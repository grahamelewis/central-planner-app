// A losing desktop/launchd race must exit before ANY startup mutation. This is
// the server-side guarantee that makes on-demand desktop start safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('EADDRINUSE exits and leaves stranded-task state untouched', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bind-race-')));
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.mkdirSync(path.join(root, 'abstracts'));
  fs.writeFileSync(path.join(root, 'categories.json'), '{}');
  const tasksFile = path.join(root, 'tasks', 'alpha.json');
  fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'alp-001', project: 'alpha', status: 'running', log: [] }], null, 2));

  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(0, '127.0.0.1', resolve);
  });
  const port = squatter.address().port;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      CP_ROOT: root,
      CP_PORT: String(port),
      CP_PROJECTS_JSON: JSON.stringify({ alpha: { name: 'alpha', root: projectRoot, color: '#abc', texWatch: null } }),
      CP_NO_BILLED: '1',
      CP_TAILSCALE_BIN: '',
      CP_KAIMON_BIN: '/nonexistent-kaimon',
      CP_CLAUDE_BIN: '/nonexistent-claude',
      CP_CODEX_BIN: '/nonexistent-codex',
      CP_UPDATE_REPO: root,
      CP_NTFY_TOPIC: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  let timer;
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`collision child did not exit:\n${logs}`)), 5000); }),
  ]).finally(() => {
    clearTimeout(timer);
    return new Promise((resolve) => squatter.close(resolve));
  });

  assert.notEqual(code, 0);
  assert.match(logs, /EADDRINUSE/);
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.equal(tasks[0].status, 'running');
  assert.deepEqual(tasks[0].log, []);
});
