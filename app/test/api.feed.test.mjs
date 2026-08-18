// The sidebar's ◷ Recent activity feed: GET /api/feed/:project merges the Δ
// journal, finished-run history, and task completions, newest first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;
const mins = (n) => new Date(Date.now() - n * 60000).toISOString();

before(async () => {
  sb = await startSandbox({
    seed: ({ root }) => {
      const sd = path.join(root, 'snapshots', 'alpha');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'journal.json'), JSON.stringify([
        { id: 'e2', task: 'alp-001', ts: mins(5), files: [{ rel: 'setUp.jl', status: 'modified', edits: 1, adds: 3, dels: 1 }] },
        {
          id: 'e1', task: 'alp-001', ts: mins(60), revertOf: 'e0',
          files: [{ rel: 'a.R', status: 'modified', edits: 1, adds: 0, dels: 4 }],
        },
      ]));
      fs.writeFileSync(path.join(root, 'jobhist.json'), JSON.stringify({
        alpha: [
          { ts: mins(30), file: 'fig3.jl', lang: 'julia', source: 'session', state: 'done', ms: 360000, taskId: 'alp-001' },
        ],
      }));
    },
  });
  const { body: t1 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'calibration', description: 'x', category: 'calibration', oversight: 'coop',
  });
  assert.equal(t1.id, 'alp-001'); // the journal above belongs to this task
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Moment Calculations', description: 'x', category: 'calibration', oversight: 'coop',
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t2.id}`, {
    status: 'done', archived: true, logNote: 'handoff accepted by user — done',
  });
});

after(async () => { if (sb) await sb.stop(); });

test('the feed merges edits, runs and completions newest-first', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/feed/alpha');
  assert.equal(status, 200);
  const kinds = body.items.map((i) => i.kind);
  // done row was stamped seconds ago; then the 5m edit, 30m run, 60m rewind
  assert.deepEqual(kinds, ['done', 'edits', 'run', 'edits']);
  const [done, edit, run, rewind] = body.items;
  assert.equal(done.title, 'Moment Calculations');
  assert.ok(done.taskId);
  assert.equal(edit.eid, 'e2');
  assert.equal(edit.taskId, 'alp-001');
  assert.equal(edit.adds, 3);
  assert.equal(edit.dels, 1);
  assert.deepEqual(edit.files[0], { rel: 'setUp.jl', status: 'modified', adds: 3, dels: 1 });
  assert.equal(run.file, 'fig3.jl');
  assert.equal(run.state, 'done');
  assert.equal(run.ms, 360000);
  assert.equal(rewind.revert, true, 'rewind change-sets are flagged');
});

test('unknown project → 404; empty project → empty items', async () => {
  const bad = await sb.fetchJson('GET', '/api/feed/nope');
  assert.equal(bad.status, 404);
  const empty = await sb.fetchJson('GET', '/api/feed/beta');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
});
