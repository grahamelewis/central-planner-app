// test/ui.monaco-settings.test.mjs — Phase 3 S2.1(b)+(d): the Settings
// "Editor" row (the opt-in surface) and the both-impls harness pilot.
//
// (b) — CONTRACT "Toggle & device gate": the row writes ONLY through
// setImpl, the sanctioned writer (flipping to legacy runs the synchronous
// M7-T7 flush BEFORE the preference changes hands); a coarse-pinned device
// shows the A15 pin as a locked, inert option (I9); a session forcedLegacy
// (boot fallback) shows its state with rebootMonaco as the try-again
// affordance, the preference never persisted off (A6). The views →
// monacoPane import closes the indirect ESM eval-order cycle
// views → monacoPane → workbench → views — benign ONLY under
// function-scope access, and the COLD-PAGE smoke below is the mandated gate
// that would catch a temporal-dead-zone/circular-eval failure
// (monaco-s2 §1 S2.1(b), review concern 7).
//
// (d) — the pilot: ONE existing KEEP contract (the P1 dirty-chip + ⌘S save
// loop) run under BOTH implementations via testBothImpls — each pass a
// fresh browser context with explicit editor:impl seeding, reported as its
// own `[impl=…]` case so a mode's skip is that mode's skip. Full KEEP
// retargeting is S2.6, not here.
//
// Ground rules (monaco-s05 + blueprint §14): genuine CDP clicks/keystrokes
// for every input assertion — the __mp seam reads state and stages carets
// only; nothing gates on window 'load'; billing-safe: armPage intercepts
// the billed routes on every context, and this file touches GET routes, one
// unbilled /api/tasks POST, and the unbilled /artifact PUT only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, sleep, CHROME, testBothImpls } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FK = {
  notes: 'alpha::notes.tex', // 0 — the smoke's draft carrier
  pilot: 'alpha::pilot.tex', // 1 — the (d) pilot's save subject
};
const NOTES = '% settings smoke\nalpha line one\nalpha line two\n';
const PILOT = '% pilot fixture\none\ntwo\nthree\n';

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), NOTES);
      fs.writeFileSync(path.join(projRoots.alpha, 'pilot.tex'), PILOT);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'settings toggle', category: 'calibration',
    oversight: 'manual', context: { files: ['notes.tex', 'pilot.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Fresh COLD context: NO editor:impl seeding unless `impl` is given (the
 * smoke mandates the true cold default), pageerrors captured from the first
 * byte so a module-eval TDZ failure cannot hide. `touch` arms CDP touch
 * emulation (Chrome then reports pointer:coarse + any-pointer:coarse — the
 * A15 pin profile, the ui.monaco-boot recipe); `inject` arms vendor-proxy
 * failure rules (cleared otherwise).
 */
async function coldPage({ touch = false, impl = null, inject = null, hash = '#alpha' } = {}) {
  if (inject) sb.vendor.set(inject); else sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  if (touch) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  if (impl) await page.addInitScript((v) => localStorage.setItem('editor:impl', v), impl);
  await page.goto(`${sb.vendor.base}/${hash}`, { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

/** Genuine-click navigation: profile menu → Settings (the production path). */
async function openSettings(page) {
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show #editorSeg', { timeout: 10000 });
}

/** The Editor row's rendered state + the stored preference, in one read. */
const segState = (page) => page.evaluate(() => ({
  on: document.querySelector('#editorSeg .segOpt.on')?.dataset.ed || null,
  locked: !!document.querySelector('#editorSeg .segOpt.locked'),
  note: document.querySelector('#editorSeg')?.closest('.setRow')?.querySelector('.setLbl small')?.textContent || '',
  retry: !!document.querySelector('#edImplRetry'),
  stored: localStorage.getItem('editor:impl'),
}));

const chipCls = (page) => page.evaluate(() =>
  document.querySelector('#saveState')?.className || '');

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitMonaco = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

/* ═══ (b) — the mandated COLD-PAGE Settings smoke ═══ */

test('COLD PAGE: module eval clean; Settings flips legacy→monaco→legacy through setImpl with a draft alive (T7/T8 handoff), preference persisted', opts, async () => {
  const { context, page, errors } = await coldPage();
  try {
    // cold default: the legacy editor renders and monaco never boots
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__mp.state()), 'IDLE',
      'no boot under the legacy default');

    // a real draft, typed through the keyboard — it must survive both flips (I1)
    await page.click('#codeEditor');
    await page.keyboard.type('DRAFTMARK ');
    await page.waitForFunction(() =>
      document.querySelector('#codeEditor').value.includes('DRAFTMARK'));
    assert.ok(await page.evaluate((fk) =>
      (window.__mp.store().drafts[fk] || '').includes('DRAFTMARK'), FK.notes),
    'the legacy keystrokes materialized a draft');

    // Settings via the production click path; the row reflects the default
    await openSettings(page);
    let s = await segState(page);
    assert.equal(s.on, 'legacy', 'the row starts on Legacy (the default)');
    assert.equal(s.locked, false, 'a fine-pointer context is not pinned');
    assert.equal(s.retry, false, 'no fallback affordance without a fallback');

    // flip to Monaco — one genuine click, through setImpl (sanctioned writer)
    await page.click('#editorSeg .segOpt[data-ed="monaco"]');
    s = await segState(page);
    assert.equal(s.stored, 'monaco', 'the preference persisted');
    assert.equal(s.on, 'monaco', 'the re-rendered row shows Monaco on');
    assert.equal(await page.evaluate(() => window.__mp.state()), 'IDLE',
      'the flip alone boots nothing — boot rides the next code-tab render');

    // back to the project: monaco boots; T8 re-entry — the newer draft WINS (A4)
    await page.click('#navProjects .tab[data-v="alpha"]');
    await waitMonaco(page, FK.notes);
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.notes)).includes('DRAFTMARK'),
      'T8: the legacy draft materialized into the model');
    assert.equal(await page.evaluate((fk) => window.__mp.isDirty(fk), FK.notes), true,
      'dirty at birth from the draft (M1)');
    assert.match(await chipCls(page), /dirty/, 'the chip stays amber across the handoff');

    // more genuine keystrokes on the monaco side — the draft grows
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('M2WINS ');
    await page.waitForFunction((fk) =>
      (window.__mp.store().drafts[fk] || '').includes('M2WINS'), FK.notes, { timeout: 5000 });

    // flip back to Legacy: setImpl runs the synchronous T7 flush BEFORE the
    // preference changes hands — by the time the click returns, drafts carry
    // the full monaco text and the stored preference reads legacy
    await openSettings(page);
    await page.click('#editorSeg .segOpt[data-ed="legacy"]');
    s = await segState(page);
    assert.equal(s.stored, 'legacy', 'the preference persisted back');
    assert.equal(s.on, 'legacy', 'the row follows');
    const draft = await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.notes);
    assert.ok(draft.includes('M2WINS') && draft.includes('DRAFTMARK'),
      'T7: the flush re-asserted the whole draft before the writer switched');

    // the legacy editor renders the draft and stays live
    await page.click('#navProjects .tab[data-v="alpha"]');
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 10000 });
    const val = await page.evaluate(() => document.querySelector('#codeEditor').value);
    assert.ok(val.includes('M2WINS') && val.includes('DRAFTMARK'),
      'the draft survives both flips');
    assert.match(await chipCls(page), /dirty/, 'still honestly amber');
    await page.click('#codeEditor');
    await page.keyboard.type('Z');
    assert.notEqual(await page.evaluate(() => document.querySelector('#codeEditor').value), val,
      'the legacy editor is editable after the round-trip');

    // the ESM-cycle gate: ZERO pageerrors across the whole run — module
    // evaluation (views → monacoPane → workbench → views) was clean, no TDZ
    assert.deepEqual(errors, [], `zero pageerrors expected, got: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

test('A15 pin in the row: on a coarse-only device the Monaco option is locked and inert — no preference write, no boot, the note explains', opts, async () => {
  const { context, page, errors } = await coldPage({ touch: true, hash: '#settings' });
  try {
    await page.waitForSelector('#v-settings.show #editorSeg', { timeout: 15000 });
    let s = await segState(page);
    assert.equal(s.locked, true, 'the Monaco option carries the pin');
    assert.equal(s.on, 'legacy', 'the row reflects reality: legacy');
    assert.match(s.note, /pinned to the legacy editor/, 'the A15 note explains the pin');
    assert.equal(s.retry, false, 'a pin is not a fallback — no retry affordance');

    // a genuine click on the locked option is a total no-op (I9: automatic,
    // per-device, not a preference — nothing to write, nothing to boot)
    await page.click('#editorSeg .segOpt[data-ed="monaco"]');
    await sleep(150);
    s = await segState(page);
    assert.equal(s.stored, null, 'no preference write from the locked option');
    assert.equal(s.on, 'legacy', 'still legacy');
    assert.equal(await page.evaluate(() => window.__mp.impl()), 'legacy');
    assert.equal(await page.evaluate(() => window.__mp.state()), 'IDLE', 'no boot attempt');
    assert.equal(sb.vendor.hits().length, 0, 'nothing fetched from /vendor/monaco');
    assert.deepEqual(errors, [], `zero pageerrors expected, got: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

test('forcedLegacy in the row: a failed boot shows the session-only state + retry; ↻ re-arms via rebootMonaco and the next code render boots READY', opts, async () => {
  // the armed loader block kills the first boot → atomic FALLBACK_LEGACY
  const { context, page } = await coldPage({
    impl: 'monaco',
    inject: [{ target: 'loader', kind: 'block' }],
  });
  try {
    await page.waitForFunction(() =>
      window.__mp && window.__mp.state() === 'FALLBACK_LEGACY', null, { timeout: 25000, polling: 100 });
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 10000 });

    await openSettings(page);
    let s = await segState(page);
    assert.equal(s.on, 'legacy', 'the row reflects reality: the session runs legacy');
    assert.equal(s.stored, 'monaco', 'the preference is NEVER persisted off (A6)');
    assert.match(s.note, /could not boot/, 'the note explains the session fallback');
    assert.equal(s.retry, true, 'rebootMonaco is offered as the try-again affordance');
    assert.equal(s.locked, false, 'a fallback is not a pin');

    // heal the network, then a genuine click on ↻ — forcedLegacy clears, the
    // row re-renders on the stored preference, the next code render boots
    sb.vendor.clear();
    await page.click('#edImplRetry');
    s = await segState(page);
    assert.equal(s.on, 'monaco', 'forcedLegacy cleared — the stored preference shows again');
    assert.equal(s.retry, false, 'the affordance retires once re-armed');
    await page.click('#navProjects .tab[data-v="alpha"]');
    await waitMonaco(page, FK.notes);
    assert.equal(await page.evaluate(() => window.__mp.forcedLegacy()), false);
  } finally {
    await context.close();
  }
});

/* ═══ (d) — the both-impls pilot: ONE KEEP contract, two per-mode cases ═══
   The P1 dirty-chip loop (files.saveChipState's contract): typing turns the
   foot chip amber and hangs the tab's dirty dot; ⌘S writes the bytes to
   disk and the chip returns to clean. The SAME assertions run against the
   legacy DOM path and the monaco machines — only editor-ready waits and
   caret staging differ. Skips: with Chrome missing, node --test reports
   `[impl=legacy]` and `[impl=monaco]` each as its own skip — the per-mode
   visibility the harness rule demands. */

testBothImpls('KEEP pilot — P1 dirty chip + tab dot: genuine typing dirties, ⌘S writes disk and cleans', {
  ui: () => ui,
}, async ({ impl, page }) => {
  // open the pilot tab under this pass's implementation
  if (impl === 'monaco') {
    await waitMonaco(page, FK.notes);
    await page.click('.ctab.cd[data-fi="1"]');
    await waitMonaco(page, FK.pilot);
  } else {
    await page.waitForSelector('#codeEditor[data-rel="notes.tex"]', { timeout: 15000 });
    await page.click('.ctab.cd[data-fi="1"]');
    await page.waitForSelector('#codeEditor[data-rel="pilot.tex"]', { timeout: 10000 });
  }
  assert.match(await chipCls(page), /saveChip/, 'the chip exists');
  assert.doesNotMatch(await chipCls(page), /dirty/, 'clean at open');
  assert.equal(await page.evaluate(() => !!document.querySelector('.ctab.cd.on .dirtyDot')), false);

  // genuine keystrokes at a staged caret (__mp/selection APIs stage only)
  if (impl === 'monaco') {
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
  } else {
    await page.click('#codeEditor');
    await page.evaluate(() => document.querySelector('#codeEditor').setSelectionRange(0, 0));
  }
  const mark = `PILOT${impl.toUpperCase()} `;
  await page.keyboard.type(mark);
  await page.waitForFunction(() =>
    /dirty/.test(document.querySelector('#saveState')?.className || ''), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => !!document.querySelector('.ctab.cd.on .dirtyDot')), true,
    'the tab dot rides the same dirty signal');

  // ⌘S — the identical save contract on both implementations
  await page.keyboard.press(`${MOD}+s`);
  await page.waitForFunction(() => {
    const c = document.querySelector('#saveState')?.className || '';
    return /saveChip/.test(c) && !/dirty/.test(c);
  }, null, { timeout: 10000 });
  const disk = fs.readFileSync(path.join(sb.projRoots.alpha, 'pilot.tex'), 'utf8');
  assert.ok(disk.startsWith(mark), `the typed bytes lead the file on disk (got: ${JSON.stringify(disk.slice(0, 30))})`);
  assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk] ?? null, FK.pilot), null,
    'the draft dissolved on clean');
});
