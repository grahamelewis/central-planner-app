// test/snapshots.counts.test.mjs — the Δ tab's numbers: diffCounts (±lines),
// per-file edit counts, and the live mid-turn aggregate (liveCounts).
// snapshots.js writes under ROOT/snapshots, so CP_ROOT is pinned to a temp dir
// BEFORE the module (and config.js) loads — nothing touches the real repo.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, rmTmp } from './helpers.mjs';

const root = mkTmp('cp-snapcounts-');
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = '{}';

const { PROJECTS } = await import('../lib/config.js');
const { createTracker, diffCounts, revertSnapshot } = await import('../lib/snapshots.js');
const { createTask, updateTask } = await import('../lib/taskStore.js');

const projRoot = fs.realpathSync(fs.mkdtempSync(path.join(root, 'proj-')));
PROJECTS.snaptest = { name: 'snaptest', root: projRoot, color: '#fff', texWatch: null };

after(() => rmTmp(root));

const write = (rel, text) => {
  const abs = path.join(projRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};

describe('diffCounts', () => {
  test('a replaced line is +1 −1', () => {
    assert.deepEqual(diffCounts('a\nb\nc\n', 'a\nX\nc\n'), { adds: 1, dels: 1 });
  });
  test('pure additions and deletions', () => {
    assert.deepEqual(diffCounts('a\n', 'a\nb\nc\n'), { adds: 2, dels: 0 });
    assert.deepEqual(diffCounts('a\nb\nc\n', 'a\n'), { adds: 0, dels: 2 });
  });
  test('unchanged lines INSIDE the change region are not counted (LCS)', () => {
    // 'b' and 'c' survive between the edits — prefix/suffix trimming alone
    // would count them as ±
    assert.deepEqual(diffCounts('a\nb\nc\nd\n', 'a\nX\nb\nc\nY\n'), { adds: 2, dels: 1 });
  });
  test('identical and empty inputs are zero', () => {
    assert.deepEqual(diffCounts('same\n', 'same\n'), { adds: 0, dels: 0 });
    assert.deepEqual(diffCounts('', ''), { adds: 0, dels: 0 });
    assert.deepEqual(diffCounts(null, null), { adds: 0, dels: 0 });
  });
});

describe('createTracker — edit counts and ±lines in the change-set', () => {
  test('every edit call counts; the recorded file carries edits/adds/dels', () => {
    write('m/setup.jl', 'a\nb\nc\n');
    const tr = createTracker('snaptest', 'tsk-1');
    const abs = path.join(projRoot, 'm/setup.jl');
    tr.note(abs);              // edit 1 — captures the before-state
    write('m/setup.jl', 'a\nX\nc\n');
    tr.note(abs);              // edit 2
    tr.note(abs);              // edit 3
    write('m/setup.jl', 'a\nX\nc\nd\n');
    const entry = tr.finish();
    assert.ok(entry, 'a change-set is recorded');
    assert.equal(entry.files.length, 1);
    const f = entry.files[0];
    assert.equal(f.rel, 'm/setup.jl');
    assert.equal(f.status, 'modified');
    assert.equal(f.edits, 3, 'three edit tool calls hit the file');
    assert.equal(f.adds, 2, 'X replaced b, d appended');
    assert.equal(f.dels, 1);
  });

  test('a created file records all lines as adds', () => {
    const tr = createTracker('snaptest', 'tsk-2');
    const abs = path.join(projRoot, 'fresh.jl');
    tr.note(abs);                      // file does not exist yet
    write('fresh.jl', 'one\ntwo\nthree\n');
    const entry = tr.finish();
    const f = entry.files[0];
    assert.equal(f.status, 'created');
    assert.equal(f.edits, 1);
    assert.equal(f.adds, 3, 'trailing newline must not add a phantom line');
    assert.equal(f.dels, 0);
  });
});

describe('createTracker.liveCounts — the mid-turn ✎ aggregate', () => {
  test('aggregates per-file counts as edits land, and settles when undone', () => {
    write('one.jl', 'a\nb\n');
    const tr = createTracker('snaptest', 'tsk-3');
    const one = path.join(projRoot, 'one.jl');
    const two = path.join(projRoot, 'two.jl');

    tr.note(one);
    write('one.jl', 'a\nB\n');
    let sum = tr.liveCounts(one);
    assert.deepEqual(sum, { files: 1, created: 0, modified: 1, deleted: 0, adds: 1, dels: 1 });

    tr.note(two);                      // brand-new file
    write('two.jl', 'x\ny\nz\n');
    sum = tr.liveCounts(two);
    assert.deepEqual(sum, { files: 2, created: 1, modified: 1, deleted: 0, adds: 4, dels: 1 });

    // the session puts one.jl back exactly as it was — it drops out live
    write('one.jl', 'a\nb\n');
    sum = tr.liveCounts(one);
    assert.deepEqual(sum, { files: 1, created: 1, modified: 0, deleted: 0, adds: 3, dels: 0 });

    // and the recorded change-set agrees with the live view
    const entry = tr.finish();
    assert.equal(entry.files.length, 1, 'the reverted-in-place file is not recorded');
    assert.equal(entry.files[0].rel, 'two.jl');
  });

  test('an untracked path aggregates without exploding', () => {
    const tr = createTracker('snaptest', 'tsk-4');
    assert.deepEqual(tr.liveCounts('/nowhere/else.jl'),
      { files: 0, created: 0, modified: 0, deleted: 0, adds: 0, dels: 0 });
  });
});

describe('createTracker — external pins (outside the project root)', () => {
  // a granted external FOLDER pin, living outside projRoot
  const extDir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'extlib-')));
  const extFile = path.join(extDir, 'shared.jl');
  const files = [extDir + '/']; // folder pin, trailing slash

  test('an edit to a granted external file is captured with external:true', () => {
    fs.writeFileSync(extFile, 'a\nb\nc\n');
    const tr = createTracker('snaptest', 'ext-1', files);
    tr.note(extFile);
    fs.writeFileSync(extFile, 'a\nX\nc\n');
    const entry = tr.finish();
    assert.ok(entry, 'external change recorded');
    assert.equal(entry.files.length, 1);
    const f = entry.files[0];
    assert.equal(f.rel, extFile, 'keyed by its absolute path');
    assert.equal(f.external, true);
    assert.equal(f.status, 'modified');
    assert.deepEqual([f.adds, f.dels], [1, 1]);
  });

  test('an UNGRANTED outside path is never tracked', () => {
    const stray = path.join(root, 'not-pinned.jl'); // outside extDir AND projRoot
    fs.writeFileSync(stray, 'x\n');
    const tr = createTracker('snaptest', 'ext-2', files);
    tr.note(stray);
    fs.writeFileSync(stray, 'y\n');
    assert.equal(tr.finish(), null, 'nothing recorded — path not granted');
  });

  test('a NEW external file (leaf not yet created) records as created', () => {
    const tr = createTracker('snaptest', 'ext-3', files);
    const fresh = path.join(extDir, 'brand_new.jl');
    tr.note(fresh);                       // does not exist yet
    fs.writeFileSync(fresh, 'l1\nl2\n');
    const entry = tr.finish();
    const f = entry.files[0];
    assert.equal(f.external, true);
    assert.equal(f.status, 'created');
    assert.deepEqual([f.adds, f.dels], [2, 0]);
  });

  test('rewind restores a granted external file — and refuses once its pin is gone', () => {
    const task = createTask('snaptest', { title: 'ext task', context: { files } });
    fs.writeFileSync(extFile, 'orig\n');
    const tr = createTracker('snaptest', task.id, files);
    tr.note(extFile);
    fs.writeFileSync(extFile, 'edited\n');
    const entry = tr.finish();

    const ok = revertSnapshot('snaptest', entry.id, extFile);
    assert.ok(ok.ok, 'rewind succeeded');
    assert.equal(fs.readFileSync(extFile, 'utf8'), 'orig\n', 'external file restored to before-state');

    // remove the pin → a later rewind of an external entry must refuse
    updateTask('snaptest', task.id, { context: { files: [] } });
    fs.writeFileSync(extFile, 'again\n');
    const tr2 = createTracker('snaptest', task.id, files);
    tr2.note(extFile);
    fs.writeFileSync(extFile, 'more\n');
    const e2 = tr2.finish();
    const denied = revertSnapshot('snaptest', e2.id, extFile);
    assert.ok(denied.error && /no longer granted/.test(denied.error), 'refused — pin removed');
    assert.equal(fs.readFileSync(extFile, 'utf8'), 'more\n', 'file untouched when denied');
  });
});

describe('sessions.js wiring (source-level)', () => {
  const src = fs.readFileSync(new URL('../lib/sessions.js', import.meta.url), 'utf8');
  test('a successful edit tool result broadcasts the live aggregate', () => {
    assert.match(src, /snapTracker\.liveCounts\(/, 'live counts computed off the tracker');
    assert.match(src, /broadcast\('session:edits'/, 'session:edits event emitted');
  });
});
