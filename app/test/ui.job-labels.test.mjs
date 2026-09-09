import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };
let ui, page;
before(async () => {
  if (opts.skip) return;
  ui = await startUI(); page = ui.page;
  await page.goto(ui.sb.base);
});
after(async () => { if (ui) await ui.stop(); });

test('real feed HTML renders legacy inline history safely without inventing a command', opts, async () => {
  const result = await page.evaluate(async () => {
    const { jobFeedRow } = await import('/jobs.js');
    const file = '/bin/zsh -lc \'JULIA_DEPOT_PATH="$PWD/.julia_depot:/Users/gra';
    const box = document.createElement('div');
    box.innerHTML = jobFeedRow({ key: 'old', lang: 'julia', state: 'done', inline: true, file,
      ms: 14695, memPeakBytes: 512753664, cpuTimeMs: 14490 }).html;
    return { name: box.querySelector('.jfCmd').textContent, tip: box.querySelector('.jfCmd').title,
      summary: box.querySelector('.jfSum').textContent };
  });
  assert.equal(result.name, 'inline Julia');
  assert.match(result.tip, /Recorded inline label\/command excerpt:/);
  assert.match(result.tip, /\/Users\/gra$/);
  assert.match(result.summary, /15s.*489M.*1\.0×/);
});

test('slash labels and launcher targets survive real rendering while file paths shorten', opts, async () => {
  const values = await page.evaluate(async () => {
    const { jobFeedRow } = await import('/jobs.js');
    const cases = [
      { titleKind: 'label', displayTitle: 'Fit φ/Φ using /tmp/research', inline: true },
      { titleKind: 'label', displayTitle: 'pkg (npm run bench/solve)' },
      { titleKind: 'label', displayTitle: 'src (make build/foo)' },
      { titleKind: 'file', displayTitle: 'models/nested/model.jl', file: 'models/nested/model.jl' },
      { titleKind: 'file', displayTitle: 'python/tests/', file: 'python/tests/' },
    ];
    return cases.map(item => {
      const box = document.createElement('div');
      box.innerHTML = jobFeedRow({ key: 'one', state: 'done', lang: 'julia', ms: 100, ...item }).html;
      return box.querySelector('.jfCmd').textContent;
    });
  });
  assert.deepEqual(values, ['Fit φ/Φ using /tmp/research', 'pkg (npm run bench/solve)', 'src (make build/foo)', 'model.jl', 'tests/']);
});

test('untrusted title and command text cannot create HTML in cards or feed rows', opts, async () => {
  const result = await page.evaluate(async () => {
    const { jobFeedRow, syncJobCards } = await import('/jobs.js');
    const title = '<img src=x onerror="window.badTitle=1"> / task';
    const command = 'julia -e \'print("<svg/onload=bad()>")\'';
    const job = { key: 'safe', jobRunId: 'safe-a', source: 'session', project: 'alpha',
      state: 'running', lang: 'julia', startedAt: new Date().toISOString(),
      titleKind: 'label', displayTitle: title, inline: true, command, elapsedMs: 100 };
    const feed = document.createElement('div'); feed.innerHTML = jobFeedRow({ ...job, state: 'done' }).html;
    const cards = document.createElement('div'); syncJobCards(cards, [job]);
    return { feedName: feed.querySelector('.jfCmd').textContent, feedTip: feed.querySelector('.jfCmd').title,
      cardName: cards.querySelector('.jobFile').textContent, cardTip: cards.querySelector('.jobFile').title,
      injected: feed.querySelectorAll('img,svg').length + cards.querySelector('.jobFile').querySelectorAll('*').length };
  });
  assert.equal(result.feedName, '<img src=x onerror="window.badTitle=1"> / task');
  assert.equal(result.cardName, result.feedName);
  assert.equal(result.feedTip, result.cardTip);
  assert.match(result.cardTip, /<svg\/onload/);
  assert.equal(result.injected, 0);
});

test('same immutable invocation keeps its card across a step timestamp change; replacement resets it', opts, async () => {
  const result = await page.evaluate(async () => {
    const { syncJobCards, absorbJob } = await import('/jobs.js');
    const box = document.createElement('div');
    const base = { key: 'run:alpha', jobRunId: 'run-a', source: 'run', project: 'alpha', state: 'running',
      file: 'model.jl', startedAt: '2026-09-09T12:00:00Z', elapsedMs: 100, output: { owned: false } };
    const a = absorbJob(undefined, { ...base }); syncJobCards(box, [a]);
    const first = box.firstElementChild;
    const b = absorbJob(a, { ...base, startedAt: '2026-09-09T12:01:00Z', elapsedMs: 200 }); syncJobCards(box, [b]);
    const retained = box.firstElementChild === first;
    const c = absorbJob(b, { ...base, jobRunId: 'run-b' }); syncJobCards(box, [c]);
    const replacement = box.firstElementChild !== first;
    const terminal = absorbJob(c, { ...c, state: 'done' });
    const ignored = absorbJob(terminal, { ...c, state: 'running' }) === terminal;
    return { retained, replacement, ignored };
  });
  assert.deepEqual(result, { retained: true, replacement: true, ignored: true });
});

test('recent-activity sidebar consumes the normalized title value, never the helper object', opts, async () => {
  const result = await page.evaluate(async () => {
    const { afRunRow } = await import('/sidebar.js');
    return [
      { inline: true, file: '/bin/zsh -lc \'JULIA_DEPOT_PATH="$PWD/.julia_depot:/Users/gra' },
      { titleKind: 'label', displayTitle: 'Fit φ/Φ at /tmp/data' },
      { titleKind: 'label', displayTitle: '<img src=x onerror=bad()> / run' },
      { titleKind: 'file', file: 'nested/tests/' },
    ].map(item => {
      const box = document.createElement('div');
      box.innerHTML = afRunRow({ kind: 'run', source: 'session', lang: 'julia', state: 'done', ms: 14695, ts: new Date().toISOString(), ...item });
      return { text: box.querySelector('.nm').textContent, title: box.querySelector('.afRow').title,
        injected: box.querySelectorAll('img').length };
    });
  });
  assert.match(result[0].text, /ran inline Julia/);
  assert.match(result[0].title, /Recorded inline label\/command excerpt/);
  assert.match(result[1].text, /Fit φ\/Φ at \/tmp\/data/);
  assert.match(result[2].text, /<img src=x onerror=bad\(\)> \/ run/);
  assert.match(result[3].text, /tests\//);
  for (const item of result) { assert.doesNotMatch(item.text, /\[object Object\]/); assert.equal(item.injected, 0); }
});

test('real event intake and snapshot adoption reject duplicate/late invocation resurrection', opts, async () => {
  const result = await page.evaluate(async () => {
    const { handleEvent } = await import('/app.js');
    const { jobsLive } = await import('/store.js');
    const { jobsEnded } = await import('/jobs.js');
    const snapshot = await (await fetch('/api/state')).json();
    const old = { key: 'run:alpha', jobRunId: 'earlier', source: 'run', project: 'alpha', file: 'a.jl',
      lang: 'julia', state: 'running', createdAt: '2026-09-09T12:00:00Z', startedAt: '2026-09-09T12:00:00Z', elapsedMs: 100 };
    const current = { ...old, jobRunId: 'current', createdAt: '2026-09-09T12:01:00Z', startedAt: '2026-09-09T12:01:00Z' };
    handleEvent('job:status', { project: 'alpha', job: current });
    handleEvent('job:status', { project: 'alpha', job: old });
    const retainedNewer = jobsLive[old.key]?.jobRunId === current.jobRunId;
    const done = { ...current, state: 'done', ms: 100 };
    handleEvent('job:status', { project: 'alpha', job: done });
    handleEvent('job:status', { project: 'alpha', job: { ...current } });
    const terminalStayedTerminal = jobsLive[old.key]?.state === 'done';
    // Simulate a completed card already moved into the terminal registry.
    jobsEnded[old.key] = jobsLive[old.key]; delete jobsLive[old.key];
    handleEvent('job:status', { project: 'alpha', job: { ...current } });
    const fadedNotResurrected = !jobsLive[old.key];
    handleEvent('state', { ...snapshot, jobHistory: { alpha: [done] }, jobs: [old] });
    const snapshotRejectedOlder = !jobsLive[old.key] && jobsEnded[old.key]?.jobRunId === current.jobRunId;
    return { retainedNewer, terminalStayedTerminal, fadedNotResurrected, snapshotRejectedOlder };
  });
  assert.deepEqual(result, { retainedNewer: true, terminalStayedTerminal: true, fadedNotResurrected: true, snapshotRejectedOlder: true });
});
