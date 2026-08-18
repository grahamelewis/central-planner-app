// test/api.update.test.mjs — the dashboard self-updater (lib/updater.js).
// A throwaway origin (bare repo) + a deploy clone stand in for GitHub and the
// user's checkout; CP_UPDATE_REPO points the sandbox server at the clone, so
// nothing ever touches the real repo and no network is involved. The fixture
// commits deliberately avoid app/package*.json — changing those would make
// applyUpdate run a REAL `npm install` in the app dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSandbox } from './serverHarness.mjs';
import { mkTmp, rmTmp } from './helpers.mjs';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const opts = { skip: hasGit ? false : 'git not installed' };

let fx;        // fixture dir: origin.git (bare) + work (author clone) + deploy
let sb;        // sandbox whose CP_UPDATE_REPO = deploy
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim();

before(async () => {
  if (!hasGit) return;
  fx = mkTmp('cp-update-');
  const origin = path.join(fx, 'origin.git');
  const work = path.join(fx, 'work');
  const deploy = path.join(fx, 'deploy');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
  for (const dir of [work]) {
    g(dir, 'config', 'user.email', 'test@example.com');
    g(dir, 'config', 'user.name', 'Fixture');
  }
  fs.writeFileSync(path.join(work, 'README.md'), 'Central Planner fixture\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'first release');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', '-u', 'origin', 'main');

  // the "user's checkout" — clones get their upstream configured automatically
  execFileSync('git', ['clone', '-q', origin, deploy], { stdio: 'ignore' });
  g(deploy, 'config', 'user.email', 'user@example.com');
  g(deploy, 'config', 'user.name', 'User');

  // origin moves ahead by one commit
  fs.writeFileSync(path.join(work, 'FEATURE.md'), 'new goodies\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'add agent teams to the console');
  g(work, 'push', '-q', 'origin', 'main');

  sb = await startSandbox({ updateRepo: deploy });
  fx = { dir: fx, origin, work, deploy };
});
after(async () => {
  if (sb) await sb.stop();
  if (fx) rmTmp(fx.dir || fx);
});

test('check reports how far behind origin the checkout is', opts, async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/update/check');
  assert.equal(status, 200);
  assert.equal(body.state, 'behind');
  assert.equal(body.behind, 1);
  assert.equal(body.ahead, 0);
  assert.equal(body.dirty, false);
  assert.equal(body.branch, 'main');
  assert.match(body.upstream, /origin\/main/);
  assert.equal(body.commits.length, 1);
  assert.equal(body.commits[0].subject, 'add agent teams to the console');
  assert.ok(body.lastChecked, 'stamps the check time');
});

test('the snapshot carries the update status for the badge', opts, async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(body.update.state, 'behind');
  assert.equal(body.update.behind, 1);
});

test('update refuses while tracked local changes exist', opts, async () => {
  fs.appendFileSync(path.join(fx.deploy, 'README.md'), 'local tinkering\n');
  const { status, body } = await sb.fetchJson('POST', '/api/update');
  assert.equal(status, 409);
  assert.match(body.error, /local changes/);
  g(fx.deploy, 'checkout', '--', 'README.md'); // tidy for the next test
});

test('update fast-forwards the checkout and clears the badge', opts, async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/update');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.from && body.to && body.from !== body.to, `moved ${body.from} → ${body.to}`);
  assert.equal(body.needsRestart, true);
  assert.equal(body.npmInstalled, false, 'no app/package*.json in the delta — npm untouched');
  assert.ok(fs.existsSync(path.join(fx.deploy, 'FEATURE.md')), 'origin commit landed on disk');

  const { body: s } = await sb.fetchJson('POST', '/api/update/check');
  assert.equal(s.state, 'ok');
  assert.equal(s.behind, 0);
  assert.deepEqual(s.updated && { from: s.updated.from, to: s.updated.to }, { from: body.from, to: body.to },
    'the updated note survives for the Settings card');
});

test('an already-current checkout is a clean no-op', opts, async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/update');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, alreadyUpToDate: true });
});

test('diverged local commits refuse with a manual-resolution message', opts, async () => {
  // local commit in the checkout…
  fs.writeFileSync(path.join(fx.deploy, 'LOCAL.md'), 'my own patch\n');
  g(fx.deploy, 'add', '.');
  g(fx.deploy, 'commit', '-m', 'local divergence');
  // …while origin moves on too
  fs.writeFileSync(path.join(fx.work, 'MORE.md'), 'more upstream work\n');
  g(fx.work, 'add', '.');
  g(fx.work, 'commit', '-m', 'upstream keeps moving');
  g(fx.work, 'push', '-q', 'origin', 'main');

  const { status, body } = await sb.fetchJson('POST', '/api/update');
  assert.equal(status, 409);
  assert.match(body.error, /diverge/);
});

test('a non-repo checkout reports updates as unmanaged', opts, async () => {
  const plain = await startSandbox(); // harness default: CP_UPDATE_REPO = sandbox root
  try {
    const { status, body } = await plain.fetchJson('POST', '/api/update/check');
    assert.equal(status, 200);
    assert.equal(body.state, 'unavailable');
    assert.match(body.error, /not a git checkout/);
    const upd = await plain.fetchJson('POST', '/api/update');
    assert.equal(upd.status, 400);
  } finally {
    await plain.stop();
  }
});
