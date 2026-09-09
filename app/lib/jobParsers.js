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
//     'nbconvert' | 'sql' | 'java' | 'matlab' | 'shell' | null
//   stataLogSummary(logText) → { counters, rc, codes, errors[], endOfDoFile,
//     commands } — the batch log tail (stdout is empty; see stata below)
//
//   Phase words: fetching · compiling n/m · linking · built · running · tests n/m ·
//     report (plus configuring/generating/generated/building for cmake/make).
//   Counter keys: errors warnings notes · passed failed skipped todo · errored
//     broken total (Julia Test / surefire / MATLAB runtests) · ok (go packages) ·
//     suites suitesFailed · crate · coverage · modules · timeS · exitStatus ·
//     rc (Stata return code, from the log) · unverified (1 = this runtime's
//     stdout cannot vouch for the result) · lastError {file,line,col,msg}
//     (most recent error diagnostic).
//
// Honesty rules baked in: cargo has no n/m unless the runner set
// CARGO_TERM_PROGRESS_WHEN=always (the Building bar); openrsync (macOS) spells
// `to-check=` and `xfer#` where rsync 3 prints `to-chk=`/`xfr#`; Stata batch
// writes nothing to stdout, so its stdout parser only raises the `unverified`
// marker (stataLogSummary reads the log); latexmk's pass total is a soft
// ≤ max(N, 3).

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
  // `java File.java` (source-file mode), javac, Maven (+ the ./mvnw wrapper), Gradle (+ ./gradlew)
  if (/^(java|javac|mvn|mvnw|gradle|gradlew)$/.test(argv0)) return 'java';
  // `matlab -batch "…"` · `/Applications/MATLAB_R2024b.app/bin/matlab -batch …`
  if (/^matlab$/i.test(argv0)) return 'matlab';
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

// Right-aligned numeric tables (Julia's `Test Summary:` rows, testthat's
// `F W  S  OK` rows): a cell's last digit sits under the last character of its
// header word, so the header's column ends locate every later row's numbers.
function columnEnds(header, from) {
  const cols = [];
  for (const m of header.slice(from).matchAll(/\S+/g)) cols.push({ key: m[0], end: from + m.index + m[0].length - 1 });
  return cols;
}
function cellAt(line, end) {
  if (!/\d/.test(line[end] || '')) return null;
  let i = end;
  while (i > 0 && /\d/.test(line[i - 1])) i -= 1;
  return Number(line.slice(i, end + 1));
}

const JULIA_TEST_KEYS = { Pass: 'passed', Fail: 'failed', Error: 'errored', Broken: 'broken', Total: 'total' };

function julia(line, st) {
  let m;
  st.jl = st.jl || { pend: null, tbl: null, sums: {} };
  const jl = st.jl;
  // --- Test.jl "Test Summary:" table: the top-level row of each table adds to the totals.
  // Program output without a trailing newline glues onto the header ("Hello World!Test
  // Summary: | Pass  Total  Time" — a real capture), so the columns are measured from
  // the header's own start and the rows' pipe is expected at that same offset.
  if ((m = line.match(/^(.*?)(Test Summary:\s*\|)/))) {
    const off = m[1].length;
    jl.tbl = { pipe: m[0].length - 1 - off, cols: columnEnds(line, m[0].length).map((c) => ({ key: c.key, end: c.end - off })) };
    jl.pend = null;
    st.setPhase('report');
    return;
  }
  if (jl.tbl) {
    if (line.indexOf('|') === jl.tbl.pipe && !/^Test Summary:/.test(line)) {
      if (!/^\s/.test(line)) { // nested testsets are indented and already counted in their parent
        for (const c of jl.tbl.cols) {
          const key = JULIA_TEST_KEYS[c.key]; if (!key) continue;
          const v = cellAt(line, c.end);
          if (v != null) { jl.sums[key] = (jl.sums[key] || 0) + v; st.set(key, jl.sums[key]); }
        }
      }
      return;
    }
    jl.tbl = null;
  }
  // --- Pkg.test wrapper lines ---
  if ((m = line.match(/^\s*Testing (\S+)$/))) { st.setPhase('tests'); return; }
  if (/^\s*Testing Running tests\.\.\.$/.test(line)) { st.setPhase('tests'); return; }
  if ((m = line.match(/^\s*Testing (\S+) tests passed\s*$/))) { st.setPhase('report'); return; }
  // Pkg's wrap-up after a failing runtests.jl: an error, but the test's own location (already
  // in lastError) is the better error line — only fill it in when nothing more specific was seen
  if ((m = line.match(/^ERROR: (?:LoadError: )?Package (\S+) errored during testing/))) {
    st.inc('errors');
    if (!st.counters.lastError) setLastError(st, { file: null, line: null, col: null, msg: `Package ${m[1]} errored during testing` });
    jl.pend = null;
    return;
  }
  // "Some tests did not pass: 2 passed, 1 failed, 1 errored, 1 broken." — a total, not an error
  if ((m = line.match(/^ERROR: (?:LoadError: )?Some tests did not pass: (\d+) passed, (\d+) failed, (\d+) errored, (\d+) broken\.$/))) {
    const p = Number(m[1]); const f = Number(m[2]); const e = Number(m[3]); const b = Number(m[4]);
    st.set('passed', p); st.set('failed', f); st.set('errored', e); st.set('broken', b); st.set('total', p + f + e + b);
    st.setPhase('report'); jl.pend = null;
    return;
  }
  // --- @testset failure / error blocks: "Arith: Test Failed at /x/tests.jl:4" then "  Expression: 2 * 2 == 5" ---
  if ((m = line.match(/^(.*?): (Test Failed|Error During Test) at (.+?):(\d+)$/))) {
    st.inc(m[2] === 'Test Failed' ? 'failed' : 'errored');
    setLastError(st, { file: m[3], line: m[4], col: null, msg: `${m[1]}: ${m[2]}` });
    jl.pend = { kind: 'expr', name: m[1] };
    if (!st.phase || st.phase.name !== 'tests') st.setPhase('tests');
    return;
  }
  if (jl.pend?.kind === 'expr' && (m = line.match(/^\s+Expression: (.*)$/))) { setLastError(st, { msg: `${jl.pend.name}: ${m[1]}` }); jl.pend = null; return; }
  // --- uncaught "ERROR: msg" + Stacktrace: the first Main / top-level frame carries the location ---
  if (/^Stacktrace:$/.test(line)) { jl.pend = jl.pend?.kind === 'err' ? { kind: 'stack' } : null; return; }
  if (jl.pend?.kind === 'stack') {
    if ((m = line.match(/^\s+@ (?:(\S+) )?(\S+?):(\d+)(?: \[inlined\])?$/))) {
      if ((!m[1] || m[1] === 'Main') && !/^(none|REPL\[\d+\]|\.\/)/.test(m[2]) && !/\/stdlib\//.test(m[2])) { setLastError(st, { file: m[2], line: m[3] }); jl.pend = null; }
      return;
    }
    if ((m = line.match(/^in expression starting at (.+?):(\d+)$/))) { if (st.counters.lastError?.file == null) setLastError(st, { file: m[1], line: m[2] }); jl.pend = null; return; }
    if (/^\s/.test(line)) return;
    jl.pend = null;
  }
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
  if ((m = line.match(/^ERROR: (.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] }); jl.pend = { kind: 'err' }; return; }
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

// A Python traceback: "Traceback (most recent call last):" counts the error,
// the LAST `File "x.py", line N, in f` frame is the location, and the final
// non-indented `ExceptionName: message` line closes it into lastError. The
// SyntaxError form has the File line but no Traceback header — it is counted
// when its exception line arrives. Returns true when the line was consumed.
function pyTraceback(line, st) {
  let m;
  st.pyt = st.pyt || { pend: null, frame: null };
  const t = st.pyt;
  if (/^Traceback \(most recent call last\):$/.test(line)) { st.inc('errors'); t.pend = 'tb'; t.frame = null; return true; }
  if ((m = line.match(/^\s+File "(.+?)", line (\d+)(?:, in .*)?$/))) { t.frame = { file: m[1], line: m[2] }; if (!t.pend) t.pend = 'file'; return true; }
  if (!t.pend) return false;
  if (/^(During handling of the above exception|The above exception was the direct cause)/.test(line)) return true;
  if ((m = line.match(/^([A-Z][\w.]*)(?:: (.*))?$/))) {
    if (t.pend === 'file') st.inc('errors');
    setLastError(st, { file: t.frame?.file ?? null, line: t.frame?.line ?? null, col: null, msg: m[2] != null ? `${m[1]}: ${m[2]}` : m[1] });
    t.pend = null; t.frame = null;
    return true;
  }
  if (/^\s/.test(line)) return true; // the echoed source line and its caret
  t.pend = null;
  return false;
}

function python(line, st) {
  if (tqdm(line, st)) return;
  let m;
  if (pyTraceback(line, st)) return;
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
  // --- failure blocks → lastError ---
  // "______ test_bad ______" opens a block; its first "E   …" line is the message and
  // "tests/test_x.py:9: AssertionError" the location. The short summary
  // "FAILED tests/test_x.py::test_bad - AssertionError: sum mismatch" re-selects that
  // test's block (so the last failure listed is the row's error line), or stands
  // alone with the file when the block was not seen.
  st.pyl = st.pyl || { open: null, fails: {} };
  const pl = st.pyl;
  if ((m = line.match(/^_{3,} (.+?) _{3,}$/))) { pl.open = { name: m[1], msg: null }; return; }
  if (pl.open && (m = line.match(/^E\s{2,}(.*)$/))) {
    if (pl.open.msg == null) { pl.open.msg = m[1]; setLastError(st, { file: null, line: null, col: null, msg: m[1] }); }
    return;
  }
  if (pl.open && (m = line.match(/^(\S+?\.py):(\d+): ([A-Z]\w*)$/))) {
    setLastError(st, { file: m[1], line: m[2], col: null });
    pl.fails[pl.open.name] = { ...st.counters.lastError };
    pl.open = { name: pl.open.name, msg: null }; // a chained "During handling…" block in the same test
    return;
  }
  if ((m = line.match(/^(FAILED|ERROR) (\S+?\.py)(?:::(\S+))?(?: - (.*))?$/))) {
    const name = (m[3] || '').replace(/::/g, '.');
    const known = name && pl.fails[name];
    if (known) setLastError(st, { ...known, msg: m[4] ?? known.msg });
    else setLastError(st, { file: m[2], line: null, col: null, msg: m[4] ?? (m[3] || m[1]) });
    pl.open = null;
    return;
  }
  if (/^=+ .* =+$/.test(line)) pl.open = null;
  pyTraceback(line, st);
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

// testthat's ProgressReporter (reporter-progress.R): header "✔ | F W  S  OK | Context",
// one row per context "✖ | 1        3 | bad [0.2s]" (F/W single-width, S %2d, OK %3d,
// each right-aligned under its header word; a braille spinner glyph marks a row
// still being redrawn), issue headers "── Failure (test-x.R:12:3): name ──" and the
// closing "[ FAIL 1 | WARN 0 | SKIP 0 | PASS 12 ]". ASCII fallbacks (v x ! -) accepted.
const TT_KEYS = { F: 'failed', W: 'warnings', S: 'skipped', OK: 'passed' };
function testthat(line, st, m) {
  st.tt = st.tt || { cols: null, sums: {}, pend: null };
  const tt = st.tt;
  if ((m = line.match(/^[✔v] \| (?=F W)/))) { tt.cols = columnEnds(line, m[0].length); st.setPhase('tests'); return true; }
  if (tt.cols && (m = line.match(/^([✔✖⚠Svx!⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) \| (.*?) \| (.+?)(?: \[[\d.]+s\])?$/))) {
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/.test(m[1])) { st.setPhase('tests'); return true; } // spinner frame: not final
    for (const c of tt.cols) {
      const key = TT_KEYS[c.key]; if (!key) continue;
      const v = cellAt(line, c.end);
      if (v != null) { tt.sums[key] = (tt.sums[key] || 0) + v; st.set(key, tt.sums[key]); }
    }
    return true;
  }
  if ((m = line.match(/^\[ FAIL (\d+) \| WARN (\d+) \| SKIP (\d+) \| PASS (\d+) \]$/))) {
    st.set('failed', Number(m[1])); st.set('warnings', Number(m[2])); st.set('skipped', Number(m[3])); st.set('passed', Number(m[4]));
    st.setPhase('report');
    return true;
  }
  if ((m = line.match(/^(?:[─-]{2,} )?(Failure|Error|Warning|Skip) \((.+?):(\d+):(\d+)\): (.*?)(?: [─-]{2,})?$/))) {
    if (m[1] === 'Failure' || m[1] === 'Error') { setLastError(st, { file: m[2], line: m[3], col: m[4], msg: `${m[1]}: ${m[5]}` }); tt.pend = { name: m[5] }; } else tt.pend = null;
    return true;
  }
  if (tt.pend) {
    if ((m = line.match(/^(?![─═-]{2,})(\S.*)$/))) { setLastError(st, { msg: `${tt.pend.name}: ${m[1]}` }); tt.pend = null; return true; }
    if (/^[─═-]{2,}/.test(line)) tt.pend = null;
  }
  return false;
}

function r(line, st) {
  let m;
  if (testthat(line, st, m)) return;
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
  // "Error in f(y) : negative input" · "Error: boom" · a caught segfault — errors + the row's error line
  if (/^Error(?: in .+?)? ?: /.test(line) || /^\s*\*\*\* caught (segfault|bus error) \*\*\*/.test(line)) {
    st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: line.trim() }); return;
  }
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
  // the CLI's traceback ends in the papermill/nbclient exception line: one error, not two
  if (/^(nbclient\.exceptions\.\w+|papermill\.exceptions\.\w+):/.test(line) || /Kernel died while waiting/.test(line)) { if (st.nbTb) st.nbTb = false; else st.inc('errors'); return; }
  if (/^Traceback \(most recent call last\):$/.test(line)) { st.inc('errors'); st.nbTb = true; }
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

// stata -b / -e writes only to <file>.log — nothing on stdout says whether the
// do-file ran, so whatever arrives here (a runner banner, an echoed command)
// only raises the `unverified` marker; the result lives in stataLogSummary().
function stata(line, st) {
  if (!st.counters.unverified) st.set('unverified', 1);
}

/**
 * Read a Stata batch log's tail: every `r(NNN);` is an error whose message is
 * the line printed just before it (Stata repeats the code once more after
 * `end of do-file` — that echo is not a second error), `. ` command echoes
 * are counted, not parsed. `counters` is wire-shaped (errors · rc · lastError)
 * for the session job; `verified` is true because the log was read.
 */
export function stataLogSummary(text) {
  const errors = [];
  let rc = null; let endOfDoFile = false; let commands = 0; let prev = ''; let prevIsEnd = false;
  for (const raw of String(text ?? '').replace(/\r/g, '\n').split('\n')) {
    const line = stripAnsi(raw).replace(/\s+$/, '');
    if (!line) continue;
    let m;
    if (/^\.( |$)/.test(line)) { commands += 1; prev = ''; prevIsEnd = false; continue; } // "." alone: the trailing-space echo before "end of do-file"
    if (/^end of do-file$/.test(line)) { endOfDoFile = true; prevIsEnd = true; prev = ''; continue; }
    if ((m = line.match(/^r\((\d+)\);?$/))) {
      rc = Number(m[1]);
      if (!prevIsEnd) errors.push({ rc, msg: prev || `r(${rc})` });
      prev = ''; prevIsEnd = false;
      continue;
    }
    prev = line; prevIsEnd = false;
  }
  const counters = { errors: errors.length };
  if (rc != null) counters.rc = rc;
  if (errors.length) counters.lastError = { file: null, line: null, col: null, msg: String(errors[errors.length - 1].msg).slice(0, 200) };
  return { counters, rc, codes: errors.map((e) => e.rc), errors, endOfDoFile, commands, verified: true };
}

// javac / `java File.java` diagnostics, an uncaught exception's stack, Maven
// (surefire "Tests run:" totals, [ERROR] file:[l,c] diagnostics, BUILD SUCCESS /
// FAILURE) and Gradle ("> Task :x", "N tests completed, M failed", "BUILD
// SUCCESSFUL in"). A test count line without "Time elapsed" is the run's total.
function java(line, st) {
  let m;
  st.jv = st.jv || { pend: null, sums: null };
  const jv = st.jv;
  if (jv.pend === 'stack') {
    if ((m = line.match(/^\s+at [\w$.<>/ ]+\((\S+?\.(?:java|kt|scala|groovy)):(\d+)\)$/))) { setLastError(st, { file: m[1], line: m[2] }); jv.pend = null; return; }
    if (/^\s+at /.test(line) || /^\s*\.\.\. \d+ more$/.test(line) || /^Caused by: /.test(line)) return;
    jv.pend = null;
  }
  if (jv.pend === 'gradle') {
    // "    java.lang.AssertionError: expected:<4> but was:<3> at FooTest.java:12"
    if ((m = line.match(/^\s+(\S+?)(?:: (.*?))? at (\S+?\.(?:java|kt)):(\d+)$/))) { setLastError(st, { file: m[3], line: m[4], msg: m[2] ? `${st.counters.lastError?.msg}: ${m[2]}` : undefined }); jv.pend = null; return; }
    if (!/^\s/.test(line)) jv.pend = null;
  }
  // --- javac "Bad.java:3: error: incompatible types…" · maven "[ERROR] /x/Bad.java:[3,17] …" ---
  if ((m = line.match(/^(\S+?\.java):(\d+): (error|warning): (.*)$/)) || (m = line.match(/^\[(ERROR|WARNING)\] (\S+?\.java):\[(\d+),(\d+)\] (.*)$/))) {
    const maven = m[0].startsWith('[');
    const kind = (maven ? m[1] : m[3]).toLowerCase();
    if (kind === 'error') { st.inc('errors'); setLastError(st, maven ? { file: m[2], line: m[3], col: m[4], msg: m[5] } : { file: m[1], line: m[2], col: null, msg: m[4] }); }
    else st.inc('warnings');
    if (!st.phase) st.setPhase('compiling');
    return;
  }
  if ((m = line.match(/^(?:\[(?:INFO|ERROR|WARNING)\] )?(\d+) (errors?|warnings?)$/))) { // javac's own total: reconcile upward only
    const key = m[2].startsWith('error') ? 'errors' : 'warnings';
    if ((st.counters[key] || 0) < Number(m[1])) st.set(key, Number(m[1]));
    return;
  }
  if (/^error: compilation failed$/.test(line)) return; // `java File.java` wrap-up after the diagnostics
  if ((m = line.match(/^(?:warning|error): (.*)$/))) { if (line.startsWith('error')) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] }); } else st.inc('warnings'); return; }
  // --- an uncaught exception: 'Exception in thread "main" java.lang.X: msg' then "\tat Crash.f(Crash.java:2)" ---
  if ((m = line.match(/^Exception in thread "[^"]*" (\S+?)(?:: (.*))?$/))) {
    st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[2] != null ? `${m[1]}: ${m[2]}` : m[1] }); jv.pend = 'stack'; return;
  }
  // --- surefire / gradle test totals ---
  if ((m = line.match(/^(?:\[(?:INFO|ERROR|WARNING)\] )?Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(.*)$/))) {
    const n = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (/Time elapsed/.test(m[5])) { // one test class — running sums until the Results total arrives
      jv.sums = jv.sums || [0, 0, 0, 0];
      n.forEach((v, i) => { jv.sums[i] += v; });
      st.setPhase('tests');
    } else { jv.sums = n.slice(); st.setPhase('report'); }
    const [t, f, e, s] = jv.sums;
    st.set('total', t); st.set('failed', f); st.set('errored', e); st.set('skipped', s); st.set('passed', Math.max(0, t - f - e - s));
    return;
  }
  if ((m = line.match(/^(\d+) tests completed, (\d+) failed(?:, (\d+) skipped)?$/))) {
    const t = Number(m[1]); const f = Number(m[2]); const s = Number(m[3] || 0);
    st.set('total', t); st.set('failed', f); if (m[3]) st.set('skipped', s); st.set('passed', Math.max(0, t - f - s));
    st.setPhase('report');
    return;
  }
  // "[ERROR]   FooTest.testBad:12 expected:<4> but was:<3>" — surefire's failure recap
  if ((m = line.match(/^\[ERROR\] {2,}(\S+?)\.(\w+):(\d+)(?: (.*))?$/))) { setLastError(st, { file: `${m[1].split('.').pop()}.java`, line: m[3], col: null, msg: `${m[2]}: ${m[4] || 'failed'}` }); return; }
  // "FooTest > testBad FAILED" — gradle's per-test line; the reason follows indented
  if ((m = line.match(/^(\S+) > (\S+) FAILED$/))) { st.inc('failed'); setLastError(st, { file: null, line: null, col: null, msg: `${m[1]}.${m[2]}` }); jv.pend = 'gradle'; st.setPhase('tests'); return; }
  // --- phases ---
  if ((m = line.match(/^\[INFO\] --- \S+?:[^:\s]+:(\w+)/))) { st.setPhase(/compile/i.test(m[1]) ? 'compiling' : m[1] === 'test' ? 'tests' : 'building'); return; }
  if (/^\[INFO\] Running \S+$/.test(line)) { st.setPhase('tests'); return; }
  if ((m = line.match(/^> Task :(\S+)/))) { st.setPhase(/compile/i.test(m[1]) ? 'compiling' : /(^|:)test$/.test(m[1]) ? 'tests' : 'building'); return; }
  if (/^\[INFO\] BUILD SUCCESS$/.test(line) || /^BUILD SUCCESSFUL in /.test(line)) { st.setPhase('built'); return; }
  if (/^\[INFO\] BUILD FAILURE$/.test(line) || /^BUILD FAILED in /.test(line) || /^FAILURE: Build failed with an exception\.$/.test(line)) { st.setPhase('failed'); return; }
  if ((m = line.match(/^\[ERROR\] Failed to execute goal .*?: (.*?)(?: -> \[Help \d+\])?$/))) { if (!st.counters.lastError) setLastError(st, { file: null, line: null, col: null, msg: m[1] }); return; }
}

// MATLAB -batch: "Error using f (line 12)" (message on the next line), "Error in
// script (line 3)" (the caller frames of the same error, or a fresh error whose
// message came just before), "Error: File: x.m Line: 3 Column: 5" (syntax);
// runtests prints "Running t" … "Totals:" then "N Passed, M Failed, K Incomplete."
// (Incomplete → errored).
function matlab(line, st) {
  let m;
  st.ml = st.ml || { pend: null, open: false, last: null };
  const ml = st.ml;
  if (ml.pend === 'msg') { if (line.trim()) { setLastError(st, { msg: line.trim() }); ml.pend = null; } return; }
  if ((m = line.match(/^Error using (.+?) \(line (\d+)\)$/))) { st.inc('errors'); setLastError(st, { file: m[1], line: m[2], col: null, msg: null }); ml.pend = 'msg'; ml.open = true; return; }
  if ((m = line.match(/^Error in (.+?) \(line (\d+)\)$/))) {
    if (!ml.open) { st.inc('errors'); setLastError(st, { file: m[1], line: m[2], col: null, msg: ml.last }); ml.open = true; }
    return;
  }
  if ((m = line.match(/^Error: File: (\S+) Line: (\d+) Column: (\d+)$/))) { st.inc('errors'); setLastError(st, { file: m[1], line: m[2], col: m[3], msg: null }); ml.pend = 'msg'; ml.open = true; return; }
  if ((m = line.match(/^Error: (.*)$/))) { st.inc('errors'); setLastError(st, { file: null, line: null, col: null, msg: m[1] }); ml.open = true; return; }
  if (/^Warning: /.test(line)) { st.inc('warnings'); return; }
  if ((m = line.match(/^Running (\S+)$/))) { st.setPhase('tests'); return; }
  if ((m = line.match(/^Error occurred in (\S+) and it did not run to completion\.$/))) { st.inc('errored'); setLastError(st, { file: null, line: null, col: null, msg: `${m[1]}: did not run to completion` }); return; }
  if ((m = line.match(/^Verification failed in (\S+)\.$/))) { st.inc('failed'); setLastError(st, { file: null, line: null, col: null, msg: `${m[1]}: verification failed` }); return; }
  if ((m = line.match(/^\s*(\d+) Passed, (\d+) Failed, (\d+) Incomplete\.$/))) {
    const p = Number(m[1]); const f = Number(m[2]); const e = Number(m[3]);
    st.set('passed', p); st.set('failed', f); st.set('errored', e); st.set('total', p + f + e);
    st.setPhase('report');
    return;
  }
  if (/^Totals:$/.test(line)) { st.setPhase('report'); return; }
  if (line.trim() && !/^\s/.test(line)) { ml.open = false; ml.last = line.trim(); }
}

const HANDLERS = {
  julia, python, pytest, cargo, rust: cargo, go, node, tsc: node, vite: node, latex, r,
  curl: download, wget: download, rsync: download,
  make: build, cmake: build, ninja: build, ctest: build, cc: build, build,
  stata, papermill: notebook, nbconvert: notebook, sql, java, matlab, shell,
};

// coarse language OR a registry `parser` key (lib/runtimes.js step.parser) → handler
const LANG_DEFAULT = {
  julia: 'julia', python: 'python', r: 'r', shell: 'shell', sql: 'sql', notebook: 'nbconvert', stata: 'stata',
  cargo: 'cargo', rust: 'rust', go: 'go', node: 'node', javascript: 'node', typescript: 'node', tsx: 'node',
  build: 'build', c: 'build', cpp: 'build', java: 'java', matlab: 'matlab',
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
