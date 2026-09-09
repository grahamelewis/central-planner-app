// Real worker orchestration, with SDK/network/filesystem writes substituted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectClaudeWorker, logWorkerUsage, memoryAccounting, createWorkerUsageWriter } from '../lib/backgroundUsage.js';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const result = { type: 'result', subtype: 'success', result: '{"bio":"I study data.","interests":["a","b","c"]}',
  usage: { input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 20, output_tokens: 40 }, total_cost_usd: 0.25 };
const stream = (messages, fail = false) => ({ [Symbol.asyncIterator]: async function* () {
  for (const message of messages) yield message;
  if (fail) throw new Error('injected iterator failure');
} });
function recordBatch(entries, records) {
  for (const r of records) {
    const row = [r.project, r.taskId, r.tokensIn, r.tokensOut, r.costUsd, r.model, r.details];
    const index = entries.findIndex(old => old[6].usageId === r.details.usageId);
    if (index < 0) entries.push(row); else entries[index] = row;
  }
}

test('SDK terminal accounting survives a subsequent iterator exception', async () => {
  const observed = await collectClaudeWorker(stream([result], true), { model: 'test-model' });
  assert.equal(observed.failure.message, 'injected iterator failure');
  assert.equal(observed.accounting.tokensIn, 620);
  assert.equal(observed.accounting.tokensOut, 40);
  assert.equal(observed.accounting.costUsd, 0.25);
  const entries = [];
  logWorkerUsage((...args) => entries.push(args), 'alpha', 'one', observed.accounting,
    { usageId: 'job-id', action: 'texfix', model: 'test-model' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0][2], 620);
  assert.equal(entries[0][4], 0.25);
  assert.equal(entries[0][6].usageId, 'job-id:test-model');
  assert.equal(entries[0][6].cachedInputTokens, 500);
});

test('no result records unknown metadata with null counts and money', async () => {
  const observed = await collectClaudeWorker(stream([]), { model: 'test-model' });
  const normalized = memoryAccounting(observed.accounting);
  assert.equal(normalized.usageCompleteness, 'unknown');
  assert.equal(normalized.usage.input_tokens, null);
  assert.equal(normalized.costUsd, null);
  const entries = [];
  logWorkerUsage((...args) => entries.push(args), null, null, observed.accounting,
    { usageId: 'profile-id', action: 'profile', model: 'test-model' });
  assert.equal(entries[0][0], null);
  assert.equal(entries[0][2], null);
  assert.equal(entries[0][6].completeness, 'unknown');
});

test('multi-model query cost without per-model prices stays unallocated, with no ID collision or duplicated money', async () => {
  const observed = await collectClaudeWorker(stream([{ ...result, modelUsage: {
    'test-model': { inputTokens: 100, outputTokens: 20 },
    'other-model': { inputTokens: 200, outputTokens: 30 },
  } }]), { model: 'test-model' });
  const entries = [];
  logWorkerUsage((...args) => entries.push(args), null, null, observed.accounting,
    { usageId: 'profile-multi', action: 'profile', model: 'test-model' });
  assert.equal(new Set(entries.map(row => row[6].usageId)).size, entries.length);
  assert.equal(entries.reduce((n, row) => n + (row[4] || 0), 0), 0.25);
  assert.equal(entries.reduce((n, row) => n + row[2], 0), 300);
  assert.equal(entries.at(-1)[5], null);
  assert.equal(entries.at(-1)[6].usageId, 'profile-multi:unallocated-cost');
});

test('production memory ledger adapter sends all model rows in one atomic batch', () => {
  const source = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
  const label = '  logUsage: ';
  const start = source.indexOf(label);
  const end = source.indexOf('\n  },\n});', start);
  assert.ok(start >= 0 && end > start);
  const batches = [];
  const callback = new Function('logTokenBatch', `return (${source.slice(start + label.length, end + 4)});`)(rows => batches.push(rows));
  callback('alpha', 'one', { usageId: 'memory:test', completeness: 'complete', scope: 'whole-query',
    provider: 'claude', costSource: 'provider-estimate', reasoningTokens: 5,
    rows: [{ model: 'model-a', tokensIn: 20, tokensOut: 5, costUsd: null },
      { model: 'model-b', tokensIn: 30, tokensOut: 6, costUsd: null },
      { model: null, tokensIn: 0, tokensOut: 0, costUsd: 0.5 }] }, 'model-a');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.equal(new Set(batches[0].map(r => r.details.usageId)).size, 3);
  assert.equal(batches[0].at(-1).model, null);
  assert.ok(batches[0].every(r => r.details.reasoningOutputTokens == null), 'aggregate reasoning is not duplicated into every model');
});

test('timeout cannot hang forever when SDK interrupt rejects and close throws', async () => {
  const q = { [Symbol.asyncIterator]: async function* () {
    yield { type: 'assistant', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 22, output_tokens: 3 } } };
    await new Promise(() => {});
  }, interrupt: async () => { throw new Error('interrupt failed'); }, close: () => { throw new Error('close failed'); } };
  const observed = await collectClaudeWorker(q, { model: 'test-model', timeoutMs: 5 });
  assert.equal(observed.timedOut, true);
  assert.equal(observed.accounting.completeness, 'partial');
  assert.equal(observed.accounting.tokensIn, 22);
});

test('worker checkpoints observed usage before completion and fences delayed events after timeout', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  const q = { [Symbol.asyncIterator]: async function* () {
    yield { type: 'assistant', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 20, output_tokens: 2 } } };
    await hold;
    yield result;
  }, close: () => {} };
  const observed = await collectClaudeWorker(q, { model: 'test-model', timeoutMs: 5,
    onUsage: snapshot => snapshots.push(snapshot) });
  assert.equal(observed.timedOut, true);
  assert.ok(snapshots.some(s => s.tokensIn === 20 && s.completeness === 'partial'));
  const count = snapshots.length;
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.length, count, 'finished job cannot send callbacks into newer/deleted stores');
});

test('durable writer atomically supersedes provisional models without inflating unknown coverage', () => {
  const entries = [];
  const write = createWorkerUsageWriter(records => recordBatch(entries, records), 'alpha', 'one',
    { usageId: 'job', action: 'texfix', model: 'requested-model' });
  write({ rows: [], costUsd: null, completeness: 'unknown', scope: 'observed-messages' });
  write({ rows: [{ model: 'actual-model', tokensIn: 10, tokensOut: 2, costUsd: 0.1 }],
    completeness: 'complete', scope: 'whole-query' });
  const provisional = entries.find(row => row[5] === 'requested-model');
  assert.equal(provisional[2], 0);
  assert.equal(provisional[6].superseded, true);
  assert.equal(entries.filter(row => !row[6].superseded).length, 1);
});

test('writer retires an attempted provisional row even when its fsync failed after append', () => {
  const entries = [];
  let fail = true;
  const write = createWorkerUsageWriter(records => {
    recordBatch(entries, records);
    if (fail) { fail = false; throw new Error('fsync failed after append'); }
  }, 'alpha', 'one', { usageId: 'fsync-job', action: 'texfix', model: 'requested-model' });
  assert.throws(() => write({ rows: [{ model: 'requested-model', tokensIn: 50, tokensOut: 3, costUsd: null }],
    completeness: 'partial', scope: 'observed-messages' }), /fsync/);
  write({ rows: [{ model: 'actual-model', tokensIn: 60, tokensOut: 4, costUsd: 0.1 }],
    completeness: 'complete', scope: 'whole-query' });
  assert.equal(entries.reduce((n, row) => n + row[2], 0), 60);
  assert.equal(entries.find(row => row[5] === 'requested-model')[6].superseded, true);
});

function originalFunction(file, name, globals) {
  const source = fs.readFileSync(path.join(APP_DIR, 'lib', file), 'utf8');
  const begin = source.indexOf(`export function ${name}(`);
  assert.ok(begin >= 0);
  const end = source.indexOf('\n}', begin) + 2;
  const body = source.slice(begin, end).replace(/^export /, '');
  return new Function(...Object.keys(globals), `${body}; return ${name};`)(...Object.values(globals));
}

function profileFixture(messages, fail = false, ledgerFails = false) {
  const entries = [], writes = [];
  const { parseProfileJson } = loadPrivateFns(path.join(APP_DIR, 'lib/profile.js'), ['parseProfileJson']);
  const generate = originalFunction('profile.js', 'generateProfile', {
    inflight: null, process: { env: {} }, randomUUID: () => 'profile-test-id',
    gatherMaterial: () => 'Synthetic researcher material', NAME: 'Test', ROOT: '/synthetic', MODEL: 'test-model',
    query: () => { if (fail === 'start') throw new Error('failed to construct SDK query'); return stream(messages, fail); }, collectClaudeWorker, createWorkerUsageWriter,
    logTokenBatch: records => { if (ledgerFails) throw new Error('disk full'); recordBatch(entries, records); },
    logTokens: (...args) => entries.push(args), log: () => {}, logErr: () => {}, parseProfileJson,
    writeProfile: profile => writes.push(profile), readProfile: () => writes.at(-1),
  });
  return { entries, writes, generate };
}

test('profile generation accounts global work without attaching it to an arbitrary project', async () => {
  const f = profileFixture([result]);
  assert.equal((await f.generate()).bio, 'I study data.');
  assert.equal(f.entries.length, 1);
  assert.equal(f.entries[0][0], null);
  assert.equal(f.entries[0][2], 620);
  assert.equal(f.entries[0][6].action, 'profile');
  assert.equal(f.entries[0][6].usageId, 'profile:profile-test-id:test-model');
});

test('profile failure after result preserves usage without overwriting the existing profile', async () => {
  const f = profileFixture([result], true);
  assert.match((await f.generate()).error, /iterator failure/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.entries.length, 1);
  assert.equal(f.entries[0][2], 620);
  assert.equal(f.entries[0][4], 0.25);
});

test('profile invalid output still records the incurred call once', async () => {
  const f = profileFixture([{ ...result, result: 'invalid JSON' }]);
  assert.ok((await f.generate()).error);
  assert.equal(f.writes.length, 0);
  assert.equal(f.entries.length, 1);
});

test('profile status exposes ledger failures without losing its reported usage or aborting generation', async () => {
  const f = profileFixture([result], false, true);
  const profile = await f.generate();
  assert.equal(profile.bio, 'I study data.');
  assert.match(profile.ledgerWarning, /accounting is incomplete/);
  assert.match(f.writes[0].ledgerWarning, /accounting is incomplete/);
});

test('a synchronous SDK construction failure does not invent missing billed profile usage', async () => {
  const f = profileFixture([], 'start');
  assert.match((await f.generate()).error, /construct/);
  assert.equal(f.entries.length, 0);
});

for (const fail of [false, true]) test(`LaTeX worker accounts cache tokens and result${fail ? ' followed by error' : ''}`, async () => {
  const entries = [], fixes = new Map();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const start = originalFunction('texfix.js', 'startTexfix', {
    PROJECTS: { alpha: { root: '/synthetic' } }, fixes,
    failingContext: () => ({ tex: '/synthetic/main.tex', problems: [] }),
    process: { env: {} }, path, fs: { readFileSync: () => 'test document' }, MAX_INLINE: 1000,
    randomUUID: () => 'tex-test-id', MODEL: 'test-model', MAX_TURNS: 20, TIMEOUT_MS: 1000,
    broadcastFix: () => {}, log: () => {}, logErr: () => {}, buildPrompt: () => 'synthetic prompt',
    query: () => stream([{ ...result, result: '[]' }], fail), collectClaudeWorker, createWorkerUsageWriter,
    parseSuggestions: () => [], logTokens: (...args) => { entries.push(args); finish(); },
    logTokenBatch: records => { recordBatch(entries, records); if (records.some(r => r.details.completeness === 'complete')) finish(); },
  });
  assert.deepEqual(start('alpha', 'task-1'), { ok: true });
  await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][2], 620);
  assert.equal(entries[0][4], 0.25);
  assert.equal(entries[0][6].action, 'texfix');
  assert.equal(fixes.get('alpha').state, fail ? 'error' : 'done');
});
