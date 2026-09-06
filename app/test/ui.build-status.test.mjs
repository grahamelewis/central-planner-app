// Quiet builds: the staged bar + toolbar verdict on the live-watch PDF pane,
// the build card that replaces the latexmk log spew for .tex ▶ runs, and the
// end of the auto-jump to ▶ output when compiling LaTeX.
// Real latexmk drives the watch tests; run-card states arrive as synthetic
// run:status pushes over the stubbed WebSocket (runner routes aren't billed,
// but synthetic states make the assertions timing-proof).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startUI, sleep, CHROME, testMonaco, edDriver, wsPushTo } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const hasTex = (() => {
  try { execSync('which latexmk', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const texOpts = { skip: !hasChrome ? 'Google Chrome not installed' : !hasTex ? 'latexmk not installed' : false };

// 12 pages: the page indicator must cross the 9 → 10 digit boundary so the
// toolbar-stability test below can prove the verdict chip never shifts
const TEX = `\\documentclass{article}
\\begin{document}
\\section{Model}
Euler: $c^{-g} = bRc'^{-g}$
${Array.from({ length: 11 }, (_, i) => `\\newpage\\section{Section ${i + 2}} Page ${i + 2}.`).join('\n')}
\\end{document}
`;

let ui, sb, page, wsPush, taskId;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'x = 1\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Paper', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex', 'model.jl'] },
  });
  taskId = t.id;
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const verdictState = () => page.evaluate(() => {
  const v = document.querySelector('#v-alpha .pdfVerdict');
  const bar = document.querySelector('#v-alpha .pdfBuildBar');
  return {
    cls: v ? v.className : null,
    text: v ? v.textContent.trim() : null,
    barOff: bar ? bar.classList.contains('off') : null,
    barP: bar ? bar.firstElementChild.style.getPropertyValue('--p') : null,
  };
});

test('the live watch pane: ⟳ pass chip while building, ✓ + seconds on built, ✗ + seconds on error', texOpts, async () => {
  const w = await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'paper.tex' });
  assert.equal(w.status, 200, JSON.stringify(w.body));

  // (one-shot compiles carry no -pv/-pvc, so latexmk can never launch the OS
  // previewer — the old resident -pvc watch needed -view=none for that)
  const st = await sb.poll('/api/state', (s) => s.pdf?.alpha?.state === 'built', { timeoutMs: 60000, everyMs: 250 });
  const entry = st.pdf.alpha;

  // reload so the page adopts the built state and mounts the pane
  await page.reload();
  await page.waitForSelector('#v-alpha .pdfPane canvas', { timeout: 20000 });
  let v = await verdictState();
  assert.match(v.cls, /\bok\b/, `built → green chip (${v.cls})`);
  assert.match(v.text, /^✓ \d+(\.\d+)?s$/, `check + compile seconds (${JSON.stringify(v.text)})`);
  assert.equal(v.barOff, true, 'staged bar hidden at rest');

  // building ping with a pass boundary → pulsing pass chip + bar at the pass stop
  await wsPush('pdf:status', {
    project: 'alpha',
    entry: { ...entry, state: 'building', pass: { n: 2, rule: 'pdflatex' } },
  });
  await sleep(200);
  v = await verdictState();
  assert.match(v.cls, /\bbld\b/, 'building → blue chip');
  assert.match(v.text, /pdflatex · pass 2/, `live pass label (${JSON.stringify(v.text)})`);
  assert.equal(v.barOff, false, 'staged bar visible while building');
  // continuous motion: the transition's TARGET is the creep cap just under
  // the next stop — the bar keeps moving between pass boundaries
  assert.equal(v.barP, '0.86', `bar creeping toward the pass-3 stop (${v.barP})`);
  const foot = await page.evaluate(() => document.querySelector('#v-alpha #pdfStateTxt')?.textContent || '');
  assert.match(foot, /building · pdflatex pass 2/, 'footer mirrors the pass');

  // built → bar completes then fades; chip flips to ✓ + seconds and persists
  await wsPush('pdf:status', { project: 'alpha', entry: { ...entry, lastBuildMs: 1832 } });
  await sleep(700); // > the 450ms completion-fade delay
  v = await verdictState();
  assert.match(v.cls, /\bok\b/, 'built → green chip');
  assert.equal(v.text, '✓ 1.8s', `seconds from lastBuildMs (${JSON.stringify(v.text)})`);
  assert.equal(v.barP, '1', 'bar ran to the end');
  assert.equal(v.barOff, true, 'and faded out');

  // error → red chip with the failing cycle's duration
  await wsPush('pdf:status', {
    project: 'alpha',
    entry: {
      ...entry, state: 'error', errorMs: 872,
      problems: [{ file: 'paper.tex', line: 3, kind: 'error', message: 'Undefined control sequence.' }],
      counts: { errors: 1, warnings: 0, badboxes: 0 },
    },
  });
  await sleep(300);
  v = await verdictState();
  assert.match(v.cls, /\bno\b/, 'error → red chip');
  assert.equal(v.text, '✗ 0.9s', `fail time on the chip (${JSON.stringify(v.text)})`);
  assert.equal(v.barOff, true, 'bar hidden on error');

  // clicking the ✗ jumps to the first error in the editor
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console')?.click(); });
  await sleep(200);
  await page.click('#v-alpha .pdfVerdict');
  await sleep(400);
  const ed = await page.evaluate(() => {
    const e = document.querySelector('#v-alpha #codeEditor');
    return e ? { ext: e.dataset.ext, line: window.__mp.getPosition().line } : null;
  });
  assert.equal(ed?.ext, 'tex', '✗ click opened the .tex in the editor');
  assert.equal(ed?.line, 3, `caret on the failing line (${ed?.line})`);

  await sb.fetchJson('DELETE', '/api/pdf/watch/alpha');
  await wsPush('pdf:status', { project: 'alpha', entry: { ...entry } }); // settle back to built for later tests
});

test('▶ on a .tex: one-shot compile + its pdf appears as its OWN viewer tab (the ＋-equivalent)', texOpts, async () => {
  // clear the watch test's build products so this run actually compiles
  // (an up-to-date latexmk run announces no passes and writes no pages)
  for (const ext of ['pdf', 'aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz']) {
    fs.rmSync(path.join(sb.projRoots.alpha, `paper.${ext}`), { force: true });
  }
  await page.reload();
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
  await page.click('#runFileBtn');
  await sleep(400); // POST round-trip + renderWB
  const view = await page.evaluate(() => ({
    on: document.querySelector('#v-alpha .sessTabs .stab.on')?.dataset.st,
    runTab: !!document.querySelector('#v-alpha .sessTabs .stab.runT'),
    vtab: document.querySelector('#v-alpha .vtabs .ptab.vw.on')?.dataset.vk,
  }));
  assert.equal(view.on, 'sess', 'session tab keeps focus while LaTeX compiles');
  assert.ok(view.runTab, 'the ▶ output tab still appears (with its spinner)');
  assert.equal(view.vtab, 'paper.pdf', `compiled pdf selected as its own viewer tab (${JSON.stringify(view.vtab)})`);

  // the run completes; the artifact broadcast (stubbed WS → pushed by hand)
  // reloads the pane in place, exactly as the live artifact watcher would
  const st = await sb.poll('/api/state', (s) => ['done', 'error'].includes(s.runs?.alpha?.state)
    && s.artifacts?.some((a) => a.project === 'alpha' && a.rel === 'paper.pdf'), { timeoutMs: 60000, everyMs: 250 });
  assert.equal(st.runs.alpha.state, 'done', JSON.stringify(st.runs.alpha));
  const art = st.artifacts.find((a) => a.project === 'alpha' && a.rel === 'paper.pdf');
  await wsPush('artifact:new', { artifact: art });
  await page.waitForSelector('#v-alpha .pdfPane.artFrame canvas', { timeout: 20000 });
});

test('the ▶ output tab shows the build card, not the log spew — with the log one disclosure away', texOpts, async () => {
  // the ▶ button routes .tex to the watch now, so drive the one-shot runner
  // directly over the API — the run machinery still serves it. Clear build
  // products first: an up-to-date run announces no passes and no pages.
  for (const ext of ['pdf', 'aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz']) {
    fs.rmSync(path.join(sb.projRoots.alpha, `paper.${ext}`), { force: true });
  }
  const run = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'paper.tex' });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  await sb.poll('/api/state', (s) => ['done', 'error'].includes(s.runs?.alpha?.state), { timeoutMs: 60000, everyMs: 250 });
  // reload: applyState adopts the finished run AND its server-kept tail (the
  // stubbed WS means the live run:stream chunks never reached this page)
  await page.reload();
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#v-alpha .sessTabs .stab[data-st="run"]')?.click(); });
  await sleep(300);
  const card = await page.evaluate(() => {
    const c = document.querySelector('#v-alpha .texRunCard');
    const pre = document.querySelector('#v-alpha #runPre');
    const det = document.querySelector('#v-alpha .texRunBody > .trLog');
    return {
      cls: c?.className, head: c?.querySelector('.trHead')?.textContent.trim(),
      preHidden: pre ? !pre.checkVisibility() : null,
      detOpen: det?.open,
    };
  });
  assert.match(card.cls, /\bok\b/, `clean compile → ✓ card (${card.cls})`);
  assert.match(card.head, /compiled clean/, 'verdict headline');
  assert.match(card.head, /\d+(\.\d+)?s · 12 pages/, `seconds + page count (${JSON.stringify(card.head)})`);
  assert.equal(card.detOpen, false, 'full log starts collapsed');
  assert.equal(card.preHidden, true, 'no raw latexmk spew in sight');
  // the raw log is still all there behind the disclosure
  await page.evaluate(() => { document.querySelector('#v-alpha .texRunBody > .trLog').open = true; });
  const log = await page.evaluate(() => document.querySelector('#v-alpha #runPre')?.textContent || '');
  assert.match(log, /This is pdfTeX|Latexmk/, 'the full latexmk log survives behind ▸');
});

test('a ▶-run pdf shown as an ARTIFACT tab carries the same bar + verdict', texOpts, async (t) => {
  // pin the compiled pdf so it opens as a pdfart viewer tab (one-shot runs
  // show their pdf this way — the live watch is a separate machine)
  const r = await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, {
    context: { files: ['paper.tex', 'model.jl', 'paper.pdf'] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  t.after(() => sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, {
    context: { files: ['paper.tex', 'model.jl'] },
  }));
  await page.reload();
  await page.waitForSelector('#v-alpha .pdfPane.artFrame canvas', { timeout: 20000 });
  await sleep(400);

  // the finished clean run (adopted from the snapshot) already stamps ✓ + seconds
  const chipSel = '#v-alpha .pdfPane.artFrame .pdfVerdict';
  let chip = await page.evaluate((s) => {
    const c = document.querySelector(s);
    return c && c.style.display !== 'none' ? { cls: c.className, text: c.textContent.trim() } : null;
  }, chipSel);
  assert.ok(chip, 'verdict chip present on the artifact pane');
  assert.match(chip.cls, /\bok\b/, `finished run → green chip (${chip?.cls})`);
  assert.match(chip.text, /^✓ \d+(\.\d+)?s$/, `✓ + compile seconds (${JSON.stringify(chip.text)})`);

  // a new run starts → the artifact pane goes into building mode too
  const t0 = new Date().toISOString();
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'running', startedAt: t0 },
  });
  await sleep(300);
  await wsPush('run:status', { // pass ping rides the in-place path
    project: 'alpha',
    run: { rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'running', startedAt: t0, pass: { n: 2, rule: 'pdflatex' } },
  });
  await sleep(250);
  const busy = await page.evaluate((s) => {
    const c = document.querySelector(s);
    const bar = document.querySelector('#v-alpha .pdfPane.artFrame .pdfBuildBar');
    return {
      cls: c?.className, text: c?.textContent.trim(),
      barOff: bar?.classList.contains('off'),
      barP: bar?.firstElementChild.style.getPropertyValue('--p'),
    };
  }, chipSel);
  assert.match(busy.cls, /\bbld\b/, 'compiling → blue chip on the artifact pane');
  assert.match(busy.text, /pdflatex · pass 2/, `pass label (${JSON.stringify(busy.text)})`);
  assert.equal(busy.barOff, false, 'staged bar riding the artifact pane');
  assert.equal(busy.barP, '0.86', 'creeping continuously toward the next stop');

  // run lands clean → ✓ + seconds persists
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'done', startedAt: t0, exitCode: 0, ms: 1400, pages: 1, counts: { errors: 0, warnings: 0, badboxes: 0 }, problems: [] },
  });
  await sleep(700);
  chip = await page.evaluate((s) => {
    const c = document.querySelector(s);
    const bar = document.querySelector('#v-alpha .pdfPane.artFrame .pdfBuildBar');
    return { cls: c?.className, text: c?.textContent.trim(), barOff: bar?.classList.contains('off') };
  }, chipSel);
  assert.match(chip.cls, /\bok\b/, 'done → green chip');
  assert.equal(chip.text, '✓ 1.4s', `seconds from the run (${JSON.stringify(chip.text)})`);
  assert.equal(chip.barOff, true, 'bar completed and faded');

  // toolbar stability: paging 9 → 10 grows the indicator by a digit — the
  // verdict chip (and everything left of it) must not move a pixel
  const at = (n) => page.evaluate((pg) => {
    const pane = window.__pdfPanes['alpha::paper.pdf'];
    pane.scrollToPage(pg);
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = pane.el;
      res({
        pageTxt: el.querySelector('.pdfPageNo').textContent,
        chipX: el.querySelector('.pdfVerdict').getBoundingClientRect().x,
        fitX: el.querySelector('.pzPct').getBoundingClientRect().x,
      });
    })));
  }, n);
  const p1d = await at(3);   // 1-digit current page
  const p2d = await at(11);  // 2-digit current page
  assert.equal(p1d.pageTxt, '3 / 12', 'a jump reports the page it landed on');
  assert.equal(p2d.pageTxt, '11 / 12', 'never the sliver of the page before it');
  assert.ok(Math.abs(p1d.chipX - p2d.chipX) < 0.5,
    `verdict chip pinned across the digit boundary (${p1d.chipX} → ${p2d.chipX})`);
  assert.ok(Math.abs(p1d.fitX - p2d.fitX) < 0.5, 'zoom controls pinned too');

  // clicking the verdict opens the ▶ output pane — the card holds the story
  await page.click('#v-alpha .pdfPane.artFrame .pdfVerdict');
  await sleep(300);
  const onTab = await page.evaluate(() =>
    document.querySelector('#v-alpha .sessTabs .stab.on')?.dataset.st);
  assert.equal(onTab, 'run', 'verdict click lands on ▶ output');

  // page-jump input: the current page arrives preselected — no cryptic "p"
  const pn = '#v-alpha .pdfPane.artFrame .pdfPageNo';
  await page.click(pn);
  const inp = await page.evaluate((s) => {
    const i = document.querySelector(`${s} input.pzJump`);
    return i ? {
      value: i.value,
      selected: i.selectionEnd - i.selectionStart === i.value.length,
      placeholder: i.placeholder,
    } : null;
  }, pn);
  assert.ok(inp, 'jump input appears');
  assert.equal(inp.value, '11', `prefilled with the current page (${JSON.stringify(inp.value)})`);
  assert.equal(inp.selected, true, 'preselected — typing replaces it');
  assert.equal(inp.placeholder, '', 'no placeholder letter');
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await sleep(300);
  const label = await page.evaluate((s) => document.querySelector(s).textContent, pn);
  assert.equal(label, '10 / 12', `Enter lands EXACTLY on the typed page (${JSON.stringify(label)})`);

  // and the 2×click hint is gone (the dblclick synctex jump itself remains)
  assert.ok(!(await page.$('#v-alpha .pdfPane.artFrame .pdfHint')), 'no toolbar hint');

  // the page number holds the SAME right-edge spot whether or not the verdict
  // chip is showing — before the first compile it must not pack left
  const edges = await page.evaluate(() => {
    const tb = document.querySelector('#v-alpha .pdfPane.artFrame .pdfToolbar');
    const pn = tb.querySelector('.pdfPageNo');
    const v = tb.querySelector('.pdfVerdict');
    const withChip = pn.getBoundingClientRect().right;
    v.hidden = true; // the pre-first-compile look
    const withoutChip = pn.getBoundingClientRect().right;
    const chipGone = getComputedStyle(v).display === 'none';
    v.hidden = false;
    return { withChip, withoutChip, chipGone };
  });
  assert.ok(edges.chipGone, '[hidden] actually hides the chip');
  assert.ok(Math.abs(edges.withChip - edges.withoutChip) < 0.5,
    `page number anchored to the same side either way (${edges.withChip} vs ${edges.withoutChip})`);
});

test('a failing .tex run: ✗ card with click-to-jump error rows (synthetic states)', opts, async () => {
  const t0 = new Date().toISOString();
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'running', startedAt: t0, ms: null },
  });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#v-alpha .sessTabs .stab[data-st="run"]')?.click(); });
  await sleep(250);
  let card = await page.evaluate(() => document.querySelector('#v-alpha .texRunCard')?.textContent || '');
  assert.match(card, /compiling paper\.tex/, 'compiling headline');
  assert.match(card, /starting…/, 'pre-pass chip');

  // a pass ping patches the chips in place (running → running)
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'running', startedAt: t0, pass: { n: 2, rule: 'pdflatex' } },
  });
  await sleep(250);
  const stage = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('#v-alpha #texRunStage .trChip')].map((c) => c.textContent.trim()),
    p: document.querySelector('#v-alpha .trTrack .fill')?.style.getPropertyValue('--p'),
  }));
  assert.deepEqual(stage.chips, ['pass 1 ✓', 'pdflatex · pass 2'], `honest pass chips (${JSON.stringify(stage.chips)})`);
  assert.equal(stage.p, '0.86', 'card bar creeping toward the pass-3 stop (continuous motion)');

  await wsPush('run:status', {
    project: 'alpha',
    run: {
      rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'error', startedAt: t0,
      exitCode: 12, ms: 912, pass: null,
      problems: [
        { file: 'paper.tex', line: 3, kind: 'error', message: 'Undefined control sequence.' },
        { file: 'paper.tex', line: 4, kind: 'warning', message: 'Font shape undefined' },
      ],
      counts: { errors: 1, warnings: 1, badboxes: 0 },
    },
  });
  await sleep(300);
  card = await page.evaluate(() => document.querySelector('#v-alpha .texRunCard')?.textContent || '');
  assert.match(card, /✗\s*1 error — no PDF/, `error headline (${JSON.stringify(card.slice(0, 60))})`);
  assert.match(card, /0\.9s/, 'fail seconds');
  assert.match(card, /paper\.tex:3/, 'error row with file:line');
  assert.ok(!card.includes('Font shape'), 'warnings stay in the strip, not the card');

  // clicking the row jumps the editor to the line
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console')?.click(); });
  await sleep(200);
  await page.click('#v-alpha .trProb');
  await sleep(400);
  const ed = await page.evaluate(() => {
    const e = document.querySelector('#v-alpha #codeEditor');
    return e ? { ext: e.dataset.ext, line: window.__mp.getPosition().line } : null;
  });
  assert.equal(ed?.ext, 'tex', 'row click opened the .tex');
  assert.equal(ed?.line, 3, `caret on the failing line (${ed?.line})`);
});

test('non-tex runs keep the live output stream (that output you do read)', opts, async () => {
  await wsPush('run:status', {
    project: 'alpha',
    run: { rel: 'model.jl', cmdLine: 'julia model.jl', state: 'running', startedAt: new Date().toISOString() },
  });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#v-alpha .sessTabs .stab[data-st="run"]')?.click(); });
  await sleep(200);
  const shape = await page.evaluate(() => ({
    card: !!document.querySelector('#v-alpha .texRunCard'),
    pre: !!document.querySelector('#v-alpha #runPre'),
    preVisible: document.querySelector('#v-alpha #runPre')?.checkVisibility() || false,
  }));
  assert.equal(shape.card, false, 'no build card for julia');
  assert.ok(shape.pre && shape.preVisible, 'raw stream pane visible as before');
});

test('PDF reload storms reuse one worker and pane destruction releases it', texOpts, async () => {
  // Pick either retained PDF pane from the suite. Both use the same lifecycle;
  // the artifact pane is preferred because its normal path reloads on builds.
  const key = await page.evaluate(() => (
    window.__pdfPanes['alpha::paper.pdf']?.doc
      ? 'alpha::paper.pdf'
      : Object.keys(window.__pdfPanes).find((k) => window.__pdfPanes[k]?.doc)
  ));
  assert.ok(key, 'a loaded PDF pane is available for the lifecycle probe');
  const workersBefore = page.workers().length;
  assert.ok(workersBefore >= 1, 'the loaded pane owns a real PDF worker');

  const result = await page.evaluate(async (paneKey) => {
    const pane = window.__pdfPanes[paneKey];
    const firstWorker = pane.worker;
    for (let i = 0; i < 12; i++) {
      await pane.load(`/artifact/alpha/paper.pdf?worker-reload=${i}`, {
        keepPlace: true,
        builtStamp: `worker-reload-${i}`,
      });
    }
    return {
      sameWorker: pane.worker === firstWorker,
      hasTask: !!pane.loadingTask,
      workerDestroyed: pane.worker?.destroyed,
    };
  }, key);
  assert.equal(result.sameWorker, true, 'every reload reused the pane worker');
  assert.equal(result.hasTask, true, 'the current document retains its owning loading task');
  assert.equal(result.workerDestroyed, false, 'the live pane worker remains usable');
  assert.equal(page.workers().length, workersBefore, '12 reloads created zero additional workers');

  // Delayed previous-document cleanup is intentionally two seconds so old
  // pixels can cover the repaint; after that, no retired transport remains.
  await sleep(2300);
  const retired = await page.evaluate((paneKey) => window.__pdfPanes[paneKey].retiredTasks.size, key);
  assert.equal(retired, 0, 'superseded document tasks were destroyed after repaint');

  await page.evaluate(async (paneKey) => {
    const pane = window.__pdfPanes[paneKey];
    window.__lastPdfTask = pane.loadingTask;
    await pane.destroy();
    delete window.__pdfPanes[paneKey];
  }, key);
  await sleep(150);
  assert.equal(page.workers().length, workersBefore - 1, 'pane destruction terminated its worker');
  assert.equal(
    await page.evaluate(() => window.__lastPdfTask?.destroyed),
    true,
    'pane destruction destroyed the current loading task',
  );
});

/* ── Phase 3 S2.6 (monaco-s2 §2): the run-card KEEP contract, near-verbatim
   under BOTH editor implementations — a failing .tex run (synthetic states,
   no latexmk) renders the ✗ card and the error-row click jumps the editor
   to the failing line. Only the caret read moves: selectionStart math under
   legacy, __mp.getPosition() (the frozen P7 seam) under monaco, where the
   row click funnels texOpenAt → revealAt (the S2.5 wiring). Declared last:
   the shared-page tests above are order-dependent; the synthetic run state
   lives only in this pass's page. */
testMonaco('run-card dual: a failing .tex run renders the ✗ card; the error-row click jumps the editor to the line', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const FKP = 'alpha::paper.tex';
  await ed.wait(page, FKP);
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, null, { timeout: 15000 });
  const t0 = new Date().toISOString();
  await wsPushTo(page, 'run:status', {
    project: 'alpha',
    run: {
      rel: 'paper.tex', cmdLine: 'latexmk -pdf paper.tex', state: 'error', startedAt: t0,
      exitCode: 12, ms: 912, pass: null,
      problems: [{ file: 'paper.tex', line: 3, kind: 'error', message: 'Undefined control sequence.' }],
      counts: { errors: 1, warnings: 0, badboxes: 0 },
    },
  });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#v-alpha .sessTabs .stab[data-st="run"]')?.click(); });
  await page.waitForSelector('#v-alpha .texRunCard', { timeout: 5000 });
  const card = await page.evaluate(() => document.querySelector('#v-alpha .texRunCard')?.textContent || '');
  assert.match(card, /✗\s*1 error — no PDF/, `error headline (${JSON.stringify(card.slice(0, 60))})`);
  assert.match(card, /paper\.tex:3/, 'error row with file:line');

  // park the center on the console, then let the row click reopen the editor
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console')?.click(); });
  await sleep(200);
  await page.click('#v-alpha .trProb');
  await ed.wait(page, FKP); // the jump reopens the editor tab under either impl
  await sleep(400);
  if (impl === 'monaco') {
    const pos = await page.evaluate(() => window.__mp.getPosition());
    assert.equal(pos?.line, 3, `caret on the failing line (${JSON.stringify(pos)})`);
  } else {
    const s = await page.evaluate(() => {
      const e = document.querySelector('#v-alpha #codeEditor');
      return { ext: e.dataset.ext, line: window.__mp.getPosition().line };
    });
    assert.equal(s.ext, 'tex', 'row click opened the .tex');
    assert.equal(s.line, 3, `caret on the failing line (${s.line})`);
  }
});
