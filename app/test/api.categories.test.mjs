// /api/categories + /api/catgroups — the Manage Categories editor's server
// side. The load-bearing semantics under test:
//   · RENAME propagates — every task ever tagged with the old key is retagged,
//     past and present, across all projects
//   · DELETE (category or group) never touches tasks — the past keeps its
//     labels; only the pickers lose the option
//   · unknown legacy fields (defaults.artifact etc.) survive edits untouched
// All routes are unbilled (pure JSON writes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;
const CATS = {
  theory: {
    group: 'Structural', name: 'theory', icon: '∂',
    primer: 'Build the model.',
    defaults: { web_search: true, artifact_dir: 'riffing/' }, // legacy key must survive
  },
  computation: {
    group: 'Structural', name: 'computation', icon: '⚙',
    primer: 'Solve the model.',
    defaults: { web_search: false },
  },
  'structural estimation': {
    group: 'Structural', name: 'estimation', icon: '⌖',
    primer: 'SMM loops.',
    defaults: { web_search: false },
  },
  slides: {
    group: 'Final Goods', name: 'slides', icon: '▤',
    primer: 'Beamer.',
    defaults: { web_search: false },
  },
};

const readCatsFile = () =>
  JSON.parse(fs.readFileSync(path.join(sb.root, 'categories.json'), 'utf8'));

before(async () => {
  sb = await startSandbox({
    seed: ({ root }) => {
      fs.writeFileSync(path.join(root, 'categories.json'), JSON.stringify(CATS, null, 2));
    },
  });
  // tasks in BOTH projects wearing the soon-to-be-renamed category
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'old theory 1', category: 'theory' });
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'old theory 2', category: 'theory' });
  await sb.fetchJson('POST', '/api/tasks', { project: 'beta', title: 'cross-project theory', category: 'theory' });
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'unrelated', category: 'slides' });
});
after(async () => { if (sb) await sb.stop(); });

test('update edits fields and preserves unknown legacy defaults', async () => {
  const { status, body } = await sb.fetchJson('PATCH', '/api/categories/theory', {
    icon: '∴', primer: 'Whiteboard first.', webSearch: false,
  });
  assert.equal(status, 200);
  assert.equal(body.category.icon, '∴');
  assert.equal(body.category.primer, 'Whiteboard first.');
  assert.equal(body.category.defaults.web_search, false);
  assert.equal(body.category.defaults.artifact_dir, 'riffing/', 'legacy defaults key survives');
  assert.equal(body.category.group, 'Structural', 'untouched fields keep their values');
  assert.equal(readCatsFile().theory.icon, '∴', 'written to disk');
});

test('create adds a category; duplicates 409; garbage 400', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/categories', {
    key: 'refereeing', icon: '⚖', group: 'Final Goods', primer: 'Review like a referee.', webSearch: true,
  });
  assert.equal(status, 201);
  assert.equal(body.category.name, 'refereeing');
  assert.equal(body.category.defaults.web_search, true);

  const dup = await sb.fetchJson('POST', '/api/categories', { key: 'refereeing' });
  assert.equal(dup.status, 409);
  const empty = await sb.fetchJson('POST', '/api/categories', { key: '   ' });
  assert.equal(empty.status, 400);
  const huge = await sb.fetchJson('POST', '/api/categories', { key: 'x'.repeat(80) });
  assert.equal(huge.status, 400);
});

test('RENAME retags every task — past and present, across projects', async () => {
  const { status, body } = await sb.fetchJson('POST', `/api/categories/${encodeURIComponent('theory')}/rename`, {
    to: 'model building',
  });
  assert.equal(status, 200);
  assert.equal(body.key, 'model building');
  assert.equal(body.retagged, 3, 'two alpha tasks + one beta task moved');

  const cats = readCatsFile();
  assert.ok(!cats.theory, 'old key gone');
  assert.equal(cats['model building'].name, 'model building', 'display name unified with the key');
  assert.equal(cats['model building'].primer, 'Whiteboard first.', 'content carried over');
  assert.deepEqual(Object.keys(cats).indexOf('model building'), 0, 'key keeps its position (group order stable)');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const all = [...state.tasks.alpha, ...state.tasks.beta];
  assert.equal(all.filter(t => t.category === 'model building').length, 3);
  assert.equal(all.filter(t => t.category === 'theory').length, 0, 'no task left behind');
  assert.equal(all.find(t => t.title === 'unrelated').category, 'slides', 'other categories untouched');
});

test('rename to an existing key 409s; unknown key 404s; no-op rename is safe', async () => {
  const clash = await sb.fetchJson('POST', `/api/categories/${encodeURIComponent('model building')}/rename`, { to: 'slides' });
  assert.equal(clash.status, 409);
  const ghost = await sb.fetchJson('POST', '/api/categories/nope/rename', { to: 'whatever' });
  assert.equal(ghost.status, 404);
  const noop = await sb.fetchJson('POST', `/api/categories/${encodeURIComponent('model building')}/rename`, { to: 'model building' });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.retagged, 0);
});

test('DELETE removes the category but tasks keep their label', async () => {
  const { status } = await sb.fetchJson('DELETE', `/api/categories/${encodeURIComponent('model building')}`);
  assert.equal(status, 200);
  assert.ok(!readCatsFile()['model building']);

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const all = [...state.tasks.alpha, ...state.tasks.beta];
  assert.equal(all.filter(t => t.category === 'model building').length, 3,
    'the past is not rewritten — tasks keep the dangling label');
  assert.ok(!state.categories['model building'], 'snapshot no longer offers it');

  const again = await sb.fetchJson('DELETE', `/api/categories/${encodeURIComponent('model building')}`);
  assert.equal(again.status, 404);
});

test('group rename moves every member category; tasks are untouched', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/catgroups/rename', {
    from: 'Structural', to: 'Modeling',
  });
  assert.equal(status, 200);
  assert.equal(body.moved, 2, 'computation + structural estimation');
  const cats = readCatsFile();
  assert.equal(cats.computation.group, 'Modeling');
  assert.equal(cats['structural estimation'].group, 'Modeling');
  assert.equal(cats.slides.group, 'Final Goods');

  const ghost = await sb.fetchJson('POST', '/api/catgroups/rename', { from: 'Structural', to: 'X' });
  assert.equal(ghost.status, 404, 'the old group name no longer exists');
});

test('group delete removes its categories after the (client-side) confirm — tasks keep labels', async () => {
  // tag a task with a category that is about to vanish with its group
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'doomed group task', category: 'computation' });

  const { status, body } = await sb.fetchJson('POST', '/api/catgroups/delete', { name: 'Modeling' });
  assert.equal(status, 200);
  assert.deepEqual(body.removed.sort(), ['computation', 'structural estimation']);
  const cats = readCatsFile();
  assert.ok(!cats.computation && !cats['structural estimation']);
  assert.ok(cats.slides && cats.refereeing, 'other groups untouched');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const t = state.tasks.alpha.find(x => x.title === 'doomed group task');
  assert.equal(t.category, 'computation', 'task keeps the label of its deleted category');

  const ghost = await sb.fetchJson('POST', '/api/catgroups/delete', { name: 'Modeling' });
  assert.equal(ghost.status, 404);
});

test('a category literally named "group" cannot shadow the group routes', async () => {
  const { status } = await sb.fetchJson('POST', '/api/categories', { key: 'group', group: 'Weird' });
  assert.equal(status, 201);
  const ren = await sb.fetchJson('POST', `/api/categories/${encodeURIComponent('group')}/rename`, { to: 'grouped' });
  assert.equal(ren.status, 200, 'category routes and /api/catgroups/* never collide');
  const del = await sb.fetchJson('DELETE', `/api/categories/${encodeURIComponent('grouped')}`);
  assert.equal(del.status, 200);
});

test('first write on a fresh install materializes the fallback cleanly', async () => {
  // a sandbox with NO categories.json — the harness seeds one, so delete it
  // (the store reads per request, nothing is cached). getCategories() then
  // serves the example fallback (absent under this CP_ROOT → {}), and the
  // first write must create the file from that fallback, not the seed.
  const fresh = await startSandbox();
  try {
    fs.rmSync(path.join(fresh.root, 'categories.json'));
    const { status } = await fresh.fetchJson('POST', '/api/categories', {
      key: 'starter', group: 'Mine', primer: 'First!',
    });
    assert.equal(status, 201);
    const cats = JSON.parse(fs.readFileSync(path.join(fresh.root, 'categories.json'), 'utf8'));
    assert.ok(cats.starter, 'categories.json created by the first edit');
    assert.equal(cats.calibration, undefined,
      'built from the fresh-install fallback — no trace of the deleted seed');
  } finally {
    await fresh.stop();
  }
});
