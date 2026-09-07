import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureClaudeBoundary, captureCodexBoundary, restoreTurnHistory } from '../lib/turnHistory.js';

const assistant = (text, uuid = 'old-final') => ({ type: 'assistant', uuid,
  message: { content: [{ type: 'text', text }] } });
const oldTurn = { id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'kept' }] };

test('provider prep cancellation requires no history mutation', async () => {
  assert.deepEqual(await restoreTurnHistory({ provider: 'codex', providerState: {} }, {}), { unchanged: true });
});

test('Codex captures all retained pages and requests full history without generation', async () => {
  const calls = [];
  const rows = await captureCodexBoundary('source', { request: async (method, params) => {
    calls.push([method, params]);
    return params.cursor ? { data: [{ ...oldTurn, id: 'second' }], nextCursor: null }
      : { data: [oldTurn], nextCursor: 'next' };
  } });
  assert.deepEqual(rows.map(r => r.id), ['old', 'second']);
  assert.ok(calls.every(([method, params]) => method === 'thread/turns/list' && params.itemsView === 'full'));
});

test('Codex refuses incomplete or repeated history pages', async () => {
  await assert.rejects(captureCodexBoundary('source', { request: async () => ({ data: [] , nextCursor: 'same' }) }), /did not advance/);
  await assert.rejects(captureCodexBoundary('source', { request: async () => ({ data: [{ ...oldTurn, status: 'inProgress' }] }) }), /active turn/);
  await assert.rejects(captureCodexBoundary('source', { request: async () => ({}) }), /cannot verify/);
});

function codexFixture(retained = [oldTurn]) {
  const calls = [];
  const codex = { request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/fork') return { thread: { id: 'forked' } };
    if (method === 'thread/turns/list') return { data: retained };
    throw new Error('generation/other methods forbidden');
  } };
  const turn = { provider: 'codex', providerState: { dispatched: true, threadId: 'source',
    turnId: 'withdrawn', codexBoundary: [oldTurn] } };
  return { turn, codex, calls };
}

test('Codex prefix fork verifies retained contents and excludes withdrawn turn', async () => {
  const f = codexFixture();
  const result = await restoreTurnHistory(f.turn, f);
  assert.equal(result.threadId, 'forked');
  assert.equal(f.calls[0][1].beforeTurnId, 'withdrawn');
  assert.equal(f.calls[0][1].deferGoalContinuation, true);
});

test('older Codex silently ignoring beforeTurnId cannot report a recall', async () => {
  const f = codexFixture([oldTurn, { ...oldTurn, id: 'withdrawn' }]);
  await assert.rejects(restoreTurnHistory(f.turn, f), /exactly the prior history/);
});

test('Codex missing earlier history or changing content is rejected', async () => {
  for (const rows of [[], [{ ...oldTurn, items: [] }]]) {
    const f = codexFixture(rows);
    await assert.rejects(restoreTurnHistory(f.turn, f), /exactly the prior history/);
  }
});

test('Codex absent provider IDs/catalog capability fails closed', async () => {
  const f = codexFixture();
  delete f.turn.providerState.codexBoundary;
  await assert.rejects(restoreTurnHistory(f.turn, f), /boundary is unavailable/);
  assert.equal(f.calls.length, 0);
});

test('Claude normal text boundary restores verified prefix with fresh session ID', async () => {
  const rows = [assistant('kept')];
  const boundary = await captureClaudeBoundary('source', '/fixture', async () => rows);
  const calls = [];
  const result = await restoreTurnHistory({ provider: 'claude', providerState: { dispatched: true, claudeBoundary: boundary } }, {
    dir: '/fixture', forkClaude: async (...args) => { calls.push(args); return { sessionId: 'fork' }; },
    readClaude: async () => [assistant('kept', 'fresh-uuid')],
  });
  assert.equal(result.sdkSessionId, 'fork');
  assert.deepEqual(calls, [['source', { dir: '/fixture', upToMessageId: 'old-final' }]]);
});

test('Claude initial turn resets to an empty future session without deleting provider log', async () => {
  const boundary = await captureClaudeBoundary(null, '/fixture', () => { throw Error('no read expected'); });
  const result = await restoreTurnHistory({ provider: 'claude', providerState: { dispatched: true, sessionId: 'audit', claudeBoundary: boundary } }, {});
  assert.deepEqual(result, { provider: 'claude', sdkSessionId: null, restoredFrom: 'audit' });
});

test('Claude tool-ending and omitted raw tail attachment boundaries are rejected', async () => {
  await assert.rejects(captureClaudeBoundary('source', '/fixture', async () => [{ type: 'user', uuid: 'tool-result' }]), /no verified/);
  const rawImport = async (_id, store) => store.append({}, [
    { ...assistant('kept'), parentUuid: null },
    { type: 'attachment', uuid: 'hidden-tail', parentUuid: 'old-final', attachment: { type: 'structured_output' } },
  ]);
  await assert.rejects(captureClaudeBoundary('source', '/fixture', async () => [assistant('kept')], rawImport), /additional chain entries/);
});

test('Claude fork verification refuses missing retained output or surviving withdrawn prompt', async () => {
  const boundary = await captureClaudeBoundary('source', '/fixture', async () => [assistant('kept')]);
  await assert.rejects(restoreTurnHistory({ provider: 'claude', providerState: { dispatched: true, claudeBoundary: boundary } }, {
    forkClaude: async () => ({ sessionId: 'fork' }), readClaude: async () => [assistant('withdrawn')],
  }), /did not match/);
});
