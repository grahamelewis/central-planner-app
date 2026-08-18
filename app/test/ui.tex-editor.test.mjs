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
const ed = (js) => page.evaluate(`(() => { const ed = document.querySelector('#codeEditor'); return ${js}; })()`);

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
  const line = await ed('ed.value.slice(0, ed.selectionStart).split("\\n").length');
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
  await page.click('#codeEditor');
  await ed('ed.setSelectionRange(ed.value.indexOf("equation"), ed.value.indexOf("equation"))');
  await page.keyboard.press('Meta+j');
  await sleep(800);
  assert.ok(await page.evaluate(() => !!document.querySelector('.syncFlash')), 'flash box appeared');
});

test('inverse SyncTeX: double-click in the PDF jumps the editor', texOpts, async () => {
  await page.evaluate(() => { document.querySelector('.pdfScroll').scrollTop = 0; });
  await ed('ed.setSelectionRange(0, 0)');
  await sleep(400);
  const at = await page.evaluate(() => {
    const r = document.querySelector('.pdfPageBox').getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.12 };
  });
  await page.mouse.dblclick(at.x, at.y);
  await sleep(800);
  const line = await ed('document.activeElement === ed ? ed.value.slice(0, ed.selectionStart).split("\\n").length : -1');
  assert.ok(line >= 1 && line <= 6, `editor focused near the clicked content (line ${line})`);
});

/* ── editor-only: completion, auto-\end, ⌘/, outline ── */

test('\\ref{ completion lists labels; accept inserts key and closes the brace', opts, async () => {
  await page.click('#codeEditor');
  await ed('ed.setSelectionRange(ed.value.indexOf("\\\\end{document}"), ed.value.indexOf("\\\\end{document}"))');
  await page.keyboard.type('\\ref{');
  await page.waitForSelector('.texCompl .tcItem', { timeout: 5000 });
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.tcItem .tcLabel')].map((x) => x.textContent));
  assert.ok(labels.includes('eq:euler'), JSON.stringify(labels));
  await page.keyboard.type('eu');
  await sleep(250);
  await page.keyboard.press('Enter');
  const around = await ed('ed.value.slice(ed.selectionStart - 15, ed.selectionStart)');
  assert.ok(around.endsWith('\\ref{eq:euler}'), `inserted + hopped the brace: ${JSON.stringify(around)}`);
  await page.keyboard.press('Escape');
});

test('\\cite{ completion lists bib keys with titles', opts, async () => {
  await page.keyboard.type(' \\cite{');
  await page.waitForSelector('.texCompl .tcItem', { timeout: 5000 });
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.tcItem')].map((x) => x.textContent));
  assert.ok(items.some((t) => /aiyagari1994/.test(t) && /Uninsured/.test(t)), JSON.stringify(items));
  await page.keyboard.press('Escape');
});

test('accepting an env completion emits BALANCED braces (the auto-paired } flow)', opts, async () => {
  await page.click('#codeEditor');
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('\\begin{cent'); // auto-pair puts the } after the caret
  await page.waitForSelector('.texCompl .tcItem', { timeout: 5000 });
  await page.keyboard.press('Enter'); // accept 'center'
  await sleep(200);
  const around = await ed('ed.value.slice(ed.selectionStart - 30, ed.selectionStart + 30)');
  assert.match(around, /\\begin\{center\}\n {2}\n\\end\{center\}/,
    `balanced env inserted: ${JSON.stringify(around)}`);
  const opens = await ed('(ed.value.match(/\\\\begin\\{center\\}/g) || []).length');
  const closes = await ed('(ed.value.match(/\\\\end\\{center\\}/g) || []).length');
  assert.equal(opens, closes, 'every \\begin{center} has its \\end');
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)'); // flush caret for the next test
});

test('Enter after \\begin{env} auto-inserts the matching \\end', opts, async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('\\begin{center}');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await sleep(150);
  const around = await ed('ed.value.slice(ed.selectionStart - 30, ed.selectionStart + 30)');
  assert.match(around, /\\begin\{center\}\n {2}\n\\end\{center\}/, JSON.stringify(around));
});

test('⌘/ toggles % comments', opts, async () => {
  await page.keyboard.type('draft sentence');
  // the toggle re-selects the block, so read the whole line, not to-the-caret
  const curLine = 'ed.value.split("\\n")[ed.value.slice(0, ed.selectionStart).split("\\n").length - 1]';
  await page.keyboard.press('Meta+/');
  await sleep(120);
  let line = await ed(curLine);
  assert.match(line, /% draft sentence/, line);
  await page.keyboard.press('Meta+/');
  await sleep(120);
  line = await ed(curLine);
  assert.doesNotMatch(line, /%/, line);
});

test('§ outline lists sections with clean titles and jumps on click', opts, async () => {
  await page.click('#texOutlineBtn');
  await page.waitForSelector('#texOutlineMenu .pmItem', { timeout: 5000 });
  const entries = await page.evaluate(() =>
    [...document.querySelectorAll('#texOutlineMenu .pmItem')].map((x) => x.textContent));
  assert.ok(entries.includes('Model'), `labels stripped from titles: ${JSON.stringify(entries)}`);
  await page.evaluate(() => {
    [...document.querySelectorAll('#texOutlineMenu .pmItem')].find((x) => x.textContent === 'Model').click();
  });
  await sleep(250);
  const line = await ed('ed.value.slice(0, ed.selectionStart).split("\\n").length');
  assert.equal(line, 5, `jumped to \\section{Model} (line ${line})`);
});

test('Enter auto-indents: text under \\item lines up with \\item', opts, async () => {
  await page.click('#codeEditor');
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Shift+Enter'); // clean flush-left start
  await page.keyboard.type('\\begin{enumerate}');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');       // auto-\end: caret lands on the indented body line
  await page.keyboard.type('\\item Project 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('continued');
  const around = await ed('ed.value.slice(ed.selectionStart - 40, ed.selectionStart)');
  assert.match(around, /\n {2}\\item Project 1\n {2}continued$/,
    `continuation lines up with \\item: ${JSON.stringify(around)}`);
});

test('Enter after an already-closed \\begin indents one level deeper (no second \\end)', opts, async () => {
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('\\begin{quote}');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter'); // auto-\end → quote is balanced now
  // re-open a line at the end of the \begin{quote} line itself
  await ed('(() => { const at = ed.value.lastIndexOf("\\\\begin{quote}") + 13; ed.setSelectionRange(at, at); return 0; })()');
  await page.keyboard.press('Enter');
  await page.keyboard.type('inside');
  const around = await ed('ed.value.slice(ed.selectionStart - 30, ed.selectionStart)');
  assert.match(around, /\\begin\{quote\}\n {2}inside$/, JSON.stringify(around));
  const ends = await ed('(ed.value.match(/\\\\end\\{quote\\}/g) || []).length');
  assert.equal(ends, 1, 'no duplicate \\end for the balanced environment');
});

test('Backspace in leading whitespace dedents one level (\\item depth → \\begin depth)', opts, async () => {
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('\\begin{description}');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');       // auto-\end: caret indented to 2
  await page.keyboard.type('\\item one');
  await page.keyboard.press('Enter');       // new line lines up with \item (col 2)
  await page.keyboard.press('Backspace');   // one press → back to \begin depth
  await page.keyboard.type('\\end');        // user closing the env by hand, flush left
  await page.keyboard.press('Escape');
  const around = await ed('ed.value.slice(ed.selectionStart - 30, ed.selectionStart)');
  assert.match(around, /\n {2}\\item one\n\\end$/, JSON.stringify(around));
});

test('Backspace steps nested indents level by level, and odd indents to the stop', opts, async () => {
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('      x');      // col 6 content, caret after 'x'
  await page.keyboard.press('Enter');       // auto-indent → col 6
  await page.keyboard.press('Backspace');   // → 4
  await page.keyboard.press('Backspace');   // → 2
  await page.keyboard.type('two');
  let around = await ed('ed.value.slice(ed.selectionStart - 12, ed.selectionStart)');
  assert.match(around, /\n {2}two$/, JSON.stringify(around));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('   ');          // odd: col 3
  await page.keyboard.press('Backspace');   // → 2 (one space, to the stop)
  await page.keyboard.type('odd');
  around = await ed('ed.value.slice(ed.selectionStart - 12, ed.selectionStart)');
  assert.match(around, /\n {2}odd$/, JSON.stringify(around));
});

test('⇧Enter stays a plain unindented newline', opts, async () => {
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.type('   indented tail');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('flush');
  const around = await ed('ed.value.slice(ed.selectionStart - 30, ed.selectionStart)');
  assert.match(around, /indented tail\nflush$/, JSON.stringify(around));
});

test('the caret pauses (no blink, dimmed) when the window loses focus', opts, async () => {
  await page.click('#codeEditor');
  await sleep(200);
  const live = await page.evaluate(() => {
    const c = document.querySelector('.edCaret');
    const cs = getComputedStyle(c);
    return { anim: cs.animationName, opacity: cs.opacity, shown: cs.display !== 'none' };
  });
  assert.ok(live.shown && live.anim === 'edBlink', `ticking while focused: ${JSON.stringify(live)}`);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(100);
  const idle = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.edCaret'));
    return { anim: cs.animationName, opacity: Number(cs.opacity) };
  });
  assert.equal(idle.anim, 'none', 'blink paused when the window blurred');
  assert.ok(idle.opacity <= 0.35, `dimmed: ${idle.opacity}`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(100);
  const back = await page.evaluate(() => getComputedStyle(document.querySelector('.edCaret')).animationName);
  assert.equal(back, 'edBlink', 'ticking resumes with window focus');
});

test('auto-pairs: braces wrap selections and closers overtype', opts, async () => {
  await ed('ed.setSelectionRange(ed.value.length, ed.value.length)');
  await page.keyboard.press('Enter');
  await page.keyboard.type('{');
  let pair = await ed('ed.value.slice(ed.selectionStart - 1, ed.selectionStart + 1)');
  assert.equal(pair, '{}', 'auto-closed');
  await page.keyboard.type('}');
  pair = await ed('ed.value.slice(ed.selectionStart - 2, ed.selectionStart)');
  assert.equal(pair, '{}', 'overtyped, not doubled');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
});
