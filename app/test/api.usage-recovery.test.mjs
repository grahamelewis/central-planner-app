// Independent end-to-end audit: boot from a crash-shaped store and read state.
// No model calls, no user history, no repair writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

test('startup exposes durable revised usage before another prompt, without rewriting task history', async () => {
  const created = '2026-09-08T10:00:00.000Z';
  const legacy = { id: 'alp-002', title: 'Untouched history', created,
    provider: 'claude', status: 'waiting', session: { tokensIn: 400, tokensOut: 30, turns: 2 } };
  const task = { id: 'alp-001', title: 'Interrupted after ledger fsync', created,
    provider: 'codex', status: 'waiting', session: {
      provider: 'codex', threadId: 'test-thread', tokensIn: 100, tokensOut: 10, turns: 1,
      usageBase: { tokensIn: 100, tokensOut: 10, costUsd: 0, completeness: 'legacy-unverified' },
    } };
  const tasksRaw = JSON.stringify([task, legacy]);
  const row = { ts: new Date().toISOString(), type: 'tokens', usageId: 'codex:crash:model',
    project: 'alpha', taskId: task.id, taskCreated: created, provider: 'codex',
    action: 'session', appTurnId: 'crash', threadId: 'test-thread', turnId: 'test-turn',
    model: 'gpt-test', in: 20, out: 5, costUsd: null, costSource: 'subscription',
    completeness: 'partial', scope: 'thread-only' };
  const ledgerRaw = [row, { type: 'token-batch', version: 2, entries: [{ ...row, in: 40, out: 8 }] },
    { ...row, usageId: 'other-provider', provider: 'claude', in: 999 },
    { ...row, usageId: 'helper', action: 'memory', in: 999 },
    { ...row, usageId: 'old-task', taskCreated: 'old-incarnation', in: 999 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
  const sb = await startSandbox({ seed: ({ root }) => {
    fs.writeFileSync(path.join(root, 'tasks', 'alpha.json'), tasksRaw);
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', 'ledger.jsonl'), ledgerRaw);
  } });
  try {
    for (let i = 0; i < 3; i++) {
      const { status, body } = await sb.fetchJson('GET', '/api/state');
      assert.equal(status, 200);
      const session = body.tasks.alpha.find(t => t.id === task.id).session;
      assert.equal(session.tokensIn, 140, 'one latest revision, scoped to this task/provider/session work');
      assert.equal(session.tokensOut, 18);
      assert.equal(session.usageLegacyTokens, 110);
      assert.equal(session.usageCompleteness, 'legacy-unverified');
      assert.equal(session.usageHasIncomplete, true);
      assert.deepEqual(body.tasks.alpha.find(t => t.id === legacy.id).session, legacy.session);
    }
    assert.equal(fs.readFileSync(path.join(sb.root, 'tasks', 'alpha.json'), 'utf8'), tasksRaw);
    assert.equal(fs.readFileSync(path.join(sb.root, 'ledger', 'ledger.jsonl'), 'utf8'), ledgerRaw);
    assert.ok(!sb.logs().includes('turn start'), 'reads do not launch a model');
  } finally { await sb.stop(); }
});
