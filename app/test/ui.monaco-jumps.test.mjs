// test/ui.monaco-jumps.test.mjs — Phase 3 S2.5: SyncTeX both ways + the P8
// revealAt seam + the § outline under the monaco impl (monaco-s2 §1 S2.5;
// CONTRACT P7/P8/P12 + invariant I5). Covers, against the real vendored 0.56
// dist:
//   - P7 forward: ⌘J (a monacoPane addCommand) and the ◎ #texSyncBtn both
//     read the caret through the getPosition seam (1-based) and ride the
//     SAME texForwardSearch flow as legacy — asserted on a stubbed
//     GET /api/synctex/view (unbilled; never latexmk);
//   - P8 inverse/jumps: a problems-strip row click funnels through the
//     UNTOUCHED texOpenAt into renderWB's monaco jump consumer → revealAt:
//     clamp → setPosition → the EXPLICIT 35% reveal (asserted GEOMETRICALLY
//     against the setScrollTop formula, ±1 line — never
//     revealPositionNearTop) → focus → restartable 1.9s lnFlash whole-line
//     decoration (fresh decoration per re-jump, released on the timer);
//   - I5 verbatim: a pending jump beats the banked viewState of a reopened
//     file by ordering; the 15s TTL drops a jump whose file never arrived in
//     time; the reopen-×-closed-pins leg rides texOpenAt unchanged;
//   - P12: the § dropdown (shared texOutlineMenu over a {value} shim) jumps
//     through revealAt with the flash; ⇧⌘O quick outline is fed by the
//     DocumentSymbolProvider (same texOutline rows) and jumps natively;
//   - a legacy control: the strip click still jumps the TEXTAREA caret and
//     NO monaco machinery arms (boot IDLE, zero vendor fetches, zero command
//     fires).
//
// Ground rules (monaco-s05 + blueprint §14): keystrokes are GENUINE CDP
// (⌘J, ⇧⌘O) — __mp is staging (focus/setPosition) + read-only probes
// (viewGeom/flashInfo/commandInfo). Billing-safe: armPage intercepts the
// billed routes on every context; this file touches GET routes and one
// unbilled POST /api/tasks — pdf:status arrives via the stubbed WS (wsPush),
// and /api/synctex/view is page-route-stubbed (it is unbilled anyway).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FK = {
  paper: 'alpha::paper.tex', // 0 — the jump subject (sections at 2/60/120)
  ch: 'alpha::ch.tex',       // 1 — the held-fetch TTL + viewState partner
};

// 160 short lines (no soft-wrap ambiguity), sections at 2 / 60 / 120
const PAPER_TEX = Array.from({ length: 160 }, (_, i) => {
  const n = i + 1;
  if (n === 1) return '% jumps playground';
  if (n === 2) return '\\section{Intro}';
  if (n === 60) return '\\section{Model}';
  if (n === 120) return '\\section{Results}';
  return `paper line ${n} text`;
}).join('\n') + '\n';

const CH_TEX = Array.from({ length: 160 }, (_, i) => `chapter line ${i + 1} text`).join('\n') + '\n';

const ROWS = [
  { kind: 'error', file: 'paper.tex', line: 5, message: 'missing $ inserted' },
  { kind: 'warning', file: 'paper.tex', line: 40, message: 'overfull hbox' },
  { kind: 'error', file: 'paper.tex', line: 60, message: 'model err' },
  { kind: 'error', file: 'paper.tex', line: 120, message: 'undefined control sequence' },
  { kind: 'error', file: 'ch.tex', line: 100, message: 'chapter boom' },
];

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), PAPER_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'ch.tex'), CH_TEX);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco jumps', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex', 'ch.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Fresh context seeded to ONE editor:impl value (the S2.1(d) isolation rule). */
async function jumpPage(impl = 'monaco') {
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

/** Feed THIS page one synthetic server WS event (fresh contexts, not ui.wsPush). */
const push = (page, type, payload) => page.evaluate(([t, p]) => {
  window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
}, [type, payload]);

/** A pdf:status entry carrying the compile rows (the ui.monaco-problems shape). */
function pdfEntry(problems, { state = 'error' } = {}) {
  const count = (k) => problems.filter((p) => p.kind === k).length;
  return {
    tex: path.join(sb.projRoots.alpha, 'paper.tex'),
    pdf: path.join(sb.projRoots.alpha, 'paper.pdf'),
    state,
    dead: false,
    counts: { errors: count('error'), warnings: count('warning'), badboxes: count('badbox') },
    problems,
  };
}

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

/** Push the rows and expand the strip list (per-project probOpen persists). */
async function armStrip(page, rows = ROWS) {
  await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(rows) });
  await page.waitForSelector('#v-alpha #tpBar', { timeout: 10000 });
  if (!(await page.$('#v-alpha .tpRow'))) {
    await page.click('#v-alpha #tpBar');
    await page.waitForSelector('#v-alpha .tpRow', { timeout: 5000 });
  }
}

const rowSel = (file, line) => `#v-alpha .tpRow[data-pf="${file}"][data-pl="${line}"]`;

const waitLine = (page, line, timeout = 10000) => page.waitForFunction(
  (n) => (window.__mp.getPosition() || {}).line === n, line, { timeout, polling: 60 },
);

/** The A20 geometric assert: line's top sits at 35% of the layout height. */
async function assertReveal35(page, line, label) {
  const g = await page.evaluate((n) => window.__mp.viewGeom(n), line);
  assert.ok(g, `${label}: viewGeom readable`);
  const want = Math.max(0, g.top - 0.35 * g.height);
  assert.ok(Math.abs(g.scrollTop - want) <= g.lineHeight + 0.5,
    `${label}: scrollTop ${g.scrollTop} within ±1 line of the formula's ${want.toFixed(1)} `
    + `(top ${g.top}, height ${g.height}, lh ${g.lineHeight}) — the EXPLICIT 35% reveal, P8`);
}

/* ═══ A — P7 forward: ⌘J + the ◎ button read the caret through getPosition ═══ */

test('forward SyncTeX: ⌘J and ◎ send the monaco caret line/col to /api/synctex/view (stubbed route)', opts, async () => {
  const { context, page, errors } = await jumpPage();
  try {
    const calls = [];
    await page.route(/\/api\/synctex\/view\//, (r) => {
      const u = new URL(r.request().url());
      calls.push({
        path: u.pathname,
        tex: u.searchParams.get('tex'),
        line: u.searchParams.get('line'),
        col: u.searchParams.get('col'),
      });
      r.fulfill({ json: {} }); // page:null → texForwardSearch returns pre-pane
    });
    await waitEditor(page, FK.paper);
    await push(page, 'pdf:status', { project: 'alpha', entry: pdfEntry(ROWS) }); // state.pdf armed
    // ⌘J from a staged caret — the keystroke itself is genuine CDP
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(5, 7); });
    await page.keyboard.press(`${MOD}+j`);
    await sleep(300);
    assert.equal(calls.length, 1, 'exactly one synctex view GET for ⌘J');
    assert.deepEqual(calls[0], { path: '/api/synctex/view/alpha', tex: 'paper.tex', line: '5', col: '7' },
      'the 1-based caret rode the SAME texForwardSearch flow as legacy (P7)');
    // the ◎ button leg — same seam, same flow
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(9, 3); });
    await page.click('#v-alpha #texSyncBtn');
    await sleep(300);
    assert.equal(calls.length, 2, 'the ◎ click sent its own GET');
    assert.deepEqual(calls[1], { path: '/api/synctex/view/alpha', tex: 'paper.tex', line: '9', col: '3' });
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ B — P8: strip click → revealAt geometry + restartable lnFlash ═══ */

test('a problems-strip row click jumps the monaco editor: caret, 35% reveal geometry, restartable lnFlash, timer release', opts, async () => {
  const { context, page, errors } = await jumpPage();
  try {
    await waitEditor(page, FK.paper);
    await armStrip(page);
    await page.click(rowSel('paper.tex', 120));
    await waitLine(page, 120);
    await assertReveal35(page, 120, 'strip click');
    assert.equal(await page.evaluate(() => window.__mp.hasTextFocus()), true, 'revealAt hands focus to the editor');
    const f1 = await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper);
    assert.deepEqual(f1.lines, [120], 'whole-line lnFlash decoration on the jump target');
    assert.equal(f1.pending, true, 'the 1.9s release timer is armed');
    // the additive .mdock .lnFlash rule really animates (paint proof)
    const anim = await page.evaluate(() => {
      const el = document.querySelector('#v-alpha .mdock .lnFlash');
      return el ? getComputedStyle(el).animationName : null;
    });
    assert.equal(anim, 'lnFlash', 'the decoration node runs the shared lnFlash keyframes');

    // restartable: a second jump re-arms a FRESH decoration (animation restarts)
    await page.click(rowSel('paper.tex', 40));
    await waitLine(page, 40);
    const f2 = await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper);
    assert.deepEqual(f2.lines, [40], 'the flash moved with the second jump');
    assert.notDeepEqual(f2.ids, f1.ids, 'a NEW decoration id — the animation restarted, not reused');
    await page.click(rowSel('paper.tex', 120));
    await waitLine(page, 120);
    const f3 = await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper);
    assert.deepEqual(f3.lines, [120], 're-jump to the same line re-flashes');
    assert.notDeepEqual(f3.ids, f1.ids, 'fresh id again (restartable on the SAME line)');
    assert.equal(f3.pending, true);

    // release: the timer clears the decoration — nothing left behind
    await sleep(2200);
    const f4 = await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper);
    assert.deepEqual({ lines: f4.lines, pending: f4.pending }, { lines: [], pending: false },
      'the 1.9s timer released the flash decoration');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ C — I5: the pending jump beats a banked viewState by ordering ═══ */

test('I5 precedence: a pending jump beats the reopened file\'s remembered viewport', opts, async () => {
  const { context, page } = await jumpPage();
  try {
    await waitEditor(page, FK.paper);
    await armStrip(page);
    // park paper deep in the file, then switch away — the viewState banks
    await page.evaluate(() => {
      window.__mp.focus();
      window.__mp.setPosition(150, 1);
      window.__mp.setScrollTop(2200);
    });
    await page.click('#v-alpha .ctab.cd[data-fi="1"]');
    await waitEditor(page, FK.ch);
    // jump BACK into paper via the strip: setFile's attach restores the
    // banked viewState first, then the consumer's revealAt overrides (I5)
    await page.click(rowSel('paper.tex', 5));
    await waitEditor(page, FK.paper);
    await waitLine(page, 5);
    await assertReveal35(page, 5, 'jump-over-memory');
    const g = await page.evaluate((n) => window.__mp.viewGeom(n), 5);
    assert.ok(g.scrollTop < 2200 - 3 * g.lineHeight,
      `the banked scrollTop (2200) lost to the jump (got ${g.scrollTop})`);
  } finally {
    await context.close();
  }
});

/* ═══ D — I5: the 15s TTL drops a jump whose file never arrived in time ═══ */

test('TTL: a jump pending behind a slow fetch expires at 15s — no late reveal; a fresh jump still lands', opts, async () => {
  const { context, page, errors } = await jumpPage();
  try {
    // hold ch.tex's artifact GET open — the jump must stay pending (no model)
    let releaseCh = null;
    const gate = new Promise((res) => { releaseCh = res; });
    await page.route(/\/artifact\/alpha\/ch\.tex$/, async (r) => {
      await gate;
      await r.continue(); // real (unbilled) artifact GET once released
    });
    await waitEditor(page, FK.paper);
    await armStrip(page);
    await page.click(rowSel('ch.tex', 100)); // texOpenAt: tab switch + pending jump
    await sleep(600); // the fetch is held: no model, revealAt refused, jump pending
    assert.equal(await page.evaluate(() => window.__mp.activeFkey()), FK.paper,
      'the kept editor still shows paper while ch.tex is fetching');
    // cross the TTL, then let the file land
    await page.evaluate(() => {
      const real = Date.now;
      Date.now = () => real.call(Date) + 16000;
    });
    releaseCh();
    await waitEditor(page, FK.ch); // the landed fetch re-renders and attaches ch
    const pos = await page.evaluate(() => window.__mp.getPosition());
    assert.notEqual(pos.line, 100, `the stale jump was dropped, not landed late (caret at ${pos.line})`);
    assert.deepEqual((await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.ch)).lines, [],
      'no flash from a dropped jump');
    // the machinery is intact: a FRESH jump (post-shim clock throughout) lands
    await page.click(rowSel('ch.tex', 100));
    await waitLine(page, 100);
    await assertReveal35(page, 100, 'post-TTL fresh jump');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ E — the reopen-×-closed-pins leg rides texOpenAt unchanged ═══ */

test('a strip click on a ×-closed pin REOPENS the tab and lands the jump (texOpenAt untouched)', opts, async () => {
  const { context, page } = await jumpPage();
  try {
    await waitEditor(page, FK.paper);
    await armStrip(page);
    await page.click('#v-alpha .ctab.cd[data-fi="0"] .tabX'); // × paper.tex
    await page.waitForFunction(() => !document.querySelector('#v-alpha .ctab.cd[data-fi="0"]'),
      null, { timeout: 5000 });
    await waitEditor(page, FK.ch); // tab normalization moved to ch.tex
    await page.click(rowSel('paper.tex', 60));
    await waitEditor(page, FK.paper);
    await waitLine(page, 60);
    assert.ok(await page.$('#v-alpha .ctab.cd[data-fi="0"].on'),
      'the closed pin tab reopened AND selected (texOpenAt\'s reopen leg)');
    await assertReveal35(page, 60, 'reopen-jump');
    assert.deepEqual((await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper)).lines, [60],
      'the jump flashed its line');
  } finally {
    await context.close();
  }
});

/* ═══ F — P12: § dropdown pick + ⇧⌘O quick outline ═══ */

test('§ outline pick jumps through revealAt with the flash; ⇧⌘O lists the SAME texOutline rows and jumps', opts, async () => {
  const { context, page, errors } = await jumpPage();
  try {
    await waitEditor(page, FK.paper);
    // § — the shared texOutlineMenu over the {value: mp.text} shim
    await page.click('#v-alpha #texOutlineBtn');
    await page.waitForSelector('#texOutlineMenu .pmItem[data-ln]', { timeout: 5000 });
    const items = await page.evaluate(() => [...document.querySelectorAll('#texOutlineMenu .pmItem[data-ln]')]
      .map((el) => ({ ln: el.dataset.ln, title: el.textContent })));
    assert.deepEqual(items, [
      { ln: '2', title: 'Intro' }, { ln: '60', title: 'Model' }, { ln: '120', title: 'Results' },
    ], 'the dropdown carries the texOutline rows');
    await page.click('#texOutlineMenu .pmItem[data-ln="60"]');
    await waitLine(page, 60);
    await assertReveal35(page, 60, '§ pick');
    assert.deepEqual((await page.evaluate((fk) => window.__mp.flashInfo(fk), FK.paper)).lines, [60],
      '§ pick flashes the target line');

    // ⇧⌘O — the DocumentSymbolProvider feeds the native quick outline
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+Shift+KeyO`);
    await page.waitForSelector('.quick-input-widget .monaco-list-row', { timeout: 10000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll('.quick-input-widget .monaco-list-row')]
      .map((r) => r.getAttribute('aria-label') || r.textContent || ''));
    for (const want of ['Intro', 'Model', 'Results']) {
      assert.ok(rows.some((r) => r.includes(want)), `⇧⌘O lists '${want}' (same texOutline source): ${JSON.stringify(rows)}`);
    }
    await page.keyboard.type('Results');
    await sleep(300);
    await page.keyboard.press('Enter');
    await waitLine(page, 120); // native quick-outline pick jumps the caret
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ G — legacy control: the strip click jumps the textarea; nothing arms ═══ */

test('legacy control: strip click jumps the TEXTAREA caret; boot stays IDLE, zero vendor fetches, zero command fires', opts, async () => {
  const { context, page } = await jumpPage('legacy');
  try {
    await page.waitForSelector('#v-alpha textarea#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await armStrip(page);
    await page.click(rowSel('paper.tex', 120));
    await sleep(300);
    const st = await page.evaluate(() => {
      const ed = document.querySelector('#v-alpha textarea#codeEditor');
      return {
        line: ed.value.slice(0, ed.selectionStart).split('\n').length,
        monacoDom: !!document.querySelector('.monaco-editor'),
        boot: window.__mp.state(),
        fires: window.__mp.commandInfo().fires.length,
      };
    });
    assert.equal(st.line, 120, 'the legacy strip click still jumps the textarea caret');
    assert.equal(st.monacoDom, false, 'no monaco DOM under legacy');
    assert.equal(st.boot, 'IDLE', 'the boot machine never started');
    assert.equal(st.fires, 0, 'no S2.5 command ever fired under legacy');
    assert.equal(sb.vendor.hits.length, 0, 'zero /vendor/monaco fetches');
  } finally {
    await context.close();
  }
});
