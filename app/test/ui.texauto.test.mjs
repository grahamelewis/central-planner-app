// Session-edits-your-open-.tex flow (2026-08-07, Graham's slides workflow):
// Claude fills slides in while the deck is open in the dashboard.
//
//  · auto-recompile: a turn that edits a .tex whose compiled pdf has an open
//    tab fires a one-shot ▶ at turn end (queued behind the project's single
//    run slot); decks with no tab, and the live watch's own tex, are skipped
//  · reflection: a clean open editor reloads to the session's version; an
//    UNSAVED draft gets a 3-way merge — non-overlapping edits combine
//    silently and rebase, a genuine overlap falls back to the ⚠ disk guard
//
// /api/run is intercepted in-browser (no latexmk needed); file edits are real
// writes into the sandbox project. Tests share one staged session, in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startUI, sleep, CHROME, testMonaco, edDriver, wsPushTo } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const V1 = ['% deck v1', '\\documentclass{beamer}', '\\begin{document}',
  '\\begin{frame}{Intro}', 'baseline result', '\\end{frame}',
  '\\end{document}', ''].join('\n');

let ui, sb, page, wsPush, id, slidesPath;
const runPosts = []; // rel of every POST /api/run the page attempted
let runSeq = 0;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'slides.tex'), V1);
      fs.writeFileSync(path.join(projRoots.alpha, 'other.tex'), '% no tab for me\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  slidesPath = path.join(sb.projRoots.alpha, 'slides.tex');
  // one-shot compiles answer instantly in-browser — the run lifecycle is
  // driven by wsPush'd run:status, so no latexmk and no real run slot
  await page.route('**/api/run', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    runPosts.push(body.rel);
    r.fulfill({
      json: {
        ok: true,
        run: { rel: body.rel, state: 'running', startedAt: `2026-08-07T00:00:0${runSeq++}Z` },
      },
    });
  });

  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Slide deck', description: 'Fill the slides in.',
    category: 'writing', oversight: 'coop', context: { files: ['slides.tex'] },
  });
  id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(700);
  await page.click('#v-alpha .ctab[data-fi="0"]'); // slides.tex editor
  await page.waitForSelector('#v-alpha #codeEditor', { timeout: 8000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const edValue = () => page.evaluate(() => window.__mp.getText());
const runStatus = (rel, state, startedAt) =>
  wsPush('run:status', { project: 'alpha', run: { rel, state, startedAt, ms: 900 } });

test('▶ creates the deck tab; a session-touched tex auto-recompiles at turn end', opts, async () => {
  await page.click('#v-alpha #runFileBtn'); // bootstrap ▶ — creates the slides.pdf tab
  await sleep(400);
  assert.deepEqual(runPosts, ['slides.tex'], 'the manual compile fired');
  await runStatus('slides.tex', 'done', '2026-08-07T00:00:00Z'); // free the slot
  await sleep(200);

  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await wsPush('file:changed', { project: 'alpha', rel: 'slides.tex' });
  await wsPush('file:changed', { project: 'alpha', rel: 'other.tex' }); // no pdf tab → must be skipped
  await sleep(200);
  assert.equal(runPosts.length, 1, 'nothing compiles mid-turn');
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  assert.deepEqual(runPosts, ['slides.tex', 'slides.tex'],
    'turn end auto-compiles the deck with an open tab — and only that one');
  await runStatus('slides.tex', 'done', '2026-08-07T00:00:01Z');
  await sleep(200);
});

test('a busy run slot queues the auto-compile until run:status frees it', opts, async () => {
  await runStatus('other.tex', 'running', '2026-08-07T00:11:00Z'); // someone else holds the slot
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await wsPush('file:changed', { project: 'alpha', rel: 'slides.tex' });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(400);
  assert.equal(runPosts.length, 2, 'queued — not fired into a busy slot');
  await runStatus('other.tex', 'done', '2026-08-07T00:11:00Z');
  await sleep(400);
  assert.equal(runPosts.length, 3, 'slot freed → queued compile fires');
  assert.equal(runPosts[2], 'slides.tex');
  await runStatus('slides.tex', 'done', '2026-08-07T00:00:02Z');
  await sleep(200);
});

test('a clean open editor reloads to the session version in place', opts, async () => {
  const v2 = V1.replace('baseline result', 'baseline result, now with CIs');
  fs.writeFileSync(slidesPath, v2);
  await wsPush('file:changed', { project: 'alpha', rel: 'slides.tex' });
  await sleep(500);
  assert.equal(await edValue(), v2, 'editor shows the session version');
});

test('non-overlapping draft + session edit merge silently; one save lands both', opts, async () => {
  const base = await edValue();
  const mine = base.replace('% deck v1', '% deck v1 — graham pass');
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText(mine); // unsaved draft
  await sleep(200);
  const claude = fs.readFileSync(slidesPath, 'utf8')
    .replace('\\end{document}', '\\begin{frame}{Robustness}\nclaude frame\n\\end{frame}\n\\end{document}');
  fs.writeFileSync(slidesPath, claude);
  await wsPush('file:changed', { project: 'alpha', rel: 'slides.tex' });
  await sleep(600);
  const merged = await edValue();
  assert.ok(merged.includes('% deck v1 — graham pass'), 'my edit survived');
  assert.ok(merged.includes('claude frame'), "Claude's frame arrived in the open editor");
  const chip = await page.textContent('#v-alpha .saveChip');
  assert.ok(chip.includes('unsaved'), 'merged draft is a normal unsaved draft');
  assert.ok(!chip.includes('⚠ disk'), 'no conflict warning — the merge rebased the draft');
  await page.click('#v-alpha .saveChip');
  await sleep(500);
  const onDisk = fs.readFileSync(slidesPath, 'utf8');
  assert.ok(onDisk.includes('% deck v1 — graham pass') && onDisk.includes('claude frame'),
    'saving lands the combined version — no clipboard dialog, nothing lost');
  assert.ok((await page.textContent('#v-alpha .saveChip')).includes('saved'));
});

test('overlapping edits fall back to the ⚠ disk guard with the draft pinned', opts, async () => {
  const base = await edValue();
  const mine = base.replace('baseline result', 'MY new number');
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText(mine);
  await sleep(200);
  fs.writeFileSync(slidesPath, base.replace('baseline result', 'CLAUDE new number'));
  await wsPush('file:changed', { project: 'alpha', rel: 'slides.tex' });
  await sleep(600);
  assert.ok((await edValue()).includes('MY new number'), 'draft pinned — never clobbered');
  assert.ok((await page.textContent('#v-alpha .saveChip')).includes('⚠ disk'),
    'conflict surfaces as the ⚠ disk guard (save offers the manual flow)');
});

test('merge3 edge cases (engine seam)', opts, async () => {
  const cases = await page.evaluate(() => {
    const m = window.__merge3;
    return {
      twins: m('a\nb\nc', 'a\nX\nc', 'a\nX\nc'),
      adjacent: m('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nC\nd'),
      dualInsert: m('a\nb', 'a\nx\nb', 'a\ny\nb'),
      oursOnly: m('a\nb', 'a\nB', 'a\nb'),
    };
  });
  assert.equal(cases.twins, 'a\nX\nc', 'identical edits collapse');
  assert.equal(cases.adjacent, 'a\nB\nC\nd', 'adjacent-line edits interleave');
  assert.equal(cases.dualInsert, null, 'two different insertions at one point = conflict');
  assert.equal(cases.oursOnly, 'a\nB', 'unchanged disk keeps the draft');
});

/* ── Phase 3 S2.6 (monaco-s2 §2): the auto-recompile KEEP contract under
   BOTH editor implementations — a session-touched .tex whose compiled pdf
   has an open tab fires ONE ▶ at turn end; the same file:changed lands the
   clean-editor reload (under monaco through the M4 reconciliation plane;
   reads via edDriver). /api/run is intercepted on THIS pass's page (never
   billed, no latexmk); run lifecycle rides synthetic run:status pushes.
   Declared last: the shared-page tests above are order-dependent. */
testMonaco('turn-end dual: ▶-created deck tab + session file:changed → exactly one queued compile; clean editor reloads', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const FKS = 'alpha::slides.tex';
  const posts = [];
  let seq = 0;
  await page.route('**/api/run', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    posts.push(body.rel);
    r.fulfill({
      json: { ok: true, run: { rel: body.rel, state: 'running', startedAt: `2026-08-17T00:00:0${seq++}Z` } },
    });
  });
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, null, { timeout: 15000 });
  await page.click('#v-alpha .ctab[data-fi="0"]'); // slides.tex editor
  await ed.wait(page, FKS);

  // bootstrap ▶ creates the deck tab (fresh storage — no remembered viewers)
  await page.click('#v-alpha #runFileBtn');
  await sleep(400);
  assert.deepEqual(posts, ['slides.tex'], 'the manual compile fired');
  await wsPushTo(page, 'run:status', { project: 'alpha', run: { rel: 'slides.tex', state: 'done', startedAt: '2026-08-17T00:00:00Z', ms: 900 } });
  await sleep(200);

  // Claude's edit lands on disk mid-turn; the deck auto-recompiles at turn end
  const markLine = `% DUALPASS ${impl}`; // per-impl: the sibling pass needs its OWN fresh reload
  fs.writeFileSync(slidesPath,
    fs.readFileSync(slidesPath, 'utf8').replace('\\end{document}', `${markLine}\n\\end{document}`));
  await wsPushTo(page, 'session:status', { project: 'alpha', id, status: 'running' });
  await wsPushTo(page, 'file:changed', { project: 'alpha', rel: 'slides.tex' });
  await wsPushTo(page, 'file:changed', { project: 'alpha', rel: 'other.tex' }); // no pdf tab → skipped
  await sleep(200);
  assert.equal(posts.length, 1, 'nothing compiles mid-turn');
  // the CLEAN open editor reloads the session version meanwhile (M4 plane)
  for (let i = 0; i < 25 && !((await ed.text(page, FKS)) || '').includes(markLine); i++) await sleep(200);
  assert.ok((await ed.text(page, FKS)).includes(markLine), 'clean editor reloaded the session version in place');
  await wsPushTo(page, 'session:status', { project: 'alpha', id, status: 'waiting' });
  for (let i = 0; i < 25 && posts.length < 2; i++) await sleep(200);
  assert.deepEqual(posts, ['slides.tex', 'slides.tex'],
    'turn end auto-compiles the deck with an open tab — and only that one');
  await wsPushTo(page, 'run:status', { project: 'alpha', run: { rel: 'slides.tex', state: 'done', startedAt: '2026-08-17T00:00:01Z', ms: 900 } });
});
