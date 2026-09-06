// test/ui.monaco-problems.test.mjs — Phase 3 S2.3: compile problems wired
// into monacoPane (P9, monaco-s2 §1 S2.3 post-remediation). Covers, against
// the real vendored 0.56 dist:
//   - problem rows → 'texlog' squiggle markers with the severity map
//     error→Error, warning→Warning, badbox→Hint, columns riding the model's
//     real lineMaxColumn;
//   - tint parity: parallel isWholeLine .lnErr/.lnWarn decorations for
//     error/warning ONLY — badboxes deliberately untinted (blueprint §2
//     problems row; the Hint severity carries the exclusion) — painted by
//     the additive palette-var CSS pair (the .mpWash precedent);
//   - the arrival wiring: the legacy-shared strip renderer is UNTOUCHED —
//     monacoPane observes the rendered #texProblems host, so BOTH pdf:status
//     legs deliver (the renderWB leg and the patch-in-place repeat ping,
//     proven on a surviving strip node);
//   - the mandated STALE-DIAGNOSTICS case (review concern 6): compile rows
//     against a 120-line file, CDP-delete most of the dirty buffer, re-apply
//     → no throw, out-of-range rows clamp to the LAST line with columns from
//     the clamped line, save chip + undo unaffected;
//   - A20 per-model discipline: rows routed by each model's rel (two .tex
//     files — A's rows never mark B), markers riding a background model
//     across a tab switch, synchronous re-arm after a cleanReload txn
//     (rearmAfterTxn's tintsRearm leg), and disposeModel clearing the
//     model's 'texlog' markers (the disposal matrix's marker step);
//   - a legacy control: the strip + legacy texMarkLines tints behave as
//     today and NO monaco problems machinery arms (observer off, zero rows).
//
// Ground rules (monaco-s05 + blueprint §14): typing drives GENUINE CDP
// keystrokes; __mp is read-only here except focus/setPosition staging, the
// sanctioned frozen seams under test (setProblems is exercised through the
// REAL strip signal — pushed pdf:status events — not called directly except
// where a test names it), applyExternal (its case's subject) and
// disposeModel (its case's subject). Billing-safe: armPage intercepts the
// five billed routes on every context; this file touches GET routes and one
// unbilled POST /api/tasks only — synthetic pdf:status events ride the
// stubbed WS (wsPush), never a real latexmk watch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// the pinned files, by tab index (context.files order)
const FK = {
  main: 'alpha::main.tex',       // 0 — the routing/tint subject
  chapter: 'alpha::chapter1.tex', // 1 — the included-file isolation partner
  long: 'alpha::long.tex',       // 2 — the stale-diagnostics subject
};

const MAIN_TEX = [
  '% problems playground',
  'line two text',   // err@2 → endColumn 14 proves the real lineMaxColumn
  'line three text',
  'line four text',
  'line five text',
  'line six',
  '',
].join('\n');

const CHAPTER_TEX = [
  '% chapter one',
  'chapter line two',
  'chapter line three',
  '',
].join('\n');

// 120 lines — the stale-diagnostics rows point near the end
const LONG_TEX = Array.from({ length: 120 }, (_, i) => `long line ${i + 1} text`).join('\n');

/** A pdf:status entry whose counts agree with its rows — the repeat-ping
 *  branch in app.js keys `transitioned` on state/errors/dead, so two pushes
 *  with equal error counts and state exercise the patch-in-place leg. */
function pdfEntry(sb, problems, { state = 'error' } = {}) {
  const count = (k) => problems.filter((p) => p.kind === k).length;
  return {
    tex: path.join(sb.projRoots.alpha, 'main.tex'),
    pdf: path.join(sb.projRoots.alpha, 'main.pdf'),
    state,
    dead: false,
    counts: { errors: count('error'), warnings: count('warning'), badboxes: count('badbox') },
    problems,
  };
}

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'main.tex'), MAIN_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'chapter1.tex'), CHAPTER_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'long.tex'), LONG_TEX);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco problems', category: 'calibration', oversight: 'manual',
    context: { files: ['main.tex', 'chapter1.tex', 'long.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Fresh context seeded to ONE editor:impl value (the S2.1(d) isolation
 *  rule), with pageerror capture — the stale case asserts zero throws. */
async function probPage(impl = 'monaco') {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript((impl2) => { localStorage.setItem('editor:impl', impl2); }, impl);
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, { timeout: 15000, polling: 50 });
  return { context, page, errors };
}

/** Feed THIS page one synthetic server WS event (startUI's wsPush is bound
 *  to the harness page — these tests run on fresh contexts). */
const push = (page, type, payload) => page.evaluate(([t, p]) => {
  window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
}, [type, payload]);

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

const clickTab = async (page, fi, fkey) => {
  await page.click(`.ctab.cd[data-fi="${fi}"]`);
  if (fkey) await waitEditor(page, fkey);
};

const markersOf = (page, fkey) => page.evaluate((fk) => window.__mp.texMarkers(fk), fkey);
const tintsOf = (page, fkey) => page.evaluate((fk) => window.__mp.tintRanges(fk), fkey);
const waitMarkers = (page, fkey, n, timeout = 10000) => page.waitForFunction(
  ([fk, want]) => (window.__mp.texMarkers(fk) || []).length === want,
  [fkey, n], { timeout, polling: 100 },
);

/* ═══ A — rows → markers + tint parity + per-model routing + clear-on-green ═══ */

test('problem rows land as texlog markers (badbox→Hint) with .lnErr/.lnWarn tint parity; rows route per model; empty rows sweep', opts, async () => {
  const { context, page } = await probPage();
  try {
    await waitEditor(page, FK.main);
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, [
      { kind: 'error', file: 'main.tex', line: 2, message: 'Undefined control sequence' },
      { kind: 'warning', file: 'main.tex', line: 3, message: 'Overfull alert' },
      { kind: 'badbox', file: 'main.tex', line: 4, message: 'Overfull \\hbox' },
      { kind: 'error', file: 'chapter1.tex', line: 2, message: 'chapter error' },
    ]) });
    await waitMarkers(page, FK.main, 3);

    // (a) severity map + columns from the model's REAL lineMaxColumn
    const mk = await markersOf(page, FK.main);
    assert.deepEqual(mk.map((r) => [r.line, r.severity]),
      [[2, 'error'], [3, 'warning'], [4, 'hint']],
      'error→Error, warning→Warning, badbox→Hint — chapter rows filtered out (A20)');
    assert.equal(mk[0].col, 1);
    assert.equal(mk[0].endCol, 'line two text'.length + 1,
      'endColumn == the model\'s lineMaxColumn of the marked line');

    // (b) tint parity: whole-line .lnErr/.lnWarn — the badbox row EXCLUDED
    assert.deepEqual(await tintsOf(page, FK.main),
      [{ line: 2, cls: 'lnErr' }, { line: 3, cls: 'lnWarn' }],
      'tints mirror error/warning rows only (P9: badbox never tints)');

    // the additive CSS pair actually paints (palette-var rule present) —
    // whole-line decorations render as .lnErr/.lnWarn divs in the view
    const paint = await page.evaluate(() => {
      const el = document.querySelector('#v-alpha .mdock .lnErr');
      return el ? getComputedStyle(el).backgroundColor : null;
    });
    assert.ok(paint && paint !== 'rgba(0, 0, 0, 0)', `.mdock .lnErr paints a background (got ${paint})`);

    // (c) per-model routing: opening chapter1 creates its model AFTER the
    // rows arrived — the attach re-apply lands ITS row (and only its row)
    await clickTab(page, 1, FK.chapter);
    const ch = await markersOf(page, FK.chapter);
    assert.deepEqual(ch.map((r) => [r.line, r.severity, r.message]),
      [[2, 'error', 'chapter error']],
      'included-file diagnostics land on the included file\'s model, nothing else (A20)');
    assert.deepEqual((await markersOf(page, FK.main)).map((r) => r.line), [2, 3, 4],
      'main\'s markers ride its (now background) model across the tab switch');

    // (d) clear-on-green: empty rows sweep ALL models of the project
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, [], { state: 'built' }) });
    await waitMarkers(page, FK.main, 0);
    await waitMarkers(page, FK.chapter, 0);
    assert.deepEqual(await tintsOf(page, FK.main), [], 'tints swept with the markers');
    assert.deepEqual(await tintsOf(page, FK.chapter), []);
  } finally {
    await context.close();
  }
});

/* ═══ B — the strip signal: the patch-in-place leg (no renderWB) delivers ═══ */

test('a repeat problems ping that patches the strip IN PLACE refreshes markers — the observer leg, no workbench render', opts, async () => {
  const { context, page } = await probPage();
  try {
    await waitEditor(page, FK.main);
    const v1 = [{ kind: 'error', file: 'main.tex', line: 2, message: 'first' }];
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, v1) });
    await waitMarkers(page, FK.main, 1);

    // mark the live strip node — a renderWB would REPLACE it (dataset lost);
    // the repeat-ping leg only patches className/innerHTML in place
    await page.evaluate(() => { document.querySelector('#v-alpha #texProblems').dataset.probe = '1'; });
    // same state ('error'), same error count, same dead → the app.js
    // patch-in-place branch: renderTexProblems only, no renderWB
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, [
      ...v1,
      { kind: 'warning', file: 'main.tex', line: 5, message: 'second' },
    ]) });
    await waitMarkers(page, FK.main, 2);
    assert.deepEqual((await markersOf(page, FK.main)).map((r) => [r.line, r.severity]),
      [[2, 'error'], [5, 'warning']]);
    assert.equal(await page.evaluate(() => document.querySelector('#v-alpha #texProblems').dataset.probe), '1',
      'the strip node SURVIVED — the refresh came from the strip observer, not a re-render');
  } finally {
    await context.close();
  }
});

/* ═══ C — the mandated STALE-DIAGNOSTICS case (review concern 6) ═══ */

test('stale diagnostics: rows past a shrunk dirty buffer clamp to the LAST line — no throw, chip/undo unaffected', opts, async () => {
  const { context, page, errors } = await probPage();
  try {
    await waitEditor(page, FK.main);
    await clickTab(page, 2, FK.long);
    const rows = [
      { kind: 'badbox', file: 'long.tex', line: 117, message: 'stale box' },
      { kind: 'error', file: 'long.tex', line: 118, message: 'stale error' },
      { kind: 'warning', file: 'long.tex', line: 119, message: 'stale warning' },
    ];
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, rows) });
    await waitMarkers(page, FK.long, 3);
    assert.deepEqual((await markersOf(page, FK.long)).map((r) => r.line), [117, 118, 119]);

    // CDP-delete most of the 120-line buffer, then leave a 3-line dirty one
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press('Delete');
    await page.keyboard.type('tiny\nbuffer\nend');
    assert.equal(await page.evaluate((fk) => window.__mp.isDirty(fk), FK.long), true, 'the buffer is dirty');

    // the next strip patch re-applies the DISK rows against the 3-line model
    // (same state/errors/dead → the in-place leg) — this is the moment the
    // unclamped code THREW mid-repaint (model.getLineMaxColumn out of range)
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, rows) });
    await page.waitForFunction((fk) => {
      const mk = window.__mp.texMarkers(fk) || [];
      return mk.length === 3 && mk.every((r) => r.line === 3);
    }, FK.long, { timeout: 10000, polling: 100 });

    const mk = await markersOf(page, FK.long);
    assert.deepEqual(mk.map((r) => [r.line, r.endCol, r.severity]),
      [[3, 4, 'hint'], [3, 4, 'error'], [3, 4, 'warning']],
      'out-of-range rows land on the LAST line, columns from the CLAMPED line (endCol == maxColumn of "end")');
    assert.deepEqual(await tintsOf(page, FK.long),
      [{ line: 3, cls: 'lnErr' }, { line: 3, cls: 'lnWarn' }],
      'clamped tints keep parity — the badbox row stays untinted even clamped');

    // chip unaffected: still the honest dirty chip
    const chip = await page.evaluate(() => {
      const el = document.querySelector('#v-alpha #saveState');
      return { cls: el.className, txt: el.textContent };
    });
    assert.ok(/\bdirty\b/.test(chip.cls), `save chip stays dirty (${chip.cls})`);
    assert.match(chip.txt, /unsaved/, 'chip text unaffected by the marker re-apply');

    // undo unaffected: ⌘Z still walks the edit history
    const beforeUndo = await page.evaluate((fk) => window.__mp.text(fk), FK.long);
    await page.keyboard.press(`${MOD}+z`);
    const afterUndo = await page.evaluate((fk) => window.__mp.text(fk), FK.long);
    assert.notEqual(afterUndo, beforeUndo, 'the undo stack survived the clamped re-apply');

    assert.deepEqual(errors, [], 'zero page errors across the whole stale-diagnostics flow');
  } finally {
    await context.close();
  }
});

/* ═══ D — txn re-arm + tab-switch ride + the disposal matrix's marker step ═══ */

test('a cleanReload txn re-arms markers/tints synchronously against the new text; disposeModel clears texlog markers', opts, async () => {
  const { context, page } = await probPage();
  try {
    await waitEditor(page, FK.main);
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(sb, [
      { kind: 'error', file: 'main.tex', line: 2, message: 'err' },
      { kind: 'warning', file: 'main.tex', line: 5, message: 'warn' },
      { kind: 'error', file: 'chapter1.tex', line: 2, message: 'chapter err' },
    ]) });
    await waitMarkers(page, FK.main, 2);
    await clickTab(page, 1, FK.chapter);

    // frozen-seam txn on the BACKGROUND main model (A4): rearmAfterTxn's
    // tintsRearm leg re-clamps the stored rows against the 1-line reload —
    // synchronously, read in the SAME evaluate with no awaits between
    const txn = await page.evaluate((fk) => {
      const applied = window.__mp.applyExternal(fk, 'short', 'cleanReload');
      return {
        applied,
        markers: window.__mp.texMarkers(fk),
        tints: window.__mp.tintRanges(fk),
      };
    }, FK.main);
    assert.equal(txn.applied, true);
    assert.deepEqual(txn.markers.map((r) => [r.line, r.endCol, r.severity]),
      [[1, 6, 'error'], [1, 6, 'warning']],
      'both rows clamp to the reloaded 1-line text, columns from the clamped line — synchronously');
    assert.deepEqual(txn.tints, [{ line: 1, cls: 'lnErr' }, { line: 1, cls: 'lnWarn' }],
      'tints re-armed in the same txn commit (M2: re-arm what the flush destroyed)');

    // the disposal matrix's marker step: a clean, backgrounded model leaves
    // with its texlog markers — nothing survives keyed to the dead URI (A20)
    await clickTab(page, 0, FK.main);
    assert.deepEqual((await markersOf(page, FK.chapter)).map((r) => r.line), [2],
      'staging: the background chapter model still carries its marker');
    const gone = await page.evaluate((fk) => {
      const uri = 'cp:' + encodeURIComponent(fk);
      window.__mp.disposeModel(fk);
      return {
        models: window.__mp.models(),
        orphanMarkers: window.monaco.editor.getModelMarkers({ owner: 'texlog' })
          .filter((mk2) => String(mk2.resource) === uri).length,
        tintMap: window.__mp.m7State(fk).tints,
      };
    }, FK.chapter);
    assert.ok(!gone.models.includes(FK.chapter), 'the clean detached model disposed');
    assert.equal(gone.orphanMarkers, 0, "disposeModel cleared the model's 'texlog' markers");
    assert.equal(gone.tintMap, false, 'the tint-id map entry left with the model (matrix totality)');
  } finally {
    await context.close();
  }
});

/* ═══ E — legacy control: strip + legacy tints as today, machinery disarmed ═══ */
