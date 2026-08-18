// Overlay-authoritative pointer input in the soft-wrap editor. Chrome's
// textarea soft-wraps at a slightly different effective width than the
// pixel-identical overlay pre (width-dependent — see
// docs/editor-click-offset-diagnosis.txt), so on wrap-heavy lines its break
// columns diverge from the glyphs the user actually sees. Clicks used to be
// hit-tested by the textarea (its private layout), painting the caret above/
// left of the aimed glyph. Now pointer input maps through the OVERLAY with
// pure Range geometry — deliberately NOT caretPositionFromPoint, whose hit
// resolution drifts under zoom/display scaling (CONTRACT "Editor pointer
// input"). The math-dense fixture line below PROVABLY diverges
// at the harness's 1600px viewport — the click tests here fail against the
// native hit test, so they pin the fix, not just describe it.
// Billing-safe: GET routes + one POST /api/tasks only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const CMT = '% referee two wants the shock grid tightened before resubmission and the appendix rebuilt with the alternative calibration of the borrowing constraint and a longer comment keeps wrapping onward through several visual rows to stress the italic metrics of the comment face. ';
const CMD = '\\textbf{Proposition} \\ref{prop:main} \\cite{aiyagari1994} \\emph{shows} \\(\\rho\\) \\textit{that} \\cite{krusell1998} \\footnote{robust} \\emph{tighter} \\ref{tab:moments} \\cite{huggett1993} \\textbf{grids} \\emph{move} \\ref{fig:gini} \\cite{carroll1997} \\textit{the} \\footnote{see appendix} \\emph{wealth} \\textbf{distribution} \\cite{deaton1991} \\ref{sec:results} \\emph{persistently}. ';
const MATH = 'The value function satisfies $v(a,z) = \\max_{c,a\\prime} u(c) + \\beta E[v(a\\prime,z\\prime)|z]$ subject to $c + a\\prime = (1+r)a + wz$ and $a\\prime \\ge -\\phi$ with $\\log z\\prime = \\rho \\log z + \\epsilon$ where $\\epsilon \\sim N(0,\\sigma^2)$ across the whole wrapped width of the pane. ';
const PLAIN = 'We discipline the persistence and dispersion of idiosyncratic earnings risk jointly from simulated moments of the wealth distribution and the tighter shock grid moves the Gini coefficient by a meaningful amount in the baseline calibration of the model economy. ';
// line indices in this fixture: 8 = the diverging math line (same layout the
// diagnosis probes used), 9 = a short line after it
const LINES = [
  '\\documentclass{article}', '\\begin{document}',
  PLAIN + PLAIN, 'Short after plain.',
  CMT + CMT, 'Short after comment.',
  CMD + CMD, 'Short after commands.',
  MATH + MATH, 'Short after math.',
  '',                                                              // 10 blank
  '\\begin{equation}',                                             // 11
  '  v(a,z) = \\max_{c,a\\prime} u(c) + \\beta E[v(a\\prime,z\\prime)|z]', // 12 display eq
  '\\end{equation}',                                               // 13
  'Setting \\newcommand{\\superlongunbrokenmacronamewithoutanyspacesatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx}{1} makes its row end jagged mid-pane. ', // 14
  'short tail line.',                                              // 15
  '\\end{document}', ''];
const MATH_LINE = 8;

let ui, sb, page;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), LINES.join('\n')),
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'click precision', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600);
});
after(async () => { if (ui) await ui.stop(); });

// viewport center of the glyph at (line, col), measured off the OVERLAY —
// i.e. the pixel the user aims at
const glyphAt = (line, col) => page.evaluate(([line, col]) => {
  const el = document.querySelector('#codeHL').children[line];
  if (!el) return null;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let nd, seen = 0, pt = null;
  while ((nd = w.nextNode())) {
    if (seen + nd.data.length > col) { pt = [nd, col - seen]; break; }
    seen += nd.data.length;
  }
  if (!pt) return null;
  const rg = document.createRange();
  rg.setStart(pt[0], pt[1]); rg.setEnd(pt[0], pt[1] + 1);
  const rc = [...rg.getClientRects()].find((r) => r.width > 0);
  // aim at the glyph's LEFT THIRD: a caret hit test resolves to the nearest
  // boundary (native semantics), so a dead-center click is a coin flip
  // between col and col+1 — the left third is deterministically col
  return rc ? { x: rc.left + rc.width * 0.3, y: rc.top + rc.height / 2, top: rc.top } : null;
}, [line, col]);

const selection = () => page.evaluate(() => {
  const ed = document.querySelector('#codeEditor');
  const lc = (off) => {
    const upto = ed.value.slice(0, off);
    return `${(upto.match(/\n/g) || []).length}:${upto.length - (upto.lastIndexOf('\n') + 1)}`;
  };
  return { start: lc(ed.selectionStart), end: lc(ed.selectionEnd), rawS: ed.selectionStart, rawE: ed.selectionEnd };
});

// the columns where the overlay starts each visual row of a line
const rowStarts = (line) => page.evaluate((line) => {
  const el = document.querySelector('#codeHL').children[line];
  const lh = parseFloat(getComputedStyle(document.querySelector('#codeEditor')).lineHeight);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = []; let nd;
  while ((nd = w.nextNode())) nodes.push(nd);
  const rectAt = (col) => {
    let seen = 0;
    for (const n of nodes) {
      if (seen + n.data.length > col) {
        const rg = document.createRange();
        rg.setStart(n, col - seen); rg.setEnd(n, col - seen + 1);
        return [...rg.getClientRects()].find((r) => r.width > 0) || null;
      }
      seen += n.data.length;
    }
    return null;
  };
  const starts = [0];
  let lastTop = rectAt(0)?.top ?? 0;
  const len = el.textContent.replace(/\n$/, '').length;
  for (let c = 1; c < len; c++) {
    const rc = rectAt(c);
    if (rc && rc.top - lastTop > lh / 2) { starts.push(c); lastTop = rc.top; }
  }
  return starts;
}, line);

test('clicks land on the aimed glyph even where the layers\' wrap columns diverge', opts, async () => {
  // sample the math line every 25 cols — the diagnosis showed cols ~292+
  // mis-mapping by 6 under the native hit test at this exact viewport
  for (let col = 25; col < 500; col += 25) {
    const g = await glyphAt(MATH_LINE, col);
    if (!g) continue;
    await page.mouse.click(g.x, g.y);
    await sleep(90);
    const s = await selection();
    assert.equal(s.start, `${MATH_LINE}:${col}`, `click at ${MATH_LINE}:${col} → caret there (got ${s.start})`);
  }
});

test('the caret paints on the clicked visual row — never the row above', opts, async () => {
  const starts = await rowStarts(MATH_LINE);
  assert.ok(starts.length > 2, `math line wraps (${starts.length} rows)`);
  // the first characters of continuation rows were the "appears above" case:
  // native mapping put them at the tail of the previous row
  for (const rowStart of starts.slice(1, 4)) {
    const g = await glyphAt(MATH_LINE, rowStart + 1);
    await page.mouse.click(g.x, g.y);
    await sleep(120);
    const r = await page.evaluate(() => {
      const c = document.querySelector('.edCaret');
      return c && c.style.display !== 'none' ? c.getBoundingClientRect().top : null;
    });
    const s = await selection();
    assert.equal(s.start, `${MATH_LINE}:${rowStart + 1}`, `caret at row-start col ${rowStart + 1}`);
    // the caret spans the ROW box; the glyph rect is the (half-leading-inset)
    // glyph box — same row means within half a line-height, not px-equal
    assert.ok(r != null && Math.abs(r - g.top) < 9,
      `caret painted on the clicked row (caret top ${r} vs glyph top ${g.top})`);
  }
});

test('drag-select is exact across wrapped rows', opts, async () => {
  const a = await glyphAt(MATH_LINE, 40);
  const b = await glyphAt(MATH_LINE, 340);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  const s = await selection();
  assert.equal(s.start, `${MATH_LINE}:40`, `selection start (got ${s.start})`);
  assert.equal(s.end, `${MATH_LINE}:340`, `selection end (got ${s.end})`);
});

test('double-click selects the word under the pointer in a diverged region', opts, async () => {
  // "function" sits just past the divergence point the diagnosis mapped
  const line = LINES[MATH_LINE];
  const at = line.indexOf('function', 250); // the second copy, deep in the wrap
  const g = await glyphAt(MATH_LINE, at + 3);
  await page.mouse.dblclick(g.x, g.y);
  await sleep(150);
  const s = await selection();
  assert.equal(s.start, `${MATH_LINE}:${at}`, `word start (got ${s.start})`);
  assert.equal(s.end, `${MATH_LINE}:${at + 'function'.length}`, `word end (got ${s.end})`);
});

test('shift-click extends from the existing caret', opts, async () => {
  const a = await glyphAt(MATH_LINE, 30);
  await page.mouse.click(a.x, a.y);
  await sleep(100);
  const b = await glyphAt(MATH_LINE, 160);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await sleep(120);
  const s = await selection();
  assert.equal(s.start, `${MATH_LINE}:30`, `anchor held (got ${s.start})`);
  assert.equal(s.end, `${MATH_LINE}:160`, `extended to the click (got ${s.end})`);
});

test('clicking PAST a line end lands at the line end — caret on that row, never above', opts, async () => {
  // the residual Graham reported: end-of-line clicks "pushed quite far up"
  // (the old caretPositionFromPoint path missed there and fell back native)
  for (const line of [15, 12]) { // short tail + the display equation
    const g = await page.evaluate((line) => {
      const el = document.querySelector('#codeHL').children[line];
      const t = el.textContent.replace(/\n$/, '');
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let nd, seen = 0, pt = null;
      while ((nd = w.nextNode())) {
        if (seen + nd.data.length >= t.length) { pt = [nd, t.length - 1 - seen]; break; }
        seen += nd.data.length;
      }
      const rg = document.createRange();
      rg.setStart(pt[0], pt[1]); rg.setEnd(pt[0], pt[1] + 1);
      const rc = [...rg.getClientRects()].find((r) => r.width > 0);
      return { right: rc.right, y: rc.top + rc.height / 2, top: rc.top, len: t.length };
    }, line);
    for (const dx of [25, 160]) {
      await page.mouse.click(g.right + dx, g.y);
      await sleep(120);
      const s = await selection();
      assert.equal(s.start, `${line}:${g.len}`, `+${dx}px past line ${line} → its end (got ${s.start})`);
      const ct = await page.evaluate(() => {
        const c = document.querySelector('.edCaret');
        return c && c.style.display !== 'none' ? c.getBoundingClientRect().top : null;
      });
      assert.ok(ct != null && Math.abs(ct - g.top) < 9,
        `caret on the clicked row (caret ${ct} vs row ${g.top})`);
    }
  }
});

test('clicking a blank line puts the caret there, col 0', opts, async () => {
  const g = await page.evaluate(() => {
    const el = document.querySelector('#codeHL').children[10];
    const r = el.getBoundingClientRect();
    return { top: r.top, h: r.height || 19 };
  });
  await page.mouse.click(500, g.top + g.h / 2);
  await sleep(120);
  const s = await selection();
  assert.equal(s.start, '10:0', `blank line takes the caret (got ${s.start})`);
});

test('the jagged gap right of a break-word row selects that row\'s end', opts, async () => {
  // the unbreakable macro forces an early soft break — the empty gap beside
  // it is exactly where "clicking equations" used to fly off
  const jag = await page.evaluate(() => {
    const el = document.querySelector('#codeHL').children[14];
    const t = el.textContent.replace(/\n$/, '');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let nd, first = null, seen = 0, endPt = null;
    while ((nd = w.nextNode())) {
      if (!first) first = nd;
      if (seen + nd.data.length >= t.length) { endPt = [nd, t.length - seen]; break; }
      seen += nd.data.length;
    }
    const rg = document.createRange();
    rg.setStart(first, 0); rg.setEnd(endPt[0], endPt[1]);
    const rows = [];
    for (const rc of rg.getClientRects()) {
      if (!rc.width && !rc.height) continue;
      const prev = rows[rows.length - 1];
      if (prev && Math.abs(rc.top - prev.top) < rc.height / 2) {
        prev.x1 = Math.max(prev.x1, rc.right);
      } else rows.push({ top: rc.top, h: rc.height, x1: rc.right });
    }
    const maxRight = Math.max(...rows.map((r) => r.x1));
    const j = rows.find((r) => maxRight - r.x1 > 100);
    return j ? { x1: j.x1, y: j.top + j.h / 2, top: j.top } : null;
  });
  assert.ok(jag, 'the fixture produced a jagged row');
  // ground truth for the row's end: a click just inside its last glyph
  await page.mouse.click(jag.x1 - 3, jag.y);
  await sleep(110);
  const inside = (await selection()).start;
  await page.mouse.click(jag.x1 + 60, jag.y); // the gap
  await sleep(120);
  const s = await selection();
  const [inL, inC] = inside.split(':').map(Number);
  const [gL, gC] = s.start.split(':').map(Number);
  assert.equal(gL, inL, `gap click stays on line ${inL} (got ${s.start})`);
  assert.ok(gC >= inC && gC <= inC + 2, `gap click ≈ row end (${s.start} vs inside ${inside})`);
  const ct = await page.evaluate(() => {
    const c = document.querySelector('.edCaret');
    return c && c.style.display !== 'none' ? c.getBoundingClientRect().top : null;
  });
  assert.ok(ct != null && Math.abs(ct - jag.top) < 9,
    `caret painted on the jagged row (caret ${ct} vs row ${jag.top})`);
});

test('typing after a corrected click inserts at the clicked spot', opts, async () => {
  const g = await glyphAt(MATH_LINE, 300); // the diagnosis's original repro col
  await page.mouse.click(g.x, g.y);
  await sleep(100);
  await page.keyboard.type('@');
  await sleep(150);
  const v = await page.evaluate(() => document.querySelector('#codeEditor').value.split('\n')[8]);
  assert.equal(v[300], '@', 'the typed char landed at the clicked column');
  await page.keyboard.press('Backspace'); // leave the draft as we found the text
  await sleep(100);
});
