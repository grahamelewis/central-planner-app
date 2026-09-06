// lib/watchers.js — Agent WATCHERS
// Native recursive artifact watchers (one OS subscription per project) and
// the live tex watch manager (push-triggered one-shot latexmk compiles).
// Never throws out of event handlers; never crashes the process.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from './events.js';
import { PROJECTS, ARTIFACT_GLOBS } from './config.js';
import { containedPath } from './paths.js';
import { parseLatexLog, problemCounts, passFromLine } from './texlog.js';

const MAX_ARTIFACTS = 60;

// ---------------------------------------------------------------------------
// Artifact watchers
// ---------------------------------------------------------------------------

// abs path → { project, path, rel, name, mtime, kind }
const artifacts = new Map();
// project → { watcher: fs.FSWatcher, root }
const artifactWatchers = new Map();
// project → serialized async scan. Native events can request a subtree
// rescan (new directory / missing filename); serialization prevents a burst of
// directory renames from launching overlapping walks.
const artifactScanQueues = new Map();
let artifactWatchersStarted = false;

const ignoreDirSet = new Set(ARTIFACT_GLOBS.ignoreDirs || []);

function kindOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  return null;
}

// True if any path segment of `abs` relative to `root` is an ignored dir name.
function inIgnoredDir(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return false;
  const segments = rel.split(path.sep);
  // For files, the last segment is the basename — still fine to check all
  // segments; a *file* named e.g. "data" without extension is not an artifact anyway.
  return segments.some((seg) => ignoreDirSet.has(seg));
}

// Source/figure extensions that can feed a pinned live compile. Deliberately
// NO build outputs (.aux/.bbl/.synctex.gz…) — a compile must never re-trigger
// itself through the watcher. Data files (.csv/.dat) are also out: simulation
// jobs churn them constantly and \input'd tables are refreshed by the figure
// formats below in practice.
const TEX_DEP_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.tikz', '.eps', '.png', '.jpg', '.jpeg']);
const isTexDep = (p) => TEX_DEP_EXTS.has(path.extname(p).toLowerCase());

function recordArtifact(project, root, abs, stats, ready) {
  try {
    const kind = kindOf(abs);
    if (!kind) return;
    if (inIgnoredDir(root, abs)) return;
    let mtime = stats && stats.mtime ? stats.mtime : null;
    if (!mtime) {
      try {
        mtime = fs.statSync(abs).mtime;
      } catch {
        return; // vanished between event and stat
      }
    }
    const artifact = {
      project,
      path: abs,
      rel: path.relative(root, abs),
      name: path.basename(abs),
      mtime: new Date(mtime).toISOString(),
      kind,
    };
    artifacts.set(abs, artifact);
    pruneArtifacts();
    if (ready && artifacts.has(abs)) {
      try {
        broadcast('artifact:new', { artifact });
      } catch (err) {
        console.error('[watchers] broadcast artifact:new failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[watchers] recordArtifact error:', err.message);
  }
}

function relativeParts(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel === '.') return [];
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).filter(Boolean);
}

// fs.watch does not follow a symlink passed as its root, but recursive native
// backends may still report a target through an alias inside the tree. Check
// every path component with lstat so an event can never cross project roots.
function lstatWithoutSymlinks(root, abs) {
  const parts = relativeParts(root, abs);
  if (!parts) return { outside: true, stats: null };
  let current = root;
  let stats = null;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      stats = fs.lstatSync(current);
    } catch {
      return { missing: true, stats: null };
    }
    if (stats.isSymbolicLink()) return { symlink: true, stats: null };
  }
  return { stats };
}

function withinWatchDepth(root, abs, isDirectory = false) {
  const parts = relativeParts(root, abs);
  if (!parts) return false;
  // Same convention as listProjectFiles: root files are depth 0; a file in
  // root/a/b is depth 2. A directory itself occupies its segment depth.
  const depth = isDirectory ? parts.length : Math.max(0, parts.length - 1);
  return depth <= ARTIFACT_GLOBS.maxDepth;
}

function forgetArtifactTree(abs) {
  const prefix = abs.endsWith(path.sep) ? abs : `${abs}${path.sep}`;
  for (const key of artifacts.keys()) {
    if (key === abs || key.startsWith(prefix)) artifacts.delete(key);
  }
}

async function scanArtifactTree(project, root, start = root, announce = false) {
  const startParts = relativeParts(root, start);
  if (!startParts || inIgnoredDir(root, start)) return 0;
  const stack = [{ dir: start, depth: startParts.length }];
  let indexed = 0;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > ARTIFACT_GLOBS.maxDepth) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // vanished, unreadable, or Dropbox placeholder mid-hydration
    }
    for (const entry of entries) {
      if (entry.name.includes('\0') || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (inIgnoredDir(root, abs)) continue;
      if (entry.isDirectory()) {
        if (depth < ARTIFACT_GLOBS.maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !kindOf(abs)) continue;
      recordArtifact(project, root, abs, null, announce);
      indexed++;
    }
  }
  return indexed;
}

function queueArtifactScan(project, root, start = root, announce = false) {
  const previous = artifactScanQueues.get(project) || Promise.resolve();
  const scan = previous
    .catch(() => {})
    .then(() => scanArtifactTree(project, root, start, announce));
  const settled = scan.catch((err) => {
    console.error(`[watchers] artifact scan failed (${project}):`, err.message);
    return 0;
  });
  artifactScanQueues.set(project, settled);
  settled
    .finally(() => {
      if (artifactScanQueues.get(project) === settled) artifactScanQueues.delete(project);
    });
  return settled;
}

function handleNativeEvent(project, root, filename, ready) {
  try {
    // Native backends are allowed to omit the filename. A serialized rescan is
    // rare and safe; importantly, it creates no persistent per-file handles.
    if (filename == null || String(filename).length === 0) {
      queueArtifactScan(project, root);
      return;
    }
    const rel = String(filename);
    if (path.isAbsolute(rel) || rel.includes('\0')) return;
    const abs = path.resolve(root, rel);
    if (!withinWatchDepth(root, abs) || inIgnoredDir(root, abs)) return;

    const inspected = lstatWithoutSymlinks(root, abs);
    if (inspected.outside || inspected.symlink) {
      forgetArtifactTree(abs);
      return;
    }
    if (inspected.missing || !inspected.stats) {
      forgetArtifactTree(abs);
      if (ready && (isTexDep(abs) || kindOf(abs) === 'pdf')) texDepChanged(project, abs);
      return;
    }
    if (inspected.stats.isDirectory()) {
      if (withinWatchDepth(root, abs, true)) queueArtifactScan(project, root, abs, ready);
      return;
    }
    if (!inspected.stats.isFile()) return;

    if (kindOf(abs)) recordArtifact(project, root, abs, inspected.stats, ready);
    if (ready) texDepChanged(project, abs);
  } catch (err) {
    console.error(`[watchers] native event failed (${project}):`, err.message);
  }
}

function pruneArtifacts() {
  if (artifacts.size <= MAX_ARTIFACTS) return;
  const sorted = [...artifacts.values()].sort(
    (a, b) => new Date(b.mtime) - new Date(a.mtime)
  );
  for (const stale of sorted.slice(MAX_ARTIFACTS)) {
    artifacts.delete(stale.path);
  }
}

export function startArtifactWatchers() {
  if (artifactWatchersStarted) return;
  artifactWatchersStarted = true;

  for (const [project, cfg] of Object.entries(PROJECTS)) {
    const root = cfg && cfg.root;
    try {
      if (!root || !fs.existsSync(root)) {
        console.error(`[watchers] root missing for ${project}: ${root} — skipping`);
        continue;
      }
      let ready = false;
      // One native recursive subscription per project. The previous Chokidar
      // implementation retained one fs.watch handle per eligible file (images
      // included), exhausting child-process stdio descriptors on large trees.
      const watcher = fs.watch(root, { recursive: true, persistent: true }, (_event, filename) => {
        handleNativeEvent(project, root, filename, ready);
      });
      watcher.on('error', (err) => {
        const resource = ['EBADF', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(err && err.code)
          ? ' — filesystem watch resources exhausted'
          : '';
        console.error(`[watchers] watcher error (${project}): ${err && err.message}${resource}`);
      });
      artifactWatchers.set(project, { watcher, root });
      // Subscribe before scanning so files created during the walk cannot fall
      // into a blind window. Initial files populate state quietly, matching the
      // old Chokidar ready contract; only later changes broadcast artifact:new.
      queueArtifactScan(project, root).then((indexed) => {
        ready = true;
        console.log(
          `[watchers] artifact watcher ready: ${project} `
          + `(native recursive; ${indexed} artifacts indexed; ${artifactWatchers.size} subscriptions total)`,
        );
      });
    } catch (err) {
      // e.g. a cloud-synced/network-mounted root acting up — never break the others.
      console.error(`[watchers] failed to start watcher for ${project}:`, err.message);
    }
  }
}

// One-shot listing of a project's files (relative paths) for the pin-a-file
// picker. Same ignore rules as the artifact watchers; skips dotfiles and
// symlinks; bounded by depth and a hard cap so huge repos can't stall us.
export function listProjectFiles(project) {
  const cfg = PROJECTS[project];
  if (!cfg) return [];
  const root = path.resolve(cfg.root);
  const out = [];
  const MAX = 4000;
  const walk = (dir, depth) => {
    if (depth > ARTIFACT_GLOBS.maxDepth || out.length >= MAX) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (e.name.startsWith('.')) continue;
      if (e.name.includes('\r')) continue; // macOS Finder 'Icon\r' droppings
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirSet.has(e.name)) continue;
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

export function getArtifacts() {
  return [...artifacts.values()]
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
    .slice(0, MAX_ARTIFACTS);
}

// ---------------------------------------------------------------------------
// Live tex watch — push-triggered one-shot latexmk compiles
// ---------------------------------------------------------------------------
// v1 kept a `latexmk -pvc` child per watch and let it POLL for changes
// ($sleep_time defaults to 2s — up to 2s of dead air after every save). The
// server already knows the instant a file changes: dashboard saves call
// pokeTex straight from PUT /artifact (zero-latency push), and out-of-band
// edits (agent sessions, external editors, a job regenerating a figure)
// arrive via the artifact watchers above, whose filter also passes
// TEX_DEP_EXTS. Each trigger runs ONE `latexmk -pdf`; latexmk's fdb/MD5
// check is the relevance filter — an irrelevant trigger exits in ~80ms
// without announcing a rule, so no 'building' state is ever broadcast for
// it. Triggers landing mid-compile coalesce into a single follow-up compile
// of the newest state. A killed/crashed compile marks the entry dead; the
// next trigger simply spawns a fresh one-shot (no revive watcher needed).

// project → { child (in-flight one-shot | null), pending, pokeTimer,
//             entry: {tex, pdf, state, lastBuildMs, lastBuiltAt, pages, …},
//             buildStartedAt, killed }
const pdfWatches = new Map();

function broadcastPdf(project) {
  try {
    const w = pdfWatches.get(project);
    if (!w) return;
    broadcast('pdf:status', { project, entry: w.entry });
  } catch (err) {
    console.error('[watchers] broadcast pdf:status failed:', err.message);
  }
}

function parsePagesFromLog(texAbs) {
  try {
    const logPath = texAbs.replace(/\.tex$/i, '.log');
    if (!fs.existsSync(logPath)) return null;
    const txt = fs.readFileSync(logPath, 'utf8');
    const matches = txt.match(/Output written on [^(]*\((\d+) pages?/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1].match(/\((\d+) pages?/);
    return last ? Number(last[1]) : null;
  } catch {
    return null;
  }
}

// Read the .log at the end of a build cycle → problems with project-relative
// file paths (TeX writes them relative to the compile cwd, i.e. dirname(tex)).
export function problemsFromLog(project, texAbs) {
  try {
    const logPath = texAbs.replace(/\.tex$/i, '.log');
    if (!fs.existsSync(logPath)) return [];
    const raw = parseLatexLog(fs.readFileSync(logPath, 'utf8'));
    const cfg = PROJECTS[project];
    const root = cfg ? path.resolve(cfg.root) : null;
    const texDir = path.dirname(texAbs);
    const mainRel = root ? path.relative(root, texAbs) : path.basename(texAbs);
    return raw.map((p) => {
      let rel = mainRel; // un-attributed problems belong to the main file
      if (p.file) {
        const abs = path.resolve(texDir, p.file);
        rel = root && !path.relative(root, abs).startsWith('..')
          ? path.relative(root, abs)
          : p.file;
      }
      return { ...p, file: rel };
    });
  } catch (err) {
    console.error('[watchers] problemsFromLog error:', err.message);
    return [];
  }
}

// End of a SUCCESSFUL cycle — one transition, one broadcast, per save. A
// latexmk cycle runs pdflatex several times (aux/refs), each printing its own
// "Output written on" — treating those as 'built' made the viewer reload
// per PASS (and read the pdf mid-write on the next pass: parse failures that
// looked like crashes). Only the cycle end may declare 'built'.
function finalizeBuild(project) {
  const w = pdfWatches.get(project);
  if (!w || w.entry.state === 'built') return;
  clearTimeout(w.settleTimer);
  w.settleTimer = null;
  const now = Date.now();
  w.entry.state = 'built';
  w.entry.pass = null;
  w.entry.errorMs = null;
  w.entry.dead = false;
  w.entry.lastBuildMs = w.buildStartedAt ? now - w.buildStartedAt : null;
  w.entry.lastBuiltAt = new Date(now).toISOString();
  w.entry.pages = w.pagesInline ?? parsePagesFromLog(w.entry.tex);
  w.entry.problems = problemsFromLog(project, w.entry.tex);
  w.entry.counts = problemCounts(w.entry.problems);
  w.buildStartedAt = null;
  broadcastPdf(project);
}

function handleLatexmkLine(project, line) {
  const w = pdfWatches.get(project);
  if (!w) return;
  try {
    const rebuildStart =
      line.includes('Latexmk: applying rule') ||
      line.includes('Latexmk: Changed files');
    // the authoritative end-of-cycle line (also printed on an MD5-skip:
    // "All targets are up-to-date" → finalizeBuild's built-guard keeps quiet)
    const cycleDone = line.includes('Latexmk: All targets');
    const outputWritten = line.match(/Output written on [^(]*\((\d+) pages?/);
    // a failed compile prints this before exiting nonzero
    const buildFailed = line.includes('Latexmk: Errors');

    if (buildFailed) {
      clearTimeout(w.settleTimer);
      w.settleTimer = null;
      w.entry.state = 'error';
      w.entry.pass = null;
      // how long the failing cycle took — the viewer's ✗ chip shows it
      w.entry.errorMs = w.buildStartedAt ? Date.now() - w.buildStartedAt : null;
      w.entry.problems = problemsFromLog(project, w.entry.tex);
      w.entry.counts = problemCounts(w.entry.problems);
      w.buildStartedAt = null;
      broadcastPdf(project);
    } else if (rebuildStart) {
      // another pass starting cancels any pending premature 'built'
      clearTimeout(w.settleTimer);
      w.settleTimer = null;
      if (w.entry.state !== 'building') {
        w.entry.state = 'building';
        w.entry.pass = null;
        w.entry.errorMs = null;
        w.entry.dead = false; // a rule is actually running — not crashed
        w.buildStartedAt = Date.now();
        w.pagesInline = null;
        broadcastPdf(project);
      }
    } else if (cycleDone) {
      finalizeBuild(project);
    } else if (outputWritten) {
      // remember the freshest page count; declare 'built' only if the cycle
      // stays quiet (belt for latexmk variants that phrase the end differently)
      w.pagesInline = Number(outputWritten[1]);
      clearTimeout(w.settleTimer);
      w.settleTimer = setTimeout(() => finalizeBuild(project), 900);
    } else {
      // rule-run boundaries inside the cycle ("Run number 2 of rule
      // 'pdflatex'") — the viewer's staged bar and verdict chip feed on these
      const pass = passFromLine(line);
      if (pass && w.entry.state === 'building') {
        w.entry.pass = pass;
        broadcastPdf(project);
      }
    }
  } catch (err) {
    console.error('[watchers] latexmk line parse error:', err.message);
  }
}

export function watchTex(project, texPathAbs) {
  try {
    const cfg = PROJECTS[project];
    if (!cfg) return { error: `unknown project: ${project}` };
    if (typeof texPathAbs !== 'string' || !texPathAbs.trim()) {
      return { error: 'tex path required' };
    }

    if (!texPathAbs.toLowerCase().endsWith('.tex')) {
      return { error: 'tex path must end with .tex' };
    }
    // realpath containment (symlink-safe), same discipline as /artifact & runs
    const contained = containedPath(project, texPathAbs);
    if (!contained) return { error: 'tex path must be an existing file inside the project root' };
    const tex = contained.abs;

    // Replace any existing watch for this project.
    if (pdfWatches.has(project)) unwatchTex(project);

    const entry = {
      tex,
      pdf: tex.replace(/\.tex$/i, '.pdf'),
      state: 'building',
      pass: null,     // { n, rule } while a rule is running inside the cycle
      errorMs: null,  // duration of the last FAILED cycle (✗ chip)
      lastBuildMs: null,
      lastBuiltAt: null,
      pages: null,
      problems: [],
      counts: { errors: 0, warnings: 0, badboxes: 0 },
    };
    const w = {
      child: null, pending: false, pokeTimer: null,
      entry, buildStartedAt: Date.now(), killed: false,
    };
    pdfWatches.set(project, w);

    // catch-up build: MD5-skips straight to 'built' when the pdf is current
    startCompile(project);
    console.log(`[watchers] live tex watch started for ${project}: ${tex} (compile on save)`);
    broadcastPdf(project);
    return { ok: true };
  } catch (err) {
    console.error('[watchers] watchTex error:', err.message);
    return { error: err.message };
  }
}

// The compile's own pdf lands back in the artifact watcher — never let it
// re-trigger the compile (epstopdf's conversions included). Everything else
// a compile writes is already filtered out by TEX_DEP_EXTS.
function isOwnBuildOutput(w, abs) {
  return abs === w.entry.pdf || /-eps-converted-to\.pdf$/i.test(abs);
}

/** Artifact-watcher feed: a file changed on disk out-of-band (agent session,
 *  external editor, a job regenerating a figure) — recompile if the pinned
 *  watch could care. Figure pdfs count as dependencies; html artifacts don't. */
function texDepChanged(project, abs) {
  const w = pdfWatches.get(project);
  if (!w) return;
  if (!isTexDep(abs) && kindOf(abs) !== 'pdf') return;
  if (isOwnBuildOutput(w, abs)) return;
  schedulePoke(project);
}

/** The push path: a file was just saved through the app (PUT /artifact) —
 *  the server IS the change notifier, no filesystem-event latency. Any
 *  extension goes; latexmk's MD5 check decides whether it matters. */
export function pokeTex(project, abs) {
  try {
    const w = pdfWatches.get(project);
    if (!w || isOwnBuildOutput(w, abs)) return;
    schedulePoke(project);
  } catch (err) {
    console.error('[watchers] pokeTex error:', err.message);
  }
}

// Agent turns write several files back-to-back, and an app save is followed
// by its own native-watcher echo — coalesce briefly so one edit burst = one compile.
const POKE_COALESCE_MS = 150;

function schedulePoke(project) {
  const w = pdfWatches.get(project);
  if (!w) return;
  clearTimeout(w.pokeTimer);
  w.pokeTimer = setTimeout(() => {
    w.pokeTimer = null;
    startCompile(project);
  }, POKE_COALESCE_MS);
}

function startCompile(project) {
  const w = pdfWatches.get(project);
  if (!w) return;
  if (w.child) {
    // one compile at a time; the newest state compiles right after this one
    w.pending = true;
    return;
  }
  const tex = w.entry.tex;

  // -synctex=1 → source↔PDF navigation; -file-line-error → parseable
  // errors; no -halt-on-error: nonstopmode reports EVERY error and still
  // writes the survivable pages, Overleaf-style, instead of dying at the
  // first typo. max_print_line stops TeX hard-wrapping log lines mid-path.
  const child = spawn(
    'latexmk',
    ['-pdf', '-interaction=nonstopmode', '-synctex=1', '-file-line-error', tex],
    {
      cwd: path.dirname(tex),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, max_print_line: '2000', error_line: '254', half_error_line: '238' },
    }
  );
  w.child = child;

  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    try {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLatexmkLine(project, line);
      }
    } catch (err) {
      console.error('[watchers] stdout handler error:', err.message);
    }
  });
  child.stderr.on('data', () => {
    /* latexmk is chatty on stderr; failures surface via lines + exit code */
  });
  child.on('error', (err) => {
    console.error(`[watchers] latexmk spawn error (${project}):`, err.message);
    const cur = pdfWatches.get(project);
    if (!cur || cur.child !== child || cur.killed) return;
    // a failed spawn (e.g. ENOENT) emits 'error'+'close' but never 'exit'
    cur.child = null;
    clearTimeout(cur.settleTimer);
    cur.settleTimer = null;
    cur.entry.state = 'error';
    cur.entry.pass = null;
    cur.entry.dead = true; // the next save retries the spawn
    broadcastPdf(project);
  });
  child.on('exit', (code, signal) => {
    const cur = pdfWatches.get(project);
    if (!cur || cur.child !== child) return; // superseded or unwatched
    cur.child = null;
    if (cur.killed) return;
    if (code === 0) {
      // belt for latexmk variants that phrase the cycle end differently —
      // finalizeBuild is idempotent and the 'All targets' line usually got here first
      finalizeBuild(project);
    } else if (cur.entry.state !== 'error') {
      // died without latexmk reporting errors (the 'Latexmk: Errors' line
      // would have set state 'error' already) — killed or crashed mid-cycle
      console.error(`[watchers] latexmk died (${project}) code=${code} signal=${signal}`);
      clearTimeout(cur.settleTimer);
      cur.settleTimer = null;
      cur.entry.state = 'error';
      cur.entry.pass = null;
      cur.entry.dead = true; // ✗ chip: "crashed — restarts on your next save"
      cur.entry.errorMs = cur.buildStartedAt ? Date.now() - cur.buildStartedAt : null;
      cur.entry.problems = problemsFromLog(project, cur.entry.tex);
      cur.entry.counts = problemCounts(cur.entry.problems);
      cur.buildStartedAt = null;
      broadcastPdf(project);
    }
    if (cur.pending) {
      // a trigger landed mid-compile — run once more against the newest state
      cur.pending = false;
      schedulePoke(project);
    }
  });
}

export function unwatchTex(project) {
  try {
    const w = pdfWatches.get(project);
    pdfWatches.delete(project);
    if (!w) return;
    clearTimeout(w.settleTimer);
    clearTimeout(w.pokeTimer);
    if (w.child) {
      w.killed = true;
      try {
        w.child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  } catch (err) {
    console.error('[watchers] unwatchTex error:', err.message);
  }
}

export function getPdfWatches() {
  const out = {};
  for (const [project, w] of pdfWatches.entries()) {
    out[project] = { ...w.entry };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup — kill latexmk children on process exit / signals.
// ---------------------------------------------------------------------------

function killAllChildren(signal = 'SIGTERM') {
  for (const w of pdfWatches.values()) {
    if (w && w.child) {
      w.killed = true;
      try {
        w.child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }
}

function closeArtifactWatchers() {
  for (const rec of artifactWatchers.values()) {
    try { rec.watcher.close(); } catch { /* already closed */ }
  }
  artifactWatchers.clear();
  artifactScanQueues.clear();
}

process.on('exit', () => {
  closeArtifactWatchers();
  killAllChildren('SIGTERM');
});
process.on('SIGINT', () => {
  closeArtifactWatchers();
  killAllChildren('SIGTERM');
  process.exit(130);
});
process.on('SIGTERM', () => {
  closeArtifactWatchers();
  killAllChildren('SIGTERM');
  process.exit(143);
});
