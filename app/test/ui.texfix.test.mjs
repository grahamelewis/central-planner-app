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
