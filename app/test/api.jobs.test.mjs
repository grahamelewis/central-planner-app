// Job cards end-to-end through the real server: ▶ run a script, watch the
// job appear in the /api/state snapshot with live stats + parsed progress,
// stop it through the card's route. Uses a .sh fixture so the test needs no
// scientific stack; jobs.test.mjs covers real julia/R processes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

// fast thresholds for the sandbox server (inherited via process.env spread)
process.env.CP_JOB_MIN_AGE_MS = '500';
process.env.CP_JOB_POLL_MS = '300';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'loop.sh'),
        'for i in $(seq 1 120); do echo "iter $i/120"; sleep 0.25; done\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'quick.sh'), 'echo done\n');
    },
  });
});

after(async () => { if (sb) await sb.stop(); });

test('a ▶ run surfaces a visible job with pid, stats, and parsed progress', async () => {
  const { status } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'loop.sh' });
  assert.equal(status, 200);
  const state = await sb.poll('/api/state', (b) =>
    Array.isArray(b.jobs) && b.jobs.some((j) => j.key === 'run:alpha' && j.progress), { timeoutMs: 15000 });
  const j = state.jobs.find((x) => x.key === 'run:alpha');
  assert.equal(j.source, 'run');
  assert.equal(j.project, 'alpha');
  assert.equal(j.file, 'loop.sh');
  assert.equal(j.lang, 'shell');
  assert.equal(j.state, 'running');
  assert.ok(j.pid > 0, 'runner pid exposed');
  assert.ok(j.elapsedMs > 0);
  assert.equal(j.progress.total, 120);
  assert.ok(j.progress.iter >= 1);
  assert.ok(j.progress.frac > 0 && j.progress.frac < 1);
  assert.ok(j.quietMs != null, 'quiet clock present for runner jobs');
});

test('POST /api/jobs/:project/stop ends the run and the job reports stopped', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/jobs/alpha/stop', { key: 'run:alpha' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  await sb.poll('/api/state', (b) => b.runs?.alpha?.state === 'stopped', { timeoutMs: 8000 });
  const state = await sb.poll('/api/state', (b) =>
    (b.jobs || []).some((j) => j.key === 'run:alpha' && j.state === 'stopped'), { timeoutMs: 8000 });
  const j = state.jobs.find((x) => x.key === 'run:alpha');
  assert.equal(j.state, 'stopped');
  assert.ok(j.ms > 0, 'final duration recorded');
});

test('stop with an unknown session key → 404; unknown project → 404', async () => {
  const bad = await sb.fetchJson('POST', '/api/jobs/alpha/stop', { key: 'sess:alpha/x/y' });
  assert.equal(bad.status, 404);
  const badProj = await sb.fetchJson('POST', '/api/jobs/nope/stop', { key: 'run:nope' });
  assert.equal(badProj.status, 404);
});

test('a quick run never surfaces a job card', async () => {
  await sb.poll('/api/state', (b) => b.runs?.alpha?.state !== 'running', { timeoutMs: 8000 });
  const { status } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'quick.sh' });
  assert.equal(status, 200);
  await sb.poll('/api/state', (b) => b.runs?.alpha?.state === 'done' && b.runs?.alpha?.rel === 'quick.sh',
    { timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 900)); // past MIN_AGE + a few polls
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.ok(!(body.jobs || []).some((j) => j.file === 'quick.sh'),
    'sub-threshold runs come and go without a card');
});
