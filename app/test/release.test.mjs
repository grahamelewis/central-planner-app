import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, verifyRelease, readReleaseManifest } from '../lib/release.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const required = {
  LICENSE: 'license\n', 'categories.example.json': '[]', 'config.example.json': '{}',
  'app/package.json': JSON.stringify({ type: 'module', dependencies: { express: '1.0.0', 'pdfjs-dist': '1.0.0', 'monaco-editor': '1.0.0' } }),
  'app/package-lock.json': '{}',
  'app/server.js': "import './lib/main.js';\n",
  'app/lib/main.js': 'export const value = 1;\n',
  'app/public/index.html': '<script type="module" src="app.js"></script>',
  'app/public/app.js': 'export const app = true;',
  'app/public/m/index.html': '<p>mobile</p>',
};
function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const files = { ...required, ...extra };
  for (const [file, content] of Object.entries(files)) write(source, file, content);
  write(source, 'release-manifest.json', JSON.stringify({ schemaVersion: 1, files: Object.keys(files).sort() }));
  return { root, source, destination: path.join(root, 'release') };
}
async function fakeInstall({ command, args, cwd }) {
  assert.equal(command, 'npm');
  assert.deepEqual(args, ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  for (const name of ['express', 'pdfjs-dist', 'monaco-editor']) write(cwd, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
  for (const file of ['pdfjs-dist/build/pdf.mjs', 'pdfjs-dist/build/pdf.worker.mjs', 'monaco-editor/min/vs/loader.js']) write(cwd, `node_modules/${file}`, '// vendor');
}

test('build stages only explicit files, records deterministic hashes, and never installs by default', async t => {
  const f = fixture(t);
  write(f.source, 'app/docs/experiment.html', 'private');
  write(f.source, 'app/test/safety.test.mjs', 'private');
  write(f.source, 'config.json', 'private');
  const result = await buildRelease({ sourceRoot: f.source, destination: f.destination, installer: () => assert.fail('unexpected install') });
  assert.equal(result.root, fs.realpathSync(f.destination));
  assert.equal(result.metadata.dependenciesInstalled, false);
  assert.equal(result.metadata.sourceRevision, null);
  assert.equal(fs.existsSync(path.join(f.destination, 'app/docs')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'config.json')), false);
  assert.deepEqual(verifyRelease({ root: f.destination }), result.metadata);
  const second = await buildRelease({ sourceRoot: f.source, destination: path.join(f.root, 'second') });
  assert.deepEqual(second.metadata, result.metadata);
  assert.throws(() => verifyRelease({ root: f.destination, requireDependencies: true }), /not production-ready/);
});

test('production install is explicit, injected, and verified before a completed release exists', async t => {
  const f = fixture(t);
  const sourceRevision = 'a'.repeat(40);
  const result = await buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true, installer: fakeInstall, sourceRevision });
  assert.equal(result.metadata.sourceRevision, sourceRevision);
  assert.equal(verifyRelease({ root: f.destination, requireDependencies: true }).dependenciesInstalled, true);
  assert.equal(fs.existsSync(path.join(f.source, 'app/node_modules')), false);
});

test('failed installer does not write a ready marker or touch the source', async t => {
  const f = fixture(t);
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true, installer: async () => { throw new Error('install failed'); } }), /install failed/);
  assert.equal(fs.existsSync(path.join(f.destination, 'release.json')), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'app/server.js'), 'utf8'), required['app/server.js']);
});

test('installer cannot silently rewrite approved application files', async t => {
  const f = fixture(t);
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true,
    installer: async req => { await fakeInstall(req); write(req.cwd, 'server.js', '// rewritten'); } }), /changed reviewed/);
  assert.equal(fs.existsSync(path.join(f.destination, 'release.json')), false);
});

for (const target of ['source', 'source/nested', '.']) test(`refuses overlapping destination ${target}`, async t => {
  const f = fixture(t);
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: path.resolve(f.root, target) }), /overlap/);
});

test('refuses existing destinations and protected data-root children', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  write(f.destination, 'keep.txt', 'do not change');
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /already exists/);
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: path.join(f.destination, 'nested'), protectedRoots: [f.destination] }), /protected data/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep.txt'), 'utf8'), 'do not change');
});

for (const entry of ['../config.json', '/tmp/escape', 'app/../config.json', 'app\\escape', 'app/docs/report.html', 'app/test/check.mjs', 'config.json', 'memory/history.json']) {
  test(`rejects unsafe or non-runtime manifest entry ${entry}`, async t => {
    const f = fixture(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.source, 'release-manifest.json')));
    manifest.files.push(entry);
    write(f.source, 'release-manifest.json', JSON.stringify(manifest));
    await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /Invalid release path|forbidden/);
    assert.equal(fs.existsSync(f.destination), false);
  });
}

test('rejects duplicate entries and a manifest omitting the actual app entry', t => {
  const f = fixture(t);
  const files = Object.keys(required);
  write(f.source, 'release-manifest.json', JSON.stringify({ schemaVersion: 1, files: [...files, files[0]] }));
  assert.throws(() => readReleaseManifest(f.source), /Duplicate/);
  write(f.source, 'release-manifest.json', JSON.stringify({ schemaVersion: 1, files: files.filter(file => file !== 'app/server.js') }));
  assert.throws(() => readReleaseManifest(f.source), /Required release/);
});

test('rejects symlinked source files and ancestor directories', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, 'app/lib/main.js'));
  write(f.root, 'outside.js', 'private');
  fs.symlinkSync(path.join(f.root, 'outside.js'), path.join(f.source, 'app/lib/main.js'));
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /without symlinks/);
  fs.rmSync(path.join(f.source, 'app/lib'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'outside'));
  write(f.root, 'outside/main.js', '// outside');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.source, 'app/lib'));
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /without symlinks/);
});

test('missing local imports and HTML assets fail before destination creation', async t => {
  const f = fixture(t);
  write(f.source, 'app/server.js', "import './lib/missing.js';");
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /Missing release dependency/);
  write(f.source, 'app/server.js', required['app/server.js']);
  write(f.source, 'app/public/index.html', '<link href="missing.css" rel="stylesheet">');
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination }), /Missing release dependency/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('verification rejects changed, missing, and unapproved files', async t => {
  const f = fixture(t);
  await buildRelease({ sourceRoot: f.source, destination: f.destination });
  write(f.destination, 'app/server.js', '// changed');
  assert.throws(() => verifyRelease({ root: f.destination }), /integrity/);
  write(f.destination, 'app/server.js', required['app/server.js']);
  write(f.destination, 'app/public/experiment.html', 'unreviewed');
  assert.throws(() => verifyRelease({ root: f.destination }), /unapproved/);
  fs.unlinkSync(path.join(f.destination, 'app/public/experiment.html'));
  fs.unlinkSync(path.join(f.destination, 'app/server.js'));
  assert.throws(() => verifyRelease({ root: f.destination }), /missing or unapproved/);
});

test('verification rejects symlinked payload and escaping dependency links', async t => {
  const f = fixture(t);
  await buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true, installer: fakeInstall });
  fs.symlinkSync(f.source, path.join(f.destination, 'app/node_modules/outside'));
  assert.throws(() => verifyRelease({ root: f.destination }), /escapes node_modules/);
  fs.unlinkSync(path.join(f.destination, 'app/node_modules/outside'));
  fs.symlinkSync(path.join(f.destination, 'app/node_modules/express'), path.join(f.destination, 'app/node_modules/inside'));
  assert.equal(verifyRelease({ root: f.destination }).dependenciesInstalled, true);
  fs.symlinkSync(path.join(f.source, 'app/server.js'), path.join(f.destination, 'extra.js'));
  assert.throws(() => verifyRelease({ root: f.destination }), /Symlink in release/);
});

test('production verification checks offline PDF and Monaco assets', async t => {
  const f = fixture(t);
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true,
    installer: async req => { await fakeInstall(req); fs.unlinkSync(path.join(req.cwd, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')); } }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(f.destination, 'release.json')), false);
});

test('lockfile development-only dependencies are rejected but shared production packages are allowed', async t => {
  const f = fixture(t);
  write(f.source, 'app/package-lock.json', JSON.stringify({ packages: { 'node_modules/express': { dev: false }, 'node_modules/typescript': { dev: true } } }));
  await assert.rejects(buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true,
    installer: async req => { await fakeInstall(req); write(req.cwd, 'node_modules/typescript/package.json', '{}'); } }), /Development-only dependency/);
  const good = await buildRelease({ sourceRoot: f.source, destination: path.join(f.root, 'good'), installDependencies: true, installer: fakeInstall });
  assert.equal(verifyRelease({ root: good.root, requireDependencies: true }).dependenciesInstalled, true);
});

test('verification rejects empty unapproved directories and dangling node_modules links', async t => {
  const f = fixture(t);
  await buildRelease({ sourceRoot: f.source, destination: f.destination });
  fs.mkdirSync(path.join(f.destination, 'experiments'));
  assert.throws(() => verifyRelease({ root: f.destination }), /Unapproved release directory/);
  fs.rmdirSync(path.join(f.destination, 'experiments'));
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.destination, 'app/node_modules'));
  assert.throws(() => verifyRelease({ root: f.destination }), /Symlink in release/);
});

test('direct dependency package identity and locked version are checked', async t => {
  const f = fixture(t);
  write(f.source, 'app/package-lock.json', JSON.stringify({ packages: { 'node_modules/express': { version: '1.0.0' } } }));
  await buildRelease({ sourceRoot: f.source, destination: f.destination, installDependencies: true, installer: fakeInstall });
  write(f.destination, 'app/node_modules/express/package.json', JSON.stringify({ name: 'express', version: '9.0.0' }));
  assert.throws(() => verifyRelease({ root: f.destination }), /does not match lockfile/);
  write(f.destination, 'app/node_modules/express/package.json', JSON.stringify({ name: 'unexpected', version: '1.0.0' }));
  assert.throws(() => verifyRelease({ root: f.destination }), /does not match lockfile/);
});

test('current repository builds without test, docs, private files or development declarations', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-release-real-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await buildRelease({ sourceRoot: ROOT, destination: path.join(root, 'release') });
  assert(result.manifest.files.includes('app/public/runledger.js'));
  assert(result.manifest.files.includes('app/lib/deployment.js'));
  assert(!result.manifest.files.some(file => /(?:^|\/)(?:test|docs)\/|\.d\.ts$/.test(file)));
  assert.equal(verifyRelease({ root: result.root }).files.length, result.metadata.files.length);
});
