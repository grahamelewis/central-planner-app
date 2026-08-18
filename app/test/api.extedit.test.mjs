// Saving EXTERNAL pins: PUT /api/extfile/:project/:id gives the user the
// same write access the session already has (the extpins allowlist), with
// the same mtime conflict guard as in-root saves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb, taskId, extDir, extFile;

before(async () => {
  sb = await startSandbox({});
  // an "external" area: inside the sandbox root but OUTSIDE the project roots
  extDir = path.join(sb.root, 'external-notes');
  fs.mkdirSync(extDir, { recursive: true });
  extFile = path.join(extDir, 'README.md');
  fs.writeFileSync(extFile, '# Original\n');
  fs.writeFileSync(path.join(extDir, 'ungranted-elsewhere.md'), 'x\n');
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'ext edit', description: 'x', category: 'calibration', oversight: 'coop',
  });
  taskId = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, {
    context: { files: [extFile] }, // a file pin grants its folder
  });
});

after(async () => { if (sb) await sb.stop(); });

test('a granted external file saves through the pin grant (and reports mtimeMs)', async () => {
  const { body: read } = await sb.fetchJson('GET',
    `/api/extfile/alpha/${taskId}?path=${encodeURIComponent(extFile)}`);
  const base = fs.statSync(extFile).mtimeMs;
  const r = await sb.fetchJson('PUT', `/api/extfile/alpha/${taskId}`, {
    path: extFile, content: '# Edited by the user\n', baseMtimeMs: base,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(Number.isFinite(r.body.mtimeMs));
  assert.equal(fs.readFileSync(extFile, 'utf8'), '# Edited by the user\n');
});

test('the mtime conflict guard refuses a stale save (409)', async () => {
  const staleBase = fs.statSync(extFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(extFile, '# Someone else moved it\n'); // disk moved on
  const r = await sb.fetchJson('PUT', `/api/extfile/alpha/${taskId}`, {
    path: extFile, content: '# my stale draft\n', baseMtimeMs: staleBase,
  });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(extFile, 'utf8'), '# Someone else moved it\n', 'disk untouched');
});

test('ungranted paths refuse (403) — the allowlist is the pin list', async () => {
  const outside = path.join(sb.root, 'not-granted.md');
  fs.writeFileSync(outside, 'x\n');
  const r = await sb.fetchJson('PUT', `/api/extfile/alpha/${taskId}`, {
    path: outside, content: 'nope', baseMtimeMs: Date.now(),
  });
  assert.equal(r.status, 403);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'x\n');
});

test('bad payloads and unknown tasks are refused cleanly', async () => {
  let r = await sb.fetchJson('PUT', `/api/extfile/alpha/${taskId}`, { path: extFile });
  assert.equal(r.status, 400); // no content
  r = await sb.fetchJson('PUT', '/api/extfile/alpha/nope-1', {
    path: extFile, content: 'x', baseMtimeMs: Date.now(),
  });
  assert.equal(r.status, 404);
});
