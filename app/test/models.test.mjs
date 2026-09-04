// Superseded model IDs resolve to their successor so "Fable" always means the
// newest release, for saved tasks and config defaults alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalModel, MODEL_ALIASES } from '../lib/models.js';

test('claude-fable-5 is aliased to claude-fable-5-1', () => {
  assert.equal(MODEL_ALIASES['claude-fable-5'], 'claude-fable-5-1');
  assert.equal(canonicalModel('claude-fable-5'), 'claude-fable-5-1');
});

test('current IDs and non-strings pass through unchanged', () => {
  assert.equal(canonicalModel('claude-fable-5-1'), 'claude-fable-5-1');
  assert.equal(canonicalModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(canonicalModel(null), null);
  assert.equal(canonicalModel(undefined), undefined);
});

// ── reasoning effort: one control, two ladders ──
import { effortsFor, coerceEffort, CLAUDE_EFFORTS, CODEX_EFFORTS } from '../lib/models.js';

test('each provider has its own effort ladder; Claude includes max, Codex includes minimal', () => {
  assert.deepEqual([...effortsFor('claude')], [...CLAUDE_EFFORTS]);
  assert.deepEqual([...effortsFor('codex')], [...CODEX_EFFORTS]);
  assert.ok(CLAUDE_EFFORTS.includes('max') && !CLAUDE_EFFORTS.includes('minimal'));
  assert.ok(CODEX_EFFORTS.includes('minimal') && !CODEX_EFFORTS.includes('max'));
});

test('coerceEffort keeps shared rungs, snaps the ends, and defaults unknowns to high', () => {
  assert.equal(coerceEffort('claude', 'xhigh'), 'xhigh');
  assert.equal(coerceEffort('codex', 'xhigh'), 'xhigh');
  assert.equal(coerceEffort('claude', 'minimal'), 'low');   // Codex-only rung → nearest Claude rung
  assert.equal(coerceEffort('codex', 'max'), 'xhigh');      // Claude-only rung → nearest Codex rung
  assert.equal(coerceEffort('claude', undefined), 'high');
  assert.equal(coerceEffort('codex', 'bogus'), 'high');
});
