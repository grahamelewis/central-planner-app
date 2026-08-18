// lib/kaimon.js — dashboard-managed Kaimon warm-Julia-REPL daemon.
//
// One Kaimon daemon per machine (Kaimon's native topology — sessions are
// machine-global, keyed by project path), owned by the dashboard: lazily
// started the first time a task in an auto-detected Julia project runs a turn,
// idle-reaped when no Julia task has used it for a while, killed on server
// exit, and swept for orphans on startup. Sessions inside the daemon are per
// PROJECT and persist across turns and tasks — that is the whole point: a
// warm REPL keeps packages and state loaded, so iterative Julia doesn't
// re-spawn `julia` (and re-pay the package-load tax) every call.
//
// HARMLESS BY DESIGN. Every gate fails to "no injection, session unchanged":
//   · kaimon disabled in config      → mcpFragmentFor returns null
//   · project has no *.jl            → null
//   · no kaimon binary installed     → null (one-click install card instead)
//   · daemon fails to boot           → null (+ cooldown so turns stay fast)
//   · any error                      → null (caught)
// A session NEVER fails because Kaimon is absent or down.
//
// Deliberately imports NO SDK, so it is directly unit-testable. Test seams:
//   CP_KAIMON_BIN         path to the kaimon binary (tests point at a fake)
//   CP_KAIMON_CONFIG_DIR  where config.json/projects.json are seeded AND the
//                         daemon's XDG_CONFIG_HOME/kaimon (tests → tmpdir)
//   CP_KAIMON_CACHE_DIR   daemon's XDG_CACHE_HOME (tests → tmpdir; keep paths
//                         SHORT — unix sockets cap sun_path at ~104 chars)
//   CP_KAIMON_WAIT_MS / CP_KAIMON_IDLE_MS  timing knobs
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { PROJECTS, ROOT, KAIMON_CFG } from './config.js';
import { writeFileAtomic } from './paths.js';
import { broadcast } from './events.js';

const log = (...a) => console.log('[kaimon]', ...a);
const logErr = (...a) => console.error('[kaimon]', ...a);

// ── options (env > config.json > defaults; per-call override bag for tests) ──
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

function resolveOpts(o = {}) {
  const cfg = KAIMON_CFG || {};
  return {
    bin: o.bin !== undefined ? o.bin : (process.env.CP_KAIMON_BIN || cfg.bin || null),
    configDir: o.configDir || process.env.CP_KAIMON_CONFIG_DIR
      || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kaimon'),
    waitMs: o.waitMs ?? num(process.env.CP_KAIMON_WAIT_MS) ?? 15000,
    bootMs: o.bootMs ?? num(process.env.CP_KAIMON_BOOT_MS) ?? 120000,
    idleMs: o.idleMs ?? num(process.env.CP_KAIMON_IDLE_MS)
      ?? (cfg.idleMinutes ? cfg.idleMinutes * 60000 : 30 * 60000),
    stateFile: o.stateFile || path.join(ROOT, '.kaimon-daemon.json'),
  };
}

export function kaimonEnabled() {
  return !KAIMON_CFG || KAIMON_CFG.enabled !== false;
}

// ── Julia-project detection ─────────────────────────────────────────────────
// Bounded shallow walk: any *.jl within a few levels → Julia project. Cached
// per project so it's not a per-turn (or per-snapshot) filesystem cost.
const juliaCache = new Map(); // project → { isJulia, ts }
const JULIA_TTL_MS = 60000;

export function hasJuliaFile(dir, depth = 0) {
  if (depth > 3) return false;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  const subdirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isFile()) { if (e.name.endsWith('.jl')) return true; }
    else if (e.isDirectory()) subdirs.push(e.name);
  }
  for (const name of subdirs) {
    if (hasJuliaFile(path.join(dir, name), depth + 1)) return true;
  }
  return false;
}

// "Julia project" here means one the warm REPL can actually SERVE: it has
// *.jl files AND a root Project.toml — Kaimon's start_session hard-requires
// the latter, so injecting the tools without it would offer a session that
// can never start. A global-env Julia project (no Project.toml) falls back to
// plain Bash julia, exactly as before this feature existed.
export function isJuliaProject(project, rootOverride) {
  const c = juliaCache.get(project);
  const now = Date.now();
  if (c && now - c.ts < JULIA_TTL_MS) return c.isJulia;
  const root = rootOverride || (PROJECTS[project] && PROJECTS[project].root);
  let isJulia = false;
  try {
    isJulia = !!root && fs.existsSync(path.join(root, 'Project.toml')) && hasJuliaFile(root);
  } catch { isJulia = false; }
  juliaCache.set(project, { isJulia, ts: now });
  return isJulia;
}

// ── binary resolution ───────────────────────────────────────────────────────
// CP_KAIMON_BIN / config `kaimon.bin` > ~/.julia/bin/kaimon > PATH. Cached —
// getKaimonStatus() runs inside the sync snapshot() on every WS connect.
let binCache = { path: null, ts: 0 };
const BIN_TTL_MS = 60000;

export function resolveKaimonBin(o = {}) {
  const O = resolveOpts(o);
  if (O.bin) {
    try { fs.accessSync(O.bin, fs.constants.X_OK); return O.bin; } catch { return null; }
  }
  const now = Date.now();
  if (binCache.ts && now - binCache.ts < BIN_TTL_MS) return binCache.path;
  let found = null;
  const shim = path.join(os.homedir(), '.julia', 'bin', 'kaimon');
  try { fs.accessSync(shim, fs.constants.X_OK); found = shim; } catch { /* not there */ }
  if (!found) {
    try {
      const p = execFileSync('which', ['kaimon'], { encoding: 'utf8' }).trim();
      if (p) found = p;
    } catch { /* not on PATH */ }
  }
  binCache = { path: found, ts: now };
  return found;
}
export function _resetBinCache() { binCache = { path: null, ts: 0 }; }

// ── config seeding ──────────────────────────────────────────────────────────
// Kaimon headless errors out (non-TTY setup wizard) without a config file, so
// seed a localhost-only one on first use. NEVER overwrite an existing file —
// the user's own mode/api_keys win. `created_at` must be an INTEGER (the
// loader's Float64 default trips an InexactError in Kaimon ≤2.0.0).
export function seedKaimonConfig(o = {}) {
  const O = resolveOpts(o);
  const file = path.join(O.configDir, 'config.json');
  if (fs.existsSync(file)) return false;
  writeFileAtomic(file, JSON.stringify({
    mode: 'lax', // localhost-only, no API key — matches the dashboard's model
    api_keys: [],
    allowed_ips: ['127.0.0.1', '::1'],
    port: 0,
    created_at: Math.floor(Date.now() / 1000),
    global_install_dismissed: true, // never TTY-prompt about the global env
  }, null, 2) + '\n');
  log('seeded', file);
  return true;
}

// `start_session{project_path}` (how a project's warm REPL is created) checks
// this allowlist, so every dashboard Julia project with a root Project.toml is
// merged in. Merge-only: existing entries and unknown top-level keys survive.
const seededProjects = new Set(); // project keys ensured this process run

export function seedKaimonProjects(o = {}, projectKeys = Object.keys(PROJECTS)) {
  const O = resolveOpts(o);
  const file = path.join(O.configDir, 'projects.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // an EXISTING but unreadable allowlist must not be silently clobbered
    // (the repo's corruption discipline: move it aside, start fresh)
    if (fs.existsSync(file)) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
        logErr(`projects.json unreadable (${err.message}) — moved to ${aside}`);
      } catch { /* best effort */ }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const entries = Array.isArray(data.projects) ? data.projects : [];
  const have = new Set(entries.map((e) => e && String(e.project_path)));
  let added = 0;
  for (const key of projectKeys) {
    const proj = PROJECTS[key];
    if (!proj || !proj.root) continue;
    if (!isJuliaProject(key)) continue;
    if (!fs.existsSync(path.join(proj.root, 'Project.toml'))) continue; // start_session requires it
    if (have.has(proj.root)) { seededProjects.add(key); continue; }
    entries.push({ project_path: proj.root, enabled: true });
    have.add(proj.root);
    seededProjects.add(key);
    added++;
  }
  if (added) {
    data.projects = entries;
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
    log(`allowlisted ${added} project(s) in`, file);
  }
  return added;
}

// ── the daemon (singleton) ──────────────────────────────────────────────────
// { child, pid, port, state:'starting'|'ready'|'error', starting: Promise,
//   startedAt, lastUsedAt, killed, cooldownUntil, errTail }
let daemon = null;
let busyProbe = () => false; // sessions.js injects (avoids an import cycle)
export function setBusyProbe(fn) { if (typeof fn === 'function') busyProbe = fn; }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Readiness = the MCP endpoint answers HTTP at all (any status). TCP accept
// alone can precede the routes being live.
function probeMcp(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json' }, timeout: timeoutMs,
    }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end('{"jsonrpc":"2.0","id":0,"method":"ping"}');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every child this process ever spawned (removed on exit) — the exit-hook /
// reset sweep uses this, not the current-daemon pointer, so no interleaving of
// retries and reassigned pids can leak a process.
const spawnedChildren = new Set();

// SIGTERM the daemon's process group (julia re-execs itself, and REPL session
// children must die with it), then SIGKILL stragglers — a stopped/stuck julia
// can shrug off SIGTERM entirely (observed live). Pid/child are captured by
// VALUE: the daemon record's fields get reassigned across boot retries and
// nulled on the error path, so closures over `d` would kill the wrong thing
// (or nothing).
function killDaemonTree(d, escalate = true) {
  const pid = d && d.pid;
  const child = d && d.child;
  if (!pid && !child) return;
  const kill = (sig) => {
    if (pid) { try { process.kill(-pid, sig); } catch { /* group gone */ } }
    try { child && child.kill(sig); } catch { /* already dead */ }
  };
  kill('SIGTERM');
  if (escalate) {
    const t = setTimeout(() => kill('SIGKILL'), 3000);
    if (t.unref) t.unref();
  }
}

function sweepSpawnedChildren(sig = 'SIGTERM') {
  for (const child of spawnedChildren) {
    try { process.kill(-child.pid, sig); } catch { /* group gone */ }
    try { child.kill(sig); } catch { /* already dead */ }
  }
}

function writeStateFile(O) {
  try {
    if (daemon && daemon.pid) {
      writeFileAtomic(O.stateFile, JSON.stringify({
        pid: daemon.pid, port: daemon.port, startedAt: daemon.startedAt, ownerPid: process.pid,
      }) + '\n');
    } else {
      fs.rmSync(O.stateFile, { force: true });
    }
  } catch (err) { logErr('state file:', err.message); }
}

function statusPayload() {
  return getKaimonStatus();
}
function broadcastStatus() {
  try { broadcast('kaimon:status', statusPayload()); } catch { /* pre-init */ }
}

// Single-flight boot. Every await re-checks `daemon === d && !d.killed` so a
// reap (or a superseding boot) racing the boot kills the just-spawned child
// instead of leaking it.
function ensureDaemon(O) {
  if (daemon) {
    if (daemon.state === 'ready') return Promise.resolve(daemon);
    if (daemon.state === 'starting') return daemon.starting;
    if (daemon.state === 'error' && Date.now() < daemon.cooldownUntil) return Promise.resolve(null);
  }
  const bin = resolveKaimonBin(O);
  if (!bin) return Promise.resolve(null);

  const d = {
    child: null, pid: null, port: null, state: 'starting', starting: null,
    startedAt: Date.now(), lastUsedAt: Date.now(), killed: false, cooldownUntil: 0, errTail: '',
  };
  daemon = d;
  broadcastStatus();

  d.starting = (async () => {
    try {
      seedKaimonConfig(O);
      seedKaimonProjects(O);
      for (let attempt = 0; attempt < 2; attempt++) {
        const port = await freePort();
        if (daemon !== d || d.killed) return null;

        const env = { ...process.env };
        // test sandboxes redirect the daemon's config/cache; real runs don't
        if (process.env.CP_KAIMON_CONFIG_DIR) env.XDG_CONFIG_HOME = path.dirname(O.configDir);
        if (process.env.CP_KAIMON_CACHE_DIR) env.XDG_CACHE_HOME = process.env.CP_KAIMON_CACHE_DIR;

        const child = spawn(bin, ['--headless', '-p', String(port)], {
          cwd: ROOT,
          detached: true, // own process group → group kills reach REPL children
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
        d.child = child; d.pid = child.pid; d.port = port;
        spawnedChildren.add(child);
        let exited = false;
        child.on('error', () => { exited = true; spawnedChildren.delete(child); });
        child.on('exit', () => { exited = true; spawnedChildren.delete(child); });
        child.stdout.on('data', () => { /* drain */ });
        child.stderr.on('data', (b) => { d.errTail = (d.errTail + b.toString()).slice(-4000); });
        writeStateFile(O);
        log(`daemon starting (pid ${d.pid}, port ${port})`);

        const deadline = Date.now() + O.bootMs;
        let ready = false;
        while (Date.now() < deadline) {
          if (daemon !== d || d.killed) { killDaemonTree(d); return null; }
          if (exited) break; // bind failure / crash → retry with a fresh port
          if (await probeMcp(port)) { ready = true; break; }
          await sleep(250);
        }
        if (daemon !== d || d.killed) { killDaemonTree(d); return null; }
        if (ready) {
          d.state = 'ready';
          d.lastUsedAt = Date.now();
          startReaper(O);
          log(`daemon ready on port ${port} (${Math.round((Date.now() - d.startedAt) / 1000)}s)`);
          broadcastStatus();
          return d;
        }
        killDaemonTree(d);
        if (d.errTail) logErr('boot attempt failed:', d.errTail.slice(-300).trim());
      }
      d.state = 'error';
      d.cooldownUntil = Date.now() + 60000; // don't re-pay a failing boot every turn
      d.child = null; d.pid = null;
      writeStateFile(O);
      broadcastStatus();
      return null;
    } catch (err) {
      logErr('boot error:', err.message);
      if (daemon === d) {
        d.state = 'error';
        d.cooldownUntil = Date.now() + 60000;
      }
      return null;
    }
  })();
  return d.starting;
}

export function reapDaemon(reason = 'reaped', o = {}) {
  const O = resolveOpts(o);
  const d = daemon;
  if (!d) return;
  d.killed = true;
  killDaemonTree(d);
  daemon = null;
  stopReaper();
  writeStateFile(O);
  log(`daemon ${reason} (pid ${d.pid || '?'})`);
  broadcastStatus();
}

// idle reaper — lazy (first spawn), unref'd so tests/short-lived runs exit clean
let reaperTimer = null;
function reaperTick(O) {
  const d = daemon;
  if (!d || d.state !== 'ready') return;
  if (busyProbe()) { d.lastUsedAt = Date.now(); return; } // active turn → stay warm
  if (Date.now() - d.lastUsedAt > O.idleMs) reapDaemon('idle-reaped', O);
}
function startReaper(O) {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    try { reaperTick(O); } catch (err) { logErr('reaper:', err.message); }
  }, 60000);
  if (reaperTimer.unref) reaperTimer.unref();
}
function stopReaper() {
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
}

export function touch() {
  if (daemon && daemon.state === 'ready') daemon.lastUsedAt = Date.now();
}

// ── what sessions.js asks for ───────────────────────────────────────────────
/** mcpServers fragment for a turn's query(), or null if Kaimon shouldn't
 *  engage. Never throws — any failure degrades to null (session unchanged).
 *  A cold daemon boots in the background; the caller waits at most `waitMs`
 *  (the boot keeps going — the NEXT turn adopts a now-ready daemon). */
export async function mcpFragmentFor(project, o = {}) {
  try {
    const O = resolveOpts(o);
    if (!kaimonEnabled()) return null;
    if (!isJuliaProject(project)) return null;
    if (!resolveKaimonBin(O)) return null;
    if (!seededProjects.has(project)) seedKaimonProjects(O, [project]);

    const boot = ensureDaemon(O);
    if (daemon && daemon.state === 'ready') { touch(); return fragment(); }
    const d = await Promise.race([boot, sleep(O.waitMs).then(() => 'timeout')]);
    if (d && d !== 'timeout' && daemon === d && d.state === 'ready') { touch(); return fragment(); }
    return null;
  } catch (err) {
    logErr('mcpFragmentFor error (skipping Kaimon):', err.message);
    return null;
  }
}
function fragment() {
  return { kaimon: { type: 'http', url: `http://127.0.0.1:${daemon.port}/mcp` } };
}

/** Kaimon's warm-REPL tools are dashboard-injected and eval in the user's own
 *  project — sessions.js auto-approves them (except ask-first/plan modes). */
export function isKaimonTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith('mcp__kaimon__');
}

// ── startup orphan sweep ────────────────────────────────────────────────────
// A crash/SIGKILL skips the exit hook and leaves the daemon tree running.
// The state file records {pid, ownerPid}: if the owner is dead and the pid
// still looks like Kaimon (PID-recycle guard), group-kill it.
export function sweepOrphans(o = {}) {
  const O = resolveOpts(o);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(O.stateFile, 'utf8')); } catch { return false; }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (rec && rec.ownerPid && alive(rec.ownerPid)) {
    // ANOTHER live server owns this daemon — its state file is its only
    // orphan-sweep record, so it must be left intact, not consumed
    logErr(`state file owned by live pid ${rec.ownerPid} — two servers? leaving its daemon alone`);
    return false;
  }
  try { fs.rmSync(O.stateFile, { force: true }); } catch { /* ignore */ }
  if (!rec || !rec.pid) return false;
  if (!alive(rec.pid)) return false;
  let cmd = '';
  try { cmd = execFileSync('ps', ['-p', String(rec.pid), '-o', 'command='], { encoding: 'utf8' }); } catch { return false; }
  // match the executable itself, not the whole arg string — an unrelated
  // process merely MENTIONING kaimon in its arguments must not be killed
  if (!/kaimon/i.test((cmd.trim().split(/\s+/)[0] || ''))) return false; // pid was recycled
  try { process.kill(-rec.pid, 'SIGTERM'); } catch { try { process.kill(rec.pid, 'SIGTERM'); } catch { /* gone */ } }
  const t = setTimeout(() => {
    try { process.kill(-rec.pid, 'SIGKILL'); } catch { try { process.kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
  }, 3000);
  if (t.unref) t.unref();
  log(`swept orphaned daemon (pid ${rec.pid}) from a previous run`);
  return true;
}

// ── one-click install ───────────────────────────────────────────────────────
// `]app add Kaimon` — the only install step Kaimon v2 needs. Minutes of
// download/precompile; progress tail is broadcast for the enable card.
let install = { state: 'idle', tail: '', startedAt: null, error: null };

function resolveJulia() {
  try {
    const p = execFileSync('which', ['julia'], { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch { /* not on PATH (GUI/launchd server) */ }
  for (const cand of [
    path.join(os.homedir(), '.juliaup', 'bin', 'julia'),
    '/opt/homebrew/bin/julia', '/usr/local/bin/julia',
  ]) {
    try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { /* next */ }
  }
  return null;
}

export function startInstall() {
  // CP_NO_BILLED marks the test sandbox — the concern here is host mutation
  // (~/.julia), not billing, but the same flag is the right guard
  if (process.env.CP_NO_BILLED) return { error: 'installs are disabled in this environment', status: 403 };
  if (install.state === 'running') return { error: 'install already running', status: 409 };
  const julia = resolveJulia();
  if (!julia) return { error: 'julia not found — install Julia ≥ 1.12 (https://julialang.org/downloads/) first', status: 400 };
  let version = '';
  try { version = execFileSync(julia, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* below */ }
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m || Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 12)) {
    return { error: `Kaimon needs Julia ≥ 1.12 (found: ${version || 'unknown'})`, status: 400 };
  }

  install = { state: 'running', tail: '', startedAt: Date.now(), error: null };
  broadcastStatus();
  const child = spawn(julia, [
    '--startup-file=no', '-e',
    'import Pkg; Pkg.Registry.update(); Pkg.Apps.add("Kaimon")',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let lastPush = 0;
  const onData = (b) => {
    install.tail = (install.tail + b.toString()).slice(-20000);
    const now = Date.now();
    if (now - lastPush > 1500) { lastPush = now; broadcastStatus(); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    install.state = 'error'; install.error = err.message;
    broadcastStatus();
  });
  child.on('exit', (code) => {
    if (install.state !== 'running') return;
    if (code === 0) {
      install.state = 'done';
      _resetBinCache(); // the binary exists now — next Julia turn picks it up
      log('kaimon installed');
    } else {
      install.state = 'error';
      install.error = `installer exited with code ${code}`;
    }
    broadcastStatus();
  });
  return { ok: true };
}

// ── status (sync, cache-backed — runs inside snapshot()) ───────────────────
export function getKaimonStatus() {
  const julia = {};
  try {
    for (const key of Object.keys(PROJECTS)) julia[key] = isJuliaProject(key);
  } catch { /* keep partial */ }
  let available = false;
  try { available = !!resolveKaimonBin(); } catch { /* stays false */ }
  return {
    enabled: kaimonEnabled(),
    available,
    julia,
    daemon: daemon ? {
      state: daemon.state, port: daemon.port,
      startedAt: daemon.startedAt, lastUsedAt: daemon.lastUsedAt,
    } : null,
    install: { state: install.state, error: install.error, tail: install.tail.slice(-2000) },
  };
}

// ── process exit sweep (watchers.js owns the signal traps; they call
//    process.exit(), which fires this — same free-ride as runner.js) ────────
process.on('exit', () => {
  if (daemon) daemon.killed = true;
  sweepSpawnedChildren('SIGTERM');
});

// test seams
export function _daemonState() { return daemon; }
export function _reaperTick(o = {}) { reaperTick(resolveOpts(o)); }
export function _resetForTests() {
  stopReaper();
  if (daemon) { daemon.killed = true; killDaemonTree(daemon, false); }
  sweepSpawnedChildren('SIGKILL'); // tests must never leak a child, period
  spawnedChildren.clear();
  daemon = null;
  seededProjects.clear();
  juliaCache.clear();
  binCache = { path: null, ts: 0 };
  install = { state: 'idle', tail: '', startedAt: null, error: null };
}
