import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, CHROME } from './uiHarness.mjs';
import { createMemoryService } from '../lib/taskMemory.js';
import { MEMORY_DEFAULTS } from '../lib/memorySettings.js';

const opts = { skip: !fs.existsSync(CHROME) };
let ui;
const errors = [];
before(async () => {
  if (opts.skip) return;
  ui = await startUI({ seed: async ({ root }) => {
    const task = { id: 'alp-001', project: 'alpha', title: 'Checkpoint inspection', created: '2026-09-04T00:00:00Z', status: 'manual', oversight: 'manual', context: { files: [] } };
    fs.writeFileSync(path.join(root, 'tasks/alpha.json'), JSON.stringify([task]));
    const events = [{ role: 'user', text: 'Preserve the original constraints.', ts: 'a' }];
    const content = { findings: ['First finding <img src=x onerror=alert(1)>'], constraints: ['Do not change production.'], uncertainties: ['Units unverified.'], nextSteps: ['Check the fixture.'], evidence: [{ claim: 'User constraint.', source: 'event-1' }] };
    const service = createMemoryService({ root, settings: { get: () => ({ ...MEMORY_DEFAULTS, enabled: true, dailyBudgetUsd: 1 }) },
      getTask: () => task, getTranscript: () => events, isActive: () => false,
      request: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }], usage: { input_tokens: 500, output_tokens: 150 } }),
    });
    await service.run('alpha', task.id);
    events.push({ role: 'assistant', text: 'Second finding.', ts: 'b' }); content.findings = ['Second finding.'];
    await service.run('alpha', task.id); service.close();
    fs.mkdirSync(path.join(root, 'transcripts/alpha'), { recursive: true });
    fs.writeFileSync(path.join(root, 'transcripts/alpha/alp-001.json'), JSON.stringify({ created: task.created, entries: events }));
  } });
  ui.page.on('pageerror', e => errors.push(e.message));
});
after(async () => { await ui?.stop(); });

test('memory accounting distinguishes unknown observations from zero and shows exact recorded totals', opts, async () => {
  const { page, sb } = ui;
  const endpoint = '**/api/tasks/alpha/alp-001/memory';
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.inputTokens = 1268709;
    data.totals.incompleteJobs = 1;
    data.jobs[0].usage = { inputTokens: null, outputTokens: null, completeness: 'unknown' };
    data.jobs[0].ledgerWarning = 'Usage saved here, but the shared ledger could not be updated.';
    await route.fulfill({ response, json: data });
  });
  try {
    await page.goto(`${sb.base}/?memory-accounting-test#alpha`, { waitUntil: 'domcontentloaded' });
    await page.locator('#taskMemoryBtn').click();
    await page.locator('.memoryStats').waitFor();
    assert.equal(await page.locator('.memoryStats b').first().innerText(), '1,268,709 recorded');
    const text = await page.locator('#taskMemoryDialog').innerText();
    assert.match(text, /incomplete or historically unverified/);
    await page.locator('.memoryJobs summary').click();
    assert.match(await page.locator('.memoryJobs').innerText(), /unknown in \/ unknown out/);
    assert.match(await page.locator('.memoryJobs').innerText(), /shared ledger could not be updated/);
    await page.keyboard.press('Escape');
  } finally { await page.unroute(endpoint); }
});

test('settings model selection persists independently; credential status and pilot boundaries are visible', opts, async () => {
  const { page, sb } = ui;
  await page.goto(`${sb.base}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('#memorySettingsForm').waitFor();
  assert.match(await page.locator('#memorySettings').innerText(), /Checkpoint-only pilot/i);
  assert.match(await page.locator('#memorySettings').innerText(), /Connect Codex with ChatGPT/);
  assert.equal(await page.locator('[name=connection]').inputValue(), 'codex-subscription');
  assert.equal(await page.locator('[name=model]').inputValue(), 'gpt-5.6-luna');
  assert.equal(await page.locator('[name=dailyBudgetUsd]').isVisible(), false);
  assert.equal(await page.locator('[name=dailyJobLimit]').isVisible(), true);
  await page.locator('[name=connection]').selectOption('claude-sdk');
  assert.match(await page.locator('#memorySettings').innerText(), /Claude is not signed in/);
  assert.equal(await page.locator('[name=dailyBudgetUsd]').isVisible(), true);
  assert.equal(await page.locator('[name=dailyJobLimit]').isVisible(), false);
  assert.deepEqual(await page.locator('[name=model] option').evaluateAll(els => els.map(e => e.value)), ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']);
  await page.locator('[name=model]').selectOption('claude-haiku-4-5');
  assert.deepEqual(await page.locator('[name=reasoningEffort] option').evaluateAll(els => els.map(e => e.value)), ['none']);
  assert.equal(await page.locator('[name=enabled]').isChecked(), false);
  const original = (await sb.fetchJson('GET', '/api/state')).body.agentDefaults;
  await page.locator('[name=connection]').selectOption('codex-subscription');
  assert.match(await page.locator('#memorySettings').innerText(), /Connect Codex with ChatGPT/);
  await page.locator('[name=dailyJobLimit]').fill('8');
  await page.getByRole('button', { name: 'Save memory settings' }).click();
  await page.waitForFunction(() => document.querySelector('#memorySettingsForm button')?.textContent === 'Save memory settings' && !document.querySelector('#memorySettingsForm button')?.disabled);
  assert.equal((await sb.fetchJson('GET', '/api/memory/settings')).body.dailyJobLimit, 8);
  assert.deepEqual((await sb.fetchJson('GET', '/api/state')).body.agentDefaults, original);
  await page.locator('#memorySettings').screenshot({ path: '/private/tmp/cp-memory-settings.png' });
  assert.deepEqual(errors, []);
});

test('task memory displays current and prior versions, escapes content, and closes with Escape', opts, async () => {
  const { page, sb } = ui;
  await page.goto(`${sb.base}/?memory-panel-test#alpha`, { waitUntil: 'domcontentloaded' });
  await page.locator('#taskMemoryBtn').click();
  await page.locator('#memoryVersion').waitFor();
  assert.match(await page.locator('#taskMemoryDialog').innerText(), /Inspection only/);
  assert.match(await page.locator('.memorySections').innerText(), /Second finding/);
  assert.equal(await page.locator('#memoryUpdate').isDisabled(), true);
  await page.locator('#memoryVersion').selectOption('1');
  await page.waitForFunction(() => document.querySelector('.memorySections')?.textContent.includes('First finding'));
  assert.equal(await page.locator('.memorySections img').count(), 0);
  assert.match(await page.locator('.memorySections').innerText(), /<img src=x onerror=alert\(1\)>/);
  await page.locator('.memorySource').click();
  await page.locator('#memoryEvidence pre').waitFor();
  assert.equal(await page.locator('#memoryEvidence pre').innerText(), 'Preserve the original constraints.');
  await page.locator('#taskMemoryDialog').screenshot({ path: '/private/tmp/cp-memory-panel.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#taskMemoryDialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('#taskMemoryDialog').screenshot({ path: '/private/tmp/cp-memory-panel-mobile.png' });
  await page.keyboard.press('Escape');
  await page.locator('#taskMemoryDialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#taskMemoryDialog').count(), 0);
  assert.deepEqual(errors, []);
});

test('paused memory exposes real outcomes and shared budget; explicit resume does not dispatch or bypass limits', opts, async () => {
  const { page, sb } = ui;
  const endpoint = '**/api/tasks/alpha/alp-001/memory';
  let paused = true;
  const resumes = [], updates = [];
  const resetAt = '2030-02-03T00:00:00.000Z';
  const diagnostics = { code: 'CODEX_MEMORY_PROTOCOL', stage: 'startup', eventType: 'item.completed',
    itemType: '<img src=x onerror=alert(1)>', exitCode: 1, version: '0.153.2',
    warningCount: 1, warningEventType: 'item.completed', warningItemType: 'warning', stderr: 'PRIVATE_DIAGNOSTIC_SENTINEL' };
  const budget = () => ({ jobsToday: 12, dailyJobLimit: 12, remainingJobs: 0, resetAt, pendingCount: 1 });
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    const data = await response.json();
    Object.assign(data, { current: null, revisions: [], status: 'failed', pending: true,
      counts: { successful: 0, failed: 45, blocked: 70 },
      coverage: { coveredEvents: 0, totalEvents: 90, partialEvent: false, complete: false },
      budget: budget(), eligibility: { eligible: false, reason: paused ? 'paused' : 'budget' },
      pause: paused ? { connection: 'codex-subscription', reason: 'Unexpected worker event.', diagnostics,
        persistenceWarning: 'Pause could not be saved. Do not restart until storage is repaired.' } : null,
      settings: { ...data.settings, enabled: true, billingBlocked: false },
      jobs: [{ id: 'diagnostic-job', status: 'failed', startedAt: '2030-02-02T12:00:00Z', durationMs: 98,
        error: 'Checkpoint rejected.', diagnostics, configuration: { connection: 'codex-subscription', model: 'memory-model' } }],
    });
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/memory/resume', route => {
    resumes.push(JSON.parse(route.request().postData()));
    paused = false;
    return route.fulfill({ json: { ...budget(), pause: null } });
  });
  await page.route('**/api/tasks/alpha/alp-001/memory/update', route => {
    updates.push(route.request().postData());
    return route.fulfill({ status: 403, json: { error: 'Never dispatch in a browser test.' } });
  });
  try {
    await page.goto(`${sb.base}/?memory-paused-test#alpha`);
    await page.locator('#taskMemoryBtn').click();
    await page.locator('#memoryResume').waitFor();
    assert.match(await page.locator('.memoryOutcomeCounts').innerText(), /0 successful checkpoints · 45 failed attempts · 70 blocked attempts/);
    assert.equal(await page.locator('#memoryPanel .memoryBadge').innerText(), 'paused');
    assert.equal(await page.locator('#memoryUpdate').isDisabled(), true);
    const text = await page.locator('#taskMemoryDialog').innerText();
    assert.match(text, /12 \/ 12 jobs reserved today · 0 remaining across all tasks/);
    const localReset = await page.evaluate(value => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), resetAt);
    assert.ok(text.includes(localReset), 'UTC reset is shown in the reader\'s local time');
    assert.match(text, /Coverage: 0 \/ 90 complete transcript entries/);
    assert.match(text, /not a fully current summary/);
    assert.match(text, /not being read by the working agent/);
    assert.equal(await page.locator('.memoryDiagnostics img').count(), 0, 'diagnostics are escaped');
    assert.match(text, /<img src=x onerror=alert\(1\)>/);
    assert.match(text, /warnings: 1/);
    assert.match(text, /warning item: warning/);
    assert.match(text, /Do not restart until storage is repaired/);
    assert.doesNotMatch(text, /PRIVATE_DIAGNOSTIC_SENTINEL/, 'non-whitelisted diagnostics are never displayed');
    assert.equal(await page.locator('#taskMemoryDialog').evaluate(el => el.scrollWidth <= el.clientWidth), true,
      'pause and diagnostic information fit the narrow memory panel');
    await page.locator('#memoryResume').click();
    await page.locator('#memoryResume').waitFor({ state: 'detached' });
    assert.deepEqual(resumes, [{ connection: 'codex-subscription' }]);
    assert.equal(await page.locator('#memoryUpdate').isDisabled(), true, 'resume does not bypass the budget');
    assert.match(await page.locator('.memoryEligibility').innerText(), /shared daily memory limit is reached/);
    assert.equal(updates.length, 0, 'resume never sends a checkpoint request');
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute(endpoint);
    await page.unroute('**/api/memory/resume');
    await page.unroute('**/api/tasks/alpha/alp-001/memory/update');
  }
});

test('legacy panel responses remain readable without invented eligibility, outcome history, or reset time', opts, async () => {
  const { page, sb } = ui;
  const endpoint = '**/api/tasks/alpha/alp-001/memory';
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const key of ['pause', 'eligibility', 'counts', 'coverage', 'budget']) delete data[key];
    await route.fulfill({ response, json: data });
  });
  try {
    await page.goto(`${sb.base}/?memory-legacy-test#alpha`);
    await page.locator('#taskMemoryBtn').click();
    await page.locator('.memoryOutcomeCounts').waitFor();
    assert.match(await page.locator('.memoryOutcomeCounts').innerText(), /2 successful checkpoints/);
    assert.match(await page.locator('.memoryOutcomeCounts').innerText(), /attempt counts shown for recent history only/);
    assert.equal(await page.locator('#memoryResume').count(), 0);
    assert.equal(await page.locator('.memorySharedBudget').count(), 0);
    assert.equal(await page.locator('#memoryUpdate').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { await page.unroute(endpoint); }
});

test('resuming an eligible retained queue permits an explicit update but never starts one by itself', opts, async () => {
  const { page, sb } = ui;
  const endpoint = '**/api/tasks/alpha/alp-001/memory';
  let paused = true;
  const updates = [];
  await page.route(endpoint, async route => {
    const response = await route.fetch(), data = await response.json();
    Object.assign(data, { status: 'queued', pending: true,
      pause: paused ? { connection: 'codex-subscription', reason: 'Worker needs review.' } : null,
      eligibility: { eligible: !paused, reason: paused ? 'paused' : null },
      settings: { ...data.settings, enabled: true, billingBlocked: false },
      budget: { jobsToday: 11, dailyJobLimit: 12, remainingJobs: 1, resetAt: '2030-02-03T00:00:00Z' },
      coverage: { coveredEvents: 1, totalEvents: 9, partialEvent: 123, complete: false },
    });
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/memory/resume', route => { paused = false; return route.fulfill({ json: { pause: null } }); });
  await page.route('**/api/tasks/alpha/alp-001/memory/update', route => {
    updates.push(route.request().postData()); return route.fulfill({ json: { queued: true } });
  });
  try {
    await page.goto(`${sb.base}/?memory-resume-ready-test#alpha`);
    await page.locator('#taskMemoryBtn').click();
    await page.locator('#memoryResume').click();
    await page.waitForFunction(() => !document.querySelector('#memoryUpdate')?.disabled);
    assert.equal(updates.length, 0);
    assert.equal(await page.locator('#memoryPanel .memoryBadge').innerText(), 'waiting — no request running');
    assert.match(await page.locator('.memoryCoverage').innerText(), /1 \/ 9 complete transcript entries \+ 123 characters/);
    await page.locator('#memoryUpdate').click();
    await page.waitForTimeout(100);
    assert.equal(updates.length, 1, 'only the explicit update action requests work');
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute(endpoint); await page.unroute('**/api/memory/resume');
    await page.unroute('**/api/tasks/alpha/alp-001/memory/update');
  }
});

test('settings resume clears the pause without enabling disabled automation or raising its daily limit', opts, async () => {
  const { page, sb } = ui;
  let paused = true;
  const resumes = [];
  await page.route('**/api/memory/settings', async route => {
    const response = await route.fetch(), data = await response.json();
    Object.assign(data, { enabled: false, jobsToday: 8, dailyJobLimit: 8, remainingJobs: 0,
      resetAt: '2030-02-03T00:00:00Z', pause: paused ? { connection: 'codex-subscription', reason: 'Worker compatibility needs review.' } : null });
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/memory/resume', route => {
    resumes.push(JSON.parse(route.request().postData())); paused = false;
    return route.fulfill({ json: { pause: null } });
  });
  try {
    await page.goto(`${sb.base}/?memory-settings-resume-test#settings`);
    await page.locator('#memorySettingsResume').click();
    await page.locator('#memorySettingsResume').waitFor({ state: 'detached' });
    assert.deepEqual(resumes, [{ connection: 'codex-subscription' }]);
    assert.equal(await page.locator('[name=enabled]').isChecked(), false);
    assert.equal(await page.locator('[name=dailyJobLimit]').inputValue(), '8');
    assert.match(await page.locator('.memorySharedBudget').innerText(), /8 \/ 8 jobs reserved today · 0 remaining/);
    assert.deepEqual(errors, []);
  } finally { await page.unroute('**/api/memory/settings'); await page.unroute('**/api/memory/resume'); }
});

test('preflight failures show no reservation while uncertain legacy attempts retain their reservation label', opts, async () => {
  const { page, sb } = ui;
  const endpoint = '**/api/tasks/alpha/alp-001/memory';
  await page.route(endpoint, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = [
      { ...data.jobs[0], status: 'failed', notDispatched: true, reservationHeld: false, error: 'Readiness check failed.',
        diagnostics: { code: 'memory-auth-required', stage: 'preflight' } },
      { ...data.jobs[1], status: 'failed', notDispatched: true, error: 'Old readiness failure after reservation.' },
    ];
    delete data.jobs[1].reservationHeld;
    await route.fulfill({ response, json: data });
  });
  try {
    await page.goto(`${sb.base}/?memory-preflight-reservation-test#alpha`);
    await page.locator('#taskMemoryBtn').click();
    await page.locator('.memoryJobs article').first().waitFor();
    const first = await page.locator('.memoryJobs article').first().innerText();
    assert.match(first, /Not dispatched/);
    assert.match(first, /No daily slot reserved/);
    assert.doesNotMatch(first, /1 subscription job reserved/);
    assert.match(await page.locator('.memoryJobs article').nth(1).innerText(), /1 subscription job reserved/);
    assert.match(await page.locator('.memoryStats').innerText(), /recent attempt records/);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { await page.unroute(endpoint); }
});
