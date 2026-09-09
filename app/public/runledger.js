// runledger.js — the run ledger's PURE row/group models (no DOM; importable
// under node --test). jobs.js renders from these. Design: docs/runfeed-mockups/
// (index.html: the vocabulary table + many-runs rules; RUNLEDGER-IMPL.md).
//
//   rowModel(job)              → one run's state, glyph, label, essentials, aux, error line, clock
//   foldRuns(jobs)             → consecutive same file+command runs folded into one entry
//   groupModel(jobs, {open})   → the tally, the (collapsed) row list, the fold ladders
//
// util.js reaches for `window` at import time, so the two formatters the rows
// share with the card (fmtJobDur / fmtBytes) are carried here verbatim.

/**
 * @typedef {{ label?: string, value: string, bad?: boolean, warn?: boolean }} Essential
 * @typedef {{ state: 'ok'|'bad'|'stop'|'unv', glyph: string, kind: string, runtimeLabel: string,
 *   file: string, tooltip: string, essentials: Essential[], essText: string, aux: string | null,
 *   errorLine: { loc: string, msg: string } | null, verified: boolean, time: string | null,
 *   timeText: string, key: string }} RowModel
 */

export const GLYPH = { ok: '✓', bad: '✗', stop: '⊘', unv: '○' };

/* ── formatters (identical to util.js fmtJobDur / fmtBytes) ── */
export function fmtJobDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
export function fmtBytes(b) {
  if (!Number.isFinite(b) || b < 0) return '—';
  const K = 1024, M = K * 1024, G = M * 1024;
  if (b >= G) return `${(b / G).toFixed(1)}G`;
  if (b >= M) return `${Math.round(b / M)}M`;
  if (b >= K) return `${Math.round(b / K)}K`;
  return `${Math.round(b)}B`;
}
/** transfer sizes read decimal, with a unit: 4.2 GB · 38 MB/s */
export function fmtXfer(b) {
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${Math.round(b)} B`;
}
/** ISO → "1:34 PM" ('' when absent) */
export function clockText(t) {
  if (!t) return '';
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
/** two clocks → "1:34 – 1:41 PM" (a shared AM/PM suffix printed once) */
export function spanText(a, b) {
  const x = clockText(a), y = clockText(b);
  if (!x || !y) return x || y;
  const m = y.match(/\s?(AM|PM|am|pm)$/);
  const xs = m && x.endsWith(m[0]) ? x.slice(0, -m[0].length) : x;
  return `${xs} – ${y}`;
}

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const n = (c, k) => (c && c[k] != null && Number.isFinite(Number(c[k])) ? Number(c[k]) : 0);
const has = (c, k) => !!c && c[k] != null;
const plural = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
/** counters carry at least one real value */
export function hasCounters(c) {
  if (!c || typeof c !== 'object') return false;
  // `unverified` is the stata parser's "stdout cannot vouch" marker, not a result
  return Object.keys(c).some((k) => k !== 'unverified' && c[k] != null && !(typeof c[k] === 'object' && !Object.keys(c[k]).length));
}

/* ── runtime → kind ──
   `job.runtime` is detectRuntime()'s id on the wire (julia, python, pytest, r,
   cargo, rust, go, tsc, vite, node, latex, curl, wget, rsync, make, cmake,
   ninja, ctest, cc, stata, papermill, nbconvert, sql, shell; the parsers agent
   adds java, maven/gradle, matlab, jest…). Old records only have `lang`. The
   test flavours (cargo test, go test, Pkg.test, testthat, vitest…) are read
   from the command, or from a passed/failed tally when the command is gone. */
const RT_ALIAS = {
  julia: 'julia', python: 'python', pytest: 'pytest', r: 'r', testthat: 'testthat',
  cc: 'cc', c: 'cc', cpp: 'cc', 'c++': 'cc', gcc: 'cc', clang: 'cc',
  make: 'build', cmake: 'build', ninja: 'build',
  ctest: 'ctest', gtest: 'ctest', googletest: 'ctest', catch2: 'ctest',
  cargo: 'cargo', rust: 'cargo', rustc: 'cargo', go: 'go', golang: 'go',
  node: 'node', deno: 'node', bun: 'node', jest: 'jstest', vitest: 'jstest', mocha: 'jstest', nodetest: 'jstest', 'node:test': 'jstest',
  tsc: 'tsc', vite: 'tsc', next: 'tsc', webpack: 'tsc', esbuild: 'tsc',
  java: 'java', javac: 'java', maven: 'mvn', mvn: 'mvn', gradle: 'mvn',
  sql: 'sql', duckdb: 'sql', sqlite: 'sql', sqlite3: 'sql', psql: 'sql',
  latex: 'latex', latexmk: 'latex', tex: 'latex',
  shell: 'shell', bash: 'shell', sh: 'shell', zsh: 'shell',
  stata: 'stata', matlab: 'matlab',
  notebook: 'notebook', nbconvert: 'notebook', papermill: 'notebook', jupyter: 'notebook',
  curl: 'xfer', wget: 'xfer', rsync: 'xfer', download: 'xfer', openrsync: 'xfer',
};
const TEST_RE = {
  julia: /Pkg\.test|runtests\.jl|@testset|\btest\/runtests/i,
  r: /testthat|test_dir|test_file|test_check|test_local|devtools::test/i,
  cargo: /\bcargo\b[^|;&]*\btest\b/,
  go: /\bgo\b[^|;&]*\btest\b/,
  node: /\b(vitest|jest|mocha|ava|node:test)\b|(?:^|\s)--test\b|\bnpm\s+(?:run\s+)?test\b|\b(?:pnpm|yarn|bun|deno)\s+test\b/,
  java: /\b(mvn|mvnw|gradle|gradlew)\b/,
};
const testTally = (c) => has(c, 'passed') || has(c, 'failed');

/**
 * Classify a job: `kind` picks the vocabulary, `label` is the pill text.
 * @param {JobInfo} job
 * @returns {{ kind: string, label: string }}
 */
export function runtimeKind(job) {
  const rt = String(job.runtime || '').toLowerCase();
  const lang = String(job.lang || '').toLowerCase();
  const cmd = String(job.command || '');
  const c = job.counters || null;
  let kind = RT_ALIAS[rt] || RT_ALIAS[lang] || (rt || lang || 'shell');
  let label = rt || ({ c: 'C', cpp: 'C++', r: 'R' }[lang] || lang) || 'run';
  // a passed/failed tally only ever comes from a test parser (Test.jl's
  // summary in a plain `julia my_tests.jl`, testthat under Rscript…): it names
  // the test flavour whatever the command line looked like
  const test = (k) => (TEST_RE[k] && TEST_RE[k].test(cmd)) || testTally(c);
  switch (kind) {
    case 'julia': if (test('julia')) { kind = 'juliatest'; label = 'julia test'; } else label = 'julia'; break;
    case 'python': if (/\b(pytest|py\.test)\b/.test(cmd)) { kind = 'pytest'; label = 'pytest'; } else if (testTally(c)) { kind = 'pytest'; label = 'pytest'; } else label = 'python'; break;
    case 'pytest': label = 'pytest'; break;
    case 'r': if (test('r')) { kind = 'testthat'; label = 'testthat'; } else label = 'R'; break;
    case 'testthat': label = 'testthat'; break;
    case 'cargo': if (test('cargo')) { kind = 'cargotest'; label = 'cargo test'; } else label = /\bcargo\s+build\b/.test(cmd) ? 'cargo build' : 'cargo run'; break;
    case 'go': if (test('go')) { kind = 'gotest'; label = 'go test'; } else label = /\bgo\s+build\b/.test(cmd) ? 'go build' : 'go run'; break;
    case 'node': if (test('node')) { kind = 'jstest'; label = jsTestLabel(cmd); } else label = rt && rt !== 'node' ? rt : 'node'; break;
    case 'jstest': label = jsTestLabel(cmd, rt); break;
    case 'tsc': label = rt && RT_ALIAS[rt] === 'tsc' ? rt : (/\bvite\b/.test(cmd) ? 'vite' : /\bnext\b/.test(cmd) ? 'next' : 'tsc'); break;
    case 'java': if (test('java')) { kind = 'mvn'; label = /\bgradlew?\b/.test(cmd) ? 'gradle' : 'mvn'; } else label = 'java'; break;
    case 'mvn': label = rt === 'gradle' || /\bgradlew?\b/.test(cmd) ? 'gradle' : 'mvn'; break;
    case 'cc': label = rt && RT_ALIAS[rt] === 'cc' && rt !== 'c' && rt !== 'cpp' ? rt : (lang === 'cpp' ? 'C++' : lang === 'c' ? 'C' : 'cc'); break;
    case 'build': label = rt || 'make'; break;
    case 'ctest': label = rt || 'ctest'; break;
    case 'sql': label = 'sql'; break;
    case 'latex': label = 'latexmk'; break;
    case 'shell': label = 'shell'; break;
    case 'stata': label = 'stata'; break;
    case 'matlab': label = 'matlab'; break;
    case 'notebook': label = 'notebook'; break;
    case 'xfer': label = rt && RT_ALIAS[rt] === 'xfer' && rt !== 'download' ? rt : (cmd.match(/\b(curl|wget|rsync)\b/) || [, 'rsync'])[1]; break;
    default: break;
  }
  return { kind, label };
}
function jsTestLabel(cmd, rt = '') {
  const m = cmd.match(/\b(vitest|jest|mocha|ava)\b/);
  if (m) return m[1];
  if (/node:test|(?:^|\s)--test\b/.test(cmd)) return 'node:test';
  if (rt && rt !== 'node') return rt;
  return 'node test';
}

/* ── the exit text, printed ONCE ── */
/** `exit 137 · SIGKILL · often out of memory` / `SIGKILL · often out of memory` / `exit 1` / null */
export function exitText(job) {
  const ex = job.exit || null;
  let code = ex && ex.code != null ? num(ex.code) : num(job.exitCode);
  let sig = ex && ex.signal ? String(ex.signal) : null;
  if (!sig && code === 137) sig = 'SIGKILL';
  const oom = sig === 'SIGKILL' ? ' · often out of memory' : '';
  if (sig && code != null) return `exit ${code} · ${sig}${oom}`;
  if (sig) return `${sig}${oom}`;
  if (code != null) return `exit ${code}`;
  return null;
}
const exitCodeOf = (job) => {
  const ex = job.exit || null;
  const c = ex && ex.code != null ? num(ex.code) : num(job.exitCode);
  return c;
};
const hasExit = (job) => exitCodeOf(job) != null || !!(job.exit && job.exit.signal);

/* ── the vocabulary ── */
const ess = (value, o = {}) => ({ value: String(value), ...o });
const bad = (value) => ess(value, { bad: true });
const warn = (value) => ess(value, { warn: true });
const errs = (c) => (n(c, 'errors') ? bad(plural(n(c, 'errors'), 'error')) : ess('0 errors'));
const warns = (c) => (n(c, 'warnings') ? warn(plural(n(c, 'warnings'), 'warning')) : ess('0 warnings'));
const passed = (c) => ess(`${n(c, 'passed')} passed`);
const failed = (c) => (n(c, 'failed') ? bad(`${n(c, 'failed')} failed`) : ess('0 failed'));
const exitEss = (job, code = exitCodeOf(job)) => (code == null ? ess('exit —') : code ? bad(`exit ${code}`) : ess('exit 0'));
const errAux = (c, job) => (has(c, 'errors') || (job && job.output && job.output.fromToolResult) ? (n(c, 'errors') ? plural(n(c, 'errors'), 'error') : '0 errors') : null);
const peakOf = (job) => { const p = num(job.memPeakBytes); return p ? `▲${fmtBytes(p)}` : null; };
const linesAux = (job) => { const l = num(job.output && job.output.lines); return l ? `${l} lines` : null; };
/** a row's elapsed: one decimal under 10 s (`1.9s`, `4.2s`), whole seconds and m/s above (`23s`, `1m12s`) */
export function fmtRowDur(ms) {
  const s = Math.max(0, (Number(ms) || 0) / 1000);
  if (s < 10) return `${s.toFixed(1).replace(/\.0$/, '')}s`;
  return fmtJobDur(ms);
}
const durOf = (job) => fmtRowDur(num(job.ms) != null ? num(job.ms) : num(job.elapsedMs));

/**
 * @param {string} kind
 * @param {JobInfo} job
 * @returns {{ e: Essential[], aux: string | null, badByCounters?: boolean, exitShown?: boolean }}
 */
function vocabulary(kind, job) {
  const c = job.counters || {};
  const dur = durOf(job), peak = peakOf(job);
  const pk = (list) => list.filter(Boolean);
  // a test runtime whose summary was never parsed (a truncated result, an
  // unmatched reporter, a pre-hook record): the generic exit · elapsed row,
  // never `0 passed · 0 failed`
  const generic = () => ({ e: [exitEss(job), ess(dur)], aux: null, exitShown: true });
  switch (kind) {
    case 'julia':
    case 'python':
    case 'matlab': {
      if (kind === 'matlab') return { e: [hasExit(job) ? exitEss(job) : ess('unverified'), ess(dur)], aux: errAux(c, job) };
      return { e: pk([ess(dur), peak && ess(peak)]), aux: errAux(c, job) };
    }
    case 'juliatest':
    case 'cargotest':
    case 'ctest':
      if (!testTally(c)) return generic();
      return { e: [passed(c), failed(c)], aux: dur, badByCounters: n(c, 'failed') > 0 };
    case 'pytest':
    case 'jstest':
      if (!testTally(c) && !has(c, 'suitesFailed')) return generic();
      return { e: [passed(c), failed(c)], aux: n(c, 'skipped') ? `${n(c, 'skipped')} skipped` : dur, badByCounters: n(c, 'failed') > 0 || n(c, 'suitesFailed') > 0 };
    case 'r':
      return { e: [ess(dur), warns(c)], aux: errAux(c, job) || (peak || null) };
    case 'testthat':
      if (!testTally(c)) return generic();
      return { e: [ess(`${n(c, 'passed')} pass`), n(c, 'failed') ? bad(`${n(c, 'failed')} fail`) : ess('0 fail')], aux: n(c, 'warnings') ? `${n(c, 'warnings')} warn` : dur, badByCounters: n(c, 'failed') > 0 };
    case 'cc': {
      const ce = n(c, 'errors'), cw = n(c, 'warnings');
      const compile = ce ? bad(plural(ce, 'error')) : ess(cw ? `0 errors ${cw} warn` : '0 errors', cw ? { warn: true } : {});
      const code = has(c, 'exitStatus') ? n(c, 'exitStatus') : exitCodeOf(job);
      const run = ce ? ess('—') : code == null ? ess('—') : ess(`exit ${code} ${dur}`, code ? { bad: true } : {});
      return { e: [{ label: 'compile', ...compile }, { label: 'run', ...run }], aux: peak, badByCounters: ce > 0 || (code != null && code !== 0) };
    }
    case 'build':
      return { e: [errs(c), warns(c)], aux: dur, badByCounters: n(c, 'errors') > 0 };
    case 'cargo': {
      const ce = n(c, 'errors'), cw = n(c, 'warnings');
      const first = ce ? bad(plural(ce, 'error')) : cw ? warn(plural(cw, 'warning')) : ess('0 warnings');
      const code = has(c, 'exitStatus') ? n(c, 'exitStatus') : exitCodeOf(job);
      return { e: [first, ce ? ess('exit —') : exitEss(job, code), ess(dur)], aux: c.crate ? String(c.crate) : null, badByCounters: ce > 0 };
    }
    case 'go':
    case 'java': {
      const ce = n(c, 'errors');
      const code = has(c, 'exitStatus') ? n(c, 'exitStatus') : exitCodeOf(job);
      return { e: [errs(c), ce ? ess('exit —') : exitEss(job, code), ess(dur)], aux: null, badByCounters: ce > 0 };
    }
    case 'gotest': {
      if (!testTally(c) && !has(c, 'suites') && !has(c, 'ok')) return generic();
      const suites = has(c, 'suites') ? n(c, 'suites') : null;
      const sf = n(c, 'suitesFailed');
      const pkgs = suites != null ? ess(`${suites - sf}/${suites} pkgs ok`) : has(c, 'ok') ? ess(`${n(c, 'ok')} pkgs ok`) : passed(c);
      const cov = c.coverage != null ? `cov ${Number(c.coverage).toFixed(0)}%` : dur;
      return { e: [pkgs, failed(c)], aux: cov, badByCounters: n(c, 'failed') > 0 || sf > 0 };
    }
    case 'node':
    case 'shell':
      return { e: [exitEss(job), ess(dur)], aux: linesAux(job) };
    case 'tsc': {
      const t = c.timeS != null ? fmtRowDur(Number(c.timeS) * 1000) : dur;
      return { e: pk([errs(c), has(c, 'modules') ? ess(`${n(c, 'modules')} modules`) : null]), aux: t, badByCounters: n(c, 'errors') > 0 };
    }
    case 'mvn': {
      if (!testTally(c) && !has(c, 'total')) return generic();
      // surefire's "Errors: N" is the parser's `errored` (its Test.jl/MATLAB key); `errors` = compile diagnostics
      const errored = has(c, 'errored') ? n(c, 'errored') : n(c, 'errors');
      const total = has(c, 'total') ? n(c, 'total') : n(c, 'passed') + n(c, 'failed') + errored + n(c, 'skipped');
      return { e: [ess(`${total} run`), n(c, 'failed') ? bad(plural(n(c, 'failed'), 'failure')) : ess('0 failures')], aux: errored ? plural(errored, 'error') : dur, badByCounters: n(c, 'failed') > 0 || errored > 0 };
    }
    case 'sql':
      return { e: [ess(plural(n(c, 'statements'), 'statement')), errs(c)], aux: dur, badByCounters: n(c, 'errors') > 0 };
    case 'latex': {
      const pages = has(c, 'page') ? ess(plural(n(c, 'page'), 'page')) : ess(dur);
      const clean = n(c, 'errors') ? bad(plural(n(c, 'errors'), 'error')) : warns(c);
      return { e: [pages, clean], aux: c.pass ? `${n(c, 'pass')} pass${n(c, 'pass') === 1 ? '' : 'es'}` : null, badByCounters: n(c, 'errors') > 0 };
    }
    case 'stata': {
      if (!hasCounters(c)) return { e: [ess('unverified'), ess('log not read')], aux: dur };
      const le = c.lastError && typeof c.lastError === 'object' ? c.lastError : null;
      // stataLogSummary puts the return code in `rc` (its lastError.msg is the
      // line BEFORE `r(198);`); older records only carry it inside the message
      const rc = c.rc != null && Number.isFinite(Number(c.rc)) ? [`r(${Number(c.rc)})`] : le && le.msg ? String(le.msg).match(/r\(\d+\)/) : null;
      if (n(c, 'errors')) return { e: [bad(rc ? rc[0] : plural(n(c, 'errors'), 'error')), ess(dur)], aux: null, badByCounters: true };
      return { e: [ess('no r() errors'), ess(dur)], aux: null };
    }
    case 'notebook': {
      const total = has(c, 'total') ? n(c, 'total') : job.progress && num(job.progress.total) ? num(job.progress.total) : null;
      const cells = has(c, 'cells') ? n(c, 'cells') : job.progress && num(job.progress.iter) != null ? num(job.progress.iter) : null;
      const cellTxt = cells == null ? dur : total ? `${cells}/${total} cells` : `${cells} cells`;
      return { e: [ess(cellTxt), errs(c)], aux: cells == null ? null : dur, badByCounters: n(c, 'errors') > 0 };
    }
    case 'xfer': {
      const bytes = has(c, 'bytes') ? fmtXfer(n(c, 'bytes')) : null;
      const rate = has(c, 'rateBps') ? `${fmtXfer(n(c, 'rateBps'))}/s` : null;
      if (!bytes && !rate) return { e: [exitEss(job), ess(dur)], aux: null };
      return { e: pk([bytes && ess(bytes), rate && ess(rate)]), aux: dur, badByCounters: n(c, 'errors') > 0 };
    }
    default:
      return { e: pk([ess(dur), peak && ess(peak)]), aux: errAux(c, job) };
  }
}
/** kinds whose vocabulary already prints the exit; the others get `exit N` prepended on failure */
const EXIT_IN_VOCAB = new Set(['cc', 'cargo', 'go', 'java', 'node', 'shell', 'matlab']);

/** the located error line of a bad row: `file:line[:col]` · message */
export function errorLineOf(job) {
  const c = job.counters || {};
  const le = c.lastError && typeof c.lastError === 'object' ? c.lastError : null;
  if (!le || (!le.file && !le.msg)) return null;
  const loc = le.file ? `${le.file}${le.line != null ? `:${le.line}${le.col != null ? `:${le.col}` : ''}` : ''}` : '';
  return { loc, msg: String(le.msg || '') };
}

/** a file/command → the row's name and tooltip (jobs.js passes jobTitle's) */
function fallbackTitle(job) {
  const file = typeof job.file === 'string' ? job.file : '';
  const raw = (typeof job.displayTitle === 'string' && job.displayTitle.trim()) || file;
  let name = raw ? raw.split('/').filter(Boolean).pop() || raw : (job.command || 'program');
  if (/\/$/.test(raw) && !name.endsWith('/')) name += '/';
  return { name, tooltip: job.command || raw || name };
}

/** the clock a row prints: the wire's endedAt, else the client fade stamp, else start + ms */
export function endedAtOf(job) {
  if (job.endedAt) return String(job.endedAt);
  if (job._endedAt) return String(job._endedAt);
  const ms = num(job.ms);
  const t0 = job.startedAt ? Date.parse(String(job.startedAt)) : NaN;
  if (ms != null && Number.isFinite(t0)) return new Date(t0 + ms).toISOString();
  if (Number.isFinite(t0)) return new Date(t0).toISOString();
  return job.createdAt ? String(job.createdAt) : null;
}

/**
 * One terminal run → its row.
 * @param {JobInfo} job
 * @param {{ name?: string, tooltip?: string }} [title]
 * @returns {RowModel}
 */
export function rowModel(job, title = {}) {
  const { kind, label } = runtimeKind(job);
  const t = title.name ? { name: title.name, tooltip: title.tooltip || title.name } : fallbackTitle(job);
  const st = job.state;
  const c = job.counters || null;
  const counters = hasCounters(c);
  const time = endedAtOf(job);
  const base = { kind, runtimeLabel: label + (job.detached ? ' · detached' : job.bg ? ' · background' : ''), file: t.name, tooltip: t.tooltip, time, timeText: clockText(time), key: String(job.key || '') };
  // ⊘ stopped: the user's (or the turn's) verdict, never unverified
  if (st === 'stopped') {
    const byUser = !job.exit || job.exit.byUser !== false;
    const frac = job.progress && Number.isFinite(job.progress.frac) ? Math.min(1, Math.max(0, job.progress.frac)) : null;
    const where = frac != null ? `at ${Math.round(frac * 100)}%` : `at ${durOf(job)}`;
    const e = [ess(`stopped${byUser ? ' by you' : ''} ${where}`)];
    return { ...base, state: 'stop', glyph: GLYPH.stop, essentials: e, essText: e.map((x) => x.value).join(' · '), aux: peakOf(job), errorLine: null, verified: true };
  }
  // ○ unverified: the dashboard could not read a result
  const truncated = !!(job.output && job.output.truncated);
  const unverified = job.verified === false || truncated || (!hasExit(job) && !counters) || (kind === 'stata' && !counters) || (kind === 'matlab' && !hasExit(job));
  const v = vocabulary(kind, job);
  let e = v.e;
  const isBad = st === 'error' || !!v.badByCounters;
  const sig = job.exit && job.exit.signal;
  if (unverified) {
    const state = /** @type {'unv'} */ ('unv');
    const e2 = kind === 'stata' || kind === 'matlab' ? e : [ess(durOf(job)), peakOf(job) && ess(peakOf(job))].filter(Boolean);
    // a >30 KB result reached the dashboard as a 2 KB preview: say so
    const aux = truncated ? 'output truncated' : null;
    return { ...base, state, glyph: GLYPH.unv, essentials: e2, essText: e2.map((x) => x.value).join(' · '), aux, errorLine: isBad ? errorLineOf(job) : null, verified: false };
  }
  let aux = v.aux;
  if (isBad) {
    const code = exitCodeOf(job);
    if (sig || code === 137) {
      // `exit 137 · SIGKILL · often out of memory` — printed once, as the only
      // essential; elapsed and peak move to the aux, and no error line repeats it
      e = [bad(exitText(job))];
      aux = [durOf(job), peakOf(job)].filter(Boolean).join(' · ') || null;
    } else if (code != null && code !== 0 && !EXIT_IN_VOCAB.has(kind) && !v.exitShown && !v.badByCounters) {
      e = [bad(`exit ${code}`), ...e];
    }
  }
  const state = isBad ? 'bad' : 'ok';
  return { ...base, state, glyph: GLYPH[state], essentials: e, essText: e.map((x) => (x.label ? `${x.label} ${x.value}` : x.value)).join(' · '), aux, errorLine: isBad ? errorLineOf(job) : null, verified: true };
}

/* ── folds and groups ── */

const foldKeyOf = (job) => `${job.file || ''}|${job.command || ''}`;

/**
 * Consecutive runs of the same file+command fold to one entry.
 * @param {JobInfo[]} jobs in createdAt order
 * @returns {{ key: string, jobs: JobInfo[] }[]}
 */
export function foldRuns(jobs) {
  /** @type {{ key: string, jobs: JobInfo[] }[]} */
  const out = [];
  for (const j of jobs) {
    const key = foldKeyOf(j);
    const last = out[out.length - 1];
    if (last && last.key === key && j.state !== 'running') last.jobs.push(j);
    else out.push({ key, jobs: [j] });
  }
  return out;
}

/** the header tally over the runs (not the folded entries) */
export function tallyOf(jobs, models) {
  const t = { n: jobs.length, ok: 0, bad: 0, stop: 0, unv: 0, spanMs: 0 };
  for (const m of models) t[m.state] += 1;
  let t0 = Infinity, t1 = -Infinity, sum = 0;
  for (const j of jobs) {
    const s = j.startedAt ? Date.parse(String(j.startedAt)) : (j.createdAt ? Date.parse(String(j.createdAt)) : NaN);
    const e = Date.parse(String(endedAtOf(j) || ''));
    if (Number.isFinite(s)) t0 = Math.min(t0, s);
    if (Number.isFinite(e)) t1 = Math.max(t1, e);
    sum += num(j.ms) || 0;
  }
  t.spanMs = Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? t1 - t0 : sum;
  return t;
}

export const MAX_OPEN = 5; // ≤ 5 entries (after folding): every row shown

/**
 * The group: tally, the (collapsed) row list, folds with their ladders.
 * Collapsed (6+ entries, not open): every bad/stop/unv entry, the last entry,
 * and one count line per hidden stretch. A fold is one entry.
 * @param {JobInfo[]} jobs terminal runs of one turn, in createdAt order
 * @param {{ open?: boolean, folds?: Set<string>, title?: (job: JobInfo) => { name: string, tooltip: string } }} [opts]
 */
export function groupModel(jobs, { open = false, folds = new Set(), title } = {}) {
  const modelOf = (j) => rowModel(j, title ? title(j) : {});
  const models = new Map(jobs.map((j) => [j, modelOf(j)]));
  const entries = foldRuns(jobs);
  const many = entries.length > MAX_OPEN;
  const collapsed = many && !open;
  const tally = tallyOf(jobs, [...models.values()]);
  /** @type {any[]} */
  const rows = [];
  /** @type {{ key: string, jobs: JobInfo[] }[]} */
  let hidden = [];
  let stretch = 0;
  const flush = () => {
    if (!hidden.length) return;
    const runs = hidden.flatMap((h) => h.jobs);
    const from = endedAtOf(runs[0]), to = endedAtOf(runs[runs.length - 1]);
    const span = runs.length > 1 ? spanText(from, to) : clockText(to);
    rows.push({ type: 'more', key: `m:${stretch++}`, n: runs.length, from, to, keys: runs.map((r) => r.key),
      text: `… ${runs.length} more ✓${span ? ` · ${span}` : ''}` });
    hidden = [];
  };
  entries.forEach((en, i) => {
    const last = en.jobs[en.jobs.length - 1];
    const model = models.get(last);
    // a fold with a ✗/⊘/○ member is kept even when its last run passed: the
    // design keeps "every failed or stopped row", and the ladder shows the mix
    const anyBad = en.jobs.some((j) => models.get(j).state !== 'ok');
    const keep = !collapsed || i === entries.length - 1 || anyBad;
    if (!keep) { hidden.push(en); return; }
    flush();
    if (en.jobs.length === 1) { rows.push({ type: 'row', key: `r:${last.key}`, job: last, model }); return; }
    const isOpen = folds.has(en.key);
    rows.push({ type: 'fold', key: `f:${en.key}`, foldKey: en.key, n: en.jobs.length, open: isOpen, job: last, model,
      ladder: en.jobs.map((j) => { const m = models.get(j); return { state: m.state, glyph: m.glyph }; }),
      runs: en.jobs.map((j) => ({ type: 'row', key: `r:${j.key}`, job: j, model: models.get(j) })) });
  });
  flush();
  return { tally, rows, collapsed, many, header: jobs.length > 1, entries: entries.length };
}

/** the header's text: `14 runs · 11 ✓ · 2 ✗ · 1 ⊘ · 4m12s` (zero categories omitted) */
export function tallyParts(t) {
  const parts = [{ k: 'n', text: `${t.n} run${t.n === 1 ? '' : 's'}` }];
  if (t.ok) parts.push({ k: 'ok', text: `${t.ok} ✓` });
  if (t.bad) parts.push({ k: 'bad', text: `${t.bad} ✗` });
  if (t.stop) parts.push({ k: 'stop', text: `${t.stop} ⊘` });
  if (t.unv) parts.push({ k: 'unv', text: `${t.unv} ○` });
  if (t.spanMs > 0) parts.push({ k: 'span', text: fmtJobDur(t.spanMs) });
  return parts;
}
