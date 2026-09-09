// The run ledger in the real console (headless Chrome, stubbed WS): one row
// per runtime with the vocabulary of docs/runfeed-mockups/index.html, the
// 4 / 14 / 60-run frames (tally header, collapse to the failed/stopped rows +
// count lines, show all in place), the sticky header under scroll, the ×n
// fold with its glyph ladder, the aux cell hidden whole when tight (never
// clipped), both themes, no page errors. Rows are seeded through the cold
// path the placement suite uses (jobHistory + a transcript with turn ids),
// so no card fade is waited on. Screenshots land in /tmp/runledger/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const available = fs.existsSync(CHROME);
const opts = { skip: available ? false : 'Google Chrome not installed' };
const SHOTS = '/tmp/runledger';
let ui, page, task;
const errors = [];
const BOX = '#v-alpha #consoleBox';

const OK = { code: 0, signal: null, byUser: false };
const FAIL = { code: 1, signal: null, byUser: false };
const T0 = Date.parse('2026-09-09T13:31:00.000Z');
const iso = (min, sec = 0) => new Date(T0 + min * 60000 + sec * 1000).toISOString();
let seq = 0;
/** a terminal session job on the new wire, owned by `turn` */
const job = (turn, over = {}) => {
  const i = seq++;
  const at = over.createdAt || iso(i * 1.5);
  const ms = over.ms != null ? over.ms : 23000;
  return {
    key: `sess:alpha/${task.id}/toolu_${String(i).padStart(3, '0')}`, jobRunId: `inv-${i}`, source: 'session', project: 'alpha', taskId: task.id,
    appTurnId: turn, taskCreated: task.created, state: 'done', exit: OK, verified: true, lang: 'julia', runtime: 'julia',
    file: `fit_cell_${i}.jl`, command: `julia fit_cell_${i}.jl`, ms, memPeakBytes: 300 * 1024 ** 2,
    counters: { errors: 0 }, output: { lines: 12, owned: false, fromToolResult: true }, ...over,
    createdAt: at, startedAt: at, endedAt: new Date(Date.parse(at) + ms).toISOString(),
  };
};
const fail = (j, msg = 'DomainError with -0.02: sqrt will only return a complex result') => Object.assign(j, { state: 'error', exit: FAIL, counters: { errors: 1, lastError: { file: j.file, line: 12, msg } } });
const stop = (j) => Object.assign(j, { state: 'stopped', exit: { code: null, signal: 'SIGTERM', byUser: true }, progress: { frac: 0.44 } });
const entry = (turnId, role, text) => ({ turnId, role, text, ts: '2026-09-09T13:30:00Z' });

/* ── the gallery: one run per runtime, expected row text ── */
const G = 'ledger-gallery';
const gallery = () => [
  [job(G, { runtime: 'julia', file: 'build_hybrid_one_type.jl', memPeakBytes: 548 * 1024 ** 2 }), { rt: 'julia', ico: '✓', ess: '23s · ▲548M', aux: ' · 0 errors' }],
  [fail(job(G, { runtime: 'julia', command: "julia --project -e 'using Pkg; Pkg.test()'", file: 'runtests.jl', ms: 214000 })), { rt: 'julia test', ico: '✗', ess: '142 passed · 2 failed', aux: ' · 3m34s', counters: { passed: 142, failed: 2, lastError: { file: 'test/solver.jl', line: 88, msg: 'Test Failed: norm(r) < 1e-6' } }, err: 'test/solver.jl:88 · Test Failed: norm(r) < 1e-6' }],
  [job(G, { runtime: 'python', file: 'fit_mixture.py', ms: 72000, memPeakBytes: 2.1 * 1024 ** 3 }), { rt: 'python', ico: '✓', ess: '1m12s · ▲2.1G', aux: ' · 0 errors' }],
  [fail(job(G, { runtime: 'pytest', command: 'python -m pytest tests/ -q', file: 'tests/', ms: 41000 })), { rt: 'pytest', ico: '✗', ess: '88 passed · 1 failed', aux: ' · 2 skipped', counters: { passed: 88, failed: 1, skipped: 2, lastError: { file: 'tests/test_income.py', line: 41, msg: 'assert abs(mu - 8.02) < 1e-3' } }, err: 'tests/test_income.py:41 · assert abs(mu - 8.02) < 1e-3' }],
  [job(G, { runtime: 'r', lang: 'r', file: 'clean_panel.R', ms: 41000, counters: { warnings: 3, errors: 0 } }), { rt: 'R', ico: '✓', ess: '41s · 3 warnings', aux: ' · 0 errors' }],
  [job(G, { runtime: 'r', lang: 'r', command: "Rscript -e 'testthat::test_dir(\"tests/testthat\")'", file: 'tests/testthat/', ms: 19000, counters: { passed: 212, failed: 0, warnings: 4 } }), { rt: 'testthat', ico: '✓', ess: '212 pass · 0 fail', aux: ' · 4 warn' }],
  [job(G, { runtime: 'cc', lang: 'c', command: 'cc -O2 -Wall solver.c -o solver && ./solver', file: 'solver.c', ms: 1900, counters: { errors: 0, warnings: 2 } }), { rt: 'cc', ico: '✓', ess: 'compile 0 errors 2 warn · run exit 0 1.9s', aux: ' · ▲300M' }],
  [fail(job(G, { runtime: 'cc', lang: 'c', command: 'cc solver.c -o solver && ./solver', file: 'solver.c', ms: 1200 })), { rt: 'cc', ico: '✗', ess: 'compile 1 error · run —', aux: ' · ▲300M', counters: { errors: 1, warnings: 0, lastError: { file: 'solver.c', line: 212, col: 14, msg: "use of undeclared identifier 'rho'" } }, err: "solver.c:212:14 · use of undeclared identifier 'rho'" }],
  [job(G, { runtime: 'cmake', lang: 'cpp', command: 'cmake --build build -j8', file: 'build/', ms: 64000, counters: { errors: 0, warnings: 3 } }), { rt: 'cmake', ico: '✓', ess: '0 errors · 3 warnings', aux: ' · 1m04s' }],
  [job(G, { runtime: 'ctest', lang: 'cpp', command: 'ctest --test-dir build', file: 'build/', ms: 12000, counters: { passed: 36, failed: 0 } }), { rt: 'ctest', ico: '✓', ess: '36 passed · 0 failed', aux: ' · 12s' }],
  [job(G, { runtime: 'cargo', lang: 'rust', command: 'cargo run --release -- --steps 1000', file: 'hybrid-sim', ms: 4200, counters: { errors: 0, warnings: 1, crate: 'hybrid-sim' } }), { rt: 'cargo run', ico: '✓', ess: '1 warning · exit 0 · 4.2s', aux: ' · hybrid-sim' }],
  [job(G, { runtime: 'cargo', lang: 'rust', command: 'cargo test', file: 'hybrid-sim', ms: 9800, counters: { passed: 61, failed: 0 } }), { rt: 'cargo test', ico: '✓', ess: '61 passed · 0 failed', aux: ' · 9.8s' }],
  [job(G, { runtime: 'go', lang: 'go', command: 'go run ./cmd/sim', file: 'cmd/sim', ms: 2100, counters: { errors: 0 } }), { rt: 'go run', ico: '✓', ess: '0 errors · exit 0 · 2.1s', aux: null }],
  [fail(job(G, { runtime: 'go', lang: 'go', command: 'go test ./... -cover', file: './...', ms: 5400 })), { rt: 'go test', ico: '✗', ess: '11/12 pkgs ok · 2 failed', aux: ' · cov 81%', counters: { suites: 12, suitesFailed: 1, failed: 2, coverage: 81.3, lastError: { file: 'sim/solver_test.go', line: 88, msg: 'want 0.5, got 0.4999' } }, err: 'sim/solver_test.go:88 · want 0.5, got 0.4999' }],
  [job(G, { runtime: 'node', lang: 'node', file: 'scripts/build-index.mjs', ms: 3400, counters: {}, output: { lines: 212, owned: false, fromToolResult: true } }), { rt: 'node', ico: '✓', ess: 'exit 0 · 3.4s', aux: ' · 212 lines' }],
  [job(G, { runtime: 'node', lang: 'node', command: 'npx vitest run', file: 'src/', ms: 6100, counters: { passed: 240, failed: 0, skipped: 3 } }), { rt: 'vitest', ico: '✓', ess: '240 passed · 0 failed', aux: ' · 3 skipped' }],
  [job(G, { runtime: 'vite', lang: 'node', command: 'npx vite build', file: 'vite build', ms: 4800, counters: { errors: 0, modules: 312, timeS: 4.6 } }), { rt: 'vite', ico: '✓', ess: '0 errors · 312 modules', aux: ' · 4.6s' }],
  [fail(job(G, { runtime: 'tsc', lang: 'node', command: 'npx tsc --noEmit', file: 'tsc --noEmit', ms: 7200, exit: { code: 2, signal: null, byUser: false } })), { rt: 'tsc', ico: '✗', ess: '3 errors', aux: ' · 7.2s', counters: { errors: 3, lastError: { file: 'src/api/jobs.ts', line: 88, col: 14, msg: "TS2339: Property 'ms' does not exist on type 'Job'" } }, err: "src/api/jobs.ts:88:14 · TS2339: Property 'ms' does not exist on type 'Job'" }],
  [job(G, { runtime: 'java', lang: 'java', command: 'javac Main.java && java Main', file: 'Main.java', ms: 2100, counters: { errors: 0 } }), { rt: 'java', ico: '✓', ess: '0 errors · exit 0 · 2.1s', aux: null }],
  [fail(job(G, { runtime: 'maven', lang: 'java', command: 'mvn -q test', file: 'mvn test', ms: 48000 })), { rt: 'mvn', ico: '✗', ess: '184 run · 2 failures', aux: ' · 1 error', counters: { total: 184, failed: 2, errors: 1 }, err: null }],
  [job(G, { runtime: 'sql', lang: 'sql', command: 'duckdb panel.duckdb < build_panel.sql', file: 'build_panel.sql', ms: 8200, counters: { statements: 14, errors: 0 } }), { rt: 'sql', ico: '✓', ess: '14 statements · 0 errors', aux: ' · 8.2s' }],
  [job(G, { runtime: 'latex', lang: 'shell', command: 'latexmk -pdf main.tex', file: 'main.tex', ms: 31000, counters: { page: 24, errors: 0, warnings: 7, pass: 3 } }), { rt: 'latexmk', ico: '✓', ess: '24 pages · 7 warnings', aux: ' · 3 passes' }],
  [job(G, { runtime: 'shell', lang: 'shell', file: 'run_all.sh', ms: 2100, counters: {}, output: { lines: 40, owned: false, fromToolResult: true } }), { rt: 'shell', ico: '✓', ess: 'exit 0 · 2.1s', aux: ' · 40 lines' }],
  [job(G, { runtime: 'stata', lang: 'shell', command: 'stata-mp -b do analysis.do', file: 'analysis.do', ms: 131000, counters: { errors: 1, lastError: { file: 'analysis.do', line: 142, msg: 'r(198) invalid syntax' } } }), { rt: 'stata', ico: '✗', ess: 'r(198) · 2m11s', aux: null, err: 'analysis.do:142 · r(198) invalid syntax' }],
  [job(G, { runtime: 'stata', lang: 'shell', command: 'stata-mp -b do robustness.do', file: 'robustness.do', ms: 62000, counters: {}, verified: false }), { rt: 'stata', ico: '○', ess: 'unverified · log not read', aux: null }],
  [job(G, { runtime: 'matlab', lang: 'shell', command: 'matlab -batch "batch_sim"', file: 'batch_sim.m', ms: 181000, counters: { errors: 0 } }), { rt: 'matlab', ico: '✓', ess: 'exit 0 · 3m01s', aux: ' · 0 errors' }],
  [fail(job(G, { runtime: 'nbconvert', lang: 'notebook', command: 'jupyter nbconvert --execute explore.ipynb', file: 'explore.ipynb', ms: 52000 })), { rt: 'notebook', ico: '✗', ess: '18/31 cells · 1 error', aux: ' · 52s', counters: { cells: 18, total: 31, errors: 1, lastError: { file: 'cell 19', msg: "KeyError: 'group_id'" } }, err: "cell 19 · KeyError: 'group_id'" }],
  [job(G, { runtime: 'rsync', lang: 'shell', command: 'rsync -avz --progress data/ hpc:proj/data/', file: 'data/', ms: 118000, counters: { bytes: 4.2e9, rateBps: 38e6 } }), { rt: 'rsync', ico: '✓', ess: '4.2 GB · 38 MB/s', aux: ' · 1m58s' }],
  [job(G, { runtime: 'python', file: 'fit_mixture.py', command: 'python fit_mixture.py --components 12', state: 'error', exit: { code: 137, signal: 'SIGKILL', byUser: false }, ms: 388000, memPeakBytes: 14.9 * 1024 ** 3 }), { rt: 'python', ico: '✗', ess: 'exit 137 · SIGKILL · often out of memory', aux: ' · 6m28s · ▲14.9G', err: null }],
  [stop(job(G, { runtime: 'python', file: 'train.py', ms: 250000, memPeakBytes: 1.2 * 1024 ** 3 })), { rt: 'python', ico: '⊘', ess: 'stopped by you at 44%', aux: ' · ▲1.2G' }],
  [job(G, { lang: 'julia', runtime: null, file: 'legacy.jl', exit: null, exitCode: null, counters: {}, verified: undefined, memPeakBytes: 548 * 1024 ** 2, output: { owned: false } }), { rt: 'julia', ico: '○', ess: '23s · ▲548M', aux: null }],
].map(([j, want]) => { if (want.counters) j.counters = want.counters; return [j, want]; });

/* ── the frames ── */
const F4 = 'ledger-4', F14 = 'ledger-14', F60 = 'ledger-60', FF = 'ledger-fold';
const frames = () => {
  const r4 = Array.from({ length: 4 }, () => job(F4)); fail(r4[1]);
  const r14 = Array.from({ length: 14 }, () => job(F14));
  fail(r14[3], 'ValueError: shapes (4,3) and (4,) not aligned'); fail(r14[8], 'Binder Error: column "grp" not found'); stop(r14[10]);
  const r60 = Array.from({ length: 60 }, () => job(F60));
  [5, 17, 23, 31, 44, 52].forEach((i) => fail(r60[i]));
  [27, 48].forEach((i) => stop(r60[i]));
  [36, 37, 38].forEach((i) => Object.assign(r60[i], { file: 'fit_cell_37.jl', command: 'julia fit_cell_37.jl' }));
  fail(r60[36], 'UndefVarError: `β0` not defined'); fail(r60[37], 'UndefVarError: `β0` not defined');
  const rf = Array.from({ length: 6 }, () => job(FF, { runtime: 'python', lang: 'python', file: 'fit_mixture.py', command: 'python fit_mixture.py', memPeakBytes: 2.1 * 1024 ** 3 }));
  fail(rf[0], "NameError: name 'panel' is not defined"); fail(rf[1], "KeyError: 'group_id'"); fail(rf[2], 'LinAlgError: singular matrix');
  return { r4, r14, r60, rf };
};

let gal, fr;
const block = (turn) => `${BOX} .cs-jobs[data-turn-id="${turn}"] .csJobFeed`;
/** the ledger of one turn, as rendered */
const readLedger = (turn) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const q = (n, s) => n.querySelector(s)?.textContent ?? null;
  return {
    head: q(el, ':scope > .lgHead'), act: q(el, ':scope > .lgHead .lgAct'),
    items: [...el.children].map((c) => ({
      key: c.dataset.key, jobkey: c.dataset.jobkey || null, cls: c.className, h: Math.round(c.getBoundingClientRect().height * 10) / 10,
      ico: q(c, '.jfIco'), rt: q(c, '.jfRt'), cmd: q(c, '.jfCmd'), ess: q(c, '.jfEss'), seq: q(c, '.jfSeq'), n: q(c, '.jfN'),
      aux: c.querySelector('.jfAux')?.textContent ?? null, auxHidden: c.querySelector('.jfAux')?.hidden ?? null,
      time: q(c, '.jfTime'), err: q(c, '.jfErr'), errTitle: c.querySelector('.jfErr')?.title ?? null, text: c.textContent.trim(),
    })),
  };
}, block(turn));

before(async () => {
  if (!available) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  ui = await startUI();
  ({ page } = ui);
  page.on('pageerror', (e) => errors.push(e.message));
  ({ body: task } = await ui.sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Run ledger review', oversight: 'coop' }));
  await ui.sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, { status: 'waiting' });
  gal = gallery(); fr = frames();
  const { body: snapshot } = await ui.sb.fetchJson('GET', '/api/state');
  snapshot.jobs = [];
  snapshot.jobHistory = { alpha: [...gal.map(([j]) => j), ...fr.r4, ...fr.r14, ...fr.r60, ...fr.rf] };
  const transcript = [];
  const turns = [[G, 'Run one of everything.', 'One row per runtime.'], [F4, 'Four runs.', 'Cleaned the panel, ran the tests, refitted the mixture and rebuilt the paper.'],
    [F14, 'Fourteen cells.', 'Swept the 14 cell configurations. Two fail and you stopped one; the other eleven completed.'],
    [F60, 'Sixty cells.', 'Ran the full 60-cell grid. Six cells fail, two were stopped, fit_cell_37.jl took three tries.'],
    [FF, 'Get fit_mixture.py running.', 'Got fit_mixture.py running after three attempts; the last three runs converge to the same log-likelihood.']];
  for (const [t, u, a] of turns) transcript.push(entry(t, 'user', u), entry(t, 'assistant', `${a}\n\n${'The reader\'s paragraph below the block. '.repeat(6)}`));
  await page.route('**/api/state', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/transcript/alpha/*', (route) => route.fulfill({ json: { transcript } }));
  await page.goto(`${ui.sb.base}/#alpha`);
  await page.waitForSelector(`${block(G)} .jobFeedRow`, { timeout: 15000 });
  await sleep(300);
});

after(async () => { if (ui) await ui.stop(); });

test('every block sits in its own turn; a turn with 30 runs opens with show all', opts, async () => {
  const g = await readLedger(G);
  assert.ok(g.head, 'the gallery turn has a tally header');
  assert.equal(g.act, 'show all ▾');
  assert.match(g.head, /^31 runs · 19 ✓ · 9 ✗ · 1 ⊘ · 2 ○ · \d/);
  await page.click(`${block(G)} .lgAct`);
  await sleep(150);
  const open = await readLedger(G);
  assert.equal(open.act, 'collapse ▴');
  assert.equal(open.items.filter((i) => i.cls.startsWith('jobFeedRow')).length, 31, 'every run is a row when open');
  assert.equal(open.items.filter((i) => i.cls === 'lgMore').length, 0);
});

test('one row per runtime: pill, glyph, essentials, aux, error line — the vocabulary', opts, async () => {
  const open = await readLedger(G);
  const by = new Map(open.items.map((i) => [i.jobkey, i]));
  for (const [j, want] of gal) {
    const row = by.get(j.key);
    assert.ok(row, `a row for ${j.file} (${want.rt})`);
    assert.equal(row.rt, want.rt, `pill of ${j.file}`);
    assert.equal(row.ico, want.ico, `glyph of ${j.file}`);
    assert.equal(row.ess, want.ess, `essentials of ${j.file}`);
    assert.equal(row.aux, want.aux, `aux of ${j.file}`);
    assert.equal(row.h, want.err ? 42 : 26, `row height of ${j.file}: 26 px, 42 with the error line`);
    if (want.err) {
      assert.equal(row.err, want.err, `error line of ${j.file}`);
      assert.equal(row.errTitle, want.err, 'the full text rides in the title');
    } else assert.equal(row.err, null, `no error line for ${j.file}`);
    assert.match(row.time, /^\d{1,2}:\d\d/, 'the clock on every row');
    assert.equal(row.cls, `jobFeedRow ${{ '✓': 'ok', '✗': 'bad', '⊘': 'stop', '○': 'unv' }[want.ico]}`);
  }
  const oom = by.get(gal.find(([, w]) => w.ess.startsWith('exit 137'))[0].key);
  assert.equal((oom.text.match(/137/g) || []).length, 1, 'exit 137 printed once');
  assert.equal((oom.text.match(/SIGKILL/g) || []).length, 1, 'SIGKILL printed once');
  await page.click(`${block(G)} .lgAct`);
  await sleep(100);
});

test('4 runs: the tally header, every row, no control', opts, async () => {
  const g = await readLedger(F4);
  assert.match(g.head, /^4 runs · 3 ✓ · 1 ✗ · \d/);
  assert.equal(g.act, null, 'two to five runs: no show-all control');
  assert.deepEqual(g.items.filter((i) => i.cls !== 'lgHead').map((i) => i.cls), ['jobFeedRow ok', 'jobFeedRow bad', 'jobFeedRow ok', 'jobFeedRow ok']);
  assert.deepEqual(g.items.map((i) => i.h).slice(1), [26, 42, 26, 26]);
});

test('14 runs: collapsed to the ✗/⊘ rows with error lines, the last row, one count line per hidden stretch; show all expands in place', opts, async () => {
  const g = await readLedger(F14);
  assert.match(g.head, /^14 runs · 11 ✓ · 2 ✗ · 1 ⊘ · \d/);
  assert.equal(g.act, 'show all ▾');
  const shape = g.items.filter((i) => i.cls !== 'lgHead').map((i) => (i.cls === 'lgMore' ? i.text : i.cls));
  assert.equal(shape.length, 8);
  assert.match(shape[0], /^… 3 more ✓ · \d{1,2}:\d\d(?: [AP]M)? – \d{1,2}:\d\d(?: [AP]M)?$/);
  assert.equal(shape[1], 'jobFeedRow bad');
  assert.match(shape[2], /^… 4 more ✓ · /);
  assert.equal(shape[3], 'jobFeedRow bad');
  assert.match(shape[4], /^… 1 more ✓ · \d{1,2}:\d\d/);
  assert.equal(shape[5], 'jobFeedRow stop');
  assert.match(shape[6], /^… 2 more ✓ · /);
  assert.equal(shape[7], 'jobFeedRow ok');
  const bad = g.items.filter((i) => i.cls === 'jobFeedRow bad');
  assert.equal(bad[0].err, `${fr.r14[3].file}:12 · ValueError: shapes (4,3) and (4,) not aligned`);
  assert.equal(bad[1].err, `${fr.r14[8].file}:12 · Binder Error: column "grp" not found`);
  assert.equal(g.items.find((i) => i.cls === 'jobFeedRow stop').ess, 'stopped by you at 44%');
  // a reader below the block: expand, and the paragraph under the divider moves zero pixels
  const drift = await page.evaluate((sel) => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const seg = document.querySelector(sel).closest('.cs-jobs');
    const next = seg.nextElementSibling;
    box.scrollTop += next.getBoundingClientRect().top - box.getBoundingClientRect().top - 24;
    const before = next.getBoundingClientRect().top;
    seg.querySelector('.lgAct').click();
    return { moved: next.getBoundingClientRect().top - before, act: seg.querySelector('.lgAct').textContent };
  }, block(F14));
  assert.equal(drift.act, 'collapse ▴');
  assert.ok(Math.abs(drift.moved) <= 1, `the reader below the block moved ${drift.moved}px`);
  const open = await readLedger(F14);
  assert.equal(open.items.filter((i) => i.cls.startsWith('jobFeedRow')).length, 14);
  assert.equal(open.items.filter((i) => i.cls === 'lgMore').length, 0);
  // clicking a count line also opens; collapse folds it back and the open state survives a re-render
  await page.click(`${block(F14)} .lgAct`);
  await sleep(100);
  const again = await readLedger(F14);
  assert.equal(again.act, 'show all ▾');
  assert.equal(again.items.filter((i) => i.cls === 'lgMore').length, 4);
  await page.click(`${block(F14)} .lgMore`);
  await sleep(100);
  assert.equal((await readLedger(F14)).act, 'collapse ▴', 'a count line click shows all');
  await ui.wsPush('state', await page.evaluate(async () => (await fetch('/api/state')).json()));
  await sleep(400);
  assert.equal((await readLedger(F14)).act, 'collapse ▴', 'a broadcast re-render keeps the group open');
});

test('60 runs: collapsed to about ten rows; expanded, fixed rows and the header sticks under scroll', opts, async () => {
  const g = await readLedger(F60);
  assert.match(g.head, /^60 runs · 50 ✓ · 8 ✗ · 2 ⊘ · \d/);
  const rows = g.items.filter((i) => i.cls.startsWith('jobFeedRow'));
  assert.equal(rows.length, 10, 'six ✗ + two ⊘ + the last run + the ✗✗✓ fold (kept: it holds failures, review R3)');
  const foldRow = rows.find((r) => r.cls.includes('fold'));
  assert.ok(foldRow && foldRow.seq === '✗ ✗ ✓', 'the kept fold shows its mixed ladder while collapsed');
  assert.equal(g.items.filter((i) => i.cls === 'lgMore').length, 10, 'the kept fold splits its stretch in two');
  const hidden = g.items.filter((i) => i.cls === 'lgMore').reduce((a, i) => a + Number(i.text.match(/… (\d+) more/)[1]), 0);
  assert.equal(hidden, 48);
  await page.click(`${block(F60)} .lgAct`);
  await sleep(150);
  const open = await readLedger(F60);
  const orows = open.items.filter((i) => i.cls.startsWith('jobFeedRow'));
  assert.equal(orows.length, 58, '60 runs, the streak folded to one row');
  assert.ok(orows.every((r) => r.h === 26 || r.h === 42), `fixed row heights: ${[...new Set(orows.map((r) => r.h))]}`);
  const fold = orows.find((r) => r.cls.includes('fold'));
  assert.ok(fold, 'the streak is a fold row');
  assert.equal(fold.n, '×3 ▾');
  assert.equal(fold.seq, '✗ ✗ ✓');
  assert.equal(fold.cls, 'jobFeedRow ok fold', 'the fold carries the last run\'s state');
  // sticky: scroll the block 400 px past the top of the console; the header stays at the top edge, rows pass under it
  const st = await page.evaluate((sel) => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const el = document.querySelector(sel);
    const b0 = box.getBoundingClientRect();
    box.scrollTop += el.getBoundingClientRect().top - b0.top + 400;
    const head = el.querySelector('.lgHead').getBoundingClientRect();
    const under = [...el.querySelectorAll('.jobFeedRow')].filter((r) => { const rr = r.getBoundingClientRect(); return rr.top < head.bottom && rr.bottom > head.top; }).length;
    return { blockTop: Math.round(el.getBoundingClientRect().top - b0.top), headTop: Math.round(head.top - b0.top), under,
      bg: getComputedStyle(el.querySelector('.lgHead')).backgroundColor, z: getComputedStyle(el.querySelector('.lgHead')).zIndex };
  }, block(F60));
  assert.ok(st.blockTop <= -380, `the block scrolled under (top at ${st.blockTop})`);
  assert.ok(Math.abs(st.headTop) <= 2, `the header sticks to the console's top edge (at ${st.headTop})`);
  assert.ok(st.under >= 1, 'a row passes under the header');
  assert.ok(!/rgba\(.*, 0\)$/.test(st.bg), `the stuck header is opaque (${st.bg})`);
  assert.equal(st.z, '2');
  await page.click(`${block(F60)} .lgAct`);
  await sleep(100);
});

test('collapse from the stuck header: the reader inside the block is not thrown onto the prose — the block\'s top is pinned (review R2)', opts, async () => {
  await page.click(`${block(F60)} .lgAct`); await sleep(150); // open
  const r = await page.evaluate((sel) => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const el = document.querySelector(sel); const b0 = box.getBoundingClientRect();
    box.scrollTop += el.getBoundingClientRect().top - b0.top + 400; // the reader is 400 px into the open block, header stuck
    const stuck = Math.round(el.querySelector('.lgHead').getBoundingClientRect().top - b0.top);
    el.querySelector('.lgAct').click(); // collapse
    const r1 = el.getBoundingClientRect();
    const prev = el.closest('.cs-jobs').previousElementSibling.getBoundingClientRect();
    return { stuck, act: el.querySelector('.lgAct').textContent, blockTop: Math.round(r1.top - b0.top), blockBottom: Math.round(r1.bottom - b0.top), proseBottom: Math.round(prev.bottom - b0.top), boxH: Math.round(b0.height) };
  }, block(F60));
  assert.equal(r.stuck, 0, 'the header was stuck at the top edge before the click');
  assert.equal(r.act, 'show all ▾');
  assert.ok(Math.abs(r.blockTop) <= 2, `after collapsing, the block's top sits at the scrollport's top edge (at ${r.blockTop}px), not the prose above it`);
  assert.ok(r.proseBottom <= 2, `the prose above stays above (bottom at ${r.proseBottom}px)`);
  assert.ok(r.blockBottom > 100, 'the collapsed block is in view');
});

test('focus mode pads the console 18 px: the sticky header still meets the visible top edge (review B8)', opts, async () => {
  await page.click('.statusbar .focusTog'); await sleep(400);
  const pad = await page.evaluate(() => { const box = document.querySelector('#v-alpha #consoleBox'); const cs = getComputedStyle(box); return { top: cs.paddingTop, v: cs.getPropertyValue('--console-pad').trim(), focus: document.querySelector('.wb').classList.contains('focus') }; });
  assert.equal(pad.focus, true, 'focus mode is on');
  assert.equal(pad.top, '18px');
  assert.equal(pad.v, '18px', 'the layout publishes its padding for the sticky offset');
  await page.click(`${block(F60)} .lgAct`); await sleep(150);
  const st = await page.evaluate((sel) => {
    const box = document.querySelector('#v-alpha #consoleBox'); const el = document.querySelector(sel); const b0 = box.getBoundingClientRect();
    box.scrollTop += el.getBoundingClientRect().top - b0.top + 300;
    const head = el.querySelector('.lgHead').getBoundingClientRect();
    return { headTop: Math.round(head.top - b0.top), top: getComputedStyle(el.querySelector('.lgHead')).top };
  }, block(F60));
  assert.equal(st.top, '-18px');
  assert.ok(Math.abs(st.headTop) <= 2, `the header sticks flush at the scrollport's edge in focus mode (at ${st.headTop}px, was 6 px above it)`);
  await page.click(`${block(F60)} .lgAct`); await sleep(100);
  await page.click('.statusbar .focusTog'); await sleep(400);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#v-alpha #consoleBox')).getPropertyValue('--console-pad').trim()), '24px');
});

test('a six-run fold: ×6 badge, the ladder ✗ ✗ ✗ ✓ ✓ ✓, the last run\'s facts and clock; click opens the runs', opts, async () => {
  const g = await readLedger(FF);
  assert.match(g.head, /^6 runs · 3 ✓ · 3 ✗ · \d/);
  assert.equal(g.act, null, 'one entry: nothing to collapse');
  const rows = g.items.filter((i) => i.cls.startsWith('jobFeedRow'));
  assert.equal(rows.length, 1);
  const f = rows[0];
  assert.equal(f.cls, 'jobFeedRow ok fold');
  assert.equal(f.n, '×6 ▾');
  assert.equal(f.seq, '✗ ✗ ✗ ✓ ✓ ✓');
  assert.equal(f.rt, 'python');
  assert.equal(f.cmd, 'fit_mixture.py');
  assert.equal(f.ess, '20s · ▲2.1G'.replace('20s', '23s'));
  assert.equal(f.jobkey, fr.rf[5].key, 'the fold head stands for the last run');
  assert.equal(f.h, 26);
  await page.evaluate((sel) => document.querySelector(`${sel} .jobFeedRow.fold`).scrollIntoView(), block(FF));
  await page.click(`${block(FF)} .jobFeedRow.fold .jfN`);
  await sleep(150);
  const open = await readLedger(FF);
  const orows = open.items.filter((i) => i.cls.startsWith('jobFeedRow'));
  assert.equal(orows.length, 7, 'the head and its six runs');
  assert.equal(orows[0].n, '×6 ▴');
  assert.equal(orows[0].jobkey, null, 'an open fold\'s head carries no job key: its runs are the records');
  assert.deepEqual(orows.slice(1).map((r) => r.ico), ['✗', '✗', '✗', '✓', '✓', '✓']);
  assert.ok(orows.slice(1).every((r) => r.cls.endsWith(' child')));
  assert.equal(orows[1].err, "fit_mixture.py:12 · NameError: name 'panel' is not defined");
  assert.deepEqual(orows.slice(1).map((r) => r.jobkey), fr.rf.map((j) => j.key));
  await page.click(`${block(FF)} .jobFeedRow.fold .jfN`);
  await sleep(100);
  assert.equal((await readLedger(FF)).items.filter((i) => i.cls.startsWith('jobFeedRow')).length, 1);
});

test('the aux cell is hidden whole when the row is tight — nothing is ever wider than its row', opts, async () => {
  await page.click(`${block(G)} .lgAct`);
  await sleep(150);
  const fits = (sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const rows = [...el.querySelectorAll('.jobFeedRow')];
    let over = 0, shown = 0, hidden = 0;
    const bad = [];
    for (const r of rows) {
      const rr = r.getBoundingClientRect();
      // every cell of the row lies inside it (the sum may ellipsise as a last resort, but never overhangs);
      // a SHOWN aux cell lies inside whole — it is dropped as a unit, never clipped
      for (const c of [...r.children, ...r.querySelectorAll('.jfAux')]) {
        if (c.hidden || c.closest('[hidden]')) continue;
        const cr = c.getBoundingClientRect();
        if (cr.width === 0) continue;
        if (cr.right > rr.right + 0.5 || cr.left < rr.left - 0.5) { over++; bad.push(`${c.className}: ${Math.round(cr.left - rr.left)}..${Math.round(cr.right - rr.right)} in ${r.querySelector('.jfCmd').textContent}`); }
      }
      const a = r.querySelector('.jfAux');
      if (a) { if (a.hidden) hidden++; else shown++; }
    }
    return { width: Math.round(el.getBoundingClientRect().width), rows: rows.length, over, bad: bad.slice(0, 5), shown, hidden };
  }, sel);
  const wide = await fits(block(G));
  assert.equal(wide.over, 0, `wide (${wide.width}px): nothing sticks out: ${wide.bad.join(' | ')}`);
  assert.ok(wide.shown > 0, 'at the console width the aux cells fit');
  // tighten the block to the session pane's ~404 px of content; the ResizeObserver re-fits
  await page.evaluate((sel) => { document.querySelector(sel).style.maxWidth = '404px'; }, block(G));
  await sleep(250);
  const tight = await fits(block(G));
  assert.equal(tight.width, 404);
  assert.equal(tight.over, 0, `tight: nothing sticks out or clips: ${tight.bad.join(' | ')}`);
  assert.ok(tight.hidden > 0, 'some aux cells no longer fit and are hidden whole');
  const partial = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .jfAux`)].filter((a) => !a.hidden).some((a) => {
    const r = a.getBoundingClientRect(), row = a.closest('.jobFeedRow').getBoundingClientRect();
    return r.right > row.right - 9; // the row's 10 px padding
  }), block(G));
  assert.equal(partial, false, 'no shown aux cell runs into the padding');
  await page.evaluate((sel) => { document.querySelector(sel).style.maxWidth = ''; }, block(G));
  await sleep(250);
  const back = await fits(block(G));
  assert.equal(back.shown, wide.shown, 'widening shows them again');
  await page.click(`${block(G)} .lgAct`);
  await sleep(100);
});

test('both themes: the glyph colours follow the tokens, the stuck header stays opaque; screenshots', opts, async () => {
  // headless Chrome prefers light, so each theme is set explicitly (the app's
  // dark palette is :root; html[data-theme="light"] re-tokens it)
  const read = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const cs = (q) => getComputedStyle(el.querySelector(q));
    const tok = (name) => { const s = document.createElement('span'); s.style.color = `var(${name})`; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
    return { ok: cs('.jobFeedRow.ok .jfIco').color, bad: cs('.jobFeedRow.bad .jfIco').color, stop: cs('.jobFeedRow.stop .jfIco').color,
      run: tok('--run'), red: tok('--red'), yellow: tok('--yellow'), head: cs('.lgHead').backgroundColor, err: cs('.jfErr').color, errink: tok('--errink') };
  }, block(F14));
  const shot = async (turn, name) => {
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), block(turn));
    await sleep(80);
    const clip = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }; }, block(turn));
    await page.screenshot({ path: `${SHOTS}/${name}.png`, clip });
  };
  const out = {};
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await sleep(200);
    const r = await read();
    assert.equal(r.ok, r.run, `${theme}: ✓ wears --run`); assert.equal(r.bad, r.red, `${theme}: ✗ wears --red`);
    assert.equal(r.stop, r.yellow, `${theme}: ⊘ wears --yellow`); assert.equal(r.err, r.errink, `${theme}: the error line wears --errink`);
    assert.ok(!/rgba\(.*, 0\)$/.test(r.head), `${theme}: the header ground is opaque (${r.head})`);
    out[theme] = r;
    await shot(F14, `14-${theme}`);
    await page.click(`${block(F14)} .lgAct`);
    await sleep(150);
    await shot(F14, `14-open-${theme}`);
    await page.click(`${block(F14)} .lgAct`);
    await shot(FF, `fold-${theme}`);
    await page.click(`${block(FF)} .jobFeedRow.fold .jfN`);
    await sleep(150);
    await shot(FF, `fold-open-${theme}`);
    await page.click(`${block(FF)} .jobFeedRow.fold .jfN`);
  }
  assert.notEqual(out.light.ok, out.dark.ok, 'the light theme re-tokens the glyphs');
  assert.notEqual(out.light.head, out.dark.head, 'the header ground follows the theme');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  for (const f of ['14-dark', '14-light', '14-open-dark', '14-open-light', 'fold-dark', 'fold-light', 'fold-open-dark', 'fold-open-light']) assert.ok(fs.statSync(`${SHOTS}/${f}.png`).size > 1000, `${f}.png written`);
});

test('no page errors', opts, () => {
  assert.deepEqual(errors, []);
});
