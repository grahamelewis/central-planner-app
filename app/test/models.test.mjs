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
