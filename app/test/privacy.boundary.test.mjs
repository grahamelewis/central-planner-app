// The public app repo must never absorb the local data root. This regression
// test makes the privacy boundary executable: removing an ignore rule or
// putting personal defaults into the shipped config example fails CI before a
// release can publish it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');

function ignored(rel) {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', rel], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

test('public repository ignores every local state and credential surface', () => {
  const privatePaths = [
    'config.json', 'profile.json', 'categories.json', 'jobhist.json',
    'tasks/example.json', 'transcripts/example/task.json',
    'snapshots/example/journal.json', 'ledger/ledger.jsonl',
    'abstracts/example.md', 'decisions/example.json', 'plan/calendar.json',
    '.cache/gcal.json', '.claude/settings.local.json', '.codex/auth.json',
    '.env', '.env.local', '.npmrc', 'private-key.pem',
    'app/docs/private/design.html', 'app/docs/local-diagnosis.txt',
    'dashboard_hybrid.html',
    'dashboard_templates.html', 'mockups/private-board.html',
  ];
  const leaked = privatePaths.filter((rel) => !ignored(rel));
  assert.deepEqual(leaked, [], `private paths not ignored: ${leaked.join(', ')}`);
});

test('source, setup command, and sanitized examples remain publishable', () => {
  const publicPaths = [
    'app/server.js', 'desktop/main.js', 'config.example.json',
    'categories.example.json', '.claude/commands/setup.md',
  ];
  const hidden = publicPaths.filter(ignored);
  assert.deepEqual(hidden, [], `publishable paths accidentally ignored: ${hidden.join(', ')}`);
});

test('shipped config example contains placeholders, never personal defaults', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.user?.name, '', 'example user name must stay blank');
  assert.equal(example.notifications?.ntfyTopic, '', 'example ntfy topic must stay blank');
  assert.equal(example.notifications?.ntfyClickBase, '', 'example notification URL must stay blank');
  for (const project of Object.values(example.projects || {}).filter(
    (value) => value && typeof value === 'object',
  )) {
    assert.match(project.root || '', /^\/absolute\/path\/to\//,
      'example project roots must be obvious placeholders');
  }
});
