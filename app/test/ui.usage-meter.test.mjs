// The status bar's usage meter: the collapsed session-window reading, the
// hover/click popover onto all three limits, and — the reason it is built as a
// patched node rather than innerHTML — that an open popover survives both the
// ledger heartbeat and the once-a-second countdown repaint.
// Limits arrive as synthetic ledger:update pushes over the stubbed WebSocket,
// so no billed path is touched and the assertions are timing-proof.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush;

// resetAt values are absolute, so build them relative to now at push time
const ledger = (over = {}) => ({
  since: new Date(Date.now() - 2 * 86400e3).toISOString(),
  perProject: { alpha: { seconds: 3600, tokensIn: 1000, tokensOut: 500, costUsd: 1 } },
  totals: { seconds: 3600, tokens: 1500, costUsd: 1 },
  hourTarget: 35,
  usage: {
    limits: [
      { key: '5h', name: '5h session', sub: 'rolling', pct: 62, spent: 3.1e6, budget: 5e6,
        resetAt: new Date(Date.now() + 6420e3).toISOString() },
      { key: 'wk', name: 'week', sub: 'all models', pct: 38, spent: 1.5e7, budget: 4e7,
        resetAt: new Date(Date.now() + 367200e3).toISOString() },
      { key: 'fable', name: 'week', sub: 'fable', pct: 71, spent: 5.7e6, budget: 8e6,
        resetAt: new Date(Date.now() + 367200e3).toISOString() },
    ],
    ...over,
  },
});

const meter = () => page.evaluate(() => {
  const q = document.querySelector('#v-alpha .statusbar > .quota');
  if (!q) return null;
  return {
    hidden: q.style.display === 'none',
    lab: q.querySelector(':scope > .qlab').textContent,
    pct: q.querySelector(':scope > .qpct').textContent,
    fill: q.querySelector(':scope > .qtrack > .qfill').style.width,
    reset: q.querySelector(':scope > .qreset > b').textContent,
    level: q.className.replace('quota', '').trim(),
    popOpen: !q.querySelector('.qpop').hidden,
    rows: [...q.querySelectorAll('.qpRow')].map((r) => ({
      key: r.dataset.key,
      pct: r.querySelector('.qpct').textContent,
      fill: r.querySelector('.qfill').style.width,
      lead: r.classList.contains('lead'),
      level: [...r.classList].filter((c) => c === 'warn' || c === 'hot').join(),
    })),
  };
});

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ sb, page, wsPush } = ui);
  // a task is needed for the session pane (and its z-indexed .sessTabs header)
  // to render at all — the stacking test below has nothing to collide with
  // otherwise, and would pass whether or not the bug is present
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibration', category: 'calibration', oversight: 'coop',
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .statusbar', { timeout: 15000 });
  await sleep(300);
  await wsPush('ledger:update', ledger());
  await sleep(150);
});

after(async () => { if (ui) await ui.stop(); });

test('collapsed meter reads the session window, not the worst limit', opts, async () => {
  const m = await meter();
  assert.equal(m.lab, '5h', 'label is the session window even though fable is further along');
  assert.equal(m.pct, '62%');
  assert.equal(m.fill, '62%');
  assert.match(m.reset, /^1h 4[0-9]m$/, m.reset);
  assert.equal(m.level, '', '62% is below the 70% amber threshold');
});

test('the collapsed cluster keeps a fixed width so it cannot jitter as it counts down', opts, async () => {
  const w = await page.evaluate(() => {
    const q = document.querySelector('#v-alpha .statusbar > .quota');
    const cs = (s) => getComputedStyle(q.querySelector(`:scope > ${s}`)).minWidth;
    return { pct: cs('.qpct'), reset: cs('.qreset') };
  });
  assert.equal(w.pct, '32px');
  assert.equal(w.reset, '64px');
});

test('hover opens the popover onto all three limits, each at its own level', opts, async () => {
  await page.hover('#v-alpha .statusbar > .quota');
  await sleep(300);
  const m = await meter();
  assert.ok(m.popOpen, 'popover opened on hover');
  assert.deepEqual(m.rows.map((r) => r.key), ['5h', 'wk', 'fable']);
  assert.deepEqual(m.rows.map((r) => r.pct), ['62%', '38%', '71%']);
  assert.deepEqual(m.rows.map((r) => r.fill), ['62%', '38%', '71%']);
  // the per-row level must NOT inherit the collapsed meter's — only fable is amber
  assert.deepEqual(m.rows.map((r) => r.level), ['', '', 'warn']);
  assert.deepEqual(m.rows.map((r) => r.lead), [true, false, false], 'session row is marked lead');
});

test('nothing in the popover overflows the panel', opts, async () => {
  const over = await page.evaluate(() => {
    const pop = document.querySelector('#v-alpha .statusbar .qpop');
    const pad = parseFloat(getComputedStyle(pop).paddingRight);
    const edge = pop.getBoundingClientRect().right - pad;
    return [...pop.querySelectorAll('.qpRow *')]
      .map((el) => el.getBoundingClientRect().right - edge)
      .filter((d) => d > 0.5);
  });
  assert.deepEqual(over, [], 'a row cell escaped the panel padding');
});

// Regression: .statusbar has backdrop-filter, which makes it a stacking
// context — so the popover's own z-index only ranks it against the bar's
// children, and the workbench panes' positioned chrome (.sessTabs/.sessHead,
// dividers, pane dropdowns) painted straight over it. Because that chrome is a
// translucent --chrome-88 strip it washed the panel out instead of hiding it,
// which reads as a rendering glitch rather than a stacking bug. Assert the
// behaviour — the popover is hit-testable along its full height — rather than
// any particular z-index number.
test('the popover paints above the workbench panes it opens over', opts, async () => {
  await page.click('#v-alpha .statusbar > .quota');
  await sleep(300);
  // Drive the vertical split so the session pane's z-indexed tab strip lands in
  // the middle of the open popover. Computed rather than hard-coded: the exact
  // percentage depends on viewport height, and a split that misses the panel
  // makes this test pass whether or not the bug is present.
  await page.evaluate(() => {
    const wb = document.querySelector('#v-alpha .wb');
    const pop = document.querySelector('#v-alpha .qpop');
    const wr = wb.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    const targetTop = pr.top + pr.height / 2;          // want .sessTabs here
    // .sessHalf is top:calc(var(--vsplit) + 2%) within .wb; .sessTabs sits at its top
    wb.style.setProperty('--vsplit', (((targetTop - wr.top) / wr.height) * 100 - 2) + '%');
  });
  await sleep(250);

  const r = await page.evaluate(() => {
    const pop = document.querySelector('#v-alpha .qpop');
    const chrome = document.querySelector('#v-alpha .sessTabs') || document.querySelector('#v-alpha .sessHead');
    const pr = pop.getBoundingClientRect(), cr = chrome && chrome.getBoundingClientRect();
    if (!cr) return { setup: 'no session pane chrome to collide with' };
    const y = cr.top + cr.height / 2;
    const overlaps = y > pr.top && y < pr.bottom && cr.right > pr.left && cr.left < pr.right;
    const el = document.elementFromPoint(pr.left + pr.width / 2, y);
    return { setup: null, overlaps, topmost: el && (el.className || el.tagName), inPop: !!(el && pop.contains(el)) };
  });
  // fail loudly if the collision never got set up, rather than passing vacuously
  assert.equal(r.setup, null, r.setup);
  assert.ok(r.overlaps, 'test setup failed to overlap the pane chrome with the popover');
  assert.ok(r.inPop, `a pane element (${r.topmost}) is painting over the popover`);

  await page.evaluate(() => document.querySelector('#v-alpha .wb').style.removeProperty('--vsplit'));
  await page.keyboard.press('Escape');
  await sleep(150);
});

test('click pins the popover, and it survives a ledger heartbeat', opts, async () => {
  await page.click('#v-alpha .statusbar > .quota');
  await sleep(120);
  assert.ok((await meter()).popOpen, 'click pinned it open');
  // move the pointer away — pinned means it stays
  await page.mouse.move(20, 20);
  await sleep(350);
  assert.ok((await meter()).popOpen, 'stayed open after the pointer left');
  // the heartbeat that used to rebuild .statusbar innerHTML
  await wsPush('ledger:update', ledger());
  await sleep(250);
  const m = await meter();
  assert.ok(m.popOpen, 'popover survived the ledger push');
  assert.equal(m.rows.length, 3, 'rows were patched, not torn out');
});

test('the countdown ticks without collapsing the pinned popover', opts, async () => {
  // a sub-5-minute reset renders with SECONDS (fmtLeft), so the label is
  // guaranteed to change across the wait — the minute-granularity "1h 47m"
  // form can sit still for up to 60s and made this assertion a coin flip
  const l = ledger();
  l.usage.limits[0] = { ...l.usage.limits[0], resetAt: new Date(Date.now() + 240e3).toISOString() };
  await wsPush('ledger:update', l);
  await sleep(250);
  const before = (await meter()).reset;
  await sleep(2100);
  const m = await meter();
  assert.ok(m.popOpen, 'the 1s repaint left the popover open');
  assert.notEqual(m.reset, before, `countdown did not advance (${before})`);
});

test('Escape closes it and clears the pin', opts, async () => {
  await page.focus('#v-alpha .statusbar > .quota');
  await page.keyboard.press('Escape');
  await sleep(120);
  assert.equal((await meter()).popOpen, false);
});

test('a limit past 90% turns the collapsed meter red', opts, async () => {
  const hot = ledger();
  hot.usage.limits[0] = { ...hot.usage.limits[0], pct: 96 };
  await wsPush('ledger:update', hot);
  await sleep(200);
  const m = await meter();
  assert.equal(m.pct, '96%');
  assert.equal(m.level, 'hot');
});

test('an open session window with no activity shows no countdown rather than 0', opts, async () => {
  const idle = ledger();
  idle.usage.limits[0] = { ...idle.usage.limits[0], pct: 0, spent: 0, resetAt: null };
  await wsPush('ledger:update', idle);
  await sleep(200);
  const m = await meter();
  assert.equal(m.pct, '0%');
  assert.equal(m.reset, '—', 'null resetAt renders as an em dash, not "now"');
});

test('the meter hides itself when the ledger reports no limits', opts, async () => {
  await wsPush('ledger:update', { ...ledger(), usage: null });
  await sleep(200);
  assert.equal((await meter()).hidden, true);
  // and comes back when limits return
  await wsPush('ledger:update', ledger());
  await sleep(200);
  assert.equal((await meter()).hidden, false);
});

// Real plan windows (lib/usage.js) replace the estimate when a turn has pulled
// them. They carry no spent/budget, so anything that assumed those must adapt,
// and the panel has to say how stale the reading is — it only refreshes when a
// task runs, so it must never read as live.
const planLedger = () => ({
  ...ledger(),
  usage: {
    source: 'plan', subscription: 'max',
    fetchedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    limits: [
      { key: '5h', name: '5h session', sub: 'rolling', pct: 14, real: true,
        resetAt: new Date(Date.now() + 6420e3).toISOString() },
      { key: 'wk', name: 'week', sub: 'all models', pct: 14, real: true,
        resetAt: new Date(Date.now() + 367200e3).toISOString() },
      { key: 'fable', name: 'week', sub: 'fable', pct: 19, real: true,
        resetAt: new Date(Date.now() + 367200e3).toISOString() },
    ],
  },
});

test('real plan windows render, and the footer dates the reading', opts, async () => {
  await wsPush('ledger:update', planLedger());
  await sleep(200);
  await page.hover('#v-alpha .statusbar > .quota');
  await sleep(300);
  const m = await meter();
  assert.equal(m.pct, '14%');
  assert.deepEqual(m.rows.map((r) => r.pct), ['14%', '14%', '19%']);
  const foot = await page.evaluate(() => document.querySelector('#v-alpha .qpF').textContent);
  assert.match(foot, /from your claude plan/i);
  assert.match(foot, /\(max\)/i);
  assert.match(foot, /7m ago/, `footer must date the reading, got: ${foot}`);
  assert.doesNotMatch(foot, /config\.json/i, 'must not claim a configured budget');
});

test('the estimate says so plainly instead of impersonating plan data', opts, async () => {
  await wsPush('ledger:update', ledger());   // source omitted → estimate
  await sleep(200);
  const foot = await page.evaluate(() => document.querySelector('#v-alpha .qpF').textContent);
  assert.match(foot, /estimated/i);
  assert.match(foot, /config\.json/i);
  assert.doesNotMatch(foot, /your claude plan/i);
});

test('a plan payload without a per-model cap shows no per-model row', opts, async () => {
  const noFable = planLedger();
  noFable.usage.limits = noFable.usage.limits.filter((L) => L.key !== 'fable');
  await wsPush('ledger:update', noFable);
  await sleep(250);
  const m = await meter();
  assert.deepEqual(m.rows.map((r) => r.key), ['5h', 'wk'],
    'a cap the account does not have must not appear as a permanent 0%');
  await page.keyboard.press('Escape');
  await sleep(120);
});

test('the left-hand status segments still render alongside the meter', opts, async () => {
  const left = await page.evaluate(() =>
    document.querySelector('#v-alpha .statusbar > .sbLeft')?.textContent || '');
  assert.match(left, /tok/, 'the wk … tok figure is still there');
});

test('session and project counters expose exact processed tokens and uncertainty', opts, async () => {
  const result = await page.evaluate(async () => {
    const { sessionBody } = await import('/session.js');
    const { tasksOf } = await import('/store.js');
    const task = { ...tasksOf('alpha')[0], status: 'waiting', session: {
      provider: 'claude', tokensIn: 8123456, tokensOut: 376545, turns: 7,
      usageCompleteness: 'legacy-unverified', usageLegacyTokens: 100,
    } };
    const box = document.createElement('div');
    box.innerHTML = sessionBody('alpha', task);
    const span = box.querySelector('.sessbar span[title]');
    return { text: span?.textContent, title: span?.getAttribute('title'),
      projectTitle: document.querySelector('#v-alpha .sbLeft span[title*="Project this week"]')?.getAttribute('title') };
  });
  assert.match(result.text, /8\.5M tok processed/);
  assert.match(result.title, /8,500,001 tokens processed/);
  assert.match(result.title, /100 historical tokens unverified/);
  assert.match(result.title, /Active work may not yet be included/);
  assert.match(result.projectTitle, /1,500 tokens processed/);
});

test('estimated quota tooltip is exact and discloses unknown-provider exclusions', opts, async () => {
  await wsPush('ledger:update', ledger({ unknownProviderTokens: 1234567 }));
  await sleep(200);
  const value = await page.evaluate(() => ({
    title: document.querySelector('#v-alpha .quota')?.getAttribute('title'),
    foot: document.querySelector('#v-alpha .qpF')?.textContent,
  }));
  assert.match(value.title, /3,100,000 of 5,000,000 tokens processed/);
  assert.match(value.title, /not subscription allowance/);
  assert.match(value.foot, /Claude-attributed tokens only/);
  assert.match(value.foot, /1,234,567 historical tokens with unknown provider excluded/);
});
