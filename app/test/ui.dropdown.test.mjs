// The themed model/permission dropdowns in the session bar. Their open menu is
// PORTALED to a top-level fixed layer (#dropPortal) so the session pane's
// overflow:hidden can't clip it — the regression this guards is "the options
// got cut off at the top of a short session pane" (a native <select> never
// clipped because the OS drew its list above everything; a DOM menu does).
// Billing-safe: only POST /api/tasks + PATCH status + GET/render, no billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;
const modelPill = '#v-alpha .sessbar .drop[data-drop="model"] .dropBtn';
const permPill = '#v-alpha .sessbar .drop[data-drop="perm"] .dropBtn';
const closeAway = () => page.evaluate(() => document.dispatchEvent(new MouseEvent('click', { bubbles: true })));

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ sb, page } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'dropdown turn', description: 'x', category: 'calibration', oversight: 'coop',
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t.id}`, { status: 'waiting' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector(`${modelPill}`, { timeout: 15000 });
  await sleep(200);
});
after(async () => { if (ui) await ui.stop(); });

test('both selectors render as themed pills, not native <select>', opts, async () => {
  const r = await page.evaluate(() => ({
    selects: document.querySelectorAll('#v-alpha .sessbar select').length,
    model: !!document.querySelector('#v-alpha .sessbar .drop[data-drop="model"] .dropBtn.model'),
    perm: !!document.querySelector('#v-alpha .sessbar .drop[data-drop="perm"] .dropBtn.perm'),
    label: document.querySelector('#v-alpha .sessbar .drop[data-drop="model"] .dropBtn')?.textContent.trim(),
  }));
  assert.equal(r.selects, 0, 'no native <select> left in the sessbar');
  assert.ok(r.model && r.perm, 'both themed pills present');
  assert.match(r.label, /Opus|Sonnet|Haiku|Fable|default/, 'pill shows the current model');
});

test('opening a menu portals it OUT of the clipping pane as a fixed, on-screen layer', opts, async () => {
  await page.click(permPill);
  await sleep(120);
  const r = await page.evaluate(() => {
    const menu = document.querySelector('#dropPortal .dropMenu');
    if (!menu) return { portaled: false };
    const cs = getComputedStyle(menu);
    const items = [...menu.querySelectorAll('.dropItem')];
    return {
      portaled: !!menu.closest('#dropPortal'),
      // the load-bearing proof: the menu is rendered OUTSIDE the project view,
      // i.e. outside .sessHalf's overflow:hidden — so it cannot be clipped
      outsidePane: !menu.closest('#v-alpha'),
      position: cs.position, display: cs.display,
      itemCount: items.length,
      selected: menu.querySelector('.dropItem.sel .ck')?.textContent.trim(),
      allOnScreen: items.every((it) => {
        const b = it.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= window.innerHeight && b.width > 0;
      }),
    };
  });
  assert.ok(r.portaled, 'the open menu lives in #dropPortal');
  assert.ok(r.outsidePane, 'the menu is outside #v-alpha — beyond the session pane\'s overflow:hidden');
  assert.equal(r.position, 'fixed', 'positioned fixed to the viewport');
  assert.equal(r.display, 'block', 'shown');
  assert.equal(r.itemCount, 5, 'all five permission options rendered');
  assert.equal(r.selected, '✓', 'the current choice is checked');
  assert.ok(r.allOnScreen, 'every option is fully visible — none clipped');
  await closeAway();
  await sleep(80);
});

test('with a SHORTER session pane the full menu still renders (the reported bug)', opts, async () => {
  // squeeze the pane (but not so far the pill itself clips): under the old
  // in-flow menu the top options fell outside the pane and were cut off.
  await page.evaluate(() => document.querySelector('#v-alpha .wb').style.setProperty('--vsplit', '72%'));
  await sleep(150);
  await page.click(permPill);
  await sleep(120);
  const r = await page.evaluate(() => {
    const menu = document.querySelector('#dropPortal .dropMenu');
    if (!menu) return { open: false };
    const items = [...menu.querySelectorAll('.dropItem')];
    return {
      open: true,
      outsidePane: !menu.closest('#v-alpha'),
      allOnScreen: items.length === 5 && items.every((it) => {
        const b = it.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= window.innerHeight && b.width > 0;
      }),
    };
  });
  assert.ok(r.open, 'the menu opened in the shortened pane');
  assert.ok(r.outsidePane, 'still rendered outside the clipping pane');
  assert.ok(r.allOnScreen, 'all five options fully visible — the clip is gone');
  await closeAway();
  await sleep(80);
});

test('outside-click closes the menu and restores it into its trigger', opts, async () => {
  await page.click(modelPill);
  await sleep(100);
  assert.ok(await page.evaluate(() => !!document.querySelector('#dropPortal .dropMenu')), 'opened + portaled');
  await closeAway();
  await sleep(100);
  const r = await page.evaluate(() => ({
    portalEmpty: !document.querySelector('#dropPortal .dropMenu'),
    restored: !!document.querySelector('#v-alpha .sessbar .drop[data-drop="model"] .dropMenu'),
    open: document.querySelectorAll('#v-alpha .drop.open').length,
  }));
  assert.ok(r.portalEmpty, 'the portal is emptied on close');
  assert.ok(r.restored, 'the menu is moved back inside its .drop');
  assert.equal(r.open, 0, 'nothing left flagged open');
});
