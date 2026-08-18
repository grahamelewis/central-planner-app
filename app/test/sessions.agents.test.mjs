// test/sessions.agents.test.mjs — the subagent ("agent teams") tracker that
// turns the SDK's Task tool_use blocks + task_started/task_progress/
// task_updated/task_notification lifecycle messages into ◆ console lines and
// a live roster.
// The functions are NOT exported (importing sessions.js pulls the Agent SDK),
// so we extract their REAL source and run them in isolation. No billing risk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const SESSIONS = path.join(APP_DIR, 'lib', 'sessions.js');
const {
  oneLine,
  agentLaunchLine, agentDoneLine, createAgentTracker,
} = loadPrivateFns(SESSIONS, [
  'oneLine',
  'agentLaunchLine', 'agentDoneLine', 'createAgentTracker',
]);

/** tracker + captured console lines + roster snapshots, with a fake clock */
function harness(startMs = 1000000) {
  let clock = startMs;
  const lines = [];
  const rosters = [];
  const tracker = createAgentTracker(
    (chunk) => lines.push(chunk),
    (agents) => rosters.push(agents),
    () => clock,
  );
  return { tracker, lines, rosters, tick: (ms) => { clock += ms; } };
}

describe('line formatters', () => {
  test('launch line: numbered, typed, one-line description', () => {
    const l = agentLaunchLine({ n: 1, type: 'Explore', desc: 'Find the config loader' });
    assert.equal(l, '\n◆ agent #1 ▶ Explore — Find the config loader\n');
  });

  test('done line: ✓ with report, ✗ with error', () => {
    assert.equal(agentDoneLine({ n: 1, type: 'Explore' }, true, 'found it in lib/config.js'),
      '◆ agent #1 ✓ done · Explore — found it in lib/config.js\n');
    assert.equal(agentDoneLine({ n: 3, type: 'Plan' }, false, 'timed out'),
      '◆ agent #3 ✗ failed · Plan — timed out\n');
  });

  test('oneLine', () => {
    assert.equal(oneLine('  a\n  b\tc  ', 100), 'a b c');
    assert.equal(oneLine('x'.repeat(300), 10).length, 10);
  });
});

describe('createAgentTracker', () => {
  test('a Task tool_use block announces the agent and numbers it', () => {
    const { tracker, lines, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /◆ agent #1 ▶ Explore — Find X/);
    assert.deepEqual(rosters.at(-1).map(a => [a.n, a.type, a.status]), [[1, 'Explore', 'running']]);
  });

  test('task_started for an already-spawned tool_use links ids without a second launch line', () => {
    const { tracker, lines } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    tracker.taskStarted({ task_id: 't-1', tool_use_id: 'tu-1', subagent_type: 'Explore', description: 'Find X' });
    assert.equal(lines.length, 1, 'no duplicate launch line');
    // …but progress addressed by task_id now reaches the same agent (roster
    // only — progress emits NO stream line since the fleet-cards redesign)
    tracker.taskProgress({ task_id: 't-1', usage: { tool_uses: 3, total_tokens: 900, duration_ms: 4000 }, summary: 'Grepping configs' });
    assert.equal(lines.length, 1, 'progress adds no stream line');
  });

  test('standalone task_started registers agent-shaped tasks only', () => {
    const { tracker, lines } = harness();
    tracker.taskStarted({ task_id: 't-1', subagent_type: 'code-reviewer', description: 'Review the diff' });
    assert.match(lines.at(-1), /◆ agent #1 ▶ code-reviewer — Review the diff/);
    // a backgrounded shell command is NOT an agent
    tracker.taskStarted({ task_id: 't-2', task_type: 'shell', description: 'npm test' });
    // housekeeping tasks are hidden entirely
    tracker.taskStarted({ task_id: 't-3', subagent_type: 'Explore', skip_transcript: true, description: 'ambient' });
    assert.equal(lines.length, 1, 'shell + skip_transcript tasks add no lines');
    // workflows count as agents, labeled by workflow name
    tracker.taskStarted({ task_id: 't-4', task_type: 'local_workflow', workflow_name: 'review', description: 'Review changes' });
    assert.match(lines.at(-1), /◆ agent #2 ▶ workflow:review — Review changes/);
  });

  test('progress is roster-only (no stream spam), and the roster carries live ms', () => {
    const { tracker, lines, rosters, tick } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    tracker.taskStarted({ task_id: 't-1', tool_use_id: 'tu-1', subagent_type: 'Explore' });
    const afterSpawn = lines.length;
    tick(5000);
    tracker.taskProgress({ task_id: 't-1', usage: { tool_uses: 1, total_tokens: 100 }, summary: 'first' });
    tick(5000);
    tracker.taskProgress({ task_id: 't-1', usage: { tool_uses: 2, total_tokens: 200 }, summary: 'second' });
    assert.equal(lines.length, afterSpawn, 'NO progress lines reach the stream, ever');
    assert.equal(rosters.at(-1)[0].tools, 2, 'the roster still carries the newest usage');
    assert.equal(rosters.at(-1)[0].summary, 'second');
    assert.equal(rosters.at(-1)[0].ms, 10000, 'running agents report live elapsed ms');
    // completion freezes the clock
    tracker.result({ tool_use_id: 'tu-1' }, 'done');
    tick(60000);
    tracker.taskProgress({ task_id: 't-9', usage: {} }); // unrelated → repush not required; read last roster
    assert.equal(rosters.at(-1)[0].ms, 10000, 'a settled agent\'s ms is frozen at completion');
  });

  test('the Task tool_result becomes the agent-styled done line', () => {
    const { tracker, lines, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    const handled = tracker.result({ tool_use_id: 'tu-1' }, 'Found it: lib/config.js:12');
    assert.equal(handled, true);
    assert.match(lines.at(-1), /◆ agent #1 ✓ done · Explore — Found it: lib\/config\.js:12/);
    assert.equal(rosters.at(-1)[0].status, 'done');
    // a result for an unknown tool_use is not ours
    assert.equal(tracker.result({ tool_use_id: 'tu-nope' }, 'whatever'), false);
  });

  test('the CLI 2.1.x launch ack stays running; task_updated later completes it', () => {
    // the REAL 2.1.218 ack — "working", not "running", in the background.
    // This exact wording used to fall through to the done branch and stamp ✓
    // on an agent that had just started (the premature-checkmark bug).
    const ACK = 'Async agent launched successfully. (This tool result is internal metadata — '
      + 'never quote or paste any part of it into a user-facing reply.) '
      + 'agentId: a565f606b4a93ac97 (internal ID - do not mention to user.) '
      + 'The agent is working in the background. You will be notified automatically when it completes.';
    const { tracker, lines, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    tracker.taskStarted({ task_id: 't-1', tool_use_id: 'tu-1', subagent_type: 'Explore' });
    tracker.result({ tool_use_id: 'tu-1' }, ACK);
    assert.match(lines.at(-1), /◆ agent #1 ⇢ backgrounded · Explore/);
    assert.equal(rosters.at(-1)[0].status, 'running', 'a launch ack must NOT read as completion');
    tracker.taskUpdated({ task_id: 't-1', patch: { status: 'completed' } });
    assert.match(lines.at(-1), /◆ agent #1 ✓ done · Explore/);
    assert.equal(rosters.at(-1)[0].status, 'done');
  });

  test('legacy ack phrasing ("running in the background") still backgrounds', () => {
    const { tracker, lines, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore' } });
    tracker.result({ tool_use_id: 'tu-1' }, 'Async task tu-1 running in the background');
    assert.match(lines.at(-1), /⇢ backgrounded/);
    assert.equal(rosters.at(-1)[0].status, 'running');
  });

  test('task_notification is the authoritative completion: final summary + whole-run usage', () => {
    const { tracker, lines, rosters, tick } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    tracker.taskStarted({ task_id: 't-1', tool_use_id: 'tu-1', subagent_type: 'Explore' });
    tracker.result({ tool_use_id: 'tu-1' },
      'Async agent launched successfully. The agent is working in the background.');
    tracker.taskProgress({ task_id: 't-1', usage: { tool_uses: 12, total_tokens: 40000 }, last_tool_name: 'Read' });
    tick(90000);
    tracker.taskNotification({
      task_id: 't-1', status: 'completed', summary: 'Found it in lib/config.js',
      usage: { tool_uses: 19, total_tokens: 61000, duration_ms: 90000 },
    });
    assert.match(lines.at(-1), /◆ agent #1 ✓ done · Explore — Found it in lib\/config\.js/);
    const a = rosters.at(-1)[0];
    assert.equal(a.status, 'done');
    assert.equal(a.tools, 19, 'final usage supersedes the last progress frame');
    assert.equal(a.tokens, 61000);
    assert.equal(a.ms, 90000, 'clock frozen at the notification');
    // a later task_updated must not double-report
    const n = lines.length;
    tracker.taskUpdated({ task_id: 't-1', patch: { status: 'completed' } });
    assert.equal(lines.length, n, 'already reported — no duplicate line');
  });

  test('a stopped/failed notification flags ✗', () => {
    const { tracker, lines, rosters } = harness();
    tracker.taskStarted({ task_id: 't-1', subagent_type: 'Plan', description: 'Plan it' });
    tracker.taskNotification({ task_id: 't-1', status: 'stopped' });
    assert.match(lines.at(-1), /◆ agent #1 ✗ failed · Plan — stopped/);
    assert.equal(rosters.at(-1)[0].status, 'failed');
  });

  test('a straggler task_progress cannot overwrite a settled card', () => {
    const { tracker, rosters } = harness();
    tracker.taskStarted({ task_id: 't-1', subagent_type: 'Explore', description: 'Find X' });
    tracker.taskNotification({ task_id: 't-1', status: 'completed', summary: 'the verdict' });
    tracker.taskProgress({ task_id: 't-1', usage: { tool_uses: 99, total_tokens: 999999 }, last_tool_name: 'Read' });
    const a = rosters.at(-1)[0];
    assert.equal(a.summary, 'the verdict', 'no "running Read" on a ✓ card');
    assert.equal(a.tools, 0, 'stale usage discarded');
    assert.equal(a.status, 'done');
  });

  test('task_updated failure surfaces the error; completion never double-reports', () => {
    const { tracker, lines } = harness();
    tracker.taskStarted({ task_id: 't-1', subagent_type: 'Plan', description: 'Plan it' });
    tracker.taskUpdated({ task_id: 't-1', patch: { status: 'failed', error: 'model overloaded' } });
    assert.match(lines.at(-1), /◆ agent #1 ✗ failed · Plan — model overloaded/);
    const n = lines.length;
    tracker.taskUpdated({ task_id: 't-1', patch: { status: 'failed', error: 'again' } });
    assert.equal(lines.length, n, 'already reported — no duplicate line');
  });

  test('mark() numbers a subagent\'s inner tool lines', () => {
    const { tracker } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore' } });
    tracker.spawn({ id: 'tu-2', name: 'Task', input: { subagent_type: 'Plan' } });
    assert.equal(tracker.mark('tu-2'), '↳2 ');
    assert.equal(tracker.mark('unknown'), '↳ ');
  });

  test('clear() empties the roster (turn end)', () => {
    const { tracker, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore' } });
    tracker.clear();
    assert.deepEqual(rosters.at(-1), []);
  });

  test('clear() flags agents orphaned by the turn\'s death — and returns the note', () => {
    const { tracker, lines, rosters } = harness();
    tracker.spawn({ id: 'tu-1', name: 'Task', input: { subagent_type: 'Explore', description: 'Find X' } });
    tracker.taskStarted({ task_id: 't-1', tool_use_id: 'tu-1', subagent_type: 'Explore' });
    tracker.spawn({ id: 'tu-2', name: 'Task', input: { subagent_type: 'Plan' } });
    tracker.result({ tool_use_id: 'tu-2' }, 'finished the plan'); // settled — no warning
    const note = tracker.clear();
    assert.match(note, /◆ agent #1 ⚠ lost · Explore — still running when the turn ended/);
    assert.ok(!note.includes('#2'), 'settled agents are not flagged');
    assert.equal(lines.at(-1), note, 'the warning also streamed to the console');
    assert.deepEqual(rosters.at(-1), [], 'roster still clears');
  });

  test('clear() with no survivors warns nothing', () => {
    const { tracker } = harness();
    tracker.taskStarted({ task_id: 't-1', subagent_type: 'Explore', description: 'x' });
    tracker.taskNotification({ task_id: 't-1', status: 'completed', summary: 'done' });
    assert.equal(tracker.clear(), '');
  });
});

describe('foreground enforcement (forceForegroundAgents PreToolUse hook)', () => {
  const { forceForegroundAgents } = loadPrivateFns(SESSIONS, ['forceForegroundAgents'],
    { AGENT_SPAWN_TOOLS: new Set(['Task', 'Agent']) });
  const hook = (tool, ti) => forceForegroundAgents({
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: ti,
  });

  test('a default (background) spawn is rewritten to run synchronously', async () => {
    const out = await hook('Task', { subagent_type: 'Explore', prompt: 'x' });
    assert.deepEqual(out.hookSpecificOutput.updatedInput,
      { subagent_type: 'Explore', prompt: 'x', run_in_background: false });
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  });

  test('an explicit run_in_background:true is overridden too', async () => {
    const out = await hook('Agent', { prompt: 'x', run_in_background: true });
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
  });

  test('already-synchronous and remote-isolation spawns pass untouched', async () => {
    assert.deepEqual(await hook('Task', { prompt: 'x', run_in_background: false }), {});
    assert.deepEqual(await hook('Task', { prompt: 'x', isolation: 'remote' }), {});
  });

  test('non-agent tools and malformed input never derail the call', async () => {
    assert.deepEqual(await hook('Bash', { command: 'ls' }), {});
    assert.deepEqual(await forceForegroundAgents(null), {});
    const garbled = await hook('Task', 'not-an-object');
    assert.deepEqual(garbled.hookSpecificOutput.updatedInput, { run_in_background: false });
  });
});

describe('runTurn wiring (source-level)', () => {
  const src = fs.readFileSync(SESSIONS, 'utf8');

  test('agentProgressSummaries is enabled on query() options', () => {
    assert.match(src, /agentProgressSummaries:\s*true/,
      'periodic per-agent summaries feed the task_progress console lines');
  });

  test('Task/Agent spawn tools are recognized', () => {
    assert.match(src, /AGENT_SPAWN_TOOLS = new Set\(\[\s*'Task',\s*'Agent'\s*\]\)/);
  });

  test('the task lifecycle subtypes are routed to the tracker', () => {
    for (const st of ['task_started', 'task_progress', 'task_updated', 'task_notification']) {
      assert.match(src, new RegExp(`msg\\.subtype === '${st}'`), `${st} handled`);
    }
  });

  test('every Task/Agent spawn is forced foreground via a PreToolUse hook', () => {
    assert.match(src,
      /hooks:\s*\{\s*PreToolUse:\s*\[\{\s*matcher:\s*'Task\|Agent',\s*hooks:\s*\[forceForegroundAgents\]/,
      'the hook is wired into query() options');
  });

  test('the model is told agents run synchronously — every turn AND the turn-1 packet', () => {
    assert.match(src, /return withProject \+ AGENT_TEAM_APPENDIX/,
      'the appendix rides the system prompt each turn (existing sessions pick it up)');
    assert.match(src, /agent teams run synchronously here \(run_in_background is/,
      'the turn-1 protocol footer covers subagents');
  });

  test('lost agents surface in the stored transcript, not just the live stream', () => {
    assert.match(src, /pending\.text = finalText \+ orphanNote/,
      'the ⚠ note survives the finalText replacement');
  });
});
