// A small JSONL client for `codex app-server --stdio` plus the dashboard's
// Codex account/model/usage cache. The wire protocol intentionally omits the
// JSON-RPC `jsonrpc` member; request ids are connection-local.
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { broadcast } from './events.js';

const log = (...args) => console.log('[codex]', ...args);
const logErr = (...args) => console.error('[codex]', ...args);
const REQUEST_TIMEOUT_MS = Number(process.env.CP_CODEX_REQUEST_TIMEOUT_MS || 30000);

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function candidateBins() {
  if (process.env.CP_CODEX_BIN) return [process.env.CP_CODEX_BIN];
  const home = os.homedir();
  return [
    'codex',
    path.join(home, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
}

let resolvedBin = null;
function codexBin() {
  if (process.env.CP_CODEX_BIN) return process.env.CP_CODEX_BIN;
  if (resolvedBin) return resolvedBin;
  for (const bin of candidateBins()) {
    if (bin === 'codex') return bin;
    try { fs.accessSync(bin, fs.constants.X_OK); resolvedBin = bin; return bin; } catch { /* next */ }
  }
  return 'codex';
}

export class CodexAppServer extends EventEmitter {
  constructor({ bin = null, spawnFn = spawn, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.bin = bin;
    this.spawnFn = spawnFn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
  }

  _write(message) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Codex app-server is not running');
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  _requestRaw(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    const message = { method, id };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this._write(message); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  _settleAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _onLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { logErr('ignored non-JSON stdout:', String(line).slice(0, 300)); return; }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const err = new Error(message.error.message || `${pending.method} failed`);
        err.code = message.error.code;
        err.data = message.error.data;
        pending.reject(err);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      if (message.method === 'currentTime/read') {
        this.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      }
      const request = {
        ...message,
        handled: false,
        respond: (result) => this.respond(message.id, result),
        reject: (text) => this.respondError(message.id, -32000, text || 'request declined by host'),
      };
      this.emit('serverRequest', request);
      if (!request.handled) request.reject('The dashboard has no active turn for this Codex request.');
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(this.bin || codexBin(), ['app-server', '--stdio'], {
          stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
        });
      } catch (err) {
        this.ready = null;
        reject(err);
        return;
      }
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => this._onLine(line));
      child.stderr?.on('data', (d) => {
        this.stderrTail = (this.stderrTail + String(d)).slice(-6000);
      });
      child.once('error', (err) => {
        this._settleAll(err);
        if (this.child === child) { this.child = null; this.ready = null; }
        reject(err);
        this.emit('exit', err);
      });
      child.once('exit', (code, signal) => {
        const detail = this.stderrTail.trim().split('\n').slice(-1)[0];
        const err = new Error(`Codex app-server exited (${signal || code})${detail ? ` — ${detail}` : ''}`);
        this._settleAll(err);
        if (this.child === child) { this.child = null; this.ready = null; }
        this.emit('exit', err);
      });
      this._requestRaw('initialize', {
        clientInfo: { name: 'central-planner', title: 'Central Planner', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }).then((result) => {
        this._write({ method: 'initialized' });
        resolve(result);
      }, (err) => {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        reject(err);
      });
    });
    return this.ready;
  }

  async request(method, params, options = {}) {
    await this.start();
    return this._requestRaw(method, params, options.timeoutMs);
  }

  respond(id, result) {
    try { this._write({ id, result }); } catch (err) { logErr('response failed:', err.message); }
  }

  respondError(id, code, message) {
    try { this._write({ id, error: { code, message } }); } catch (err) { logErr('error response failed:', err.message); }
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}

const client = new CodexAppServer();

const state = {
  available: null,
  connected: false,
  checking: false,
  loggingIn: false,
  loginId: null,
  loginUrl: null,
  loginError: null,
  account: null,
  models: [],
  modelsFetchedAt: null,
  usage: null,
  lastChecked: null,
  error: null,
};

function publicState() {
  return {
    ...state,
    // login URLs are short-lived credentials for completing OAuth. Return it
    // only from the explicit login route, never in /api/state or a WS frame.
    loginUrl: undefined,
  };
}

function emit() {
  try { broadcast('provider:status', { provider: 'codex', state: publicState() }); }
  catch (err) { logErr('broadcast failed:', err.message); }
}

function isoSeconds(v) {
  return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;
}

function durationLabel(minutes, fallback) {
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function usageWindowName(minutes, slot) {
  if (!Number.isFinite(minutes) || minutes <= 0) return slot === 'primary' ? 'session' : 'limit';
  // `primary` means the first window in the provider payload, not necessarily
  // a short session: Spark currently reports a one-week primary window.
  if (minutes === 10080) return 'weekly limit';
  const kind = minutes < 1440 ? 'session' : 'limit';
  return `${durationLabel(minutes, 'window')} ${kind}`;
}

function usageBucket(bucketId, rawName) {
  const full = String(rawName || bucketId || 'Codex');
  if (/spark/i.test(`${bucketId} ${full}`)) {
    return { label: 'Codex Spark', full, scopeModel: 'spark' };
  }
  return { label: /^chatgpt codex$/i.test(full) ? 'Codex' : full, full, scopeModel: null };
}

export function normalizeCodexUsage(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const buckets = payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.entries(payload.rateLimitsByLimitId).filter(([, v]) => v)
    : [];
  if (!buckets.length && payload.rateLimits) buckets.push([payload.rateLimits.limitId || 'codex', payload.rateLimits]);
  const limits = [];
  for (const [bucketId, snap] of buckets) {
    const bucket = usageBucket(bucketId, snap.limitName);
    for (const [slot, win] of [['primary', snap.primary], ['secondary', snap.secondary]]) {
      if (!win || !Number.isFinite(win.usedPercent)) continue;
      limits.push({
        key: `${bucketId}:${slot}`,
        name: usageWindowName(win.windowDurationMins, slot),
        sub: bucket.label,
        fullSub: bucket.full,
        scopeModel: bucket.scopeModel,
        pct: Math.max(0, Math.min(100, Math.round(win.usedPercent))),
        resetAt: isoSeconds(win.resetsAt),
        real: true,
      });
    }
  }
  if (!limits.length) return null;
  // The general allowance is the collapsed meter's useful headline. Keep any
  // model-specific buckets behind it regardless of provider object ordering.
  limits.sort((a, b) => Number(!!a.scopeModel) - Number(!!b.scopeModel));
  return {
    source: 'plan', provider: 'codex', limits,
    subscription: state.account?.type === 'chatgpt' ? state.account.planType : null,
    fetchedAt: new Date(nowMs).toISOString(),
  };
}

async function readAllModels() {
  const rows = [];
  let cursor = null;
  do {
    const page = await client.request('model/list', { cursor, includeHidden: false, limit: 100 });
    rows.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = page?.nextCursor || null;
  } while (cursor && rows.length < 500);
  return rows.filter((m) => m && !m.hidden).map((m) => ({
    id: m.model || m.id,
    label: m.displayName || m.model || m.id,
    description: m.description || '',
    isDefault: !!m.isDefault,
    defaultReasoningEffort: m.defaultReasoningEffort || null,
    supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.map((r) => ({ id: r.reasoningEffort, description: r.description || '' }))
      : [],
  }));
}

let refreshInflight = null;
export function refreshCodex({ force = false } = {}) {
  if (refreshInflight) return refreshInflight;
  if (!force && state.lastChecked && Date.now() - Date.parse(state.lastChecked) < 30000) {
    return Promise.resolve(publicState());
  }
  state.checking = true;
  emit();
  refreshInflight = (async () => {
    try {
      await client.start();
      state.available = true;
      const accountResult = await client.request('account/read', { refreshToken: !!force });
      state.account = accountResult?.account || null;
      state.connected = !!state.account || accountResult?.requiresOpenaiAuth === false;
      state.loginError = null;
      state.error = null;
      try {
        state.models = await readAllModels();
        state.modelsFetchedAt = new Date().toISOString();
      } catch (err) {
        log(`model catalog unavailable: ${err.message}`);
      }
      if (state.account?.type === 'chatgpt') {
        try {
          state.usage = normalizeCodexUsage(await client.request('account/rateLimits/read'));
        } catch (err) {
          log(`rate limits unavailable: ${err.message}`);
        }
      } else state.usage = null;
    } catch (err) {
      state.available = err.code === 'ENOENT' ? false : state.available;
      state.connected = false;
      state.error = err.code === 'ENOENT' ? 'Codex CLI not found' : err.message;
      if (err.code !== 'ENOENT') logErr('refresh failed:', err.message);
    } finally {
      state.lastChecked = new Date().toISOString();
      state.checking = false;
      refreshInflight = null;
      emit();
    }
    return publicState();
  })();
  return refreshInflight;
}

export async function startCodexLogin() {
  if (state.loggingIn) throw httpError(409, 'a Codex sign-in is already in progress');
  try {
    await client.start();
    state.available = true;
    state.loggingIn = true;
    state.loginError = null;
    emit();
    const result = await client.request('account/login/start', {
      type: 'chatgpt', codexStreamlinedLogin: true, useHostedLoginSuccessPage: true,
    });
    if (!result || result.type !== 'chatgpt' || !result.authUrl) {
      throw new Error('Codex did not return a browser sign-in URL');
    }
    state.loginId = result.loginId;
    state.loginUrl = result.authUrl;
    return { ok: true, authUrl: result.authUrl, loginId: result.loginId };
  } catch (err) {
    state.loggingIn = false;
    state.loginError = err.message;
    emit();
    if (err.code === 'ENOENT') throw httpError(404, 'Codex CLI not found — install Codex, then try again');
    throw err;
  }
}

export async function logoutCodex() {
  await client.request('account/logout');
  state.connected = false;
  state.account = null;
  state.usage = null;
  state.loggingIn = false;
  state.loginId = null;
  state.loginUrl = null;
  emit();
  return publicState();
}

client.on('notification', (message) => {
  const p = message.params || {};
  if (message.method === 'account/login/completed') {
    if (!state.loginId || !p.loginId || state.loginId === p.loginId) {
      state.loggingIn = false;
      state.loginError = p.success ? null : (p.error || 'Codex sign-in did not complete');
      if (p.success) refreshCodex({ force: true }).catch(() => {});
      else emit();
    }
  } else if (message.method === 'account/updated') {
    refreshCodex({ force: true }).catch(() => {});
  } else if (message.method === 'account/rateLimits/updated') {
    // Notifications are sparse; a refetch merges them correctly and is cheap.
    client.request('account/rateLimits/read').then((u) => {
      state.usage = normalizeCodexUsage(u);
      emit();
    }).catch(() => {});
  }
});
client.on('exit', (err) => {
  state.connected = false;
  state.checking = false;
  state.error = err.message;
  emit();
});

export function getCodexStatus() { return publicState(); }
export function getCodexClient() { return client; }
export function startCodexChecks() {
  const delay = Number(process.env.CP_CODEX_BOOT_MS || 5500);
  const timer = setTimeout(() => refreshCodex({ force: true }).catch(() => {}), delay);
  if (timer.unref) timer.unref();
}
export function stopCodex() { client.stop(); }
export const _test = { state, durationLabel, isoSeconds };
