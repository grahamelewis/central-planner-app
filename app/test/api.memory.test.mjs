import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';
let sb, task;
before(async () => {
  sb = await startSandbox();
  ({ body: task } = await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Memory pilot' }));
});
after(async () => { await sb?.stop(); });

test('memory settings are available without credentials, disabled by default, and persist independently', async () => {
  let r = await sb.fetchJson('GET', '/api/memory/settings');
  assert.equal(r.status, 200); assert.equal(r.body.enabled, false);
  assert.equal(r.body.credentialConfigured, false); assert.equal(r.body.billingBlocked, true);
  const before = (await sb.fetchJson('GET', '/api/state')).body.agentDefaults;
  assert.equal(r.body.connection, 'codex-subscription'); assert.equal(r.body.model, 'gpt-5.6-luna');
  assert.deepEqual(r.body.connections.map(c => c.id), ['claude-sdk', 'codex-subscription']);
  assert.equal((await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'openai-api' })).status, 400);
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'codex-subscription', model: 'gpt-5.6-terra', dailyJobLimit: 8 });
  assert.equal(r.status, 200); assert.equal(r.body.model, 'gpt-5.6-terra');
  assert.equal((await sb.fetchJson('PATCH', '/api/memory/settings', { model: 'claude-haiku-4-5' })).status, 400, 'model must match the connection');
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'claude-sdk', model: 'claude-haiku-4-5', reasoningEffort: 'none' });
  assert.equal(r.status, 200); assert.equal(r.body.model, 'claude-haiku-4-5');
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'codex-subscription', model: 'gpt-5.6-terra', reasoningEffort: 'low' });
  assert.equal(r.status, 200);
  assert.deepEqual((await sb.fetchJson('GET', '/api/state')).body.agentDefaults, before);
  assert.equal((await sb.fetchJson('PATCH', '/api/memory/settings', { model: 'invented' })).status, 400);
  assert.equal((await sb.fetchJson('PATCH', '/api/memory/settings', { enabled: true })).status, 400);
});

test('task panel handles empty memory, missing tasks, and rejects billed updates in tests', async () => {
  const route = `/api/tasks/alpha/${task.id}/memory`;
  const r = await sb.fetchJson('GET', route);
  assert.equal(r.status, 200); assert.equal(r.body.current, null); assert.deepEqual(r.body.revisions, []);
  assert.equal((await sb.fetchJson('GET', '/api/tasks/alpha/missing/memory')).status, 404);
  assert.equal((await sb.fetchJson('GET', '/api/tasks/unknown/missing/memory')).status, 404);
  assert.equal((await sb.fetchJson('POST', `${route}/update`, {})).status, 403);
  assert.equal((await sb.fetchJson('GET', route)).body.totals.reservedUsd, 0);
  const fresh = (await sb.fetchJson('GET', '/api/state')).body.tasks.alpha.find(t => t.id === task.id);
  assert.deepEqual(fresh.session, task.session);
});

test('memory health reports shared reservations, eligibility and real checkpoint counts without dispatch', async () => {
  const settings = (await sb.fetchJson('GET', '/api/memory/settings')).body;
  assert.equal(settings.pause, null);
  assert.equal(settings.jobsToday, 0);
  assert.equal(settings.remainingJobs, settings.dailyJobLimit);
  assert.ok(Number.isFinite(Date.parse(settings.resetAt)));
  const view = (await sb.fetchJson('GET', `/api/tasks/alpha/${task.id}/memory`)).body;
  assert.deepEqual(view.counts, { successful: 0, failed: 0, blocked: 0 });
  assert.equal(view.eligibility.eligible, false);
  assert.equal(typeof view.eligibility.reason, 'string');
  assert.equal(view.coverage.coveredEvents, 0);
  assert.equal(view.coverage.totalEvents, 0);
  assert.equal(view.budget.jobsToday, settings.jobsToday);
  assert.equal(view.budget.remainingJobs, settings.remainingJobs);
});

test('resume validates the selected connection and never queues work, changes settings, or refunds budget', async () => {
  const settings = (await sb.fetchJson('GET', '/api/memory/settings')).body;
  const route = `/api/tasks/alpha/${task.id}/memory`;
  const before = (await sb.fetchJson('GET', route)).body;
  for (const body of [{}, { connection: 'invented' }, { connection: 'claude-sdk' }]) {
    const result = await sb.fetchJson('POST', '/api/memory/resume', body);
    assert.ok([400, 409].includes(result.status), `invalid resume rejected: ${JSON.stringify(body)}`);
  }
  const resumed = await sb.fetchJson('POST', '/api/memory/resume', { connection: settings.connection });
  assert.equal(resumed.status, 200, 'non-generating resume is safe even under CP_NO_BILLED');
  const after = (await sb.fetchJson('GET', route)).body;
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.totals, before.totals);
  assert.equal(after.budget.jobsToday, before.budget.jobsToday);
  assert.equal(after.budget.remainingJobs, before.budget.remainingJobs);
  const nextSettings = (await sb.fetchJson('GET', '/api/memory/settings')).body;
  assert.equal(nextSettings.enabled, settings.enabled);
  assert.equal(nextSettings.dailyJobLimit, settings.dailyJobLimit);
  assert.equal(nextSettings.pendingCount, 0);
});
