import test from 'node:test';
import assert from 'node:assert/strict';
import { createTailnetController, summarizeTailnet } from '../lib/tailnet.js';

const running = {
  BackendState: 'Running',
  Self: { DNSName: 'host.example.ts.net.', Online: true },
};

test('summarize: exact Central Planner root mapping is live only while connected', () => {
  const serve = { Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4242' } } } } };
  const live = summarizeTailnet(running, serve, 4242);
  assert.equal(live.state, 'live');
  assert.equal(live.configured, true);
  assert.equal(live.url, 'https://host.example.ts.net');

  const stopped = summarizeTailnet({ BackendState: 'Stopped' }, serve, 4242);
  assert.equal(stopped.state, 'disconnected');
  assert.equal(stopped.configured, true, 'saved Serve intent is distinct from reachability');
});

test('summarize: foreign root is a conflict and extra handlers make disable unsafe', () => {
  const conflict = summarizeTailnet(running, {
    Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
  }, 4242);
  assert.equal(conflict.state, 'conflict');
  assert.match(conflict.error, /9999/);

  const shared = summarizeTailnet(running, {
    Web: { 'host.example.ts.net:443': { Handlers: {
      '/': { Proxy: 'http://127.0.0.1:4242' },
      '/other': { Proxy: 'http://127.0.0.1:9999' },
    } } },
  }, 4242);
  assert.equal(shared.state, 'live');
  assert.equal(shared.shared, true);
});

function fakeController(sequence) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    calls.push([bin, ...args]);
    const next = sequence.shift();
    if (!next) return cb(new Error(`unexpected command: ${args.join(' ')}`));
    cb(next.err || null, next.stdout || '', next.stderr || '');
  };
  const ctl = createTailnetController({
    port: 4242,
    env: { CP_TAILSCALE_BIN: '/fake/tailscale' },
    execFile,
  });
  return { ctl, calls };
}

test('enable configures only the local port then re-reads authoritative status', async () => {
  const off = JSON.stringify({ Web: {} });
  const live = JSON.stringify({ Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4242' } } } } });
  const f = fakeController([
    { stdout: JSON.stringify(running) }, { stdout: off },
    { stdout: 'Serve started' },
    { stdout: JSON.stringify(running) }, { stdout: live },
  ]);
  const result = await f.ctl.enable();
  assert.equal(result.state, 'live');
  assert.deepEqual(f.calls[2], ['/fake/tailscale', 'serve', '--bg', '--yes', '4242']);
});

test('enable reconnects a stopped, already-configured Tailnet without resetting settings', async () => {
  const own = JSON.stringify({ Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4242' } } } } });
  const f = fakeController([
    { stdout: JSON.stringify({ BackendState: 'Stopped' }) }, { stdout: own },
    { stdout: 'connected' },
    { stdout: JSON.stringify(running) }, { stdout: own },
  ]);
  const result = await f.ctl.enable();
  assert.equal(result.state, 'live');
  assert.deepEqual(f.calls[2], ['/fake/tailscale', 'up', '--timeout=10s']);
  assert.ok(f.calls.every((c) => !c.includes('--reset')));
  assert.equal(f.calls.filter((c) => c.includes('serve') && c.includes('--bg')).length, 0,
    'the saved mapping comes live with the connection; it is not rewritten');
});

test('disable uses targeted off and refuses to reset a shared endpoint', async () => {
  const own = JSON.stringify({ Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4242' } } } } });
  const f = fakeController([
    { stdout: JSON.stringify(running) }, { stdout: own },
    { stdout: 'Serve stopped' },
    { stdout: JSON.stringify(running) }, { stdout: JSON.stringify({ Web: {} }) },
  ]);
  const result = await f.ctl.disable();
  assert.equal(result.configured, false);
  assert.deepEqual(f.calls[2], ['/fake/tailscale', 'serve', '--https=443', 'off']);
  assert.ok(f.calls.every((c) => !c.includes('reset')));

  const shared = JSON.stringify({ Web: { 'host.example.ts.net:443': { Handlers: {
    '/': { Proxy: 'http://127.0.0.1:4242' }, '/x': { Proxy: 'http://127.0.0.1:9' },
  } } } });
  const g = fakeController([{ stdout: JSON.stringify(running) }, { stdout: shared }]);
  await assert.rejects(g.ctl.disable(), /shares this Serve endpoint/);
  assert.equal(g.calls.length, 2);
});

test('explicit empty CP_TAILSCALE_BIN disables discovery for tests and CI', async () => {
  let called = false;
  const ctl = createTailnetController({
    env: { CP_TAILSCALE_BIN: '' },
    execFile: () => { called = true; },
  });
  const status = await ctl.refresh();
  assert.equal(status.state, 'unavailable');
  assert.equal(called, false);
});
