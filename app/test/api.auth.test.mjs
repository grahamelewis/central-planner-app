// Sign-in state through the real server: the boot check surfaces a
// signed-out install, /api/auth/check re-verifies, /api/auth/login runs the
// (fake) browser flow, and the retry route stays hard-blocked in the sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSandbox } from './serverHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

let sb;
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-authapi-')), 'claude-state.json');
const setSignedIn = (loggedIn) => fs.writeFileSync(stateFile, JSON.stringify({ loggedIn, email: loggedIn ? 'fake@example.com' : null }));

before(async () => {
  setSignedIn(false); // the install starts signed OUT
  process.env.FAKE_CLAUDE_STATE_FILE = stateFile; // inherited by the sandbox server
  process.env.FAKE_CLAUDE_LOGIN_MODE = 'success';
  sb = await startSandbox({ claudeBin: FAKE });
});

after(async () => {
  delete process.env.FAKE_CLAUDE_STATE_FILE;
  delete process.env.FAKE_CLAUDE_LOGIN_MODE;
  if (sb) await sb.stop();
});

test('the boot check surfaces a signed-out install in the snapshot', async () => {
  const state = await sb.poll('/api/state', (b) => b.auth && b.auth.needed === true, { timeoutMs: 8000 });
  assert.equal(state.auth.loggedIn, false);
  assert.equal(state.auth.method, 'oauth');
  assert.equal(state.auth.available, true);
});

test('POST /api/auth/login runs the browser flow and clears the card', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/auth/login');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  await sb.poll('/api/state', (b) => b.auth && b.auth.needed === false && b.auth.loggedIn === true,
    { timeoutMs: 8000 });
  const { body: st } = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.auth.email, 'fake@example.com');
  assert.equal(st.auth.loggingIn, false);
  assert.equal(st.auth.loginError, null);
});

test('POST /api/auth/check re-verifies on demand (both directions)', async () => {
  setSignedIn(false);
  let { status, body } = await sb.fetchJson('POST', '/api/auth/check');
  assert.equal(status, 200);
  assert.equal(body.loggedIn, false);
  assert.equal(body.needed, true);
  setSignedIn(true);
  ({ body } = await sb.fetchJson('POST', '/api/auth/check'));
  assert.equal(body.loggedIn, true);
  assert.equal(body.needed, false);
});

test('the retry route is hard-blocked in the sandbox (CP_NO_BILLED)', async () => {
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'retry guard', description: 'x', category: 'calibration', oversight: 'coop',
  });
  const r = await sb.fetchJson('POST', `/api/tasks/alpha/${created.id}/retry`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /disabled/);
});

test('retry: unknown project → 404', async () => {
  const r = await sb.fetchJson('POST', '/api/tasks/nope/tsk-1/retry');
  assert.equal(r.status, 404);
});
