import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { APP_DIR, mkTmp, rmTmp, extractFunction, loadPrivateFns } from './helpers.mjs';
import { codexUsage, createCodexUsageTracker, createClaudeUsageTracker, readCodexUsageBaseline,
  sessionUsageCheckpoint } from '../lib/sessionUsage.js';

const source = path.join(APP_DIR, 'lib/sessions.js');
const u = (inputTokens, outputTokens = 0, cachedInputTokens = 0, reasoningOutputTokens = 0) =>
  ({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, cacheWriteInputTokens: 0 });

test('Codex cumulative deltas account for missed intermediate events, excluding prior turns', () => {
  const tracker = createCodexUsageTracker({ baseline: codexUsage(u(10000, 1000)) });
  tracker.observe({ total: u(15000, 1800), last: u(2000, 300) });
  assert.deepEqual([tracker.snapshot().tokensIn, tracker.snapshot().tokensOut], [5000, 800]);
  assert.equal(tracker.finish({ completed: true }).completeness, 'complete');
});

test('missing baseline reports only observed last response, never inherited history', () => {
  const tracker = createCodexUsageTracker();
  tracker.observe({ total: u(50000, 500), last: u(200, 10) });
  tracker.observe({ total: u(50300, 520), last: u(300, 20) });
  assert.deepEqual([tracker.snapshot().tokensIn, tracker.snapshot().tokensOut], [500, 30]);
  assert.equal(tracker.finish({ completed: true }).completeness, 'partial');
});

test('absent usage and last-only protocol do not become complete zero', () => {
  const tracker = createCodexUsageTracker({ fresh: true });
  tracker.observe({ last: u(20, 2) });
  assert.equal(tracker.finish({ completed: true }).completeness, 'unknown');
});

test('unseen stale snapshot matching last is not proof of a mid-turn reset', () => {
  const tracker = createCodexUsageTracker({ baseline: codexUsage(u(10000)) });
  tracker.observe({ total: u(10100), last: u(100) });
  tracker.observe({ total: u(50), last: u(50) });
  tracker.observe({ total: u(10200), last: u(100) });
  assert.equal(tracker.snapshot().tokensIn, 100);
  assert.equal(tracker.finish({ completed: true }).completeness, 'partial');
});

test('cache and reasoning are subsets, missing optional breakdown does not reset token totals', () => {
  const tracker = createCodexUsageTracker({ fresh: true });
  tracker.observe({ total: u(100, 20, 50, 10), last: u(100, 20, 50, 10) });
  tracker.observe({ total: { inputTokens: 200, outputTokens: 40 }, last: u(100, 20) });
  const result = tracker.finish({ completed: true });
  assert.equal(result.tokensIn + result.tokensOut, 240);
  assert.equal(result.cachedInputTokens, null);
  assert.equal(result.completeness, 'complete');
});

test('invalid numeric/cache reports do not masquerade as zero or exceed input', () => {
  for (const raw of [u(-1), u(1.5), u(NaN), u(Infinity), u('5'), u(10, 1, -1),
    { ...u(10), cachedInputTokens: 8, cacheWriteInputTokens: 8 }]) assert.equal(codexUsage(raw), null);
  assert.equal(createCodexUsageTracker({ fresh: true }).snapshot().costUsd, null);
});

test('rollout baseline validates thread ownership and bounded complete JSONL records', () => {
  const dir = mkTmp('cp-usage-baseline-');
  try {
    const file = path.join(dir, 'rollout.jsonl');
    const line = n => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: n, output_tokens: 10, cached_input_tokens: 1, reasoning_output_tokens: 2 },
    } } });
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'owner' } }) + '\n' + line(100) + '\n' + line(200));
    assert.equal(readCodexUsageBaseline(file, 'owner').tokensIn, 100);
    assert.equal(readCodexUsageBaseline(file, 'wrong'), null);
    assert.equal(readCodexUsageBaseline(path.join(dir, 'absent'), 'owner'), null);
    assert.equal(readCodexUsageBaseline(file, 'owner', 10), null);
  } finally { rmTmp(dir); }
});

test('Claude deduplicates parent and child message IDs, then replaces with whole-query per-model result', () => {
  const tracker = createClaudeUsageTracker({ defaultModel: 'main' });
  const message = { id: 'msg', model: 'main', usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20 } };
  tracker.observe({ type: 'assistant', message }); tracker.observe({ type: 'assistant', message });
  tracker.observe({ type: 'assistant', parent_tool_use_id: 'agent1', message: { ...message, id: 'child-response', model: 'small' } });
  assert.equal(tracker.snapshot().tokensIn, 240);
  tracker.observe({ type: 'result', modelUsage: {
    main: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, costUSD: 0.1 },
    small: { inputTokens: 200, outputTokens: 10, cacheCreationInputTokens: 50, costUSD: 0.05 },
  } });
  const result = tracker.snapshot();
  assert.equal(result.tokensIn, 370); assert.equal(result.tokensOut, 60);
  assert.equal(result.rows.length, 2); assert.equal(result.scope, 'whole-query');
  assert.equal(result.completeness, 'complete');
});

test('a rewrapped identical Claude response is not billed twice across parent metadata', () => {
  const tracker = createClaudeUsageTracker();
  const message = { id: 'response-id', usage: { input_tokens: 50, output_tokens: 10 } };
  tracker.observe({ type: 'assistant', message });
  tracker.observe({ type: 'assistant', parent_tool_use_id: 'parent', message });
  assert.equal(tracker.snapshot().tokensIn, 50);
});

test('Claude invalid cache fields preserve partial observed usage; unidentified messages are not guessed', () => {
  const tracker = createClaudeUsageTracker();
  tracker.observe({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 1 } } });
  tracker.observe({ type: 'result', modelUsage: { m: { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: -1 } } });
  assert.equal(tracker.snapshot().completeness, 'unknown');
  assert.equal(tracker.snapshot().tokensIn, 0);
});

test('Claude preserves known aggregate cost when provider omits model allocation', () => {
  const tracker = createClaudeUsageTracker();
  tracker.observe({ type: 'result', total_cost_usd: 2, modelUsage: {
    a: { inputTokens: 100, outputTokens: 10 }, b: { inputTokens: 200, outputTokens: 20, costUSD: 0.5 },
  } });
  const result = tracker.snapshot();
  assert.equal(result.rows.reduce((n, row) => n + (row.costUsd || 0), 0), 2);
  assert.equal(result.rows.find(row => row.model === null).costUsd, 1.5);
  assert.equal(result.tokensIn, 300);
});

function accountingHarness(initialTask = {}) {
  let task = { created: 'task-created', model: 'model', provider: 'codex', context: {}, oversight: 'coop', ...initialTask };
  const ledger = new Map();
  const globals = {
    tokenEntries: filters => [...ledger.values()].filter(row => Object.entries(filters).every(([k, v]) => row[k] === v)),
    logTokens(project, taskId, tin, tout, costUsd, model, details) {
      ledger.set(details.usageId, { project, taskId, in: tin, out: tout, costUsd, model, ...details });
    },
    logTokenBatch(records) {
      for (const r of records) globals.logTokens(r.project, r.taskId, r.tokensIn, r.tokensOut, r.costUsd, r.model, r.details);
    },
    getTask: () => task,
    updateTask: (_p, _id, patch) => { task = { ...task, ...patch }; },
    sessionUsageCheckpoint,
  };
  const helpers = loadPrivateFns(source, ['providerSessionsWith', 'recordedSessionUsage', 'prepareSessionUsage', 'createSessionUsageWriter', 'withRecordedSessionUsage'], globals);
  return { globals, helpers, ledger, task: () => task };
}

test('real writer replaces provisional model rows and never mutates tracker snapshots', () => {
  const harness = accountingHarness();
  const write = harness.helpers.createSessionUsageWriter('p', 't', 'claude', 'app-turn', 'task-created');
  const provisional = { rows: [{ model: 'a', tokensIn: 100, tokensOut: 1, costUsd: null }], completeness: 'partial', scope: 'observed-messages' };
  write(provisional); write(provisional);
  const final = { rows: [{ model: 'b', tokensIn: 120, tokensOut: 30, costUsd: 0.1 }], completeness: 'complete', scope: 'whole-query' };
  write(final); write(final);
  assert.equal(final.rows.length, 1);
  assert.equal([...harness.ledger.values()].reduce((n, row) => n + row.in + row.out, 0), 150);
});

test('a write followed by fsync failure cannot strand an additive provisional model', () => {
  const ledger = new Map();
  let fail = true;
  const { createSessionUsageWriter } = loadPrivateFns(source, ['createSessionUsageWriter'], {
    logTokenBatch(records) {
      for (const row of records) ledger.set(row.details.usageId, row);
      if (fail) { fail = false; throw new Error('fsync failed after durable append'); }
    },
  });
  const write = createSessionUsageWriter('p', 't', 'claude', 'turn', 'created');
  assert.throws(() => write({ rows: [{ model: 'provisional', tokensIn: 100, tokensOut: 1 }], completeness: 'partial' }), /fsync/);
  write({ rows: [{ model: 'actual', tokensIn: 120, tokensOut: 20 }], completeness: 'complete' });
  assert.equal([...ledger.values()].reduce((sum, row) => sum + row.tokensIn + row.tokensOut, 0), 140);
  assert.ok([...ledger.values()].find(row => row.model === 'provisional').details.superseded);
});

test('checkpoint preserves providerless legacy Claude and archived provider accounting without resuming old identity', () => {
  const old = { sdkSessionId: 'old', tokensIn: 100, tokensOut: 20, turns: 3 };
  const legacy = accountingHarness({ session: old });
  legacy.helpers.prepareSessionUsage('p', 't', 'claude');
  assert.equal(legacy.task().session.sdkSessionId, 'old');
  assert.equal(legacy.task().session.usageBase.tokensIn, 100);
  const switched = accountingHarness({ session: null, providerSessions: { claude: [old] } });
  switched.helpers.prepareSessionUsage('p', 't', 'claude');
  assert.equal(switched.task().session.sdkSessionId, undefined);
  assert.equal(switched.task().session.tokensIn, 100);
});

async function runCodexHarness({ lostReply = false, failRecorder = false, observeJobs = false } = {}) {
  const harness = accountingHarness({ session: { provider: 'codex', threadId: 'thread', tokensIn: 1000, tokensOut: 5, turns: 2 } });
  const jobCalls = [];
  const appTurn = observeJobs ? { turnId: 'application-turn', providerState: {} } : null;
  const client = new EventEmitter();
  client.request = async method => {
    if (method === 'thread/resume') return { thread: { id: 'thread' }, model: 'model' };
    if (method === 'turn/start') {
      if (observeJobs) {
        for (const method of ['item/started', 'item/completed']) client.emit('notification', { method, params: {
          threadId: 'thread', turnId: 'provider-turn', item: { id: 'shell-item', type: 'commandExecution', command: 'julia program.jl', status: 'completed', exitCode: 0 },
        } });
      }
      if (lostReply) client.emit('notification', { method: 'turn/started', params: {
        threadId: 'thread', turn: { id: 'provider-turn' },
      } });
      let total = 0;
      for (const n of [169846, 178009, 179671, 181006, 185858, 186354, 187965]) {
        total += n;
        client.emit('notification', { method: 'thread/tokenUsage/updated', params: {
          threadId: 'thread', turnId: 'provider-turn', tokenUsage: { total: u(total), last: u(n) },
        } });
      }
      client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turnId: 'provider-turn', turn: { id: 'provider-turn', status: 'completed', items: [] } } });
      if (lostReply) throw new Error('turn/start timed out');
      return { turn: { id: 'provider-turn' } };
    }
    throw new Error(`unexpected provider call ${method}`);
  };
  const no = () => {};
  const globals = { ...harness.globals, ...harness.helpers,
    keyOf: (p, id) => `${p}/${id}`, turnLifecycle: { get: () => appTurn, attach: async () => {} }, broadcastForTurn: no,
    ensureStateOwner: no, transcriptFor: () => [], publicTurn: () => ({}), registry: new Map(),
    createActivityTracker: () => ({ clear: no, phase: no, start: no, end: no }), getCodexClient: () => client,
    createCodexUsageTracker, readCodexUsageBaseline: () => codexUsage(u(98543393)),
    requireTask: () => harness.task(), codexExecutionSettings: () => ({}), PROJECTS: { p: { root: '/tmp' } },
    path, externalDirsFor: () => [], oversightAppendix: () => '', persistTranscript: no,
    interruptedDuringPrep: new Set(), createTracker: () => ({ finish: no }), activeTurns: new Map(),
    codexTurnError: () => null, endSessionJobsFor: (...args) => jobCalls.push(['cleanup', ...args]), pendingPermissions: new Map(),
    sessionJobStart: (...args) => jobCalls.push(['start', ...args]), sessionJobEnd: (...args) => jobCalls.push(['end', ...args]),
    oneLine: text => String(text),
    parseHandoff: () => null, parseQuestion: () => null, failedTurns: new Set(), refreshCodex: async () => {},
    notify: no, log: no, logErr: lostReply || failRecorder ? no : (...args) => { throw new Error(args.join(' ')); },
  };
  const fn = new Function(...Object.keys(globals), `return async ${extractFunction(source, 'runCodexTurn')};`)(...Object.values(globals));
  await fn('p', 't', 'test prompt');
  return { harness, client, jobCalls };
}

test('real Codex turn callback handles seven cumulative reports emitted before turn/start response', async () => {
  const { harness, client } = await runCodexHarness();
  assert.equal(harness.task().session.tokensIn, 1269709);
  assert.equal(harness.task().session.tokensOut, 5);
  assert.equal(harness.task().session.lastTurnUsage.tokensIn, 1268709);
  assert.equal([...harness.ledger.values()].reduce((n, row) => n + row.in, 0), 1268709);
  assert.equal(client.listenerCount('notification'), 0);
});

test('lost turn/start response cannot discard usage after a trusted turn/started notification', async () => {
  const { harness, client } = await runCodexHarness({ lostReply: true });
  assert.equal(harness.task().session.lastTurnUsage.tokensIn, 1268709);
  assert.equal(harness.task().session.lastTurnUsage.completeness, 'partial');
  assert.equal([...harness.ledger.values()].reduce((n, row) => n + row.in, 0), 1268709);
  assert.equal(client.listenerCount('notification'), 0);
});

test('real Codex command lifecycle carries immutable application-turn and task-generation ownership', async () => {
  const { jobCalls } = await runCodexHarness({ observeJobs: true });
  const start = jobCalls.find(call => call[0] === 'start');
  const end = jobCalls.find(call => call[0] === 'end');
  const cleanup = jobCalls.find(call => call[0] === 'cleanup');
  assert.equal(start[5].appTurnId, 'application-turn');
  assert.equal(start[5].taskCreated, 'task-created');
  assert.equal(end[2].appTurnId, 'application-turn');
  assert.equal(end[2].taskId, 't');
  assert.equal(cleanup[4].appTurnId, 'application-turn');
  assert.equal(cleanup[4].taskCreated, 'task-created');
});

test('state read immediately recovers ledger observations after crash before final session save', () => {
  const harness = accountingHarness({ id: 't', session: { provider: 'codex', tokensIn: 100, tokensOut: 10, turns: 3 } });
  harness.helpers.prepareSessionUsage('p', 't', 'codex');
  const write = harness.helpers.createSessionUsageWriter('p', 't', 'codex', 'unfinished', 'task-created');
  write({ tokensIn: 20, tokensOut: 5, completeness: 'partial', scope: 'thread-only' });
  const saved = harness.task();
  const decorated = harness.helpers.withRecordedSessionUsage('p', saved);
  assert.equal(saved.session.tokensIn, 100, 'read decoration does not mutate history');
  assert.equal(decorated.session.tokensIn, 120);
  assert.equal(decorated.session.tokensOut, 15);
  assert.equal(decorated.session.usageHasIncomplete, true);
});

test('Claude terminal replay cannot erase authoritative nonzero counts or cost', () => {
  const tracker = createClaudeUsageTracker();
  tracker.observe({ type: 'result', total_cost_usd: 1, modelUsage: { a: { inputTokens: 100, outputTokens: 10, costUSD: 1 } } });
  tracker.observe({ type: 'result', modelUsage: { a: { inputTokens: 0, outputTokens: 0 } } });
  assert.equal(tracker.snapshot().tokensIn, 100); assert.equal(tracker.snapshot().costUsd, 1);
});

test('contradictory model allocations cannot inflate or erase known query aggregate cost', () => {
  for (const [allocation, aggregate] of [[0, 1], [2, 1], [1, 0]]) {
    const tracker = createClaudeUsageTracker();
    tracker.observe({ type: 'result', total_cost_usd: aggregate, modelUsage: { a: { inputTokens: 100, outputTokens: 10, costUSD: allocation } } });
    const result = tracker.snapshot();
    assert.equal(result.rows.reduce((n, row) => n + (row.costUsd || 0), 0), aggregate);
    assert.equal(result.costUsd, aggregate);
    assert.equal(result.completeness, 'partial');
  }
});

test('foreground Claude synchronous SDK construction failure retires the predispatch marker', async () => {
  const harness = accountingHarness({ provider: 'claude' });
  const no = () => {};
  let attempted = false;
  const globals = { ...harness.globals, ...harness.helpers,
    keyOf: (p, id) => `${p}/${id}`, turnLifecycle: { get: () => null }, broadcastForTurn: no,
    ensureStateOwner: no, transcriptFor: () => [], publicTurn: () => ({}), registry: new Map(),
    createActivityTracker: () => ({ clear: no }), createClaudeUsageTracker,
    coerceEffort: () => 'high', DEFAULT_MODEL: 'model', requireTask: () => harness.task(),
    permissionModeFor: () => 'plan', PROJECTS: { p: { root: '/tmp' } },
    persistTranscript: no, externalDirsFor: () => [], oversightAppendix: () => '',
    interruptedDuringPrep: new Set(), forceForegroundAgents: no, SESSION_ENV_OVERRIDES: {},
    query: () => { attempted = true; throw new Error('constructor failed'); },
    activeTurns: new Map(), endSessionJobsFor: no, kaimonTouch: no, pendingPermissions: new Map(),
    failedTurns: new Set(), classifyAuthError: () => false, noteAuthError: no, logErr: no,
  };
  const fn = new Function(...Object.keys(globals), `return async ${extractFunction(source, 'runClaudeTurn')};`)(...Object.values(globals));
  await fn('p', 't', 'test prompt');
  assert.equal(attempted, true);
  assert.equal(harness.ledger.size, 1);
  assert.ok([...harness.ledger.values()].every(row => row.superseded && row.in === 0 && row.out === 0));
});
