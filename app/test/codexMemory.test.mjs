import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { requestCodexMemory } from '../lib/codexMemory.js';

const body = { model: 'account-model', reasoning: { effort: 'low' }, instructions: 'Synthesize.', input: 'Private transcript.',
  max_output_tokens: 1000, text: { format: { schema: { type: 'object' } } } };
const available = { model: body.model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] };
function fake({ account = { type: 'chatgpt' }, models = [available], events, hang = false } = {}) {
  const seen = { requests: [], spawns: [], prompt: '', kills: [] };
  const client = { request: async (method, args) => {
    seen.requests.push([method, args]);
    if (method === 'account/read') return { account };
    assert.equal(method, 'model/list');
    return { data: models, nextCursor: null };
  } };
  const spawnFn = (bin, args, opts) => {
    seen.spawns.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { seen.kills.push(signal); queueMicrotask(() => child.emit('close', 1)); };
    child.stdin.on('data', chunk => { seen.prompt += chunk.toString(); });
    child.stdin.on('finish', () => { if (!hang) queueMicrotask(() => {
      for (const event of events || [
        { type: 'item.completed', item: { type: 'agent_message', text: '{"findings":["café ✓"]}' } },
        { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } },
      ]) child.stdout.write(JSON.stringify(event) + '\n');
      child.emit('close', 0);
    }); });
    return child;
  };
  return { seen, client, spawnFn, env: { CODEX_HOME: '/fake-auth', OPENAI_API_KEY: 'do-not-use', CODEX_API_KEY: 'do-not-use', OPENAI_BASE_URL: 'do-not-use' } };
}

test('uses isolated subscription exec, strips API billing credentials, and cleans private files', async () => {
  const f = fake(); const result = await requestCodexMemory(body, f);
  assert.equal(result.status, 'completed'); assert.equal(result.costUsd, null, 'subscription usage is not a zero-dollar API charge');
  assert.match(result.output[0].content[0].text, /café ✓/);
  assert.equal(result.usage.input_tokens_details.cached_tokens, 20);
  assert.deepEqual(f.seen.requests.map(r => r[0]), ['account/read', 'model/list']);
  assert.equal(f.seen.spawns.length, 1);
  const { args, opts } = f.seen.spawns[0];
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'features.shell_tool=false', 'features.plugins=false', 'notify=[]']) assert.ok(args.includes(flag), flag);
  assert.equal(opts.env.OPENAI_API_KEY, undefined); assert.equal(opts.env.CODEX_API_KEY, undefined);
  assert.equal(opts.env.OPENAI_BASE_URL, undefined); assert.equal(opts.env.CODEX_HOME, '/fake-auth');
  assert.ok(!args.join(' ').includes(body.input)); assert.match(f.seen.prompt, /Private transcript/);
  assert.equal(fs.existsSync(opts.cwd), false);
});

test('rejects API-key login and missing account before dispatch, regardless of environment keys', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const f = fake({ account });
    await assert.rejects(requestCodexMemory(body, f), /API-key billing is not allowed/);
    assert.equal(f.seen.spawns.length, 0);
  }
});

test('requires live model and effort access; paginates account catalog', async () => {
  for (const models of [[], [{ ...available, hidden: true }], [{ ...available, supportedReasoningEfforts: [] }]]) {
    const f = fake({ models });
    await assert.rejects(requestCodexMemory(body, f), /not available/);
    assert.equal(f.seen.spawns.length, 0);
  }
  const f = fake(); const original = f.client.request;
  f.client.request = async (method, args) => method === 'model/list' && !args.cursor
    ? { data: [], nextCursor: 'next-page' } : original(method, args);
  await requestCodexMemory(body, f);
  assert.equal(f.seen.requests[1][1].cursor, 'next-page');
});

test('test guard prevents even account access', async () => {
  const f = fake(); f.env.CP_NO_BILLED = '1';
  await assert.rejects(requestCodexMemory(body, f), /disabled/);
  assert.equal(f.seen.requests.length, 0); assert.equal(f.seen.spawns.length, 0);
});

test('quota failures and unexpected tools fail closed without retries or leaking provider errors', async () => {
  for (const event of [
    { type: 'turn.failed', error: { message: 'private-provider-secret quota exceeded' } },
    { type: 'item.started', item: { type: 'command_execution', command: 'touch forbidden' } },
  ]) {
    const f = fake({ events: [event] });
    await assert.rejects(requestCodexMemory(body, f), e => !e.message.includes('private-provider-secret') && /no API fallback|tool operation/.test(e.message));
    assert.equal(f.seen.spawns.length, 1); assert.ok(f.seen.kills.length);
    assert.equal(fs.existsSync(f.seen.spawns[0].opts.cwd), false);
  }
});

test('timeout stops the worker and cleans up without retry', async () => {
  const f = fake({ hang: true });
  await assert.rejects(requestCodexMemory(body, { ...f, timeoutMs: 10 }), /timed out/);
  assert.deepEqual(f.seen.kills, ['SIGTERM']);
  assert.equal(fs.existsSync(f.seen.spawns[0].opts.cwd), false);
});

test('oversized output is incomplete but retains usage for accounting', async () => {
  const f = fake(); const result = await requestCodexMemory({ ...body, max_output_tokens: 10 }, f);
  assert.equal(result.status, 'incomplete'); assert.equal(result.usage.output_tokens, 50);
});

test('completed usage survives a later invalid/tool event that rejects the checkpoint', async () => {
  const f = fake({ events: [
    { type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 50 } },
    { type: 'item.started', item: { type: 'command_execution' } },
  ] });
  await assert.rejects(requestCodexMemory(body, f), err => {
    assert.equal(err.accountingResponse.usage.input_tokens, 300);
    assert.equal(err.accountingResponse.usageCompleteness, 'complete');
    assert.equal(err.accountingResponse.costUsd, null);
    return /tool operation/.test(err.message);
  });
});

test('failed Codex result retains partial usage; absent usage is explicitly unknown', async () => {
  for (const usage of [{ input_tokens: 70, output_tokens: 10 }, undefined]) {
    const f = fake({ events: [{ type: 'turn.failed', usage }] });
    await assert.rejects(requestCodexMemory(body, f), err => {
      assert.equal(err.accountingResponse.usageCompleteness, usage ? 'partial' : 'unknown');
      assert.equal(err.accountingResponse.usage?.input_tokens ?? null, usage ? 70 : null);
      return true;
    });
  }
});

test('later failed or malformed telemetry cannot replace a captured completed total', async () => {
  const f = fake({ events: [
    { type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 200,
      cache_write_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 20 } },
    { type: 'turn.failed', usage: { input_tokens: 1, output_tokens: 1 } },
  ] });
  await assert.rejects(requestCodexMemory(body, f), err => {
    assert.equal(err.accountingResponse.usage.input_tokens, 300);
    assert.equal(err.accountingResponse.usage.input_tokens_details.cache_write_tokens, 10);
    assert.equal(err.accountingResponse.usage.output_tokens_details.reasoning_tokens, 20);
    assert.equal(err.accountingResponse.usageCompleteness, 'complete');
    return true;
  });
});

test('invalid usage breakdown retains valid totals as partial without inventing charges', async () => {
  const f = fake({ events: [
    { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
    { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 200,
      output_tokens: 5, reasoning_output_tokens: 20 } },
  ] });
  const response = await requestCodexMemory(body, f);
  assert.equal(response.usage.input_tokens, 30);
  assert.equal(response.usage.input_tokens_details.cached_tokens, null);
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, null);
  assert.equal(response.usageCompleteness, 'partial');
});

test('partial terminal updates cannot erase an earlier observed lower bound', async () => {
  const f = fake({ events: [
    { type: 'turn.failed', usage: { input_tokens: 100, output_tokens: 20 } },
    { type: 'turn.failed', usage: { input_tokens: null, output_tokens: 1 } },
  ] });
  await assert.rejects(requestCodexMemory(body, f), err => {
    assert.equal(err.accountingResponse.usage.input_tokens, 100);
    assert.equal(err.accountingResponse.usage.output_tokens, 20);
    assert.equal(err.accountingResponse.usageCompleteness, 'partial');
    return true;
  });
});

test('asynchronous missing-executable error records no dispatched-usage checkpoint', async () => {
  const f = fake({ hang: true });
  const originalSpawn = f.spawnFn;
  const checkpoints = [];
  await assert.rejects(requestCodexMemory(body, { ...f, onUsage: u => checkpoints.push(u), spawnFn: (...args) => {
    const child = originalSpawn(...args);
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' })));
    return child;
  } }), err => err.dispatched === false);
  assert.equal(checkpoints.length, 0);
});
