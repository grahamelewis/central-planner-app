// Provider controls + Codex usage + responsive light-mode regression. Billed
// routes are intercepted by uiHarness and both real CLIs are pinned away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
let ui, sb, page, wsPush, taskId;

const CODEX = (over = {}) => ({
  available: true, connected: true, checking: false, loggingIn: false,
  account: { type: 'chatgpt', email: 'researcher@example.test', planType: 'pro' },
  lastChecked: new Date().toISOString(), error: null,
  models: [
    { id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] },
    { id: 'gpt-5.3-codex-spark', label: 'Codex Spark', defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ id: 'medium' }, { id: 'high' }] },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', supportedReasoningEfforts: [{ id: 'low' }, { id: 'medium' }] },
  ],
  ...over,
});

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({ viewport: { width: 1440, height: 900 } });
  ({ sb, page, wsPush } = ui);
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Provider-aware task', category: 'calibration', oversight: 'coop',
  });
  taskId = task.id;
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .statusbar', { timeout: 15000 });
  await wsPush('provider:status', { provider: 'codex', state: CODEX() });
  await sleep(250);
});

after(async () => { if (ui) await ui.stop(); });

test('combined provider/model picker switches a fresh task to Codex and reveals effort', opts, async () => {
  await page.click('.drop[data-drop="model"] .dropBtn');
  await page.click('#dropPortal .dropItem[data-provider="codex"][data-val="gpt-5.6-codex"]');
  await page.waitForFunction(() => document.querySelector('.drop[data-drop="model"] .dropBtn')?.textContent.includes('Codex'));
  const view = await page.evaluate(() => ({
    trigger: document.querySelector('.drop[data-drop="model"] .dropBtn')?.textContent,
    effort: document.querySelector('.drop[data-drop="effort"] .dropBtn')?.textContent,
  }));
  assert.match(view.trigger, /Codex · GPT-5.6 Codex/);
  assert.match(view.effort, /high/);
  const { body: saved } = await sb.fetchJson('GET', '/api/state');
  const task = saved.tasks.alpha.find(t => t.id === taskId);
  assert.equal(task.provider, 'codex');
  assert.equal(task.model, 'gpt-5.6-codex');
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await page.waitForSelector('#composerInput');
  assert.equal(await page.getAttribute('#composerInput', 'placeholder'), 'Message Codex…');
  if (process.env.CP_QA_SHOTS) {
    await page.evaluate(() => { localStorage.setItem('theme', 'dark'); document.documentElement.removeAttribute('data-theme'); });
    await page.screenshot({ path: '/tmp/cp-provider-desktop-dark.png', fullPage: true });
  }
});

test('Codex meter hides unused Spark and contains its long label when Spark is selected', opts, async () => {
  await wsPush('provider:status', { provider: 'codex', state: CODEX({
    usage: { source: 'plan', provider: 'codex', subscription: 'pro', fetchedAt: new Date().toISOString(), limits: [
      { key: 'codex:primary', name: '5h session', sub: 'Codex', pct: 47, resetAt: new Date(Date.now() + 3600e3).toISOString(), real: true },
      { key: 'codex:secondary', name: 'weekly limit', sub: 'Codex', pct: 18, resetAt: new Date(Date.now() + 86400e3).toISOString(), real: true },
      { key: 'spark:primary', name: 'weekly limit', sub: 'GPT-5.3-Codex-Spark-with-an-intentionally-enormous-provider-label',
        fullSub: 'GPT-5.3-Codex-Spark-with-an-intentionally-enormous-provider-label', scopeModel: 'spark',
        pct: 0, resetAt: new Date(Date.now() + 6 * 86400e3).toISOString(), real: true },
    ] },
  }) });
  await sleep(150);
  let meter = await page.evaluate(() => {
    const q = document.querySelector('.statusbar > .quota[data-provider="codex"]');
    return {
      display: getComputedStyle(q).display,
      pct: q.querySelector(':scope > .qpct').textContent,
      label: q.querySelector(':scope > .qlab').textContent,
      rows: [...q.querySelectorAll('.qpRow')].map(r => r.dataset.key),
    };
  });
  assert.notEqual(meter.display, 'none');
  assert.equal(meter.pct, '47%');
  assert.match(meter.label, /Codex · 5h session/);
  assert.deepEqual(meter.rows, ['codex:primary', 'codex:secondary'],
    'Spark is irrelevant while the active task uses a general Codex model');

  await page.click('.drop[data-drop="model"] .dropBtn');
  await page.click('#dropPortal .dropItem[data-provider="codex"][data-val="gpt-5.3-codex-spark"]');
  await page.hover('.statusbar > .quota[data-provider="codex"]');
  await sleep(300);
  meter = await page.evaluate(() => {
    const q = document.querySelector('.statusbar > .quota[data-provider="codex"]');
    const pop = q.querySelector('.qpop');
    const pad = parseFloat(getComputedStyle(pop).paddingRight);
    const contentEdge = pop.getBoundingClientRect().right - pad;
    const sparkName = q.querySelector('.qpRow[data-key="spark:primary"] .qpN');
    const sparkSub = sparkName.querySelector('small');
    return {
      rows: [...q.querySelectorAll('.qpRow')].map(r => r.dataset.key),
      popRight: pop.getBoundingClientRect().right,
      viewportRight: innerWidth,
      overflow: [...pop.querySelectorAll('.qpRow *')]
        .map(el => el.getBoundingClientRect().right - contentEdge)
        .filter(n => n > 0.5),
      ellipsized: sparkSub.scrollWidth > sparkSub.clientWidth,
      title: sparkName.title,
    };
  });
  assert.deepEqual(meter.rows, ['codex:primary', 'codex:secondary', 'spark:primary']);
  assert.ok(meter.popRight <= meter.viewportRight, 'popover stays inside the viewport');
  assert.deepEqual(meter.overflow, [], 'no row content escapes the popover padding');
  assert.ok(meter.ellipsized, 'the long provider label is visibly truncated');
  assert.match(meter.title, /intentionally-enormous-provider-label/, 'the full name remains available as a tooltip');
  if (process.env.CP_QA_SHOTS) await page.screenshot({ path: '/tmp/cp-provider-both-usage-dark.png', fullPage: true });
});

test('AI service cards stay contained in light mode at a phone-width viewport, including neither-connected state', opts, async () => {
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show .serviceGrid');
  await page.click('[data-th="light"]');
  await wsPush('provider:status', { provider: 'codex', state: CODEX({ connected: false, account: null, models: [], error: 'signed out' }) });
  await wsPush('auth:status', { needed: true, method: 'oauth', loggedIn: false, available: true, lastChecked: new Date().toISOString() });
  await page.setViewportSize({ width: 390, height: 800 });
  await sleep(250);
  const fit = await page.evaluate(() => ({
    light: document.documentElement.dataset.theme,
    cards: document.querySelectorAll('.serviceCard').length,
    notice: document.querySelector('.serviceNotice')?.textContent,
    doc: document.documentElement.scrollWidth,
    viewport: innerWidth,
    settings: document.querySelector('#v-settings .frame').scrollWidth,
    settingsClient: document.querySelector('#v-settings .frame').clientWidth,
  }));
  assert.equal(fit.light, 'light');
  assert.equal(fit.cards, 2);
  assert.match(fit.notice, /No AI service is connected/);
  assert.ok(fit.doc <= fit.viewport, `document overflowed: ${fit.doc} > ${fit.viewport}`);
  assert.ok(fit.settings <= fit.settingsClient + 1, `settings overflowed: ${fit.settings} > ${fit.settingsClient}`);
  if (process.env.CP_QA_SHOTS) {
    await sleep(3600); // let the earlier provider-selection toast clear for inspection
    await page.screenshot({ path: '/tmp/cp-provider-settings-light-narrow.png', fullPage: true });
  }
});
