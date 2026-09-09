import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = {}; // util's unrelated merge-engine test seam
const { exactTok, tokenTooltip, recordedCostLabel } = await import('../public/util.js');

test('token tooltip gives exact input/output/total and disclaims context, bill, quota', () => {
  const text = tokenTooltip({ tokensIn: 8123456, tokensOut: 376545, usageCompleteness: 'complete' });
  assert.match(text, /8,500,001 tokens processed/);
  assert.match(text, /8,123,456 input.*376,545 output/);
  assert.match(text, /not context size, a bill, or subscription allowance/);
  assert.equal(exactTok(1268709), '1,268,709');
});

test('legacy uncertainty is not asserted to be a known lower bound', () => {
  const text = tokenTooltip({ tokensIn: 12, tokensOut: 3, usageLegacyTokens: 15, usageCompleteness: 'legacy-unverified' });
  assert.match(text, /15 historical tokens unverified/);
  assert.doesNotMatch(text, /lower bound/);
  const mixed = tokenTooltip({ tokensIn: 10, usageLegacyTokens: 10, usageCompleteness: 'legacy-unverified', usageHasIncomplete: true });
  assert.match(mixed, /coverage is also incomplete/);
  assert.doesNotMatch(mixed, /lower bound/);
});

test('partial and entirely unknown observations identify incomplete coverage', () => {
  assert.match(tokenTooltip({ tokensIn: 100, usageCompleteness: 'partial' }), /lower bound/);
  assert.match(tokenTooltip({ tokens: 0, costCoverage: { unknownUsageEntries: 1 } }), /lower bound/);
});

test('a saved persistence warning remains visible beside the exact counter', () => {
  const text = tokenTooltip({ tokensIn: 100, usageCompleteness: 'partial',
    usageWarning: 'Usage persistence failed: disk full' });
  assert.match(text, /100 tokens processed/);
  assert.match(text, /Usage persistence failed: disk full/);
});

test('subscription unknown zero is never formatted as a zero-dollar provider bill', () => {
  for (const c of [{ entries: 1, unknownCostEntries: 1 }, { entries: 1, subscriptionTokens: 30 }]) {
    const text = recordedCostLabel({ costUsd: 0, costCoverage: c });
    assert.equal(text, 'cost unknown / subscription');
    assert.doesNotMatch(text, /\$0/);
  }
  assert.equal(recordedCostLabel({ costUsd: 0, costCoverage: { entries: 0 } }), 'no cost observations');
});

test('known cost provenance survives zero-dollar amounts and mixed coverage', () => {
  assert.equal(recordedCostLabel({ costUsd: 0, costCoverage: { entries: 1, estimatedCostEntries: 1 } }), '$0.00 estimated cost subtotal');
  assert.equal(recordedCostLabel({ costUsd: 0, costCoverage: { entries: 1, providerReportedCostEntries: 1 } }), '$0.00 provider-reported cost subtotal');
  assert.equal(recordedCostLabel({ costUsd: 1.2, costCoverage: { entries: 2, estimatedCostEntries: 1, unknownCostEntries: 1 } }), '$1.20 estimated cost subtotal; other cost unknown');
});
