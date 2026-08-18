// Tailscale Serve control for the dashboard's localhost server.
//
// This module owns only ONE mapping: the root HTTPS handler whose proxy target
// is this Central Planner process. It never calls `serve reset`, never touches
// Funnel, and refuses to disable a shared Serve configuration. The controller
// is dependency-injected so tests never reach the developer's real tailnet.
import fs from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { PORT } from './config.js';

const CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

const ownTargets = (port) => new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);

function cleanError(err) {
  const raw = String(err?.stderr || err?.stdout || err?.message || err || 'Tailscale command failed');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function jsonOr(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Reduce Tailscale's large status/config payloads to the UI-safe state. */
export function summarizeTailnet(statusJson, serveJson, port = PORT) {
  const backendState = String(statusJson?.BackendState || 'Unknown');
  const connected = backendState === 'Running';
  const web = serveJson?.Web && typeof serveJson.Web === 'object' ? serveJson.Web : {};
  const targets = ownTargets(port);
  const roots = [];
  let handlerCount = 0;

  for (const [host, entry] of Object.entries(web)) {
    const handlers = entry?.Handlers && typeof entry.Handlers === 'object' ? entry.Handlers : {};
    handlerCount += Object.keys(handlers).length;
    if (handlers['/']) roots.push({ host, handler: handlers['/'] });
  }

  const owned = roots.find((r) => targets.has(String(r.handler?.Proxy || ''))) || null;
  const foreign = roots.find((r) => !targets.has(String(r.handler?.Proxy || ''))) || null;
  const configured = !!owned;
  const shared = configured && handlerCount > 1;
  const host = owned?.host ? String(owned.host).replace(/:443$/, '') : '';
  const url = host ? `https://${host}` : '';

  let state = 'off';
  let error = '';
  if (foreign) {
    state = 'conflict';
    error = `Tailscale Serve root is already assigned to ${foreign.handler?.Proxy || 'another service'}`;
  } else if (!connected) {
    state = 'disconnected';
    error = backendState === 'NeedsLogin'
      ? 'Tailscale needs you to sign in'
      : 'Tailscale is not connected';
  } else if (configured) {
    state = 'live';
  }

  return {
    available: true,
    state,
    connected,
    configured,
    shared,
    backendState,
    url,
    target: `http://127.0.0.1:${port}`,
    error,
    checkedAt: new Date().toISOString(),
  };
}

export function createTailnetController({
  port = PORT,
  env = process.env,
  accessSync = fs.accessSync,
  execFile = execFileCb,
} = {}) {
  let current = {
    available: false,
    state: 'checking',
    connected: false,
    configured: false,
    shared: false,
    backendState: 'Unknown',
    url: '',
    target: `http://127.0.0.1:${port}`,
    error: '',
    checkedAt: null,
  };
  let inFlight = null;

  function resolveBin() {
    if (Object.prototype.hasOwnProperty.call(env, 'CP_TAILSCALE_BIN')) {
      return env.CP_TAILSCALE_BIN || null; // explicit empty string disables discovery (tests/CI)
    }
    for (const candidate of CANDIDATES) {
      try {
        accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* try the next supported install location */ }
    }
    return null;
  }

  function run(args, timeout = 8000) {
    const bin = resolveBin();
    if (!bin) {
      const err = new Error('Tailscale is not installed or its CLI is unavailable');
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      execFile(bin, args, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...env,
          // The App Store/standalone macOS binary selects GUI vs CLI from its
          // environment. This flag makes Finder-launched Electron deterministic.
          TAILSCALE_BE_CLI: '1',
          TERM: env.TERM || 'xterm',
        },
      }, (err, stdout = '', stderr = '') => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else resolve({ stdout, stderr });
      });
    });
  }

  async function doRefresh() {
    if (!resolveBin()) {
      current = {
        ...current,
        available: false,
        state: 'unavailable',
        error: 'Install Tailscale or enable its CLI integration',
        checkedAt: new Date().toISOString(),
      };
      return current;
    }
    try {
      const [{ stdout: statusRaw }, { stdout: serveRaw }] = await Promise.all([
        run(['status', '--json']),
        run(['serve', 'status', '--json']),
      ]);
      current = summarizeTailnet(jsonOr(statusRaw), jsonOr(serveRaw), port);
    } catch (err) {
      current = {
        ...current,
        available: err?.code !== 'ENOENT',
        state: err?.code === 'ENOENT' ? 'unavailable' : 'error',
        error: cleanError(err),
        checkedAt: new Date().toISOString(),
      };
    }
    return current;
  }

  function refresh() {
    if (!inFlight) inFlight = doRefresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function enable() {
    let before = await refresh();
    if (!before.available) throw Object.assign(new Error(before.error), { status: 503 });
    if (before.state === 'conflict') throw Object.assign(new Error(before.error), { status: 409 });
    if (!before.connected) {
      if (before.backendState !== 'Stopped') {
        throw Object.assign(new Error(before.error || 'Tailscale is not connected'), { status: 409 });
      }
      try {
        // A no-flag `tailscale up` reconnects with the saved configuration. It
        // does not reset preferences; `--timeout` only bounds this UI action.
        await run(['up', '--timeout=10s'], 15000);
      } catch (err) {
        const e = new Error(cleanError(err));
        e.status = 502;
        throw e;
      }
      before = await doRefresh();
      if (!before.connected) {
        throw Object.assign(new Error(before.error || 'Tailscale did not connect'), { status: 502 });
      }
      if (before.state === 'conflict') throw Object.assign(new Error(before.error), { status: 409 });
    }
    if (before.configured) return before;
    try {
      await run(['serve', '--bg', '--yes', String(port)], 20000);
    } catch (err) {
      const e = new Error(cleanError(err));
      e.status = 502;
      throw e;
    }
    return doRefresh();
  }

  async function disable() {
    const before = await refresh();
    if (!before.configured) return before;
    if (before.shared) {
      throw Object.assign(new Error('Central Planner shares this Serve endpoint with another handler; refusing to alter it'), { status: 409 });
    }
    try {
      // Exact HTTPS listener only. Never use `serve reset`, which could erase
      // unrelated services configured by the user.
      await run(['serve', '--https=443', 'off'], 12000);
    } catch (err) {
      const e = new Error(cleanError(err));
      e.status = 502;
      throw e;
    }
    return doRefresh();
  }

  return {
    getStatus: () => ({ ...current }),
    refresh,
    enable,
    disable,
    resolveBin,
  };
}

export const tailnet = createTailnetController();
