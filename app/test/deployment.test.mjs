// Deployment safety is tested with tiny synthetic source/dependency trees. No
// server startup, model request, Git remote, real npm install, or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployRelease, rollbackRelease, readDeployment } from '../lib/deployment.js';

function write(root, file, data) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), data);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), dataRoot = path.join(root, 'data'), installationRoot = path.join(root, 'installation');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(dataRoot);
  const files = {
    LICENSE: 'license', 'categories.example.json': '[]', 'config.example.json': '{}',
    'app/package.json': JSON.stringify({ type: 'module', dependencies: { express: '1.0.0', 'pdfjs-dist': '1.0.0', 'monaco-editor': '1.0.0' } }),
    'app/package-lock.json': '{}', 'app/server.js': '// initial source',
    'app/public/index.html': '<p>dashboard</p>', 'app/public/m/index.html': '<p>mobile</p>',
  };
  for (const [file, data] of Object.entries(files)) write(sourceRoot, file, data);
  write(sourceRoot, 'release-manifest.json', JSON.stringify({ schemaVersion: 1, files: Object.keys(files).sort() }));
  write(dataRoot, 'config.json', '{"private":"unchanged"}');
  write(dataRoot, 'memory/history.json', '{"history":"unchanged"}');
  return { root, sourceRoot, dataRoot, installationRoot, requireClean: false, installer: fakeInstall };
}
async function fakeInstall({ command, args, cwd }) {
  assert.equal(command, 'npm'); assert(args.includes('--omit=dev'));
  for (const name of ['express', 'pdfjs-dist', 'monaco-editor']) write(cwd, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
  for (const file of ['pdfjs-dist/build/pdf.mjs', 'pdfjs-dist/build/pdf.worker.mjs', 'monaco-editor/min/vs/loader.js']) write(cwd, `node_modules/${file}`, '// dependency');
}
function assertDataUnchanged(f) {
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'config.json'), 'utf8'), '{"private":"unchanged"}');
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'memory/history.json'), 'utf8'), '{"history":"unchanged"}');
  assert.deepEqual(fs.readdirSync(f.dataRoot).sort(), ['config.json', 'memory']);
}
function launcherFixture(f) {
  const verifier = fileURLToPath(new URL('../lib/release.js', import.meta.url));
  write(f.sourceRoot, 'app/lib/release.js', fs.readFileSync(verifier));
  write(f.sourceRoot, 'app/server.js', 'console.log(JSON.stringify({dataRoot:process.env.CP_ROOT,installationRoot:process.env.CP_INSTALLATION_ROOT}));');
  const file = path.join(f.sourceRoot, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.files.push('app/lib/release.js');
  fs.writeFileSync(file, JSON.stringify(manifest));
}
function launch(f) {
  return execFileSync(process.execPath, [path.join(f.installationRoot, 'app/server.js')], {
    cwd: f.root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CP_NO_BILLED: '1', CP_ROOT: path.join(f.root, 'incorrect-root') },
  });
}

test('installation activates a verified release using an explicit separate data root', async t => {
  const f = fixture(t);
  const result = await deployRelease({ ...f, sourceRevision: '1'.repeat(40) });
  const current = readDeployment(f.installationRoot);
  assert.equal(current.active, result.active);
  assert.equal(current.previous, null);
  assert.equal(current.dataRoot, fs.realpathSync(f.dataRoot));
  assert.equal(current.sourceRevision, '1'.repeat(40));
  assert.equal(fs.existsSync(path.join(f.installationRoot, 'app/server.js')), true);
  assert.equal(fs.existsSync(path.join(f.installationRoot, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'app/node_modules')), false);
  assertDataUnchanged(f);
});

test('update and rollback only change the active pointer; both old releases and data remain', async t => {
  const f = fixture(t);
  const first = await deployRelease({ ...f, sourceRevision: '1'.repeat(40) });
  write(f.sourceRoot, 'app/server.js', '// second source');
  const second = await deployRelease({ ...f, sourceRevision: '2'.repeat(40) });
  assert.notEqual(first.active, second.active);
  assert.equal(second.previous, first.active);
  assert.equal(fs.readFileSync(path.join(first.releaseRoot, 'app/server.js'), 'utf8'), '// initial source');
  assert.equal(fs.readFileSync(path.join(second.releaseRoot, 'app/server.js'), 'utf8'), '// second source');
  const back = await rollbackRelease(f.installationRoot);
  assert.equal(back.active, first.active);
  assert.equal(back.previous, second.active);
  assert.equal(back.sourceRevision, '1'.repeat(40));
  assertDataUnchanged(f);
});

test('failed dependency installation leaves old active pointer intact and releases lock', async t => {
  const f = fixture(t);
  await deployRelease(f);
  const before = fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8');
  await assert.rejects(deployRelease({ ...f, installer: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.installationRoot, '.deployment.lock')), false);
  assertDataUnchanged(f);
});

test('failed first installation does not create an active deployment', async t => {
  const f = fixture(t);
  await assert.rejects(deployRelease({ ...f, installer: async () => { throw new Error('fail'); } }), /fail/);
  assert.equal(fs.existsSync(path.join(f.installationRoot, 'deployment.json')), false);
  assertDataUnchanged(f);
});

test('rollback refuses a tampered previous release and preserves current pointer', async t => {
  const f = fixture(t);
  const first = await deployRelease(f);
  await deployRelease(f);
  const before = fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8');
  write(first.releaseRoot, 'app/server.js', '// unauthorized edit');
  await assert.rejects(rollbackRelease(f.installationRoot), /integrity/);
  assert.equal(fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8'), before);
  assertDataUnchanged(f);
});

test('refuses replacing unrelated directories, overlapping roots, and changed data/source identity', async t => {
  const f = fixture(t);
  const unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated);
  write(unrelated, 'keep', 'untouched');
  await assert.rejects(deployRelease({ ...f, installationRoot: unrelated }), /ENOENT|ownership|ordinary/);
  for (const installationRoot of [f.sourceRoot, f.dataRoot, path.join(f.sourceRoot, 'runtime'), path.join(f.dataRoot, 'runtime'), f.root]) {
    await assert.rejects(deployRelease({ ...f, installationRoot }), /separate/);
  }
  await deployRelease(f);
  const otherData = path.join(f.root, 'other-data'); fs.mkdirSync(otherData);
  await assert.rejects(deployRelease({ ...f, dataRoot: otherData }), /cannot be changed/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'untouched');
  assertDataUnchanged(f);
});

test('release directory symlink is refused before rollback or read can follow it', async t => {
  const f = fixture(t);
  const first = await deployRelease(f);
  const second = await deployRelease(f);
  const moved = path.join(f.root, 'moved-release');
  fs.renameSync(first.releaseRoot, moved);
  fs.symlinkSync(moved, first.releaseRoot);
  await assert.rejects(rollbackRelease(f.installationRoot), /ordinary/);
  assert.equal(readDeployment(f.installationRoot).active, second.active);
  fs.unlinkSync(first.releaseRoot);
  fs.renameSync(moved, first.releaseRoot);
  const activeMoved = path.join(f.root, 'moved-active');
  fs.renameSync(second.releaseRoot, activeMoved);
  fs.symlinkSync(activeMoved, second.releaseRoot);
  assert.throws(() => readDeployment(f.installationRoot), /ordinary/);
  assertDataUnchanged(f);
});

test('concurrent deployment is rejected by an exclusive lock', async t => {
  const f = fixture(t);
  await deployRelease(f);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = deployRelease({ ...f, installer: async request => { entered(); await gate; await fakeInstall(request); } });
  await started;
  try { await assert.rejects(deployRelease(f), /EEXIST|locked|progress/); }
  finally { release(); }
  await first;
  assertDataUnchanged(f);
});

test('changed stable launcher is never overwritten during update', async t => {
  const f = fixture(t);
  await deployRelease(f);
  write(f.installationRoot, 'app/server.js', '// local edit');
  const before = fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8');
  await assert.rejects(deployRelease(f), /launcher was changed/);
  assert.equal(fs.readFileSync(path.join(f.installationRoot, 'app/server.js'), 'utf8'), '// local edit');
  assert.equal(fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8'), before);
  assertDataUnchanged(f);
});

test('rollback without a previous release is a no-op failure', async t => {
  const f = fixture(t);
  await deployRelease(f);
  const before = fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8');
  await assert.rejects(rollbackRelease(f.installationRoot), /No previous/);
  assert.equal(fs.readFileSync(path.join(f.installationRoot, 'deployment.json'), 'utf8'), before);
});

test('stable launcher verifies the release and explicitly preserves the configured data root', async t => {
  const f = fixture(t); launcherFixture(f);
  await deployRelease(f);
  const result = JSON.parse(launch(f));
  assert.equal(result.dataRoot, fs.realpathSync(f.dataRoot));
  assert.equal(result.installationRoot, fs.realpathSync(f.installationRoot));
  assert.equal(fs.existsSync(path.join(f.root, 'incorrect-root')), false);
  assertDataUnchanged(f);
});

test('stable launcher rejects a modified verifier before importing its code', async t => {
  const f = fixture(t); launcherFixture(f);
  const installed = await deployRelease(f);
  write(installed.releaseRoot, 'app/lib/release.js', "console.log('UNVERIFIED_CODE_EXECUTED'); export function verifyRelease() {};");
  assert.throws(() => launch(f), error => {
    assert.match(error.stderr, /Release bootstrap integrity failed/);
    assert(!error.stdout.includes('UNVERIFIED_CODE_EXECUTED'));
    return true;
  });
  assertDataUnchanged(f);
});

test('stable launcher refuses a changed or missing data root instead of starting blank', async t => {
  const f = fixture(t); launcherFixture(f);
  await deployRelease(f);
  const pointer = path.join(f.installationRoot, 'deployment.json');
  const original = fs.readFileSync(pointer, 'utf8');
  const edited = JSON.parse(original); edited.dataRoot = path.join(f.root, 'unrelated-data');
  fs.writeFileSync(pointer, JSON.stringify(edited));
  assert.throws(() => launch(f), /Invalid production deployment/);
  fs.writeFileSync(pointer, original);
  fs.renameSync(f.dataRoot, path.join(f.root, 'moved-data'));
  assert.throws(() => launch(f), /ENOENT/);
  assert.equal(fs.existsSync(f.dataRoot), false);
  fs.renameSync(path.join(f.root, 'moved-data'), f.dataRoot);
  assertDataUnchanged(f);
});
