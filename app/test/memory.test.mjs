import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, rmTmp } from './helpers.mjs';
import { createMemorySettings, MEMORY_DEFAULTS, MEMORY_MODELS } from '../lib/memorySettings.js';
import { createMemoryService, requestMemory, requestClaudeSdk, CHECKPOINT_SCHEMA } from '../lib/taskMemory.js';

const checkpoint = (source = 'event-1') => ({
  findings: ['Baseline is 0.5, not 5.'], constraints: ['Do not change the production model.'],
  uncertainties: ['Units need verification.'], nextSteps: ['Check the fixture.'],
  evidence: [{ claim: 'Baseline is 0.5.', source }],
});
const response = content => ({ status: 'completed', usage: { input_tokens: 1000, output_tokens: 300,
  input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 100 } },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }] });
function fixture(t, options = {}) {
  const root = mkTmp('cp-memory-');
  const state = { task: { id: 'one', created: '2026-09-04T00:00:00Z', session: { threadId: 'untouched' } }, active: false,
    events: [{ role: 'user', text: 'The baseline is 0.5, not 5. Do not change production.', ts: 'a' }], calls: [], logs: [] };
  const settings = createMemorySettings(root, {}, { claudeConnected: () => options.claude === true,
    codexStatus: () => ({ connected: true, account: { type: 'chatgpt' }, models: ['gpt-5.6-luna', 'gpt-5.6-terra'].map(id => ({ id, supportedReasoningEfforts: [{ id: 'low' }, { id: 'medium' }] })) }) });
  settings.update({ connection: 'codex-subscription', model: 'gpt-5.6-luna', enabled: true, dailyBudgetUsd: 1, ...options.settings });
  const deps = { root, settings, getTask: () => state.task, getTranscript: () => state.events, isActive: () => state.active,
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.preflight ? { preflight: (...args) => options.preflight(...args, state) } : {}),
    request: async (body, _connection, observers) => { state.calls.push(body); return options.request ? options.request(body, state, observers) : response(checkpoint()); },
    logUsage: (...args) => state.logs.push(args), now: () => new Date('2026-09-04T12:00:00Z') };
  const service = createMemoryService(deps);
  t.after(() => { service.close(); rmTmp(root); });
  return { root, state, settings, service, deps };
}

test('settings are opt-in, isolated, validated, and secret-free', t => {
  const root = mkTmp('cp-memory-settings-'); t.after(() => rmTmp(root));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agents: { defaultModel: 'keep' }, user: { name: 'keep' } }));
  const s = createMemorySettings(root, {}, { claudeConnected: () => false });
  assert.deepEqual(s.get(), MEMORY_DEFAULTS);
  assert.equal(MEMORY_DEFAULTS.connection, 'codex-subscription'); assert.equal(MEMORY_DEFAULTS.model, 'gpt-5.6-luna');
  assert.throws(() => s.update({ enabled: true, dailyBudgetUsd: 1 }), /Sign in to Codex/);
  assert.throws(() => s.update({ connection: 'claude-sdk', model: 'claude-sonnet-5', enabled: true, dailyBudgetUsd: 1 }), /Sign in to Claude/);
  assert.throws(() => s.update({ connection: 'openai-api', model: 'gpt-5.6-luna', enabled: true, dailyBudgetUsd: 1 }), /removed/);
  for (const patch of [{ model: 'unknown' }, { reasoningEffort: 'max' }, { model: 'claude-sonnet-5' } /* wrong connection */, { connection: 'claude-sdk' } /* OpenAI model on Claude */, { dailyBudgetUsd: -1 }, { maxInputTokens: '24000' }, { apiKey: 'secret' }, { enabled: 'yes' }, []]) assert.throws(() => s.update(patch));
  s.update({ connection: 'codex-subscription', model: 'gpt-5.6-terra', dailyBudgetUsd: 2 });
  assert.equal(s.publicSettings().credentialConfigured, false);
  assert.deepEqual(s.publicSettings().connections.map(c => [c.id, c.credentialConfigured]), [['claude-sdk', false], ['codex-subscription', false]]);
  const signedIn = createMemorySettings(root, {}, { claudeConnected: () => true });
  assert.equal(signedIn.publicSettings().connections.find(c => c.id === 'claude-sdk').credentialConfigured, true);
  signedIn.update({ connection: 'claude-sdk', model: 'claude-haiku-4-5', reasoningEffort: 'none', enabled: true, dailyBudgetUsd: 1 });
  assert.equal(signedIn.get().enabled, true);
  signedIn.update({ enabled: false });
  assert.equal(s.get().enabled, false);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  assert.deepEqual(cfg.agents, { defaultModel: 'keep' }); assert.deepEqual(cfg.user, { name: 'keep' });
  fs.writeFileSync(path.join(root, 'config.json'), '{malformed');
  assert.throws(() => s.update({ enabled: false }), /Cannot read/);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{malformed');
});

const incompatible = () => Object.assign(new Error('secret raw failure'), { status: 502,
  code: 'memory-protocol-unsupported', deterministic: true, pauseWorthy: true,
  diagnostics: { code: 'memory-protocol-unsupported', eventType: 'item.completed', itemType: 'unknown',
    stage: 'protocol', stderr: 'secret stderr', input: 'private transcript', arbitrary: 'secret' } });

test('deterministic failure pauses durably; twenty later prompts reserve nothing and coalesce pending work', async t => {
  const { root, service, state, deps } = fixture(t, { request: () => { throw incompatible(); } });
  await service.run('alpha', 'one');
  for (let i = 0; i < 20; i++) { service.enqueue('alpha', 'one'); await service.drain(); }
  const view = service.view('alpha', 'one');
  assert.equal(state.calls.length, 1); assert.equal(service.jobsToday(), 1);
  assert.equal(view.counts.failed, 1); assert.equal(view.counts.blocked, 0);
  assert.equal(view.budget.pendingCount, 1); assert.equal(view.eligibility.reason, 'paused');
  assert.equal(view.pause.code, 'memory-protocol-unsupported');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'memory/control.json'), 'utf8'), /secret|private|stderr/);
  assert.doesNotMatch(JSON.stringify(view), /secret raw failure|private transcript|secret stderr/);
  service.close(); const restarted = createMemoryService(deps); t.after(() => restarted.close());
  assert.equal(restarted.status().pause.code, 'memory-protocol-unsupported');
  assert.equal(restarted.status().pendingCount, 0, 'restart does not auto-enqueue a historical backlog');
  await assert.rejects(restarted.run('alpha', 'one'), /paused/);
  assert.equal(state.calls.length, 1);
});

test('readiness incompatibility reserves no slot and pauses before worker dispatch', async t => {
  const { root, state, service } = fixture(t, { preflight: () => { throw incompatible(); } });
  await service.run('alpha', 'one');
  assert.equal(state.calls.length, 0); assert.equal(service.jobsToday(), 0);
  assert.equal(fs.existsSync(path.join(root, 'memory/budget.json')), false);
  assert.equal(service.view('alpha', 'one').jobs[0].notDispatched, true);
  assert.equal(service.view('alpha', 'one').jobs[0].reservationHeld, false);
  assert.equal(service.status().pause.code, 'memory-protocol-unsupported');
});

test('resume clears only the selected connection pause without dispatch or historical refund', async t => {
  const { root, service, state } = fixture(t, { settings: { dailyJobLimit: 1 }, request: () => { throw incompatible(); } });
  await service.run('alpha', 'one'); service.enqueue('alpha', 'one'); await service.drain();
  const before = fs.readFileSync(path.join(root, 'memory/budget.json'), 'utf8');
  assert.throws(() => service.resume('claude-sdk'), /currently configured/);
  assert.throws(() => service.resume(), /currently configured/);
  assert.equal(service.resume('codex-subscription').pause, null);
  assert.equal(service.status().remainingJobs, 0); assert.equal(service.jobsToday(), 1);
  assert.equal(service.view('alpha', 'one').jobs[0].reservationHeld, true);
  assert.equal(fs.readFileSync(path.join(root, 'memory/budget.json'), 'utf8'), before);
  assert.equal(state.calls.length, 1);
  await service.drain(); assert.equal(state.calls.length, 1);
  assert.equal(service.view('alpha', 'one').counts.blocked, 0);
  assert.equal(service.status().pendingCount, 1);
});

test('busy pending work is retained without duplicate blocked records and rearms on a new trigger', async t => {
  const { service, state } = fixture(t); state.active = true;
  for (let i = 0; i < 5; i++) { service.enqueue('alpha', 'one'); await service.drain(); }
  assert.equal(service.status().pendingCount, 1); assert.equal(service.jobsToday(), 0);
  assert.equal(service.view('alpha', 'one').counts.blocked, 0);
  state.active = false;
  assert.equal(service.enqueue('alpha', 'one'), false, 'existing pending task is coalesced, not lost');
  await service.drain();
  assert.equal(state.calls.length, 1); assert.equal(service.status().pendingCount, 0);
});

test('readiness races recheck activity, task generation, settings and source before reserving', async t => {
  for (const mutation of ['active', 'generation', 'source', 'settings']) {
    const f = fixture(t, { preflight: () => {
      if (mutation === 'active') f.state.active = true;
      if (mutation === 'generation') f.state.task = { ...f.state.task, created: 'new' };
      if (mutation === 'source') f.state.events.push({ role: 'user', text: 'new' });
      if (mutation === 'settings') f.settings.update({ model: 'gpt-5.6-terra' });
    } });
    f.service.enqueue('alpha', 'one'); await f.service.drain();
    assert.equal(f.state.calls.length, 0, mutation); assert.equal(f.service.jobsToday(), 0, mutation);
  }
});

test('transient failure is not an autonomous retry or a durable pause', async t => {
  const { service, state } = fixture(t, { request: () => { throw Object.assign(new Error('secret'), {
    code: 'memory-timeout', deterministic: false, pauseWorthy: false }); } });
  service.enqueue('alpha', 'one'); await service.drain(); await service.drain();
  assert.equal(service.status().pause, null); assert.equal(state.calls.length, 1);
  service.enqueue('alpha', 'one'); await service.drain();
  assert.equal(state.calls.length, 2); assert.equal(service.jobsToday(), 2);
});

test('invalid pause metadata fails closed without modifying the record or making calls', async t => {
  const { root, service, state } = fixture(t);
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  const file = path.join(root, 'memory/control.json'); fs.writeFileSync(file, '{invalid');
  assert.throws(() => service.status(), /unreadable/);
  await assert.rejects(service.run('alpha', 'one'), /unreadable/);
  assert.throws(() => service.resume('codex-subscription'), /unreadable/);
  assert.equal(state.calls.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});

test('coverage reports a partial bounded checkpoint rather than claiming all history is summarized', async t => {
  const { service, state } = fixture(t); state.events[0].text = 'x'.repeat(50000);
  await service.run('alpha', 'one');
  const view = service.view('alpha', 'one');
  assert.equal(view.counts.successful, 1); assert.equal(view.coverage.totalEvents, 1);
  assert.equal(view.coverage.coveredEvents, 0); assert.ok(view.coverage.partialEvent > 0);
  assert.equal(view.coverage.complete, false); assert.equal(view.pending, true);
});

test('successful warning diagnostics are retained without arbitrary metadata or secret-like type values', async t => {
  const { service } = fixture(t, { request: () => ({ ...response(checkpoint()), diagnostics: {
    stage: 'completed', eventType: 'secret-token', itemType: 'secret-token', version: 'secret-token',
    warningCount: 2, warningEventType: 'item.completed', warningItemType: 'error',
    code: 'secret-token', stderr: 'secret-token', message: 'secret-token',
  } }) });
  await service.run('alpha', 'one');
  assert.deepEqual(service.view('alpha', 'one').jobs[0].diagnostics, {
    eventType: 'unknown', itemType: 'unknown', stage: 'completed', warningCount: 2,
    warningEventType: 'item.completed', warningItemType: 'error',
  });
  assert.doesNotMatch(JSON.stringify(service.view('alpha', 'one')), /secret-token/);
});

test('pause storage failure still blocks repeat dispatch in this process and reports lack of durability', async t => {
  const { service, state, root } = fixture(t, { request: () => { throw incompatible(); } });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, 'memory/control.json')) throw Object.assign(new Error('fixture storage full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { await service.run('alpha', 'one'); }
  finally { fs.renameSync = rename; }
  assert.match(service.status().pause.persistenceWarning, /could not be saved/);
  service.enqueue('alpha', 'one'); await service.drain();
  assert.equal(state.calls.length, 1); assert.equal(service.jobsToday(), 1);
  assert.equal(service.resume('codex-subscription').pause, null);
});

test('concurrent same-task readiness checks cannot create duplicate reservations', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, state } = fixture(t, { preflight: () => gate });
  const first = service.run('alpha', 'one');
  await service.run('alpha', 'one'); release(); await first;
  assert.equal(state.calls.length, 1); assert.equal(service.jobsToday(), 1);
});

test('resume does not awaken pending timers armed before or during a pause', async t => {
  const { service, state } = fixture(t, { debounceMs: 10, request: () => { throw incompatible(); } });
  service.enqueue('alpha', 'one');
  await service.run('alpha', 'one'); // fails while the original idle timer is armed
  service.enqueue('alpha', 'one'); // paused triggers stay pending, without a new timer
  service.resume('codex-subscription');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(state.calls.length, 1, 'explicit resume alone cannot cause another model attempt');
  assert.equal(service.status().pendingCount, 1);
});

test('Claude dollar admission is rechecked after concurrent readiness and reflected in eligibility', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, state } = fixture(t, { claude: true, preflight: () => gate, settings: {
    connection: 'claude-sdk', model: 'claude-haiku-4-5', reasoningEffort: 'none', dailyBudgetUsd: 0.03,
  } });
  const first = service.run('alpha', 'one'), second = service.run('alpha', 'two');
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && /budget/.test(r.reason.message)).length, 1);
  assert.equal(state.calls.length, 1); assert.ok(service.spentToday() <= 0.03);
  assert.equal(service.view('alpha', 'two').eligibility.reason, 'budget');
});

test('legacy API settings migrate disabled; API-key sign-in cannot enable subscription memory', t => {
  const root = mkTmp('cp-memory-migrate-'); t.after(() => rmTmp(root));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ memory: { ...MEMORY_DEFAULTS, connection: 'openai-api', enabled: true } }));
  const s = createMemorySettings(root, { OPENAI_API_KEY: 'unused' }, { claudeConnected: () => false,
    codexStatus: () => ({ connected: true, account: { type: 'apiKey' }, models: [] }) });
  assert.equal(s.get().enabled, false); assert.equal(s.get().connection, 'codex-subscription');
  assert.equal(s.publicSettings().credentialConfigured, false);
  assert.throws(() => s.update({ enabled: true }), /Sign in to Codex/);
});

test('account-specific model persists and remains disableable after disconnect', t => {
  const root = mkTmp('cp-memory-model-'); t.after(() => rmTmp(root));
  let connected = true;
  const s = createMemorySettings(root, {}, { claudeConnected: () => false, codexStatus: () => ({ connected,
    account: connected ? { type: 'chatgpt' } : null,
    models: [{ id: 'account-model', supportedReasoningEfforts: [{ id: 'high' }] }] }) });
  s.update({ model: 'account-model', reasoningEffort: 'high', enabled: true });
  assert.equal(s.get().dailyBudgetUsd, 0, 'subscription needs no API budget');
  connected = false;
  assert.equal(s.get().model, 'account-model');
  assert.equal(s.publicSettings().models.find(m => m.id === 'account-model').available, false);
  s.update({ enabled: false }); assert.equal(s.get().enabled, false);
  assert.throws(() => s.update({ enabled: true }), /Sign in to Codex/);
});

test('subscription daily slots survive failures and restart without dollar estimates', async t => {
  const { state, service, deps } = fixture(t, { settings: { dailyJobLimit: 1, dailyBudgetUsd: 0 }, request: async () => { throw new Error('quota'); } });
  await service.run('alpha', 'one');
  assert.equal(service.view('alpha', 'one').jobs[0].status, 'failed');
  assert.equal(service.jobsToday(), 1); assert.equal(service.spentToday(), 0);
  service.close();
  const restarted = createMemoryService(deps); t.after(() => restarted.close());
  await assert.rejects(restarted.run('alpha', 'one'), /daily.*limit/i);
  assert.equal(state.calls.length, 1);
});

test('publishes a versioned checkpoint, records usage, and leaves the working conversation untouched', async t => {
  const { state, service } = fixture(t);
  const before = JSON.stringify({ task: state.task, events: state.events });
  await service.run('alpha', 'one');
  const view = service.view('alpha', 'one');
  assert.equal(view.current.revision, 1); assert.equal(view.current.inspectionOnly, true);
  assert.equal(view.current.validation, 'structure-and-source-ids-only');
  assert.deepEqual(view.current.content, checkpoint());
  assert.equal(view.pending, false); assert.equal(view.totals.inputTokens, 1000);
  assert.equal(view.jobs[0].usage.reasoningTokens, 100); assert.equal(state.logs.length, 1);
  assert.equal(view.jobs[0].usage.costSource, 'subscription'); assert.equal(view.jobs[0].usage.estimatedCostUsd, null);
  assert.equal(JSON.stringify({ task: state.task, events: state.events }), before);
  const body = state.calls[0];
  assert.equal(body.model, 'gpt-5.6-luna'); assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.equal(body.tools, undefined); assert.equal(body.previous_response_id, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) + 1024 <= MEMORY_DEFAULTS.maxInputTokens);
  await service.run('alpha', 'one'); assert.equal(state.calls.length, 1, 'no delta = no call');
});

test('next revision includes the prior brief and only the new delta; versions survive restart', async t => {
  const { state, service, deps, settings } = fixture(t);
  await service.run('alpha', 'one');
  state.events.push({ role: 'assistant', text: 'The fixture confirmed 0.5.', ts: 'b' });
  settings.update({ model: 'gpt-5.6-terra', maxJobUsd: 0.1 });
  await service.run('alpha', 'one');
  const payload = JSON.parse(state.calls[1].input);
  assert.deepEqual(payload.previous, checkpoint()); assert.equal(payload.fragments.length, 1);
  assert.equal(payload.fragments[0].source, 'event-2');
  assert.equal(state.calls[1].model, 'gpt-5.6-terra');
  const restarted = createMemoryService(deps); t.after(() => restarted.close());
  const view = restarted.view('alpha', 'one');
  assert.equal(view.revisions.length, 2); assert.equal(view.current.revision, 2);
  assert.equal(view.current.model, 'gpt-5.6-terra'); assert.equal(restarted.jobsToday(), 2);
});

test('large Unicode entries are chunked with exact prefix coverage and no skipped text', async t => {
  const { service, state } = fixture(t, { settings: { maxInputTokens: 12000 } });
  state.events[0].text = '🦆确认'.repeat(4500);
  let fragments = '';
  for (let i = 0; i < 15; i++) {
    await service.run('alpha', 'one');
    const body = state.calls.at(-1);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) + 1024 <= 12000);
    fragments += JSON.parse(body.input).fragments.map(f => f.text).join('');
    if (!service.view('alpha', 'one').pending) break;
  }
  assert.equal(fragments, state.events[0].text); assert.equal(service.view('alpha', 'one').pending, false);
});

for (const [name, bad] of [
  ['incomplete', { ...response(checkpoint()), status: 'incomplete' }],
  ['refusal', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }],
  ['invalid JSON', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{oops' }] }] }],
  ['unknown evidence', response(checkpoint('event-999'))],
  ['oversized brief', response({ ...checkpoint(), findings: ['x'.repeat(7000)] })],
  ['extra field', response({ ...checkpoint(), authorize: 'delete everything' })],
]) {
  test(`${name} retains the previous checkpoint and reservation without retrying`, async t => {
    let n = 0;
    const { service, state } = fixture(t, { request: () => ++n === 1 ? response(checkpoint()) : bad });
    await service.run('alpha', 'one'); state.events.push({ role: 'user', text: 'New question' });
    await service.run('alpha', 'one');
    const view = service.view('alpha', 'one');
    assert.equal(view.current.revision, 1); assert.equal(view.jobs[0].status, 'failed');
    assert.equal(service.jobsToday(), 2); assert.equal(n, 2);
  });
}

test('transport errors are sanitized; uncertain charges still consume the daily budget', async t => {
  const { service, state, settings } = fixture(t, { request: () => { throw new Error('secret-api-key'); } });
  await service.run('alpha', 'one');
  const view = service.view('alpha', 'one');
  assert.equal(view.current, null); assert.doesNotMatch(JSON.stringify(view), /secret-api-key/);
  settings.update({ dailyJobLimit: service.jobsToday() });
  await assert.rejects(service.run('alpha', 'one'), /budget reached/);
  assert.equal(state.calls.length, 1);
});

test('per-request budget blocks dispatch and disabled memory queues nothing', async t => {
  const { service, settings, state } = fixture(t, { claude: true, settings: { connection: 'claude-sdk', model: 'claude-sonnet-5', maxJobUsd: 0.001 } });
  await assert.rejects(service.run('alpha', 'one'), /budget reached/);
  assert.equal(state.calls.length, 0); assert.equal(service.spentToday(), 0);
  settings.update({ enabled: false }); assert.equal(service.enqueue('alpha', 'one'), false);
  await assert.rejects(service.run('alpha', 'one'), /disabled/);
});

test('running turns and edited source prefixes cannot advance memory', async t => {
  const { service, state } = fixture(t);
  state.active = true; await assert.rejects(service.run('alpha', 'one'), /turn is running/);
  state.active = false; await service.run('alpha', 'one');
  state.events[0].text = 'rewritten history';
  await assert.rejects(service.run('alpha', 'one'), /Transcript changed/);
  assert.equal(state.calls.length, 1); assert.equal(service.view('alpha', 'one').current.revision, 1);
});

test('duplicate queued jobs coalesce and all requests run serially', async t => {
  let active = 0, high = 0;
  const { service, state } = fixture(t, { request: async () => {
    high = Math.max(high, ++active); await new Promise(r => setImmediate(r)); active--; return response(checkpoint());
  } });
  assert.equal(service.enqueue('alpha', 'one'), true); assert.equal(service.enqueue('alpha', 'one'), false);
  assert.equal(service.view('alpha', 'one').status, 'queued');
  await Promise.all([service.drain(), service.drain()]);
  assert.equal(state.calls.length, 1); assert.equal(high, 1);
});

for (const change of ['edit', 'append', 'new-turn', 'delete', 'reuse']) {
  test(`in-flight ${change} discards a stale candidate`, async t => {
    const { service, state } = fixture(t, { request: (_body, s) => {
      if (change === 'edit') s.events[0].text = 'edited';
      if (change === 'append') s.events.push({ role: 'user', text: 'A newer correction.' });
      if (change === 'new-turn') s.active = true;
      if (change === 'delete') s.task = null;
      if (change === 'reuse') s.task = { ...s.task, created: 'different-instance' };
      return response(checkpoint());
    } });
    const original = state.task;
    await service.run('alpha', 'one'); state.task = original;
    const view = service.view('alpha', 'one');
    assert.equal(view.current, null); assert.equal(view.jobs[0].status, 'failed');
  });
}

test('task ID reuse cannot resurrect another task checkpoint', async t => {
  const { service, state } = fixture(t);
  await service.run('alpha', 'one'); state.task.created = 'new-instance';
  assert.equal(service.view('alpha', 'one').current, null);
});

test('evidence inspection is revision-bound, paginated, and detects changed transcripts', async t => {
  const { service, state } = fixture(t, { settings: { maxInputTokens: 64000 } });
  state.events[0].text = 'a'.repeat(20000);
  await service.run('alpha', 'one');
  const first = service.evidence('alpha', 'one', 1, 'event-1');
  assert.equal(first.text.length, 12000); assert.equal(first.nextOffset, 12000);
  const rest = service.evidence('alpha', 'one', 1, 'event-1', first.nextOffset);
  assert.equal(rest.text.length, 8000); assert.equal(rest.nextOffset, null);
  assert.throws(() => service.evidence('alpha', 'one', 1, 'event-999'), /not found/);
  assert.throws(() => service.evidence('alpha', 'one', 1, 'event-1', -1), /Invalid/);
  state.events[0].text = 'changed';
  assert.throws(() => service.evidence('alpha', 'one', 1, 'event-1'), /changed/);
});

test('deleting memory cancels queued work, erases checkpoints, and retains budget accounting', async t => {
  const { service, state } = fixture(t);
  await service.run('alpha', 'one');
  const reserved = service.spentToday();
  state.events.push({ role: 'user', text: 'New event' });
  service.enqueue('alpha', 'one'); service.forget('alpha', 'one');
  await service.drain();
  assert.equal(service.view('alpha', 'one').current, null);
  assert.equal(state.calls.length, 1); assert.equal(service.spentToday(), reserved);
});

test('deleting during a request cannot recreate its memory file', async t => {
  let erase;
  const { service } = fixture(t, { request: () => { erase(); return response(checkpoint()); } });
  erase = () => service.forget('alpha', 'one');
  await service.run('alpha', 'one');
  assert.equal(service.view('alpha', 'one').jobs.length, 0);
  assert.equal(service.view('alpha', 'one').current, null);
  assert.equal(service.jobsToday(), 1);
});

test('a completed turn arriving during consolidation queues one follow-up with fresh data', async t => {
  let queueNew;
  const { service, state } = fixture(t, { request: (_body, s) => {
    if (s.calls.length === 1) { s.events.push({ role: 'user', text: 'New correction' }); queueNew(); }
    return response(checkpoint());
  } });
  queueNew = () => { assert.equal(service.enqueue('alpha', 'one'), true); assert.equal(service.enqueue('alpha', 'one'), false); };
  service.enqueue('alpha', 'one'); await service.drain();
  assert.equal(state.calls.length, 2);
  const view = service.view('alpha', 'one');
  assert.equal(view.jobs[1].status, 'failed'); assert.equal(view.jobs[0].status, 'completed');
  assert.equal(view.current.coverage.cursor.index, 2);
});

test('symlinked memory directories and corrupted budget stores fail closed', async t => {
  const { root, service, state } = fixture(t);
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'memory'));
  await assert.rejects(service.run('alpha', 'one'), /symlinks/);
  fs.unlinkSync(path.join(root, 'memory')); fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory/budget.json'), '{bad');
  await assert.rejects(service.run('alpha', 'one'), /unreadable/);
  assert.equal(state.calls.length, 0);
});

test('CP_NO_BILLED guards the actual transport before network access', async () => {
  const prior = process.env.CP_NO_BILLED;
  process.env.CP_NO_BILLED = '1';
  try { await assert.rejects(requestMemory({}), /disabled/); }
  finally { if (prior === undefined) delete process.env.CP_NO_BILLED; else process.env.CP_NO_BILLED = prior; }
});

test('Claude connection: Sonnet 5 fits the default per-request cap at both token ceilings', () => {
  const sonnet = MEMORY_MODELS.find(m => m.id === 'claude-sonnet-5');
  const ceiling = (MEMORY_DEFAULTS.maxInputTokens * sonnet.input * sonnet.cacheWrite + MEMORY_DEFAULTS.maxOutputTokens * sonnet.output) / 1e6;
  assert.ok(ceiling <= MEMORY_DEFAULTS.maxJobUsd, `ceiling $${ceiling.toFixed(4)} exceeds the default cap`);
});

test('Claude connection: the writer gets a tool-less single-turn SDK body and the provider cost estimate is recorded', async t => {
  const { service, state } = fixture(t, { claude: true,
    settings: { connection: 'claude-sdk', model: 'claude-sonnet-5', reasoningEffort: 'low' },
    request: (_body, _s) => ({ ...response(checkpoint()), costUsd: 0.0123 }) });
  await service.run('alpha', 'one');
  const body = state.calls[0];
  assert.equal(body.connection, 'claude-sdk'); assert.equal(body.model, 'claude-sonnet-5'); assert.equal(body.effort, 'low');
  assert.equal(typeof body.systemPrompt, 'string'); assert.match(body.systemPrompt, /untrusted evidence/);
  assert.deepEqual(JSON.parse(body.prompt).fragments.map(f => f.source), ['event-1']);
  assert.deepEqual(body.schema, CHECKPOINT_SCHEMA);
  assert.equal(body.tools, undefined); assert.equal(body.instructions, undefined, 'no OpenAI-shaped fields');
  const view = service.view('alpha', 'one');
  assert.equal(view.current.model, 'claude-sonnet-5');
  assert.equal(view.jobs[0].usage.estimatedCostUsd, 0.0123); assert.equal(view.jobs[0].usage.costSource, 'provider-estimate');
  assert.equal(state.logs[0][3], 'claude-sonnet-5');
});

test('Claude connection: Haiku sends no effort, and a missing provider estimate falls back to planning rates', async t => {
  const { service, state } = fixture(t, { claude: true, settings: { connection: 'claude-sdk', model: 'claude-haiku-4-5', reasoningEffort: 'none' } });
  await service.run('alpha', 'one');
  assert.equal(state.calls[0].effort, null);
  const haiku = MEMORY_MODELS.find(m => m.id === 'claude-haiku-4-5');
  const expected = (1000 * haiku.input * haiku.cacheWrite + 300 * haiku.output) / 1e6;
  const job = service.view('alpha', 'one').jobs[0];
  assert.ok(Math.abs(job.usage.estimatedCostUsd - expected) < 1e-12); assert.equal(job.usage.costSource, 'planning-rates');
});

test('requestClaudeSdk normalizes the SDK result stream: success, refusal, structured output, usage, and cost', async () => {
  const calls = [];
  const stream = msgs => { calls.push(msgs); return { [Symbol.asyncIterator]: async function* () { for (const m of msgs) yield m; }, interrupt: async () => {} }; };
  const body = { connection: 'claude-sdk', model: 'claude-sonnet-5', effort: 'low', maxOutputTokens: 4000, maxBudgetUsd: 0.10, systemPrompt: 'sys', prompt: '{}', schema: CHECKPOINT_SCHEMA };
  let seen = null;
  const ok = await requestClaudeSdk(body, { cwd: '/tmp', run: (args) => { seen = args; return stream([
    { type: 'assistant' },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'ignored', structured_output: checkpoint(),
      usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 300 }, total_cost_usd: 0.02 },
  ]); } });
  assert.equal(seen.options.maxTurns, 1); assert.equal(seen.options.permissionMode, 'dontAsk'); assert.equal(seen.options.effort, 'low');
  assert.equal(seen.options.maxBudgetUsd, 0.10); assert.equal(seen.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4000');
  assert.deepEqual(seen.options.tools, []); assert.deepEqual(seen.options.mcpServers, {}); assert.equal(seen.options.strictMcpConfig, true);
  assert.deepEqual(seen.options.settingSources, []); assert.equal(seen.options.persistSession, false);
  assert.equal(seen.options.outputFormat.type, 'json_schema'); assert.ok(seen.options.disallowedTools.includes('Bash'));
  assert.equal(ok.status, 'completed'); assert.equal(ok.costUsd, 0.02);
  assert.equal(ok.usage.input_tokens, 1050); assert.equal(ok.usage.input_tokens_details.cached_tokens, 900); assert.equal(ok.usage.output_tokens, 300);
  assert.deepEqual(JSON.parse(ok.output[0].content[0].text), checkpoint());
  const noEffort = await requestClaudeSdk({ ...body, effort: null }, { cwd: '/tmp', run: (args) => { seen = args; return stream([{ type: 'result', subtype: 'success', is_error: false, result: '{}', usage: {} }]); } });
  assert.equal('effort' in seen.options, false); assert.equal(noEffort.output[0].content[0].text, '{}');
  const refused = await requestClaudeSdk(body, { cwd: '/tmp', run: () => stream([{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'refusal', result: '', usage: {} }]) });
  assert.equal(refused.output[0].content[0].type, 'refusal');
  const failed = await requestClaudeSdk(body, { cwd: '/tmp', run: () => stream([{ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} }]) });
  assert.equal(failed.status, 'incomplete');
  await assert.rejects(requestClaudeSdk(body, { cwd: '/tmp', run: () => stream([{ type: 'assistant' }]) }), /no result/);
});

test('requestMemory routes by connection and stays blocked in test environments', async () => {
  const prior = process.env.CP_NO_BILLED;
  process.env.CP_NO_BILLED = '1';
  try {
    await assert.rejects(requestMemory({}, 'claude-sdk'), /disabled/);
    await assert.rejects(requestMemory({}, 'openai-api'), /disabled/);
  } finally { if (prior === undefined) delete process.env.CP_NO_BILLED; else process.env.CP_NO_BILLED = prior; }
  // an unknown connection is refused before any transport is touched
  process.env.CP_NO_BILLED = '0';
  try { await assert.rejects(requestMemory({}, 'nowhere'), /Unknown memory connection/); }
  finally { if (prior === undefined) delete process.env.CP_NO_BILLED; else process.env.CP_NO_BILLED = prior; }
});

test('memory transport failures retain reported usage once, with stable job identity and no leaked exception', async t => {
  const { state, service } = fixture(t, { request: async () => {
    throw Object.assign(new Error('private credential string'), { accountingResponse: {
      usage: { input_tokens: 40, output_tokens: 5 }, usageCompleteness: 'partial',
    } });
  } });
  await service.run('alpha', 'one');
  const job = service.view('alpha', 'one').jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.usage.inputTokens, 40);
  assert.equal(job.usage.completeness, 'partial');
  assert.equal(job.usage.usageId, `memory:${job.id}`);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0][2].usageId, job.usage.usageId);
  assert.doesNotMatch(JSON.stringify(job), /private credential/);
});

test('missing memory telemetry produces an explicit unknown record, not a zero-charge success', async t => {
  const { state, service } = fixture(t, { request: async () => { throw new Error('no result'); } });
  await service.run('alpha', 'one');
  const view = service.view('alpha', 'one');
  assert.equal(view.jobs[0].usage.completeness, 'unknown');
  assert.equal(view.jobs[0].usage.inputTokens, null);
  assert.equal(view.jobs[0].usage.outputTokens, null);
  assert.equal(view.jobs[0].usage.estimatedCostUsd, null);
  assert.equal(view.totals.incompleteJobs, 1);
  assert.equal(state.logs.length, 1);
});

test('preflight failure before dispatch is known not-started, with no unknown expenditure row', async t => {
  const { state, service } = fixture(t, { request: async () => {
    throw Object.assign(new Error('No account'), { dispatched: false });
  } });
  await service.run('alpha', 'one');
  const view = service.view('alpha', 'one');
  assert.equal(view.jobs[0].notDispatched, true);
  assert.equal(view.jobs[0].usage.inputTokens, 0);
  assert.equal(view.jobs[0].usage.completeness, 'complete');
  assert.equal(view.totals.incompleteJobs, 0);
  assert.equal(state.logs.length, 0);
});

test('memory observations are durable mid-job, then late callbacks cannot resurrect deleted memory', async t => {
  let late, release, seen;
  const started = new Promise(resolve => { seen = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const { state, service } = fixture(t, { request: async (_body, _state, { onUsage }) => {
    late = onUsage;
    onUsage({ usage: { input_tokens: 20, output_tokens: 2 }, usageCompleteness: 'partial' });
    seen();
    await hold;
    return response(checkpoint());
  } });
  const pending = service.run('alpha', 'one');
  await started;
  assert.equal(service.view('alpha', 'one').jobs[0].usage.inputTokens, 20);
  assert.equal(state.logs.length, 1);
  const usageId = state.logs[0][2].usageId;
  release(); await pending;
  assert.equal(state.logs.at(-1)[2].usageId, usageId);
  service.forget('alpha', 'one');
  const before = state.logs.length;
  late({ usage: { input_tokens: 9999, output_tokens: 999 }, usageCompleteness: 'complete' });
  assert.equal(state.logs.length, before);
  assert.equal(service.view('alpha', 'one').jobs.length, 0);
});

test('a timed-out SDK iterator released after memory deletion cannot resurrect its retired job', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const { state, service } = fixture(t, { request: (body, _state, { onUsage }) => requestClaudeSdk(body, {
    timeoutMs: 5, onUsage, run: () => ({ close: () => {}, [Symbol.asyncIterator]: async function* () {
      yield { type: 'assistant', message: { id: 'early', model: body.model, usage: { input_tokens: 20, output_tokens: 2 } } };
      await hold;
      yield { type: 'result', subtype: 'success', result: JSON.stringify(checkpoint()),
        usage: { input_tokens: 9999, output_tokens: 500 } };
    } }),
  }) });
  await service.run('alpha', 'one');
  const before = service.view('alpha', 'one');
  assert.equal(before.jobs[0].status, 'failed');
  assert.equal(before.jobs[0].usage.inputTokens, 20);
  service.forget('alpha', 'one');
  const logCount = state.logs.length;
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.logs.length, logCount);
  assert.equal(service.view('alpha', 'one').jobs.length, 0);
});

test('Claude memory retains whole-query model usage if the iterator fails after its terminal result', async () => {
  const run = () => ({ [Symbol.asyncIterator]: async function* () {
    yield { type: 'result', subtype: 'success', result: '{}', total_cost_usd: 0.12,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 700, cacheCreationInputTokens: 20, costUSD: 0.12 } } };
    throw new Error('private provider detail');
  } });
  await assert.rejects(requestClaudeSdk({ model: 'claude-sonnet-5' }, { run }), err => {
    assert.equal(err.accountingResponse.usage.input_tokens, 820);
    assert.equal(err.accountingResponse.usage.output_tokens, 30);
    assert.equal(err.accountingResponse.usageCompleteness, 'complete');
    assert.equal(err.accountingResponse.costUsd, 0.12);
    assert.doesNotMatch(err.message, /private provider/);
    return true;
  });
});
