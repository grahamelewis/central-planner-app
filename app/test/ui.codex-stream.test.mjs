// Codex final-answer reconciliation in the real browser console. Reproduces
// commentary glued directly to a ```latex final, then settles the turn from a
// canonical transcript. Billing-safe: no provider route is called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
let ui, sb, page, wsPush, task;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), 'x\n'),
  });
  ({ sb, page, wsPush } = ui);
  const made = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Codex fence stream', category: 'calibration', oversight: 'coop',
    provider: 'codex', model: 'gpt-test', context: { files: ['notes.tex'] },
  });
  task = { ...made.body, status: 'running', provider: 'codex' };
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, { status: 'running' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .ctab.console', { timeout: 15000 });
  await page.click('#v-alpha .ctab.console');
  await page.waitForFunction(() => window.marked && window.DOMPurify && window.renderMathInElement,
    null, { timeout: 8000 }).catch(() => {});
});

after(async () => { if (ui) await ui.stop(); });

test('turn completion repairs a Codex final fence glued to commentary', opts, async () => {
  const finalText = '```latex\n\\subsection{The criterion}\nLet $x=1$.\n```\nKeep the claim scoped.';
  await wsPush('session:stream', {
    project: 'alpha', id: task.id,
    chunk: '\n∴ thinking…\nI will keep the assumptions narrow. ' + finalText
      + '\n— turn done · 1.0s · 1k in / 1k out —\n',
  });

  // The page fetched the task's initially-empty transcript during boot. Stub
  // the completion refresh with the canonical transcript the server would
  // have persisted after a real Codex turn.
  await page.route(`**/api/transcript/alpha/${task.id}`, (route) => route.fulfill({ json: {
    transcript: [
      { role: 'user', text: 'Draft the next section.', ts: task.created },
      { role: 'assistant', provider: 'codex', text: finalText, ts: task.created,
        turnLine: '— turn done · 1.0s · 1k in / 1k out —' },
    ],
  } }));

  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id: task.id, provider: 'codex', status: 'waiting' });
  await page.waitForSelector('#v-alpha #consoleBox .fenceBox', { timeout: 5000 });
  await sleep(200);

  const view = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const fence = box.querySelector('.fenceBox');
    return {
      lang: fence.querySelector('.fenceLang')?.textContent,
      source: fence.querySelector('pre')?.textContent,
      answerSegments: box.querySelectorAll('.cseg.cs-ans').length,
      text: box.textContent,
    };
  });
  assert.equal(view.lang, 'latex');
  assert.match(view.source, /\\subsection\{The criterion\}/);
  assert.ok(view.answerSegments >= 1, 'the canonical final is an answer segment');
  assert.match(view.text, /I will keep the assumptions narrow/, 'live commentary is preserved');
});
