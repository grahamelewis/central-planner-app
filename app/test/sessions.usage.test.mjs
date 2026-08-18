// test/sessions.usage.test.mjs — WHOLE-TREE token accounting. The SDK
// result's `usage` counts only the top-level agent loop: tokens spent inside
// subagents and Workflow runs are EXCLUDED (per the Agent SDK cost-tracking
// docs, "the usage field undercounts as soon as nesting occurs") — which is
// how an overnight 18-agent workflow logged 3M tokens against a night that
// spent most of a weekly plan (Graham, 2026-07-31). `modelUsage` counts the
// whole tree per model; sessions.js must prefer it and ledger one row per
// model. parseModelUsage is not exported (importing sessions.js pulls the
// Agent SDK), so its real source is extracted. No billing risk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const SESSIONS = path.join(APP_DIR, 'lib', 'sessions.js');
const { parseModelUsage } = loadPrivateFns(SESSIONS, ['parseModelUsage']);

describe('parseModelUsage', () => {
  test('camelCase wire shape: cache tokens fold into tokensIn, cost carried per model', () => {
    const rows = parseModelUsage({
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 100_000, outputTokens: 40_000,
          cacheReadInputTokens: 900_000, cacheCreationInputTokens: 50_000,
          costUSD: 12.5,
        },
        'claude-haiku-4-5': { inputTokens: 2_000_000, outputTokens: 600_000, costUSD: 5.0 },
      },
    });
    assert.equal(rows.length, 2);
    const opus = rows.find((r) => r.model === 'claude-opus-5');
    assert.equal(opus.tokensIn, 1_050_000, 'in = input + cache creation + cache read (fullInputTokens semantics)');
    assert.equal(opus.tokensOut, 40_000);
    assert.equal(opus.costUsd, 12.5);
    const haiku = rows.find((r) => r.model === 'claude-haiku-4-5');
    assert.equal(haiku.tokensIn, 2_000_000);
  });

  test('snake_case fields are tolerated', () => {
    const rows = parseModelUsage({
      model_usage: {
        'claude-opus-5': { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 85, cost_usd: 0.1 },
      },
    });
    assert.equal(rows[0].tokensIn, 95);
    assert.equal(rows[0].tokensOut, 5);
    assert.equal(rows[0].costUsd, 0.1);
  });

  test('absent, junk, or all-zero payloads return null (callers fall back to result.usage)', () => {
    assert.equal(parseModelUsage({}), null);
    assert.equal(parseModelUsage({ modelUsage: null }), null);
    assert.equal(parseModelUsage({ modelUsage: [] }), null);
    assert.equal(parseModelUsage({ modelUsage: 'nope' }), null);
    assert.equal(parseModelUsage({ modelUsage: { m: {} } }), null);
    assert.equal(parseModelUsage({ modelUsage: { m: null } }), null);
    assert.equal(parseModelUsage(null), null);
  });
});

describe('runTurn wiring (source-level)', () => {
  const src = fs.readFileSync(SESSIONS, 'utf8');

  test('the result branch overrides usageIn/usageOut from modelUsage when present', () => {
    assert.match(src, /modelRows = parseModelUsage\(msg\)/);
    assert.match(src, /usageIn = modelRows\.reduce/);
    assert.match(src, /usageOut = modelRows\.reduce/);
  });

  test('the ledger gets one row PER MODEL when the whole-tree breakdown exists', () => {
    assert.match(src, /for \(const r of modelRows\) logTokens\(project, id, r\.tokensIn, r\.tokensOut, r\.costUsd, r\.model\)/);
    // and the single-row fallback survives for results without modelUsage
    assert.match(src, /logTokens\(project, id, usageIn, usageOut, costUsd, \(task && task\.model\) \|\| DEFAULT_MODEL\)/);
  });
});
