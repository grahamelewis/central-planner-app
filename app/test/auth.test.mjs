// lib/auth.js — sign-in detection and the browser-login runner.
// Everything runs against test/fixtures/fake-claude.mjs; the real CLI is
// never touched (a real `auth login` would pop the dev machine's browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-auth-')));
const stateFile = path.join(root, 'claude-state.json');
const setSignedIn = (loggedIn) => fs.writeFileSync(stateFile, JSON.stringify({ loggedIn, email: loggedIn ? 'fake@example.com' : null }));

// env seams BEFORE the module loads
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({ alpha: { name: 'alpha', root, color: '#fff', texWatch: null } });
process.env.CP_CLAUDE_BIN = FAKE;
process.env.FAKE_CLAUDE_STATE_FILE = stateFile;
process.env.CP_AUTH_LOGIN_TIMEOUT_MS = '700';
delete process.env.ANTHROPIC_API_KEY;

const {
  classifyAuthError, checkAuth, getAuthStatus, startLogin,
  noteTurnError, noteTurnSuccess, _test,
} = await import('../lib/auth.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > end) throw new Error('until() timed out');
    await sleep(50);
  }
}

test('classifyAuthError: catches the known signed-out shapes, not general errors', () => {
  const yes = [
    'Invalid API key · Please run /login',
    'Please run /login to authenticate',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'OAuth token has expired. Please obtain a new token.',
    'OAuth token revoked — run claude auth login',
    'Not logged in',
    'your login session expired',
    'credentials expired — please re-authenticate',
    '401 Unauthorized',
  ];
  for (const s of yes) assert.ok(classifyAuthError(s), `should classify: ${s}`);
  const no = [
    'Claude Code process exited with code 1',
    'rate limit exceeded — retry after 60s',
    'Credit balance is too low',
    'ENOENT: no such file or directory',
    'turn ended with error_max_turns',
    'the user asked to log the results in results.csv',
    '',
    null,
  ];
  for (const s of no) assert.ok(!classifyAuthError(s), `should NOT classify: ${s}`);
});

test('checkAuth: signed out → needed; signed in → clears (JSON verdict beats exit code)', async () => {
  setSignedIn(false);
  let st = await checkAuth({ force: true });
  assert.equal(st.loggedIn, false);
  assert.equal(st.needed, true);
  assert.equal(st.available, true);
  setSignedIn(true);
  st = await checkAuth({ force: true });
  assert.equal(st.loggedIn, true);
  assert.equal(st.needed, false);
  assert.equal(st.email, 'fake@example.com');
});

test('noteTurnError: classified error flags needed immediately; success clears', async () => {
  setSignedIn(false);
  noteTurnError('Invalid API key · Please run /login');
  assert.equal(getAuthStatus().needed, true);
  assert.match(getAuthStatus().reason, /please run \/login/i);
  await until(() => !getAuthStatus().checking); // the confirm check settles
  setSignedIn(true);
  noteTurnSuccess();
  assert.equal(getAuthStatus().needed, false);
  assert.equal(getAuthStatus().reason, null);
});

test('noteTurnError: unrecognized error still catches a signed-out CLI via the status check', async () => {
  setSignedIn(false);
  _test.state.needed = false;
  // bypass the ambient throttle: force lastChecked far in the past by using
  // a direct forced check after the note (noteTurnError uses the throttled
  // path for unclassified errors — a prior forced check may be recent)
  noteTurnError('Claude Code process exited with code 1');
  await checkAuth({ force: true });
  assert.equal(getAuthStatus().needed, true, 'status check catches what the classifier missed');
  setSignedIn(true);
  await checkAuth({ force: true });
});

test('startLogin: browser flow completes → signed in, card cleared', async () => {
  setSignedIn(false);
  await checkAuth({ force: true });
  assert.equal(getAuthStatus().needed, true);
  process.env.FAKE_CLAUDE_LOGIN_MODE = 'success';
  const r = startLogin();
  assert.equal(r.ok, true);
  assert.equal(getAuthStatus().loggingIn, true);
  assert.throws(() => startLogin(), /already in progress/); // 409 while running
  await until(() => !getAuthStatus().loggingIn);
  const st = getAuthStatus();
  assert.equal(st.loggedIn, true);
  assert.equal(st.needed, false);
  assert.equal(st.loginError, null);
});

test('startLogin: a failing login reports the error and stays needed', async () => {
  setSignedIn(false);
  await checkAuth({ force: true });
  process.env.FAKE_CLAUDE_LOGIN_MODE = 'fail';
  startLogin();
  await until(() => !getAuthStatus().loggingIn);
  const st = getAuthStatus();
  assert.equal(st.needed, true);
  assert.match(st.loginError, /did not complete|Unable to open browser/i);
});

test('startLogin: a hung login times out (CP_AUTH_LOGIN_TIMEOUT_MS)', async () => {
  setSignedIn(false);
  process.env.FAKE_CLAUDE_LOGIN_MODE = 'hang';
  startLogin();
  await until(() => !getAuthStatus().loggingIn, 8000);
  assert.match(getAuthStatus().loginError, /timed out/i);
  delete process.env.FAKE_CLAUDE_LOGIN_MODE;
});

test('startLogin: refused (400) when auth is via ANTHROPIC_API_KEY', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    assert.equal(getAuthStatus().method, 'apikey');
    assert.throws(() => startLogin(), /ANTHROPIC_API_KEY/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('checkAuth: a missing CLI reports unavailable, never nags', async () => {
  // the previous login's exit handler fires a confirm check — let it settle so
  // checkAuth below doesn't return that shared in-flight run
  await until(() => !getAuthStatus().checking);
  process.env.CP_CLAUDE_BIN = '/nonexistent-claude-cli';
  _test.state.needed = false;
  _test.state.available = null;
  const st = await checkAuth({ force: true });
  assert.equal(st.available, false);
  assert.equal(st.needed, false, 'no card the user cannot act on');
  process.env.CP_CLAUDE_BIN = FAKE;
});
