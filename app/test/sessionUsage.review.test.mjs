// Independent adversarial review of the provider accounting implementation.
// No SDK calls, provider histories, or user data are accessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexUsageTracker, createClaudeUsageTracker, codexUsage, sessionUsageCheckpoint } from '../lib/sessionUsage.js';

const usage = (input, output = 0, cached = 0, reasoning = 0) => ({
  inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: reasoning,
});

test('review: measured seven-call resume/reset counts 1,268,709, not only the last 187,965', () => {
  const tracker = createCodexUsageTracker({ baseline: codexUsage(usage(98543393)) });
  const requests = [169846, 178009, 179671, 181006, 185858, 186354, 187965];
  let cumulative = 0;
  for (const request of requests) {
    cumulative += request;
    tracker.observe({ total: usage(cumulative), last: usage(request) });
  }
  assert.equal(tracker.finish({ completed: true }).tokensIn, 1268709);
});

test('review: deterministic duplicate/replay matrix never charges a model call twice', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const baseline = usage(seed * 10000, seed * 100, seed * 1000, seed * 10);
    const tracker = createCodexUsageTracker({ baseline: codexUsage(baseline) });
    const snapshots = [];
    let input = baseline.inputTokens, output = baseline.outputTokens;
    let cached = baseline.cachedInputTokens, reasoning = baseline.reasoningOutputTokens;
    for (let call = 1; call <= 20; call++) {
      const delta = usage(seed * call + 100, call + 10, call, 1);
      input += delta.inputTokens; output += delta.outputTokens;
      cached += delta.cachedInputTokens; reasoning += delta.reasoningOutputTokens;
      const event = { total: usage(input, output, cached, reasoning), last: delta };
      tracker.observe(event); tracker.observe(event);
      snapshots.push(event);
      if (snapshots.length > 2) tracker.observe(snapshots[call % snapshots.length]);
    }
    const result = tracker.finish({ completed: true });
    assert.equal(result.tokensIn, input - baseline.inputTokens, `input seed ${seed}`);
    assert.equal(result.tokensOut, output - baseline.outputTokens, `output seed ${seed}`);
    assert.equal(result.cachedInputTokens, cached - baseline.cachedInputTokens);
    assert.equal(result.reasoningOutputTokens, reasoning - baseline.reasoningOutputTokens);
  }
});

test('review: an unseen out-of-order counter cannot create additional expenditure', () => {
  const tracker = createCodexUsageTracker({ fresh: true });
  tracker.observe({ total: usage(1000, 100), last: usage(1000, 100) });
  tracker.observe({ total: usage(2000, 200), last: usage(1000, 100) });
  tracker.observe({ total: usage(1500, 150), last: usage(500, 50) });
  tracker.observe({ total: usage(3000, 300), last: usage(1000, 100) });
  const result = tracker.finish({ completed: true });
  assert.ok(result.tokensIn <= 3000 && result.tokensOut <= 300);
  assert.equal(result.completeness, 'partial', 'ambiguous gaps must be visible');
});

test('review: late repeated assistant placeholder cannot erase message_delta output', () => {
  const tracker = createClaudeUsageTracker({ defaultModel: 'test-model' });
  const message = { id: 'same-response', model: 'test-model', usage: {
    input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 1,
  } };
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message } });
  tracker.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } });
  tracker.observe({ type: 'assistant', message });
  tracker.observe({ type: 'assistant', message });
  const result = tracker.snapshot();
  assert.equal(result.tokensIn, 1200);
  assert.equal(result.tokensOut, 200);
  assert.equal(result.completeness, 'partial');
});

test('review: an empty final usage report cannot erase observed nonzero input', () => {
  const tracker = createClaudeUsageTracker({ defaultModel: 'test-model' });
  tracker.observe({ type: 'assistant', message: { id: 'one', model: 'test-model', usage: { input_tokens: 1000, output_tokens: 1 } } });
  tracker.observe({ type: 'result', modelUsage: { 'test-model': { inputTokens: 0, outputTokens: 0 } }, usage: { input_tokens: 0, output_tokens: 0 } });
  const result = tracker.snapshot();
  assert.equal(result.tokensIn, 1000);
  assert.notEqual(result.completeness, 'complete');
});

test('review: known single-model fallback cost remains available for ledger recording', () => {
  const tracker = createClaudeUsageTracker({ defaultModel: 'test-model' });
  tracker.observe({ type: 'result', usage: { input_tokens: 1000, output_tokens: 50 }, total_cost_usd: 0.05 });
  const result = tracker.snapshot();
  assert.equal(result.costUsd, 0.05);
  assert.equal(result.rows.reduce((sum, row) => sum + (row.costUsd || 0), 0), 0.05);
});

test('review: durable baseline plus a pending ledger snapshot recovers without refund or duplication', () => {
  const previous = { tokensIn: 100, tokensOut: 10, turns: 3,
    usageBase: { tokensIn: 100, tokensOut: 10, costUsd: 0, completeness: 'legacy-unverified' } };
  const pending = [{ in: 20, out: 5, costUsd: null, completeness: 'partial' }];
  const recovered = sessionUsageCheckpoint(previous, pending);
  assert.equal(recovered.tokensIn, 120); assert.equal(recovered.tokensOut, 15);
  assert.equal(recovered.usageCompleteness, 'legacy-unverified');
  const again = sessionUsageCheckpoint(recovered, pending);
  assert.equal(again.tokensIn, 120); assert.equal(again.tokensOut, 15);
});
