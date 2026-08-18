// Console rendering regressions — the dashboard's Claude interface.
// Drives the real frontend in headless Chrome (system Chrome via
// playwright-core); skips cleanly on machines without Chrome.
//
// Guards the fixes for:
//   · scroll-behavior:smooth race — completion renders ratcheted the console
//     to the top (scroll captured mid-animation)
//   · full console wipes when streaming re-segments the tail
//   · stick-to-bottom dragging a reader who had scrolled up (height heuristic
//     broke when scrollback < threshold; now an explicit _follow intent bit)
//   · typed prompts never appearing in the console (hard to scroll back and
//     see what you asked)
// Tests share one staged session and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, chunked, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, task;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'β = 0.96\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate model', description: 'Fit β.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({
    created: created.created,
    entries: [
      { role: 'user', text: 'Calibrate the model to the baseline sample.', ts: created.created },
      { role: 'assistant', text: 'Done — moment match **0.83**.', ts: created.created },
    ],
  }));
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.marked && window.DOMPurify, null, { timeout: 8000 }).catch(() => {});
  await sleep(700);
});
after(async () => { if (ui) await ui.stop(); });

const consoleState = () => page.evaluate(() => {
  const box = document.querySelector('#v-alpha #consoleBox');
  const on = document.querySelector('#v-alpha .ctabs .ctab.on');
  return {
    activeTab: on ? on.textContent.trim() : null,
    text: box ? box.innerText : null,
    scrollTop: box ? Math.round(box.scrollTop) : null,
    maxScroll: box ? Math.round(box.scrollHeight - box.clientHeight) : null,
  };
});
const stream = async (text, n = 30, everyMs = 25) => {
  for (const chunk of chunked(text, n)) {
    await wsPush('session:stream', { project: 'alpha', id, chunk });
    await sleep(everyMs);
  }
  await sleep(300); // reveal pump catches up
};

test('Enter in the composer jumps to the console and shows the typed prompt', opts, async () => {
  assert.equal(await page.getAttribute('#composerInput', 'placeholder'), 'Message Claude…');
  await page.fill('#composerInput', 'Try β = 0.97 and report the fit.');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  const s = await consoleState();
  assert.match(s.activeTab, /console/);
  assert.ok(s.text.includes('Try β = 0.97 and report the fit.'), 'sent prompt is visible in the console');
  assert.equal(await page.inputValue('#composerInput'), '', 'composer cleared');
});

test('streaming renders incrementally — the console DOM is never wiped', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await page.evaluate(() => {
    const wrap = document.querySelector('#v-alpha #consoleBox .csegWrap');
    window.__wipes = 0;
    if (wrap.firstElementChild) wrap.firstElementChild.dataset.sentinel = '1';
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n && n.dataset && n.dataset.sentinel) window.__wipes++;
        }
      }
    }).observe(wrap, { childList: true });
  });
  // a stream that re-segments its tail: fence opens chunks before it closes,
  // marker lines complete across chunk boundaries
  await stream('⟐ model · auto\n\n∴ thinking…\nRefit and compare.\n\n— answer —\n'
    + 'Refit at $\\beta = 0.97$:\n\n```julia\nsol = solve(m; β = 0.97)\n```\n'
    + 'The **fit improves** to 0.87.\n'
    + '\n[tool: Bash] julia calibrate.jl — rerun\n[result] match = 0.87\n'
    + Array.from({ length: 30 }, (_, i) => `step ${i}: residual ${(1 / (i + 1)).toFixed(3)}`).join('\n'), 22);
  assert.equal(await page.evaluate(() => window.__wipes), 0, 'no full console wipes during streaming');
  const s = await consoleState();
  assert.ok(Math.abs(s.scrollTop - s.maxScroll) <= 2, `console follows the stream to the bottom (${s.scrollTop}/${s.maxScroll})`);
});

test('a reader who scrolled up is not dragged while streaming continues', opts, async () => {
  await page.evaluate(() => {
    document.querySelector('#v-alpha #consoleBox').scrollTop = 0; // user scrolls to the top
  });
  await sleep(80); // scroll event → follow intent off
  await stream('\nMore output that must not yank the reader:\n'
    + Array.from({ length: 12 }, (_, i) => `extra line ${i}`).join('\n'), 25);
  const s = await consoleState();
  assert.equal(s.scrollTop, 0, 'scrolled-up reader stays put');
});

test('turn completion preserves the reader position (no jump to top or bottom)', opts, async () => {
  await stream('\n— turn done · 2.0s · 1k in / 1k out —\n');
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting', tokens: { in: 1, out: 1 }, costUsd: 0 });
  await sleep(600); // task:update + session:status + transcript-refresh renders
  const s = await consoleState();
  assert.equal(s.scrollTop, 0, 'completion renders keep the scrolled-up position');
});

test('an at-bottom console stays pinned to the bottom through completion', opts, async () => {
  await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    box.scrollTop = box.scrollHeight; // user scrolls back down → follow resumes
  });
  await sleep(80);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await stream('\nwrapping up: final summary line.\n');
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(600);
  const s = await consoleState();
  assert.ok(Math.abs(s.scrollTop - s.maxScroll) <= 2, `still at the bottom (${s.scrollTop}/${s.maxScroll})`);
});

test('a second prompt sent mid-conversation appears in the live console', opts, async () => {
  await page.fill('#composerInput', 'Now check the holdout sample please.');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  const s = await consoleState();
  const t = s.text;
  assert.ok(t.includes('Now check the holdout sample please.'), 'second prompt visible in the console');
  assert.ok(t.indexOf('Try β = 0.97') < t.indexOf('Now check the holdout sample'),
    'messages appear in conversation order');
});

// Switching away from a scrolled-up console and back must not snap it to the
// bottom. A module-level consoleView map saves each console's {scrollTop,follow}
// per task (renderWB) and restores it when the console re-mounts (wireWB).
// Regression: A→B→A used to reset A to the bottom, losing the reader's place.
test('switching tasks preserves a scrolled-up console (A→B→A is not reset)', opts, async () => {
  // seed a SECOND task in alpha so there are two task tabs to switch between
  const { body: b2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Second task', description: 'Another.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  const id2 = b2.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id2}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's2', startedAt: b2.created, lastTurnAt: b2.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.writeFileSync(path.join(tdir, `${id2}.json`), JSON.stringify({
    created: b2.created,
    entries: [{ role: 'user', text: 'Second task seed.', ts: b2.created }],
  }));
  await wsPush('task:update', { project: 'alpha', task: { ...task, id: id2, title: 'Second task' } });
  await sleep(200);

  // select a task tab by data-id; open the ≋ console tab of the current task
  const selectTask = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  const openConsole = async () => {
    await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
    await sleep(300);
  };

  // task A (the shared `id`): make its console overflow, then open it
  await selectTask(id);
  await openConsole();
  await stream('\n' + Array.from({ length: 60 }, (_, i) => `scrollback line ${i} — filler to overflow the short viewport`).join('\n') + '\n', 28);

  // user scrolls UP to read; capture the position
  await page.evaluate(() => { document.querySelector('#v-alpha #consoleBox').scrollTop = 50; });
  await sleep(120); // scroll event → follow intent off
  const before = await consoleState();
  assert.ok(before.maxScroll > 60, `A console overflows (maxScroll=${before.maxScroll})`);
  assert.ok(Math.abs(before.scrollTop - 50) <= 6, `A scrolled up to ~50 (got ${before.scrollTop})`);

  // switch to B and back (task switch resets fileTab → re-open A's console)
  await selectTask(id2);
  await selectTask(id);
  await openConsole();

  const back = await consoleState();
  assert.ok(Math.abs(back.scrollTop - 50) <= 6,
    `A's scroll is preserved on return (got ${back.scrollTop}, expected ~50)`);
  assert.ok(back.scrollTop < back.maxScroll - 10,
    `A is NOT snapped to the bottom (scrollTop=${back.scrollTop}, maxScroll=${back.maxScroll})`);
});

// Switching PROJECTS (top-nav tabs) and back must also preserve the console
// scroll. renderAll only re-renders the entered view, so the outgoing project's
// renderWB never fires to capture its scroll — go() now saves it on leave, and
// the wireWB restore defers via requestAnimationFrame because the returning
// view is rendered while still display:none (geometry reads 0 until .show).
// Regression: alpha → beta → alpha used to reset alpha's console to the bottom.
test('switching projects preserves a scrolled-up console (alpha→beta→alpha is not reset)', opts, async () => {
  // the harness seeds a `beta` project too; give it a task so it has a workbench
  const { body: bBeta } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'beta', title: 'Beta task', description: 'In the other project.',
    category: 'calibration', oversight: 'coop', context: {},
  });
  const idBeta = bBeta.id;
  await sb.fetchJson('PATCH', `/api/tasks/beta/${idBeta}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 'sb', startedAt: bBeta.created, lastTurnAt: bBeta.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const btdir = path.join(sb.root, 'transcripts', 'beta');
  fs.mkdirSync(btdir, { recursive: true });
  fs.writeFileSync(path.join(btdir, `${idBeta}.json`), JSON.stringify({
    created: bBeta.created,
    entries: [{ role: 'user', text: 'Beta task seed.', ts: bBeta.created }],
  }));
  await sleep(150);

  const goProject = async (v) => {
    await page.evaluate((x) => {
      document.querySelector(`#navProjects .tab[data-v="${x}"]`).click();
    }, v);
    await sleep(300);
  };
  // select task `id` in alpha and open its console
  const selectTaskA = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  const openConsoleA = async () => {
    await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
    await sleep(300);
  };

  // make alpha's task `id` console overflow and scroll the reader up
  await goProject('alpha');
  await selectTaskA(id);
  await openConsoleA();
  await stream('\n' + Array.from({ length: 60 }, (_, i) => `cross-proj line ${i} — filler to overflow the short viewport`).join('\n') + '\n', 28);
  await page.evaluate(() => { document.querySelector('#v-alpha #consoleBox').scrollTop = 50; });
  await sleep(120); // scroll event → follow intent off
  const before = await consoleState();
  assert.ok(before.maxScroll > 60, `alpha console overflows (maxScroll=${before.maxScroll})`);
  assert.ok(Math.abs(before.scrollTop - 50) <= 6, `alpha scrolled up to ~50 (got ${before.scrollTop})`);

  // switch to the beta PROJECT via the top nav, then back to alpha
  await goProject('beta');
  await goProject('alpha');
  await openConsoleA(); // re-open the console tab if the return reset the file tab
  await sleep(200); // wireWB restore defers to requestAnimationFrame once visible

  const back = await consoleState();
  assert.ok(Math.abs(back.scrollTop - 50) <= 6,
    `alpha's scroll is preserved across the project switch (got ${back.scrollTop}, expected ~50)`);
  assert.ok(back.scrollTop < back.maxScroll - 10,
    `alpha is NOT snapped to the bottom on return (scrollTop=${back.scrollTop}, maxScroll=${back.maxScroll})`);
});

// Switching PROJECTS and back must not leave the Claude composer dead. renderWB
// runs while the returning view is still display:none (the .show toggle happens
// after), so the composer's autosize() read scrollHeight 0 and pinned the
// textarea to height:0 — present in the DOM but unclickable. Fix: the initial
// autosize defers via requestAnimationFrame when the input has no layout yet
// (clientHeight 0), sizing it after .show gives the view geometry.
// Regression: alpha → beta → alpha left #composerInput at height 0, swallowing
// clicks (elementFromPoint hit the wrapper div, not the textarea).
test('switching projects keeps the composer clickable (alpha→beta→alpha is not dead)', opts, async () => {
  // give beta a waiting task so it has a workbench to switch to
  const { body: bBeta } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'beta', title: 'Beta composer task', description: 'In the other project.',
    category: 'calibration', oversight: 'coop', context: {},
  });
  const idBeta = bBeta.id;
  await sb.fetchJson('PATCH', `/api/tasks/beta/${idBeta}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 'sbc', startedAt: bBeta.created, lastTurnAt: bBeta.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const btdir = path.join(sb.root, 'transcripts', 'beta');
  fs.mkdirSync(btdir, { recursive: true });
  fs.writeFileSync(path.join(btdir, `${idBeta}.json`), JSON.stringify({
    created: bBeta.created,
    entries: [{ role: 'user', text: 'Beta composer seed.', ts: bBeta.created }],
  }));
  await sleep(150);

  const goProject = async (v) => {
    await page.evaluate((x) => {
      document.querySelector(`#navProjects .tab[data-v="${x}"]`).click();
    }, v);
    await sleep(300);
  };
  // select alpha's waiting task `id` so its composer (status !== done) shows
  const selectTaskA = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  // composer geometry + what actually sits under its center point
  const composerProbe = () => page.evaluate(() => {
    const inp = document.querySelector('#v-alpha #composerInput');
    if (!inp) return { exists: false };
    const r = inp.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                          Math.round(r.top + r.height / 2));
    return { exists: true, height: Math.round(r.height), hitIsComposer: hit === inp };
  });

  // show alpha's composer
  await goProject('alpha');
  await selectTaskA(id);
  const start = await composerProbe();
  assert.ok(start.height > 0, `composer has height before the switch (got ${start.height})`);

  // leave to beta, come back to alpha, re-select the task
  await goProject('beta');
  await goProject('alpha');
  await selectTaskA(id);
  await sleep(160); // initial autosize defers to requestAnimationFrame once visible

  const back = await composerProbe();
  assert.ok(back.exists, 'composer still present after the project switch');
  assert.ok(back.height > 0, `composer is not pinned to height 0 on return (got ${back.height})`);
  assert.ok(back.hitIsComposer, 'composer center is hittable (not occluded by a height:0 collapse)');

  // a real click must land in the textarea and typing must reach .value
  await page.click('#v-alpha #composerInput');
  await page.fill('#v-alpha #composerInput', ''); // clear any restored draft
  await page.type('#v-alpha #composerInput', 'alive after switch');
  assert.equal(await page.inputValue('#v-alpha #composerInput'), 'alive after switch',
    'click + type lands in the composer after the project switch');
});

// Per-task tab memory: coming back to a task restores the tab you left it on
// (console included) instead of dumping you on the first pinned file — and it
// survives a reload (localStorage). The lookup is O(1); no extra renders.
test('switching tasks restores each task\'s last-open center tab', opts, async () => {
  // task C with a pinned file, so its DEFAULT tab is the file — the contrast
  // to task A which we leave parked on the ≋ console
  const { body: c } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Tab memory task', description: 'C.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  const idC = c.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${idC}`, {
    status: 'waiting',
    session: { sdkSessionId: 'sc', startedAt: c.created, lastTurnAt: c.created, tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1 },
  });
  await wsPush('task:update', { project: 'alpha', task: { ...task, id: idC, title: 'Tab memory task' } });
  await sleep(200);

  const selectTask = async (tid) => {
    await page.evaluate((x) => {
      [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x)?.click();
    }, tid);
    await sleep(250);
  };
  const activeTab = () => page.evaluate(() => {
    const on = document.querySelector('#v-alpha .ctabs .ctab.on');
    return on ? { text: on.textContent.trim(), isConsole: on.classList.contains('console') } : null;
  });

  // park task A on the console…
  await selectTask(id);
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
  await sleep(250);
  assert.equal((await activeTab()).isConsole, true, 'A parked on the console');

  // …switch to C: its own default (the file), NOT A's console
  await selectTask(idC);
  let tab = await activeTab();
  assert.equal(tab.isConsole, false, `C opens on its default file tab (${tab.text})`);
  assert.match(tab.text, /model\.jl/, 'which is the pinned file');

  // back to A: the console is restored without re-clicking it
  await selectTask(id);
  tab = await activeTab();
  assert.equal(tab.isConsole, true, 'A comes back on the console, as left');

  // and C remembered its file tab through the round-trip
  await selectTask(idC);
  tab = await activeTab();
  assert.match(tab.text, /model\.jl/, 'C still on its file');

  // reload: A is the default task and comes back on the console (localStorage)
  await selectTask(id);
  await page.reload();
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(500);
  tab = await activeTab();
  assert.equal(tab?.isConsole, true, 'the console tab survives a reload');
});

// Subagents ("agent teams"): ◆ launch/progress/done lines render as their own
// styled segments, ↳N-prefixed inner tool lines stay tool segments (they must
// never be swallowed into a markdown answer), and the session:agents roster
// shows a live "N agents running" strip that clears when the turn ends.
test('subagent lines and the live agents strip render in the console', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('\n◆ agent #1 ▶ Explore — Map the config loaders\n'
    + '↳1 [tool: Grep] pattern=config\n'
    + '↳1 [result] 14 matches in 6 files\n'
    + '◆ agent #2 ▶ general-purpose — Draft the tests\n'
    + '◆ agent #1 ✓ done · Explore — loaders live in lib/config.js\n', 26);
  await wsPush('session:agents', {
    project: 'alpha', id,
    agents: [
      { n: 1, type: 'Explore', desc: 'Map the config loaders', status: 'done', summary: null, tools: 4, tokens: 12100, ms: 61000 },
      { n: 2, type: 'general-purpose', desc: 'Draft the tests', status: 'running', summary: 'Writing api.tasks specs', tools: 7, tokens: 38200, ms: 95000 },
    ],
  });
  await sleep(400);

  const s = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const agentSegs = [...box.querySelectorAll('.cseg.cs-agent')].map(e => e.textContent);
    const toolSegs = [...box.querySelectorAll('.cseg.cs-tool')].map(e => e.textContent);
    const board = box.querySelector('.csAgents');
    return {
      agentSegs, toolSegs,
      board: board ? board.innerText : null,
      cards: board ? [...board.querySelectorAll('.csACard')].map(c => c.className) : [],
    };
  });
  assert.ok(s.agentSegs.some(t => /◆ agent #1 ▶ Explore/.test(t)), 'launch line is an agent segment');
  assert.ok(s.agentSegs.some(t => /agent #1 ✓ done/.test(t)), 'done line is an agent segment');
  assert.ok(s.toolSegs.some(t => /↳1 \[tool: Grep\]/.test(t)), '↳N inner tool line stays a tool segment');
  assert.ok(s.board, 'fleet board is shown while running');
  // the fleet board keeps FINISHED agents on the board (dimmed) — deep
  // choreography lives in ui.agents-fleet.test.mjs; this pins coexistence
  // with the ◆ text segments and the turn-end clear
  assert.match(s.board, /◆ 2 agents · 1 running · ✓1/, 'header counts running AND done');
  assert.equal(s.cards.length, 2, 'both agents hold cards');
  assert.ok(s.cards.some(c => /\bdone\b/.test(c)) && s.cards.some(c => /\brunning\b/.test(c)));
  assert.match(s.board, /Writing api\.tasks specs/, 'the live card shows the current summary');
  assert.match(s.board, /7 tools · 38k tok · 1m35s/, 'usage + live clock');

  // turn end: server clears the roster and the task settles → board disappears
  await wsPush('session:agents', { project: 'alpha', id, agents: [] });
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(400);
  const gone = await page.evaluate(() => !document.querySelector('#v-alpha #consoleBox .csAgents'));
  assert.ok(gone, 'fleet board clears when the turn ends');
});

test('an UNCLOSED code fence cannot swallow the console (formatting dropout)', opts, async () => {
  // The bug (docs/console-formatting-bug-diagnosis.txt): a streamed answer
  // opens a ``` block whose closing fence hasn't arrived; every later framing
  // marker used to be absorbed as fence "content" into one giant trailing
  // segment, which the live tail renders raw — the whole console below the
  // opener "lost its formatting". Markers now ESCAPE an open fence.
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('\n— answer —\nHere is the solver loop:\n\n```julia\nwhile r > tol\n    r = step!(m)\n'
    // NO closing fence — and the turn moves on to tools and more text
    + '\n[tool: Bash] Pass-through at pe=0.50 — julia --gcthreads=1 -e …\n'
    + '[result] Φ = 0.61, φ_BPP = 0.54\n'
    + '∴ thinking…\nNow compare the two.\n'
    + '— answer —\nThe **covariance estimator** understates Φ.\n', 24);

  const s = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    return {
      tools: [...box.querySelectorAll('.cseg.cs-tool')].map(e => e.textContent),
      results: [...box.querySelectorAll('.cseg.cs-res')].map(e => e.textContent),
      thinks: box.querySelectorAll('.cseg.cs-think').length,
      // the answer AFTER the wedge point must be its own segment, not part of
      // one giant raw tail that still contains literal marker lines
      lastSegText: box.querySelector('.csegWrap')?.lastElementChild?.textContent || '',
    };
  });
  assert.ok(s.tools.some(t => /\[tool: Bash\] Pass-through/.test(t)),
    'the tool line after the open fence is a real tool segment, not fence content');
  assert.ok(s.results.some(t => /0\.61/.test(t)), 'the result line survives too');
  assert.ok(s.thinks >= 1, 'the ∴ thinking marker after the fence starts a think segment');
  assert.ok(!/\[tool: Bash\]/.test(s.lastSegText),
    'the trailing segment does not contain swallowed marker lines');

  // once the turn settles, the final answer typesets as markdown (bold, not **)
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  const settled = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')];
    const last = segs[segs.length - 1];
    return { bolded: !!last?.querySelector('strong'), raw: /\*\*/.test(last?.textContent || '') };
  });
  assert.ok(settled.bolded, 'markdown after the unbalanced fence renders formatted');
  assert.ok(!settled.raw, 'no literal ** left behind');
});

test('QUESTION: lines light up as the pink needs-you block — across the variants', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  // the canonical protocol form (the screenshot's case), a bolded variant
  // with math, and a multi-line question with options
  await stream('\n— answer —\nMy recommendation: start with **(A-i)** together.\n'
    + 'QUESTION: Do you want to walk through it **section-by-section** (my recommendation), or should I write up the standalone comparison document?\n'
    + '\n— answer —\nThe refit is cheap either way.\n'
    + '**QUESTION:** Should I re-run at $\\beta = 0.97$ first?\n'
    + '\n— answer —\nTwo threads are on the table.\n'
    + 'QUESTION: Which thread first?\n- (a) the concept mapping\n- (b) the quantitative overlay\n', 28);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting', question: 'Which thread first?' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(600);

  const s = await page.evaluate(() => {
    const qs = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ques')];
    return {
      count: qs.length,
      tags: qs.map(q => q.querySelector('.csTag')?.textContent.trim()),
      texts: qs.map(q => q.querySelector('.csMd')?.textContent || ''),
      bolded: !!qs[0]?.querySelector('strong'),
      katex: !!qs[1]?.querySelector('.katex'),
      list: !!qs[2]?.querySelector('li'),
      pinkBorder: qs[0] ? getComputedStyle(qs[0]).borderColor : null,
    };
  });
  assert.equal(s.count, 3, 'each question variant becomes its own block');
  assert.ok(s.tags.every(t => /question — needs you/.test(t)), 'every block wears the needs-you tag');
  assert.ok(!s.texts.some(t => /QUESTION:/.test(t)), 'the literal QUESTION: token is replaced by the tag');
  assert.match(s.texts[0], /section-by-section/, 'canonical form captured');
  assert.ok(s.bolded, 'markdown inside the question typesets');
  assert.match(s.texts[1], /re-run at/, 'bolded **QUESTION:** variant captured');
  assert.ok(s.katex, 'math inside the question typesets');
  assert.ok(s.list, 'multi-line question keeps its option list inside the block');
  assert.ok(s.pinkBorder && s.pinkBorder !== 'rgba(0, 0, 0, 0)', 'the block carries the red/pink frame');
  // the console is the ONLY home: the session pane's duplicate "claude ·
  // needs you" ask block was removed on purpose — never bring it back
  const paneDup = await page.evaluate(() => ({
    askBlock: !!document.querySelector('#v-alpha .askBlock'),
    needsYou: [...document.querySelectorAll('#v-alpha .chat .who')]
      .some(w => /needs you/i.test(w.textContent)),
  }));
  assert.equal(paneDup.askBlock, false, 'no ask block in the session pane (task.question set)');
  assert.equal(paneDup.needsYou, false, 'no "claude · needs you" header in the session pane');
});

test('QUESTION: quoted in a fence or in the user packet does NOT light up', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  const before = await page.evaluate(() => document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ques').length);
  await stream('\n▸ you ─────\nIf blocked, end with a line starting\nQUESTION: like the protocol says.\n'
    + '\n— answer —\nThe protocol footer looks like:\n\n```text\nQUESTION: am I quoted?\n```\nDone.\n', 26);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  const after = await page.evaluate(() => document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ques').length);
  assert.equal(after, before, 'no new question blocks from quoted forms');
});

test('a BALANCED fence still renders as one code block (markers unaffected)', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('\n— answer —\nExample:\n\n```text\nplain fenced body\nstill fenced\n```\nDone with `inline` code.\n', 24);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  const s = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')];
    const last = segs[segs.length - 1];
    return {
      hasPre: !!last?.querySelector('pre'),
      preText: last?.querySelector('pre')?.textContent || '',
    };
  });
  assert.ok(s.hasPre, 'balanced fence typesets as a code block');
  assert.match(s.preText, /plain fenced body/);
});

test('single ~ "approximately" tildes never pair into strikethrough', opts, async () => {
  // The bug (docs/console-tilde-strikethrough-diagnosis.txt): marked's GFM
  // del rule accepts SINGLE tildes, so "(~97–98%)" paired with "≤~2018" and
  // struck out everything between — and split the **bold** pair across the
  // del boundary into literal asterisks. Strikethrough now requires ~~.
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('\n— answer —\nCoverage is excellent (~97–98%) back to the 1950s, so their `cnp` is unstable. '
    + '**Restrict the quality measure to ≤~2018** (or down-weight recent years). '
    + 'Real ~~struck~~ strikethrough still works.\n', 30);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  const s = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')];
    const last = segs[segs.length - 1];
    return {
      dels: [...(last?.querySelectorAll('del') || [])].map(d => d.textContent),
      text: last?.textContent || '',
      bolded: !!last?.querySelector('strong'),
    };
  });
  assert.deepEqual(s.dels, ['struck'], 'only the ~~…~~ span is struck through');
  assert.match(s.text, /\(~97–98%\)/, 'approximately-tildes stay literal prose');
  assert.match(s.text, /≤~2018/, 'the would-be closing tilde stays literal too');
  assert.ok(s.bolded, 'the bold that used to span the del boundary typesets');
  assert.ok(!/\*\*/.test(s.text), 'no literal ** left behind');
});

test('you-echo packets: angle-bracket placeholders show literally, JSON never struck', opts, async () => {
  // task-007's handoff packet: "(~2.8GB)" in prose paired with a
  // quote-touching "~2.8 GB" thousands of chars later in the numbers JSON
  // (no blank lines = one markdown paragraph), striking the whole artifacts
  // block between them. And data/<format>/<entity>/ lost its placeholders to
  // the sanitizer (parsed as HTML tags). Console segments are chat, not
  // documents: raw HTML now shows literally.
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('\n▸ you ─────\ncompleted the full pull: 132/132 works batches (~2.8GB). Then did extensive validation.\n'
    + '"artifacts": [\n'
    + '  ["utils.R", "pin_manifest updated to data/<format>/<entity>/manifest.json + man$files"],\n'
    + '  ["kept_extract_size", "~2.8 GB (authors 609MB + works 2.2GB)"]\n'
    + ']\n'
    + '\n— answer —\nNoted.\n', 40);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(500);
  const s = await page.evaluate(() => {
    const yous = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-you')];
    const last = yous[yous.length - 1];
    return {
      dels: last ? last.querySelectorAll('del').length : -1,
      text: last?.textContent || '',
    };
  });
  assert.equal(s.dels, 0, 'no phantom strikethrough across the packet');
  assert.match(s.text, /data\/<format>\/<entity>\/manifest\.json/, 'placeholders survive as text');
  assert.match(s.text, /\(~2\.8GB\)/, 'the opener tilde stays literal');
});

test('parseTexMacros harvests the preamble dialect (and skips what KaTeX cannot say)', opts, async () => {
  const TEX = String.raw`
% \newcommand{\dead}{\alpha}
\newcommand{\E}{\mathbb{E}}
\newcommand{\1}{\mathbbm{1}}
\newcommand{\ip}[2]{\left\langle #1,\; #2\right\rangle}
\newcommand{\opt}[2][x]{#1 #2}
\renewcommand\footnotesize{\tiny}
\DeclareMathOperator*{\argmin}{arg\,min}
\providecommand{\E}{\mathrm{E}}
`;
  const out = await page.evaluate((t) => window.__parseTexMacros(t), TEX);
  assert.equal(out['\\E'], '\\mathbb{E}', 'harvested; a later \\providecommand must not override');
  assert.equal(out['\\1'], '\\mathbb{1}', 'control-symbol name + \\mathbbm→\\mathbb translation');
  assert.equal(out['\\ip'], '\\left\\langle #1,\\; #2\\right\\rangle', '[nargs] dropped, #n body kept');
  assert.equal(out['\\opt'], undefined, 'optional-arg macro skipped (not expressible in KaTeX)');
  assert.equal(out['\\dead'], undefined, 'commented-out definitions ignored');
  assert.equal(out['\\argmin'], '\\operatorname*{arg\\,min}', 'DeclareMathOperator* → \\operatorname*');
  assert.equal(out['\\footnotesize'], '\\tiny', 'unbraced-name form parsed');
});

test('pinned-preamble macros typeset console math — even when the pin loads late', opts, async () => {
  // The red-math bug (docs/console-red-math-diagnosis.txt): Claude writes
  // $\ah(\cdot)$, $\E[e^\varepsilon]$ in the paper's shorthand and KaTeX
  // paints the unknown macros red (inline color:#cc0000 — NOT .katex-error).
  // The pin's fetch is HELD below so the console must first paint red, then
  // the release must heal it (the rev-stamped re-typeset path).
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'paper.tex'),
    '\\documentclass{article}\n'
    + '\\newcommand{\\E}{\\mathbb{E}}\n'
    + '\\newcommand{\\ah}{\\hat{a}}\n'
    + '\\begin{document}x\\end{document}\n');
  let release; const held = new Promise((r) => { release = r; });
  await page.route('**/artifact/alpha/paper.tex', async (r) => { await held; await r.continue(); });

  const { body: b3 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Macro math', description: 'x',
    category: 'calibration', oversight: 'coop', context: { files: ['paper.tex'] },
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${b3.id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's3', startedAt: b3.created, lastTurnAt: b3.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  await wsPush('task:update', { project: 'alpha', task: { ...task, ...b3, status: 'waiting' } });
  await sleep(200);
  await page.evaluate((x) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x).click();
  }, b3.id);
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
  await sleep(300);

  await wsPush('session:stream', { project: 'alpha', id: b3.id,
    chunk: '\n— answer —\nRegularity: $\\ah(\\cdot)$ is continuous and $\\E[e^\\varepsilon] = 1$.\n' });
  await sleep(500);
  // KaTeX's errorColor #cc0000 — the DOM normalizes it to rgb(204, 0, 0)
  const redCount = () => page.evaluate(() =>
    [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans .katex [style]')]
      .filter((e) => e.style.color === 'rgb(204, 0, 0)').length);
  assert.ok(await redCount() > 0, 'before the pin loads, the unknown macros paint red (the bug, live)');

  release();
  // fetch lands → renderWB → harvest bumps the rev → re-typeset; poll for the
  // re-typeset instead of betting a fixed sleep on fetch + KaTeX latency
  for (let i = 0; i < 30 && (await redCount()) > 0; i++) await sleep(150);
  const s = await page.evaluate(() => {
    const seg = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')].pop();
    return {
      katex: seg.querySelectorAll('.katex').length,
      accent: !!seg.querySelector('.katex .accent'), // \hat{a} really expanded
    };
  });
  assert.equal(await redCount(), 0, 'once the pin loads, \\ah and \\E typeset via harvested macros');
  assert.ok(s.katex >= 2 && s.accent, 'the math actually expanded (hat accent present)');
  await page.unroute('**/artifact/alpha/paper.tex');
});

test('pdf-sibling harvest (v2.12): pinning only the compiled pdf still typesets the dialect', opts, async () => {
  // The task-015 shape from the field: the task pins a compiled PDF (or nothing)
  // while the session reads the .tex itself and answers in its macros. The
  // widened harvest fetches the pdf pin's tex SIBLING on its own.
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'sib.tex'),
    '\\documentclass{article}\n'
    + '\\newcommand{\\Hs}{\\mathsf{H}}\n'
    + '\\newcommand{\\xh}{\\hat{x}}\n'
    + '\\begin{document}x\\end{document}\n');
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'sib.pdf'), '%PDF-1.4 fake\n');

  const { body: b4 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Sibling dialect', description: 'x',
    category: 'calibration', oversight: 'coop', context: { files: ['sib.pdf'] }, // NO tex pin
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${b4.id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's4', startedAt: b4.created, lastTurnAt: b4.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  await wsPush('task:update', { project: 'alpha', task: { ...task, ...b4, status: 'waiting' } });
  await sleep(200);
  await page.evaluate((x) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x).click();
  }, b4.id);
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
  await sleep(300);

  await wsPush('session:stream', { project: 'alpha', id: b4.id,
    chunk: '\n— answer —\nThe fixed point of $\\Hs$ prices risk at $\\xh_{-1}$.\n' });
  // first render queues the sibling fetch; poll until its arrival re-typesets
  // the answer clean (typeset present AND no red) instead of a fixed sleep
  const settled = () => page.evaluate(() => {
    // fully settled = BOTH math spans typeset, the \hat accent expanded, and
    // no red — anything less is a mid-typeset frame the poll must ride out
    const seg = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')].pop();
    if (!seg || seg.querySelectorAll('.katex').length < 2) return false;
    if (!seg.querySelector('.katex .accent')) return false;
    return [...seg.querySelectorAll('.katex [style]')]
      .filter((e) => e.style.color === 'rgb(204, 0, 0)').length === 0;
  });
  for (let i = 0; i < 30 && !(await settled()); i++) await sleep(150);
  const s = await page.evaluate(() => {
    const seg = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')].pop();
    return {
      red: [...seg.querySelectorAll('.katex [style]')]
        .filter((e) => e.style.color === 'rgb(204, 0, 0)').length,
      katex: seg.querySelectorAll('.katex').length,
      accent: !!seg.querySelector('.katex .accent'), // \hat{x} expanded
    };
  });
  assert.equal(s.red, 0, `\\Hs and \\xh typeset via the pdf's tex sibling (${s.red} red)`);
  assert.ok(s.katex >= 2 && s.accent, 'math expanded through the sibling harvest');
});

test('project-wide harvest (v2.12): a dialect learned in one task serves a pinless task', opts, async () => {
  // seen.tex was harvested while viewing ANOTHER task that pins it; a task
  // with no pins at all still gets the project's accumulated dialect.
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'seen.tex'),
    '\\documentclass{article}\n'
    + '\\newcommand{\\Qz}{\\mathbb{Q}}\n'
    + '\\begin{document}x\\end{document}\n');
  const { body: pinner } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Pins the source', description: 'x',
    category: 'calibration', oversight: 'coop', context: { files: ['seen.tex'] },
  });
  await wsPush('task:update', { project: 'alpha', task: { ...task, ...pinner, status: 'queued' } });
  await sleep(200);
  await page.evaluate((x) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x).click();
  }, pinner.id); // viewing it fetches + harvests seen.tex
  await sleep(600);

  const { body: bare } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'No pins at all', description: 'x',
    category: 'calibration', oversight: 'coop', context: { files: [] },
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${bare.id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's5', startedAt: bare.created, lastTurnAt: bare.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  await wsPush('task:update', { project: 'alpha', task: { ...task, ...bare, status: 'waiting' } });
  await sleep(200);
  await page.evaluate((x) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x).click();
  }, bare.id);
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
  await sleep(300);
  await wsPush('session:stream', { project: 'alpha', id: bare.id,
    chunk: '\n— answer —\nUnder $\\Qz$ the measure is invariant.\n' });
  await sleep(600);
  const s = await page.evaluate(() => {
    const seg = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans')].pop();
    return {
      red: [...seg.querySelectorAll('.katex [style]')]
        .filter((e) => e.style.color === 'rgb(204, 0, 0)').length,
      katex: seg.querySelectorAll('.katex').length,
    };
  });
  assert.equal(s.red, 0, `\\Qz typesets from the project-wide harvest (${s.red} red)`);
  assert.ok(s.katex >= 1, 'math rendered');
});

test('links in rendered content open in a NEW tab — the SPA never navigates away', opts, async () => {
  // delegated document-level handler (Graham 2026-07-30): markdown links in
  // console answers carry no target=, and a same-tab navigation would dump
  // the whole dashboard state. window.open is stubbed to observe the call.
  // earlier tests switched to OTHER tasks' consoles — reselect ours first
  await page.evaluate((tid) => {
    [...document.querySelectorAll('#v-alpha .ptab.tk')].find((t) => t.dataset.id === tid)?.click();
  }, id);
  await sleep(300);
  await page.evaluate(() => document.querySelector('#v-alpha .ctab.console')?.click());
  await sleep(200);
  await wsPush('session:stream', { project: 'alpha', id,
    chunk: '\n— answer —\nSee [the BPSE appendix](https://example.org/bpse.pdf) for the details.\n' });
  // close the answer segment — links only exist once the raw streaming tail
  // is re-rendered as markdown
  await wsPush('session:stream', { project: 'alpha', id, chunk: '\n— turn done · 1.0s · 1k in / 1k out —\n' });
  await sleep(500);
  const r = await page.evaluate(async () => {
    window.__opened = null;
    const realOpen = window.open;
    window.open = (u, t, f) => { window.__opened = [u, t, f]; return null; };
    const a = [...document.querySelectorAll('#v-alpha #consoleBox .cseg.cs-ans a')].pop();
    const before = location.href;
    a.click();
    await new Promise((res) => setTimeout(res, 100));
    window.open = realOpen;
    return { opened: window.__opened, stayed: location.href === before, href: a.getAttribute('href') };
  });
  assert.equal(r.href, 'https://example.org/bpse.pdf', 'the answer rendered the link');
  assert.ok(r.stayed, 'the dashboard tab did not navigate');
  assert.deepEqual(r.opened, ['https://example.org/bpse.pdf', '_blank', 'noopener'],
    'the link left via a new tab with noopener');
});
