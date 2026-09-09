// The run ledger's pure models (public/runledger.js): one case per runtime in
// the vocabulary table (docs/runfeed-mockups/index.html, RUNLEDGER-IMPL.md),
// the ○ unverified states, exit 137 printed once, and the fold / collapse
// rules for 1 / 4 / 6 / 14 / 60 runs and a six-run fold. No DOM, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowModel, foldRuns, groupModel, runtimeKind, exitText, spanText, clockText, fmtRowDur, fmtXfer, tallyParts, hasCounters,
} from '../public/runledger.js';

const OK = { code: 0, signal: null, byUser: false };
const FAIL = { code: 1, signal: null, byUser: false };
const T0 = Date.parse('2026-09-09T13:31:00.000Z');
const iso = (min, sec = 0) => new Date(T0 + min * 60000 + sec * 1000).toISOString();
/** a terminal session job on the new wire */
const job = (over = {}) => ({
  key: `sess:alpha/t1/${over.file || 'x'}`, source: 'session', state: 'done', exit: OK, verified: true,
  createdAt: iso(0), startedAt: iso(0), ms: 23000, endedAt: iso(0, 23), counters: {}, output: { lines: 0, owned: false, fromToolResult: true },
  ...over,
});
/** the row as one line: essentials · aux ‖ error line */
const line = (m) => [m.essText, m.aux].filter(Boolean).join(' · ') + (m.errorLine ? ` ‖ ${m.errorLine.loc} · ${m.errorLine.msg}` : '');

/* ── the vocabulary, one case per runtime ── */
const CASES = [
  ['julia script', job({ runtime: 'julia', file: 'build_hybrid_one_type.jl', memPeakBytes: 548 * 1024 ** 2, counters: { errors: 0 } }),
    { label: 'julia', state: 'ok', ess: '23s · ▲548M', aux: '0 errors' }],
  ['julia tests (Pkg.test)', job({ runtime: 'julia', command: "julia --project -e 'using Pkg; Pkg.test()'", file: 'runtests.jl', state: 'error', exit: FAIL, ms: 214000, counters: { passed: 142, failed: 2, lastError: { file: 'test/solver.jl', line: 88, msg: 'Test Failed: norm(r) < 1e-6' } } }),
    { label: 'julia test', state: 'bad', ess: '142 passed · 2 failed', aux: '3m34s', err: 'test/solver.jl:88 · Test Failed: norm(r) < 1e-6' }],
  ['python script', job({ runtime: 'python', file: 'fit_mixture.py', ms: 72000, memPeakBytes: 2.1 * 1024 ** 3, counters: { errors: 0 } }),
    { label: 'python', state: 'ok', ess: '1m12s · ▲2.1G', aux: '0 errors' }],
  ['pytest', job({ runtime: 'pytest', command: 'python -m pytest tests/ -q', file: 'tests/', state: 'error', exit: FAIL, ms: 41000, counters: { passed: 88, failed: 1, skipped: 2, lastError: { file: 'tests/test_income.py', line: 41, msg: 'assert abs(mu - 8.02) < 1e-3' } } }),
    { label: 'pytest', state: 'bad', ess: '88 passed · 1 failed', aux: '2 skipped', err: 'tests/test_income.py:41 · assert abs(mu - 8.02) < 1e-3' }],
  ['R script', job({ runtime: 'r', file: 'clean_panel.R', ms: 41000, counters: { warnings: 3, errors: 0 } }),
    { label: 'R', state: 'ok', ess: '41s · 3 warnings', aux: '0 errors' }],
  ['testthat', job({ runtime: 'r', command: "Rscript -e 'testthat::test_dir(\"tests/testthat\")'", file: 'tests/testthat/', ms: 19000, counters: { passed: 212, failed: 0, warnings: 4 } }),
    { label: 'testthat', state: 'ok', ess: '212 pass · 0 fail', aux: '4 warn' }],
  ['cc compile + run', job({ runtime: 'cc', command: 'cc -O2 -Wall solver.c -o solver && ./solver', file: 'solver.c', ms: 1900, counters: { errors: 0, warnings: 2 } }),
    { label: 'cc', state: 'ok', ess: 'compile 0 errors 2 warn · run exit 0 1.9s', aux: null }],
  ['cc failed compile', job({ runtime: 'cc', command: 'cc solver.c -o solver && ./solver', file: 'solver.c', state: 'error', exit: FAIL, ms: 1200, counters: { errors: 1, warnings: 0, lastError: { file: 'solver.c', line: 212, col: 14, msg: "use of undeclared identifier 'rho'" } } }),
    { label: 'cc', state: 'bad', ess: 'compile 1 error · run —', aux: null, err: "solver.c:212:14 · use of undeclared identifier 'rho'" }],
  ['cmake / make', job({ runtime: 'cmake', command: 'cmake --build build -j8', file: 'build/', ms: 64000, counters: { errors: 0, warnings: 3 } }),
    { label: 'cmake', state: 'ok', ess: '0 errors · 3 warnings', aux: '1m04s' }],
  ['ctest / gtest / catch2', job({ runtime: 'ctest', file: 'build/', ms: 12000, counters: { passed: 36, failed: 0 } }),
    { label: 'ctest', state: 'ok', ess: '36 passed · 0 failed', aux: '12s' }],
  ['cargo run', job({ runtime: 'cargo', command: 'cargo run --release -- --steps 1000', file: 'hybrid-sim', ms: 4200, counters: { errors: 0, warnings: 1, crate: 'hybrid-sim' } }),
    { label: 'cargo run', state: 'ok', ess: '1 warning · exit 0 · 4.2s', aux: 'hybrid-sim' }],
  ['cargo test', job({ runtime: 'cargo', command: 'cargo test', file: 'hybrid-sim', ms: 9800, counters: { passed: 61, failed: 0 } }),
    { label: 'cargo test', state: 'ok', ess: '61 passed · 0 failed', aux: '9.8s' }],
  ['go run', job({ runtime: 'go', command: 'go run ./cmd/sim', file: 'cmd/sim', ms: 2100, counters: { errors: 0 } }),
    { label: 'go run', state: 'ok', ess: '0 errors · exit 0 · 2.1s', aux: null }],
  ['go test', job({ runtime: 'go', command: 'go test ./... -cover', file: './...', state: 'error', exit: FAIL, ms: 5400, counters: { suites: 12, suitesFailed: 1, failed: 2, coverage: 81.3, lastError: { file: 'sim/solver_test.go', line: 88, msg: 'want 0.5, got 0.4999' } } }),
    { label: 'go test', state: 'bad', ess: '11/12 pkgs ok · 2 failed', aux: 'cov 81%', err: 'sim/solver_test.go:88 · want 0.5, got 0.4999' }],
  ['node script', job({ runtime: 'node', file: 'scripts/build-index.mjs', ms: 3400, output: { lines: 212, owned: false, fromToolResult: true } }),
    { label: 'node', state: 'ok', ess: 'exit 0 · 3.4s', aux: '212 lines' }],
  ['vitest', job({ runtime: 'node', command: 'npx vitest run', file: 'src/', ms: 6100, counters: { passed: 240, failed: 0, skipped: 3 } }),
    { label: 'vitest', state: 'ok', ess: '240 passed · 0 failed', aux: '3 skipped' }],
  ['jest via npm test', job({ runtime: 'node', command: 'npm test', file: 'src/', ms: 6100, counters: { passed: 240, failed: 0 } }),
    { label: 'node test', state: 'ok', ess: '240 passed · 0 failed', aux: '6.1s' }],
  ['node --test', job({ runtime: 'node', command: 'node --test test/*.test.mjs', file: 'test/', ms: 6100, counters: { passed: 12, failed: 1 }, state: 'error', exit: FAIL }),
    { label: 'node:test', state: 'bad', ess: '12 passed · 1 failed', aux: '6.1s' }],
  ['vite build', job({ runtime: 'vite', command: 'npx vite build', file: 'vite build', ms: 4800, counters: { errors: 0, modules: 312, timeS: 4.6 } }),
    { label: 'vite', state: 'ok', ess: '0 errors · 312 modules', aux: '4.6s' }],
  ['tsc', job({ runtime: 'tsc', command: 'npx tsc --noEmit', file: 'tsc --noEmit', state: 'error', exit: { code: 2, signal: null, byUser: false }, ms: 7200, counters: { errors: 3, lastError: { file: 'src/api/jobs.ts', line: 88, col: 14, msg: "TS2339: Property 'ms' does not exist on type 'Job'" } } }),
    { label: 'tsc', state: 'bad', ess: '3 errors', aux: '7.2s', err: "src/api/jobs.ts:88:14 · TS2339: Property 'ms' does not exist on type 'Job'" }],
  ['java run', job({ runtime: 'java', command: 'javac Main.java && java Main', file: 'Main.java', ms: 2100, counters: { errors: 0 } }),
    { label: 'java', state: 'ok', ess: '0 errors · exit 0 · 2.1s', aux: null }],
  ['maven test', job({ runtime: 'maven', command: 'mvn -q test', file: 'mvn test', state: 'error', exit: FAIL, ms: 48000, counters: { total: 184, failed: 2, errors: 1 } }),
    { label: 'mvn', state: 'bad', ess: '184 run · 2 failures', aux: '1 error' }],
  ['gradle test', job({ runtime: 'gradle', command: './gradlew test', file: 'gradle test', ms: 48000, counters: { total: 184, failed: 0, errors: 0 } }),
    { label: 'gradle', state: 'ok', ess: '184 run · 0 failures', aux: '48s' }],
  ['sql', job({ runtime: 'sql', command: 'duckdb panel.duckdb < build_panel.sql', file: 'build_panel.sql', ms: 8200, counters: { statements: 14, errors: 0 } }),
    { label: 'sql', state: 'ok', ess: '14 statements · 0 errors', aux: '8.2s' }],
  ['latexmk', job({ runtime: 'latex', command: 'latexmk -pdf main.tex', file: 'main.tex', ms: 31000, counters: { page: 24, errors: 0, warnings: 7, pass: 3 } }),
    { label: 'latexmk', state: 'ok', ess: '24 pages · 7 warnings', aux: '3 passes' }],
  ['shell', job({ runtime: 'shell', file: 'run_all.sh', ms: 2100, output: { lines: 40, owned: false, fromToolResult: true } }),
    { label: 'shell', state: 'ok', ess: 'exit 0 · 2.1s', aux: '40 lines' }],
  ['stata r(198) from the log', job({ runtime: 'stata', command: 'stata-mp -b do analysis.do', file: 'analysis.do', ms: 131000, counters: { errors: 1, lastError: { file: 'analysis.do', line: 142, msg: 'r(198) invalid syntax' } } }),
    { label: 'stata', state: 'bad', ess: 'r(198) · 2m11s', aux: null, err: 'analysis.do:142 · r(198) invalid syntax' }],
  ['stata log read, clean', job({ runtime: 'stata', file: 'tables.do', ms: 88000, counters: { errors: 0 } }),
    { label: 'stata', state: 'ok', ess: 'no r() errors · 1m28s', aux: null }],
  ['matlab batch', job({ runtime: 'matlab', command: 'matlab -batch "batch_sim"', file: 'batch_sim.m', ms: 181000, counters: { errors: 0 } }),
    { label: 'matlab', state: 'ok', ess: 'exit 0 · 3m01s', aux: '0 errors' }],
  ['notebook', job({ runtime: 'nbconvert', command: 'jupyter nbconvert --execute explore.ipynb', file: 'explore.ipynb', state: 'error', exit: FAIL, ms: 52000, counters: { cells: 18, total: 31, errors: 1, lastError: { file: 'cell 19', msg: "KeyError: 'group_id'" } } }),
    { label: 'notebook', state: 'bad', ess: '18/31 cells · 1 error', aux: '52s', err: "cell 19 · KeyError: 'group_id'" }],
  ['rsync', job({ runtime: 'rsync', command: 'rsync -avz --progress data/ hpc:proj/data/', file: 'data/', ms: 118000, counters: { bytes: 4.2e9, rateBps: 38e6 } }),
    { label: 'rsync', state: 'ok', ess: '4.2 GB · 38 MB/s', aux: '1m58s' }],
  ['curl', job({ runtime: 'curl', command: 'curl -O https://x/y.bin', file: 'y.bin', ms: 3000, counters: { bytes: 512e6, rateBps: 171e6 } }),
    { label: 'curl', state: 'ok', ess: '512 MB · 171 MB/s', aux: '3s' }],
  ['⊘ stopped by you', job({ runtime: 'python', file: 'train.py', state: 'stopped', exit: { code: null, signal: 'SIGTERM', byUser: true }, ms: 250000, progress: { frac: 0.61 }, memPeakBytes: 1.2 * 1024 ** 3 }),
    { label: 'python', state: 'stop', ess: 'stopped by you at 61%', aux: '▲1.2G' }],
  ['⊘ stopped with the turn (no fraction)', job({ runtime: 'julia', file: 'sweep.jl', state: 'stopped', exit: { code: null, signal: 'SIGTERM', byUser: false }, ms: 272000 }),
    { label: 'julia', state: 'stop', ess: 'stopped at 4m32s', aux: null }],
  ['python failed, exit only', job({ runtime: 'python', file: 'x.py', state: 'error', exit: FAIL, ms: 3000, memPeakBytes: 100 * 1024 ** 2, counters: { errors: 1 } }),
    { label: 'python', state: 'bad', ess: 'exit 1 · 3s · ▲100M', aux: '1 error' }],
  ['old record: lang only, no result text parsed', job({ lang: 'r', file: 'old.R', ms: 41000, counters: { warnings: 0 }, output: { owned: false } }),
    { label: 'R', state: 'ok', ess: '41s · 0 warnings', aux: null }],
];
for (const [name, j, want] of CASES) {
  test(`row · ${name}`, () => {
    const m = rowModel(j);
    assert.equal(m.runtimeLabel, want.label, `label of ${name}`);
    assert.equal(m.state, want.state, `state of ${name}: ${line(m)}`);
    assert.equal(m.glyph, { ok: '✓', bad: '✗', stop: '⊘', unv: '○' }[want.state]);
    assert.equal(m.essText, want.ess, `essentials of ${name}`);
    assert.equal(m.aux, want.aux, `aux of ${name}`);
    if (want.err) assert.equal(`${m.errorLine.loc} · ${m.errorLine.msg}`, want.err);
    else assert.equal(m.errorLine, null, `no error line for ${name}`);
    assert.equal(m.verified, true);
    assert.match(m.timeText, /^\d{1,2}:\d\d/);
  });
}

/* ── ○ unverified ── */
test('○ · a row with no counters and no exit (pre-hook data) shows elapsed · peak, unverified', () => {
  const m = rowModel(job({ lang: 'julia', file: 'x.jl', exit: null, exitCode: null, counters: {}, memPeakBytes: 548 * 1024 ** 2, verified: undefined, output: { owned: false } }));
  assert.equal(m.state, 'unv');
  assert.equal(m.glyph, '○');
  assert.equal(m.essText, '23s · ▲548M');
  assert.equal(m.aux, null);
  assert.equal(m.verified, false);
});
test('○ · verified:false on the wire wins even with an exit code', () => {
  const m = rowModel(job({ runtime: 'python', file: 'x.py', verified: false, counters: {} }));
  assert.equal(m.state, 'unv');
  assert.equal(m.essText, '23s');
});
test('○ · stata without its log: unverified · log not read (exit 0 is never a ✓)', () => {
  const m = rowModel(job({ runtime: 'stata', command: 'stata-mp -b do robustness.do', file: 'robustness.do', ms: 62000, counters: {}, verified: false }));
  assert.equal(m.state, 'unv');
  assert.equal(m.essText, 'unverified · log not read');
  assert.equal(m.errorLine, null);
});
test('○ · matlab with no exit: unverified · elapsed', () => {
  const m = rowModel(job({ runtime: 'matlab', file: 'batch_sim.m', ms: 181000, exit: null, exitCode: null, counters: {}, verified: false }));
  assert.equal(m.state, 'unv');
  assert.equal(m.essText, 'unverified · 3m01s');
});
test('○ · a failed run with no result text still carries its error line but no verdict', () => {
  const m = rowModel(job({ runtime: 'python', file: 'x.py', state: 'error', exit: null, exitCode: null, verified: false, counters: { lastError: { file: 'x.py', line: 3, msg: 'boom' } } }));
  assert.equal(m.state, 'unv');
  assert.equal(m.errorLine.loc, 'x.py:3');
});
test('a stopped run is never unverified: the user stopped it', () => {
  const m = rowModel(job({ runtime: 'python', file: 'x.py', state: 'stopped', exit: null, counters: {}, verified: false, progress: { frac: 0.4 } }));
  assert.equal(m.state, 'stop');
  assert.equal(m.essText, 'stopped by you at 40%');
});

/* ── exit 137, once ── */
test('exit 137 · SIGKILL · often out of memory — printed once, never twice', () => {
  const m = rowModel(job({ runtime: 'python', command: 'python fit_mixture.py --components 12', file: 'fit_mixture.py', state: 'error', exit: { code: 137, signal: 'SIGKILL', byUser: false }, ms: 388000, memPeakBytes: 14.9 * 1024 ** 3, counters: { errors: 0 } }));
  assert.equal(m.state, 'bad');
  assert.equal(m.essText, 'exit 137 · SIGKILL · often out of memory');
  assert.equal(m.aux, '6m28s · ▲14.9G');
  assert.equal(m.errorLine, null, 'no error line repeats the signal');
  const all = line(m);
  assert.equal((all.match(/137/g) || []).length, 1, all);
  assert.equal((all.match(/SIGKILL/g) || []).length, 1, all);
  assert.equal((all.match(/out of memory/g) || []).length, 1, all);
});
test('a SIGKILL without a code never invents 137; a bare 137 names SIGKILL', () => {
  const a = rowModel(job({ runtime: 'python', file: 'train.py', state: 'error', exit: { code: null, signal: 'SIGKILL', byUser: false }, ms: 724000, memPeakBytes: 14.2 * 1024 ** 3 }));
  assert.equal(a.essText, 'SIGKILL · often out of memory');
  assert.equal(a.aux, '12m04s · ▲14.2G');
  assert.equal(exitText({ exit: { code: 137, signal: null } }), 'exit 137 · SIGKILL · often out of memory');
  assert.equal(exitText({ exit: { code: 1, signal: null } }), 'exit 1');
  assert.equal(exitText({ exit: { code: null, signal: 'SIGTERM' } }), 'SIGTERM');
  assert.equal(exitText({}), null);
});
test('a shell/node row keeps its own exit even when killed: the signal replaces it, once', () => {
  const m = rowModel(job({ runtime: 'shell', file: 'run.sh', state: 'error', exit: { code: 137, signal: 'SIGKILL', byUser: false }, ms: 5000, output: { lines: 12, owned: false } }));
  assert.equal(m.essText, 'exit 137 · SIGKILL · often out of memory');
  assert.equal((line(m).match(/exit/g) || []).length, 1);
});

/* ── detection ── */
test('runtimeKind: runtime on the wire, lang fallback, test flavours from the command or the tally', () => {
  assert.deepEqual(runtimeKind({ runtime: 'cargo', command: 'cargo build --release' }), { kind: 'cargo', label: 'cargo build' });
  assert.deepEqual(runtimeKind({ runtime: 'go', command: 'go build ./...' }), { kind: 'go', label: 'go build' });
  assert.deepEqual(runtimeKind({ runtime: 'julia', command: 'julia --project test/runtests.jl' }), { kind: 'juliatest', label: 'julia test' });
  assert.deepEqual(runtimeKind({ runtime: 'python', command: 'python -m pytest -q' }), { kind: 'pytest', label: 'pytest' });
  assert.deepEqual(runtimeKind({ runtime: 'node', command: 'npx jest' }), { kind: 'jstest', label: 'jest' });
  assert.deepEqual(runtimeKind({ runtime: 'node', command: 'npx mocha' }), { kind: 'jstest', label: 'mocha' });
  assert.deepEqual(runtimeKind({ runtime: 'node', command: 'npx next build' }), { kind: 'node', label: 'node' });
  assert.deepEqual(runtimeKind({ runtime: 'next', command: 'npx next build' }), { kind: 'tsc', label: 'next' });
  assert.deepEqual(runtimeKind({ runtime: 'wget', command: 'wget https://x' }), { kind: 'xfer', label: 'wget' });
  assert.deepEqual(runtimeKind({ runtime: 'gtest', command: './build/solver_test' }), { kind: 'ctest', label: 'gtest' });
  assert.deepEqual(runtimeKind({ runtime: 'papermill', command: 'papermill a.ipynb b.ipynb' }), { kind: 'notebook', label: 'notebook' });
  assert.deepEqual(runtimeKind({ lang: 'cpp' }), { kind: 'cc', label: 'C++' });
  assert.deepEqual(runtimeKind({ lang: 'c' }), { kind: 'cc', label: 'C' });
  assert.deepEqual(runtimeKind({ lang: 'rust', counters: { passed: 3, failed: 0 } }), { kind: 'cargotest', label: 'cargo test' });
  assert.deepEqual(runtimeKind({ lang: 'notebook' }), { kind: 'notebook', label: 'notebook' });
  assert.deepEqual(runtimeKind({}), { kind: 'shell', label: 'shell' });
});

/* ── formatters ── */
test('formatters: row durations, transfer sizes, clocks and spans', () => {
  assert.equal(fmtRowDur(1900), '1.9s');
  assert.equal(fmtRowDur(2000), '2s');
  assert.equal(fmtRowDur(23000), '23s');
  assert.equal(fmtRowDur(72000), '1m12s');
  assert.equal(fmtRowDur(3723000), '1h02m');
  assert.equal(fmtXfer(4.2e9), '4.2 GB');
  assert.equal(fmtXfer(38e6), '38 MB');
  assert.equal(fmtXfer(900), '900 B');
  assert.match(clockText(iso(0)), /^\d{1,2}:\d\d/);
  assert.equal(clockText(null), '');
  const s = spanText(iso(3), iso(10));
  assert.match(s, /^\d{1,2}:\d\d(?: [AP]M)? – \d{1,2}:\d\d(?: [AP]M)?$/);
  assert.ok(!/[AP]M.*[AP]M/.test(s), `a shared AM/PM suffix prints once: ${s}`);
  assert.ok(hasCounters({ passed: 1 }));
  assert.ok(!hasCounters({}));
  assert.ok(!hasCounters({ lastError: {} }));
  assert.ok(!hasCounters(null));
  assert.ok(!hasCounters({ unverified: 1 }), 'the stata parser\'s "stdout cannot vouch" marker is not a counter');
});

/* ── the parsers' real keys (verifier, live captures 2026-09-09) ── */
test('a Test.jl tally in a plain `julia my_tests.jl` is a test row, not `exit 1 · 0 errors`', () => {
  // captured: `julia test_solver.jl` with one @testset failure → passed 2 · failed 1 (+ errored/broken/total)
  const m = rowModel(job({ runtime: 'julia', command: 'julia test_solver.jl', file: 'test_solver.jl', state: 'error', exit: FAIL, ms: 1574,
    counters: { passed: 2, failed: 1, errored: 0, broken: 0, total: 3, lastError: { file: 'test_solver.jl', line: 5, col: null, msg: 'Solver: 2 * 2 == 5' } } }));
  assert.equal(m.runtimeLabel, 'julia test');
  assert.equal(m.state, 'bad');
  assert.equal(m.essText, '2 passed · 1 failed');
  assert.deepEqual(m.errorLine, { loc: 'test_solver.jl:5', msg: 'Solver: 2 * 2 == 5' });
});
test('a test runtime with no tally falls back to exit · elapsed — never `0 passed · 0 failed` (review B6)', () => {
  for (const [rt, cmd] of [['pytest', 'python -m pytest -q tests/'], ['cargo', 'cargo test'], ['node', 'npx vitest run'], ['julia', 'julia test/runtests.jl'], ['go', 'go test ./...'], ['r', "Rscript -e 'testthat::test_dir(\"tests\")'"], ['java', 'mvn -q test']]) {
    const m = rowModel(job({ runtime: rt, command: cmd, file: 'tests/', ms: 41000, exit: OK, counters: {} }));
    assert.equal(m.state, 'ok', `${rt}: exit 0 still verifies`);
    assert.equal(m.essText, 'exit 0 · 41s', `${rt}: generic row`);
    assert.equal(m.aux, null);
    const f = rowModel(job({ runtime: rt, command: cmd, file: 'tests/', ms: 41000, state: 'error', exit: FAIL, counters: {} }));
    assert.equal(f.essText, 'exit 1 · 41s', `${rt}: a failed run without a tally`);
  }
  // a stale mvn record with only `total` keeps the run count
  assert.equal(rowModel(job({ runtime: 'java', command: 'mvn test', file: 'mvn test', ms: 1000, exit: OK, counters: { total: 12 } })).essText, '12 run · 0 failures');
});
test('a persisted (>30 KB) result is a 2 KB preview: ○ with `output truncated` as the aux, whatever the exit says (review B5)', () => {
  const m = rowModel(job({ runtime: 'pytest', command: 'pytest tests/', file: 'tests/', ms: 41000, exit: OK, verified: false, counters: {}, output: { lines: 40, owned: false, fromToolResult: true, truncated: true } }));
  assert.equal(m.state, 'unv');
  assert.equal(m.glyph, '○');
  assert.equal(m.essText, '41s');
  assert.equal(m.aux, 'output truncated');
  // the wire flag alone (an older client reading a newer record) is enough
  const w = rowModel(job({ runtime: 'python', file: 'x.py', ms: 5000, exit: OK, counters: {}, output: { lines: 40, owned: false, fromToolResult: true, truncated: true } }));
  assert.equal(w.state, 'unv');
  assert.equal(w.aux, 'output truncated');
});
test('collapse keeps a fold whose LAST run passed but which holds a ✗ member (review R3)', () => {
  const rs = runs(8);
  // runs 3-5 are one file: ✗ ✗ ✓ — the fold ends ✓ but carries failures
  for (const i of [3, 4, 5]) Object.assign(rs[i], { file: 'fit.jl', command: 'julia fit.jl' });
  Object.assign(rs[3], { state: 'error', exit: FAIL }); Object.assign(rs[4], { state: 'error', exit: FAIL });
  const g = groupModel(rs);
  assert.equal(g.collapsed, true);
  const fold = g.rows.find((r) => r.type === 'fold');
  assert.ok(fold, 'the fold is kept in the collapsed view');
  assert.deepEqual(fold.ladder.map((l) => l.glyph), ['✗', '✗', '✓']);
  assert.equal(fold.model.state, 'ok', 'its head still wears the last run\'s state');
  assert.equal(g.tally.bad, 2, 'and the header counts the two failures it shows');
  const hiddenN = g.rows.filter((r) => r.type === 'more').reduce((a, r) => a + r.n, 0);
  assert.equal(hiddenN, 4, 'only the ✓ singles between are folded into count lines');
});
test('surefire "Errors: N" arrives as the parser\'s `errored`: the mvn aux reads it', () => {
  const m = rowModel(job({ runtime: 'java', command: 'mvn -q test', file: 'mvn test', state: 'error', exit: FAIL, ms: 48000, counters: { total: 184, failed: 2, errored: 1, skipped: 0, passed: 181 } }));
  assert.equal(m.runtimeLabel, 'mvn');
  assert.equal(m.essText, '184 run · 2 failures');
  assert.equal(m.aux, '1 error');
});
test('stataLogSummary\'s `rc` names the row: r(198) · 2m11s (its lastError.msg is the line before the code)', () => {
  const m = rowModel(job({ runtime: 'stata', command: 'stata-mp -b do analysis.do', file: 'analysis.do', ms: 131000, counters: { errors: 1, rc: 198, lastError: { file: 'analysis.do', line: 142, col: null, msg: 'option foo not allowed' } } }));
  assert.equal(m.state, 'bad');
  assert.equal(m.essText, 'r(198) · 2m11s');
  assert.deepEqual(m.errorLine, { loc: 'analysis.do:142', msg: 'option foo not allowed' });
  const u = rowModel(job({ runtime: 'stata', command: 'stata-mp -b do analysis.do', file: 'analysis.do', ms: 131000, exit: OK, counters: { unverified: 1 } }));
  assert.equal(u.state, 'unv', 'the marker alone is no result');
  assert.equal(u.essText, 'unverified · log not read');
});

/* ── folds and groups ── */
/** n ✓ runs of distinct files, one every 90 s */
const runs = (n, mk = () => ({})) => Array.from({ length: n }, (_, i) => job({
  key: `sess:alpha/t1/toolu_${String(i).padStart(2, '0')}`, runtime: 'julia', file: `fit_cell_${i + 1}.jl`, command: `julia fit_cell_${i + 1}.jl`,
  createdAt: iso(i * 1.5), startedAt: iso(i * 1.5), ms: 20000, endedAt: iso(i * 1.5, 20), memPeakBytes: 300 * 1024 ** 2, counters: { errors: 0 }, ...mk(i),
}));
const fail = (j, msg = 'DomainError with -0.02') => Object.assign(j, { state: 'error', exit: FAIL, counters: { errors: 1, lastError: { file: j.file, line: 12, msg } } });
const stop = (j) => Object.assign(j, { state: 'stopped', exit: { code: null, signal: 'SIGTERM', byUser: true }, progress: { frac: 0.44 } });
const types = (g) => g.rows.map((r) => r.type === 'more' ? `more:${r.n}` : `${r.type}:${r.model.state}`);

test('1 run: no header, one row', () => {
  const g = groupModel(runs(1));
  assert.equal(g.header, false);
  assert.equal(g.many, false);
  assert.equal(g.collapsed, false);
  assert.deepEqual(types(g), ['row:ok']);
  assert.deepEqual(g.tally, { ...g.tally, n: 1, ok: 1, bad: 0, stop: 0, unv: 0 });
});
test('4 runs: header with the tally, every row, no show-all control', () => {
  const rs = runs(4); fail(rs[1]);
  const g = groupModel(rs);
  assert.equal(g.header, true);
  assert.equal(g.many, false);
  assert.equal(g.collapsed, false);
  assert.deepEqual(types(g), ['row:ok', 'row:bad', 'row:ok', 'row:ok']);
  assert.equal(g.tally.n, 4); assert.equal(g.tally.ok, 3); assert.equal(g.tally.bad, 1);
  assert.equal(g.tally.spanMs, 3 * 90000 + 20000, 'span = first start → last end');
  assert.deepEqual(tallyParts(g.tally).map((p) => p.text), ['4 runs', '3 ✓', '1 ✗', '4m50s']);
});
test('6 runs, all ✓: collapsed to one count line and the last run; open shows every row', () => {
  const rs = runs(6);
  const g = groupModel(rs);
  assert.equal(g.many, true);
  assert.equal(g.collapsed, true);
  assert.deepEqual(types(g), ['more:5', 'row:ok']);
  assert.match(g.rows[0].text, /^… 5 more ✓ · \d{1,2}:\d\d(?: [AP]M)? – \d{1,2}:\d\d(?: [AP]M)?$/);
  assert.deepEqual(g.rows[0].keys, rs.slice(0, 5).map((j) => j.key));
  const open = groupModel(rs, { open: true });
  assert.equal(open.collapsed, false);
  assert.deepEqual(types(open), Array(6).fill('row:ok'));
});
test('14 runs: every ✗/⊘ row with its error line, the last row, one count line per hidden stretch', () => {
  const rs = runs(14);
  fail(rs[3], "ValueError: shapes (4,3) and (4,) not aligned"); fail(rs[8], 'Binder Error: column "grp" not found'); stop(rs[10]);
  const g = groupModel(rs);
  assert.equal(g.collapsed, true);
  assert.deepEqual(types(g), ['more:3', 'row:bad', 'more:4', 'row:bad', 'more:1', 'row:stop', 'more:2', 'row:ok']);
  assert.deepEqual(g.rows.filter((r) => r.type === 'row' && r.model.state === 'bad').map((r) => r.model.errorLine.msg),
    ["ValueError: shapes (4,3) and (4,) not aligned", 'Binder Error: column "grp" not found']);
  assert.equal(g.rows[6].n, 2);
  assert.match(g.rows[4].text, /^… 1 more ✓ · \d{1,2}:\d\d/, 'a one-run stretch prints a single clock');
  assert.deepEqual(tallyParts(g.tally).map((p) => p.text).slice(0, 4), ['14 runs', '11 ✓', '2 ✗', '1 ⊘']);
  const open = groupModel(rs, { open: true });
  assert.equal(open.rows.length, 14);
  assert.equal(open.rows.filter((r) => r.type === 'more').length, 0);
});
test('60 runs: six ✗, two ⊘, a same-file streak folds to one entry and counts as one row', () => {
  const rs = runs(60);
  [5, 17, 23, 31, 44, 52].forEach((i) => fail(rs[i]));
  [27, 48].forEach((i) => stop(rs[i]));
  [36, 37, 38].forEach((i) => Object.assign(rs[i], { file: 'fit_cell_37.jl', command: 'julia fit_cell_37.jl' }));
  fail(rs[36], 'UndefVarError: `β0` not defined'); fail(rs[37], 'UndefVarError: `β0` not defined');
  const g = groupModel(rs);
  assert.equal(g.entries, 58, '60 runs fold to 58 entries');
  assert.equal(g.tally.n, 60); assert.equal(g.tally.bad, 8); assert.equal(g.tally.stop, 2); assert.equal(g.tally.ok, 50);
  const kept = g.rows.filter((r) => r.type !== 'more');
  assert.equal(kept.length, 10, 'six ✗ + two ⊘ + the last run + the ✗✗✓ fold (it ends ✓ but holds failures — kept, review R3)');
  const hiddenRuns = g.rows.filter((r) => r.type === 'more').reduce((a, r) => a + r.n, 0);
  assert.equal(hiddenRuns, 48, 'the count lines account for every hidden ✓ run');
  assert.ok(!g.rows.some((r) => r.type === 'more' && r.keys.includes(rs[37].key)), 'a folded ✗ run never hides in a "more ✓" stretch');
  assert.deepEqual(kept.find((r) => r.type === 'fold').ladder.map((l) => l.glyph), ['✗', '✗', '✓']);
  const open = groupModel(rs, { open: true });
  const fold = open.rows.find((r) => r.type === 'fold');
  assert.ok(fold, 'open: the streak is a fold row');
  assert.equal(fold.n, 3);
  assert.deepEqual(fold.ladder.map((l) => l.glyph), ['✗', '✗', '✓'], 'the ladder reads oldest → newest');
  assert.equal(fold.model.state, 'ok', 'the fold carries the LAST run');
  assert.equal(fold.job, rs[38]);
  assert.equal(open.rows.length, 58);
  const shown = groupModel(rs, { open: true, folds: new Set([fold.foldKey]) });
  const at = shown.rows.findIndex((r) => r.type === 'fold');
  assert.ok(shown.rows[at].open, 'the fold knows it is open');
  assert.deepEqual(shown.rows[at].runs.map((r) => r.model.glyph), ['✗', '✗', '✓'], 'an open fold carries its runs for the renderer to list after the head');
  assert.deepEqual(shown.rows[at].runs.map((r) => r.job), [rs[36], rs[37], rs[38]]);
  assert.equal(shown.rows.length, 58, 'the fold is still one entry of the group');
});
test('a six-run fold of one file: one entry, ladder ✗ ✗ ✗ ✓ ✓ ✓, the last run\'s facts and clock', () => {
  const rs = runs(6, () => ({ runtime: 'python', file: 'fit_mixture.py', command: 'python fit_mixture.py', memPeakBytes: 2.1 * 1024 ** 3 }));
  fail(rs[0], "NameError: name 'panel' is not defined"); fail(rs[1], "KeyError: 'group_id'"); fail(rs[2], 'LinAlgError: singular matrix');
  assert.equal(foldRuns(rs).length, 1);
  const g = groupModel(rs);
  assert.equal(g.header, true, 'six runs → the tally header');
  assert.equal(g.many, false, 'one entry → nothing to collapse');
  assert.deepEqual(types(g), ['fold:ok']);
  const f = g.rows[0];
  assert.equal(f.n, 6);
  assert.deepEqual(f.ladder.map((l) => l.glyph).join(' '), '✗ ✗ ✗ ✓ ✓ ✓');
  assert.equal(f.model.essText, '20s · ▲2.1G');
  assert.equal(f.model.timeText, rowModel(rs[5]).timeText);
  assert.equal(g.tally.bad, 3); assert.equal(g.tally.ok, 3);
});
test('foldRuns: only CONSECUTIVE same file+command runs fold; a different command breaks the streak', () => {
  const rs = runs(5);
  rs[1].file = rs[0].file; rs[1].command = rs[0].command;
  rs[3].file = rs[0].file; rs[3].command = rs[0].command;
  rs[4].file = rs[0].file; rs[4].command = `${rs[0].command} --fast`;
  const f = foldRuns(rs);
  assert.deepEqual(f.map((e) => e.jobs.length), [2, 1, 1, 1]);
});
test('a fold that ends ✗ or ⊘ is kept when collapsed', () => {
  const rs = runs(8);
  [2, 3].forEach((i) => Object.assign(rs[i], { file: 'a.jl', command: 'julia a.jl' }));
  fail(rs[3]);
  const g = groupModel(rs);
  assert.deepEqual(types(g), ['more:2', 'fold:bad', 'more:3', 'row:ok']);
  assert.equal(g.rows[1].model.errorLine.loc, 'a.jl:12');
});
