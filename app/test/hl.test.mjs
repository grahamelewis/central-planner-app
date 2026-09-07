// test/hl.test.mjs — hl.js syntax highlighter invariants.
//  1. round-trip fidelity: stripping tags + unescaping the highlighted HTML
//     must equal the original input (a wrong color is tolerable; lost/garbled
//     text is not).
// Read-only highlighting is independent of the retired editor overlay.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { APP_DIR } from './helpers.mjs';

const { hlText, hlFor } = await import(path.join(APP_DIR, 'public', 'hl.js'));
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
  // wave 1 (docs/language-support/RUNTIMES.md): the compact grammars behind
  // the editor's langFor table — keyed by the extensions the workbench sends
  rs: 'use std::fmt;\n/// doc <T> & "q"\nfn f<\'a>(x: &\'a str) -> Option<char> { x.chars().next() } // c <a>\n/* block\n< > & */\nlet s = "a<b>&\\"c"; let c = \'<\'; let b = b\'x\';\nprintln!("{} {}", 1u32, 0xFF_u8);\n#[derive(Debug)]\nstruct S;',
  go: 'package main\n\nimport "fmt"\n\n// comment <x> & "q"\nfunc main() {\n\ts := `raw <a>\n& "multi"`\n\tfmt.Println(s, \'<\', 3.5e2, "a<b>&\\"c")\n\t/* block\n< > & */\n}',
  js: '// comment <x> & "q"\nexport function add(a, b) { return `t${a} <b> & "q"\nmulti` + a; }\n/* block\n< > & */\nconst s = \'x<y\' + "a<b>&\\"c"; let n = 10n + 0xFF + 1e9;',
  ts: 'interface Foo<T> { readonly n: number; s: string }\n// comment <x> & "q"\nexport const f = (x: Foo<string>): string => `${x.s} <b>` + "a<b>&\\"c";\n/* block\n< > & */\nenum E { A = 1 }',
  c: '#include <stdio.h>\n// comment <x> & "q"\nint main(void) {\n  /* block\n  < > & */\n  printf("a<b>&\\"c\\n", 10UL, 1.0f, \'<\');\n  return 0;\n}',
  cpp: '#include <iostream>\n// comment <x> & "q"\ntemplate <typename T> class A : public B<T> {\n  virtual void f() override { std::cout << "a<b>&\\"c" << 0x1F; }\n  /* block\n  < > & */\n};',
  hpp: '#pragma once\n#ifndef H_HPP\n#define H_HPP 1\nint add(int a, int b); // <x> &\n#endif',
  toml: '[package] # <x> &\nname = "a<b>&\\"c"\nversion = \'0.1.0\'\nedition = 2021\nok = true\nwhen = 1979-05-27T07:32:00Z\ndesc = """multi <a>\n& line"""\n[dependencies.serde]\nfeatures = ["derive"]',
  yml: '---\n# comment <x> & "q"\nname: a<b\nlist:\n  - a: 1\n  - "x<y>&\\"z"\n  - \'q<r\'\nanchor: &base { on: yes }\nref: *base\n...',
  makefile: '# build <x> & "q"\nCC ?= cc\nCFLAGS := -Wall\nall: hello\n\t$(CC) $(CFLAGS) -o $@ $< "a<b" \'c<d\'\n.PHONY: all clean\nifeq ($(OS),Windows_NT)\n\techo ${HOME}\nendif',
  mk: 'include common.mk # <x>\nobjs = $(patsubst %.c,%.o,$(wildcard *.c))\n$(BIN): $(objs)\n\t$(CC) -o $@ $^',
  cmake: 'cmake_minimum_required(VERSION 3.10) # <x> &\nproject(hello LANGUAGES C)\nset(SRC "a<b>&\\"c")\nadd_executable(hello ${SRC})\ntarget_link_libraries(hello $<TARGET_FILE:dep>)',
  mod: 'module example.com/hello // <x> &\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3 // indirect\n\tgithub.com/c/d v0.0.0-20240102150405-abcdef123456\n)\nreplace github.com/a/b => ../b',
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

/* ═══ wave 1 grammars (docs/language-support/RUNTIMES.md, editor row) ═══
   Each grammar: a keyword gets .kw, a string with an embedded `<` is escaped
   INSIDE its .st span, a comment gets .cm, and the multiline openers carry
   across lines and close. hlFor maps every extension the workbench can send
   (rel.split('.').pop().toLowerCase(), so `Makefile` arrives as 'makefile'). */
describe('wave 1 grammars', () => {
  const kw = (html, w) => new RegExp(`<span class="kw">${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`).test(html);
  const cls = (html, c, w) => new RegExp(`<span class="${c}">${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`).test(html);

  test('hlFor: every wave-1 extension resolves; CMakeLists.txt (txt) stays plain', () => {
    const map = {
      rs: 'rs', go: 'go',
      js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
      ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
      c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', 'c++': 'c', hpp: 'c', hxx: 'c', hh: 'c',
      toml: 'toml', yaml: 'yaml', yml: 'yaml',
      makefile: 'make', gnumakefile: 'make', mk: 'make',
      cmake: 'cmake', mod: 'gomod', sum: 'gomod',
    };
    for (const [ext, lang] of Object.entries(map)) assert.equal(hlFor(ext), lang, `hlFor(${ext})`);
    assert.equal(hlFor('txt'), null, 'CMakeLists.txt is plaintext (no txt grammar)');
    // the pre-existing map is untouched
    for (const [ext, lang] of Object.entries({ jl: 'jl', py: 'py', r: 'r', sh: 'sh', tex: 'tex', bib: 'tex', json: 'json', md: 'md', sql: 'sql' })) {
      assert.equal(hlFor(ext), lang, `existing hlFor(${ext})`);
    }
  });

  test('rust: keywords, escaped string, char vs lifetime, macro, attribute, block comment carry', () => {
    const html = hlText(SNIPPETS.rs, 'rs');
    assert.ok(kw(html, 'fn') && kw(html, 'let') && kw(html, 'struct') && kw(html, 'Option'), 'keywords');
    assert.ok(cls(html, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;'), 'string with < > & " escaped inside .st');
    assert.ok(cls(html, 'st', "'&lt;'"), "char literal '<' is a string token");
    assert.ok(cls(html, 'fn', "'a"), 'lifetime is fn, not the start of a string');
    assert.ok(cls(html, 'fn', 'println!'), 'macro call');
    assert.ok(cls(html, 'fn', '#[derive(Debug)]'), 'attribute');
    assert.ok(cls(html, 'cm', '/// doc &lt;T&gt; &amp; &quot;q&quot;'), 'doc comment');
    assert.ok(cls(html, 'nm', '1u32') && cls(html, 'nm', '0xFF_u8'), 'suffixed numbers');
    const lines = html.split('\n');
    assert.match(lines[3], /^<span class="cm">\/\* block<\/span>$/, 'block comment opener line');
    assert.match(lines[4], /^<span class="cm">&lt; &gt; &amp; \*\/<\/span>$/, 'carried + closed');
    assert.ok(kw(lines[5], 'let'), 'highlighting resumes after the close');
  });

  test('go: keywords + builtins, raw string carries across lines, rune literal', () => {
    const html = hlText(SNIPPETS.go, 'go');
    assert.ok(kw(html, 'package') && kw(html, 'import') && kw(html, 'func'), 'keywords');
    assert.ok(cls(html, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;'), 'escaped string');
    assert.ok(cls(html, 'st', "'&lt;'"), 'rune literal');
    const lines = html.split('\n');
    assert.match(lines[6], /<span class="st">`raw &lt;a&gt;<\/span>$/, 'raw string opener carries');
    assert.match(lines[7], /^<span class="st">&amp; &quot;multi&quot;`<\/span>/, 'raw string closes on the next line');
    assert.ok(cls(html, 'nm', '3.5e2'), 'float');
    assert.ok(cls(html, 'cm', '// comment &lt;x&gt; &amp; &quot;q&quot;'), 'line comment');
  });

  test('js: keywords, template literal carry, both quote styles, bigint/hex/exp numbers', () => {
    const html = hlText(SNIPPETS.js, 'js');
    assert.ok(kw(html, 'export') && kw(html, 'function') && kw(html, 'return') && kw(html, 'const'), 'keywords');
    assert.ok(!kw(html, 'interface'), 'ts-only vocabulary is plain in js');
    const lines = html.split('\n');
    assert.match(lines[1], /<span class="st">`t\$\{a\} &lt;b&gt; &amp; &quot;q&quot;<\/span>$/, 'template opener carries');
    assert.match(lines[2], /^<span class="st">multi`<\/span>/, 'template closes');
    assert.ok(cls(html, 'st', "'x&lt;y'") && cls(html, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;'), 'strings escaped');
    assert.ok(cls(html, 'nm', '10n') && cls(html, 'nm', '0xFF') && cls(html, 'nm', '1e9'), 'numbers');
  });

  test('ts: the js tokenizer plus the type vocabulary', () => {
    const html = hlText(SNIPPETS.ts, 'ts');
    for (const w of ['interface', 'readonly', 'number', 'string', 'export', 'const', 'enum']) assert.ok(kw(html, w), `kw ${w}`);
    assert.ok(cls(html, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;'), 'escaped string');
    assert.ok(cls(html, 'nm', '1'), 'number');
    assert.ok(!cls(html, 'kw', 'Foo'), 'identifiers stay plain');
  });

  test('c / cpp / hpp: one grammar — preprocessor lines, keywords, block comment carry', () => {
    const c = hlText(SNIPPETS.c, 'c');
    assert.ok(cls(c, 'fn', '#include') && kw(c, 'int') && kw(c, 'void') && kw(c, 'return'), 'c tokens');
    assert.ok(cls(c, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c\\n&quot;'), 'escaped string');
    assert.ok(cls(c, 'nm', '10UL') && cls(c, 'nm', '1.0f'), 'suffixed numbers');
    const lines = c.split('\n');
    assert.match(lines[3], /<span class="cm">\/\* block<\/span>$/, 'block comment opener');
    assert.match(lines[4], /^<span class="cm"> {2}&lt; &gt; &amp; \*\/<\/span>$/, 'carried + closed');
    const cpp = hlText(SNIPPETS.cpp, 'cpp');
    for (const w of ['template', 'typename', 'class', 'public', 'virtual', 'void', 'override']) assert.ok(kw(cpp, w), `cpp kw ${w}`);
    assert.ok(cls(cpp, 'fn', '#include') && cls(cpp, 'nm', '0x1F'), 'cpp include + hex');
    const h = hlText(SNIPPETS.hpp, 'hpp');
    assert.ok(cls(h, 'fn', '#pragma') && cls(h, 'fn', '#ifndef') && cls(h, 'fn', '#endif') && kw(h, 'int'), 'hpp preprocessor + kw');
  });

  test('toml: tables, keys, strings, dates, booleans, """ carry', () => {
    const html = hlText(SNIPPETS.toml, 'toml');
    assert.ok(cls(html, 'kw', '[package]') && cls(html, 'kw', '[dependencies.serde]'), 'tables');
    assert.ok(cls(html, 'fn', 'name') && cls(html, 'fn', 'features'), 'keys');
    assert.ok(cls(html, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;') && cls(html, 'st', "'0.1.0'"), 'strings');
    assert.ok(cls(html, 'nm', '2021') && cls(html, 'nm', '1979-05-27T07:32:00Z'), 'int + datetime');
    assert.ok(kw(html, 'true'), 'boolean');
    assert.ok(cls(html, 'cm', '# &lt;x&gt; &amp;'), 'comment');
    const lines = html.split('\n');
    assert.match(lines[6], /<span class="st">&quot;&quot;&quot;multi &lt;a&gt;<\/span>$/, '""" opener carries');
    assert.match(lines[7], /^<span class="st">&amp; line&quot;&quot;&quot;<\/span>/, '""" closes');
  });

  test('yaml: document markers, keys, anchors, strings, booleans', () => {
    const html = hlText(SNIPPETS.yml, 'yml');
    assert.ok(cls(html, 'kw', '---') && cls(html, 'kw', '...'), 'document markers');
    assert.ok(cls(html, 'fn', 'name') && cls(html, 'fn', 'list') && cls(html, 'fn', '&amp;base') && cls(html, 'fn', '*base'), 'keys + anchor/alias');
    assert.ok(cls(html, 'st', '&quot;x&lt;y&gt;&amp;\\&quot;z&quot;') && cls(html, 'st', "'q&lt;r'"), 'strings');
    assert.ok(kw(html, 'yes'), 'boolean');
    assert.ok(cls(html, 'cm', '# comment &lt;x&gt; &amp; &quot;q&quot;'), 'comment');
  });

  test('makefile / .mk: targets, automatic + named variables, directives', () => {
    const html = hlText(SNIPPETS.makefile, 'makefile');
    assert.ok(cls(html, 'kw', 'all:') && cls(html, 'kw', '.PHONY:'), 'target lines');
    assert.ok(cls(html, 'fn', '$(CC)') && cls(html, 'fn', '$@') && cls(html, 'fn', '$&lt;') && cls(html, 'fn', '${HOME}'), 'variables');
    assert.ok(kw(html, 'ifeq') && kw(html, 'endif'), 'directives');
    assert.ok(cls(html, 'st', '&quot;a&lt;b&quot;') && cls(html, 'st', "'c&lt;d'"), 'strings');
    assert.ok(cls(html, 'cm', '# build &lt;x&gt; &amp; &quot;q&quot;'), 'comment');
    assert.ok(!/<span class="kw">CC \?=/.test(html) && !/<span class="kw">CFLAGS :=/.test(html), 'assignments are not targets');
    const mk = hlText(SNIPPETS.mk, 'mk');
    assert.ok(kw(mk, 'include') && cls(mk, 'kw', '$(BIN):') && cls(mk, 'fn', '$^'), '.mk tokens');
  });

  test('cmake (*.cmake) + go.mod: commands any-case, ${VAR} / $<GEN>, directives + versions', () => {
    const cm = hlText(SNIPPETS.cmake, 'cmake');
    assert.ok(kw(cm, 'cmake_minimum_required') && kw(cm, 'project') && kw(cm, 'set'), 'commands');
    assert.ok(cls(cm, 'fn', '${SRC}') && cls(cm, 'fn', '$&lt;TARGET_FILE:dep&gt;'), 'variables / generator expressions');
    assert.ok(cls(cm, 'st', '&quot;a&lt;b&gt;&amp;\\&quot;c&quot;'), 'string');
    assert.ok(kw(hlText('SET(x 1)', 'cmake'), 'SET'), 'commands match any case');
    const mod = hlText(SNIPPETS.mod, 'mod');
    for (const w of ['module', 'go', 'require', 'replace']) assert.ok(kw(mod, w), `go.mod kw ${w}`);
    assert.ok(cls(mod, 'nm', 'v1.2.3') && cls(mod, 'nm', 'v0.0.0-20240102150405-abcdef123456'), 'versions');
    assert.ok(cls(mod, 'cm', '// &lt;x&gt; &amp;'), 'comment');
  });
});
