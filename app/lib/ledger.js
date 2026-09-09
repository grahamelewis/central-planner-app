// Append-only JSONL ledger at ROOT/ledger/ledger.jsonl.
// Lines: {"ts":ISO,"type":"time","project":k,"seconds":n}
//        {"ts":ISO,"type":"tokens","project":k,"taskId":id,"in":n,"out":n,"costUsd":x,"model":id}
//        {"type":"token-batch","version":2,"entries":[tokenSnapshot,...]}
// Stable usageIds identify replaceable snapshots, not additive events. A batch
// commits multiple model snapshots atomically in one fsynced JSONL record.
// Readers MUST flatten batches and retain the latest snapshot per usageId.
// Legacy rows without usageId remain additive; unattributed providers remain
// unknown rather than being silently included in the Claude-only budget.
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
const usageIds = new Map();
let needsNewline = false;

function loadEntries() {
  if (entries !== null) return entries;
  const loaded = [];
  let raw = '';
  try {
    if (fs.existsSync(LEDGER_FILE)) raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (err) {
    console.error('[core] ledger read failed:', err.message);
    throw err; // Do not append into an unread ledger and lose deduplication.
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        const rows = e.type === 'token-batch' ? e.entries : [e];
        if (e.type === 'token-batch') {
          if (e.version !== 2 || !Array.isArray(rows) || !rows.length) continue;
          const seen = new Set();
          // Validate ALL before applying ANY: torn/invalid batches never leave
          // half a model replacement visible after a restart.
          if (!rows.every(row => {
            if (!validSnapshot(row) || !row.usageId || seen.has(row.usageId)) return false;
            seen.add(row.usageId);
            const index = usageIds.get(row.usageId);
            return index === undefined || sameScope(loaded[index], row);
          })) continue;
        }
        for (const row of rows) {
          if (row.type === 'tokens' && !validSnapshot(row)) continue;
          if (row.type === 'tokens' && row.usageId) {
            const index = usageIds.get(row.usageId);
            if (index !== undefined) {
              if (sameScope(loaded[index], row)) loaded[index] = { ...row, ts: loaded[index].ts };
              continue;
            }
            usageIds.set(row.usageId, loaded.length);
          }
          loaded.push(row);
        }
      }
    } catch { /* skip corrupt lines */ }
  }
  entries = loaded;
  needsNewline = raw.length > 0 && !raw.endsWith('\n');
  return entries;
}

function appendLine(obj) {
  // Load BEFORE appending: otherwise the first row appears in the initial
  // read and is then pushed into the mirror a second time.
  loadEntries();
  const prepared = prepareSnapshot(obj);
  if (!prepared) return false;
  return writeSnapshots(prepared, [prepared]);
}

function prepareSnapshot(obj) {
  const index = obj.usageId ? usageIds.get(obj.usageId) : undefined;
  if (index !== undefined) {
    const previous = entries[index];
    if (!sameScope(previous, obj)) throw new Error('usageId accounting scope cannot change');
    obj.ts = previous.ts;
    const comparable = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !['revision', 'observedAt'].includes(key)));
    if (JSON.stringify(comparable(previous)) === JSON.stringify(comparable(obj))) return null;
    obj.revision = (previous.revision || 1) + 1;
    obj.observedAt = new Date().toISOString();
  }
  return obj;
}

function writeSnapshots(record, rows) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const fd = fs.openSync(LEDGER_FILE, 'a');
    try {
      fs.writeFileSync(fd, (needsNewline ? '\n' : '') + JSON.stringify(record) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    needsNewline = false;
    for (const obj of rows) {
      const index = obj.usageId ? usageIds.get(obj.usageId) : undefined;
      if (index !== undefined) entries[index] = obj;
      else {
        if (obj.usageId) usageIds.set(obj.usageId, entries.length);
        entries.push(obj);
      }
    }
    return true;
  } catch (err) {
    console.error('[core] ledger append failed:', err.message);
    // A failed fsync/close can follow a successful write. Force a disk reread
    // before retrying so a durable observation is not duplicated.
    entries = null;
    usageIds.clear();
    throw err;
  }
}

function validSnapshot(row) {
  if (!row || row.type !== 'tokens' || (row.usageId != null && (typeof row.usageId !== 'string' || !row.usageId.trim()))) return false;
  if (!Number.isFinite(Date.parse(row.ts))) return false;
  for (const key of ['in', 'out']) {
    if (row[key] == null && ['unknown', 'partial'].includes(row.completeness)) continue;
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) return false;
  }
  if (row.costUsd != null && (typeof row.costUsd !== 'number' || !Number.isFinite(row.costUsd) || row.costUsd < 0)) return false;
  if (row.superseded && (row.in !== 0 || row.out !== 0 || (row.costUsd != null && row.costUsd !== 0))) return false;
  let classified = 0;
  for (const key of ['uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']) {
    if (row[key] == null) continue;
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) return false;
    if (key !== 'reasoningOutputTokens') classified += row[key];
  }
  return classified <= (row.in || 0) && (row.reasoningOutputTokens || 0) <= (row.out || 0);
}

function sameScope(a, b) {
  return ['project', 'taskId', 'provider', 'action', 'appTurnId', 'taskCreated']
    .every(key => (a[key] ?? null) === (b[key] ?? null))
    && ['threadId', 'turnId'].every(key => a[key] == null || a[key] === b[key]);
}

export function logTime(project, seconds) {
  assertProject(project);
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error('seconds must be a positive number');
  appendLine({ ts: new Date().toISOString(), type: 'time', project, seconds: secs });
  broadcast('ledger:update', weekSummary());
}

export function logTokens(project, taskId, tokensIn, tokensOut, costUsd, model, details = {}) {
  const appended = appendLine(tokenSnapshot(project, taskId, tokensIn, tokensOut, costUsd, model, details));
  if (appended) broadcast('ledger:update', weekSummary());
  return appended;
}

/** Atomic group replacement. Every record uses logTokens's argument names. */
export function logTokenBatch(records) {
  if (!Array.isArray(records)) throw new Error('token batch must be an array');
  const seen = new Set();
  const snapshots = records.map(record => {
    const row = tokenSnapshot(record.project, record.taskId, record.tokensIn, record.tokensOut, record.costUsd, record.model, record.details);
    if (!row.usageId || seen.has(row.usageId)) throw new Error('batch usageIds must be present and unique');
    seen.add(row.usageId);
    return row;
  });
  loadEntries();
  const changed = snapshots.map(prepareSnapshot).filter(Boolean);
  if (!changed.length) return false;
  const appended = writeSnapshots({ type: 'token-batch', version: 2, entries: changed }, changed);
  if (appended) broadcast('ledger:update', weekSummary());
  return appended;
}

function tokenSnapshot(project, taskId, tokensIn, tokensOut, costUsd, model, details = {}) {
  if (project !== null) assertProject(project); // global helpers (e.g. profile)
  const nullable = ['partial', 'unknown'].includes(details.completeness);
  const tin = tokensIn == null && nullable ? null : tokenCount(tokensIn, 'tokensIn');
  const tout = tokensOut == null && nullable ? null : tokenCount(tokensOut, 'tokensOut');
  if (costUsd != null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
    throw new Error('costUsd must be a non-negative finite number or null');
  }
  const metadata = {};
  for (const key of ['usageId', 'provider', 'action', 'threadId', 'turnId', 'appTurnId', 'taskCreated', 'scope', 'completeness', 'costSource']) {
    if (details[key] != null) {
      if (typeof details[key] !== 'string' || !details[key].trim()) throw new Error(`${key} must be a nonempty string`);
      metadata[key] = details[key];
    }
  }
  if (metadata.completeness && !['complete', 'partial', 'unknown', 'legacy-unverified'].includes(metadata.completeness)) throw new Error('invalid completeness');
  if (metadata.costSource && !['unknown', 'legacy', 'subscription', 'planning-rates', 'provider-estimate', 'provider-reported'].includes(metadata.costSource)) throw new Error('invalid costSource');
  for (const key of ['uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']) {
    if (details[key] != null) metadata[key] = tokenCount(details[key], key);
  }
  const classifiedInput = (metadata.uncachedInputTokens || 0) + (metadata.cachedInputTokens || 0) + (metadata.cacheWriteInputTokens || 0);
  if (classifiedInput > tin || (metadata.reasoningOutputTokens || 0) > tout) throw new Error('token breakdown exceeds total');
  if (details.superseded === true) {
    if (tin !== 0 || tout !== 0 || (costUsd != null && costUsd !== 0)) throw new Error('superseded snapshot must contain no usage or cost');
    metadata.superseded = true;
  }
  const costSource = metadata.costSource || (costUsd == null ? 'unknown' : 'legacy');
  // Subscription consumption is not a $0 API bill. Preserve unknown money
  // even when a legacy caller supplies the old zero placeholder.
  const money = costSource === 'subscription' ? null : (costUsd ?? null);
  return {
    ts: new Date().toISOString(),
    type: 'tokens',
    project,
    taskId: taskId == null ? null : String(taskId),
    in: tin,
    out: tout,
    costUsd: money,
    model: typeof model === 'string' && model ? model : null,
    ...metadata,
    provider: metadata.provider || inferProvider({ model }),
    completeness: metadata.completeness || 'unknown',
    costSource,
    costEstimated: details.costEstimated === true || ['planning-rates', 'provider-estimate'].includes(costSource),
  };
}

function tokenCount(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function inferProvider(entry) {
  if (entry.provider) return entry.provider;
  if (/^claude-/i.test(entry.model || '')) return 'claude';
  if (/^(?:gpt-|o[134](?:-|$)|codex(?:-|$))/i.test(entry.model || '')) return 'codex';
  return 'unknown';
}

/** Read-only copies for recovery/reconciliation; never rewrites history. */
export function tokenEntries(filters = {}) {
  return loadEntries().filter(e => e.type === 'tokens' && Object.entries(filters).every(([key, value]) =>
    (key === 'provider' ? inferProvider(e) : e[key] ?? null) === (value ?? null))).map(e => ({ ...e }));
}

function costCoverage() {
  return { entries: 0, knownCostTokens: 0, unknownCostTokens: 0, subscriptionTokens: 0,
    estimatedUsd: 0, providerReportedUsd: 0, legacyUsd: 0, incompleteTokens: 0, legacyTokens: 0, unknownUsageEntries: 0,
    unknownCostEntries: 0, estimatedCostEntries: 0, providerReportedCostEntries: 0, legacyCostEntries: 0 };
}

function addCostCoverage(coverage, entry) {
  if (entry.superseded) return;
  const tokens = (Number(entry.in) || 0) + (Number(entry.out) || 0);
  coverage.entries++;
  if (entry.in == null || entry.out == null || entry.completeness === 'unknown') coverage.unknownUsageEntries++;
  const costKnown = typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)
    && entry.costUsd >= 0 && entry.costSource !== 'subscription'
    // Old zero placeholders were used for subscription usage.
    && (entry.costUsd > 0 || (entry.costSource && entry.costSource !== 'unknown' && entry.costSource !== 'legacy'));
  coverage[costKnown ? 'knownCostTokens' : 'unknownCostTokens'] += tokens;
  if (!costKnown) coverage.unknownCostEntries++;
  if (entry.costSource === 'subscription') coverage.subscriptionTokens += tokens;
  if (costKnown) {
    const kind = entry.costEstimated || ['provider-estimate', 'planning-rates'].includes(entry.costSource)
      ? 'estimated' : entry.costSource === 'provider-reported' ? 'providerReported' : 'legacy';
    coverage[`${kind}Usd`] += entry.costUsd;
    coverage[`${kind}CostEntries`]++;
  }
  if (!entry.completeness || entry.completeness === 'legacy-unverified' || (entry.completeness === 'unknown' && !entry.usageId)) coverage.legacyTokens += tokens;
  else if (entry.completeness !== 'complete') coverage.incompleteTokens += tokens;
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
    const d = days[key] || (days[key] = { seconds: 0, tokens: 0, costUsd: 0, perProject: {}, costCoverage: costCoverage() });
    if (entry.type === 'time') {
      const s = Number(entry.seconds) || 0;
      d.seconds += s;
      if (entry.project) d.perProject[entry.project] = (d.perProject[entry.project] || 0) + s;
    } else if (entry.type === 'tokens') {
      d.tokens += (Number(entry.in) || 0) + (Number(entry.out) || 0);
      d.costUsd += Number(entry.costUsd) || 0;
      addCostCoverage(d.costCoverage, entry);
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
  let weekSpent = 0, topSpent = 0, unknownProviderTokens = 0;

  for (const entry of loadEntries()) {
    if (entry.type !== 'tokens' || entry.superseded) continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts)) continue;
    const tok = (Number(entry.in) || 0) + (Number(entry.out) || 0);
    const provider = inferProvider(entry);
    if (provider === 'unknown' && ts >= weekMs && ts <= nowMs) unknownProviderTokens += tok;
    if (provider !== 'claude') continue;
    if (ts >= nowMs - windowMs && ts <= nowMs) {
      sessionSpent += tok;
      if (sessionAnchor === null || ts < sessionAnchor) sessionAnchor = ts;
    }
    if (ts >= weekMs && ts <= nowMs) {
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
    provider: 'claude',
    unknownProviderTokens,
    limits: [
      row('5h', `${U.sessionHours}h session`, 'rolling', sessionSpent, U.sessionTokens,
        sessionAnchor === null ? null : new Date(sessionAnchor + windowMs).toISOString()),
      row('wk', 'week', 'Claude models', weekSpent, U.weeklyTokens, new Date(weekEnd).toISOString()),
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
    perProject[key] = { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costCoverage: costCoverage() };
  }
  const totals = { seconds: 0, tokens: 0, costUsd: 0, costCoverage: costCoverage() };
  const byProvider = {};

  for (const entry of loadEntries()) {
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const proj = entry.project == null ? '__global__' : entry.project;
    if (!Object.hasOwn(perProject, proj)) {
      // Unknown/retired project key: still count in totals via a dynamic bucket.
      Object.defineProperty(perProject, proj, { enumerable: true, configurable: true, writable: true,
        value: { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, costCoverage: costCoverage() } });
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
      addCostCoverage(totals.costCoverage, entry);
      addCostCoverage(perProject[proj].costCoverage, entry);
      const provider = inferProvider(entry);
      if (!Object.hasOwn(byProvider, provider)) Object.defineProperty(byProvider, provider, { enumerable: true,
        value: { tokensIn: 0, tokensOut: 0, costUsd: 0, costCoverage: costCoverage() } });
      byProvider[provider].tokensIn += tin;
      byProvider[provider].tokensOut += tout;
      byProvider[provider].costUsd += cost;
      addCostCoverage(byProvider[provider].costCoverage, entry);
    }
  }

  return {
    since: since.toISOString(),
    perProject,
    totals,
    byProvider,
    hourTarget: WEEKLY_HOUR_TARGET,
    // real plan windows when a turn has fetched them (lib/usage.js), else this
    // module's own spend-against-a-configured-budget estimate
    usage: realUsage() || usageWindows(),
  };
}
