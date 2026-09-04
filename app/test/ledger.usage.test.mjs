// test/ledger.usage.test.mjs — usageWindows(): the three limits behind the
// status bar's usage meter.
//
// Same approach as ledger.test.mjs: ledger.js binds LEDGER_FILE at import time
// with no seam, so we extract the REAL source of usageWindows (+ the weekStart
// and topLabel it calls) and drive it with a loadEntries() reading a temp
// fixture. This exercises the shipped code, not a re-implementation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp, extractFunction, APP_DIR } from './helpers.mjs';

const SRC = path.join(APP_DIR, 'lib', 'ledger.js');
const LIMITS = {
  sessionHours: 5,
  sessionTokens: 1000,
  weeklyTokens: 10_000,
  topModel: 'claude-fable-5-1',
  topModelWeeklyTokens: 2000,
};

let tmp, ledgerFile;
/** Bind the extracted functions against a given USAGE_LIMITS. */
function build(limits) {
  const bodies = ['weekStart', 'usageWindows', 'topLabel']
    .map((n) => extractFunction(SRC, n)).join('\n');
  const factory = new Function('loadEntries', 'USAGE_LIMITS',
    `${bodies}\nreturn { usageWindows };`);
  return factory(() => {
    const out = [];
    let raw = '';
    try { raw = fs.readFileSync(ledgerFile, 'utf8'); } catch { /* none */ }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { const e = JSON.parse(t); if (e && typeof e === 'object') out.push(e); } catch { /* skip */ }
    }
    return out;
  }, limits);
}

before(() => { tmp = mkTmp('cp-usage-'); ledgerFile = path.join(tmp, 'ledger.jsonl'); });
after(() => rmTmp(tmp));

function writeLedger(lines) {
  fs.writeFileSync(ledgerFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}
const tok = (isoTs, n, model) => ({ ts: isoTs, type: 'tokens', project: 'alpha', in: n, out: 0, costUsd: 0, model });
const agoISO = (now, ms) => new Date(now - ms).toISOString();
const byKey = (r, k) => r.limits.find((L) => L.key === k);
const HOUR = 3600 * 1000;

describe('usageWindows — shape and gating', () => {
  test('returns null when the meter is disabled', () => {
    writeLedger([]);
    assert.equal(build(null).usageWindows(Date.now()), null);
  });

  test('emits exactly the three limits, per-model row keyed off the model id', () => {
    writeLedger([]);
    const r = build(LIMITS).usageWindows(Date.now());
    assert.deepEqual(r.limits.map((L) => L.key), ['5h', 'wk', 'fable']);
    assert.equal(r.limits[0].name, '5h session');
    assert.equal(r.limits[2].sub, 'fable');
  });

  test('an unrecognised topModel degrades to a "top" tag rather than throwing', () => {
    writeLedger([]);
    const r = build({ ...LIMITS, topModel: 'gpt-9' }).usageWindows(Date.now());
    assert.equal(r.limits[2].key, 'top');
  });
});

describe('usageWindows — the rolling session window', () => {
  test('counts only entries inside the window', () => {
    const now = Date.now();
    writeLedger([
      tok(agoISO(now, 2 * HOUR), 300, 'claude-opus-5'),   // in
      tok(agoISO(now, 6 * HOUR), 900, 'claude-opus-5'),   // older than 5h — out
    ]);
    const s = byKey(build(LIMITS).usageWindows(now), '5h');
    assert.equal(s.spent, 300);
    assert.equal(s.pct, 30);
  });

  test('resets five hours after the window opened, not five hours from now', () => {
    const now = Date.now();
    writeLedger([
      tok(agoISO(now, 4 * HOUR), 100, 'claude-opus-5'),   // anchor
      tok(agoISO(now, 1 * HOUR), 100, 'claude-opus-5'),
    ]);
    const s = byKey(build(LIMITS).usageWindows(now), '5h');
    // anchored 4h ago on a 5h window → ~1h left
    assert.ok(Math.abs((Date.parse(s.resetAt) - now) - HOUR) < 60_000, s.resetAt);
  });

  test('no recent activity means no open window — resetAt is null, not a countdown', () => {
    const now = Date.now();
    writeLedger([tok(agoISO(now, 40 * HOUR), 500, 'claude-opus-5')]);
    const s = byKey(build(LIMITS).usageWindows(now), '5h');
    assert.equal(s.spent, 0);
    assert.equal(s.resetAt, null);
  });

  test('counts input and output tokens together', () => {
    const now = Date.now();
    writeLedger([{ ts: agoISO(now, HOUR), type: 'tokens', project: 'alpha', in: 200, out: 300, costUsd: 0, model: 'claude-opus-5' }]);
    assert.equal(byKey(build(LIMITS).usageWindows(now), '5h').spent, 500);
  });

  test('ignores time entries and tolerates corrupt lines', () => {
    const now = Date.now();
    writeLedger([
      { ts: agoISO(now, HOUR), type: 'time', project: 'alpha', seconds: 1800 },
      '{ not json',
      tok(agoISO(now, HOUR), 250, 'claude-opus-5'),
      { ts: 'not-a-date', type: 'tokens', project: 'alpha', in: 999, out: 0 },
    ]);
    assert.equal(byKey(build(LIMITS).usageWindows(now), '5h').spent, 250);
  });
});

describe('usageWindows — the two weekly windows', () => {
  test('the per-model window counts only that model; all-models counts both', () => {
    const now = Date.now();
    writeLedger([
      tok(agoISO(now, HOUR), 400, 'claude-fable-5-1'),
      tok(agoISO(now, 2 * HOUR), 600, 'claude-opus-5'),
    ]);
    const r = build(LIMITS).usageWindows(now);
    assert.equal(byKey(r, 'wk').spent, 1000);
    assert.equal(byKey(r, 'fable').spent, 400);
  });

  test('pre-model entries count toward all-models but not the per-model row', () => {
    const now = Date.now();
    writeLedger([{ ts: agoISO(now, HOUR), type: 'tokens', project: 'alpha', in: 700, out: 0, costUsd: 0 }]);
    const r = build(LIMITS).usageWindows(now);
    assert.equal(byKey(r, 'wk').spent, 700);
    assert.equal(byKey(r, 'fable').spent, 0);
  });

  test('both weekly rows share the Monday boundary and always carry a reset', () => {
    const now = Date.now();
    writeLedger([tok(agoISO(now, HOUR), 10, 'claude-fable-5-1')]);
    const r = build(LIMITS).usageWindows(now);
    assert.equal(byKey(r, 'wk').resetAt, byKey(r, 'fable').resetAt);
    assert.ok(Date.parse(byKey(r, 'wk').resetAt) > now);
  });
});

describe('usageWindows — pct', () => {
  test('rounds, and clamps at 100 rather than reporting over-budget', () => {
    const now = Date.now();
    writeLedger([tok(agoISO(now, HOUR), 5000, 'claude-fable-5-1')]); // 5x the 1000 session budget
    const s = byKey(build(LIMITS).usageWindows(now), '5h');
    assert.equal(s.pct, 100);
    assert.equal(s.spent, 5000, 'spend itself is still reported truthfully');
  });

  test('an empty ledger is 0%, not NaN', () => {
    writeLedger([]);
    for (const L of build(LIMITS).usageWindows(Date.now()).limits) assert.equal(L.pct, 0);
  });
});

// Which of the two sources weekSummary() serves. `"usageLimits": false` is not
// merely "hide the meter" — it is PLAN-ONLY mode: show real windows when a turn
// has fetched them, and show nothing at all rather than an estimate the user
// has said they don't trust.
describe('weekSummary — choosing plan data over the estimate', () => {
  const PLAN = { limits: [{ key: '5h', name: '5h session', sub: 'rolling', pct: 20, resetAt: null, real: true }],
    source: 'plan', subscription: 'max', fetchedAt: '2026-07-24T19:00:00.000Z' };

  /** weekSummary bound to a given USAGE_LIMITS + realUsage() stub. */
  function summaryWith(limits, realUsageStub) {
    const bodies = ['weekStart', 'usageWindows', 'topLabel', 'weekSummary']
      .map((n) => extractFunction(SRC, n)).join('\n');
    return new Function('loadEntries', 'PROJECTS', 'WEEKLY_HOUR_TARGET', 'USAGE_LIMITS', 'realUsage',
      `${bodies}\nreturn weekSummary;`)(() => [], { alpha: {} }, 35, limits, realUsageStub)();
  }

  test('a plan reading wins over the estimate whenever one exists', () => {
    const u = summaryWith(LIMITS, () => PLAN).usage;
    assert.equal(u.source, 'plan');
    assert.equal(u.limits[0].real, true);
  });

  test('with budgets configured, no plan reading falls back to the estimate', () => {
    const u = summaryWith(LIMITS, () => null).usage;
    assert.equal(u.source, 'estimate');
    assert.ok(u.limits.length);
  });

  test('plan-only mode ("usageLimits": false): no reading → no usage at all, so the meter hides', () => {
    assert.equal(summaryWith(null, () => null).usage, null);
  });

  test('plan-only mode still serves real windows when a turn has fetched them', () => {
    const u = summaryWith(null, () => PLAN).usage;
    assert.equal(u.source, 'plan');
    assert.equal(u.limits[0].pct, 20);
  });
});
