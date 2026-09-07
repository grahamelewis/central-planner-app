// /api/run — the ▶ run feature. Uses only trivial bash scripts; asserts the
// full lifecycle (running → done/stopped/error), output capture, the
// one-run-per-project rule, and containment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startSandbox } from './serverHarness.mjs';

// job cards: a run's card turns visible only at a poll sweep that finds it
// older than CP_JOB_MIN_AGE_MS — and a card that never turned visible is
// deleted when the run ends (jobs.js finish), so the tests below could not
// read its `lang`. Age 0 makes the FIRST sweep during the run enough; the
// fixtures each hold ≥ ~1 s so that sweep (250 ms floor + a ps -A under a
// parallel test load) is certain to land. Inherited by the sandbox server
// via process.env.
process.env.CP_JOB_MIN_AGE_MS = '0';
process.env.CP_JOB_POLL_MS = '200'; // floors at 250 (jobs.js POLL_MS)

/** is `bin` on this machine's PATH? (go / cmake / ninja may be absent) */
const hasBin = (bin) => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
};

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      const a = projRoots.alpha;
      fs.writeFileSync(path.join(a, 'hello.sh'), 'echo hello-from-run\n');
      fs.writeFileSync(path.join(a, 'fail.sh'), 'echo about-to-fail >&2\nexit 3\n');
      fs.writeFileSync(path.join(a, 'sleeper.sh'), 'sleep 30\n');
      fs.writeFileSync(path.join(a, 'data.csv'), 'a,b\n1,2\n');
      const w = (rel, text, mode) => {
        fs.mkdirSync(path.dirname(path.join(a, rel)), { recursive: true });
        fs.writeFileSync(path.join(a, rel), text, mode ? { mode } : undefined);
      };
      // ── wave 1 fixtures (each runs ≥ ~1 s so its job card turns visible) ──
      w('hello.rs', 'fn main() { println!("rs-line-1"); std::thread::sleep(std::time::Duration::from_millis(900)); println!("rs-line-2"); }\n');
      w('crate/Cargo.toml', '[package]\nname = "hello_crate"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
      w('crate/src/main.rs', 'fn main() { println!("hello from crate"); std::thread::sleep(std::time::Duration::from_millis(600)); }\n'
        // the test sleeps too: `cargo test` on the warm crate is ~0.4 s end to end otherwise — no sweep would see its card
        + '#[cfg(test)]\nmod t { #[test] fn always_fails() { std::thread::sleep(std::time::Duration::from_millis(1000)); assert_eq!(1, 2, "deliberate"); } }\n');
      w('hello.js', 'console.log("js-line-1"); setTimeout(() => { console.log("js-line-2"); }, 900);\n');
      w('hello.ts', 'enum Status { Ready = 42 }; class Example { constructor(public status: Status) {} }; console.log("ts-line", new Example(Status.Ready).status); setTimeout(() => { console.log("ts-done"); }, 900);\n');
      w('pkg/package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2));
      w('pkg/server.js', 'console.log("server up"); setTimeout(() => { console.log("server done"); }, 900);\n');
      w('hello.c', '#include <stdio.h>\n#include <unistd.h>\nint main(void){ printf("c-line-1\\n"); sleep(1); printf("c-line-2\\n"); return 0; }\n');
      w('hello.cpp', '#include <iostream>\n#include <unistd.h>\nint main(){ std::cout << "cpp-line-1" << std::endl; sleep(1); std::cout << "cpp-line-2\\n"; return 3; }\n');
      w('mk/Makefile', 'prog: prog.c\n\tcc -o prog prog.c\n');
      w('mk/prog.c', '#include <stdio.h>\n#include <unistd.h>\nint main(void){ printf("made ok\\n"); sleep(1); return 0; }\n');
      w('gomod/go.mod', 'module example.com/hello\n\ngo 1.21\n');
      w('gomod/main.go', 'package main\n\nimport ("fmt"; "time")\n\nfunc main() { fmt.Println("go-line-1"); time.Sleep(900 * time.Millisecond); fmt.Println("go-line-2") }\n');
      w('gomod/main_test.go', 'package main\n\nimport "testing"\n\nfunc TestFails(t *testing.T) { t.Fatal("deliberate") }\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

const runState = (s) => s.runs && s.runs.alpha;

test('a shell script runs to completion with its output in the tail', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.sh' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.run.state, 'running');
  assert.match(body.run.cmdLine, /bash hello\.sh/);

  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'done');
  const run = runState(state);
  assert.equal(run.exitCode, 0);
  assert.ok(run.tail.includes('hello-from-run'), 'stdout captured in the server-side tail');
  assert.ok(Number.isFinite(run.ms), 'duration recorded');
});

test('a failing script ends in error state with its exit code', async () => {
  await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'fail.sh' });
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'error');
  const run = runState(state);
  assert.equal(run.exitCode, 3);
  assert.ok(run.tail.includes('about-to-fail'), 'stderr captured');
});

test('one run per project: a second start is refused, stop kills the active run', async () => {
  const first = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'sleeper.sh' });
  assert.equal(first.status, 200);

  const second = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.sh' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already active/);

  const stop = await sb.fetchJson('DELETE', '/api/run/alpha');
  assert.equal(stop.status, 200);
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'stopped');
  assert.equal(runState(state).state, 'stopped');
});

test('run refuses unknown files, escapes, and unrunnable extensions', async () => {
  const missing = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'ghost.sh' });
  assert.equal(missing.status, 400);

  const esc = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: '../escape.sh' });
  assert.equal(esc.status, 400);

  const csv = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'data.csv' });
  assert.equal(csv.status, 400);
  assert.match(csv.body.error, /don't know how to run/);

  const noRel = await sb.fetchJson('POST', '/api/run', { project: 'alpha' });
  assert.equal(noRel.status, 400);
});

test('stopping a project with no active run is a harmless no-op', async () => {
  const { status, body } = await sb.fetchJson('DELETE', '/api/run/beta');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

// ── .sql runs (duckdb via the python package) ──
const hasDuck = (() => {
  try { execSync('python3 -c "import duckdb"', { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('a .sql file runs through duckdb: every statement\'s results in the tail',
  { skip: hasDuck ? false : 'python3 duckdb package not installed' }, async () => {
    fs.writeFileSync(path.join(sb.projRoots.alpha, 'query.sql'),
      "-- build + two selects: BOTH result boxes must print\n"
      + 'CREATE TABLE t AS SELECT range AS id, range * 2 AS v FROM range(5);\n'
      + 'SELECT count(*) AS n_rows FROM t;\n'
      + "SELECT id FROM t WHERE v >= 6 ORDER BY id;\n");
    const { status, body } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'query.sql' });
    assert.equal(status, 200);
    assert.match(body.run.cmdLine, /duckdb query\.sql/, 'footer shows the honest engine, not the shim');
    const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state !== 'running');
    const run = runState(state);
    assert.equal(run.state, 'done');
    assert.equal(run.exitCode, 0);
    assert.match(run.tail, /in-memory/, 'the ATTACH-your-own-database note leads the output');
    assert.match(run.tail, /n_rows/, 'first SELECT printed');
    assert.match(run.tail, /│\s*5\s*│/, 'count value in the box table');
    assert.ok(run.tail.indexOf('n_rows') < run.tail.indexOf('ORDER BY'),
      'statements print in order — intermediate results are not swallowed');
  });

test('a broken .sql statement fails the run and names the error',
  { skip: hasDuck ? false : 'python3 duckdb package not installed' }, async () => {
    fs.writeFileSync(path.join(sb.projRoots.alpha, 'bad.sql'),
      'SELECT 1;\nSELECT * FROM table_that_does_not_exist;\n');
    await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'bad.sql' });
    const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state !== 'running');
    const run = runState(state);
    assert.equal(run.state, 'error');
    assert.match(run.tail, /table_that_does_not_exist/, 'the failing statement is named');
  });

// ── wave 1: rust · node/ts · c/c++ · make (· go when installed) ──
// Each: 200 on start with the resolved plan, a terminal run:status, the
// expected exit code and phases, and a job card whose lang = runtime id.

/** POST /api/run, wait for the terminal state, hand back {start, run, job}. */
async function runToEnd(rel, body = {}) {
  const start = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel, ...body });
  assert.equal(start.status, 200, `start ${rel}: ${JSON.stringify(start.body)}`);
  assert.equal(start.body.ok, true);
  assert.equal(start.body.run.state, 'running');
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state !== 'running'
    && runState(s).startedAt === start.body.run.startedAt, { timeoutMs: 90000, everyMs: 150 });
  const run = runState(state);
  const job = (state.jobs || []).find((j) => j.key === 'run:alpha') || null;
  return { start: start.body.run, run, job };
}

test('hello.rs (no Cargo.toml) → rustc then the binary: two phases, exit 0, a rust card', async () => {
  const { start, run, job } = await runToEnd('hello.rs');
  assert.equal(start.runtime, 'rust');
  assert.deepEqual(start.phases, ['compiling', 'running']);
  assert.equal(start.display, 'rustc -o ./hello hello.rs && ./hello');
  assert.equal(start.cmdLine, 'rustc -o ./hello hello.rs', 'the footer starts on step 1');
  assert.equal(run.state, 'done');
  assert.equal(run.exitCode, 0);
  assert.equal(run.phase, 'running');
  assert.deepEqual(run.step, { i: 1, n: 2 });
  assert.equal(run.cmdLine, './hello', 'the footer followed the step that ran last');
  assert.ok(run.tail.includes('rs-line-1') && run.tail.includes('rs-line-2'), run.tail);
  assert.ok(run.tail.indexOf('[runner] ./hello') < run.tail.indexOf('rs-line-1'), 'step boundary marked before its output');
  assert.ok(fs.existsSync(path.join(sb.root, 'runs', 'alpha', 'bin', 'hello')), 'binary under <ROOT>/runs/alpha/bin');
  assert.ok(!fs.existsSync(path.join(sb.projRoots.alpha, 'hello')), 'nothing compiled into the project');
  assert.ok(job, 'the run\'s job card lingered for the snapshot');
  assert.equal(job.lang, 'rust');
  assert.equal(job.state, 'done');
  assert.deepEqual(job.exit, { code: 0, signal: null, byUser: false });
  assert.equal(job.phase.name, 'running');
});

test('a Cargo crate: ▶ on src/main.rs → cargo run at the crate root, exit 0; mode:test → cargo test fails with exit 101', async () => {
  const ran = await runToEnd('crate/src/main.rs');
  assert.equal(ran.start.runtime, 'rust');
  assert.equal(ran.start.display, 'cargo run');
  assert.deepEqual(ran.start.phases, ['compiling']);
  assert.equal(ran.run.state, 'done', ran.run.tail);
  assert.equal(ran.run.exitCode, 0);
  assert.ok(ran.run.tail.includes('hello from crate'), ran.run.tail);
  assert.ok(ran.job && ran.job.lang === 'rust', 'cargo run card is a rust card');

  const tested = await runToEnd('crate/src/main.rs', { mode: 'test' });
  assert.equal(tested.start.mode, 'test');
  assert.equal(tested.start.display, 'cargo test');
  assert.equal(tested.run.state, 'error');
  assert.equal(tested.run.exitCode, 101, 'cargo\'s test-failure exit code carries');
  assert.match(tested.run.tail, /test result: FAILED\. 0 passed; 1 failed/);
  assert.match(tested.run.tail, /deliberate/);
  assert.equal(tested.job.lang, 'rust');
  assert.equal(tested.job.exit.code, 101);
  assert.equal(tested.job.state, 'error');
});

test('hello.js → node; enum/parameter-property TypeScript → installed tsx; both stream and exit 0', async () => {
  const js = await runToEnd('hello.js');
  assert.equal(js.start.runtime, 'node');
  assert.equal(js.start.display, 'node hello.js');
  assert.equal(js.run.state, 'done');
  assert.equal(js.run.exitCode, 0);
  assert.ok(js.run.tail.includes('js-line-1') && js.run.tail.includes('js-line-2'), 'nothing lost on a natural node exit');
  assert.equal(js.job.lang, 'node');

  const ts = await runToEnd('hello.ts');
  assert.equal(ts.start.display, 'tsx hello.ts');
  assert.equal(ts.run.state, 'done', ts.run.tail);
  assert.equal(ts.run.exitCode, 0);
  assert.match(ts.run.tail, /ts-line 42/);
  assert.equal(ts.job.lang, 'node');
});

test('a package.json start script: ▶ on the file runs `npm run start` from the package dir, pinned to the node child', async () => {
  const { start, run, job } = await runToEnd('pkg/server.js');
  assert.equal(start.display, 'npm run start');
  assert.equal(run.state, 'done', run.tail);
  assert.equal(run.exitCode, 0);
  assert.match(run.tail, /start script — running `npm run start`/);
  assert.ok(run.tail.includes('server up') && run.tail.includes('server done'), run.tail);
  assert.equal(job.lang, 'node');
  assert.ok(job.pid > 0);
});

test('hello.c → cc then the binary under a pty: lines arrive BEFORE exit, exit 0, phases compiling → running', async () => {
  const start = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.c' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.deepEqual(start.body.run.phases, ['compiling', 'running']);
  assert.equal(start.body.run.display, 'cc -Wall -O0 -g hello.c -o ./hello && ./hello');
  // the pty path's whole point: C's printf is block-buffered when piped, so
  // without it "c-line-1" would only land at exit — here it must be in the
  // tail while the run is STILL running (the program sleeps 1 s after it)
  const mid = await sb.poll('/api/state', (s) => runState(s) && runState(s).tail.includes('c-line-1'), { timeoutMs: 30000, everyMs: 50 });
  assert.equal(runState(mid).state, 'running', 'first line seen before the program exited');
  assert.equal(runState(mid).phase, 'running');
  assert.equal(runState(mid).cmdLine, './hello');
  assert.ok(!runState(mid).tail.includes('c-line-2'), 'the second line has not been printed yet');
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state !== 'running', { timeoutMs: 30000 });
  const run = runState(state);
  assert.equal(run.state, 'done');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.step, { i: 1, n: 2 });
  assert.ok(run.tail.includes('c-line-1\nc-line-2'), `\\r\\n collapsed to \\n: ${JSON.stringify(run.tail)}`);
  assert.ok(!run.tail.includes('^D'), 'script(1)\'s ^D echo stripped');
  const job = (state.jobs || []).find((j) => j.key === 'run:alpha');
  assert.equal(job.lang, 'c');
  assert.equal(job.output.buffered, false, 'under the pty the stream is honest');
});

test('hello.cpp → c++ then the binary: a non-zero return carries as the run\'s exit code and error state', async () => {
  const { start, run, job } = await runToEnd('hello.cpp');
  assert.equal(start.runtime, 'cpp');
  assert.equal(start.display, 'c++ -Wall -O0 -g hello.cpp -o ./hello && ./hello');
  assert.equal(run.state, 'error');
  assert.equal(run.exitCode, 3);
  assert.equal(run.phase, 'running', 'the phase names the step that failed');
  assert.ok(run.tail.includes('cpp-line-1') && run.tail.includes('cpp-line-2'));
  assert.equal(job.lang, 'cpp');
  assert.deepEqual(job.exit, { code: 3, signal: null, byUser: false });
});

test('a Makefile project: ▶ on prog.c → make in that dir, then ./prog', async () => {
  const { start, run, job } = await runToEnd('mk/prog.c');
  assert.equal(start.display, 'make && ./prog');
  assert.deepEqual(start.phases, ['building', 'running']);
  assert.equal(run.state, 'done', run.tail);
  assert.equal(run.exitCode, 0);
  assert.match(run.tail, /cc -o prog prog\.c/, 'make echoed its recipe');
  assert.ok(run.tail.includes('made ok'));
  assert.deepEqual(run.step, { i: 1, n: 2 });
  assert.ok(fs.existsSync(path.join(sb.projRoots.alpha, 'mk', 'prog')), 'make built where the Makefile lives');
  assert.equal(job.lang, 'c');
});

test('a stopped multi-step run: ⊘ during the binary step kills the process group and reports stopped',
  async () => {
    fs.writeFileSync(path.join(sb.projRoots.alpha, 'forever.c'), '#include <stdio.h>\n#include <unistd.h>\nint main(void){ printf("looping\\n"); for(;;) sleep(1); }\n');
    const start = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'forever.c' });
    assert.equal(start.status, 200);
    await sb.poll('/api/state', (s) => runState(s) && runState(s).tail.includes('looping'), { timeoutMs: 30000, everyMs: 50 });
    // let the card cross the visibility gate (CP_JOB_MIN_AGE_MS) so the
    // snapshot still carries it after the stop
    await sb.poll('/api/state', (s) => (s.jobs || []).some((j) => j.key === 'run:alpha' && j.state === 'running'), { timeoutMs: 10000 });
    const stop = await sb.fetchJson('DELETE', '/api/run/alpha');
    assert.equal(stop.status, 200);
    const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state !== 'running');
    assert.equal(runState(state).state, 'stopped');
    const job = (state.jobs || []).find((j) => j.key === 'run:alpha');
    assert.equal(job.state, 'stopped');
    assert.equal(job.exit.byUser, true);
  });

test('go.mod: ▶ on main.go → go run . (exit 0, a go card pinned to the exe child); main_test.go → go test ./... fails',
  { skip: hasBin('go') ? false : 'go not installed' }, async () => {
    const ran = await runToEnd('gomod/main.go');
    assert.equal(ran.start.runtime, 'go');
    assert.equal(ran.start.display, 'go run .');
    assert.equal(ran.run.state, 'done', ran.run.tail);
    assert.equal(ran.run.exitCode, 0);
    assert.ok(ran.run.tail.includes('go-line-1') && ran.run.tail.includes('go-line-2'));
    assert.equal(ran.job.lang, 'go');
    const tested = await runToEnd('gomod/main_test.go');
    assert.equal(tested.start.mode, 'test');
    assert.equal(tested.start.display, 'go test ./...');
    assert.equal(tested.run.state, 'error');
    assert.equal(tested.run.exitCode, 1);
    assert.match(tested.run.tail, /--- FAIL: TestFails/);
    assert.equal(tested.job.lang, 'go');
  });

test('go absent: ▶ on a .go file is refused before spawning, naming the missing binary',
  { skip: hasBin('go') ? 'go is installed here' : false }, async () => {
    const { status, body } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'gomod/main.go' });
    assert.equal(status, 400);
    assert.equal(body.error, 'go not found on the server PATH');
  });

test('/api/run validates mode; /api/state carries the registry (exts, byExt, toolchains)', async () => {
  const bad = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.sh', mode: 'bench' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /mode must be/);
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.ok(Array.isArray(body.runtimes.exts));
  for (const e of ['.jl', '.py', '.rs', '.go', '.ts', '.tsx', '.c', '.cpp']) assert.ok(body.runtimes.exts.includes(e), e);
  assert.equal(body.runtimes.byExt['.rs'].id, 'rust');
  assert.equal(body.runtimes.byExt['.rs'].label, 'Rust');
  assert.equal(body.runtimes.byExt['.cpp'].id, 'cpp');
  assert.equal(body.runtimes.toolchains.rust.ok, true);
  assert.equal(body.runtimes.toolchains.shell.ok, true);
  assert.equal(body.runtimes.toolchains.go.ok, hasBin('go'));
  assert.equal(typeof body.runtimes.toolchains.c.bins.cc.path, 'string');
});
