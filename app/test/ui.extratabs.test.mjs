// Ephemeral (◇ extra) tabs survive a refresh — the reported bug: files opened
// ad hoc (folder browser, Δ jumps, ✎ source) lived only in memory, so a
// reload dropped them AND silently reset the remembered active tab when it
// was an 'x:' tab. They now persist per project in localStorage
// (openExtra:<key>), the same family as closed tabs / taskTab / addedViewers.
// Tests share one staged project and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME, testBothImpls, edDriver } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.mkdirSync(path.join(projRoots.alpha, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'main.jl'), 'x = 1\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'src', 'extra1.jl'), 'a = 1\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'src', 'extra2.jl'), 'b = 2\n');
    },
  });
  ({ sb, page } = ui);
  const { body: t1 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Estimate', description: 'x', category: 'calibration',
    oversight: 'coop', context: { files: ['main.jl', 'src/'] },
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t1.id}`, { status: 'waiting' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600);
});

after(async () => { if (ui) await ui.stop(); });

const tabState = () => page.evaluate(() => ({
  tabs: [...document.querySelectorAll('#v-alpha .ctabs .ctab')].map(t => t.textContent.trim().replace(/×$/, '')),
  active: document.querySelector('#v-alpha .ctabs .ctab.on')?.textContent.trim().replace(/×$/, '') || null,
  stored: JSON.parse(localStorage.getItem('openExtra:alpha') || '[]'),
}));

test('files opened from the folder browser become ◇ tabs and persist to localStorage', opts, async () => {
  // expand the src/ folder pin, open both files from the browser
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .side .scRow[data-fi]')]
      .find(r => r.textContent.includes('src'))?.click();
  });
  await sleep(600); // /api/ls fetch + render
  await page.click('#v-alpha .scKid.filek[data-fk="src/extra1.jl"]');
  await sleep(400);
  await page.click('#v-alpha .scKid.filek[data-fk="src/extra2.jl"]');
  await sleep(400);
  const s = await tabState();
  assert.ok(s.tabs.some(t => t.includes('extra1.jl')), 'extra1 tab open');
  assert.ok(s.tabs.some(t => t.includes('extra2.jl')), 'extra2 tab open');
  assert.match(s.active, /extra2\.jl/, 'last-opened extra is focused');
  assert.deepEqual(s.stored, ['src/extra1.jl', 'src/extra2.jl'], 'persisted to localStorage');
});

test('a refresh restores the ◇ tabs AND the focused extra tab', opts, async () => {
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(700);
  const s = await tabState();
  assert.ok(s.tabs.some(t => t.includes('extra1.jl')), 'extra1 tab back after reload');
  assert.ok(s.tabs.some(t => t.includes('extra2.jl')), 'extra2 tab back after reload');
  assert.match(s.active, /extra2\.jl/,
    'the remembered active tab (an x: extra) survives normalization after reload');
});

test('× closes an extra for good — it stays closed across refreshes', opts, async () => {
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('#v-alpha .ctabs .ctab.xtab')]
      .find(t => t.textContent.includes('extra1.jl'));
    tab.querySelector('.tabX').click();
  });
  await sleep(400);
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(700);
  const s = await tabState();
  assert.ok(!s.tabs.some(t => t.includes('extra1.jl')), 'closed extra stays closed');
  assert.ok(s.tabs.some(t => t.includes('extra2.jl')), 'the other extra survives');
  assert.deepEqual(s.stored, ['src/extra2.jl']);
});

test('pinning an extra supersedes it — no duplicate, persisted list updated', opts, async () => {
  // pin src/extra2.jl properly via the task PATCH (as the ＋ pin flow would)
  const { body: st } = await sb.fetchJson('GET', '/api/state');
  const t = st.tasks.alpha[0];
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t.id}`, {
    context: { ...t.context, files: [...t.context.files, 'src/extra2.jl'] },
  });
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(700);
  const s = await tabState();
  const extraTabs = s.tabs.filter(x => x.includes('extra2.jl'));
  assert.equal(extraTabs.length, 1, 'one tab for the file — pin superseded the extra');
  assert.deepEqual(s.stored, [], 'the persisted extra entry was retired');
});
/* ── Phase 3 S2.6 (P21, monaco-s2 §2): the ◇ extra-tab KEEP contract,
   near-verbatim under BOTH editor implementations — a folder-browser open
   becomes a focused ◇ tab persisted to openExtra:<key>, and a file the task
   already PINS opens its pin tab instead (supersede — the shared-page tests
   above PATCHed src/extra2.jl onto the task, so this pass exercises both
   branches). The editor under the ◇ tab is the impl's own (edDriver wait).
   The reload-restore half stays with the shared-page tests: implPage's init
   script clears storage on every navigation BY DESIGN (the explicit
   impl-seeding reset), so a reload inside a dual pass cannot honestly
   assert persistence. Declared last: shared-page order-dependence. */
testBothImpls('◇ dual: a browser open becomes a persisted focused extra; a pinned file opens its pin tab instead', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await ed.wait(page, 'alpha::main.jl'); // fi 0 — the first pinned editor file
  // expand the src/ folder pin, open the UNPINNED file from the browser
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .side .scRow[data-fi]')]
      .find(r => r.textContent.includes('src'))?.click();
  });
  await page.waitForSelector('#v-alpha .scKid.filek[data-fk="src/extra1.jl"]', { timeout: 8000 });
  await page.click('#v-alpha .scKid.filek[data-fk="src/extra1.jl"]');
  await ed.wait(page, 'alpha::src/extra1.jl'); // the ◇ tab focused + its editor live
  let s = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#v-alpha .ctabs .ctab')].map(t => t.textContent.trim().replace(/×$/, '')),
    active: document.querySelector('#v-alpha .ctabs .ctab.on')?.textContent.trim().replace(/×$/, '') || null,
    xtab: !!document.querySelector('#v-alpha .ctabs .ctab.xtab.on'),
    stored: JSON.parse(localStorage.getItem('openExtra:alpha') || '[]'),
  }));
  assert.match(s.active, /extra1\.jl/, 'the opened extra is focused');
  assert.ok(s.xtab, 'and it is a ◇ (x:) tab, not a pin');
  assert.deepEqual(s.stored, ['src/extra1.jl'], 'persisted to localStorage');
  // the PINNED file (PATCHed onto the task by the shared-page tests) opens
  // its pin tab — never a duplicate ◇
  await page.click('#v-alpha .scKid.filek[data-fk="src/extra2.jl"]');
  await ed.wait(page, 'alpha::src/extra2.jl');
  s = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#v-alpha .ctabs .ctab')].map(t => t.textContent.trim().replace(/×$/, '')),
    stored: JSON.parse(localStorage.getItem('openExtra:alpha') || '[]'),
  }));
  assert.equal(s.tabs.filter(t => t.includes('extra2.jl')).length, 1, 'one tab for the pinned file — no ◇ duplicate');
  assert.deepEqual(s.stored, ['src/extra1.jl'], 'the pin never enters the extra list');
});
