// Settings view + light/dark theme toggle: the profile menu opens Settings,
// the three-way control (system | dark | light) flips html[data-theme],
// persists in localStorage across reloads, and 'system' tracks
// prefers-color-scheme live.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush;

const themeAttr = () => page.evaluate(() => document.documentElement.dataset.theme || null);
const stored = () => page.evaluate(() => localStorage.getItem('theme'));
const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ sb, page, wsPush } = ui);
  // headless Chrome reports prefers-color-scheme: light by default — pin it
  // to dark so 'system' starts on the dashboard's classic look
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(sb.base);
  await page.waitForSelector('#bento', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

test('default is system: dark OS → no data-theme, dark canvas', opts, async () => {
  assert.equal(await themeAttr(), null, 'no data-theme attribute');
  assert.equal(await stored(), null, 'nothing persisted yet');
  assert.match(await bodyBg(), /rgb\(16, 18, 32\)/, 'body paints the dark base');
});

test('system tracks prefers-color-scheme live', opts, async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(100);
  assert.equal(await themeAttr(), 'light', 'OS flip to light re-themes without a reload');
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(100);
  assert.equal(await themeAttr(), null, 'and back');
});

test('profile menu → Settings → Light: applies, persists, survives reload', opts, async () => {
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show #themeSeg');
  assert.equal(
    await page.evaluate(() => document.querySelector('#themeSeg .segOpt.on')?.dataset.th),
    'system', 'control starts on System');

  await page.click('#themeSeg .segOpt[data-th="light"]');
  assert.equal(await themeAttr(), 'light');
  assert.equal(await stored(), 'light');
  assert.match(await bodyBg(), /rgb\(238, 240, 247\)/, 'body paints the paper base');

  await page.reload();
  // the hash now follows the view, so a reload restores Settings itself
  await page.waitForSelector('#v-settings.show #themeSeg', { timeout: 15000 });
  assert.equal(await themeAttr(), 'light', 'the head bootstrap re-applies before paint');
  assert.match(await bodyBg(), /rgb\(238, 240, 247\)/);
  assert.equal(
    await page.evaluate(() => document.querySelector('#themeSeg .segOpt.on')?.dataset.th),
    'light', 'the control shows the persisted choice after reload');
});

test('Dark forces dark even on a light OS; System returns to following it', opts, async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show #themeSeg');

  await page.click('#themeSeg .segOpt[data-th="dark"]');
  assert.equal(await themeAttr(), null, 'dark override beats the light OS');
  assert.equal(await stored(), 'dark');
  assert.match(await bodyBg(), /rgb\(16, 18, 32\)/);

  await page.click('#themeSeg .segOpt[data-th="system"]');
  assert.equal(await themeAttr(), 'light', 'system resumes following the (light) OS');
  assert.equal(await stored(), 'system');
});

// Dashboard self-update: an update:status 'behind' puts a 1-badge on the
// profile button (same pill as the project tabs' waiting badge), clicking it
// jumps to Settings where the Updates card lists the incoming commits and
// offers the Update button; 'ok' clears everything.
test('an available update badges the profile button and fills the Updates card', opts, async () => {
  await wsPush('update:status', {
    state: 'behind', behind: 2, ahead: 0, dirty: false,
    branch: 'main', upstream: 'origin/main', head: 'abc1234',
    commits: [
      { sha: 'f00d123', subject: 'agent teams in the console' },
      { sha: 'cafe456', subject: 'quiet builds polish' },
    ],
    lastChecked: new Date().toISOString(), error: null, updated: null,
  });
  await sleep(200);

  const badge = await page.evaluate(() => {
    const b = document.getElementById('updBadge');
    return b ? { text: b.textContent, title: b.title, inProfile: !!b.closest('#profileBtn') } : null;
  });
  assert.ok(badge, 'badge appears');
  assert.equal(badge.text, '1', 'one pending action — the update');
  assert.ok(badge.inProfile, 'it rides the profile button, right of the name');
  assert.match(badge.title, /2 commits behind/);

  // go somewhere else, then let the badge itself take us to Settings
  await page.evaluate(() => { document.querySelector('#nav > .tab[data-v="ov"]').click(); });
  await sleep(150);
  await page.click('#updBadge');
  await page.waitForSelector('#v-settings.show', { timeout: 5000 });

  const card = await page.evaluate(() => ({
    status: document.querySelector('.updStatus')?.textContent || '',
    rows: [...document.querySelectorAll('.updCommit')].map(e => e.textContent),
    hasGo: !!document.querySelector('#updGo'),
    hasCheck: !!document.querySelector('#updCheck'),
    version: document.querySelector('#updSec .setLbl small')?.textContent || '',
  }));
  assert.match(card.status, /2 updates available/);
  assert.equal(card.rows.length, 2);
  assert.match(card.rows[0], /agent teams in the console/);
  assert.ok(card.hasGo, 'Update now button offered');
  assert.ok(card.hasCheck, 'Check now button present');
  assert.match(card.version, /main @ abc1234/);

  // back up to date: badge and Update button retire, status flips
  await wsPush('update:status', {
    state: 'ok', behind: 0, ahead: 0, dirty: false,
    branch: 'main', upstream: 'origin/main', head: 'f00d123',
    commits: [], lastChecked: new Date().toISOString(), error: null, updated: null,
  });
  await sleep(200);
  assert.equal(await page.evaluate(() => !!document.getElementById('updBadge')), false, 'badge clears');
  const after2 = await page.evaluate(() => ({
    status: document.querySelector('.updStatus')?.textContent || '',
    hasGo: !!document.querySelector('#updGo'),
  }));
  assert.match(after2.status, /up to date/);
  assert.equal(after2.hasGo, false, 'no Update button when current');
});
