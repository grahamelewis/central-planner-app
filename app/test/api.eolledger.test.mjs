// The P-EOL-5 eol-normalize ledger (CONTRACT.md Phase 3 "EOL policy", A19;
// monaco-s2 §1 S2.1(c)): the FIRST save that normalizes a mixed-EOL file
// records a rewindable change-set — before-bytes captured SERVER-SIDE from
// disk at PUT time into the blob store, journaled by recordEditorSave with
// task:null (in-project) or the granting task's id (external pins), and
// restored byte-identically by the standing revert machinery. Everything here
// is unbilled: artifact/extfile PUTs plus GET/POST snapshot bookkeeping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb, taskId, extFile;

// byte-exact mixed fixture: BOM + CRLF + LF + lone CR, no final newline — the
// pattern an aggregate {from,to} profile cannot reconstruct, which is exactly
// why the ledger stores the pre-write BYTES (monaco-s2 §1 S2.1(c))
const MIXED = Buffer.from('\uFEFFone\r\ntwo\nthree\rfour', 'utf8');
const NORMALIZED = '\uFEFFone\ntwo\nthree\nfour'; // pure LF, BOM + no-final kept

const mtimeOf = (abs) => fs.statSync(abs).mtimeMs;
const entriesFor = async (rel) => {
  const { body } = await sb.fetchJson('GET', '/api/snapshots/alpha');
  return body.entries.filter((e) => (e.files || []).some((f) => f.rel === rel));
};

before(async () => {
  sb = await startSandbox({
    seed: ({ root, projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'mixed.tex'), MIXED);
      fs.writeFileSync(path.join(projRoots.alpha, 'twice.tex'), MIXED);
      fs.writeFileSync(path.join(projRoots.alpha, 'pure.tex'), 'alpha\r\nbeta\r\n');
      // disk-side disclosed gap: mixed but over the 2MB blob cap
      fs.writeFileSync(path.join(projRoots.alpha, 'huge.tex'), ('a\r\nb\nc\r').repeat(300000));
      // incoming-side disclosed gap: small mixed file, oversize incoming save
      fs.writeFileSync(path.join(projRoots.alpha, 'tiny-mixed.tex'), 'a\r\nb\nc\r');
      const extDir = path.join(root, 'external-notes');
      fs.mkdirSync(extDir, { recursive: true });
      extFile = path.join(extDir, 'notes.md');
      fs.writeFileSync(extFile, MIXED);
    },
  });
  // a real (unbilled) task whose file pin grants the external folder — the
  // api.extedit idiom; its id is what the extfile ledger entries attribute
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'eol ledger ext', description: 'x', category: 'calibration', oversight: 'coop',
  });
  taskId = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, { context: { files: [extFile] } });
});

after(async () => { if (sb) await sb.stop(); });

test('a normalizing artifact PUT records the eol-normalize change-set (task:null, before = the mixed disk bytes)', async () => {
  const abs = path.join(sb.projRoots.alpha, 'mixed.tex');
  const r = await sb.fetchJson('PUT', '/artifact/alpha/mixed.tex', {
    content: NORMALIZED, baseMtimeMs: mtimeOf(abs),
  });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(abs, 'utf8'), NORMALIZED, 'the save itself lands normally');

  const [entry, ...rest] = await entriesFor('mixed.tex');
  assert.ok(entry, 'the journal gained the eol-normalize entry');
  assert.deepEqual(rest, [], 'exactly one entry');
  assert.equal(entry.task, null, 'a dashboard save has no task to attribute');
  assert.equal(entry.origin, 'editor-save');
  assert.equal(entry.eol.to, 'LF');
  // the advisory load-profile census (P-EOL-5 "carrying the load profile")
  assert.deepEqual(entry.eol.from, { lf: 1, crlf: 1, cr: 1, bom: true, finalNewline: false });
  assert.equal(entry.files[0].status, 'modified');
  assert.ok(entry.files[0].adds >= 1 && entry.files[0].dels >= 1, 'the ± columns have real counts');

  const blob = await sb.fetchJson('GET', `/api/snapshots/alpha/${entry.id}/file?rel=mixed.tex`);
  assert.equal(blob.status, 200);
  assert.equal(blob.body.before, MIXED.toString('utf8'), 'before blob = the pre-write disk bytes');
  assert.equal(blob.body.after, NORMALIZED, 'after blob = the normalized content');
});

test('the REAL rewind: revert restores the original mixed bytes byte-identically and records revertOf', async () => {
  const abs = path.join(sb.projRoots.alpha, 'mixed.tex');
  const [entry] = await entriesFor('mixed.tex');
  const rev = await sb.fetchJson('POST', `/api/snapshots/alpha/${entry.id}/revert`, {});
  assert.equal(rev.status, 200);
  assert.equal(rev.body.ok, true);
  assert.ok(fs.readFileSync(abs).equals(MIXED), 'disk is BYTE-identical to the original mixed file');
  assert.equal(rev.body.entry.revertOf, entry.id, 'the rewind is its own journal entry');
  assert.equal(rev.body.entry.task, null, 'the revert of a task-less entry is task-less too');
  // disk is mixed again — the ledger genuinely re-arms: the client chip
  // re-detects on reopen (monacoPane eolProfile at model creation, verified
  // in ui.monaco-save) and the NEXT normalizing save records a fresh event
  const again = await sb.fetchJson('PUT', '/artifact/alpha/mixed.tex', {
    content: NORMALIZED, baseMtimeMs: mtimeOf(abs),
  });
  assert.equal(again.status, 200);
  assert.equal((await entriesFor('mixed.tex')).length, 3, 'save + revert + re-offered save');
});

test('only the FIRST normalizing save records — a pure follow-up save records nothing', async () => {
  const abs = path.join(sb.projRoots.alpha, 'twice.tex');
  const first = await sb.fetchJson('PUT', '/artifact/alpha/twice.tex', {
    content: NORMALIZED, baseMtimeMs: mtimeOf(abs),
  });
  assert.equal(first.status, 200);
  assert.equal((await entriesFor('twice.tex')).length, 1);
  const second = await sb.fetchJson('PUT', '/artifact/alpha/twice.tex', {
    content: NORMALIZED + '\nmore', baseMtimeMs: first.body.mtimeMs,
  });
  assert.equal(second.status, 200);
  assert.equal((await entriesFor('twice.tex')).length, 1, 'pure→pure round-trips are never events');
});

test('a pure file records no event (P-EOL-3 round-trip)', async () => {
  const abs = path.join(sb.projRoots.alpha, 'pure.tex');
  const r = await sb.fetchJson('PUT', '/artifact/alpha/pure.tex', {
    content: 'alpha\r\nbeta\r\ngamma\r\n', baseMtimeMs: mtimeOf(abs),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await entriesFor('pure.tex'), [], 'no event for pure files');
});

test('the ≤2MB blob limit is a DISCLOSED gap — oversize saves proceed, record nothing, and log', async () => {
  // disk side: a mixed file over the cap can't ride the blob store
  const huge = path.join(sb.projRoots.alpha, 'huge.tex');
  const r1 = await sb.fetchJson('PUT', '/artifact/alpha/huge.tex', {
    content: 'small now\n', baseMtimeMs: mtimeOf(huge),
  });
  assert.equal(r1.status, 200);
  assert.equal(fs.readFileSync(huge, 'utf8'), 'small now\n', 'the save is never blocked');
  assert.deepEqual(await entriesFor('huge.tex'), [], 'no event past the blob cap');
  assert.ok(sb.logs().includes('eol-normalize check skipped'), 'the gap is logged, not silent');
  // incoming side: an oversize after-blob is the same gap
  const tiny = path.join(sb.projRoots.alpha, 'tiny-mixed.tex');
  const r2 = await sb.fetchJson('PUT', '/artifact/alpha/tiny-mixed.tex', {
    content: 'y'.repeat(2 * 1024 * 1024 + 100) + '\n', baseMtimeMs: mtimeOf(tiny),
  });
  assert.equal(r2.status, 200);
  assert.deepEqual(await entriesFor('tiny-mixed.tex'), [], 'no event when the incoming side is oversize');
});

test('extfile leg: a granted pin normalizes the same way, attributed to the granting task, and rewinds', async () => {
  const r = await sb.fetchJson('PUT', `/api/extfile/alpha/${taskId}`, {
    path: extFile, content: NORMALIZED, baseMtimeMs: mtimeOf(extFile),
  });
  assert.equal(r.status, 200);
  const [entry] = await entriesFor(extFile);
  assert.ok(entry, 'the extfile PUT recorded the event');
  assert.equal(entry.task, taskId, 'attributed to the granting task (the stated purge trade-off)');
  assert.equal(entry.origin, 'editor-save');
  assert.equal(entry.files[0].external, true, 'external rel convention: absolute path + external flag');
  const rev = await sb.fetchJson('POST', `/api/snapshots/alpha/${entry.id}/revert`, {});
  assert.equal(rev.status, 200);
  assert.ok(fs.readFileSync(extFile).equals(MIXED), 'external rewind is byte-identical too');
});

test('the feed tolerates null-task entries (nullable taskId, no 500)', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/feed/alpha');
  assert.equal(status, 200);
  const edits = body.items.filter((i) => i.kind === 'edits');
  const nullRow = edits.find((i) => i.taskId === null && i.files.some((f) => f.rel === 'mixed.tex'));
  assert.ok(nullRow, 'the editor-save change-set rides the feed with taskId:null');
  const extRow = edits.find((i) => i.taskId === taskId && i.files.some((f) => f.external));
  assert.ok(extRow, 'the extfile event rides the feed under its task');
});

test('purgeTask: deleting the task removes ITS extfile ledger entries; task-less entries survive', async () => {
  const del = await sb.fetchJson('DELETE', `/api/tasks/alpha/${taskId}`);
  assert.equal(del.status, 200);
  assert.deepEqual(await entriesFor(extFile), [], 'extfile save + its revert died with the task');
  assert.ok((await entriesFor('mixed.tex')).length >= 3, 'dashboard (task:null) history survives task deletion');
});
