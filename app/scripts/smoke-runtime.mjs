// Run the actual production payload with disposable state and all provider,
// notification, updater and external-tool integrations disabled. No source
// node_modules fallback: the child must resolve its own installed dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { verifyRelease } from '../lib/release.js';

const releaseRoot = process.argv[2];
if (!releaseRoot || process.argv.length !== 3) throw new Error('Usage: node app/scripts/smoke-runtime.mjs /absolute/release');
verifyRelease({ root: releaseRoot, requireDependencies: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-release-smoke-')));
const project = path.join(root, 'project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'report.html'), '<h1>User report</h1>');
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ kaimon: false, projects: { smoke: { name: 'smoke', root: project } }, notifications: { turnEnd: false } }));
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
});
const child = spawn(process.execPath, [path.join(path.resolve(releaseRoot), 'app/server.js')], {
  cwd: path.join(path.resolve(releaseRoot), 'app'),
  env: { ...process.env, NODE_ENV: 'production', NODE_PATH: '', CP_INSTALLATION_ROOT: '',
    CP_ROOT: root, CP_PORT: String(port), CP_PROJECTS_JSON: '', CP_NO_BILLED: '1', CP_NTFY_TOPIC: '',
    ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CP_UPDATE_REPO: root,
    CP_CLAUDE_BIN: '/nonexistent-claude', CP_CODEX_BIN: '/nonexistent-codex',
    CP_KAIMON_BIN: '/nonexistent-kaimon', CP_KAIMON_CONFIG_DIR: path.join(root, 'kaimon'),
    CP_TAILSCALE_BIN: '', CP_AUTH_BOOT_MS: '50', CP_CODEX_BOOT_MS: '50' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
let spawnError; child.on('error', error => { spawnError = error; });
const base = `http://127.0.0.1:${port}`;
try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Production server exited: ${logs}`);
    try { ready = (await fetch(base + '/api/state', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Production server did not become ready: ${logs}`);
  for (const url of ['/', '/m/', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png',
    '/vendor/pdfjs/pdf.mjs', '/vendor/pdfjs/pdf.worker.mjs', '/vendor/monaco/vs/loader.js', '/api/state',
    '/api/memory/settings', '/artifact/smoke/report.html']) {
    assert.equal((await fetch(base + url, { signal: AbortSignal.timeout(3000) })).status, 200, url);
  }
  for (const url of ['/test/serverHarness.mjs', '/docs/codex-mockups/index.html', '/release.json', '/release-manifest.json']) {
    assert.equal((await fetch(base + url)).status, 404, `Development/control file exposed: ${url}`);
  }
  const state = await (await fetch(base + '/api/state')).json();
  assert.ok(Object.keys(state.categories).length, 'Shipped category fallback must work with separate data root');
  assert.equal(state.projects.smoke.root, project, 'Uses isolated configured project');
  console.log('Production runtime smoke passed: desktop/mobile assets, Monaco/PDF, API, separate data, and negative exposure checks.');
} finally {
  if (child.exitCode === null && !spawnError) await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
  // This exact disposable directory is owned by this invocation only.
  fs.rmSync(root, { recursive: true, force: true });
}
