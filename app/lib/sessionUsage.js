// Provider-reported usage, not a tokenizer estimate. Input totals INCLUDE cache
// reads/writes; reasoning is a subset of output, never another additive charge.
import fs from 'node:fs';

const count = n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
const totals = ['tokensIn', 'tokensOut'];
const fields = [...totals, 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'];
const zero = () => Object.fromEntries(fields.map(k => [k, 0]));
const same = (a, b) => a && b && totals.every(k => a[k] === b[k]);
const fingerprint = a => totals.map(k => a[k]).join(':');

export function codexUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tokensIn = count(raw.inputTokens ?? raw.input_tokens);
  const tokensOut = count(raw.outputTokens ?? raw.output_tokens);
  if (tokensIn === null || tokensOut === null) return null;
  const cachedRaw = raw.cachedInputTokens ?? raw.cached_input_tokens;
  const writeRaw = raw.cacheWriteInputTokens ?? raw.cache_write_input_tokens ?? raw.cache_write_tokens;
  const reasoningRaw = raw.reasoningOutputTokens ?? raw.reasoning_output_tokens;
  const cachedInputTokens = count(cachedRaw);
  const cacheWriteInputTokens = count(writeRaw);
  const reasoningOutputTokens = count(reasoningRaw);
  if ((cachedRaw != null && cachedInputTokens === null) || (writeRaw != null && cacheWriteInputTokens === null)
      || (reasoningRaw != null && reasoningOutputTokens === null)
      || cachedInputTokens > tokensIn || cacheWriteInputTokens > tokensIn
      || (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > tokensIn || reasoningOutputTokens > tokensOut) return null;
  return { tokensIn, tokensOut, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens };
}

// The app-server gives the authoritative rollout path. Read only a bounded
// tail, verify the session header, and ignore a not-yet-flushed trailing line.
// Failure means unknown baseline, NOT zero. Never scan unrelated user history.
export function readCodexUsageBaseline(file, threadId, maxBytes = 8 * 1024 * 1024) {
  if (!file || !threadId) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, header, 0, header.length, 0);
    const first = JSON.parse(header.toString('utf8').split('\n')[0]);
    if (first.type !== 'session_meta' || first.payload?.id !== threadId) return null;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    lines.pop(); // an incomplete JSONL record is not authoritative
    if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type === 'event_msg' && row.payload?.type === 'token_count') {
        const usage = codexUsage(row.payload.info?.total_token_usage);
        if (usage) return usage;
      }
    }
  } catch { /* unavailable or incompatible rollout: explicitly unknown */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export function createCodexUsageTracker({ baseline = null, fresh = false } = {}) {
  let anchor = baseline || (fresh ? zero() : null);
  const total = zero();
  const seen = new Set(anchor ? [fingerprint(anchor)] : []);
  const reasons = new Set(anchor ? [] : ['missing-baseline']);
  let observations = 0;
  let blocked = false;
  let complete = false;
  return {
    observe(usage) {
      const next = codexUsage(usage?.total);
      const last = codexUsage(usage?.last);
      if (!next) { reasons.add('missing-cumulative-usage'); return this.snapshot(); }
      const key = fingerprint(next);
      if (seen.has(key)) return this.snapshot(); // replay, including old known epochs
      seen.add(key);
      observations++;
      let delta;
      if (!anchor) {
        // Cannot attribute historical cumulative tokens to this new turn.
        // Its current-turn last response is a verified lower bound only.
        delta = last;
      } else if (totals.some(k => next[k] < anchor[k])) {
        reasons.add('counter-reset');
        if (observations === 1 && same(next, last)) {
          // A reset to exactly the just-completed response is demonstrable.
          // Common on resume: old total 98M -> first response 169846.
          delta = next;
          blocked = false;
        } else {
          // A reset without response-level evidence could be out-of-order
          // replay or compaction. Do not guess a new baseline and double count.
          blocked = true;
          reasons.add('ambiguous-counter-discontinuity');
        }
      } else if (!blocked) {
        delta = Object.fromEntries(fields.map(k => [k, next[k] === null || anchor[k] === null
          || next[k] < anchor[k] ? null : next[k] - anchor[k]]));
      }
      if (delta) for (const k of fields) total[k] = total[k] === null || delta[k] === null ? null : total[k] + delta[k];
      anchor = next;
      return this.snapshot();
    },
    markPartial(reason) { reasons.add(reason); },
    finish({ completed = false } = {}) { complete = completed; return this.snapshot(); },
    snapshot() {
      return { ...total, uncachedInputTokens: total.cachedInputTokens === null || total.cacheWriteInputTokens === null
        ? null : Math.max(0, total.tokensIn - total.cachedInputTokens - total.cacheWriteInputTokens),
        costUsd: null, scope: 'thread-only',
        completeness: !observations ? 'unknown' : complete && !reasons.size ? 'complete' : 'partial',
        reasons: [...reasons], observations };
    },
  };
}

function claudeRow(raw, model = null) {
  if (!raw || typeof raw !== 'object') return null;
  const uncachedInputTokens = count(raw.inputTokens ?? raw.input_tokens);
  const tokensOut = count(raw.outputTokens ?? raw.output_tokens);
  if (uncachedInputTokens === null || tokensOut === null) return null;
  const cachedRaw = raw.cacheReadInputTokens ?? raw.cache_read_input_tokens;
  const writeRaw = raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens;
  const cachedInputTokens = cachedRaw == null ? 0 : count(cachedRaw);
  const cacheWriteInputTokens = writeRaw == null ? 0 : count(writeRaw);
  if (cachedInputTokens === null || cacheWriteInputTokens === null
      || !Number.isSafeInteger(uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens)) return null;
  const dollars = raw.costUSD ?? raw.cost_usd;
  return { model, tokensIn: uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens,
    tokensOut, uncachedInputTokens, cachedInputTokens, cacheWriteInputTokens,
    costUsd: typeof dollars === 'number' && Number.isFinite(dollars) && dollars >= 0 ? dollars : null };
}

export function createClaudeUsageTracker({ defaultModel = null } = {}) {
  const messages = new Map();
  const active = new Map();
  const reasons = new Set();
  let resultRows = null;
  let resultCost = null;
  let resultScope = 'observed-messages';
  let resultSeen = false;
  let nested = false;
  const update = (message, parent) => {
    if (!message?.usage) return;
    if (!message.id) { reasons.add('missing-message-id'); return; }
    const key = message.id; // provider response IDs are global, wrapper lineage can change
    const previous = messages.get(key);
    const raw = { ...(previous?.raw || {}), ...message.usage };
    // A later SDK content-block wrapper can repeat the initial output=1
    // placeholder after a stream delta reported the real cumulative output.
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (count(previous?.raw?.[k]) !== null && count(raw[k]) !== null) raw[k] = Math.max(previous.raw[k], raw[k]);
    }
    const model = message.model || previous?.model || defaultModel;
    const row = claudeRow(raw, model);
    if (!row) { reasons.add('invalid-message-usage'); return; }
    // SDK may repeat one message per content block. Its input is paid once.
    messages.set(key, { raw, model, row });
  };
  return {
    observe(msg) {
      if (msg?.parent_tool_use_id) nested = true;
      if (msg?.type === 'assistant') update(msg.message, msg.parent_tool_use_id);
      if (msg?.type === 'stream_event') {
        const event = msg.event;
        const parent = msg.parent_tool_use_id || 'root';
        if (event?.type === 'message_start') {
          active.set(parent, event.message?.id);
          update(event.message, msg.parent_tool_use_id);
        } else if (event?.type === 'message_delta' && event.usage) {
          update({ id: active.get(parent), usage: event.usage }, msg.parent_tool_use_id);
        } else if (event?.type === 'message_stop') active.delete(parent);
      }
      if (msg?.type === 'result') {
        if (resultRows) return this.snapshot(); // terminal replay cannot erase a settled report
        resultSeen = true;
        resultCost = typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd)
          && msg.total_cost_usd >= 0 ? msg.total_cost_usd : null;
        const mu = msg.modelUsage || msg.model_usage;
        if (mu && typeof mu === 'object' && !Array.isArray(mu) && Object.keys(mu).length) {
          const rows = Object.entries(mu).map(([model, raw]) => claudeRow(raw, model));
          if (rows.every(Boolean) && (rows.some(r => r.tokensIn || r.tokensOut) || !messages.size)) {
            resultRows = rows; resultScope = 'whole-query'; reasons.clear();
          }
          else reasons.add('invalid-model-usage');
        }
        if (!resultRows) {
          const row = claudeRow(msg.usage, defaultModel);
          // A top-level aggregate cannot replace observed nested messages;
          // retain that lower bound instead of silently dropping subagents.
          if (row && !nested && (row.tokensIn || row.tokensOut || !messages.size)) {
            resultRows = [{ ...row, costUsd: resultCost }]; resultScope = 'thread-only';
          }
          else reasons.add(nested ? 'missing-whole-query-usage' : 'missing-result-usage');
        }
      }
      return this.snapshot();
    },
    snapshot() {
      const byModel = new Map();
      for (const { row } of messages.values()) {
        const target = byModel.get(row.model) || { model: row.model, tokensIn: 0, tokensOut: 0,
          uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, costUsd: null };
        for (const k of ['tokensIn', 'tokensOut', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) target[k] += row[k];
        byModel.set(row.model, target);
      }
      const rows = (resultRows || [...byModel.values()]).map(row => ({ ...row }));
      if (resultCost !== null) {
        let knownCost = rows.reduce((n, row) => n + (row.costUsd || 0), 0);
        const allKnown = rows.length && rows.every(row => row.costUsd !== null);
        if (knownCost > resultCost + 1e-9 || (allKnown && Math.abs(knownCost - resultCost) > 1e-9)) {
          // Contradictory model prices must not inflate/erase a known query
          // aggregate. Keep the latter, explicitly unallocated to a model.
          for (const row of rows) row.costUsd = null;
          knownCost = 0;
          reasons.add('inconsistent-model-cost-allocation');
        }
        if (rows.length === 1 && !reasons.has('inconsistent-model-cost-allocation')) rows[0].costUsd = resultCost;
        else if (resultCost > knownCost || reasons.has('inconsistent-model-cost-allocation')) {
          const unallocated = rows.find(row => row.model === null);
          if (unallocated) unallocated.costUsd = (unallocated.costUsd || 0) + resultCost - knownCost;
          else rows.push({ model: null, tokensIn: 0, tokensOut: 0,
            uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
            costUsd: resultCost - knownCost });
        }
      }
      const sum = k => rows.reduce((n, row) => n + (row[k] || 0), 0);
      const costUsd = resultCost ?? (rows.length && rows.every(r => r.costUsd !== null) ? sum('costUsd') : null);
      return { rows, tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'), costUsd,
        uncachedInputTokens: sum('uncachedInputTokens'), cachedInputTokens: sum('cachedInputTokens'),
        cacheWriteInputTokens: sum('cacheWriteInputTokens'), scope: resultRows ? resultScope : 'observed-messages',
        completeness: resultRows && !reasons.size ? 'complete' : rows.length ? 'partial' : 'unknown',
        reasons: [...reasons, ...(!resultSeen ? ['missing-final-result'] : [])], finished: resultSeen };
    },
  };
}

// New ledger snapshots can recover an interrupted process without rewriting
// old history. Keep legacy session totals as an explicit unverified baseline.
export function sessionUsageCheckpoint(previous, ledgerRows) {
  const sums = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  for (const row of ledgerRows) {
    sums.tokensIn += row.in || 0; sums.tokensOut += row.out || 0; sums.costUsd += row.costUsd || 0;
  }
  const base = previous?.usageBase || {
    tokensIn: Math.max(0, (previous?.tokensIn || 0) - sums.tokensIn),
    tokensOut: Math.max(0, (previous?.tokensOut || 0) - sums.tokensOut),
    costUsd: Math.max(0, (previous?.costUsd || 0) - sums.costUsd),
    completeness: previous?.turns ? 'legacy-unverified' : 'complete',
  };
  const unknown = ledgerRows.some(r => !r.superseded && r.completeness !== 'complete');
  return { tokensIn: base.tokensIn + sums.tokensIn, tokensOut: base.tokensOut + sums.tokensOut,
    costUsd: base.costUsd + sums.costUsd, usageBase: base,
    usageLegacyTokens: base.completeness === 'legacy-unverified' ? base.tokensIn + base.tokensOut : 0,
    usageHasIncomplete: unknown,
    usageCompleteness: base.completeness === 'legacy-unverified' ? 'legacy-unverified' : unknown ? 'partial' : 'complete' };
}
