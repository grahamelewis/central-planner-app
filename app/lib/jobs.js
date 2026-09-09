// lib/jobs.js — live monitor for long-running script executions ("job cards").
//
// Two sources feed one registry:
//   'session' — a task turn's Bash tool call that runs a julia/R/python script
//               (detected from the streamed tool_use command). The process is
//               spawned by the SDK subprocess, so its stdout is NOT visible —
//               stats come from polling the process table: pid, %CPU, memory.
//   'run'     — the ▶ run path (lib/runner.js). We own the child, so on top of
//               the process stats the output stream is parsed for real progress
//               (iter N/M, percentages, ProgressMeter/txtProgressBar bars,
//               reported ETAs) plus a "quiet" clock (time since last output).
//
// One `ps` sweep (~every 2s) serves every live job. A job only becomes VISIBLE
// (broadcast as `job:status`, included in the snapshot's `jobs`) once it has
// run for MIN_AGE — quick scripts come and go without a card ever flashing.
// Ended jobs broadcast a terminal state and linger briefly for reloads.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import { broadcast } from './events.js';
import { PROJECTS, ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';
import { probe as probeProcs } from './jobProbe.js';
import { createJobParser, stripAnsi } from './jobParsers.js';
import { RUNTIMES, runLangs, sessionInterpreterRows, sessionArgv0Rows } from './runtimes.js';

const log = (...args) => console.log('[jobs]', ...args);
const logErr = (...args) => console.error('[jobs]', ...args);

// env seams so tests don't need to wait 8s per card
const MIN_AGE_MS = Number(process.env.CP_JOB_MIN_AGE_MS ?? 8000);
const POLL_MS = Math.max(250, Number(process.env.CP_JOB_POLL_MS ?? 2000));
const LINGER_MS = 30000;       // ended visible jobs stay for snapshot reloads
// v3 telemetry (see CONTRACT.md "Job cards v3"): cores from cputime deltas
// smoothed with an EMA, health from cores + root state + output silence
const CORES_EMA_ALPHA = 1 / 3;
const LOW_CORES = 0.05;        // below this the tree counts as not computing
const STALL_MS = 20000;        // continuous low-CPU (and silence) before "stalled"
const PROBE_EVERY = 2;         // footprint/thread probe on every other tick
const PROBE_TIMEOUT_MS = 1500;
const OUTPUT_RATE_WINDOW_S = 10;
const LAST_LINE_MAX = 160;
const HOST_CORES = (() => {
  try { return (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || null; } catch { return null; }
})();
// injectable clock (tests drive health/stale transitions without waiting)
let nowFn = Date.now;
// session pid vanished but no tool_result yet (&& chains; also the ONLY end
// signal for backgrounded/detached jobs)
const PID_GONE_GRACE_MS = Number(process.env.CP_JOB_GONE_MS ?? 10000);
// bg/detached job whose process was never found — retire the watch instead of
// polling ps until the server restarts
const PID_FIND_TIMEOUT_MS = Number(process.env.CP_JOB_FIND_MS ?? 10 * 60 * 1000);
const KILL_ESCALATE_MS = 6000; // SIGTERM → SIGKILL if the tree ignores it

// key → job (see publicJob for the wire shape; underscore fields are internal)
const jobs = new Map();
let pollTimer = null;
let polling = false;

// ---------------------------------------------------------------------------
// Command detection — does this Bash command run a julia/R/python script file?
// ---------------------------------------------------------------------------

// KEYED, not positional (reordering must never break python detection). The
// six original rows stay verbatim; the wave-1 runtimes (rust, go, node, c,
// cpp) come from lib/runtimes.js — one registry, so the ▶ button, this table
// and INTERP_ARGV0 can't drift apart.
const INTERPRETERS = {
  julia: { names: ['julia'], lang: 'julia', ext: /\.jl$/i },
  r: { names: ['rscript', 'r'], lang: 'r', ext: /\.(r|rmd)$/i },
  python: { names: ['python', 'python3', 'python2', 'uv'], lang: 'python', ext: /\.py$/i },
  // notebooks: `jupyter nbconvert --execute x.ipynb`, `jupyter execute`,
  // papermill, quarto render — the kernel does the long compute
  notebook: { names: ['jupyter', 'jupyter-nbconvert', 'jupyter-execute', 'jupyter-run', 'nbconvert', 'papermill'], lang: 'notebook', ext: /\.ipynb$/i },
  quarto: { names: ['quarto'], lang: 'notebook', ext: /\.(qmd|ipynb|rmd)$/i },
  sql: { names: ['duckdb', 'psql', 'sqlite3', 'mysql'], lang: 'sql', ext: /\.sql$/i },
  ...sessionInterpreterRows(),
};
const INTERPRETER_ROWS = Object.values(INTERPRETERS);

// inline-eval markers: `julia -e '…'`, `Rscript -e`, `python -c`, heredocs
const INLINE_FLAGS = new Set(['-e', '-E', '--eval', '-c']);

// ---------------------------------------------------------------------------
// Launchers without a script file — `cargo run`, `go test ./...`, `npm test`,
// `make -j8`, `cmake --build build`, `./target/debug/app`. A hit from these
// carries a `pin` the sweep uses instead of the interpreter+basename rule:
//   any:   [{argv0, needle}] — a process qualifies when its argv0 matches
//          and (needle == null || its args contain/match needle)
//   child: RegExp | null — after the launcher is pinned, re-pin ONCE to its
//          shallowest descendant whose argv0 matches (npm's sh -c → node,
//          go run's go-build exe); shallowest, never a worker pool
//   tree:  the launcher is the tree root (cargo, make, watchers): pin the
//          candidate closest to the tool call and never descend to a child
//   tok:   the token the detached-line check anchors on
// ---------------------------------------------------------------------------

const NODEISH_RE = /(^|\/)(node|nodejs|npm|npx|pnpm|yarn|corepack|deno|bun|tsx|nodemon)$/;
const NODE_CHILD_RE = RUNTIMES.node.argv0;   // node|nodejs|deno|bun|tsx
const GO_CHILD_RE = RUNTIMES.go.argv0;       // go-build…/exe/ | .test
const BIN_DIR_RE = /(^|\/)(target\/(debug|release)|build|bin|out|_build|zig-out|\.build)\//;
const BIN_EXTS = new Set(['', '.out', '.exe', '.test', '.bin']);
const INSTALLISH = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'ci', 'init', 'create', 'publish', 'link',
  'unlink', 'why', 'list', 'ls', 'll', 'outdated', 'audit', 'cache', 'config', 'set', 'get', 'info', 'view', 'login',
  'logout', 'pack', 'version', 'upgrade', 'update', 'up', 'import', 'env', 'prune', 'rebuild', 'store', 'patch',
  'dedupe', 'doctor', 'help', 'fund', 'search', 'whoami', 'token', 'owner', 'deprecate', 'completion', 'workspaces',
  'workspace', 'setup', 'policies', 'bin', 'explain', 'lockfile', 'fetch', 'licenses', 'node', 'pm', 'x']);
const VERSIONISH = new Set(['--version', '-V', '--help', '-h', '-help', 'version', 'help']);
const isRedirect = (t) => /^\d*[<>]|^&>|^>>/.test(t);
const binRe = (rel) => new RegExp(`(^|/)${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// the wave-1 runtimes whose project markers name the language of a fileless
// launcher or a bare binary — the marker names come from the registry
const MARKER_LANGS = ['rust', 'go', 'node', 'c'];
const markerNamesOf = (id) => (RUNTIMES[id] && RUNTIMES[id].project || [])
  .flatMap((m) => (Array.isArray(m.marker) ? m.marker : [m.marker]));

/** nearest project marker at or above `dir`, never above `root` (a dir outside
    the root checks only itself): { id, file, dir } | null */
function nearestMarker(dir, root) {
  if (!dir) return null;
  let d = path.resolve(dir);
  const top = root ? path.resolve(root) : null;
  for (let i = 0; i < 16; i++) {
    for (const id of MARKER_LANGS) {
      for (const name of markerNamesOf(id)) {
        const f = path.join(d, name);
        try { if (fs.statSync(f).isFile()) return { id, file: f, dir: d }; } catch { /* not here */ }
      }
    }
    if (top && d === top) break;
    const parent = path.dirname(d);
    if (parent === d || (top && !parent.startsWith(top))) break;
    d = parent;
  }
  return null;
}

// C or C++ for a CMakeLists/Makefile project: the CMake languages line, else
// the sources beside the marker (and in src/)
function cDialect(mk) {
  try {
    if (/CMakeLists\.txt$/.test(mk.file)) {
      const head = fs.readFileSync(mk.file, 'utf8').slice(0, 65536);
      if (/\bCXX\b/.test(head)) return 'cpp';
      if (/\bLANGUAGES\s+C\b/.test(head)) return 'c';
    }
    for (const sub of ['', 'src']) {
      let names = [];
      try { names = fs.readdirSync(path.join(mk.dir, sub)); } catch { continue; }
      if (names.some((n) => /\.(cpp|cc|cxx|c\+\+|C)$/.test(n))) return 'cpp';
      if (names.some((n) => /\.c$/.test(n))) return 'c';
    }
  } catch { /* display only */ }
  return 'c';
}

const markerLang = (mk) => (mk ? (mk.id === 'c' ? cDialect(mk) : mk.id) : null);

// crate / module / package name from the marker file; the marker's dir otherwise
function projectName(mk) {
  try {
    const txt = fs.readFileSync(mk.file, 'utf8').slice(0, 65536);
    if (mk.id === 'rust') {
      const m = txt.match(/^\s*\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms);
      if (m) return m[1];
    } else if (mk.id === 'go') {
      const m = txt.match(/^\s*module\s+"?([^\s"]+)/m);
      if (m) return m[1].split('/').pop();
    } else if (mk.id === 'node') {
      const j = JSON.parse(txt);
      if (j && typeof j.name === 'string' && j.name) return j.name.split('/').pop();
    }
  } catch { /* fall through */ }
  return path.basename(mk.dir);
}

// `cd` inside the command moves where the marker walk starts
function chdir(cwd, arg, root) {
  if (!arg || arg === '~' || arg === '-' || arg.startsWith('$HOME')) return root;
  if (arg.startsWith('/')) return arg.replace(/\/+$/, '') || '/';
  return cwd ? path.resolve(cwd, arg) : null;
}

const nonFlags = (toks) => toks.filter((t) => t && !t.startsWith('-') && !t.startsWith('+') && !isRedirect(t));
const valueOf = (toks, names) => {
  for (let i = 0; i < toks.length; i++) {
    for (const n of names) {
      if (toks[i] === n) return toks[i + 1] || null;
      if (toks[i].startsWith(`${n}=`)) return toks[i].slice(n.length + 1);
    }
  }
  return null;
};
const label = (name, ...words) => `${name || 'project'} (${words.filter(Boolean).join(' ')})`;
const nameAt = (c, id) => {
  const mk = nearestMarker(c.cwd, c.root);
  if (mk && (!id || mk.id === id)) return projectName(mk);
  return c.cwd ? path.basename(c.cwd) : null;
};
const mkHit = (lang, file, pin, tok, titleKind = 'label') => ({ lang, file, titleKind, detached: false, inline: false, pin: { ...pin, tok } });

// a bare binary: `./x`, `./build/app`, `target/debug/app`, `bin/tool`. Paths
// under a build dir are taken on faith (the agent just built them); a plain
// `./x` must exist, be executable and not be a #! script (else `./configure`
// and `./run.sh`-style wrappers would get a card); the tail of a compile
// chain (`cc x.c -o x && ./x`) is taken on faith too. Absolute paths only
// inside the project root — never /usr/bin/env or /dev/null.
function binaryToken(tok, c, chain = false) {
  if (!tok || tok.startsWith('-') || tok.includes('=') || isRedirect(tok) || /^\d+$/.test(tok)) return null;
  const rel = tok.replace(/^\.\//, '');
  const base = rel.split('/').pop();
  if (!base || !BIN_EXTS.has(path.extname(base).toLowerCase())) return null;
  const pathy = tok.startsWith('./') || tok.startsWith('../') || tok.startsWith('/');
  const inBinDir = BIN_DIR_RE.test(tok);
  if (!pathy && !inBinDir) return null;
  if (tok.startsWith('/') && !(c.root && tok.startsWith(c.root + '/'))) return null;
  const abs = tok.startsWith('/') ? tok : (c.cwd ? path.resolve(c.cwd, tok) : null);
  if (!inBinDir && !chain) {
    if (!abs) return null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || !(st.mode & 0o111)) return null;
      const fd = fs.openSync(abs, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') === '#!') return null;
    } catch { return null; }
  }
  let lang = markerLang(nearestMarker(abs ? path.dirname(abs) : null, c.root));
  if (!lang) {
    if (/(^|\/)target\/(debug|release)\//.test(tok)) lang = 'rust';
    else if (/go-build\d+\/|\.test$/.test(tok)) lang = 'go';
  }
  return { lang, rel, argv0: binRe(rel) };
}

// the launcher table: base name → { parse(rest, ctx) → hit | null }
const CARGO_SUBS = new Set(['run', 'r', 'test', 't', 'bench', 'build', 'b', 'check', 'c', 'clippy', 'doc', 'watch', 'nextest', 'miri', 'fmt']);
const GO_SUBS = new Set(['run', 'test', 'build', 'vet', 'generate', 'install', 'tool']);
const CARGO_PIN = { any: [{ argv0: /(^|\/)(cargo|rustc)$/, needle: /(^|[\s/])cargo\s/ }, { argv0: /(^|\/)target\/(debug|release)\//, needle: null }], child: null, tree: true };
const compileSub = (sub) => ['build', 'b', 'check', 'c', 'clippy'].includes(sub);

function nodeScriptLauncher(base) {
  return {
    lang: 'node',
    parse(rest, c) {
      const toks = rest.filter((t) => !isRedirect(t));
      let i = 0;
      while (i < toks.length && toks[i].startsWith('-')) i++;
      const sub = toks[i];
      if (!sub || VERSIONISH.has(sub)) return null;
      let script = null;
      if (base === 'npx' || sub === 'exec' || sub === 'x' || sub === 'dlx') {
        script = base === 'npx' ? sub : nonFlags(toks.slice(i + 1))[0];
        if (!script) return null;
      } else if (sub === 'run' || sub === 'run-script') {
        script = nonFlags(toks.slice(i + 1))[0];
        if (!script) return null;
      } else if (sub === 'test' || sub === 't' || sub === 'tst') script = 'test';
      else if (sub === 'start') script = 'start';
      else if (base !== 'npm' && !INSTALLISH.has(sub)) script = sub; // yarn build · pnpm lint · bun test
      else return null;
      const shown = base === 'npx' ? ['npx', script] : ['run', 'run-script', 'exec', 'x', 'dlx'].includes(sub) ? [base, sub, script] : [base, script];
      const own = base === 'deno' || base === 'bun'; // the launcher IS the runtime
      return mkHit('node', label(nameAt(c, 'node'), ...shown), {
        any: [{ argv0: NODEISH_RE, needle: new RegExp(`(^|[\\s/])${escRe(base)}(\\.js|\\.cjs|\\.mjs|-cli\\.js)?\\s`) }],
        child: own ? null : NODE_CHILD_RE,
        tree: true,
      }, base);
    },
  };
}

const LAUNCHERS = {
  cargo: {
    parse(rest, c) {
      const toks = nonFlags(rest);
      const sub = toks[0];
      if (!sub || !CARGO_SUBS.has(sub)) return null;
      const target = valueOf(rest, ['--bin', '--example', '-p', '--package']);
      const name = target || nameAt(c, 'rust');
      return mkHit('rust', label(name, 'cargo', sub), { ...CARGO_PIN, compile: compileSub(sub) }, 'cargo');
    },
  },
  go: {
    parse(rest, c) {
      const sub = rest[0];
      if (!sub || !GO_SUBS.has(sub)) return null;
      // package paths (`.`, `./...`, `./cmd/foo`) name the target; flag values don't
      const pkgs = rest.slice(1).filter((t) => (t.startsWith('.') || t.includes('/')) && !t.startsWith('-') && !isRedirect(t));
      const pkg = pkgs.find((t) => !/^\.\.?$|\.\.\.$/.test(t) && !/\.go$/i.test(t));
      const name = pkg ? pkg.replace(/\/+$/, '').split('/').pop() : nameAt(c, 'go');
      return mkHit('go', label(name, 'go', sub), {
        any: [{ argv0: /(^|\/)go$/, needle: /(^|[\s/])go\s+(run|test|build|vet|generate|install|tool)(\s|$)/ }],
        child: sub === 'run' || (sub === 'test' && !rest.includes('-c')) ? GO_CHILD_RE : null,
        tree: true,
        compile: sub === 'build' || sub === 'install' || (sub === 'test' && rest.includes('-c')),
      }, 'go');
    },
  },
  air: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t))) return null;
      return mkHit('go', label(nameAt(c, 'go'), 'air'), { any: [{ argv0: /(^|\/)air$/, needle: null }], child: null, tree: true }, 'air');
    },
  },
  npm: nodeScriptLauncher('npm'),
  npx: nodeScriptLauncher('npx'),
  pnpm: nodeScriptLauncher('pnpm'),
  yarn: nodeScriptLauncher('yarn'),
  bun: nodeScriptLauncher('bun'),
  deno: nodeScriptLauncher('deno'),
  node: {
    parse(rest, c) {
      // `node --test [dir]`, `node --run script` — no script file to anchor on
      const run = valueOf(rest, ['--run']);
      if (!rest.includes('--test') && !run) return null;
      const shown = run ? ['node --run', run] : ['node --test'];
      return mkHit('node', label(nameAt(c, 'node'), ...shown), {
        any: [{ argv0: NODE_CHILD_RE, needle: run ? '--run' : '--test' }], child: null, tree: true,
      }, 'node');
    },
  },
  nodemon: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t))) return null;
      const file = nonFlags(rest).find((t) => RUNTIMES.node.session.ext.test(t));
      return mkHit('node', file || label(nameAt(c, 'node'), 'nodemon'), {
        any: [{ argv0: NODEISH_RE, needle: 'nodemon' }], child: null, tree: true,
      }, 'nodemon', file ? 'file' : 'label');
    },
  },
  make: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t) || t === '-n' || t === '--dry-run' || t === '-q' || t === '--question')) return null;
      const toks = rest.filter((t) => !isRedirect(t));
      let dir = valueOf(toks, ['-C', '--directory']);
      const cwd = dir ? chdir(c.cwd, dir, c.root) : c.cwd;
      // targets: non-flag tokens that aren't VAR=val or the value of -j/-C/-f
      const targets = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (['-j', '-C', '--directory', '-f', '--file', '-I', '-o', '-W', '--jobs'].includes(t)) { i++; continue; }
        if (t.startsWith('-') || t.includes('=')) continue;
        targets.push(t);
      }
      const mk = nearestMarker(cwd, c.root);
      const lang = markerLang(mk);
      if (!lang) return null;
      return mkHit(lang, label(mk ? projectName(mk) : null, 'make', targets[0]), {
        any: [{ argv0: /(^|\/)g?make$/, needle: null }], child: null, tree: true, compile: true,
      }, 'make');
    },
  },
  cmake: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t) || t === '-P' || t === '-E')) return null;
      const build = rest.includes('--build');
      const src = valueOf(rest, ['-S']);
      const cwd = src ? chdir(c.cwd, src, c.root) : c.cwd;
      const mk = nearestMarker(cwd, c.root);
      const lang = markerLang(mk);
      if (!lang) return null;
      return mkHit(lang, label(mk ? projectName(mk) : null, 'cmake', build ? '--build' : null), {
        any: [{ argv0: /(^|\/)cmake$/, needle: null }], child: null, tree: true, compile: build,
      }, 'cmake');
    },
  },
  ninja: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t) || t === '-n')) return null;
      const dir = valueOf(rest, ['-C']);
      const mk = nearestMarker(dir ? chdir(c.cwd, dir, c.root) : c.cwd, c.root);
      const lang = markerLang(mk);
      if (!lang) return null;
      return mkHit(lang, label(mk ? projectName(mk) : null, 'ninja'), {
        any: [{ argv0: /(^|\/)ninja$/, needle: null }], child: null, tree: true, compile: true,
      }, 'ninja');
    },
  },
  ctest: {
    parse(rest, c) {
      if (rest.some((t) => VERSIONISH.has(t) || t === '-N')) return null;
      const mk = nearestMarker(c.cwd, c.root);
      const lang = markerLang(mk);
      if (!lang) return null;
      return mkHit(lang, label(mk ? projectName(mk) : null, 'ctest'), {
        any: [{ argv0: /(^|\/)ctest$/, needle: null }], child: null, tree: true,
      }, 'ctest');
    },
  },
};
LAUNCHERS.gmake = LAUNCHERS.make;

// commands that only NAME a binary (`rm -rf target/debug/app`, `ls build/`,
// `strip bin/tool`): never a run, whatever path follows
const NOT_RUNNERS = new Set(['rm', 'ls', 'cat', 'cp', 'mv', 'chmod', 'chown', 'file', 'strip', 'otool', 'ldd', 'nm',
  'objdump', 'du', 'stat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'find', 'fd', 'echo', 'test', 'mkdir', 'touch',
  'xattr', 'codesign', 'install', 'tar', 'zip', 'unzip', 'git', 'gh', 'open', 'which', 'wc', 'md5', 'shasum', 'diff',
  'cmp', 'hexdump', 'xxd', 'strings', 'readelf', 'size', 'ln', 'rsync', 'scp', 'tee', 'sed', 'awk', 'sort', 'uniq',
  'cut', 'tr', 'xargs', 'printf', 'kill', 'pkill', 'pgrep', 'lsof', 'curl', 'wget', 'export', 'source', 'type',
  'realpath', 'basename', 'dirname', 'dsymutil', 'lipo', 'ar', 'ranlib', 'chflags', 'trash']);

// scan one segment's tokens for a fileless launcher or a bare binary
function launcherHit(tokens, c) {
  const first = tokens.find((t) => t && !/^(nohup|setsid|time|env|sudo|caffeinate|exec)$/.test(t.split('/').pop()) && !/^[A-Z_][A-Z0-9_]*=/.test(t));
  if (first && NOT_RUNNERS.has(first.split('/').pop().toLowerCase())) return null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || isRedirect(tok)) continue;
    const base = tok.split('/').pop().toLowerCase();
    const L = LAUNCHERS[base];
    if (L) {
      const h = L.parse(tokens.slice(i + 1), c);
      if (h) return h;
      continue;
    }
    const b = binaryToken(tok, c);
    if (b && b.lang) return mkHit(b.lang, b.rel, { any: [{ argv0: b.argv0, needle: null }], child: null, tree: true }, tok, 'file');
  }
  return null;
}

// `cc x.c -o x && ./x`, `cargo build && ./target/debug/app`, `make && ./app`:
// the binary in a LATER segment is the work — the card is titled by it and
// the pin follows the compiler into it (findRespawn under the same shell)
function chainTail(hit, segs, si, c) {
  for (let k = si + 1; k < segs.length; k++) {
    const toks = segs[k].trim().replace(/&\s*$/, '').split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ''));
    if (toks[0] === 'cd') continue;
    for (const t of toks) {
      if (!t || isRedirect(t)) continue;
      if (t.split('/').pop().toLowerCase() in LAUNCHERS) break; // a second build step, not the program
      const b = binaryToken(t, c, true);
      if (!b) continue;
      const any = hit.pin ? [...hit.pin.any] : [{ argv0: INTERP_ARGV0_OF(hit.lang), needle: String(hit.file).split('/').pop() }];
      any.push({ argv0: b.argv0, needle: null });
      return { ...hit, file: b.rel, titleKind: 'file', pin: { ...(hit.pin || { child: null, tree: true, tok: t }), any, compile: false } };
    }
  }
  return hit;
}
const INTERP_ARGV0_OF = (lang) => (RUNTIMES[lang] && RUNTIMES[lang].argv0) || /$^/;

// an ext-row hit whose launcher needs more than interpreter+basename:
// `go run main.go` (go-build exe child), `npx tsx x.ts` / `npm run x -- y.js`
// (node under sh -c), and compile-then-run chains
function decorateHit(hit, launcherTok, segs, si, c) {
  const base = launcherTok.split('/').pop().toLowerCase();
  const needle = String(hit.file).split('/').pop();
  if (hit.lang === 'go') {
    return { ...hit, pin: { any: [{ argv0: /(^|\/)go$/, needle }], child: GO_CHILD_RE, tree: true, tok: launcherTok } };
  }
  if (['npm', 'npx', 'pnpm', 'yarn'].includes(base)) {
    return { ...hit, pin: { any: [{ argv0: NODEISH_RE, needle }], child: NODE_CHILD_RE, tree: true, tok: launcherTok } };
  }
  if (['cc', 'gcc', 'clang', 'c++', 'g++', 'clang++', 'rustc'].includes(base)) return chainTail(hit, segs, si, c);
  return hit;
}

/**
 * Detect a script run inside a (possibly compound) shell command.
 * Token-based: per segment (split on && || ; |), find an interpreter token,
 * then the first later NON-FLAG token with the matching extension (so
 * `--output=out.ipynb` never wins over the actual input notebook). Returns
 * { lang, file, detached, inline } or null.
 *   detached — scripts/bg, nohup, setsid, or a trailing `&`: the card
 *     outlives the tool call (and, for truly detached processes, the turn).
 *   inline — `-e`/`-c`/heredoc evals with NO script file (file:null): a
 *     multi-minute GE solve is often a `julia -e` program, not a .jl file.
 *     A file match anywhere in the command beats an inline match.
 *   pin — only on hits the interpreter+basename rule can't pin (see the
 *     launcher table above): `cargo run`, `go test ./...`, `npm test`,
 *     `make`, `cmake --build`, `./target/debug/app`, `cc x.c -o x && ./x`.
 *     `file` is then the crate/module/package name plus the launcher, or
 *     the binary's path. `root` (the project root) seeds the marker walk;
 *     `cd` segments move it.
 */
export function detectScriptRun(command, { root = null } = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  const top = root ? String(root).replace(/\/+$/, '') : null;
  let cwd = top;
  // Quote-severed compounds — `nohup bash -c 'until Rscript x.R; do …; done' &`
  // (a crash-resuming supervisor loop): the split below doesn't understand
  // quotes, so the `;` INSIDE the quoted program lands x.R in a segment that
  // carries neither the nohup nor the trailing `&`, and the per-segment flag
  // misses. The physical LINE still holds all three — a detach-marked line
  // containing the matched token makes the hit detached. (The [^&] guard keeps
  // a line-continuation `&&` from reading as a trailing `&`.)
  const detachedLine = (tok) => tok != null && cmd.split('\n').some((l) => l.includes(tok)
    && (/(^|\s)(nohup|setsid)\s/.test(l) || /(^|[\s/])scripts\/bg(\s|$)/.test(l)
      || /(^|[^&])&\s*$/.test(l)));
  let inlineHit = null;
  let launcher = null;
  const segs = cmd.split(/&&|\|\||;|\|/);
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    let detached = /&\s*$/.test(seg);
    const tokens = seg.trim().replace(/&\s*$/, '').split(/\s+/)
      .map((t) => t.replace(/^['"]+|['"]+$/g, ''));
    if (tokens[0] === 'cd') { cwd = chdir(cwd, tokens[1], top); continue; }
    const ctx = { cwd, root: top };
    let spec = null;
    let interpTok = null;
    let inline = false;
    let noInline = false; // module/subcommand runs: `python -m pip install -e .`
    let skipNext = false; // value-consuming flags: `--output out.ipynb`
    let fileHit = null;
    for (const tok of tokens) {
      if (!spec) {
        const base = tok.split('/').pop().toLowerCase();
        if (base === 'nohup' || base === 'setsid' || /(^|\/)scripts\/bg$/.test(tok)) {
          detached = true;
          continue;
        }
        spec = INTERPRETER_ROWS.find((i) => i.names.includes(base))
          || (/^python[\d.]*$/.test(base) ? INTERPRETERS.python : null);
        if (spec) interpTok = tok;
        // `uv`'s own -e belongs to pip, never an eval
        if (spec && base === 'uv') noInline = true;
        continue;
      }
      if (skipNext) { skipNext = false; continue; }
      if (tok === '-m') noInline = true; // module run, not an inline program
      if (tok === '--output' || tok === '-o') { skipNext = true; continue; }
      if (INLINE_FLAGS.has(tok) || tok.startsWith('<<')) inline = true;
      if (tok.startsWith('-')) continue; // flags (incl. --output=x.ipynb)
      if (spec.ext.test(tok)) {
        fileHit = { lang: spec.lang, file: tok, detached: detached || detachedLine(tok), inline: false };
        break;
      }
    }
    if (fileHit) return decorateHit(fileHit, interpTok, segs, si, ctx);
    // no script file in this segment: a fileless launcher or a bare binary
    // (`cargo test`, `npm run build`, `make -j8`, `./target/debug/app`). A
    // script file in a LATER segment still wins (`cargo build && julia x.jl`
    // is the julia card, as before); the first launcher otherwise.
    if (!launcher) {
      const lh = launcherHit(tokens, ctx);
      if (lh) {
        const tailed = lh.pin.compile ? chainTail(lh, segs, si, ctx) : lh;
        tailed.detached = detached || detachedLine(lh.pin.tok);
        launcher = tailed;
      }
    }
    if (spec && inline && !noInline && !inlineHit) {
      inlineHit = { lang: spec.lang, file: null, detached: detached || detachedLine(interpTok), inline: true };
    }
  }
  return launcher || inlineHit;
}

// display path: project-relative when the file sits under the project root
function displayFile(project, file) {
  try {
    const root = PROJECTS[project] && PROJECTS[project].root;
    if (root && file.startsWith(root.replace(/\/+$/, '') + '/')) {
      return file.slice(root.replace(/\/+$/, '').length + 1);
    }
  } catch { /* display only */ }
  return file;
}

// ---------------------------------------------------------------------------
// Progress parsing (runner jobs — the sources whose output we can see)
// ---------------------------------------------------------------------------

const ITER_RE = /(?:^|[^\w])(?:iter(?:ations?)?|steps?|epochs?|gen(?:erations?)?|draws?|samples?|reps?|sims?|folds?|rounds?|trials?|batch(?:es)?|it)\.?\s*[:#=]?\s*(\d+)\s*(?:\/|of\b|out of\b)\s*(\d+)/i;
const BRACKET_RE = /[[(](\d+)\s*\/\s*(\d+)[\])]/;
const PCT_RE = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%/;
const BARISH_RE = /[|┤┫]?[=＝#█▓▒░>▏▎▍▌▋▊▉·.]{4,}|Progress|progress|complete|finished/;
// ProgressMeter.jl / tqdm style reported ETA: "ETA: 0:03:12" (h:mm:ss) or "ETA: 2 days, 1:02:03"
const ETA_RE = /\bETA:?\s+(?:(\d+)\s*days?,?\s*)?(\d+):(\d{2})(?::(\d{2}))?/i;

/** Parse one output line → {iter, total, frac, etaS} (any subset) or null. */
export function parseProgressLine(line) {
  const s = String(line);
  if (!s || s.length > 2000) return null;
  const out = {};
  const eta = s.match(ETA_RE);
  if (eta) {
    const days = Number(eta[1] || 0);
    const a = Number(eta[2]); const b = Number(eta[3]); const c = eta[4] == null ? null : Number(eta[4]);
    // h:mm:ss when three parts, m:ss when two
    out.etaS = days * 86400 + (c == null ? a * 60 + b : a * 3600 + b * 60 + c);
  }
  let m = s.match(ITER_RE) || s.match(BRACKET_RE);
  if (m) {
    const iter = Number(m[1]); const total = Number(m[2]);
    if (total > 1 && total < 1e9 && iter >= 0 && iter <= total) {
      out.iter = iter; out.total = total; out.frac = iter / total;
    }
  }
  if (out.frac == null && BARISH_RE.test(s)) {
    m = s.match(PCT_RE);
    if (m) {
      const pct = Number(m[1]);
      if (pct >= 0 && pct <= 100) out.frac = pct / 100;
    }
  }
  return Object.keys(out).length ? out : null;
}

// feed a chunk of output into a job: quiet clock + line-wise progress, plus
// (▶ runs) the stream accounting behind `output`: \n-terminated line count,
// lines/s over the last 10 s, and the last non-empty line (ANSI stripped, a
// \r-redrawn bar collapsed to its final frame, ≤ 160 chars)
function feedOutput(job, chunk) {
  const now = nowFn();
  job.lastOutputAt = now;
  const text = String(chunk);
  let start = 0;
  const delimiters = /[\r\n]/g;
  let match;
  while ((match = delimiters.exec(text))) {
    appendOutputFragment(job, text, start, match.index);
    if (match[0] === '\n') noteLine(job, now);
    flushOutputLine(job, now);
    start = match.index + 1;
  }
  appendOutputFragment(job, text, start, text.length);
}

// Bound only unfinished lines, never discard a burst's complete diagnostics.
function appendOutputFragment(job, text, start, end) {
  const current = job._lineBuf || '';
  const room = 16384 - current.length;
  if (end - start > room) job._lineOverflow = true;
  job._lineBuf = current + text.slice(start, start + Math.min(room, end - start));
}

function flushOutputLine(job, now) {
  const line = job._lineBuf || '';
  const clean = stripAnsi(line).trim();
  if (clean) job._lastLine = clean.length > LAST_LINE_MAX ? clean.slice(0, LAST_LINE_MAX - 1) + '…' : clean;
  // An overlong truncated line is display-only, never a synthetic diagnostic.
  if (!job._lineOverflow) feedLine(job, line, now);
  job._lineBuf = '';
  job._lineOverflow = false;
}

// one output line (either fd) → per-runtime parser first, generic fallback
// for `progress` when the parser produced none. Session jobs never see their
// lines today (the SDK owns that stream) — sessionJobOutput() is the hook.
function feedLine(job, rawLine, now) {
  const line = stripAnsi(rawLine);
  let r = null;
  if (job._parser) r = job._parser.feed(line);
  if (r) {
    if (r.phase) job.phase = r.phase;
    if (r.counters) job.counters = { ...(job.counters || {}), ...r.counters };
    if (r.progress) noteProgress(job, r.progress, now);
  }
  if (!r || !r.progress) {
    const p = parseProgressLine(line);
    if (p) noteProgress(job, p, now);
  }
}

// \n-terminated line accounting: cumulative count + per-second buckets for the rate
function noteLine(job, now) {
  job._lines = (job._lines || 0) + 1;
  const sec = Math.floor(now / 1000);
  const b = job._lineBuckets || (job._lineBuckets = []);
  const last = b[b.length - 1];
  if (last && last.sec === sec) last.n += 1;
  else {
    b.push({ sec, n: 1 });
    if (b.length > OUTPUT_RATE_WINDOW_S + 1) b.splice(0, b.length - (OUTPUT_RATE_WINDOW_S + 1));
  }
}

function outputRate(job, now) {
  const b = job._lineBuckets;
  if (!b || !b.length) return 0;
  const from = Math.floor(now / 1000) - OUTPUT_RATE_WINDOW_S;
  let n = 0;
  for (const x of b) if (x.sec > from) n += x.n;
  return Math.round((n / OUTPUT_RATE_WINDOW_S) * 10) / 10;
}

function noteProgress(job, p, now) {
  const prog = job.progress || (job.progress = {});
  if (p.iter != null) { prog.iter = p.iter; prog.total = p.total; }
  if (p.frac != null) {
    // a lower frac by a wide margin = a new phase/loop — restart the history
    if (prog.frac != null && p.frac < prog.frac - 0.15) {
      job._hist = [];
      job._etaEma = null;
      delete prog.etaS;
    }
    prog.frac = p.frac;
    (job._hist = job._hist || []).push({ t: now, frac: p.frac });
    if (job._hist.length > 50) job._hist.shift();
  }
  if (p.etaS != null) {
    prog.etaS = p.etaS; // the script's own ETA beats our estimate
    job._etaReportedAt = now;
  } else if (prog.frac != null && (!job._etaReportedAt || now - job._etaReportedAt > 30000)) {
    const est = estimateEta(job, now);
    if (est != null) prog.etaS = est;
  }
}

function estimateEta(job, now) {
  const h = job._hist || [];
  if (h.length < 2) return null;
  const first = h[0]; const last = h[h.length - 1];
  const dt = (last.t - first.t) / 1000;
  const df = last.frac - first.frac;
  if (dt < 5 || df < 0.005) return null;
  const raw = (1 - last.frac) * (dt / df);
  if (!Number.isFinite(raw) || raw < 0 || raw > 48 * 3600) return null;
  // EMA so the display doesn't jitter with every line
  job._etaEma = job._etaEma == null ? raw : job._etaEma * 0.7 + raw * 0.3;
  return Math.round(job._etaEma);
}

// ---------------------------------------------------------------------------
// Registry + lifecycle
// ---------------------------------------------------------------------------

// stale = the numbers are older than two polls, or the last sweep did not
// contain the root pid (never freeze silently — the UI greys on this flag)
function isStale(j, now) {
  if (j.state !== 'running') return false;
  if (j._sampledAt == null) return false; // 'starting' — nothing to be stale yet
  return !!j._rootGone || now - j._sampledAt > 2 * POLL_MS;
}

function publicJob(j) {
  const now = nowFn();
  const running = j.state === 'running';
  const quietMs = j.source === 'run' && running && j.lastOutputAt ? now - j.lastOutputAt : null;
  return {
    key: j.key,
    jobRunId: j.jobRunId || null,
    appTurnId: j.appTurnId || null,
    taskCreated: j.taskCreated || null,
    createdAt: j.createdAt || null,
    source: j.source,
    project: j.project,
    taskId: j.taskId || null,
    file: j.file,
    displayTitle: j.displayTitle || null,
    titleKind: j.titleKind || null,
    lang: j.lang,
    command: j.command || null,
    state: j.state,
    bg: !!j.bg,
    detached: !!j.detached,
    inline: !!j.inline,
    stopping: !!j._stopReq,
    startedAt: new Date(j.t0).toISOString(),
    endedAt: j.endedAt != null ? new Date(j.endedAt).toISOString() : null,
    elapsedMs: running ? now - j.t0 : (j.ms != null ? j.ms : now - j.t0),
    pid: j.pid || null,
    // legacy (one release): raw Σ pcpu and Σ rss over the tree
    cpu: j.cpu != null ? j.cpu : null,
    mem: j.mem != null ? j.mem : null,
    progress: j.progress && j.progress.frac != null
      ? {
        frac: Math.min(1, Math.max(0, j.progress.frac)),
        iter: j.progress.iter ?? null,
        total: j.progress.total ?? null,
        etaS: j.progress.etaS ?? null,
      }
      : null,
    quietMs,
    exitCode: j.exitCode ?? null,
    ms: j.ms ?? null,
    // v3 telemetry
    sampledAt: j._sampledAt != null ? new Date(j._sampledAt).toISOString() : null,
    pollMs: POLL_MS,
    stale: isStale(j, now),
    cores: j.cores ?? null,
    coresBasis: j.cores != null ? (j.coresBasis || null) : null,
    hostCores: HOST_CORES,
    cpuTimeMs: j.cpuTimeMs ?? null,
    memBytes: j.memBytes ?? null,
    memKind: j.memBytes != null ? (j.memKind || 'rss') : null,
    memPeakBytes: j.memPeakBytes ?? null,
    procs: j.procs ?? null,
    threads: j.threads ?? null,
    health: running ? (j._health ? { state: j._health.state, sinceMs: Math.max(0, now - j._health.since) } : { state: 'starting', sinceMs: now - j.t0 }) : null,
    output: j.source === 'run'
      ? {
        lines: j._lines || 0,
        rate: outputRate(j, now),
        last: j._lastLine || null,
        owned: true,
        buffered: !!j._buffered,
      }
      : { owned: false },
    history: j._history || null,
    exit: running ? null : {
      code: j.exit?.code ?? j.exitCode ?? null,
      signal: j.exit?.signal ?? null,
      byUser: !!(j.exit?.byUser ?? j._stopReq),
    },
    phase: j.phase ? { name: j.phase.name, n: j.phase.n ?? null, m: j.phase.m ?? null, mSoft: !!j.phase.mSoft } : null,
    counters: j.counters ? { ...j.counters } : {},
  };
}

function emitJob(j) {
  if (!j.visible) return;
  try { broadcast('job:status', { project: j.project, job: publicJob(j) }); } catch (err) {
    logErr('broadcast failed:', err.message);
  }
}

function finish(j, state, extra = {}) {
  if (!j || j.state !== 'running') return;
  if (j._lineBuf) flushOutputLine(j, nowFn()); // EOF is not an extra newline
  j.state = state;
  j.ms = nowFn() - j.t0;
  j.endedAt = nowFn();
  Object.assign(j, extra);
  // exit: the runner passes {code, signal, byUser}; session jobs have no
  // code to report (the tool_result's text is not parsed — never invented)
  if (!j.exit) j.exit = { code: j.exitCode ?? null, signal: null, byUser: !!j._stopReq };
  else if (j.exit.byUser == null) j.exit.byUser = !!j._stopReq;
  if (j.exit.code != null && j.exitCode == null) j.exitCode = j.exit.code;
  if (j.progress && state === 'done') j.progress.frac = 1;
  if (j.visible) {
    emitJob(j);
    recordHistory(j); // the sidebar's activity feed remembers finished runs
  } else {
    jobs.delete(j.key); // never shown — nothing to clean up on screen
  }
  log(`${j.key} ${state} after ${(j.ms / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Run history — finished (visible) jobs, for the sidebar activity feed.
// Persisted so a server restart doesn't blank the feed's ▶ rows.
// ---------------------------------------------------------------------------

const HIST_CAP = 50;
const HIST_FILE = path.join(ROOT, 'jobhist.json');
let history = null; // {project: [record, ...]} oldest → newest

function loadHistory() {
  if (history) return history;
  history = {};
  try {
    if (fs.existsSync(HIST_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') history = parsed;
    }
  } catch (err) {
    logErr('job history unreadable — starting fresh:', err.message);
  }
  return history;
}

function recordHistory(j) {
  try {
    const h = loadHistory();
    const arr = h[j.project] || (h[j.project] = []);
    arr.push({
      ...publicJob(j), // retain immutable ownership + terminal summary on reload
      ts: new Date(j.endedAt).toISOString(),
      file: j.file,
      lang: j.lang,
      source: j.source,
      state: j.state,
      ms: j.ms,
      taskId: j.taskId || null,
      bg: !!j.bg,
      detached: !!j.detached,
      ...(j.inline ? { inline: true } : {}),
      // v3: end-summary inputs (peak of the sampled tree footprint/rss, Σ cputime)
      peakMem: j.memPeakBytes ?? null,
      cpuTimeMs: j.cpuTimeMs ?? null,
    });
    if (arr.length > HIST_CAP) arr.splice(0, arr.length - HIST_CAP);
    writeFileAtomic(HIST_FILE, JSON.stringify(h));
  } catch (err) {
    logErr('job history record failed:', err.message);
  }
}

/** Finished runs for a project, oldest → newest (activity-feed source). */
export function getJobHistory(project) {
  const arr = loadHistory()[project];
  return Array.isArray(arr) ? arr.map((r) => ({ ...r })) : [];
}

// "usually ~2m10s (n=7)": median duration of DONE runs of the same file in
// this project. null for inline evals (no stable key) and when nothing ran.
function historyFor(project, file, inline) {
  try {
    if (inline || !file) return null;
    const ms = getJobHistory(project)
      .filter((r) => (r.file || r.displayTitle) === file && r.state === 'done' && Number(r.ms) > 0)
      .map((r) => Number(r.ms))
      .sort((a, b) => a - b);
    if (!ms.length) return null;
    const mid = ms.length >> 1;
    const typicalMs = ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
    return { typicalMs, n: ms.length };
  } catch {
    return null;
  }
}

let pollingParked = false; // test seam — see _test.setPolling

function ensurePolling() {
  if (pollTimer || pollingParked) return;
  pollTimer = setInterval(() => tick(), POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

// ---------------------------------------------------------------------------
// Process-table sweep
// ---------------------------------------------------------------------------

// etime is [[dd-]hh:]mm:ss → ms of process age (start-time guard for detached
// pid discovery — never adopt an unrelated pre-existing run of the same script)
function etimeMs(s) {
  const m = String(s || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

// cputime is [[dd-]hh:]mm:ss[.cc] (macOS prints centiseconds; procps whole
// seconds; minutes may exceed 59 without an hours field: "91:21.30")
function cputimeMs(s) {
  const m = String(s || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const secs = ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
  const frac = m[5] ? Number(`0.${m[5]}`) : 0;
  return Math.round((secs + frac) * 1000);
}

// one `ps -A` table → {procs, kids, at}; exported to tests as _test.parsePs
function parsePs(stdout, now = nowFn()) {
  const procs = new Map(); // pid → {ppid, pcpu, rss, startMs, cpuMs, state, tty, args}
  const kids = new Map();  // ppid → [pid]
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:-]+)\s+([\d:.-]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    const age = etimeMs(m[5]);
    procs.set(pid, {
      ppid, pcpu: Number(m[3]), rss: Number(m[4]),
      startMs: age == null ? null : now - age,
      cpuMs: cputimeMs(m[6]),
      state: m[7].charAt(0), // R running · S/I sleeping · U/D uninterruptible · T stopped · Z zombie
      tty: m[8],
      args: m[9],
    });
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { procs, kids, at: now };
}

function psSnapshot() {
  return new Promise((resolve) => {
    // -A, not -ax: POSIX `-a` drops processes with no controlling terminal,
    // so detached runs and supervisor loops vanish from the table on Linux.
    // -A selects every process on both BSD/macOS and procps, and produces
    // byte-identical output to -ax here on macOS.
    execFile('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,etime=,cputime=,state=,tty=,args='],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(parsePs(stdout, nowFn())); } catch { resolve(null); }
      });
  });
}

function descendantsOf(snap, rootPid, includeRoot = false) {
  const out = includeRoot ? [rootPid] : [];
  const queue = [(rootPid)];
  const seen = new Set([rootPid]);
  while (queue.length) {
    for (const c of snap.kids.get(queue.shift()) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

const INTERP_ARGV0 = {
  julia: /(^|\/)julia(-[\w.]+)?$/i,
  r: /(^|\/)(Rscript|R)$/,
  python: /(^|\/)(python[\d.]*|uv)$/i,
  // nbconvert/papermill run under python; quarto is its own binary
  notebook: /(^|\/)(python[\d.]*|jupyter(-[\w.]+)?|papermill|quarto)$/i,
  sql: /(^|\/)(duckdb|psql|sqlite3|mysql)$/i,
  shell: /(^|\/)(bash|sh|zsh)$/,
  // rust / go / node / c / cpp — from the registry's `argv0`
  ...sessionArgv0Rows(),
};

// ▶ runs with `pin:'child'` (go run, npm scripts, pty-wrapped binaries): the
// spawned pid is a launcher; pin the DEEPEST fresh descendant of it whose
// argv0 matches. Scoped to the launcher's own subtree — never the whole
// table — so two concurrent runs can't adopt each other's children.
// `mode` 'shallowest' (session launchers: npm's node, go run's exe) picks
// the nearest match instead — never a worker in the program's own pool.
function findChildPid(snap, rootPid, re, claimed, mode = 'deepest') {
  if (!snap || !rootPid || !re) return null;
  let best = null;
  let bestDepth = -1;
  const better = (depth) => (best === null || (mode === 'shallowest' ? depth < bestDepth : depth > bestDepth));
  const walk = (pid, depth) => {
    for (const c of snap.kids.get(pid) || []) {
      const p = snap.procs.get(c);
      if (p && !claimed.has(c) && c !== process.pid) {
        const argv0 = p.args.split(/\s+/)[0] || '';
        if (re.test(argv0) && better(depth)) { best = c; bestDepth = depth; }
      }
      if (depth < 8) walk(c, depth + 1);
    }
  };
  walk(rootPid, 0);
  return best;
}

// what a session job's process must look like: the launcher's own matchers
// (`hit.pin.any`) when it has them, else interpreter argv0 + script basename
function pinMatchers(job) {
  if (job._pin && job._pin.any) return job._pin.any;
  const re = INTERP_ARGV0[job.lang];
  const base = job.inline ? null : String(job.file || '').split('/').pop();
  if ((!base && !job.inline) || !re) return null;
  return [{ argv0: re, needle: base }];
}
function matchProc(p, matchers) {
  const argv0 = p.args.split(/\s+/)[0] || '';
  return matchers.some((m) => m.argv0.test(argv0)
    && (m.needle == null || (m.needle instanceof RegExp ? m.needle.test(p.args) : p.args.includes(m.needle))));
}

// find the process for a session job: argv0 looks like the interpreter AND —
// when the job runs a script FILE — the args mention its basename. INLINE
// evals (`julia -e '…'`) have no filename to anchor on and match on the
// interpreter alone. Foreground/background tool runs search OUR descendants;
// detached launches (nohup/&/scripts/bg re-parent to launchd) search the
// whole table but must be TERMINAL-LESS — the user's own interactive REPL
// always has a tty and must never be adopted (Stop would kill it). EVERY
// job requires freshness: its process starts at (or after, behind an
// approval gate) its own tool call, so anything meaningfully older belongs
// to someone else — another task running the same script name, or the
// kaimon warm-REPL daemon (also excluded by name). Among candidates the one
// whose start time is closest to the job's own start wins, then a deeper
// descendant of the winner is preferred (juliaup's shim keeps the real
// binary as its child, started the same instant).
function findSessionPid(snap, job, claimed) {
  const matchers = pinMatchers(job);
  if (!matchers) return null;
  const pool = job.detached ? [...snap.procs.keys()] : descendantsOf(snap, process.pid);
  const candidates = [];
  for (const pid of pool) {
    if (claimed.has(pid) || pid === process.pid) continue;
    const p = snap.procs.get(pid);
    if (!p) continue;
    if (/kaimon/i.test(p.args)) continue; // never the warm REPL's tree
    if (!matchProc(p, matchers)) continue;
    if (p.startMs != null && p.startMs < job.t0 - 30000) continue;
    if (job.detached && p.tty && p.tty !== '??' && p.tty !== '?' && p.tty !== '-') continue;
    candidates.push(pid);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const d = (pid) => {
      const s = snap.procs.get(pid).startMs;
      return s == null ? Infinity : Math.abs(s - job.t0);
    };
    return d(a) - d(b);
  });
  let best = candidates[0];
  // a launcher that IS the tree root (cargo, make, cargo watch, nodemon) is
  // pinned as such: its compilers and restarts live under it
  if (job._pin && job._pin.tree) return best;
  for (const c of candidates) {
    if (c !== best && descendantsOf(snap, best).includes(c)) best = c;
  }
  return best;
}

// the pinned pid's private ancestor chain, recorded at pin time — stops
// before launchd/init AND before our own process (whose descendants span
// every task's shells, so they'd defeat the containment guarantee below)
function ancestryOf(snap, pid) {
  const chain = [];
  let cur = snap.procs.get(pid);
  while (cur && cur.ppid > 1 && cur.ppid !== process.pid && chain.length < 6) {
    chain.push(cur.ppid);
    cur = snap.procs.get(cur.ppid);
  }
  return chain;
}

// A supervisor loop (`nohup bash -c 'until Rscript x.R; do …; done' &`)
// respawns its interpreter after every crash. The vanished pid's immediate
// parent usually died with it (a caffeinate/sh wrapper waiting on the child),
// so re-pin by searching the nearest STILL-ALIVE recorded ancestor's
// descendants for the same interpreter + script. Tree containment replaces
// the freshness guard here: the chain never includes launchd or this server,
// so the search can't wander into another task's processes.
// Launcher jobs (`_pin`) follow the same rule with their own matchers — the
// compile-then-run chain's binary under the same shell, the next `cargo run`
// under `cargo watch`, a relaunched npm — plus the child argv0 (the node
// under a respawned npm). descendantsOf is breadth-first, so the first match
// is the shallowest: a relaunched launcher is re-pinned before its child,
// and the tick re-arms the one-shot child pin for it.
function findRespawn(snap, job, claimed) {
  const matchers = pinMatchers(job);
  if (!matchers) return null;
  const child = job._pin && job._pin.child ? [{ argv0: job._pin.child, needle: null }] : [];
  const root = (job._ancestry || []).find((pid) => snap.procs.has(pid));
  if (!root) return null;
  for (const pid of descendantsOf(snap, root)) {
    if (claimed.has(pid) || pid === process.pid) continue;
    const p = snap.procs.get(pid);
    if (!p) continue;
    if (/kaimon/i.test(p.args)) continue;
    if (!matchProc(p, matchers) && !(child.length && matchProc(p, child))) continue;
    return pid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-job telemetry from one sweep (+ the optional footprint probe)
// ---------------------------------------------------------------------------

// The tree's live pids (root first), zombies excluded from the count
function treeOf(snap, rootPid) {
  return descendantsOf(snap, rootPid, true).filter((pid) => snap.procs.has(pid));
}

function sameProbeProcess(before, current) {
  return !!before && !!current && before.args === current.args
    // ps etime has one-second resolution; tolerate rounding, not PID reuse.
    && (before.startMs == null || current.startMs == null || Math.abs(before.startMs - current.startMs) <= 1500);
}

// cores = Σ Δcputime / Δwall over pids present in BOTH consecutive sweeps
// (a new child contributes from its second sweep), EMA α = 1/3, clamped ≥ 0.
// First sweep (or no overlap after a respawn): Σ pcpu / 100, basis 'pcpu'.
function sampleTree(j, snap, now, probeMap) {
  const pids = treeOf(snap, j.pid);
  let pcpu = 0; let rss = 0; let cpuMs = 0; let procs = 0; let anyCpu = false;
  const cur = new Map();
  for (const pid of pids) {
    const p = snap.procs.get(pid);
    pcpu += p.pcpu; rss += p.rss;
    if (p.state !== 'Z') procs += 1;
    if (p.cpuMs != null) { cpuMs += p.cpuMs; cur.set(pid, p.cpuMs); anyCpu = true; }
  }
  j.cpu = Math.round(pcpu);   // legacy
  j.mem = rss * 1024;          // legacy: ps rss is KB
  j.procs = procs;
  j.cpuTimeMs = anyCpu ? cpuMs : null;
  const prev = j._prevCpu;
  const dWall = prev ? snap.at - j._prevAt : 0;
  let overlap = 0; let dCpu = 0;
  if (prev && dWall > 0) {
    for (const [pid, ms] of cur) {
      if (prev.has(pid)) { overlap += 1; dCpu += Math.max(0, ms - prev.get(pid)); }
    }
  }
  if (overlap > 0) {
    const raw = Math.max(0, dCpu / dWall);
    j.cores = j._coresEma == null ? raw : j._coresEma + (raw - j._coresEma) * CORES_EMA_ALPHA;
    j._coresEma = j.cores;
    j.cores = Math.round(j.cores * 100) / 100;
    j.coresBasis = 'cputime';
  } else {
    j.cores = Math.round((pcpu / 100) * 100) / 100;
    j.coresBasis = 'pcpu';
    j._coresEma = null;
  }
  j._prevCpu = cur;
  j._prevAt = snap.at;
  j._rootState = snap.procs.get(j.pid)?.state || null;
  j._sampledAt = snap.at;
  j._rootGone = false;

  // A missing probe row is not evidence of exit: workers can be new, hidden,
  // or beyond the probe's PID cap. Totals require the entire current tree.
  let sample = null;
  if (probeMap) {
    const at = probeMap._sampledAt ?? now;
    const fresh = now >= at && now - at <= PROBE_FRESH_MS;
    let sum = 0; let ok = fresh && pids.length > 0;
    let th = 0; let allThreads = ok;
    for (const pid of pids) {
      const r = probeMap.get(pid);
      const matched = !probeMap._identities || sameProbeProcess(probeMap._identities.get(pid), snap.procs.get(pid));
      if (!matched || !r || !Number.isFinite(r.footprint) || r.footprint < 0) ok = false;
      else sum += r.footprint;
      if (!matched || !r || !Number.isInteger(r.threads) || r.threads < 0) allThreads = false;
      else th += r.threads;
    }
    sample = { at, members: new Map(pids.map(pid => [pid, snap.procs.get(pid)])),
      footprint: ok ? sum : null, threads: allThreads ? th : null };
    j._probeSample = sample;
  } else if (j._probeSample) {
    const previous = j._probeSample;
    if (now >= previous.at && now - previous.at <= PROBE_FRESH_MS
        && previous.members.size === pids.length
        && pids.every(pid => sameProbeProcess(previous.members.get(pid), snap.procs.get(pid)))) sample = previous;
  }
  if (sample?.footprint != null) { j.memBytes = sample.footprint; j.memKind = 'footprint'; }
  else { j.memBytes = j.mem; j.memKind = 'rss'; }
  j.threads = sample?.threads ?? null;
  if (j._peakKind !== j.memKind) { j._peakKind = j.memKind; j.memPeakBytes = null; }
  if (j.memBytes != null && (j.memPeakBytes == null || j.memBytes > j.memPeakBytes)) j.memPeakBytes = j.memBytes;

  updateHealth(j, now);
}

// health — computing: cores ≥ 0.05 · io: root in uninterruptible wait ·
// stalled: < 0.05 cores for ≥ 20 s AND (no owned output OR quiet ≥ 20 s) ·
// idle: low but not yet 20 s. sinceMs counts from the state's first sweep —
// except stalled, which counts the whole silence (the 20 s detection window
// included), so the band reads "STALLED 21s" the moment it is declared.
function updateHealth(j, now) {
  const c = j.cores ?? 0;
  const s = j._rootState;
  const q = j.source === 'run' && j.lastOutputAt ? now - j.lastOutputAt : null;
  let state;
  if (c >= LOW_CORES) { state = 'computing'; j._lowSince = null; }
  else {
    if (j._lowSince == null) j._lowSince = now;
    if (s === 'U' || s === 'D') state = 'io';
    else if (now - j._lowSince >= STALL_MS && (q == null || q >= STALL_MS)) state = 'stalled';
    else state = 'idle';
  }
  if (!j._health || j._health.state !== state) {
    const quietSince = state === 'stalled'
      ? Math.max(j._lowSince, j.source === 'run' && j.lastOutputAt ? j.lastOutputAt : 0)
      : now;
    j._health = { state, since: quietSince };
  }
}

// probe cadence: launched every other tick (never while one is in flight),
// only while a visible job is live, and NEVER awaited by the sweep — top
// takes ~300 ms even with -pid, which would push every sample past the
// staleness budget. The result is applied by the ticks that follow while it
// is younger than two probe periods.
let tickNo = 0;
let probeState = { map: null, at: 0, pending: false };
const PROBE_FRESH_MS = 2 * PROBE_EVERY * POLL_MS;

function scheduleProbe(pids, snap) {
  if (probeState.pending) return;
  probeState.pending = true;
  probeProcs(pids, { timeoutMs: PROBE_TIMEOUT_MS })
    .then((map) => {
      if (map) {
        map._sampledAt = snap.at;
        map._identities = new Map(pids.map(pid => [pid, snap.procs.get(pid)]));
      }
      probeState = { map, at: snap.at, pending: false };
    })
    .catch(() => { probeState.pending = false; });
}

// tick(opts) — opts are the test seam: {snap, now, probe} inject a synthetic
// ps table, a clock, and a probe result (probe: null = no probe this tick).
async function tick(opts = null) {
  if (polling) {
    if (!opts) return;
    // an injected sweep must not be dropped behind an in-flight timer tick
    while (polling) await new Promise((r) => setTimeout(r, 10));
  }
  polling = true;
  try {
    const now = opts && opts.now != null ? opts.now : nowFn();
    tickNo += 1;
    // GC ended jobs past their linger
    for (const j of [...jobs.values()]) {
      if (j.state !== 'running' && j.endedAt && now - j.endedAt > LINGER_MS) jobs.delete(j.key);
    }
    if (!jobs.size) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const running = [...jobs.values()].filter((j) => j.state === 'running');
    if (!running.length) return;

    const snap = opts && 'snap' in opts ? opts.snap : await psSnapshot();
    if (!snap) {
      // a failed sweep never freezes the numbers: sampledAt stays, so the
      // card goes stale after two polls (isStale) while the values remain
      for (const j of running) if (j.pid && j._sampledAt != null) j._rootGone = true;
    }
    let probeMap = null;
    if (snap) {
      if (opts && 'probe' in opts) probeMap = opts.probe;
      else {
        if (tickNo % PROBE_EVERY === 0) {
          const pids = [];
          for (const j of running) if (j.visible && j.pid && snap.procs.has(j.pid)) pids.push(...treeOf(snap, j.pid));
          if (pids.length) scheduleProbe(pids, snap);
        }
        if (probeState.map && now - probeState.at <= PROBE_FRESH_MS) probeMap = probeState.map;
      }
    }
    if (snap) {
      const claimed = new Set(running.map((j) => j.pid).filter(Boolean));
      for (const j of running) {
        // discover the pid of a session job (runner jobs are born with one)
        if (!j.pid && j.source === 'session') {
          const pid = findSessionPid(snap, j, claimed);
          if (pid) {
            j.pid = pid;
            j._ancestry = ancestryOf(snap, pid);
            claimed.add(pid);
            // npm → sh -c → node, go run → go-build exe: one-shot re-pin
            // to the launcher's shallowest matching child (below)
            if (j._pin && j._pin.child) j._pinChild = { root: pid, re: j._pin.child, mode: 'shallowest' };
            // late first sighting (approval gate, slow start): the clock
            // starts when the process actually appears, not at the tool call
            if (now - j.t0 > 5000) j.t0 = now;
            log(`${j.key} → pid ${pid}`);
          } else if ((j.bg || j.detached) && now - j.t0 > PID_FIND_TIMEOUT_MS) {
            // bg/detached jobs have no tool_result to end them — a process
            // that never appeared (crashed on launch, mis-detected command)
            // must not keep an invisible zombie job polling ps forever
            finish(j, 'done');
          }
        }
        // ▶ run with pin:'child': follow the launcher down to its real child
        // once it appears (go run's exe, npm's node, script(1)'s program)
        if (j.pid && j._pinChild && snap.procs.has(j._pinChild.root)) {
          const c = findChildPid(snap, j._pinChild.root, j._pinChild.re, claimed, j._pinChild.mode);
          if (c && c !== j.pid) {
            j.pid = c;
            claimed.add(c);
            j._prevCpu = null;
            j._pinChild = null; // pinned — the sweep needn't search again
            if (j.source === 'session') j._ancestry = ancestryOf(snap, c); // respawns search from here
            log(`${j.key} → child pid ${c}`);
          }
        }
        if (j.pid) {
          if (snap.procs.has(j.pid)) {
            j._pidGoneAt = null;
            sampleTree(j, snap, now, probeMap);
            // a stop was requested but the tree ignores SIGTERM → escalate
            if (j._stopReq && now - j._stopReq > KILL_ESCALATE_MS && !j._killed) {
              j._killed = true;
              for (const pid of descendantsOf(snap, j.pid, true)) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* raced exit */ }
              }
            }
          } else {
            // root not in this sweep: numbers stay, the card reads stale
            j._rootGone = true;
          }
          if (!snap.procs.has(j.pid) && j.source === 'session') {
            // process gone but no tool_result yet — the shell may be running a
            // later command in a && chain; give the result a grace window
            if (j._stopReq) finish(j, 'stopped');
            else {
              const heir = findRespawn(snap, j, claimed);
              if (heir) {
                // a supervisor loop respawned the interpreter — follow it
                j.pid = heir;
                j._ancestry = ancestryOf(snap, heir);
                claimed.add(heir);
                j._pidGoneAt = null;
                j._prevCpu = null; // a new tree — cores restart from a pcpu sweep
                // a relaunched LAUNCHER (npm again, not yet its node): re-arm
                // the one-shot child pin; a relaunched program needs none
                j._pinChild = j._pin && j._pin.child && matchProc(snap.procs.get(heir), j._pin.any)
                  ? { root: heir, re: j._pin.child, mode: 'shallowest' } : null;
                log(`${j.key} → respawned pid ${heir}`);
              } else if ((j.detached && (j._ancestry || []).some((p) => snap.procs.has(p)))
                || (j._pin && (j._ancestry || []).length && snap.procs.has(j._ancestry[0]))) {
                // between crash and respawn (the loop's sleep): the launch
                // tree is still alive, so hold the card — either a respawn
                // appears (re-pinned above) or the supervisor itself exits
                // (then the grace below ends the job). Launcher jobs hold
                // only on their immediate parent: the chain's shell between
                // `cc` and `./x`, npm between `tsc` and `vite build`, the
                // watcher between restarts — never the task's own CLI.
                j._pidGoneAt = null;
              } else if (!j._pidGoneAt) j._pidGoneAt = now;
              else if (now - j._pidGoneAt > PID_GONE_GRACE_MS) finish(j, 'done');
            }
          }
        }
      }
    }
    // visibility + steady broadcast (elapsed/cpu/quiet tick for every client)
    for (const j of running) {
      if (j.state !== 'running') continue; // finished during this sweep
      if (!j.visible && now - j.t0 >= MIN_AGE_MS && (j.source === 'run' || j.pid)) {
        j.visible = true;
        log(`${j.key} visible (${j.lang} ${j.file})`);
      }
      emitJob(j);
    }
  } catch (err) {
    logErr('tick failed:', err.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Session-source hooks (lib/sessions.js)
// ---------------------------------------------------------------------------

/** A Bash tool_use streamed. Registers a watch when the command runs a script
    OR an inline eval; harmless no-op otherwise. `bg` = the tool's
    run_in_background flag — the process runs on after its tool_result, so
    only the process table (or the turn ending) finishes the card. `label` =
    the tool call's own description — the card's title for inline evals,
    which have no filename to show. */
export function sessionJobStart(project, taskId, toolUseId, command, { bg = false, label = '', appTurnId = null, taskCreated = null } = {}) {
  try {
    if (!toolUseId || !PROJECTS[project]) return null;
    const hit = detectScriptRun(command, { root: PROJECTS[project].root });
    if (!hit) return null;
    // Same provider tool IDs can recur in another turn/thread or after task
    // ID reuse. Ownership is captured once, never inferred from current UI.
    const ownerSuffix = appTurnId || taskCreated ? `/${encodeURIComponent(taskCreated || 'unknown')}/${encodeURIComponent(appTurnId || 'unowned')}` : '';
    const key = `sess:${project}/${taskId}/${toolUseId}${ownerSuffix}`;
    if (jobs.has(key)) return jobs.get(key);
    // A replayed tool-start must not resurrect a settled invocation merely
    // because its live-registry linger elapsed. Legacy unowned IDs are not
    // sufficient evidence to make this judgment.
    if (appTurnId && getJobHistory(project).some(row => row.key === key && row.appTurnId === appTurnId
      && (row.taskCreated ?? null) === taskCreated)) return null;
    const squeezed = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const job = {
      key,
      jobRunId: randomUUID(),
      appTurnId,
      taskCreated,
      createdAt: new Date(nowFn()).toISOString(),
      source: 'session',
      project,
      taskId,
      toolUseId,
      file: hit.inline || hit.titleKind === 'label' ? null : displayFile(project, hit.file),
      displayTitle: hit.inline ? squeezed || `inline ${RUNTIMES[hit.lang]?.label || hit.lang}`
        : hit.titleKind === 'label' ? hit.file : displayFile(project, hit.file),
      titleKind: hit.inline ? squeezed ? 'label' : 'inline' : hit.titleKind || 'file',
      lang: hit.lang,
      command: String(command).slice(0, 300),
      state: 'running',
      t0: nowFn(),
      visible: false,
      pid: null,
      bg: !!bg,
      detached: !!hit.detached,
      inline: !!hit.inline,
    };
    job._pin = hit.pin || null; // launcher matchers + child rule (see detectScriptRun)
    job._history = historyFor(project, job.file || job.displayTitle, job.inline);
    job._parser = createJobParser(job.lang, command);
    jobs.set(key, job);
    ensurePolling();
    return job;
  } catch (err) {
    logErr('sessionJobStart failed:', err.message);
    return null;
  }
}

function matchesSessionOwner(job, owner) {
  return ['project', 'taskId', 'appTurnId', 'taskCreated'].every(field =>
    !Object.hasOwn(owner, field) || (job[field] ?? null) === (owner[field] ?? null));
}

// Legacy unscoped callers remain usable only when the tool ID is unambiguous.
// Never let a delayed result for another task/turn end the first matching job.
function findSessionJob(toolUseId, owner = {}) {
  const matches = [...jobs.values()].filter(job => job.source === 'session'
    && job.toolUseId === toolUseId && matchesSessionOwner(job, owner));
  return matches.length === 1 ? matches[0] : null;
}

/** HOOK — a session job's output line(s), should the dashboard ever see them
    (today the SDK owns that stream and nothing calls this). Feeds the
    per-runtime parser (phase/counters/progress) only; `output.owned` stays
    false because the dashboard does not own the stream. */
export function sessionJobOutput(toolUseId, chunk, owner = {}) {
  try {
    if (!toolUseId) return;
    const j = findSessionJob(toolUseId, owner);
    if (j?.state === 'running') {
      const now = nowFn();
      for (const line of String(chunk).split(/[\r\n]/)) if (line) feedLine(j, line, now);
      return;
    }
  } catch { /* display only */ }
}

/** tool_progress heartbeat — elapsed_time_seconds is authoritative for how
    long the tool has actually been executing. */
export function sessionJobProgress(toolUseId, elapsedSeconds, owner = {}) {
  try {
    if (!toolUseId || !Number.isFinite(elapsedSeconds)) return;
    const j = findSessionJob(toolUseId, owner);
    if (j?.state === 'running') {
      const t0 = nowFn() - elapsedSeconds * 1000;
      if (Math.abs(t0 - j.t0) > 3000) j.t0 = t0;
      return;
    }
  } catch { /* display only */ }
}

/** The Bash tool_result landed. For a foreground run that IS the end; for a
    backgrounded/detached launch it's just the launch ack — the process runs
    on, and the card ends when the process does (an error ack means it never
    started). */
export function sessionJobEnd(toolUseId, { error = false, ...owner } = {}) {
  try {
    if (!toolUseId) return;
    const j = findSessionJob(toolUseId, owner);
    if (j) {
      if ((j.bg || j.detached) && !error && !j._stopReq) return;
      finish(j, j._stopReq ? 'stopped' : error ? 'error' : 'done');
      return;
    }
  } catch { /* display only */ }
}

/** Turn over (completed, errored, or interrupted) — background shells die
    with the turn, so their cards end here too. Truly DETACHED jobs survive
    the turn by design: their card stays live until the process exits. */
export function endSessionJobsFor(project, taskId, state = 'stopped', owner = {}) {
  try {
    for (const j of jobs.values()) {
      if (j.source === 'session' && j.project === project && j.taskId === taskId && j.state === 'running'
        && matchesSessionOwner(j, owner)) {
        if (j.detached) continue;
        finish(j, j._stopReq ? 'stopped' : state);
      }
    }
  } catch { /* display only */ }
}

// ---------------------------------------------------------------------------
// Runner-source hooks (lib/runner.js)
// ---------------------------------------------------------------------------

// ext → runtime id, from the registry (tex is excluded there: it keeps its
// own build card). Same rows as before for .jl/.r/.py/.sh/.sql.
const RUN_LANGS = runLangs();

// the per-step parser: the registry's `parser` key names a jobParsers
// HANDLERS entry (createJobParser maps cargo/rust/go/node/build through
// LANG_DEFAULT; the step's COMMAND still refines it — `python -m pytest`).
// An explicit `parser: null` (a compiled binary step) means NO handler: the
// program's own output must not be read as compiler diagnostics — only the
// generic parseProgressLine fallback applies. `undefined` = the job's lang.
function stepParser(job, { command, parser }) {
  job._parser = createJobParser(parser === null ? null : (parser || job.lang), command);
  job._lineBuf = '';
  job._lineOverflow = false;
}

/** A ▶ run started. tex compiles keep their own build card — not a job.
    `buffered` = the runtime is known to block-buffer stdout when piped
    (python without PYTHONUNBUFFERED) — the card's rate is then a fiction.
    `lang` (the resolved runtime id) beats the extension lookup; `phase` seeds
    the card's phase chip for multi-step runs; `pin:'child'` + `argv0` make
    the sweep re-pin to the launcher's real child (see findChildPid). */
export function runJobStart(project, rel, pid, command, { buffered = false, lang: langOpt = null, phase = null, parser = undefined, pin = 'self', argv0 = null } = {}) {
  try {
    if (!PROJECTS[project] || !pid) return null;
    const ext = ('.' + String(rel).split('.').pop()).toLowerCase();
    const lang = langOpt || RUN_LANGS[ext];
    if (!lang) return null;
    const key = `run:${project}`;
    const job = {
      key,
      jobRunId: randomUUID(),
      createdAt: new Date(nowFn()).toISOString(),
      source: 'run',
      project,
      file: rel,
      displayTitle: rel,
      titleKind: 'file',
      lang,
      command: String(command || '').slice(0, 300),
      state: 'running',
      t0: nowFn(),
      visible: false,
      pid,
      lastOutputAt: nowFn(),
      _buffered: !!buffered,
    };
    if (phase) job.phase = { name: String(phase), n: null, m: null, mSoft: false };
    if (pin === 'child' && argv0) job._pinChild = { root: pid, re: argv0 };
    job._history = historyFor(project, rel, false);
    stepParser(job, { command, parser });
    jobs.set(key, job); // one run per project — a new run replaces the old card
    ensurePolling();
    return job;
  } catch (err) {
    logErr('runJobStart failed:', err.message);
    return null;
  }
}

/** A multi-step ▶ run moved to its next step: a NEW child pid, the step's own
    command/phase/parser. Telemetry restarts from a pcpu sweep (new tree);
    the job, its clock and its history row carry on. */
export function runJobStep(project, { pid, command, phase = null, parser = undefined, buffered = false, pin = 'self', argv0 = null } = {}) {
  try {
    const j = jobs.get(`run:${project}`);
    if (!j || j.state !== 'running') return null;
    if (pid) j.pid = pid;
    j.command = String(command || '').slice(0, 300);
    j.phase = phase ? { name: String(phase), n: null, m: null, mSoft: false } : null;
    j.counters = {};
    j.progress = null;
    j._hist = [];
    j._etaEma = null;
    j._buffered = !!buffered;
    j._prevCpu = null;
    j._pinChild = pin === 'child' && argv0 && pid ? { root: pid, re: argv0 } : null;
    stepParser(j, { command, parser });
    emitJob(j);
    return j;
  } catch (err) {
    logErr('runJobStep failed:', err.message);
    return null;
  }
}

export function runJobOutput(project, chunk) {
  try {
    const j = jobs.get(`run:${project}`);
    if (j && j.state === 'running') feedOutput(j, chunk);
  } catch { /* display only */ }
}

/** The ▶ child exited. `exit` carries Node's (code, signal) pair — one of the
    two is null — and byUser when stopRun (or shutdown) sent the signal. */
export function runJobEnd(project, { state = 'done', exitCode = null, ms = null, exit = null } = {}) {
  try {
    const j = jobs.get(`run:${project}`);
    if (!j) return;
    const ex = {
      code: exit && exit.code != null ? exit.code : exitCode,
      signal: exit && exit.signal ? String(exit.signal) : null,
      byUser: !!(exit && exit.byUser),
    };
    // the runner's own duration is authoritative — it must land BEFORE
    // finish() broadcasts the terminal state and records the history row
    finish(j, state === 'running' ? 'done' : state,
      { exitCode: ex.code, exit: ex, ...(ms != null ? { ms } : {}) });
  } catch { /* display only */ }
}

// ---------------------------------------------------------------------------
// Stop + snapshot
// ---------------------------------------------------------------------------

/** Stop a SESSION job: SIGTERM the process and its descendants (individually —
    never the group, which the SDK subprocess may share). Runner jobs stop via
    runner.stopRun (server dispatches by key prefix). The job stays 'running'
    with stopping:true until the process actually dies — honest state. */
export function stopSessionJob(project, key) {
  const j = jobs.get(String(key));
  if (!j || j.source !== 'session' || j.project !== project) {
    const err = new Error(`no such job: ${key}`);
    err.status = 404;
    throw err;
  }
  if (j.state !== 'running') return { ok: true };
  if (!j.pid) {
    const err = new Error('job process not identified yet — try again in a moment');
    err.status = 409;
    throw err;
  }
  j._stopReq = nowFn();
  psSnapshot().then((snap) => {
    const pids = snap ? descendantsOf(snap, j.pid, true) : [j.pid];
    pids.reverse(); // children first
    // a supervisor loop would respawn the interpreter the moment it dies —
    // kill the loop FIRST. Only recorded ancestors that have re-parented to
    // launchd qualify: while the turn is live the chain can still contain
    // the SDK's own shell, which must survive its tool call.
    if (snap) {
      const sups = (j._ancestry || []).filter((a) => snap.procs.get(a)?.ppid === 1);
      pids.unshift(...sups);
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }).catch(() => { try { process.kill(j.pid, 'SIGTERM'); } catch { /* gone */ } });
  emitJob(j); // stopping:true reaches the card immediately
  return { ok: true };
}

/** Visible jobs for the /api/state snapshot (reload mid-run re-seeds cards). */
export function getJobs() {
  return [...jobs.values()].filter((j) => j.visible).map(publicJob);
}

// test seam: reach the internals without exporting them for production use.
//   tick({snap, now, probe}) drives one sweep from a synthetic ps table;
//   parsePs(text, now) builds such a table from `ps -Ao …` text;
//   setClock(fn|null) injects the clock; setPolling(false) parks the timer so
//   an injected sweep is the ONLY sweep (setPolling(true) restores it).
export const _test = {
  jobs, tick, findSessionPid, findChildPid, findRespawn, descendantsOf, psSnapshot, feedOutput, parsePs, publicJob, sampleTree,
  nearestMarker, INTERPRETERS, INTERP_ARGV0, RUN_LANGS,
  setClock(fn) { nowFn = typeof fn === 'function' ? fn : Date.now; },
  setPolling(on) {
    pollingParked = !on;
    if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; } else if (on && jobs.size) ensurePolling();
  },
};
