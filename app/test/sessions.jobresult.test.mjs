// test/sessions.jobresult.test.mjs — the run ledger's data (v3.1): a session
// job's tool result is the ONLY output the dashboard ever sees, so
// lib/sessions.js hands it to lib/jobs.js (`sessionJobOutput` then
// `sessionJobEnd({error, exitCode})`) and the job carries exit, counters,
// output lines, runtime and `verified` on the wire. Short runs (under
// MIN_AGE, never a live card) become a lightweight `short:true` record,
// broadcast once as terminal and written to jobhist. No Claude, no process:
// the seams are driven with synthetic tool-result text per runtime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-jobresult-')));
const proj = path.join(root, 'proj');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({ alpha: { name: 'alpha', root: proj, color: '#aabbcc', texWatch: null } });
process.env.CP_NTFY_TOPIC = '';
process.env.CP_JOB_MIN_AGE_MS = '8000';

// a pre-v3.1 jobhist: no runtime/verified/short/exit/counters/output at all
const HIST = path.join(root, 'jobhist.json');
const OLD = [
  { ts: '2026-09-01T10:00:00.000Z', key: 'sess:alpha/t0/toolu_old1', file: 'old.jl', lang: 'julia', source: 'session', state: 'done', ms: 100, taskId: 't0' },
  { ts: '2026-09-02T10:00:00.000Z', key: 'sess:alpha/t0/toolu_old2', file: 'old.jl', lang: 'julia', source: 'session', state: 'done', ms: 200, taskId: 't0' },
  { ts: '2026-09-03T10:00:00.000Z', key: 'sess:alpha/t0/toolu_old3', file: 'old.jl', lang: 'julia', source: 'session', state: 'done', ms: 300, taskId: 't0', peakMem: 5, cpuTimeMs: 6 },
];
fs.writeFileSync(HIST, JSON.stringify({ alpha: OLD }));

const jobsMod = await import('../lib/jobs.js');
const {
  detectScriptRun, getJobs, getJobHistory, sessionJobStart, sessionJobOutput, sessionJobEnd, endSessionJobsFor,
  toolResultText, toolResultExitCode, _test,
} = jobsMod;
const { initWss } = await import('../lib/events.js');

// a synthetic clock; the sweep is parked (no ps, no pid — exactly the
// "never earned a live card" case unless a test pins one by hand)
const t0 = Date.parse('2026-09-09T10:00:00.000Z');
let t = t0;
_test.setPolling(false);
_test.setClock(() => t);

// one real WS client so `broadcast` has somewhere to go — the short-run
// record must reach the wire exactly once
const msgs = [];
let server = null; let ws = null;
before(async () => {
  server = http.createServer();
  initWss(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  ws.on('message', (d) => { try { msgs.push(JSON.parse(String(d))); } catch { /* ignore */ } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
});
after(async () => {
  try { ws.close(); } catch { /* gone */ }
  await new Promise((r) => server.close(r));
  _test.setClock(null);
  _test.setPolling(false);
  fs.rmSync(root, { recursive: true, force: true });
});
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const statusFor = (key) => msgs.filter((m) => m.type === 'job:status' && m.payload?.job?.key === key).map((m) => m.payload.job);

const owner = { appTurnId: 'turn-1', taskCreated: '2026-09-09T09:00:00.000Z' };
let seq = 0;
/** sessionJobStart → (elapsed) → sessionJobOutput(text) → sessionJobEnd({error, exitCode}) —
    the exact call order lib/sessions.js makes at a Claude tool_result. */
function drive(command, text, { error = false, exitCode, elapsedMs = 3000, live = false, own = owner } = {}) {
  const tool = `toolu_${++seq}`;
  const job = sessionJobStart('alpha', 'tsk-led', tool, command, own);
  assert.ok(job, `${command} is a session job`);
  if (live) { job.visible = true; job.pid = 4242; } // a card the sweep had already shown
  t += elapsedMs;
  sessionJobOutput(tool, text, { ...own, isError: error }); // the SDK's is_error rides along (the marker is only read for an error)
  const code = exitCode === undefined ? toolResultExitCode(text, error) : exitCode;
  sessionJobEnd(tool, { ...own, error, exitCode: code });
  const rec = getJobHistory('alpha').find((r) => r.key === job.key) || null;
  const live_ = _test.jobs.get(job.key);
  return { job, tool, rec, pub: live_ ? _test.publicJob(live_) : rec };
}

// ---------------------------------------------------------------------------

test('toolResultText: string content, text blocks joined by newlines, nothing → ""', () => {
  assert.equal(toolResultText({ content: 'a\nb' }), 'a\nb');
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
  assert.equal(toolResultText({ content: [] }), '');
  assert.equal(toolResultText({}), '');
  assert.equal(toolResultText(null), '');
});

test('toolResultExitCode: the SDK marker on the FIRST or LAST line, never mid-output; 0 for a non-error result; null for an error without it', () => {
  assert.equal(toolResultExitCode('Exit code 1\nboom', true), 1, 'ShellError formatter: marker first');
  assert.equal(toolResultExitCode('out\nmore\nExit code 137\n', true), 137, 'streaming tool: marker appended last (trailing newline tolerated)');
  assert.equal(toolResultExitCode('\n\nExit code 2\n\n', true), 2, 'blank lines around the marker');
  assert.equal(toolResultExitCode('a\nExit code 3\nb', true), null, 'a script printing "Exit code 3" mid-output is not a marker');
  assert.equal(toolResultExitCode('a\nExit code 3\nb', false), 0);
  assert.equal(toolResultExitCode('all good', false), 0, 'for a job runtime the SDK flags a non-zero exit is_error — a clean result means 0');
  assert.equal(toolResultExitCode('', false), 0, 'stata prints nothing: still a clean result');
  assert.equal(toolResultExitCode('partial output\n[interrupted]', true), null, 'interrupt: an error without the marker — the exit is unknown, never invented');
  assert.equal(toolResultExitCode('Exit code 0\nfine', false), 0);
  // the SDK appends the marker ONLY to an error result: a program's own last
  // line "Exit code 3" in a non-error result is text, not a verdict (review B7)
  assert.equal(toolResultExitCode('out\nExit code 3', false), 0);
  assert.equal(toolResultExitCode('Exit code 3\nout', false), 0);
  assert.equal(_test.splitToolResult('Exit code 1\nx\ny\n').lines.length, 2, 'the marker line is not one of the program\'s lines');
});

test('toolResultKind: the SDK\'s non-output results (2.1.263 wording) — background acks, a denial, a persisted preview', () => {
  const { toolResultKind } = jobsMod;
  assert.equal(toolResultKind('Command did not complete within its 120s timeout and was moved to the background (ID: bh3x). Output is being written to: /tmp/x.log.'), 'background');
  assert.equal(toolResultKind('Command running in background with ID: b1. Output is being written to: /tmp/b1.log.'), 'background');
  assert.equal(toolResultKind('Command was moved to the background (ID: b2) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /tmp/b2.log.'), 'background');
  assert.equal(toolResultKind('Command was manually backgrounded by user with ID: b3. Output is being written to: /tmp/b3.log.'), 'background');
  assert.equal(toolResultKind("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."), 'denied');
  assert.equal(toolResultKind('<persisted-output>\nOutput too large (48.2KB). Full output saved to: /Users/x/.claude/projects/p/tool-results/toolu_1.txt\n\nPreview (first 2.0KB):\n===== test session starts =====\n…\n</persisted-output>'), 'persisted');
  assert.equal(toolResultKind('Output too large (48.2KB). Full output saved to: /tmp/r.txt\n\nPreview (first 2.0KB):\nx'), 'persisted');
  assert.equal(toolResultKind('3 passed in 0.02s'), null);
  assert.equal(toolResultKind('Command running in the background is what my script prints'), null, 'only the SDK\'s own opening');
});

test('detectScriptRun: the ledger rows — pytest (bare / -m / file), latexmk, bash x.sh (never bash -c), stata, matlab -batch, java, mvn/gradle', () => {
  const d = (c) => detectScriptRun(c, { root: proj });
  assert.equal(d('pytest').lang, 'python');
  assert.equal(d('pytest').titleKind, 'label');
  assert.match(d('pytest tests/ -k slow').file, /pytest tests\/\)$/);
  assert.equal(d('python3 -m pytest tests/').lang, 'python');
  assert.match(d('python3 -m pytest tests/').file, /pytest tests\//);
  assert.equal(d('python3 -m pytest --version'), null, 'not a workload');
  assert.deepEqual([d('pytest tests/test_a.py').lang, d('pytest tests/test_a.py').file], ['python', 'tests/test_a.py']);
  assert.deepEqual([d('latexmk -pdf -interaction=nonstopmode main.tex').lang, d('latexmk -pdf main.tex').file], ['tex', 'main.tex']);
  assert.equal(d('pdflatex paper.tex').lang, 'tex');
  assert.deepEqual([d('bash run.sh').lang, d('bash run.sh').file], ['shell', 'run.sh']);
  assert.equal(d('bash -c "ls -la"'), null, 'the agent\'s own plumbing is not a run');
  assert.equal(d('sh -c "echo hi"'), null);
  assert.deepEqual([d('stata-mp -b do analysis.do').lang, d('stata-mp -b do analysis.do').file], ['stata', 'analysis.do']);
  assert.equal(d('StataSE -e do fig2.do').lang, 'stata');
  const m = d('matlab -batch "run(\'sim.m\')"');
  assert.deepEqual([m.lang, m.inline, m.file], ['matlab', true, null]);
  assert.equal(d('matlab -nodisplay -r "sim; exit"').inline, true);
  assert.deepEqual([d('javac Main.java && java Main').lang, d('javac Main.java && java Main').file], ['java', 'Main.java']);
  assert.equal(d('mvn -q test').lang, 'java');
  assert.match(d('mvn -q test').file, /mvn test\)$/);
  assert.match(d('./gradlew build').file, /gradlew build\)$/);
  assert.equal(d('mvn --version'), null);
  // the old rows still work exactly as before
  assert.deepEqual([d('julia fig3.jl').lang, d('python3 train.py').file, d('cargo test').lang], ['julia', 'train.py', 'rust']);
});

test('pytest pass (a job that had a live card): counters, runtime, exit 0 from a non-error result, lines, verified', () => {
  const text = [
    '============================= test session starts ==============================',
    'collected 3 items', '',
    'tests/test_a.py ... [100%]', '',
    '============================== 3 passed in 0.02s ===============================', '',
  ].join('\n');
  const { job, pub } = drive('python3 -m pytest tests/test_a.py', text, { live: true, elapsedMs: 12000 });
  assert.equal(pub.state, 'done');
  assert.equal(pub.runtime, 'pytest');
  assert.equal(pub.lang, 'python');
  assert.deepEqual(pub.exit, { code: 0, signal: null, byUser: false });
  assert.equal(pub.exitCode, 0);
  assert.deepEqual(pub.counters, { passed: 3 });
  assert.equal(pub.phase.name, 'report');
  assert.deepEqual(pub.output, { lines: 6, owned: false, fromToolResult: true });
  assert.equal(pub.verified, true);
  assert.equal(pub.short, false, 'it WAS a live card');
  assert.ok(_test.jobs.has(job.key), 'a visible job lingers in the registry for reloads');
  assert.ok(getJobs().some((j) => j.key === job.key && j.state === 'done' && j.verified === true), 'and in the snapshot');
  _test.jobs.delete(job.key);
});

test('pytest fail (short run): `Exit code 1` first line, failed/passed + lastError, error state, verified, recorded — one terminal broadcast, never a live card', async () => {
  const text = [
    'Exit code 1',
    '============================= test session starts ==============================',
    'collected 3 items', '',
    'tests/test_a.py .F. [100%]', '',
    '=================================== FAILURES ===================================',
    '___________________________________ test_bad ___________________________________', '',
    '    def test_bad():', '>       assert sum([1, 2]) == 4', 'E       assert 3 == 4', '',
    'tests/test_a.py:9: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_a.py::test_bad - assert 3 == 4',
    '========================= 1 failed, 2 passed in 0.04s ==========================', '',
  ].join('\n');
  const { job, rec, pub } = drive('python3 -m pytest tests/test_a.py', text, { error: true });
  assert.ok(rec, 'recorded in jobhist');
  assert.equal(pub.state, 'error');
  assert.equal(pub.short, true);
  assert.equal(pub.runtime, 'pytest');
  assert.deepEqual(pub.exit, { code: 1, signal: null, byUser: false });
  assert.equal(pub.counters.passed, 2);
  assert.equal(pub.counters.failed, 1);
  assert.deepEqual(pub.counters.lastError, { file: 'tests/test_a.py', line: 9, col: null, msg: 'assert 3 == 4' });
  assert.deepEqual(pub.output, { lines: 16, owned: false, fromToolResult: true });
  assert.equal(pub.verified, true);
  assert.equal(pub.ms, 3000);
  assert.equal(pub.endedAt, new Date(t).toISOString());
  assert.equal(_test.jobs.has(job.key), false, 'gone from the registry at once');
  assert.ok(!getJobs().some((j) => j.key === job.key), 'never in the snapshot');
  await settle();
  const seen = statusFor(job.key);
  assert.equal(seen.length, 1, 'broadcast exactly once');
  assert.equal(seen[0].state, 'error');
  assert.equal(seen[0].short, true);
  assert.equal(seen[0].verified, true);
  assert.equal(seen[0].exit.code, 1);
  assert.equal(seen[0].counters.failed, 1);
  // a replayed tool-start for the same owned invocation does not resurrect it
  assert.equal(sessionJobStart('alpha', 'tsk-led', 'toolu_2', 'python3 -m pytest tests/test_a.py', owner), null);
});

test('cargo test: libtest totals, crate, exit 0', () => {
  const text = [
    '   Compiling app v0.1.0 (/p/app)',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.50s',
    '     Running unittests src/lib.rs (target/debug/deps/app-1a2b3c)', '',
    'running 2 tests',
    'test tests::adds ... ok',
    'test tests::muls ... ok', '',
    'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
  ].join('\n');
  const { pub } = drive('cargo test', text);
  assert.equal(pub.runtime, 'cargo');
  assert.equal(pub.lang, 'rust');
  assert.equal(pub.state, 'done');
  assert.deepEqual(pub.counters, { crate: 'app', passed: 2, failed: 0, skipped: 0 });
  assert.equal(pub.exit.code, 0);
  assert.equal(pub.verified, true);
  assert.equal(pub.short, true);
  assert.equal(pub.output.lines, 9);
});

test('node --test (TAP): `Exit code 1` LAST line, pass/fail + the failing test\'s location, error state', () => {
  const text = [
    'TAP version 13',
    '# Subtest: adds',
    'ok 1 - adds',
    '  ---',
    '  duration_ms: 1.2',
    '  ...',
    '# Subtest: fails',
    'not ok 2 - fails',
    '  ---',
    '  duration_ms: 0.8',
    "  location: '/p/test/a.test.mjs:9:1'",
    "  failureType: 'testCodeFailure'",
    "  error: 'Expected values to be strictly equal'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '1..2',
    '# tests 2',
    '# suites 0',
    '# pass 1',
    '# fail 1',
    'Exit code 1',
  ].join('\n');
  const { pub } = drive('node --test test/', text, { error: true });
  assert.equal(pub.runtime, 'node');
  assert.equal(pub.state, 'error');
  assert.deepEqual(pub.exit, { code: 1, signal: null, byUser: false });
  assert.equal(pub.counters.passed, 1);
  assert.equal(pub.counters.failed, 1);
  assert.equal(pub.counters.lastError.file, '/p/test/a.test.mjs');
  assert.equal(pub.counters.lastError.line, 9);
  assert.match(pub.counters.lastError.msg, /Expected values to be strictly equal/);
  assert.equal(pub.phase.name, 'report');
  assert.equal(pub.output.lines, 20, 'the marker is not a program line');
  assert.equal(pub.verified, true);
});

test('latexmk: pages, warnings, passes; runtime latex; lang tex; exit 0', () => {
  const text = [
    "Latexmk: applying rule 'pdflatex'...",
    "Run number 1 of rule 'pdflatex'",
    'Running \'pdflatex  -recorder  "main.tex"\'',
    'This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)',
    '(./main.tex',
    "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 12.",
    '[1] [2] [3]',
    'Output written on main.pdf (3 pages, 12345 bytes).',
    'Latexmk: All targets (main.pdf) are up-to-date', '',
  ].join('\n');
  const { pub } = drive('latexmk -pdf -interaction=nonstopmode main.tex', text);
  assert.equal(pub.runtime, 'latex');
  assert.equal(pub.lang, 'tex');
  assert.equal(pub.file, 'main.tex');
  assert.equal(pub.state, 'done');
  assert.equal(pub.counters.page, 3);
  assert.equal(pub.counters.warnings, 1);
  assert.equal(pub.counters.errors, 0);
  assert.equal(pub.counters.pass, 1);
  assert.equal(pub.exit.code, 0);
  assert.equal(pub.verified, true);
});

test('plain python traceback: errors + lastError from the last frame, exit 1', () => {
  const text = [
    'Exit code 1',
    'loading data',
    'Traceback (most recent call last):',
    '  File "/p/train.py", line 41, in <module>',
    '    main()',
    '  File "/p/train.py", line 12, in main',
    '    x = 1 / 0',
    'ZeroDivisionError: division by zero',
  ].join('\n');
  const { pub } = drive('python3 train.py', text, { error: true });
  assert.equal(pub.runtime, 'python');
  assert.equal(pub.state, 'error');
  assert.equal(pub.exit.code, 1);
  assert.equal(pub.counters.errors, 1);
  assert.deepEqual(pub.counters.lastError, { file: '/p/train.py', line: 12, col: null, msg: 'ZeroDivisionError: division by zero' });
  assert.equal(pub.output.lines, 7);
  assert.equal(pub.verified, true);
});

test('shell `exit 3`: no counters, the exit code alone verifies; a long pid-less run is still `short` (never a card)', () => {
  const { pub } = drive('bash run.sh', 'step one\nstep two\nExit code 3', { error: true, elapsedMs: 20000 });
  assert.equal(pub.runtime, 'shell');
  assert.equal(pub.lang, 'shell');
  assert.equal(pub.state, 'error');
  assert.deepEqual(pub.exit, { code: 3, signal: null, byUser: false });
  assert.deepEqual(pub.counters, {});
  assert.deepEqual(pub.output, { lines: 2, owned: false, fromToolResult: true });
  assert.equal(pub.verified, true);
  assert.equal(pub.short, true, 'past MIN_AGE but the sweep never pinned a pid: recorded from the result alone');
  assert.equal(pub.ms, 20000);
});

test('stata batch: nothing on stdout → exit 0 is NOT a verdict; verified:false, zero lines', () => {
  const { pub } = drive('stata-mp -b do analysis.do', '');
  assert.equal(pub.runtime, 'stata');
  assert.equal(pub.lang, 'stata');
  assert.equal(pub.state, 'done');
  assert.equal(pub.exit.code, 0, 'the SDK saw a clean exit — stata always exits 0');
  assert.deepEqual(pub.counters, {});
  assert.deepEqual(pub.output, { lines: 0, owned: false, fromToolResult: true });
  assert.equal(pub.verified, false, 'stata is verified only through its parser');
  // a banner echoed on stdout raises the parser's `unverified` marker — still no verdict
  const b = drive('stata-mp -b do analysis.do', 'StataMP 18.0 batch\n');
  assert.deepEqual(b.pub.counters, { unverified: 1 });
  assert.equal(b.pub.verified, false, 'the marker is a reason NOT to trust exit 0, never a counter');
});

test('an error result without the marker (interrupt): exit stays null, nothing read → verified:false, still recorded', () => {
  const { pub, rec } = drive('julia sim.jl', 'partial output\n[Request interrupted by user]', { error: true });
  assert.ok(rec);
  assert.equal(pub.state, 'error');
  assert.deepEqual(pub.exit, { code: null, signal: null, byUser: false });
  assert.equal(pub.verified, false);
  assert.equal(pub.short, true);
});

test('a timeout (2.1.26x): the command is MOVED TO THE BACKGROUND with an is_error:false ack — the job stays live as bg, never ✓ exit 0; it ends ○ unverified with the turn (review B1)', () => {
  const tool = 'toolu_timeout';
  const job = sessionJobStart('alpha', 'tsk-led', tool, 'python3 train.py', owner);
  job.visible = true; job.pid = 4243; // a card the sweep had shown for 2 minutes
  t += 120000;
  const ack = 'Command did not complete within its 120s timeout and was moved to the background (ID: bh3x). Output is being written to: /tmp/claude/bh3x.output.';
  sessionJobOutput(tool, ack, { ...owner, isError: false });
  sessionJobEnd(tool, { ...owner, error: false, exitCode: toolResultExitCode(ack, false) });
  assert.equal(job.state, 'running', 'the ack does not end it: the process is still computing');
  assert.equal(job.bg, true, 'it is a background run now');
  const live = _test.publicJob(job);
  assert.equal(live.verified, false);
  assert.equal(live.exit, null);
  assert.deepEqual(live.output, { owned: false }, 'the ack is not output');
  assert.equal(live.counters.errors, undefined, 'the ack text never reaches the parser');
  assert.ok(!getJobHistory('alpha').some((r) => r.key === job.key), 'no record yet');
  // the SDK terminates backgrounded commands at the final response: the turn's end ends the job
  endSessionJobsFor('alpha', 'tsk-led', 'stopped', owner);
  const rec = getJobHistory('alpha').find((r) => r.key === job.key);
  assert.ok(rec, 'recorded when the turn ends');
  assert.equal(rec.state, 'done', 'ended with the turn — not ⊘ stopped by anyone');
  assert.equal(rec.verified, false, 'nothing was ever read: ○, never ✓ exit 0');
  assert.deepEqual(rec.exit, { code: null, signal: null, byUser: false });
  assert.equal(rec.bg, true);
  _test.jobs.delete(job.key);
});

test('a denied tool call: the tool_use streamed before the decision, its result is the rejection — nothing ran, no row, no record (review B4)', () => {
  const tool = 'toolu_denied';
  const job = sessionJobStart('alpha', 'tsk-led', tool, 'python3 wipe.py', owner);
  assert.ok(job);
  t += 300;
  const text = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  sessionJobOutput(tool, text, { ...owner, isError: true });
  sessionJobEnd(tool, { ...owner, error: true, exitCode: toolResultExitCode(text, true) });
  assert.equal(_test.jobs.has(job.key), false, 'dropped from the registry');
  assert.ok(!getJobHistory('alpha').some((r) => r.key === job.key), 'never recorded');
  assert.ok(!getJobs().some((j) => j.key === job.key));
});

test('a >30 KB result arrives as the SDK\'s 2 KB preview: output.truncated, verified:false, no counters from the head, exit is the SDK\'s verdict only (review B5)', () => {
  const head = ['============================= test session starts ==============================', 'collected 900 items', '', 'tests/test_a.py ........................................ [  4%]'];
  const wrapper = (isErr) => `<persisted-output>\nOutput too large (48.2KB). Full output saved to: /Users/x/.claude/projects/p/tool-results/toolu_9.txt\n\nPreview (first 2.0KB):\n${head.join('\n')}\n${'x'.repeat(1800)}\n</persisted-output>${isErr ? '\nExit code 1' : ''}`;
  const ok = drive('python3 -m pytest tests/', wrapper(false));
  assert.equal(ok.pub.state, 'done');
  assert.deepEqual(ok.pub.output, { lines: 0, owned: false, fromToolResult: true, truncated: true });
  assert.deepEqual(ok.pub.counters, {}, 'the preview\'s head is not read as the run\'s counters');
  assert.equal(ok.pub.exit.code, 0, 'the SDK said it was not an error');
  assert.equal(ok.pub.verified, false, 'but a preview cannot vouch for it');
  const bad = drive('python3 -m pytest tests/', wrapper(true), { error: true });
  assert.equal(bad.pub.state, 'error');
  assert.equal(bad.pub.output.truncated, true);
  assert.equal(bad.pub.verified, false);
  assert.equal(bad.pub.exit.code, 1, 'the streaming tool\'s marker after the wrapper is still the last line');
});

test('a program whose own last line is "Exit code 3" in a NON-error result: exit 0, done (review B7)', () => {
  const { pub } = drive('bash run.sh', 'step one\nExit code 3', { error: false });
  assert.equal(pub.state, 'done');
  assert.equal(pub.exit.code, 0);
  assert.equal(pub.output.lines, 2, 'the line is the program\'s own');
});

test('stata batch with its log beside the do-file: the log tail is read at the end — errors · rc · lastError merged, r(198) verifies the FAILURE (review B3/B9)', () => {
  fs.mkdirSync(path.join(proj, 'do'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'do', 'analysis.do'), 'use panel, clear\nreghdfe wage age, absorb(id) foo\n');
  fs.writeFileSync(path.join(proj, 'do', 'analysis.log'), ['  ___  ____  ____  ____  ____ ®', '', '. do analysis.do ', '', '. use panel, clear', '',
    '. reghdfe wage age, absorb(id) foo', 'option foo not allowed', 'r(198);', '', 'end of do-file', 'r(198);', ''].join('\n'));
  const { pub } = drive('stata-mp -b do do/analysis.do', '', { elapsedMs: 131000 });
  assert.equal(pub.runtime, 'stata');
  assert.equal(pub.exit.code, 0, 'stata always exits 0');
  assert.equal(pub.state, 'error', 'the log says r(198)');
  assert.equal(pub.verified, true, 'verified through the log');
  assert.equal(pub.counters.errors, 1);
  assert.equal(pub.counters.rc, 198);
  assert.equal(pub.counters.unverified, undefined);
  assert.deepEqual(pub.counters.lastError, { file: 'do/analysis.do', line: null, col: null, msg: 'option foo not allowed' });
  // a clean log: verified, done, no r() errors
  fs.writeFileSync(path.join(proj, 'do', 'tables.do'), 'use panel, clear\n');
  fs.writeFileSync(path.join(proj, 'do', 'tables.log'), ['. do tables.do ', '', '. use panel, clear', '', '. ', 'end of do-file', ''].join('\n'));
  const clean = drive('stata-mp -b do do/tables.do', 'StataMP 18.0 batch\n', { elapsedMs: 88000 });
  assert.equal(clean.pub.state, 'done');
  assert.equal(clean.pub.verified, true);
  assert.deepEqual(clean.pub.counters, { errors: 0 }, 'the stdout marker is replaced by the log\'s verdict');
  // the log in the PROJECT ROOT (stata run from the root) is found too
  fs.writeFileSync(path.join(proj, 'fig2.do'), 'graph export fig2.png\n');
  fs.writeFileSync(path.join(proj, 'fig2.log'), ['. do fig2.do ', '', '. graph export fig2.png', 'file fig2.png could not be opened', 'r(603);', '', 'end of do-file', 'r(603);', ''].join('\n'));
  const root = drive('StataSE -e do fig2.do', '');
  assert.equal(root.pub.state, 'error');
  assert.equal(root.pub.counters.rc, 603);
  // no log anywhere: the honest ○ — nothing verifies it
  const none = drive('stata-mp -b do do/missing.do', '');
  assert.equal(none.pub.state, 'done');
  assert.equal(none.pub.verified, false);
  assert.deepEqual(none.pub.counters, {});
});

test('Codex shape: aggregatedOutput + item.exitCode passed explicitly; a non-zero code makes the state error even without is_error', () => {
  const a = drive('julia sim.jl', 'iter 10/10\n', { exitCode: 0 });
  assert.equal(a.pub.state, 'done');
  assert.equal(a.pub.exit.code, 0);
  assert.equal(a.pub.progress.frac, 1);
  assert.equal(a.pub.verified, true);
  const b = drive('Rscript analysis.R', 'Error in f(): boom\nExecution halted\n', { exitCode: 1 });
  assert.equal(b.pub.state, 'error');
  assert.equal(b.pub.exit.code, 1);
  assert.equal(b.pub.runtime, 'r');
});

test('a background launch: the tool_result is only the ack — nothing is read, the card stays live, no record without a real end', () => {
  const tool = 'toolu_bg';
  const job = sessionJobStart('alpha', 'tsk-led', tool, 'python3 serve.py', { ...owner, bg: true });
  t += 1000;
  sessionJobOutput(tool, 'Command running in background with ID: b1', owner);
  sessionJobEnd(tool, { ...owner, error: false, exitCode: 0 });
  assert.equal(job.state, 'running', 'the ack does not end it');
  assert.deepEqual(_test.publicJob(job).output, { owned: false }, 'the ack is not output');
  assert.equal(_test.publicJob(job).verified, false);
  endSessionJobsFor('alpha', 'tsk-led', 'stopped', owner); // the turn ended
  assert.equal(_test.jobs.has(job.key), false);
  assert.ok(!getJobHistory('alpha').some((r) => r.key === job.key), 'never visible, no tool result of its own → no ledger row');
});

test('the wire while running: verified:false, output {owned:false}, exit null; a stopped session job keeps byUser', () => {
  const tool = 'toolu_run';
  const job = sessionJobStart('alpha', 'tsk-led', tool, 'julia long.jl', owner);
  job.visible = true; job.pid = 777;
  const live = _test.publicJob(job);
  assert.equal(live.verified, false);
  assert.equal(live.runtime, 'julia');
  assert.equal(live.short, false);
  assert.deepEqual(live.output, { owned: false });
  assert.equal(live.exit, null);
  job._stopReq = t;
  sessionJobOutput(tool, 'iter 3/10\nExit code 143', owner);
  sessionJobEnd(tool, { ...owner, error: true, exitCode: 143 });
  const done = _test.publicJob(job);
  assert.equal(done.state, 'stopped');
  assert.deepEqual(done.exit, { code: 143, signal: null, byUser: true });
  _test.jobs.delete(job.key);
});

test('jobhist: the new fields round-trip through the file; pre-v3.1 records still load and still feed the history median', () => {
  const onDisk = JSON.parse(fs.readFileSync(HIST, 'utf8')).alpha;
  const rec = onDisk.find((r) => r.runtime === 'pytest' && r.state === 'error');
  assert.ok(rec, 'the failed pytest run persisted');
  assert.equal(rec.short, true);
  assert.equal(rec.verified, true);
  assert.deepEqual(rec.exit, { code: 1, signal: null, byUser: false });
  assert.equal(rec.counters.failed, 1);
  assert.deepEqual(rec.output, { lines: 16, owned: false, fromToolResult: true });
  assert.equal(rec.appTurnId, 'turn-1');
  assert.equal(typeof rec.endedAt, 'string');
  // old records: untouched, loadable, fields simply absent
  const old = getJobHistory('alpha').filter((r) => r.file === 'old.jl');
  assert.equal(old.length, 3);
  for (const r of old) {
    assert.equal(r.runtime, undefined);
    assert.equal(r.verified, undefined);
    assert.equal(r.short, undefined);
    assert.equal(r.exit, undefined);
  }
  assert.deepEqual(onDisk.slice(0, 3), OLD, 'never rewritten');
  const j = sessionJobStart('alpha', 'tsk-led', 'toolu_old_again', 'julia old.jl', owner);
  assert.deepEqual(j._history, { typicalMs: 200, n: 3 }, 'the median still reads old records');
  _test.jobs.delete(j.key);
});

test('lib/sessions.js hands text then exit to jobs.js at both tool-result sites, in that order', () => {
  const src = fs.readFileSync(new URL('../lib/sessions.js', import.meta.url), 'utf8');
  // Claude: the tool_result block
  const cOut = src.indexOf('sessionJobOutput(block.tool_use_id, resultText, { ...jobOwner, isError: !!block.is_error })');
  const cEnd = src.indexOf('sessionJobEnd(block.tool_use_id, { ...jobOwner, error: !!block.is_error, exitCode: toolResultExitCode(resultText, !!block.is_error) })');
  assert.ok(cOut > 0 && cEnd > cOut, 'Claude site: output before end, exit from the marker');
  assert.ok(src.includes('const resultText = toolResultText(block);'));
  // Codex: the commandExecution item
  const xOut = src.indexOf("sessionJobOutput(item.id, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '', jobOwner)");
  const xEnd = src.indexOf('exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null');
  assert.ok(xOut > 0 && xEnd > xOut, 'Codex site: aggregatedOutput before end, item.exitCode carried');
  assert.equal(src.match(/sessionJobEnd\(/g).length, 2, 'no other end sites');
});
