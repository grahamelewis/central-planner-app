// Live editor refresh: a session's Edit/Write mid-turn broadcasts
// file:changed — a clean open editor reloads the new disk content in place
// (keeping the reader's scroll). An unsaved draft is NEVER clobbered: a
// non-overlapping disk change 3-way-merges INTO the draft (which rebases,
// so saving just works); only a genuine overlap pins the draft behind the
// ⚠ changed-on-disk warning + save-time 409 recovery flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME, testMonaco, edDriver, wsPushTo } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const LINES = (tag) => Array.from({ length: 80 }, (_, i) => `% ${tag} line ${i + 1}`).join('\n');
const TEX_V1 = `\\documentclass{article}\n${LINES('v1')}\n\\begin{document}\nOriginal.\n\\end{document}\n`;
const TEX_V2 = `\\documentclass{article}\n${LINES('v2')}\n\\begin{document}\nClaude rewrote this.\n\\end{document}\n`;

let ui, sb, page, wsPush, texPath;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      texPath = path.join(projRoots.alpha, 'paper.tex');
      fs.writeFileSync(texPath, TEX_V1);
    },
  });
  ({ sb, page, wsPush } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Paper', category: 'calibration', oversight: 'manual',
    context: { files: ['paper.tex'] },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

/* ── Phase 3 S2.6 (P3/M4, monaco-s2 §2): the file:changed KEEP contracts
   under BOTH editor implementations — clean reload in place, the
   non-overlapping 3-way merge folding disk INTO the draft, and the genuine
   overlap pinning the draft behind ⚠ disk. Contracts verbatim; text/dirty
   reads move to __mp under monaco (edDriver). The save-time flows stay in
   their own suites (legacy confirm above; the M5 ladder in ui.monaco-save)
   — the SHARED contract here ends at the pin + warn. Declared last: the
   shared-page tests above are order-dependent; each pass reseeds disk. */
testMonaco('file:changed dual: clean reload in place; non-overlap merges into the draft; overlap pins ⚠ disk', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const FKP = 'alpha::paper.tex';
  await ed.wait(page, FKP);
  await page.waitForFunction(() => window.__ws && !!window.__ws.onmessage, null, { timeout: 15000 });
  const chip = () => page.evaluate(() => ({
    txt: document.querySelector('#saveState')?.textContent || '',
    cls: document.querySelector('#saveState')?.className || '',
  }));

  // ── 1 · clean reload in place ──
  fs.writeFileSync(texPath, TEX_V1);
  await wsPushTo(page, 'file:changed', { project: 'alpha', rel: 'paper.tex' });
  for (let i = 0; i < 30 && (await ed.text(page, FKP)) !== TEX_V1; i++) await sleep(200);
  assert.equal(await ed.text(page, FKP), TEX_V1, 'clean editor shows the new disk content');

  // ── 2 · non-overlapping draft + disk edit merge silently ──
  await ed.caretEnd(page);
  const mine = `% dual ${impl} unsaved thought`;
  await page.keyboard.type(mine);
  await page.waitForFunction(() =>
    /dirty/.test(document.querySelector('#saveState')?.className || ''), null, { timeout: 5000 });
  fs.writeFileSync(texPath, TEX_V2); // every touched line is far from the draft's tail
  await wsPushTo(page, 'file:changed', { project: 'alpha', rel: 'paper.tex' });
  for (let i = 0; i < 30 && !((await ed.text(page, FKP)) || '').includes('Claude rewrote this.'); i++) await sleep(200);
  const merged = await ed.text(page, FKP);
  assert.ok(merged.includes(mine), 'draft text untouched');
  assert.ok(merged.includes('Claude rewrote this.'), "Claude's edit merged into the open draft");
  let c = await chip();
  assert.ok(!/⚠ disk/.test(c.txt), `no conflict warning — the draft rebased (${JSON.stringify(c.txt)})`);
  assert.match(c.cls, /dirty/, 'merged draft is a normal unsaved draft');

  // ── 3 · a genuine overlap pins the draft behind ⚠ disk ──
  // OURS and THEIRS both REPLACE the same trailing line with different text
  // (no trailing newline on either side — a trailing '\n' would make THEIRS
  // an insertion at a different base coordinate and merge3 would interleave)
  fs.writeFileSync(texPath, TEX_V2 + '% claude tail');
  await wsPushTo(page, 'file:changed', { project: 'alpha', rel: 'paper.tex' });
  await page.waitForFunction(() =>
    /stale/.test(document.querySelector('#saveState')?.className || ''), null, { timeout: 8000 });
  const pinned = await ed.text(page, FKP);
  assert.ok(pinned.includes(mine), 'draft pinned — disk did not overwrite it');
  assert.ok(!pinned.includes('% claude tail'), 'the conflicting disk line stayed on disk');
  c = await chip();
  assert.match(c.txt, /⚠ disk/, `chip warns about the conflict (${JSON.stringify(c.txt)})`);
});
