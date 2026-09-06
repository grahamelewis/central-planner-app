// The tex compile button lives in the PDF pane's TOOLBAR (v2.11 — texrun
// mockup 02): ▶ leads the − fit ＋ zoom cluster in ONE fixed 34px box that
// swaps glyph + color only (▶ idle / ⊘ while its one-shot run is live), with
// an amber corner dot when the tex source has an unsaved draft. The editor
// foot only BOOTSTRAPS a never-compiled doc, then yields for good; its save
// note is now a fixed-width chip (saved/unsaved/⚠ disk — dot changes, box
// never does), and ▶ run/⊘ stop share one box for every runnable.
// Billing-safe: /api/run + GET routes + wsPush only — no billed dispatch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startUI, sleep, CHROME, testMonaco, edDriver } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const hasTex = (() => { try { execSync('command -v latexmk', { stdio: 'ignore' }); return true; } catch { return false; } })();
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const texOpts = { skip: !hasChrome ? 'Google Chrome not installed' : !hasTex ? 'latexmk not installed' : false };

// body text must stay underscore-free — a raw _ is a LaTeX error
const DOC = '\\documentclass{article}\n\\begin{document}\nFixed geometry, moving type.\n\\input{appendix}\n\\end{document}\n';
const APPENDIX = '\\section{Included appendix}\nA document-owned input.\n';

let ui, sb, page, wsPush, texPath, appendixPath;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), DOC);
      fs.writeFileSync(path.join(projRoots.alpha, 'appendix.tex'), APPENDIX);
    },
  });
  ({ sb, page, wsPush } = ui);
  texPath = path.join(sb.projRoots.alpha, 'paper.tex');
  appendixPath = path.join(sb.projRoots.alpha, 'appendix.tex');
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'toolbar compile', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex', 'appendix.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

test('foot ▶/⊘ share one fixed box — a starting run shifts nothing', opts, async () => {
  const w0 = await page.evaluate(() => {
    const b = document.querySelector('#runFileBtn');
    return b ? { w: b.getBoundingClientRect().width, txt: b.textContent } : null;
  });
  assert.ok(w0, 'bootstrap ▶ present for the never-compiled tex');
  assert.match(w0.txt, /▶ run/);
  // a run starting elsewhere in the project (stubbed WS, as another client
  // would see it) flips the button to ⊘ stop — same box, new glyph/color
  const t0 = new Date().toISOString();
  await wsPush('run:status', { project: 'alpha', run: { rel: 'other.jl', state: 'running', startedAt: t0 } });
  await sleep(350);
  const s1 = await page.evaluate(() => {
    const b = document.querySelector('#runFileBtn');
    return { w: b.getBoundingClientRect().width, txt: b.textContent, running: !!b.dataset.running };
  });
  assert.ok(s1.running && /⊘ stop/.test(s1.txt), `flips to ⊘ stop (${JSON.stringify(s1.txt)})`);
  assert.ok(Math.abs(s1.w - w0.w) < 0.6, `constant width: ${w0.w} → ${s1.w}`);
  await wsPush('run:status', { project: 'alpha', run: { rel: 'other.jl', state: 'done', startedAt: t0, ms: 10, exitCode: 0 } });
  await sleep(350);
});

test('the save chip: constant box, the dot flips, a click saves', opts, async () => {
  const clean = await page.evaluate(() => {
    const c = document.querySelector('#saveState');
    return { w: c.getBoundingClientRect().width, txt: c.textContent, cls: c.className };
  });
  assert.match(clean.cls, /saveChip/);
  assert.ok(!/unsaved/.test(clean.txt) && /saved/.test(clean.txt), `clean chip says saved (${JSON.stringify(clean.txt)})`);
  await page.click('#codeEditor');
  await page.evaluate(() => {
    window.__mp.focus(); const lines = window.__mp.getText().split('\n');
    window.__mp.setPosition(lines.length, lines.at(-1).length + 1);
  });
  await page.keyboard.type('% chip test\n');
  await sleep(300);
  const dirty = await page.evaluate(() => {
    const c = document.querySelector('#saveState');
    return { w: c.getBoundingClientRect().width, txt: c.textContent, cls: c.className };
  });
  assert.match(dirty.cls, /dirty/, 'chip flagged dirty');
  assert.match(dirty.txt, /unsaved/, 'chip says unsaved');
  assert.ok(Math.abs(dirty.w - clean.w) < 0.6, `constant width: ${clean.w} → ${dirty.w}`);
  await page.click('#saveState'); // the chip itself saves — no popping button
  await sleep(600);
  assert.match(fs.readFileSync(texPath, 'utf8'), /% chip test/, 'chip click wrote the draft to disk');
  const after1 = await page.evaluate(() => document.querySelector('#saveState').textContent);
  assert.ok(!/unsaved/.test(after1) && /saved/.test(after1), 'chip settles back to saved');
});

test('▶ bootstraps the first compile, then hands off to the pane toolbar for good', texOpts, async () => {
  await page.click('#runFileBtn');
  await sleep(400);
  const st = await sb.poll('/api/state', (s) => s.runs?.alpha?.state === 'done'
    && s.artifacts?.some((a) => a.project === 'alpha' && a.rel === 'paper.pdf'), { timeoutMs: 60000, everyMs: 250 });
  await wsPush('run:status', { project: 'alpha', run: st.runs.alpha });
  await wsPush('artifact:new', { artifact: st.artifacts.find((a) => a.rel === 'paper.pdf') });
  await sleep(450);
  const s = await page.evaluate(() => {
    const r = document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun');
    return {
      footBtn: !!document.querySelector('#runFileBtn'),
      pz: r ? { hidden: r.hidden, glyph: r.firstElementChild.textContent, w: r.getBoundingClientRect().width } : null,
    };
  });
  assert.ok(!s.footBtn, 'the foot ▶ retired — this doc has a pane now');
  assert.ok(s.pz && !s.pz.hidden, 'toolbar ▶ revealed (tex-backed probe)');
  assert.equal(s.pz.glyph, '▶', 'idle glyph');
  assert.ok(Math.abs(s.pz.w - 34) < 2.5, `the fixed 34px box (${s.pz.w})`);
});

test('toolbar ▶ recompiles (⊘ mid-run, same box) and the corner dot tracks the draft', texOpts, async () => {
  // dirty the tex → the pane control grows its amber corner dot
  await page.click('#codeEditor');
  await page.evaluate(() => {
    window.__mp.focus(); const lines = window.__mp.getText().split('\n');
    window.__mp.setPosition(lines.length, lines.at(-1).length + 1);
  });
  await page.keyboard.type('% via toolbar\n');
  await sleep(300);
  const dot = await page.evaluate(() =>
    document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun')?.className || '');
  assert.match(dot, /dirty/, 'unsaved tex draft → amber dot on the toolbar ▶');
  // clear build products so the recompile does real passes
  for (const ext of ['pdf', 'aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz']) {
    fs.rmSync(path.join(sb.projRoots.alpha, `paper.${ext}`), { force: true });
  }
  const w0 = await page.evaluate(() =>
    document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun').getBoundingClientRect().width);
  await page.click('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun'); // saves the draft, then compiles
  await sleep(600);
  // the client's view stays "running" until the (stubbed) socket says done —
  // deterministic window to check the ⊘ state
  const mid = await page.evaluate(() => {
    const r = document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun');
    return { glyph: r.firstElementChild.textContent, w: r.getBoundingClientRect().width, cls: r.className };
  });
  assert.equal(mid.glyph, '⊘', 'mid-run the same box is the stop control');
  assert.match(mid.cls, /running/);
  assert.ok(Math.abs(mid.w - w0) < 0.6, `constant width: ${w0} → ${mid.w}`);
  assert.match(fs.readFileSync(texPath, 'utf8'), /% via toolbar/, '▶ saved the draft before compiling');
  const st = await sb.poll('/api/state', (s) => ['done', 'error'].includes(s.runs?.alpha?.state), { timeoutMs: 60000, everyMs: 250 });
  assert.equal(st.runs.alpha.state, 'done', JSON.stringify(st.runs.alpha));
  await wsPush('run:status', { project: 'alpha', run: st.runs.alpha });
  await sleep(350);
  const end = await page.evaluate(() => {
    const r = document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun');
    return { glyph: r.firstElementChild.textContent, cls: r.className };
  });
  assert.equal(end.glyph, '▶', 'back to ▶ when the run lands');
  assert.ok(!/dirty/.test(end.cls), 'dot cleared — the draft was saved by the run');
});

test('document ▶ saves a dirty included file, then compiles the viewer root', texOpts, async () => {
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#v-alpha .ctab.cd')];
    tabs.find((t) => /appendix\.tex/.test(t.textContent))?.click();
  });
  await page.waitForSelector('#codeEditor[data-rel="appendix.tex"]');
  await page.evaluate(() => {
    window.__mp.focus(); const lines = window.__mp.getText().split('\n');
    window.__mp.setPosition(lines.length, lines.at(-1).length + 1);
  });
  await page.keyboard.type('% dependency transaction\n');
  await sleep(250);
  assert.doesNotMatch(fs.readFileSync(appendixPath, 'utf8'), /dependency transaction/, 'draft is browser-only before compile');
  assert.match(
    await page.evaluate(() => document.querySelector('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun').className),
    /dirty/,
    'the PDF toolbar marks a dirty included input, not only a dirty root',
  );

  const before = (await sb.fetchJson('GET', '/api/state')).body.runs?.alpha?.startedAt;
  await page.click('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun');
  const st = await sb.poll('/api/state', (s) => ['done', 'error'].includes(s.runs?.alpha?.state)
    && s.runs.alpha.rel === 'paper.tex' && s.runs.alpha.startedAt !== before,
  { timeoutMs: 60000, everyMs: 100 });
  assert.equal(st.runs.alpha.state, 'done', JSON.stringify(st.runs.alpha));
  assert.match(fs.readFileSync(appendixPath, 'utf8'), /dependency transaction/, 'included draft saved before the root run');
  await wsPush('run:status', { project: 'alpha', run: st.runs.alpha });
  await sleep(250);
});

test('a fast terminal WebSocket state cannot regress to the POST running acknowledgement', texOpts, async () => {
  await page.evaluate(() => {
    const realFetch = window.fetch;
    window.__restoreRunFetch = () => { window.fetch = realFetch; };
    window.fetch = async (...args) => {
      const res = await realFetch(...args);
      const method = String(args[1]?.method || 'GET').toUpperCase();
      if (String(args[0]).includes('/api/run') && method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return res;
    };
  });
  try {
    const before = (await sb.fetchJson('GET', '/api/state')).body.runs?.alpha?.startedAt;
    await page.click('#v-alpha .pdfPane.artFrame:not(.vhid) .pzRun');
    const st = await sb.poll('/api/state', (s) => ['done', 'error'].includes(s.runs?.alpha?.state)
      && s.runs.alpha.rel === 'paper.tex' && s.runs.alpha.startedAt !== before,
    { timeoutMs: 60000, everyMs: 50 });
    assert.equal(st.runs.alpha.state, 'done', JSON.stringify(st.runs.alpha));
    await wsPush('run:status', { project: 'alpha', run: st.runs.alpha });
    await sleep(950); // let the deliberately late POST continuation run
    const pane = await page.evaluate(() => {
      const p = window.__pdfPanes['alpha::paper.pdf'];
      const run = p.el.querySelector('.pzRun');
      const bar = p.el.querySelector('.pdfBuildBar');
      const verdict = p.el.querySelector('.pdfVerdict');
      return {
        glyph: run.firstElementChild.textContent,
        running: run.classList.contains('running'),
        barOff: bar.classList.contains('off'),
        verdict: verdict.textContent,
      };
    });
    assert.equal(pane.glyph, '▶', 'terminal run remains idle, never stale ⊘');
    assert.equal(pane.running, false, 'late HTTP ack did not restore running state');
    assert.equal(pane.barOff, true, 'completed bar is not frozen at 40%');
    assert.match(pane.verdict, /✓/, 'terminal verdict survives the late acknowledgement');
  } finally {
    await page.evaluate(() => window.__restoreRunFetch?.());
  }
});

test('the live-watch pane grows the ▶ too — save-now semantics in its tooltip', texOpts, async () => {
  await wsPush('pdf:status', {
    project: 'alpha',
    entry: {
      tex: texPath, pdf: path.join(sb.projRoots.alpha, 'paper.pdf'),
      state: 'built', pass: 2, lastBuildMs: 900, lastBuiltAt: new Date().toISOString(),
    },
  });
  await sleep(400);
  // surface the live-watch viewer tab so its pane mounts
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#v-alpha .vtabs .ptab.vw')];
    (tabs.find((t) => t.dataset.vk === 'pdf') || tabs.find((t) => /live/i.test(t.textContent)))?.click();
  });
  await sleep(450);
  const s = await page.evaluate(() => {
    const r = document.querySelector('#v-alpha #pdfPaneHost .pzRun');
    return r ? { hidden: r.hidden, glyph: r.firstElementChild.textContent, title: r.title } : null;
  });
  assert.ok(s && !s.hidden, 'watch pane toolbar carries the ▶');
  assert.equal(s.glyph, '▶', 'never ⊘ — the watch is not a stoppable one-shot');
  assert.match(s.title, /live watch recompiles on save/, 'tooltip states the save-now semantics');
});

/* ── Phase 3 S2.6 (P1/P13, monaco-s2 §2): the save-chip KEEP contract under
   BOTH editor implementations — constant box, the dot flips on genuine
   typing, and a CHIP CLICK saves through the impl's own machine (legacy
   files.saveFile body; monaco the M3 token queue via the S2.1 gate — this
   is the real-route complement to ui.monaco-save's stubbed rows). Dirty
   reads ride the chip + __mp (edDriver); contract verbatim. Declared last:
   the shared-page tests above are order-dependent; the disk marker is
   per-pass so the sibling pass never collides. */
testMonaco('save chip dual: constant box, dot flips on typing, a chip click saves to disk', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const FKP = 'alpha::paper.tex';
  await ed.wait(page, FKP);
  const clean = await page.evaluate(() => {
    const c = document.querySelector('#saveState');
    return { w: c.getBoundingClientRect().width, txt: c.textContent, cls: c.className };
  });
  assert.match(clean.cls, /saveChip/);
  assert.ok(!/unsaved/.test(clean.txt) && /saved/.test(clean.txt),
    `clean chip says saved (${JSON.stringify(clean.txt)})`);
  await ed.caretEnd(page);
  const mark = `% dual chip ${impl}`;
  await page.keyboard.type(`${mark}\n`);
  await page.waitForFunction(() =>
    /dirty/.test(document.querySelector('#saveState')?.className || ''), null, { timeout: 5000 });
  const dirty = await page.evaluate(() => {
    const c = document.querySelector('#saveState');
    return { w: c.getBoundingClientRect().width, txt: c.textContent, cls: c.className };
  });
  assert.match(dirty.txt, /unsaved/, 'chip says unsaved');
  assert.ok(Math.abs(dirty.w - clean.w) < 0.6, `constant width: ${clean.w} → ${dirty.w}`);
  await page.click('#saveState'); // the chip itself saves — no popping button
  await page.waitForFunction(() => {
    const c = document.querySelector('#saveState')?.className || '';
    return /saveChip/.test(c) && !/dirty/.test(c);
  }, null, { timeout: 10000 });
  assert.ok(fs.readFileSync(texPath, 'utf8').includes(mark), 'chip click wrote the draft to disk');
  assert.ok((await ed.text(page, FKP)).includes(mark), 'the buffer and disk agree');
});
