// texlog.js — LaTeX .log parsing into structured problems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLatexLog, unwrapLog, problemCounts, passFromLine } from '../lib/texlog.js';

test('file-line-error errors parse with file, line, and message', () => {
  const log = [
    'This is pdfTeX, Version 3.141592653',
    './main.tex:12: Undefined control sequence.',
    'l.12 \\badmacro',
    '',
    './chapters/intro.tex:3: LaTeX Error: Environment itemzie undefined.',
    '',
    'See the LaTeX manual or LaTeX Companion for explanation.',
  ].join('\n');
  const p = parseLatexLog(log);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { file: './main.tex', line: 12, kind: 'error', message: 'Undefined control sequence.' });
  assert.equal(p[1].file, './chapters/intro.tex');
  assert.equal(p[1].line, 3);
  assert.match(p[1].message, /Environment itemzie undefined/);
});

test('bang errors without file context still get a line from the l.N echo', () => {
  const log = [
    '! Missing $ inserted.',
    '<inserted text>',
    '                $',
    'l.42 x_1',
  ].join('\n');
  const p = parseLatexLog(log);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'error');
  assert.equal(p[0].line, 42);
  assert.equal(p[0].file, null);
  assert.match(p[0].message, /Missing \$ inserted/);
});

test('warnings: references, citations, package warnings, with input lines', () => {
  const log = [
    "LaTeX Warning: Reference `fig:model' on page 1 undefined on input line 10.",
    '',
    "LaTeX Warning: Citation `krusell1998' on page 2 undefined on input line 31.",
    '',
    'Package hyperref Warning: Token not allowed in a PDF string on input line 7.',
    '',
    'LaTeX Warning: There were undefined references.',
  ].join('\n');
  const p = parseLatexLog(log);
  assert.equal(p.length, 4);
  assert.ok(p.every((x) => x.kind === 'warning'));
  assert.equal(p[0].line, 10);
  assert.equal(p[1].line, 31);
  assert.equal(p[2].line, 7);
  assert.equal(p[3].line, null);
});

test('badboxes parse with their line ranges', () => {
  const log = 'Overfull \\hbox (13.55pt too wide) in paragraph at lines 12--14';
  const p = parseLatexLog(log);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'badbox');
  assert.equal(p[0].line, 12);
});

test('hard-wrapped log lines (max_print_line=79) are unwrapped before matching', () => {
  const long = './a/very/deeply/nested/path/that/goes/on/and/on/chapters/section-intro.tex:99';
  // craft a physical wrap at exactly 79 chars
  const wrapped = (long + ': Undefined control sequence.').match(/.{1,79}/g).join('\n');
  assert.ok(wrapped.includes('\n'), 'fixture actually wraps');
  const p = parseLatexLog(wrapped);
  assert.equal(p.length, 1);
  assert.equal(p[0].line, 99);
  assert.match(p[0].file, /section-intro\.tex$/);
});

test('unwrapLog keeps short lines intact', () => {
  assert.deepEqual(unwrapLog('a\nb\nc'), ['a', 'b', 'c']);
});

test('duplicate problems dedupe; counts split by kind', () => {
  const log = [
    './m.tex:5: Undefined control sequence.',
    './m.tex:5: Undefined control sequence.',
    "LaTeX Warning: Reference `x' on page 1 undefined on input line 2.",
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--4',
  ].join('\n');
  const p = parseLatexLog(log);
  assert.equal(p.length, 3);
  assert.deepEqual(problemCounts(p), { errors: 1, warnings: 1, badboxes: 1 });
});

test('passFromLine: pdflatex pass line', () => {
    assert.deepEqual(passFromLine("Run number 2 of rule 'pdflatex'"), { n: 2, rule: 'pdflatex' });
});
test('passFromLine: multi-word rules keep the tool name only', () => {
    assert.deepEqual(passFromLine("Run number 1 of rule 'bibtex paper'"), { n: 1, rule: 'bibtex' });
});
test('passFromLine: non-boundary lines are null', () => {
    assert.equal(passFromLine('Output written on t.pdf (1 page, 29436 bytes).'), null);
    assert.equal(passFromLine("Latexmk: applying rule 'pdflatex'..."), null);
    assert.equal(passFromLine('  Run number 1 of rule mid-line'), null);
});
