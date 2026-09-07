// Real browser UI; all model/recall requests are intercepted, never billed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };
let ui, sb, page, wsPush, task, base, snapshot, entries;
let messages, recalls, interrupts, active, messageHold, recallHold, rejectRecall;
let heldMessage, heldRecall;
let holdRunningStatus;
const prior = [
  { role: 'user', text: 'Earlier prompt — keep this.', ts: '2026-09-01T00:00:00Z' },
  { role: 'assistant', text: 'Earlier answer — keep this too.', ts: '2026-09-01T00:00:01Z' },
];
const composer = '#v-alpha #composerInput';
const stop = '#v-alpha #interruptBtn';
const consoleBox = '#v-alpha #consoleBox';

before(async () => {
  if (opts.skip) return;
  ui = await startUI();
  ({ sb, page, wsPush } = ui);
  await page.addInitScript(() => {
    window.__undoMicStops = 0;
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() {}
      stop() { window.__undoMicStops++; }
      abort() { window.__undoMicStops++; }
    };
  });
  ({ body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Undo send fixture', description: 'No provider launches.',
    oversight: 'coop', context: { files: [] },
  }));
  task = { ...task, status: 'waiting', session: {
    sdkSessionId: 'undo-fixture', turns: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
  } };
  ({ body: base } = await sb.fetchJson('GET', '/api/state'));
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/transcript/*/*', route => route.fulfill({ json: { transcript: entries } }));
  await page.unroute('**/api/tasks/*/*/message');
  await page.route('**/api/tasks/*/*/message', async route => {
    const body = route.request().postDataJSON();
    messages.push(body);
    active = { turnId: `turn-${messages.length}`, requestId: body.requestId,
      startedAt: new Date().toISOString(), recallUntil: new Date(Date.now() + 5000).toISOString(),
      prompt: body.text };
    entries = [...entries, { role: 'user', text: body.text }];
    if (!holdRunningStatus) await wsPush('session:status', { project: 'alpha', id: task.id, status: 'running', ...active });
    if (messageHold) heldMessage = route;
    else await route.fulfill({ json: { ok: true, ...active } });
  });
  await page.route('**/api/tasks/*/*/recall', async route => {
    recalls.push(route.request().postDataJSON());
    if (rejectRecall) {
      await route.fulfill({ status: 409, json: { error: 'Provider rollback failed' } });
      return;
    }
    await wsPush('session:status', { project: 'alpha', id: task.id, status: 'running', phase: 'recalling', ...active });
    if (recallHold) heldRecall = route;
    else await finishRecall(route);
  });
  await page.route('**/api/tasks/*/*/interrupt', async route => {
    interrupts++;
    await route.fulfill({ json: { ok: true } });
  });
});
after(async () => { if (ui) await ui.stop(); });

async function load() {
  messages = []; recalls = []; interrupts = 0; active = null;
  messageHold = false; recallHold = false; rejectRecall = false;
  heldMessage = null; heldRecall = null;
  holdRunningStatus = false;
  entries = structuredClone(prior);
  snapshot = { ...base, tasks: { ...base.tasks, alpha: [task] }, sessions: [], turnStates: {} };
  if (page.url().startsWith(sb.base)) await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${sb.base}/#alpha`);
  await page.reload();
  await page.waitForSelector(composer);
  await page.click('#v-alpha .ctab[data-fi="tail"]');
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent.includes('Earlier answer'), consoleBox);
}

async function send(text) {
  const count = messages.length;
  await page.fill(composer, text);
  await page.press(composer, 'Enter');
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent.includes('Stop & Edit'), stop);
  assert.equal(messages.length, count + 1);
  await wsPush('session:stream', { project: 'alpha', id: task.id, turnId: active.turnId,
    requestId: active.requestId, chunk: '\n— thinking —\nOutput that must disappear.\n' });
}

function recalledPayload() {
  return { ok: true, project: 'alpha', id: task.id, status: 'recalled', ...active,
    transcript: structuredClone(prior) };
}

async function finishRecall(route = heldRecall) {
  const payload = recalledPayload();
  entries = structuredClone(prior);
  snapshot.turnStates[`alpha/${task.id}`] = { activeTurn: null,
    lastRecalled: payload, recalledTurnIds: [active.turnId] };
  snapshot.tasks.alpha = [{ ...task, status: 'waiting' }];
  await route.fulfill({ json: payload });
  heldRecall = null;
  return payload;
}

test('Stop & Edit removes only the confirmed turn, restores exact text, focuses, and rejects late replay', opts, async () => {
  await load();
  const text = '  Original <b>literal</b> prompt\n\nwith Unicode β and trailing space.  ';
  await send(text);
  await page.screenshot({ path: '/private/tmp/central-planner-stop-edit.png', fullPage: true });
  recallHold = true;
  await page.click(stop);
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent === 'Stopping…', stop);
  assert.ok((await page.textContent(consoleBox)).includes('Original'), 'nothing hidden before confirmation');
  assert.equal(await page.inputValue(composer), '');
  await finishRecall();
  await page.waitForFunction(([sel, value]) => document.querySelector(sel)?.value === value, [composer, text]);
  assert.equal(await page.evaluate(sel => document.activeElement === document.querySelector(sel), composer), true);
  assert.equal(await page.evaluate(sel => document.querySelector(sel).selectionStart, composer), text.length);
  await page.waitForFunction(sel => !document.querySelector(sel)?.textContent.includes('Original'), consoleBox);
  assert.ok((await page.textContent(consoleBox)).includes('Earlier answer'));
  assert.equal(await page.locator(`${consoleBox} .cs-you b`).count(), 0, 'prompt HTML remains literal');
  await wsPush('session:stream', { project: 'alpha', id: task.id, turnId: active.turnId,
    chunk: '\nLate output that must not return.\n' });
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'running', ...active });
  await wsPush('session:recalled', recalledPayload());
  assert.equal(await page.inputValue(composer), text, 'event + HTTP are idempotent');
  assert.ok(!(await page.textContent(consoleBox)).includes('Late output'));
  assert.equal(await page.locator(stop).count(), 0);
  assert.deepEqual(recalls, [{ requestId: active.requestId, turnId: active.turnId }]);
});

test('Esc works before message ACK; newer drafts and queued messages survive without automatic sends', opts, async () => {
  await load();
  messageHold = true;
  await send('Original to correct');
  await page.fill(composer, 'Follow-up queued');
  await page.press(composer, 'Enter');
  await page.fill(composer, 'Newer unsent draft');
  recallHold = true;
  await page.press(composer, 'Escape');
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent === 'Stopping…', stop);
  // A generic terminal event racing the recall must not drain this queue.
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting', ...active });
  assert.equal(messages.length, 1);
  await finishRecall();
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Original to correct', composer);
  assert.equal(await page.locator('[data-restore-draft]').count(), 1);
  assert.ok((await page.textContent('.savedComposerDraft')).includes('Newer unsent draft'));
  assert.ok((await page.textContent('.queuedBar')).includes('Paused'));
  assert.equal(messages.length, 1);
  await page.screenshot({ path: '/private/tmp/central-planner-restored-prompt.png', fullPage: true });
  await heldMessage.fulfill({ json: { ok: true, ...active } });
  heldMessage = null;
  await wsPush('session:recalled', recalledPayload());
  assert.equal(await page.inputValue(composer), 'Original to correct');
  await page.click('[data-restore-draft="0"]');
  assert.equal(await page.inputValue(composer), 'Newer unsent draft');
  assert.ok((await page.textContent('.savedComposerDraft')).includes('Original to correct'));
  await page.reload();
  await page.waitForSelector(composer);
  assert.equal(await page.inputValue(composer), 'Newer unsent draft', 'tab reload keeps both drafts');
  assert.equal(await page.locator('[data-restore-draft]').count(), 1);
  assert.ok((await page.textContent('.queuedBar')).includes('Follow-up queued'));
  assert.equal(messages.length, 1, 'reload does not send the parked follow-up');
});

test('failure retains output and newer draft, pauses queue, and leaves ordinary Stop available', opts, async () => {
  await load();
  await send('Do not hide on failure');
  await page.fill(composer, 'Park this');
  await page.press(composer, 'Enter');
  await page.fill(composer, 'Never overwrite this draft');
  rejectRecall = true;
  await page.click(stop);
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent.includes('⏹ stop'), stop);
  assert.equal(await page.inputValue(composer), 'Never overwrite this draft');
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent.includes('Do not hide on failure'), consoleBox);
  assert.ok((await page.textContent(consoleBox)).includes('Do not hide on failure'));
  assert.ok((await page.textContent('.queuedBar')).includes('Paused'));
  await page.click(stop);
  assert.equal(interrupts, 1);
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting', ...active });
  assert.equal(messages.length, 1);
});

test('five-second expiry keeps ordinary Stop, and successful completion closes correction early', opts, async () => {
  await load();
  await page.clock.install();
  try {
    await send('Too late to recall');
    await page.clock.fastForward(5001);
    await page.click(stop);
    assert.equal(recalls.length, 0);
    assert.equal(interrupts, 1);
    await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting', ...active });
    await send('Completes immediately');
    await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting', ...active });
    assert.equal(await page.locator(stop).count(), 0);
    await page.press(composer, 'Escape');
    assert.equal(recalls.length, 0);
  } finally { await page.clock.setSystemTime(new Date()); await page.clock.resume(); }
});

test('Esc respects IME, repeat, modifiers, an open modal, and editor surfaces', opts, async () => {
  await load();
  await send('Only intentional Escape cancels');
  await page.evaluate(sel => {
    const input = document.querySelector(sel);
    for (const extra of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...extra }));
    }
    const overlay = document.getElementById('modalBack');
    overlay.classList.add('show');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    editor.tabIndex = 0;
    document.querySelector('#v-alpha').appendChild(editor);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    editor.remove();
  }, composer);
  assert.equal(recalls.length, 0);
  await page.press(composer, 'Escape');
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Only intentional Escape cancels', composer);
  assert.equal(recalls.length, 1);
});

test('missed recall event heals on snapshot without overwriting another client draft or current task status', opts, async () => {
  await load();
  await page.fill(composer, 'This client did not send that prompt');
  await wsPush('session:stream', { project: 'alpha', id: task.id,
    chunk: '\n▸ you ─────────\nOther client recalled prompt\n— answer —\nRemove this answer\n' });
  const remote = { status: 'recalled', requestId: 'remote-request', turnId: 'remote-turn',
    prompt: 'Other client recalled prompt', transcript: structuredClone(prior) };
  snapshot.turnStates[`alpha/${task.id}`] = { lastRecalled: remote, recalledTurnIds: ['remote-turn'] };
  snapshot.tasks.alpha = [{ ...task, status: 'running' }];
  await wsPush('state', snapshot);
  await page.waitForFunction(sel => !document.querySelector(sel)?.textContent.includes('Remove this answer'), consoleBox);
  assert.equal(await page.inputValue(composer), 'This client did not send that prompt');
  assert.equal(await page.textContent(stop), '⏹ stop', 'historical recall never resets authoritative running status');
  await wsPush('state', snapshot);
  assert.equal(await page.inputValue(composer), 'This client did not send that prompt');
});

test('request IDs work without secure-context randomUUID and mismatched terminal events do not end this window', opts, async () => {
  await load();
  await page.evaluate(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
  await send('LAN HTTP submission');
  assert.match(active.requestId, /^[0-9a-f-]{36}$/);
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting',
    turnId: 'older-turn', requestId: 'older-request' });
  assert.ok((await page.textContent(stop)).includes('Stop & Edit'));
  await page.click(stop);
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'LAN HTTP submission', composer);
});

test('a second Enter before any running status queues instead of replacing the pending submission identity', opts, async () => {
  await load();
  messageHold = true;
  holdRunningStatus = true;
  await send('First pending request');
  await page.fill(composer, 'Second prompt must wait');
  await page.press(composer, 'Enter');
  assert.equal(messages.length, 1);
  assert.ok((await page.textContent('.queuedBar')).includes('Second prompt must wait'));
  await page.click(stop);
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'First pending request', composer);
  await heldMessage.fulfill({ json: { ok: true, ...active } });
  heldMessage = null;
  assert.equal(recalls[0].requestId, messages[0].requestId);
});

test('if message and recall both fail, the undelivered echo disappears and the original draft survives exactly once', opts, async () => {
  await load();
  messageHold = true;
  recallHold = true;
  await send('Both requests will fail');
  await page.fill(composer, 'Newer draft also survives');
  await page.click(stop);
  const deliveryDone = page.waitForResponse(response => response.url().endsWith('/message'));
  await heldMessage.fulfill({ status: 409, json: { error: 'Message rejected' } });
  heldMessage = null;
  await deliveryDone;
  await heldRecall.fulfill({ status: 409, json: { error: 'No accepted turn to restore' } });
  heldRecall = null;
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Both requests will fail', composer);
  await page.waitForFunction(sel => !document.querySelector(sel)?.textContent.includes('Both requests will fail'), consoleBox);
  assert.equal(await page.locator('[data-restore-draft]').count(), 1);
  assert.ok((await page.textContent('.savedComposerDraft')).includes('Newer draft also survives'));
  assert.equal(recalls.length, 1);
});

test('a recall arriving before server acceptance retries the same request after ACK without a new submission', opts, async () => {
  await load();
  messageHold = true;
  rejectRecall = true;
  await send('Pre-accept cancellation race');
  await page.click(stop);
  // The failed request may already have completed; wait for its route count,
  // not a delayed timeout that would extend the real five-second window.
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent === 'Stopping…', stop);
  assert.equal(recalls.length, 1);
  rejectRecall = false;
  await heldMessage.fulfill({ json: { ok: true, ...active } });
  heldMessage = null;
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Pre-accept cancellation race', composer);
  assert.equal(recalls.length, 2);
  assert.equal(recalls[0].requestId, recalls[1].requestId);
  assert.equal(messages.length, 1);
});

test('accepted rollback with a persistence failure exposes Retry restore beyond five seconds and blocks new sends', opts, async () => {
  await load();
  await send('Recover this accepted cancellation');
  recallHold = true;
  await page.click(stop);
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'running',
    phase: 'recall-recovery', recallFailed: true, ...active });
  await heldRecall.fulfill({ status: 500, json: { error: 'Local persistence failed; retry restore' } });
  heldRecall = null;
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent === 'Retry restore', stop);
  assert.equal(await page.isDisabled('#sendBtn'), true);
  await page.clock.fastForward(6000);
  await page.fill(composer, 'Must not be sent during recovery');
  await page.press(composer, 'Enter');
  assert.equal(messages.length, 1);
  recallHold = false;
  await page.click(stop);
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Recover this accepted cancellation', composer);
  assert.equal(recalls.length, 2);
  assert.ok((await page.textContent('.savedComposerDraft')).includes('Must not be sent during recovery'));
  await page.clock.setSystemTime(new Date());
  await page.clock.resume();
});

test('Escape cancels an active microphone before it can cancel the running model', opts, async () => {
  await load();
  await send('Voice Escape must not double-cancel');
  await page.click('#micBtn');
  await page.waitForSelector('.composer.vListening');
  await page.press(composer, 'Escape');
  assert.equal(await page.locator('.composer.vListening').count(), 0);
  assert.ok(await page.evaluate(() => window.__undoMicStops > 0));
  assert.equal(recalls.length, 0);
  await page.press(composer, 'Escape');
  await page.waitForFunction(sel => document.querySelector(sel)?.value === 'Voice Escape must not double-cancel', composer);
  assert.equal(recalls.length, 1);
});

test('an older transcript fetch resolving after recall cannot resurrect its removed user or output', opts, async () => {
  await load();
  await send('A stale transcript must not restore this');
  let staleRoute;
  const intercept = route => { staleRoute = route; };
  await page.route('**/api/transcript/*/*', intercept);
  try {
    const requested = page.waitForRequest(request => request.url().includes('/api/transcript/'));
    await page.evaluate(async id => {
      const { refreshTranscript } = await import('/files.js');
      window.__undoOldFetch = refreshTranscript('alpha', id, { reconcileTail: true });
    }, task.id);
    await requested;
    await page.click(stop);
    await page.waitForFunction(sel => document.querySelector(sel)?.value === 'A stale transcript must not restore this', composer);
    await staleRoute.fulfill({ json: { transcript: [...prior,
      { role: 'user', text: 'A stale transcript must not restore this' },
      { role: 'assistant', text: 'Stale answer must remain hidden' },
    ] } });
    await page.evaluate(() => window.__undoOldFetch);
    assert.ok(!(await page.textContent(consoleBox)).includes('Stale answer'));
    const cached = await page.evaluate(async id => {
      const { transcripts } = await import('/store.js');
      return transcripts[`alpha/${id}`].entries;
    }, task.id);
    assert.deepEqual(cached, prior);
  } finally { await page.unroute('**/api/transcript/*/*', intercept); }
});
