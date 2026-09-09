// Manage projects + the pinned top bar (docs/projects-mockups/pin-only/
// PIN-IMPL.md): the bar lists `state.pinned` in slot order and nothing else,
// ☆/★/▲▼ on the Manage page speak the PATCH {pinOrder} / PUT /pins wire, the
// cap and inactive rows disable ☆ with a tooltip, ⌘1–⌘7 follow the slots (and
// never fire while typing), and a snapshot without `pinned` degrades to the
// first visible projects so an older server still draws a bar.
//
// The write routes are intercepted in the browser (page.route) so the suite
// asserts the exact wire the client speaks and stays deterministic whether or
// not the server side has landed; the resulting broadcast is pushed by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush;
let snapshot; // the sandbox's real /api/state, re-shaped per test
const writes = []; // every intercepted PATCH /api/projects/:key and PUT /api/projects/pins
let nextPinStatus = 200; // what the intercepted PATCH {pinOrder} answers
let nextPinSlot = 4; // the effective slot the intercepted pin PATCH reports back (the toast reads it)

const CAP_MSG = '7 of 7 pinned — unpin a project to make room';

const proj = (name, status = 'active') => ({ name, root: '/nowhere', color: '#7ea2f5', texWatch: null, status });
/** nine projects: alpha/beta (real, seeded) plus seven synthetic ones. */
const NINE = {
  alpha: proj('alpha'), beta: proj('beta'),
  gamma: proj('Gamma'), delta: proj('Delta'), eps: proj('Epsilon'), zeta: proj('Zeta'),
  eta: proj('Eta'), theta: proj('Theta'), iota: proj('Iota', 'inactive'),
};

const push = (over) => wsPush('state', { ...snapshot, ...over });
const barKeys = () => page.evaluate(() => [...document.querySelectorAll('#navProjects .tab')].map(t => t.dataset.v));
const view = () => page.evaluate(() => document.querySelector('.view.show')?.id || null);
const toastText = () => page.evaluate(() => document.getElementById('toast')?.textContent || '');
const openManage = async () => {
  await page.evaluate(() => {
    document.querySelector('#profileBtn').click();
    document.querySelector('#profileMenu .pmItem[data-pm="Manage Projects"]').click();
  });
  await page.waitForSelector('#v-manage.show #pinSummary', { timeout: 5000 });
  await sleep(100);
};
/** the pin control per row: {key, pinned, slot, disabled, tip} */
const rows = () => page.evaluate(() => [...document.querySelectorAll('#manageFrame .mpProj')].map(r => {
  const b = r.querySelector('.mpPin');
  return {
    key: r.dataset.mp,
    pinned: b.classList.contains('on'),
    slot: b.querySelector('.slot')?.textContent || null,
    disabled: b.disabled,
    tip: b.dataset.tip || null,
    ghost: r.querySelector('.mpOrder').classList.contains('ghost'),
    up: r.querySelector('[data-up]')?.disabled ?? null,
    down: r.querySelector('[data-down]')?.disabled ?? null,
  };
}));

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({ viewport: { width: 1200, height: 900 } });
  ({ sb, page, wsPush } = ui);
  // one handler for both write routes (a later page.route would shadow an
  // earlier one, and '/api/projects/*' matches '/api/projects/pins' too)
  await page.route('**/api/projects/*', (r) => {
    const req = r.request();
    const url = new URL(req.url()).pathname;
    const method = req.method();
    const isPins = url === '/api/projects/pins' && method === 'PUT';
    if (method !== 'PATCH' && !isPins) return r.continue();
    const body = req.postDataJSON();
    writes.push({ method, url, body });
    if (method === 'PATCH' && body.pinOrder != null && nextPinStatus !== 200) {
      return r.fulfill({ status: nextPinStatus, json: { error: 'the bar is full' } });
    }
    r.fulfill({ json: { ok: true, ...(method === 'PATCH' && body.pinOrder != null ? { pinOrder: nextPinSlot } : {}) } });
  });
  await page.goto(sb.base);
  await page.waitForSelector('#bento', { timeout: 15000 });
  await sleep(300);
  ({ body: snapshot } = await sb.fetchJson('GET', '/api/state'));
});
after(async () => { if (ui) await ui.stop(); });

test('a snapshot without `pinned` still draws the bar from the visible projects', opts, async () => {
  const { pinned: _drop, ...noPins } = snapshot;
  await wsPush('state', { ...noPins, projects: NINE });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta'],
    'first 7 visible in key order (iota is inactive)');
});

test('the bar lists state.pinned in slot order and nothing else', opts, async () => {
  await push({ projects: NINE, pinned: ['eta', 'alpha', 'beta'] });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['eta', 'alpha', 'beta']);
  const tab = await page.evaluate(() => {
    const t = document.querySelector('#navProjects .tab[data-v="eta"]');
    return { text: [...t.childNodes].filter(n => !n.classList?.contains('k')).map(n => n.textContent).join('').trim(), dot: !!t.querySelector('.dot'), k: t.querySelector('.k')?.textContent };
  });
  assert.equal(tab.text, 'Eta', 'tab markup is unchanged: dot + name');
  assert.ok(tab.dot);
  assert.equal(tab.k, '⌘1', 'plus the ⌘n hint span');
  // an inactive key in the list is never drawn, and the list is capped at 7
  await push({ projects: NINE, pinned: ['iota', 'alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'] });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta']);
});

test('⌘n hints: a .k span per pinned tab, hidden at rest, shown while ⌘ is held and on hover', opts, async () => {
  await push({ projects: NINE, pinned: ['eta', 'alpha', 'beta'] });
  await sleep(100);
  const hints = () => page.evaluate(() => [...document.querySelectorAll('#navProjects .tab')].map(t => {
    const k = t.querySelector('.k');
    return { v: t.dataset.v, k: k?.textContent, opacity: getComputedStyle(k).opacity, tabW: Math.round(t.getBoundingClientRect().width) };
  }));
  const rest = await hints();
  assert.deepEqual(rest.map(x => [x.v, x.k, x.opacity]), [['eta', '⌘1', '0'], ['alpha', '⌘2', '0'], ['beta', '⌘3', '0']], 'numbered by slot, invisible at rest');
  await page.keyboard.down('Meta');
  await sleep(200);
  assert.ok(await page.evaluate(() => document.body.classList.contains('cmd')), 'body.cmd while ⌘ is held');
  const held = await hints();
  assert.deepEqual(held.map(x => x.opacity), ['1', '1', '1'], 'shown while ⌘ is held');
  assert.deepEqual(held.map(x => x.tabW), rest.map(x => x.tabW), 'the tab layout does not change');
  await page.keyboard.up('Meta');
  await sleep(200);
  assert.deepEqual((await hints()).map(x => x.opacity), ['0', '0', '0'], 'hidden again on release');
  await page.hover('#navProjects .tab[data-v="alpha"]');
  await sleep(200);
  assert.equal((await hints())[1].opacity, '1', 'and on hover');
  await page.mouse.move(0, 0);
});

test('Manage: heading without emoji, "n of 7 pinned", rows without key/count/colour', opts, async () => {
  await push({ projects: NINE, pinned: ['alpha', 'beta', 'gamma'] });
  await openManage();
  const head = await page.evaluate(() => ({
    h1: document.querySelector('#manageFrame .catHead h1').textContent.trim(),
    sub: !!document.querySelector('#manageFrame .catHead .sub'),
    summary: document.getElementById('pinSummary').textContent.trim(),
    full: document.getElementById('pinSummary').classList.contains('full'),
    weight: getComputedStyle(document.getElementById('pinSummary')).fontWeight,
    stray: document.querySelectorAll('#manageFrame .mpKey, #manageFrame .mpCount, #manageFrame .mpColor').length,
  }));
  assert.equal(head.h1, 'Manage projects');
  assert.equal(head.sub, false, 'no sub copy');
  assert.equal(head.summary, '3 of 7 pinned');
  assert.equal(head.full, false);
  assert.equal(head.weight, '400', 'not bold');
  assert.equal(head.stray, 0, 'no .mpKey / .mpCount / .mpColor anywhere in the rows');
  const r = await rows();
  assert.deepEqual(r.map(x => x.key), Object.keys(NINE), 'every project, inactive included, config order');
  assert.deepEqual(r.slice(0, 3).map(x => [x.pinned, x.slot, x.ghost]), [[true, '1', false], [true, '2', false], [true, '3', false]]);
  assert.deepEqual([r[0].up, r[0].down, r[2].up, r[2].down], [true, false, false, true], '▲ off in slot 1, ▼ off in the last slot');
  assert.ok(r.slice(3, 8).every(x => !x.pinned && !x.disabled && x.ghost), 'unpinned active rows: ☆ enabled, ghost ▲▼');
  const star = await page.evaluate(() => {
    const h = document.querySelector('#manageFrame .mpProj[data-mp="alpha"] .mpHead');
    return [...h.children].map(c => c.className.split(' ')[0]);
  });
  assert.deepEqual(star, ['mpPin', 'mpOrder', 'mpName', 'mpStatus', 'mpOpen', 'mpHue'], 'star left of the name, in place of the swatch; the colour link last');
});

test('recolour: a "colour" link at the far right, invisible at rest, shown on row hover, PATCHes {color}', opts, async () => {
  const sel = '#manageFrame .mpProj[data-mp="beta"]';
  const rest = await page.evaluate((s) => {
    const l = document.querySelector(`${s} .mpHue`);
    return { text: l.textContent.trim(), opacity: getComputedStyle(l).opacity, input: l.querySelector('input[type="color"]').value, swatches: document.querySelectorAll('#manageFrame .mpProj input[type="color"]:not(.mpHue input)').length };
  }, sel);
  assert.deepEqual(rest, { text: 'colour', opacity: '0', input: '#7ea2f5', swatches: 0 }, 'text link, hidden at rest, no visible swatch on the row');
  await page.hover(`${sel} .mpName`);
  await sleep(250);
  assert.equal(await page.evaluate((s) => getComputedStyle(document.querySelector(`${s} .mpHue`)).opacity, sel), '1', 'revealed on row hover');
  writes.length = 0;
  await page.evaluate((s) => {
    const i = document.querySelector(`${s} .mpHue input`);
    i.value = '#123456';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, sel);
  await sleep(100);
  assert.deepEqual(writes, [{ method: 'PATCH', url: '/api/projects/beta', body: { color: '#123456' } }]);
  await page.mouse.move(0, 0);
});

test('the inactive row: ☆ disabled with the tooltip; its status pills still PATCH status', opts, async () => {
  const r = (await rows()).find(x => x.key === 'iota');
  assert.equal(r.pinned, false);
  assert.equal(r.disabled, true);
  assert.equal(r.tip, 'inactive projects are hidden from the nav — set it active to pin it');
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="iota"] .mpStPill[data-pkst="iota::active"]');
  await sleep(100);
  assert.deepEqual(writes, [{ method: 'PATCH', url: '/api/projects/iota', body: { status: 'active' } }]);
});

test('☆ pins into the next slot (PATCH pinOrder) and the tab appears', opts, async () => {
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="eta"] [data-pin]');
  await sleep(100);
  // the client asks for slot 7 (the server APPENDS past the end, so two quick
  // clicks land in click order); the toast reports the response's real slot
  assert.deepEqual(writes, [{ method: 'PATCH', url: '/api/projects/eta', body: { pinOrder: 7 } }]);
  assert.equal(await toastText(), 'Eta pinned · slot 4 · ⌘4');
  await push({ projects: NINE, pinned: ['alpha', 'beta', 'gamma', 'eta'] });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['alpha', 'beta', 'gamma', 'eta']);
  assert.equal(await page.textContent('#pinSummary'), '4 of 7 pinned');
  assert.equal((await rows()).find(x => x.key === 'eta').slot, '4');
});

test('▲ moves it (PUT /api/projects/pins with the swapped order)', opts, async () => {
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="eta"] [data-up]');
  await sleep(100);
  assert.deepEqual(writes, [{ method: 'PUT', url: '/api/projects/pins', body: { keys: ['alpha', 'beta', 'eta', 'gamma'] } }]);
  await push({ projects: NINE, pinned: ['alpha', 'beta', 'eta', 'gamma'] });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['alpha', 'beta', 'eta', 'gamma']);
  // keyboard focus survives the re-render: still on eta's ▲ (it had focus from the click)
  const focus = await page.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, key: a.closest('[data-mp]')?.dataset.mp, attr: a.hasAttribute('data-up') ? 'data-up' : a.className }; });
  assert.deepEqual(focus, { tag: 'BUTTON', key: 'eta', attr: 'data-up' }, 'focus was not dropped to body');
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="alpha"] [data-down]');
  await sleep(100);
  assert.deepEqual(writes[0].body, { keys: ['beta', 'alpha', 'eta', 'gamma'] }, '▼ swaps the other way');
});

test('★ unpins (PATCH pinOrder null); unpinning the open project keeps its view', opts, async () => {
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="gamma"] [data-unpin]');
  await sleep(100);
  assert.deepEqual(writes, [{ method: 'PATCH', url: '/api/projects/gamma', body: { pinOrder: null } }]);
  assert.equal(await toastText(), 'Gamma unpinned');
  // now open alpha and unpin it from another client (the broadcast): the
  // workbench stays — an unpinned project is still active, just off the bar
  await page.click('#navProjects .tab[data-v="alpha"]');
  await page.waitForSelector('#v-alpha.show', { timeout: 5000 });
  await push({ projects: NINE, pinned: ['beta', 'eta'] });
  await sleep(150);
  assert.equal(await view(), 'v-alpha', 'still on alpha');
  assert.deepEqual(await barKeys(), ['beta', 'eta'], 'but its tab is gone');
});

test('at seven: ☆ disabled with the tooltip, the count line goes amber, a 400 reads as the cap', opts, async () => {
  await push({ projects: NINE, pinned: ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta'] });
  await openManage();
  const s = await page.evaluate(() => ({
    text: document.getElementById('pinSummary').textContent.trim(),
    full: document.getElementById('pinSummary').classList.contains('full'),
    color: getComputedStyle(document.getElementById('pinSummary')).color,
    wait: getComputedStyle(document.documentElement).getPropertyValue('--wait').trim(),
  }));
  assert.equal(s.text, '7 of 7 pinned');
  assert.ok(s.full, 'amber when full');
  const r = await rows();
  assert.equal(r.filter(x => x.pinned).length, 7);
  const theta = r.find(x => x.key === 'theta');
  assert.equal(theta.disabled, true);
  assert.equal(theta.tip, CAP_MSG);
  assert.equal(r.find(x => x.key === 'iota').tip, 'inactive projects are hidden from the nav — set it active to pin it',
    'the inactive reason wins over the cap');
  // the tooltip on a disabled ☆ must be fully opaque and readable: the button
  // dims its glyph/border, never its own opacity (which the ::after inherits)
  const btn = page.locator('#manageFrame .mpProj[data-mp="theta"] .mpPin');
  await btn.scrollIntoViewIfNeeded();
  const bb = await btn.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(250);
  const tip = await page.evaluate(() => {
    const b = document.querySelector('#manageFrame .mpProj[data-mp="theta"] .mpPin');
    const a = getComputedStyle(b, '::after');
    return { btnOpacity: getComputedStyle(b).opacity, content: a.content, opacity: a.opacity, bgOpaque: /^rgb\(/.test(a.backgroundColor), dimmed: /rgba\(.*0\.45\)|\/ 0\.45\)/.test(getComputedStyle(b).color) };
  });
  assert.deepEqual(tip, { btnOpacity: '1', content: `"${CAP_MSG}"`, opacity: '1', bgOpaque: true, dimmed: true },
    'tooltip drawn, fully opaque on an opaque panel; the disabled glyph is what is dimmed');
  await page.mouse.move(0, 0);
  // a pin the server rejects (someone else filled the bar first) → the cap toast
  await push({ projects: NINE, pinned: ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'] });
  await sleep(100);
  nextPinStatus = 400;
  writes.length = 0;
  await page.click('#manageFrame .mpProj[data-mp="theta"] [data-pin]');
  await sleep(150);
  nextPinStatus = 200;
  assert.deepEqual(writes, [{ method: 'PATCH', url: '/api/projects/theta', body: { pinOrder: 7 } }]);
  assert.equal(await toastText(), CAP_MSG);
});

test('⌘3 opens slot 3, ⌘0 the overview; nothing fires while an input has focus', opts, async () => {
  await push({ projects: NINE, pinned: ['alpha', 'gamma', 'beta', 'delta'] });
  await sleep(100);
  await page.evaluate(() => document.querySelector('#nav > .tab[data-v="ov"]').click());
  await sleep(100);
  assert.equal(await view(), 'v-ov');
  await page.keyboard.press('Meta+3');
  await sleep(150);
  assert.equal(await view(), 'v-beta', 'slot 3 is beta');
  await page.keyboard.press('Meta+1');
  await sleep(150);
  assert.equal(await view(), 'v-alpha');
  await page.keyboard.press('Meta+0');
  await sleep(150);
  assert.equal(await view(), 'v-ov');
  // the guard: with the caret in an input, ⌘3 is the input's, not ours
  await openManage();
  await page.focus('#npName');
  await page.keyboard.press('Meta+3');
  await sleep(150);
  assert.equal(await view(), 'v-manage', 'stayed put');
  await page.focus('#manageFrame .mpProj[data-mp="alpha"] .mpName');
  await page.keyboard.press('Meta+2');
  await sleep(150);
  assert.equal(await view(), 'v-manage');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Meta+2');
  await sleep(150);
  assert.equal(await view(), 'v-gamma', 'and fires again once nothing has focus');
});

test('an unpinned active project is still in the add-task modal (pins decide only the bar)', opts, async () => {
  await push({ projects: NINE, pinned: ['alpha'] });
  await sleep(100);
  assert.deepEqual(await barKeys(), ['alpha']);
  await page.evaluate(() => document.querySelector('#nav > .tab[data-v="ov"]').click());
  await sleep(100);
  await page.click('#openModal');
  await page.waitForSelector('#mProj .pillOpt', { timeout: 5000 });
  const opts_ = await page.evaluate(() => [...document.querySelectorAll('#mProj .pillOpt')].map(e => e.textContent.trim()));
  assert.ok(opts_.includes('beta') && opts_.includes('Theta'), `unpinned active projects listed: ${opts_.join(', ')}`);
  assert.ok(!opts_.includes('Iota'), 'inactive still excluded');
  await page.keyboard.press('Escape');
});
