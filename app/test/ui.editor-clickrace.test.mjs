// The click-vs-rebuild race (docs/editor-click-race-diagnosis.txt): build
// transitions re-render the workbench; the editor stack rebuilds with the
// overlay PAINTED at mount (pan 0) and the textarea's viewport restored
// afterwards — and Chrome delivers queued input ahead of the async scroll
// re-sync. A click in that window used to resolve through top-of-file
// geometry: caret set hundreds of lines from the aim, next keystrokes
// splicing into the wrong place, editor yanked to the top by caret-follow.
// Three nets:
// 1) pointer guard — a click on a deliberately mis-panned overlay still
//    resolves against the view the TEXTAREA's scroll describes;
// 2) restore invariant — after a WS-driven rebuild there is no tick where
//    the overlay is painted but panned away from the restored textarea;
// 3) storyline — build lands mid-flow, then click + type stays on the
//    aimed line and the file head survives untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };

const TEX = '\\documentclass{article}\n\\begin{document}\nBody here.\n\\end{document}\n'
  + Array.from({ length: 90 }, (_, i) => `% filler line number ${i + 1} with some words to click on`).join('\n') + '\n';

let ui, sb, page, wsPush, task;
before(async () => {
  if (!fs.existsSync(CHROME)) return;
  ui = await startUI({ seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'p.tex'), TEX) });
  ({ sb, page, wsPush } = ui);
  task = (await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'T', category: 'calibration', oversight: 'manual',
    context: { files: ['p.tex'] },
  })).body;
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

const scrollDeep = () => page.evaluate(() => {
  const ed = document.querySelector('#v-alpha #codeEditor');
  ed.focus();
  ed.scrollTop = ed.scrollHeight * 0.7;
  return Math.round(ed.scrollTop);
});
// a deep line's visible glyphs, in viewport px — what the user aims at
const aimDeep = () => page.evaluate(() => {
  const wrap = document.querySelector('#v-alpha .edWrap');
  const code = wrap.querySelector('pre.codeHL code');
  const edr = wrap.querySelector('#codeEditor').getBoundingClientRect();
  for (const ln of code.children) {
    const r = ln.getBoundingClientRect();
    if (r.top > edr.top + 150 && r.bottom < edr.bottom - 150 && r.width > 200) {
      return { x: r.left + 100, y: r.top + r.height / 2, text: ln.textContent.replace(/\n$/, '') };
    }
  }
  return null;
});
const caretLine = () => page.evaluate(() => {
  const ed = document.querySelector('#v-alpha #codeEditor');
  const a = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
  const b = ed.value.indexOf('\n', a);
  return { line: ed.value.slice(a, b < 0 ? undefined : b), sel: ed.selectionStart, st: Math.round(ed.scrollTop) };
});

test('a click on a mis-panned overlay resolves against the textarea\'s view', opts, async () => {
  await scrollDeep();
  await sleep(150); // let the scroll-event hlSync settle the layers
  const aim = await aimDeep();
  assert.ok(aim, 'a deep line is visible to aim at');
  // adversarial stale state: painted overlay at pan 0, textarea still deep —
  // exactly what a background rebuild leaves until the async re-sync lands
  await page.evaluate(() => {
    const wrap = document.querySelector('#v-alpha .edWrap');
    wrap.querySelector('pre.codeHL').scrollTop = 0;
  });
  await page.mouse.click(aim.x, aim.y);
  await sleep(60);
  const got = await caretLine();
  assert.ok(got.line.startsWith(aim.text.slice(0, 24)),
    `caret landed on the aimed line (aimed "${aim.text.slice(0, 24)}", got "${got.line.slice(0, 24)}")`);
  const pans = await page.evaluate(() => {
    const wrap = document.querySelector('#v-alpha .edWrap');
    return Math.abs(wrap.querySelector('pre.codeHL').scrollTop
      - wrap.querySelector('#codeEditor').scrollTop);
  });
  assert.ok(pans <= 1, `layers re-aligned by the guard (Δpan ${pans}px)`);
});

test('after a WS-driven rebuild the overlay is never painted-but-mis-panned', opts, async () => {
  await scrollDeep();
  await sleep(150);
  // dispatch the rebuild and probe SYNCHRONOUSLY — same task, before any
  // scroll event or rAF can repair a stale pan
  const r = await page.evaluate((t) => {
    window.__ws.onmessage({ data: JSON.stringify({ type: 'task:update', payload: { project: 'alpha', task: t } }) });
    const wrap = document.querySelector('#v-alpha .edWrap');
    const ed = wrap.querySelector('#codeEditor');
    const pre = wrap.querySelector('pre.codeHL');
    return {
      kids: pre.querySelector('code').children.length,
      edSt: Math.round(ed.scrollTop),
      hlSt: Math.round(pre.scrollTop),
    };
  }, task);
  assert.ok(r.edSt > 300, `viewport restored deep (ed.scrollTop ${r.edSt})`);
  assert.ok(r.kids === 0 || Math.abs(r.hlSt - r.edSt) <= 1,
    `no stale window: overlay unpainted or panned with the textarea (kids ${r.kids}, ed ${r.edSt}, hl ${r.hlSt})`);
});

test('build lands mid-flow: click + type stays on the aimed line, file head intact', opts, async () => {
  await scrollDeep();
  await sleep(150);
  const entry = (over) => ({ project: 'alpha', entry: { tex: 'p.tex', pdf: 'p.pdf', problems: [], counts: { errors: 0 }, ...over } });
  await wsPush('pdf:status', entry({ state: 'building', pass: { n: 1, rule: 'pdflatex' } }));
  await wsPush('pdf:status', entry({ state: 'built', lastBuildMs: 900, lastBuiltAt: Date.now(), pages: 1 }));
  await sleep(120);
  const aim = await aimDeep();
  assert.ok(aim, 'a deep line is visible after the build transitions');
  await page.mouse.click(aim.x, aim.y);
  await sleep(60);
  await page.keyboard.type('zz');
  const v = await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    const a = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
    const b = ed.value.indexOf('\n', a);
    return { line: ed.value.slice(a, b < 0 ? undefined : b), head: ed.value.slice(0, 22) };
  });
  assert.ok(v.line.includes('zz'), `typed text landed on the clicked line ("${v.line.slice(0, 30)}")`);
  assert.equal(v.head, '\\documentclass{article', 'file head untouched — no top-of-file splice');
});
