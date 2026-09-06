// Running-status regressions: real frontend, synthetic session events only.
// uiHarness blocks billed routes; no model requests are made by these tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };
let ui, sb, page, wsPush, task, base, snapshot;
const status = '#v-alpha #consoleBox .csVerb .runActivity';
const label = `${status} .runActivityLabel`;
const timer = `${status} .runActivityTime`;
const seconds = text => text.trim().split(':').reduce((n, part) => n * 60 + Number(part), 0);

before(async () => {
  if (opts.skip) return;
  ui = await startUI();
  ({ sb, page, wsPush } = ui);
  ({ body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Activity fixture', description: 'No model is launched.',
    oversight: 'coop', context: { files: [] },
  }));
  task = { ...task, status: 'running', session: {
    sdkSessionId: 'activity-fixture', startedAt: '2020-01-01T00:00:00Z',
    lastTurnAt: '2020-01-01T00:00:00Z', turns: 4,
    tokensIn: 0, tokensOut: 0, costUsd: 0,
  } };
  ({ body: base } = await sb.fetchJson('GET', '/api/state'));
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/tasks/*/*/interrupt', route => route.fulfill({ json: { ok: true } }));
});
after(async () => { if (ui) await ui.stop(); });

async function load({ ageMs = 65000, activity = null, knownStart = true, view = 'alpha' } = {}) {
  const turnStartedAt = knownStart ? new Date(Date.now() - ageMs).toISOString() : null;
  snapshot = { ...base, tasks: { ...base.tasks, alpha: [task] }, sessions: [{
    project: 'alpha', id: task.id, running: true, status: 'running',
    turnStartedAt, activity,
  }] };
  await page.goto(`${sb.base}/#${view}`);
  await page.reload(); // reset client caches, approval state, and local ticking
  await page.waitForSelector(view === 'alpha' ? status : '#v-ov .runActivity', { timeout: 15000 });
  return turnStartedAt;
}

async function expectLabel(value, selector = label) {
  await page.waitForFunction(([sel, text]) => document.querySelector(sel)?.textContent === text,
    [selector, value], { timeout: 5000 });
}

test('running console has quiet status and a current-turn timer that patches stable DOM', opts, async () => {
  await load();
  await expectLabel('Working');
  assert.equal(await page.locator('.claudeVerb').count(), 0);
  assert.equal(await page.locator(`${status} .runActivityDot`).getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator(timer).getAttribute('role'), 'timer');
  assert.equal(await page.locator(timer).getAttribute('aria-live'), 'off', 'clock ticks do not become live announcements');
  const before = seconds(await page.textContent(timer));
  assert.ok(before >= 65 && before < 90, 'uses current turn, not the years-old session start');
  await page.evaluate(sel => {
    window.__activityNode = document.querySelector(sel);
    window.__activityTimeNode = document.querySelector(`${sel} .runActivityTime`);
    window.__activityConsole = document.querySelector('#v-alpha #consoleBox .csegWrap');
  }, status);
  await page.waitForFunction(([sel, first]) => {
    const value = document.querySelector(sel)?.textContent || '';
    return value.split(':').reduce((n, part) => n * 60 + Number(part), 0) > first;
  }, [timer, before], { timeout: 4000 });
  assert.equal(await page.evaluate(sel => window.__activityNode === document.querySelector(sel)
    && window.__activityTimeNode === document.querySelector(`${sel} .runActivityTime`)
    && window.__activityConsole === document.querySelector('#v-alpha #consoleBox .csegWrap'), status), true);
});

test('real activity updates in console and overview without rotating or interpreting prose', opts, async () => {
  const turnStartedAt = await load();
  await wsPush('session:activity', { project: 'alpha', id: task.id, turnStartedAt,
    activity: { label: 'Reading files' } });
  await expectLabel('Reading files');
  await wsPush('session:stream', { project: 'alpha', id: task.id,
    chunk: '\n— answer —\nI might run tests later.\n' });
  await expectLabel('Reading files');
  await page.click('#nav .tab[data-v="ov"]');
  await page.waitForSelector('#v-ov.show');
  const ov = '#v-ov .runActivity';
  await expectLabel('Reading files', `${ov} .runActivityLabel`);
  await page.evaluate(sel => { window.__overviewActivity = document.querySelector(sel); }, ov);
  await wsPush('session:activity', { project: 'alpha', id: task.id, turnStartedAt,
    activity: { label: 'Running command' } });
  await expectLabel('Running command', `${ov} .runActivityLabel`);
  assert.equal(await page.evaluate(sel => window.__overviewActivity === document.querySelector(sel), ov), true,
    'activity patches the overview card rather than rebuilding it');
  await wsPush('session:activity', { project: 'alpha', id: task.id, turnStartedAt, activity: null });
  await expectLabel('Working', `${ov} .runActivityLabel`);
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting' });
  assert.equal(await page.locator(`${ov}[data-task="${task.id}"]`).count(), 0);
});

test('completion clears activity and a new turn resets elapsed without reviving stale snapshot data', opts, async () => {
  const previousStart = await load({ activity: { label: 'Searching files' }, ageMs: 125000 });
  await expectLabel('Searching files');
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting' });
  assert.equal(await page.locator('#v-alpha #consoleBox .csVerb').count(), 0);
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'running',
    turnStartedAt: new Date().toISOString() });
  await expectLabel('Working');
  assert.ok(seconds(await page.textContent(timer)) < 10, 'new turn starts at zero');
  await wsPush('session:activity', { project: 'alpha', id: task.id,
    turnStartedAt: previousStart, activity: { label: 'Searching files' } });
  await expectLabel('Working');
  assert.ok(seconds(await page.textContent(timer)) < 10, 'late prior-turn activity cannot replace the new clock');
});

test('concurrent overview tasks keep independent activity and clocks', opts, async () => {
  await load({ activity: { label: 'Reading files' } });
  const other = { ...task, id: `${task.id}-other`, title: 'Second activity fixture' };
  const otherStart = new Date(Date.now() - 125000).toISOString();
  snapshot = { ...snapshot, tasks: { ...snapshot.tasks, alpha: [task, other] },
    sessions: [...snapshot.sessions, { project: 'alpha', id: other.id, status: 'running',
      turnStartedAt: otherStart, activity: { label: 'Running command' } }] };
  await wsPush('state', snapshot);
  await page.click('#nav .tab[data-v="ov"]');
  const first = `#v-ov .runActivity[data-task="${task.id}"]`;
  const second = `#v-ov .runActivity[data-task="${other.id}"]`;
  await expectLabel('Reading files', `${first} .runActivityLabel`);
  await expectLabel('Running command', `${second} .runActivityLabel`);
  const firstSeconds = seconds(await page.textContent(`${first} .runActivityTime`));
  const secondSeconds = seconds(await page.textContent(`${second} .runActivityTime`));
  assert.ok(secondSeconds - firstSeconds >= 55, 'each task retains its own turn clock');
  await wsPush('session:activity', { project: 'alpha', id: other.id,
    turnStartedAt: otherStart, activity: { label: 'Writing response' } });
  await expectLabel('Writing response', `${second} .runActivityLabel`);
  await expectLabel('Reading files', `${first} .runActivityLabel`);
  await wsPush('session:status', { project: 'alpha', id: other.id, status: 'waiting' });
  assert.equal(await page.locator(second).count(), 0);
  await expectLabel('Reading files', `${first} .runActivityLabel`);
});

test('snapshot restoration keeps actual activity and elapsed; unknown timestamp stays hidden', opts, async () => {
  await load({ ageMs: 3665000, activity: { label: 'Writing response' } });
  await expectLabel('Writing response');
  assert.match((await page.textContent(timer)).trim(), /^1:01:\d{2}$/);
  await load({ knownStart: false });
  await expectLabel('Working');
  assert.equal(await page.locator(timer).isVisible(), false,
    'no invented elapsed time when the server has no turn timestamp');
});

test('pending approval and stopping override ordinary activity', opts, async () => {
  await load({ activity: { label: 'Running command' } });
  await wsPush('session:permission', { project: 'alpha', id: task.id,
    requestId: 'activity-approval', tool: 'Bash', input: { command: 'echo fixture' } });
  await expectLabel('Awaiting approval');
  await wsPush('session:permission:resolved', { project: 'alpha', id: task.id, requestId: 'activity-approval' });
  await expectLabel('Running command');
  await page.click('#v-alpha #interruptBtn');
  await expectLabel('Stopping');
  await wsPush('session:status', { project: 'alpha', id: task.id, status: 'waiting' });
  assert.equal(await page.locator('#v-alpha #consoleBox .csVerb').count(), 0);
});

test('reduced motion disables the decorative pulse', opts, async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load();
  assert.equal(await page.locator(`${status} .runActivityDot`).evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
