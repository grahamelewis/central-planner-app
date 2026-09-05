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
  assert.equal(r.body.connection, 'openai-api'); assert.equal(r.body.model, 'gpt-5.6-luna');
  assert.deepEqual(r.body.connections.map(c => c.id), ['claude-sdk', 'openai-api']);
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'openai-api', model: 'gpt-5.6-terra', dailyBudgetUsd: 1 });
  assert.equal(r.status, 200); assert.equal(r.body.model, 'gpt-5.6-terra');
  assert.equal((await sb.fetchJson('PATCH', '/api/memory/settings', { model: 'claude-haiku-4-5' })).status, 400, 'model must match the connection');
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'claude-sdk', model: 'claude-haiku-4-5', reasoningEffort: 'none' });
  assert.equal(r.status, 200); assert.equal(r.body.model, 'claude-haiku-4-5');
  r = await sb.fetchJson('PATCH', '/api/memory/settings', { connection: 'openai-api', model: 'gpt-5.6-terra' });
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
