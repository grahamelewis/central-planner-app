import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

test('GET tailnet status is safe when Tailscale is unavailable', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/tailnet/status');
  assert.equal(status, 200);
  assert.equal(body.state, 'unavailable');
  assert.equal(body.available, false);
  assert.equal(body.canManage, true);
});

test('local enable reports unavailable without invoking a real CLI', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/tailnet/enable');
  assert.equal(status, 503);
  assert.match(body.error, /Tailscale|CLI/i);
});

test('remote Host header cannot mutate Tailnet access', async () => {
  const res = await fetch(`${sb.base}/api/tailnet/disable`, {
    method: 'POST',
    headers: { Host: 'host.example.ts.net', 'Tailscale-User-Login': 'person@example.com' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /host Mac/);
});

test('a cross-origin page cannot use localhost as a Tailnet control endpoint', async () => {
  const res = await fetch(`${sb.base}/api/tailnet/disable`, {
    method: 'POST',
    headers: { Origin: 'https://example.invalid' },
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /host Mac/);
});
