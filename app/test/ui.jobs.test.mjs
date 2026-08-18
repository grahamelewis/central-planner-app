// The live job card in the real frontend (headless Chrome, stubbed WS).
// Guards the properties that make it feel smooth:
//   · the card is built ONCE and patched — the progress bar's width transition
//     and the ticking clock must never be reset by an innerHTML rebuild
//   · session jobs (no output access) show the indeterminate sweep; ▶ run
//     jobs show an honest width + iter/ETA
//   · ⊘ stop posts the job key to /api/jobs/:project/stop
//   · a finished card holds its terminal state, then fades away
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

const sessJob = (over = {}) => ({
  key: jobKey, source: 'session', project: 'alpha', taskId: id,
  file: 'models/fig3.jl', lang: 'julia', command: 'julia --project=. models/fig3.jl',
  state: 'running', stopping: false,
  startedAt: new Date(Date.now() - 65000).toISOString(),
  elapsedMs: 65000, pid: 48213, cpu: 340, mem: 2.1e9,
  progress: null, quietMs: null, exitCode: null, ms: null, ...over,
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

const card = () => page.evaluate(() => {
  const el = document.querySelector('.csJobs .jobCard');
  if (!el) return null;
  return {
    state: el.dataset.state,
    stateTxt: el.querySelector('.jobState')?.textContent,
    file: el.querySelector('.jobFile')?.textContent,
    lang: el.querySelector('.jobLang')?.textContent,
    elapsed: el.querySelector('.jobElapsed')?.textContent,
    cpu: el.querySelector('.jobCpu')?.textContent,
    mem: el.querySelector('.jobMem')?.textContent,
    memShown: !!el.querySelector('.jsMem.on'),
    quietShown: !!el.querySelector('.jsQuiet.on'),
    indet: el.querySelector('.jobFill')?.classList.contains('indet'),
    barW: el.querySelector('.jobFill')?.style.width,
    iter: el.querySelector('.jobIter')?.textContent,
    meta: el.querySelector('.jobMeta')?.textContent,
    stopVisible: getComputedStyle(el.querySelector('.jobStop')).display !== 'none',
    marked: el._marked === true,
  };
});

test('a session job renders the full card: stats, sweep bar, pid, stop', opts, async () => {
  await wsPush('job:status', { project: 'alpha', job: sessJob() });
  await sleep(300);
  const c = await card();
  assert.ok(c, 'card appears in the console');
  assert.equal(c.state, 'running');
  assert.equal(c.file, 'models/fig3.jl');
  assert.equal(c.lang, 'julia');
  assert.equal(c.elapsed, '1m05s');
  assert.equal(c.cpu, '340%');
  assert.equal(c.mem, '2.1G');
  assert.ok(c.memShown);
  assert.ok(!c.quietShown, 'session jobs have no quiet clock');
  assert.ok(c.indet, 'no output access → indeterminate sweep');
  assert.match(c.meta, /pid 48213/);
  assert.ok(c.stopVisible);
  // the card lives ONLY in the console — it is deliberately NOT duplicated in
  // the session pane (the session pane just points to the console)
  const chatCards = await page.evaluate(() =>
    document.querySelectorAll('.chatJobSlot .jobCard').length);
  assert.equal(chatCards, 0, 'the running card is not duplicated in the session pane');
});

test('updates PATCH the card in place — same element, no rebuild', opts, async () => {
  await page.evaluate(() => { document.querySelector('.csJobs .jobCard')._marked = true; });
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 68000, cpu: 355 }) });
  await sleep(250);
  const c = await card();
  assert.ok(c.marked, 'the DOM element survived the update');
  assert.equal(c.cpu, '355%');
  assert.equal(c.elapsed, '1m08s');
});

test('the clock ticks locally between server pushes', opts, async () => {
  const before = (await card()).elapsed;
  await sleep(2300);
  const afterTick = (await card()).elapsed;
  assert.notEqual(afterTick, before, `clock should advance without a push (${before} → ${afterTick})`);
});

test('the card never flickers: no entrance replays across streams, patches, and prompt sends', opts, async () => {
  // The reported bug: sending a prompt while code ran (turn streaming, verb
  // showing) made the card "disappear then reappear" — renderWB re-inserted
  // the kept console (restarting the one-shot jobIn entrance), and the strip
  // elements were re-appended on every pump frame. Count jobIn restarts from
  // here on: any replay is a visible blink and fails this test.
  await page.evaluate(() => {
    window.__jobInReplays = 0;
    document.addEventListener('animationstart', (e) => {
      if (e.animationName === 'jobIn') window.__jobInReplays++;
    }, true);
  });
  // (a) streaming while the card is up (verb present → the old per-frame moves)
  for (const c of ['∴ thinking…\n', 'solving the model, output pending…\n'.repeat(6)]) {
    await wsPush('session:stream', { project: 'alpha', id, chunk: c });
    await sleep(60);
  }
  // (b) a server poll tick patching the card
  await wsPush('job:status', { project: 'alpha', job: sessJob({ elapsedMs: 72000, cpu: 348 }) });
  await sleep(250);
  // (c) the user sends a prompt mid-turn → sendMsg → renderWB (console kept,
  // re-inserted); sample the card's opacity across that render
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
  // (d) the broadcasts that follow a send
  await wsPush('task:update', { project: 'alpha', task: { id, status: 'running', title: 'Regenerate Fig 3', project: 'alpha' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await sleep(300);
  const replays = await page.evaluate(() => window.__jobInReplays);
  assert.equal(replays, 0, 'the entrance animation never replays after first appearance');
  assert.equal(minOpacity, 1, 'the card stays fully visible through a prompt send');
  assert.ok(await card(), 'card still present and patched');
});

test('⊘ stop posts the job key and shows the stopping state', opts, async () => {
  await page.click('.csJobs .jobCard .jobStop');
  await sleep(200);
  assert.deepEqual(stopPosts, [{ key: jobKey }]);
  const btnTxt = await page.evaluate(() => document.querySelector('.csJobs .jobStop')?.textContent);
  assert.equal(btnTxt, 'stopping…');
  await wsPush('job:status', { project: 'alpha', job: sessJob({ stopping: true }) });
  await sleep(200);
  assert.equal((await card()).stateTxt, 'stopping…');
});

test('a ▶ run job shows an honest bar, iter counter, ETA and quiet clock', opts, async () => {
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'models/fig3.jl', cmdLine: 'julia fig3.jl', state: 'running', startedAt: new Date().toISOString(), ms: null, exitCode: null, bytes: 0 },
  });
  await sleep(400);
  await page.click('.sessTabs .stab.runT');
  await sleep(300);
  await wsPush('job:status', {
    project: 'alpha',
    job: {
      key: 'run:alpha', source: 'run', project: 'alpha', taskId: null,
      file: 'models/fig3.jl', lang: 'julia', command: 'julia fig3.jl',
      state: 'running', stopping: false, startedAt: new Date(Date.now() - 30000).toISOString(),
      elapsedMs: 30000, pid: 4242, cpu: 180, mem: 5e8,
      progress: { frac: 0.42, iter: 210, total: 500, etaS: 240 },
      quietMs: 15000, exitCode: null, ms: null,
    },
  });
  await sleep(300);
  const c = await page.evaluate(() => {
    const el = document.querySelector('.runJobSlot .jobCard');
    return el && {
      indet: el.querySelector('.jobFill').classList.contains('indet'),
      barW: el.querySelector('.jobFill').style.width,
      iter: el.querySelector('.jobIter').textContent,
      meta: el.querySelector('.jobMeta').textContent,
      quietShown: !!el.querySelector('.jsQuiet.on'),
      quiet: el.querySelector('.jobQuiet').textContent,
    };
  });
  assert.ok(c, 'card mounts in the ▶ output slot');
  assert.ok(!c.indet, 'parsed progress → honest bar');
  assert.equal(c.barW, '42%');
  assert.equal(c.iter, 'iter 210/500');
  assert.match(c.meta, /ETA ~4m/);
  assert.match(c.meta, /pid 4242/);
  assert.ok(c.quietShown, '15s without output → quiet clock shows');
});

test('background + detached + notebook cards: chips name the mode; detached outlives the turn', opts, async () => {
  // the previous test left the session pane on ▶ output — the chat (and its
  // job slot) only exists on the ⌘ session tab
  await page.click('.sessTabs .stab:not(.runT)');
  await sleep(300);
  const bgKey = `sess:alpha/${id}/toolu_bg`;
  const detKey = `sess:alpha/${id}/toolu_det`;
  await wsPush('job:status', {
    project: 'alpha',
    job: sessJob({ key: bgKey, bg: true, file: 'dl/01_download.R', lang: 'r', command: 'Rscript dl/01_download.R' }),
  });
  await wsPush('job:status', {
    project: 'alpha',
    job: sessJob({ key: detKey, detached: true, file: 'sim.jl', lang: 'julia', command: 'nohup julia sim.jl &' }),
  });
  await wsPush('job:status', {
    project: 'alpha',
    job: sessJob({ key: `sess:alpha/${id}/toolu_nb`, file: 'replicate_all.ipynb', lang: 'notebook', command: 'jupyter nbconvert --execute replicate_all.ipynb' }),
  });
  await sleep(350);
  const chips = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.csJobs .jobCard')].map(el =>
      [el.querySelector('.jobFile').textContent, el.querySelector('.jobLang').textContent])));
  assert.equal(chips['dl/01_download.R'], 'R · background');
  assert.equal(chips['sim.jl'], 'julia · detached');
  assert.equal(chips['replicate_all.ipynb'], 'notebook');

  // the turn ends: bg + foreground cards stop; the detached card lives on in
  // the console (the card is not shown in the session pane)
  const { body: tw } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'waiting' });
  await wsPush('task:update', { project: 'alpha', task: tw });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(400);
  const after = await page.evaluate(() => ({
    states: Object.fromEntries([...document.querySelectorAll('.csJobs .jobCard')].map(el =>
      [el.querySelector('.jobFile').textContent, el.dataset.state])),
    chatCards: document.querySelectorAll('.chatJobSlot .jobCard').length,
  }));
  assert.equal(after.states['sim.jl'], 'running', 'detached card outlives the turn (in the console)');
  assert.notEqual(after.states['dl/01_download.R'], 'running', 'background card ends with the turn');
  assert.equal(after.chatCards, 0, 'cards are not shown in the session pane');

  // clean up for the tests below: detached ends when its process does
  await wsPush('job:status', { project: 'alpha', job: sessJob({ key: detKey, detached: true, file: 'sim.jl', lang: 'julia', state: 'done', ms: 60000 }) });
  const { body: tr2 } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'running' });
  await wsPush('task:update', { project: 'alpha', task: tr2 });
  await sleep(7000); // both terminal cards fade out
});

test('a finished card reports its terminal state, then fades away', opts, async () => {
  await page.click('.sessTabs .stab.runT'); // the run card lives on ▶ output
  await sleep(300);
  await wsPush('job:status', {
    project: 'alpha',
    job: {
      key: 'run:alpha', source: 'run', project: 'alpha', taskId: null,
      file: 'models/fig3.jl', lang: 'julia', command: 'julia fig3.jl',
      state: 'done', stopping: false, startedAt: new Date(Date.now() - 45000).toISOString(),
      elapsedMs: 45000, pid: 4242, cpu: 0, mem: 5e8,
      progress: { frac: 1, iter: 500, total: 500, etaS: null },
      quietMs: null, exitCode: 0, ms: 45000,
    },
  });
  await sleep(300);
  const c = await page.evaluate(() => {
    const el = document.querySelector('.runJobSlot .jobCard');
    return el && {
      state: el.dataset.state,
      stateTxt: el.querySelector('.jobState').textContent,
      barW: el.querySelector('.jobFill').style.width,
      stopVisible: getComputedStyle(el.querySelector('.jobStop')).display !== 'none',
    };
  });
  assert.equal(c.state, 'done');
  assert.equal(c.stateTxt, 'done');
  assert.equal(c.barW, '100%', 'done sweeps the bar full');
  assert.ok(!c.stopVisible, 'no stop button on a finished job');
  await sleep(7000); // 6s hold + 450ms fade
  const gone = await page.evaluate(() => !document.querySelector('.runJobSlot .jobCard'));
  assert.ok(gone, 'card left the layout after its farewell');
});
