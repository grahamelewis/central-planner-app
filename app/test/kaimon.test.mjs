// lib/kaimon.js — the dashboard-managed warm-REPL daemon: Julia detection,
// config seeding, the single-daemon lifecycle against a fake kaimon binary,
// reaping, and the harmless-by-design gates. Imports the module DIRECTLY (it
// pulls no SDK), so this runs billing-safe with no server/session at all —
// every "daemon" here is test/fixtures/fake-kaimon.mjs, never real Julia.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BIN = path.join(__dirname, 'fixtures', 'fake-kaimon.mjs');

// env seams BEFORE the modules load: pin CP_ROOT to an empty temp dir so
// config.js never reads the developer's real config.json (whose kaimon block
// would flip kaimonEnabled and break the "enabled by default" premise), and
// pin the project table so PROJECTS mutations never touch real projects.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaimon-test-'));
const juliaRoot = path.join(root, 'julia-proj');
const plainRoot = path.join(root, 'plain-proj');
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({});
const {
  hasJuliaFile, isJuliaProject, isKaimonTool, kaimonEnabled,
  resolveKaimonBin, seedKaimonConfig, seedKaimonProjects,
  mcpFragmentFor, touch, reapDaemon, sweepOrphans, setBusyProbe,
  getKaimonStatus, startInstall,
  _daemonState, _reaperTick, _resetForTests, _resetBinCache,
} = await import('../lib/kaimon.js');
const { PROJECTS } = await import('../lib/config.js');

// throwaway trees; keep tmpdir paths (short) — never the deep scratchpads
let cfgDir, stateFile;
before(() => {
  fs.chmodSync(FAKE_BIN, 0o755);
  cfgDir = path.join(root, 'kaimon'); // acts as <XDG_CONFIG_HOME>/kaimon
  stateFile = path.join(root, '.kaimon-daemon.json');
  fs.mkdirSync(path.join(juliaRoot, 'model'), { recursive: true });
  fs.writeFileSync(path.join(juliaRoot, 'model', 'egm.jl'), '# julia\n');
  fs.writeFileSync(path.join(juliaRoot, 'Project.toml'), 'name = "JP"\n');
  fs.mkdirSync(plainRoot, { recursive: true });
  fs.writeFileSync(path.join(plainRoot, 'paper.tex'), '\\documentclass{article}\n');
  // register as dashboard projects (PROJECTS is deliberately mutable for tests)
  PROJECTS.jp = { name: 'jp', root: juliaRoot, color: '#fff', texWatch: null };
  PROJECTS.pp = { name: 'pp', root: plainRoot, color: '#fff', texWatch: null };
});
after(() => {
  _resetForTests();
  delete PROJECTS.jp;
  delete PROJECTS.pp;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => { _resetForTests(); });

// short-fuse options so failure paths don't stall the suite
const O = (extra = {}) => ({
  bin: FAKE_BIN, configDir: cfgDir, stateFile,
  waitMs: 4000, bootMs: 4000, idleMs: 60 * 60000, ...extra,
});
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return pred();
};

describe('Julia-project detection', () => {
  test('hasJuliaFile finds a *.jl a few levels down', () => {
    assert.equal(hasJuliaFile(juliaRoot), true);
  });
  test('hasJuliaFile is false without .jl / for a missing dir', () => {
    assert.equal(hasJuliaFile(plainRoot), false);
    assert.equal(hasJuliaFile(path.join(root, 'nope')), false);
  });
  test('isJuliaProject caches per project key', () => {
    assert.equal(isJuliaProject('jp'), true);
    assert.equal(isJuliaProject('pp'), false);
    assert.equal(isJuliaProject('jp', plainRoot), true, 'cached true survives an override');
  });
});

describe('tool predicate + enable gate', () => {
  test('matches only mcp__kaimon__* tools', () => {
    assert.equal(isKaimonTool('mcp__kaimon__ex'), true);
    assert.equal(isKaimonTool('mcp__kaimon__start_session'), true);
    assert.equal(isKaimonTool('Bash'), false);
    assert.equal(isKaimonTool('mcp__other__ex'), false);
    assert.equal(isKaimonTool(undefined), false);
  });
  test('enabled by default (no kaimon config block)', () => {
    assert.equal(kaimonEnabled(), true);
  });
});

describe('config seeding', () => {
  test('seeds a lax localhost config with an INTEGER created_at', () => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    assert.equal(seedKaimonConfig(O()), true);
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
    assert.equal(cfg.mode, 'lax');
    assert.deepEqual(cfg.allowed_ips, ['127.0.0.1', '::1']);
    assert.equal(Number.isInteger(cfg.created_at), true, 'Kaimon requires Int64 created_at');
    assert.equal(cfg.global_install_dismissed, true);
  });
  test('never overwrites an existing config', () => {
    const file = path.join(cfgDir, 'config.json');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, '{"mode":"strict","api_keys":["secret"]}\n');
    assert.equal(seedKaimonConfig(O()), false);
    assert.match(fs.readFileSync(file, 'utf8'), /strict/);
    fs.rmSync(file);
  });
  test('projects.json: merges Julia projects with Project.toml, preserves the rest', () => {
    const file = path.join(cfgDir, 'projects.json');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      projects: [{ project_path: '/somewhere/else', enabled: true }],
      session_prefs: { keep: 'me' }, // unknown top-level key must survive
    }));
    const added = seedKaimonProjects(O(), ['jp', 'pp']);
    assert.equal(added, 1, 'only jp qualifies (Julia + Project.toml)');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.projects.length, 2);
    assert.ok(data.projects.some((e) => e.project_path === juliaRoot));
    assert.ok(data.projects.some((e) => e.project_path === '/somewhere/else'));
    assert.deepEqual(data.session_prefs, { keep: 'me' });
    assert.equal(seedKaimonProjects(O(), ['jp']), 0, 'idempotent');
    fs.rmSync(file);
  });
});

describe('daemon lifecycle (fake binary)', () => {
  test('mcpFragmentFor boots the daemon and returns the http fragment', async () => {
    const frag = await mcpFragmentFor('jp', O());
    assert.ok(frag && frag.kaimon, 'fragment returned');
    assert.equal(frag.kaimon.type, 'http');
    assert.match(frag.kaimon.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const d = _daemonState();
    assert.equal(d.state, 'ready');
    // state file written for the orphan sweep
    const rec = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(rec.pid, d.pid);
    assert.equal(rec.ownerPid, process.pid);
  });
  test('second call reuses the running daemon (same port), and touch bumps lastUsedAt', async () => {
    const a = await mcpFragmentFor('jp', O());
    const d = _daemonState();
    const t0 = d.lastUsedAt;
    await new Promise((r) => setTimeout(r, 15));
    const b = await mcpFragmentFor('jp', O());
    assert.equal(a.kaimon.url, b.kaimon.url);
    assert.equal(_daemonState(), d, 'same daemon object');
    assert.ok(d.lastUsedAt > t0, 'reuse touched the daemon');
    touch();
  });
  test('single-flight: concurrent callers share one boot', async () => {
    const [a, b, c] = await Promise.all([
      mcpFragmentFor('jp', O()), mcpFragmentFor('jp', O()), mcpFragmentFor('jp', O()),
    ]);
    assert.ok(a && b && c);
    assert.equal(a.kaimon.url, b.kaimon.url);
    assert.equal(b.kaimon.url, c.kaimon.url);
  });
  test('non-Julia project → null, no daemon spawned', async () => {
    assert.equal(await mcpFragmentFor('pp', O()), null);
    assert.equal(_daemonState(), null);
  });
  test('missing binary → null, no daemon (the default-install path)', async () => {
    assert.equal(await mcpFragmentFor('jp', O({ bin: '/nonexistent-kaimon' })), null);
    assert.equal(_daemonState(), null);
  });
  test('reapDaemon kills the child and clears the state file', async () => {
    await mcpFragmentFor('jp', O());
    const d = _daemonState();
    assert.equal(d.state, 'ready');
    reapDaemon('test-reaped', O());
    assert.equal(_daemonState(), null);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(await waitFor(() => { try { process.kill(d.pid, 0); return false; } catch { return true; } }), true, 'child died');
  });
  test('boot failure (exit-1) retries then cools down — later calls return fast nulls', async () => {
    process.env.FAKE_KAIMON_MODE = 'exit-1';
    try {
      assert.equal(await mcpFragmentFor('jp', O()), null);
      const d = _daemonState();
      assert.equal(d.state, 'error');
      assert.ok(d.cooldownUntil > Date.now(), 'cooldown armed');
      const t0 = Date.now();
      assert.equal(await mcpFragmentFor('jp', O()), null);
      assert.ok(Date.now() - t0 < 500, 'cooldown short-circuits (no re-boot wait)');
    } finally { delete process.env.FAKE_KAIMON_MODE; }
  });
  test('never-listens → caller times out at waitMs but does not crash', async () => {
    process.env.FAKE_KAIMON_MODE = 'never-listens';
    try {
      const t0 = Date.now();
      assert.equal(await mcpFragmentFor('jp', O({ waitMs: 600, bootMs: 1200 })), null);
      assert.ok(Date.now() - t0 < 5000);
      await waitFor(() => { const d = _daemonState(); return d && d.state === 'error'; }, 5000);
    } finally { delete process.env.FAKE_KAIMON_MODE; }
  });
});

describe('idle reaper busy probe', () => {
  test('a reaper tick keeps a busy daemon warm, reaps an idle one', async () => {
    await mcpFragmentFor('jp', O());
    const d = _daemonState();
    assert.equal(d.state, 'ready');
    // drive the tick directly (the real timer fires every 60s — too slow to test)
    d.lastUsedAt = Date.now() - 10000; // stale, way past idleMs:1
    setBusyProbe(() => true);
    try {
      _reaperTick(O({ idleMs: 1 }));
      assert.equal(_daemonState(), d, 'busy daemon survived its idle deadline');
      assert.ok(Date.now() - d.lastUsedAt < 5000, 'busy tick refreshed lastUsedAt');
    } finally { setBusyProbe(() => false); }
    d.lastUsedAt = Date.now() - 10000;
    _reaperTick(O({ idleMs: 1 }));
    assert.equal(_daemonState(), null, 'idle daemon reaped once the probe is quiet');
  });
});

describe('orphan sweep', () => {
  test('dead owner + live kaimon-looking pid → killed; state file consumed', async () => {
    // a live decoy whose ps command PASSES the /kaimon/ guard: a kaimon-named
    // symlink to sleep, spawned detached so the group-kill only hits it
    const { spawn } = await import('node:child_process');
    const decoyBin = path.join(root, 'kaimon-decoy');
    if (!fs.existsSync(decoyBin)) fs.symlinkSync('/bin/sleep', decoyBin);
    const decoy = spawn(decoyBin, ['30'], { stdio: 'ignore', detached: true });
    try {
      await waitFor(() => { try { process.kill(decoy.pid, 0); return true; } catch { return false; } });
      fs.writeFileSync(stateFile, JSON.stringify({ pid: decoy.pid, port: 1, ownerPid: 999999999 }));
      assert.equal(sweepOrphans(O()), true, 'orphan swept');
      assert.equal(fs.existsSync(stateFile), false, 'state file consumed');
      assert.equal(await waitFor(() => { try { process.kill(decoy.pid, 0); return false; } catch { return true; } }), true, 'orphan died');
    } finally { try { process.kill(-decoy.pid, 'SIGKILL'); } catch { /* already gone */ } }
  });
  test('live owner → left alone (two-servers guard)', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ pid: 1, port: 1, ownerPid: process.pid }));
    assert.equal(sweepOrphans(O()), false);
  });
  test('recycled pid (command does not match kaimon) → not killed', async () => {
    // a live process whose command has no "kaimon" in it (careful: the test
    // process itself DOES — "kaimon.test.mjs" — and once SIGTERM'd itself here)
    const { spawn } = await import('node:child_process');
    const decoy = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: decoy.pid, port: 1, ownerPid: 999999999 }));
      assert.equal(sweepOrphans(O()), false, 'ps-command guard refused the kill');
      assert.equal(await waitFor(() => { try { process.kill(decoy.pid, 0); return false; } catch { return true; } }, 300), false, 'decoy survived');
    } finally { decoy.kill('SIGKILL'); }
  });
});

describe('status + install guards', () => {
  test('getKaimonStatus is sync and shaped for the snapshot', async () => {
    const s = getKaimonStatus();
    assert.equal(typeof s.enabled, 'boolean');
    assert.equal(typeof s.available, 'boolean');
    assert.equal(s.julia.jp, true);
    assert.equal(s.julia.pp, false);
    assert.equal(s.daemon, null);
    assert.equal(s.install.state, 'idle');
  });
  test('startInstall refuses in the sandbox (CP_NO_BILLED)', () => {
    process.env.CP_NO_BILLED = '1';
    try {
      const r = startInstall();
      assert.equal(r.status, 403);
      assert.match(r.error, /disabled/);
    } finally { delete process.env.CP_NO_BILLED; }
  });
  test('resolveKaimonBin honors the explicit-bin override and rejects non-executables', () => {
    _resetBinCache();
    assert.equal(resolveKaimonBin({ bin: FAKE_BIN }), FAKE_BIN);
    assert.equal(resolveKaimonBin({ bin: '/nonexistent-kaimon' }), null);
  });
});
