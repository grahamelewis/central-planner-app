// Independent browser regression for turn ownership, not just card content.
// All model routes are intercepted by uiHarness; process Stop is also stubbed.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const available = fs.existsSync(CHROME);
const opts = { skip: available ? false : 'Google Chrome not installed' };
let ui, page, wsPush, task, snapshot, savedTranscript = [];
const errors = [], stops = [];
const A = 'placement-turn-A', B = 'placement-turn-B';
const BOX = '#v-alpha #consoleBox';
const job = (name, over = {}) => ({
  key: `sess:alpha/${task.id}/${name}`, source: 'session', project: 'alpha', taskId: task.id,
  appTurnId: A, taskCreated: task.created, jobRunId: `invocation-${name}`,
  createdAt: '2026-09-09T11:00:00.000Z', startedAt: '2026-09-09T11:00:01.000Z',
  command: `julia ${name}.jl`, file: `${name}.jl`, lang: 'julia', state: 'running',
  elapsedMs: 15000, pid: 123, cores: 1, memBytes: 1024, memPeakBytes: 1024,
  output: { owned: false }, ...over,
});
const entry = (turnId, role, text) => ({ turnId, role, text, ts: '2026-09-09T11:00:00Z' });
const stream = (turnId, chunk) => wsPush('session:stream', { project: 'alpha', id: task.id, turnId, chunk });
const emit = j => wsPush('job:status', { project: 'alpha', job: j });
const user = (turn, text) => stream(turn, `\n▸ you ─────\n${text}\n`);
const answer = (turn, text) => stream(turn, `\n— answer —\n${text}\n`);
const selector = j => `[data-jobkey="${j.key}"]`;

async function status(value, turnId = A) {
  snapshot.tasks.alpha = snapshot.tasks.alpha.map(t => t.id === task.id ? { ...t, status: value } : t);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: value } });
  await wsPush('session:status', { project: 'alpha', id: task.id, turnId, status: value });
}

async function assertOwnedBefore(j, text) {
  await page.waitForFunction(({ text, box }) => [...document.querySelector(box).querySelectorAll('.cs-you')]
    .some(el => el.textContent.includes(text)), { text, box: BOX });
  const actual = await page.evaluate(({ key, text, box }) => {
    const host = document.querySelector(box);
    const row = host.querySelector(`[data-jobkey="${key}"]`);
    const next = [...host.querySelectorAll('.cs-you')].find(el => el.textContent.includes(text));
    return {
      count: host.querySelectorAll(`[data-jobkey="${key}"]`).length,
      owner: row?.closest('.cs-jobs')?.dataset.turnId,
      before: !!row && !!next && !!(row.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING),
      tail: host.querySelectorAll(':scope > .csJobs [data-jobkey], :scope > .csJobFeed [data-jobkey]').length,
    };
  }, { key: j.key, text, box: BOX });
  assert.equal(actual.count, 1, 'one visible record per invocation');
  assert.equal(actual.owner, j.appTurnId, 'summary belongs to its original turn');
  assert.equal(actual.before, true, 'completion stays before the subsequent user prompt');
  assert.equal(actual.tail, 0, 'completed work never occupies the live tail');
}

before(async () => {
  if (!available) return;
  ui = await startUI();
  ({ page, wsPush } = ui);
  await page.addInitScript(() => { if (location.protocol === 'http:') localStorage.clear(); });
  page.on('pageerror', e => errors.push(e.message));
  ({ body: task } = await ui.sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Job placement review', oversight: 'coop',
  }));
  await ui.sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, { status: 'running' });
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/transcript/alpha/*', route => route.fulfill({ json: { transcript: savedTranscript } }));
  await page.route('**/api/jobs/alpha/stop', route => {
    stops.push(JSON.parse(route.request().postData()));
    return route.fulfill({ json: { ok: true } });
  });
});

beforeEach(async () => {
  if (!available) return;
  ({ body: snapshot } = await ui.sb.fetchJson('GET', '/api/state'));
  snapshot.jobs = [];
  snapshot.jobHistory = {};
  savedTranscript = [];
  stops.length = 0;
  await page.goto('about:blank'); // force a new document, not a hash-only navigation
  await page.goto(`${ui.sb.base}/#alpha`);
  await page.waitForSelector(`${BOX} .csegWrap`, { timeout: 15000 });
});

after(async () => { if (ui) await ui.stop(); });

test('late fade after prompt B anchors completion to A; typing never reattaches it', opts, async () => {
  await user(A, 'First prompt');
  await answer(A, 'First answer');
  const j = job('late-fade');
  await emit(j);
  await page.waitForSelector(`${BOX} > .csJobs ${selector(j)}`);
  // Existing _endedAt exercises the formerly unsafe content-only freshness check.
  await emit({ ...j, state: 'done', ms: 15000, exitCode: 0, _endedAt: '2026-09-09T11:00:16Z' });
  await user(B, 'Second prompt');
  await answer(B, 'Second answer is streaming');
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}.jobCard`);
  await assertOwnedBefore(j, 'Second prompt');
  await page.fill('#composerInput', 'A draft\nwith another line');
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}.jobFeedRow`, { timeout: 10000 });
  await assertOwnedBefore(j, 'Second prompt');
  assert.equal(await page.locator(`${BOX} ${selector(j)}.gone`).count(), 0);
  assert.equal(await page.inputValue('#composerInput'), 'A draft\nwith another line');
});

test('detached work stays visible across turns and Stop targets its original invocation', opts, async () => {
  await user(A, 'Launch detached job');
  const j = job('detached', { detached: true });
  await emit(j);
  await status('waiting');
  await page.waitForSelector(`${BOX} > .csJobFeed ${selector(j)}.live .jfAct.stop`);
  await page.click(`${BOX} > .csJobFeed ${selector(j)} .jfAct.stop`);
  assert.deepEqual(stops.at(-1), { key: j.key, startedAt: j.startedAt, jobRunId: j.jobRunId });
  // A later sample can correct observed process start time without changing owner.
  const corrected = { ...j, startedAt: '2026-09-09T11:00:02.000Z' };
  await emit(corrected);
  await status('running', B);
  await user(B, 'Continue while detached job runs');
  await page.waitForSelector(`${BOX} > .csJobs ${selector(j)} .jobStop`);
  await page.click(`${BOX} > .csJobs ${selector(j)} .jobStop`);
  assert.deepEqual(stops.at(-1), { key: j.key, startedAt: corrected.startedAt, jobRunId: j.jobRunId });
  await emit({ ...corrected, state: 'stopped', ms: 15000 });
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}`);
  await assertOwnedBefore(j, 'Continue while detached job runs');
});

test('cold reload rebuilds owned history from trusted transcript metadata, not bottom-of-task history', opts, async () => {
  const j = job('reloaded', { state: 'done', ms: 15000 });
  snapshot.jobHistory = { alpha: [j] };
  savedTranscript = [entry(A, 'user', 'First reload prompt'), entry(A, 'assistant', 'First reload answer'),
    entry(B, 'user', 'Second reload prompt'), entry(B, 'assistant', 'Second reload answer')];
  await page.reload();
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}.jobFeedRow`);
  await assertOwnedBefore(j, 'Second reload prompt');
  // A repeated authoritative state must not duplicate a persisted completion.
  await wsPush('state', snapshot);
  await assertOwnedBefore(j, 'Second reload prompt');
});

test('unowned legacy and other task-generation histories cannot masquerade as current-turn work', opts, async () => {
  await user(A, 'Current task');
  const legacy = job('legacy', { appTurnId: null, jobRunId: null, taskCreated: null, state: 'done', ms: 15000 });
  const replaced = job('replaced', { taskCreated: 'another-task-generation', state: 'done', ms: 15000 });
  await emit(legacy);
  await emit(replaced);
  snapshot.jobHistory = { alpha: [legacy, replaced] };
  await wsPush('state', snapshot);
  await sleep(150);
  assert.equal(await page.locator(`${BOX} [data-jobkey]`).count(), 0);
  const history = await page.evaluate(async () => (await import('/store.js')).state.jobHistory.alpha);
  assert.equal(history.length, 2, 'history is retained separately, not deleted to conceal the bug');
});

test('out-of-order completions and duplicate terminal events each remain with the original turn', opts, async () => {
  await user(A, 'Older prompt');
  const first = job('first'), second = job('second', { appTurnId: B });
  await emit(first);
  await user(B, 'Newer prompt');
  await emit(second);
  await emit({ ...second, state: 'done', ms: 16000 });
  await emit({ ...first, state: 'done', ms: 17000 });
  await emit({ ...first, state: 'done', ms: 17000 });
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(first)}`);
  await assertOwnedBefore(first, 'Newer prompt');
  assert.equal(await page.locator(`${BOX} .cs-jobs[data-turn-id="${B}"] ${selector(second)}`).count(), 1);
  assert.equal(await page.locator(`${BOX} > .csJobs [data-jobkey]`).count(), 0);
});

for (const anchorKind of ['prompt', 'tall-answer']) {
test(`late completion above a newer turn preserves DOM nodes and reader viewport [${anchorKind}]`, opts, async () => {
  await user(A, 'Launch work that outlives this turn');
  const j = job('late-insertion', { detached: true });
  await emit(j);
  await user(B, 'Newer turn must keep its nodes');
  await answer(B, 'An already rendered paragraph.\n\n'.repeat(60) + 'End of viewport fixture.');
  await page.waitForFunction(box => document.querySelector(box).textContent.includes('End of viewport fixture.'), BOX);
  const before = await page.locator(BOX).evaluate((box, kind) => {
    const prompt = [...box.querySelectorAll('.cs-you')].find(el => el.textContent.includes('Newer turn must keep its nodes'));
    window.__placementNewerPrompt = prompt;
    const answer = prompt.nextElementSibling;
    window.__placementNewerAnswer = answer;
    box._follow = false;
    const target = kind === 'tall-answer' ? answer : prompt;
    const offset = kind === 'tall-answer' ? -200 : 20;
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
    return { top: prompt.getBoundingClientRect().top - box.getBoundingClientRect().top,
      text: answer.textContent };
  }, anchorKind);
  await emit({ ...j, state: 'done', ms: 15000 });
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}`);
  await sleep(100);
  const after = await page.locator(BOX).evaluate(box => {
    const prompt = [...box.querySelectorAll('.cs-you')].find(el => el.textContent.includes('Newer turn must keep its nodes'));
    return { samePrompt: prompt === window.__placementNewerPrompt,
      sameAnswer: prompt.nextElementSibling === window.__placementNewerAnswer,
      text: prompt.nextElementSibling.textContent,
      top: prompt.getBoundingClientRect().top - box.getBoundingClientRect().top };
  });
  assert.equal(after.samePrompt, true, 'insertion must not repurpose the following user segment');
  assert.equal(after.sameAnswer, true, 'insertion must not rebuild the following assistant segment');
  assert.equal(after.text, before.text);
  assert.ok(Math.abs(after.top - before.top) < 5, `visible prompt stays anchored (${before.top} → ${after.top})`);
});
}

test('recalling a turn removes its anchored completion and does not append it to the preceding turn', opts, async () => {
  await user(A, 'Keep this turn');
  await user(B, 'Recall this turn');
  const j = job('recalled', { appTurnId: B, state: 'done', ms: 15000 });
  await emit(j);
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}`);
  await wsPush('session:recalled', { project: 'alpha', id: task.id, turnId: B, status: 'recalled',
    transcript: [entry(A, 'user', 'Keep this turn')] });
  await page.waitForFunction(({ box, key }) => !document.querySelector(box)?.querySelector(`[data-jobkey="${key}"]`), { box: BOX, key: j.key });
  assert.match(await page.textContent(`${BOX} .csegWrap`), /Keep this turn/);
  assert.doesNotMatch(await page.textContent(`${BOX} .csegWrap`), /Recall this turn/);
});

test('deleting and recreating a task ID cannot revive the deleted transcript or its job cards', opts, async () => {
  await user(A, 'Text from the deleted task');
  const old = job('deleted', { state: 'done', ms: 15000 });
  await emit(old);
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(old)}`);
  await wsPush('task:delete', { project: 'alpha', id: task.id });
  const replacement = { ...task, created: 'replacement-generation', title: 'Replacement task', status: 'running' };
  await wsPush('task:update', { project: 'alpha', task: replacement });
  await page.evaluate(() => document.querySelector('.tab[data-v="alpha"]')?.click());
  await page.waitForSelector(BOX);
  await user(B, 'Text from the replacement task');
  // Even a late terminal replay must remain scoped to the deleted generation.
  await emit(old);
  await page.waitForFunction(box => document.querySelector(box).textContent.includes('Text from the replacement task'), BOX);
  assert.equal(await page.locator(`${BOX} [data-jobkey]`).count(), 0);
  assert.doesNotMatch(await page.textContent(`${BOX} .csegWrap`), /Text from the deleted task/);
});

test('stream growth and completed-card reconciliation respect a reader scrolled away from the tail', opts, async () => {
  await user(A, 'Long historical answer');
  await answer(A, 'Paragraph for the scrollback.\n\n'.repeat(100) + 'End of scroll fixture.');
  // Let the real reveal pump settle before testing ownership reconciliation.
  await page.waitForFunction(box => document.querySelector(box).textContent.includes('End of scroll fixture.'), BOX);
  await page.waitForFunction(box => document.querySelector(box).scrollHeight > 1500, BOX);
  await sleep(250); // drain the browser's scroll event for the final reveal frame
  // Existing _prog scroll-event suppression can swallow a wheel gesture on
  // clean HEAD before any job exists (separately documented). Establish the
  // accepted-reader-intent state here to isolate the new row-placement delta;
  // this test deliberately does not claim wheel-intent detection is fixed.
  const before = await page.locator(BOX).evaluate(el => {
    el._follow = false;
    el.scrollTop = 50;
    return { top: el.scrollTop, follow: el._follow };
  });
  assert.equal(before.follow, false);
  const j = job('scroll', { state: 'done', ms: 15000 });
  await emit(j);
  await user(B, 'New prompt while reading old text');
  await answer(B, 'More text continues arriving.\n'.repeat(10));
  await sleep(500);
  const after = await page.locator(BOX).evaluate(el => ({ top: el.scrollTop, follow: el._follow }));
  assert.equal(after.follow, false);
  assert.ok(Math.abs(after.top - before.top) < 5, `scroll position retained (${before.top} → ${after.top})`);
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});

// ── run ledger placement: the block sits between the prose and the divider ──
const turnDone = (turn) => stream(turn, '\n— turn done · 2.0s · 1k in / 1k out —\n');
// where turn A's .cs-jobs block sits relative to its neighbours in .csegWrap
const blockOrder = (turnId = A) => page.locator(BOX).evaluate((box, turnId) => {
  const block = box.querySelector(`.cs-jobs[data-turn-id="${turnId}"]`);
  if (!block) return { block: false };
  window.__placementBlocks = window.__placementBlocks || {};
  const same = window.__placementBlocks[turnId] === block;
  window.__placementBlocks[turnId] = block;
  const prev = block.previousElementSibling, next = block.nextElementSibling;
  return {
    block: true, same, inWrap: block.parentElement.classList.contains('csegWrap'),
    prev: prev && { cls: prev.className, text: prev.textContent.trim() },
    next: next && { cls: next.className, text: next.textContent.trim() },
    dividers: box.querySelectorAll('.cs-turn').length,
    tail: box.querySelectorAll(':scope > .csJobs [data-jobkey], :scope > .csJobFeed [data-jobkey]').length,
    keys: [...block.querySelectorAll('[data-jobkey]')].map(el => el.dataset.jobkey),
    kids: [...block.parentElement.children].map(el => el.className.replace(/^cseg /, '') + ':' + el.textContent.trim().slice(0, 24)),
  };
}, turnId);

test("a turn's jobs block precedes its turn-done divider and follows the answer prose", opts, async () => {
  await user(A, 'Run both scripts');
  await answer(A, 'Both scripts ran; see the ledger.');
  await turnDone(A);
  await page.waitForSelector(`${BOX} .cs-turn`);
  const one = job('ledger-one', { state: 'done', ms: 15000, exitCode: 0 });
  const two = job('ledger-two', { state: 'error', ms: 12000, exitCode: 1, createdAt: '2026-09-09T11:00:30.000Z',
    startedAt: '2026-09-09T11:00:31.000Z' });
  await emit(one);
  await emit(two);
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(two)}`);
  const held = await blockOrder();
  assert.equal(held.inWrap, true, 'the block is a segment of the stream, not a tail strip');
  assert.match(held.prev.cls, /\bcs-ans\b/, `the block follows the answer prose (got ${held.prev.cls})`);
  assert.match(held.prev.text, /see the ledger/);
  assert.match(held.next.cls, /\bcs-turn\b/, `the block precedes the divider (got ${held.next.cls})`);
  assert.match(held.next.text, /^turn done/);
  assert.equal(held.dividers, 1);
  assert.deepEqual(held.keys, [one.key, two.key], 'rows in createdAt order');
  assert.equal(held.tail, 0);
  // the held cards fade into rows (~6.5 s): same block node, same position
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(two)}.jobFeedRow`, { timeout: 10000 });
  const rows = await blockOrder();
  assert.equal(rows.same, true, 'the card → row hand-off reuses the .cs-jobs node');
  assert.match(rows.prev.cls, /\bcs-ans\b/);
  assert.match(rows.next.cls, /\bcs-turn\b/);
  assert.deepEqual(rows.keys, [one.key, two.key]);
  assert.equal(rows.tail, 0);
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});

test('a turn with no runs has no block', opts, async () => {
  await user(A, 'Just talk');
  await answer(A, 'No scripts were run.');
  await turnDone(A);
  await page.waitForSelector(`${BOX} .cs-turn`);
  const order = await page.locator(BOX).evaluate(box => ({
    blocks: box.querySelectorAll('.cs-jobs').length,
    kids: [...box.querySelector('.csegWrap').children].map(el => el.className.replace(/^cseg /, '')),
  }));
  assert.equal(order.blocks, 0);
  assert.deepEqual(order.kids.slice(-2), ['cs-ans', 'cs-turn'], 'prose then divider, nothing between');
});

test('a short run (short:true, never a live card) lands in its turn as a row at once — no held card, above the divider', opts, async () => {
  await user(A, 'Run the quick script');
  await answer(A, 'It ran in under a second.');
  await turnDone(A);
  await page.waitForSelector(`${BOX} .cs-turn`);
  // the wire lib/jobs.js finish() broadcasts for a run under MIN_AGE: terminal, short, from its tool result
  const j = job('short-run', { state: 'error', short: true, ms: 400, exitCode: 3, exit: { code: 3, signal: null, byUser: false },
    runtime: 'shell', lang: 'shell', command: 'bash run.sh', file: 'run.sh', verified: true, counters: {},
    output: { lines: 2, owned: false, fromToolResult: true }, endedAt: '2026-09-09T11:00:01.400Z', pid: null, elapsedMs: 400 });
  await emit(j);
  await page.waitForSelector(`${BOX} .cs-jobs ${selector(j)}.jobFeedRow`, { timeout: 2000 });
  const at = await blockOrder();
  assert.equal(await page.locator(`${BOX} ${selector(j)}.jobCard`).count(), 0, 'no held card, not even briefly');
  assert.equal(at.tail, 0);
  assert.deepEqual(at.keys, [j.key]);
  assert.match(at.prev.cls, /\bcs-ans\b/);
  assert.match(at.next.cls, /\bcs-turn\b/, `above the divider (${at.kids.join(' | ')})`);
  const row = await page.locator(`${BOX} .cs-jobs ${selector(j)}`).evaluate(el => ({ ico: el.querySelector('.jfIco').textContent, ess: el.querySelector('.jfEss').textContent }));
  assert.deepEqual(row, { ico: '✗', ess: 'exit 3 · 0.4s' });
  await sleep(7000); // past the card-hold window: still one row, still no card
  assert.equal(await page.locator(`${BOX} ${selector(j)}`).count(), 1);
  assert.equal(await page.locator(`${BOX} ${selector(j)}.jobFeedRow`).count(), 1);
});

test("the detached live row stays in the tail until it ends, then joins its turn's block", opts, async () => {
  await user(A, 'Launch the long simulation');
  await answer(A, 'Started it detached.');
  await turnDone(A);
  await page.waitForSelector(`${BOX} .cs-turn`); // let the reveal pump draw the divider first
  const j = job('detached-ledger', { detached: true });
  await emit(j);
  await status('waiting');
  await page.waitForSelector(`${BOX} > .csJobFeed ${selector(j)}.live`);
  const live = await blockOrder();
  assert.equal(live.block, false, 'a still-running detached job is not ledger material yet');
  assert.equal(await page.locator(`${BOX} .csegWrap ${selector(j)}`).count(), 0);
  await emit({ ...j, state: 'done', ms: 15000, exitCode: 0 });
  await page.waitForSelector(`${BOX} .cs-jobs[data-turn-id="${A}"] ${selector(j)}`);
  const ended = await blockOrder();
  assert.equal(ended.tail, 0, 'the ended row left the tail');
  assert.deepEqual(ended.keys, [j.key]);
  assert.match(ended.prev.cls, /\bcs-ans\b/, `the block follows the prose (${ended.kids.join(' | ')})`);
  assert.match(ended.next.cls, /\bcs-turn\b/, `the block sits above the divider of the launching turn (${ended.kids.join(' | ')})`);
  assert.equal(await page.locator(`${BOX} ${selector(j)}`).count(), 1, 'one record: no tail/block duplicate');
});

test('expandInPlace: zero drift for a reader below the block, above it, and at the clamped end', opts, async () => {
  await user(A, 'Marker prompt');
  await answer(A, 'An already rendered paragraph.\n\n'.repeat(80) + 'End of drift fixture.');
  await turnDone(A);
  await page.waitForFunction(box => document.querySelector(box).textContent.includes('End of drift fixture.'), BOX);
  await page.waitForSelector(`${BOX} .cs-turn`);
  await page.waitForFunction(box => document.querySelector(box).scrollHeight > 2500, BOX);
  await sleep(250); // drain the reveal pump's last scroll event
  const drift = await page.locator(BOX).evaluate(async (box) => {
    const { expandInPlace } = await import('/console.js');
    box._follow = false;
    const top = (el) => el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const prompt = box.querySelector('.cs-you');
    const divider = box.querySelector('.cs-turn');
    const grow = (el, h) => () => { const d = document.createElement('div'); d.className = '__grow'; d.style.height = h + 'px'; el.appendChild(d); return d; };
    const out = {};
    // 1. reader below the block: the prompt is scrolled off the top; a
    // paragraph in view must not move when the prompt grows by 300px
    box.scrollTop = 600;
    const para = [...box.querySelectorAll('.cs-ans p')].find(p => top(p) >= 0);
    const b1 = { marker: top(para), scrollTop: box.scrollTop, above: top(prompt) < 0, prog: box._prog || 0 };
    const grown = expandInPlace(box, prompt, grow(prompt, 300));
    out.below = { ...b1, markerAfter: top(para), scrollTopAfter: box.scrollTop, progAfter: box._prog || 0, returned: grown.className };
    // 2. reader above the block: the divider is below the viewport; the
    // visible prompt must not move and scrollTop must stay put
    box.scrollTop = 0;
    const b2 = { marker: top(prompt), scrollTop: box.scrollTop, belowView: top(divider) > box.clientHeight };
    expandInPlace(box, divider, grow(divider, 300));
    out.above = { ...b2, markerAfter: top(prompt), scrollTopAfter: box.scrollTop };
    // 3. reader at the very end, block above shrinks: the browser clamps
    // scrollTop during the mutation; the divider in view must not move
    box.scrollTop = box.scrollHeight;
    const b3 = { marker: top(divider), scrollTop: box.scrollTop, atEnd: box.scrollHeight - box.scrollTop - box.clientHeight < 1 };
    expandInPlace(box, prompt, () => grown.remove());
    out.shrink = { ...b3, markerAfter: top(divider), scrollTopAfter: box.scrollTop };
    return out;
  });
  assert.equal(drift.below.above, true, 'fixture: the prompt starts above the viewport');
  assert.ok(Math.abs(drift.below.markerAfter - drift.below.marker) < 1, `reader below: paragraph stays put (${drift.below.marker} → ${drift.below.markerAfter})`);
  assert.equal(drift.below.scrollTopAfter, drift.below.scrollTop + 300, 'reader below: scrollTop absorbed the growth');
  assert.equal(drift.below.progAfter, drift.below.prog + 1, 'the compensating write is flagged programmatic');
  assert.equal(drift.below.returned, '__grow', 'mutate()\'s result is passed through');
  assert.equal(drift.above.belowView, true, 'fixture: the divider starts below the viewport');
  assert.ok(Math.abs(drift.above.markerAfter - drift.above.marker) < 1, `reader above: prompt stays put (${drift.above.marker} → ${drift.above.markerAfter})`);
  assert.equal(drift.above.scrollTopAfter, 0, 'reader above: expansion grows downward, scrollTop untouched');
  assert.equal(drift.shrink.atEnd, true, 'fixture: the reader is at the end of the console');
  assert.ok(Math.abs(drift.shrink.markerAfter - drift.shrink.marker) < 1, `clamped end: divider stays put (${drift.shrink.marker} → ${drift.shrink.markerAfter})`);
  assert.equal(drift.shrink.scrollTopAfter, drift.shrink.scrollTop - 300, 'the clamp is not double-applied');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});
