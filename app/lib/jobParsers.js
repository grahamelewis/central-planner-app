// lib/jobParsers.js — per-runtime output parsers behind a job card's phase
// and counters. Fed one line at a time (the caller has already split on \n
// and \r, so a progress-bar redraw arrives as its own line); every regex is
// anchored to real output captured for docs/jobcard-mockups/metrics.html.
// Nothing here spawns or bills: pure text → {phase?, counters?, progress?}.
//
//   createJobParser(lang, command) → { runtime, feed(line) }
//     feed returns only what CHANGED on that line (or null):
//       phase    {name, n?, m?, mSoft?}   the runtime chip's word (+ n/m when the
//                                        tool states one; mSoft = m is a guess)
//       counters {key: absoluteValue}    only keys this line moved
//       progress {frac?, iter?, total?, etaS?}  a parsed fraction — beats the
//                                        generic parseProgressLine fallback
//   detectRuntime(command) → 'julia' | 'python' | 'pytest' | 'cargo' | 'rust' |
//     'go' | 'node' | 'tsc' | 'vite' | 'latex' | 'r' | 'curl' | 'wget' | 'rsync' |
//     'make' | 'cmake' | 'ninja' | 'ctest' | 'cc' | 'stata' | 'papermill' |
//     'nbconvert' | 'sql' | 'shell' | null
//
//   Phase words: fetching · compiling n/m · linking · built · running · tests n/m ·
//     report (plus configuring/generating/generated/building for cmake/make).
//   Counter keys: errors warnings notes · passed failed skipped todo · ok (go
//     packages) · suites suitesFailed · crate · coverage · modules · timeS ·
//     exitStatus · lastError {file,line,col,msg} (most recent error diagnostic).
//
// Honesty rules baked in: cargo has no n/m unless the runner set
// CARGO_TERM_PROGRESS_WHEN=always (the Building bar); openrsync (macOS) spells
// `to-check=` and `xfer#` where rsync 3 prints `to-chk=`/`xfr#`; Stata batch
// writes nothing to stdout, so its parser is deliberately empty; latexmk's
// pass total is a soft ≤ max(N, 3).

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

const num = (s) => Number(String(s).replace(/,/g, ''));
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// "0:01:36" | "1:05" | "2 days, 1:02:03" | "36s" | "1m20s" | "2h3m" → seconds
function clockS(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === '?' || /^-+:/.test(t)) return null;
  let m = t.match(/^(?:(\d+)\s*days?,?\s*)?(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = Number(m[1] || 0); const a = Number(m[2]); const b = Number(m[3]);
    const c = m[4] == null ? null : Number(m[4]);
    return d * 86400 + (c == null ? a * 60 + b : a * 3600 + b * 60 + c);
  }
  m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return null;
}

// "3906k" (curl, 1024) · "12.34MB/s" (rsync, 1000) · "2.35M" (wget, 1024)
function bytesOf(s, base = 1024) {
  const m = String(s || '').replace(/,/g, '').match(/^([\d.]+)\s*([kKMGT]?)(?:i?B)?(?:\/s)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const p = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[m[2]];
  return Number.isFinite(n) && p != null ? Math.round(n * base ** p) : null;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

// wrappers and the shell keywords a `;`-split leaves at a segment's head
// (`until cargo build; do …` inside a quoted supervisor loop)
const PREFIX_SKIP = new Set(['time', 'nohup', 'setsid', 'nice', 'env', 'sudo', 'caffeinate', 'exec', 'command', 'stdbuf', 'unbuffer',
  'until', 'while', 'do', 'if', 'then', 'else', 'elif', '!']);

function tokensOf(seg) {
  return seg.trim().replace(/&\s*$/, '').split(/\s+/)
    .map((t) => t.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

function runtimeOfTokens(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const base = t.split('/').pop();
    if (/^[A-Za-z_][\w]*=/.test(t) || t === 'cd' && i === 0) { i += t === 'cd' ? 2 : 1; continue; }
    if (PREFIX_SKIP.has(base) || (base === 'uv' && tokens[i + 1] === 'run') || base === 'npx' || base === 'pnpx') {
      if (base === 'uv') i += 2; else i += 1;
      // options of the prefix tool (`caffeinate -i`, `nice -n 5`, `env -u X`)
      while (i < tokens.length && /^-/.test(tokens[i]) && !/^-[ceE]$/.test(tokens[i])) i += (tokens[i] === '-n' || tokens[i] === '-u') ? 2 : 1;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return null;
  const argv0 = tokens[i].split('/').pop();
  const rest = tokens.slice(i + 1);
  const has = (re) => rest.some((x) => re.test(x));
  if (/^julia(-[\w.]+)?$/i.test(argv0)) return 'julia';
  if (/^python[\d.]*$/i.test(argv0) || /^pypy[\d.]*$/i.test(argv0)) {
    const mi = rest.indexOf('-m');
    const mod = mi !== -1 ? rest[mi + 1] : null;
    if (mod === 'pytest' || mod === 'py.test') return 'pytest';
    if (mod === 'papermill') return 'papermill';
    if (mod === 'jupyter' || mod === 'nbconvert') return 'nbconvert';
    if (/(^|\/)(duckdb|sqlite)\b/.test(rest.join(' ')) && has(/\.sql$/i)) return 'sql';
    return 'python';
  }
  if (/^(pytest|py\.test)$/.test(argv0)) return 'pytest';
  if (/^(Rscript|R)$/.test(argv0)) return 'r';
  if (argv0 === 'cargo') return 'cargo';
  if (argv0 === 'rustc') return 'rust';
  if (argv0 === 'go') return 'go';
  if (argv0 === 'tsc') return 'tsc';
  if (argv0 === 'vite') return 'vite';
  if (/^(node|nodejs|deno|bun|bunx|tsx|ts-node|vitest|jest|mocha|eslint|next|npm|pnpm|yarn)$/.test(argv0)) {
    if (has(/^tsc$/)) return 'tsc';
    if (has(/^vite$/)) return 'vite';
    return 'node';
  }
  if (/^(latexmk|pdflatex|xelatex|lualatex|latex|pdftex|tectonic|bibtex|biber)$/.test(argv0)) return 'latex';
  if (argv0 === 'perl' && has(/(^|\/)latexmk$/)) return 'latex';
  if (argv0 === 'curl') return 'curl';
  if (argv0 === 'wget') return 'wget';
  if (/^(rsync|openrsync)$/.test(argv0)) return 'rsync';
  if (/^g?make$/.test(argv0)) return 'make';
  if (argv0 === 'cmake') return 'cmake';
  if (argv0 === 'ninja') return 'ninja';
  if (argv0 === 'ctest') return 'ctest';
  if (/^(cc|gcc|clang|c\+\+|g\+\+|clang\+\+)(-\d+)?$/.test(argv0)) return 'cc';
  if (/^(stata(-mp|-se|-ic)?|StataMP|StataSE|StataIC|xstata(-mp|-se)?)$/.test(argv0)) return 'stata';
  if (argv0 === 'papermill') return 'papermill';
  if (/^(jupyter(-nbconvert|-execute|-run)?|nbconvert|quarto)$/.test(argv0)) return 'nbconvert';
  if (/^(duckdb|psql|sqlite3|mysql)$/.test(argv0)) return 'sql';
  if (/^(bash|sh|zsh|fish|dash)$/.test(argv0)) {
    const ci = rest.indexOf('-c');
    if (ci !== -1 && rest[ci + 1]) {
      const inner = detectRuntime(rest.slice(ci + 1).join(' '));
      if (inner && inner !== 'shell') return inner;
    }
    return 'shell';
  }
  return null;
}

/** Name the runtime a command line will run (first recognizable segment). */
export function detectRuntime(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  let shell = null;
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const toks = tokensOf(seg);
    if (!toks.length) continue;
    const r = runtimeOfTokens(toks);
    if (r && r !== 'shell') return r;
    if (r === 'shell') shell = shell || r;
  }
  return shell;
}

// ---------------------------------------------------------------------------
// Per-runtime handlers — each is (line, st) → void, using st.setPhase /
// st.inc / st.set / st.progress. `st` persists for the job's lifetime.
// ---------------------------------------------------------------------------

function julia(line, st) {
  let m;
  if (/^Precompiling (?:packages|project|[A-Z]\w+)\.{3}/.test(line) || /^\[ Info: Precompiling/.test(line)) {
    st.pre = { n: 0, m: null };
    if ((m = line.match(/\((\d+)\/(\d+)\)/))) { st.pre.n = Number(m[1]); st.pre.m = Number(m[2]); }
    st.setPhase('precompiling', st.pre.n, st.pre.m);
    return;
  }
  if ((m = line.match(/^\s*(\d+) dependenc(?:y|ies) successfully precompiled/))) {
    st.pre = null;
    st.setPhase('running');
    return;
  }
  if (st.pre) {
    if (/^\s+[\d.]+ ms\s+[✓✗]\s+\S+/.test(line) || /^\s+[✓✗]\s+\S+/.test(line)) {
      st.pre.n += 1;
      st.setPhase('precompiling', st.pre.n, st.pre.m);
      return;
    }
    if ((m = line.match(/(\d+)\/(\d+)/)) && /Progress|Precompiling/.test(line)) {
      st.pre.n = Number(m[1]); st.pre.m = Number(m[2]);
      st.setPhase('precompiling', st.pre.n, st.pre.m);
      return;
    }
    if (!/^\s/.test(line) && !/^(ERROR|Stacktrace)/.test(line) && !/^[┌│└\[]/.test(line)) {
      st.pre = null;
      st.setPhase('running');
      // fall through — this line may carry a bar or a counter
    }
  }
  // ProgressMeter.jl: "desc 53%|████   |  ETA: 0:09:02 (12.34  s/it)" · "Time: 0:00:05" when finished
  if ((m = line.match(/^(.*?)\s*(\d{1,3})%[|\[][^|\]]*[|\]]\s*(?:ETA: ([\d:]+(?:\s*days?,?\s*[\d:]+)?|\d+ days?, [\d:]+)|Time: ([\d:]+))/))) {
    const p = { frac: clamp01(Number(m[2]) / 100) };
    const eta = clockS(m[3]);
    if (eta != null) p.etaS = eta;
    if (m[4]) p.frac = 1;
    st.progress(p);
    if (!st.phase) st.setPhase('running');
    return;
  }
  if (/^ERROR: /.test(line)) { st.inc('errors'); return; }
  if ((m = line.match(/^[┌\[] (Warning|Error|Info): /))) {
    if (m[1] === 'Warning') st.inc('warnings');
    else if (m[1] === 'Error') st.inc('errors');
    return;
  }
  if (!st.phase && !/^\s/.test(line)) st.setPhase('running');
}

// tqdm: "train:  60%|███   | 18/30 [00:00<00:00, 176.32it/s]" (also papermill, HF, pip)
const TQDM_RE = /^\s*(?:(.+?):\s+)?(\d{1,3})%\|[^|]*\|\s*([\d.]+[kMGT]?)\/([\d.]+[kMGT]?)\s+\[(\d+:\d{2}(?::\d{2})?)<([\d:]+|\?)(?:,\s*([\d.]+|\?)\s*([\w/]+?)\/s)?/;

function tqdm(line, st) {
  const m = line.match(TQDM_RE);
  if (!m) return false;
  const p = { frac: clamp01(Number(m[2]) / 100) };
  if (/^\d+$/.test(m[3]) && /^\d+$/.test(m[4])) { p.iter = Number(m[3]); p.total = Number(m[4]); }
  const eta = clockS(m[6]);
  if (eta != null) p.etaS = eta;
  st.progress(p);
  if (m[1]) st.setPhase(m[1].trim().toLowerCase().slice(0, 24), p.iter ?? null, p.total ?? null);
  return true;
}

function python(line, st) {
  if (tqdm(line, st)) return;
  let m;
  if (/^Traceback \(most recent call last\):$/.test(line)) { st.inc('errors'); return; }
  if ((m = line.match(/^(.+?):(\d+): (\w+Warning): /))) { st.inc('warnings'); return; }
  if ((m = line.match(/^(WARNING|ERROR|CRITICAL):[\w.]*:/))) {
    st.inc(m[1] === 'WARNING' ? 'warnings' : 'errors');
  }
}

const PYTEST_SUMMARY_RE = /^(?:=+ )?((?:\d+ (?:passed|failed|skipped|xfailed|xpassed|errors?|deselected|warnings?|rerun)(?:, )?)+) in ([\d.]+)s?(?: \([^)]*\))?(?: =+)?$/;

function pytest(line, st) {
  let m;
  if (/^=+ test session starts =+$/.test(line)) { st.setPhase('collecting'); return; }
  if ((m = line.match(/^collected (\d+) items?/))) {
    let total = Number(m[1]);
    const des = line.match(/\/ (\d+) deselected/);
    if (des) total -= Number(des[1]);
    st.py = { n: 0, m: total };
    st.setPhase('tests', 0, total);
    return;
  }
  if ((m = line.match(/^(\S+\.py) ([.FsxXE]+)\s+\[\s*(\d{1,3})%\]$/))) {
    const glyphs = m[2];
    let dn = 0;
    for (const g of glyphs) {
      dn += 1;
      if (g === '.') st.inc('passed');
      else if (g === 'F') st.inc('failed');
      else if (g === 's') st.inc('skipped');
      else if (g === 'E') st.inc('errors');
    }
    st.py = st.py || { n: 0, m: null };
    st.py.n += dn;
    st.setPhase('tests', st.py.n, st.py.m);
    st.progress({ frac: clamp01(Number(m[3]) / 100), iter: st.py.n, total: st.py.m });
    return;
  }
  if ((m = line.match(/^(\S+::\S+) (PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)\b.*\[\s*(\d{1,3})%\]$/))) {
    st.py = st.py || { n: 0, m: null };
    st.py.n += 1;
    if (m[2] === 'PASSED') st.inc('passed');
    else if (m[2] === 'FAILED') st.inc('failed');
    else if (m[2] === 'SKIPPED') st.inc('skipped');
    else if (m[2] === 'ERROR') st.inc('errors');
    st.setPhase('tests', st.py.n, st.py.m);
    st.progress({ frac: clamp01(Number(m[3]) / 100), iter: st.py.n, total: st.py.m });
    return;
  }
  if ((m = line.match(PYTEST_SUMMARY_RE))) {
    const abs = { passed: 0, failed: 0, skipped: 0, errors: 0, warnings: 0 };
    for (const tok of m[1].split(', ')) {
      const t = tok.match(/^(\d+) (\w+)$/);
      if (!t) continue;
      const n = Number(t[1]); const k = t[2];
      if (k === 'passed') abs.passed += n;
      else if (k === 'failed') abs.failed += n;
      else if (k === 'skipped') abs.skipped += n;
      else if (k === 'error' || k === 'errors') abs.errors += n;
      else if (k === 'warning' || k === 'warnings') abs.warnings += n;
    }
    for (const [k, v] of Object.entries(abs)) if (v || st.counters[k] != null) st.set(k, v);
    st.setPhase('report');
    return;
  }
  if (/^!+ Interrupted: /.test(line)) { st.setPhase('interrupted'); return; }
  if (/^Traceback \(most recent call last\):$/.test(line)) st.inc('errors');
}

// --- compiled-language diagnostics -----------------------------------------
// lastError = {file, line, col, msg} — the most recent error-class diagnostic
// with a location, so a card can show "src/main.rs:12:5 mismatched types".
// Warnings never touch it. `pending` lets a two-line form (rustc's message
// then ` --> file:line:col`; a panic's location then its message on the next
// line) fill in the missing half.
// A field left undefined keeps the current value (a follow-up line refining
// one half); an explicit null clears it (a fresh diagnostic without one).
function setLastError(st, { file, line, col, msg }) {
  const cur = st.counters.lastError || {};
  const pick = (v, old, num) => (v === undefined ? (old ?? null) : v == null ? null : num ? Number(v) : v);
  st.set('lastError', {
    file: pick(file, cur.file, false),
    line: pick(line, cur.line, true),
    col: pick(col, cur.col, true),
    msg: msg === undefined ? (cur.msg ?? null) : msg == null ? null : String(msg).slice(0, 200),
  });
}

// rustc / cargo diagnostics (also the libtest harness, which cargo test and a
// `rustc --test` binary both print). Cargo's own progress lines only ever
// appear under cargo; a bare rustc run just never matches them.
function cargo(line, st) {
  let m;
  st.cg = st.cg || { crates: 0, bar: false, res: null, tests: null, pend: null };
  // second half of a two-line diagnostic: " --> src/main.rs:1:26"
  if ((m = line.match(/^\s*--> (.+?):(\d+):(\d+)$/))) {
    if (st.cg.pend && st.cg.pend.kind === 'error') setLastError(st, { file: m[1], line: m[2], col: m[3], msg: st.cg.pend.msg });
    st.cg.pend = null;
    return;
  }
  // the panic message follows its location line
  if (st.cg.pend && st.cg.pend.kind === 'panic') {
    if (line.trim()) { setLastError(st, { msg: line.trim() }); st.cg.pend = null; }
    return;
  }
  if (/^\s+(Updating|Downloading|Downloaded|Blocking|Locking|Adding|Removing) /.test(line)) { st.setPhase('fetching'); return; }
  if ((m = line.match(/^\s+(Compiling|Checking|Documenting) (\S+) v(\S+)/))) {
    st.cg.crates += 1;
    st.set('crate', m[2]);
    if (!st.cg.bar) st.setPhase('compiling', st.cg.crates, null);
    else st.setPhase('compiling', st.phase?.n ?? null, st.phase?.m ?? null);
    return;
  }
  // "    Building [======>   ] 12/40: syn, serde" — only with CARGO_TERM_PROGRESS_WHEN=always
  if ((m = line.match(/^\s*Building \[[=> ]*\]\s*(\d+)\/(\d+)(?::\s*(.*))?$/))) {
    st.cg.bar = true;
    const n = Number(m[1]); const t = Number(m[2]);
    st.setPhase('compiling', n, t);
    if (t > 0) st.progress({ frac: clamp01(n / t), iter: n, total: t });
    return;
  }
  // "warning: unused variable: `x`" — not the per-crate / rustc totals
  if ((m = line.match(/^warning: (?!`\S+` \(.+?\) generated \d+ warnings?|\d+ warnings? emitted|unused manifest key)(.*)$/))) {
    st.inc('warnings');
    st.cg.pend = { kind: 'warning', msg: m[1] };
    return;
  }
  // "error[E0308]: mismatched types" — not cargo's / rustc's wrap-up lines
  if ((m = line.match(/^error(?:\[E\d{4}\])?: (?!could not compile|aborting due to|test failed|process didn't exit successfully|build failed|failed to run|\d+ previous errors?|doctest failed)(.*)$/))) {
    st.inc('errors');
    st.cg.pend = { kind: 'error', msg: m[1] };
    setLastError(st, { file: null, line: null, col: null, msg: m[1] });
    return;
  }
  if (/^\s+Running (unittests |tests )?\S+ \(/.test(line) || /^\s+Doc-tests \S+/.test(line)) { st.setPhase('tests'); return; }
  if (/^\s+Running `/.test(line)) { st.setPhase('running'); return; }
  if (/^\s+Finished `?[\w-]+`?(?: profile)? \[/.test(line)) { st.setPhase('built'); return; }
  if ((m = line.match(/^running (\d+) tests?$/))) { st.cg.tests = { n: 0, m: Number(m[1]) }; st.setPhase('tests', 0, Number(m[1])); return; }
  // "test tests::fails ... FAILED" · "test src/lib.rs - add (line 3) ... ok" (doctest, spaces in the name)
  if ((m = line.match(/^test (.+?) (?:- should panic )?\.\.\. (ok|FAILED|ignored)\b/))) {
    st.inc(m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped');
    if (st.cg.tests) {
      st.cg.tests.n += 1;
      st.setPhase('tests', st.cg.tests.n, st.cg.tests.m);
      if (st.cg.tests.m) st.progress({ frac: clamp01(st.cg.tests.n / st.cg.tests.m), iter: st.cg.tests.n, total: st.cg.tests.m });
    }
    return;
  }
  // one per harness (unit, integration, doc) — totals add up across them
  if ((m = line.match(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/))) {
    st.cg.res = st.cg.res || { passed: 0, failed: 0, skipped: 0 };
    st.cg.res.passed += Number(m[2]); st.cg.res.failed += Number(m[3]); st.cg.res.skipped += Number(m[4]);
    st.set('passed', st.cg.res.passed); st.set('failed', st.cg.res.failed); st.set('skipped', st.cg.res.skipped);
    st.setPhase('report');
    return;
  }
  // "thread 'tests::fails' (6937328) panicked at src/lib.rs:6:26:" — message on the next line
  if ((m = line.match(/^thread '.+' (?:\(\d+\) )?panicked at (.+?):(\d+):(\d+):?$/))) {
    st.inc('errors');
    setLastError(st, { file: m[1], line: m[2], col: m[3], msg: 'panicked' });
    st.cg.pend = { kind: 'panic' };
    return;
  }
  if ((m = line.match(/^thread '.+' (?:\(\d+\) )?panicked at (.*)$/))) { st.inc('errors'); setLastError(st, { msg: m[1] }); }
}

function go(line, st) {
  let m;
  st.go = st.go || { testFails: 0, n: 0, pend: null, log: null };
  // a panic's first "\t/path/main.go:8 +0x1d" frame carries the location
  if (st.go.pend === 'panic' && (m = line.match(/^\s+(\S+\.go):(\d+)/))) { setLastError(st, { file: m[1], line: m[2] }); st.go.pend = null; return; }
  if (/^go: (downloading|finding module for package|extracting|added|upgraded) /.test(line)) { st.setPhase('fetching'); return; }
  if (/^=== RUN\s+/.test(line)) { st.setPhase('tests', st.go.n, null); return; }
  if ((m = line.match(/^--- (PASS|FAIL|SKIP): (\S+)/))) { // top-level only; subtests are indented
    st.go.n += 1;
    if (m[1] === 'FAIL') { st.go.testFails += 1; st.inc('failed'); setLastError(st, st.go.log || { file: null, line: null, col: null, msg: m[2] }); }
    else st.inc(m[1] === 'PASS' ? 'passed' : 'skipped');
    st.go.log = null;
    st.setPhase('tests', st.go.n, null);
    return;
  }
  if (/^\s+--- (PASS|FAIL|SKIP): /.test(line)) return;
  // "    x_test.go:12: expected 3, got 4" — the failing test's own log line
  if ((m = line.match(/^\s+(\S+_test\.go):(\d+): (.*)$/))) { st.go.log = { file: m[1], line: m[2], col: null, msg: m[3] }; return; }
  if ((m = line.match(/^ok\s+\S+/))) {
    st.inc('ok'); st.go.testFails = 0;
    if ((m = line.match(/coverage: ([\d.]+)% of statements/))) st.set('coverage', Number(m[1]));
    st.setPhase('report');
    return;
  }
  if ((m = line.match(/^coverage: ([\d.]+)% of statements/))) { st.set('coverage', Number(m[1])); return; }
  if (/^FAIL\s+\S+/.test(line)) {
    if (!st.go.testFails) st.inc('failed'); // build failure or a package with no per-test lines
    st.go.testFails = 0;
    st.setPhase('report');
    return;
  }
  if (/^\?\s+\S+\s+\[no test files\]$/.test(line)) { st.setPhase('report'); return; }
  if (/^# \S+( \[\S+\])?$/.test(line)) { st.setPhase('compiling'); return; }
  // "./x.go:12:3: undefined: foo" (col optional for vet-style output)
  if ((m = line.match(/^(\S+\.go):(\d+)(?::(\d+))?: (.*)$/))) { st.inc('errors'); setLastError(st, { file: m[1], line: m[2], col: m[3] ?? null, msg: m[4] }); return; }
  if ((m = line.match(/^(panic: |fatal error: )(.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] + m[2] }); st.go.pend = 'panic'; return; }
  if ((m = line.match(/^exit status (\d+)$/))) { st.set('exitStatus', Number(m[1])); return; }
  if (/^(PASS|FAIL)$/.test(line)) st.setPhase('report');
}

// node --test spec reporter glyphs (✔ ✖ ﹣ ▶ ℹ), TAP, Jest, Vitest, Mocha, tsc,
// vite / next build lines, eslint, npm lifecycle banners, uncaught errors.
const NODE_TEST_ABS = { pass: 'passed', fail: 'failed', skipped: 'skipped', todo: 'todo' };

function nodeTestTick(st) {
  st.nd.n += 1;
  st.setPhase('tests', st.nd.n, null);
}

function node(line, st) {
  let m;
  st.nd = st.nd || { n: 0, suites: [], failing: false, pendLoc: null, failName: null, pendErr: null, tapOpen: null, tapNested: false, reported: false };
  const nd = st.nd;
  const inTests = nd.n > 0 || st.counters.suites != null;
  // --- tsc ---
  if ((m = line.match(/^(.+?)\((\d+),(\d+)\): error TS\d{4,5}: (.*)$/)) || (m = line.match(/^(.+?):(\d+):(\d+) - error TS\d{4,5}: (.*)$/))) {
    st.inc('errors'); setLastError(st, { file: m[1], line: m[2], col: m[3], msg: m[4] }); return;
  }
  if ((m = line.match(/^error TS\d{4,5}: (.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] }); return; }
  if ((m = line.match(/^Found (\d+) errors?/))) { st.set('errors', Number(m[1])); st.setPhase('report'); return; }
  if (/Starting compilation in watch mode/.test(line)) { st.setPhase('watching'); return; }
  if (/File change detected\. Starting incremental compilation/.test(line)) { st.set('errors', 0); st.setPhase('compiling'); return; }
  // --- vite / next ---
  if (/^vite v[\d.]+ building for /.test(line)) { st.setPhase('building'); return; }
  if ((m = line.match(/^(transforming|rendering chunks|computing gzip size)\.{3}$/))) {
    st.setPhase(m[1] === 'rendering chunks' ? 'rendering' : m[1] === 'computing gzip size' ? 'gzip' : 'transforming');
    return;
  }
  if ((m = line.match(/^✓ (\d+) modules transformed\.$/))) { st.set('modules', Number(m[1])); st.setPhase('rendering'); return; }
  if (/^✓ built in /.test(line)) { st.setPhase('built'); return; }
  if (/^\s*[✓√] Compiled\b/.test(line)) { st.setPhase('built'); return; }
  if (/^\s*(▲ Next\.js |Creating an optimized production build)/.test(line)) { st.setPhase('building'); return; }
  if ((m = line.match(/^(?:✗|error during build|\s*⨯) ?(.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] || line.trim() }); return; }
  // --- eslint "✖ 3 problems (2 errors, 1 warning)" ---
  if ((m = line.match(/^✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/))) { st.set('errors', Number(m[2])); st.set('warnings', Number(m[3])); st.setPhase('report'); return; }
  // --- npm ---
  if ((m = line.match(/^> \S+@\S+ (\S+)$/))) { st.setPhase(m[1]); return; }
  if (/^npm (error|ERR!) /.test(line)) { st.inc('errors'); return; }
  // --- node --test spec reporter ---
  if (/^✖ failing tests:$/.test(line)) { nd.failing = true; return; }
  if ((m = line.match(/^test at (.+?):(\d+):(\d+)$/))) { nd.pendLoc = { file: m[1], line: m[2], col: m[3] }; return; }
  if ((m = line.match(/^(\s*)▶ (.*)$/))) { nd.suites.push(m[1].length + ':' + m[2]); if (!nd.failing && !st.phase) st.setPhase('tests', nd.n, null); return; }
  if ((m = line.match(/^(\s*)([✔✖﹣]) (.+?) \(\d[\d.]*ms\)(?: # (SKIP|TODO))?$/))) {
    const key = m[1].length + ':' + m[3];
    if (nd.suites.includes(key)) { nd.suites.splice(nd.suites.indexOf(key), 1); return; } // a suite closing, not a test
    if (nd.failing) {
      if (m[2] === '✖') { nd.failName = m[3]; setLastError(st, { ...(nd.pendLoc || { file: null, line: null, col: null }), msg: m[3] }); nd.pendLoc = null; }
      return;
    }
    if (m[4] === 'TODO') st.inc('todo');
    else if (m[4] === 'SKIP' || m[2] === '﹣') st.inc('skipped');
    else st.inc(m[2] === '✔' ? 'passed' : 'failed');
    nodeTestTick(st);
    return;
  }
  if (nd.failName && (m = line.match(/^ {2}(\S.*)$/))) { setLastError(st, { msg: `${nd.failName}: ${m[1]}` }); nd.failName = null; return; }
  if ((m = line.match(/^ℹ (pass|fail|skipped|todo) (\d+)$/))) { st.set(NODE_TEST_ABS[m[1]], Number(m[2])); return; }
  if ((m = line.match(/^ℹ tests (\d+)$/))) { st.setPhase('report'); return; }
  // --- TAP (node --test-reporter=tap) ---
  if ((m = line.match(/^(\s*)# Subtest: (.*)$/))) { if (m[1]) nd.tapNested = true; else { nd.tapOpen = m[2]; nd.tapNested = false; } return; }
  if ((m = line.match(/^(\s*)(not )?ok \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/))) {
    if (!m[1] && nd.tapNested && m[3] === nd.tapOpen) { nd.tapOpen = null; nd.tapNested = false; return; } // suite wrap-up
    if (m[4] === 'TODO') st.inc('todo');
    else if (m[4] === 'SKIP') st.inc('skipped');
    else if (m[2]) { st.inc('failed'); setLastError(st, { file: null, line: null, col: null, msg: m[3] }); nd.pendErr = 'tap'; }
    else st.inc('passed');
    nodeTestTick(st);
    return;
  }
  if (nd.pendErr === 'tap') {
    if ((m = line.match(/^\s+location: '(.+?):(\d+):(\d+)'$/))) { setLastError(st, { file: m[1], line: m[2], col: m[3] }); return; }
    if ((m = line.match(/^\s+error: '(.*)'$/))) { setLastError(st, { msg: `${st.counters.lastError?.msg || ''}: ${m[1]}` }); nd.pendErr = null; return; }
    if (/^\s+\.\.\.$/.test(line)) nd.pendErr = null;
  }
  if ((m = line.match(/^# (pass|fail|skipped|todo) (\d+)$/))) { st.set(NODE_TEST_ABS[m[1]], Number(m[2])); return; }
  if (/^# tests \d+$/.test(line)) { st.setPhase('report'); return; }
  // --- Jest ---
  if ((m = line.match(/^(PASS|FAIL) (\S+)/))) {
    st.inc('suites'); if (m[1] === 'FAIL') { st.inc('suitesFailed'); nd.pendLoc = { file: m[2], line: null, col: null }; }
    st.setPhase('tests', nd.n, null);
    return;
  }
  if ((m = line.match(/^\s*● (.+)$/)) && !/Test suite failed to run/.test(m[1])) { setLastError(st, { ...(nd.pendLoc || { file: null, line: null, col: null }), msg: m[1] }); return; }
  if ((m = line.match(/^Test Suites:\s+(.*?), (\d+) total$/))) {
    st.set('suites', Number(m[2]));
    const f = m[1].match(/(\d+) failed/); if (f) st.set('suitesFailed', Number(f[1]));
    return;
  }
  if ((m = line.match(/^Tests:\s+(.*?), (\d+) total$/)) || (m = line.match(/^\s*Tests\s+(.*?)\s+\((\d+)\)$/))) {
    for (const t of m[1].matchAll(/(\d+) (failed|passed|skipped|todo)/g)) st.set(t[2], Number(t[1]));
    st.setPhase('report');
    return;
  }
  if ((m = line.match(/^Time:\s+([\d.]+) s/))) { st.set('timeS', Number(m[1])); return; }
  // --- Vitest ---
  if ((m = line.match(/^\s*Test Files\s+(.*?)\s+\((\d+)\)$/))) {
    st.set('suites', Number(m[2]));
    const f = m[1].match(/(\d+) failed/); if (f) st.set('suitesFailed', Number(f[1]));
    return;
  }
  if ((m = line.match(/^\s*[✓❯↓×✗] (\S+\.[cm]?[jt]sx?) \((\d+) tests?(?: \| (.*?))?\)/))) {
    const total = Number(m[2]);
    let failed = 0; let skipped = 0;
    for (const t of (m[3] || '').matchAll(/(\d+) (failed|skipped|todo)/g)) { if (t[2] === 'failed') failed += Number(t[1]); else skipped += Number(t[1]); }
    st.inc('suites'); if (failed) { st.inc('suitesFailed'); nd.pendLoc = { file: m[1], line: null, col: null }; }
    if (failed) st.inc('failed', failed); if (skipped) st.inc('skipped', skipped);
    if (total - failed - skipped > 0) st.inc('passed', total - failed - skipped);
    nd.n += total;
    st.setPhase('tests', nd.n, null);
    return;
  }
  if ((m = line.match(/^\s*Duration\s+([\d.]+)s\b/))) { st.set('timeS', Number(m[1])); return; }
  if ((m = line.match(/^\s*FAIL\s+(\S+) > (.+)$/))) { setLastError(st, { file: m[1], line: null, col: null, msg: m[2] }); return; }
  // --- Mocha ---
  if ((m = line.match(/^\s*(\d+) passing\b/))) { st.set('passed', Number(m[1])); nd.reported = true; st.setPhase('report'); return; }
  if ((m = line.match(/^\s*(\d+) failing\b/))) { st.set('failed', Number(m[1])); nd.reported = true; st.setPhase('report'); return; }
  if ((m = line.match(/^\s*(\d+) pending\b/))) { st.set('skipped', Number(m[1])); return; }
  if (nd.reported) return; // the failure recap repeats the per-test lines
  if (/^\s+[✓✔] \S/.test(line)) { st.inc('passed'); nodeTestTick(st); return; }
  if ((m = line.match(/^\s+\d+\) (\S.*)$/))) { st.inc('failed'); setLastError(st, { file: null, line: null, col: null, msg: m[1] }); nodeTestTick(st); return; }
  // --- uncaught error with a stack ---
  if ((m = line.match(/^(\/\S+|[A-Za-z]:\\\S+|file:\/\/\S+):(\d+)$/))) { nd.pendLoc = { file: m[1].replace(/^file:\/\//, ''), line: m[2], col: null }; return; }
  if ((m = line.match(/^((?:[A-Z]\w*)?(?:Error|Exception)(?: \[\w+\])?): (.*)$/))) {
    if (!inTests) st.inc('errors');
    setLastError(st, { ...(nd.pendLoc || (inTests ? {} : { file: null, line: null, col: null })), msg: `${m[1]}: ${m[2]}` });
    nd.pendLoc = null; nd.pendErr = 'stack';
    return;
  }
  if (nd.pendErr === 'stack') {
    if ((m = line.match(/^\s+at (?:.*?\()?(?:file:\/\/)?([^()\s]+?):(\d+):(\d+)\)?$/))) {
      if (!/^node:/.test(m[1])) { setLastError(st, { file: m[1], line: m[2], col: m[3] }); nd.pendErr = null; }
      return;
    }
    if (!/^\s+at /.test(line)) nd.pendErr = null;
  }
}
function latex(line, st) {
  let m;
  st.tex = st.tex || { pass: 0 };
  if ((m = line.match(/^Latexmk: applying rule '([^']+)'/))) { st.setPhase(m[1], st.tex.pass || null, st.tex.pass ? Math.max(st.tex.pass, 3) : null, true); return; }
  if ((m = line.match(/^Run number (\d+) of rule '([^']+)'/))) {
    const n = Number(m[1]);
    st.tex.pass = n;
    st.set('pass', n);
    st.set('passesSoft', Math.max(n, 3));
    st.set('warnings', 0); st.set('errors', 0); // per pass — warnings repeat every pass
    st.setPhase(m[2], n, Math.max(n, 3), true);
    return;
  }
  if ((m = line.match(/^Running '(\w+)/))) { if (!st.phase) st.setPhase(m[1]); return; }
  if ((m = line.match(/^Output written on \S+ \((\d+) pages?/))) { st.set('page', Number(m[1])); return; }
  if (/^LaTeX Warning: /.test(line) || /^Package \w+ Warning: /.test(line)) { st.inc('warnings'); return; }
  if (/^(Overfull|Underfull) \\[hv]box/.test(line)) { st.inc('overfull'); return; }
  if (/^! /.test(line) || /^(?:\.\/)?\S+?\.(?:tex|sty|cls):\d+: /.test(line)) { st.inc('errors'); return; }
  if (/^Latexmk: All targets \(.+\) are up-to-date/.test(line)) { st.setPhase('done'); return; }
  if (/^Latexmk: Errors, so I did not complete/.test(line)) { st.setPhase('failed'); return; }
  // engine page markers "[14" / "[2]" — the largest wins
  let best = null;
  for (const pm of line.matchAll(/\[(\d+)(?:[\]{ ]|$)/g)) best = Math.max(best ?? 0, Number(pm[1]));
  if (best != null && best > 0 && best < 100000 && best > (st.counters.page || 0)) st.set('page', best);
}

function r(line, st) {
  let m;
  if (/^(Loading required package|Attaching package): /.test(line)) { st.setPhase('loading'); return; }
  if (/^processing file: /.test(line) || /^\s*label: \S+$/.test(line)) { st.setPhase('rendering'); return; }
  if (/^(output file|Output created): /.test(line)) { st.setPhase('rendered'); return; }
  if ((m = line.match(/^\s*\|[.=]+\s*\|\s+(\d{1,3})%$/)) || (m = line.match(/^\s*\|[= ]+\|\s+(\d{1,3})%$/))) {
    st.progress({ frac: clamp01(Number(m[1]) / 100) });
    return;
  }
  if ((m = line.match(/\[[=>\- ]+\]\s+(\d+)\/(\d+)\s+(\d{1,3})%(?:\s+eta:\s+(\S+))?/))) {
    const p = { frac: clamp01(Number(m[3]) / 100), iter: Number(m[1]), total: Number(m[2]) };
    const eta = clockS(m[4]);
    if (eta != null) p.etaS = eta;
    st.progress(p);
    return;
  }
  if (/^Warning message:?$/.test(line)) { st.rDeferred = false; st.inc('warnings'); return; }
  if (/^Warning messages:$/.test(line)) { st.rDeferred = true; return; }
  if (st.rDeferred) {
    if (/^\d+: /.test(line)) { st.inc('warnings'); return; }
    if (!/^\s/.test(line)) st.rDeferred = false;
  }
  if (/^Error(?: in .+?)? ?: /.test(line) || /^\s*\*\*\* caught (segfault|bus error) \*\*\*/.test(line)) { st.inc('errors'); return; }
  if (/^Execution halted$/.test(line)) { st.setPhase('halted'); return; }
  if (st.phase?.name === 'loading' && !/^\s/.test(line)) st.setPhase('running');
}

const CURL_ROW_RE = /^\s*(\d{1,3})\s+([\d.]+[kMG]?)\s+(\d{1,3})\s+([\d.]+[kMG]?)\s+(\d{1,3})\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d:.-]+)\s+([\d:.-]+)\s+([\d:.-]+)\s+([\d.]+[kMG]?)$/;
const WGET_DOT_RE = /^\s*(\d+)K [. ]+\s*(\d{1,3})%\s+([\d.]+[KMG]?)\s+([\dhms]+)$/;
const WGET_BAR_RE = /^\s*(\S+)\s+(\d{1,3})%\[[=> ]*\]\s+([\d.,]+[KMG]?)\s+([\d.]+[KMG]?B\/s)(?:\s+(?:eta|in) (\S+))?/;
const WGET_NV_RE = /URL:\S+ \[(\d+)\/(\d+)\]/;
const RSYNC_RE = /^\s*([\d,]+)\s+(\d{1,3})%\s+([\d.]+[kMG]?B\/s)\s+(\d+:\d{2}:\d{2})(?:\s+\((?:xfr|xfer)#(\d+),\s*(to-chk|to-check|ir-chk)=(\d+)\/(\d+)\))?/;

function download(line, st) {
  let m;
  if ((m = line.match(CURL_ROW_RE))) {
    const total = bytesOf(m[2]); const got = bytesOf(m[4]); const speed = bytesOf(m[12]);
    if (got != null) st.set('bytes', got);
    if (speed != null) st.set('rateBps', speed);
    if (total) {
      st.set('total', total);
      const p = { frac: clamp01(Number(m[1]) / 100) };
      const eta = clockS(m[11]);
      if (eta != null) p.etaS = eta;
      st.progress(p);
    }
    st.setPhase('downloading');
    return true;
  }
  if ((m = line.match(/^#*\s+(\d{1,3}(?:\.\d)?)%$/))) { st.progress({ frac: clamp01(Number(m[1]) / 100) }); st.setPhase('downloading'); return true; }
  if ((m = line.match(WGET_DOT_RE))) {
    st.set('bytes', Number(m[1]) * 1024);
    const sp = bytesOf(m[3]); if (sp != null) st.set('rateBps', sp);
    const p = { frac: clamp01(Number(m[2]) / 100) };
    const eta = clockS(m[4]); if (eta != null) p.etaS = eta;
    st.progress(p);
    st.setPhase('downloading');
    return true;
  }
  if ((m = line.match(WGET_BAR_RE))) {
    const b = bytesOf(m[3]); if (b != null) st.set('bytes', b);
    const sp = bytesOf(m[4]); if (sp != null) st.set('rateBps', sp);
    const p = { frac: clamp01(Number(m[2]) / 100) };
    const eta = clockS(m[5]); if (eta != null) p.etaS = eta;
    st.progress(p);
    st.setPhase('downloading');
    return true;
  }
  if ((m = line.match(WGET_NV_RE))) {
    st.set('bytes', Number(m[1])); st.set('total', Number(m[2]));
    st.progress({ frac: 1 });
    return true;
  }
  if ((m = line.match(RSYNC_RE))) {
    st.set('bytes', num(m[1]));
    const sp = bytesOf(m[3], 1000); if (sp != null) st.set('rateBps', sp);
    if (m[5]) {
      const total = Number(m[8]); const remaining = Number(m[7]); const n = Math.max(0, total - remaining);
      st.set('files', Number(m[5]));
      st.setPhase('transferring', n, total, m[6] === 'ir-chk');
      if (total > 0) st.progress({ frac: clamp01(n / total), iter: n, total });
    } else {
      st.setPhase('transferring');
      st.progress({ frac: clamp01(Number(m[2]) / 100) });
    }
    return true;
  }
  if (/^rsync(?: error)?: /.test(line) || /^curl: \(\d+\) /.test(line) || /^wget: /.test(line)) { st.inc('errors'); return true; }
  return false;
}

// cmake / make / ninja / ctest, gcc & clang diagnostics, the linkers, GoogleTest,
// Catch2 and the sanitizers — everything a C/C++ build or test binary prints.
// Errors are counted per diagnostic; a tool's own wrap-up ("make: *** Error",
// "ninja: build stopped", "N errors generated.") never double-counts them.
function build(line, st) {
  let m;
  st.b = st.b || { diag: 0, unitBase: { errors: 0, warnings: 0 }, ct: null, gt: null, gtFail: null, pend: null, makeLevel: null };
  const b = st.b;
  const unitStart = () => { b.unitBase = { errors: st.counters.errors || 0, warnings: st.counters.warnings || 0 }; b.makeLevel = null; };
  // pending second halves: ld's `"_sym", referenced from:` after the macOS header
  if (b.pend === 'ld' && (m = line.match(/^\s+"(.+?)", referenced from:/))) { setLastError(st, { msg: `undefined symbol ${m[1]}` }); b.pend = null; return true; }
  // --- cmake generator output "[ 45%] Building CXX object …" ---
  if ((m = line.match(/^\[\s*(\d{1,3})%\] (Building|Linking|Built target|Generating|Scanning|Automatic MOC|Running)\b/))) {
    st.progress({ frac: clamp01(Number(m[1]) / 100) });
    st.setPhase(m[2] === 'Linking' ? 'linking' : m[2] === 'Building' ? 'compiling' : m[2] === 'Built target' && Number(m[1]) === 100 ? 'built' : 'building');
    unitStart();
    return true;
  }
  // --- ninja "[12/40] Building CXX object …" ---
  if ((m = line.match(/^\[(\d+)\/(\d+)\] (.*)$/))) {
    const n = Number(m[1]); const t = Number(m[2]);
    st.setPhase(/^(LINK|Linking)/.test(m[3]) ? 'linking' : /^(Building|CC|CXX|Compiling)/.test(m[3]) ? 'compiling' : 'building', n, t);
    if (t > 0) st.progress({ frac: clamp01(n / t), iter: n, total: t });
    unitStart();
    return true;
  }
  if (/^FAILED: /.test(line)) { b.diag = 0; setLastError(st, { file: null, line: null, col: null, msg: line }); return true; }
  if (/^ninja: build stopped/.test(line)) { if (!b.diag) st.inc('errors'); b.diag = 0; return true; }
  if (/^ninja: (error|fatal)/.test(line)) { st.inc('errors'); return true; }
  if (/^ninja: no work to do\.$/.test(line)) { st.setPhase('built'); return true; }
  // --- cmake configure ---
  if ((m = line.match(/^-- (Configuring done|Generating done|Build files have been written)/))) {
    st.setPhase(m[1] === 'Configuring done' ? 'generating' : 'generated');
    return true;
  }
  if (/^-- /.test(line)) { if (!st.phase) st.setPhase('configuring'); return true; }
  if ((m = line.match(/^CMake (Error|Warning)/))) { st.inc(m[1] === 'Error' ? 'errors' : 'warnings'); if (m[1] === 'Error') setLastError(st, { file: null, line: null, col: null, msg: line }); return true; }
  // --- make ---
  if ((m = line.match(/^make(?:\[(\d+)\])?: \*\*\* /)) && (/(Error \d+|Killed|Terminated|Segmentation fault)/.test(line) || /No rule to make target/.test(line))) {
    // a shallower level after a deeper one is the same failure propagating up the recursion
    const level = Number(m[1] || 0);
    const propagated = b.makeLevel != null && level < b.makeLevel;
    if (!b.diag && !propagated) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: line }); }
    b.diag = 0; b.makeLevel = level;
    return true;
  }
  if (/^make(?:\[\d+\])?: (Entering|Leaving) directory /.test(line)) { st.setPhase('building'); return true; }
  if (/^make(?:\[\d+\])?: (Nothing to be done for|`\S+' is up to date\.)/.test(line)) { st.setPhase('built'); return true; }
  // make echoing a compiler command starts a new translation unit
  if (/^(?:\S*\/)?(cc|gcc|clang|c\+\+|g\+\+|clang\+\+)(?:-\d+)? .*(?:-c |-o )/.test(line)) { unitStart(); st.setPhase(/\.(c|cc|cpp|cxx|c\+\+|C|m|mm|s|S)(\s|$)/.test(line) ? 'compiling' : 'linking', st.phase?.n ?? null, st.phase?.m ?? null); return true; }
  // --- gcc / clang "file.c:12:5: error: msg" (also UBSan's "runtime error:") ---
  if ((m = line.match(/^(\S+?):(\d+):(\d+): (error|fatal error|warning|note|runtime error): (.*)$/))) {
    if (m[4] === 'warning') st.inc('warnings');
    else if (m[4] === 'note') st.inc('notes');
    else { st.inc('errors'); b.diag += 1; setLastError(st, { file: m[1], line: m[2], col: m[3], msg: m[5] }); }
    return true;
  }
  // clang's per-unit totals: reconcile upward only (lines can be lost under a pty)
  if ((m = line.match(/^(?:(\d+) warnings? and )?(\d+) (warnings?|errors?) generated\.$/))) {
    const w = m[1] != null ? Number(m[1]) : (m[3].startsWith('warning') ? Number(m[2]) : 0);
    const e = m[3].startsWith('error') ? Number(m[2]) : 0;
    if (w && (st.counters.warnings || 0) < b.unitBase.warnings + w) st.set('warnings', b.unitBase.warnings + w);
    if (e && (st.counters.errors || 0) < b.unitBase.errors + e) { st.set('errors', b.unitBase.errors + e); b.diag += 1; }
    return true;
  }
  // --- linkers ---
  if ((m = line.match(/undefined reference to [`'](.+?)'/))) { st.inc('errors'); b.diag += 1; setLastError(st, { file: null, line: null, col: null, msg: `undefined reference to ${m[1]}` }); return true; }
  if (/^Undefined symbols for architecture /.test(line)) { st.inc('errors'); b.diag += 1; b.pend = 'ld'; setLastError(st, { file: null, line: null, col: null, msg: 'undefined symbols' }); return true; }
  if (/^(?:\/\S*\/)?ld(?:\.\w+)?: warning: /.test(line)) { st.inc('warnings'); return true; }
  if ((m = line.match(/^(?:\/\S*\/)?ld(?:\.\w+)?: (?!symbol\(s\) not found)(?!.*: in function )(.*)$/))) { st.inc('errors'); b.diag += 1; setLastError(st, { file: null, line: null, col: null, msg: `ld: ${m[1]}` }); return true; }
  if ((m = line.match(/^(?:clang|gcc|cc|g\+\+|c\+\+|clang\+\+)(?:-\d+)?: (?:fatal )?error: (?!linker command failed)(.*)$/))) { st.inc('errors'); b.diag += 1; setLastError(st, { file: null, line: null, col: null, msg: m[1] }); return true; }
  if (/^collect2: error: ld returned/.test(line) || /^clang: error: linker command failed/.test(line)) { b.diag += 1; return true; }
  // --- sanitizers ---
  if ((m = line.match(/^==\d+==\s*ERROR: (\w+Sanitizer): (.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: `${m[1]}: ${m[2]}` }); b.pend = 'san'; return true; }
  if (b.pend === 'san' && (m = line.match(/^SUMMARY: \w+Sanitizer: \S+ (\S+?):(\d+)(?::(\d+))? in /))) { setLastError(st, { file: m[1], line: m[2], col: m[3] ?? null }); b.pend = null; return true; }
  // --- ctest ---
  if ((m = line.match(/^\s*(\d+)\/(\d+) Test\s+#\d+: (\S+) \.*\s*(\*{3})?(Passed|Failed|Exception|Timeout|Not Run|Skipped)\b/))) {
    b.ct = { n: Number(m[1]), m: Number(m[2]) };
    if (m[5] === 'Passed') st.inc('passed');
    else if (m[5] === 'Skipped' || m[5] === 'Not Run') st.inc('skipped');
    else { st.inc('failed'); setLastError(st, { file: null, line: null, col: null, msg: `${m[3]}: ${m[5]}` }); }
    st.setPhase('tests', b.ct.n, b.ct.m);
    if (b.ct.m) st.progress({ frac: clamp01(b.ct.n / b.ct.m), iter: b.ct.n, total: b.ct.m });
    return true;
  }
  if (/^Test project /.test(line)) { st.setPhase('tests'); return true; }
  if ((m = line.match(/^(\d+)% tests passed, (\d+) tests? failed out of (\d+)$/))) {
    st.set('failed', Number(m[2]));
    st.set('passed', Math.max(0, Number(m[3]) - Number(m[2]) - (st.counters.skipped || 0)));
    st.setPhase('report');
    return true;
  }
  // --- GoogleTest ---
  if ((m = line.match(/^\[==========\] Running (\d+) tests? from (\d+) test (?:suites?|cases?)\.$/))) { b.gt = { n: 0, m: Number(m[1]) }; st.set('suites', Number(m[2])); st.setPhase('tests', 0, b.gt.m); return true; }
  if ((m = line.match(/^\[\s+(OK|FAILED|SKIPPED)\s+\] (\S+) \(\d+ ms\)$/))) {
    b.gt = b.gt || { n: 0, m: null };
    b.gt.n += 1;
    if (m[1] === 'OK') st.inc('passed'); else if (m[1] === 'SKIPPED') st.inc('skipped'); else { st.inc('failed'); setLastError(st, { ...(b.gtFail || { file: null, line: null, col: null }), msg: m[2] }); }
    b.gtFail = null;
    st.setPhase('tests', b.gt.n, b.gt.m);
    if (b.gt.m) st.progress({ frac: clamp01(b.gt.n / b.gt.m), iter: b.gt.n, total: b.gt.m });
    return true;
  }
  if ((m = line.match(/^(\S+?):(\d+): Failure$/))) { b.gtFail = { file: m[1], line: m[2], col: null }; return true; }
  if ((m = line.match(/^\[\s+PASSED\s+\] (\d+) tests?\.$/))) { st.set('passed', Number(m[1])); st.setPhase('report'); return true; }
  if ((m = line.match(/^\s*(\d+) FAILED TESTS?$/))) { st.set('failed', Number(m[1])); st.setPhase('report'); return true; }
  if (/^\[==========\] \d+ tests? from \d+ test (?:suites?|cases?) ran\./.test(line)) { st.setPhase('report'); return true; }
  // --- Catch2 ---
  if ((m = line.match(/^All tests passed \((\d+) assertions? in (\d+) test cases?\)$/))) { st.set('passed', Number(m[2])); st.set('failed', 0); st.setPhase('report'); return true; }
  if ((m = line.match(/^test cases:\s+(\d+)(.*)$/))) {
    const p = m[2].match(/(\d+) passed/); const f = m[2].match(/(\d+) failed/); const s = m[2].match(/(\d+) skipped/);
    st.set('passed', p ? Number(p[1]) : Number(m[1])); st.set('failed', f ? Number(f[1]) : 0); if (s) st.set('skipped', Number(s[1]));
    st.setPhase('report');
    return true;
  }
  if ((m = line.match(/^(\S+?):(\d+): FAILED:$/))) { setLastError(st, { file: m[1], line: m[2], col: null, msg: 'FAILED' }); return true; }
  return false;
}
function notebook(line, st) {
  let m;
  if ((m = line.match(/^Executing(?: (\S+))?:\s+(\d{1,3})%\|[^|]*\|\s*(\d+)\/(\d+)/)) || (m = line.match(/^Executing(?: (\S+))?:\s+()(\d+)\/(\d+)\b/))) {
    const n = Number(m[3]); const t = Number(m[4]);
    st.setPhase('executing', n, t);
    if (t > 0) st.progress({ frac: clamp01(n / t), iter: n, total: t });
    return;
  }
  if (/^\[NbConvertApp\] Converting notebook /.test(line) || /^\[NbClientApp\] Executing /.test(line)) { st.setPhase('executing'); return; }
  if (/^\[NbConvertApp\] Executing cell:$/.test(line)) { st.inc('cells'); return; }
  if (/^\[NbConvertApp\] Writing \d+ bytes to /.test(line)) { st.setPhase('wrote'); return; }
  if (/^(nbclient\.exceptions\.\w+|papermill\.exceptions\.\w+):/.test(line) || /Kernel died while waiting/.test(line)) { st.inc('errors'); return; }
  if (/^Traceback \(most recent call last\):$/.test(line)) st.inc('errors');
}

function sql(line, st) {
  let m;
  if ((m = line.match(/^-- (.{1,88})$/))) { st.inc('statements'); st.setPhase('statement', st.counters.statements, null); return; }
  if (/^error: /.test(line) || /^(Catalog|Binder|Parser|Conversion|Out of Memory|IO|Invalid Input|Constraint|Dependency|Permission|Serialization|Internal) Error: /.test(line)
    || /^(Parse|Runtime) error/.test(line) || /^psql:\S+:\d+: ERROR: /.test(line)) st.inc('errors');
}

function shell(line, st) {
  if (download(line, st)) return;
  build(line, st);
}

const stata = () => { /* stata -b writes only to <file>.log — nothing reaches stdout */ };

const HANDLERS = {
  julia, python, pytest, cargo, rust: cargo, go, node, tsc: node, vite: node, latex, r,
  curl: download, wget: download, rsync: download,
  make: build, cmake: build, ninja: build, ctest: build, cc: build, build,
  stata, papermill: notebook, nbconvert: notebook, sql, shell,
};

// coarse language OR a registry `parser` key (lib/runtimes.js step.parser) → handler
const LANG_DEFAULT = {
  julia: 'julia', python: 'python', r: 'r', shell: 'shell', sql: 'sql', notebook: 'nbconvert', stata: 'stata',
  cargo: 'cargo', rust: 'rust', go: 'go', node: 'node', javascript: 'node', typescript: 'node', tsx: 'node',
  build: 'build', c: 'build', cpp: 'build',
};

/**
 * Build a parser for one job. `lang` is the job's coarse language (from the
 * runner's extension table or detectScriptRun); `command` refines it to a
 * runtime (`python -m pytest` → pytest). Unknown runtimes get a parser whose
 * feed() always returns null — the generic fallback still runs in jobs.js.
 */
export function createJobParser(lang, command) {
  const runtime = detectRuntime(command) || LANG_DEFAULT[String(lang || '').toLowerCase()] || null;
  const handler = runtime ? HANDLERS[runtime] : null;
  const st = {
    phase: null,
    counters: {},
    _out: null,
    setPhase(name, n = null, m = null, mSoft = false) {
      const next = { name: String(name), n: n ?? null, m: m ?? null, mSoft: !!mSoft };
      const cur = st.phase;
      if (cur && cur.name === next.name && cur.n === next.n && cur.m === next.m && cur.mSoft === next.mSoft) return;
      st.phase = next;
      st._out.phase = { ...next };
    },
    inc(key, by = 1) { st.set(key, (st.counters[key] || 0) + by); },
    set(key, val) {
      if (st.counters[key] === val) return;
      if (val && typeof val === 'object' && JSON.stringify(st.counters[key]) === JSON.stringify(val)) return;
      st.counters[key] = val;
      (st._out.counters = st._out.counters || {})[key] = val;
    },
    progress(p) { st._out.progress = { ...(st._out.progress || {}), ...p }; },
  };
  return {
    runtime,
    get phase() { return st.phase; },
    get counters() { return { ...st.counters }; },
    feed(rawLine) {
      if (!handler) return null;
      try {
        let line = stripAnsi(String(rawLine ?? ''));
        // a \r-redrawn frame that reached us whole: keep the final segment
        const cr = line.lastIndexOf('\r');
        if (cr !== -1) line = line.slice(cr + 1);
        line = line.replace(/\s+$/, '');
        if (!line || line.length > 4000) return null;
        st._out = {};
        handler(line, st);
        const out = st._out;
        st._out = null;
        return Object.keys(out).length ? out : null;
      } catch {
        st._out = null;
        return null;
      }
    },
  };
}
