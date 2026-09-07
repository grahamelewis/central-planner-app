// lib/runtimes.js — the ONE registry behind the ▶ button, the job card's
// language rows, and the client's runnable-extension list. Every runtime says
// how a file of its kind is run (standalone, or inside the nearest project
// marker), how the job card pins its process, whether its stdout block-buffers
// when piped (→ the runner's pty path), which output parser reads it, and
// which binaries it needs. Nothing here spawns a run: resolveRunTarget()
// returns a plan (steps) that lib/runner.js executes; toolchainStatus() only
// runs `--version` probes, cached, never throwing.
//
//   RUNTIMES                         id → runtime (shape documented on `rust` below)
//   runtimeForExt(ext)               '.rs' → RUNTIMES.rust | null
//   resolveRunTarget({project, abs, root, mode}) → plan | { error }
//   runnableExts()                   ['.jl', '.py', …] (registry order, deduped)
//   runtimesSnapshot()               { exts, byExt, toolchains } for /api/state
//   toolchainStatus()                { rust: {ok, missing, bins, versions}, … } cached 60 s
//   findBin(name) / hasBin(name)     which-style PATH lookup, cached 60 s
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { ROOT, APP_DIR } from './config.js';

const DARWIN = process.platform === 'darwin';
const CACHE_MS = 60000;

// ---------------------------------------------------------------------------
// PATH lookup + toolchain probes
// ---------------------------------------------------------------------------

const binCache = new Map(); // name → { path: string|null, at }

/** which-style lookup on the server's PATH (60 s cache); a name with a slash
    is checked as a path. Never throws. */
export function findBin(name) {
  try {
    const n = String(name || '');
    if (!n) return null;
    if (n.includes('/')) {
      try { fs.accessSync(n, fs.constants.X_OK); return n; } catch { return null; }
    }
    const hit = binCache.get(n);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.path;
    let found = null;
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); found = p; break; }
      } catch { /* not here */ }
    }
    binCache.set(n, { path: found, at: Date.now() });
    return found;
  } catch {
    return null;
  }
}

export const hasBin = (name) => !!findBin(name);

// `<bin> --version` results: bin → { version: string|null, at }
const versionCache = new Map();
const versionPending = new Map(); // bin → unique probe token (fences late pre-refresh callbacks)

function probeVersion(bin, binPath, args) {
  if (versionPending.has(bin)) return;
  const token = {};
  versionPending.set(bin, token);
  try {
    execFile(binPath, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (versionPending.get(bin) !== token) return;
      versionPending.delete(bin);
      const text = `${stdout || ''}\n${stderr || ''}`;
      const line = text.split('\n').map((l) => l.trim()).find(Boolean) || null;
      versionCache.set(bin, { version: err && !line ? null : line, at: Date.now() });
    });
  } catch {
    if (versionPending.get(bin) !== token) return;
    versionPending.delete(bin);
    versionCache.set(bin, { version: null, at: Date.now() });
  }
}

let toolchainCache = { at: 0, status: null };

/**
 * Per-runtime toolchain presence. Synchronous (PATH lookups are cheap) and
 * cached 60 s; the `--version` strings arrive asynchronously — the first call
 * kicks the probes off and reports `version: null` until they land.
 * Shape: { [id]: { ok, missing: [bin…], bins: { [bin]: { path, version, optional } }, versions: { [bin]: string|null } } }
 */
export function toolchainStatus({ refresh = false } = {}) {
  try {
    if (refresh) {
      binCache.clear();
      versionCache.clear();
      versionPending.clear(); // obsolete children may finish, but their tokens no longer match
      toolchainCache = { at: 0, status: null };
    }
    if (!refresh && toolchainCache.status && Date.now() - toolchainCache.at < CACHE_MS) {
      return fillVersions(toolchainCache.status);
    }
    const status = {};
    for (const rt of Object.values(RUNTIMES)) {
      const bins = {};
      const missing = [];
      for (const t of rt.toolchain || []) {
        const p = findBin(t.bin);
        bins[t.bin] = { path: p, version: null, optional: !!t.optional };
        if (!p && !t.optional) missing.push(t.bin);
        if (p) {
          const v = versionCache.get(t.bin);
          if (!v || Date.now() - v.at > CACHE_MS) probeVersion(t.bin, p, t.version || ['--version']);
        }
      }
      status[rt.id] = { ok: missing.length === 0, missing, bins, versions: {} };
    }
    toolchainCache = { at: Date.now(), status };
    return fillVersions(status);
  } catch {
    return toolchainCache.status || {};
  }
}

function fillVersions(status) {
  const out = {};
  for (const [id, s] of Object.entries(status)) {
    const bins = {};
    const versions = {};
    for (const [bin, b] of Object.entries(s.bins)) {
      const v = b.path ? (versionCache.get(bin)?.version ?? null) : null;
      bins[bin] = { ...b, version: v };
      versions[bin] = v;
    }
    out[id] = { ok: s.ok, missing: [...s.missing], bins, versions };
  }
  return out;
}

/** Promise form: resolves once every pending `--version` probe has answered. */
export async function refreshToolchains() {
  toolchainStatus({ refresh: true });
  const t0 = Date.now();
  while (versionPending.size && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 25));
  return toolchainStatus();
}

// Informational native stripping capability only; direct TS/JSX execution
// uses installed tsx regardless, because stripping omits valid TS syntax.
// The version comes from the PATH node's probe when available.
export function nodeStripsTypes(version) {
  const v = String(version || versionCache.get('node')?.version || process.versions.node || '').replace(/^v/, '');
  const m = v.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]); const minor = Number(m[2]);
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

// ---------------------------------------------------------------------------
// Helpers shared by the entries
// ---------------------------------------------------------------------------

function venvPython(root) {
  return ['.venv/bin/python', 'venv/bin/python']
    .map((v) => path.join(root, v))
    .find((v) => fs.existsSync(v)) || null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readHead(file, bytes = 8192) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// The .sql runner: execute the file statement-by-statement through the duckdb
// python package (see the sql entry for why). Kept as one -c program so
// nothing is written to disk; the script path travels in PM_RUN_FILE like the
// R wrapper's, so nothing is ever interpolated into the program text.
const SQL_SHIM = `
import os, sys
try:
    import duckdb
except ImportError:
    sys.exit("the duckdb python package is not installed for this interpreter - pip install duckdb")
src = open(os.environ["PM_RUN_FILE"], encoding="utf-8").read()
con = duckdb.connect()  # in-memory; ATTACH in the script for a database file
try:
    statements = duckdb.extract_statements(src)
except duckdb.Error as e:
    sys.exit(f"parse error: {e}")
for st in statements:
    head = " ".join(st.query.split())[:88]
    try:
        rel = con.sql(st.query)
        if rel is not None:
            print(f"-- {head}")
            print(rel)
    except duckdb.Error as e:
        print(f"-- {head}", file=sys.stderr)
        sys.exit(f"error: {e}")
`;

const CARGO_ENV = { CARGO_TERM_PROGRESS_WHEN: 'always', CARGO_TERM_PROGRESS_WIDTH: '80', CARGO_TERM_COLOR: 'never' };

function cargoRunSpec({ root, abs, markerFile }) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel.startsWith('src/bin/')) {
    return { cmd: 'cargo', args: ['run'], cwd: root, phase: 'compiling', parser: 'cargo' };
  }
  const selected = /^src\/bin\/([^/]+)\.rs$/.exec(rel)
    || /^src\/bin\/([^/]+)\/main\.rs$/.exec(rel);
  const manifest = readHead(markerFile, 256 * 1024);
  let complete = false;
  try { complete = fs.statSync(markerFile).size <= 256 * 1024; } catch { /* unavailable */ }
  // Only Cargo's conventional automatic targets are inferred. Any explicit
  // bin declaration, disabled auto-discovery, oversized/unknown manifest, or
  // helper module requires a target choice rather than guessing a different
  // executable. Conservative string matches may refuse unusual TOML safely.
  // A full TOML parser would be needed to distinguish escaped keys, inline
  // target arrays and array-table headers inside multiline strings. Refuse
  // those uncertain cases, even when the match happens to be in a comment.
  const custom = /\[\[/.test(manifest)
    || /^\s*["']?bin["']?\s*=/m.test(manifest)
    || /\\[uU][0-9a-fA-F]/.test(manifest)
    || /\bautobins["']?\s*=\s*false\b/.test(manifest);
  if (!selected || !complete || !/^\s*\[\s*["']?package["']?\s*\]/m.test(manifest) || custom) {
    return { error: 'This Cargo source needs an explicit binary target choice. Use cargo run --bin <target> from the crate directory; no different binary was started.' };
  }
  return { cmd: 'cargo', args: ['run', '--bin', selected[1]], cwd: root, phase: 'compiling', parser: 'cargo' };
}

// C / C++ share one factory: markers CMakeLists.txt (only when cmake is
// installed — otherwise the level falls through) then Makefile; standalone
// file = compile to the data root's bin dir, then run the binary under a pty
// (stdio block-buffers when piped, so the card would otherwise see nothing
// until exit).
function cFamily(id, label, exts, compiler, dialect) {
  return {
    id, label, exts, dialect,
    project: [
      {
        marker: 'CMakeLists.txt',
        when: (probe) => probe('cmake'),
        run: ({ root }) => ({
          steps: [
            { cmd: 'cmake', args: ['-S', root, '-B', path.join(root, 'build')], cwd: root, phase: 'configuring', parser: 'build' },
            { cmd: 'cmake', args: ['--build', path.join(root, 'build')], cwd: root, phase: 'building', parser: 'build' },
            {
              phase: 'running', pty: true, parser: null, display: '<built executable>',
              deferred: () => {
                const exe = singleExecutableIn(path.join(root, 'build'));
                if (exe === null) return { skip: 'build finished — no single executable in build/ to run (stopping at built)' };
                return { cmd: exe, args: [], cwd: path.dirname(exe), display: `./${path.basename(exe)}` };
              },
            },
          ],
        }),
        test: ({ root }) => ({
          steps: [
            { cmd: 'cmake', args: ['-S', root, '-B', path.join(root, 'build')], cwd: root, phase: 'configuring', parser: 'build' },
            { cmd: 'cmake', args: ['--build', path.join(root, 'build')], cwd: root, phase: 'building', parser: 'build' },
            { cmd: 'ctest', args: ['--test-dir', path.join(root, 'build'), '--output-on-failure'], cwd: root, phase: 'tests', parser: 'build' },
          ],
        }),
      },
      {
        marker: ['Makefile', 'makefile', 'GNUmakefile'],
        run: ({ root, base }) => ({
          steps: [
            { cmd: 'make', args: [], cwd: root, phase: 'building', parser: 'build' },
            {
              phase: 'running', pty: true, parser: null, display: `./${base}`,
              deferred: () => {
                const exe = path.join(root, base);
                if (!isExecutableFile(exe)) return { skip: `make finished — no ./${base} to run (stopping at built)` };
                return { cmd: exe, args: [], cwd: root, display: `./${base}` };
              },
            },
          ],
        }),
        test: ({ root, markerFile }) => {
          if (!/^test\s*:/m.test(readHead(markerFile, 65536))) return { error: `${path.basename(markerFile)} has no test target` };
          return { cmd: 'make', args: ['test'], cwd: root, phase: 'tests', parser: 'build' };
        },
      },
    ],
    file: ({ abs, dir, out }) => ({
      steps: [
        { cmd: compiler, args: ['-Wall', '-O0', '-g', abs, '-o', out], cwd: dir, phase: 'compiling', parser: 'build' },
        { cmd: out, args: [], cwd: dir, phase: 'running', pty: true, parser: null, built: true, display: `./${path.basename(out)}` },
      ],
    }),
    pin: 'self',
    argv0: /(^|\/)(cc|c\+\+|gcc|g\+\+|clang|clang\+\+|make|gmake|cmake|ninja|ctest)$/,
    session: { names: dialect === 'c' ? ['cc', 'gcc', 'clang'] : ['c++', 'g++', 'clang++'], ext: new RegExp(`\\.(${exts.map((e) => e.slice(1).replace(/\+/g, '\\+')).join('|')})$`) },
    buffered: true,
    parser: 'build',
    monaco: dialect, hl: dialect,
    toolchain: [{ bin: 'cc' }, { bin: 'c++' }, { bin: 'make' }, { bin: 'cmake', optional: true }, { bin: 'ninja', optional: true }],
  };
}

function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// exactly one executable regular file directly under `dir` (cmake's own
// artefacts are never executable) → its path; null otherwise
function singleExecutableIn(dir) {
  try {
    const exes = fs.readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((p) => isExecutableFile(p) && !/\.(so|dylib|a|o|cmake|txt|json|sh)$/i.test(p));
    return exes.length === 1 ? exes[0] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const RUNTIMES = {
  julia: {
    id: 'julia', label: 'Julia', exts: ['.jl'],
    // honour the nearest Project.toml so the project's package env is active
    project: [{
      marker: 'Project.toml',
      run: ({ root, abs, dir }) => ({ cmd: 'julia', args: [`--project=${root}`, abs], cwd: dir, phase: 'running' }),
    }],
    file: ({ abs, dir }) => ({
      cmd: 'julia', args: [abs], cwd: dir, phase: 'running',
      note: 'no Project.toml between the file and the project root — running in julia\'s global environment',
    }),
    pin: 'self', argv0: /(^|\/)julia(-[\w.]+)?$/i,
    buffered: false, parser: 'julia', monaco: 'julia', hl: 'julia',
    toolchain: [{ bin: 'julia' }],
  },
  python: {
    id: 'python', label: 'Python', exts: ['.py'],
    project: [],
    file: ({ abs, dir, projectRoot }) => {
      const venv = venvPython(projectRoot);
      return {
        cmd: venv || 'python3', args: [abs], cwd: dir, phase: 'running',
        // piped python block-buffers stdout (8 KiB bursts) — without this the
        // job card's line rate and quiet clock would be fiction
        env: { PYTHONUNBUFFERED: '1' },
        note: venv ? null : 'no .venv/venv in the project root — using python3 from PATH',
      };
    },
    pin: 'self', argv0: /(^|\/)(python[\d.]*|uv)$/i,
    // the env flag above is the fix; the card's `buffered` flag goes true
    // only if a run somehow lacks it (see runner.js)
    buffered: false, bufferedWithoutEnv: 'PYTHONUNBUFFERED',
    parser: 'python', monaco: 'python', hl: 'python',
    toolchain: [{ bin: 'python3' }],
  },
  r: {
    id: 'r', label: 'R', exts: ['.r'], // '.R' folds to it (runtimeForExt is case-tolerant)
    project: [],
    // plain `Rscript file.R` reports runtime errors with NO line numbers
    // ("Error in f() : boom"). Wrapping in source(keep.source=TRUE) with
    // show.error.locations makes R append the failing line ("(from file.R#5)")
    // and gives file:line:col for syntax errors; stdout/auto-printing and exit
    // codes stay identical to plain Rscript (verified against R 4.5.2 —
    // deferred warnings gain an "In eval(ei, envir):" prefix, the one known
    // difference). The script path travels in an env var so the user script's
    // commandArgs() stays empty, exactly as under plain Rscript; nothing is
    // ever interpolated into the -e expression.
    file: ({ abs, dir }) => ({
      cmd: 'Rscript',
      args: [
        '--no-save', '-e',
        'options(show.error.locations=TRUE); source(Sys.getenv("PM_RUN_FILE"), keep.source=TRUE, print.eval=TRUE)',
      ],
      cwd: dir, phase: 'running',
      env: { PM_RUN_FILE: abs },
      display: `Rscript ${path.basename(abs)}`, // the -e wrapper is noise in the UI footer
    }),
    pin: 'self', argv0: /(^|\/)(Rscript|R)$/,
    buffered: false, parser: 'r', monaco: 'r', hl: 'r',
    toolchain: [{ bin: 'Rscript' }],
  },
  shell: {
    id: 'shell', label: 'Shell', exts: ['.sh'],
    project: [],
    // shell scripts are how cargo/go/make used to be run from here: cargo hides
    // its `Building [==> ] n/m` bar when piped unless told otherwise (the job
    // card's only honest crate denominator); harmless for everything else
    file: ({ abs, dir }) => ({
      cmd: 'bash', args: [abs], cwd: dir, phase: 'running',
      env: { CARGO_TERM_PROGRESS_WHEN: 'always', CARGO_TERM_PROGRESS_WIDTH: '80' },
    }),
    pin: 'self', argv0: /(^|\/)(bash|sh|zsh)$/,
    buffered: false, parser: 'shell', monaco: 'shell', hl: 'sh',
    toolchain: [{ bin: 'bash' }],
  },
  sql: {
    id: 'sql', label: 'SQL', exts: ['.sql'],
    project: [],
    // DuckDB via its python package (the CLI is rarely installed; the package
    // rides the same python the .py branch resolves). In-memory connection —
    // parquet/CSV are queryable in place from the file's own folder, and a
    // database file is a deliberate `ATTACH` in the script, never a guess by
    // us (a wrong guess could contend with a live analysis pipeline's lock).
    // Statements run one at a time so EVERY result set prints, not just the
    // last, with duckdb's own box tables; an error names the statement and
    // its line before exiting non-zero.
    file: ({ abs, dir, projectRoot }) => {
      const venv = venvPython(projectRoot);
      return {
        cmd: venv || 'python3', args: ['-c', SQL_SHIM], cwd: dir, phase: 'running',
        env: { PM_RUN_FILE: abs, PYTHONUNBUFFERED: '1' }, // the shim is python too — see the python entry
        display: `duckdb ${path.basename(abs)}`,
        note: 'duckdb, in-memory — parquet/CSV readable from the script\'s folder; ATTACH database files explicitly in the script',
      };
    },
    pin: 'self', argv0: /(^|\/)(duckdb|psql|sqlite3|mysql)$/i,
    buffered: false, parser: 'sql', monaco: 'sql', hl: 'sql',
    toolchain: [{ bin: 'python3' }],
  },
  tex: {
    id: 'tex', label: 'LaTeX', exts: ['.tex'],
    card: false, // tex compiles keep their own build card — never a job
    project: [],
    // one-shot compile (the live watch's own compile is separate); the artifact
    // watcher picks up the resulting .pdf and the show panel can display it.
    // Same flags as the watcher: -synctex=1 (source↔PDF nav), -file-line-error
    // (parseable errors), nonstopmode without -halt-on-error (report every
    // error, still write the survivable pages). max_print_line in env stops
    // TeX hard-wrapping log lines mid-path.
    file: ({ abs, dir }) => ({
      cmd: 'latexmk',
      args: ['-pdf', '-interaction=nonstopmode', '-synctex=1', '-file-line-error', abs],
      cwd: dir, phase: 'compiling',
      env: { max_print_line: '2000', error_line: '254', half_error_line: '238' },
      tex: abs,
    }),
    pin: 'self', argv0: /(^|\/)(latexmk|pdflatex|xelatex|lualatex)$/,
    buffered: false, parser: 'latex', monaco: 'latex', hl: 'latex',
    toolchain: [{ bin: 'latexmk' }],
  },

  // ── wave 1 ──
  rust: {
    id: 'rust', label: 'Rust', exts: ['.rs'],
    // project markers, nearest-first from the file's dir up to the project root
    project: [{
      marker: 'Cargo.toml',
      run: cargoRunSpec,
      test: ({ root }) => ({ cmd: 'cargo', args: ['test'], cwd: root, phase: 'compiling', parser: 'cargo' }),
    }],
    // standalone file fallback: compile into the data root's bin dir, then run
    file: ({ abs, dir, out, mode }) => ({
      steps: [
        { cmd: 'rustc', args: [...(mode === 'test' ? ['--test'] : []), '-o', out, abs], cwd: dir, phase: 'compiling', parser: 'rust' },
        { cmd: out, args: [], cwd: dir, phase: mode === 'test' ? 'tests' : 'running', parser: mode === 'test' ? 'cargo' : null, built: true, display: `./${path.basename(out)}` },
      ],
    }),
    // cargo run execs target/debug/<bin>: the spawned pid BECOMES the program
    pin: 'self',
    argv0: /(^|\/)(cargo|rustc)$|(^|\/)target\/(debug|release)\//,
    session: { names: ['cargo', 'rustc'], ext: /\.rs$/i },
    env: CARGO_ENV,
    buffered: false,          // Rust's stdout is a LineWriter — flushes fine when piped
    parser: 'cargo',          // project runs; 'rust' rides the rustc step of a file run
    monaco: 'rust', hl: 'rs', testFile: /(^|\/)tests\/|_test\.rs$/,
    toolchain: [{ bin: 'cargo', version: ['--version'] }, { bin: 'rustc', version: ['--version'] }],
  },
  go: {
    id: 'go', label: 'Go', exts: ['.go'],
    project: [{
      marker: 'go.mod',
      // `go run .` from the file's directory when it holds package main
      // (the package is the unit), else `go run <file>`
      run: ({ abs, dir }) => (/^\s*package\s+main\b/m.test(readHead(abs))
        ? { cmd: 'go', args: ['run', '.'], cwd: dir, phase: 'compiling', parser: 'go' }
        : { cmd: 'go', args: ['run', abs], cwd: dir, phase: 'compiling', parser: 'go' }),
      test: ({ root }) => ({ cmd: 'go', args: ['test', './...'], cwd: root, phase: 'tests', parser: 'go' }),
    }],
    file: ({ abs, dir, mode }) => (mode === 'test'
      ? { cmd: 'go', args: ['test', abs], cwd: dir, phase: 'tests', parser: 'go' }
      : { cmd: 'go', args: ['run', abs], cwd: dir, phase: 'compiling', parser: 'go' }),
    // go run spawns $TMPDIR/go-build*/b001/exe/<name>; go test spawns <pkg>.test
    pin: 'child',
    argv0: /go-build\d+\/b\d+\/exe\/|\.test$/,
    session: { names: ['go'], ext: /\.go$/i },
    buffered: false, parser: 'go', monaco: 'go', hl: 'go', testFile: /_test\.go$/,
    toolchain: [{ bin: 'go', version: ['version'] }],
  },
  node: {
    id: 'node', label: 'Node', exts: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'],
    project: [{
      marker: 'package.json',
      run: (ctx) => {
        const pkg = readJson(ctx.markerFile);
        if (pkg && pkg.scripts && typeof pkg.scripts.start === 'string') {
          return {
            cmd: 'npm', args: ['run', 'start'], cwd: ctx.root, phase: 'running', parser: 'node',
            pin: 'child', // sh -c → node
            note: `package.json has a start script — running \`npm run start\` from ${path.basename(ctx.root)}/ (the project, not just this file)`,
          };
        }
        return nodeFileSpec(ctx, 'run');
      },
      test: (ctx) => {
        const pkg = readJson(ctx.markerFile);
        if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string') {
          return { cmd: 'npm', args: ['test'], cwd: ctx.root, phase: 'tests', parser: 'node', pin: 'child' };
        }
        return nodeFileSpec(ctx, 'test');
      },
    }],
    file: (ctx) => nodeFileSpec(ctx, ctx.mode),
    pin: 'self',
    argv0: /(^|\/)(node|nodejs|deno|bun|tsx)$/,
    session: { names: ['node', 'nodejs', 'deno', 'bun', 'tsx', 'npm', 'npx'], ext: /\.(js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i },
    // macOS async pipes: never SIGKILL a finished node early (the runner only
    // ever signals on stop) — output is let drain naturally
    buffered: false, parser: 'node',
    monaco: (ext) => (/^\.[cm]?tsx?$/.test(ext) ? 'typescript' : 'javascript'),
    hl: (ext) => (/^\.[cm]?tsx?$/.test(ext) ? 'ts' : 'js'),
    testFile: /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__)\//,
    toolchain: [{ bin: 'node' }, { bin: 'npm' }],
  },
  c: cFamily('c', 'C', ['.c'], 'cc', 'c'),
  cpp: cFamily('cpp', 'C++', ['.cc', '.cpp', '.cxx', '.c++', '.C'], 'c++', 'cpp'),
};

/** Find an already-installed TS/JSX executor. Never invoke npm/npx or install.
 * Project-local dependencies win, then PATH, then the dashboard's bundled tsx.
 * The Settings service uses this same resolver without project coordinates. */
export function findTsx({ dir = null, root = null, which = findBin, appDir = APP_DIR } = {}) {
  const executable = candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return null;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { return null; }
  };
  if (dir && root) {
    const limit = path.resolve(root);
    let current = path.resolve(dir);
    while (current === limit || current.startsWith(limit + path.sep)) {
      const candidate = executable(path.join(current, 'node_modules', '.bin', 'tsx'));
      if (candidate) return candidate;
      if (current === limit) break;
      current = path.dirname(current);
    }
  }
  return which('tsx') || executable(path.join(appDir, 'node_modules', '.bin', 'tsx'));
}

// Native Node stripping omits enums/parameter properties and ignores tsconfig;
// use a full installed executor consistently, including on newer Node versions.
function nodeFileSpec({ abs, dir, ext, projectRoot, tsxBinary }, mode) {
  const needsTsx = /^\.(?:[cm]?ts|[jt]sx)$/i.test(ext);
  const testArgs = mode === 'test' ? ['--test'] : [];
  if (!needsTsx) {
    return { cmd: 'node', args: [...testArgs, abs], cwd: dir, phase: mode === 'test' ? 'tests' : 'running', parser: 'node' };
  }
  const tsx = tsxBinary === undefined ? findTsx({ dir, root: projectRoot }) : tsxBinary;
  if (!tsx) return { error: 'TypeScript/JSX requires installed tsx — install project dependencies or the dashboard dependencies first (nothing is downloaded automatically)' };
  return {
    cmd: tsx, args: [...testArgs, abs], cwd: dir, phase: mode === 'test' ? 'tests' : 'running', parser: 'node',
    pin: 'child', // tsx's CLI starts a Node child for the actual program
    note: 'using installed tsx for TypeScript/JSX — no package download',
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const BY_EXT = (() => {
  const exact = new Map();
  const lower = new Map();
  for (const rt of Object.values(RUNTIMES)) {
    for (const e of rt.exts) {
      if (!exact.has(e)) exact.set(e, rt);
      if (!lower.has(e.toLowerCase())) lower.set(e.toLowerCase(), rt);
    }
  }
  return { exact, lower };
})();

/** '.rs' → RUNTIMES.rust; case-exact first ('.C' is C++), then case-folded. */
export function runtimeForExt(ext) {
  const e = String(ext || '');
  return BY_EXT.exact.get(e) || BY_EXT.lower.get(e.toLowerCase()) || null;
}

/** Every runnable extension (with the dot), registry order, deduped. */
export function runnableExts() {
  const out = [];
  for (const rt of Object.values(RUNTIMES)) for (const e of rt.exts) if (!out.includes(e)) out.push(e);
  return out;
}

/** Session-detection rows for jobs.js INTERPRETERS: { id: {names, lang, ext} }. */
export function sessionInterpreterRows() {
  const out = {};
  for (const rt of Object.values(RUNTIMES)) {
    if (rt.session) out[rt.id] = { names: [...rt.session.names], lang: rt.id, ext: rt.session.ext };
  }
  return out;
}

/** jobs.js INTERP_ARGV0 rows for the runtimes that carry a session row. */
export function sessionArgv0Rows() {
  const out = {};
  for (const rt of Object.values(RUNTIMES)) if (rt.session && rt.argv0) out[rt.id] = rt.argv0;
  return out;
}

/** ext → runtime id for every runtime that gets a job card (tex excluded). */
export function runLangs() {
  const out = {};
  for (const rt of Object.values(RUNTIMES)) {
    if (rt.card === false) continue;
    for (const e of rt.exts) { const k = e.toLowerCase(); if (!(k in out)) out[k] = rt.id; }
  }
  return out;
}

/** What /api/state carries as `runtimes`. */
export function runtimesSnapshot() {
  const byExt = {};
  for (const rt of Object.values(RUNTIMES)) {
    for (const e of rt.exts) {
      if (!byExt[e]) byExt[e] = { id: rt.id, label: rt.label, pin: rt.pin, buffered: !!rt.buffered };
    }
  }
  return { exts: runnableExts(), byExt, toolchains: toolchainStatus() };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// compiled single files land here — never inside the user's project
function outPathFor(project, abs) {
  const dir = path.join(ROOT, 'runs', String(project), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(abs).replace(/\.[^.]+$/, '') || 'a.out';
  return path.join(dir, base);
}

// the footer line for one step: leaf names for the file and the compiled
// binary, project-relative paths for anything under the project root
function stepDisplay(step, { abs, projectRoot }) {
  if (step.display) return step.display;
  const runsDir = path.join(ROOT, 'runs') + path.sep;
  const shown = (step.args || []).map((a) => {
    if (a === abs) return path.basename(abs);
    if (a.startsWith('--project=')) return `--project=…/${path.basename(a.slice(10))}`;
    if (a.startsWith(runsDir)) return `./${path.basename(a)}`;
    if (a === projectRoot) return '.';
    if (a.startsWith(projectRoot + path.sep)) return path.relative(projectRoot, a);
    return a;
  });
  const cmd = step.cmd.startsWith(runsDir) ? `./${path.basename(step.cmd)}` : step.cmd.split('/').pop();
  return [cmd, ...shown].join(' ');
}

function normalizeSteps(spec) {
  if (!spec) return null;
  if (Array.isArray(spec.steps)) return spec.steps.map((s) => ({ ...s }));
  const { steps, note, pin, ...one } = spec; // eslint-disable-line no-unused-vars
  return [one]; // a single-step spec keeps its own `display` (R's -e wrapper, the sql shim)
}

/**
 * Plan a ▶ run for `abs` (an existing file under `root`, the project's
 * realpath'd root). Walks from the file's dir up to `root` (never above) for
 * the runtime's project markers — nearest level wins, markers tried in the
 * runtime's order at each level — else the standalone-file recipe.
 * `mode` defaults to 'run', or 'test' when the file matches the runtime's
 * testFile. Returns { runtime, label, mode, steps, phases, display, note,
 * projectRoot, pin, argv0, buffered, parser, tex? } or { error }.
 * Test seams: `nodeVersion` (the .ts rule) and `probe(bin) → bool` (replaces
 * the PATH lookup for the marker `when` guards and the toolchain pre-check).
 */
export function resolveRunTarget({ project, abs, root, mode, nodeVersion, tsxBinary, probe } = {}) {
  try {
    const has = typeof probe === 'function' ? probe : hasBin;
    if (typeof abs !== 'string' || !abs) return { error: 'file required' };
    const ext = path.extname(abs);
    const rt = runtimeForExt(ext);
    if (!rt) return { error: `don't know how to run ${ext || 'this file'}` };
    const projectRoot = path.resolve(root || path.dirname(abs));
    const dir = path.dirname(abs);
    if (dir !== projectRoot && !dir.startsWith(projectRoot + path.sep)) return { error: 'file is outside the project root' };
    if (mode != null && mode !== 'run' && mode !== 'test') return { error: `unknown mode: ${mode}` };
    const auto = !mode && !!(rt.testFile && rt.testFile.test(path.relative(projectRoot, abs)));
    const useMode = mode || (auto ? 'test' : 'run');
    const base = path.basename(abs).replace(/\.[^.]+$/, '');

    // `out` is lazy (a non-enumerable getter, so spreading never triggers it):
    // the bin dir is created only when a recipe actually compiles into it
    let outCache = null;
    const mkCtx = (extra) => {
      const c = {
        project, abs, dir, ext, base, projectRoot, mode: useMode, nodeVersion, tsxBinary,
        root: projectRoot, markerFile: null, ...extra,
      };
      Object.defineProperty(c, 'out', {
        enumerable: false,
        get() { if (!outCache) outCache = outPathFor(project, abs); return outCache; },
      });
      return c;
    };
    const ctx = mkCtx({});

    // nearest marker wins; never walk above the project root
    let spec = null;
    let markerRoot = null;
    let d = dir;
    for (;;) {
      for (const m of rt.project || []) {
        if (m.when && !m.when(has)) continue;
        const names = Array.isArray(m.marker) ? m.marker : [m.marker];
        const file = names.map((n) => path.join(d, n)).find((f) => fs.existsSync(f));
        if (!file) continue;
        const fn = useMode === 'test' ? m.test : m.run;
        if (!fn) {
          if (useMode === 'test' && mode === 'test') return { error: `${rt.label} has no test mode for a ${names[0]} project` };
          continue;
        }
        spec = fn(mkCtx({ root: d, markerFile: file }));
        markerRoot = d;
        break;
      }
      if (spec || d === projectRoot) break;
      const parent = path.dirname(d);
      if (parent === d || !parent.startsWith(projectRoot)) break;
      d = parent;
    }
    if (!spec) {
      if (!rt.file) return { error: `${rt.label} files need a project (${(rt.project || []).map((m) => (Array.isArray(m.marker) ? m.marker[0] : m.marker)).join(' / ')}) — none found up to the project root` };
      if (useMode === 'test' && mode === 'test' && !rt.testFile) return { error: `${rt.label} has no test mode` };
      spec = rt.file(ctx);
    }
    if (!spec) return { error: `don't know how to run ${ext || 'this file'}` };
    if (spec.error) return { error: spec.error };

    const steps = normalizeSteps(spec);
    for (const s of steps) {
      if (s.deferred) { s.phase = s.phase || 'running'; s.display = s.display || '<built target>'; continue; }
      s.phase = s.phase || 'running';
      s.env = { ...(rt.env || {}), ...(s.env || {}) };
      if (s.pty == null) s.pty = false;
      s.display = stepDisplay(s, { abs, projectRoot });
      if (!('parser' in s)) s.parser = rt.parser || null;
      // toolchain pre-check — a missing binary answers here, not as a spawn error
      if (!s.built && !has(s.cmd)) return { error: `${s.cmd.split('/').pop()} not found on the server PATH` };
    }
    const display = (Array.isArray(spec.steps) && spec.display) || steps.map((s) => s.display).join(' && ');
    const notes = [];
    if (spec.note) notes.push(spec.note);
    if (auto) notes.push(`${path.basename(abs)} looks like a test file — running in test mode`);
    return {
      runtime: rt.id,
      label: rt.label,
      mode: useMode,
      steps,
      phases: steps.map((s) => s.phase),
      display: useMode === 'test' && !/\btest\b/.test(display) ? `${display} (test)` : display,
      note: notes.length ? notes.join(' · ') : null,
      projectRoot: markerRoot,
      pin: spec.pin || rt.pin || 'self',
      argv0: rt.argv0 || null,
      buffered: !!rt.buffered,
      bufferedWithoutEnv: rt.bufferedWithoutEnv || null,
      parser: rt.parser || null,
      card: rt.card !== false, // false = no job card (tex keeps its build card)
      ...(spec.tex ? { tex: spec.tex } : {}),
    };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

/** Shell-quote for `script -c` on Linux (single quotes, POSIX-safe). */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** argv for running `cmd args` under a pseudo-terminal via script(1); null when script is missing. */
export function ptyArgv(cmd, args) {
  if (!findBin('script')) return null;
  if (DARWIN) return { cmd: 'script', args: ['-q', '/dev/null', cmd, ...args] };
  return { cmd: 'script', args: ['-qec', [cmd, ...args].map(shQuote).join(' '), '/dev/null'] };
}

// test seam
export const _test = { binCache, versionCache, stepDisplay, outPathFor, singleExecutableIn };
