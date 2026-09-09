import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendConsoleText, consoleSlices, bindConsoleTurn, resetConsoleOwnership, reviseConsoleText } from '../public/consoleOwnership.js';

test('optimistic request binds to server turn without guessing from prompt content', () => {
  const k = 'review/optimistic';
  let raw = appendConsoleText(k, '', 'first prompt\n', { requestId: 'request-A' });
  raw = appendConsoleText(k, raw, 'first response\n', { requestId: 'request-A', turnId: 'turn-A' });
  raw = appendConsoleText(k, raw, 'second prompt\n', { requestId: 'request-B' });
  bindConsoleTurn(k, 'request-B', 'turn-B');
  assert.deepEqual(consoleSlices(k, raw), [
    { text: 'first prompt\nfirst response\n', turnId: 'turn-A' },
    { text: 'second prompt\n', turnId: 'turn-B' },
  ]);
});

test('model text cannot forge ownership and untracked buffer replacement fails unowned', () => {
  const k = 'review/markers';
  const raw = appendConsoleText(k, '', '▸ you ─────\nturnId: fake\n', { turnId: 'real' });
  assert.equal(consoleSlices(k, raw)[0].turnId, 'real');
  assert.equal(consoleSlices(k, raw + 'unexpected replacement')[0].turnId, null);
  resetConsoleOwnership(k);
  assert.equal(consoleSlices(k, raw)[0].turnId, null);
});

test('bounded buffer trimming preserves exact surviving ownership and reveal slices', () => {
  const k = 'review/trim';
  let raw = appendConsoleText(k, '', 'old\nold\n', { turnId: 'A' }, 100);
  raw = appendConsoleText(k, raw, 'new\nnew\n', { turnId: 'B' }, 10);
  assert.ok(raw.length <= 10);
  assert.deepEqual(consoleSlices(k, raw), [{ text: raw, turnId: 'B' }]);
  assert.deepEqual(consoleSlices(k, raw, 3), [{ text: raw.slice(0, 3), turnId: 'B' }]);
});

test('final-answer insertion and rejected optimistic echo retain earlier turn boundaries', () => {
  const k = 'review/revise';
  let raw = appendConsoleText(k, '', 'A\n', { turnId: 'A' });
  raw = appendConsoleText(k, raw, 'B answer\n', { turnId: 'B' });
  const repaired = raw.replace('B answer', 'B\n— answer —\nanswer');
  raw = reviseConsoleText(k, raw, repaired);
  assert.deepEqual(consoleSlices(k, raw).map(s => s.turnId), ['A', 'B']);
  const saved = raw;
  raw = appendConsoleText(k, raw, 'rejected\n', { requestId: 'rejected' });
  raw = reviseConsoleText(k, raw, saved);
  assert.deepEqual(consoleSlices(k, raw).map(s => s.turnId), ['A', 'B']);
});

test('identical prompts on different turns stay separately owned, including late prior-turn events', () => {
  const k = 'review/repeats';
  let raw = appendConsoleText(k, '', 'repeat\n', { turnId: 'A' });
  raw = appendConsoleText(k, raw, 'repeat\n', { turnId: 'B' });
  raw = appendConsoleText(k, raw, 'late A\n', { turnId: 'A' });
  assert.deepEqual(consoleSlices(k, raw).map(s => s.turnId), ['A', 'B', 'A']);
});
