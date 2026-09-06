// The LaTeX editor: PDF.js pane (render, keep-place, zoom), SyncTeX both
// ways, completion popup, auto-\end, ⌘/ toggle, § outline, problems strip.
// Editor-only behaviors run everywhere; compile-dependent ones skip without
// latexmk. Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const hasTex = (() => {
  try { execSync('which latexmk synctex', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const texOpts = { skip: !hasChrome ? 'Google Chrome not installed' : !hasTex ? 'latexmk not installed' : false };

const para = 'Household heterogeneity matters for aggregate dynamics. '.repeat(40);
const TEX = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
${para}
\\section{Model}\\label{sec:model}
\\begin{equation}\\label{eq:euler}
c_t^{-\\gamma} = \\beta (1+r) E_t\\, c_{t+1}^{-\\gamma}
\\end{equation}
\\newpage
\\section{Results}\\label{sec:results}
See \\ref{sec:nope}.
${para}
\\end{document}
`;

let ui, sb, page;


before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'refs.bib'),
        '@article{aiyagari1994, title={Uninsured Idiosyncratic Risk}, year={1994}}\n');
    },
  });
  ({ sb, page } = ui);
  await page.emulateMedia({ colorScheme: 'dark' });
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Paper', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex'] },
  });
  if (hasTex) {
    await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'paper.tex' });
    await sb.poll('/api/state', (s) => s.pdf?.alpha?.state === 'built', { timeoutMs: 60000, everyMs: 250 });
  }
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(hasTex ? 1500 : 400);
});
after(async () => { if (ui) await ui.stop(); });

/* ── compile-dependent: pane, problems, keep-place, synctex ── */

test('PDF pane renders page boxes with canvases and a text layer', texOpts, async () => {
  const info = await page.evaluate(() => ({
    boxes: document.querySelectorAll('.pdfPageBox').length,
    canvases: document.querySelectorAll('.pdfPageBox canvas').length,
    spans: document.querySelectorAll('.textLayer span').length,
  }));
  assert.ok(info.boxes >= 2, `page boxes: ${info.boxes}`);
  assert.ok(info.canvases >= 1, 'visible pages rasterized');
  assert.ok(info.spans > 10, 'selectable text layer');
});

test('problems strip: warning chips, expand, click jumps the editor', texOpts, async () => {
  assert.match(await page.evaluate(() => document.querySelector('.tpBar')?.textContent || ''),
    /warning/, 'undefined \\ref surfaces as a warning');
  await page.click('#tpBar');
  await page.waitForSelector('.tpRow', { timeout: 5000 });
  await page.click('.tpRow[data-pl]');
  await sleep(300);
  const line = await page.evaluate(() => window.__mp.getPosition()?.line);
  assert.ok(line >= 9, `caret jumped to the problem line (got ${line})`);
});

test('rebuilds keep the reader\'s place (no reload flicker path)', texOpts, async () => {
  await page.evaluate(() => { document.querySelector('.pdfScroll').scrollTop = 700; });
  await sleep(300);
  const stamp0 = (await sb.fetchJson('GET', '/api/state')).body.pdf.alpha.lastBuiltAt;
  fs.appendFileSync(path.join(sb.projRoots.alpha, 'paper.tex'), '% touch\n');
  await sb.poll('/api/state', (s) => s.pdf?.alpha?.lastBuiltAt !== stamp0 && s.pdf?.alpha?.state === 'built',
    { timeoutMs: 60000, everyMs: 250 });
  // the harness stubs the WebSocket — deliver the pdf:status the real server
  // just broadcast, so the pane actually performs its keep-place reload
  const entry = (await sb.fetchJson('GET', '/api/state')).body.pdf.alpha;
  await ui.wsPush('pdf:status', { project: 'alpha', entry });
  await sleep(1500);
  const after = await page.evaluate((stamp) => ({
    scroll: document.querySelector('.pdfScroll').scrollTop,
    canvases: document.querySelectorAll('.pdfPageBox canvas').length,
    reloaded: window.__pdfPanes.alpha.builtStamp === stamp,
    err: !!document.querySelector('.pdfLoadErr'),
  }), entry.lastBuiltAt);
  assert.ok(after.reloaded, 'the pane really reloaded the new build (stamp advanced)');
  assert.ok(Math.abs(after.scroll - 700) < 3, `scroll survived the rebuild (${after.scroll})`);
  assert.ok(after.canvases >= 1 && !after.err, 'pages re-rendered in place');
});

test('forward SyncTeX (⌘J) flashes the located box in the PDF', texOpts, async () => {
  await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(7, 1); });
  await page.keyboard.press('Meta+j');
  await sleep(800);
  assert.ok(await page.evaluate(() => !!document.querySelector('.syncFlash')), 'flash box appeared');
});

test('inverse SyncTeX: double-click in the PDF jumps the editor', texOpts, async () => {
  await page.evaluate(() => { document.querySelector('.pdfScroll').scrollTop = 0; });
  await page.evaluate(() => window.__mp.setPosition(1, 1));
  await sleep(400);
  const at = await page.evaluate(() => {
    const r = document.querySelector('.pdfPageBox').getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.12 };
  });
  await page.mouse.dblclick(at.x, at.y);
  await sleep(800);
  const line = await page.evaluate(() => window.__mp.hasTextFocus() ? window.__mp.getPosition().line : -1);
  assert.ok(line >= 1 && line <= 6, `editor focused near the clicked content (line ${line})`);
});

// Editor commands/completions now live in ui.monaco-commands/completions.
// The shared outline and recovery UI are covered by ui.monaco-only.
