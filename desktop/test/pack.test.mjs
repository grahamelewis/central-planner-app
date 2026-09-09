// Builtins only: no Electron, signing, icon rendering, or installed app writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePackOptions } from '../pack.mjs';

function write(root, file, data) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data));
}
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pack-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = fs.realpathSync(temporary);
  const installation = path.join(root, 'production runtime'), source = path.join(root, 'source'), data = path.join(root, 'data');
  for (const dir of [installation, source, data]) fs.mkdirSync(dir);
  const active = 'release-12345678-1234-1234-1234-123456789abc';
  const owner = { version: 1, installationRoot: installation, sourceRoot: source, dataRoot: data };
  const pointer = { version: 1, sourceRoot: source, dataRoot: data, active, previous: null };
  write(installation, '.central-planner-installation.json', owner);
  write(installation, 'deployment.json', pointer);
  for (const file of ['app/server.js', 'app/package.json', `releases/${active}/release.json`, `releases/${active}/app/server.js`, `releases/${active}/app/package.json`]) write(installation, file, '{}');
  return { root, installation, source, data, active, pointer };
}

test('developer package retains checkout hint and optional staging', () => {
  assert.deepEqual(resolvePackOptions([], { desktopRoot: '/example/source/desktop' }), { stage: false, serverRoot: '/example/source' });
  assert.deepEqual(resolvePackOptions(['--stage'], { desktopRoot: '/example/source/desktop' }), { stage: true, serverRoot: '/example/source' });
});

test('production hint targets validated runtime even when built elsewhere', t => {
  const f = fixture(t);
  assert.deepEqual(resolvePackOptions(['--stage', '--server-root', f.installation], { desktopRoot: '/unrelated/build-copy/desktop' }), { stage: true, serverRoot: f.installation });
  assert.deepEqual(resolvePackOptions(['--server-root', f.installation, '--stage']), { stage: true, serverRoot: f.installation });
});

test('rejects relative paths, unknown or duplicate flags, and missing values', () => {
  assert.throws(() => resolvePackOptions(['--server-root', 'relative/runtime']), /absolute/);
  for (const args of [['--server-root'], ['--unknown'], ['--stage', '--stage'], ['--server-root', '/one', '--server-root', '/two']]) assert.throws(() => resolvePackOptions(args), /Usage/);
});

test('source checkout cannot be a production fallback', t => {
  const f = fixture(t);
  write(f.source, 'app/server.js', '// source'); write(f.source, 'app/package.json', '{}');
  assert.throws(() => resolvePackOptions(['--server-root', f.source]), /not a source checkout/);
});

test('missing launcher or active release rejects incomplete installation', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.installation, 'app/server.js'));
  assert.throws(() => resolvePackOptions(['--server-root', f.installation]), /ENOENT/);
  write(f.installation, 'app/server.js', '{}');
  fs.unlinkSync(path.join(f.installation, `releases/${f.active}/release.json`));
  assert.throws(() => resolvePackOptions(['--server-root', f.installation]), /ENOENT/);
});

test('mismatched ownership, missing data, and symlinked launcher fail closed', t => {
  const f = fixture(t);
  write(f.installation, 'deployment.json', { ...f.pointer, dataRoot: f.source });
  assert.throws(() => resolvePackOptions(['--server-root', f.installation]), /disagree/);
  write(f.installation, 'deployment.json', f.pointer);
  fs.rmdirSync(f.data);
  assert.throws(() => resolvePackOptions(['--server-root', f.installation]), /data root/);
  fs.mkdirSync(f.data);
  fs.unlinkSync(path.join(f.installation, 'app/server.js'));
  fs.symlinkSync(path.join(f.installation, 'app/package.json'), path.join(f.installation, 'app/server.js'));
  assert.throws(() => resolvePackOptions(['--server-root', f.installation]), /Invalid production installation path/);
});
