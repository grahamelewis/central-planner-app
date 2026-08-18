// Provider/account/task-boundary API tests. All Codex and Claude executables
// are pinned to nonexistent paths by serverHarness; no turn routes are called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

test('snapshot exposes both independent providers plus new-task defaults', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.providers).sort(), ['claude', 'codex']);
  assert.equal(body.providers.claude.name, 'Claude');
  assert.equal(body.providers.codex.name, 'Codex');
  assert.equal(body.agentDefaults.provider, 'claude');
  assert.ok(Array.isArray(body.providers.claude.models));
});

test('a Codex task persists its provider, model, effort, and provider-session map', async () => {
  const { status, body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Codex task', provider: 'codex', model: 'gpt-test', reasoningEffort: 'medium',
  });
  assert.equal(status, 201);
  assert.equal(task.provider, 'codex');
  assert.equal(task.model, 'gpt-test');
  assert.equal(task.reasoningEffort, 'medium');
  assert.deepEqual(task.providerSessions, {});
});

test('crossing providers with history requires explicit fresh-thread confirmation', async () => {
  const session = { provider: 'claude', sessionId: 'claude-thread', turns: 2 };
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Boundary task', provider: 'claude', model: 'claude-opus-5',
    session, providerSessions: { claude: [session] }, status: 'waiting',
  });
  const refused = await sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, {
    provider: 'codex', model: 'gpt-test',
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.providerBoundary, true);

  const accepted = await sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, {
    provider: 'codex', model: 'gpt-test', reasoningEffort: 'high', startNewProviderThread: true,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.provider, 'codex');
  assert.equal(accepted.body.session, null);
  assert.equal(accepted.body.status, 'queued');
  assert.deepEqual(accepted.body.providerSessions.claude, [session], 'old private thread remains retained');
});

test('agent defaults are editable independently of account state', async () => {
  const changed = await sb.fetchJson('PATCH', '/api/providers/defaults', {
    provider: 'codex', model: 'gpt-test', reasoningEffort: 'xhigh',
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { provider: 'codex', model: 'gpt-test', reasoningEffort: 'xhigh' });
  const { body: next } = await sb.fetchJson('POST', '/api/tasks', { project: 'beta', title: 'Uses defaults' });
  assert.equal(next.provider, 'codex');
  assert.equal(next.model, 'gpt-test');
  assert.equal(next.reasoningEffort, 'xhigh');
});

test('Codex check is safe when the CLI is absent', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/providers/codex/check');
  assert.equal(status, 200);
  assert.equal(body.available, false);
  assert.equal(body.connected, false);
  assert.match(body.error, /not found/i);
  assert.equal(body.loginUrl, undefined, 'OAuth URLs never leak through provider state');
});
