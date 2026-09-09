// The desktop shell's full test plan (BLUEPRINT §8): the lifecycle decision
// table (per-row + full probe × launchd cross product), single-flight,
// probe classification/error mapping, port resolution, the pure window/
// navigation helpers, shell-log rotation, and the notifier (F1 event map,
// reconciliation + persistence, watchdog, capped backoff, suppression).
// Plain `node --test` — no Electron runtime, no network sockets, no real
// launchctl, and by construction no billed route (serverlink.js never calls
// any /api mutation). Every timer runs on the fake makeClock except the one
// documented 10 ms tcpAccepts timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATES, resolvePort, installationDataRoot, classifyProbe, probe, tcpAccepts, launchdLoaded,
  createLifecycle, createNotifier, shellLog, sanitizeBounds, shouldIntervene,
  themeFromBackground,
} from '../serverlink.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(TEST_DIR, '..');
const drain = () => new Promise((resolve) => setImmediate(resolve));

// Manual clock: ordered pending-callback list + microtask draining between
// firings so the async iterate() settles before the next timer is considered.
function makeClock() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: t + ms, fn }); return seq; },
    clearTimeout(id) { pending.delete(id); },
    pendingDelays() { return [...pending.values()].map((p) => p.at - t); },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, p]) => p.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, p] = due[0];
        pending.delete(id);
        t = p.at;
        p.fn();
        await drain();
      }
      t = target;
    },
  };
}

// Lifecycle harness: scripted probe/tcp/launchd results, spy onState + delays.
// Process effects are injected; serverlink itself remains pure and serializes
// decisions without importing child_process spawn.
function harness({ probeResults = [], tcp = [], launchd = [], port = 4242, startServer, stopServer } = {}) {
  const clock = makeClock();
  const states = [];
  const delays = [];
  const logs = [];
  const calls = { resolvePort: 0, probe: 0, tcp: 0, launchd: 0 };
  const next = (arr, dflt) => (arr.length ? arr.shift() : dflt);
  const lc = createLifecycle({
    resolvePort: () => { calls.resolvePort += 1; return port; },
    probe: async () => { calls.probe += 1; return next(probeResults, 'REFUSED'); },
    tcpAccepts: async () => { calls.tcp += 1; return next(tcp, false); },
    launchdLoaded: async () => { calls.launchd += 1; return next(launchd, false); },
    startServer,
    stopServer,
    onState: (s) => states.push(s),
    log: (l) => logs.push(l),
    setTimeout: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, ms); },
    clearTimeout: (id) => clock.clearTimeout(id),
    now: clock.now,
  });
  return { lc, clock, states, delays, logs, calls };
}

// ---------------------------------------------------------------- decision matrix

test('HEALTHY → ATTACH, loop ends, launchd/tcp never consulted', async () => {
  const h = harness({ probeResults: ['HEALTHY'] });
  h.lc.trigger('startup');
  await drain();
  assert.deepEqual(h.states.map((s) => s.name), [STATES.ATTACH]);
  assert.equal(h.states[0].port, 4242);
  assert.equal(h.states[0].gen, 1);
  assert.equal(h.calls.probe, 1);
  assert.equal(h.calls.launchd, 0);
  assert.equal(h.calls.tcp, 0);
  assert.equal(h.delays.length, 0); // nothing scheduled — attach is terminal
  await h.clock.advance(60000);
  assert.equal(h.calls.probe, 1);   // and stays terminal
});

test('FOREIGN → BLOCKED_OCCUPIED(foreign) at 5 s cadence', async () => {
  const h = harness({ probeResults: ['FOREIGN'] });
  h.lc.trigger('startup');
  await drain();
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].name, STATES.BLOCKED_OCCUPIED);
  assert.equal(h.states[0].reason, 'foreign');
  assert.deepEqual(h.delays, [5000]);
  assert.equal(h.calls.launchd, 0);
  assert.equal(h.calls.tcp, 0);
});

test('REFUSED + job loaded → WAIT_LAUNCHD at 1 s, flipping to 5 s after 20 s', async () => {
  // dedicated build: probe REFUSED forever, launchd loaded forever
  const states = [];
  const delays = [];
  const clock = makeClock();
  const lc = createLifecycle({
    resolvePort: () => 4242,
    probe: async () => 'REFUSED',
    tcpAccepts: async () => false,
    launchdLoaded: async () => true,
    onState: (s) => states.push(s),
    log: () => {},
    setTimeout: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, ms); },
    clearTimeout: (id) => clock.clearTimeout(id),
    now: clock.now,
  });
  lc.trigger('startup');
  await drain();
  assert.deepEqual(states.map((s) => s.name), [STATES.WAIT_LAUNCHD]);
  assert.deepEqual(delays, [1000]);
  await clock.advance(20000);
  // 1 s cadence through the first 20 s of the contiguous WAIT stretch, then 5 s
  assert.equal(delays.at(-1), 5000);
  assert.ok(delays.slice(0, -1).every((ms) => ms === 1000));
  assert.equal(states.length, 1); // deduped: WAIT_LAUNCHD emitted once, not per cycle
  await clock.advance(10000);
  assert.equal(delays.at(-1), 5000); // 5 s forever after the fast window
});

test('REFUSED + job not loaded → SERVER_ABSENT at 5 s', async () => {
  const h = harness({ probeResults: ['REFUSED'], launchd: [false] });
  h.lc.trigger('startup');
  await drain();
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].name, STATES.SERVER_ABSENT);
  assert.deepEqual(h.delays, [5000]);
  assert.equal(h.calls.launchd, 1);
  assert.equal(h.calls.tcp, 0);
});

test('TIMEOUT + TCP accepts → BLOCKED_OCCUPIED(occupied)', async () => {
  const h = harness({ probeResults: ['TIMEOUT'], tcp: [true] });
  h.lc.trigger('startup');
  await drain();
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].name, STATES.BLOCKED_OCCUPIED);
  assert.equal(h.states[0].reason, 'occupied');
  assert.deepEqual(h.delays, [5000]);
  assert.equal(h.calls.tcp, 1);
  assert.equal(h.calls.launchd, 0);
});

test('TIMEOUT + TCP refuses → CONNECTING (transient), re-probe at 5 s', async () => {
  const h = harness({ probeResults: ['TIMEOUT', 'HEALTHY'], tcp: [false] });
  h.lc.trigger('startup');
  await drain();
  assert.equal(h.states[0].name, STATES.CONNECTING);
  assert.deepEqual(h.delays, [5000]);
  await h.clock.advance(5000);
  assert.deepEqual(h.states.map((s) => s.name), [STATES.CONNECTING, STATES.ATTACH]);
});

test('leaving WAIT resets the fast-cadence window for a later WAIT stretch', async () => {
  const states = [];
  const delays = [];
  const clock = makeClock();
  // WAIT at t=0, then 25 s of TIMEOUT cycles, then WAIT again at t=26 s —
  // well past the first stretch's 20 s window, inside the new stretch's.
  const script = ['REFUSED', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT'];
  const lc = createLifecycle({
    resolvePort: () => 4242,
    probe: async () => (script.length ? script.shift() : 'REFUSED'),
    tcpAccepts: async () => false,
    launchdLoaded: async () => true,
    onState: (s) => states.push(s),
    log: () => {},
    setTimeout: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, ms); },
    clearTimeout: (id) => clock.clearTimeout(id),
    now: clock.now,
  });
  lc.trigger('startup');
  await drain();               // REFUSED+loaded → WAIT @1s (fast window opens at t=0)
  await clock.advance(26500);  // TIMEOUTs break the stretch; WAIT re-entered at t=26000
  // The WAIT re-entry is a NEW contiguous stretch — cadence is 1000 again,
  // even though 26 s have passed since the first stretch began. (Without the
  // waitSince reset this would be 5000.)
  assert.equal(delays.at(-1), 1000);
  // dedupe: consecutive identical states collapse
  assert.deepEqual(states.map((s) => s.name),
    [STATES.WAIT_LAUNCHD, STATES.CONNECTING, STATES.WAIT_LAUNCHD]);
});

test('decision matrix: full probe × launchd cross product — launchd only on REFUSED, tcp only on TIMEOUT', async () => {
  const CASES = [
    // [probe, launchd loaded, tcp accepts, expected state, expected reason]
    ['HEALTHY', true,  false, STATES.ATTACH, undefined],
    ['HEALTHY', false, false, STATES.ATTACH, undefined],
    ['FOREIGN', true,  false, STATES.BLOCKED_OCCUPIED, 'foreign'],
    ['FOREIGN', false, false, STATES.BLOCKED_OCCUPIED, 'foreign'],
    ['REFUSED', true,  false, STATES.WAIT_LAUNCHD, undefined],
    ['REFUSED', false, false, STATES.SERVER_ABSENT, undefined],
    ['TIMEOUT', true,  false, STATES.CONNECTING, undefined],
    ['TIMEOUT', false, false, STATES.CONNECTING, undefined],
    ['TIMEOUT', true,  true,  STATES.BLOCKED_OCCUPIED, 'occupied'],
    ['TIMEOUT', false, true,  STATES.BLOCKED_OCCUPIED, 'occupied'],
  ];
  for (const [cls, loaded, tcpUp, name, reason] of CASES) {
    const label = `${cls} × launchd ${loaded ? 'loaded' : 'not loaded'} × tcp ${tcpUp}`;
    const h = harness({ probeResults: [cls], launchd: [loaded], tcp: [tcpUp] });
    h.lc.trigger('startup');
    await drain();
    assert.equal(h.states.length, 1, label);
    assert.equal(h.states[0].name, name, label);
    assert.equal(h.states[0].reason, reason, label);
    // Evidence discipline: launchd is consulted ONLY on REFUSED and the raw-
    // TCP check runs ONLY on TIMEOUT — no other outcome may touch either
    // source, so launchd evidence can never leak into a non-REFUSED decision.
    assert.equal(h.calls.launchd, cls === 'REFUSED' ? 1 : 0, label);
    assert.equal(h.calls.tcp, cls === 'TIMEOUT' ? 1 : 0, label);
    h.lc.dispose(); // no fake-clock timer carries into the next row
  }
});

test('serverlink stays a pure coordinator: process start is injected by main.js', () => {
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'serverlink.js'), 'utf8');
  assert.ok(!/\bspawn\s*\(/.test(src), 'serverlink.js must contain no process-starting effect');
  assert.ok(!/execSync|\bexec\(/.test(src), 'no shell-out beyond execFile');
  // the one child_process use remains the read-only launchctl list query
  assert.match(src, /execFile/);
  assert.match(src, /startServerDep/);
  assert.match(src, /launchctl/);
  assert.ok(!src.includes("from 'electron'") && !src.includes('require('), 'no electron import, pure ESM');
});

test('REFUSED + no launchd starts exactly one owned server then attaches', async () => {
  let starts = 0;
  const h = harness({
    probeResults: ['REFUSED', 'REFUSED', 'HEALTHY'],
    launchd: [false, false],
    startServer: async () => { starts += 1; },
  });
  h.lc.trigger('startup');
  await drain();
  assert.deepEqual(h.states.map((s) => s.name), [STATES.STARTING_SERVER]);
  assert.equal(starts, 1);
  assert.equal(h.delays[0], 250);
  await h.clock.advance(250);
  assert.equal(starts, 1, 'a still-booting child is never duplicated');
  assert.equal(h.delays.at(-1), 500);
  await h.clock.advance(500);
  assert.deepEqual(h.states.map((s) => s.name), [STATES.STARTING_SERVER, STATES.ATTACH]);
  assert.equal(starts, 1);
});

test('a later generation can replace an owned server that exited after attach', async () => {
  let starts = 0;
  const h = harness({
    probeResults: ['REFUSED', 'HEALTHY', 'REFUSED', 'HEALTHY'],
    launchd: [false, false],
    startServer: async () => { starts += 1; },
  });
  h.lc.trigger('startup');
  await drain();
  await h.clock.advance(250);
  assert.equal(h.states.at(-1).name, STATES.ATTACH);
  assert.equal(starts, 1);

  h.lc.trigger('owned-server-exit');
  await drain();
  assert.equal(h.states.at(-1).name, STATES.STARTING_SERVER);
  assert.equal(starts, 2, 'process-start state resets at the generation boundary');
  await h.clock.advance(250);
  assert.equal(h.states.at(-1).name, STATES.ATTACH);
});

test('owned start failure becomes SERVER_FAILED without a retry loop', async () => {
  let starts = 0;
  const h = harness({
    probeResults: ['REFUSED', 'REFUSED'],
    launchd: [false, false],
    startServer: async () => { starts += 1; throw new Error('node missing'); },
  });
  h.lc.trigger('startup');
  await drain();
  assert.deepEqual(h.states.map((s) => s.name), [STATES.STARTING_SERVER, STATES.SERVER_FAILED]);
  assert.match(h.states.at(-1).reason, /node missing/);
  await h.clock.advance(5000);
  assert.equal(starts, 1);
});

test('owned child readiness budget stops the child after 15 seconds', async () => {
  let stops = 0;
  const probes = Array(40).fill('REFUSED');
  const launches = Array(40).fill(false);
  const h = harness({
    probeResults: probes,
    launchd: launches,
    startServer: async () => {},
    stopServer: async () => { stops += 1; },
  });
  h.lc.trigger('startup');
  await drain();
  await h.clock.advance(15250);
  assert.equal(stops, 1);
  assert.equal(h.states.at(-1).name, STATES.SERVER_FAILED);
  assert.match(h.states.at(-1).reason, /15 seconds/);
});

// ---------------------------------------------------------------- single-flight

test('trigger during an in-flight probe joins it — no second probe (I8)', async () => {
  let resolveProbe;
  let probeCalls = 0;
  const clock = makeClock();
  const states = [];
  const lc = createLifecycle({
    resolvePort: () => 4242,
    probe: () => { probeCalls += 1; return new Promise((r) => { resolveProbe = r; }); },
    tcpAccepts: async () => false,
    launchdLoaded: async () => false,
    onState: (s) => states.push(s),
    log: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  lc.trigger('startup');
  lc.trigger('did-fail-load'); // probe in flight → no-op join
  lc.trigger('resume');
  assert.equal(probeCalls, 1);
  assert.equal(lc.generation, 1); // same generation throughout
  resolveProbe('HEALTHY');
  await drain();
  assert.deepEqual(states.map((s) => s.name), [STATES.ATTACH]);
});

test('trigger while sleeping collapses the timer — immediate probe, same generation', async () => {
  const h = harness({ probeResults: ['REFUSED', 'HEALTHY'], launchd: [false] });
  h.lc.trigger('startup');
  await drain();
  assert.equal(h.states[0].name, STATES.SERVER_ABSENT);
  assert.equal(h.clock.pendingDelays().length, 1); // sleeping
  h.lc.trigger('resume');                          // collapse the sleep
  await drain();
  assert.equal(h.clock.pendingDelays().length, 0);
  assert.equal(h.calls.probe, 2);
  assert.equal(h.lc.generation, 1);
  assert.deepEqual(h.states.map((s) => s.name), [STATES.SERVER_ABSENT, STATES.ATTACH]);
});

test('dispose() makes a superseded generation inert — no emit, no timer (I8)', async () => {
  let resolveProbe;
  const clock = makeClock();
  const states = [];
  const lc = createLifecycle({
    resolvePort: () => 4242,
    probe: () => new Promise((r) => { resolveProbe = r; }),
    tcpAccepts: async () => false,
    launchdLoaded: async () => false,
    onState: (s) => states.push(s),
    log: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  lc.trigger('startup');
  lc.dispose();
  resolveProbe('HEALTHY');
  await drain();
  assert.deepEqual(states, []);
  assert.equal(clock.pendingDelays().length, 0);
});

test('single-flight: a superseded generation completion is inert after dispose + retrigger (I8)', async () => {
  const resolvers = [];
  let launchdCalls = 0;
  const clock = makeClock();
  const states = [];
  const lc = createLifecycle({
    resolvePort: () => 4242,
    probe: () => new Promise((r) => { resolvers.push(r); }),
    tcpAccepts: async () => false,
    launchdLoaded: async () => { launchdCalls += 1; return true; },
    onState: (s) => states.push(s),
    log: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  lc.trigger('startup');   // gen A: probe in flight
  lc.dispose();            // supersedes gen A while its probe is airborne
  lc.trigger('resume');    // new generation with its own probe
  assert.equal(resolvers.length, 2, 'the retrigger runs its own probe');
  resolvers[0]('REFUSED'); // gen A completes late: must not emit, schedule, or consult launchd
  await drain();
  assert.deepEqual(states, []);
  assert.equal(clock.pendingDelays().length, 0);
  assert.equal(launchdCalls, 0, 'stale check fires before the REFUSED branch');
  resolvers[1]('HEALTHY'); // the live generation attaches normally
  await drain();
  assert.deepEqual(states.map((s) => s.name), [STATES.ATTACH]);
  assert.equal(states[0].gen, lc.generation);
  // (Also proves the stale iterate's finally-clobber of the write-only
  // inFlight flag is behaviorally harmless — nothing observable changed.)
});

test('a new generation after attach re-emits states (dedupe is per-generation)', async () => {
  const h = harness({ probeResults: ['HEALTHY', 'HEALTHY'] });
  h.lc.trigger('startup');
  await drain();
  h.lc.trigger('did-fail-load'); // loop was idle → new generation
  await drain();
  assert.deepEqual(h.states.map((s) => s.name), [STATES.ATTACH, STATES.ATTACH]);
  assert.deepEqual(h.states.map((s) => s.gen), [1, 2]);
});

// ---------------------------------------------------------------- classifyProbe

test('classifyProbe: 200 + correct-name JSON → HEALTHY', () => {
  const body = JSON.stringify({ name: 'Central Planner', start_url: '/m/' });
  assert.equal(classifyProbe({ status: 200, body }), 'HEALTHY');
});

test('classifyProbe: wrong-name JSON / 404 / non-JSON → FOREIGN', () => {
  assert.equal(classifyProbe({ status: 200, body: JSON.stringify({ name: 'Other Thing' }) }), 'FOREIGN');
  assert.equal(classifyProbe({ status: 404, body: 'Not Found' }), 'FOREIGN');
  assert.equal(classifyProbe({ status: 200, body: '<html>not json</html>' }), 'FOREIGN');
  assert.equal(classifyProbe({ status: 500, body: JSON.stringify({ name: 'Central Planner' }) }), 'FOREIGN');
  assert.equal(classifyProbe({ status: 200, body: 'null' }), 'FOREIGN');
});

// ---------------------------------------------------------------- probe() mapping

test('probe: fetch success paths classify via classifyProbe', async () => {
  const ok = { status: 200, text: async () => JSON.stringify({ name: 'Central Planner' }) };
  assert.equal(await probe({ port: 1, fetchImpl: async () => ok }), 'HEALTHY');
  const notFound = { status: 404, text: async () => 'nope' };
  assert.equal(await probe({ port: 1, fetchImpl: async () => notFound }), 'FOREIGN');
});

test('probe: ECONNREFUSED in the cause chain → REFUSED', async () => {
  const err = new Error('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4242'), { code: 'ECONNREFUSED' });
  assert.equal(await probe({ port: 1, fetchImpl: () => Promise.reject(err) }), 'REFUSED');
});

test('probe: AggregateError containing ECONNREFUSED → REFUSED', async () => {
  const err = new Error('fetch failed');
  err.cause = new AggregateError(
    [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })], 'all attempts failed');
  assert.equal(await probe({ port: 1, fetchImpl: () => Promise.reject(err) }), 'REFUSED');
});

test('probe: TimeoutError → TIMEOUT', async () => {
  const err = new DOMException('signal timed out', 'TimeoutError');
  assert.equal(await probe({ port: 1, fetchImpl: () => Promise.reject(err) }), 'TIMEOUT');
});

test('probe: unexpected network error (EHOSTUNREACH) → TIMEOUT with a log line', async () => {
  const logs = [];
  const err = new Error('fetch failed');
  err.cause = Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' });
  const cls = await probe({ port: 1, fetchImpl: () => Promise.reject(err), log: (l) => logs.push(l) });
  assert.equal(cls, 'TIMEOUT');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EHOSTUNREACH/);
});

// ---------------------------------------------------------------- tcpAccepts / launchdLoaded

function fakeSocket() {
  const handlers = {};
  return {
    destroyed: false,
    on(ev, fn) { handlers[ev] = fn; },
    destroy() { this.destroyed = true; },
    fire(ev) { handlers[ev]?.(); },
  };
}

test('tcpAccepts: connect → true; error → false; sync throw → false', async () => {
  const s1 = fakeSocket();
  const p1 = tcpAccepts({ port: 4242, connect: () => s1 });
  s1.fire('connect');
  assert.equal(await p1, true);
  assert.equal(s1.destroyed, true);

  const s2 = fakeSocket();
  const p2 = tcpAccepts({ port: 4242, connect: () => s2 });
  s2.fire('error');
  assert.equal(await p2, false);

  assert.equal(await tcpAccepts({ port: 4242, connect: () => { throw new Error('bad'); } }), false);
});

// The suite's ONE real timer: tcpAccepts' internal setTimeout is not
// injectable (out of T4's test-only scope), so this spends a real 10 ms.
test('tcpAccepts: silent socket times out → false', async () => {
  const s = fakeSocket();
  assert.equal(await tcpAccepts({ port: 4242, connect: () => s, timeoutMs: 10 }), false);
});

test('launchdLoaded: exit 0 → true; non-zero → false; ENOENT → false + log', async () => {
  const seen = [];
  const mk = (err) => (cmd, args, cb) => { seen.push([cmd, ...args]); cb(err); };
  assert.equal(await launchdLoaded({ execFile: mk(null) }), true);
  assert.equal(await launchdLoaded({ execFile: mk(Object.assign(new Error('exit'), { code: 113 })) }), false);
  const logs = [];
  const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
  assert.equal(await launchdLoaded({ execFile: mk(enoent), log: (l) => logs.push(l) }), false);
  assert.equal(logs.length, 1);
  // read-only query only — never anything that mutates launchd state (I1)
  assert.deepEqual(seen[0], ['launchctl', 'list', 'local.projectmanager']);
});

// ---------------------------------------------------------------- resolvePort

function installationFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-desktop-install-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'runtime'), data = path.join(dir, 'data');
  fs.mkdirSync(root); fs.mkdirSync(data);
  const owner = { version: 1, installationRoot: root, sourceRoot: path.join(dir, 'source'), dataRoot: data };
  const config = { version: 1, sourceRoot: owner.sourceRoot, dataRoot: data,
    active: 'release-12345678-1234-1234-1234-123456789abc', previous: null };
  const marker = path.join(root, '.central-planner-installation.json');
  const pointer = path.join(root, 'deployment.json');
  fs.writeFileSync(marker, JSON.stringify(owner));
  fs.writeFileSync(pointer, JSON.stringify(config));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port: 4545 }));
  return { root, data, marker, pointer, owner, config };
}

test('installed data-root port is resolved before probing and overrides inherited legacy CP_ROOT', t => {
  const f = installationFixture(t);
  assert.equal(installationDataRoot(f.root), f.data);
  assert.equal(resolvePort({ repoRoot: f.root, env: {} }), 4545);
  assert.equal(resolvePort({ repoRoot: f.root, env: { CP_ROOT: '/stale-checkout' } }), 4545);
  assert.equal(resolvePort({ repoRoot: f.root, env: { CP_ROOT: '/stale-checkout', CP_PORT: '4567' } }), 4567);
});

test('installed pointer disagreement, missing marker and missing data fail closed', t => {
  const f = installationFixture(t);
  fs.writeFileSync(f.pointer, JSON.stringify({ ...f.config, dataRoot: '/different-data' }));
  assert.throws(() => resolvePort({ repoRoot: f.root, env: {} }), /disagree/);
  fs.writeFileSync(f.pointer, JSON.stringify(f.config));
  fs.renameSync(f.marker, `${f.marker}.saved`);
  assert.throws(() => resolvePort({ repoRoot: f.root, env: { CP_PORT: '4242' } }), /metadata/);
  fs.renameSync(`${f.marker}.saved`, f.marker);
  fs.renameSync(f.data, `${f.data}.saved`);
  assert.throws(() => resolvePort({ repoRoot: f.root, env: {} }), /missing or changed/);
});

test('installed symlink metadata and redirected data roots cannot choose a different dashboard', t => {
  const f = installationFixture(t);
  fs.renameSync(f.pointer, `${f.pointer}.saved`);
  fs.symlinkSync(`${f.pointer}.saved`, f.pointer);
  assert.throws(() => installationDataRoot(f.root), /metadata/);
  fs.unlinkSync(f.pointer);
  fs.renameSync(`${f.pointer}.saved`, f.pointer);
  fs.renameSync(f.data, `${f.data}.saved`);
  fs.symlinkSync(`${f.data}.saved`, f.data);
  assert.throws(() => installationDataRoot(f.root), /missing or changed/);
});

test('legacy selected checkout uses its own nondefault port without changing CP_ROOT precedence', t => {
  const f = installationFixture(t);
  fs.unlinkSync(f.pointer); fs.unlinkSync(f.marker);
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ port: 4646 }));
  assert.equal(installationDataRoot(f.root), null);
  assert.equal(resolvePort({ repoRoot: f.root, env: {} }), 4646);
  assert.equal(resolvePort({ repoRoot: f.root, env: { CP_ROOT: f.data } }), 4545);
});

test('invalid installation configuration emits failure without probing or starting a server', async () => {
  const states = [], clock = makeClock();
  let calls = 0;
  const lifecycle = createLifecycle({ resolvePort: () => { throw new Error('invalid installation'); },
    probe: async () => { calls++; }, tcpAccepts: async () => { calls++; },
    launchdLoaded: async () => { calls++; }, startServer: async () => { calls++; },
    onState: value => states.push(value), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  lifecycle.trigger();
  await drain();
  assert.equal(calls, 0);
  assert.equal(states[0].name, STATES.SERVER_FAILED);
  assert.match(states[0].reason, /invalid installation/);
  await clock.advance(5000);
  assert.equal(calls, 0);
  lifecycle.dispose();
});

test('desktop probe lookup remains non-interactive and uses the same selected root as startup', () => {
  const source = fs.readFileSync(path.join(DESKTOP_DIR, 'main.js'), 'utf8');
  assert.match(source, /resolvePort: \(\) => resolvePort\(\{ log, repoRoot: knownRepoRoot\(\)\?\.root \}\)/);
  assert.match(source, /getPort: \(\) => resolvePort\(\{ log, repoRoot: knownRepoRoot\(\)\?\.root \}\)/);
  const known = source.slice(source.indexOf('function knownRepoRoot()'), source.indexOf('function resolveRepoRoot()'));
  assert.equal(known.includes('showOpenDialog'), false);
  assert.match(known, /persisted/);
  assert.match(known, /packaged hint/);
  const start = source.slice(source.indexOf('function startOwnedServer(port)'), source.indexOf('async function stopOwnedServer'));
  assert.match(start, /if \(resolvePort\(\{ log, repoRoot \}\) !== port\)/);
  assert.ok(start.indexOf("trigger('server-location-selected')") < start.indexOf('spawn(node'));
});

test('first-start selection re-probes a newly discovered port without stale-generation startup', async () => {
  const states = [], probes = [], clock = makeClock();
  let port = 4242, starts = 0;
  const lifecycle = createLifecycle({ resolvePort: () => port,
    probe: async value => { probes.push(value); return value === 4545 ? 'HEALTHY' : 'REFUSED'; },
    tcpAccepts: async () => false, launchdLoaded: async () => false,
    startServer: () => {
      starts++;
      port = 4545; // the non-interactive candidates were empty; the picker found this root
      queueMicrotask(() => { lifecycle.dispose(); lifecycle.trigger('server-location-selected'); });
      return Promise.resolve();
    },
    onState: value => states.push(value), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  lifecycle.trigger();
  await drain();
  assert.deepEqual(probes, [4242, 4545]);
  assert.equal(starts, 1);
  assert.equal(states.at(-1).name, STATES.ATTACH);
  assert.equal(states.at(-1).port, 4545);
  await clock.advance(20000);
  assert.deepEqual(probes, [4242, 4545]);
  lifecycle.dispose();
});

test('resolvePort: invalid CP_PORT values fall through WITH a log line', () => {
  for (const bad of ['abc', '0', '70000', '12.5']) {
    const logs = [];
    const port = resolvePort({
      env: { CP_PORT: bad },
      readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      log: (l) => logs.push(l),
    });
    assert.equal(port, 4242, `CP_PORT=${bad}`);
    assert.equal(logs.length, 1, `CP_PORT=${bad} must log`);
    assert.match(logs[0], /CP_PORT/);
  }
});

test('resolvePort: valid CP_PORT wins without touching config.json', () => {
  let reads = 0;
  const readFile = () => { reads += 1; throw new Error('should not be called'); };
  assert.equal(resolvePort({ env: { CP_PORT: '65535' }, readFile }), 65535);
  assert.equal(resolvePort({ env: { CP_PORT: '4243' }, readFile }), 4243);
  assert.equal(reads, 0);
});

test('resolvePort: config.json "port" honored; CP_ROOT picks the config path', () => {
  const asked = [];
  const readFile = (p) => { asked.push(p); return JSON.stringify({ port: 4243 }); };
  assert.equal(resolvePort({ env: { CP_ROOT: '/cfgroot' }, readFile }), 4243);
  assert.equal(asked[0], path.join(path.resolve('/cfgroot'), 'config.json'));
  // CP_ROOT wins over the injected test-only repoRoot (mirrors config.js:24)
  asked.length = 0;
  resolvePort({ env: { CP_ROOT: '/cfgroot' }, repoRoot: '/elsewhere', readFile });
  assert.equal(asked[0], path.join(path.resolve('/cfgroot'), 'config.json'));
});

test('resolvePort: default config root is the parent of desktop/', () => {
  const asked = [];
  const readFile = (p) => { asked.push(p); throw new Error('ENOENT'); };
  resolvePort({ env: {}, readFile });
  assert.equal(asked[0], path.join(path.resolve(DESKTOP_DIR, '..'), 'config.json'));
});

test('resolvePort: missing config → 4242 silently; malformed / invalid port → 4242 with log', () => {
  const silent = [];
  const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(resolvePort({ env: {}, readFile: missing, log: (l) => silent.push(l) }), 4242);
  assert.deepEqual(silent, []); // fresh clone is normal — no log noise

  const logs1 = [];
  assert.equal(resolvePort({ env: {}, readFile: () => '{not json', log: (l) => logs1.push(l) }), 4242);
  assert.equal(logs1.length, 1);

  const logs2 = [];
  assert.equal(resolvePort({ env: {}, readFile: () => JSON.stringify({ port: 0 }), log: (l) => logs2.push(l) }), 4242);
  assert.equal(logs2.length, 1);

  // absent "port" key → silent default
  const logs3 = [];
  assert.equal(resolvePort({ env: {}, readFile: () => JSON.stringify({ user: { name: 'x' } }), log: (l) => logs3.push(l) }), 4242);
  assert.deepEqual(logs3, []);
});

// ------------------------------------------------------------ themeFromBackground

test('themeFromBackground: page background classifies chrome theme in both directions', () => {
  assert.equal(themeFromBackground('rgb(247, 246, 243)'), 'light');  // app light --bg
  assert.equal(themeFromBackground('rgb(20, 22, 26)'), 'dark');      // app dark --bg
  assert.equal(themeFromBackground('rgb(247 246 243)'), 'light');    // modern space syntax
  assert.equal(themeFromBackground('rgba(20, 22, 26, 0.9)'), 'dark');
});

test('themeFromBackground: no signal → null (never flips the chrome blindly)', () => {
  assert.equal(themeFromBackground('rgba(0, 0, 0, 0)'), null); // transparent
  assert.equal(themeFromBackground('transparent'), null);
  assert.equal(themeFromBackground(''), null);
  assert.equal(themeFromBackground(undefined), null);
  assert.equal(themeFromBackground('#f7f6f3'), null); // computed styles are rgb(); hex is out of contract
});

// ---------------------------------------------------------------- sanitizeBounds

const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

test('sanitizeBounds: off-screen or garbage → null (caller re-centers, F24)', () => {
  assert.equal(sanitizeBounds({ x: 5000, y: 5000, width: 800, height: 600 }, [DISPLAY]), null);
  assert.equal(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, [DISPLAY]), null);
  assert.equal(sanitizeBounds({ x: 0, y: 0, width: 800 }, [DISPLAY]), null);           // missing height
  assert.equal(sanitizeBounds({ x: 0, y: 0, width: 0, height: 0 }, [DISPLAY]), null);  // degenerate
  assert.equal(sanitizeBounds({ x: 0, y: 0, width: 800, height: 600 }, []), null);     // no displays
  assert.equal(sanitizeBounds(null, [DISPLAY]), null);
  // only 50 px overlaps the display — below the 100 px visibility threshold
  assert.equal(sanitizeBounds({ x: 1870, y: 0, width: 800, height: 600 }, [DISPLAY]), null);
});

test('sanitizeBounds: bounds overlapping a display ≥100×100 px are returned unchanged', () => {
  const b = { x: 100, y: 100, width: 800, height: 600 };
  assert.equal(sanitizeBounds(b, [DISPLAY]), b);
  // straddling: mostly off the first display, enough overlap on a second
  const second = { workArea: { x: 1920, y: 0, width: 1440, height: 900 } };
  const straddle = { x: 1800, y: 0, width: 800, height: 600 };
  assert.equal(sanitizeBounds(straddle, [DISPLAY, second]), straddle);
});

// ---------------------------------------------------------------- shouldIntervene

test('shouldIntervene filter table (G12/F11)', () => {
  const gen = 2;
  assert.equal(shouldIntervene({ isMainFrame: false, errorCode: -102 }, gen), false);
  assert.equal(shouldIntervene({ isMainFrame: true, errorCode: -3 }, gen), false); // ERR_ABORTED
  assert.equal(shouldIntervene(
    { isMainFrame: true, errorCode: -102, validatedURL: 'file:///x/connecting.html#absent' }, gen), false);
  assert.equal(shouldIntervene(
    { isMainFrame: true, errorCode: -102, validatedURL: 'http://127.0.0.1:4242/', generation: 1 }, gen), false);
  assert.equal(shouldIntervene(
    { isMainFrame: true, errorCode: -102, validatedURL: 'http://127.0.0.1:4242/', generation: 2 }, gen), true);
  // undefined generation (untagged renderer navigation) is NOT stale
  assert.equal(shouldIntervene(
    { isMainFrame: true, errorCode: -102, validatedURL: 'http://127.0.0.1:4242/' }, gen), true);
  assert.equal(shouldIntervene(null, gen), false);
});

// ---------------------------------------------------------------- shellLog

test('shellLog: cap trips a single rotation to shell.log.1; second trip overwrites it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shelllog-'));
  try {
    const sl = shellLog(dir, { maxBytes: 200, now: () => new Date('2026-08-07T12:00:00Z') });
    // each entry ≈ 103 bytes (25-byte timestamp prefix + 77-char line + \n):
    // the 200-byte cap trips on the second write
    sl.log('first-batch line aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    sl.log('first-batch line bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const rotated1 = fs.readFileSync(path.join(dir, 'shell.log.1'), 'utf8');
    assert.match(rotated1, /first-batch line aaaa/);
    assert.match(rotated1, /first-batch line bbbb/);
    assert.ok(!fs.existsSync(path.join(dir, 'shell.log'))); // fresh log starts on next write
    sl.log('after-rotation line');
    const fresh = fs.readFileSync(path.join(dir, 'shell.log'), 'utf8');
    assert.match(fresh, /after-rotation line/);
    assert.ok(!fresh.includes('first-batch'));
    // trip the cap again: .1 is OVERWRITTEN — never a .2
    sl.log('second-batch line dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
    sl.log('second-batch line eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    const rotated2 = fs.readFileSync(path.join(dir, 'shell.log.1'), 'utf8');
    assert.match(rotated2, /second-batch/);
    assert.ok(!rotated2.includes('first-batch'));
    assert.ok(!fs.existsSync(path.join(dir, 'shell.log.2')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shellLog: pre-existing file size counts toward the cap (survives restarts)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shelllog-'));
  try {
    fs.writeFileSync(path.join(dir, 'shell.log'), 'x'.repeat(190));
    const sl = shellLog(dir, { maxBytes: 200 });
    sl.log('tips the counter over the cap');
    assert.ok(fs.existsSync(path.join(dir, 'shell.log.1')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shellLog: auto-creates the directory; write errors are swallowed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shelllog-'));
  try {
    const nested = path.join(base, 'nested', 'logs');
    const sl = shellLog(nested);
    sl.log('hello');
    assert.match(fs.readFileSync(path.join(nested, 'shell.log'), 'utf8'), /hello/);
    // make the dir unwritable — log() must not throw (logging never crashes the shell)
    fs.chmodSync(nested, 0o555);
    try {
      assert.doesNotThrow(() => sl.log('into a read-only dir'));
    } finally {
      fs.chmodSync(nested, 0o755);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- notifier fakes

// FakeWS mimics the native-WebSocket property-handler surface the notifier
// uses (onopen/onmessage/onclose/onerror) plus test drivers to script frames.
// Frames are the real events.js wire shape: JSON {type, payload}.
function makeWsClass() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
    }
    close() { this.closed = true; }
    // drivers
    open() { this.onopen?.({}); }
    frame(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
    raw(str) { this.onmessage?.({ data: str }); }
    fail() { this.onerror?.({}); this.onclose?.({}); } // real sockets double-fire error-then-close
    end() { this.onclose?.({}); }
  }
  return { WS: FakeWS, sockets };
}

function makeNotifClass() {
  const banners = [];
  class FakeNotification {
    constructor({ title, body } = {}) {
      this.title = title;
      this.body = body;
      this.shown = false;
      this.closedCount = 0;
      this.handlers = {};
      banners.push(this);
    }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { this.shown = true; }
    close() { this.closedCount += 1; }
    // drivers
    click() { this.handlers.click?.(); }
    failDelivery(err) { this.handlers.failed?.({}, err); }
  }
  return { Notif: FakeNotification, banners };
}

// Bundles fake clock + WS + Notification + tmpdir state file + spies. Passing
// `statePath` reuses an earlier harness's file (restart tests) and skips the
// tmpdir (the caller owns cleanup of that dir).
function notifierHarness({ focused = () => false, statePath, onClick, ws, WSImpl } = {}) {
  const clock = makeClock();
  const wsPair = ws ?? makeWsClass();
  const notifs = makeNotifClass();
  const logs = [];
  const clicks = [];
  const dir = statePath ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'cp-notify-'));
  const sp = statePath ?? path.join(dir, 'notify-state.json');
  const notifier = createNotifier({
    getPort: () => 4242,
    WebSocketImpl: WSImpl ?? wsPair.WS,
    NotificationImpl: notifs.Notif,
    statePath: sp,
    isFocusedOnProject: focused,
    onClick: onClick ?? ((p) => clicks.push(p)),
    log: (l) => logs.push(l),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  return {
    notifier, clock, sockets: wsPair.sockets, banners: notifs.banners, logs, clicks, statePath: sp,
    stateFileKeys() { return JSON.parse(fs.readFileSync(sp, 'utf8')).entries.map((e) => e[0]); },
    cleanup() {
      try { notifier.dispose(); } catch { /* already disposed */ }
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const mkTask = (over = {}) =>
  ({ id: 't1', title: 'My task', status: 'waiting', question: null, handoff: null, ...over });

test('notifier: turn-end mute suppresses snapshot and live alerts, preserves approvals, and prevents replay', () => {
  const h = notifierHarness();
  try {
    h.notifier.start(); const s = h.sockets[0]; s.open();
    const task = mkTask({ question: 'A question', handoff: { summary: 'done' } });
    s.frame('state', { notifications: { turnEnd: false }, tasks: { p: [task] } });
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'Another question' }) });
    s.frame('session:status', { project: 'p', id: 't1', error: 'boom' });
    s.frame('session:status', { project: 'p', id: 't1', error: 'auth expired', authNeeded: true });
    assert.equal(h.banners.length, 0);
    assert.ok(h.logs.some(l => l.includes('turn-end alerts disabled')));
    s.frame('session:permission', { project: 'p', id: 't1', requestId: 42 });
    assert.equal(h.banners.length, 1);
    s.frame('state', { notifications: { turnEnd: true }, tasks: { p: [task] } });
    assert.equal(h.banners.length, 1, 'muted identities do not replay');
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'A fresh question' }) });
    assert.equal(h.banners.length, 2);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- notifier event map

test('notifier: F1 regression, pinned forever — question/handoff on session:status are IGNORED', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('state', { tasks: { p: [mkTask()] } }); // seeds the title, banners nothing
    // question/handoff keys riding session:status must never banner — they
    // only ever reach the wire via task:update (sessions.js updateTask()).
    s.frame('session:status', {
      project: 'p', id: 't1', status: 'waiting',
      question: 'Deploy the fix?', handoff: { summary: 'done' },
    });
    assert.equal(h.banners.length, 0);
    // with error present, exactly ONE banner — turn failed; still no question/handoff
    s.frame('session:status', {
      project: 'p', id: 't1', status: 'error', error: 'boom',
      question: 'Deploy the fix?', handoff: { summary: 'done' },
    });
    assert.equal(h.banners.length, 1);
    assert.equal(h.banners[0].title, '✗ My task — turn failed');
    assert.ok(!h.banners[0].body.includes('boom'), 'error text never in a banner (privacy)');
    assert.ok(!h.banners[0].body.includes('Deploy'), 'question text never in a banner');
  } finally { h.cleanup(); }
});

test('notifier: permission banners once, clears + forgets on :resolved', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('state', { tasks: { p: [mkTask()] } });
    const perm = { project: 'p', id: 't1', requestId: 42, tool: 'Bash', input: { command: 'rm -rf /tmp/x' } };
    s.frame('session:permission', perm);
    assert.equal(h.banners.length, 1);
    assert.equal(h.banners[0].title, '⏳ approval needed — My task');
    assert.ok(!h.banners[0].body.includes('Bash') && !h.banners[0].body.includes('rm -rf'),
      'tool/input never in a banner (privacy)');
    s.frame('session:permission', perm); // duplicate → deduped
    assert.equal(h.banners.length, 1);
    s.frame('session:permission:resolved', { project: 'p', id: 't1', requestId: 42, allow: true });
    assert.equal(h.banners[0].closedCount, 1, 'live banner closed on resolve');
    s.frame('session:permission:resolved', { requestId: 99 }); // unknown → no-op
    assert.equal(h.banners[0].closedCount, 1);
    // identity forgotten: the same requestId (restart replay) banners again
    s.frame('session:permission', perm);
    assert.equal(h.banners.length, 2);
  } finally { h.cleanup(); }
});

test('notifier: :resolved after a shell restart still deletes the persisted perm identity', () => {
  const h1 = notifierHarness();
  let h2;
  try {
    h1.notifier.start();
    h1.sockets[0].open();
    h1.sockets[0].frame('session:permission', { project: 'p', id: 't1', requestId: 7 });
    assert.equal(h1.banners.length, 1);
    assert.ok(h1.stateFileKeys().includes('perm:7'));
    h1.notifier.dispose();

    h2 = notifierHarness({ statePath: h1.statePath });
    h2.notifier.start();
    h2.sockets[0].open();
    // no live banner to close (it died with the old shell) — the persisted
    // identity is still forgotten so a future request with this id can banner
    h2.sockets[0].frame('session:permission:resolved', { requestId: 7 });
    assert.ok(!h2.stateFileKeys().includes('perm:7'));
    h2.sockets[0].frame('session:permission', { project: 'p', id: 't1', requestId: 7 });
    assert.equal(h2.banners.length, 1);
  } finally { h2?.cleanup(); h1.cleanup(); }
});

test('notifier: question dedupe — same text once, a different text banners again', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('task:update', { project: 'p', task: mkTask() });                   // question:null → nothing
    assert.equal(h.banners.length, 0);
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) }); // null→text fires
    assert.equal(h.banners.length, 1);
    assert.equal(h.banners[0].title, '❓ My task — Claude is asking');
    assert.ok(!h.banners[0].body.includes('A?'), 'question text never in a banner');
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) }); // same → dedupe
    assert.equal(h.banners.length, 1);
    s.frame('task:update', { project: 'p', task: mkTask({ question: '' }) });   // '' is not a question
    assert.equal(h.banners.length, 1);
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'B?' }) }); // new text → new hash
    assert.equal(h.banners.length, 2);
    // no status gate on task:update transitions (the letter of the spec)
    s.frame('task:update', { project: 'p', task: mkTask({ id: 't4', status: 'running', question: 'C?' }) });
    assert.equal(h.banners.length, 3);
  } finally { h.cleanup(); }
});

test('notifier: handoff banners exactly once per task — identity carries no hash', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('task:update', { project: 'p', task: mkTask({ handoff: { summary: 'first' } }) });
    assert.equal(h.banners.length, 1);
    assert.equal(h.banners[0].title, '📋 My task — handoff recorded');
    s.frame('task:update', { project: 'p', task: mkTask({ handoff: { summary: 'rewritten' } }) });
    assert.equal(h.banners.length, 1); // h:<project>:<id> — content changes never re-banner
  } finally { h.cleanup(); }
});

test('notifier: session:status error/authNeeded banners with error-hash dedupe', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('state', { tasks: { p: [mkTask()] } });
    s.frame('session:status', { project: 'p', id: 't1', status: 'error', error: 'boom' });
    assert.equal(h.banners.length, 1);
    assert.equal(h.banners[0].title, '✗ My task — turn failed');
    s.frame('session:status', { project: 'p', id: 't1', status: 'error', error: 'boom' }); // dedupe
    assert.equal(h.banners.length, 1);
    // authNeeded takes precedence over error for the banner text
    s.frame('session:status', { project: 'p', id: 't1', authNeeded: true, error: 'auth expired' });
    assert.equal(h.banners.length, 2);
    assert.equal(h.banners[1].title, '✗ My task — sign-in needed');
    // authNeeded without error still banners (identity hashes the 'auth' fallback)
    s.frame('session:status', { project: 'p', id: 't2', authNeeded: true });
    assert.equal(h.banners.length, 3);
    assert.equal(h.banners[2].title, '✗ t2 — sign-in needed'); // no snapshot title → id fallback
  } finally { h.cleanup(); }
});

test('notifier: pre-snapshot banner titles fall back to the task id', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('session:permission', { project: 'p', id: 't7', requestId: 1 });
    assert.equal(h.banners[0].title, '⏳ approval needed — t7');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- reconciliation + persistence

test('notifier: snapshot reconciliation fires exactly once, waiting-only', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    const snapshot = { tasks: {
      p: [
        mkTask({ question: 'Q1?' }),                              // waiting + question → banner
        mkTask({ id: 't2', status: 'running', question: 'Q2?' }), // not waiting → no banner
        mkTask({ id: 't3', handoff: { summary: 'done' } }),       // waiting + handoff → banner
      ],
      bad: 'not-an-array', // shape tolerance
    } };
    s.frame('state', snapshot);
    assert.deepEqual(h.banners.map((b) => b.title),
      ['❓ My task — Claude is asking', '📋 My task — handoff recorded']);
    s.frame('state', snapshot); // second snapshot (reconnects re-send it) → silent
    assert.equal(h.banners.length, 2);
    // the same question arriving live is the SAME identity — membership dedupe
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'Q1?' }) });
    assert.equal(h.banners.length, 2);
  } finally { h.cleanup(); }
});

test('notifier: restart with persisted notify-state fires none', () => {
  const h1 = notifierHarness();
  let h2;
  try {
    h1.notifier.start();
    h1.sockets[0].open();
    const snapshot = { tasks: { p: [mkTask({ question: 'Q?' }), mkTask({ id: 't3', handoff: { x: 1 } })] } };
    h1.sockets[0].frame('state', snapshot);
    assert.equal(h1.banners.length, 2);
    h1.notifier.dispose();

    h2 = notifierHarness({ statePath: h1.statePath });
    h2.notifier.start();
    h2.sockets[0].open();
    h2.sockets[0].frame('state', snapshot);
    assert.equal(h2.banners.length, 0, 'a restart neither re-fires old banners nor loses its place');
  } finally { h2?.cleanup(); h1.cleanup(); }
});

test('notifier: an approval absent from the snapshot never resurrects (best-effort, R6)', async () => {
  const h1 = notifierHarness();
  let h2;
  try {
    h1.notifier.start();
    h1.sockets[0].open();
    // Snapshots never carry pending approvals — the server keeps them in
    // session memory only — so a banner missed while disconnected is gone
    // for good (accepted best-effort; ntfy stays the durable channel).
    const snapshot = { tasks: { p: [mkTask()] } };
    h1.sockets[0].frame('state', snapshot);
    h1.sockets[0].frame('session:permission', { project: 'p', id: 't1', requestId: 5 });
    assert.equal(h1.banners.length, 1);
    // reconnect: the re-sent snapshot has no approval in it → nothing resurrects
    h1.sockets[0].fail();
    await h1.clock.advance(5000);
    assert.equal(h1.sockets.length, 2);
    h1.sockets[1].open();
    h1.sockets[1].frame('state', snapshot);
    assert.equal(h1.banners.length, 1, 'reconnect snapshot must not re-fire the approval');
    h1.notifier.dispose();

    // shell restart on the same persisted state: still silent — and even a
    // verbatim replay of the permission frame stays deduped by the persisted
    // 'perm:5' identity (no :resolved ever arrived to forget it)
    h2 = notifierHarness({ statePath: h1.statePath });
    h2.notifier.start();
    h2.sockets[0].open();
    h2.sockets[0].frame('state', snapshot);
    assert.equal(h2.banners.length, 0);
    h2.sockets[0].frame('session:permission', { project: 'p', id: 't1', requestId: 5 });
    assert.equal(h2.banners.length, 0, 'persisted perm identity still dedupes the replay');
  } finally { h2?.cleanup(); h1.cleanup(); }
});

test('notifier: corrupt state file logs and starts empty; banners still fire', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-notify-'));
  const sp = path.join(dir, 'notify-state.json');
  fs.writeFileSync(sp, '{{{ not json');
  const h = notifierHarness({ statePath: sp });
  try {
    h.notifier.start();
    assert.ok(h.logs.some((l) => /state unparseable/.test(l)));
    h.sockets[0].open();
    h.sockets[0].frame('task:update', { project: 'p', task: mkTask({ question: 'Q?' }) });
    assert.equal(h.banners.length, 1);
  } finally { h.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('notifier: notified identities prune to 500 oldest-first in the state file', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    for (let i = 0; i <= 500; i += 1) { // 501 distinct question identities
      s.frame('task:update', { project: 'p', task: mkTask({ question: `q${i}?` }) });
    }
    assert.equal(h.banners.length, 501);
    const fired = h.logs.filter((l) => l.startsWith('notify: fired ')).map((l) => l.slice('notify: fired '.length));
    const keys = h.stateFileKeys();
    assert.equal(keys.length, 500);
    assert.ok(!keys.includes(fired[0]), 'oldest identity pruned');
    assert.ok(keys.includes(fired.at(-1)), 'newest identity kept');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- suppression, click, delivery

test('notifier: focused-on-project suppression — logged, recorded, project-scoped', () => {
  let focusedProject = 'p';
  const h = notifierHarness({ focused: (proj) => proj === focusedProject });
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) });
    assert.equal(h.banners.length, 0, 'no banner while watching that project');
    const supLine = h.logs.find((l) => /^notify: suppressed q:p:t1:/.test(l));
    assert.ok(supLine, 'suppression still goes to the shell log');
    // recorded as notified: unfocusing does NOT replay it
    focusedProject = null;
    s.frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) });
    assert.equal(h.banners.length, 0);
    assert.ok(h.stateFileKeys().includes(supLine.match(/suppressed (\S+)/)[1]));
    // a different project's moment always banners (R8: project-scoped)
    focusedProject = 'p';
    s.frame('task:update', { project: 'other', task: mkTask({ id: 't9', question: 'B?' }) });
    assert.equal(h.banners.length, 1);
  } finally { h.cleanup(); }
});

test('notifier: click → onClick(project); delivery failure and throwing click handler → log', () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    h.sockets[0].open();
    h.sockets[0].frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) });
    const b = h.banners[0];
    b.failDelivery('XPC connection interrupted'); // G7 — signature-vs-permission triage evidence
    assert.ok(h.logs.some((l) => /delivery failed/.test(l)));
    b.click();
    assert.deepEqual(h.clicks, ['p']);
  } finally { h.cleanup(); }

  const h2 = notifierHarness({ onClick: () => { throw new Error('window destroyed'); } });
  try {
    h2.notifier.start();
    h2.sockets[0].open();
    h2.sockets[0].frame('task:update', { project: 'p', task: mkTask({ question: 'A?' }) });
    assert.doesNotThrow(() => h2.banners[0].click());
    assert.ok(h2.logs.some((l) => /click handler failed/.test(l)));
  } finally { h2.cleanup(); }
});

test('notifier: unparseable/garbage frames are tolerated and still count as liveness', async () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s = h.sockets[0];
    s.open();                       // watchdog armed → would fire at t=60 s
    await h.clock.advance(30000);
    s.raw('{nope');                 // rearms the watchdog (any inbound frame), then logs
    s.raw('null');
    s.raw('"str"');
    s.frame('task:update', {});                  // shape-guarded → silent
    s.frame('task:update', { project: 'p' });    // no task → silent
    s.frame('session:permission', {});           // no requestId → silent
    s.frame('state', {});                        // no tasks → silent
    s.frame('state', { tasks: 'x' });            // wrong shape → silent
    assert.equal(h.banners.length, 0);
    assert.ok(h.logs.some((l) => /unparseable frame/.test(l)));
    await h.clock.advance(45000);   // t=75 s — past the ORIGINAL 60 s deadline
    assert.equal(h.sockets.length, 1, 'garbage frame at 30 s reset the watchdog');
    await h.clock.advance(20000);   // t=95 s — past the reset deadline (90 s)
    assert.equal(h.sockets.length, 2);
    // and the link still works: a real frame on the new socket banners
    h.sockets[1].open();
    h.sockets[1].frame('task:update', { project: 'p', task: mkTask({ question: 'Q?' }) });
    assert.equal(h.banners.length, 1);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------- watchdog + backoff + kick

test('notifier: 60 s of silence → terminate + IMMEDIATE reconnect; a tick resets the timer', async () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    const s1 = h.sockets[0];
    s1.open();                       // armed → fires at 60 s
    await h.clock.advance(30000);
    s1.frame('tick', { t: 1 });      // reset → fires at 90 s
    await h.clock.advance(45000);    // t=75 s
    assert.equal(h.sockets.length, 1, 'tick at 30 s pushed the deadline to 90 s');
    await h.clock.advance(15000);    // t=90 s — watchdog fires
    assert.equal(s1.closed, true);
    assert.equal(h.sockets.length, 2, 'reconnect is immediate, not via backoff');
    assert.ok(h.logs.some((l) => /watchdog/.test(l)));
  } finally { h.cleanup(); }
});

test('notifier: backoff climbs 5→10→20 s, resets ONLY on an inbound frame (not bare open)', async () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    h.sockets[0].fail();             // → reconnect in 5000
    await h.clock.advance(5000);
    h.sockets[1].fail();             // → reconnect in 10000
    await h.clock.advance(10000);
    h.sockets[2].open();             // bare open must NOT reset the ladder
    h.sockets[2].fail();             // → reconnect in 20000
    await h.clock.advance(20000);
    h.sockets[3].open();
    h.sockets[3].frame('tick', { t: 1 }); // an inbound frame resets to 5 s
    h.sockets[3].fail();             // → reconnect in 5000
    const delays = h.logs
      .map((l) => l.match(/^notify: reconnect in (\d+) ms$/))
      .filter(Boolean).map((m) => Number(m[1]));
    // exact sequence also proves the error-then-close double-fire schedules ONE reconnect
    assert.deepEqual(delays, [5000, 10000, 20000, 5000]);
  } finally { h.cleanup(); }
});

test('notifier: connects/minute bound against an always-failing server (I3/G9)', async () => {
  const h = notifierHarness();
  try {
    h.notifier.start();
    let failed = 0;
    const failNew = () => {
      while (failed < h.sockets.length) { h.sockets[failed].fail(); failed += 1; }
    };
    failNew();
    for (let t = 0; t < 300000; t += 1000) {
      await h.clock.advance(1000);
      failNew();
      assert.ok(h.sockets.filter((s) => !s.closed).length <= 1, 'at most one live socket ever (I3)');
    }
    // delays 5+10+20+40+60+60+60 s → connects at 0,5,15,35,75,135,195,255 s.
    // Exactly 8 over 5 minutes: more means the doubling/cap ladder was broken
    // (a storm), fewer means the 60 s cap was removed (unbounded climb).
    assert.equal(h.sockets.length, 8);
  } finally { h.cleanup(); }
});

test('notifier: kick() reconnects immediately, clears pending backoff, is inert before start()', async () => {
  const h = notifierHarness();
  try {
    h.notifier.kick();               // before start → no socket (started guard)
    assert.equal(h.sockets.length, 0);
    h.notifier.start();
    assert.equal(h.notifier.connected, false);
    const s1 = h.sockets[0];
    s1.open();
    assert.equal(h.notifier.connected, true);
    h.notifier.kick();               // healthy socket: dropped + replaced NOW (post-wake suspicion)
    assert.equal(s1.closed, true);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.notifier.connected, false);
    h.sockets[1].fail();             // → backoff timer pending
    assert.equal(h.clock.pendingDelays().length, 1);
    h.notifier.kick();               // skips the pending backoff entirely
    assert.equal(h.sockets.length, 3);
    assert.equal(h.clock.pendingDelays().length, 0, 'pending reconnect timer cleared');
  } finally { h.cleanup(); }
});

test('notifier: WebSocketImpl constructor throw → logged, retried via backoff, never a crash', async () => {
  const ws = makeWsClass();
  let boom = 1;
  class ThrowFirst {
    constructor(url) {
      if (boom > 0) { boom -= 1; throw new Error('EBADSOCKET'); }
      return new ws.WS(url); // constructor-return: hands back a tracked FakeWS
    }
  }
  const h = notifierHarness({ ws, WSImpl: ThrowFirst });
  try {
    h.notifier.start();
    assert.equal(h.sockets.length, 0);
    assert.ok(h.logs.some((l) => /ws construct failed/.test(l)));
    await h.clock.advance(5000);
    assert.equal(h.sockets.length, 1, 'retried on the backoff schedule');
  } finally { h.cleanup(); }
});
