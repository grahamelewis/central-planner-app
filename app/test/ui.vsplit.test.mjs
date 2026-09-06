// The right pane's viewer/session split: shrinking the session pane must eat
// the grey log gap and then STOP — the composer and the sessbar buttons never
// clip (Graham's screenshot: at the old blind 82% ceiling on a short window,
// the sessbar sat below the overflow:hidden edge). Three layers under test:
// the measured drag ceiling, the clamp applied to persisted values, and the
// CSS floor (.log min-height:0) that keeps chrome visible even when a bogus
// split is forced directly. Billing-safe: POST/PATCH /api/tasks + GETs only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME, testMonaco } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({ viewport: { width: 1500, height: 700 } }); // short window — the failing geometry
  ({ sb, page } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'split floor', description: 'x', category: 'calibration', oversight: 'coop',
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t.id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's1', startedAt: t.created, lastTurnAt: t.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .sessHalf .composer', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const chrome = () => page.evaluate(() => {
  const sess = document.querySelector('#v-alpha .sessHalf');
  const sr = sess.getBoundingClientRect();
  const bar = sess.querySelector('.sessbar');
  const comp = sess.querySelector('.composer');
  const log = sess.querySelector('.chat .log');
  const vis = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { fully: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1, bottom: r.bottom, h: r.height };
  };
  return {
    paneBottom: sr.bottom, paneH: sr.height,
    bar: vis(bar), comp: vis(comp),
    logH: log ? log.getBoundingClientRect().height : null,
    vsplit: document.querySelector('#v-alpha .rpb').style.getPropertyValue('--vsplit'),
  };
});

test('dragging the divider all the way down stops at the chrome floor — buttons stay', opts, async () => {
  const d = await page.evaluate(() => {
    const el = document.querySelector('#v-alpha .hdivider');
    const r = el.getBoundingClientRect();
    const rp = document.querySelector('#v-alpha .rpb').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 5, bottom: rp.bottom };
  });
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.bottom + 50, { steps: 6 }); // way past the bottom
  await page.mouse.up();
  await sleep(250);
  const s = await chrome();
  assert.ok(s.bar && s.bar.fully, `sessbar fully visible after max shrink (${JSON.stringify(s.bar)})`);
  assert.ok(s.comp && s.comp.fully, 'composer fully visible after max shrink');
  assert.ok(s.logH != null && s.logH >= 10, `a sliver of the grey gap survives (${s.logH}px)`);
});

test('an over-large persisted split is clamped on load', opts, async () => {
  await page.evaluate(() => localStorage.setItem('wbVSplit', '82.0')); // the old blind ceiling
  await page.reload();
  await page.waitForSelector('#v-alpha .sessHalf .composer', { timeout: 15000 });
  await sleep(400);
  const s = await chrome();
  assert.ok(s.bar && s.bar.fully, `persisted 82% clamps — sessbar visible (${JSON.stringify(s.bar)})`);
  assert.ok(parseFloat(s.vsplit) < 82, `applied vsplit clamped below 82 (${s.vsplit})`);
});

test('⇧Enter growth scrolls the textarea instead of evicting the buttons', opts, async () => {
  // shrink the session pane to its floor first
  const d = await page.evaluate(() => {
    const el = document.querySelector('#v-alpha .hdivider');
    const r = el.getBoundingClientRect();
    const rp = document.querySelector('#v-alpha .rpb').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 5, bottom: rp.bottom };
  });
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.bottom + 50, { steps: 4 });
  await page.mouse.up();
  await sleep(250);
  // now write a tall message
  await page.click('#v-alpha #composerInput');
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press('Shift+Enter');
  }
  await sleep(300);
  const s = await chrome();
  assert.ok(s.bar && s.bar.fully, `sessbar survives a 10-line draft in the floored pane (${JSON.stringify(s.bar)})`);
  assert.ok(s.comp && s.comp.fully, 'composer itself stays inside the pane');
  const ta = await page.evaluate(() => {
    const t = document.querySelector('#v-alpha #composerInput');
    return { scrollable: t.scrollHeight > t.clientHeight + 2, h: t.clientHeight };
  });
  assert.ok(ta.scrollable, `past the cap the textarea scrolls internally (h=${ta.h})`);
  // a ROOMY pane keeps the ~7-line design cap: grow the pane back and re-cap
  await page.mouse.move(d.x, await page.evaluate(() => {
    const r = document.querySelector('#v-alpha .hdivider').getBoundingClientRect();
    return r.top + 5;
  }));
  await page.mouse.down();
  const mid = await page.evaluate(() => {
    const rp = document.querySelector('#v-alpha .rpb').getBoundingClientRect();
    return rp.top + rp.height * 0.35;
  });
  await page.mouse.move(d.x, mid, { steps: 4 });
  await page.mouse.up();
  await sleep(350); // ResizeObserver re-caps the tall draft
  const ta2 = await page.evaluate(() => {
    const t = document.querySelector('#v-alpha #composerInput');
    return { h: t.clientHeight };
  });
  assert.ok(ta2.h > ta.h + 20 && ta2.h <= 172, `room returns → the box regrows toward the design cap (${ta.h} → ${ta2.h})`);
  await page.evaluate(() => { // clean the draft for the next test
    const t = document.querySelector('#v-alpha #composerInput');
    t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(150);
});

test('the window shrinking AFTER a valid split re-clamps live (the resize story)', opts, async () => {
  // first give the user a MID-pane preference (test 1 left the floor saved —
  // growing back would rightly stay minimal and prove nothing)
  const d = await page.evaluate(() => {
    const el = document.querySelector('#v-alpha .hdivider');
    const r = el.getBoundingClientRect();
    const rp = document.querySelector('#v-alpha .rpb').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 5, midY: rp.top + rp.height * 0.5 };
  });
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.midY, { steps: 4 });
  await page.mouse.up();
  await sleep(250);
  // the split is fine at 700px tall; shrink the window and the pane's
  // ResizeObserver must pull the divider up before the chrome clips
  await page.setViewportSize({ width: 1500, height: 540 });
  await sleep(400);
  const s = await chrome();
  assert.ok(s.bar && s.bar.fully, `sessbar visible after the window shrank (${JSON.stringify(s.bar)})`);
  assert.ok(s.comp && s.comp.fully, 'composer visible after the window shrank');
  // and space returning grows the pane back toward the saved preference
  await page.setViewportSize({ width: 1500, height: 700 });
  await sleep(400);
  const s2 = await chrome();
  assert.ok(s2.bar && s2.bar.fully, 'still healthy after growing back');
  assert.ok(s2.paneH > s.paneH + 20, `the pane grew back (${s.paneH} → ${s2.paneH})`);
});

/* ── Phase 3 S2.6 (monaco-s2 §2): the split-floor KEEP contract,
   near-verbatim under BOTH editor implementations — the divider dragged all
   the way down still stops at the chrome floor with the sessbar + composer
   fully visible. This task pins no editor file, so the monaco pass proves
   the impl PREFERENCE alone never disturbs the split geometry (boot stays
   idle — exactly the near-verbatim intent; the layout-happened growth for
   this suite is deferred to S3 by the plan's own call). Declared last:
   the shared-page tests above are order-dependent. */
testMonaco('vsplit dual: the divider floor keeps sessbar + composer whole under either editor impl', {
  ui: () => ui,
  page: { viewport: { width: 1500, height: 700 } }, // the failing geometry
}, async ({ page }) => {
  await page.waitForSelector('#v-alpha .sessHalf .composer', { timeout: 15000 });
  await sleep(300);
  const d = await page.evaluate(() => {
    const el = document.querySelector('#v-alpha .hdivider');
    const r = el.getBoundingClientRect();
    const rp = document.querySelector('#v-alpha .rpb').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 5, bottom: rp.bottom };
  });
  await page.mouse.move(d.x, d.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.bottom + 50, { steps: 6 }); // way past the bottom
  await page.mouse.up();
  await sleep(250);
  const s = await page.evaluate(() => {
    const sess = document.querySelector('#v-alpha .sessHalf');
    const sr = sess.getBoundingClientRect();
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { fully: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1 };
    };
    return {
      bar: vis(sess.querySelector('.sessbar')),
      comp: vis(sess.querySelector('.composer')),
      logH: sess.querySelector('.chat .log')?.getBoundingClientRect().height ?? null,
    };
  });
  assert.ok(s.bar && s.bar.fully, `sessbar fully visible after max shrink (${JSON.stringify(s.bar)})`);
  assert.ok(s.comp && s.comp.fully, 'composer fully visible after max shrink');
  assert.ok(s.logH != null && s.logH >= 10, `a sliver of the grey gap survives (${s.logH}px)`);
});
