// Gutter/overlay scroll sync under layer divergence (softWrap files). Chrome
// soft-wraps the textarea at a slightly different effective width than the
// pixel-identical overlay pre (docs/editor-click-offset-diagnosis.txt), so on
// wrap-heavy files the two layers' TOTAL heights can drift apart. The gutter
// numbers used to ride raw ed.scrollTop while the visible text (the overlay)
// clamped at its own shorter end — numbers sailing away from the text — and
// with the divergence reversed the overlay's last rows were unreachable.
// Now (CONTRACT.md "Editor scroll sync"): the gutter keys off the overlay's
// clamp-checked scrollTop, and syncScrollRange pads the shorter layer's
// bottom so both scroll ranges stay equal. Divergence is forced here with
// letter-spacing on the OVERLAY (same mechanism class, deterministic, and
// every wrap point moves) — NOT by restyling the textarea: Blink's textarea
// inner layout honors a wrap-width style change only until the next frame's
// paint pass, so a padded textarea quietly snaps back to its old wrapping.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const PROSE = 'We discipline the persistence and dispersion of idiosyncratic earnings risk jointly from simulated moments of the wealth distribution and the tighter shock grid moves the Gini coefficient by a meaningful amount in the baseline calibration. ';
const LINES = ['\\documentclass{article}', '\\begin{document}'];
for (let i = 0; i < 40; i++) {
  LINES.push(`Paragraph ${i}: ` + PROSE + PROSE);
  LINES.push(`% short marker line ${i}`);
}
LINES.push('\\end{document}', '');

let ui, sb, page;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'scroll.tex'), LINES.join('\n')),
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'scroll sync', category: 'calibration', oversight: 'manual',
    context: { files: ['scroll.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600); // first hlPaint + gutter height sync
});
after(async () => { if (ui) await ui.stop(); });

// scroll the textarea (the real scroll surface) and report every ruler the
// sync machinery must keep in agreement
const scrollAndMeasure = (to) => page.evaluate(async (to) => {
  const ed = document.querySelector('#codeEditor');
  const pre = document.querySelector('pre.codeHL');
  ed.scrollTop = to;
  await new Promise((r) => setTimeout(r, 120)); // programmatic scroll event + rAF chain
  const inner = document.querySelector('#edGutterInner');
  const tf = /translateY\((-?[\d.]+)px\)/.exec(inner.style.transform);
  const lns = pre.querySelectorAll('.ln');
  const rows = inner.children;
  const last = lns.length - 1;
  const paneR = ed.closest('.edWrap').getBoundingClientRect();
  return {
    edTop: ed.scrollTop,
    preTop: pre.scrollTop,
    gutY: tf ? -parseFloat(tf[1]) : NaN,
    edRange: ed.scrollHeight,
    preRange: pre.scrollHeight,
    preMaxLeft: pre.scrollHeight - pre.clientHeight - pre.scrollTop, // 0 ⇒ overlay fully scrolled
    lastLnTop: lns[last].getBoundingClientRect().top,
    lastLnBot: lns[last].getBoundingClientRect().bottom,
    lastRowTop: rows[last] ? rows[last].getBoundingClientRect().top : NaN,
    midLnTop: lns[20].getBoundingClientRect().top,
    midRowTop: rows[20] ? rows[20].getBoundingClientRect().top : NaN,
    paneTop: paneR.top, paneBot: paneR.bottom,
    padBEd: parseFloat(ed.style.paddingBottom) || 0,
    padBPre: parseFloat(pre.style.paddingBottom) || 0,
  };
}, to);

// rewrap the OVERLAY only (letter-spacing moves every wrap point) and push a
// repaint through the app's own pipeline (input → hlSchedule → hlPaint)
const divergeOverlay = (spacing) => page.evaluate(async (spacing) => {
  document.querySelector('pre.codeHL').style.letterSpacing = spacing;
  document.querySelector('#codeEditor').dispatchEvent(new Event('input', { bubbles: true }));
}, spacing);

// .ln spans are inline: their rect top sits a half-leading (~4px) below the
// block row the gutter cell starts on — 8px discriminates against the
// multi-row (~100px+) drift this file pins
const ALIGNED = 8;

test('baseline: numbers, overlay, and textarea scroll as one', opts, async () => {
  const s = await scrollAndMeasure(400);
  assert.ok(Math.abs(s.edTop - 400) < 2, `textarea took the scroll (${s.edTop})`);
  assert.ok(Math.abs(s.preTop - s.edTop) <= 1, `overlay rode along (${s.preTop} vs ${s.edTop})`);
  assert.ok(Math.abs(s.gutY - s.preTop) <= 1, `gutter keyed to the overlay (${s.gutY} vs ${s.preTop})`);
  assert.ok(Math.abs(s.midRowTop - s.midLnTop) <= ALIGNED, `number 21 sits on line 21 (${s.midRowTop} vs ${s.midLnTop})`);
});

test('overlay shorter than the textarea: numbers stay on the text to the last row', opts, async () => {
  // tighten the overlay's glyphs — it wraps later, drops rows, and ends up
  // SHORTER than the textarea: the exact shape of the reported bug (numbers
  // sailed on while the text sat clamped at its own end)
  await divergeOverlay('-1.5px');
  await sleep(400); // input → hlSchedule → hlPaint → syncScrollRange
  const s = await scrollAndMeasure(1e9);
  assert.ok(s.padBPre > 40, `forcing took: overlay was padded up to the textarea (${s.padBPre}px)`);
  assert.ok(Math.abs(s.edRange - s.preRange) <= 2, `ranges equalized (${s.edRange} vs ${s.preRange})`);
  assert.ok(Math.abs(s.gutY - s.preTop) <= 1, `gutter keyed to the overlay (${s.gutY} vs ${s.preTop})`);
  assert.ok(Math.abs(s.lastRowTop - s.lastLnTop) <= ALIGNED, `last number sits on the last line (${s.lastRowTop} vs ${s.lastLnTop})`);
  // the textarea's extra rows are blank overlay padding at the very bottom
  // (with THIS synthetic 40-row delta the tail is taller than the pane —
  // real divergences are a few rows); backing up to just above the tail must
  // show the real last row at the pane bottom, still glued to its number
  const paneH = s.paneBot - s.paneTop;
  const t = await scrollAndMeasure(s.preRange - (s.padBPre - s.padBEd) - paneH + 2);
  assert.ok(t.lastLnBot <= t.paneBot && t.lastLnBot > t.paneBot - 40, `last line rests at the pane bottom (${t.lastLnBot} vs ${t.paneBot})`);
  assert.ok(t.lastLnTop >= t.paneTop, 'and is on screen');
  assert.ok(Math.abs(t.lastRowTop - t.lastLnTop) <= ALIGNED, `still numbered there (${t.lastRowTop} vs ${t.lastLnTop})`);
});

test('overlay taller than the textarea: the tail is still reachable', opts, async () => {
  // flip the divergence: wider glyphs → the overlay wraps earlier and grows
  // TALLER. Without range parity the textarea runs out of scroll first and
  // the overlay's last rows can never be shown.
  await divergeOverlay('1.5px');
  await sleep(400);
  const s = await scrollAndMeasure(1e9);
  assert.ok(s.padBEd > 40, `forcing took: textarea was padded up to the overlay (${s.padBEd}px)`);
  assert.ok(Math.abs(s.edRange - s.preRange) <= 2, `ranges equalized (${s.edRange} vs ${s.preRange})`);
  assert.ok(s.preMaxLeft <= 2, `overlay reached its own end (${s.preMaxLeft}px short)`);
  assert.ok(Math.abs(s.gutY - s.preTop) <= 1, `gutter keyed to the overlay (${s.gutY} vs ${s.preTop})`);
  assert.ok(Math.abs(s.lastRowTop - s.lastLnTop) <= ALIGNED, `last number sits on the last line (${s.lastRowTop} vs ${s.lastLnTop})`);
  assert.ok(s.lastLnBot <= s.paneBot + 2 && s.lastLnTop >= s.paneTop, 'last line is on screen at full scroll');
});

test('range parity is a fixed point — repaints do not stack padding', opts, async () => {
  const s = await page.evaluate(async () => {
    const ed = document.querySelector('#codeEditor');
    const pre = document.querySelector('pre.codeHL');
    const pads = [];
    for (let i = 0; i < 3; i++) {
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      pads.push([parseFloat(ed.style.paddingBottom) || 0, parseFloat(pre.style.paddingBottom) || 0]);
    }
    return { pads, edRange: ed.scrollHeight, preRange: pre.scrollHeight };
  });
  assert.ok(Math.abs(s.edRange - s.preRange) <= 2, `ranges stay equal (${s.edRange} vs ${s.preRange})`);
  assert.deepEqual(s.pads[1], s.pads[2], `padding converged (${JSON.stringify(s.pads)})`);
  assert.ok(s.pads[2].every((p) => p < 800), `padding stays proportionate (${s.pads[2]})`);
});
