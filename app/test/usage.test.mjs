// test/usage.test.mjs — normalizing the Agent SDK's plan-usage payload.
//
// The fixtures below are the REAL shape returned by
// usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() on a live Max
// account (captured 2026-07-24), trimmed of account-identifying values. Two
// details cost real debugging and are pinned here on purpose:
//   * seven_day_opus / seven_day_sonnet were BOTH null while a per-model cap
//     was actively in use — the live figure was only in model_scoped[].
//   * utilization from this endpoint is 0-100. The pushed rate_limit_event
//     reports the same quantity as a 0-1 fraction; mixing them is a 100x error.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, recordUsage, realUsage, _resetUsage } from '../lib/usage.js';

const LIVE = {
  rate_limits_available: true,
  subscription_type: 'max',
  rate_limits: {
    five_hour: { utilization: 14, resets_at: '2026-07-24T23:00:00.814078+00:00' },
    seven_day: { utilization: 14, resets_at: '2026-07-30T18:00:00.814102+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: 'Fable', utilization: 19, resets_at: '2026-07-30T18:00:00.080802+00:00' }],
    limits: [
      { kind: 'session', group: 'session', percent: 14, resets_at: '2026-07-24T23:00:00.080480+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 14, resets_at: '2026-07-30T18:00:00.080504+00:00', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 19, resets_at: '2026-07-30T18:00:00.080802+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
    ],
  },
};
const keys = (r) => r.limits.map((L) => L.key);

beforeEach(() => _resetUsage());

describe('normalizeUsage — gating', () => {
  test('null for an API-key session (no plan windows exist)', () => {
    assert.equal(normalizeUsage({ rate_limits_available: false, rate_limits: null }), null);
  });
  test('null for a missing or malformed payload', () => {
    for (const p of [null, undefined, {}, { rate_limits_available: true, rate_limits: null }]) {
      assert.equal(normalizeUsage(p), null);
    }
  });
  test('null when every window is empty, so the meter falls back rather than showing nothing', () => {
    assert.equal(normalizeUsage({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null } }), null);
  });
});

describe('normalizeUsage — the live payload', () => {
  test('produces session, weekly and the per-model row, in that order', () => {
    const r = normalizeUsage(LIVE);
    assert.deepEqual(keys(r), ['5h', 'wk', 'fable']);
    assert.equal(r.subscription, 'max');
  });

  test('carries utilization straight through as 0-100', () => {
    const r = normalizeUsage(LIVE);
    assert.deepEqual(r.limits.map((L) => L.pct), [14, 14, 19]);
  });

  test('every row is flagged real, so the UI stops claiming a configured budget', () => {
    assert.ok(normalizeUsage(LIVE).limits.every((L) => L.real === true));
  });

  test('reads the per-model cap from model_scoped even though seven_day_opus/sonnet are null', () => {
    const r = normalizeUsage(LIVE);
    const fable = r.limits.find((L) => L.key === 'fable');
    assert.equal(fable.pct, 19);
    assert.equal(fable.sub, 'fable');
    assert.equal(fable.name, 'week');
  });
});

describe('normalizeUsage — the per-model row is derived, never assumed', () => {
  test('no model_scoped and no scoped limits → no per-model row at all', () => {
    const p = { ...LIVE, rate_limits: { ...LIVE.rate_limits, model_scoped: [], limits: [] } };
    assert.deepEqual(keys(normalizeUsage(p)), ['5h', 'wk']);
  });

  test('falls back to limits[] kind=weekly_scoped when model_scoped is absent', () => {
    const rl = { ...LIVE.rate_limits }; delete rl.model_scoped;
    assert.deepEqual(keys(normalizeUsage({ ...LIVE, rate_limits: rl })), ['5h', 'wk', 'fable']);
  });

  test('falls back to the named seven_day_* windows only when nothing scoped exists', () => {
    const p = { ...LIVE, rate_limits: { ...LIVE.rate_limits, model_scoped: [], limits: [],
      seven_day_opus: { utilization: 42, resets_at: '2026-07-30T18:00:00Z' } } };
    const r = normalizeUsage(p);
    assert.deepEqual(keys(r), ['5h', 'wk', 'opus']);
    assert.equal(r.limits[2].pct, 42);
  });

  test('several per-model caps each get their own row', () => {
    const p = { ...LIVE, rate_limits: { ...LIVE.rate_limits, model_scoped: [
      { display_name: 'Fable', utilization: 19, resets_at: '2026-07-30T18:00:00Z' },
      { display_name: 'Opus', utilization: 7, resets_at: '2026-07-30T18:00:00Z' },
    ] } };
    assert.deepEqual(keys(normalizeUsage(p)), ['5h', 'wk', 'fable', 'opus']);
  });

  test('a window present but with a null reading yields no row', () => {
    const p = { ...LIVE, rate_limits: { ...LIVE.rate_limits, five_hour: { utilization: null, resets_at: null } } };
    assert.deepEqual(keys(normalizeUsage(p)), ['wk', 'fable']);
  });
});

describe('normalizeUsage — resets_at', () => {
  test('ISO strings are normalized to ISO', () => {
    assert.equal(normalizeUsage(LIVE).limits[0].resetAt, new Date('2026-07-24T23:00:00.814078+00:00').toISOString());
  });

  test('unix seconds are accepted — limits[] has been seen carrying them', () => {
    const rl = { ...LIVE.rate_limits }; delete rl.model_scoped;
    rl.limits = [{ kind: 'weekly_scoped', percent: 19, resets_at: 1785000000,
      scope: { model: { display_name: 'Fable' } } }];
    const fable = normalizeUsage({ ...LIVE, rate_limits: rl }).limits.find((L) => L.key === 'fable');
    assert.equal(fable.resetAt, new Date(1785000000 * 1000).toISOString());
  });

  test('an unparseable reset degrades to null rather than an Invalid Date', () => {
    const p = { ...LIVE, rate_limits: { ...LIVE.rate_limits, five_hour: { utilization: 5, resets_at: 'soon' } } };
    assert.equal(normalizeUsage(p).limits[0].resetAt, null);
  });
});

describe('normalizeUsage — pct hygiene', () => {
  test('rounds and clamps to 0-100', () => {
    const mk = (u) => normalizeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: u, resets_at: null } } });
    assert.equal(mk(14.6).limits[0].pct, 15);
    assert.equal(mk(140).limits[0].pct, 100);
    assert.equal(mk(-3).limits[0].pct, 0);
  });

  test('a 0-1 fraction is NOT rescaled — this endpoint is 0-100, and silently '
    + 'multiplying would mask a real upstream change', () => {
    const r = normalizeUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0.19, resets_at: null } } });
    assert.equal(r.limits[0].pct, 0);
  });
});

describe('the cache', () => {
  test('realUsage is null until a payload is recorded', () => {
    assert.equal(realUsage(), null);
  });

  test('recordUsage stores rows, stamps fetchedAt and reports the source', () => {
    const now = Date.parse('2026-07-24T20:00:00Z');
    assert.equal(recordUsage(LIVE, now), true);
    const r = realUsage(now + 60_000);
    assert.equal(r.source, 'plan');
    assert.equal(r.subscription, 'max');
    assert.equal(r.fetchedAt, new Date(now).toISOString());
    assert.deepEqual(r.limits.map((L) => L.key), ['5h', 'wk', 'fable']);
  });

  test('an unusable payload neither stores nor clobbers what is cached', () => {
    const now = Date.parse('2026-07-24T20:00:00Z');
    recordUsage(LIVE, now);
    assert.equal(recordUsage({ rate_limits_available: false }, now + 1000), false);
    assert.equal(realUsage(now + 2000).limits.length, 3, 'previous good reading survived');
  });

  test('a reading older than a day is withheld, so the meter falls back to the estimate', () => {
    const now = Date.parse('2026-07-24T20:00:00Z');
    recordUsage(LIVE, now);
    assert.ok(realUsage(now + 23 * 3600e3));
    assert.equal(realUsage(now + 25 * 3600e3), null);
  });
});
