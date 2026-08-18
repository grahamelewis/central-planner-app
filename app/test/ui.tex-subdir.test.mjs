// Two .tex documents in subdirectories (the draft + the slide deck): ▶ on
// each gives each compiled pdf its OWN coexisting viewer tab — the
// ＋-equivalent of adding draft.pdf and slides.pdf by hand. Guards the
// 2026-07-17 regression: routing ▶ into the single live-watch slot meant the
// two documents could only steal the pane from each other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startUI, sleep, CHROME, testBothImpls, edDriver, wsPushTo } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const hasTex = (() => {
  try { execSync('which latexmk', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const texOpts = { skip: !hasChrome ? 'Google Chrome not installed' : !hasTex ? 'latexmk not installed' : false };

const DOC = (t) => `\\documentclass{article}\n\\begin{document}\n${t}\n\\end{document}\n`;
const DRAFT = 'Documentation/draft_new/draft.tex';
const SLIDES = 'Documentation/Slides/slides.tex';

let ui, sb, page, wsPush;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      // body text must stay underscore-free — a raw _ is a LaTeX error
      fs.mkdirSync(path.dirname(path.join(projRoots.alpha, DRAFT)), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, DRAFT), DOC('the draft'));
      fs.mkdirSync(path.dirname(path.join(projRoots.alpha, SLIDES)), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, SLIDES), DOC('the deck'));
    },
  });
  ({ sb, page, wsPush } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Paper + deck', category: 'calibration', oversight: 'manual',
    context: { files: [DRAFT, SLIDES] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const runAndLand = async (texRel) => {
  const pdfRel = texRel.replace(/\.tex$/, '.pdf');
  const btnRel = await page.evaluate(() => document.querySelector('#runFileBtn')?.dataset.rel);
  assert.equal(btnRel, texRel, `editor is on ${texRel} before ▶`);
  await page.click('#runFileBtn');
  await sleep(400);
  const sel = await page.evaluate(() => document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk);
  assert.equal(sel, pdfRel, `▶ selected ${pdfRel} as its own tab (${JSON.stringify(sel)})`);
  const st = await sb.poll('/api/state', (s) => s.runs?.alpha?.state === 'done'
    && s.artifacts?.some((a) => a.project === 'alpha' && a.rel === pdfRel), { timeoutMs: 60000, everyMs: 250 });
  // stubbed WS: deliver the done run:status + the artifact broadcast by hand,
  // exactly as the live socket would (without run:status the ▶ button would
  // stay in ⊘ stop mode and the next click would stop instead of run)
  await wsPush('run:status', { project: 'alpha', run: st.runs.alpha });
  await wsPush('artifact:new', { artifact: st.artifacts.find((a) => a.rel === pdfRel) });
  await sleep(300);
};

test('▶ on draft.tex then slides.tex: two coexisting pdf tabs, both live', texOpts, async () => {
  await runAndLand(DRAFT);

  // switch the editor to the deck and run it too
  await page.evaluate((rel) => {
    [...document.querySelectorAll('#v-alpha .scRow[data-fi]')]
      .find((r) => r.textContent.includes(rel.split('/').pop()))?.click();
  }, SLIDES);
  await sleep(400);
  await runAndLand(SLIDES);

  const tabs = await page.evaluate(() => ({
    vks: [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].map((t) => t.dataset.vk),
    on: document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk,
  }));
  assert.ok(tabs.vks.includes(DRAFT.replace('.tex', '.pdf')), `draft.pdf tab present (${JSON.stringify(tabs.vks)})`);
  assert.ok(tabs.vks.includes(SLIDES.replace('.tex', '.pdf')), `slides.pdf tab still there too (${JSON.stringify(tabs.vks)})`);
  assert.equal(tabs.on, SLIDES.replace('.tex', '.pdf'), 'the just-compiled deck is selected');

  // clicking back to the draft tab shows ITS pdf — no pane stealing, and the
  // STRIP ORDER never changes with selection (regression: the selected added
  // tab used to be claimed by the ephemeral-tab fallback and jump forward,
  // so clicking between draft.pdf and slides.pdf swapped their positions)
  const order0 = tabs.vks;
  const clickTab = async (vk) => {
    await page.evaluate((v) => {
      [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].find((t) => t.dataset.vk === v)?.click();
    }, vk);
    await sleep(450);
    return page.evaluate(() => ({
      vks: [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].map((t) => t.dataset.vk),
      on: document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk,
      canvas: !!document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) canvas'),
    }));
  };
  const back = await clickTab(DRAFT.replace('.tex', '.pdf'));
  assert.equal(back.on, DRAFT.replace('.tex', '.pdf'), 'draft tab reselects');
  assert.ok(back.canvas, 'draft pdf rendered in its pane');
  assert.deepEqual(back.vks, order0, `selecting draft must not reorder the strip (${JSON.stringify(back.vks)})`);
  const fwd = await clickTab(SLIDES.replace('.tex', '.pdf'));
  assert.deepEqual(fwd.vks, order0, 'selecting slides must not reorder it either');

  // no run record left running, and the live-watch slot was never touched
  const st = await sb.fetchJson('GET', '/api/state');
  assert.ok(!st.body.pdf?.alpha, '▶ never starts a live watch');
});

test('the pdf tabs persist like ＋-added displays (reload keeps both)', texOpts, async () => {
  await page.reload();
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(400);
  const vks = await page.evaluate(() =>
    [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].map((t) => t.dataset.vk));
  assert.ok(vks.includes(DRAFT.replace('.tex', '.pdf')), `draft.pdf survives reload (${JSON.stringify(vks)})`);
  assert.ok(vks.includes(SLIDES.replace('.tex', '.pdf')), 'slides.pdf survives reload');
});

/* ── Phase 3 S2.6 (monaco-s2 §2): the two-document ▶ KEEP contract,
   near-verbatim under BOTH editor implementations and WITHOUT latexmk —
   /api/run is intercepted on this pass's page (the ui.texauto recipe), so
   the tab-strip contract (each ▶ selects its OWN coexisting pdf tab; the
   foot ▶ datasets track the open subdir file; selection never reorders the
   strip) runs everywhere the suite runs. The compile/canvas halves stay in
   the latexmk-gated tests above. Declared last: the shared-page tests above
   are order-dependent. */
testBothImpls('▶ dual: draft.tex then slides.tex get coexisting pdf tabs; selection never reorders the strip', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  let seq = 0;
  await page.route('**/api/run', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    r.fulfill({
      json: { ok: true, run: { rel: body.rel, state: 'running', startedAt: `2026-08-17T01:00:0${seq++}Z` } },
    });
  });
  // on latexmk machines the shared-page tests built real pdfs — restore the
  // never-compiled state, then reload so applyState adopts it (the reload
  // re-runs implPage's init script: storage cleared, this pass's impl kept)
  for (const rel of [DRAFT, SLIDES]) {
    const base = rel.replace(/\.tex$/, '');
    for (const ext of ['pdf', 'aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz']) {
      fs.rmSync(path.join(sb.projRoots.alpha, `${base}.${ext}`), { force: true });
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, null, { timeout: 15000 });
  const runBoth = async (texRel, fi) => {
    const pdfRel = texRel.replace(/\.tex$/, '.pdf');
    await page.click(`#v-alpha .ctab[data-fi="${fi}"]`);
    await ed.wait(page, `alpha::${texRel}`);
    assert.equal(await page.evaluate(() => document.querySelector('#runFileBtn')?.dataset.rel), texRel,
      `foot ▶ datasets track ${texRel} before the run`);
    await page.click('#runFileBtn');
    await sleep(400);
    assert.equal(await page.evaluate(() => document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk),
      pdfRel, `▶ selected ${pdfRel} as its own tab`);
    await wsPushTo(page, 'run:status', {
      project: 'alpha', run: { rel: texRel, state: 'done', startedAt: `2026-08-17T01:00:0${seq - 1}Z`, ms: 900, exitCode: 0 },
    });
    await sleep(250);
  };
  await runBoth(DRAFT, 0);
  await runBoth(SLIDES, 1);
  const tabs = await page.evaluate(() => ({
    vks: [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].map((t) => t.dataset.vk),
    on: document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk,
  }));
  assert.ok(tabs.vks.includes(DRAFT.replace('.tex', '.pdf')), `draft.pdf tab present (${JSON.stringify(tabs.vks)})`);
  assert.ok(tabs.vks.includes(SLIDES.replace('.tex', '.pdf')), 'slides.pdf tab coexists');
  assert.equal(tabs.on, SLIDES.replace('.tex', '.pdf'), 'the just-run deck is selected');
  // selecting back and forth must never reorder the strip
  const clickTab = async (vk) => {
    await page.evaluate((v) => {
      [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].find((t) => t.dataset.vk === v)?.click();
    }, vk);
    await sleep(350);
    return page.evaluate(() => ({
      vks: [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')].map((t) => t.dataset.vk),
      on: document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk,
    }));
  };
  const back = await clickTab(DRAFT.replace('.tex', '.pdf'));
  assert.equal(back.on, DRAFT.replace('.tex', '.pdf'), 'draft tab reselects');
  assert.deepEqual(back.vks, tabs.vks, 'selecting draft must not reorder the strip');
  const fwd = await clickTab(SLIDES.replace('.tex', '.pdf'));
  assert.deepEqual(fwd.vks, tabs.vks, 'selecting slides must not reorder it either');
});
