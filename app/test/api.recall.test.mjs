// API boundary checks only. Provider cancellation/history is tested with
// injected local doubles in the lifecycle suites, never a live model session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
let task;
before(async () => {
  sb = await startSandbox();
  ({ body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Recall boundary',
  }));
});
after(async () => { await sb?.stop(); });

test('message request IDs are validated before the billed-route guard', async () => {
  for (const requestId of ['', 12, {}, 'short', '../not-an-id', 'x'.repeat(129)]) {
    const r = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/message`, { text: 'Keep me', requestId });
    assert.equal(r.status, 400, JSON.stringify(requestId));
    assert.match(r.body.error, /requestId/);
  }
  const r = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/message`, {
    text: 'Keep me', requestId: 'request-12345',
  });
  assert.equal(r.status, 403, 'valid requests still cannot dispatch a billed turn in tests');
});

test('recall requires an exact valid submission identifier', async () => {
  for (const body of [{}, { turnId: '' }, { requestId: 1 }, { turnId: 'short' },
    { requestId: 'request-12345', turnId: {} }]) {
    const r = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/recall`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const unknownProject = await sb.fetchJson('POST', '/api/tasks/nope/task-12345/recall', { requestId: 'request-12345' });
  assert.equal(unknownProject.status, 404);
});

test('recall never reaches real provider history from the sandbox', async () => {
  for (const body of [{ requestId: 'request-12345' }, { turnId: 'turn-id-12345' },
    { requestId: 'request-12345', turnId: 'turn-id-12345' }]) {
    const r = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/recall`, body);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /provider history changes are disabled/);
  }
  const { body } = await sb.fetchJson('GET', `/api/transcript/alpha/${task.id}`);
  assert.deepEqual(body.transcript, []);
});

test('state snapshots expose recall state without creating a model turn', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.ok(body.turnStates && typeof body.turnStates === 'object');
  assert.equal(body.turnStates[`alpha/${task.id}`]?.activeTurn ?? null, null);
});

test('ordinary Stop validates optional turn identifiers without breaking older clients', async () => {
  const invalid = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/interrupt`, { turnId: {} });
  assert.equal(invalid.status, 400);
  const oldClient = await sb.fetchJson('POST', `/api/tasks/alpha/${task.id}/interrupt`, {});
  assert.equal(oldClient.status, 200, 'an old client may harmlessly stop an idle task');
});
