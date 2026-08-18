// lib/snapshots.js — per-turn change tracking with rewind.
// A tracker captures a file's content the moment a session's Edit/Write tool
// call appears in the stream (pre-execution), then at turn end compares with
// what's on disk and records a change-set: journal + before/after blobs under
// projectManager/snapshots/<project>/. Reverts write the "before" blob back
// and are themselves recorded, so a rewind can be rewound.
// Limits: only files inside the project root, text files, ≤2MB. Side effects
// of Bash commands are not seen — only direct file-editing tools.
// A second writer, recordEditorSave, journals DASHBOARD saves that normalize
// mixed line endings (the P-EOL-5 eol-normalize ledger — see its section).
import fs from 'fs';
import path from 'path';
import { broadcast } from './events.js';
import { ROOT } from './config.js';
import { containedPath, writeFileAtomic } from './paths.js';
import { isPathGranted } from './extpins.js';
import { getTask } from './taskStore.js';

// Resolve an edit target to { key, abs, external }. Internal files resolve via
// containment (key = project-relative path). Files OUTSIDE the root are tracked
// too — but ONLY when they're a granted external pin — keyed by their absolute
// path (the same "absolute path = external rel" convention the rest of the app
// uses). Returns null for anything ungranted/invalid.
function resolveTarget(project, files, fileish) {
  const s = String(fileish || '');
  if (!s) return null;
  const r = containedPath(project, s, { mustExist: false });
  if (r) return { key: r.rel, abs: r.abs, external: false };
  if (isPathGranted(project, files, s)) {
    const abs = path.resolve(s);
    return { key: abs, abs, external: true };
  }
  return null;
}

const SNAP_ROOT = path.join(ROOT, 'snapshots');
// Journal cap raised 200 → 500 (2026-08-07): pruned entries are the raw signal
// for the planned style distiller (proposed-vs-kept deltas), so the live
// window got bigger AND pruned entries are harvested to archive.jsonl below
// instead of evaporating.
const MAX_ENTRIES = 500;               // journal cap per project (oldest pruned)
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024; // stop appending past this (log once)

const log = (...a) => console.log('[snapshots]', ...a);
const logErr = (...a) => console.error('[snapshots]', ...a);

let idCounter = 0;
const newId = () => `snp-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const journals = new Map(); // project → entries array (newest first)

function dirs(project) {
  const base = path.join(SNAP_ROOT, project);
  return { base, blobs: path.join(base, 'blobs'), journal: path.join(base, 'journal.json') };
}

function loadJournal(project) {
  if (journals.has(project)) return journals.get(project);
  let entries = [];
  const file = dirs(project).journal;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (err) {
      // Don't silently treat corruption as "empty" — the next save would
      // overwrite the history. Move the corrupt file aside and start fresh.
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* read-only? best effort */ }
      logErr(`journal for ${project} unreadable (${err.message}) — moved to ${aside}`);
    }
  }
  journals.set(project, entries);
  return entries;
}

function saveJournal(project) {
  const d = dirs(project);
  fs.mkdirSync(d.base, { recursive: true });
  const tmp = d.journal + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(journals.get(project) || [], null, 2), 'utf8');
  fs.renameSync(tmp, d.journal);
}

function blobPath(project, entryId, idx, side) {
  return path.join(dirs(project).blobs, `${entryId}.${idx}.${side}`);
}

function writeBlob(project, entryId, idx, side, content) {
  const d = dirs(project);
  fs.mkdirSync(d.blobs, { recursive: true });
  // atomic: a truncated 'before' blob would make rewind restore garbage
  writeFileAtomic(blobPath(project, entryId, idx, side), content);
}

function readBlob(project, entryId, idx, side) {
  try {
    return fs.readFileSync(blobPath(project, entryId, idx, side), 'utf8');
  } catch {
    return null;
  }
}

function pruneJournal(project) {
  const entries = journals.get(project) || [];
  while (entries.length > MAX_ENTRIES) {
    const dead = entries.pop(); // newest-first → pop the oldest
    archiveEntry(project, dead); // harvest BEFORE the blobs are deleted
    (dead.files || []).forEach((f, i) => {
      for (const side of ['before', 'after']) {
        try { fs.unlinkSync(blobPath(project, dead.id, i, side)); } catch { /* gone */ }
      }
    });
  }
}

// Pruned entries append to snapshots/<project>/archive.jsonl with their blob
// text INLINED — the journal blobs die right after this, and the planned
// memory distiller mines proposed-vs-kept deltas from the archive (2026-08-07
// packet-honesty release). Append-only, size-capped, and a failure here never
// blocks the prune: losing one archive line beats wedging the tracker.
const archiveFull = new Set(); // project → warned once
function archiveEntry(project, entry) {
  try {
    const file = path.join(dirs(project).base, 'archive.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* absent → 0 */ }
    if (size >= ARCHIVE_MAX_BYTES) {
      if (!archiveFull.has(project)) {
        archiveFull.add(project);
        logErr(`archive for ${project} is at its ${ARCHIVE_MAX_BYTES}B cap — pruned entries are no longer harvested`);
      }
      return;
    }
    const files = (entry.files || []).map((f, i) => ({
      ...f,
      before: readBlob(project, entry.id, i, 'before'),
      after: readBlob(project, entry.id, i, 'after'),
    }));
    fs.mkdirSync(dirs(project).base, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...entry, files }) + '\n');
  } catch (err) {
    logErr(`archive of ${entry && entry.id} failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Reading project files safely
// ---------------------------------------------------------------------------

// → string content, null (no file), or undefined (unsnapshotable: binary/huge/dir)
function readSnapshotable(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null; // doesn't exist (yet)
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Line diff — added/removed counts for the Δ tab's ±lines columns
// ---------------------------------------------------------------------------

// Same shape as the frontend's diffLines: trim the common prefix/suffix, then
// LCS-align the middle so unchanged lines inside an edit don't count as ±.
// Bounded — a middle too big to align precisely falls back to wholesale
// counts, which only ever OVERSTATES the churn.
export function diffCounts(beforeText, afterText) {
  const a = String(beforeText ?? '').split('\n');
  const b = String(afterText ?? '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length, eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - pre, m = eb - pre;
  if (!n && !m) return { adds: 0, dels: 0 };
  // n*m bounds the WORK; the per-dimension caps bound the ALLOCATION — a
  // 2MB single-file delete otherwise allocates one Uint32Array per line
  if (n * m > 4000000 || n > 50000 || m > 50000) return { adds: m, dels: n }; // too big to align precisely
  const mA = a.slice(pre, ea), mB = b.slice(pre, eb);
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = mA[i] === mB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { adds: m - common, dels: n - common };
}

// null-tolerant wrapper: created files count all lines added, deletions all
// removed ('' and null must not differ by a phantom line)
function countsFor(before, after) {
  return diffCounts(before ?? '', after ?? '');
}

// ---------------------------------------------------------------------------
// Tracker — one per session turn
// ---------------------------------------------------------------------------

export function createTracker(project, taskId, files = []) {
  // key → { abs, before: string|null, edits, live, external } (undefined-skips
  // not stored). key is the project-relative path for in-root files, or the
  // absolute path for granted external pins.
  const noted = new Map();

  return {
    // Called when a file-editing tool_use appears in the stream. Captures the
    // pre-state the FIRST time a file shows up in this turn and counts every
    // subsequent edit call against it. In-root files and granted external pins
    // are both tracked (see resolveTarget).
    note(fileish) {
      try {
        if (!fileish) return;
        const t = resolveTarget(project, files, fileish);
        if (!t) return;
        const known = noted.get(t.key);
        if (known) { known.edits++; return; }
        const before = readSnapshotable(t.abs);
        if (before === undefined) return; // binary/huge — not tracked
        noted.set(t.key, { abs: t.abs, before, edits: 1, live: null, external: t.external });
      } catch (err) {
        logErr('note failed:', err.message);
      }
    },

    // Live mid-turn aggregate for the console strip: recompute the file that
    // just changed against its before-state, then roll up every noted file's
    // cached counts. Cheap — one bounded diff per completed edit tool call.
    liveCounts(fileish) {
      try {
        if (fileish) {
          const t = resolveTarget(project, files, fileish);
          const rec = t && noted.get(t.key);
          if (rec) {
            const now = readSnapshotable(rec.abs);
            if (now === undefined || now === rec.before) rec.live = null;
            else {
              rec.live = {
                status: rec.before === null ? 'created' : now === null ? 'deleted' : 'modified',
                ...countsFor(rec.before, now),
              };
            }
          }
        }
        const sum = { files: 0, created: 0, modified: 0, deleted: 0, adds: 0, dels: 0 };
        for (const rec of noted.values()) {
          if (!rec.live) continue;
          sum.files++;
          sum[rec.live.status]++;
          sum.adds += rec.live.adds;
          sum.dels += rec.live.dels;
        }
        return sum;
      } catch (err) {
        logErr('liveCounts failed:', err.message);
        return null;
      }
    },

    // Called once at turn end. Records an entry if anything actually changed.
    finish(meta = {}) {
      try {
        if (!noted.size) return null;
        const files = [];
        const blobs = [];
        for (const [rel, { abs, before, edits, external }] of noted.entries()) {
          const after = readSnapshotable(abs);
          if (after === undefined) continue;       // became binary/huge — skip
          if (before === after) continue;          // no net change this turn
          const status = before === null ? 'created' : after === null ? 'deleted' : 'modified';
          blobs.push({ before, after });
          files.push({ rel, status, edits, ...(external ? { external: true } : {}), ...countsFor(before, after) });
        }
        if (!files.length) return null;

        const entry = {
          id: newId(),
          task: taskId,
          ts: new Date().toISOString(),
          files,
        };
        if (meta.revertOf) entry.revertOf = meta.revertOf;

        blobs.forEach((b, i) => {
          if (b.before !== null) writeBlob(project, entry.id, i, 'before', b.before);
          if (b.after !== null) writeBlob(project, entry.id, i, 'after', b.after);
        });
        const entries = loadJournal(project);
        entries.unshift(entry);
        pruneJournal(project);
        saveJournal(project);

        try {
          broadcast('snapshot:new', { project, entry });
        } catch (err) {
          logErr('broadcast failed:', err.message);
        }
        log(`${project}/${taskId}: recorded ${files.length} file change(s) (${entry.id})`);
        return entry;
      } catch (err) {
        logErr('finish failed:', err.message);
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Editor-save ledger — the P-EOL-5 eol-normalize event
// ---------------------------------------------------------------------------
// CONTRACT.md Phase 3 "EOL policy" (A19/P-EOL-5): mixed line endings are
// normalized at model creation (irreversible in Monaco); the FIRST save that
// writes the normalized form records a rewindable `eol-normalize` event —
// disclosed before (the client chip), recorded when (here), rewindable after
// (the standing revert machinery). Detection is SERVER-SIDE, by comparing the
// pre-write disk bytes with the incoming content: a profile-{from,to} field
// alone cannot reconstruct a mixed byte pattern, so the BEFORE bytes are
// captured from disk at PUT time — the file still holds the original bytes
// until writeFileAtomic runs — into the standing blob store. Self-limiting to
// the first normalizing save by construction: once disk is pure the check can
// never match again (and after a rewind it genuinely re-arms — normalization
// is re-offered on the next save, never silently re-applied).
// Standing limits apply and are the disclosed gap: text only, ≤MAX_FILE_BYTES
// per side — an unsnapshotable file records no event and the save proceeds.

/**
 * P-EOL-2 twin of public/monacoPane.js `eolProfile` (keep the two in sync):
 * EOL census of a text. `pure` === at most one uniform EOL kind and no lone
 * CR (Monaco cannot represent CR; a pure-CR file normalizes to CRLF).
 * @param {string} text
 * @returns {{lf: number, crlf: number, cr: number, bom: boolean,
 *            finalNewline: boolean, pure: boolean}}
 */
export function eolProfile(text) {
  let lf = 0, crlf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
    } else if (c === 10) lf++;
  }
  const bom = text.charCodeAt(0) === 0xFEFF;
  const finalNewline = text.length > 0 && /[\n\r]$/.test(text);
  const kinds = (lf ? 1 : 0) + (crlf ? 1 : 0) + (cr ? 1 : 0);
  return { lf, crlf, cr, bom, finalNewline, pure: kinds <= 1 && cr === 0 };
}

/**
 * Call BEFORE writeFileAtomic on a save route: does writing `content` over
 * the file at `abs` normalize mixed line endings? Returns the captured
 * pre-write disk bytes + advisory eol metadata when it does, else null
 * (pure→pure round-trips — P-EOL-3 — new files, non-normalizing saves, and
 * the disclosed unsnapshotable gap: binary/oversize on either side).
 * @param {string} abs absolute path of the file about to be overwritten
 * @param {string} content the incoming PUT content
 * @returns {{before: string, eol: {from: {lf: number, crlf: number,
 *            cr: number, bom: boolean, finalNewline: boolean},
 *            to: 'LF' | 'CRLF'}} | null}
 */
export function checkEolNormalize(abs, content) {
  try {
    if (typeof content !== 'string' || content.includes('\0')
      || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return null;
    const incoming = eolProfile(content);
    if (!incoming.pure) return null; // the save preserves the mix — nothing normalized
    const before = readSnapshotable(abs);
    if (before === null) return null; // new file — nothing was there to normalize
    if (before === undefined) {
      // the disclosed gap: binary/oversize disk bytes can't ride the blob store
      log(`eol-normalize check skipped for ${abs} — unsnapshotable (binary or >${MAX_FILE_BYTES}B)`);
      return null;
    }
    const prof = eolProfile(before);
    if (prof.pure) return null; // pure→pure (P-EOL-3) — and why this fires at most once
    return {
      before,
      eol: {
        // advisory metadata only (the load-time census P-EOL-5 asks the event
        // to carry) — the before BLOB is the recovery mechanism, never this
        from: { lf: prof.lf, crlf: prof.crlf, cr: prof.cr, bom: prof.bom, finalNewline: prof.finalNewline },
        to: incoming.crlf > 0 ? 'CRLF' : 'LF',
      },
    };
  } catch (err) {
    logErr('checkEolNormalize failed:', err.message);
    return null;
  }
}

/**
 * Journal writer for DASHBOARD editor saves (the second writer beside
 * createTracker, which owns session turns). Records a one-file change-set
 * with `origin:'editor-save'`: in-project saves carry `task: null` — a
 * dashboard save has no task to attribute, so purgeTask (which matches a real
 * task id) never removes them and they age out via the journal cap + archive
 * harvest instead; extfile saves attribute the GRANTING task's real id,
 * accepting — stated, not accidental — that purgeTask then removes them with
 * that task. The entry rides the standing machinery (MAX_ENTRIES prune,
 * archive, snapshot:new broadcast, revert with revertOf) — nothing bespoke.
 * @param {string} project
 * @param {{rel: string, before: string, after: string,
 *          eol?: {from: object, to: string}, task?: string | null,
 *          external?: boolean}} opts rel is project-relative for in-root
 *        files, the pin's absolute path for granted external files (the
 *        app-wide "absolute path = external rel" convention)
 * @returns {object | null} the recorded journal entry, or null on failure
 */
export function recordEditorSave(project, { rel, before, after, eol, task = null, external = false }) {
  try {
    if (typeof before !== 'string' || typeof after !== 'string' || !rel) {
      logErr('recordEditorSave refused — before/after must be strings and rel non-empty');
      return null;
    }
    const entry = {
      id: newId(),
      task,
      origin: 'editor-save',
      ts: new Date().toISOString(),
      files: [{ rel, status: 'modified', edits: 1, ...(external ? { external: true } : {}), ...countsFor(before, after) }],
      ...(eol ? { eol } : {}),
    };
    writeBlob(project, entry.id, 0, 'before', before);
    writeBlob(project, entry.id, 0, 'after', after);
    const entries = loadJournal(project);
    entries.unshift(entry);
    pruneJournal(project);
    saveJournal(project);
    try {
      broadcast('snapshot:new', { project, entry });
    } catch (err) {
      logErr('broadcast failed:', err.message);
    }
    log(`${project}: editor save recorded for ${rel} (${entry.id}${eol ? `, eol-normalize → ${eol.to}` : ''})`);
    return entry;
  } catch (err) {
    logErr('recordEditorSave failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Queries + revert
// ---------------------------------------------------------------------------

export function listSnapshots(project, taskId) {
  const entries = loadJournal(project);
  const filtered = taskId ? entries.filter((e) => e.task === taskId) : entries;
  return filtered.map((e) => ({ ...e })); // shallow copies, no blob contents
}

export function getSnapshotFile(project, entryId, rel) {
  const entry = loadJournal(project).find((e) => e.id === entryId);
  if (!entry) return { error: 'unknown change-set' };
  const idx = (entry.files || []).findIndex((f) => f.rel === rel);
  if (idx === -1) return { error: 'file not in this change-set' };
  return {
    rel,
    status: entry.files[idx].status,
    before: readBlob(project, entryId, idx, 'before'),
    after: readBlob(project, entryId, idx, 'after'),
  };
}

/**
 * Remove all change history for a deleted task (journal entries + blobs).
 * Editor-save entries (recordEditorSave): in-project ones carry task:null,
 * which never matches a real task id — dashboard save history survives task
 * deletion and ages out via the journal cap; extfile ones are attributed to
 * their granting task and die here with it (the stated P-EOL-5 consequence).
 * @param {string} project
 * @param {string} taskId
 */
export function purgeTask(project, taskId) {
  try {
    const entries = loadJournal(project);
    const dead = entries.filter((e) => e.task === taskId);
    if (!dead.length) return;
    for (const e of dead) {
      (e.files || []).forEach((_, i) => {
        for (const side of ['before', 'after']) {
          try { fs.unlinkSync(blobPath(project, e.id, i, side)); } catch { /* gone */ }
        }
      });
    }
    journals.set(project, entries.filter((e) => e.task !== taskId));
    saveJournal(project);
    log(`${project}/${taskId}: purged ${dead.length} change-set(s)`);
  } catch (err) {
    logErr('purgeTask failed:', err.message);
  }
}

// Rewind file(s) in an entry to their BEFORE state. relOnly limits to one
// file; otherwise the whole change-set rewinds. The rewind is recorded as its
// own entry (revertOf), so it shows in history and can itself be rewound.
export function revertSnapshot(project, entryId, relOnly) {
  try {
    const entry = loadJournal(project).find((e) => e.id === entryId);
    if (!entry) return { error: 'unknown change-set' };
    const targets = (entry.files || [])
      .map((f, i) => ({ ...f, idx: i }))
      .filter((f) => !relOnly || f.rel === relOnly);
    if (!targets.length) return { error: 'file not in this change-set' };

    // the task's current pins gate external rewinds (and feed the new tracker).
    // A corrupt task store must only block what actually NEEDS the pins —
    // internal-only rewinds proceed with an empty grant list. entry.task may
    // be null (editor-save entries): getTask then finds nothing and in-root
    // rewinds proceed the same way — the revert entry records task:null too.
    let task = null;
    try { task = getTask(project, entry.task); } catch (err) {
      logErr(`task store unreadable for ${project}/${entry.task} — external rewinds will refuse:`, err.message);
    }
    const files = task && Array.isArray(task.context?.files) ? task.context.files : [];
    const tracker = createTracker(project, entry.task, files);
    const failed = [];
    for (const f of targets) {
      try {
        // external entries (abs rel, outside the root) rewind to their absolute
        // path — but only if that path is STILL a granted external pin; if the
        // pin was removed, refuse rather than write outside the project
        const external = f.external || String(f.rel).startsWith('/');
        let abs;
        if (external) {
          if (!isPathGranted(project, files, f.rel)) { failed.push(`${f.rel}: external path no longer granted`); continue; }
          // write through the realpath when the target exists — the grant was
          // evaluated on the resolved file, and rewinding a symlinked path
          // must not replace the symlink with a regular file
          try { abs = fs.realpathSync(f.rel); } catch { abs = f.rel; }
        } else {
          const r = containedPath(project, f.rel, { mustExist: false });
          if (!r) { failed.push(`${f.rel}: path no longer valid`); continue; }
          abs = r.abs;
        }
        const before = readBlob(project, entryId, f.idx, 'before');
        // Only a change recorded as 'created' may delete on rewind — a missing
        // blob on a modified file is a read failure, never a license to delete.
        if (before === null && f.status !== 'created') {
          failed.push(`${f.rel}: before-state blob unreadable`);
          continue;
        }
        tracker.note(abs); // capture current state so the revert is in history
        if (f.status === 'created') {
          try { fs.unlinkSync(abs); } catch { /* already gone */ }
        } else {
          writeFileAtomic(abs, before);
        }
      } catch (err) {
        failed.push(`${f.rel}: ${err.message}`);
      }
    }
    // record whatever DID revert, even when some files failed
    const recorded = tracker.finish({ revertOf: entryId });
    if (failed.length === targets.length) {
      return { error: `rewind failed — ${failed.join('; ')}` };
    }
    return { ok: true, entry: recorded, ...(failed.length ? { partial: failed } : {}) };
  } catch (err) {
    logErr('revert failed:', err.message);
    return { error: err.message };
  }
}
