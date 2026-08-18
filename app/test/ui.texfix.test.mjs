// Claude-fix suggestions UI: in-editor highlights + chips, the review card,
// apply/dismiss, staleness when the user already fixed it, and the bottom
// strip staying up while Claude works even after the build goes clean (the
// disappearing-worker bug). All fix states arrive as synthetic WS pushes;
// the harness intercepts /api/texfix/** so nothing is ever billed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const filler = Array.from({ length: 80 }, (_, i) => `% filler line ${i + 1}`).join('\n');
const TEX = `\\documentclass{article}
${filler}
\\begin{document}
\\secton{Model}
Euler: $c^{-g} = bRc'^{-g}$
\\end{document}
`;

let ui, sb, page, wsPush;
const posts = [];

const errEntry = (root, extra = {}) => ({
  tex: path.join(root, 'paper.tex'),
  pdf: path.join(root, 'paper.pdf'),
  state: 'error', lastBuildMs: null, lastBuiltAt: null, pages: null,
  problems: [{ file: 'paper.tex', line: 3, kind: 'error', message: 'Undefined control sequence.' }],
  counts: { errors: 1, warnings: 0, badboxes: 0 },
  ...extra,
});

const sug = (over = {}) => ({
  id: 's1-test', file: 'paper.tex',
  find: '\\secton{Model}', replace: '\\section{Model}',
  why: 'misspelled \\section', status: 'open', ...over,
});

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), TEX),
  });
  ({ sb, page, wsPush } = ui);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route('**/api/texfix/**', (r) => {
    posts.push({ url: r.request().url(), body: r.request().postDataJSON() });
    r.fulfill({ json: { ok: true } });
  });
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Paper', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

test('THE bug: Claude stays visibly working after the user fixes the build', opts, async () => {
  await wsPush('pdf:status', { project: 'alpha', entry: errEntry(sb.projRoots.alpha) });
  await sleep(200);
  await wsPush('texfix:status', { project: 'alpha', fix: { state: 'running', startedAt: new Date().toISOString(), suggestions: [] } });
  await sleep(300);
  // the user fixes it themselves — build goes clean while Claude still works
  await wsPush('pdf:status', {
    project: 'alpha',
    entry: errEntry(sb.projRoots.alpha, {
      state: 'built', lastBuiltAt: new Date().toISOString(),
      problems: [], counts: { errors: 0, warnings: 0, badboxes: 0 },
    }),
  });
  await sleep(400);
  const strip = await page.evaluate(() => document.querySelector('.texProblems .tpBar')?.textContent || '');
  assert.match(strip, /searching for a fix/, `bottom strip persists: ${JSON.stringify(strip)}`);
  assert.match(strip, /build ✓/, 'and shows the build is clean now');
  const card = await page.evaluate(() => document.querySelector('.texfixCard')?.textContent || '');
  assert.match(card, /searching for a fix/, 'session card persists too');
});

test('suggestions arrive: red mark + a readable pane superimposed under it', opts, async () => {
  await wsPush('texfix:status', {
    project: 'alpha',
    fix: { state: 'done', costUsd: 0.2, suggestions: [sug()] },
  });
  await sleep(400);
  const deco = await page.evaluate(() => {
    const mark = document.querySelector('.sugMark');
    const pane = document.querySelector('.sugPane');
    const ed = document.querySelector('#codeEditor');
    const cs = getComputedStyle(ed);
    const lh = parseFloat(cs.lineHeight);
    const padT = parseFloat(cs.paddingTop);
    const line = ed.value.split('\n').findIndex((l) => l.includes('\\secton{Model}'));
    const btn = pane?.querySelector('.sugApply');
    return {
      mark: !!mark,
      paneNew: pane?.querySelector('.sugNew')?.textContent || '',
      why: pane?.querySelector('.sugWhy')?.textContent || '',
      applyRect: btn ? getComputedStyle(btn).borderRadius : '',
      markTop: mark ? parseFloat(mark.style.top) : -1,
      paneTop: pane ? parseFloat(pane.style.top) : -1,
      expectTop: padT + line * lh,
      strip: document.querySelector('.tpBar')?.textContent || '',
    };
  });
  assert.ok(deco.mark, 'deletion mark rendered');
  assert.equal(deco.paneNew, '\\section{Model}', 'pane shows the complete replacement');
  assert.match(deco.why, /misspelled/, 'why on the pane');
  assert.ok(Math.abs(deco.markTop - deco.expectTop) < 0.5, `mark on the right line (${deco.markTop})`);
  assert.ok(deco.paneTop > deco.expectTop && deco.paneTop < deco.expectTop + 2.5 * 19.25,
    `pane sits just below the mark (${deco.paneTop} vs line top ${deco.expectTop})`);
  assert.equal(deco.applyRect, '7px', 'apply is a rounded rectangle, not a circle');
  assert.match(deco.strip, /1 suggested fix/, 'strip counts it');
});

test('Apply on the pane lands in the draft and resolves — WITHOUT moving the view', opts, async () => {
  posts.length = 0;
  // scroll the editor so the suggestion (deep in the file) sits mid-viewport
  const before = await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    const at = ed.value.indexOf('\\secton{Model}');
    const lh = parseFloat(getComputedStyle(ed).lineHeight);
    const line = ed.value.slice(0, at).split('\n').length - 1;
    ed.scrollTop = Math.max(0, line * lh - ed.clientHeight * 0.4);
    return ed.scrollTop;
  });
  await sleep(300);
  await page.click('.sugApply');
  await sleep(400);
  const stateAfter = await page.evaluate(() => ({
    val: document.querySelector('#codeEditor').value,
    scroll: document.querySelector('#codeEditor').scrollTop,
    save: document.querySelector('#saveState')?.textContent || '',
    card: document.querySelector('.texfixCard')?.textContent || '',
  }));
  assert.ok(stateAfter.val.includes('\\section{Model}') && !stateAfter.val.includes('\\secton{Model}'), 'text replaced in the draft');
  assert.ok(Math.abs(stateAfter.scroll - before) < 2,
    `editor scroll untouched by apply (${before} → ${stateAfter.scroll})`);
  assert.equal(posts.length, 1, 'one resolve POST');
  assert.deepEqual(posts[0].body, { id: 's1-test', status: 'accepted' });
  assert.ok(!(await page.$('.sugMark')), 'mark cleared after apply');
  assert.ok(!(await page.$('.sugPane')), 'pane cleared after apply');
  assert.match(stateAfter.save, /unsaved/, 'the applied fix sits in the unsaved draft (user saves it)');
  assert.match(stateAfter.card, /1 fix applied|applied/, 'session card reflects the resolution in place');
});

test('multi-line replacements are shown IN FULL; Dismiss leaves the text alone', opts, async () => {
  posts.length = 0;
  // put the typo back (fresh draft state) and push a multi-line suggestion
  await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    ed.value = ed.value.replace('\\section{Model}', '\\secton{Model}');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const multi = sug({
    id: 's2-test',
    find: '\\secton{Model}',
    replace: '\\section{Model}\n\\begin{itemize}\n  \\item restored structure with a rather long explanatory line of content\n\\end{itemize}',
  });
  await wsPush('texfix:status', { project: 'alpha', fix: { state: 'done', suggestions: [multi] } });
  await sleep(300);
  const paneNew = await page.evaluate(() => document.querySelector('.sugPane .sugNew')?.textContent || '');
  assert.equal(paneNew, multi.replace, 'the ENTIRE multi-line replacement is readable — no truncation');
  await page.click('.sugDismiss');
  await sleep(300);
  assert.deepEqual(posts.pop()?.body, { id: 's2-test', status: 'dismissed' });
  const val = await page.evaluate(() => document.querySelector('#codeEditor').value);
  assert.ok(val.includes('\\secton{Model}'), 'text untouched by dismiss');
  assert.ok(!val.includes('itemize'), 'nothing applied');
});

test('a suggestion the user already fixed goes stale quietly (grace period)', opts, async () => {
  posts.length = 0;
  // the buffer no longer contains the find-string
  await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    ed.value = ed.value.replace('\\secton{Model}', '\\section{Model}');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wsPush('texfix:status', {
    project: 'alpha',
    fix: { state: 'done', suggestions: [sug({ id: 's3-test' })] },
  });
  await sleep(400);
  assert.ok(!(await page.$('.sugMark')), 'no highlight for an unlocatable suggestion');
  await sleep(5600); // grace period → auto-retired as stale
  const resolved = posts.find((p) => p.body?.id === 's3-test');
  assert.deepEqual(resolved?.body, { id: 's3-test', status: 'stale' });
});

test('the URL hash still follows the view across reloads', opts, async () => {
  assert.equal(await page.evaluate(() => location.hash), '#alpha');
  await page.reload();
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.querySelector('.view.show')?.id), 'v-alpha');
});

test('the success card takes a bow: ~4.5s of glory, a smooth fade, then retired for good', opts, async () => {
  posts.length = 0;
  // applied fix + clean build → the "✓ Claude fix applied" card
  await wsPush('pdf:status', {
    project: 'alpha',
    entry: errEntry(sb.projRoots.alpha, {
      state: 'built', lastBuiltAt: new Date().toISOString(),
      problems: [], counts: { errors: 0, warnings: 0, badboxes: 0 },
    }),
  });
  await sleep(200);
  await wsPush('texfix:status', {
    project: 'alpha',
    fix: { state: 'done', suggestions: [sug({ id: 's9-test', status: 'accepted' })] },
  });
  await sleep(400);
  let card = await page.evaluate(() => {
    const el = document.querySelector('.texfixCard.sugDone');
    return el ? { text: el.textContent, fading: el.classList.contains('fadeAway') } : null;
  });
  assert.ok(card, 'success card shows');
  assert.match(card.text, /Claude fix applied/, 'with the applied message');
  assert.equal(card.fading, false, 'and gets its moment before the exit');

  // ~4.5s later the graceful exit starts (fade + collapse)…
  await sleep(4500);
  const fading = await page.evaluate(() =>
    !!document.querySelector('.texfixCard.fadeAway'));
  assert.ok(fading, 'card fades out rather than vanishing');

  // …and once it's gone, it's GONE: record cleared + retired server-side
  await sleep(900);
  assert.ok(!(await page.$('.texfixCard')), 'card removed after the fade');
  assert.ok(posts.some((p) => p.url.includes('/api/texfix/alpha/dismiss')),
    'the fix record is retired server-side (no reload resurrection)');

  // the user's actual complaint: switching tasks must not bring it back
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Second task', category: 'calibration', oversight: 'manual', context: {},
  });
  await wsPush('task:update', { project: 'alpha', task: t2 });
  await sleep(200);
  await page.evaluate((tid) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find((e) => e.dataset.id === tid)?.click();
  }, t2.id);
  await sleep(300);
  assert.ok(!(await page.$('.texfixCard')), 'no resurrection on task switch');
});
