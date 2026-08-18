// test/ui.monaco-texfix.test.mjs — Phase 3 S2.4: texfix under the Monaco
// impl (P6, monaco-s2 §1 S2.4 post-remediation). Covers, against the real
// vendored 0.56 dist:
//   - arrival: the S0 anchors engine armed on the ACTIVE model, the sticky
//     .sugMark inline decoration (NeverGrowsWhenTypingAtEdges) + the ✦
//     .sugPane hosted as an IContentWidget under the match end; decorations
//     track typing ABOVE the match; the pulse plays once per id;
//   - apply: one undoable edit flowing AS TYPING through the drafts pipeline
//     (CONTRACT M2: deliberately UNguarded), the accepted wire shape pinned
//     VERBATIM (POST /api/texfix/:project/resolve {id, status:'accepted'}),
//     scroll untouched and the strip patched in place — never renderWB (I4);
//   - the mandated APPLY-GUARD DIFFERENTIAL (review concern 1 / R5): the
//     tracked range is corrupted between arm and click via __mp staging,
//     inside the revalidate-debounce window → the apply REFUSES, exactly one
//     synchronous re-find re-anchors at the surviving copy, and the captured
//     pre-click range text proves an UNguarded apply would have replaced the
//     wrong text; the re-click is then safe;
//   - stale grace → refusal: typing the find text away drops the visuals
//     (legacy find-missing semantics), apply refuses while stale, and the
//     ENGINE's single 5.2s grace resolves 'stale' exactly ONCE (risk N2's
//     single-owner rule — the legacy markSugStale timer is never armed);
//   - undo re-anchors: ⌘Z inside the grace restores visuals, cancels the
//     grace (no stale POST ever), and the suggestion applies cleanly after;
//   - the mandated CONCERN-2 two-file case: the SAME find string in two
//     files — only the suggestion's NAMED file gains a decoration, widget,
//     or edit; tab switches re-arm the active-model-only engine per file;
//   - stacking (R10): two suggestions in one file render two panes below
//     their own lines; resolving one patches in place and leaves the other
//     anchored.
//
// Legacy control: ui.texfix.test.mjs runs UNTOUCHED — the legacy
// renderSugs/applySug path is byte-identical this slice.
// Ground rules (monaco-s05 + blueprint §14): __mp is staging + the
// sanctioned surfaces under test (texfixState/texfixInfo read-only;
// texfixApply IS the pane's Apply path; pushEdit stages corruption/edits as
// undoable user-shaped edits); clicks hit the REAL widget buttons.
// Billing-safe: armPage intercepts the billed routes on every context and
// this file re-stubs /api/texfix/** to capture resolve bodies — suggestions
// arrive as synthetic texfix:status WS pushes (the ui.texfix staging), the
// billed POST /api/texfix/:project generate route is NEVER exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FK = { paper: 'alpha::paper.tex', other: 'alpha::other.tex' };

const filler = Array.from({ length: 80 }, (_, i) => `% filler line ${i + 1}`).join('\n');
const TEX = `\\documentclass{article}
${filler}
\\begin{document}
\\secton{Model}
Euler: money now beats money later
\\end{document}
`;
const SUG_LINE = 83;   // 1 documentclass + 80 filler + \begin{document} + this
const EULER_LINE = 84;
// the concern-2 partner: contains the SAME find string
const OTHER = `% other file
\\secton{Model}
same find string, different file
`;

const sug = (over = {}) => ({
  id: 's1-mtx', file: 'paper.tex',
  find: '\\secton{Model}', replace: '\\section{Model}',
  why: 'misspelled \\section', status: 'open', ...over,
});

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'other.tex'), OTHER);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco texfix', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex', 'other.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Fresh context seeded to ONE editor:impl value (the S2.1(d) isolation
 *  rule), with the resolve-POST capture the ui.texfix staging uses and
 *  pageerror capture. Registered AFTER armPage so this route wins. */
async function tfxPage(impl = 'monaco') {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const posts = [];
  await page.route('**/api/texfix/**', (r) => {
    posts.push({ url: r.request().url(), body: r.request().postDataJSON() });
    r.fulfill({ json: { ok: true } });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript((impl2) => { localStorage.setItem('editor:impl', impl2); }, impl);
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, { timeout: 15000, polling: 50 });
  return { context, page, posts, errors };
}

/** Feed THIS page one synthetic server WS event. */
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

const tfxState = (page, id) => page.evaluate((i) => window.__mp.texfixState(i), id);
const tfxInfo = (page) => page.evaluate(() => window.__mp.texfixInfo());
const paneCount = (page) => page.evaluate(
  () => document.querySelectorAll('#v-alpha .mdock .sugPane').length);
const markCount = (page) => page.evaluate(
  () => document.querySelectorAll('#v-alpha .mdock .sugMark').length);
const reveal = (page, line) => page.evaluate((ln) => window.__mp.revealLine(ln), line);
const waitPane = (page, n = 1, timeout = 10000) => page.waitForFunction(
  (want) => document.querySelectorAll('#v-alpha .mdock .sugPane').length === want,
  n, { timeout, polling: 100 });
/* goStale untracks the decoration synchronously, but the rendered .sugMark
   spans only leave the DOM on Monaco's next repaint — poll for the drop
   rather than sampling that frame gap. */
const waitMarks = (page, n = 0, timeout = 10000) => page.waitForFunction(
  (want) => document.querySelectorAll('#v-alpha .mdock .sugMark').length === want,
  n, { timeout, polling: 100 });
const waitStatus = (page, id, status, timeout = 10000) => page.waitForFunction(
  ([i, st]) => (window.__mp.texfixState(i) || {}).status === st,
  [id, status], { timeout, polling: 60 });

/* ═══ A — arrival visuals + tracking + apply: wire pinned, scroll/strip kept ═══ */

test('arrival: sticky mark + ✦ content-widget pane, tracks typing above; apply = ONE undoable typed edit, wire {id, status:\'accepted\'} verbatim, scroll + strip untouched (no renderWB)', opts, async () => {
  const { context, page, posts, errors } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', costUsd: 0.2, suggestions: [sug()] },
    });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    await sleep(150);

    // (a) the pane: legacy .sugPane DOM verbatim, pulse on first arrival
    const pane = await page.evaluate(() => {
      const el = document.querySelector('#v-alpha .mdock .sugPane');
      return {
        cls: el.className,
        paneNew: el.querySelector('.sugNew')?.textContent || '',
        why: el.querySelector('.sugWhy')?.textContent || '',
        applyRadius: getComputedStyle(el.querySelector('.sugApply')).borderRadius,
      };
    });
    assert.equal(pane.paneNew, '\\section{Model}', 'pane shows the complete replacement');
    assert.match(pane.why, /misspelled/, 'why on the pane');
    assert.ok(pane.cls.includes('pulse'), 'first arrival pulses (once per id)');
    assert.equal(pane.applyRadius, '7px', 'apply is the legacy rounded rectangle');
    // (b) the engine anchored the exact range; the mark decoration paints
    const st0 = await tfxState(page, 's1-mtx');
    assert.equal(st0.status, 'anchored');
    assert.deepEqual(
      [st0.range.startLineNumber, st0.range.startColumn, st0.range.endLineNumber, st0.range.endColumn],
      [SUG_LINE, 1, SUG_LINE, 1 + '\\secton{Model}'.length],
      'anchored at the find string (findMatches literal, first-match parity)');
    assert.ok((await markCount(page)) >= 1, '.sugMark inline decoration rendered');
    const strip = await page.evaluate(() => document.querySelector('#v-alpha .tpBar')?.textContent || '');
    assert.match(strip, /1 suggested fix/, 'strip counts it');

    // (c) decorations track typing ABOVE the match (sticky ranges)
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('% top\n');
    await sleep(300); // engine debounce (120ms) settles — still anchored
    const st1 = await tfxState(page, 's1-mtx');
    assert.equal(st1.status, 'anchored', 'typing above never stales the anchor');
    assert.equal(st1.range.startLineNumber, SUG_LINE + 1, 'the tracked range rode the insertion');
    assert.equal(await paneCount(page), 1, 'the pane rode along');

    // (d) apply — scroll spy + in-place-patch spy armed first
    await reveal(page, SUG_LINE + 1);
    await sleep(150);
    const scroll0 = await page.evaluate(() => {
      document.querySelector('#v-alpha #texProblems').dataset.probe = '1'; // renderWB detector
      return window.__mp.getScrollTop();
    });
    posts.length = 0;
    await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane .sugApply').click());
    await sleep(300);
    const after = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      draft: window.__mp.store().drafts[fk] || null,
      scroll: window.__mp.getScrollTop(),
      probe: document.querySelector('#v-alpha #texProblems').dataset.probe || null,
      chip: document.querySelector('#v-alpha #saveState')?.textContent || '',
      card: document.querySelector('#v-alpha .texfixCard')?.textContent || '',
      ids: window.__mp.texfixInfo() ? window.__mp.texfixInfo().ids : [],
    }), FK.paper);
    assert.ok(after.text.includes('\\section{Model}') && !after.text.includes('\\secton{Model}'),
      'text replaced in the buffer');
    assert.ok(after.draft && after.draft.includes('\\section{Model}'),
      'the applied fix flows through the drafts pipeline as typing (M2-unguarded)');
    assert.ok(Math.abs(after.scroll - scroll0) < 2,
      `apply moves neither scroll nor view (${scroll0} → ${after.scroll})`);
    assert.equal(posts.length, 1, 'one resolve POST');
    assert.deepEqual(posts[0].body, { id: 's1-mtx', status: 'accepted' },
      'the wire shape, verbatim (review concern 1)');
    assert.match(posts[0].url, /\/api\/texfix\/alpha\/resolve$/, 'the resolve route, exactly');
    assert.equal(after.probe, '1',
      'the strip host node SURVIVED — resolution patched in place, never renderWB (I4)');
    assert.match(after.chip, /unsaved/, 'the fix sits in the unsaved draft (user saves it)');
    assert.match(after.card, /applied/, 'session card reflects the resolution in place');
    assert.deepEqual(after.ids, [], 'engine anchor retired with the resolution');
    assert.equal(await paneCount(page), 0, 'pane cleared after apply');
    assert.equal(await markCount(page), 0, 'mark cleared after apply');

    // (e) undo-able in ONE step: ⌘Z reverts the apply and nothing else
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+z`);
    const undone = await page.evaluate((fk) => window.__mp.text(fk), FK.paper);
    assert.ok(undone.includes('\\secton{Model}'), 'one ⌘Z reverts the whole apply');
    assert.ok(undone.includes('% top'), '…and ONLY the apply — the earlier typing stands');

    assert.deepEqual(errors, [], 'zero page errors across arrival/tracking/apply');
  } finally {
    await context.close();
  }
});

/* ═══ B — stale grace: visuals down, apply refuses, ONE engine-owned 'stale' ═══ */

test('the user already fixed it: visuals drop, apply REFUSES while stale, and the engine\'s single 5.2s grace resolves \'stale\' exactly once', opts, async () => {
  const { context, page, posts } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', suggestions: [sug({ id: 's2-mtx' })] },
    });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    const r0 = (await tfxState(page, 's2-mtx')).range;
    // the user fixes it themselves (an undoable, user-shaped staged edit)
    await page.evaluate(([r, fk]) => window.__mp.pushEdit('\\section{Model}', r, fk), [r0, FK.paper]);
    await waitStatus(page, 's2-mtx', 'stale');
    assert.equal(await paneCount(page), 0, 'stale visuals: pane down (legacy find-missing semantics)');
    await waitMarks(page, 0);
    assert.equal(await markCount(page), 0, 'stale visuals: mark down');

    // refusal while stale — the buffer is untouched by the attempt
    const res = await page.evaluate((id) => window.__mp.texfixApply(id), 's2-mtx');
    assert.deepEqual(res, { ok: false, reason: 'stale' }, 'apply refuses while stale');
    const txt = await page.evaluate((fk) => window.__mp.text(fk), FK.paper);
    assert.equal(txt.split('\\section{Model}').length - 1, 1, 'exactly the user\'s own fix — no double apply');
    assert.ok(!txt.includes('\\secton{Model}'), 'nothing re-inserted');
    assert.equal(posts.length, 0, 'a refused apply resolves NOTHING');

    // the ENGINE owns the grace (risk N2): exactly ONE 'stale' resolution
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !posts.some((p) => p.body && p.body.id === 's2-mtx')) await sleep(150);
    await sleep(600); // a double-armed legacy timer would land a second POST here
    assert.deepEqual(posts.map((p) => p.body), [{ id: 's2-mtx', status: 'stale' }],
      'grace expiry resolved stale EXACTLY once, through the wire');
  } finally {
    await context.close();
  }
});

/* ═══ C — undo re-anchors inside the grace; the grace is CANCELED ═══ */

test('undo inside the grace re-anchors: visuals restored, the grace canceled (no stale POST, ever), and the suggestion still applies', opts, async () => {
  const { context, page, posts } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', suggestions: [sug({ id: 's3-mtx' })] },
    });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    const r0 = (await tfxState(page, 's3-mtx')).range;
    await page.evaluate(([r, fk]) => window.__mp.pushEdit('% gone', r, fk), [r0, FK.paper]);
    await waitStatus(page, 's3-mtx', 'stale');
    assert.equal(await paneCount(page), 0, 'staging: stale visuals down');

    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+z`);
    await waitStatus(page, 's3-mtx', 'anchored');
    await waitPane(page);
    assert.ok((await markCount(page)) >= 1, 'mark restored with the re-anchor');
    const st = await tfxState(page, 's3-mtx');
    assert.equal(st.range.startLineNumber, SUG_LINE, 're-anchored at the restored text');

    // the grace was CANCELED, not merely pending: wait past its full window
    await sleep(5600);
    assert.equal(posts.filter((p) => p.body && p.body.id === 's3-mtx').length, 0,
      'no stale resolution ever fired — the undo canceled the engine\'s grace');

    // and the suggestion is fully live again
    posts.length = 0;
    await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane .sugApply').click());
    await sleep(300);
    assert.deepEqual(posts.map((p) => p.body), [{ id: 's3-mtx', status: 'accepted' }]);
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.paper)).includes('\\section{Model}'));
  } finally {
    await context.close();
  }
});

/* ═══ D — the mandated apply-guard differential (concern 1 / R5) ═══ */

test('apply-guard differential: a range corrupted between arm and click REFUSES (one synchronous re-find, no wrong-text replacement — the unguarded edit is proven wrong), then the re-click is safe', opts, async () => {
  const { context, page, posts, errors } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', suggestions: [sug({ id: 's4-mtx' })] },
    });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    await sleep(150);
    posts.length = 0;

    // ONE evaluate — no awaits between corruption and click, so the click
    // lands INSIDE the engine's 120ms revalidate-debounce window: the exact
    // race the synchronous guard exists for.
    const out = await page.evaluate((id) => {
      const fk = 'alpha::paper.tex';
      const mp2 = window.__mp;
      const r = mp2.texfixState(id).range;
      // (i) plant a pristine copy BELOW the match — does not shift the anchor
      const lines = mp2.text(fk).split('\n');
      const lastLn = lines.length;
      const lastCol = lines[lastLn - 1].length + 1;
      mp2.pushEdit('\n\\secton{Model}',
        { startLineNumber: lastLn, startColumn: lastCol, endLineNumber: lastLn, endColumn: lastCol }, fk);
      // (ii) corrupt the TRACKED range in place ('sec' → 'XXX', same length)
      mp2.pushEdit('XXX',
        { startLineNumber: r.startLineNumber, startColumn: r.startColumn + 1,
          endLineNumber: r.startLineNumber, endColumn: r.startColumn + 4 }, fk);
      // (iii) what an UNGUARDED apply would replace RIGHT NOW: the tracked
      // range's current text, captured immediately before the click
      const rc = mp2.texfixState(id).range;
      const lineTxt = mp2.text(fk).split('\n')[rc.startLineNumber - 1];
      const rangeText = lineTxt.slice(rc.startColumn - 1, rc.endColumn - 1);
      // (iv) the REAL click — synchronous dispatch
      document.querySelector('#v-alpha .mdock .sugPane .sugApply').click();
      const stA = mp2.texfixState(id);
      return {
        rangeText,
        lineBefore: r.startLineNumber,
        after: stA ? { status: stA.status, line: stA.range && stA.range.startLineNumber } : null,
        text: mp2.text(fk),
      };
    }, 's4-mtx');

    // the differential: without the guard, THIS text would have been replaced
    assert.equal(out.rangeText, '\\XXXton{Model}',
      'at click time the tracked range no longer held the find string — the unguarded edit would have corrupted it');
    assert.notEqual(out.rangeText, '\\secton{Model}');
    // the guard refused: nothing replaced anywhere
    assert.ok(out.text.includes('\\XXXton{Model}'), 'the corrupted text is untouched');
    assert.equal(out.text.split('\\secton{Model}').length - 1, 1, 'the pristine copy is untouched');
    assert.ok(!out.text.includes('\\section{Model}'), 'no replacement landed ANYWHERE');
    assert.equal(posts.length, 0, 'a refused apply never resolves');
    // exactly one synchronous re-find ran: re-anchored at the surviving copy
    assert.equal(out.after.status, 'anchored', 'the one re-find re-anchored (refusal reason: moved)');
    assert.ok(out.after.line > out.lineBefore, `…at the surviving copy (line ${out.after.line})`);

    // the re-click is now safe (the engine header's contract)
    await page.evaluate((id) => {
      window.__mp.revealLine(window.__mp.texfixState(id).range.startLineNumber);
    }, 's4-mtx');
    await sleep(150);
    await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane .sugApply').click());
    await sleep(300);
    assert.deepEqual(posts.map((p) => p.body), [{ id: 's4-mtx', status: 'accepted' }]);
    const finalTxt = await page.evaluate((fk) => window.__mp.text(fk), FK.paper);
    assert.ok(finalTxt.includes('\\section{Model}'), 'the re-click applied at the re-anchored copy');
    assert.ok(finalTxt.includes('\\XXXton{Model}'), 'the corrupted text still untouched');
    assert.deepEqual(errors, [], 'zero page errors across the differential');
  } finally {
    await context.close();
  }
});

/* ═══ E — concern 2: same find string in TWO files — ownership is absolute ═══ */

test('two files, one find string: only the suggestion\'s NAMED file gains decoration/widget/edit; tab switches re-arm the active-model-only engine per file', opts, async () => {
  const { context, page, posts } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', suggestions: [sug({ id: 's5-mtx' })] },
    });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    let info = await tfxInfo(page);
    assert.equal(info.fkey, FK.paper, 'engine bound to the attached model');
    assert.deepEqual(info.ids, ['s5-mtx']);
    assert.equal(info.redrawRegistered, true, 'sugRedraw handle registered (seams delta 4)');

    // switch to the OTHER file — it contains the identical find string, and
    // the ownership filter is the ONLY thing keeping it untouched
    await clickTab(page, 1, FK.other);
    info = await tfxInfo(page);
    assert.equal(info.fkey, FK.other, 'tab switch re-armed against the new active model');
    assert.deepEqual(info.ids, [], 'the engine slice for this file is EMPTY (s.file filter)');
    assert.equal(await paneCount(page), 0, 'no widget in the wrong file');
    assert.equal(await markCount(page), 0, 'no decoration in the wrong file');
    const res = await page.evaluate((id) => window.__mp.texfixApply(id), 's5-mtx');
    assert.deepEqual(res, { ok: false, reason: 'unknown' }, 'an apply is impossible here');
    const otherTxt = await page.evaluate((fk) => window.__mp.text(fk), FK.other);
    assert.ok(otherTxt.includes('\\secton{Model}'), 'the wrong file\'s text is untouched');

    // back — per-file re-arm restores the suggestion (no pulse replay)
    await clickTab(page, 0, FK.paper);
    await waitPane(page);
    await reveal(page, SUG_LINE);
    info = await tfxInfo(page);
    assert.deepEqual(info.ids, ['s5-mtx'], 'switching back re-arms the named file');
    const cls = await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane').className);
    assert.ok(!cls.includes('pulse'), 'the pulse plays once per id — never on a re-arm');

    // apply lands ONLY in the named file
    posts.length = 0;
    await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane .sugApply').click());
    await sleep(300);
    assert.deepEqual(posts.map((p) => p.body), [{ id: 's5-mtx', status: 'accepted' }]);
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.paper)).includes('\\section{Model}'));
    await clickTab(page, 1, FK.other);
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.other)).includes('\\secton{Model}'),
      'the other file NEVER received the edit');
  } finally {
    await context.close();
  }
});

/* ═══ F — stacking (R10): two panes, in-place resolution leaves one standing ═══ */

test('two suggestions in one file stack: each pane sits under its own match; resolving one patches in place and the other stays anchored', opts, async () => {
  const { context, page, posts } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    const sA = sug({ id: 'sA-mtx' });
    const sB = sug({
      id: 'sB-mtx',
      find: 'Euler: money now beats money later',
      replace: 'Euler: patience is priced',
      why: 'tighter phrasing',
    });
    await push(page, 'texfix:status', {
      project: 'alpha', fix: { state: 'done', suggestions: [sA, sB] },
    });
    await waitPane(page, 2);
    await reveal(page, SUG_LINE);
    await sleep(150);

    const stacked = await page.evaluate(() => (
      [...document.querySelectorAll('#v-alpha .mdock .sugPane')].map((el) => ({
        replace: el.querySelector('.sugNew')?.textContent || '',
        top: el.getBoundingClientRect().top,
      }))
    ));
    assert.equal(stacked.length, 2, 'both panes render (multi-suggestion stacking)');
    const a = stacked.find((p) => p.replace === sA.replace);
    const b = stacked.find((p) => p.replace === sB.replace);
    assert.ok(a && b, 'each pane carries its own replacement');
    assert.ok(a.top < b.top, `panes stack under their own lines (${a.top} < ${b.top})`);
    assert.deepEqual((await tfxInfo(page)).ids.sort(), ['sA-mtx', 'sB-mtx']);

    // resolve A in place — B must not flinch
    posts.length = 0;
    await page.evaluate((probe) => {
      document.querySelector('#v-alpha #texProblems').dataset.probe = probe;
      const pane = [...document.querySelectorAll('#v-alpha .mdock .sugPane')]
        .find((el) => el.querySelector('.sugNew')?.textContent === '\\section{Model}');
      pane.querySelector('.sugApply').click();
    }, 'f');
    await sleep(300);
    assert.deepEqual(posts.map((p) => p.body), [{ id: 'sA-mtx', status: 'accepted' }]);
    assert.equal(await paneCount(page), 1, 'the other pane survives the in-place patch');
    const rest = await page.evaluate(() => ({
      paneNew: document.querySelector('#v-alpha .mdock .sugPane .sugNew')?.textContent || '',
      probe: document.querySelector('#v-alpha #texProblems').dataset.probe || null,
      strip: document.querySelector('#v-alpha .tpBar')?.textContent || '',
    }));
    assert.equal(rest.paneNew, sB.replace, 'the surviving pane is B\'s');
    assert.equal(rest.probe, 'f', 'strip patched in place across the resolution (I4)');
    assert.match(rest.strip, /1 suggested fix.*1 applied/, 'strip counts both states');
    const stB = await tfxState(page, 'sB-mtx');
    assert.equal(stB.status, 'anchored', 'B stayed anchored through A\'s apply');
    assert.equal(stB.range.startLineNumber, EULER_LINE, 'B\'s range untouched (same-line-count edit above)');
  } finally {
    await context.close();
  }
});

/* ═══ G — S2.6 sweep (standing both-impls duty): the DISMISS leg ═══
   ui.texfix's 'multi-line replacements shown IN FULL; Dismiss leaves the
   text alone' contract had no monaco leg — the pane's Dismiss button wiring
   (monacoPane texfixBuildWidget → resolveSug 'dismissed') was live product
   code with zero coverage. Same contract, monaco assertions: the ✦ pane
   shows the ENTIRE replacement untruncated, Dismiss POSTs
   {id, status:'dismissed'} verbatim, the buffer keeps the typo, and the
   decoration/widget/engine slice all release. */
test('dismiss on the pane: multi-line replacement shown IN FULL; wire {id, status:\'dismissed\'}; buffer untouched; visuals released', opts, async () => {
  const { context, page, posts, errors } = await tfxPage();
  try {
    await waitEditor(page, FK.paper);
    const multi = sug({
      id: 'sd-mtx',
      replace: '\\section{Model}\n\\begin{itemize}\n  \\item restored structure with a rather long explanatory line of content\n\\end{itemize}',
    });
    await push(page, 'texfix:status', { project: 'alpha', fix: { state: 'done', suggestions: [multi] } });
    await waitPane(page);
    await reveal(page, SUG_LINE);
    await sleep(150);
    const paneNew = await page.evaluate(() =>
      document.querySelector('#v-alpha .mdock .sugPane .sugNew')?.textContent || '');
    assert.equal(paneNew, multi.replace, 'the ENTIRE multi-line replacement is readable — no truncation');
    assert.equal((await tfxState(page, 'sd-mtx')).status, 'anchored', 'anchored before the dismissal');

    posts.length = 0;
    const before = await page.evaluate((fk) => window.__mp.text(fk), FK.paper);
    await page.evaluate(() => document.querySelector('#v-alpha .mdock .sugPane .sugDismiss').click());
    await sleep(300);
    assert.equal(posts.length, 1, 'one resolve POST');
    assert.deepEqual(posts[0].body, { id: 'sd-mtx', status: 'dismissed' }, 'the wire shape, verbatim');
    assert.match(posts[0].url, /\/api\/texfix\/alpha\/resolve$/, 'the resolve route, exactly');
    const after = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      draft: window.__mp.store().drafts[fk] ?? null,
      ids: window.__mp.texfixInfo() ? window.__mp.texfixInfo().ids : [],
    }), FK.paper);
    assert.equal(after.text, before, 'text untouched by dismiss');
    assert.ok(after.text.includes('\\secton{Model}'), 'the typo is still the user\'s to keep');
    assert.ok(!after.text.includes('itemize'), 'nothing applied');
    assert.equal(after.draft, null, 'no draft materialized — dismiss is not an edit');
    assert.deepEqual(after.ids, [], 'the engine slice released the anchor');
    await waitPane(page, 0);
    await waitMarks(page, 0);
    assert.deepEqual(errors, [], 'zero page errors across the dismissal');
  } finally {
    await context.close();
  }
});
