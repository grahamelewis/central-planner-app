// The live job card v3 (telemetry strip · expanded card · feed row) in the
// real frontend (headless Chrome, stubbed WS). Spec: docs/jobcard-mockups/
// IMPLEMENTATION.md §2. Guards:
//   · the card is built ONCE and patched — the bar's width transition and the
//     ticking clock must never be reset by an innerHTML rebuild
//   · the HEALTH word owns the band: computing / stalled Ns / waiting on I/O /
//     starting · pid not pinned / ✓ done / ✗ failed · exit 1 / ⊘ stopped · by you
//   · estimates wear ≈ + a dotted underline; a withheld ETA says why
//   · no decorative sweep: no .indet anywhere; a bar only for a parsed
//     fraction; a dotted ruler only with history; otherwise no track
//   · stale samples grey the numbers (--dim, ≥ 3:1) but never the clock
//   · the expanded card toggles (click / Escape) and plots two sparklines
//   · an OLD event (cpu/mem only) still renders, labelled % / rss
//   · ⊘ stop posts the job key; a finished card holds its end summary, fades,
//     and leaves a one-line feed row; a detached job keeps a live row
// Tests share one staged session and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, jobKey;
const stopPosts = [];
const pageErrors = [];

const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const SESSION_START = iso(65000);
const RUN_START = iso(30000);

/** the full v3 wire shape for a session job (IMPLEMENTATION.md §1) */
const sessJob = (over = {}) => ({
  key: jobKey, source: 'session', project: 'alpha', taskId: id,
  file: 'models/fig3.jl', lang: 'julia', command: 'julia --project=. --threads=4 models/fig3.jl --chains 4 --draws 10000',
  state: 'running', bg: false, detached: false, inline: false, stopping: false,
  startedAt: SESSION_START, elapsedMs: 65000, pid: 48213,
  cpu: 320, mem: 1109852160, progress: null, quietMs: null, exitCode: null, ms: null,
  sampledAt: iso(1000), pollMs: 2000, stale: false,
  cores: 3.2, coresBasis: 'cputime', hostCores: 10, cpuTimeMs: 208000,
  memBytes: 759000000, memKind: 'footprint', memPeakBytes: 1400000000,
  procs: 3, threads: 9,
  health: { state: 'computing', sinceMs: 60000 },
  output: { owned: false },
  history: null, exit: null, phase: null, counters: {},
  ...over,
});

/** the full v3 shape for a ▶ run (owned output) */
const runJob = (over = {}) => sessJob({
  key: 'run:alpha', source: 'run', taskId: null, command: 'julia fig3.jl',
  startedAt: RUN_START, elapsedMs: 30000, pid: 4242, cpu: 180, mem: 5e8,
  cores: 1.8, memBytes: 5e8, memPeakBytes: 5.2e8, procs: 1, threads: 4, cpuTimeMs: 54000,
  progress: { frac: 0.42, iter: 210, total: 500, etaS: 240 },
  output: { lines: 12400, rate: 3.1, last: 'iter 210/500 …', owned: true, buffered: false },
  ...over,
});

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.mkdirSync(path.join(projRoots.alpha, 'models'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'models', 'fig3.jl'), 'println(1)\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  await page.route('**/api/jobs/**', (r) => {
    stopPosts.push(JSON.parse(r.request().postData() || '{}'));
    r.fulfill({ json: { ok: true } });
  });
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Regenerate Fig 3', description: 'Rebuild the slide.',
    category: 'calibration', oversight: 'coop',
  });
  id = created.id;
  jobKey = `sess:alpha/${id}/toolu_01`;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'running' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600);
  await wsPush('session:stream', { project: 'alpha', id, chunk: '▸ you ─────\nRegenerate Fig 3.\n' });
  await wsPush('session:stream', { project: 'alpha', id, chunk: '\n[tool: Bash] julia --project=. models/fig3.jl\n' });
  await sleep(400);
});

after(async () => { if (ui) await ui.stop(); });

const readCard = (sel = '.csJobs .jobCard') => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const txt = (q) => el.querySelector(q)?.textContent ?? null;
  const shown = (q) => { const n = el.querySelector(q); return !!n && getComputedStyle(n).display !== 'none'; };
  return {
    state: el.dataset.state, hk: el.dataset.hk,
    stale: el.classList.contains('stale'), expanded: el.classList.contains('expanded'),
    ariaExpanded: el.getAttribute('aria-expanded'),
    stateTxt: txt('.jobState'), health: txt('.jobHealth'), healthShown: shown('.jobHealth'),
    chip: txt('.jobLang'), chipTitle: el.querySelector('.jobLang')?.getAttribute('title'),
    file: txt('.jobFile'), elapsed: txt('.jobElapsed'), staleTag: txt('.jobStale'),
    left: txt('.jpL'), right: txt('.jpR'), rightEst: !!el.querySelector('.jpR .est'),
    trackShown: shown('.jobTrack'), rulerShown: shown('.jobRuler'), rulerOver: el.querySelector('.jobRuler')?.classList.contains('over'),
    barW: el.querySelector('.jobFill')?.style.width,
    fillOpacity: getComputedStyle(el.querySelector('.jobFill')).opacity,
    strip: txt('.jobStats'), cells: [...el.querySelectorAll('.jobCell')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    stopVisible: getComputedStyle(el.querySelector('.jobStop')).display !== 'none',
    indet: !!document.querySelector('.indet'),
    marked: el._marked === true,
  };
}, sel);

test('a session job renders the v3 strip: health word, chip, command, strip cells — no track, no sweep', opts, async () => {
  await wsPush('job:status', { project: 'alpha', job: sessJob() });
  await sleep(300);
  const c = await readCard();
  assert.ok(c, 'card appears in the console');
  assert.equal(c.state, 'running');
  assert.equal(c.hk, 'run');
  assert.equal(c.stateTxt, 'running');
  assert.equal(c.health, 'computing', 'health word: computing');
  assert.equal(c.chip, 'julia');
  assert.equal(c.chipTitle, 'pid 48213 · click to copy', 'pid lives on the chip hover, not on the strip');
  assert.equal(c.file, 'julia --project=. --threads=4 models/fig3.jl --chains 4 --draws 10000');
  assert.equal(c.elapsed, '1m05s');
  assert.equal(c.left, 'no progress info');
  assert.equal(c.right, 'no history yet');
  assert.ok(!c.trackShown && !c.rulerShown, 'no parsed fraction and no history → no track at all');
  assert.ok(!c.indet, 'no .indet anywhere — the decorative sweep is gone');
  assert.deepEqual(c.cells, ['3.2 cores', 'mem 724M ▲1.3G', '3 procs', 'output not visible · session'], 'binary-consistent units: 759,000,000 B = 724 MiB');
  assert.ok(!/pid/.test(c.strip), 'the strip never shows the pid');
  assert.ok(c.stopVisible);
  const chatCards = await page.evaluate(() => document.querySelectorAll('.chatJobSlot .jobCard').length);
  assert.equal(chatCards, 0, 'the running card is not duplicated in the session pane');
});

test('updates PATCH the card in place — same element, no rebuild', opts, async () => {
  await page.evaluate(() => { document.querySelector('.csJobs .jobCard')._marked = true; });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 68000, cores: 3.5 }) });
  await sleep(250);
  const c = await readCard();
  assert.ok(c.marked, 'the DOM element survived the update');
  assert.equal(c.cells[0], '3.5 cores');
  assert.equal(c.elapsed, '1m08s');
});

test('the clock ticks locally between server pushes', opts, async () => {
  const before = (await readCard()).elapsed;
  await sleep(2300);
  const afterTick = (await readCard()).elapsed;
  assert.notEqual(afterTick, before, `clock should advance without a push (${before} → ${afterTick})`);
});

test('the health word owns the band: stalled / io / idle / starting', opts, async () => {
  await wsPush('job:status', { project: 'alpha', job: sessJob({ health: { state: 'stalled', sinceMs: 48000 }, cores: 0.0, progress: { frac: 0.4, iter: 12, total: 30, etaS: null } }) });
  await sleep(200);
  let c = await readCard();
  assert.equal(c.stateTxt, 'stalled 48s', 'STALLED 48s replaces the state word');
  assert.equal(c.hk, 'wait');
  assert.ok(!c.healthShown, 'no second health word beside it');
  assert.equal(c.right, 'ETA — stalled', 'withheld ETA says why');
  assert.equal(c.cells[0], '0.0 cores');

  await wsPush('job:status', { project: 'alpha', job: sessJob({ health: { state: 'io', sinceMs: 3000 }, cores: 0.02 }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.stateTxt, 'running');
  assert.equal(c.health, 'waiting on I/O');
  assert.equal(c.hk, 'blue');

  await wsPush('job:status', { project: 'alpha', job: sessJob({ health: { state: 'idle', sinceMs: 8000 }, cores: 0.01 }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.health, 'idle 8.0s');
  assert.equal(c.hk, 'wait');

  await wsPush('job:status', { project: 'alpha', job: sessJob({ health: { state: 'starting', sinceMs: 300 }, pid: null, elapsedMs: 300, cores: null, coresBasis: null, memBytes: null, memPeakBytes: null, procs: null, threads: null, sampledAt: null }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.stateTxt, 'starting · pid not pinned');
  assert.equal(c.hk, 'queue');
  assert.equal(c.left, 'pid not pinned yet');
  assert.equal(c.right, 'first sample in ≤ 2 s');
  assert.match(c.strip, /no sample yet · pid not pinned/);
  assert.equal(c.chipTitle, 'pid not pinned yet');
  assert.ok(!c.stale, 'a starting card is never stale');
});

test('≈ estimates: parsed progress → bar + ≈ETA; history → dotted ruler + ≈usually; withheld reasons', opts, async () => {
  // parsed fraction + the tool's ETA
  await wsPush('job:status', { project: 'alpha', job: sessJob({ progress: { frac: 0.41, iter: 4120, total: 10000, etaS: 220 }, output: { lines: 12400, rate: 3, last: 'x', owned: true, buffered: false } }) });
  await sleep(250);
  let c = await readCard();
  assert.equal(c.left, 'iter 4,120/10,000 · 41%');
  assert.equal(c.right, '≈ETA 3m40s');
  assert.ok(c.rightEst, 'the ETA wears the ≈ estimate mark (dotted underline)');
  assert.ok(c.trackShown && !c.rulerShown, 'a parsed fraction draws the bar');
  assert.equal(c.barW, '41%');
  assert.equal(c.cells[3], '12.4k ln · 3/s ▶', 'owned output: lines · rate with the ▶ marker');
  // history and no parser → ruler, ≈usually
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 80000, history: { typicalMs: 130000, n: 7 } }) });
  await sleep(250);
  c = await readCard();
  assert.equal(c.left, 'no progress info');
  assert.equal(c.right, '≈usually 2m10s · n=7');
  assert.ok(c.rightEst);
  assert.ok(c.rulerShown && !c.trackShown, 'history without a parsed fraction draws the ruler, not a bar');
  assert.equal(c.rulerOver, false);
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 170000, history: { typicalMs: 130000, n: 7 } }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.rulerOver, true, 'past the usual duration the ruler goes amber');
  // no history → the ruler leaves
  await wsPush('job:status', { project: 'alpha', job: sessJob() });
  await sleep(200);
  c = await readCard();
  assert.ok(!c.rulerShown && !c.trackShown, 'ruler only with history');
  // withheld ETAs: soft total / uneven rate; phase word rides the chip
  await wsPush('job:status', { project: 'alpha', job: sessJob({ phase: { name: 'precompiling', n: 12, m: 38, mSoft: true } }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.left, 'precompiling 12/≈38');
  assert.equal(c.right, 'ETA — total unknown');
  assert.equal(c.chip, 'julia · precompiling');
  await wsPush('job:status', { project: 'alpha', job: sessJob({ phase: { name: 'precompiling', n: 12, m: 38, mSoft: false }, counters: { warnings: 3 } }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.left, 'precompiling 12/38 · 3 warnings');
  assert.equal(c.right, 'ETA — rate uneven');
  assert.equal(c.barW, '31.6%', 'a hard phase n/m is a parsed fraction');
  assert.ok(!c.indet);
});

test('wave-1 counters: lastError renders as "last: file:line:col msg"; coverage, suites failed, todo and go\'s exit status ride the same line', opts, async () => {
  // a cargo build with three errors — the most recent located one is named
  await wsPush('job:status', { project: 'alpha', job: sessJob({ lang: 'rust', command: 'cargo build', phase: { name: 'compiling', n: null, m: null, mSoft: false },
    counters: { errors: 3, lastError: { file: 'src/main.rs', line: 12, col: 5, msg: 'mismatched types' } } }) });
  await sleep(200);
  let c = await readCard();
  assert.equal(c.left, 'compiling · 3 errors · last: src/main.rs:12:5 mismatched types');
  assert.equal(c.chip, 'rust · compiling');
  const lastTitle = await page.evaluate(() => document.querySelector('.csJobs .jobCard .jpLast')?.getAttribute('title'));
  assert.equal(lastTitle, 'src/main.rs:12:5 mismatched types', 'the full diagnostic sits in the hover');
  // go test -cover: coverage + package ok count; jest: suites failed; node:test: todo
  await wsPush('job:status', { project: 'alpha', job: sessJob({ lang: 'go', command: 'go test -cover ./...', phase: { name: 'tests', n: null, m: null, mSoft: false },
    counters: { ok: 4, coverage: 81.3 } }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.left, 'tests · 4 ok · coverage 81.3%');
  await wsPush('job:status', { project: 'alpha', job: sessJob({ lang: 'node', command: 'npm test', phase: { name: 'tests', n: 14, m: 20, mSoft: false },
    counters: { passed: 12, failed: 2, todo: 1, suites: 5, suitesFailed: 2 } }) });
  await sleep(200);
  c = await readCard();
  assert.equal(c.left, 'tests 14/20 · 12 passed · 2 failed · 1 todo · 2 suites failed');
  // a finished go run whose program exited 1: the end summary carries the parsed exit status
  await wsPush('job:status', { project: 'alpha', job: sessJob({ lang: 'go', command: 'go run .', state: 'error', ms: 4200, exit: { code: 1, signal: null, byUser: false }, exitCode: 1,
    counters: { exitStatus: 1, lastError: { file: 'main.go', line: 8, col: 2, msg: 'undefined: foo' } } }) });
  await sleep(200);
  c = await readCard();
  assert.match(c.left, /^✗ exit 1 · last: main\.go:8:2 undefined: foo · program exit 1 · /);
  // back to a plain running card for the tests that follow
  await wsPush('job:status', { project: 'alpha', job: sessJob() });
  await sleep(200);
});

test('stale: numbers grey to --dim (≥ 3:1 on --panel), the clock keeps its ink, the health word hides', opts, async () => {
  await wsPush('job:status', { project: 'alpha', job: sessJob({ stale: true, sampledAt: iso(6000) }) });
  await sleep(250);
  const r = await page.evaluate(() => {
    const el = document.querySelector('.csJobs .jobCard');
    const cs = (n) => getComputedStyle(n).color;
    const probe = document.createElement('span');
    probe.style.color = 'var(--dim)';
    document.body.appendChild(probe);
    const dim = cs(probe);
    probe.remove();
    return {
      stale: el.classList.contains('stale'),
      tag: el.querySelector('.jobStale').textContent,
      healthShown: getComputedStyle(el.querySelector('.jobHealth')).display !== 'none',
      coresColor: cs(el.querySelector('.jobCell.cores b')),
      memColor: cs(el.querySelectorAll('.jobCell b')[1]),
      elapsedColor: cs(el.querySelector('.jobElapsed')),
      opacity: getComputedStyle(el).opacity,
      dim,
    };
  });
  assert.ok(r.stale);
  assert.match(r.tag, /^stale 6\.\ds$/);
  assert.ok(!r.healthShown, 'a stale sample has no health');
  assert.equal(r.coresColor, r.dim, 'cores greyed to --dim');
  assert.equal(r.memColor, r.dim, 'mem greyed to --dim');
  assert.notEqual(r.elapsedColor, r.dim, 'elapsed is not greyed');
  assert.equal(r.opacity, '1', 'never an opacity fade');
  // --dim on --panel clears 3:1 in BOTH themes
  const contrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const read = () => {
      const a = document.createElement('span'); a.style.color = 'var(--dim)';
      const b = document.createElement('span'); b.style.backgroundColor = 'var(--panel)';
      document.body.append(a, b);
      const out = [getComputedStyle(a).color, getComputedStyle(b).backgroundColor];
      a.remove(); b.remove();
      return out;
    };
    const ratio = ([fg, bg]) => { const l1 = lum(fg), l2 = lum(bg); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const dark = ratio(read());
    document.documentElement.dataset.theme = 'light';
    const light = ratio(read());
    delete document.documentElement.dataset.theme;
    return { dark, light };
  });
  assert.ok(contrast.dark >= 3, `--dim on --panel (dark) ${contrast.dark.toFixed(2)}:1`);
  assert.ok(contrast.light >= 3, `--dim on --panel (light) ${contrast.light.toFixed(2)}:1`);
  // fresh sample → the tag leaves, numbers regain their ink
  await wsPush('job:status', { project: 'alpha', job: sessJob() });
  await sleep(200);
  const c = await readCard();
  assert.ok(!c.stale && c.staleTag === '' && c.healthShown);
});

test('the expanded card: click toggles, aria-expanded, two sparklines, phase timeline, copyable pid, Escape collapses', opts, async () => {
  // a few samples so the sparklines have shape, a phase change and a stall window
  for (let i = 0; i < 6; i++) {
    await wsPush('job:status', { project: 'alpha', job: sessJob({
      elapsedMs: 70000 + i * 2000, sampledAt: iso(500), cores: 2 + i * 0.3, memBytes: 7e8 + i * 1e7,
      phase: i < 3 ? { name: 'precompiling', n: 10 + i, m: 38, mSoft: false } : null,
      health: i === 4 ? { state: 'stalled', sinceMs: 21000 } : { state: 'computing', sinceMs: 1000 },
      output: { lines: 100 + i, rate: 1, last: `line ${i}`, owned: true, buffered: false },
    }) });
    await sleep(40);
  }
  await page.click('.csJobs .jobCard .jobFile');
  await sleep(250);
  let x = await page.evaluate(() => {
    const el = document.querySelector('.csJobs .jobCard');
    const X = el.querySelector('.jobX');
    return {
      expanded: el.classList.contains('expanded'), aria: el.getAttribute('aria-expanded'),
      xShown: getComputedStyle(X).display !== 'none',
      svgs: X.querySelectorAll('svg').length,
      polylines: X.querySelectorAll('polyline').length,
      phases: [...X.querySelectorAll('.phBar .ph:not(.hatch)')].map((p) => p.getAttribute('title')),
      hatch: X.querySelectorAll('.phBar .ph.hatch').length,
      cap: X.querySelector('.phCap').textContent,
      tail: [...X.querySelectorAll('.xTailBox div')].map((d) => d.textContent),
      pidBtn: X.querySelector('.pidBtn')?.textContent,
      proc: X.querySelector('.xTree .xH b')?.textContent,
      foot: X.querySelector('.xFoot').textContent,
      fileWraps: getComputedStyle(el.querySelector('.jobFile')).whiteSpace,
    };
  });
  assert.ok(x.expanded && x.aria === 'true' && x.xShown, 'click anywhere on the strip expands');
  assert.equal(x.svgs, 2, 'two inline-SVG sparklines (cores, mem)');
  assert.equal(x.polylines, 2);
  assert.ok(x.phases.some((t) => /^start /.test(t)) && x.phases.some((t) => /^precompiling /.test(t)) && x.phases.some((t) => /^running /.test(t)), `phase timeline from phase.name changes: ${x.phases}`);
  // two windows: the 48 s stall from the health test above and this 21 s one
  assert.ok(x.hatch >= 1, 'stalled windows are hatched');
  assert.match(x.cap, /stalled 1m09s/, 'the caption sums the stalled windows');
  assert.deepEqual(x.tail, ['line 3', 'line 4', 'line 5'], 'last 3 output lines');
  assert.equal(x.pidBtn, 'pid 48213 ⧉');
  assert.equal(x.proc, '3 procs · 9 thr');
  assert.match(x.foot, /started \d+:\d\d/);
  assert.match(x.foot, /sampled \d+\.\ds ago · poll 2\.0s/);
  // a patch keeps it open and refreshes the plots without collapsing
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 84000, sampledAt: iso(300) }) });
  await sleep(200);
  x = await page.evaluate(() => ({ expanded: document.querySelector('.csJobs .jobCard').classList.contains('expanded'), marked: document.querySelector('.csJobs .jobCard')._marked }));
  assert.ok(x.expanded, 'expanded state persists across patches');
  assert.ok(x.marked, 'still the same element');
  // Escape collapses (the card is focused after the click)
  await page.focus('.csJobs .jobCard');
  await page.keyboard.press('Escape');
  await sleep(200);
  const c = await readCard();
  assert.ok(!c.expanded && c.ariaExpanded === 'false', 'Escape collapses');
  const xShown = await page.evaluate(() => getComputedStyle(document.querySelector('.csJobs .jobX')).display !== 'none');
  assert.ok(!xShown);
});

test('the card never flickers: no entrance replays across streams, patches, and prompt sends', opts, async () => {
  // The reported bug: sending a prompt while code ran made the card
  // "disappear then reappear" — renderWB re-inserted the kept console
  // (restarting the one-shot jobIn entrance). Count jobIn restarts from here
  // on: any replay is a visible blink and fails this test.
  await page.evaluate(() => {
    window.__jobInReplays = 0;
    document.addEventListener('animationstart', (e) => {
      if (e.animationName === 'jobIn') window.__jobInReplays++;
    }, true);
  });
  for (const c of ['∴ thinking…\n', 'solving the model, output pending…\n'.repeat(6)]) {
    await wsPush('session:stream', { project: 'alpha', id, chunk: c });
    await sleep(60);
  }
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 90000, cores: 3.4 }) });
  await sleep(250);
  const dipPromise = page.evaluate(async () => {
    const el = document.querySelector('.csJobs .jobCard');
    let min = 1;
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      min = Math.min(min, parseFloat(getComputedStyle(el).opacity));
      await new Promise((r) => requestAnimationFrame(r));
    }
    return min;
  });
  await page.fill('#composerInput', 'How is the fit looking so far?');
  await page.press('#composerInput', 'Enter');
  const minOpacity = await dipPromise;
  await wsPush('task:update', { project: 'alpha', task: { id, status: 'running', title: 'Regenerate Fig 3', project: 'alpha' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await sleep(300);
  const replays = await page.evaluate(() => window.__jobInReplays);
  assert.equal(replays, 0, 'the entrance animation never replays after first appearance');
  assert.equal(minOpacity, 1, 'the card stays fully visible through a prompt send');
  assert.ok(await readCard(), 'card still present and patched');
});

test('an OLD event (cpu/mem only) still renders — labelled % / rss — and never throws', opts, async () => {
  const oldKey = `sess:alpha/${id}/toolu_old`;
  await wsPush('job:status', { project: 'alpha', job: {
    key: oldKey, source: 'session', project: 'alpha', taskId: id,
    file: 'old.R', lang: 'r', command: 'Rscript old.R', state: 'running', stopping: false,
    startedAt: iso(20000), elapsedMs: 20000, pid: 777, cpu: 340, mem: 2.1e9,
    progress: null, quietMs: null, exitCode: null, ms: null,
  } });
  await sleep(250);
  const c = await readCard(`.csJobs .jobCard[data-jobkey="${oldKey}"]`);
  assert.ok(c, 'the old-shape card renders');
  assert.equal(c.stateTxt, 'running');
  assert.equal(c.health, '', 'no health word without a health field');
  assert.deepEqual(c.cells, ['340%', 'rss 2.0G'], 'legacy cpu labelled %, legacy mem labelled rss');
  assert.equal(c.left, 'no progress info');
  assert.ok(!c.trackShown && !c.rulerShown && !c.indet);
  assert.equal(c.chipTitle, 'pid 777 · click to copy');
  // and its expanded card copes with an empty history
  await page.click(`.csJobs .jobCard[data-jobkey="${oldKey}"] .jobFile`);
  await sleep(200);
  const x = await page.evaluate((k) => {
    const X = document.querySelector(`.csJobs .jobCard[data-jobkey="${k}"] .jobX`);
    return { shown: getComputedStyle(X).display !== 'none', sp: X.querySelectorAll('.spBox').length, cpuLbl: X.querySelector('.spLbl em')?.textContent };
  }, oldKey);
  assert.ok(x.shown && x.sp === 2);
  assert.equal(x.cpuLbl, 'cpu', 'legacy cpu keeps its % label in the expanded card');
  await page.keyboard.press('Escape');
  await wsPush('job:status', { project: 'alpha', job: { key: oldKey, source: 'session', project: 'alpha', taskId: id, file: 'old.R', lang: 'r', command: 'Rscript old.R', state: 'done', exitCode: 0, ms: 21000, startedAt: iso(21000), elapsedMs: 21000, pid: 777, cpu: 0, mem: 2.1e9 } });
  await sleep(200);
  const d = await readCard(`.csJobs .jobCard[data-jobkey="${oldKey}"]`);
  assert.equal(d.stateTxt, 'done');
  assert.equal(d.left, '✓ 21s');
  assert.equal(pageErrors.length, 0, `no page errors: ${pageErrors.join(' | ')}`);
});

test('nullable telemetry stays unknown and a missing terminal ms falls back to elapsedMs', opts, async () => {
  const result = await page.evaluate(async () => {
    const { absorbJob, syncJobCards, jobFeedRow } = await import('/jobs.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const job = { key: 'review:null', project: 'alpha', source: 'session', state: 'running',
      startedAt: '2026-01-01T00:00:00Z', elapsedMs: 45000, ms: null, pid: 123,
      cores: null, cpu: null, mem: null, memBytes: null, memPeakBytes: null,
      procs: null, threads: null, cpuTimeMs: null,
      health: { state: 'idle', sinceMs: 2000 }, _recvAt: performance.now() };
    syncJobCards(host, [absorbJob(undefined, job)]);
    host.firstElementChild.click();
    const unknown = host.querySelector('.jobX').textContent;
    const terminal = jobFeedRow({ ...job, state: 'done' }).html;
    const measured = absorbJob(undefined, { ...job, key: 'review:zero', cores: 0, memBytes: 0, procs: 0, threads: 0 });
    syncJobCards(host, [measured]);
    host.firstElementChild.click();
    const zero = host.querySelector('.jobX').textContent;
    host.remove();
    return { unknown, terminal, zero };
  });
  assert.match(result.unknown, /mem—▲ peak —/);
  assert.match(result.unknown, /process— procs/);
  assert.doesNotMatch(result.unknown, /0 procs|0 thr|0B|one sample/);
  assert.match(result.terminal, /45s/);
  assert.doesNotMatch(result.terminal, /cpu 0\.0×/);
  assert.match(result.zero, /mem0B/);
  assert.match(result.zero, /0 procs · 0 thr/, 'measured zero is distinct from unknown');
});

test('a reused run key resets history, expansion, progress and stopping controls at a new startedAt', opts, async () => {
  const result = await page.evaluate(async () => {
    const { absorbJob, syncJobCards } = await import('/jobs.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    const a = absorbJob(undefined, { key: 'review:reuse', project: 'alpha', source: 'run', state: 'running',
      startedAt: '2026-01-01T00:00:00Z', elapsedMs: 45000, pid: 1, cores: 8, memBytes: 9000,
      phase: { name: 'compiling' }, progress: { frac: 0.8 }, output: { owned: true, last: 'OLD OUTPUT' }, _recvAt: performance.now() });
    syncJobCards(host, [a]);
    host.firstElementChild.click();
    host.querySelector('.jobStop').disabled = true;
    host.querySelector('.jobStop').textContent = 'stopping…';
    const oldElement = host.firstElementChild;
    const b = absorbJob(a, { ...a, startedAt: '2026-01-01T00:01:00Z', elapsedMs: 100, pid: 2,
      cores: 1, memBytes: 100, phase: { name: 'testing' }, progress: null, output: { owned: true, last: 'NEW OUTPUT' } });
    syncJobCards(host, [b]);
    const out = { history: b._hist, replaced: host.firstElementChild !== oldElement,
      expanded: host.firstElementChild.classList.contains('expanded'),
      disabled: host.querySelector('.jobStop').disabled, stop: host.querySelector('.jobStop').textContent,
      barHidden: host.querySelector('.jobTrack').classList.contains('off') };
    host.remove(); return out;
  });
  assert.deepEqual(result.history.cores, [1]);
  assert.deepEqual(result.history.mem, [100]);
  assert.deepEqual(result.history.t, [100]);
  assert.deepEqual(result.history.prog, []);
  assert.deepEqual(result.history.tail, ['NEW OUTPUT']);
  assert.deepEqual(result.history.phases.map(p => p.name), ['start', 'testing']);
  assert.equal(result.replaced, true);
  assert.equal(result.expanded, false);
  assert.equal(result.disabled, false);
  assert.equal(result.stop, '⊘ stop');
  assert.equal(result.barHidden, true);
});

test('failed Stop can retry; an older response never disables or relabels a replacement run', opts, async () => {
  let held;
  const routeHandler = route => { held = route; };
  await page.route('**/api/jobs/alpha/stop', routeHandler);
  await page.evaluate(async () => {
    const { absorbJob, syncJobCards } = await import('/jobs.js');
    const host = document.createElement('div'); host.id = 'reviewStop'; document.body.appendChild(host);
    const job = { key: 'review:stop', project: 'alpha', source: 'run', state: 'running',
      startedAt: '2026-01-01T00:00:00Z', elapsedMs: 100, pid: 1, _recvAt: performance.now() };
    window.__reviewStopJob = job;
    syncJobCards(host, [absorbJob(undefined, job)]);
  });
  try {
    await page.click('#reviewStop .jobStop');
    await held.fulfill({ status: 503, json: { error: 'temporary failure' } });
    await page.waitForFunction(() => !document.querySelector('#reviewStop .jobStop').disabled);
    assert.equal(await page.textContent('#reviewStop .jobStop'), '⊘ stop');
    await page.click('#reviewStop .jobStop');
    await page.evaluate(async () => {
      const { absorbJob, syncJobCards } = await import('/jobs.js');
      const old = window.__reviewStopJob;
      syncJobCards(document.querySelector('#reviewStop'), [absorbJob(old, { ...old, startedAt: '2026-01-01T00:01:00Z', pid: 2 })]);
    });
    await held.fulfill({ status: 409, json: { error: 'old run is no longer current' } });
    assert.equal(await page.isDisabled('#reviewStop .jobStop'), false);
    assert.equal(await page.textContent('#reviewStop .jobStop'), '⊘ stop');
  } finally {
    await page.unroute('**/api/jobs/alpha/stop', routeHandler);
    await page.evaluate(() => document.querySelector('#reviewStop')?.remove());
  }
});

test('both the terminal hold timer and in-flight fade are fenced to their original invocation', opts, async () => {
  await page.clock.install();
  try {
    await page.evaluate(async () => {
      const { absorbJob, scheduleJobFade, syncJobCards } = await import('/jobs.js');
      const { jobsLive } = await import('/store.js');
      const host = document.createElement('div'); host.id = 'reviewFade'; document.body.appendChild(host);
      const a = { key: 'review:fade', project: 'alpha', source: 'run', state: 'done',
        startedAt: '2026-01-01T00:00:00Z', elapsedMs: 100, ms: 100, _recvAt: performance.now() };
      jobsLive[a.key] = absorbJob(undefined, a); syncJobCards(host, [a]); scheduleJobFade(a);
      const b = { ...a, startedAt: '2026-01-01T00:01:00Z', state: 'running', ms: null };
      jobsLive[b.key] = absorbJob(a, b); syncJobCards(host, [b]);
    });
    await page.clock.fastForward(7000);
    assert.equal(await page.evaluate(async () => (await import('/store.js')).jobsLive['review:fade']?.state), 'running');
    await page.evaluate(async () => {
      const { scheduleJobFade, syncJobCards } = await import('/jobs.js');
      const { jobsLive } = await import('/store.js');
      const job = jobsLive['review:fade']; job.state = 'done'; job.ms = 100;
      syncJobCards(document.querySelector('#reviewFade'), [job]); scheduleJobFade(job);
    });
    await page.clock.fastForward(6001);
    assert.equal(await page.locator('#reviewFade .jobCard.gone').count(), 1);
    await page.evaluate(async () => {
      const { absorbJob, syncJobCards } = await import('/jobs.js');
      const { jobsLive } = await import('/store.js');
      const prev = jobsLive['review:fade'];
      const next = { ...prev, startedAt: '2026-01-01T00:02:00Z', state: 'running', ms: null };
      jobsLive[next.key] = absorbJob(prev, next); syncJobCards(document.querySelector('#reviewFade'), [next]);
    });
    await page.clock.fastForward(500);
    assert.equal(await page.evaluate(async () => (await import('/store.js')).jobsLive['review:fade']?.startedAt), '2026-01-01T00:02:00Z');
    assert.equal(await page.locator('#reviewFade .jobCard.gone').count(), 0);
    assert.equal(await page.evaluate(async () => !!(await import('/jobs.js')).jobsEnded['review:fade']), false);
  } finally {
    await page.evaluate(async () => {
      delete (await import('/store.js')).jobsLive['review:fade'];
      document.querySelector('#reviewFade')?.remove();
    });
    await page.clock.setSystemTime(new Date());
    await page.clock.resume();
  }
});

test('⊘ stop posts the job key and shows the stopping state', opts, async () => {
  await page.click(`.csJobs .jobCard[data-jobkey="${jobKey}"] .jobStop`);
  await sleep(200);
  assert.deepEqual(stopPosts, [{ key: jobKey, startedAt: SESSION_START }]);
  const btnTxt = await page.evaluate((k) => document.querySelector(`.csJobs .jobCard[data-jobkey="${k}"] .jobStop`)?.textContent, jobKey);
  assert.equal(btnTxt, 'stopping…');
  await wsPush('job:status', { project: 'alpha', job: sessJob({ stopping: true }) });
  await sleep(200);
  const c = await readCard();
  assert.equal(c.stateTxt, 'stopping…');
  assert.equal(c.hk, 'yellow');
});

test('a ▶ run job: honest bar, iter counter, ≈ETA, owned output cell; clicking the stop button never expands', opts, async () => {
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'models/fig3.jl', cmdLine: 'julia fig3.jl', state: 'running', startedAt: new Date().toISOString(), ms: null, exitCode: null, bytes: 0 },
  });
  await sleep(400);
  await page.click('.sessTabs .stab.runT');
  await sleep(300);
  await wsPush('job:status', { project: 'alpha', job: runJob() });
  await sleep(300);
  const c = await readCard('.runJobSlot .jobCard');
  assert.ok(c, 'card mounts in the ▶ output slot');
  assert.ok(c.trackShown, 'parsed progress → honest bar');
  assert.equal(c.barW, '42%');
  assert.equal(c.left, 'iter 210/500 · 42%');
  assert.equal(c.right, '≈ETA 4m00s');
  assert.ok(c.rightEst);
  assert.deepEqual(c.cells, ['1.8 cores', 'mem 477M ▲496M', '1 proc', '12.4k ln · 3.1/s ▶']);
  assert.ok(!c.indet);
  await page.click('.runJobSlot .jobCard .jobStop');
  await sleep(150);
  const after = await readCard('.runJobSlot .jobCard');
  assert.ok(!after.expanded, 'the stop button does not toggle the card');
  assert.deepEqual(stopPosts.at(-1), { key: 'run:alpha', startedAt: RUN_START });
});

test('background + detached + notebook chips; the turn ends → detached becomes a LIVE feed row with ⊘ stop', opts, async () => {
  await page.click('.sessTabs .stab:not(.runT)');
  await sleep(300);
  const bgKey = `sess:alpha/${id}/toolu_bg`;
  const detKey = `sess:alpha/${id}/toolu_det`;
  await wsPush('job:status', { project: 'alpha', job: sessJob({ key: bgKey, bg: true, file: 'dl/01_download.R', lang: 'r', command: 'Rscript dl/01_download.R' }) });
  await wsPush('job:status', { project: 'alpha', job: sessJob({
    key: detKey, detached: true, file: 'sim.jl', lang: 'julia', command: 'nohup julia sim.jl &',
    elapsedMs: 520000, startedAt: iso(520000), progress: { frac: 0.86, iter: 860, total: 1000, etaS: 120 },
    output: { lines: 6800, rate: 12, last: 'iter 860/1000', owned: true, buffered: false },
  }) });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ key: `sess:alpha/${id}/toolu_nb`, file: 'replicate_all.ipynb', lang: 'notebook', command: 'jupyter nbconvert --execute replicate_all.ipynb' }) });
  await sleep(350);
  const chips = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.csJobs .jobCard')].map((el) => [el.querySelector('.jobFile').textContent, el.querySelector('.jobLang').textContent])));
  assert.equal(chips['Rscript dl/01_download.R'], 'R · background');
  assert.equal(chips['nohup julia sim.jl &'], 'julia · detached');
  assert.equal(chips['jupyter nbconvert --execute replicate_all.ipynb'], 'notebook');

  const { body: tw } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'waiting' });
  await wsPush('task:update', { project: 'alpha', task: tw });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(400);
  const after = await page.evaluate(() => ({
    states: Object.fromEntries([...document.querySelectorAll('.csJobs .jobCard')].map((el) => [el.dataset.jobkey, el.dataset.state])),
    live: [...document.querySelectorAll('.csJobFeed .jobFeedRow.live')].map((r) => ({
      key: r.dataset.jobkey, txt: [...r.children].map((c) => c.textContent.trim()).join(' '), est: !!r.querySelector('.est'), stop: !!r.querySelector('.jfAct.stop'),
    })),
    chatCards: document.querySelectorAll('.chatJobSlot .jobCard').length,
  }));
  assert.equal(after.states[detKey], undefined, 'after the turn the detached card collapses to its feed row');
  assert.notEqual(after.states[bgKey], 'running', 'background card ends with the turn');
  assert.equal(after.live.length, 1, 'one live feed row: the detached job');
  assert.equal(after.live[0].key, detKey);
  assert.match(after.live[0].txt, /^▶ julia · detached sim\.jl still running · 86% · 8m4\ds · ≈2m00s left ⊘ stop$/);
  assert.ok(after.live[0].est && after.live[0].stop);
  assert.equal(after.chatCards, 0);
  // the live row updates from job:status and its ⊘ stop uses the same route
  await wsPush('job:status', { project: 'alpha', job: sessJob({ key: detKey, detached: true, file: 'sim.jl', lang: 'julia', command: 'nohup julia sim.jl &', elapsedMs: 530000, progress: { frac: 0.9, iter: 900, total: 1000, etaS: 100 } }) });
  await sleep(200);
  const row = await page.evaluate(() => document.querySelector('.csJobFeed .jobFeedRow.live .jfSum')?.textContent);
  assert.match(row, /90% · 8m5\ds · ≈1m40s left/);
  await page.click('.csJobFeed .jobFeedRow.live .jfAct.stop');
  await sleep(150);
  assert.deepEqual(stopPosts.at(-1), { key: detKey, startedAt: SESSION_START });
  // the detached job ends: its live row becomes an end-summary row (after the fade)
  await wsPush('job:status', { project: 'alpha', job: sessJob({ key: detKey, detached: true, file: 'sim.jl', lang: 'julia', command: 'nohup julia sim.jl &', state: 'stopped', ms: 540000, exit: { code: null, signal: 'SIGTERM', byUser: true }, progress: { frac: 0.9, iter: 900, total: 1000, etaS: null }, memPeakBytes: 1.4e9 }) });
  const { body: tr2 } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'running' });
  await wsPush('task:update', { project: 'alpha', task: tr2 });
  await sleep(7000); // terminal cards fade out
  const rows = await page.evaluate(() => [...document.querySelectorAll('.csJobFeed .jobFeedRow')].map((r) => [r.dataset.jobkey, r.className, r.querySelector('.jfSum').textContent]));
  const det = rows.find((r) => r[0] === detKey);
  assert.ok(det, 'the detached job left a feed row');
  assert.equal(det[1], 'jobFeedRow stop');
  assert.equal(det[2], 'stopped by you at 90% · peak 1.3G');
});

test('terminal states: ✓ done / ✗ failed / ⊘ stopped end summaries, frozen bar, then feed rows', opts, async () => {
  const doneKey = `sess:alpha/${id}/toolu_done`;
  const failKey = `sess:alpha/${id}/toolu_fail`;
  const oomKey = `sess:alpha/${id}/toolu_oom`;
  const stopKey = `sess:alpha/${id}/toolu_stop`;
  const base = { output: { lines: 208, rate: 0, last: 'x', owned: true, buffered: false } };
  await wsPush('job:status', { project: 'alpha', job: sessJob({ ...base, key: doneKey, file: 'fit_model.jl', command: 'julia fit_model.jl', progress: { frac: 0.7, iter: 7, total: 10, etaS: 10 } }) });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ ...base, key: failKey, file: 'tests/', lang: 'python', command: 'pytest tests/ --maxfail=5' }) });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ ...base, key: oomKey, file: 'train.py', lang: 'python', command: 'python scripts/train.py --epochs 30', progress: { frac: 0.23, iter: null, total: null, etaS: null } }) });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ ...base, key: stopKey, file: 'sync', lang: 'shell', command: 'rsync -avz cluster:/scratch data/', progress: { frac: 0.61, iter: null, total: null, etaS: null } }) });
  await sleep(300);
  const t = (over) => sessJob({ ...base, ...over, sampledAt: iso(100) });
  await wsPush('job:status', { project: 'alpha', job: t({ key: doneKey, file: 'fit_model.jl', command: 'julia fit_model.jl', state: 'done', ms: 272000, exit: { code: 0, signal: null, byUser: false }, exitCode: 0, memPeakBytes: 1.4e9 * 1024 / 1000, cpuTimeMs: 843000, progress: { frac: 1, iter: 10, total: 10, etaS: null }, output: { lines: 12400, rate: 0, last: 'x', owned: true, buffered: false } }) });
  await wsPush('job:status', { project: 'alpha', job: t({ key: failKey, file: 'tests/', lang: 'python', command: 'pytest tests/ --maxfail=5', state: 'error', ms: 41200, exit: { code: 1, signal: null, byUser: false }, exitCode: 1, memPeakBytes: 340 * 1024 * 1024, cpuTimeMs: 37000, counters: { passed: 138, failed: 2, skipped: 3 } }) });
  await wsPush('job:status', { project: 'alpha', job: t({ key: oomKey, file: 'train.py', lang: 'python', command: 'python scripts/train.py --epochs 30', state: 'error', ms: 724000, exit: { code: null, signal: 'SIGKILL', byUser: false }, exitCode: null, memPeakBytes: 14.2 * 1024 ** 3, cpuTimeMs: 724000, progress: { frac: 0.23, iter: null, total: null, etaS: null } }) });
  await wsPush('job:status', { project: 'alpha', job: t({ key: stopKey, file: 'sync', lang: 'shell', command: 'rsync -avz cluster:/scratch data/', state: 'stopped', ms: 80000, exit: { code: null, signal: 'SIGTERM', byUser: true }, memPeakBytes: 24 * 1024 * 1024, cpuTimeMs: 4000, progress: { frac: 0.61, iter: null, total: null, etaS: null } }) });
  await sleep(300);
  const cards = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.csJobs .jobCard')].map((el) => [el.dataset.jobkey, {
    state: el.dataset.state, hk: el.dataset.hk, stateTxt: el.querySelector('.jobState').textContent,
    left: el.querySelector('.jpL').textContent, right: el.querySelector('.jpR').textContent,
    barW: el.querySelector('.jobFill').style.width, trackShown: getComputedStyle(el.querySelector('.jobTrack')).display !== 'none',
    fillOpacity: getComputedStyle(el.querySelector('.jobFill')).opacity,
    cells: [...el.querySelectorAll('.jobCell')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    stopVisible: getComputedStyle(el.querySelector('.jobStop')).display !== 'none',
  }])));
  const done = cards[doneKey], fail = cards[failKey], oom = cards[oomKey], stop = cards[stopKey];
  assert.equal(done.stateTxt, 'done');
  assert.equal(done.hk, 'run');
  assert.equal(done.left, '✓ 4m32s · peak 1.3G · cpu 3.1×');
  assert.equal(done.barW, '100%');
  assert.equal(done.fillOpacity, '0.6', 'the bar freezes at 60 % opacity');
  assert.deepEqual(done.cells, ['peak 1.3G', 'cpu 3.1×', '12.4k ln']);
  assert.ok(!done.stopVisible);
  assert.equal(fail.stateTxt, 'failed · exit 1');
  assert.equal(fail.hk, 'red');
  assert.equal(fail.left, '✗ exit 1 · 138 passed · 2 failed · 3 skipped · 41s · peak 340M');
  assert.ok(!fail.trackShown, 'no bar if there was none');
  assert.equal(oom.stateTxt, 'failed · SIGKILL · often out of memory');
  assert.equal(oom.left, '✗ SIGKILL · often out of memory · 12m04s · peak 14.2G');
  assert.equal(oom.barW, '23%', 'the bar freezes where it was');
  assert.ok(oom.trackShown);
  assert.equal(stop.stateTxt, 'stopped · by you');
  assert.equal(stop.hk, 'yellow');
  assert.equal(stop.left, '⊘ stopped by you at 61% · peak 24M');
  assert.equal(stop.barW, '61%');
  assert.equal(done.right, '', 'the end summary owns the whole progress line');
  // fade → feed rows
  await sleep(7000);
  const feed = await page.evaluate(() => ({
    cards: document.querySelectorAll('.csJobs .jobCard').length,
    rows: Object.fromEntries([...document.querySelectorAll('.csJobFeed .jobFeedRow')].map((r) => [r.dataset.jobkey, {
      cls: r.className, txt: [...r.children].map((c) => c.textContent.trim()).join(' '), sum: r.querySelector('.jfSum').textContent, time: r.querySelector('.jfTime')?.textContent,
    }])),
    indet: !!document.querySelector('.indet'),
  }));
  assert.equal(feed.cards, 0, 'every terminal card left the layout');
  assert.ok(!feed.indet);
  assert.equal(feed.rows[doneKey].cls, 'jobFeedRow ok');
  assert.match(feed.rows[doneKey].txt, /^✓ julia fit_model\.jl 4m32s · peak 1\.3G · cpu 3\.1× \d+:\d\d/);
  assert.equal(feed.rows[failKey].cls, 'jobFeedRow bad');
  assert.equal(feed.rows[failKey].sum, 'exit 1 · 138 passed · 2 failed · 3 skipped · 41s · peak 340M');
  assert.equal(feed.rows[oomKey].sum, 'SIGKILL · often out of memory · 12m04s · peak 14.2G');
  assert.equal(feed.rows[stopKey].cls, 'jobFeedRow stop');
  assert.equal(feed.rows[stopKey].sum, 'stopped by you at 61% · peak 24M');
  assert.match(feed.rows[doneKey].time, /^\d+:\d\d/);
  // the ▶ run's card fades into a feed row in its slot, with an "output" action
  await page.click('.sessTabs .stab.runT');
  await sleep(300);
  await wsPush('job:status', { project: 'alpha', job: runJob({ state: 'done', ms: 45000, exit: { code: 0, signal: null, byUser: false }, exitCode: 0, progress: { frac: 1, iter: 500, total: 500, etaS: null }, cpuTimeMs: 140000 }) });
  await sleep(300);
  const rc = await readCard('.runJobSlot .jobCard');
  assert.equal(rc.state, 'done');
  assert.equal(rc.left, '✓ 45s · peak 496M · cpu 3.1×');
  assert.equal(rc.barW, '100%');
  assert.ok(!rc.stopVisible);
  await sleep(7000);
  const slot = await page.evaluate(() => ({
    card: !!document.querySelector('.runJobSlot .jobCard'),
    row: [...(document.querySelector('.runJobSlot .jobFeedRow')?.children || [])].map((c) => c.textContent.trim()).join(' '),
    out: !!document.querySelector('.runJobSlot .jobFeedRow .jfAct.out'),
  }));
  assert.ok(!slot.card, 'card left the layout after its farewell');
  assert.match(slot.row, /^✓ julia fig3\.jl 45s · peak 496M · cpu 3\.1×/);
  assert.ok(slot.out, 'a ▶ run row offers "output"');
  assert.equal(pageErrors.length, 0, `no page errors: ${pageErrors.join(' | ')}`);
});
