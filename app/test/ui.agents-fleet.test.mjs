// The console's agent FLEET BOARD (docs/agentview-mockups ②, Graham's pick,
// 2026-07-30). session:agents rosters render as a card grid at the stream's
// end: header counts, one card per agent (mission, live note, tools/tok/
// clock). Finished cards stay on the board dimmed with verdict + "ago" while
// stragglers keep a live clock; past 8 agents the board groups by type and
// folds settled cards into the group counts; an empty roster clears it.
// Replaces the old running-only strip + the server's ◆ progress-line spam
// (sessions.agents.test.mjs pins the server side).
// Billing-safe: uiHarness stubs the WS and intercepts billed routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';
import { APP_DIR } from './helpers.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, tid;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), 'x\n'),
  });
  ({ sb, page, wsPush } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'lit sweep', category: 'calibration', oversight: 'coop',
    context: { files: ['notes.tex'] },
  });
  tid = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${tid}`, { status: 'running' });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .ctab.console', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#v-alpha .ctab.console').click());
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

const A = (n, status, over = {}) => ({
  n, type: 'general-purpose', desc: `mission ${n}`, status,
  summary: status === 'running' ? `running WebFetch ${n}` : `verdict ${n}`,
  tools: n * 3, tokens: n * 9000, ms: n * 40000, ...over,
});
const push = (agents) => wsPush('session:agents', { project: 'alpha', id: tid, agents });
const board = () => page.evaluate(() => {
  const el = document.querySelector('#v-alpha #consoleBox > .csAgents');
  if (!el) return null;
  return {
    head: el.querySelector('.csAgentsHead')?.textContent.trim(),
    cards: [...el.querySelectorAll('.csACard')].map((c) => ({
      cls: c.className, desc: c.querySelector('.csADesc')?.textContent,
      act: c.querySelector('.csAAct')?.textContent, meta: c.querySelector('.csAMeta')?.textContent,
    })),
    phases: [...el.querySelectorAll('.csAPhase')].map((p) => p.textContent.trim()),
  };
});

test('mid-flight: one bright card per running agent, header counts', opts, async () => {
  await push([A(1, 'running'), A(2, 'running'), A(3, 'running')]);
  await sleep(250);
  const b = await board();
  assert.ok(b, 'the board mounted');
  assert.equal(b.head, '◆ 3 agents · 3 running');
  assert.equal(b.cards.length, 3);
  assert.ok(b.cards.every((c) => c.cls.includes('running')));
  assert.equal(b.cards[0].desc, 'mission 1');
  assert.equal(b.cards[0].act, 'running WebFetch 1');
  assert.match(b.cards[1].meta, /6 tools · 18k tok · 1m20s/, 'tools · tok · live clock');
});

test('stragglers: finished cards dim to verdict + ago, the grinder keeps its clock', opts, async () => {
  await push([A(1, 'running', { ms: 552000, tools: 31, tokens: 104000 }), A(2, 'done'), A(3, 'failed')]);
  await sleep(250);
  const b = await board();
  assert.equal(b.head, '◆ 3 agents · 1 running · ✓1 · ✗1');
  assert.ok(b.cards[0].cls.includes('running'), 'grinder stays bright');
  assert.match(b.cards[0].meta, /9m12s/, 'grinder clock still live');
  assert.ok(b.cards[1].cls.includes('done'), 'done card dims');
  assert.equal(b.cards[1].act, 'verdict 2');
  assert.match(b.cards[1].meta, /just now/, 'the running→done flip was stamped');
  assert.ok(b.cards[2].cls.includes('failed'), 'failed card flags red');
});

test('an unchanged roster does not rebuild the DOM', opts, async () => {
  const agents = [A(1, 'running', { ms: 552000, tools: 31, tokens: 104000 }), A(2, 'done'), A(3, 'failed')];
  await page.evaluate(() => { document.querySelector('#v-alpha .csACard')._probe = true; });
  await push(agents);
  await sleep(250);
  const kept = await page.evaluate(() => !!document.querySelector('#v-alpha .csACard')._probe);
  assert.ok(kept, 'identical payload → signature match → cards not rebuilt');
});

test('a large team groups by type; settled agents fold into the counts', opts, async () => {
  const team = [];
  for (let i = 1; i <= 12; i++) team.push(A(i, i <= 9 ? 'done' : 'running', { type: 'finder' }));
  for (let i = 13; i <= 24; i++) team.push(A(i, i <= 20 ? 'running' : 'failed', { type: 'verifier' }));
  await push(team);
  await sleep(250);
  const b = await board();
  assert.equal(b.head, '◆ 24 agents · 11 running · ✓9 · ✗4');
  assert.deepEqual(b.phases, ['finder — 9/12', 'verifier — 4/12 ✗4']);
  assert.equal(b.cards.length, 11, 'only RUNNING cards render in the grouped view');
});

test('an empty roster clears the board (turn end)', opts, async () => {
  await push([]);
  await sleep(250);
  assert.equal(await board(), null, 'board gone');
});

// ── fossil-panel regression (source-level; runs without Chrome) ──
// A state.sessions snapshot fetched mid-turn used to be the renderer's
// fallback roster: the turn-end clear emptied agentsLive, un-shadowing the
// stale snapshot, and the dead fleet re-rendered under EVERY later turn
// (frozen clocks, "running" agents that were long gone). The strips must
// render from agentsLive/editsLive only; applyState is the single
// snapshot→live seeding path and replaces rather than merges.
test('the fleet board renders from agentsLive only; applyState owns the snapshot seed', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'app.js'), 'utf8');
  assert.ok(!/sess\.agents|sess\.edits/.test(src),
    'no direct state.sessions roster/edits fallback anywhere in the renderer');
  assert.match(src, /for \(const k of Object\.keys\(agentsLive\)\) delete agentsLive\[k\]/,
    'applyState replaces (never merges) the live rosters from the snapshot');
  assert.match(src, /for \(const k of Object\.keys\(editsLive\)\) delete editsLive\[k\]/,
    'the ✎ aggregate is re-seeded the same way');
});
