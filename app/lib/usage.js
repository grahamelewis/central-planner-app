// Real Claude-plan usage windows, read from the Agent SDK.
//
// The SDK exposes the same data claude.ai shows under Settings → Usage, via an
// experimental control method on the Query object. lib/sessions.js pulls it
// once per turn and hands the payload here; ledger.js serves the cached rows in
// place of its own token-budget estimate whenever they are present.
//
// Why cached rather than fetched on demand: the pull needs a live query with
// stdin open, so it rides along with a turn the user was running anyway. That
// makes the numbers "as of" the last turn rather than live, which the UI states
// explicitly — an honest stale number beats a confident invented one.
//
// OAuth only. An install running on ANTHROPIC_API_KEY gets
// `rate_limits_available: false` and no windows at all; those users keep the
// ledger estimate. The method name carries a DO_NOT_RELY_ON_THIS_API_YET
// warning and will change when it stabilises, so every call site feature-
// detects and falls back rather than throwing.

const MAX_AGE_MS = 24 * 3600 * 1000;   // beyond a day, prefer the estimate

let cache = null;   // { limits, fetchedAt, subscription }

/** ISO string | unix seconds | null → ISO string | null.
    The payload mixes both: top-level windows use ISO, and entries inside
    `limits[]` have been observed carrying unix seconds. */
function isoAt(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // seconds vs milliseconds: anything below ~1e11 is seconds
    return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  }
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.max(0, Math.min(100, Math.round(v))) : null);

/**
 * SDKControlGetUsageResponse → the meter's row shape.
 *
 * Rows are derived strictly from what the payload actually contains: a window
 * that is null or absent produces no row. That is deliberate — a per-model cap
 * the account does not have must not appear as a permanent 0%, implying we
 * track something we don't.
 *
 * Utilization from this endpoint is already 0-100. (The pushed
 * `rate_limit_event` reports the same figure as a 0-1 fraction — do not mix
 * them; see CONTRACT.md.)
 *
 * → { limits: [{key,name,sub,pct,resetAt,real}], subscription } | null
 */
export function normalizeUsage(payload) {
  if (!payload || !payload.rate_limits_available || !payload.rate_limits) return null;
  const w = payload.rate_limits;
  const limits = [];

  const row = (key, name, sub, utilization, resetsAt) => {
    const p = pct(utilization);
    if (p === null) return;                       // no reading → no row
    limits.push({ key, name, sub, pct: p, resetAt: isoAt(resetsAt), real: true });
  };

  if (w.five_hour) row('5h', '5h session', 'rolling', w.five_hour.utilization, w.five_hour.resets_at);
  if (w.seven_day) row('wk', 'week', 'all models', w.seven_day.utilization, w.seven_day.resets_at);

  // Per-model weekly caps. `model_scoped[]` is the modern shape; older CLIs
  // only populate `limits[]` with kind 'weekly_scoped'. The named
  // `seven_day_opus`/`seven_day_sonnet` keys exist in the schema but were null
  // on a live Max account whose Fable cap was in use — so they are read last,
  // not first.
  const scoped = Array.isArray(w.model_scoped) && w.model_scoped.length
    ? w.model_scoped.map((m) => ({ name: m.display_name, u: m.utilization, r: m.resets_at }))
    : (Array.isArray(w.limits) ? w.limits : [])
      .filter((l) => l && l.kind === 'weekly_scoped' && l.scope && l.scope.model)
      .map((l) => ({ name: l.scope.model.display_name, u: l.percent, r: l.resets_at }));

  for (const m of scoped) {
    const label = String(m.name || '').trim();
    if (!label) continue;
    row(label.toLowerCase(), 'week', label.toLowerCase(), m.u, m.r);
  }
  if (!scoped.length) {
    for (const [key, win] of [['opus', w.seven_day_opus], ['sonnet', w.seven_day_sonnet]]) {
      if (win) row(key, 'week', key, win.utilization, win.resets_at);
    }
  }

  if (!limits.length) return null;
  return { limits, subscription: payload.subscription_type || null };
}

/** Store a payload pulled during a turn. Returns true if it produced rows. */
export function recordUsage(payload, nowMs = Date.now()) {
  const n = normalizeUsage(payload);
  if (!n) return false;
  cache = { ...n, fetchedAt: new Date(nowMs).toISOString() };
  return true;
}

/**
 * The cached real windows, or null when absent or too old to be worth showing.
 * `fetchedAt` is surfaced so the UI can say how stale the reading is instead of
 * presenting it as live.
 */
export function realUsage(nowMs = Date.now()) {
  if (!cache) return null;
  const age = nowMs - Date.parse(cache.fetchedAt);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;
  return { limits: cache.limits, source: 'plan', subscription: cache.subscription, fetchedAt: cache.fetchedAt };
}

/** Testing seam. */
export function _resetUsage() { cache = null; }
