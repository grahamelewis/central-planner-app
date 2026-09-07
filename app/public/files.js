// files.js — the file/transcript/pin/snapshot/feed data layer, split verbatim
// out of app.js (phase 2): fetch+cache, 3-way auto-merge orchestration, save,
// dir browser, pin picker, WYSIWYG html edit, editor chrome patching.

import {
  enc, esc, isPdfFile, isHtmlFile, isDataFile, pinKindOf, isExtRel, toast, merge3,
} from './util.js';
import {
  state, ui, transcripts, tailBufs, fileCache, drafts, draftBase, diskStale,
  snapFileCache, snapsCache, feedCache, feedTimers, editsLive, htmlEdits,
  curTask, perOf, relOf, artifactUrl, isExternalPin, tasksOf,
  getClosed, persistClosed, extrasOf, persistExtras,
} from './store.js';
import { api, apiQuiet } from './net.js';
import { syncTexRunControls } from './texrun.js';
// Phase 3 M4: the merge path routes dissolve/rebase into the kept Monaco
// model through the frozen applyExternal seam; since S2.1 saveFile routes a
// MODELED monaco fkey through the frozen M3 token queue (requestSave — the
// CONTRACT M3 re-anchor; text() doubles as the model-existence probe:
// null ⇔ no model). Same import discipline as
// texrun.js — a static import used strictly inside functions; the
// files ⇄ monacoPane ESM cycle already exists (via texrun) and is benign
// because neither side touches the other at module-eval time (monacoPane's
// imports of us are hoisted function declarations).
import {
  applyExternal as mpApplyExternal,
  noteViewClose as mpNoteViewClose, requestSave as mpRequestSave, text as mpText,
} from './monacoPane.js';
import { selectViewer } from './viewers.js';
import { renderWB } from './workbench.js';
import { transcriptRevision, replaceTranscript } from './undoSend.js';

const fileLists = {};     // project → { files:[rel,…] } | { loading } — for the pin picker
const dirCache = {};      // `${project}::${rel}` → { entries, sig, loaded, loading } — sidebar folder browser

/* ───────────────────────── transcripts & files ───────────────────────── */

/* Completion safety net for old/unknown Codex event shapes. The authoritative
   transcript contains only the final agent message. If that exact final text
   exists in the live stream but was glued to the preceding commentary, insert
   the semantic answer boundary in place. This preserves thinking/tool history;
   unlike a full transcript rebuild, it changes only the missing separator. */
function reconcileFinalTranscriptTail(live, finalText) {
  if (typeof live !== 'string' || !live || typeof finalText !== 'string' || !finalText) return live;
  const at = live.lastIndexOf(finalText);
  if (at < 0) {
    // A dropped/changed delta is rarer than a missing boundary, but completion
    // still has the canonical answer. Put it before the turn receipt so the
    // current view heals without requiring a reload.
    const turnAt = live.lastIndexOf('\n— turn ');
    const insertAt = turnAt >= 0 ? turnAt : live.length;
    return live.slice(0, insertAt).replace(/[ \t]+$/, '')
      + '\n— answer —\n' + finalText + '\n' + live.slice(insertAt).replace(/^\n/, '');
  }
  if (at === 0) return live;
  const before = live.slice(0, at);
  if (/(?:^|\n)— answer —\n$/.test(before)) return live;
  const clean = before.replace(/[ \t]+$/, '');
  return clean + (clean.endsWith('\n') ? '— answer —\n' : '\n— answer —\n') + live.slice(at);
}

/**
 * Re-fetch a task's server-side transcript into the transcripts cache.
 * @param {string} project
 * @param {string} id task id
 * @param {{ reconcileTail?: boolean, rebuildTail?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function refreshTranscript(project, id, { reconcileTail = false, rebuildTail = false } = {}) {
  const k = `${project}/${id}`;
  const revision = transcriptRevision[k] || 0;
  const data = await apiQuiet('GET', `/api/transcript/${enc(project)}/${enc(id)}`);
  if ((transcriptRevision[k] || 0) !== revision) return;
  const prev = transcripts[k];
  const entries = (data && Array.isArray(data.transcript)) ? data.transcript : (prev?.entries || []);
  transcripts[k] = {
    entries,
    fetched: true,
  };
  if (rebuildTail && data && Array.isArray(data.transcript)) {
    replaceTranscript(project, id, data.transcript);
  } else if (reconcileTail && data && Array.isArray(data.transcript)) {
    const final = [...entries].reverse().find(e => e && e.role === 'assistant' && typeof e.text === 'string');
    if (final) tailBufs[k] = reconcileFinalTranscriptTail(tailBufs[k], final.text);
  }
  if (ui.view === project && curTask(project)?.id === id) renderWB(project);
}

/**
 * Fetch the transcript once (cache-first).
 * @param {string} project
 * @param {string} id task id
 * @returns {void}
 */
export function ensureTranscript(project, id) {
  const k = `${project}/${id}`;
  if (transcripts[k]) return;
  transcripts[k] = { entries: [], fetched: false };
  refreshTranscript(project, id);
}

/**
 * Fetch a file's text into fileCache[k] (size-capped; marks binary/errors).
 * @param {string} k fkey `${project}::${rel}`
 * @param {string} project
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function fetchFileInto(k, project, rel) {
  try {
    const url = isExtRel(rel)
      ? `/api/extfile/${enc(project)}/${enc(curTask(project)?.id || '')}?path=${enc(rel)}`
      : artifactUrl(project, rel);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // precise server header first; Last-Modified (second-floor) as fallback
    const lm = Number(res.headers.get('x-mtime-ms'))
      || Date.parse(res.headers.get('last-modified') || '') || null;
    const truncated = text.length > 200000;
    const binary = text.includes('\u0000') || /\ufffd{2}/.test(text.slice(0, 8000));
    fileCache[k] = {
      text: binary ? `// binary file (${text.length.toLocaleString()} bytes) — not editable here` :
        truncated ? text.slice(0, 200000) + '\n… (truncated)' : text,
      mtimeMs: lm,
      truncated: truncated || binary, // binary rides the read-only path
      binary,
    };
  } catch (err) {
    fileCache[k] = { error: String(err.message || err) };
  }
}

/**
 * Cache-first file load.
 * @param {string} project
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function ensureFile(project, rel) {
  const k = `${project}::${rel}`;
  if (fileCache[k]) return;
  fileCache[k] = { loading: true };
  await fetchFileInto(k, project, rel);
  if (ui.view === project) renderWB(project);
}

/* Live refresh (file:changed): the OLD content stays on screen — scroll and
   all — until the new text has actually arrived; then one render swaps it. */
/**
 * Force-refresh a cached file (keeps the draft; re-renders the open view).
 * @param {string} project
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function refreshFile(project, rel) {
  const k = `${project}::${rel}`;
  await fetchFileInto(k, project, rel);
  if (drafts[k] != null) return; // user started typing mid-fetch — draft wins
  if (ui.view === project) renderWB(project);
}

/* A session (or watcher) changed `rel` on disk. A clean open editor reloads
   in place — the OLD text holds the screen until the new arrives, so the
   textarea never unmounts (unmounting flashed a loading shell and dropped
   focus mid-typing). An unsaved draft gets a 3-way auto-merge attempt (the
   disk change folds INTO the draft); only a genuine overlap falls back to
   the ⚠ disk footer warning + save-time 409 net. Files never loaded need
   nothing: the next open fetches fresh. */
/**
 * A session's Edit/Write landed on disk — reload clean editors in place,
 * 3-way-merge into an unsaved draft (file:changed / snapshot:new path).
 * @param {string} project
 * @param {string} rel
 * @returns {void}
 */
export function sessionFileChanged(project, rel) {
  const fk = `${project}::${rel}`;
  if (drafts[fk] != null) {
    // serialize per file — a turn can land several edits in quick succession,
    // and each merge must see the state the previous one left
    mergeRuns[fk] = (mergeRuns[fk] || Promise.resolve())
      .then(() => autoMergeDisk(project, rel))
      .catch(() => { /* never wedge the chain */ });
    return;
  }
  diskStale.delete(fk);
  if (fileCache[fk]) refreshFile(project, rel);
}

const mergeRuns = {};    // fkey → promise chain serializing merge attempts
const mergeToastAt = {}; // fkey → last "merged" toast time (a turn's edit volley ≠ 5 toasts)

/* Disk changed under an unsaved draft: 3-way merge. All three versions are at
   hand — BASE is the fileCache text (deliberately frozen while a draft
   exists: nothing refetches into the cache then), OURS is the draft, THEIRS
   is a fresh read of what the session wrote. Non-overlapping line edits — the
   normal case: Claude adds frames while you tweak a different one — combine
   silently and the draft rebases onto the new disk version, so save/▶ just
   work. A real overlap (or any doubt) falls back to the old behavior: draft
   pinned, ⚠ disk chip, save-time 409 as the net. */
/**
 * The merge half of sessionFileChanged: rebase the draft onto the new disk
 * text when the hunks are disjoint, else pin the ⚠ changed-on-disk flow.
 * @param {string} project
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function autoMergeDisk(project, rel) {
  const fk = `${project}::${rel}`;
  const c = fileCache[fk];
  const bail = () => {
    const first = !diskStale.has(fk);
    diskStale.add(fk);
    if (ui.view === project) editorChrome(project);
    if (first) toast(`session edited ${rel} under your unsaved changes — couldn't auto-merge (⚠ disk)`);
  };
  if (!c || c.loading || c.error || c.truncated || typeof c.text !== 'string') { bail(); return; }
  let theirs = null;
  let mtime = null;
  try {
    const url = isExtRel(rel)
      ? `/api/extfile/${enc(project)}/${enc(curTask(project)?.id || '')}?path=${enc(rel)}`
      : artifactUrl(project, rel);
    const res = await fetch(url);
    if (res.ok) {
      theirs = await res.text();
      mtime = Number(res.headers.get('x-mtime-ms'))
        || Date.parse(res.headers.get('last-modified') || '') || null;
    }
  } catch { /* fall through to bail */ }
  const ours = drafts[fk]; // re-read AFTER the fetch — keystrokes kept landing
  if (ours == null) { // draft vanished meanwhile (saved / reverted) — plain reload
    diskStale.delete(fk);
    if (fileCache[fk]) {
      // M4 T3 under Monaco: refreshFile's renderWB only reconciles the fkey
      // attached to the VISIBLE view — a retained background/orphan model
      // (A4/M7 T6) would hold pre-change text and its live undo indefinitely.
      // Await the refetch (keeps the mergeRuns chain serialized through the
      // reload), then route the fresh bytes through the frozen seam:
      // applyExternal is a no-op without a model, and its cleanReload
      // idempotence guard makes the just-reconciled attached model a no-op
      // too — never a second txn on bytes already in place.
      await refreshFile(project, rel);
      const c2 = fileCache[fk];
      if (drafts[fk] == null // re-read AGAIN — typing during the refetch wins (no clobber, no resurrection)
        && c2 && !c2.loading && !c2.error && !c2.truncated
        && typeof c2.text === 'string' && Number.isFinite(c2.mtimeMs)) {
        mpApplyExternal(fk, c2.text, 'cleanReload');
      }
    }
    return;
  }
  if (theirs == null || !Number.isFinite(mtime)
    || theirs.length > 200000 || theirs.includes('\u0000')) { bail(); return; }
  const merged = merge3(c.text, ours, theirs);
  if (merged == null) { bail(); return; }
  fileCache[fk] = { text: theirs, mtimeMs: mtime };
  if (merged === theirs) {
    delete drafts[fk]; // the draft's edits are all on disk already — clean
    delete draftBase[fk];
  } else {
    drafts[fk] = merged;
    draftBase[fk] = mtime; // rebased: saving now writes ON TOP of the session's version
  }
  diskStale.delete(fk);
  // M4 T4/T5 — the A1 HISTORY REBASE reaches the model. The store commit
  // above ran first, in this same synchronous block (fileCache / drafts /
  // draftBase / diskStale are the calling machine's half of the atomic
  // commit — applyExternal's contract), so the txn's exactly-one chrome
  // signal paints the new truth: applyExternal(mergeRebase) setValue(THEIRS)s
  // with undo CLEARED, captures savedAltId := altId(THEIRS) (a real model
  // state), and pushes MERGED as the ONLY undoable edit iff it differs (T4
  // dissolve pushes nothing) — ⌘Z can reach current disk, never pre-merge
  // OURS. Background/orphan models take the same txn directly (A4/M7 T6 —
  // no renderWB needed, visible caret untouched); no model →
  // no-op/skipped: today's behavior byte-identical. The renderWB below then
  // reconciles as a read-only no-op (serialize === draft / raw-to-raw
  // baseline match) — at most once post-commit, P3's one-swap rule.
  mpApplyExternal(fk, { theirs, merged }, 'mergeRebase');
  if (ui.view === project) renderWB(project);
  const now = Date.now();
  if (!(mergeToastAt[fk] > now - 15000)) {
    mergeToastAt[fk] = now;
    toast(`merged the session's ${rel} edits into your open draft`);
  }
}

/**
 * PUT the draft (or editor buffer) to /artifact | /api/extfile, with the
 * 409 mtime-conflict reload/merge flow. Under the monaco impl a modeled
 * fkey rides the M3 token queue instead (same wire protocol — see the gate
 * below); the returned promise settles when that queue is idle, so awaiting
 * callers keep their save-first ordering.
 * @param {string} key project key
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function saveFile(key, rel) {
  const k = `${key}::${rel}`;
  // Phase 3 S2.1(a) — the M3 re-anchor (CONTRACT M3: the S1 residual, now
  // closed). Under the monaco impl a MODELED fkey's save rides the M3 token
  // queue: the same PUT to the same /artifact | /api/extfile routes, the
  // same 409 semantics (the M5 clipboard-verified ladder instead of the
  // native confirm), the machine's own no-finite-baseline/sentinel refusal
  // toast (same wording as ours below) and network-failure toast — but
  // commitSave captures savedAltId := token.altId, so the chip realigns
  // immediately instead of waiting for reattach reconciliation. Caller swap
  // only, NO wire-protocol change; concurrent callers coalesce per fkey
  // (M3 T7 — chip click + saveFile can never double-dispatch). mpText(k) is
  // the model-existence probe (null ⇔ no model): no-model fkeys still
  // need the shared draft-save path below.
  if (mpText(k) != null) return mpRequestSave(k);
  if (drafts[k] == null) return; // nothing unsaved
  const base = draftBase[k] ?? fileCache[k]?.mtimeMs;
  if (!Number.isFinite(base)) {
    // no trustworthy baseline (cache mid-load/error) — saving now could
    // overwrite a newer on-disk version with the conflict guard disarmed
    toast('cannot save yet — file state unknown, reopen the tab first');
    return;
  }
  const text = drafts[k];
  let res;
  try {
    // external pins save through their grant route (same allowlist the
    // session writes with); in-root files through /artifact as always
    res = isExtRel(rel)
      ? await fetch(`/api/extfile/${enc(key)}/${enc(curTask(key)?.id || '')}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: rel, content: text, baseMtimeMs: base }),
      })
      : await fetch(artifactUrl(key, rel), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, baseMtimeMs: base }),
      });
  } catch (err) { toast('save failed: ' + (err.message || err)); return; }
  if (res.status === 409) {
    // real recovery path: offer to load the new disk version (draft → clipboard)
    if (confirm('This file changed on disk (a session or another machine edited it).\n\n' +
      'Load the NEW version? Your unsaved text is copied to the clipboard first.\n' +
      'Cancel keeps your draft (saving will keep failing until you reload).')) {
      // the clipboard backup is the whole promise — if it fails (denied, or
      // navigator.clipboard is absent over plain-http remote access), the
      // draft must NOT be destroyed
      let copied = false;
      try { await navigator.clipboard.writeText(text); copied = true; } catch { /* denied/absent */ }
      if (!copied) {
        toast('clipboard unavailable — draft kept; copy your text manually, then close the tab to reload');
        return;
      }
      delete drafts[k];
      delete draftBase[k];
      delete fileCache[k];
      diskStale.delete(k);
      renderWB(key);
      toast('reloaded from disk — your draft is on the clipboard');
    }
    return;
  }
  if (!res.ok) {
    let msg = `save failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* */ }
    toast(msg);
    return;
  }
  const r = await res.json();
  fileCache[k] = { text, mtimeMs: r.mtimeMs };
  diskStale.delete(k); // our write is now the disk state
  if (drafts[k] === text) {
    delete drafts[k]; // clean — nothing typed while the save was in flight
    delete draftBase[k];
  } else {
    draftBase[k] = r.mtimeMs; // newer keystrokes survive; rebase them on our own write
  }
  toast('saved ' + rel);
  editorChrome(key);
}

/**
 * Close a center file tab (localStorage, never the task record) and hand
 * focus to the nearest open tab.
 * @param {string} key project key
 * @param {Task} task
 * @param {number} i index into files
 * @param {*[]} files the task's tab list (pin entries)
 * @returns {void}
 */
export function closeTab(key, task, i, files) {
  const closed = getClosed(key, task);
  closed.add(String(files[i]));
  persistClosed(key, task);
  // Phase 3 full-M7 (A10 / s05 M7 T4): tell the kept-model registry the VIEW
  // closed — a clean model becomes an LRU-eligible orphan, a dirty model
  // (draft, undo stack, savedAltId) is retained until save/revert/discard.
  // Additive: a no-op without a model (for example, never-opened tabs).
  {
    const rel = isExternalPin(key, files[i]) ? String(files[i]) : relOf(key, files[i]);
    if (rel != null) mpNoteViewClose(`${key}::${rel}`);
  }
  const per = perOf(key);
  if (per.fileTab === i) {
    // hand focus to the nearest tab that's still open (pdfs have no tabs)
    const open = files.map((_, j) => j)
      .filter(j => !closed.has(String(files[j])) && !isPdfFile(files[j]) && pinKindOf(files[j]) !== 'folder');
    per.fileTab = open.find(j => j > i) ?? (open.length ? open[open.length - 1]
      : per.openExtra?.length ? 'x:' + per.openExtra[0] : 'tail');
  }
  renderWB(key);
}

/* ephemeral code tabs — files opened from a folder-pin browser. UI-only and
   per project (per.openExtra), NOT part of the task's context packet; the
   fileTab value for extras is the string 'x:<rel>' so it can never collide
   with numeric pin indexes or 'tail'/'run'/'snaps' */
/**
 * Open an ephemeral ◇ tab for rel (reuses a matching pin tab when one exists).
 * @param {string} key project key
 * @param {string} rel
 * @returns {void}
 */
export function openExtraTab(key, rel) {
  const per = perOf(key);
  const task = curTask(key);
  const pins = task && Array.isArray(task.context?.files) ? task.context.files : [];
  const pinIdx = pins.findIndex(f => relOf(key, String(f).replace(/\/+$/, '')) === rel);
  if (pinIdx >= 0 && pinIdx < 12 && pinKindOf(pins[pinIdx]) === 'code') {
    // already pinned as code — select its tab (reopening it if × closed);
    // data/folder pins render cards, so those still get an ephemeral tab
    per.fileTab = pinIdx;
    if (task) {
      const closed = getClosed(key, task);
      if (closed.delete(String(pins[pinIdx]))) persistClosed(key, task);
    }
    if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
  } else {
    // Folder-browser HTML/PDF/data opens in the show panel, but callers can
    // also request source tabs (including external files and overflow pins).
    const extras = extrasOf(key);
    if (!extras.includes(rel)) { extras.push(rel); persistExtras(key); }
    per.fileTab = 'x:' + rel;
    // refetch on open (unless a draft is in progress) — same staleness rule as pins
    if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
  }
  renderWB(key);
}

/**
 * Fetch (or refresh) a folder listing into the dir cache.
 * @param {string} key project key
 * @param {string} rel folder rel ('' = root)
 * @returns {Promise<void>}
 */
export async function ensureDir(key, rel) {
  const ck = `${key}::${rel}`;
  const cur = dirCache[ck];
  if (cur && cur.loading) return; // fetch already in flight
  // refetch even on a cache hit — stale entries stay visible while loading,
  // so re-expanding a folder (or the heartbeat sweep) picks up new files
  dirCache[ck] = cur ? { ...cur, loading: true } : { entries: [], loading: true };
  const d = await apiQuiet('GET', isExtRel(rel)
    ? `/api/extls/${enc(key)}/${enc(curTask(key)?.id || '')}?dir=${enc(rel)}`
    : `/api/ls/${enc(key)}?rel=${enc(rel)}`);
  const entries = (d && d.entries) || [];
  // re-render only when names change: sizes churn while logs are written
  const sig = entries.map(e => (e.dir ? 'd' : 'f') + e.name).join('\n');
  const changed = !cur || sig !== cur.sig;
  dirCache[ck] = { entries, sig, loaded: true };
  if (changed && ui.view === key) renderWB(key);
}

/* expanded folder contents under a 🗀 pin — pdfs/htmls open in the show panel */
/**
 * Folder-pin browser rows for one directory level.
 * @param {string} key project key
 * @param {string} rel
 * @param {number} depth
 * @returns {string} html
 */
export function dirKidsHtml(key, rel, depth) {
  const dc = dirCache[`${key}::${rel}`];
  const pad = 16 + depth * 13;
  if (!dc || (dc.loading && !dc.loaded)) return `<div class="scKid note" style="padding-left:${pad}px">loading…</div>`;
  if (!dc.entries.length) return `<div class="scKid note" style="padding-left:${pad}px">empty</div>`;
  return dc.entries.map(e => {
    const crel = `${rel}/${e.name}`;
    if (e.dir) {
      const open = perOf(key).openDirs?.has(crel);
      return `<div class="scKid dirk" data-dk="${esc(crel)}" style="padding-left:${pad}px">${open ? '▾' : '▸'} 🗀 ${esc(e.name)}</div>`
        + (open ? dirKidsHtml(key, crel, depth + 1) : '');
    }
    const ext = e.name.split('.').pop().toLowerCase();
    const dataf = isDataFile(e.name);
    const viewable = ['pdf', 'html', 'htm'].includes(ext) || dataf;
    const icon = ext === 'pdf' ? '◫' : (ext === 'html' || ext === 'htm') ? '⌗' : dataf ? '▦' : '·';
    return `<div class="scKid filek ${viewable ? 'viewable' : ''}" data-fk="${esc(crel)}"
      style="padding-left:${pad}px" title="${dataf ? 'preview head rows in the show panel'
    : viewable ? 'open in the show panel' : 'open in the code pane'}">${icon} ${esc(e.name)}</div>`;
  }).join('');
}

/**
 * Fetch a data/folder pin card (GET /api/pincard) into the cache.
 * @param {string} key project key
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function ensureCard(key, rel) {
  const ck = `${key}::card::${rel}`;
  if (fileCache[ck]) return;
  fileCache[ck] = { loading: true };
  const d = await apiQuiet('GET', `/api/pincard/${enc(key)}?rel=${enc(rel)}`);
  fileCache[ck] = (d && d.card) ? { text: d.card } : { error: (d && d.error) || 'card unavailable' };
  if (ui.view === key) renderWB(key);
}

/**
 * Fetch the project file list (pin search) once.
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function ensureFileList(key) {
  if (fileLists[key]) return;
  fileLists[key] = { loading: true };
  const d = await apiQuiet('GET', `/api/files/${enc(key)}`);
  fileLists[key] = { files: (d && Array.isArray(d.files)) ? d.files : [] };
  if (ui.view === key) renderWB(key);
}

/* the ＋ menu's actions: native dialogs locally; remote falls back to the
   in-app search (files) or a path prompt (folders). Dialog errors just toast —
   never silently swap UIs (that was the old "search bar appears" bug). */
/**
 * The ＋ pin flow: native dialogs locally (incl. external grants), the
 * in-app search list remotely.
 * @param {string} key project key
 * @param {Task} task
 * @param {'file' | 'folder' | 'ext-file' | 'ext-folder' | string} [kindWanted]
 * @returns {Promise<void>}
 */
export async function pickPin(key, task, kindWanted) {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const external = kindWanted === 'ext-file' || kindWanted === 'ext-folder';
  const folder = kindWanted === 'folder' || kindWanted === 'ext-folder';
  if (external) {
    // an EXTERNAL file/folder anywhere on disk — grants the session read/edit
    // access to it (its folder) via additionalDirectories
    if (local) {
      const r = await api('POST', '/api/pickfile', { project: key, external: true, kind: folder ? 'folder' : 'file' });
      if (r && r.path) pinFile(key, task, r.path);     // outside root → absolute
      else if (r && r.rel) pinFile(key, task, r.rel);  // they picked inside root after all
    } else {
      const p = prompt(`Absolute path to an external ${folder ? 'folder' : 'file'} (outside ${state.projects[key]?.name || key}):`, '');
      if (p && p.trim()) pinFile(key, task, folder ? p.trim().replace(/\/?$/, '/') : p.trim());
    }
    return;
  }
  if (local) {
    const r = await api('POST', '/api/pickfile', folder
      ? { project: key, kind: 'folder', prompt: 'Pin a folder to {name} — the map is injected, not the contents' }
      : { project: key, prompt: 'Pin a file to {name}' });
    if (r && r.rel) pinFile(key, task, r.rel);
    // canceled → nothing; errors already toasted by api()
  } else if (folder) {
    const rel = prompt(`Folder path in ${state.projects[key]?.name || key} (relative to project root):`, '');
    if (rel && rel.trim()) pinFile(key, task, rel.trim().replace(/\/?$/, '/'));
  } else {
    const per = perOf(key);
    per.pinOpen = true;
    per.pinQ = '';
    delete fileLists[key];
    ensureFileList(key);
    renderWB(key);
    document.querySelector(`#v-${key} #pinSearch`)?.focus();
  }
}

/**
 * Append a file/folder to the task's context.files (PATCH) and open its tab.
 * @param {string} key project key
 * @param {Task} task
 * @param {string} rel root-relative, or absolute for an external grant
 * @returns {Promise<void>}
 */
export async function pinFile(key, task, rel) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  const cur = Array.isArray(local.context?.files) ? local.context.files : [];
  const ext = isExternalPin(key, rel);
  if (cur.some(f => f === rel || (!ext && relOf(key, f) === rel))) return; // already pinned
  const order = [...cur, rel];
  // optimistic: show the new tab immediately, then persist (broadcast confirms)
  local.context = { ...(local.context || {}), files: order };
  const closed = getClosed(key, task); // re-pinning something once closed reopens it
  if (closed.delete(rel)) persistClosed(key, task);
  const per = perOf(key);
  const ex0 = extrasOf(key);
  per.openExtra = ex0.filter(r => r !== rel); // pin tab supersedes an ephemeral one
  if (per.openExtra.length !== ex0.length) persistExtras(key);
  if (ext) {
    // external pins don't open in the dashboard editor (the path is outside the
    // project) — they just grant the session read/edit access to that folder
    toast(`external ${pinKindOf(rel) === 'folder' ? 'folder' : 'file'} pinned — the task agent can now read & edit it`);
  } else if (isPdfFile(rel)) selectViewer(key, rel); // pdfs open in the show panel
  else if (pinKindOf(rel) === 'folder') {
    // folders have no center tab — open their sidebar browser instead
    const frel = relOf(key, String(rel).replace(/\/+$/, ''));
    if (frel != null) {
      per.openDirs = per.openDirs || new Set();
      per.openDirs.add(frel);
      ensureDir(key, frel);
    }
  } else if (order.length <= 12) per.fileTab = order.length - 1;
  else if (!isHtmlFile(rel)) toast('pinned — beyond the 12 visible tabs, see the sidebar'); // don't focus a different file
  // HTML is both source and a readable document. Open both on an explicit
  // pin, but leave subsequent editor/viewer tab selections independent.
  if (!ext && isHtmlFile(rel)) {
    const htmlRel = relOf(key, rel);
    if (htmlRel != null) {
      selectViewer(key, htmlRel);
      // Pins beyond the editor's visible-tab limit still need a source tab.
      if (order.length > 12) openExtraTab(key, htmlRel);
    }
  }
  per.pinOpen = false;
  per.pinQ = '';
  renderWB(key);
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`,
    { context: { ...local.context, files: order } });
}

/* Revoke an external pin — removes it from context.files so the session no
   longer gets that directory in additionalDirectories. */
/**
 * Revoke an external pin (amber ×): PATCH the pin list without the path.
 * @param {string} key project key
 * @param {Task} task
 * @param {string} f the pin's absolute path
 * @returns {Promise<void>}
 */
export async function removeExternalPin(key, task, f) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  const cur = Array.isArray(local.context?.files) ? local.context.files : [];
  const order = cur.filter(x => String(x) !== String(f));
  if (order.length === cur.length) return; // not present
  local.context = { ...(local.context || {}), files: order };
  renderWB(key);
  toast('external access revoked');
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`,
    { context: { ...local.context, files: order } });
}

/**
 * Search-result rows for the remote pin picker.
 * @param {string} key project key
 * @param {Task} task
 * @returns {string} html
 */
export function pinResultsHtml(key, task) {
  const fl = fileLists[key];
  if (!fl || fl.loading) return '<div class="sideNote">scanning project…</div>';
  const terms = (perOf(key).pinQ || '').toLowerCase().split(/\s+/).filter(Boolean);
  const pinned = new Set((task.context?.files || []).map(f => relOf(key, f)).filter(Boolean));
  const hits = fl.files.filter(f =>
    !pinned.has(f) && terms.every(t => f.toLowerCase().includes(t)));
  if (!hits.length) return '<div class="sideNote">no matches</div>';
  return hits.slice(0, 30).map(f =>
    `<div class="pinRow" data-rel="${esc(f)}" title="${esc(f)}">＋ ${esc(f)}</div>`).join('')
    + (hits.length > 30 ? `<div class="sideNote">… ${hits.length - 30} more — keep typing</div>` : '');
}

/* ── change history (snapshots) ── */

/* ◷ Recent activity — the sidebar feed (change-sets + finished runs + task
   completions). Fetched once per project, refreshed (debounced) when the
   underlying events broadcast. */
/**
 * Fetch ◷ Recent activity once per project (cache-first).
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function ensureFeed(key) {
  if (feedCache[key]) return;
  feedCache[key] = { items: [], fetched: false };
  const d = await apiQuiet('GET', `/api/feed/${enc(key)}`);
  feedCache[key] = { items: (d && Array.isArray(d.items)) ? d.items : [], fetched: true };
  if (ui.view === key) renderWB(key);
}

/**
 * Debounced (800ms) feed re-fetch — snapshot:new / job end / task done.
 * @param {string} key project key
 * @returns {void}
 */
export function refreshFeed(key) {
  if (!state.projects[key]) return;
  clearTimeout(feedTimers[key]);
  feedTimers[key] = setTimeout(() => {
    delete feedCache[key];
    ensureFeed(key);
  }, 800);
}

/**
 * Fetch a task's Δ change history once (cache-first).
 * @param {string} key project key
 * @param {string} taskId
 * @returns {Promise<void>}
 */
export async function ensureSnaps(key, taskId) {
  const ck = `${key}/${taskId}`;
  if (snapsCache[ck]) return;
  snapsCache[ck] = { entries: [], fetched: false };
  const d = await apiQuiet('GET', `/api/snapshots/${enc(key)}?task=${enc(taskId)}`);
  snapsCache[ck] = { entries: (d && Array.isArray(d.entries)) ? d.entries : [], fetched: true };
  if (ui.view === key && curTask(key)?.id === taskId) renderWB(key);
}

/* the running turn's live ✎ aggregate for a task (null when idle / no edits).
   editsLive alone — applyState seeds it from state.sessions, and a direct
   state.sessions fallback would resurrect stale snapshot data (the
   fossil-panel bug). */
/**
 * @param {string} key project key
 * @param {string} taskId
 * @returns {EditsAggregate | null} the running turn's live ✎ aggregate
 */
export function liveEditsOf(key, taskId) {
  const e = editsLive[`${key}/${taskId}`];
  return e && e.files ? e : null;
}

/* before/after blobs for the Δ diff view, fetched once per entry+file */
/**
 * Fetch a change-set file's before/after blobs once (Δ diff view).
 * @param {string} key project key
 * @param {string} eid change-set entry id
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function ensureSnapFile(key, eid, rel) {
  const fk = `${key}::${eid}::${rel}`;
  if (snapFileCache[fk]) return;
  snapFileCache[fk] = { loading: true };
  const d = await apiQuiet('GET', `/api/snapshots/${enc(key)}/${enc(eid)}/file?rel=${enc(rel)}`);
  snapFileCache[fk] = d && !d.error
    ? { before: d.before ?? null, after: d.after ?? null, status: d.status }
    : { error: (d && d.error) || 'diff unavailable' };
  if (ui.view === key) renderWB(key);
}

/* ── WYSIWYG html editing — designMode on the viewer iframe ──
   The page renders with its own CSS but scripts paused, so MathJax/plot code
   stays as source ($...$ etc.) and the saved file remains faithful. While an
   edit is live, renderWB skips this project so WS events can't reload the
   iframe and eat the edits. */

/**
 * Enter WYSIWYG editing on an html artifact (contentEditable iframe).
 * @param {string} key project key
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function startHtmlEdit(key, rel) {
  // grab the raw source once for the doctype + the conflict-guard mtime
  let doctype = '<!DOCTYPE html>';
  let mtimeMs = null;
  try {
    const res = await fetch(artifactUrl(key, rel));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const m = text.match(/^﻿?\s*<!doctype[^>]*>/i);
    if (m) doctype = m[0].trim();
    // precise header first — Last-Modified is second-truncated and trips the
    // 250ms conflict window with spurious 409s
    mtimeMs = Number(res.headers.get('x-mtime-ms'))
      || Date.parse(res.headers.get('last-modified') || '') || null;
  } catch (err) {
    toast('cannot edit ' + rel + ' — ' + (err.message || err));
    return;
  }
  htmlEdits[key] = { rel, doctype, baseMtimeMs: mtimeMs, dirty: false };
  const per = perOf(key);
  per.htmlEdit = rel;
  per.viewerKey = rel;
  renderWB(key);
}

/**
 * PUT the WYSIWYG buffer back to /artifact (mtime-guarded).
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function saveHtmlEdit(key) {
  const st = htmlEdits[key];
  const frame = document.querySelector(`#v-${key} #htmlEditFrame`);
  const doc = frame && frame.contentDocument;
  if (!st || !doc) return;
  const gen = st.gen || 0; // edits made while the PUT is in flight bump gen
  const html = st.doctype + '\n' + doc.documentElement.outerHTML + '\n';
  const r = await api('PUT', artifactUrl(key, st.rel), { content: html, baseMtimeMs: st.baseMtimeMs });
  if (!r || !r.ok) return; // api() toasted the reason (409 = changed on disk)
  st.baseMtimeMs = r.mtimeMs;
  if ((st.gen || 0) === gen) st.dirty = false; // else newer keystrokes stay unsaved
  // disk changed under the code pane — refresh its copy (an unsaved raw draft,
  // if one exists, is kept; its own conflict guard will catch the divergence)
  delete fileCache[`${key}::${st.rel}`];
  toast('saved ' + st.rel);
  htmlEditChrome(key);
}

/**
 * Leave WYSIWYG mode (discarding the live buffer).
 * @param {string} key project key
 * @returns {void}
 */
export function endHtmlEdit(key) {
  const st = htmlEdits[key];
  if (st?.dirty && !confirm('Discard unsaved visual edits to ' + st.rel + '?')) return;
  delete htmlEdits[key];
  perOf(key).htmlEdit = null;
  renderWB(key); // back to the normal scripted view
}

/**
 * Patch the WYSIWYG toolbar's dirty state in place.
 * @param {string} key project key
 * @returns {void}
 */
export function htmlEditChrome(key) {
  const el = document.querySelector(`#v-${key} #htmlDirty`);
  if (el) el.textContent = htmlEdits[key]?.dirty ? '● unsaved — ⌘S' : '';
}

/* the fixed save chip: ONE constant-width box whose dot carries the
   state — no sentence swap, no materializing save button. Click (or ⌘S)
   saves; a tex ▶ saves first anyway. 'stale' = the disk moved under a dirty
   draft (the old "⚠ changed on disk" warning — ⌘S still runs the same
   reload/merge recovery flow). */
/**
 * The footer save-chip's current presentation.
 * @param {string} fkey `${project}::${rel}`
 * @param {string} rel
 * @returns {{ cls: string, txt: string, title: string }}
 */
export function saveChipState(fkey, rel) {
  const dirty = drafts[fkey] != null;
  const stale = dirty && diskStale.has(fkey);
  const ext = isExtRel(rel);
  return {
    cls: stale ? 'saveChip stale' : dirty ? 'saveChip dirty' : 'saveChip',
    txt: stale ? '⚠ disk · ⌘S' : dirty ? 'unsaved · ⌘S' : 'saved · ⌘S',
    title: stale
      ? 'an agent session edited this file on disk while you have unsaved changes — saving offers the reload/merge flow'
      : dirty
        ? `unsaved changes — click or ⌘S saves${ext ? ' through the pin grant' : ''}`
        : ext ? '↗ external — editable, click or ⌘S saves through the pin grant'
          : 'editable — click or ⌘S saves',
  };
}

/* refresh the footer save-chip and tab dirty-dot in place — no re-render,
   so this is safe to call on every keystroke */
/**
 * Refresh the footer save-chip + tab dirty-dot in place (keystroke-safe).
 * @param {string} key project key
 * @returns {void}
 */
export function editorChrome(key) {
  const root = document.getElementById('v-' + key);
  const ed = root && root.querySelector('#codeEditor');
  if (!ed) return;
  const dirty = drafts[ed.dataset.fkey] != null;
  const ss = root.querySelector('#saveState');
  if (ss) {
    const chip = saveChipState(ed.dataset.fkey, ed.dataset.rel);
    ss.className = chip.cls;
    ss.title = chip.title;
    ss.innerHTML = `<i></i>${chip.txt}`;
  }
  const tab = root.querySelector('.ctab.cd.on');
  if (tab) {
    const dot = tab.querySelector('.dirtyDot');
    if (dirty && !dot) tab.insertAdjacentHTML('beforeend', '<span class="dirtyDot">●</span>');
    else if (!dirty && dot) dot.remove();
  }
  syncTexRunControls(key); // the toolbar ▶'s amber dot rides the same signal
}
