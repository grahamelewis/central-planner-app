// Focus mode (2026-08-07, Graham's VSCode-style request): the statusbar's
// bottom-left button hides the workbench sidebar and unstacks the right
// column — editor | viewer | console side by side. Pure CSS re-layout on the
// KEPT skeleton (mounted panes must survive the toggle), persisted per
// browser in localStorage.focusMode like theme/dividers.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    viewport: { width: 1600, height: 900 },
    seed: ({ projRoots }) => {
      // A PDF first mirrors the reported task. It belongs in the viewer, never
      // in the editor, even when an old console selection is normalized.
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.pdf'), '%PDF test stub\n');
      fs.writeFileSync(
        path.join(projRoots.alpha, 'notes.tex'),
        '\\documentclass{article}\n\\begin{document}\nHello focus\n\\end{document}\n',
      );
    },
  });
  ({ sb, page, wsPush } = ui);
  // waiting coop task (never launched — no billing): sessionBody renders the
  // chat + composer, which is where focus mode hosts the console
  const t = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'focus mode task', category: 'calibration', oversight: 'coop',
    status: 'waiting', context: { files: ['paper.pdf', 'notes.tex'] },
  });
  id = t.body.id;
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600);
});
after(async () => { if (ui) await ui.stop(); });

const layout = () => page.evaluate(() => {
  const wb = document.querySelector('.wb');
  const side = wb.querySelector(':scope > .side');
  const viewer = wb.querySelector('.viewerTop');
  const sess = wb.querySelector('.sessHalf');
  const vr = viewer ? viewer.getBoundingClientRect() : null;
  const sr = sess ? sess.getBoundingClientRect() : null;
  return {
    focus: wb.classList.contains('focus'),
    sideVisible: !!side && side.offsetParent !== null,
    hdividerVisible: (() => { const h = wb.querySelector('.hdivider'); return !!h && h.offsetParent !== null; })(),
    // stacked = session pane starts below the viewer; side-by-side = same band
    stacked: vr && sr ? sr.top >= vr.bottom - 2 : null,
    sideBySide: vr && sr ? Math.abs(sr.top - vr.top) < 4 && sr.left >= vr.right - 2 : null,
    stored: localStorage.focusMode || null,
  };
});

test('the statusbar grows the focus toggle at its left end', opts, async () => {
  const btn = await page.$('.statusbar .focusTog');
  assert.ok(btn, 'focus toggle renders in the statusbar');
  const first = await page.$eval('.statusbar .sbLeft', el => el.firstElementChild?.id);
  assert.equal(first, 'focusTog', 'it sits leftmost — the bottom-left corner');
  const rects = await page.$eval('.focusTog svg', el => el.querySelectorAll('rect').length);
  assert.equal(rects, 2, 'normal mode shows the two-pane target glyph');
});

test('click → sidebar gone, viewer and console side by side; persisted', opts, async () => {
  await page.click('.statusbar .focusTog');
  await sleep(300);
  const st = await layout();
  assert.equal(st.focus, true, '.wb carries the focus class');
  assert.equal(st.sideVisible, false, 'the sidebar is gone');
  assert.equal(st.hdividerVisible, false, 'no stacked divider remains');
  assert.equal(st.sideBySide, true, 'viewer and console sit side by side, same band');
  assert.equal(st.stored, '1', 'persisted like theme/dividers');
  const rects = await page.$eval('.focusTog svg', el => el.querySelectorAll('rect').length);
  assert.equal(rects, 3, 'button now offers the way back (three-pane glyph)');
  // the editor is still the kept node — the toggle must not have remounted it
  assert.ok(await page.$('#codeEditor[data-ext="tex"]'), 'editor survived the toggle');
});

test('focus: Send preserves the editor when the first pin is a PDF', opts, async () => {
  const before = await page.$eval('#codeEditor', el => el.dataset.fkey);
  assert.equal(before, 'alpha::notes.tex', 'the valid code pin is open before Send');

  await page.fill('#composerInput', 'Keep this editor in place.');
  await page.click('#sendBtn');
  await sleep(300);

  assert.equal(await page.$eval('#codeEditor', el => el.dataset.fkey), before,
    'Send leaves the active editor alone because the console is already at right');
  assert.ok(await page.$('.ctabs .ctab.on[data-fi="1"]'), 'the notes tab stays selected');
  assert.equal(await page.evaluate((taskId) =>
    JSON.parse(localStorage.getItem('taskTab:alpha') || '{}')[taskId], id), 1,
    'Send does not persist the hidden console tab over the editor selection');
});

test('focus: a legacy console selection resolves to a visible editor, not files[0]', opts, async () => {
  // Recreate the stale state: leave focus mode, select the center console, then
  // return. The first context file is a PDF and must be skipped.
  await page.click('.statusbar .focusTog');
  await page.waitForSelector('.wb:not(.focus)');
  await page.click('.ctabs .ctab[data-fi="tail"]');
  await page.click('.statusbar .focusTog');
  await page.waitForSelector('.wb.focus');
  await sleep(200);

  assert.ok(await page.$('.ctabs .ctab.on[data-fi="1"]'), 'the first valid editor tab is selected');
  assert.equal(await page.$eval('#codeEditor', el => el.dataset.fkey), 'alpha::notes.tex');
  assert.ok(!(await page.textContent('.codeHalf')).includes('loading paper.pdf'),
    'the hidden PDF pin never becomes an orphaned editor surface');
});

test('focus: the console mounts in the session pane and the center strip drops its ≋ tab', opts, async () => {
  // (still in focus mode from the previous test)
  const box = await page.$('.sessHalf #consoleBox');
  assert.ok(box, 'the ≋ console lives in the right pane');
  assert.equal(await page.$('.ctabs .ctab.console'), null, 'the center strip has no console tab — ids stay unique');
  assert.ok(await page.$('.sessHalf #composerInput'), 'the composer sits under the console — watch and talk in one pane');
  // a live chunk streams into the right-pane console
  await wsPush('task:update', { project: 'alpha', task: { id, project: 'alpha', title: 'focus mode task', oversight: 'coop', status: 'running', context: {} } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await wsPush('session:stream', { project: 'alpha', id, chunk: 'FOCUSSTREAM the model is thinking here\n' });
  await sleep(900); // reveal pump
  const txt = await page.$eval('.sessHalf #consoleBox', el => el.textContent);
  assert.ok(txt.includes('FOCUSSTREAM'), 'streamed chunks paint into the hosted console');
});

test('focus: the barrier is full-height, drags smoothly (console stays anchored), persists', opts, async () => {
  const fd = await page.$('.fdivider');
  assert.ok(fd, 'fdivider exists');
  const geo = await page.evaluate(() => {
    const f = document.querySelector('.fdivider').getBoundingClientRect();
    const r = document.querySelector('.rpb').getBoundingClientRect();
    return { f, r, visible: document.querySelector('.fdivider').offsetParent !== null };
  });
  assert.equal(geo.visible, true, 'visible in focus mode');
  assert.ok(geo.f.height >= geo.r.height - 2, 'spans the full pane height, like the pane-1/2 barrier');
  // overflow the console, then sit at the bottom (the follow position) — the
  // anti-jump fix must hold the view there through every width rewrap
  const lines = Array.from({ length: 120 }, (_, i) =>
    `stream line ${i} — long filler prose so the wrap width genuinely matters here`).join('\n');
  await wsPush('session:stream', { project: 'alpha', id, chunk: lines + '\n' });
  await sleep(1200); // reveal pump drains
  const overflows = await page.evaluate(() => {
    const b = document.querySelector('.sessHalf #consoleBox');
    b.scrollTop = b.scrollHeight;
    return b.scrollHeight > b.clientHeight + 50;
  });
  assert.ok(overflows, 'console overflows (precondition for the anchor assertion)');
  await sleep(120);
  // drag it RIGHT ~150px — the console NARROWS, so its content rewraps
  // TALLER: without the anchor fix the view gets left behind (the browser's
  // own scrollTop clamp would mask a broken anchor in the widening direction)
  const x = geo.f.x + geo.f.width / 2;
  const y = geo.f.y + geo.f.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 150, y, { steps: 10 });
  await page.mouse.up();
  await sleep(300); // rAF apply + persist-on-mouseup settle
  const after = await page.evaluate(() => {
    const b = document.querySelector('.sessHalf #consoleBox');
    return {
      gap: b.scrollHeight - b.scrollTop - b.clientHeight,
      split: parseFloat(document.querySelector('.rpb').style.getPropertyValue('--fsplit')),
      stored: localStorage.wbFSplit,
    };
  });
  assert.ok(after.split > 50 && after.split < 75, `split moved right of center (got ${after.split})`);
  assert.ok(Math.abs(parseFloat(after.stored) - after.split) < 1, 'persisted (once, on mouseup)');
  assert.ok(after.gap < 30, `console stays bottom-anchored through the drag (gap ${after.gap}px)`);
});

test('reload restores focus mode; toggling back restores the stacked layout', opts, async () => {
  await page.reload();
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(600);
  let st = await layout();
  assert.equal(st.focus, true, 'focus mode survives a reload');
  assert.equal(st.sideVisible, false, 'sidebar still hidden after reload');
  await page.click('.statusbar .focusTog');
  await sleep(300);
  st = await layout();
  assert.equal(st.focus, false, 'back to normal mode');
  assert.equal(st.sideVisible, true, 'sidebar returns');
  assert.equal(st.stacked, true, 'viewer over console again');
  assert.equal(st.stored, null, 'localStorage key cleared');
});

/* ── the combination pin: editor:impl='monaco' × the focus-mode tab repair ──
   ui.monaco-core §C pins Monaco surviving the #focusTog toggle; the repair
   tests above pin the tail→file rules under the LEGACY editor only. This test
   pins the two together, in a FRESH context (isolated localStorage — the
   shared page above never sees monaco mode, and the impl toggle is armed
   PRE-boot, the ui.monaco-core idiom): the repair must land the KEPT dock on
   the first valid editor file, genuine CDP keystrokes must land in the drafts
   plane, and the no-file leg must render the focusnote with the host PARKED
   (never destroyed). Declared last on purpose: the shared-page tests above
   are order-dependent and must finish before another context runs. */
test('focus + monaco: the tail repair docks the kept editor on the first valid file, typing lands; no visible file → focusnote parks the host', opts, async () => {
  const FKN = 'alpha::notes.tex';
  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pg = await context.newPage();
  await armPage(pg); // billed routes intercepted + WS stubbed on this context too
  const pageErrors = [];
  pg.on('pageerror', (e) => pageErrors.push(String(e)));
  await pg.addInitScript(() => localStorage.setItem('editor:impl', 'monaco'));
  // boot READY + the kept editor live on fk inside a visible dock
  const waitEditor = (fk) => pg.waitForFunction((k) => (
    window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === k
    && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
  ), fk, { timeout: 25000, polling: 100 });
  try {
    await pg.goto(`${sb.base}/#alpha`, { waitUntil: 'domcontentloaded' });
    await waitEditor(FKN); // fresh storage boots on firstOpen — the PDF (0) skipped

    // recreate the stale state exactly like the legacy repair test above:
    // select the center console in normal mode ('tail' persists via the
    // task-tab memory), then enter focus mode
    await pg.click('.ctabs .ctab[data-fi="tail"]');
    await pg.waitForSelector('#consoleBox', { timeout: 5000 });
    assert.equal(await pg.evaluate(() => !!document.querySelector('#v-alpha .wb > .mdock.on')), false,
      'precondition: the dock hides on the console tab (host parked)');
    await pg.click('.statusbar .focusTog');
    await pg.waitForSelector('.wb.focus');
    await waitEditor(FKN);
    await sleep(200); // positionDock/RO settle before measuring

    // the repair landed on notes.tex (never blindly files[0] — that's the
    // PDF) AND the kept Monaco dock is attached over it, not parked
    const st = await pg.evaluate((taskId) => ({
      tabOn: !!document.querySelector('.ctabs .ctab.on[data-fi="1"]'),
      fkey: document.getElementById('codeEditor').dataset.fkey,
      active: window.__mp.activeFkey(),
      dockW: (document.querySelector('#v-alpha .wb > .mdock.on')?.getBoundingClientRect().width) || 0,
      parked: !!document.querySelector('#mpPark .mpHost'),
      remembered: JSON.parse(localStorage.getItem('taskTab:alpha') || '{}')[taskId],
    }), id);
    assert.equal(st.tabOn, true, 'the first valid editor tab is selected — the PDF pin is skipped');
    assert.equal(st.fkey, FKN, 'the kept host #codeEditor datasets track the repaired file');
    assert.equal(st.active, FKN, 'the active model matches the repaired selection');
    assert.ok(st.dockW > 100, `the dock is attached at a real laid-out width (got ${st.dockW})`);
    assert.equal(st.parked, false, 'the host is docked over the slot, not parked');
    assert.equal(st.remembered, 1, 'the repaired selection persisted over the stale tail');
    assert.ok(!(await pg.textContent('.codeHalf')).includes('loading paper.pdf'),
      'the hidden PDF pin never becomes an orphaned editor surface');

    // genuine CDP keystrokes land in the drafts plane — the editor is LIVE in
    // the 3-pane layout, not a painted corpse
    const orig = await pg.evaluate((fk) => window.__mp.text(fk), FKN);
    await pg.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await pg.keyboard.type('FOCUSLIVE ');
    await pg.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('FOCUSLIVE'),
      FKN, { timeout: 5000 });
    assert.ok((await pg.evaluate((fk) => window.__mp.text(fk), FKN)).startsWith('FOCUSLIVE '),
      'the keystrokes landed in the buffer');
    // undo to clean (the ui.monaco-core idiom) — leave no draft behind
    await pg.evaluate(() => window.__mp.focus());
    for (let i = 0; i < 40 && await pg.evaluate((fk) => window.__mp.isDirty(fk), FKN); i++) {
      await pg.keyboard.press(`${MOD}+z`);
      await sleep(40);
    }
    assert.equal(await pg.evaluate((fk) => window.__mp.text(fk), FKN), orig,
      '⌘Z bottomed out at the disk baseline');
    assert.equal(await pg.evaluate((fk) => window.__mp.store().drafts[fk], FKN), undefined,
      'no draft left behind');

    // the no-file leg: × the only editor tab (closed pins are skipped by the
    // repair rules, and localStorage-only — the task record is untouched) →
    // fi falls to 'tail' → the focusnote renders, the kept host PARKS
    await pg.click('.ctabs .ctab.cd[data-fi="1"] .tabX');
    await pg.waitForSelector('.codeHalf .noCode', { timeout: 5000 });
    const note = await pg.evaluate(() => ({
      text: document.querySelector('.codeHalf .noCode').textContent,
      foot: (document.querySelector('.codeHalf .cfoot') || {}).textContent || '',
      slot: !!document.querySelector('#monacoSlot'),
      dockOn: !!document.querySelector('#v-alpha .wb > .mdock.on'),
      parked: !!document.querySelector('#mpPark .mpHost'),
      state: window.__mp.state(),
    }));
    assert.ok(note.text.includes('the console lives in the session pane'), 'the focusnote renders');
    assert.ok(note.foot.includes('in the session pane (focus mode)'), 'its cfoot names the console home');
    assert.equal(note.slot, false, 'no monaco slot renders without an editor file');
    assert.equal(note.dockOn, false, 'the dock is not .on over the note');
    assert.equal(note.parked, true, 'the kept host parked — hidden, never destroyed');
    assert.equal(note.state, 'READY', 'the boot machine stayed READY through the park');
    assert.deepEqual(pageErrors, [], 'zero page errors across the whole flow');
  } finally {
    // isolated storage dies with the context; the server and the shared page
    // above never saw monaco mode — nothing to restore
    await context.close();
  }
});
