// Soft wrap in the editor (prose files): a long .tex line wraps down to the
// pane width instead of scrolling right — ONE line number spanning all its
// visual rows, gutter cells sized to match, caret/selection measured off the
// overlay instead of line×lineHeight. Code files keep wrap="off" untouched.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

// line 4 (index 3) is the monster: ~600 chars of prose, wraps into 4+ rows
const LONG = 'This sentence runs far past any reasonable pane width and keeps going because tex prose paragraphs are often written as one enormous logical line per sentence or even per paragraph, which is exactly the case soft wrap exists for. '.repeat(3).trim();
const TEX = `\\documentclass{article}
\\begin{document}
\\section{Intro}\\label{sec:intro}
${LONG}
Short line after.
\\end{document}
`;
const JL_LONG = `x = 1 ${'# a very long trailing comment that must NOT wrap in code files '.repeat(8)}`;
const JL = `${JL_LONG}\ny = 2\n`;

let ui, sb, page;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), JL);
    },
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Wrap check', category: 'calibration', oversight: 'manual',
    context: { files: ['notes.tex', 'model.jl'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600); // first hlPaint + gutter height sync
});
after(async () => { if (ui) await ui.stop(); });

const LH = 11 * 1.75; // .codeEdit font-size × line-height

test('a .tex editor soft-wraps: no horizontal scroll, layers agree', opts, async () => {
  const s = await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    const pre = document.querySelector('pre.codeHL');
    return {
      wrap: ed.getAttribute('wrap'),
      cls: ed.closest('.edWrap').className,
      hOverflow: ed.scrollWidth - ed.clientWidth,
      edH: ed.scrollHeight,
      preH: pre.scrollHeight,
    };
  });
  assert.equal(s.wrap, 'soft');
  assert.match(s.cls, /softWrap/);
  assert.ok(s.hOverflow <= 1, `no sideways scrolling (overflow ${s.hOverflow}px)`);
  // if the overlay wrapped at different points than the textarea, their
  // total heights would disagree — this is the layers-in-lockstep invariant
  assert.ok(Math.abs(s.edH - s.preH) <= 2, `overlay wraps with the textarea (${s.edH} vs ${s.preH})`);
});

test('one number per logical line; the wrapped line owns a taller gutter cell', opts, async () => {
  const s = await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    const rows = [...document.querySelectorAll('#edGutterInner > div')];
    const lns = [...document.querySelectorAll('#codeHL .ln')];
    return {
      logical: ed.value.split('\n').length,
      rows: rows.length,
      lastNum: rows[rows.length - 1]?.textContent,
      cellH: rows.map((r) => r.getBoundingClientRect().height),
      lnH: lns.map((el, i) => (lns[i + 1] ? lns[i + 1].offsetTop - el.offsetTop : null)),
    };
  });
  assert.equal(s.rows, s.logical, 'gutter rows = logical lines, not visual rows');
  assert.equal(s.lastNum, String(s.logical));
  assert.ok(s.cellH[3] > LH * 2.5, `long line's cell spans its rows (${s.cellH[3]}px)`);
  assert.ok(Math.abs(s.cellH[2] - LH) < 3, `short line's cell stays one row (${s.cellH[2]}px)`);
  // each gutter cell must be exactly as tall as its overlay line
  for (let i = 0; i < 5; i++) {
    if (s.lnH[i] == null) continue;
    assert.ok(Math.abs(s.cellH[i] - s.lnH[i]) < 2, `cell ${i + 1} matches its line (${s.cellH[i]} vs ${s.lnH[i]})`);
  }
});

test('the caret lands on the correct visual row inside a wrapped line', opts, async () => {
  const s = await page.evaluate(async () => {
    const ed = document.querySelector('#codeEditor');
    const lines = ed.value.split('\n');
    const endOfLong = lines.slice(0, 4).join('\n').length; // end of line 4
    ed.focus();
    ed.setSelectionRange(endOfLong, endOfLong);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const caret = document.querySelector('.edCaret');
    const lnTop = document.querySelectorAll('#codeHL .ln')[3].offsetTop;
    return {
      top: parseFloat(caret.style.top),
      left: parseFloat(caret.style.left),
      lnTop,
      paneW: ed.clientWidth,
    };
  });
  assert.ok(s.top > s.lnTop + LH, `caret rode the wrap down (${s.top} vs line top ${s.lnTop})`);
  assert.ok(s.left >= 0 && s.left < s.paneW, `caret x stays inside the pane (${s.left})`);
});

test('the current-line band tints every wrapped row, full width', opts, async () => {
  const s = await page.evaluate(async () => {
    const ed = document.querySelector('#codeEditor');
    const lines = ed.value.split('\n');
    const midOfLong = lines.slice(0, 3).join('\n').length + 40; // inside line 4
    ed.focus();
    ed.setSelectionRange(midOfLong, midOfLong);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const band = document.querySelector('.edLnBand');
    const pre = document.querySelector('pre.codeHL');
    const cell = document.querySelectorAll('#edGutterInner > div')[3].getBoundingClientRect();
    const b = band.getBoundingClientRect();
    const shown = band.style.display !== 'none';
    // a range selection is not a caret — the band must yield to the bands
    ed.setSelectionRange(midOfLong, midOfLong + 20);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const hiddenOnSelection = band.style.display === 'none';
    ed.setSelectionRange(midOfLong, midOfLong);
    return { shown, top: b.top, h: b.height, w: b.width, cellTop: cell.top, cellH: cell.height, paneW: pre.clientWidth, hiddenOnSelection };
  });
  assert.ok(s.shown, 'band paints while the caret sits in the line');
  assert.ok(s.h > LH * 2.5, `band spans the wrapped rows (${s.h}px)`);
  assert.ok(Math.abs(s.h - s.cellH) < 3, `band height matches the gutter cell (${s.h} vs ${s.cellH})`);
  assert.ok(Math.abs(s.top - s.cellTop) < 3, `band top matches the gutter cell (${s.top} vs ${s.cellTop})`);
  assert.ok(s.w >= s.paneW - 1, `band runs the full pane width (${s.w} vs ${s.paneW})`);
  assert.ok(s.hiddenOnSelection, 'band hides while a range is selected');
});

test('selecting the wrapped line draws one band per visual row', opts, async () => {
  const s = await page.evaluate(async () => {
    const ed = document.querySelector('#codeEditor');
    const lines = ed.value.split('\n');
    const start = lines.slice(0, 3).join('\n').length + 1;
    ed.focus();
    ed.setSelectionRange(start, start + lines[3].length);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bands = [...document.querySelectorAll('.selBand')];
    return {
      count: bands.length,
      tops: bands.map((b) => parseFloat(b.style.top)),
      maxRight: Math.max(...bands.map((b) => parseFloat(b.style.left) + parseFloat(b.style.width))),
      paneW: ed.clientWidth,
    };
  });
  assert.ok(s.count >= 4, `wrapped selection = one band per row (${s.count})`);
  assert.ok(new Set(s.tops.map(Math.round)).size === s.count, 'bands sit on distinct rows');
  assert.ok(s.maxRight <= s.paneW + 8, `bands never run off the pane (${s.maxRight} vs ${s.paneW})`);
});

test('growing the long line re-sizes its gutter cell', opts, async () => {
  const s = await page.evaluate(async () => {
    const ed = document.querySelector('#codeEditor');
    const cell = () => document.querySelectorAll('#edGutterInner > div')[3].getBoundingClientRect().height;
    const before = cell();
    const lines = ed.value.split('\n');
    const endOfLong = lines.slice(0, 4).join('\n').length;
    ed.setRangeText(' more words to force another visual row '.repeat(4), endOfLong, endOfLong, 'end');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250)); // hlSchedule rAF + paint
    return { before, after: cell() };
  });
  assert.ok(s.after > s.before + LH - 3, `cell grew with the line (${s.before} → ${s.after})`);
});

test('code files are untouched: wrap stays off, long lines scroll right', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('.ctab')].find((t) => t.textContent.includes('model.jl'))?.click();
  });
  await sleep(500);
  const s = await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    return {
      ext: ed.dataset.ext,
      wrap: ed.getAttribute('wrap'),
      cls: ed.closest('.edWrap').className,
      hOverflow: ed.scrollWidth - ed.clientWidth,
      sizedCells: [...document.querySelectorAll('#edGutterInner > div')].filter((d) => d.style.height).length,
    };
  });
  assert.equal(s.ext, 'jl');
  assert.equal(s.wrap, 'off');
  assert.ok(!/softWrap/.test(s.cls));
  assert.ok(s.hOverflow > 50, `long code line still overflows sideways (${s.hOverflow}px)`);
  assert.equal(s.sizedCells, 0, 'no per-line heights outside softWrap mode');
});
