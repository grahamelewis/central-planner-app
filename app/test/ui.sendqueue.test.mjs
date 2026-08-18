// Mid-turn composer sends — the joined-pane bug (2026-08-06).
//
// Sending while a turn streamed used to POST anyway: the server 409'd it (one
// turn at a time), the optimistic `▸ you` echo stranded mid-stream, and every
// later chunk of the still-running answer rendered INSIDE the you-bubble.
// The message itself was silently lost.
//
// Now a mid-turn Enter queues the message (visible strip + console note),
// the turn-end session:status flushes the queue as one send, and a send the
// server refuses rolls back its echoes and returns the text to the composer.
// Tests share one staged session and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, chunked, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id;
const msgPosts = [];   // bodies of every POST …/message the page attempted
let refuse = false;    // route flips to a 409 for the rollback test

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'β = 0.96\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  // replace the harness's blanket /message stub with a recording one (still
  // fulfilled in-browser — nothing billed ever reaches the server)
  await page.unroute('**/api/tasks/*/*/message');
  await page.route('**/api/tasks/*/*/message', (r) => {
    msgPosts.push(JSON.parse(r.request().postData() || '{}'));
    if (refuse) r.fulfill({ status: 409, json: { error: 'Task already has an active turn' } });
    else r.fulfill({ json: { ok: true } });
  });

  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate model', description: 'Fit β.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({
    created: created.created,
    entries: [
      { role: 'user', text: 'Calibrate the model to the baseline sample.', ts: created.created },
      { role: 'assistant', text: 'Done — moment match **0.83**.', ts: created.created },
    ],
  }));

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(700);
  // open ≋ console so the tail seeds from the transcript, THEN go live
  await page.click('#v-alpha .ctab[data-fi="tail"]');
  await sleep(300);
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const consoleText = () => page.evaluate(() =>
  document.querySelector('#v-alpha #consoleBox')?.innerText || '');
const youBubbles = () => page.evaluate(() =>
  [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-you')].map(e => e.innerText));
const stream = async (text, n = 30, everyMs = 25) => {
  for (const chunk of chunked(text, n)) {
    await wsPush('session:stream', { project: 'alpha', id, chunk });
    await sleep(everyMs);
  }
  await sleep(300); // reveal pump catches up
};

test('Enter during a running turn queues — nothing is POSTed, nothing strands in the stream', opts, async () => {
  assert.equal(await page.getAttribute('#composerInput', 'placeholder'), 'Queue a message…');
  await stream('\n∴ thinking…\nchecking the payment branch\n— answer —\nThe landlord section holds. ');
  await page.fill('#composerInput', 'sidenote: make the panes unscrollable');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  assert.equal(msgPosts.length, 0, 'no POST while the turn runs');
  assert.equal(await page.inputValue('#composerInput'), '', 'composer cleared');
  const strip = await page.textContent('#v-alpha .queuedBar');
  assert.ok(strip.includes('sidenote: make the panes unscrollable'), 'queued strip shows the message');
  assert.ok(strip.includes('sends when this turn ends'), 'strip says when it sends');
  assert.match(await consoleText(), /message queued/, 'console tail carries the ⏳ note');
  assert.ok(!(await consoleText()).includes('sidenote: make the panes'),
    'the queued text is NOT spliced into the live stream');
});

test('the still-streaming answer keeps rendering as claude text, never inside a you-bubble', opts, async () => {
  await stream('Ex ante landlord value (L7) stays old.');
  const txt = await consoleText();
  assert.ok(txt.includes('Ex ante landlord value (L7) stays old.'), 'streamed answer visible');
  const yous = await youBubbles();
  assert.equal(yous.length, 1, 'only the seeded transcript you-bubble exists');
  assert.ok(!yous.some(t => t.includes('Ex ante landlord value')),
    'the joined-pane bug: streamed answer must not render inside a you-bubble');
});

test('a second Enter stacks; × returns a message to the composer', opts, async () => {
  await page.fill('#composerInput', 'second thought');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  assert.equal(msgPosts.length, 0);
  assert.equal(await page.locator('#v-alpha .queuedMsg').count(), 2, 'two messages queued');
  await page.click('#v-alpha .queuedMsg [data-unqueue="1"]');
  await sleep(300);
  assert.equal(await page.locator('#v-alpha .queuedMsg').count(), 1, 'one left after ×');
  assert.equal(await page.inputValue('#composerInput'), 'second thought', '× returns the text');
  await page.fill('#composerInput', ''); // clear the draft for the next tests
  await sleep(150);
});

test('turn end flushes the queue as one send and echoes it into the console', opts, async () => {
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  assert.equal(msgPosts.length, 1, 'exactly one POST at turn end');
  assert.equal(msgPosts[0].text, 'sidenote: make the panes unscrollable');
  const yous = await youBubbles();
  assert.equal(yous.length, 2, 'the delivered message is a you-bubble now');
  assert.ok(yous.some(t => t.includes('sidenote: make the panes unscrollable')));
  assert.equal(await page.locator('#v-alpha .queuedBar').count(), 0, 'strip gone');
  assert.ok(!(await consoleText()).includes('message queued'), 'console ⏳ note gone');
});

test('a refused send rolls back its echoes and keeps the text in the composer', opts, async () => {
  refuse = true;
  await page.fill('#composerInput', 'doomed message');
  await page.press('#composerInput', 'Enter');
  await sleep(500);
  assert.equal(msgPosts.length, 2, 'the send was attempted');
  assert.equal(msgPosts[1].text, 'doomed message');
  assert.ok(!(await consoleText()).includes('doomed message'), 'console echo rolled back');
  assert.equal((await youBubbles()).length, 2, 'no stranded you-bubble');
  assert.equal(await page.inputValue('#composerInput'), 'doomed message',
    'the refused text is back in the composer, not lost');
  refuse = false;
});
