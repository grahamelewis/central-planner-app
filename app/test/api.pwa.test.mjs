// PWA install surfaces (2026-08-10): the iPad/desktop-installable root app +
// the existing iPhone app at /m/. One brand mark everywhere — the icon set is
// generated from desktop/icon.svg. All GETs, nothing billed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

test('the root serves an installable manifest scoped to the whole dashboard', async () => {
  const { status, body } = await sb.fetchJson('GET', '/manifest.webmanifest');
  assert.equal(status, 200);
  assert.equal(body.name, 'Central Planner');
  assert.equal(body.scope, '/');
  assert.equal(body.display, 'standalone');
  assert.ok(body.icons.length >= 2, 'icon set declared');
});

test('the icon set exists at the declared paths (180 for iOS, 192/512 for the manifest)', async () => {
  for (const size of [180, 192, 512]) {
    const r = await sb.rawRequest('GET', `/icons/icon-${size}.png`);
    assert.equal(r.status, 200, `/icons/icon-${size}.png serves`);
  }
});

test('the root head carries the install identity for iPadOS', async () => {
  const { text: html } = await sb.rawRequest('GET', '/');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/icon-180\.png">/);
  assert.match(html, /apple-mobile-web-app-capable/);
});

test('the phone app and the SHELL IDENTITY PROBE are intact', async () => {
  // desktop/CONTRACT.md coupling #2: the shell classifies a server HEALTHY by
  // this exact name — the phone manifest must never drift
  const { status, body } = await sb.fetchJson('GET', '/m/manifest.webmanifest');
  assert.equal(status, 200);
  assert.equal(body.name, 'Central Planner', 'shell identity probe coupling holds');
  assert.equal(body.scope, '/m/');
  for (const size of [180, 192, 512]) {
    const r = await sb.rawRequest('GET', `/m/icon-${size}.png`);
    assert.equal(r.status, 200, `/m/icon-${size}.png serves`);
  }
});
