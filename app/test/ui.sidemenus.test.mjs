// The task sidebar's ＋ menus (add-lineage #linMenu, pin-a-file #pinMenu)
// must stay fully on screen. They used to be right-anchored absolute boxes
// inside the sidebar's .sh header — the LEFTMOST column — so linMenu (whose
// uppercase section headers saturate its 300px cap whenever any linkable
// task exists) grew leftward straight through x=0 into unreachable overflow
// (no leftward scroll region in LTR; the root clips x). Now placeSideMenu
// portals them to the body as fixed, viewport-clamped boxes (CONTRACT.md
// "Workbench per project"). Billing-safe: GET/POST tasks + PATCH only.
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
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), 'x\n'),
  });
  ({ sb, page } = ui);
  // three same-category tasks → the lineage menu has kin to offer (which is
  // all it takes to saturate the 300px width that used to overflow)
  for (const title of ['First analysis task', 'Second welfare cost paper section task', 'Third reproduction task']) {
    await sb.fetchJson('POST', '/api/tasks', {
      project: 'alpha', title, category: 'calibration', oversight: 'manual',
      context: { files: ['notes.tex'] },
    });
  }
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#linAddBtn', { timeout: 15000 });
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

const openMenu = (btnSel, menuSel) => page.evaluate(async ([btnSel, menuSel]) => {
  document.querySelector(btnSel).click();
  await new Promise((r) => setTimeout(r, 50));
  const m = document.getElementById(menuSel);
  if (!m) return null;
  const r = m.getBoundingClientRect();
  const side = document.querySelector('.wb .side')?.getBoundingClientRect();
  return {
    parentIsBody: m.parentElement === document.body,
    left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    width: r.width, sideW: side ? side.width : NaN,
    items: m.querySelectorAll('.pmItem').length,
    vw: window.innerWidth, vh: window.innerHeight,
  };
}, [btnSel, menuSel]);

test('the lineage ＋ menu stays fully on screen', opts, async () => {
  const s = await openMenu('#linAddBtn', 'linMenu');
  assert.ok(s, 'menu opened');
  assert.ok(s.parentIsBody, 'portaled to the body, not the sidebar header');
  assert.ok(s.items >= 4, `both parent and child sections list the two kin (${s.items} items)`);
  assert.ok(s.width > s.sideW, `the saturated menu IS wider than the sidebar (${s.width} vs ${s.sideW}) — the shape that used to overflow`);
  assert.ok(s.left >= 0, `left edge on screen (${s.left})`);
  assert.ok(s.right <= s.vw + 0.5, `right edge on screen (${s.right} vs ${s.vw})`);
  assert.ok(s.bottom <= s.vh + 0.5, `bottom edge on screen (${s.bottom} vs ${s.vh})`);
  await page.evaluate(() => document.getElementById('linMenu')?.remove());
});

test('picking a parent still links it after the portal change', opts, async () => {
  await page.evaluate(async () => {
    document.querySelector('#linAddBtn').click();
    await new Promise((r) => setTimeout(r, 50));
    document.querySelector('#linMenu .pmItem[data-lu]').click();
  });
  await sleep(500);
  const { body } = await sb.fetchJson('GET', '/api/state');
  const tasks = body.tasks.alpha;
  const linked = tasks.find((t) => Array.isArray(t.upstream) && t.upstream.length);
  assert.ok(linked, 'one task gained an upstream link');
  assert.ok(tasks.some((t) => t.id === linked.upstream[0]), 'and it points at a real sibling');
  const gone = await page.evaluate(() => !document.getElementById('linMenu'));
  assert.ok(gone, 'the re-render swept the portaled menu away');
});

test('the pin ＋ menu stays on screen too', opts, async () => {
  const s = await openMenu('#pinAddBtn', 'pinMenu');
  assert.ok(s, 'menu opened');
  assert.ok(s.parentIsBody, 'portaled to the body');
  assert.ok(s.left >= 0, `left edge on screen (${s.left})`);
  assert.ok(s.right <= s.vw + 0.5, `right edge on screen (${s.right})`);
  await page.evaluate(() => document.getElementById('pinMenu')?.remove());
});
