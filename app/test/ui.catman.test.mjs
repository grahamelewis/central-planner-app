// Manage Categories — the two-pane editor behind the profile menu.
// The load-bearing behaviors under test, per the approved design:
//   · reachable from the profile dropdown (name, top-left)
//   · grouped tree + full editor (icon picker, name, group, primer, toggle)
//   · deleting a GROUP asks "are you sure" (it takes its categories with it)
//   · deleting a CATEGORY keeps old tasks' labels (the past is never rewritten)
//   · RENAMING a category retags every task, past and present
// Drives the real frontend in headless Chrome; skips without Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ root }) => {
      fs.writeFileSync(path.join(root, 'categories.json'), JSON.stringify({
        theory: { group: 'Structural', name: 'theory', icon: '∂', primer: 'Build the model.', defaults: { web_search: true } },
        computation: { group: 'Structural', name: 'computation', icon: '⚙', primer: 'Solve it.', defaults: { web_search: false } },
        slides: { group: 'Final Goods', name: 'slides', icon: '▤', primer: 'Beamer.', defaults: { web_search: false } },
      }, null, 2));
    },
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Old theory task', category: 'theory' });
  await sb.fetchJson('POST', '/api/tasks', { project: 'beta', title: 'Beta theory task', category: 'theory' });
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Deck task', category: 'slides' });
  await page.goto(sb.base);
  await page.waitForSelector('#bento', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const treeState = () => page.evaluate(() => ({
  groups: [...document.querySelectorAll('#v-catman .cmGrp .gname')].map(e => e.textContent.trim()),
  cats: [...document.querySelectorAll('#v-catman .cmCat')].map(e => e.textContent.trim()),
  sub: document.querySelector('#v-catman .catHead .sub')?.textContent.replace(/\s+/g, ' ') || '',
}));

test('the profile menu opens the editor with the grouped tree', opts, async () => {
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Manage Categories"]');
  await page.waitForSelector('#v-catman.show .cmTree', { timeout: 5000 });
  const s = await treeState();
  assert.deepEqual(s.groups, ['Structural', 'Final Goods']);
  assert.deepEqual(s.cats, ['∂ theory', '⚙ computation', '▤ slides']);
  assert.match(s.sub, /3 categories · 2 groups/);
});

test('editing the primer and icon saves to categories.json', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-catman .cmCat')].find(e => e.dataset.k === 'theory').click();
  });
  await sleep(150);
  // icon via the curated picker
  await page.click('#cmIconBtn');
  await page.evaluate(() => {
    [...document.querySelectorAll('#cmIconPop .ic')].find(e => e.dataset.ic === '∴').click();
  });
  await page.fill('#cmPrimer', 'Whiteboard first, derive, then hand to computation.');
  await page.click('#cmSave');
  await sleep(400);

  const cats = JSON.parse(fs.readFileSync(path.join(sb.root, 'categories.json'), 'utf8'));
  assert.equal(cats.theory.icon, '∴');
  assert.equal(cats.theory.primer, 'Whiteboard first, derive, then hand to computation.');
  assert.equal(cats.theory.defaults.web_search, true, 'untouched toggle keeps its value');
  const s = await treeState();
  assert.ok(s.cats.includes('∴ theory'), 'tree reflects the new icon');
});

test('renaming a category retags every task, past and present', opts, async () => {
  await page.fill('#cmName', 'model building');
  await page.click('#cmSave');
  await sleep(500);

  const s = await treeState();
  assert.ok(s.cats.includes('∴ model building'), 'tree shows the new name');
  assert.ok(!s.cats.some(c => /theory/.test(c)), 'the old name is gone');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const all = [...state.tasks.alpha, ...state.tasks.beta];
  assert.equal(all.filter(t => t.category === 'model building').length, 2,
    'both projects\' tasks retagged');
  assert.equal(all.filter(t => t.category === 'theory').length, 0);
  assert.ok(state.categories['model building'] && !state.categories.theory);
});

test('deleting a category asks once and never rewrites the past', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-catman .cmCat')].find(e => e.dataset.k === 'slides').click();
  });
  await sleep(150);
  await page.click('#cmDelete');
  await page.waitForSelector('#confirmBack .cbMsg', { timeout: 3000 });
  const msg = await page.evaluate(() => document.querySelector('#confirmBack .cbMsg').textContent);
  assert.match(msg, /keep the “slides” label/, 'the confirm explains the past stays put');

  // cancel first — nothing changes
  await page.click('#confirmBack .cbCancel');
  await sleep(150);
  assert.ok((await treeState()).cats.some(c => /slides/.test(c)), 'cancel keeps the category');

  // now really delete
  await page.click('#cmDelete');
  await page.waitForSelector('#confirmBack .cbGo', { timeout: 3000 });
  await page.click('#confirmBack .cbGo');
  await sleep(400);
  assert.ok(!(await treeState()).cats.some(c => /slides/.test(c)), 'gone from the tree');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok(!state.categories.slides, 'gone from the pickers');
  assert.equal(state.tasks.alpha.find(t => t.title === 'Deck task').category, 'slides',
    'the old task keeps its label');
});

test('the deleted category still renders as a label on old tasks (Manage view)', opts, async () => {
  await page.evaluate(() => {
    document.querySelector('#profileBtn').click();
    document.querySelector('#profileMenu .pmItem[data-pm="Manage Projects"]').click();
  });
  await page.waitForSelector('#v-manage.show', { timeout: 5000 });
  await sleep(200);
  const txt = await page.evaluate(() => document.getElementById('manageFrame').textContent);
  assert.match(txt, /slides/, 'the dangling label renders as plain text — no crash, no blank');
  // back to the editor for the remaining tests
  await page.evaluate(() => {
    document.querySelector('#profileBtn').click();
    document.querySelector('#profileMenu .pmItem[data-pm="Manage Categories"]').click();
  });
  await page.waitForSelector('#v-catman.show .cmTree', { timeout: 5000 });
});

test('renaming a group moves its member categories along', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-catman .cmGRen')].find(e => e.dataset.g === 'Structural').click();
  });
  await page.waitForSelector('#cmGinp', { timeout: 3000 });
  await page.fill('#cmGinp', 'Modeling');
  await page.press('#cmGinp', 'Enter');
  await sleep(400);
  const s = await treeState();
  assert.ok(s.groups.includes('Modeling') && !s.groups.includes('Structural'));
  const cats = JSON.parse(fs.readFileSync(path.join(sb.root, 'categories.json'), 'utf8'));
  assert.equal(cats.computation.group, 'Modeling');
  assert.equal(cats['model building'].group, 'Modeling');
});

test('deleting a group is confirmed — it takes its categories with it', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-catman .cmGDel')].find(e => e.dataset.g === 'Modeling').click();
  });
  await page.waitForSelector('#confirmBack .cbMsg', { timeout: 3000 });
  const msg = await page.evaluate(() => document.querySelector('#confirmBack .cbMsg').textContent);
  assert.match(msg, /Modeling/, 'names the group');
  assert.match(msg, /2 categories/, 'counts what goes down with it');
  assert.match(msg, /keep their category labels/, 'and reassures about the past');
  await page.click('#confirmBack .cbGo');
  await sleep(400);

  const s = await treeState();
  assert.deepEqual(s.groups, [], 'no groups left');
  assert.deepEqual(s.cats, [], 'its categories went with it');
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const all = [...state.tasks.alpha, ...state.tasks.beta];
  assert.equal(all.filter(t => t.category === 'model building').length, 2,
    'tasks keep the deleted categories\' labels');
});

test('＋ Group and ＋ Category build a fresh taxonomy', opts, async () => {
  // + Group → inline name input
  await page.click('#cmAddGrp');
  await page.waitForSelector('#cmGinp', { timeout: 3000 });
  await page.fill('#cmGinp', 'Fieldwork');
  await page.press('#cmGinp', 'Enter');
  await sleep(200);
  let s = await treeState();
  assert.ok(s.groups.includes('Fieldwork'), 'pending group appears');

  // + Category into it
  await page.click('#cmAddCat');
  await sleep(150);
  await page.fill('#cmName', 'interviews');
  await page.selectOption('#cmGroup', 'Fieldwork');
  await page.fill('#cmPrimer', 'Semi-structured. Record with consent.');
  await page.evaluate(() => { document.querySelector('#cmWeb').click(); });
  await page.click('#cmSave');
  await sleep(400);

  s = await treeState();
  assert.ok(s.cats.some(c => /interviews/.test(c)), 'category created');
  assert.ok(s.groups.includes('Fieldwork'), 'group became real');
  const cats = JSON.parse(fs.readFileSync(path.join(sb.root, 'categories.json'), 'utf8'));
  assert.equal(cats.interviews.group, 'Fieldwork');
  assert.equal(cats.interviews.primer, 'Semi-structured. Record with consent.');
  assert.equal(cats.interviews.defaults.web_search, true, 'the toggle made it through');
});

test('the new category is offered in the Add-Task picker', opts, async () => {
  await page.evaluate(() => { document.getElementById('openModal').click(); });
  await page.waitForSelector('#mCat', { timeout: 5000 });
  const pills = await page.evaluate(() =>
    [...document.querySelectorAll('#mCat .pillOpt')].map(e => e.textContent.trim()));
  assert.ok(pills.some(p => /interviews/.test(p)), 'picker refreshed with the new taxonomy');
  assert.ok(!pills.some(p => /slides|model building/.test(p)), 'deleted categories are not offered');
});
