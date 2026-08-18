// test/ui.monaco-core.test.mjs — Phase 3 S1.2: the kept-connected host (A7),
// the M1 model-creation machine (P-EOL seeding, dirty-at-birth, sentinel),
// the M2 mutation-transaction/origin guard, the M2-idle drafts data plane,
// and the EDITCONTEXT PIN evidence (the I2-IME CDP case in BOTH surfaces).
// S2.1 adds section F3 — the C2-MF5 editHold case (blur + readOnly for the
// WYSIWYG hold lifetime, P17; monaco-s1 §3 item 11).
//
// Ground rules (monaco-s05 + blueprint §14):
//   - the __mp seam bypasses the input path, so typing/undo/IME here drive
//     GENUINE CDP keystrokes (page.keyboard / Input.imeSetComposition);
//   - every wait is domcontentloaded-based; nothing gates on window 'load';
//   - background renderWB storms are real WS events through the stubbed
//     socket (the exact path production renders take);
//   - billing-safe: armPage() intercepts billed routes on every context;
//     the suite touches GET routes, unbilled /api/tasks POST, and unbilled
//     /artifact PUT only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX_DIR = path.join(APP_DIR, 'test', 'fixtures', 'eol');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// the pinned files, by tab index (context.files order)
const FK = {
  notes: 'alpha::notes.tex',   // 0 — 200 LF lines (typing / storms / viewstate)
  two: 'alpha::two.tex',       // 1 — registry-identity partner
  crlf: 'alpha::crlf.tex',     // 2 — pure-CRLF fixture (byte round-trip)
  mixed: 'alpha::mixed.tex',   // 3 — mixed EOL (disclosure chip, LF majority)
  nofinal: 'alpha::nofinal.tex', // 4 — no final newline
  big: 'alpha::big.tex',       // 5 — >200k (T5: no model, read-only <pre>)
};

const NOTES = '% intro line\n'
  + Array.from({ length: 199 }, (_, i) => `line ${i + 1} content padding text`).join('\n') + '\n';
const TWO = 'two alpha\ntwo beta\n';

let ui, sb, task;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), NOTES);
      fs.writeFileSync(path.join(projRoots.alpha, 'two.tex'), TWO);
      // byte-exact EOL fixtures (P-EOL-6) — copied, never retyped
      for (const f of ['crlf.tex', 'mixed.tex', 'nofinal.tex']) {
        fs.copyFileSync(path.join(FIX_DIR, f), path.join(projRoots.alpha, f));
      }
      fs.writeFileSync(path.join(projRoots.alpha, 'big.tex'),
        '% big\n' + 'x'.repeat(210000) + '\n');
      // html artifact for the C2-MF5 editHold case (section F3): indexed by
      // the watcher's initial walk → a ⌗ viewer tab with the ✎ edit button.
      // Scriptless + inert, so its iframe changes nothing for other tests.
      fs.writeFileSync(path.join(projRoots.alpha, 'page.html'),
        '<!doctype html>\n<html><head><title>hold</title></head>'
        + '<body><h1>Hold target</h1><p>alpha page body</p></body></html>\n');
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco core', category: 'calibration',
    oversight: 'manual',
    context: { files: ['notes.tex', 'two.tex', 'crlf.tex', 'mixed.tex', 'nofinal.tex', 'big.tex'] },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  assert.ok(task && task.id, 'task record captured for render storms');
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

async function corePage({ impl = 'monaco', init = null } = {}) {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const msgs = [];
  page.on('console', (m) => msgs.push(m.text()));
  await page.addInitScript(([impl2, init2]) => {
    if (impl2) localStorage.setItem('editor:impl', impl2);
    if (init2) for (const [k, v] of Object.entries(init2)) window[k] = v;
  }, [impl, init]);
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, msgs };
}

/** One synthetic server WS event → the page's stubbed socket (renderWB path). */
const push = (page, type, payload) => page.evaluate(([t, p]) => {
  if (window.__ws && window.__ws.onmessage) {
    window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
  }
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

/** Keyboard-undo until the altId dirty bit reads clean (bounded). */
async function undoToClean(page, fkey, max = 40) {
  await page.evaluate(() => window.__mp.focus());
  for (let i = 0; i < max; i++) {
    if (!(await page.evaluate((fk) => window.__mp.isDirty(fk), fkey))) return i;
    await page.keyboard.press(`${MOD}+z`);
    await sleep(40);
  }
  throw new Error(`undoToClean: still dirty after ${max} ⌘Z`);
}

/* The #saveState chip is briefly absent mid-render (renderWB replaces the
   foot); a raw read can catch that window under Chrome load — the recurring
   12/13 flake (three sightings, same signature: null.includes at a chip
   assert). Wait for the element rather than sampling the gap. */
const chipClass = (page) => page.waitForFunction(() => {
  const el = document.querySelector('#saveState');
  return el ? el.className : false;
}, undefined, { timeout: 15000 }).then((h) => h.jsonValue());

/* ═══ node-side: the M2 fossil guard (no bare internal writes) ═══ */

test('M2 fossil guard: setValue/pushEditOperations/setEOL appear ONLY inside the guarded-wrapper block', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  const begin = src.indexOf('M2-GUARDED-WRITES-BEGIN');
  const end = src.indexOf('M2-GUARDED-WRITES-END');
  assert.ok(begin >= 0 && end > begin, 'the guarded-writes block markers exist');
  const inside = src.slice(begin, end);
  const outside = src.slice(0, begin) + src.slice(end);
  for (const raw of ['.setValue(', '.pushEditOperations(', '.setEOL(']) {
    assert.equal(outside.split(raw).length - 1, 0,
      `bare ${raw} outside the M2 guarded block is a fossil (A2: every internal write in a txn)`);
    assert.equal(inside.split(raw).length - 1, 1,
      `${raw} must appear exactly once, in its wrapper`);
  }
  // the reason sets are closed — no call site may invent members
  assert.ok(/'seedCreate', 'cleanReload', 'mergeRebase', 'recoveryReload', 'legacyHandoff', 'eolSetup'/.test(src),
    'TXN_REASONS is the enumerated closed set');
  assert.ok(/'cleanReload', 'mergeRebase', 'recoveryReload', 'legacyHandoff'/.test(src),
    'applyExternal reasons are the A4 closed set');
  // save-path serialization: bare getValue() is forbidden — every read goes
  // through serialize() (P-EOL-1); getValue appears only there
  const getValues = src.split('.getValue(').length - 1;
  assert.equal(getValues, 1, 'model.getValue appears exactly once — inside serialize() with TextDefined+preserveBOM');
  assert.ok(/getValue\(pref, \/\* preserveBOM \*\/ true\)/.test(src), 'serialize uses TextDefined + preserveBOM');
});

/* ═══ A — M1 clean open + P-EOL round-trips + T5 ═══ */

test('M1 clean open, one-signal creation, CRLF/mixed/no-final/BOM byte behavior, >200k → no model', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    const s = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      cache: window.__mp.store().fileCache[fk].text,
      dirty: window.__mp.isDirty(fk),
      savedAlt: window.__mp.savedAlt(fk),
      ds: { ...document.getElementById('codeEditor').dataset },
      tag: document.getElementById('codeEditor').tagName,
    }), FK.notes);
    assert.equal(s.text, s.cache, 'model === fileCache text on a clean open');
    assert.equal(s.dirty, false);
    assert.equal(typeof s.savedAlt, 'number', 'savedAltId captured from disk bytes');
    assert.ok((await chipClass(page)).includes('saveChip') && !(await chipClass(page)).includes('dirty'),
      'chip reads saved (§2 row-1 falsely-amber guard)');
    assert.equal(s.tag, 'DIV', 'the kept host carries the #codeEditor contact surface');
    assert.deepEqual({ fkey: s.ds.fkey, rel: s.ds.rel, ext: s.ds.ext },
      { fkey: FK.notes, rel: 'notes.tex', ext: 'tex' }, 'host datasets synced');

    // fresh creation (crlf.tex): exactly ONE chrome signal; the seeding
    // setEOL is silent — zero drafts/preview side effects
    await page.evaluate(() => window.__mp.resetSignals());
    await clickTab(page, 2, FK.crlf);
    const c = await page.evaluate((fk) => ({
      sig: window.__mp.signals(),
      draft: window.__mp.store().drafts[fk],
      eol: window.__mp.getEOL(fk),
      prof: window.__mp.eol(fk),
      text: window.__mp.text(fk),
    }), FK.crlf);
    assert.equal(c.sig.chrome, 1, 'exactly one editorChrome signal per creation (M1 T6)');
    assert.equal(c.sig.preview, 0, 'no preview ping from seeding');
    assert.equal(c.draft, undefined, 'creation mutates no drafts (M1 invariant)');
    assert.equal(c.eol, '\r\n', 'CRLF detected and seeded (A19)');
    assert.equal(c.prof.pure, true);
    const crlfBytes = fs.readFileSync(path.join(FIX_DIR, 'crlf.tex'), 'utf8');
    assert.equal(c.text, crlfBytes, 'no-op = zero diff (P-EOL-3, CRLF)');

    // type one char → the save-path bytes (drafts) are CRLF
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(2, 1); });
    await page.keyboard.type('X');
    const d = await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.crlf);
    assert.ok(d.includes('\r\nX'), `the draft (save-path serialization) carries CRLF bytes: ${JSON.stringify(d.slice(0, 40))}`);
    assert.ok((await chipClass(page)).includes('dirty'));
    await undoToClean(page, FK.crlf);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.crlf), crlfBytes,
      'undo restores the exact disk bytes');
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.crlf), undefined);

    // mixed EOL → persistent disclosure chip FROM LOAD; normalized to the
    // majority (LF, 3v2); clean at rest (P-EOL-4: open+close writes nothing)
    await clickTab(page, 3, FK.mixed);
    const m = await page.evaluate((fk) => ({
      chip: document.querySelector('#eolChip') && document.querySelector('#eolChip').textContent,
      text: window.__mp.text(fk),
      dirty: window.__mp.isDirty(fk),
      draft: window.__mp.store().drafts[fk],
      prof: window.__mp.eol(fk),
    }), FK.mixed);
    assert.equal(m.chip, 'EOL: mixed → will normalize to LF on save', 'P-EOL-5 disclosure chip from load');
    assert.equal(m.text, 'a\nb\nc\nd\ne\n', 'mixed normalized to the majority EOL at creation (measured A19)');
    assert.equal(m.dirty, false, 'dirty is altId-based — a mixed file at rest is CLEAN (P-EOL-4)');
    assert.equal(m.draft, undefined);
    assert.equal(m.prof.pure, false);

    // pure file → chip gone; no-final-newline preserved byte-exact
    await clickTab(page, 4, FK.nofinal);
    assert.equal(await page.evaluate(() => !!document.querySelector('#eolChip')), false,
      'the disclosure chip clears for pure files');
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.nofinal),
      fs.readFileSync(path.join(FIX_DIR, 'nofinal.tex'), 'utf8'),
      'final-newline state preserved (Monaco never appends/removes)');

    // BOM + machine-level byte fixtures through the seam (the fetch layer
    // strips BOMs app-wide — legacy identical — so P-EOL-1 preserveBOM is
    // pinned at the machine boundary)
    const rt = await page.evaluate(() => {
      const cases = {
        bom: '﻿\\section{BOM}\nbody line\n',
        lf: 'a\nb\n',
        crlf: 'a\r\nb\r\n',
        nofinal: 'a\nb',
        empty: '',
      };
      const out = {};
      let i = 0;
      for (const [k, v] of Object.entries(cases)) {
        const fk = `alpha::__fix${i++}.tex`;
        window.__mp.setFile(fk, v, { mtimeMs: 1000 + i, ext: 'tex' });
        out[k] = window.__mp.text(fk) === v;
      }
      return out;
    });
    for (const [k, ok] of Object.entries(rt)) assert.equal(ok, true, `byte-level no-op round-trip: ${k}`);

    // >200k → T5: no model, the legacy read-only <pre> branch renders
    await clickTab(page, 0, FK.notes); // restore a real file first
    await page.click('.ctab.cd[data-fi="5"]');
    // wait past the loading shell for the settled truncated render
    await page.waitForFunction(
      () => /read-only/.test(document.querySelector('.cfoot')?.textContent || ''),
      null, { timeout: 10000 });
    const big = await page.evaluate((fk) => ({
      slot: !!document.querySelector('#monacoSlot'),
      model: window.__mp.models().includes(fk),
      dockOn: !!document.querySelector('#v-alpha .wb > .mdock.on'),
      pre: !!document.querySelector('.codeHalf pre'),
      truncated: window.__mp.store().fileCache[fk]?.truncated === true,
    }), FK.big);
    assert.equal(big.slot, false, 'no monaco slot for a truncated file');
    assert.equal(big.model, false, 'M1 never creates a model it cannot honor (T5)');
    assert.equal(big.dockOn, false, 'the dock hides over the read-only branch');
    assert.equal(big.pre, true, 'the hlText <pre> branch renders (P5 unchanged)');
    assert.equal(big.truncated, true);
  } finally {
    await context.close();
  }
});

/* ═══ B — dirty-at-birth, listener spy, registry identity, sentinel ═══ */

test('M1: draft-backed creation is dirty at birth; ⌘Z reaches disk baseline; sentinel path refuses save then recovers', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    const orig = await page.evaluate((fk) => window.__mp.text(fk), FK.notes);

    // a real draft through the keyboard
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('DRAFT MARK ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.notes);
    assert.ok((await chipClass(page)).includes('dirty'));

    // two opens of one fkey → same model instance + same undo stack
    const mid1 = await page.evaluate((fk) => window.__mp.modelId(fk), FK.notes);
    await clickTab(page, 1, FK.two);
    await clickTab(page, 0, FK.notes);
    const backAgain = await page.evaluate((fk) => ({
      mid: window.__mp.modelId(fk),
      text: window.__mp.text(fk),
    }), FK.notes);
    assert.equal(backAgain.mid, mid1, 'registry identity: the same ITextModel on reattach');
    assert.ok(backAgain.text.includes('DRAFT MARK'), 'draft text survived the round trip');

    // listener-order spy: registered after mount → zero events for creation
    // writes, exactly ONE for the first real keystroke (M1 T6 proof)
    await page.evaluate((fk) => window.__mp.spyContent(fk), FK.notes);
    assert.equal(await page.evaluate(() => window.__mp.spyCount()), 0);
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.type('Z');
    const afterKey = await page.evaluate((fk) => ({
      spy: window.__mp.spyCount(),
      draft: window.__mp.store().drafts[fk],
    }), FK.notes);
    assert.equal(afterKey.spy, 1, 'exactly one content event per keystroke');
    assert.ok(afterKey.draft.includes('Z'), 'the drafts map tracked the keystroke synchronously');

    // undo-aware dirty bit round trip (still the live model)
    await undoToClean(page, FK.notes);
    const clean = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      draft: window.__mp.store().drafts[fk],
      base: window.__mp.store().draftBase[fk],
    }), FK.notes);
    assert.equal(clean.text, orig, '⌘Z bottoms out at the disk baseline');
    assert.equal(clean.draft, undefined, 'clean transition deleted the draft');
    assert.equal(clean.base, undefined);
    assert.ok(!(await chipClass(page)).includes('dirty'), 'chip truthfully reads saved at the baseline');
    // redo re-materializes the draft via the normal pipeline
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate((fk) => window.__mp.isDirty(fk), FK.notes)) break;
      await page.keyboard.press(`${MOD}+Shift+z`);
      await sleep(40);
    }
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.notes);
    assert.ok((await chipClass(page)).includes('dirty'), 'redo re-materialized the draft (amber)');

    // ── dirty AT BIRTH: evict the model (draft survives in the store — the
    // drafts map outlives any editor), re-open, capture the FIRST paint ──
    const draftNow = await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.notes);
    await page.evaluate((fk) => window.__mp.evictForTest(fk), FK.notes);
    assert.equal(await page.evaluate((fk) => window.__mp.models().includes(fk), FK.notes), false);
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.notes), draftNow,
      'the draft survives model death (drafts are the single source of truth)');
    const firstPaint = await page.evaluate((fk) => {
      // both renders run SYNCHRONOUSLY inside the click handlers — the chip
      // state read here is literally the first paint (M1 T3: never clean at
      // creation), and the host datasets must already be swapped (P14)
      document.querySelector('.ctab.cd[data-fi="1"]').click();
      document.querySelector('.ctab.cd[data-fi="0"]').click();
      return {
        chip: document.querySelector('#saveState').className,
        text: window.__mp.text(fk),
        draft: window.__mp.store().drafts[fk],
        savedAlt: window.__mp.savedAlt(fk),
        dirty: window.__mp.isDirty(fk),
        dsFkey: document.getElementById('codeEditor').dataset.fkey,
      };
    }, FK.notes);
    assert.ok(firstPaint.chip.includes('dirty'), 'amber at first paint — unsaved text NEVER marked clean at creation (A4 gate)');
    assert.equal(firstPaint.text, draftNow, 'the model shows the draft');
    assert.equal(firstPaint.draft, draftNow, 'drafts[k] byte-identical through creation');
    assert.equal(typeof firstPaint.savedAlt, 'number', 'savedAltId is the DISK baseline beneath the draft');
    assert.equal(firstPaint.dirty, true);
    assert.equal(firstPaint.dsFkey, FK.notes, 'datasets updated synchronously before the render returned');

    // the draft rides as exactly ONE undoable edit: a single ⌘Z reaches the
    // disk baseline and truthfully reads clean; a single redo comes back
    await waitEditor(page, FK.notes);
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+z`);
    await page.waitForFunction((fk) => !window.__mp.isDirty(fk), FK.notes);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.notes), orig);
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.notes), undefined);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.notes);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.notes), draftNow);

    // ── sentinel (T4): draft alive but NO trustworthy fileCache ──
    const stash = await page.evaluate((fk) => {
      const c = window.__mp.store().fileCache[fk];
      return { text: c.text, mtimeMs: c.mtimeMs };
    }, FK.notes);
    await page.evaluate((fk) => {
      const s = window.__mp.store();
      delete s.fileCache[fk];
      delete s.draftBase[fk];
      window.__mp.evictForTest(fk);
      window.__mp.setFile(fk, null, { mtimeMs: null, ext: 'tex' });
    }, FK.notes);
    const sent = await page.evaluate((fk) => ({
      savedAlt: window.__mp.savedAlt(fk),
      dirty: window.__mp.isDirty(fk),
      text: window.__mp.text(fk),
    }), FK.notes);
    assert.equal(sent.savedAlt, 'DIRTY_SENTINEL', 'no trustworthy baseline → DIRTY_SENTINEL, never a fake altId');
    assert.equal(sent.dirty, true, 'the sentinel can never produce a falsely-clean chip');
    assert.equal(sent.text, draftNow, 'the model seeds from the draft (T4)');
    assert.ok((await chipClass(page)).includes('dirty'));
    // ⌘S refusal: the chip click runs files.saveFile, whose finite-baseline
    // guard must refuse (the 409 net would be disarmed otherwise)
    await page.click('#saveState');
    await page.waitForFunction(
      () => document.getElementById('toast').textContent.includes('cannot save yet'),
      null, { timeout: 5000 });
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.notes), draftNow,
      'the refusal destroyed nothing');

    // ── recovery (T7): fileCache resolves → re-seed onto the REAL baseline ──
    await page.evaluate(([fk, st]) => {
      window.__mp.store().fileCache[fk] = { text: st.text, mtimeMs: st.mtimeMs };
      window.__mp.setFile(fk, st.text, { mtimeMs: st.mtimeMs, ext: 'tex' });
    }, [FK.notes, stash]);
    const rec = await page.evaluate((fk) => ({
      savedAlt: window.__mp.savedAlt(fk),
      text: window.__mp.text(fk),
    }), FK.notes);
    assert.equal(typeof rec.savedAlt, 'number', 'only real disk bytes ever replace the sentinel');
    assert.equal(rec.text, draftNow, 'the draft stayed on top through the re-seed');
    // and now the save works on the real baseline (unbilled /artifact PUT)
    await page.click('#saveState');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] == null, FK.notes, { timeout: 5000 });
    assert.ok(!(await chipClass(page)).includes('dirty'), 'chip saved after the recovered save');
    assert.equal(await page.evaluate((fk) => window.__mp.store().fileCache[fk].text, FK.notes), draftNow,
      'our write is now the disk state');
  } finally {
    await context.close();
  }
});

/* ═══ C — the kept-instance invariant + viewstate + datasets sync ═══ */

test('kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    const orig = await page.evaluate((fk) => window.__mp.text(fk), FK.notes);
    await page.evaluate(() => {
      document.querySelector('.mpHost')._stamp = 'keep';
      window.__mp.focus();
      window.__mp.setPosition(150, 3);
      window.__mp.revealLine(150);
    });
    const before0 = await page.evaluate(() => ({
      scroll: window.__mp.getScrollTop(),
      edId: window.__mp.editorId(),
    }));
    assert.ok(before0.scroll > 0, 'the caret line is deep enough to scroll');

    // interleave REAL keystrokes with background renderWB storms
    const typed = ['storm0 ', 'storm1 ', 'storm2 '];
    for (const t of typed) {
      await page.keyboard.type(t);
      await push(page, 'task:update', { project: 'alpha', task });
      await push(page, 'task:update', { project: 'alpha', task });
    }
    const after = await page.evaluate((fk) => ({
      pos: window.__mp.getPosition(),
      focus: window.__mp.hasTextFocus(),
      scroll: window.__mp.getScrollTop(),
      stamp: document.querySelector('.mpHost')._stamp,
      edId: window.__mp.editorId(),
      boots: window.__mp.bootCount(),
      line150: window.__mp.text(fk).split('\n')[149],
      docked: !!document.querySelector('#v-alpha .wb > .mdock.on .mpHost'),
    }), FK.notes);
    assert.equal(after.stamp, 'keep', 'the SAME host node survived the storm (A7)');
    assert.equal(after.edId, before0.edId, 'editor instance identity stable');
    assert.equal(after.boots, 1, 'no re-boot');
    assert.equal(after.focus, true, 'focus never moved');
    assert.deepEqual(after.pos, { line: 150, col: 3 + typed.join('').length },
      'the caret sits exactly where typing left it — storms moved nothing');
    assert.ok(Math.abs(after.scroll - before0.scroll) < 3,
      `scroll held (${before0.scroll} → ${after.scroll})`);
    assert.equal(after.line150.includes(typed.join('')), true, 'all keystrokes landed contiguously');
    assert.equal(after.docked, true);

    // the undo stack survived the storms
    await undoToClean(page, FK.notes);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.notes), orig,
      'undo history intact through the render storm');

    // viewstate round trip through 'tail' and back
    await page.evaluate(() => { window.__mp.setPosition(120, 5); window.__mp.revealLine(120); });
    const vs0 = await page.evaluate(() => ({ pos: window.__mp.getPosition(), scroll: window.__mp.getScrollTop() }));
    await page.click('.ctab.cd[data-fi="tail"]');
    await page.waitForSelector('#consoleBox', { timeout: 5000 });
    const parked = await page.evaluate(() => ({
      dockOn: !!document.querySelector('#v-alpha .wb > .mdock.on'),
      inPark: !!document.querySelector('#mpPark .mpHost'),
    }));
    assert.equal(parked.dockOn, false, 'dock hides on the console tab');
    assert.equal(parked.inPark, true, 'the host parks — never destroyed');
    await clickTab(page, 0, FK.notes);
    const vs1 = await page.evaluate(() => ({ pos: window.__mp.getPosition(), scroll: window.__mp.getScrollTop() }));
    assert.deepEqual(vs1.pos, vs0.pos, 'caret restored through the tail round trip');
    assert.ok(Math.abs(vs1.scroll - vs0.scroll) < 3, `scroll restored (${vs0.scroll} → ${vs1.scroll})`);

    // focus-mode toggle: a full CSS re-layout on the kept skeleton
    await page.click('#focusTog');
    await waitEditor(page, FK.notes);
    const focusMode = await page.evaluate(() => ({
      edId: window.__mp.editorId(),
      w: document.querySelector('#v-alpha .wb > .mdock.on').getBoundingClientRect().width,
    }));
    assert.equal(focusMode.edId, before0.edId, 'same editor instance in focus mode');
    assert.ok(focusMode.w > 100, 'the dock re-laid out to a real width');
    await page.click('#focusTog');
    await waitEditor(page, FK.notes);

    // datasets + active model swap SYNCHRONOUSLY inside the render.
    // (A clean file's tab click deliberately evicts fileCache — refetch on
    // open — which renders a loading shell first; a draft-backed file keeps
    // its cache, so THAT switch renders the editor in one synchronous pass.)
    await clickTab(page, 1, FK.two);
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('S'); // small draft pins two.tex's cache
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.two);
    await clickTab(page, 0, FK.notes);
    const sync = await page.evaluate(() => {
      document.querySelector('.ctab.cd[data-fi="1"]').click(); // renderWB runs inside
      return {
        ds: document.getElementById('codeEditor').dataset.fkey,
        active: window.__mp.activeFkey(),
      };
    });
    assert.equal(sync.ds, FK.two, 'data-fkey updated before the render returned (P14)');
    assert.equal(sync.active, FK.two, 'the model swap is synchronous in setFile');
    await undoToClean(page, FK.two); // leave the file clean for later tests
  } finally {
    await context.close();
  }
});

/* ═══ C2 — the kept-instance invariant on a NON-PURE file (baselineRaw guard) ═══
   The S1.2 churn bug: reconcileOnAttach compared serialize(m) against the raw
   fileCache text, but Monaco normalizes mixed EOLs irreversibly at createModel
   (A19) — the comparison could NEVER match for a clean mixed-EOL file, so
   every background renderWB fired a spurious cleanReload (caret teleported to
   (1,1), undo/redo destroyed). The invariant is file-type-independent: this is
   the exact CDP probe recipe that confirmed the bug, now pinned green. */

test('M7-T2 mixed-EOL steady state: renderWB storms fire ZERO txns on a clean mixed.tex — caret, undo/redo, chip intact; a genuine disk change still reloads', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    await clickTab(page, 3, FK.mixed);
    const rawBytes = fs.readFileSync(path.join(FIX_DIR, 'mixed.tex'), 'utf8');
    assert.equal(await page.evaluate((fk) => window.__mp.rawBaseline(fk), FK.mixed), rawBytes,
      'baselineRaw carries the RAW disk bytes (not the normalized model text), captured in the seedCreate txn');

    // build a live undo/redo stack: one real keystroke, then undo it (redo armed)
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(3, 2); });
    await page.keyboard.type('X');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.mixed);
    await page.keyboard.press(`${MOD}+z`);
    await page.waitForFunction((fk) => !window.__mp.isDirty(fk), FK.mixed);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.mixed), 'a\nb\nc\nd\ne\n',
      'clean at the normalized baseline before the probe');

    // park the caret, zero the counters — the probe begins
    await page.evaluate(() => { window.__mp.setPosition(3, 2); window.__mp.resetSignals(); });
    const sync0 = (await page.evaluate(() => window.__mp.signals())).txnSync;
    const edId0 = await page.evaluate(() => window.__mp.editorId());

    // the exact probe: 3 background task:update renders on the clean mixed file
    for (let i = 0; i < 3; i++) await push(page, 'task:update', { project: 'alpha', task });

    const s = await page.evaluate((fk) => ({
      sig: window.__mp.signals(),
      pos: window.__mp.getPosition(),
      text: window.__mp.text(fk),
      dirty: window.__mp.isDirty(fk),
      draft: window.__mp.store().drafts[fk],
      chip: document.querySelector('#eolChip') && document.querySelector('#eolChip').textContent,
      edId: window.__mp.editorId(),
    }), FK.mixed);
    assert.equal(s.sig.chrome, 0, 'ZERO txns across the storm (pre-guard: 3 spurious cleanReloads)');
    assert.equal(s.sig.txnSync, sync0, 'no guarded write ran at all');
    assert.deepEqual(s.pos, { line: 3, col: 2 }, 'the caret never teleported to (1,1)');
    assert.equal(s.text, 'a\nb\nc\nd\ne\n', 'model text untouched');
    assert.equal(s.dirty, false, 'still clean — the dirty bit stays altId-based (P-EOL-4)');
    assert.equal(s.draft, undefined, 'no draft manufactured (open+storms writes nothing)');
    assert.equal(s.chip, 'EOL: mixed → will normalize to LF on save', 'disclosure chip persists (P-EOL-5)');
    assert.equal(s.edId, edId0, 'same editor instance');

    // the undo/redo stack survived: redo re-lands the char (pre-guard: dead)
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+Shift+z`);
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.mixed, { timeout: 5000 });
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.mixed)).includes('cX'),
      'redo alive after the storm — the undo stack was never destroyed');
    await undoToClean(page, FK.mixed);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.mixed), 'a\nb\nc\nd\ne\n');

    // and a GENUINE disk change still reloads: raw-to-raw differs → cleanReload
    fs.writeFileSync(path.join(sb.projRoots.alpha, 'mixed.tex'), 'a\nb\r\nc\nd\nNEW\r\n');
    await push(page, 'file:changed', { project: 'alpha', rel: 'mixed.tex' });
    await page.waitForFunction(
      () => window.__mp.text('alpha::mixed.tex') === 'a\nb\nc\nd\nNEW\n', null, { timeout: 10000 });
    assert.equal(await page.evaluate((fk) => window.__mp.rawBaseline(fk), FK.mixed), 'a\nb\r\nc\nd\nNEW\r\n',
      'the fresh raw record was captured inside the reload txn');
    assert.equal(await page.evaluate((fk) => window.__mp.isDirty(fk), FK.mixed), false,
      'clean under the new baseline');
    // restore the fixture bytes on disk for any later context
    fs.copyFileSync(path.join(FIX_DIR, 'mixed.tex'), path.join(sb.projRoots.alpha, 'mixed.tex'));
  } finally {
    await context.close();
  }
});

/* ═══ D — M2: cleanReload txn, canary, exception injection, cross-fkey ═══ */

test('M2: cleanReload on the kept model — one signal, no draft, undo cleared; canary; exception → flag cleared; cross-fkey independence', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    const notesPath = path.join(sb.projRoots.alpha, 'notes.tex');
    const NEW1 = '% reloaded v2\n' + NOTES.slice('% intro line\n'.length);
    fs.writeFileSync(notesPath, NEW1);
    const sync0 = (await page.evaluate(() => window.__mp.signals())).txnSync;
    await page.evaluate(() => window.__mp.resetSignals());
    await push(page, 'file:changed', { project: 'alpha', rel: 'notes.tex' });
    await page.waitForFunction((t) => window.__mp.text('alpha::notes.tex') === t, NEW1, { timeout: 10000 });
    const r = await page.evaluate((fk) => ({
      sig: window.__mp.signals(),
      draft: window.__mp.store().drafts[fk],
      dirty: window.__mp.isDirty(fk),
    }), FK.notes);
    assert.equal(r.sig.chrome, 1, 'exactly one editorChrome call for the whole reload txn');
    assert.equal(r.sig.preview, 0, 'no preview ping with intermediate text');
    assert.ok(r.sig.txnSync > sync0, 'synchronicity canary verified the flush was synchronous');
    assert.equal(r.draft, undefined, 'a clean reload manufactures no draft');
    assert.equal(r.dirty, false, 'chip stays saved');
    // undo cleared: ⌘Z must not resurrect pre-reload text as a dirty draft
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+z`);
    await sleep(120);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.notes), NEW1,
      '⌘Z is a no-op after a clean reload (reconciliation rule)');
    // falsely-amber guard: savedAltId was captured from the fresh bytes
    await page.keyboard.type('Q');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.notes);
    await undoToClean(page, FK.notes);
    assert.ok(!(await chipClass(page)).includes('dirty'), 'one char + undo reads clean — savedAltId is fresh');

    // exception injection: a throwing txn body must clear the flag and leave
    // dirty tracking alive (M2 T6/T7 — no wedged suppression)
    const NEW2 = '% reloaded v3\n' + NOTES.slice('% intro line\n'.length);
    fs.writeFileSync(notesPath, NEW2);
    await page.evaluate(() => { window.__mpTxnThrow = true; });
    await push(page, 'file:changed', { project: 'alpha', rel: 'notes.tex' });
    await page.waitForFunction((t) => window.__mp.store().fileCache['alpha::notes.tex']?.text === t, NEW2, { timeout: 10000 });
    const injected = await page.evaluate((fk) => ({
      open: window.__mp.txnOpen(),
      text: window.__mp.text(fk),
    }), FK.notes);
    assert.deepEqual(injected.open, [], 'the origin flag cleared on the exception path (finally)');
    assert.equal(injected.text, NEW1, 'the aborted txn wrote nothing (bookkeeping pinned pre-txn)');
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.type('W');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.notes, { timeout: 5000 });
    assert.ok((await chipClass(page)).includes('dirty'), 'the next keystroke dirties normally — no dead tracking');
    await undoToClean(page, FK.notes);

    // cross-fkey independence: an applyExternal txn on a BACKGROUND model
    // leaves the active editor's pipeline, caret and focus untouched
    await clickTab(page, 1, FK.two);
    await clickTab(page, 0, FK.notes);
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(5, 1); });
    await page.keyboard.type('CROSSDRAFT ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.notes);
    const pos0 = await page.evaluate(() => window.__mp.getPosition());
    const x = await page.evaluate(([fkTwo, fkNotes]) => {
      window.__mp.applyExternal(fkTwo, 'external new text\n', 'cleanReload');
      return {
        two: window.__mp.text(fkTwo),
        notesDraft: window.__mp.store().drafts[fkNotes],
        pos: window.__mp.getPosition(),
        focus: window.__mp.hasTextFocus(),
        active: window.__mp.activeFkey(),
      };
    }, [FK.two, FK.notes]);
    assert.equal(x.two, 'external new text\n', 'the background model updated directly (A4 — no renderWB needed)');
    assert.ok(x.notesDraft.includes('CROSSDRAFT'), 'the active fkey draft untouched');
    assert.deepEqual(x.pos, pos0, 'background txn never moves the visible caret');
    assert.equal(x.focus, true);
    assert.equal(x.active, FK.notes);
    assert.ok((await chipClass(page)).includes('dirty'), 'active chip still amber');

    // the reason set is closed — unknown asserts
    const thrown = await page.evaluate((fk) => {
      try { window.__mp.applyExternal(fk, 'x', 'sneakyReason'); return 'no-throw'; }
      catch (e) { return String(e.message); }
    }, FK.two);
    assert.ok(thrown.includes("unknown applyExternal reason 'sneakyReason'"),
      'a fifth reason is a programming error');
  } finally {
    await context.close();
  }
});

/* ═══ E — the I2-IME CDP case: BOTH surfaces + the pin re-assert ═══ */

/**
 * The exact A7 spike recipe: imeSetComposition ×2 → background renderWB
 * storm → imeSetComposition → insertText. The composition must survive the
 * storm (no compositionEnd, focus kept) and the commit must land exactly the
 * composed text — in the kept-connected host this holds on BOTH surfaces.
 */
async function imeCase(init, expectSurface) {
  const { context, page } = await corePage({ init });
  try {
    await waitEditor(page, FK.notes);
    if (expectSurface !== undefined) {
      assert.equal(await page.evaluate(() => window.__mp.editContext()), expectSurface,
        `create-option surface is ${expectSurface ? 'EditContext' : 'textarea'}`);
    }
    const cdp = await context.newCDPSession(page);
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(2, 1); });
    const ends0 = await page.evaluate(() => window.__mp.compositionEnds());
    await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'かん', selectionStart: 2, selectionEnd: 2 });
    assert.equal(await page.evaluate(() => window.__mp.inComposition()), true,
      'editor.onDidCompositionStart armed the belt (DOM composition events are NOT trusted — s05)');
    // the background render storm, mid-composition
    for (let i = 0; i < 3; i++) await push(page, 'task:update', { project: 'alpha', task });
    const mid = await page.evaluate(() => ({
      comp: window.__mp.inComposition(),
      ends: window.__mp.compositionEnds(),
      focus: window.__mp.hasTextFocus(),
    }));
    assert.equal(mid.comp, true, 'composition alive across the renders');
    assert.equal(mid.ends, ends0, 'ZERO compositionEnd across the render (the transplant killer — A7)');
    assert.equal(mid.focus, true, 'hasTextFocus true across the render');
    await cdp.send('Input.imeSetComposition', { text: 'かんじ', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '漢字' });
    await page.waitForFunction((fk) => window.__mp.text(fk).includes('漢字'), FK.notes, { timeout: 5000 });
    const fin = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      focus: window.__mp.hasTextFocus(),
      draft: window.__mp.store().drafts[fk],
    }), FK.notes);
    assert.ok(fin.text.includes('漢字'), 'the commit landed');
    assert.ok(!fin.text.includes('か'), `no stranded preedit (buffer head: ${JSON.stringify(fin.text.slice(0, 40))})`);
    assert.equal(fin.focus, true);
    assert.ok(fin.draft && fin.draft.includes('漢字'), 'the drafts plane carried the committed text');
  } finally {
    await context.close();
  }
}

test('I2-IME under editContext:true (EditContext surface)', opts, async () => {
  await imeCase({ __mpEditContext: true }, true);
});

test('I2-IME under editContext:false (textarea surface)', opts, async () => {
  await imeCase({ __mpEditContext: false }, false);
});

test('EDITCONTEXT PIN: the default surface is editContext:false and the IME case holds on it', opts, async () => {
  // no override: this is the shipped create-option default — the PIN.
  // Rationale recorded in monacoPane.js's header: both surfaces pass the CDP
  // case; false is pinned because every tag-based guard in the app (voice
  // Space-PTT, wireGlobal Tab) stays meaningful on a real textarea surface.
  // The I3 triple guard is now COMPLETE beyond this pin (leg a): the explicit
  // closest('.monaco-editor') bails live in voice.js (Space-PTT) and app.js
  // wireGlobal (Tab) — leg (b) — and the real-CDP-keystroke cases are
  // ui.voice.test.mjs 'Space while Monaco focused never mics' and section G
  // below (Tab) — leg (c).
  await imeCase(null, false);
});

/* ═══ F — toggle handoff both ways + legacy byte-identical ═══ */

test('toggle off → legacy DOM intact, zero vendor fetches, boot never starts', opts, async () => {
  const { context, page } = await corePage({ impl: null });
  try {
    await page.waitForSelector('textarea#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await sleep(1200); // the idle-warm window must be a no-op
    const s = await page.evaluate(() => ({
      state: window.__mp.state(),
      slot: document.querySelectorAll('#monacoSlot').length,
      monaco: document.querySelectorAll('.monaco-editor').length,
      hosts: document.querySelectorAll('.mpHost').length,
      edWrap: !!document.querySelector('.edWrap .edGutter #edGutterInner')
        && !!document.querySelector('.edWrap #codeHL')
        && !!document.querySelector('.edWrap textarea#codeEditor'),
    }));
    assert.equal(s.state, 'IDLE');
    assert.equal(s.slot, 0);
    assert.equal(s.monaco, 0);
    assert.equal(s.hosts, 0, 'no kept host exists in legacy mode');
    assert.equal(s.edWrap, true, 'legacy editor structure byte-for-byte intact');
    assert.equal(sb.vendor.hits().length, 0, 'legacy mode fetches nothing from /vendor/monaco');
  } finally {
    await context.close();
  }
});

test('toggle handoff with a draft alive: monaco → legacy shows it, legacy typing wins on re-entry, ⌘Z reaches the disk baseline', opts, async () => {
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes); // fresh context → first open tab
    await clickTab(page, 1, FK.two);  // two.tex — isolated from D's disk rewrites
    const orig = await page.evaluate((fk) => window.__mp.text(fk), FK.two);
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('MONACO DRAFT ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('MONACO DRAFT'), FK.two);

    // → legacy: the textarea renders the SAME draft (the continuously-synced
    // drafts map IS the synchronous flush — single source of truth, I1/A4)
    await page.evaluate(() => localStorage.setItem('editor:impl', 'legacy'));
    await page.click('.ctab.cd[data-fi="1"]');
    await page.waitForSelector('textarea#codeEditor[data-ext="tex"]', { timeout: 10000 });
    const leg = await page.evaluate(() => ({
      val: document.querySelector('textarea#codeEditor').value,
      parked: !!document.querySelector('#mpPark .mpHost'),
      monacoVisible: !!document.querySelector('#v-alpha .wb > .mdock.on'),
    }));
    assert.ok(leg.val.includes('MONACO DRAFT'), 'legacy shows the monaco draft verbatim');
    assert.equal(leg.parked, true, 'the kept host parked, not destroyed');
    assert.equal(leg.monacoVisible, false);
    // type MORE in legacy — this draft revision is now the newest truth
    await page.click('textarea#codeEditor');
    await page.evaluate(() => {
      const ta = document.querySelector('textarea#codeEditor');
      ta.setSelectionRange(0, 0);
    });
    await page.keyboard.type('LEGACY MORE ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('LEGACY MORE'), FK.two);

    // → monaco: the NEWER draft wins (A4 — a retained stale model can never
    // hide the legacy draft), dirty at re-entry, ⌘Z reaches the DISK baseline
    await page.evaluate(() => localStorage.setItem('editor:impl', 'monaco'));
    await page.click('.ctab.cd[data-fi="1"]');
    await waitEditor(page, FK.two);
    const re = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      dirty: window.__mp.isDirty(fk),
    }), FK.two);
    assert.ok(re.text.includes('LEGACY MORE') && re.text.includes('MONACO DRAFT'),
      'monaco re-entry shows the newer (legacy-typed) draft');
    assert.equal(re.dirty, true, 'amber on re-entry');
    await undoToClean(page, FK.two);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.two), orig,
      '⌘Z bottoms out at the disk baseline — never an intermediate buffer');
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.two), undefined,
      'clean again — draft dissolved by the undo');
  } finally {
    await context.close();
  }
});

/* ═══ F3 — C2-MF5 editHold: blur + readOnly for the hold lifetime (P17) ═══
   The WYSIWYG hold (files.startHtmlEdit → renderWB's .editHold class) greys
   the workbench with pointer-events CSS — but the kept Monaco dock is a
   position:fixed SIBLING of the greyed panes, so CSS never silences the
   keyboard (blueprint §2 "Layout & editHold" row: "pointer-events CSS never
   silenced keyboards; a focused kept Monaco would corrupt a live WYSIWYG
   hold"). The holdEditor seam must blur + pin readOnly at raise and unpin at
   release, handing focus back ONLY when the editor had it at raise. Both
   legs drive the REAL hold path (✎ edit / ✓ done on the seeded page.html
   artifact) with GENUINE CDP keystrokes; __mp is staging/reads only. */

test('C2-MF5 editHold: raise blurs + pins readOnly (typing lands nothing, even force-focused); release unpins + hands focus back only if held at raise', opts, async () => {
  const { context, page } = await corePage();
  try {
    // seam tolerance first: calls in whatever boot state the page is in right
    // now (usually pre-READY — no editor exists) must not throw, and the flag
    // must still record so applyFile can honor it once an editor materializes
    const early = await page.evaluate(() => {
      window.__mp.holdEditor(true);
      const held = window.__mp.editHold().held;
      window.__mp.holdEditor(false);
      window.__mp.holdEditor(false); // repeat release — transition-only no-op
      return { held, after: window.__mp.editHold().held };
    });
    assert.equal(early.held, true, 'holdEditor(true) records with or without an editor');
    assert.equal(early.after, false, 'release (and a repeat) settles the flag');

    await waitEditor(page, FK.notes);
    await page.waitForSelector('#v-alpha #htmlEditBtn', { timeout: 10000 });
    const text0 = await page.evaluate((fk) => window.__mp.text(fk), FK.notes);

    // focus the editor the way a user would (real click), then raise the hold
    // via a SYNTHETIC el.click() on ✎ edit — a real click's mousedown would
    // blur the editor before startHtmlEdit even runs, and this leg exists to
    // prove the exact C2-MF5 scenario: a FOCUSED kept Monaco when the hold
    // lands. (Cycle 2 below covers the real-click/unfocused raise.)
    await page.click('#v-alpha .wb > .mdock.on .monaco-editor .view-lines');
    await page.waitForFunction(() => window.__mp.hasTextFocus(), null, { timeout: 5000 });
    await page.evaluate(() => document.querySelector('#v-alpha #htmlEditBtn').click());
    await page.waitForSelector('#v-alpha .wb.editHold #htmlEditFrame', { timeout: 10000 });
    const held = await page.evaluate(() => ({
      hold: window.__mp.editHold(),
      focus: window.__mp.hasTextFocus(),
    }));
    assert.equal(held.hold.held, true, 'the seam raised with the .editHold class');
    assert.equal(held.hold.readOnly, true, 'updateOptions({readOnly:true}) pinned for the hold lifetime');
    assert.equal(held.hold.hadFocus, true, 'raise captured that the editor had text focus');
    assert.equal(held.focus, false, 'raise BLURRED the editor — CSS pointer-events never silences keyboards');

    // genuine keystrokes at the held (blurred) editor: nothing may land
    await page.keyboard.type('HELDX');
    // adversarial: force focus back mid-hold (a stray focus() — e.g. a
    // misfiring hand-back) — readOnly is the load-bearing half of the pin
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.type('HELDY');
    const mid = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      draft: window.__mp.store().drafts[fk],
      dirty: window.__mp.isDirty(fk),
    }), FK.notes);
    assert.equal(mid.text, text0, 'the buffer is byte-identical through held typing');
    assert.equal(mid.draft, undefined, 'no draft manufactured under the hold');
    assert.equal(mid.dirty, false);

    // background renderWB storms mid-hold: the early-return freezes the
    // project — the class, the frame and the pin all survive
    for (let i = 0; i < 3; i++) await push(page, 'task:update', { project: 'alpha', task });
    const storm = await page.evaluate(() => ({
      cls: !!document.querySelector('#v-alpha .wb.editHold'),
      frame: !!document.querySelector('#v-alpha #htmlEditFrame'),
      readOnly: window.__mp.editHold().readOnly,
    }));
    assert.deepEqual(storm, { cls: true, frame: true, readOnly: true },
      'storms mid-hold change nothing (renderWB bails while the frame is mounted)');

    // ── release: the REAL path — ✓ done (endHtmlEdit; clean buffer → no
    // confirm, which Playwright would auto-dismiss into a stuck hold) ──
    await page.click('#v-alpha #htmlDoneBtn');
    await page.waitForFunction(() => !document.querySelector('#v-alpha .wb.editHold'), null, { timeout: 10000 });
    const rel = await page.evaluate(() => ({
      hold: window.__mp.editHold(),
      focus: window.__mp.hasTextFocus(),
    }));
    assert.equal(rel.hold.held, false, 'the seam released with the class');
    assert.equal(rel.hold.readOnly, false, 'release unpinned readOnly');
    assert.equal(rel.focus, true,
      'focus handed back — the editor had it at raise (the documented hand-back choice)');

    // typing lands again — genuine keystrokes through the normal M2 pipeline
    await page.evaluate(() => window.__mp.setPosition(1, 1));
    await page.keyboard.type('LANDED');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('LANDED'), FK.notes, { timeout: 5000 });
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.notes)).includes('LANDED'),
      'the released editor edits normally');
    await undoToClean(page, FK.notes);

    // ── cycle 2: editor NOT focused at raise → release must steal nothing ──
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.waitForFunction(() => !window.__mp.hasTextFocus(), null, { timeout: 5000 });
    await page.click('#v-alpha #htmlEditBtn'); // the real-click raise this time
    await page.waitForSelector('#v-alpha .wb.editHold #htmlEditFrame', { timeout: 10000 });
    const h2 = await page.evaluate(() => window.__mp.editHold());
    assert.equal(h2.held, true);
    assert.equal(h2.readOnly, true, 'the pin holds regardless of focus at raise');
    assert.equal(h2.hadFocus, false, 'raise recorded no text focus');
    await page.click('#v-alpha #htmlDoneBtn');
    await page.waitForFunction(() => !document.querySelector('#v-alpha .wb.editHold'), null, { timeout: 10000 });
    const f2 = await page.evaluate(() => ({
      hold: window.__mp.editHold(),
      focus: window.__mp.hasTextFocus(),
    }));
    assert.equal(f2.hold.readOnly, false, 'unpinned again');
    assert.equal(f2.focus, false,
      'NO focus steal — the editor was not focused at raise (the documented choice, other half)');
  } finally {
    await context.close();
  }
});

/* ═══ G — I3 leg (c) for Tab: the wireGlobal closest-bail (P19) ═══
   Blueprint §2 "EditContext posture" + P19: under Monaco the event TARGET is
   an inner element of the editor DOM (the hidden .inputarea textarea under
   the pin), never the #codeEditor host — wireGlobal's id check passes dead
   air, so the exclusion is re-anchored to closest('.monaco-editor'). Genuine
   CDP keystrokes throughout (the __mp seam bypasses the input path). */

test('P19 Tab: inside Monaco Tab indents and keeps focus — the prose \\symbol handler never fires; \\beta⇥ in the composer still completes', opts, async () => {
  // the queued task renders a launch card, not the composer — flip it to
  // waiting with a synthetic session record (unbilled PATCH; the ui.voice
  // idiom) so the positive control has a real prose input. Runs LAST in the
  // file: the earlier tests captured `task` pre-PATCH and have finished.
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: task.created, lastTurnAt: task.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const { context, page } = await corePage();
  try {
    await waitEditor(page, FK.notes);
    // disk line 1 is whatever earlier tests left there — capture, don't pin
    const line0 = await page.evaluate((fk) => window.__mp.text(fk).split('\n')[0], FK.notes);
    // focus via a REAL click, then park the caret at (1,1)
    await page.click('#v-alpha .wb > .mdock.on .monaco-editor .view-lines');
    await page.waitForFunction(() => window.__mp.hasTextFocus(), null, { timeout: 5000 });
    await page.evaluate(() => window.__mp.setPosition(1, 1));
    await page.keyboard.type('\\beta');
    await page.keyboard.press('Tab');
    const s = await page.evaluate((fk) => ({
      line1: window.__mp.text(fk).split('\n')[0],
      focus: window.__mp.hasTextFocus(),
    }), FK.notes);
    // Monaco owned the Tab: indent whitespace landed at the caret (tabSize:2,
    // insertSpaces:true, detectIndentation:false — A18) and \beta was NOT
    // rewritten to β (.tex Tab is pure — P19; the S2 per-language addCommand
    // work touches .jl only, so this assertion is S2-stable)
    assert.match(s.line1, /^\\beta[\t ]+/,
      `Tab indented inside the editor: ${JSON.stringify(s.line1)}`);
    assert.ok(s.line1.endsWith(line0), 'the original line rides behind the insertion');
    assert.ok(!s.line1.includes('β'), '\\beta untouched — texComplete never hijacked the Tab');
    assert.equal(s.focus, true, 'Tab never threw focus across the page');

    // positive control — outside the editor the delegated handler is
    // UNCHANGED: \beta + Tab in the composer completes to β, the Tab is
    // eaten, and focus stays put (the wireGlobal contract as it stands today)
    await page.click('#v-alpha #composerInput');
    await page.keyboard.type('\\beta');
    await page.keyboard.press('Tab');
    const c = await page.evaluate(() => ({
      val: document.querySelector('#v-alpha #composerInput').value,
      focused: document.activeElement === document.querySelector('#v-alpha #composerInput'),
    }));
    assert.equal(c.val, 'β', 'prose \\symbol completion still converts outside the editor');
    assert.equal(c.focused, true, 'the eaten Tab kept focus in the composer');
  } finally {
    await context.close();
  }
});
