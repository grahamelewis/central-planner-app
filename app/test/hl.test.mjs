// test/hl.test.mjs — hl.js syntax highlighter invariants.
//  1. round-trip fidelity: stripping tags + unescaping the highlighted HTML
//     must equal the original input (a wrong color is tolerable; lost/garbled
//     text is not).
// Read-only highlighting is independent of the retired editor overlay.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { APP_DIR } from './helpers.mjs';

const { hlText } = await import(path.join(APP_DIR, 'public', 'hl.js'));
const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
const stripToText = html => html.replace(/<\/?span[^>]*>/g, '')
  .replace(/&(amp|lt|gt|quot);/g, match => UNESC[match]);

// Representative snippets per language (cover comments, strings, multiline
// constructs, and HTML-significant characters that must survive escaping).
const SNIPPETS = {
  jl: 'function f(x)\n    @assert x > 0  # check & <ok>\n    s = "a<b>&\\"c"\n    return x^2\nend\n#=\nblock comment with < > &\n=#\ndone',
  py: 'def g(n):\n    """doc <x> & "q" """\n    s = \'a<b>\' + "d&e"\n    # comment <tag>\n    return [i for i in range(n)]\nclass C: pass',
  r: 'f <- function(x) {\n  # comment <a&b>\n  y <- "str & <x>"\n  z <- c(1L, 2.5, 0xFFL)\n  TRUE & FALSE\n}',
  sh: '#!/bin/bash\n# a comment <x> & "q"\nfor f in *.txt; do\n  echo "hi $USER & ${HOME}"\ndone',
  md: '# Heading <x> &\n> a quote\ntext with `code` and **bold** and [link](http://u)\n```\nfenced < > & body\n```\nafter',
  json: '{\n  "key": "va<l&ue\\"",\n  "n": -1.5e3,\n  "ok": true,\n  "z": null\n}',
  tex: '% comment <x>\n\\section{Title & more}\ntext $x^2 + y$ and $$\\int_0^1$$ done',
  sql: "-- comment <x> & \"q\"\nSELECT a, count(*) AS n\nFROM read_parquet('works_*.parquet')\nWHERE name = 'O''Brien' AND v < 5\n/*\nblock comment < > &\n*/\ngroup by a;",
};

describe('hlFor / hlText basics', () => {
  test('hlText returns null for an unknown extension', async () => {
    assert.equal(hlText('x', 'zzz'), null);
  });

  for (const [ext, snip] of Object.entries(SNIPPETS)) {
    test(`hlText(${ext}) round-trips text exactly (strip tags + unescape === input)`, () => {
      const html = hlText(snip, ext);
      assert.ok(html != null, `hlText should support ${ext}`);
      // hlText appends a trailing \n per line; compare line-by-line content
      const got = stripToText(html);
      assert.equal(got, snip + '\n', `text fidelity for ${ext}`);
    });

    test(`hlText(${ext}) emits no unescaped < or & outside span tags`, () => {
      const html = hlText(snip, ext);
      // strip all span tags, then assert no raw < > remain (all should be &lt; etc.)
      const noTags = html.replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '');
      assert.ok(!/[<>]/.test(noTags), `no raw angle brackets leak for ${ext}`);
    });
  }
});

describe('sql tokens', () => {
  test('keywords match in ANY case; strings, comments, numbers colored', () => {
    const html = hlText("SELECT a FROM t where v = 'x''y' -- note\nLIMIT 10", 'sql');
    assert.match(html, /<span class="kw">SELECT<\/span>/, 'uppercase keyword');
    assert.match(html, /<span class="kw">where<\/span>/, 'lowercase keyword');
    assert.match(html, /<span class="st">'x''y'<\/span>/, "''-doubled quote stays ONE string");
    assert.match(html, /<span class="cm">-- note<\/span>/, 'line comment');
    assert.match(html, /<span class="nm">10<\/span>/, 'number');
    assert.ok(!/<span class="kw">a<\/span>/.test(html), 'identifiers stay plain');
  });
  test('/* */ block comment carries across lines and closes', () => {
    const html = hlText('SELECT 1;\n/* two\nlines */\nSELECT 2', 'sql');
    assert.match(html, /<span class="cm">\/\* two<\/span>/, 'opener line is comment');
    assert.match(html, /<span class="cm">lines \*\/<\/span>/, 'carry line is comment');
    const after = html.slice(html.indexOf('lines */'));
    assert.match(after, /<span class="kw">SELECT<\/span>/, 'highlighting resumes after close');
  });
});

describe('tex math zones', () => {
  test('inline $…$ gets a wash with differentiated tokens', () => {
    const html = hlText('cost $x^2 + \\alpha_1$ done', 'tex');
    assert.match(html, /<span class="mzone">/, 'math wash present');
    assert.match(html, /<span class="mv">x<\/span>/, 'variables italicized class');
    assert.match(html, /<span class="mo">\^<\/span>/, 'operators marked');
    assert.match(html, /<span class="ms">\\alpha<\/span>/, 'greek as symbol class');
    assert.match(html, /<span class="md">\$<\/span>/, 'delimiters marked');
    assert.ok(!html.includes('<span class="mv">cost</span>'), 'text-mode words stay plain');
  });

  test('\\alpha outside math is a plain command, inside math a symbol', () => {
    const html = hlText('\\alpha and $\\alpha$', 'tex');
    assert.match(html, /<span class="kw">\\alpha<\/span> and/, 'text mode: command purple');
    assert.match(html, /<span class="ms">\\alpha<\/span>/, 'math mode: symbol');
  });

  test('align* carries math across lines; \\end closes it', () => {
    const text = '\\begin{align*}\n\\frac{1}{x^{2}}\\mathbb{E}[X_{j}]\n\\end{align*}\nafter x';
    const html = hlText(text, 'tex');
    const lines = html.split('\n');
    assert.match(lines[1], /^<span class="mzone">/, 'body line fully washed');
    assert.match(lines[1], /<span class="kw">\\frac<\/span>/, 'structural command in math');
    assert.match(lines[1], /<span class="mv">X<\/span>/, 'variable in math');
    assert.ok(!lines[3].includes('mzone'), 'wash ends with the environment');
    assert.ok(!lines[3].includes('"mv"'), 'plain text after');
    assert.match(lines[0], /<span class="cl">align\*<\/span>/, 'env name colored');
  });

  test('escaped \\$ does not toggle math; % comments still win', () => {
    const html = hlText('price \\$5 and $x$ % note $y$', 'tex');
    assert.match(html, /<span class="kw">\\\$<\/span>/, 'escaped dollar is a command');
    const zones = (html.match(/mzone/g) || []).length;
    assert.equal(zones, 1, 'only the real $x$ opens math');
    assert.match(html, /<span class="cm">% note \$y\$<\/span>/, 'comment swallows the rest');
  });

});

describe('tex wash edges', () => {
  test('leading indentation stays outside the math wash; no orphan stub before \\end', () => {
    const text = '\\begin{align*}\n    \\frac{1}{2}\n    \\end{align*}';
    const lines = hlText(text, 'tex').split('\n');
    assert.match(lines[1], /^ {4}<span class="mzone">/, 'indent precedes the wash');
    assert.ok(!lines[2].includes('mzone'), 'the \\end line has no wash stub');
    assert.match(lines[2], /^ {4}<span class="kw">\\end<\/span>/, 'indent plain before \\end');
  });

  test('an indented inline $…$ keeps the wash tight around the math', () => {
    const html = hlText('  intro $x$', 'tex');
    assert.match(html, /^ {2}intro <span class="mzone">/, 'wash starts at the $');
  });
});

describe('tex verbatim + unclosed math containment', () => {
  test('a raw $ inside \\begin{verbatim} does not open a math zone', () => {
    const text = '\\begin{verbatim}\nprice $5 and $10\n\\end{verbatim}\nafter x';
    const lines = hlText(text, 'tex').split('\n');
    assert.ok(!lines[1].includes('mzone'), 'verbatim body unwashed');
    assert.ok(!lines[3].includes('mzone'), 'nothing leaks past \\end{verbatim}');
    assert.ok(!lines[3].includes('"mv"'), 'plain prose after stays plain');
  });

  test('\\verb|$x$| is literal; real math after it still washes', () => {
    const html = hlText('use \\verb|$x$| here and $y$ math', 'tex');
    assert.equal((html.match(/mzone/g) || []).length, 1, 'only the real $…$ washes');
    assert.match(html, /<span class="mv">y<\/span>/);
  });

  test('an unclosed inline $ ends at the line break instead of washing the file', () => {
    const lines = hlText('typo $ oops\nnext line x', 'tex').split('\n');
    assert.ok(lines[0].includes('mzone'), 'the typo line itself is marked');
    assert.ok(!lines[1].includes('mzone') && !lines[1].includes('"mv"'), 'carry dropped at EOL');
  });


});
