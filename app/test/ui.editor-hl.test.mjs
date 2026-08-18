// Editor highlight geometry. Two invariants:
// 1) Overlay line decorations (jump-flash etc.) are the inline content box,
//    vertically CENTERED in the row by half-leading — measured against the
//    PRE's padding box (measuring from the inline <code> rect was the
//    2026-07-20 mistake: its top already sits at the first line's content
//    box, which made a correctly-centered band look top-anchored).
// 2) Text selection is drawn by wireWB's syncSel as .selBand rows in the
//    overlay's coordinate space; the native textarea ::selection is
//    transparent (at some zoom/scaling combos Chrome paints textarea rows a
//    few px off the overlay glyphs — the off-center band in the 2026-07-20
//    screenshots).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };

const TEX = '\\documentclass{article}\n\\begin{document}\n\n\\section{Intro}\n\nBody here.\n\n\\end{document}\n'
  + Array.from({ length: 60 }, (_, i) => `% filler ${i + 1}`).join('\n') + '\n'; // tall enough to scroll

let ui, sb, page;
before(async () => {
  if (!fs.existsSync(CHROME)) return;
  ui = await startUI({ seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'p.tex'), TEX) });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'T', category: 'calibration', oversight: 'manual', context: { files: ['p.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

const geom = () => page.evaluate(() => {
  const ed = document.querySelector('#v-alpha #codeEditor');
  const wrap = ed.closest('.edWrap');
  const pre = wrap.querySelector('pre.codeHL');
  const pr = pre.getBoundingClientRect();
  const cs = getComputedStyle(pre);
  return {
    preTop: pr.top, lh: parseFloat(cs.lineHeight),
    padT: parseFloat(cs.paddingTop), padL: parseFloat(cs.paddingLeft),
  };
});

test('jump-flash band: content box centered in the row (symmetric half-leading)', opts, async () => {
  const g = await geom();
  const m = await page.evaluate(() => {
    const hl = document.querySelector('#v-alpha #codeHL');
    const span = hl.children[5]; // line 6 = "Body here."
    span.classList.add('lnFlash');
    const sr = span.getBoundingClientRect();
    return { top: sr.top, bottom: sr.bottom };
  });
  const rowTop = g.preTop + g.padT + 5 * g.lh;
  const gapAbove = m.top - rowTop;
  const gapBelow = (rowTop + g.lh) - m.bottom;
  assert.ok(gapAbove >= 0 && gapBelow >= 0,
    `band stays inside its row (above ${gapAbove.toFixed(2)}, below ${gapBelow.toFixed(2)})`);
  assert.ok(Math.abs(gapAbove - gapBelow) < 1.5,
    `band centered: half-leading symmetric (above ${gapAbove.toFixed(2)} vs below ${gapBelow.toFixed(2)})`);
});

test('selection: native band transparent; custom .selBand row-aligned with the glyphs', opts, async () => {
  const g = await geom();
  const m = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    const wrap = ed.closest('.edWrap');
    const pre = wrap.querySelector('pre.codeHL');
    ed.focus();
    const start = ed.value.indexOf('Body here.');
    ed.setSelectionRange(start, start + 10);
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const bands = [...pre.querySelectorAll('.selBand')].map((b) => {
        const r = b.getBoundingClientRect();
        return { top: r.top, height: r.height, left: r.left, width: r.width };
      });
      const span = wrap.querySelector('#codeHL').children[5].getBoundingClientRect();
      res({
        bands, spanLeft: span.left, spanWidth: span.width,
        nativeSel: getComputedStyle(ed, '::selection').backgroundColor,
        caretShown: getComputedStyle(wrap.querySelector('.edCaret')).display !== 'none',
      });
    })));
  });
  assert.equal(m.nativeSel, 'rgba(0, 0, 0, 0)', 'native textarea selection is not painted');
  assert.equal(m.bands.length, 1, `one band for a single-line selection (${JSON.stringify(m.bands)})`);
  const b = m.bands[0];
  const rowTop = g.preTop + g.padT + 5 * g.lh;
  assert.ok(Math.abs(b.top - rowTop) < 0.5, `band top on the row grid (${b.top} vs ${rowTop})`);
  assert.ok(Math.abs(b.height - g.lh) < 0.5, `band is exactly one row tall (${b.height})`);
  assert.ok(Math.abs(b.left - m.spanLeft) < 1.5, `band starts where the glyphs start (${b.left} vs ${m.spanLeft})`);
  assert.ok(Math.abs(b.width - m.spanWidth) < 3, `band spans the selected text (${b.width} vs ${m.spanWidth})`);
  assert.equal(m.caretShown, false, 'caret hides while a selection is active');
});

test('multi-line selection: one band per row; empty rows keep a nub; collapse clears', opts, async () => {
  const g = await geom();
  const m = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    const pre = ed.closest('.edWrap').querySelector('pre.codeHL');
    ed.focus();
    const s = ed.value.indexOf('{Intro}');           // middle of line 4
    const e = ed.value.indexOf('here.') + 2;         // middle of line 6
    ed.setSelectionRange(s, e);
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const bands = [...pre.querySelectorAll('.selBand')].map((b) => {
        const r = b.getBoundingClientRect();
        return { top: +r.top.toFixed(2), left: +r.left.toFixed(2), width: +r.width.toFixed(2) };
      });
      ed.setSelectionRange(e, e); // collapse
      requestAnimationFrame(() => requestAnimationFrame(() => {
        res({ bands, after: pre.querySelectorAll('.selBand').length });
      }));
    })));
  });
  assert.equal(m.bands.length, 3, `three rows selected → three bands (${JSON.stringify(m.bands)})`);
  const tops = m.bands.map((b) => b.top);
  assert.ok(Math.abs(tops[1] - tops[0] - g.lh) < 0.5 && Math.abs(tops[2] - tops[1] - g.lh) < 0.5,
    'bands sit on consecutive rows');
  assert.ok(m.bands[0].left > m.bands[1].left, 'first band starts mid-line');
  assert.ok(m.bands[2].width > 3, 'last band covers up to the selection end');
  // line 5 is EMPTY — its band is just the newline nub, but it must exist
  assert.ok(m.bands[1].width >= 3 && m.bands[1].width <= 12, `empty selected line shows a nub (${m.bands[1].width})`);
  assert.equal(m.after, 0, 'collapsing the selection clears every band');
});

test('the editor keeps its place across a ≋ console round-trip', opts, async () => {
  const m0 = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    ed.focus();
    const at = ed.value.indexOf('Body here.');
    ed.setSelectionRange(at, at + 4);
    ed.scrollTop = 260;
    return { at, scrollTop: ed.scrollTop };
  });
  await page.click('#v-alpha .ctab.console');
  await sleep(300);
  assert.equal(await page.evaluate(() => !!document.querySelector('#v-alpha #codeEditor')), false,
    'console tab replaces the editor');
  await page.click('#v-alpha .ctab[data-fi="0"]');
  await sleep(400);
  const m1 = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    return {
      scrollTop: ed.scrollTop, selStart: ed.selectionStart, selEnd: ed.selectionEnd,
      focused: document.activeElement === ed,
      hlScroll: ed.closest('.edWrap').querySelector('pre.codeHL').scrollTop,
    };
  });
  assert.ok(Math.abs(m1.scrollTop - m0.scrollTop) <= 1, `scroll restored (${m1.scrollTop} vs ${m0.scrollTop})`);
  assert.equal(m1.selStart, m0.at, 'caret position restored');
  assert.equal(m1.selEnd, m0.at + 4, 'selection restored');
  assert.equal(m1.focused, false, 'no focus steal — the user clicked a tab, not the text');
  assert.ok(Math.abs(m1.hlScroll - m1.scrollTop) <= 1, 'overlay follows the restored scroll');
});

test('background events never move a focused editor (the mid-typing top-bump)', opts, async () => {
  // docs/editor-scroll-reset-diagnosis.txt — two stacked bugs:
  // 1) renderWB's restore ran viewport→focus→caret; focus() scrolls a
  //    textarea to its caret (0 on a fresh node), so EVERY background
  //    re-render (session:status, pdf:status, plan:update…) zeroed the
  //    scroll of a focused editor.
  // 2) snapshot:new blind-deleted the file cache, unmounting an OPEN editor
  //    into a "// loading…" shell — a flash that dropped focus mid-typing.
  const { body: st } = await sb.fetchJson('GET', '/api/state');
  const t = st.tasks.alpha[0];
  const { wsPush } = ui;
  const m0 = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    ed.focus();
    ed.setSelectionRange(120, 120);
    ed.scrollTop = 180; // clamped by content height — capture what stuck
    return { scrollTop: ed.scrollTop };
  });
  assert.ok(m0.scrollTop > 0, 'test file is tall enough to scroll');
  // the full turn-end volley, in one burst
  await wsPush('session:status', { project: 'alpha', id: t.id, status: 'running' });
  await wsPush('file:changed', { project: 'alpha', rel: 'p.tex' });
  await wsPush('snapshot:new', {
    project: 'alpha',
    entry: { id: 'sK', task: t.id, ts: new Date().toISOString(), files: [{ rel: 'p.tex', status: 'modified', edits: 1, adds: 1, dels: 0 }] },
  });
  await wsPush('pdf:status', { project: 'alpha', entry: { state: 'built', lastBuiltAt: new Date().toISOString(), pages: 1, counts: { errors: 0, warnings: 0 } } });
  await wsPush('task:update', { project: 'alpha', task: { ...t, status: 'waiting' } });
  await sleep(900); // renders + the in-place refetch all settle
  const m1 = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    return {
      ed: !!ed,
      scrollTop: ed?.scrollTop,
      selStart: ed?.selectionStart,
      focused: ed ? document.activeElement === ed : false,
    };
  });
  assert.ok(m1.ed, 'the editor never unmounted (no loading-shell flash)');
  assert.equal(m1.scrollTop, m0.scrollTop, 'viewport held through the whole volley');
  assert.equal(m1.selStart, 120, 'caret held');
  assert.equal(m1.focused, true, 'focus held — keystrokes keep landing');
});
