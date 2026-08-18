// test/ui.monaco-latex.test.mjs — Phase 3 S1.4: the S0 latex brain wired into
// monacoPane — Monarch 'latex'/'bibtex' registration at boot INIT (§5 step 4,
// A5 design consequence), the cpDefineThemes theme bridge (§2 Theme row:
// define BEFORE the first createEditor, re-apply on every theme flip without
// a reload), the mzone wash as a decorations pass over texZones (§2 "mzone
// math wash", invariant I7), the per-filetype wrap policy (§2 Wrap policy /
// P15), and the A18 detectIndentation:false pin.
//
// Ground rules (monaco-s05 + blueprint §14):
//   - typing drives GENUINE CDP keystrokes; the __mp seam is read-only here
//     except setPosition/focus (positioning) and ONE applyExternal call that
//     exercises the frozen seam's txn re-arm;
//   - wash expectations are never hand-computed: the page dynamic-imports
//     /latex/texZones.js and compares against scanMathZones over the SAME
//     text (I7 single-source, the anti-drift gate);
//   - billing-safe: armPage() intercepts the five billed routes on every
//     context; this file touches GET routes and unbilled POST /api/tasks only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// the pinned files, by tab index (context.files order)
const FK = {
  math: 'alpha::math.tex',   // 0 — grammar + wash + wrap-on subject
  bib: 'alpha::refs.bib',    // 1 — bibtex routing
  plain: 'alpha::plain.py',  // 2 — wrap-off + no wash on a non-latex model
  indent: 'alpha::indent.py', // 3 — 4-space bait for the A18 pin
};

// every zone flavor the scanner knows: inline $, display $$, a carrying
// math env, and a verbatim body whose raw $ must stay literal
const MATH_TEX = [
  '% intro comment',
  'text before math',
  'inline $a+b$ here',
  'display $$\\alpha + \\beta$$ done',
  '\\begin{align}',
  '  y &= 2x \\\\',
  '  z &= 3',
  '\\end{align}',
  '\\begin{verbatim}',
  'raw $ stays literal',
  '\\end{verbatim}',
  'after text',
  '',
].join('\n');

const REFS_BIB = [
  '% bib comment',
  '@article{knuth84,',
  '  author = {Donald E. Knuth},',
  '  title = {Literate {P}rogramming},',
  '  journal = {The Computer Journal},',
  '  year = 1984,',
  '}',
  '',
].join('\n');

// 4-space indentation bait: with detectIndentation unpinned Monaco would
// resolve tabSize 4 from these lines
const INDENT_PY = [
  'def f(x):',
  '    y = x + 1',
  '    if y > 2:',
  '        return y',
  '    return 0',
  '',
].join('\n');

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'math.tex'), MATH_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'refs.bib'), REFS_BIB);
      fs.writeFileSync(path.join(projRoots.alpha, 'plain.py'), 'print("wrap policy")\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'indent.py'), INDENT_PY);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco latex', category: 'calibration', oversight: 'manual',
    context: { files: ['math.tex', 'refs.bib', 'plain.py', 'indent.py'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

async function latexPage({ colorScheme = null } = {}) {
  sb.vendor.clear();
  const ctxOpts = { viewport: { width: 1600, height: 1000 } };
  if (colorScheme) ctxOpts.colorScheme = colorScheme;
  const context = await ui.browser.newContext(ctxOpts);
  const page = await context.newPage();
  await armPage(page);
  await page.addInitScript(() => { localStorage.setItem('editor:impl', 'monaco'); });
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

const clickTab = async (page, fi, fkey) => {
  await page.click(`.ctab.cd[data-fi="${fi}"]`);
  if (fkey) await waitEditor(page, fkey);
};

/** Expected wash ranges via the SHARED scanner (I7) over the model's text. */
const scannerRanges = (page, fkey) => page.evaluate(async (fk) => {
  const mod = await import('/latex/texZones.js');
  const zones = mod.scanMathZones(window.__mp.text(fk));
  const out = [];
  zones.forEach((zs, i) => zs.forEach(([s, e]) => { if (e > s) out.push([i + 1, s + 1, e + 1]); }));
  return out;
}, fkey);

/* ═══ node-side: the I7 fossil guard ═══ */

test('I7 fossil guard: the wash is decorations from the shared scanner, never theme token-background rules', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  assert.ok(src.includes("from './latex/texZones.js'"),
    'the wash consumes the shared texZones scanner (I7 single-source: grammar states + wash from one module)');
  assert.ok(src.includes("from './latex/texLang.js'"),
    'the grammars come from the S0 brain, not an inline copy');
  assert.ok(/inlineClassName:\s*'mpWash'/.test(src),
    'the wash is an inline content-hugging decoration class');
  const b = src.indexOf('CP-THEME-RULES-BEGIN');
  const e = src.indexOf('CP-THEME-RULES-END');
  assert.ok(b >= 0 && e > b, 'the theme-rules markers exist');
  assert.ok(!/background\s*:/.test(src.slice(b, e)),
    'no token-background theme rules (I7: they silently do not render in the standalone theme service)');
});

/* ═══ A — grammar routing + tokenization + wash equality + options audit ═══ */

test('latex/bibtex routing, ≥3 token classes in the DOM, wash == scanner, wrap policy, A18 indent pin', opts, async () => {
  const { context, page } = await latexPage();
  try {
    await waitEditor(page, FK.math);

    // (a) routing: .tex → the registered Monarch 'latex'
    assert.equal(await page.evaluate((fk) => window.__mp.language(fk), FK.math), 'latex');

    // the grammar actually tokenizes: ≥3 DISTINCT mtk color classes rendered
    // (comment/keyword/delimiter.math/tag.env… under the cp theme)
    await page.waitForFunction(() => {
      const set = new Set();
      document.querySelectorAll('#v-alpha .wb > .mdock.on .monaco-editor .view-lines [class*="mtk"]')
        .forEach((el) => el.classList.forEach((c) => { if (/^mtk\d+$/.test(c)) set.add(c); }));
      return set.size >= 3;
    }, { timeout: 10000, polling: 100 });

    // (b) the wash decorations equal scanMathZones over the same text — the
    // I7 anti-drift gate, live in the editor (inline $, $$, align body; the
    // verbatim body contributes NO zone: raw $ stays literal)
    const got = await page.evaluate((fk) => window.__mp.washRanges(fk), FK.math);
    const expect = await scannerRanges(page, FK.math);
    assert.ok(expect.length >= 4, `fixture exercises several zones (got ${expect.length})`);
    assert.deepEqual(got, expect, 'wash decoration ranges == scanMathZones (I7)');
    const verbatimLines = got.filter(([ln]) => ln === 10);
    assert.equal(verbatimLines.length, 0, 'verbatim raw $ opens no wash zone');

    // (e) wrap policy: tex → on
    assert.equal(await page.evaluate(() => window.__mp.wordWrap()), 'on', 'P15: .tex wraps');

    // (a) routing: .bib → 'bibtex'
    await clickTab(page, 1, FK.bib);
    assert.equal(await page.evaluate((fk) => window.__mp.language(fk), FK.bib), 'bibtex');

    // (e) wrap policy: py → off; and a non-latex model carries no wash
    await clickTab(page, 2, FK.plain);
    assert.equal(await page.evaluate(() => window.__mp.wordWrap()), 'off', 'P15: code does not wrap');
    assert.deepEqual(await page.evaluate((fk) => window.__mp.washRanges(fk), FK.plain), [],
      'no wash decorations on a non-latex model');

    // (f) A18: 4-space-indented file does NOT flip the contractual two-space
    await clickTab(page, 3, FK.indent);
    const ind = await page.evaluate((fk) => window.__mp.indentInfo(fk), FK.indent);
    assert.equal(ind.detectIndentation, false, 'detectIndentation:false is pinned (A18)');
    assert.equal(ind.tabSize, 2, 'tabSize stays 2 against 4-space bait');
    assert.equal(ind.insertSpaces, true, 'insertSpaces stays true');
  } finally {
    await context.close();
  }
});

/* ═══ B — the wash follows edits: debounced idle typing + synchronous txn ═══ */

test('typing that opens a math zone updates the wash after the ~120ms debounce; a txn re-arms synchronously', opts, async () => {
  const { context, page } = await latexPage();
  try {
    await waitEditor(page, FK.math);
    const before = await page.evaluate((fk) => window.__mp.washRanges(fk), FK.math);
    assert.equal(before.filter(([ln]) => ln === 2).length, 0, 'line 2 starts zone-free');

    // genuine CDP keystrokes at the end of line 2 ("text before math") — the
    // $ auto-closing pair + overtype produce exactly one new inline zone
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(2, 17); });
    await page.keyboard.type(' and $q+r$');

    // after the R13 debounce the wash re-equals the scanner over the NEW text
    await page.waitForFunction(async (fk) => {
      const mod = await import('/latex/texZones.js');
      const zones = mod.scanMathZones(window.__mp.text(fk));
      const expect = [];
      zones.forEach((zs, i) => zs.forEach(([s, e]) => { if (e > s) expect.push([i + 1, s + 1, e + 1]); }));
      return JSON.stringify(window.__mp.washRanges(fk)) === JSON.stringify(expect)
        && expect.some(([ln]) => ln === 2);
    }, FK.math, { timeout: 5000, polling: 100 });

    // frozen-seam txn (applyExternal cleanReload) → rearmAfterTxn re-arms the
    // wash SYNCHRONOUSLY — no debounce wait, no render needed (M2 T4 shape)
    const txn = await page.evaluate(async (fk) => {
      const mod = await import('/latex/texZones.js');
      const text = 'plain line\n$$x+y$$\n';
      window.__mp.applyExternal(fk, text, 'cleanReload');
      const zones = mod.scanMathZones(text);
      const expect = [];
      zones.forEach((zs, i) => zs.forEach(([s, e]) => { if (e > s) expect.push([i + 1, s + 1, e + 1]); }));
      return { got: window.__mp.washRanges(fk), expect, pending: window.__mp.washPending(fk) };
    }, FK.math);
    assert.deepEqual(txn.got, txn.expect, 'txn commit re-armed the wash synchronously');
    assert.equal(txn.pending, false, 'the synchronous re-arm superseded any pending debounce');
  } finally {
    await context.close();
  }
});

/* ═══ C — theme bridge: define-before-create + flip without reload ═══ */

test('cp themes: defined before createEditor, palette from live CSS vars, re-applied on an OS scheme flip', opts, async () => {
  const { context, page } = await latexPage({ colorScheme: 'dark' });
  try {
    await waitEditor(page, FK.math);

    // boot order proof (§5 step 4): langs → themes → create, in one INIT
    assert.deepEqual(await page.evaluate(() => window.__mp.initTrace()),
      ['langs', 'themes', 'create'], 'themes are defined BEFORE the first createEditor (no stock flash)');
    const t0 = await page.evaluate(() => window.__mp.themeInfo());
    assert.equal(t0.name, 'cp-dark', 'dark scheme → cp-dark applied');
    assert.ok(t0.defines >= 1, 'at least the boot define pass ran');

    // the editor surface carries the app palette (--well-edit dark = #101425)
    const bg = () => page.evaluate(() => getComputedStyle(
      document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')).backgroundColor);
    assert.equal(await bg(), 'rgb(16, 20, 37)', 'editor.background == dark --well-edit');

    // live OS scheme flip (store.applyTheme's sysLight listener → themeHooks):
    // re-defines + re-applies WITHOUT a reload or a fresh boot
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => window.__mp.themeInfo().name === 'cp-light', { timeout: 5000, polling: 50 });
    const t1 = await page.evaluate(() => ({
      info: window.__mp.themeInfo(),
      boots: window.__mp.bootCount(),
      state: window.__mp.state(),
    }));
    assert.ok(t1.info.defines > t0.defines, 'the flip re-ran the define pass (live palette re-read)');
    assert.equal(t1.boots, 1, 'no reboot — the flip is a theme swap, not a boot');
    assert.equal(t1.state, 'READY');
    assert.equal(await bg(), 'rgb(242, 244, 250)', 'editor.background == light --well-edit');
  } finally {
    await context.close();
  }
});
