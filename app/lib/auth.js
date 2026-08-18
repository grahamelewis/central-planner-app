// lib/auth.js — Claude sign-in state for the dashboard.
//
// The SDK's task turns silently die when the Claude login has expired (or the
// server's ANTHROPIC_API_KEY is bad) — the user just saw a cryptic toast.
// This module owns the truth about "can we reach Claude?":
//   · detection — a boot-time check, a throttled check whenever a dashboard
//     client connects, a targeted check after ANY turn error, and a string
//     classifier (classifyAuthError) for the immediate signal
//   · the fix — startLogin() runs the official CLI's own `claude auth login`,
//     which opens the user's browser to sign in; checkAuth() confirms with
//     `claude auth status --json` (fast, local, NOT billed) and the card
//     clears everywhere via the auth:status broadcast
// Snapshot carries getAuthStatus() as `auth`; WS event: `auth:status` (same
// shape). Env seams for tests: CP_CLAUDE_BIN (fake binary), CP_AUTH_BOOT_MS,
// CP_AUTH_LOGIN_TIMEOUT_MS. Nothing here bills — auth status/login are
// account plumbing, not model calls.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { broadcast } from './events.js';

const log = (...args) => console.log('[auth]', ...args);
const logErr = (...args) => console.error('[auth]', ...args);

const CHECK_THROTTLE_MS = 30000;  // ambient checks (client connect) coalesce
const CHECK_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = Number(process.env.CP_AUTH_LOGIN_TIMEOUT_MS ?? 4 * 60 * 1000);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// how the SDK authenticates: an ANTHROPIC_API_KEY in the server env wins over
// the stored login, so browser sign-in can't fix a bad key (function, not a
// constant, so tests can flip the env)
const method = () => (process.env.ANTHROPIC_API_KEY ? 'apikey' : 'oauth');

const state = {
  needed: false,     // show the sign-in card
  reason: null,      // one-liner for the card (from the failing turn / check)
  loggedIn: null,    // last `auth status` verdict (null = never checked)
  email: null,
  checking: false,   // an auth-status check is in flight
  loggingIn: false,  // `claude auth login` is running (browser flow)
  loginError: null,  // last failed sign-in attempt, shown on the card
  lastChecked: null, // ISO
  available: null,   // is a claude CLI reachable at all? (null = unknown yet)
};

export function getAuthStatus() {
  return { ...state, method: method() };
}

function emit() {
  try { broadcast('auth:status', getAuthStatus()); } catch (err) {
    logErr('broadcast failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Error classification — is this turn failure an auth failure?
// ---------------------------------------------------------------------------

const AUTH_ERROR_RES = [
  /please run \/login/i,                 // the classic CLI message
  /\bclaude auth login\b/i,
  /invalid (?:api[- ]?key|x-api-key)/i,
  /authentication[_ ]error/i,
  /not (?:logged|signed) in/i,
  /(?:login|session) (?:has )?expired/i,
  // bounded on '.' AND ';' — sessions.js joins multiple SDK errors with '; ',
  // and a wildcard spanning that join would let two unrelated errors
  // concatenate into a false auth match
  /oauth (?:token|session)[^.;]*(?:expired|revoked|invalid|missing)/i,
  /(?:token|credential)s?[^.;]*(?:expired|revoked|has been revoked)/i,
  /\b401\b[^.;]*unauthorized|unauthorized[^.;]*\b401\b/i,
];

/** Does this error text look like "you're signed out / bad key"? */
export function classifyAuthError(text) {
  const s = String(text || '');
  if (!s) return false;
  return AUTH_ERROR_RES.some((re) => re.test(s));
}

// ---------------------------------------------------------------------------
// The CLI binary
// ---------------------------------------------------------------------------

let resolvedBin = null;

function candidateBins() {
  if (process.env.CP_CLAUDE_BIN) return [process.env.CP_CLAUDE_BIN];
  const home = os.homedir();
  return [
    'claude', // PATH first — respects the user's own arrangement
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

function claudeBin() {
  if (process.env.CP_CLAUDE_BIN) return process.env.CP_CLAUDE_BIN; // explicit pin always wins
  if (resolvedBin) return resolvedBin;
  for (const bin of candidateBins()) {
    if (bin === 'claude') return bin; // PATH lookup — let spawn decide
    try { fs.accessSync(bin, fs.constants.X_OK); resolvedBin = bin; return bin; } catch { /* next */ }
  }
  return 'claude';
}

// `claude` from PATH may not exist either — on ENOENT, retry the next
// absolute candidate once, then mark the CLI unavailable.
function execStatus(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status', '--json'], {
      timeout: CHECK_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

let lastCheckAt = 0;
let inflight = null;

/**
 * Run `claude auth status --json` and fold the verdict into the state.
 * Throttled unless force; concurrent callers share one run. Never throws.
 */
export function checkAuth({ force = false } = {}) {
  if (inflight) {
    // a FORCED check exists to confirm an event that just happened (login
    // exit, turn error) — an in-flight run that started before that event
    // carries a stale verdict, so chain a fresh run behind it instead of
    // handing the caller yesterday's answer
    if (!force) return inflight;
    return inflight.then(() => checkAuth({ force: true }));
  }
  if (!force && Date.now() - lastCheckAt < CHECK_THROTTLE_MS) {
    return Promise.resolve(getAuthStatus());
  }
  state.checking = true;
  emit();
  inflight = (async () => {
    try {
      let bin = claudeBin();
      let r = await execStatus(bin);
      if (r.err && r.err.code === 'ENOENT' && bin === 'claude') {
        for (const alt of candidateBins().slice(1)) {
          r = await execStatus(alt);
          if (!r.err || r.err.code !== 'ENOENT') { resolvedBin = alt; break; }
        }
      }
      lastCheckAt = Date.now();
      state.lastChecked = new Date().toISOString();
      if (r.err && r.err.code === 'ENOENT') {
        // no CLI anywhere — can't know; don't nag with a card we can't act on
        state.available = false;
        log('claude CLI not found — sign-in state unknown');
        return getAuthStatus();
      }
      state.available = true;
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* fall through */ }
      if (parsed && typeof parsed.loggedIn === 'boolean') {
        state.loggedIn = parsed.loggedIn;
        state.email = parsed.email || null;
      } else {
        // no JSON — fall back to the exit code (0 = signed in)
        state.loggedIn = !r.err;
      }
      if (state.loggedIn) {
        // in apikey mode the CLI's stored login is IRRELEVANT — the SDK uses
        // the env key, so "loggedIn: true" must not erase a card raised by a
        // rejected key (only a successful turn clears that one)
        if (method() !== 'apikey') {
          if (state.needed) log('signed in — clearing the card');
          state.needed = false;
          state.reason = null;
        }
      } else if (method() === 'oauth') {
        if (!state.needed) log('signed OUT — surfacing the sign-in card');
        state.needed = true;
        state.reason = state.reason || 'you are signed out of Claude';
      }
      return getAuthStatus();
    } catch (err) {
      logErr('check failed:', err.message);
      return getAuthStatus();
    } finally {
      state.checking = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

// ---------------------------------------------------------------------------
// Turn outcomes feed the state
// ---------------------------------------------------------------------------

/** A turn errored. Classifier gives the instant verdict; a forced status
    check confirms (and catches auth failures with unrecognized wording). */
export function noteTurnError(errText) {
  try {
    if (classifyAuthError(errText)) {
      const was = state.needed;
      state.needed = true;
      state.reason = String(errText || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      if (!was) emit();
      checkAuth({ force: true }).catch(() => {});
    } else {
      // unrecognized error — quietly confirm we're still signed in
      checkAuth().catch(() => {});
    }
  } catch (err) {
    logErr('noteTurnError failed:', err.message);
  }
}

/** A turn completed — Claude was reachable; any stale card clears. */
export function noteTurnSuccess() {
  try {
    if (!state.needed && state.loggedIn !== false) return;
    state.needed = false;
    state.reason = null;
    state.loggedIn = true;
    state.loginError = null;
    emit();
  } catch { /* display only */ }
}

// ---------------------------------------------------------------------------
// Sign-in (the CLI's own browser flow)
// ---------------------------------------------------------------------------

let loginChild = null;

/**
 * Spawn `claude auth login` — the CLI opens the browser; we wait for it to
 * finish, then confirm with a status check. 409 while one is running; 400
 * when auth is via ANTHROPIC_API_KEY (a browser login can't fix the key).
 */
export function startLogin() {
  if (method() === 'apikey') {
    const err = new Error('this server authenticates via ANTHROPIC_API_KEY — update the key in the server environment, then retry');
    err.status = 400;
    throw err;
  }
  if (state.loggingIn) {
    const err = new Error('a sign-in is already in progress — finish it in the browser');
    err.status = 409;
    throw err;
  }
  const bin = claudeBin();
  let child;
  try {
    child = spawn(bin, ['auth', 'login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (err) {
    const e = new Error(`could not start the sign-in: ${err.message}`);
    e.status = 500;
    throw e;
  }
  loginChild = child;
  state.loggingIn = true;
  state.loginError = null;
  emit();
  log('sign-in started (browser flow)');

  let out = '';
  const grab = (d) => { out = (out + d).slice(-4000); };
  if (child.stdout) child.stdout.on('data', grab);
  if (child.stderr) child.stderr.on('data', grab);

  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    state.loginError = 'sign-in timed out — the browser window may have been closed';
    // a child that ignores SIGTERM would wedge loggingIn forever (permanent
    // spinner, every future login 409s) — escalate
    const hard = setTimeout(() => {
      if (loginChild === child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, 5000);
    if (hard.unref) hard.unref();
  }, LOGIN_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  child.on('error', (err) => {
    clearTimeout(timer);
    if (loginChild !== child) return;
    loginChild = null;
    state.loggingIn = false;
    state.loginError = err.code === 'ENOENT'
      ? 'claude CLI not found — sign in from a terminal with `claude auth login`'
      : err.message;
    emit();
  });
  child.on('exit', async (code) => {
    clearTimeout(timer);
    if (loginChild !== child) return;
    loginChild = null;
    if (code !== 0 && !state.loginError) {
      const tail = out.trim().split('\n').pop() || '';
      state.loginError = `sign-in did not complete${tail ? ` — ${tail.slice(0, 160)}` : ''}`;
    }
    log(`sign-in process exited (code ${code})`);
    // the status check is the arbiter — the card holds its spinner until the
    // verdict is in, so loggingIn only drops once the check resolves
    await checkAuth({ force: true });
    state.loggingIn = false;
    if (state.loggedIn) state.loginError = null;
    emit();
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

/** One check shortly after boot, so an already-signed-out install surfaces
    the card before anyone burns a turn discovering it. */
export function startAuthChecks() {
  const delay = Number(process.env.CP_AUTH_BOOT_MS ?? 5000);
  const t = setTimeout(() => { checkAuth({ force: true }).catch(() => {}); }, delay);
  if (t.unref) t.unref();
}

// test seam
export const _test = { state, AUTH_ERROR_RES };
