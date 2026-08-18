// The sign-in card in the real frontend (headless Chrome, stubbed WS) — and
// the narrow-pane readability guarantee: every session-pane state must stay
// readable with the right column at its 300px minimum and a short split.
// Tests share one staged session and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, idQueued;
const loginPosts = [];
const retryPosts = [];
let checkReply = { loggedIn: true, needed: false };

const AUTH = (over = {}) => ({
  needed: true, method: 'oauth', loggedIn: false, email: null,
  checking: false, loggingIn: false, loginError: null,
  lastChecked: new Date().toISOString(), available: true,
  reason: 'Invalid API key · Please run /login', ...over,
});

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({ viewport: { width: 1500, height: 950 } });
  ({ sb, page, wsPush } = ui);
  // observe the card's calls (registered after the harness defaults → wins)
  await page.route('**/api/auth/login', (r) => { loginPosts.push(1); r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/auth/check', (r) => { r.fulfill({ json: checkReply }); });
  await page.route('**/api/tasks/*/*/retry', (r) => { retryPosts.push(r.request().url()); r.fulfill({ json: { ok: true } }); });

  const { body: t1 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Estimate the baseline', description: 'x',
    category: 'calibration', oversight: 'coop',
  });
  id = t1.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: { sdkSessionId: 's1', startedAt: t1.created, lastTurnAt: t1.created, tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1 },
  });
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Queued sweep', description: 'x', category: 'calibration', oversight: 'auto',
  });
  idQueued = t2.id;

  await page.goto(`${sb.base}/#alpha`);
  // the readability squeeze: right column at its 300px floor, short split
  await page.evaluate(() => { localStorage.wbCenterPx = '2000'; localStorage.wbVSplit = '55'; });
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600);
  await page.click(`.ptab.tk[data-id="${id}"]`);
  await sleep(400);
});

after(async () => { if (ui) await ui.stop(); });

const card = () => page.evaluate(() => {
  const el = document.querySelector('#v-alpha .authCard');
  if (!el) return null;
  return {
    heading: el.querySelector('.acH')?.textContent,
    signBtn: !!el.querySelector('#authSignBtn'),
    retryBtn: !!el.querySelector('#authRetryBtn'),
    waiting: el.querySelector('.acWait')?.textContent || null,
    error: el.querySelector('.acErr')?.textContent || null,
    fallback: el.querySelector('.acFall')?.textContent || null,
  };
});

// nothing in the session pane may overflow horizontally (intentional
// scrollers and single-line ellipses excepted)
const paneOverflows = () => page.evaluate(() => {
  const root = document.querySelector('#v-alpha .sessHalf');
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollWidth > el.clientWidth + 1
      && !['PRE', 'TEXTAREA', 'SELECT'].includes(el.tagName)
      && !el.closest('pre, textarea, select, table, .tool, .stab')) {
      out.push(`${el.tagName}.${String(el.className || '').split(/\s+/).slice(0, 2).join('.')}`);
    }
  }
  return out;
});

test('signed-out: the card appears with Sign in + Retry, and fits the narrow pane', opts, async () => {
  await wsPush('auth:status', AUTH());
  await sleep(400);
  const c = await card();
  assert.ok(c, 'card rendered');
  assert.match(c.heading, /login has expired/i);
  assert.ok(c.signBtn, 'Sign in offered');
  assert.ok(c.retryBtn, 'Retry offered (task has a session)');
  assert.match(c.fallback, /claude auth login/);
  assert.deepEqual(await paneOverflows(), []);
});

test('a queued task mounts the card on its launch card — Sign in only', opts, async () => {
  await page.click(`.ptab.tk[data-id="${idQueued}"]`);
  await sleep(400);
  const c = await card();
  assert.ok(c, 'card rendered on the launch card');
  assert.ok(c.signBtn);
  assert.ok(!c.retryBtn, 'nothing to retry before the first launch');
  assert.deepEqual(await paneOverflows(), []);
  await page.click(`.ptab.tk[data-id="${id}"]`);
  await sleep(300);
});

test('Sign in posts /api/auth/login; the loggingIn broadcast shows the spinner', opts, async () => {
  await page.click('#authSignBtn');
  await sleep(250);
  assert.equal(loginPosts.length, 1);
  await wsPush('auth:status', AUTH({ loggingIn: true }));
  await sleep(250);
  const c = await card();
  assert.ok(!c.signBtn && !c.retryBtn, 'buttons yield to the spinner');
  assert.match(c.waiting, /opening the browser sign-in/i);
  assert.deepEqual(await paneOverflows(), []);
});

test('a failed sign-in shows the error and restores the buttons', opts, async () => {
  await wsPush('auth:status', AUTH({ loginError: 'sign-in did not complete — the browser window may have been closed' }));
  await sleep(250);
  const c = await card();
  assert.ok(c.signBtn, 'Sign in is back');
  assert.match(c.error, /did not complete/);
  assert.deepEqual(await paneOverflows(), []);
});

test('Retry checks the sign-in, then posts the retry when signed in', opts, async () => {
  checkReply = { loggedIn: true, needed: false };
  await page.click('#authRetryBtn');
  await sleep(300);
  assert.equal(retryPosts.length, 1);
  assert.match(retryPosts[0], new RegExp(`/api/tasks/alpha/${id}/retry$`));
});

test('still signed out: Retry does NOT fire the billed retry', opts, async () => {
  await wsPush('auth:status', AUTH());
  await sleep(250);
  checkReply = { loggedIn: false, needed: true };
  await page.click('#authRetryBtn');
  await sleep(300);
  assert.equal(retryPosts.length, 1, 'no second retry post');
});

test('signed back in: the card clears everywhere', opts, async () => {
  await wsPush('auth:status', { needed: false, method: 'oauth', loggedIn: true, email: 'g@x.com', checking: false, loggingIn: false, loginError: null });
  await sleep(300);
  assert.equal(await card(), null);
});

test('apikey mode: no Sign in button — the fix is the env, not the browser', opts, async () => {
  await wsPush('auth:status', AUTH({ method: 'apikey' }));
  await sleep(300);
  const c = await card();
  assert.match(c.heading, /API key/i);
  assert.ok(!c.signBtn);
  assert.deepEqual(await paneOverflows(), []);
  await wsPush('auth:status', { needed: false, method: 'oauth', loggedIn: true });
});

test('readability: question, handoff, and running states fit the narrow pane', opts, async () => {
  const longPath = 'raw/dataset_2026_revision_final_v3_supplemental/records_component_by_unit.dta';
  const { body: tq } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    question: `The revision file ${longPath} has 118 fewer records — drop them everywhere or reweight the baseline sample?`,
  });
  await wsPush('task:update', { project: 'alpha', task: tq });
  await sleep(350);
  assert.deepEqual(await paneOverflows(), [], 'question state');

  // a handoff renders only on a DONE task now — waiting tasks show no
  // proposal banner (sessions can't suggest completion anymore)
  const { body: th } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    question: null,
    status: 'done',
    handoff: {
      summary: 'Re-estimated the baseline on the revised extract.',
      artifacts: [[`models/model_a/estimation/output/reestimate_moments_table.tex`, 'headline table']],
      numbers: [['param_a', '0.9714'], ['param_b', '0.0413']],
      decisions: ['kept the baseline weights unchanged'],
      next: 'sweep the parameter grid',
    },
  });
  await wsPush('task:update', { project: 'alpha', task: th });
  await sleep(350);
  assert.deepEqual(await paneOverflows(), [], 'handoff state');

  const { body: tr } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'running', handoff: null });
  await wsPush('task:update', { project: 'alpha', task: tr });
  await wsPush('session:permission', {
    project: 'alpha', id, requestId: 'p1', tool: 'Bash',
    input: { command: `julia --project=. models/model_a/estimation/reestimate.jl --threads=8` },
  });
  await sleep(350);
  assert.deepEqual(await paneOverflows(), [], 'running + approval hint');
});
