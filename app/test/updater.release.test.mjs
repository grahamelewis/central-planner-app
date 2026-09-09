// Production updater integration with genuine LOCAL Git repositories and a
// fake npm executable. No network, installed package mutation, server, or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deployRelease, readDeployment } from '../lib/deployment.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function write(root, file, data) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), data);
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function install({ cwd }) {
  for (const name of ['express', 'pdfjs-dist', 'monaco-editor']) write(cwd, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
  for (const file of ['pdfjs-dist/build/pdf.mjs', 'pdfjs-dist/build/pdf.worker.mjs', 'monaco-editor/min/vs/loader.js']) write(cwd, `node_modules/${file}`, '// fake dependency');
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-update-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publisher = path.join(root, 'publisher'), sourceRoot = path.join(root, 'source'), dataRoot = path.join(root, 'data'), installationRoot = path.join(root, 'installation');
  fs.mkdirSync(publisher); fs.mkdirSync(dataRoot);
  git(publisher, 'init', '-b', 'main');
  git(publisher, 'config', 'user.name', 'Release test'); git(publisher, 'config', 'user.email', 'release@example.invalid');
  git(publisher, 'config', 'commit.gpgsign', 'false');
  const files = {
    LICENSE: 'license', 'categories.example.json': '[]', 'config.example.json': '{}',
    'app/package.json': JSON.stringify({ type: 'module', dependencies: { express: '1.0.0', 'pdfjs-dist': '1.0.0', 'monaco-editor': '1.0.0' } }),
    'app/package-lock.json': '{}', 'app/server.js': '// initial',
    'app/public/index.html': '<p>dashboard</p>', 'app/public/m/index.html': '<p>mobile</p>',
  };
  for (const [file, data] of Object.entries(files)) write(publisher, file, data);
  write(publisher, 'release-manifest.json', JSON.stringify({ schemaVersion: 1, files: Object.keys(files).sort() }));
  git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'initial');
  git(root, 'clone', '--no-hardlinks', publisher, sourceRoot);
  write(dataRoot, 'config.json', '{"private":"unchanged"}');
  write(dataRoot, 'memory/history.json', '{"private":"unchanged"}');
  const first = await deployRelease({ sourceRoot, installationRoot, dataRoot, installer: install });
  write(publisher, 'app/server.js', '// updated');
  write(publisher, 'app/test/new-safety.test.mjs', '// source-only safety harness');
  git(publisher, 'add', '.'); git(publisher, 'commit', '-m', 'update runtime plus source test');
  const nextRevision = git(publisher, 'rev-parse', 'HEAD');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const fakeNpm = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['ci','--omit=dev','--no-audit','--no-fund'])) throw new Error('Unexpected npm invocation');
const cwd = process.cwd();
const installRoot = fs.realpathSync(process.env.CP_INSTALLATION_ROOT);
if (!cwd.startsWith(installRoot + path.sep + 'releases' + path.sep)) throw new Error('Install escaped release staging');
fs.appendFileSync(process.env.CP_TEST_NPM_LOG, JSON.stringify({cwd,args}) + '\\n');
const mode = fs.readFileSync(process.env.CP_TEST_NPM_MODE, 'utf8');
if (mode === 'fail') process.exit(9);
const write = (rel, data) => { const file = path.join(cwd, rel); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, data); };
for (const name of ['express','pdfjs-dist','monaco-editor']) write('node_modules/' + name + '/package.json', JSON.stringify({name,version:'1.0.0'}));
for (const file of ['pdfjs-dist/build/pdf.mjs','pdfjs-dist/build/pdf.worker.mjs','monaco-editor/min/vs/loader.js']) write('node_modules/' + file, '// fake dependency');
if (mode === 'tamper') write('public/unapproved-test.html', 'must never activate');
`;
  write(bin, 'npm', fakeNpm); fs.chmodSync(path.join(bin, 'npm'), 0o755);
  write(root, 'npm-mode', 'fail');
  return { root, sourceRoot, dataRoot, installationRoot, first, nextRevision, bin };
}
function runUpdater(f, body, env = {}) {
  const script = `import fs from 'node:fs';
import {applyUpdate,checkForUpdates,getUpdateStatus} from ${JSON.stringify(pathToFileURL(path.join(APP, 'lib/updater.js')).href)};
import {readDeployment} from ${JSON.stringify(pathToFileURL(path.join(APP, 'lib/deployment.js')).href)};
const current = () => readDeployment(process.env.CP_INSTALLATION_ROOT);
${body}`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CP_INSTALLATION_ROOT: f.installationRoot, CP_UPDATE_REPO: f.sourceRoot,
      CP_ROOT: f.dataRoot, CP_NO_BILLED: '1', CP_PROJECTS_JSON: '{}', CP_NTFY_TOPIC: '',
      CP_TEST_NPM_LOG: path.join(f.root, 'npm-log'), CP_TEST_NPM_MODE: path.join(f.root, 'npm-mode'),
      PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
}

test('failed stage remains retryable after Git advances; success switches only verified runtime', async t => {
  const f = await fixture(t);
  const result = runUpdater(f, `
const initial = await checkForUpdates();
let failure; try { await applyUpdate(); } catch (e) { failure = {message:e.message,status:e.status}; }
const failedState = getUpdateStatus();
const afterFailure = current();
const retryStatus = await checkForUpdates();
fs.writeFileSync(process.env.CP_TEST_NPM_MODE, 'ok');
const success = await applyUpdate();
const afterSuccess = current();
const finalStatus = await checkForUpdates();
console.log('RESULT ' + JSON.stringify({initial,failure,failedState,afterFailure,retryStatus,success,afterSuccess,finalStatus}));
`);
  assert.equal(result.initial.behind, 1);
  assert.equal(result.failure.status, 500);
  assert.match(result.failure.message, /previous release retained/);
  assert.equal(result.failedState.state, 'error');
  assert.equal(result.afterFailure.active, f.first.active);
  assert.equal(result.afterFailure.sourceRevision, f.first.sourceRevision);
  assert.equal(result.retryStatus.behind, 1);
  assert.equal(result.retryStatus.head, f.nextRevision.slice(0, result.retryStatus.head.length));
  assert.equal(result.success.productionRelease, true);
  assert.equal(result.success.needsRestart, true);
  assert.equal(result.afterSuccess.sourceRevision, f.nextRevision);
  assert.equal(result.afterSuccess.previous, f.first.active);
  assert.notEqual(result.afterSuccess.active, f.first.active);
  assert.equal(result.finalStatus.behind, 0);
  assert.equal(fs.readFileSync(path.join(f.first.releaseRoot, 'app/server.js'), 'utf8'), '// initial');
  assert.equal(fs.readFileSync(path.join(result.afterSuccess.releaseRoot, 'app/server.js'), 'utf8'), '// updated');
  assert.equal(fs.existsSync(path.join(result.afterSuccess.releaseRoot, 'app/test')), false);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'app/test/new-safety.test.mjs')), true);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'app/node_modules')), false);
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'memory/history.json'), 'utf8'), '{"private":"unchanged"}');
  const installs = fs.readFileSync(path.join(f.root, 'npm-log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(installs.length, 2);
  assert(installs.every(call => call.cwd.startsWith(fs.realpathSync(f.installationRoot) + path.sep + 'releases' + path.sep)));
});

test('a stage containing an unapproved render cannot become active', async t => {
  const f = await fixture(t);
  write(f.root, 'npm-mode', 'tamper');
  const result = runUpdater(f, `
let failure; try { await applyUpdate(); } catch (e) { failure = {message:e.message,status:e.status}; }
console.log('RESULT ' + JSON.stringify({failure,current:current(),status:await checkForUpdates()}));
`);
  assert.equal(result.failure.status, 500);
  assert.match(result.failure.message, /unapproved/);
  assert.equal(result.current.active, f.first.active);
  assert.equal(result.status.behind, 1);
  assert.equal(git(f.sourceRoot, 'rev-parse', 'HEAD'), f.nextRevision);
  assert.equal(readDeployment(f.installationRoot).active, f.first.active);
});

test('dirty production source is blocked before merge or dependency execution', async t => {
  const f = await fixture(t);
  write(f.sourceRoot, 'unreviewed-runtime.js', '// uncommitted');
  const result = runUpdater(f, `
let failure; try { await applyUpdate(); } catch (e) { failure = {message:e.message,status:e.status}; }
console.log('RESULT ' + JSON.stringify({failure,current:current()}));
`);
  assert.equal(result.failure.status, 409);
  assert.match(result.failure.message, /local changes/);
  assert.equal(result.current.active, f.first.active);
  assert.equal(git(f.sourceRoot, 'rev-parse', 'HEAD'), f.first.sourceRevision);
  assert.equal(fs.existsSync(path.join(f.root, 'npm-log')), false);
});

test('a development update-repo override cannot redirect the production updater', async t => {
  const f = await fixture(t);
  const unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated);
  write(unrelated, 'keep.txt', 'untouched');
  write(f.root, 'npm-mode', 'ok');
  const result = runUpdater(f, `
const success = await applyUpdate();
console.log('RESULT ' + JSON.stringify({success,current:current()}));
`, { CP_UPDATE_REPO: unrelated });
  assert.equal(result.success.productionRelease, true);
  assert.equal(result.current.sourceRevision, f.nextRevision);
  assert.deepEqual(fs.readdirSync(unrelated), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'untouched');
});
