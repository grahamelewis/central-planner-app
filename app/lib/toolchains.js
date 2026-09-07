// lib/toolchains.js — what the ▶ button and the job cards depend on, and what
// to install when it is missing. Wraps lib/runtimes.js's toolchainStatus()
// (the single PATH prober — never duplicated here) and enriches it with
// per-bin install hints, native stripping capability and the installed TS executor,
// the duckdb python MODULE the .sql shim imports, and a per-project scan of
// the markers that tell which toolchains a project actually needs.
//
//   describeToolchains()      { [id]: { id, label, required, optional, ok, missing, hint, … } } cached 60 s
//   toolchainsSummary()       the same minus paths (snapshot().toolchains)
//   refreshToolchains()       re-probe now; resolves once the version probes land
//   projectNeeds(root)        { runtimes: ['rust', …], markers: { rust: 'Cargo.toml' } } cached 60 s
//   missingFor(root)          needed − ok → ['go']
//   projectToolchains(root)   { runtimes, markers, missing } (the projects snapshot)
//   createToolchains(deps)    factory with injectable probes (tests)
//
// No REPL daemons this wave: evcxr (rust), gore (go) and `node -i` are future.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { APP_DIR } from './config.js';
import {
  RUNTIMES, toolchainStatus as rtStatus, refreshToolchains as rtRefresh, findBin as rtFindBin, nodeStripsTypes, findTsx,
} from './runtimes.js';

const CACHE_MS = 60000;

/** The runtimes the Settings section lists, in display order. `shell` is
    deliberately absent: bash is not something anyone installs. */
export const TOOLCHAIN_IDS = ['rust', 'go', 'node', 'c', 'cpp', 'julia', 'python', 'r', 'sql', 'tex'];

/**
 * Install hints per binary (macOS first, Linux alternative). A runtime's hint
 * is the union of the hints for its missing bins, so `cc` present but `cmake`
 * absent says `brew install cmake`, not `xcode-select --install`.
 */
export const HINTS = {
  cargo: { darwin: 'install rustup: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh', linux: 'same rustup one-liner (https://rustup.rs)' },
  rustc: { darwin: 'install rustup: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh', linux: 'same rustup one-liner (https://rustup.rs)' },
  go: { darwin: 'brew install go', linux: 'sudo apt install golang-go (or the tarball from go.dev/dl)' },
  node: { darwin: 'brew install node (or nvm install --lts)', linux: 'nvm install --lts (or sudo apt install nodejs npm)' },
  npm: { darwin: 'brew install node (npm ships with it)', linux: 'sudo apt install npm (or nvm install --lts)' },
  cc: { darwin: 'xcode-select --install', linux: 'sudo apt install build-essential' },
  'c++': { darwin: 'xcode-select --install', linux: 'sudo apt install build-essential' },
  make: { darwin: 'xcode-select --install', linux: 'sudo apt install build-essential' },
  cmake: { darwin: 'brew install cmake', linux: 'sudo apt install cmake' },
  ninja: { darwin: 'brew install ninja', linux: 'sudo apt install ninja-build' },
  'cmake+ninja': { darwin: 'brew install cmake ninja', linux: 'sudo apt install cmake ninja-build' },
  julia: { darwin: 'curl -fsSL https://install.julialang.org | sh (juliaup)', linux: 'same juliaup one-liner' },
  python3: { darwin: 'brew install python', linux: 'sudo apt install python3' },
  Rscript: { darwin: 'brew install --cask r', linux: 'sudo apt install r-base' },
  latexmk: { darwin: 'brew install --cask basictex, then sudo tlmgr install latexmk', linux: 'sudo apt install texlive-latex-extra latexmk' },
  // the .sql runner is a python shim that `import duckdb`s — a MODULE, not a CLI
  'duckdb (python module)': { darwin: 'python3 -m pip install duckdb (or pipx runpip)', linux: 'python3 -m pip install duckdb' },
};

/** Project markers → the runtime they imply. `*.ext` entries match by extension. */
export const MARKERS = [
  { name: 'Cargo.toml', id: 'rust' },
  { name: 'go.mod', id: 'go' },
  { name: 'package.json', id: 'node' },
  { name: 'CMakeLists.txt', id: 'c' },
  { name: ['Makefile', 'makefile', 'GNUmakefile'], id: 'c' },
  { name: 'Project.toml', id: 'julia' },
  { name: ['pyproject.toml', 'requirements.txt'], id: 'python' },
  { name: 'renv.lock', id: 'r' },
  { ext: '.tex', id: 'tex' },
  { ext: '.sql', id: 'sql' },
];
/** C++ sources next to a Makefile/CMakeLists turn the `c` need into `cpp`. */
const CPP_EXTS = new Set(['.cc', '.cpp', '.cxx', '.c++', '.C', '.hpp']);
const C_EXTS = new Set(['.c']);

/** Directories the project scan never enters (build output, deps, VCS). */
export const SKIP_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', '.git', '.next', 'coverage', 'vendor',
  '.venv', 'venv', '__pycache__', '.cache', 'runs', '.idea', '.vscode', '.svn', '.hg',
]);
const SCAN_DEPTH = 2;

const shortVersion = (line) => {
  const m = String(line || '').match(/\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : (line ? String(line).slice(0, 40) : null);
};

/**
 * Build a toolchains service. Every probe is injectable so tests never depend
 * on the machine's PATH: `status()` ≙ runtimes.toolchainStatus, `refresh()` ≙
 * runtimes.refreshToolchains, `which(bin)` ≙ findBin, `probeModule(python,
 * mod, cb)` runs `python -c "import mod"`, `now()` the clock.
 */
export function createToolchains({
  status = rtStatus,
  refresh = rtRefresh,
  which = rtFindBin,
  probeModule = defaultProbeModule,
  platform = process.platform,
  now = Date.now,
  appDir = APP_DIR,
} = {}) {
  let cache = { at: 0, value: null };
  const needsCache = new Map(); // root → { at, value }
  // python-module probes: key → { found, version, at }; pending guards re-entry
  const modCache = new Map();
  const modPending = new Map(); // request tokens fence late callbacks after Refresh

  const other = platform === 'darwin' ? 'linux' : 'darwin';
  const hintFor = (list) => {
    const mine = [];
    const theirs = [];
    // cmake + ninja missing together → one brew line, not two
    const bins = list.includes('cmake') && list.includes('ninja')
      ? ['cmake+ninja', ...list.filter((b) => b !== 'cmake' && b !== 'ninja')] : list;
    for (const b of bins) {
      const h = HINTS[b];
      if (!h) continue;
      if (!mine.includes(h[platform] || h.darwin)) mine.push(h[platform] || h.darwin);
      if (!theirs.includes(h[other] || h.linux)) theirs.push(h[other] || h.linux);
    }
    if (!mine.length) return null;
    const otherLabel = other === 'linux' ? 'Linux' : 'macOS';
    return `${mine.join('; ')} · ${otherLabel}: ${theirs.join('; ')}`;
  };

  function moduleStatus(pythonPath, mod) {
    const key = `${pythonPath}::${mod}`;
    const hit = modCache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit;
    if (!modPending.has(key)) {
      const token = {};
      modPending.set(key, token);
      try {
        probeModule(pythonPath, mod, (res) => {
          if (modPending.get(key) !== token) return;
          modPending.delete(key);
          modCache.set(key, { found: !!(res && res.found), version: (res && res.version) || null, at: now() });
        });
      } catch {
        if (modPending.get(key) !== token) return modCache.get(key) || null;
        modPending.delete(key);
        modCache.set(key, { found: false, version: null, at: now() });
      }
    }
    return modCache.get(key) || null; // null until the first probe answers (a sync probe has already)
  }

  function tsxPath() {
    return findTsx({ which, appDir });
  }

  function build(st) {
    const out = {};
    for (const id of TOOLCHAIN_IDS) {
      const rt = RUNTIMES[id];
      const s = st[id] || { ok: false, missing: [], bins: {}, versions: {} };
      const required = [];
      const optional = [];
      for (const t of rt.toolchain || []) {
        const b = s.bins[t.bin] || { path: null, version: null, optional: !!t.optional };
        const row = { bin: t.bin, found: !!b.path, path: b.path || null, version: b.version || null, short: shortVersion(b.version) };
        (t.optional ? optional : required).push(row);
      }
      const extra = {};
      if (id === 'sql') {
        // the shim's `import duckdb` — probed through the python3 the shim runs
        const py = required.find((r) => r.bin === 'python3');
        const m = py && py.path ? moduleStatus(py.path, 'duckdb') : null;
        required.push({
          bin: 'duckdb (python module)', kind: 'module',
          found: !!(m && m.found), path: null,
          version: m && m.found ? `duckdb ${m.version || ''}`.trim() : null,
          short: m && m.found ? m.version : null,
          pending: !!(py && py.path) && m === null,
        });
      }
      if (id === 'node') {
        const nodeRow = required.find((r) => r.bin === 'node');
        const tsx = tsxPath();
        const strips = nodeRow && nodeRow.version ? nodeStripsTypes(nodeRow.version) : (nodeRow && nodeRow.found ? nodeStripsTypes() : false);
        extra.ts = {
          strip: strips, // node ≥ 22.18 / 23.6 / 24 runs .ts directly
          tsx: tsx,      // the exact installed executable used outside project-local overrides
          via: tsx ? 'tsx' : null,
        };
      }
      const missing = required.filter((r) => !r.found && !r.pending).map((r) => r.bin);
      const missingOptional = optional.filter((r) => !r.found).map((r) => r.bin);
      const versions = {};
      for (const r of [...required, ...optional]) versions[r.bin] = r.short;
      out[id] = {
        id, label: rt.label, required, optional,
        ok: missing.length === 0,
        missing, missingOptional, versions,
        hint: hintFor(missing.length ? missing : missingOptional),
        ...extra,
      };
    }
    return out;
  }

  /** Full detail (paths included). Sync; cached 60 s; versions fill in as the probes answer. */
  function describeToolchains({ refresh: force = false } = {}) {
    try {
      if (!force && cache.value && now() - cache.at < CACHE_MS) {
        // async versions/modules may have landed since — rebuild from the
        // (itself cached) status only while something is still unanswered
        const incomplete = Object.values(cache.value).some((t) =>
          [...t.required, ...t.optional].some((r) => (r.found && r.version == null) || r.pending));
        if (incomplete) cache.value = build(status());
        return cache.value;
      }
      cache = { at: now(), value: build(status({ refresh: force })) };
      return cache.value;
    } catch {
      return cache.value || {};
    }
  }

  /** Snapshot form: ok flags, missing bins, short versions, hint — no paths. */
  function toolchainsSummary() {
    const out = {};
    for (const [id, t] of Object.entries(describeToolchains())) {
      out[id] = { id: t.id, label: t.label, ok: t.ok, missing: t.missing, missingOptional: t.missingOptional, versions: t.versions, hint: t.hint };
      if (t.ts) out[id].ts = { strip: t.ts.strip, via: t.ts.via, tsx: !!t.ts.tsx };
    }
    return out;
  }

  /** Re-probe everything now; resolves with the detail once the async probes have answered. */
  async function refreshToolchains() {
    for (const k of modCache.keys()) modCache.delete(k);
    modPending.clear();
    needsCache.clear();
    await refresh();
    // The runtime refresh above already invalidated/reprobed PATH and versions.
    // Do not invalidate them again while assembling this service's result.
    cache = { at: now(), value: build(status()) };
    const t0 = now();
    while (modPending.size && now() - t0 < 6000) await new Promise((r) => setTimeout(r, 25));
    cache = { at: now(), value: build(status()) };
    return cache.value;
  }

  /** Which runtimes a project uses, from its marker files (depth ≤ 2). */
  function projectNeeds(root, { refresh: force = false } = {}) {
    const key = path.resolve(String(root || ''));
    const hit = needsCache.get(key);
    if (!force && hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = scanNeeds(key);
    needsCache.set(key, { at: now(), value });
    return value;
  }

  /** needed − ok → the runtime ids whose required toolchain is missing. */
  function missingFor(root) {
    const needs = projectNeeds(root);
    const tc = describeToolchains();
    return needs.runtimes.filter((id) => tc[id] && !tc[id].ok);
  }

  /** The projects-snapshot form: { runtimes, markers, missing }. */
  function projectToolchains(root) {
    const needs = projectNeeds(root);
    return { runtimes: needs.runtimes, markers: needs.markers, missing: missingFor(root) };
  }

  return {
    describeToolchains, toolchainsSummary, refreshToolchains, projectNeeds, missingFor, projectToolchains,
    _test: { cache: () => cache, needsCache, modCache, hintFor, build },
  };
}

function scanNeeds(root) {
  const runtimes = [];
  const markers = {};
  let sawCpp = false;
  let sawC = false;
  const add = (id, rel) => {
    if (!runtimes.includes(id)) { runtimes.push(id); markers[id] = rel; }
  };
  const walk = (dir, depth, relBase) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < SCAN_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1, rel);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name);
      for (const m of MARKERS) {
        if (m.name && (Array.isArray(m.name) ? m.name.includes(e.name) : m.name === e.name)) add(m.id, rel);
        else if (m.ext && ext.toLowerCase() === m.ext) add(m.id, rel);
      }
      if (CPP_EXTS.has(ext)) sawCpp = true;
      else if (C_EXTS.has(ext)) sawC = true;
    }
  };
  walk(root, 0, '');
  // a Makefile/CMakeLists with C++ sources (and no C ones) is a C++ project
  if (runtimes.includes('c') && sawCpp && !sawC) {
    runtimes[runtimes.indexOf('c')] = 'cpp';
    markers.cpp = markers.c;
    delete markers.c;
  }
  return { runtimes, markers };
}

/** `python -c "import <mod>; print(<mod>.__version__)"` — args array, never a shell string. */
function defaultProbeModule(pythonPath, mod, cb) {
  execFile(pythonPath, ['-c', `import ${mod}, sys; print(getattr(${mod}, '__version__', ''))`],
    { timeout: 8000, maxBuffer: 16 * 1024 }, (err, stdout) => {
      if (err) return cb({ found: false, version: null });
      cb({ found: true, version: String(stdout || '').trim() || null });
    });
}

const DEFAULT = createToolchains();
export const describeToolchains = DEFAULT.describeToolchains;
export const toolchainsSummary = DEFAULT.toolchainsSummary;
export const refreshToolchains = DEFAULT.refreshToolchains;
export const projectNeeds = DEFAULT.projectNeeds;
export const missingFor = DEFAULT.missingFor;
export const projectToolchains = DEFAULT.projectToolchains;
export const _test = { scanNeeds, shortVersion, DEFAULT };
