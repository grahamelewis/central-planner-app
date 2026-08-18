// Drag a file tab onto ANOTHER task's tab: the file opens in that task
// (context pin + remembered as its selected tab) WITHOUT switching away from
// the task you're on (Graham's ask, 2026-07-30: "drag gl_draft.tex into the
// introWrite banner and have it be open there next time I click that task —
// I don't want the task I'm working on to change"). Duplicate drops must not
// double-pin. Wired by wireFileToTaskDrag — note it covers single-file tasks,
// which the older reorder wiring (files.length > 1) never armed for drag.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes; this
// file only POSTs/PATCHes /api/tasks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME, testBothImpls, edDriver } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, tgtId;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'a.tex'), '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'b.tex'), '\\documentclass{article}\n\\begin{document}\nB\n\\end{document}\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'c.tex'), '\\documentclass{article}\n\\begin{document}\nC\n\\end{document}\n');
    },
  });
  ({ sb, page } = ui);
  // TWO files on the source task — this arms wireFileReorder, whose dragstart
  // sets effectAllowed='move' and used to veto the cross-task 'copy' drop in
  // real browsers (the 2026-07-31 regression: single-file sources worked,
  // multi-file sources silently didn't)
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'source task', category: 'calibration', oversight: 'manual',
    context: { files: ['a.tex', 'c.tex'] },
  });
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'target task', category: 'calibration', oversight: 'manual',
    context: { files: ['b.tex'] },
  });
  tgtId = t2.id;
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

// one synthesized HTML5 drag from the first file tab onto the target task tab
// a REAL browser drag (mouse-driven, native DataTransfer) — not synthesized
// DragEvents, which bypass the browser's effect negotiation entirely. The
// 2026-07-31 regression lived exactly in that gap: reorder's dragstart set
// effectAllowed='move', the cross-task drop asked for 'copy', and real
// browsers vetoed the drop while dispatched events sailed through.
const dragTabOntoTask = () => page.dragAndDrop(
  '#v-alpha .ctab[data-fi="0"]',
  `#v-alpha .ptab.tk[data-id="${tgtId}"]`,
);

test('dropping a file tab on another task opens it there — without switching tasks', opts, async () => {
  const before = await page.evaluate(() => ({
    on: document.querySelector('.ptab.tk.on')?.dataset.id,
    rel: document.querySelector('#codeEditor')?.dataset.rel,
  }));
  assert.notEqual(before.on, tgtId, 'precondition: the SOURCE task is the selected one');

  await dragTabOntoTask();
  await sleep(500); // PATCH round-trip

  const after = await page.evaluate(() => ({
    on: document.querySelector('.ptab.tk.on')?.dataset.id,
    rel: document.querySelector('#codeEditor')?.dataset.rel,
  }));
  assert.equal(after.on, before.on, 'the current task did NOT change');
  assert.equal(after.rel, before.rel, 'the open editor did not move either');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const tgt = state.tasks.alpha.find((t) => t.id === tgtId);
  assert.deepEqual(tgt.context.files, ['b.tex', 'a.tex'], 'the file is pinned on the target task, appended');
});

test('a second drop of the same file does not duplicate the pin', opts, async () => {
  await dragTabOntoTask();
  await sleep(400);
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const tgt = state.tasks.alpha.find((t) => t.id === tgtId);
  assert.deepEqual(tgt.context.files, ['b.tex', 'a.tex'], 'still exactly one pin of a.tex');
});

test('clicking the target task greets you with the dropped file selected', opts, async () => {
  await page.evaluate((tgtId) => {
    [...document.querySelectorAll('.ptab.tk')].find((t) => t.dataset.id === tgtId).click();
  }, tgtId);
  await sleep(500);
  const s = await page.evaluate(() => ({
    on: document.querySelector('.ptab.tk.on')?.dataset.id,
    rel: document.querySelector('#codeEditor')?.dataset.rel,
    tabs: [...document.querySelectorAll('.ctab.cd')].map((t) => t.textContent.replace('×', '').trim()),
  }));
  assert.equal(s.on, tgtId, 'now the target task is selected');
  assert.equal(s.rel, 'a.tex', 'and the dropped file is the open tab');
  assert.ok(s.tabs.some((t) => t.includes('b.tex')), 'its original file tab is still there too');
});

/* ── Phase 3 S2.6 (P21, monaco-s2 §2): the cross-task drag KEEP contract,
   near-verbatim under BOTH editor implementations — the kept container
   preserves #codeEditor + datasets under monaco, so the "editor did not
   move" probe is the SAME dataset read. Uses c.tex (fi=1 on the source
   task): the legacy pass performs the first pin, the monaco pass proves the
   duplicate drop stays a no-op — both passes assert the invariants (task
   unchanged, editor unchanged, EXACTLY one pin). Declared last: the
   shared-page tests above are order-dependent. */
testBothImpls('drag dual: dropping c.tex on the target task pins it once, without switching task or editor', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  await ed.wait(page, 'alpha::a.tex'); // source task selected, first pin open
  const before = await page.evaluate(() => ({
    on: document.querySelector('.ptab.tk.on')?.dataset.id,
    rel: document.querySelector('#codeEditor')?.dataset.rel,
  }));
  assert.notEqual(before.on, tgtId, 'precondition: the SOURCE task is the selected one');
  assert.equal(before.rel, 'a.tex', 'precondition: the source editor is on a.tex');

  await page.dragAndDrop('#v-alpha .ctab[data-fi="1"]', `#v-alpha .ptab.tk[data-id="${tgtId}"]`);
  await sleep(500); // PATCH round-trip

  const after = await page.evaluate(() => ({
    on: document.querySelector('.ptab.tk.on')?.dataset.id,
    rel: document.querySelector('#codeEditor')?.dataset.rel,
  }));
  assert.equal(after.on, before.on, 'the current task did NOT change');
  assert.equal(after.rel, before.rel, 'the open editor did not move either');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const tgt = state.tasks.alpha.find((t) => t.id === tgtId);
  assert.equal(tgt.context.files.filter((f) => f === 'c.tex').length, 1,
    `exactly one pin of c.tex on the target (${JSON.stringify(tgt.context.files)})`);
});
