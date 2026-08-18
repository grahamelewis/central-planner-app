// Codex app-server text-item framing + completion reconciliation. Pure source
// extraction: no Codex process, provider request, browser, or billed route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { APP_DIR, loadPrivateFns } from './helpers.mjs';

const { codexTextFrame } = loadPrivateFns(
  path.join(APP_DIR, 'lib', 'sessions.js'), ['codexTextFrame']);
const { reconcileFinalTranscriptTail } = loadPrivateFns(
  path.join(APP_DIR, 'public', 'files.js'), ['reconcileFinalTranscriptTail']);

test('saved Codex history keeps user and assistant entries separate', () => {
  const tailBufs = {};
  const transcripts = {
    'alpha/task-1': { entries: [
      { role: 'user', text: 'Describe C.3.' },
      { role: 'assistant', provider: 'codex', text: 'Use a compact derivation.' },
    ] },
  };
  const { parseConsole, seedTailBuf } = loadPrivateFns(
    path.join(APP_DIR, 'public', 'console.js'), ['parseConsole', 'seedTailBuf'], {
      tailBufs,
      transcripts,
      agentName: (provider) => provider === 'codex' ? 'Codex' : 'Claude',
      taskProvider: (task) => task?.provider === 'codex' ? 'codex' : 'claude',
      QUES_RE: /^(?:#{1,4}\s+)?(?:\*\*|__)?QUESTION(?::\s*(?:\*\*|__)?|(?:\*\*|__):)\s*/,
    });

  const key = seedTailBuf('alpha', { id: 'task-1', provider: 'codex' });
  const segments = parseConsole(tailBufs[key]);

  assert.deepEqual(segments.map(({ type, text }) => ({ type, text: text.trim() })), [
    { type: 'you', text: 'Describe C.3.' },
    { type: 'ans', text: 'Use a compact derivation.' },
  ]);
  assert.ok(!segments.some(({ text }) => text.includes('▸ codex')),
    'the internal Codex boundary is consumed instead of shown in the user bubble');
});

test('Codex agent item boundaries separate commentary from a fenced final answer', () => {
  let key = null;
  let framed = codexTextFrame(key, 'agent', 'comment-1', 'commentary');
  assert.equal(framed.prefix, '\n∴ thinking…\n');
  key = framed.key;

  framed = codexTextFrame(key, 'agent', 'comment-1', 'commentary');
  assert.equal(framed.prefix, '', 'later deltas from the same item append without duplicate chrome');

  framed = codexTextFrame(key, 'agent', 'final-1', 'final_answer');
  assert.equal(framed.prefix, '\n— answer —\n', 'the final item starts its own Markdown segment');
  assert.notEqual(framed.key, key);
});

test('unknown message phases still receive an answer boundary', () => {
  const framed = codexTextFrame('agent:old', 'agent', 'new', null);
  assert.equal(framed.prefix, '\n— answer —\n');
});

test('completion repair separates a glued canonical final without losing live history', () => {
  const finalText = '```latex\n\\subsection{Criterion}\n```\nRecommendation.';
  const live = '∴ thinking…\nCheck assumptions. ' + finalText
    + '\n[result] file inspected\n— turn done · 1.0s —\n';
  const repaired = reconcileFinalTranscriptTail(live, finalText);

  assert.match(repaired, /Check assumptions\.\n— answer —\n```latex/);
  assert.match(repaired, /\[result\] file inspected/, 'tool/result history survives the targeted repair');
  assert.match(repaired, /turn done/, 'turn metadata survives too');
});

test('completion repair leaves an already-framed final untouched', () => {
  const finalText = '```latex\nx\n```';
  const live = 'commentary\n— answer —\n' + finalText + '\n— turn done —\n';
  assert.equal(reconcileFinalTranscriptTail(live, finalText), live);
});

test('completion repair adds a semantic answer marker even after a bare newline', () => {
  const finalText = '```latex\nx\n```';
  const live = 'commentary ended with a newline\n' + finalText;
  assert.equal(reconcileFinalTranscriptTail(live, finalText),
    'commentary ended with a newline\n— answer —\n' + finalText);
});

test('completion repair restores a canonical final when its live delta was absent', () => {
  const finalText = '```latex\nx\n```';
  const live = 'commentary only\n— turn done · 1.0s —\n';
  assert.equal(reconcileFinalTranscriptTail(live, finalText),
    'commentary only\n— answer —\n```latex\nx\n```\n— turn done · 1.0s —\n');
});
