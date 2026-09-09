// raw|formatted LaTeX fences in the console (design:
// docs/fence-toggle-mockup.html, variant A — Graham's pick, 2026-07-31).
// Tex-ish fences get a header strip (lang · raw|formatted pill · ⧉ copy);
// "formatted" re-renders the fence through the SAME md+KaTeX pipeline as
// answer prose after a structural pass (equation→$$, lists, lemma family,
// proof, \cite/\label chips). Default raw; the choice keys off a content hash in
// fenceView so it SURVIVES segment rebuilds (tab round-trips, macro bumps).
// Code fences in other languages are untouched.
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const TEXFENCE = [
  '```tex',
  'Fix prices $(r,w)$ with law $\\mu_0$, \\emph{feasible} plans satisfying',
  '\\begin{equation}\\label{eq:feasible}',
  '    c_t + a_{t+1} = x_t,\\qquad a_{t+1}\\ge0',
  '\\end{equation}',
  '\\begin{lemma}[The feasible set scales]',
  'For every $\\theta>0$, $\\Phi(\\theta x,\\theta P) = \\theta\\,\\Phi(x,P)$ \\citet{Aiyagari1994}.',
  '\\end{lemma}',
  '\\begin{proof}',
  'Scaling $P$ scales $P_t$ along every history.',
  '\\end{proof}',
  '\\begin{enumerate}[label=(\\alph*)]',
  '    \\item\\emph{First benchmark.}',
  '    Its display remains formatted:',
  '    \\[ q_1 = 1 \\]',
  '',
  '    \\item \\emph{Second benchmark.}',
  '    Its display remains formatted after the inter-item blank line:',
  '    \\[ q_2 = 2 \\]',
  '    \\begin{itemize}',
  '        \\item Nested qualification with $q_2>0$.',
  '    \\end{itemize}',
  '\\end{enumerate}',
  '\\begin{center}',
  '    Unsupported structure stays visibly literal.',
  '',
  '    Its indented tail must not become a Markdown code block.',
  '\\end{center}',
  '```',
].join('\n');
const JLFENCE = '```julia\nsol = solve(m; β = 0.97)\n```';
const BARE_MATHY = '```\nwith $x_0=x$ and $P_0=P$ write\n\\[ V(x,P) = \\sup \\E_0\\sum\\beta^t u(c_t) \\]\n```';

let ui, sb, page, wsPush, id;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), 'x\n'),
  });
  ({ sb, page, wsPush } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'appendix drafting', category: 'calibration', oversight: 'coop',
    context: { files: ['notes.tex'] },
  });
  id = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'running' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .ctab.console', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#v-alpha .ctab.console').click());
  await page.waitForFunction(() => window.marked && window.DOMPurify && window.renderMathInElement, null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  await wsPush('session:stream', { project: 'alpha', id,
    chunk: `\n— answer —\nHere is the appendix draft:\n\n${TEXFENCE}\n\nand the solver:\n\n${JLFENCE}\n\nplus a bare fence:\n\n${BARE_MATHY}\n\n— turn done · 1.0s · 1k in / 1k out —\n` });
  // The reveal pump may still be showing raw text at 600ms. Wait for the
  // streamed answer to settle into its actual fenced DOM, not a machine-speed
  // dependent delay (otherwise the formatted-view tests never run at all).
  await page.waitForFunction(() => document.querySelectorAll('#v-alpha #consoleBox .fenceBox').length === 2,
    null, { timeout: 10000 });
});
after(async () => { if (ui) await ui.stop(); });

const boxes = () => page.evaluate(() => {
  const seg = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')].pop();
  return {
    fenceBoxes: [...seg.querySelectorAll('.fenceBox')].map((b) => ({
      lang: b.querySelector('.fenceLang')?.textContent,
      fmt: b.classList.contains('fmt'),
      rawVisible: !!b.querySelector(':scope > pre')?.offsetParent,
    })),
    barePres: [...seg.querySelectorAll('pre')].filter((p) => !p.closest('.fenceBox')).length,
  };
});

test('tex-ish fences get the header chrome; other languages stay bare', opts, async () => {
  const b = await boxes();
  assert.equal(b.fenceBoxes.length, 2, 'the ```tex fence AND the bare mathy fence are chromed');
  assert.ok(b.fenceBoxes.every((x) => x.lang === 'tex'), 'labeled tex');
  assert.ok(b.fenceBoxes.every((x) => !x.fmt && x.rawVisible), 'default view is RAW');
  assert.equal(b.barePres, 1, 'the julia fence keeps its plain pre — no chrome');
});

test('formatted view typesets math, environments, and chips through the real pipeline', opts, async () => {
  const r = await page.evaluate(async () => {
    const box = document.querySelector('#v-alpha #consoleBox .fenceBox');
    box.querySelector('.fenceSeg [data-v="fmt"]').click();
    await new Promise((res) => setTimeout(res, 300));
    const f = box.querySelector('.fenceFmt');
    return {
      fmtOn: box.classList.contains('fmt'),
      rawHidden: !box.querySelector(':scope > pre').offsetParent,
      katex: f.querySelectorAll('.katex').length,
      display: f.querySelectorAll('.katex-display').length,
      text: f.innerText,
      pillOn: box.querySelector('.fenceSeg [data-v="fmt"]').classList.contains('on'),
      innerPres: f.querySelectorAll('pre').length,
      outerItems: f.querySelector('ol.texListExplicit')?.children.length || 0,
      nestedItems: f.querySelector('ol.texListExplicit ul')?.children.length || 0,
      secondDisplays: f.querySelector('ol.texListExplicit > li:nth-child(2)')?.querySelectorAll('.katex-display').length || 0,
      partial: f.querySelector('.fencePartial')?.textContent || '',
    };
  });
  assert.ok(r.fmtOn && r.rawHidden && r.pillOn, 'toggle flipped the views');
  assert.ok(r.katex >= 4, `inline + display math typeset (${r.katex} nodes)`);
  assert.ok(r.display >= 1, 'the equation environment became display math');
  assert.match(r.text, /Lemma\s*\(The feasible set scales\)/, 'lemma header rendered');
  assert.match(r.text, /Proof\./, 'proof block rendered');
  assert.match(r.text, /∎/, 'proof closes with the tombstone');
  assert.match(r.text, /\(eq:feasible\)/, 'the label surfaced as a chip');
  assert.match(r.text, /\[Aiyagari1994\]/, 'citet became a citation chip');
  assert.ok(!/\\begin\{equation\}/.test(r.text), 'no raw environment text leaks into the formatted view');
  assert.equal(r.outerItems, 2, 'enumerate became one ordered list with both items');
  assert.equal(r.nestedItems, 1, 'nested itemize remained nested');
  assert.match(r.text, /\(a\).*First benchmark[\s\S]*\(b\).*Second benchmark/, 'enumitem alpha labels survived');
  assert.equal(r.secondDisplays, 1, 'math in the second item still typesets after the blank line');
  assert.equal(r.innerPres, 0, 'TeX indentation did not create an accidental code block');
  assert.ok(!/\\(?:begin|end)\{(?:enumerate|itemize)\}|\\item/.test(r.text), 'no raw list commands leak');
  assert.match(r.text, /Its indented tail must not become a Markdown code block/, 'unsupported environment cannot swallow its tail');
  assert.match(r.partial, /partially formatted.*center left literal/, 'unsupported environment is disclosed');
});

test('the choice survives a full console rebuild (tab round-trip)', opts, async () => {
  await page.evaluate(() => document.querySelector('#v-alpha .ctab[data-fi="0"]').click());
  await sleep(250);
  await page.evaluate(() => document.querySelector('#v-alpha .ctab.console').click());
  await sleep(400);
  const b = await boxes();
  assert.equal(b.fenceBoxes[0].fmt, true, 'first fence came back FORMATTED from the store');
  assert.equal(b.fenceBoxes[1].fmt, false, 'the untouched fence stayed raw');
});

test('⧉ copies the raw LaTeX source, never the rendered HTML', opts, async () => {
  const r = await page.evaluate(async () => {
    let copied = null;
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (t) => { copied = t; };
    document.querySelector('#v-alpha #consoleBox .fenceBox .fenceCopy').click();
    await new Promise((res) => setTimeout(res, 100));
    navigator.clipboard.writeText = orig;
    return copied;
  });
  assert.match(r, /^Fix prices \$\(r,w\)\$/, 'copied text starts with the source');
  assert.match(r, /\\begin\{equation\}\\label\{eq:feasible\}/, 'source is verbatim — environments intact');
  assert.ok(!/katex/.test(r), 'no rendered HTML in the clipboard');
});
