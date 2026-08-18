// test/sessions.test.mjs — parseHandoff() and parseQuestion(): the protocol
// parsers that read Claude's final message. They are NOT exported, and
// importing sessions.js pulls the Agent SDK + data-reading modules, so we
// extract their REAL source text and run them in isolation. No billing risk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const { parseHandoff, parseQuestion } = loadPrivateFns(
  path.join(APP_DIR, 'lib', 'sessions.js'), ['parseHandoff', 'parseQuestion']);

describe('parseHandoff', () => {
  test('parses a plain ```handoff fenced JSON block', () => {
    const txt = 'Done.\n\n```handoff\n{"summary":"finished","files":["a.py"]}\n```\n';
    assert.deepEqual(parseHandoff(txt), { summary: 'finished', files: ['a.py'] });
  });

  test('returns null when there is no handoff fence', () => {
    assert.equal(parseHandoff('just a normal message'), null);
    assert.equal(parseHandoff(''), null);
    assert.equal(parseHandoff(null), null);
  });

  test('handles handoff JSON that itself contains ``` fences (the hard case)', () => {
    // The summary string contains a code fence; a lazy match to the first ```
    // would truncate the JSON. The parser tries closing fences from the last
    // one backwards and must recover the full object.
    const inner = JSON.stringify({
      summary: 'I added a snippet:\n```python\nprint(1)\n```\nand it works',
      files: ['x.py'],
    }, null, 2);
    const txt = `Here is my handoff.\n\n\`\`\`handoff\n${inner}\n\`\`\`\n`;
    const r = parseHandoff(txt);
    assert.ok(r, 'should recover the object');
    assert.match(r.summary, /print\(1\)/);
    assert.deepEqual(r.files, ['x.py']);
  });

  test('uses the LAST ```handoff opener when several exist', () => {
    const txt = [
      '```handoff', '{"summary":"old"}', '```',
      'then revised:',
      '```handoff', '{"summary":"new"}', '```',
    ].join('\n');
    assert.deepEqual(parseHandoff(txt), { summary: 'new' });
  });

  test('returns null when the fenced body is not valid JSON', () => {
    const txt = '```handoff\nnot json at all\n```';
    assert.equal(parseHandoff(txt), null);
  });

  test('returns null for a JSON primitive (not an object)', () => {
    assert.equal(parseHandoff('```handoff\n42\n```'), null);
  });

  test('returns null when the opener has no following newline', () => {
    assert.equal(parseHandoff('```handoff'), null);
  });

  test('tolerates indentation/whitespace on the closing fence line', () => {
    const txt = '```handoff\n{"summary":"ok"}\n   ```   \n';
    assert.deepEqual(parseHandoff(txt), { summary: 'ok' });
  });
});

describe('parseQuestion', () => {
  test('extracts the text after a QUESTION: line', () => {
    assert.equal(parseQuestion('blah\nQUESTION: which path?\nmore'), 'which path?');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(parseQuestion('QUESTION:    spaced out   '), 'spaced out');
  });

  test('matches QUESTION: only at the start of a line', () => {
    assert.equal(parseQuestion('a NON-QUESTION: not this'), null);
  });

  test('returns the FIRST question when several lines match', () => {
    assert.equal(parseQuestion('QUESTION: first?\nQUESTION: second?'), 'first?');
  });

  test('returns null when there is no QUESTION line', () => {
    assert.equal(parseQuestion('no question here'), null);
    assert.equal(parseQuestion(''), null);
    assert.equal(parseQuestion(null), null);
  });

  test('handles an empty question body', () => {
    assert.equal(parseQuestion('QUESTION:'), '');
  });
});

describe('SESSION_ENV_OVERRIDES — the session-subprocess env floor', () => {
  // extracted from source (importing sessions.js pulls the SDK); losing any
  // of these regresses badly: the 120s CLI default SIGTERMs a foreground
  // `julia script.jl` mid package-load, and options.env REPLACES process.env
  const src = fs.readFileSync(path.join(APP_DIR, 'lib', 'sessions.js'), 'utf8');
  const m = src.match(/export const SESSION_ENV_OVERRIDES = (\{[\s\S]*?\});/);
  const overrides = m ? new Function(`return ${m[1]}`)() : null;

  test('bash timeouts give package-load room (≥10 min default, ≥60 min ceiling)', () => {
    assert.ok(overrides, 'SESSION_ENV_OVERRIDES present in sessions.js');
    assert.ok(Number(overrides.BASH_DEFAULT_TIMEOUT_MS) >= 600000,
      `default ${overrides.BASH_DEFAULT_TIMEOUT_MS} — the CLI's 120s fallback kills Julia startup`);
    assert.ok(Number(overrides.BASH_MAX_TIMEOUT_MS) >= 3600000,
      `ceiling ${overrides.BASH_MAX_TIMEOUT_MS}`);
    assert.ok(Number(overrides.BASH_MAX_OUTPUT_LENGTH) >= 150000, 'output cap kept');
  });

  test('Read token cap raised well above the 25k default (large notebooks stay readable/editable)', () => {
    // env-gated in the CLI (CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS ?? 25000);
    // without the raise, a >25k-token .ipynb can't be Read → NotebookEdit/Write
    // (which require a prior Read) are blocked
    assert.ok(Number(overrides.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS) >= 100000,
      `read cap ${overrides.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS} — must clear the 25k default by a wide margin`);
  });

  test('options.env spreads process.env (it REPLACES, never merges — PATH/keys must survive)', () => {
    assert.match(src, /env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.SESSION_ENV_OVERRIDES\s*\}/,
      'the query() env must spread process.env before the overrides');
  });
});
