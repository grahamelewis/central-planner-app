// The add-task modal losing a half-written task.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes; this file
// only POSTs/PATCHes /api/tasks (never launch/message).
//
// Reported as "the task disappears while I'm typing". Root cause: a `click` is
// dispatched on the nearest common ancestor of mousedown and mouseup, so
// drag-selecting text inside the modal and releasing past its edge targeted
// #modalBack — the dismiss-on-backdrop handler fired even though the user never
// clicked the backdrop. closeModal() then nulled the form with no persistence
// anywhere, making the draft unrecoverable.
//
// Two fixes, both covered here: the backdrop only dismisses when the press
// BEGAN on it, and an accidental dismissal stashes the draft for the next open
// while cancel/save still discard it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;

const modal = () => page.evaluate(() => ({
  open: document.getElementById('modalBack').classList.contains('show'),
  title: document.getElementById('mTitle')?.value ?? null,
  desc: document.getElementById('mDesc')?.value ?? null,
}));

/** Open the modal fresh (discarding any stash) and type a draft into it. */
async function draft(title, desc = 'half-written body text') {
  const m = await modal();
  if (m.open) await page.click('#mCancel');            // cancel discards
  await sleep(120);
  await page.click('#openModal');
  await sleep(250);
  const cur = await modal();
  if (cur.title) { await page.click('#mCancel'); await sleep(120); await page.click('#openModal'); await sleep(250); }
  await page.fill('#mTitle', title);
  await page.fill('#mDesc', desc);
  await sleep(80);
}

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({ viewport: { width: 1500, height: 950 } });
  ({ sb, page } = ui);
  await page.goto(`${sb.base}/#ov`);
  await page.waitForSelector('#openModal', { timeout: 15000 });
});
after(async () => { if (ui) await ui.stop(); });

test('drag-selecting text out past the modal edge does not dismiss it', opts, async () => {
  await draft('Selection drag');
  const box = await page.locator('#mDesc').boundingBox();
  const back = await page.locator('#modalBack').boundingBox();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();                                                   // inside
  await page.mouse.move(back.x + back.width - 30, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();                                                     // on the backdrop
  await sleep(250);
  const m = await modal();
  assert.equal(m.open, true, 'the modal closed on a selection drag');
  assert.equal(m.title, 'Selection drag', 'the draft survived');
});

test('a press that begins on the backdrop still dismisses it', opts, async () => {
  const m0 = await modal();
  assert.equal(m0.open, true, 'precondition: modal open from the previous test');
  const back = await page.locator('#modalBack').boundingBox();
  await page.mouse.click(back.x + back.width - 30, back.y + 30);
  await sleep(200);
  assert.equal((await modal()).open, false, 'deliberate backdrop dismissal must still work');
});

test('an accidental dismissal is recoverable — reopening restores the draft', opts, async () => {
  await draft('Recover me', 'body I would hate to retype');
  await page.click('#mDesc');
  await page.keyboard.press('Escape');
  await sleep(200);
  assert.equal((await modal()).open, false, 'Escape closes');

  await page.click('#openModal');
  await sleep(250);
  const m = await modal();
  assert.equal(m.title, 'Recover me', 'the stashed draft came back');
  assert.equal(m.desc, 'body I would hate to retype');
});

test('cancel is a deliberate discard — the next open is empty', opts, async () => {
  await draft('Throw this away');
  await page.click('#mCancel');
  await sleep(200);
  await page.click('#openModal');
  await sleep(250);
  assert.equal((await modal()).title, '', 'cancel must not resurrect the draft');
  await page.click('#mCancel');
  await sleep(120);
});

test('a saved task is not offered back as a draft', opts, async () => {
  await draft('Real task from the modal');       // POST /api/tasks — not a billed route
  await page.click('#mSave');
  await sleep(600);
  assert.equal((await modal()).open, false, 'save closes the modal');
  await page.click('#openModal');
  await sleep(250);
  assert.equal((await modal()).title, '', 'a saved task must not reappear as an unsaved draft');
  await page.click('#mCancel');
  await sleep(120);
});

test('an untouched modal stashes nothing, so no spurious restore', opts, async () => {
  await page.click('#openModal');
  await sleep(250);
  await page.keyboard.press('Escape');            // closed without typing
  await sleep(150);
  await page.click('#openModal');
  await sleep(250);
  const m = await modal();
  assert.equal(m.title, '');
  const toast = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  assert.doesNotMatch(toast, /restored/i, 'nothing was typed, so nothing should be announced as restored');
  await page.click('#mCancel');
  await sleep(120);
});
