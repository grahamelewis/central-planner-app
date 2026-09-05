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

test('settings model selection persists independently; credential status and pilot boundaries are visible', opts, async () => {
  const { page, sb } = ui;
  await page.goto(`${sb.base}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('#memorySettingsForm').waitFor();
  assert.match(await page.locator('#memorySettings').innerText(), /Checkpoint-only pilot/i);
  assert.match(await page.locator('#memorySettings').innerText(), /No server API key configured/);
  assert.equal(await page.locator('[name=connection]').inputValue(), 'openai-api');
  assert.equal(await page.locator('[name=model]').inputValue(), 'gpt-5.6-luna');
  await page.locator('[name=connection]').selectOption('claude-sdk');
  assert.match(await page.locator('#memorySettings').innerText(), /Claude is not signed in/);
  assert.deepEqual(await page.locator('[name=model] option').evaluateAll(els => els.map(e => e.value)), ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5']);
  await page.locator('[name=model]').selectOption('claude-haiku-4-5');
  assert.deepEqual(await page.locator('[name=reasoningEffort] option').evaluateAll(els => els.map(e => e.value)), ['none']);
  assert.equal(await page.locator('[name=enabled]').isChecked(), false);
  const original = (await sb.fetchJson('GET', '/api/state')).body.agentDefaults;
  await page.locator('[name=connection]').selectOption('openai-api');
  assert.match(await page.locator('#memorySettings').innerText(), /No server API key configured/);
  await page.locator('[name=model]').selectOption('gpt-5.6-terra');
  await page.locator('[name=dailyBudgetUsd]').fill('1');
  await page.getByRole('button', { name: 'Save memory settings' }).click();
  await page.waitForFunction(() => document.querySelector('#memorySettingsForm button')?.textContent === 'Save memory settings' && !document.querySelector('#memorySettingsForm button')?.disabled);
  assert.equal((await sb.fetchJson('GET', '/api/memory/settings')).body.model, 'gpt-5.6-terra');
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
