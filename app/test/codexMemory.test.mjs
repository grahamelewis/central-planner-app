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
  assert.equal(result.status, 'completed'); assert.equal(result.costUsd, 0);
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
