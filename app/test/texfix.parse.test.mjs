// parseSuggestions — turning the fixer's reply into validated suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSuggestions } from '../lib/texfix.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texfix-parse-'));
const baseContent = '\\documentclass{article}\n\\secton{Intro}\nBody $x$.\n';
const ctx = { root, baseContent, mainRel: 'paper.tex' };
fs.writeFileSync(path.join(root, 'appendix.tex'), '\\subsectoin{Extra}\n');

test('clean JSON array parses; ids and open status assigned', () => {
  const out = parseSuggestions(JSON.stringify([
    { file: 'paper.tex', find: '\\secton{Intro}', replace: '\\section{Intro}', why: 'typo' },
  ]), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'open');
  assert.equal(out[0].file, 'paper.tex');
  assert.ok(out[0].id);
});

test('fenced / prose-wrapped replies still parse', () => {
  const reply = 'Here you go:\n```json\n[{"file":"paper.tex","find":"\\\\secton{Intro}","replace":"\\\\section{Intro}","why":"typo"}]\n```\nDone.';
  assert.equal(parseSuggestions(reply, ctx).length, 1);
});

test('un-anchored finds are dropped (must appear verbatim in the dispatched file)', () => {
  const out = parseSuggestions(JSON.stringify([
    { file: 'paper.tex', find: 'not in the file at all', replace: 'x' },
    { file: 'paper.tex', find: '\\secton{Intro}', replace: '\\section{Intro}' },
  ]), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].find, '\\secton{Intro}');
});

test('suggestions for \\input files anchor against the file on disk', () => {
  const out = parseSuggestions(JSON.stringify([
    { file: 'appendix.tex', find: '\\subsectoin{Extra}', replace: '\\subsection{Extra}' },
  ]), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'appendix.tex');
});

test('containment: files outside the project are dropped', () => {
  const out = parseSuggestions(JSON.stringify([
    { file: '../../etc/passwd', find: 'root', replace: 'x' },
  ]), ctx);
  assert.equal(out.length, 0);
});

test('no-op and malformed entries are dropped; garbage returns []', () => {
  assert.equal(parseSuggestions('no json here', ctx).length, 0);
  const out = parseSuggestions(JSON.stringify([
    { file: 'paper.tex', find: '\\secton{Intro}', replace: '\\secton{Intro}' }, // no-op
    { file: 'paper.tex', find: '', replace: 'x' },
    { notEven: 'close' },
  ]), ctx);
  assert.equal(out.length, 0);
});
