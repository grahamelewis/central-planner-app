// Regression: generated-image trees must not consume one persistent descriptor
// per file. The watcher uses one native recursive subscription per project,
// while preserving live artifact events and leaving child-process spawn healthy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      const bulk = path.join(projRoots.alpha, 'output', 'plots');
      fs.mkdirSync(bulk, { recursive: true });
      for (let i = 0; i < 2500; i++) {
        fs.writeFileSync(path.join(bulk, `figure-${String(i).padStart(4, '0')}.png`), 'x');
      }
      fs.writeFileSync(path.join(projRoots.alpha, 'spawn-check.sh'), 'printf "watcher-spawn-ok\\n"\n');
    },
  });
});

after(async () => { if (sb) await sb.stop(); });

test('large generated trees keep one native watcher per project and child spawn remains healthy', async () => {
  await sb.poll('/api/state', () => (
    /artifact watcher ready: alpha \(native recursive;/.test(sb.logs())
    && /artifact watcher ready: beta \(native recursive;/.test(sb.logs())
  ));
  assert.match(sb.logs(), /2 subscriptions total/, 'subscriptions scale with projects, not files');
  assert.doesNotMatch(sb.logs(), /spawn EBADF|filesystem watch resources exhausted/);

  const started = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'spawn-check.sh' });
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  const done = await sb.poll('/api/state', (s) => s.runs?.alpha?.state === 'done');
  assert.match(done.runs.alpha.tail, /watcher-spawn-ok/);
});

test('artifacts created inside the large output tree still arrive live', async () => {
  const rel = path.join('output', 'plots', 'late-report.html');
  fs.writeFileSync(path.join(sb.projRoots.alpha, rel), '<h1>late</h1>');
  const state = await sb.poll('/api/state', (s) => (
    (s.artifacts || []).some((a) => a.project === 'alpha' && a.rel === rel)
  ));
  assert.ok(state.artifacts.some((a) => a.project === 'alpha' && a.rel === rel));
});
