// Background jobs share the foreground SDK accounting rules. Keep usage even
// when an iterator throws after delivering its result; never turn missing
// provider telemetry into a claim of zero expenditure.
import { createClaudeUsageTracker } from './sessionUsage.js';

export async function collectClaudeWorker(q, { model, timeoutMs = 90000, closeOnTimeout = false, onUsage } = {}) {
  const tracker = createClaudeUsageTracker({ defaultModel: model });
  let result = null, failure = null, timedOut = false, persistenceFailed = false, acceptingEvents = true;
  const checkpoint = () => {
    if (!onUsage || !acceptingEvents) return;
    try { onUsage(tracker.snapshot()); persistenceFailed = false; }
    catch { persistenceFailed = true; }
  };
  checkpoint(); // durable unknown marker before consuming the billable stream
  let timer, closeTimer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        const stopped = closeOnTimeout && q.close ? q.close() : q.interrupt?.();
        Promise.resolve(stopped).catch(() => {});
      } catch { /* shutdown failure does not erase observed usage */ }
      // Let cooperative interruption deliver final telemetry, but a broken
      // iterator/interrupt must not leave the worker or memory queue hung.
      closeTimer = setTimeout(() => {
        try { q.close?.(); } catch { /* best effort; report observed lower bound */ }
        resolve();
      }, 250);
    }, timeoutMs);
  });
  const consume = (async () => {
    try {
      for await (const msg of q) {
        if (!acceptingEvents) break;
        if (msg?.type === 'assistant' || msg?.type === 'result' || (msg?.type === 'stream_event'
            && ['message_start', 'message_delta', 'message_stop'].includes(msg.event?.type))) {
          tracker.observe(msg);
          checkpoint();
        }
        if (msg?.type === 'result') result = msg;
      }
    } catch (err) { failure = err; }
  })();
  try {
    await Promise.race([consume, deadline]);
  } finally { clearTimeout(timer); clearTimeout(closeTimer); }
  checkpoint(); // final retry can repair a transient write failure
  acceptingEvents = false;
  return { result, failure, timedOut, accounting: tracker.snapshot(), persistenceFailed };
}

export function memoryAccounting(accounting) {
  return {
    usage: {
      input_tokens: accounting.completeness === 'unknown' ? null : accounting.tokensIn,
      output_tokens: accounting.completeness === 'unknown' ? null : accounting.tokensOut,
      input_tokens_details: {
        cached_tokens: accounting.rows.length ? accounting.rows.reduce((n, r) => n + (r.cachedInputTokens || 0), 0) : null,
        cache_write_tokens: accounting.rows.length ? accounting.rows.reduce((n, r) => n + (r.cacheWriteInputTokens || 0), 0) : null,
      },
    },
    costUsd: accounting.costUsd,
    usageCompleteness: accounting.completeness,
    usageScope: accounting.scope,
    usageRows: accounting.rows,
  };
}

// A single worker may use several models. Stable child IDs let the ledger
// reconcile a repeated write without counting that job twice.
export function logWorkerUsage(logTokens, project, taskId, accounting, details, logBatch) {
  const rows = accounting.rows.length ? accounting.rows : [{
    model: details.model, tokensIn: null, tokensOut: null, costUsd: accounting.costUsd,
  }];
  const records = rows.map(row => {
    const { model: _model, ...metadata } = details;
    const model = row.model === null ? null : row.model || details.model;
    return { project, taskId, tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd, model, details: {
      ...metadata, provider: 'claude', completeness: accounting.completeness, scope: accounting.scope,
      usageId: `${details.usageId}:${model === null ? 'unallocated-cost' : model}`,
      costSource: row.costUsd == null ? 'unknown' : 'provider-estimate',
      uncachedInputTokens: row.uncachedInputTokens, cachedInputTokens: row.cachedInputTokens,
      cacheWriteInputTokens: row.cacheWriteInputTokens,
    } };
  });
  if (logBatch) return logBatch(records);
  for (const record of records) logTokens(record.project, record.taskId, record.tokensIn,
    record.tokensOut, record.costUsd, record.model, record.details);
}

/** Atomic cumulative snapshots, including zero revisions for provisional
 * models superseded by a later authoritative whole-query model report. */
export function createWorkerUsageWriter(logBatch, project, taskId, details) {
  const previous = new Map();
  return accounting => {
    const records = logWorkerUsage(null, project, taskId, accounting, details, rows => rows);
    const current = new Set(records.map(r => r.details.usageId));
    for (const [usageId, old] of previous) if (!current.has(usageId)) records.push({
      ...old, tokensIn: 0, tokensOut: 0, costUsd: null,
      details: { ...old.details, superseded: true, completeness: accounting.completeness, scope: accounting.scope,
        uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
    });
    // A failed fsync can follow a successful append. Remember attempted IDs
    // before writing so the next authoritative snapshot retires them too.
    for (const record of records) previous.set(record.details.usageId, record);
    return logBatch(records);
  };
}
