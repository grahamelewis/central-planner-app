// Ownership regressions are deterministic; no provider/real process is run.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-job-ownership-'));
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({ alpha: { root }, beta: { root } });
process.env.CP_NTFY_TOPIC = '';
const { sessionJobStart, sessionJobEnd, sessionJobProgress, sessionJobOutput,
  endSessionJobsFor, getJobs, getJobHistory, runJobStart, runJobStep, _test } = await import('../lib/jobs.js');
_test.setPolling(false);
let now = Date.parse('2026-09-09T12:00:00Z');
_test.setClock(() => now);
const owner = (appTurnId = 'turn-a', taskCreated = 'created-a', project = 'alpha', taskId = 'task') =>
  ({ project, taskId, appTurnId, taskCreated });
const start = (tool, own = owner(), command = 'julia program.jl', extra = {}) =>
  sessionJobStart(own.project, own.taskId, tool, command, { ...own, ...extra });
beforeEach(() => { _test.jobs.clear(); now += 60000; });
after(() => { _test.setPolling(false); _test.setClock(null); fs.rmSync(root, { recursive: true, force: true }); });

test('immutable invocation and turn identity survive execution clock correction', () => {
  const job = start('retime');
  job.visible = true;
  const initial = getJobs()[0];
  assert.ok(initial.jobRunId);
  assert.equal(initial.appTurnId, 'turn-a');
  assert.equal(initial.taskCreated, 'created-a');
  now += 20000;
  sessionJobProgress('retime', 2, owner());
  const corrected = getJobs()[0];
  assert.notEqual(corrected.startedAt, initial.startedAt);
  assert.equal(corrected.createdAt, initial.createdAt);
  assert.equal(corrected.jobRunId, initial.jobRunId);
  assert.equal(corrected.appTurnId, initial.appTurnId);
});

test('same tool ID in separate turns/tasks/projects gets distinct invocation ownership', () => {
  const jobs = [start('shared', owner()), start('shared', owner('turn-b')),
    start('shared', owner('turn-a', 'created-b')), start('shared', owner('turn-a', 'created-a', 'beta'))];
  assert.equal(new Set(jobs.map(job => job.key)).size, 4);
  assert.equal(new Set(jobs.map(job => job.jobRunId)).size, 4);
  sessionJobEnd('shared', { ...owner('turn-b'), error: true });
  assert.equal(jobs[1].state, 'error');
  assert.ok([jobs[0], jobs[2], jobs[3]].every(job => job.state === 'running'));
});

test('ambiguous unscoped callbacks do nothing; scoped progress and output touch only their job', () => {
  const a = start('ambiguous', owner());
  const b = start('ambiguous', owner('turn-b'));
  now += 20000;
  sessionJobProgress('ambiguous', 1);
  assert.equal(a.t0, b.t0);
  sessionJobEnd('ambiguous');
  assert.equal(a.state, 'running'); assert.equal(b.state, 'running');
  sessionJobProgress('ambiguous', 1, owner('turn-b'));
  assert.notEqual(a.t0, b.t0);
  sessionJobOutput('ambiguous', '50% complete\n', owner('turn-b'));
  assert.equal(a.progress, undefined);
  assert.ok(b.progress);
});

test('turn cleanup does not stop a later turn or a detached job from the original turn', () => {
  const old = start('old', owner());
  const next = start('new', owner('turn-b'));
  const detached = start('detached', owner(), 'nohup julia detached.jl &');
  assert.equal(detached.detached, true);
  endSessionJobsFor('alpha', 'task', 'stopped', owner());
  assert.equal(old.state, 'stopped');
  assert.equal(next.state, 'running');
  assert.equal(detached.state, 'running');
  sessionJobEnd('detached', owner());
  assert.equal(detached.state, 'running', 'launch acknowledgment is not detached completion');
});

test('terminal persisted history retains exact owner, stable identity, title and timestamps', () => {
  const own = owner('history-turn');
  const job = start('history', own, 'julia -e "println(1)"', { label: 'Compute A/B estimates' });
  job.visible = true;
  now += 1234;
  sessionJobEnd('history', own);
  const record = getJobHistory('alpha').find(row => row.key === job.key);
  assert.equal(record.jobRunId, job.jobRunId);
  assert.equal(record.appTurnId, own.appTurnId);
  assert.equal(record.taskCreated, own.taskCreated);
  assert.equal(record.project, 'alpha');
  assert.equal(record.taskId, 'task');
  assert.equal(record.state, 'done');
  assert.equal(record.displayTitle, 'Compute A/B estimates');
  assert.equal(record.file, null);
  assert.equal(record.titleKind, 'label');
  assert.equal(record.endedAt, record.ts);
  assert.equal(record.ms, 1234);
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'jobhist.json'), 'utf8'));
  assert.equal(disk.alpha.find(row => row.key === job.key).jobRunId, job.jobRunId);
  assert.equal(Object.keys(record).some(key => key.startsWith('_')), false);
});

test('same owned tool-start replay remains idempotent after terminal registry garbage collection', async () => {
  const own = owner('replay-history');
  const job = start('replayed', own);
  assert.equal(start('replayed', own), job);
  job.visible = true;
  sessionJobEnd('replayed', own);
  now += 31000;
  await _test.tick({ now, snap: null });
  assert.equal(_test.jobs.has(job.key), false);
  assert.equal(start('replayed', own), null);
  assert.ok(start('replayed', owner('different-turn')));
});

test('inline command fallback is generic, while file and human-title semantics are explicit', () => {
  const inline = start('inline', owner(), 'julia -e "println(\"/Users/graham/private\")"');
  assert.equal(inline.file, null);
  assert.equal(inline.displayTitle, 'inline Julia');
  assert.equal(inline.titleKind, 'inline');
  assert.match(inline.command, /Users\/graham/);
  const file = start('file', owner(), 'julia folder/analysis.jl');
  assert.equal(file.file, 'folder/analysis.jl');
  assert.equal(file.displayTitle, file.file);
  assert.equal(file.titleKind, 'file');
});

test('generated launcher labels containing slashes are labels, never file paths', () => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { 'bench/solve': 'node solve.js' } }));
  const job = start('launcher', owner(), 'npm run bench/solve');
  assert.equal(job.titleKind, 'label');
  assert.equal(job.displayTitle, 'demo (npm run bench/solve)');
  assert.equal(job.file, null);
});

test('project-run invocations have stable IDs across step changes and distinct IDs on rerun', () => {
  const initial = runJobStart('alpha', 'program.jl', 1234, 'julia program.jl');
  const id = initial.jobRunId;
  runJobStep('alpha', { pid: 2345, command: 'julia next.jl' });
  assert.equal(_test.jobs.get('run:alpha').jobRunId, id);
  const next = runJobStart('alpha', 'program.jl', 3456, 'julia program.jl');
  assert.notEqual(next.jobRunId, id);
});
