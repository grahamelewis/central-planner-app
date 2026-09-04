// Append-only JSONL ledger at ROOT/ledger/ledger.jsonl.
// Lines: {"ts":ISO,"type":"time","project":k,"seconds":n}
//        {"ts":ISO,"type":"tokens","project":k,"taskId":id,"in":n,"out":n,"costUsd":x,"model":id}
// `model` was added later — entries written before it are counted toward the
// all-models window but cannot be attributed to the per-model one.
import fs from 'fs';
import path from 'path';
import { ROOT, PROJECTS, WEEKLY_HOUR_TARGET, USAGE_LIMITS } from './config.js';
import { realUsage } from './usage.js';
import { broadcast } from './events.js';

const LEDGER_DIR = path.join(ROOT, 'ledger');
const LEDGER_FILE = path.join(LEDGER_DIR, 'ledger.jsonl');

function assertProject(project) {
  if (typeof project !== 'string' || !Object.prototype.hasOwnProperty.call(PROJECTS, project)) {
    throw new Error(`unknown project '${project}'`);
  }
}

// In-memory mirror of the ledger so weekSummary doesn't re-read and re-parse
// the whole (unbounded, append-only) file on every heartbeat. This process is
// the only writer, so the mirror stays correct after the initial load.
let entries = null;

function loadEntries() {
  if (entries !== null) return entries;
  entries = [];
  let raw = '';
  try {
    if (fs.existsSync(LEDGER_FILE)) raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (err) {
    console.error('[core] ledger read failed:', err.message);
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e === 'object') entries.push(e);
    } catch { /* skip corrupt lines */ }
  }
  return entries;
}

function appendLine(obj) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(obj) + '\n', 'utf8');
    loadEntries().push(obj);
  } catch (err) {
    console.error('[core] ledger append failed:', err.message);
  }
}

export function logTime(project, seconds) {
  assertProject(project);
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error('seconds must be a positive number');
  appendLine({ ts: new Date().toISOString(), type: 'time', project, seconds: secs });
  broadcast('ledger:update', weekSummary());
}

export function logTokens(project, taskId, tokensIn, tokensOut, costUsd, model) {
  assertProject(project);
  appendLine({
    ts: new Date().toISOString(),
    type: 'tokens',
    project,
    taskId: taskId == null ? null : String(taskId),
    in: Number(tokensIn) || 0,
    out: Number(tokensOut) || 0,
    costUsd: Number(costUsd) || 0,
    model: typeof model === 'string' && model ? model : null,
  });
  broadcast('ledger:update', weekSummary());
}

/** Local-date key (YYYY-MM-DD) for an ISO timestamp — the heatmap buckets by
    the user's wall-clock day, not UTC. */
function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Per-day activity for the profile heatmap: every ledger entry bucketed by
 * local date. Cheap — runs over the in-memory mirror.
 * → { days: { 'YYYY-MM-DD': { seconds, tokens, costUsd, perProject: {k: seconds} } } }
 */
export function dailyActivity() {
  const days = {};
  for (const entry of loadEntries()) {
    const key = dayKey(entry.ts);
    if (!key) continue;
    const d = days[key] || (days[key] = { seconds: 0, tokens: 0, costUsd: 0, perProject: {} });
    if (entry.type === 'time') {
      const s = Number(entry.seconds) || 0;
      d.seconds += s;
      if (entry.project) d.perProject[entry.project] = (d.perProject[entry.project] || 0) + s;
    } else if (entry.type === 'tokens') {
      d.tokens += (Number(entry.in) || 0) + (Number(entry.out) || 0);
      d.costUsd += Number(entry.costUsd) || 0;
    }
  }
  return { days };
}

/** Monday 00:00 local time of the current week. */
function weekStart() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay(); // 0 = Sunday
  const back = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - back);
  return d;
}

/**
 * The three usage windows behind the status bar's ◔ meter.
 *
 * The numerator is real: tokens actually logged to the ledger. The denominator
 * is a target from config (USAGE_LIMITS) — no Anthropic API reports a
 * subscription's remaining quota, so this measures your own spend against your
 * own budget rather than mirroring claude.ai.
 *
 * The session row is a SLIDING last-sessionHours sum, not a mirror of
 * claude.ai's anchored sessions: resetAt = oldest in-window turn +
 * sessionHours, so it slides forward under continuous use, and with no
 * recent activity there is no open window and resetAt is null. Both weekly
 * windows share the Monday-00:00-local boundary that weekSummary() uses.
 * Exported as public API but consumed only via weekSummary().usage.
 *
 * → { limits: [{ key, name, sub, pct, spent, budget, resetAt }] } | null
 */
export function usageWindows(nowMs = Date.now()) {
  if (!USAGE_LIMITS) return null;
  const U = USAGE_LIMITS;
  const windowMs = U.sessionHours * 3600 * 1000;
  const weekMs = weekStart().getTime();
  const weekEnd = weekMs + 7 * 86400 * 1000;

  let sessionSpent = 0, sessionAnchor = null;
  let weekSpent = 0, topSpent = 0;

  for (const entry of loadEntries()) {
    if (entry.type !== 'tokens') continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts)) continue;
    const tok = (Number(entry.in) || 0) + (Number(entry.out) || 0);
    if (ts >= nowMs - windowMs && ts <= nowMs) {
      sessionSpent += tok;
      if (sessionAnchor === null || ts < sessionAnchor) sessionAnchor = ts;
    }
    if (ts >= weekMs) {
      weekSpent += tok;
      if (entry.model === U.topModel) topSpent += tok;
    }
  }

  const row = (key, name, sub, spent, budget, resetAt) => ({
    key, name, sub, spent, budget, resetAt,
    pct: budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0,
  });

  return {
    source: 'estimate',
    limits: [
      row('5h', `${U.sessionHours}h session`, 'rolling', sessionSpent, U.sessionTokens,
        sessionAnchor === null ? null : new Date(sessionAnchor + windowMs).toISOString()),
      row('wk', 'week', 'all models', weekSpent, U.weeklyTokens, new Date(weekEnd).toISOString()),
      row(topLabel(U.topModel), 'week', topLabel(U.topModel), topSpent, U.topModelWeeklyTokens,
        new Date(weekEnd).toISOString()),
    ],
  };
}

/** 'claude-fable-5-1' → 'fable' — the short tag the meter shows. */
function topLabel(model) {
  const m = /^claude-([a-z]+)/.exec(String(model || ''));
  return m ? m[1] : 'top';
}

export function weekSummary() {
  const since = weekStart();
  const sinceMs = since.getTime();

  const perProject = {};
  for (const key of Object.keys(PROJECTS)) {
    perProject[key] = { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
  const totals = { seconds: 0, tokens: 0, costUsd: 0 };

  for (const entry of loadEntries()) {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const proj = entry.project;
    if (!perProject[proj]) {
      // Unknown/retired project key: still count in totals via a dynamic bucket.
      perProject[proj] = { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    }
    if (entry.type === 'time') {
      const s = Number(entry.seconds) || 0;
      perProject[proj].seconds += s;
      totals.seconds += s;
    } else if (entry.type === 'tokens') {
      const tin = Number(entry.in) || 0;
      const tout = Number(entry.out) || 0;
      const cost = Number(entry.costUsd) || 0;
      perProject[proj].tokensIn += tin;
      perProject[proj].tokensOut += tout;
      perProject[proj].costUsd += cost;
      totals.tokens += tin + tout;
      totals.costUsd += cost;
    }
  }

  return {
    since: since.toISOString(),
    perProject,
    totals,
    hourTarget: WEEKLY_HOUR_TARGET,
    // real plan windows when a turn has fetched them (lib/usage.js), else this
    // module's own spend-against-a-configured-budget estimate
    usage: realUsage() || usageWindows(),
  };
}
