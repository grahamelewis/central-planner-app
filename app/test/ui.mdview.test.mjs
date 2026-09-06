// Rendered markdown in the show panel (headless Chrome, stubbed WS):
//   · a pinned .md opens in the editor with a ▤ preview button → a rendered
//     pane (marked + DOMPurify + KaTeX, console typography) in the show panel
//   · the pane LIVE-tracks the editor's unsaved draft as you type — patched
//     in place (same element, scroll kept), with an honest bar note
//   · relative images/links resolve against the file's folder; links open in
//     new tabs (never navigate the dashboard); no raw markdown leaks
//   · a session edit on disk (file:changed) refreshes a draft-less pane
// Tests share one staged project and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME, testMonaco, edDriver } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush;

const MD = `# Model notes

The **pass-through** at $p_e = 0.50$:

$$\\Phi = \\frac{d \\log C}{d \\log P}$$

- see [the calibration](calibration/fit.jl)

\`\`\`julia
fit = fit_income_block(0.50)
\`\`\`

Approximately (~97–98%) coverage ≤~2018; <b>inline html</b> and ~~done~~ both render.

![posterior](figs/posterior.png)

${'filler paragraph so the pane has real scroll range.\n\n'.repeat(40)}`;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.mkdirSync(path.join(projRoots.alpha, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'notes', 'model.md'), MD);
      fs.writeFileSync(path.join(projRoots.alpha, 'notes', 'disk.md'), '# Disk one\n\noriginal\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: t1 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Write up notes', description: 'x',
    category: 'calibration', oversight: 'coop', context: { files: ['notes/model.md'] },
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t1.id}`, { status: 'waiting' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.marked && window.DOMPurify, null, { timeout: 8000 }).catch(() => {});
  await sleep(800); // pinned file loads into the editor
});

after(async () => { if (ui) await ui.stop(); });

const pane = (rel = 'notes/model.md') => page.evaluate((r) => {
  const p = document.querySelector(`#v-alpha .mdPane[data-vk="${r}"]`);
  if (!p) return null;
  const body = p.querySelector('.mdBody');
  return {
    visible: !p.classList.contains('vhid'),
    h1: body.querySelector('h1')?.textContent || null,
    bolded: !!body.querySelector('strong'),
    katex: !!body.querySelector('.katex'),
    codeBlock: !!body.querySelector('pre'),
    imgSrc: body.querySelector('img')?.getAttribute('src') || null,
    linkHref: body.querySelector('a')?.getAttribute('href') || null,
    linkTarget: body.querySelector('a')?.target || null,
    rawStars: /\*\*/.test(body.textContent),
    text: body.textContent.slice(0, 400),
    scrollTop: p.scrollTop,
    kept: p._probe === 'kept',
  };
}, rel);

test('▤ preview renders the pinned .md: typography, math, code — no raw markdown', opts, async () => {
  assert.ok(await page.evaluate(() => !!document.querySelector('#mdPreviewBtn')),
    'md files in the editor offer ▤ preview');
  await page.click('#mdPreviewBtn');
  await sleep(800);
  const p = await pane();
  assert.ok(p, 'rendered pane mounted in the show panel');
  assert.ok(p.visible);
  assert.equal(p.h1, 'Model notes');
  assert.ok(p.bolded, 'markdown bold typesets');
  assert.ok(p.katex, 'KaTeX math typesets');
  assert.ok(p.codeBlock, 'fenced code typesets');
  assert.ok(!p.rawStars, 'no literal ** leaks');
  const tab = await page.evaluate(() =>
    [...document.querySelectorAll('#v-alpha .ptab.vw')].map(t => t.textContent.trim())
      .find(t => t.includes('model.md')));
  assert.match(tab, /^▤/, 'viewer tab wears the markdown glyph');
});

test('doc engine: single ~ stays literal, ~~ strikes, inline HTML still renders', opts, async () => {
  // the ~~-only del fix (docs/console-tilde-strikethrough-diagnosis.txt)
  // applies to the .md pane too, but unlike the console this pane KEEPS raw
  // HTML — it's a document viewer, GitHub-style
  const s = await page.evaluate(() => {
    const body = document.querySelector('#v-alpha .mdPane[data-vk="notes/model.md"] .mdBody');
    return {
      dels: [...body.querySelectorAll('del')].map(d => d.textContent),
      htmlBold: [...body.querySelectorAll('b')].some(b => /inline html/.test(b.textContent)),
      text: body.textContent,
    };
  });
  assert.deepEqual(s.dels, ['done'], 'only ~~…~~ becomes strikethrough');
  assert.match(s.text, /\(~97–98%\)/, '"approximately" tildes stay literal');
  assert.match(s.text, /≤~2018/, 'the would-be closer stays literal');
  assert.ok(s.htmlBold, 'real inline HTML still renders in the doc pane');
});

test('relative images and links resolve against the file folder; links open in new tabs', opts, async () => {
  const p = await pane();
  assert.equal(p.imgSrc, '/artifact/alpha/notes/figs/posterior.png');
  assert.equal(p.linkHref, '/artifact/alpha/notes/calibration/fit.jl');
  assert.equal(p.linkTarget, '_blank', 'links never navigate the dashboard away');
});

test('typing in the editor live-updates the pane IN PLACE — scroll and element kept', opts, async () => {
  await page.evaluate(() => {
    const p = document.querySelector('#v-alpha .mdPane[data-vk="notes/model.md"]');
    p._probe = 'kept';
    p.scrollTop = 30;
  });
  await page.click('#codeEditor');
  await page.evaluate(() => {
    window.__mp.focus(); window.__mp.setPosition(1, 1);
  });
  await page.keyboard.type('LIVE DRAFT LINE\n\n');
  await sleep(600); // 250ms debounce + render
  const p = await pane();
  assert.ok(p.text.includes('LIVE DRAFT LINE'), 'draft text renders without saving');
  assert.ok(p.kept, 'same pane element — patched, not rebuilt');
  assert.equal(p.scrollTop, 30, 'reader position survives the re-render');
  const note = await page.evaluate(() => document.querySelector('#v-alpha #mdSrcNote')?.textContent || '');
  assert.match(note, /unsaved draft/, 'the bar says the preview is the draft');
});

test('✎ source in the viewer bar jumps to the editor', opts, async () => {
  await page.click('#mdEditBtn');
  await sleep(400);
  assert.ok(await page.evaluate(() =>
    document.querySelector('#codeEditor')?.dataset.rel === 'notes/model.md'));
});

test('a ＋-added .md renders from disk and refreshes on file:changed', opts, async () => {
  await page.evaluate(() => {
    localStorage.setItem('addedViewers:alpha', JSON.stringify([{ rel: 'notes/disk.md', kind: 'md' }]));
  });
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600);
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .ptab.vw')].find(t => t.textContent.includes('disk.md'))?.click();
  });
  await sleep(700);
  let p = await pane('notes/disk.md');
  assert.match(p.text, /original/);
  // Claude edits it on disk mid-turn → the pane follows
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'notes', 'disk.md'), '# Disk one\n\nEDITED BY CLAUDE\n');
  await wsPush('file:changed', { project: 'alpha', rel: 'notes/disk.md' });
  await sleep(800);
  p = await pane('notes/disk.md');
  assert.match(p.text, /EDITED BY CLAUDE/);
  assert.ok(!/original/.test(p.text));
});

test('switching viewer tabs keeps the pane mounted (no re-render on return)', opts, async () => {
  await page.evaluate(() => {
    document.querySelector('#v-alpha .mdPane[data-vk="notes/disk.md"]')._probe = 'kept';
    // switch to another viewer tab and back
    [...document.querySelectorAll('#v-alpha .ptab.vw')].find(t => t.textContent.includes('model.md'))?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .ptab.vw')].find(t => t.textContent.includes('disk.md'))?.click();
  });
  await sleep(400);
  const p = await pane('notes/disk.md');
  assert.ok(p.visible);
  assert.ok(p.kept, 'the pane element survived the tab round-trip');
  assert.match(p.text, /EDITED BY CLAUDE/);
});

test('hostile markdown is sanitized: no script/style/handlers/javascript: URLs', opts, async () => {
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'notes', 'disk.md'), `# Still a heading

<script>window.__pwned = 1<\/script>

<img src=x onerror="window.__pwned = 2">

[harmless-looking](javascript:window.__pwned=3)

<style>.mdBody{ display:none }</style>

<div style="position:fixed; inset:0; background:red">styled overlay</div>

<iframe src="https://evil.example"></iframe>
`);
  await wsPush('file:changed', { project: 'alpha', rel: 'notes/disk.md' });
  await sleep(800);
  const h = await page.evaluate(() => {
    const body = document.querySelector('#v-alpha .mdPane[data-vk="notes/disk.md"] .mdBody');
    return {
      pwned: window.__pwned ?? null,
      script: !!body.querySelector('script'),
      style: !!body.querySelector('style'),
      iframe: !!body.querySelector('iframe'),
      onerror: !!body.querySelector('[onerror]'),
      styleAttr: !!body.querySelector('[style]'),
      jsHref: [...body.querySelectorAll('a')].some(a => /^\s*javascript:/i.test(a.getAttribute('href') || '')),
      h1: body.querySelector('h1')?.textContent || null,
    };
  });
  assert.equal(h.pwned, null, 'nothing executed');
  assert.equal(h.script, false, '<script> stripped');
  assert.equal(h.style, false, '<style> stripped (FORBID_TAGS)');
  assert.equal(h.iframe, false, '<iframe> stripped');
  assert.equal(h.onerror, false, 'onerror handler stripped');
  assert.equal(h.styleAttr, false, 'style attribute stripped (FORBID_ATTR)');
  assert.equal(h.jsHref, false, 'javascript: links stripped');
  assert.equal(h.h1, 'Still a heading', 'benign markdown still renders');
});

/* ── Phase 3 S2.6 (P20, monaco-s2 §1/§2): the md-preview KEEP contract under
   BOTH editor implementations — typing live-updates the ▤ pane IN PLACE
   (250ms debounce, drafts as the source, pane element + scrollTop kept, the
   honest bar note). Contract verbatim; only the editor waits and caret
   staging move (edDriver — DOM path under legacy, __mp under monaco). Under
   monaco the ping rides onDidChangeModelContent → signalOnce →
   mdPreviewSchedule (the data plane landed pre-S2.6; these are the
   retargeted ASSERTIONS the plan's S2.6 row calls for). Declared last: the
   shared-page tests above are order-dependent; each pass here runs in its
   own fresh context (the S2.1(d) isolation rule) and touches no disk. */
testMonaco('P20 dual: typing live-updates the ▤ pane in place — debounce, drafts-as-source, scroll kept', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const FKMD = 'alpha::notes/model.md';
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.marked && window.DOMPurify, null, { timeout: 8000 }).catch(() => {});
  await ed.wait(page, FKMD);
  await page.waitForSelector('#mdPreviewBtn', { timeout: 8000 });
  await page.click('#mdPreviewBtn');
  await page.waitForSelector('#v-alpha .mdPane[data-vk="notes/model.md"] .mdBody', { timeout: 10000 });
  await sleep(300);
  // mark the pane + park the reader mid-scroll — both must survive the update
  await page.evaluate(() => {
    const p = document.querySelector('#v-alpha .mdPane[data-vk="notes/model.md"]');
    p._probe = 'kept';
    p.scrollTop = 30;
  });
  // genuine keystrokes at a staged caret — the draft is the render source
  await ed.caretStart(page);
  const mark = `DUAL ${impl.toUpperCase()} DRAFT LINE`;
  await page.keyboard.type(`${mark}\n\n`);
  // 250ms debounce + render — poll rather than sample the debounce frame
  await page.waitForFunction((m) => document
    .querySelector('#v-alpha .mdPane[data-vk="notes/model.md"] .mdBody')
    ?.textContent.includes(m), mark, { timeout: 5000, polling: 100 });
  const p = await page.evaluate(() => {
    const pane = document.querySelector('#v-alpha .mdPane[data-vk="notes/model.md"]');
    return {
      kept: pane._probe === 'kept',
      scrollTop: pane.scrollTop,
      note: document.querySelector('#v-alpha #mdSrcNote')?.textContent || '',
    };
  });
  assert.ok(p.kept, 'same pane element — patched in place, not rebuilt');
  assert.equal(p.scrollTop, 30, 'reader position survives the re-render');
  assert.match(p.note, /unsaved draft/, 'the bar says the preview is the draft');
  assert.ok((await ed.text(page, FKMD)).includes(mark), 'the draft (not disk) is the render source');
});
