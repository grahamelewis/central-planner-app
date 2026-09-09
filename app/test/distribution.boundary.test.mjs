import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectIndex, violationsFor } from '../scripts/check-boundary.mjs';
import { installBoundaryHook, PRE_COMMIT } from '../scripts/install-boundary-hook.mjs';

const forbidden = [
  'app/docs/agentview-mockups/index.html', 'app/docs/new-mockups/mock.css',
  'app/docs/feedmark-mockups.html', 'app/docs/fence-toggle-mockup.html',
  'app/docs/new-report/nested/render.html', 'app/docs/language-support/RUNTIMES.md',
  'app/docs/token-efficiency-review/report.css', 'desktop/BLUEPRINT.html',
  'desktop/BLUEPRINT_AUDIT.txt', 'desktop/logo-concepts.html',
  'docs/screenshots/shot1-3pane.png', 'app/test-results/report.json',
  'app/playwright-report/index.html', 'app/coverage/coverage.json',
  'app/stata.log', 'server.log', '.local/research.html', '.artifacts/report.json',
  'research/notes.md', 'experiments/check.mjs', 'renders/screen.png',
  'app/experiments/check.mjs', 'app/renders/screen.png', 'app/research/notes.md',
  'app/.local/probe.mjs', 'app/.artifacts/result.json',
  '.env', '.env.production', 'app/.env', '.npmrc', 'private.pem',
  '.codex/auth.json', '.claude/settings.local.json',
  'memory/control.json', 'transcripts/project/task.json', 'tasks/private.json',
  'ledger/usage.jsonl', 'config.json', 'profile.json', 'categories.json',
  '.cache/tokens.json', 'app/node_modules/package/index.js', 'desktop/dist/App.app/main.js',
];
const allowed = [
  'app/server.js', 'app/public/index.html', 'app/public/m/index.html',
  'desktop/connecting.html', 'app/public/icons/icon-192.png', 'desktop/icon.svg',
  'app/public/mathMarkdown.js', 'app/lib/taskMemory.js', 'app/package-lock.json',
  'app/test/serverHarness.mjs', 'app/test/uiHarness.mjs',
  'app/test/distribution.boundary.test.mjs', 'app/test/privacy.boundary.test.mjs',
  'app/test/diagnostics/ui.console.repro.mjs', 'app/test/latex-corpus/goldens/inline-math.tex.json',
  'app/test/fixtures/fake-claude.mjs', 'app/test/monaco-matrix-run.json',
  'app/docs/memory-worker-recovery.md', 'app/docs/token-accounting.md',
  'app/docs/math-rendering-rules.md', 'app/scripts/release.mjs',
  'release-manifest.json', '.github/workflows/ci.yml', 'config.example.json',
  '.env.example', '.claude/commands/setup.md',
];

test('repository policy rejects research and generated output by path, not blanket file extension', () => {
  assert.deepEqual(violationsFor(forbidden).map(row => row.file), [...forbidden].sort());
  assert.deepEqual(violationsFor(allowed), []);
  assert.deepEqual(violationsFor(['app/public/mytest.js', 'app/lib/coverage.js']), []);
});

test('ignore rules match representative forbidden paths without hiding maintained source', () => {
  const root = new URL('../..', import.meta.url);
  const ignored = rel => {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', rel], { cwd: root, stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  assert.deepEqual(forbidden.filter(file => !ignored(file)), []);
  assert.deepEqual(allowed.filter(ignored), []);
});

test('index audit catches already tracked ignored files and ignores untracked local research', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const write = (rel, contents = 'fixture') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  };
  git('init');
  write('app/public/index.html');
  write('app/test/safety.test.mjs');
  write('app/docs/demo.html');
  git('add', '.');
  write('.gitignore', 'app/docs/\n*.log\n');
  write('app/docs/untracked.html');
  write('app/secret.log');
  // Deleting a working-tree file does not remove its indexed version.
  fs.unlinkSync(path.join(root, 'app/docs/demo.html'));
  const report = inspectIndex(path.join(root, 'app'));
  assert.deepEqual(report.violations.map(row => row.file), ['app/docs/demo.html']);
  assert.equal(report.files.includes('app/public/index.html'), true);
  assert.equal(report.files.includes('app/docs/untracked.html'), false);
  assert.equal(report.files.includes('app/secret.log'), false);
  git('rm', '--cached', '--', 'app/docs/demo.html');
  assert.deepEqual(inspectIndex(root).violations, []);
  git('add', '--force', '--', 'app/secret.log');
  assert.deepEqual(inspectIndex(root).violations.map(row => row.file), ['app/secret.log']);
  write('.env', 'TEST_ONLY=fixture');
  git('add', '--force', '--', '.env');
  assert.deepEqual(inspectIndex(root).violations.map(row => row.file), ['.env', 'app/secret.log']);
});

test('path handling is unambiguous for spaces, newlines, duplicate paths and nested reports', () => {
  const file = 'app/docs/a report\nwith newline.html';
  assert.deepEqual(violationsFor([file, file]).map(row => row.file), [file]);
  assert.equal(violationsFor(['app/docs/deep/nested/report.HTML']).length, 1);
});

function hookFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp boundary hook '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  git('init');
  fs.mkdirSync(path.join(root, '.githooks'));
  fs.writeFileSync(path.join(root, '.githooks/pre-commit'), PRE_COMMIT);
  fs.mkdirSync(path.join(root, 'app/scripts'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/check-boundary.mjs', import.meta.url), path.join(root, 'app/scripts/check-boundary.mjs'));
  return { root, git };
}

test('explicit hook setup is idempotent and blocks forbidden commits before publication', t => {
  const { root, git } = hookFixture(t);
  installBoundaryHook({ cwd: path.join(root, 'app') });
  installBoundaryHook({ cwd: root });
  assert.equal(git('config', '--get', 'core.hooksPath').trim(), '.githooks');
  git('add', '.');
  git('-c', 'user.name=Boundary Test', '-c', 'user.email=boundary@example.invalid', 'commit', '-m', 'allowed source');
  const before = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, '.env'), 'TEST_ONLY=fixture');
  git('add', '--force', '--', '.env');
  assert.throws(() => git('-c', 'user.name=Boundary Test', '-c', 'user.email=boundary@example.invalid', 'commit', '-m', 'must reject'), /boundary FAILED/);
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(fs.existsSync(path.join(root, '.env')), true, 'rejection preserves the local file');
});

test('hook setup refuses other hook managers and existing non-sample hooks without altering them', t => {
  const { root, git } = hookFixture(t);
  git('config', '--local', 'core.hooksPath', '/other-hook-manager');
  assert.throws(() => installBoundaryHook({ cwd: root }), /Existing core.hooksPath/);
  assert.equal(git('config', '--get', 'core.hooksPath').trim(), '/other-hook-manager');
  git('config', '--local', '--unset', 'core.hooksPath');
  const existing = path.join(root, '.git/hooks/pre-commit');
  fs.writeFileSync(existing, 'existing hook\n');
  assert.throws(() => installBoundaryHook({ cwd: root }), /non-sample/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing hook\n');
  assert.throws(() => git('config', '--get', 'core.hooksPath'));
});

test('hook setup rejects altered or additional versioned hooks and has no npm lifecycle side effects', t => {
  const { root, git } = hookFixture(t);
  fs.writeFileSync(path.join(root, '.githooks/pre-push'), 'not reviewed\n');
  assert.throws(() => installBoundaryHook({ cwd: root }), /Unexpected versioned hooks/);
  fs.unlinkSync(path.join(root, '.githooks/pre-push'));
  fs.writeFileSync(path.join(root, '.githooks/pre-commit'), 'changed\n');
  assert.throws(() => installBoundaryHook({ cwd: root }), /missing or changed/);
  assert.throws(() => git('config', '--get', 'core.hooksPath'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.prepare, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
});
