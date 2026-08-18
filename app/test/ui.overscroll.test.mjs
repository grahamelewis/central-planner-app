// Viewport sturdiness (CONTRACT.md): the dashboard never wobbles. On a Mac,
// any scroll delta no pane consumes chains to the viewport, and macOS elastic
// overscroll rubber-bands the whole page — on either axis, even with nothing
// to scroll. The bounce itself is a compositor gesture headless Chrome can't
// reproduce, so this pins what produces/permits it: the root's declared
// locks, zero document slack where views are viewport-bound (task view, both
// axes; overview, x), and — the deliberate asymmetry — that the overview's
// REAL vertical scrolling still works (overflow-y must never be locked; only
// its edge bounce goes).
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
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
    // laptop-ish: at this height the overview genuinely overflows the window,
    // so the still-scrollable assertion below actually bites
    viewport: { width: 1280, height: 800 },
    seed: ({ projRoots }) => fs.writeFileSync(
      path.join(projRoots.alpha, 'notes.tex'),
      '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n',
    ),
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'sturdy viewport', category: 'calibration', oversight: 'manual',
    context: { files: ['notes.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600);
});
after(async () => { if (ui) await ui.stop(); });

test('the root declares the locks: no bounce on either axis, x unpannable', opts, async () => {
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { overflowX: cs.overflowX, overflowY: cs.overflowY, osX: cs.overscrollBehaviorX, osY: cs.overscrollBehaviorY };
  });
  assert.equal(s.osX, 'none', 'horizontal elastic bounce / swipe-back must be off');
  assert.equal(s.osY, 'none', 'vertical elastic bounce must be off');
  assert.equal(s.overflowX, 'hidden', 'stray overflow must never make the document x-pannable');
  assert.notEqual(s.overflowY, 'hidden', 'overflow-y must stay free — the overview scrolls the document');
  assert.notEqual(s.overflowY, 'clip', 'overflow-y must stay free — the overview scrolls the document');
});

test('the task view is viewport-bound on both axes — no scroll is possible at all', opts, async () => {
  const s = await page.evaluate(() => {
    const se = document.scrollingElement;
    return {
      xSlack: se.scrollWidth - document.documentElement.clientWidth,
      ySlack: se.scrollHeight - document.documentElement.clientHeight,
    };
  });
  assert.equal(s.xSlack, 0, 'task view: document exactly viewport-wide');
  assert.equal(s.ySlack, 0, 'task view: document exactly viewport-tall');
});

test('the overview still scrolls vertically for real — only its edge bounce is gone', opts, async () => {
  await page.evaluate(() => { location.hash = ''; });
  await page.reload();
  await sleep(800);
  const s = await page.evaluate(() => {
    const se = document.scrollingElement;
    const xSlack = se.scrollWidth - document.documentElement.clientWidth;
    se.scrollTop = 50;
    const moved = se.scrollTop;
    se.scrollTop = 0;
    return { xSlack, moved };
  });
  assert.equal(s.xSlack, 0, 'overview: document exactly viewport-wide');
  assert.ok(s.moved > 0, `overview: vertical document scroll must keep working (moved ${s.moved}px)`);
});

test('scrollbar thumbs paint only while a pane is scrolling', opts, async () => {
  // overlay-style fade (Graham 2026-07-30): custom-styled webkit scrollbars
  // never fade natively, so app.js stamps the scrolled element with
  // .scrolling and style.css keys the thumb color off it. The 8px gutter is
  // always reserved — only the PAINT toggles — so panes never reflow.
  const r = await page.evaluate(async () => {
    // the overview page's own scroller — a document scroll must stamp <html>
    const el = document.documentElement;
    const thumb = () => getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor;
    // the PREVIOUS test scrolled the document programmatically — let that
    // stamp's ~700ms linger fade before sampling the at-rest state
    await new Promise((res) => setTimeout(res, 900));
    const before = thumb();
    document.dispatchEvent(new Event('scroll', { bubbles: false }));
    await new Promise((res) => setTimeout(res, 60));
    const during = { color: thumb(), cls: el.classList.contains('scrolling') };
    await new Promise((res) => setTimeout(res, 900));
    const after = { color: thumb(), cls: el.classList.contains('scrolling') };
    return { before, during, after };
  });
  assert.match(r.before, /rgba\(0, 0, 0, 0\)|transparent/, `thumb invisible at rest (${r.before})`);
  assert.ok(r.during.cls, 'scroll stamps the pane');
  assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(r.during.color), `thumb paints while scrolling (${r.during.color})`);
  assert.ok(!r.after.cls && /rgba\(0, 0, 0, 0\)|transparent/.test(r.after.color), 'thumb fades ~700ms after the last scroll');
});
