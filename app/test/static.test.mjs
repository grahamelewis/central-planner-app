// test/static.test.mjs — cheap, broad safety net: every shipped JS file must
// parse cleanly under `node --check`. Catches syntax errors / typos in files
// the runtime loads lazily (e.g. public/app.js, public/m/m.js) that a
// server-side test suite would otherwise never touch. Also asserts the
// offline-safety of the vendored Monaco dist (Phase 3 S0, blueprint C2-9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import path from 'path';
import { APP_DIR } from './helpers.mjs';
import { startSandbox } from './serverHarness.mjs';

const pexec = promisify(execFile);

const FILES = [
  ...fs.readdirSync(path.join(APP_DIR, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('lib', f)),
  // every shipped frontend module — the runtime loads them lazily as ESM, so
  // this glob is the only place a typo in a rarely-hit module fails fast
  // (Phase 3 S1: grown from the app.js/hl.js pair to ALL of public/)
  ...fs.readdirSync(path.join(APP_DIR, 'public'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('public', f)),
  ...fs.readdirSync(path.join(APP_DIR, 'public', 'latex'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('public', 'latex', f)),
  'server.js',
  'public/m/m.js',
];

test('the node --check list covers the Monaco pane (S1) and the workbench', () => {
  assert.ok(FILES.includes(path.join('public', 'monacoPane.js')), 'public/monacoPane.js must be checked');
  assert.ok(FILES.includes(path.join('public', 'workbench.js')), 'public/workbench.js must be checked');
});

for (const rel of FILES) {
  test(`node --check passes on ${rel}`, async () => {
    const abs = path.join(APP_DIR, rel);
    assert.ok(fs.existsSync(abs), `${rel} should exist`);
    // resolves on exit 0; rejects (throwing the test) with stderr on a parse error
    await pexec(process.execPath, ['--check', abs]);
  });
}

test('GET /vendor/monaco/vs/loader.js → 200 (Monaco dist is vendored + served offline-safe)', async () => {
  const sb = await startSandbox({});
  try {
    const res = await sb.rawRequest('GET', '/vendor/monaco/vs/loader.js');
    assert.equal(res.status, 200, 'the AMD loader must be served from the vendored dist');
    assert.ok(/define|require/.test(res.text || ''), 'loader body looks like the AMD loader');
  } finally {
    await sb.stop();
  }
});
