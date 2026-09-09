// Full checkpoint pipeline with a simulated Codex process: no provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkTmp, rmTmp } from './helpers.mjs';
import { createMemorySettings } from '../lib/memorySettings.js';
import { createMemoryService } from '../lib/taskMemory.js';
import { requestCodexMemory } from '../lib/codexMemory.js';

const model = 'gpt-5.6-luna';
const answer = {
  findings: ['The corrected rate is 0.05 per year, not 0.5.'],
  constraints: ['Keep the production model unchanged.'],
  uncertainties: ['The monthly conversion is not yet verified.'],
  nextSteps: ['Verify the monthly conversion.'],
  evidence: [{ claim: 'Corrected annual rate: 0.05.', source: 'event-2' },
    { claim: 'Keep production unchanged.', source: 'event-1' }],
};

function pipeline(t, forbidden = false) {
  const root = mkTmp('cp-memory-pipeline-');
  const events = [
    { role: 'user', ts: '2026-09-09T10:00:00Z', text: 'Initial task: test a rate of 0.5 per year. Keep the production model unchanged.' },
    { role: 'user', ts: '2026-09-09T10:01:00Z', text: 'Correction: use 0.05 per year, not 0.5. The monthly conversion is not yet verified. Verify it next.' },
  ];
  const task = { id: 'one', created: '2026-09-09T09:00:00Z', session: { threadId: 'keep' } };
  const settings = createMemorySettings(root, {}, { codexStatus: () => ({ connected: true,
    account: { type: 'chatgpt' }, models: [{ id: model, supportedReasoningEfforts: [{ id: 'low' }] }] }) });
  settings.update({ enabled: true, model });
  const client = { request: async method => method === 'account/read' ? { account: { type: 'chatgpt' } }
    : { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } };
  const seen = { calls: 0, kills: [], prompts: [], usage: [] };
  const spawnFn = () => {
    seen.calls++;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { seen.kills.push(signal); queueMicrotask(() => child.emit('close', 1)); };
    let prompt = '';
    child.stdin.on('data', data => { prompt += data; });
    child.stdin.on('finish', () => queueMicrotask(() => {
      seen.prompts.push(prompt);
      const stream = [
        { type: 'thread.started', thread_id: 'fake-thread' },
        { type: 'item.completed', item: { type: 'error', message: 'PRIVATE_DIAGNOSTIC_MUST_NOT_BE_SAVED' } },
        { type: 'turn.started' },
        ...(forbidden ? [{ type: 'item.started', item: { type: 'command_execution', command: 'PRIVATE_COMMAND_MUST_NOT_BE_SAVED' } }] : [
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } },
          { type: 'turn.completed', usage: { input_tokens: 240, cached_input_tokens: 0, output_tokens: 120 } },
        ]),
      ].map(event => JSON.stringify(event)).join('\n') + '\n';
      // Exercise JSONL framing across chunk boundaries, not one event per chunk.
      child.stdout.write(stream.slice(0, 19)); child.stdout.write(stream.slice(19));
      child.emit('close', forbidden ? 1 : 0);
    }));
    return child;
  };
  const deps = { root, settings, getTask: () => task, getTranscript: () => events, isActive: () => false,
    now: () => new Date('2026-09-09T11:00:00Z'),
    request: (body, _connection, observers) => requestCodexMemory(body,
      { client, spawnFn, env: {}, ...observers }),
    logUsage: (...args) => seen.usage.push(args) };
  const service = createMemoryService(deps);
  t.after(() => { service.close(); rmTmp(root); });
  return { root, service, deps, seen, task, events };
}

test('diagnostic → successful transport → persisted, sourced history survives reload without changing the conversation', async t => {
  const f = pipeline(t);
  const before = JSON.stringify([f.task, f.events]);
  await f.service.run('alpha', 'one');
  const view = f.service.view('alpha', 'one');
  assert.deepEqual(view.current.content, answer);
  assert.equal(view.current.inspectionOnly, true);
  assert.equal(view.current.coverage.cursor.index, 2);
  assert.equal(view.pending, false);
  assert.equal(view.counts.successful, 1);
  assert.equal(view.jobs[0].usage.inputTokens, 240);
  assert.equal(view.jobs[0].usage.outputTokens, 120);
  assert.equal(f.service.jobsToday(), 1);
  assert.equal(f.seen.calls, 1); assert.deepEqual(f.seen.kills, []);
  assert.match(f.seen.prompts[0], /Keep the production model unchanged/);
  assert.match(f.seen.prompts[0], /Correction: use 0.05 per year, not 0.5/);
  assert.equal(JSON.stringify([f.task, f.events]), before);
  assert.match(f.service.evidence('alpha', 'one', 1, 'event-2').text, /0.05 per year, not 0.5/);
  const stored = fs.readdirSync(path.join(f.root, 'memory')).map(file => fs.readFileSync(path.join(f.root, 'memory', file), 'utf8')).join('\n');
  assert.doesNotMatch(stored, /PRIVATE_DIAGNOSTIC_MUST_NOT_BE_SAVED/);
  f.service.close();
  const reloaded = createMemoryService(f.deps); t.after(() => reloaded.close());
  assert.deepEqual(reloaded.view('alpha', 'one').current.content, answer);
  assert.equal(reloaded.jobsToday(), 1); assert.equal(f.seen.calls, 1);
});

test('diagnostic cannot disguise an actual tool: pause survives reload and repeated prompts do not spend another slot', async t => {
  const f = pipeline(t, true);
  await f.service.run('alpha', 'one');
  assert.equal(f.service.view('alpha', 'one').current, null);
  assert.ok(f.service.status().pause);
  for (let i = 0; i < 20; i++) { f.service.enqueue('alpha', 'one'); await f.service.drain(); }
  assert.equal(f.seen.calls, 1); assert.equal(f.service.jobsToday(), 1);
  assert.equal(f.service.view('alpha', 'one').counts.failed, 1);
  assert.ok(f.seen.kills.includes('SIGTERM'));
  const stored = fs.readdirSync(path.join(f.root, 'memory')).map(file => fs.readFileSync(path.join(f.root, 'memory', file), 'utf8')).join('\n');
  assert.doesNotMatch(stored, /PRIVATE_DIAGNOSTIC_MUST_NOT_BE_SAVED|PRIVATE_COMMAND_MUST_NOT_BE_SAVED/);
  f.service.close();
  const reloaded = createMemoryService(f.deps); t.after(() => reloaded.close());
  assert.ok(reloaded.status().pause);
  reloaded.resume('codex-subscription');
  assert.equal(reloaded.status().pause, null);
  assert.equal(reloaded.jobsToday(), 1); assert.equal(f.seen.calls, 1, 'resume does not dispatch');
});
