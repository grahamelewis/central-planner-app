// /api/texfix/:project — guard rails only. The valid path spawns a REAL
// BILLED Claude session, so tests exercise exactly the refusals: unknown
// project, and no failing build — and the sandbox sets CP_NO_BILLED as
// defense-in-depth, so even a valid-looking POST could never dispatch.
// (The UI harness intercepts the route in the browser; see ui.texfix.test.mjs.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

test('404 on an unknown project', async () => {
  const { status } = await sb.fetchJson('POST', '/api/texfix/nope', {});
  assert.equal(status, 404);
});

test('400 when the project has no failing LaTeX build', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/texfix/alpha', { taskId: 'alp-001' });
  assert.equal(status, 400);
  assert.match(body.error, /no failing LaTeX build/i);
});

test('the snapshot exposes a texfix field', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.deepEqual(body.texfix, {});
});

test('dismiss is idempotent bookkeeping: 200 with no fix record, 404 on unknown project', async () => {
  let r = await sb.fetchJson('POST', '/api/texfix/alpha/dismiss', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  r = await sb.fetchJson('POST', '/api/texfix/nope/dismiss', {});
  assert.equal(r.status, 404);
});
