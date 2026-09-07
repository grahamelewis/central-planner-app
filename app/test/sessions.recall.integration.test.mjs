// Exercise the real session orchestration/persistence functions with provider
// IO replaced. No SDK query, subprocess, network, or real user data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, mkTmp, rmTmp } from './helpers.mjs';
import { createTurnRecall, publicTurn } from '../lib/turnRecall.js';
import { createMemoryService } from '../lib/taskMemory.js';
import { MEMORY_DEFAULTS } from '../lib/memorySettings.js';

const sourcePath = path.join(APP_DIR, 'lib/sessions.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const names = ['providerSessionsWith', 'transcriptFile', 'loadTranscript', 'persistTranscript',
  'transcriptFor', 'ensureStateOwner', 'settleAppTurn', 'reserveAppTurn', 'startTurn',
  'sendMessage', 'recallTurn', 'interrupt', 'hasActiveTurn', 'getTranscript', 'getTurnState'];
// These module-level functions close at column zero. Unlike the older helper's
// first-brace scan, this also handles default object arguments and async bodies.
const bodies = names.map(name => {
  const match = new RegExp(`^(?:export )?((?:async )?function ${name}\\()`, 'm').exec(source);
  assert.ok(match, `actual function ${name} exists`);
  const end = source.indexOf('\n}', match.index);
  assert.ok(end > match.index, `actual function ${name} has a closing boundary`);
  return source.slice(match.index, end + 2).replace(/^export /, '');
}).join('\n');

function fixture(t) {
  const root = mkTmp('cp-recall-integration-');
  t.after(() => rmTmp(root));
  const task = { id: 'task-1', created: '2026-09-06T00:00:00Z', provider: 'codex', oversight: 'coop',
    status: 'waiting', session: { provider: 'codex', threadId: 'original-thread', tokensIn: 20 },
    question: 'Original question', handoff: { summary: 'Original handoff' } };
  const memory = [], events = [], dispatched = [], forks = [];
  let rejectCommit = false;
  function boot() {
    const turnLifecycle = createTurnRecall();
    const activeTurns = new Map(), transcripts = new Map(), recallAudits = new Map();
    const registry = new Map(), stateOwner = new Map(), failedTurns = new Set();
    let fns;
    const globals = {
      fs, path, ROOT: root, TRANSCRIPTS_DIR: path.join(root, 'transcripts'),
      PROJECTS: { alpha: { root } }, DEFAULT_PROVIDER: 'claude',
      keyOf: (project, id) => `${project}/${id}`,
      providerOf: task => task.provider,
      requireTask: () => task, getTask: () => task,
      updateTask: (_project, _id, patch) => Object.assign(task, patch),
      permissionModeFor: () => 'default',
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      logErr: () => {},
      queueTaskMemory: (...args) => memory.push(args),
      broadcast: (type, payload) => events.push({ type, payload }),
      broadcastEvent: (type, payload) => events.push({ type, payload }),
      writeFileAtomic: (file, text) => {
        if (rejectCommit && JSON.parse(text).recalls.some(r => r.phase === 'recalled')) {
          throw new Error('injected durable commit failure');
        }
        fs.writeFileSync(file, text);
      },
      getCodexClient: () => ({}), forkSession: () => {}, getSessionMessages: () => {}, importSessionToStore: () => {},
      restoreTurnHistory: async turn => {
        const result = { provider: 'codex', threadId: `restored-${turn.turnId}`, restoredFrom: 'original-thread' };
        forks.push(result);
        return result;
      },
      runTurn: async (project, id, text) => {
        const key = `${project}/${id}`, turn = turnLifecycle.get(key);
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        dispatched.push({ text, threadId: task.session.threadId, finish });
        registry.set(key, { project, id, provider: 'codex', status: 'running' });
        const entries = fns.transcriptFor(key);
        entries.push({ role: 'user', text, ts: 'new-user', ...publicTurn(turn) },
          { role: 'assistant', text: 'Withdraw this output only', ts: 'new-answer', ...publicTurn(turn) });
        fns.persistTranscript(key, task, true);
        turn.providerState.dispatched = true;
        await turnLifecycle.attach(key, { interrupt: async () => finish() }, turn);
        await done;
        task.session = { ...task.session, tokensIn: task.session.tokensIn + 7 };
        task.status = 'waiting';
        fns.persistTranscript(key, task, true);
      },
      turnLifecycle, activeTurns, transcripts, recallAudits, registry, stateOwner, failedTurns,
      interruptedDuringPrep: new Set(), publicTurn,
    };
    fns = new Function(...Object.keys(globals), `${bodies}\nreturn {${names.join(',')}};`)(...Object.values(globals));
    return { fns, turnLifecycle };
  }
  const first = boot();
  first.fns.transcriptFor('alpha/task-1').push(
    { role: 'user', text: 'Keep this earlier prompt', ts: 'old-user' },
    { role: 'assistant', text: 'Keep this earlier answer', ts: 'old-answer' });
  first.fns.persistTranscript('alpha/task-1', task, true);
  return { ...first, root, task, memory, events, dispatched, forks, boot,
    failCommit: value => { rejectCommit = value; },
    disk: () => JSON.parse(fs.readFileSync(path.join(root, 'transcripts/alpha/task-1.json'), 'utf8')) };
}

test('recall persists an audit, restores the provider pointer, and excludes only the withdrawn exchange', async t => {
  const x = fixture(t);
  const prompt = '  Exact prompt\nwith trailing whitespace  \n';
  const turn = x.fns.sendMessage('alpha', 'task-1', prompt, { requestId: 'request-first' });
  assert.equal(x.fns.hasActiveTurn('alpha', 'task-1'), true);
  const result = await x.fns.recallTurn('alpha', 'task-1', turn);
  assert.equal(result.status, 'recalled');
  assert.equal(result.prompt, prompt);
  assert.deepEqual(result.transcript.map(e => e.text), ['Keep this earlier prompt', 'Keep this earlier answer']);
  assert.equal(x.task.session.threadId, x.forks[0].threadId);
  assert.equal(x.task.session.tokensIn, 27, 'usage incurred by withdrawn work remains counted');
  assert.equal(x.task.question, 'Original question');
  assert.equal(x.fns.hasActiveTurn('alpha', 'task-1'), false);
  assert.equal(x.memory.length, 0, 'recall must not enqueue consolidation');
  const disk = x.disk();
  assert.equal(disk.entries.length, 4, 'full original exchange remains in the private audit');
  assert.equal(disk.entries[2].text, prompt);
  assert.ok(disk.entries[2].recalledAt && disk.entries[3].recalledAt);
  assert.equal(disk.recalls[0].effectsNotReverted, true);
  assert.equal(x.events.at(-1).type, 'session:recalled');
  assert.deepEqual(x.boot().fns.getTranscript('alpha', 'task-1'), result.transcript,
    'reload cannot resurrect the withdrawn exchange');
});

test('duplicate recall and send retries cannot interrupt or overwrite a replacement turn', async t => {
  const x = fixture(t);
  const first = x.fns.sendMessage('alpha', 'task-1', 'First', { requestId: 'request-first' });
  await x.fns.recallTurn('alpha', 'task-1', first);
  const second = x.fns.sendMessage('alpha', 'task-1', 'Corrected', { requestId: 'request-second' });
  assert.equal(x.dispatched[1].threadId, x.forks[0].threadId, 'replacement uses the restored provider branch');
  await x.fns.recallTurn('alpha', 'task-1', first);
  const retriedSend = x.fns.sendMessage('alpha', 'task-1', 'First', { requestId: 'request-first' });
  assert.equal(retriedSend.phase, 'recalled');
  assert.equal(x.dispatched.length, 2, 'HTTP retry does not dispatch another generation');
  assert.equal(x.forks.length, 1, 'duplicate recall does not fork the replacement');
  assert.equal(x.fns.getTurnState('alpha', 'task-1').activeTurn.turnId, second.turnId);
  await assert.rejects(x.fns.interrupt('alpha', 'task-1', first), /no longer active/);
  await x.fns.interrupt('alpha', 'task-1', second);
});

test('the memory service reads retained history, never the recalled prompt or output', async t => {
  const x = fixture(t);
  const turn = x.fns.sendMessage('alpha', 'task-1', 'Withdraw this private correction', { requestId: 'request-memory' });
  await x.fns.recallTurn('alpha', 'task-1', turn);
  const calls = [];
  const service = createMemoryService({ root: x.root,
    settings: { get: () => ({ ...MEMORY_DEFAULTS, enabled: true }), publicSettings: () => ({ enabled: true }) },
    getTask: () => x.task, getTranscript: x.fns.getTranscript, isActive: x.fns.hasActiveTurn,
    request: async body => {
      calls.push(body);
      return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ findings: ['Earlier conversation retained.'], constraints: [],
          uncertainties: [], nextSteps: [], evidence: [{ claim: 'Earlier conversation retained.', source: 'event-1' }] }) }] }] };
    }, logUsage: () => {},
  });
  t.after(() => service.close());
  await service.run('alpha', 'task-1');
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].input);
  assert.deepEqual(payload.fragments.map(f => f.text), ['Keep this earlier prompt', 'Keep this earlier answer']);
  assert.doesNotMatch(calls[0].input, /Withdraw this/);
  assert.equal(service.view('alpha', 'task-1').current.revision, 1);
  assert.match(JSON.stringify(x.disk()), /Withdraw this private correction/, 'audit remains separate from memory input');
});

test('failed local commit is locked and recoverable after restart without a second provider fork', async t => {
  const x = fixture(t);
  const turn = x.fns.sendMessage('alpha', 'task-1', 'Recover me', { requestId: 'request-recovery' });
  x.failCommit(true);
  await assert.rejects(x.fns.recallTurn('alpha', 'task-1', turn), /injected durable commit failure/);
  assert.equal(x.fns.hasActiveTurn('alpha', 'task-1'), true);
  assert.equal(x.fns.getTranscript('alpha', 'task-1').length, 4, 'failed commit never hides evidence');
  assert.equal(x.disk().recalls[0].phase, 'recall-recovery');
  assert.throws(() => x.fns.sendMessage('alpha', 'task-1', 'Unsafe replacement', { requestId: 'request-blocked' }), /running|recalled/);
  const restarted = x.boot();
  assert.equal(restarted.fns.hasActiveTurn('alpha', 'task-1'), true, 'durable receipt restores the send lock');
  assert.equal(restarted.fns.getTurnState('alpha', 'task-1').activeTurn.phase, 'recall-recovery');
  x.failCommit(false);
  const recovered = await restarted.fns.recallTurn('alpha', 'task-1', turn);
  assert.equal(recovered.status, 'recalled');
  assert.equal(x.forks.length, 1, 'recovery commits the existing branch receipt');
  assert.equal(restarted.fns.hasActiveTurn('alpha', 'task-1'), false);
  assert.equal(recovered.transcript.length, 2);
});
