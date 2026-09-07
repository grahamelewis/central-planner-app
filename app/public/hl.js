// hl.js — tiny dependency-free syntax highlighter for the code pane.
// Line-based with a carry state for multiline constructs (block comments,
// triple-quoted strings), so edits re-tokenize only the changed lines and
// whatever the carry state invalidates downstream. Token classes (.kw .st
// .cm .fn .nm) are styled in style.css under .codeHalf; text always comes
// out of esc(), so a wrong color is the worst possible failure.

'use strict';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const span = (cls, s) => cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s);

/* Each language: one sticky-ish global regex with named groups, a keyword
   set for the generic `id` group, and a table of multiline openers whose
   {cls,end} configs double as the carry-state objects — they are stable
   references, so carry states compare with `===`.
   Group meanings: open (multiline opener) · cm (comment) · st (string) ·
   kwp (directly-keyword pattern) · fn (macro/decorator/var) · nm (number) ·
   id (identifier → kw if in the set). */

const JL_MULTI = { '#=': { cls: 'cm', end: '=#' }, '"""': { cls: 'st', end: '"""' } };
const PY_MULTI = { '"""': { cls: 'st', end: '"""' }, "'''": { cls: 'st', end: "'''" } };
const SQL_MULTI = { '/*': { cls: 'cm', end: '*/' } };
// wave 1 (docs/language-support/RUNTIMES.md): the C-family block comment,
// plus the backtick literal where it spans lines (JS templates, Go raw strings)
const C_MULTI = { '/*': { cls: 'cm', end: '*/' } };
const JS_MULTI = { '/*': { cls: 'cm', end: '*/' }, '`': { cls: 'st', end: '`' } };
const TOML_MULTI = { '"""': { cls: 'st', end: '"""' }, "'''": { cls: 'st', end: "'''" } };
// shared C-family pieces: numbers with any suffix (1u64, 10UL, 1.0f, 10n,
// 1e9) and the "…" string — spliced into per-language regexes below
const C_NUM = String.raw`\b0[xXbBoO][\da-fA-F_]+\w*|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*`;
const C_STR = String.raw`"(?:\\.|[^"\\])*"`;
const JS_KW = ('async await break case catch class const continue debugger default delete do else export '
  + 'extends finally for from function if import in instanceof let new of return static super switch this '
  + 'throw try typeof var void while with yield true false null undefined NaN Infinity get set '
  + 'constructor').split(' ');

const LANGS = {
  jl: {
    re: /(?<open>#=|""")|(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(?<fn>@[A-Za-z_]\w*!?)|(?<nm>\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*)|(?<id>[A-Za-z_]\w*!?)/g,
    multi: JL_MULTI,
    kw: new Set(('function end if elseif else for while begin let local global const return break continue '
      + 'module baremodule using import export struct mutable abstract primitive type quote do try catch '
      + 'finally macro where in isa true false nothing missing NaN Inf').split(' ')),
  },
  py: {
    re: /(?<open>[rbfuRBFU]{0,2}(?:"""|'''))|(?<cm>#[^\n]*)|(?<st>[rbfuRBFU]{0,2}"(?:\\.|[^"\\])*"|[rbfuRBFU]{0,2}'(?:\\.|[^'\\])*')|(?<fn>@[A-Za-z_][\w.]*)|(?<nm>\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*)|(?<id>[A-Za-z_]\w*)/g,
    multi: PY_MULTI,
    kw: new Set(('def class return if elif else for while in not and or is None True False import from as '
      + 'with try except finally lambda yield pass break continue raise assert del global nonlocal '
      + 'async await match case print').split(' ')),
  },
  r: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<nm>\b0x[\da-fA-F]+L?\b|\b\d+[\d.]*(?:[eE][+-]?\d+)?L?i?\b)|(?<id>[A-Za-z._][\w.]*)/g,
    multi: {},
    kw: new Set(('function if else for while repeat break next return in TRUE FALSE NULL NA NaN Inf '
      + 'library require source setwd c').split(' ')),
  },
  sh: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'[^']*')|(?<fn>\$\{[^}\n]*\}|\$\w+)|(?<nm>\b\d+\b)|(?<id>[A-Za-z_]\w*)/g,
    multi: {},
    kw: new Set(('if then else elif fi for while until do done case esac function in local export '
      + 'return exit set source echo cd').split(' ')),
  },
  sql: {
    // strings use ''-doubling, not backslash escapes; "double quotes" are
    // identifiers in SQL but read fine on the string color. Keywords match
    // any case (kwLower) — SELECT and select are both idiomatic.
    re: /(?<open>\/\*)|(?<cm>--[^\n]*)|(?<st>'(?:[^']|'')*'|"(?:[^"]|"")*")|(?<nm>\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z_]\w*)/g,
    multi: SQL_MULTI,
    kwLower: true,
    kw: new Set(('select from where group by order having join left right inner outer full cross on as with '
      + 'union all distinct limit offset insert into values update set delete create or replace table view '
      + 'temp temporary drop alter add column and not null is in exists between like ilike glob case when '
      + 'then else end cast over partition window rows range preceding following current row asc desc nulls '
      + 'first last using copy to attach detach pragma install load describe summarize explain analyze '
      + 'primary key unique default if returning sample tablesample true false').split(' ')),
  },
  tex: { custom: texLine },
  rs: {
    // char literals are ONE char ('a', '\n'); a bare 'a is a lifetime (fn),
    // so "fn f<'a>(x: &'a str)" never reads as a string. Macros (println!)
    // and #[attributes] share the fn colour.
    re: new RegExp(String.raw`(?<open>/\*)|(?<cm>//[^\n]*)|(?<st>b?${C_STR}|b?'(?:\\.|[^'\\])')|(?<fn>#!?\[[^\]\n]*\]|'[A-Za-z_]\w*|[A-Za-z_]\w*!(?=\s*[({\[]))|(?<nm>${C_NUM})|(?<id>[A-Za-z_]\w*)`, 'g'),
    multi: C_MULTI,
    kw: new Set(('as async await break const continue crate dyn else enum extern false fn for if impl in let '
      + 'loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where '
      + 'while union macro_rules i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str '
      + 'String Vec Option Some None Result Ok Err Box').split(' ')),
  },
  go: {
    re: new RegExp(String.raw`(?<open>/\*|\`)|(?<cm>//[^\n]*)|(?<st>${C_STR}|'(?:\\.|[^'\\])*')|(?<nm>${C_NUM})|(?<id>[A-Za-z_]\w*)`, 'g'),
    multi: JS_MULTI, // the backtick opener is Go's raw string
    kw: new Set(('break case chan const continue default defer else fallthrough for func go goto if import '
      + 'interface map package range return select struct switch type var true false nil iota bool byte rune '
      + 'string error int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 '
      + 'complex64 complex128 any append cap close copy delete len make new panic print println recover').split(' ')),
  },
  js: {
    re: new RegExp(String.raw`(?<open>/\*|\`)|(?<cm>//[^\n]*)|(?<st>${C_STR}|'(?:\\.|[^'\\])*')|(?<fn>@[A-Za-z_][\w.]*)|(?<nm>${C_NUM})|(?<id>[A-Za-z_$][\w$]*)`, 'g'),
    multi: JS_MULTI,
    kw: new Set(JS_KW),
  },
  ts: {
    // same tokenizer as js (spliced in below LANGS); the keyword set adds
    // the type-level vocabulary
    re: /$^/g,
    multi: JS_MULTI,
    kw: new Set(JS_KW.concat(('abstract as declare enum implements interface is keyof namespace never private '
      + 'protected public readonly satisfies type unknown any number string boolean symbol bigint object '
      + 'override module require').split(' '))),
  },
  c: {
    // one grammar for C and C++: preprocessor lines share the fn colour;
    // the keyword set is the union (harmless on a .c file)
    re: new RegExp(String.raw`(?<open>/\*)|(?<cm>//[^\n]*)|(?<st>${C_STR}|'(?:\\.|[^'\\])*')|(?<fn>#\s*[a-z]+)|(?<nm>${C_NUM})|(?<id>[A-Za-z_]\w*)`, 'g'),
    multi: C_MULTI,
    kw: new Set(('auto break case char const continue default do double else enum extern float for goto if '
      + 'inline int long register restrict return short signed sizeof static struct switch typedef union '
      + 'unsigned void volatile while _Bool _Complex bool true false NULL nullptr class namespace template '
      + 'typename public private protected virtual override final new delete this friend using operator '
      + 'explicit constexpr consteval constinit static_cast dynamic_cast reinterpret_cast const_cast try '
      + 'catch throw noexcept mutable decltype export import module concept requires co_await co_return '
      + 'co_yield size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t').split(' ')),
  },
  // the files that ride along: labelled, lightly coloured, never wrong
  toml: {
    re: /(?<open>"""|''')|(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'[^'\n]*')|(?<kwp>^\s*\[[^\]\n]*\])|(?<fn>^\s*[A-Za-z0-9_.-]+(?=\s*=))|(?<nm>\b\d{4}-\d\d-\d\d[^\s,\]}]*|[+-]?\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z_][\w-]*)/g,
    multi: TOML_MULTI,
    kw: new Set(['true', 'false', 'inf', 'nan']),
  },
  yaml: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'[^'\n]*')|(?<kwp>^---\s*$|^\.\.\.\s*$)|(?<fn>^\s*(?:-\s+)?[A-Za-z0-9_.\/-]+(?=\s*:(?:\s|$))|[&*][\w-]+|![\w!\/]+)|(?<nm>\b-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z_]\w*)/g,
    multi: {},
    kw: new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null', 'TRUE', 'FALSE', 'NULL']),
  },
  make: {
    // a target line "name: deps" is kw; $(VAR) / ${VAR} / $@ / $< are fn
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'[^'\n]*')|(?<kwp>^[A-Za-z0-9_.$(){}%\/-][^:=#\n]*?:(?!=))|(?<fn>\$\([^)\n]*\)|\$\{[^}\n]*\}|\$[@<^*?%+|]|\$\w)|(?<nm>\b\d+\b)|(?<id>[A-Za-z_.][\w.]*)/g,
    multi: {},
    kw: new Set(('ifeq ifneq ifdef ifndef else endif include define endef export unexport override vpath '
      + '.PHONY .SUFFIXES .DEFAULT .PRECIOUS .SECONDARY').split(' ')),
  },
  cmake: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*")|(?<fn>\$\{[^}\n]*\}|\$<[^>\n]*>)|(?<nm>\b\d[\d.]*\b)|(?<id>[A-Za-z_]\w*)/g,
    multi: {},
    kwLower: true,
    kw: new Set(('cmake_minimum_required project add_executable add_library add_subdirectory add_test '
      + 'target_link_libraries target_include_directories target_compile_options target_compile_features '
      + 'target_compile_definitions set unset if else elseif endif foreach endforeach while endwhile function '
      + 'endfunction macro endmacro include find_package find_library option message install enable_testing '
      + 'return list string file configure_file on off true false').split(' ')),
  },
  gomod: {
    // go.mod / go.sum: directives + versions
    re: /(?<cm>\/\/[^\n]*)|(?<st>"[^"\n]*")|(?<nm>\bv\d[\w.+-]*)|(?<id>[A-Za-z_]\w*)/g,
    multi: {},
    kw: new Set(['module', 'go', 'require', 'replace', 'exclude', 'retract', 'toolchain']),
  },
  json: {
    re: /(?<st>"(?:\\.|[^"\\])*")|(?<nm>-?\b\d[\d.]*(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z]\w*)/g,
    multi: {},
    kw: new Set(['true', 'false', 'null']),
  },
  md: { custom: mdLine },
};
LANGS.ts.re = LANGS.js.re; // one tokenizer, two keyword sets (lineTok resets lastIndex per line)

const EXT_LANG = {
  jl: 'jl', py: 'py', r: 'r', sh: 'sh', bash: 'sh', zsh: 'sh',
  tex: 'tex', sty: 'tex', cls: 'tex', bib: 'tex',
  json: 'json', md: 'md', rmd: 'md', qmd: 'md', markdown: 'md',
  sql: 'sql',
  // wave 1 — the read-only fallback for the editor's langFor table. Keys are
  // rel.split('.').pop().toLowerCase(), so a dotless name arrives whole
  // (Makefile → makefile); CMakeLists.txt is 'txt' and stays unhighlighted.
  rs: 'rs', go: 'go',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', 'c++': 'c', hpp: 'c', hxx: 'c', hh: 'c',
  toml: 'toml', yaml: 'yaml', yml: 'yaml',
  makefile: 'make', gnumakefile: 'make', mk: 'make',
  cmake: 'cmake', mod: 'gomod', sum: 'gomod',
};

/** Is there a highlighter for this (lowercase) extension? */
export function hlFor(ext) { return EXT_LANG[ext] || null; }

/* markdown: headings/quotes/fences per line, light inline marks; fence
   bodies stay plain (we don't know their language cheaply) */
const MD_FENCE = { cls: '', end: '' }; // sentinel carry state
const MD_INLINE = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\)/g;
function mdLine(line, st) {
  if (st === MD_FENCE) {
    if (/^\s*(```|~~~)/.test(line)) return [span('cm', line), null];
    return [esc(line), MD_FENCE];
  }
  if (/^\s*(```|~~~)/.test(line)) return [span('cm', line), MD_FENCE];
  if (/^#{1,6}\s/.test(line)) return [span('kw', line), null];
  if (/^\s*>/.test(line)) return [span('cm', line), null];
  let out = '', last = 0, m;
  MD_INLINE.lastIndex = 0;
  while ((m = MD_INLINE.exec(line))) {
    out += esc(line.slice(last, m.index));
    out += span(m[0][0] === '`' ? 'st' : m[0][0] === '[' ? 'fn' : 'nm', m[0]);
    last = MD_INLINE.lastIndex;
  }
  return [out + esc(line.slice(last)), null];
}

/* ── tex: hand-rolled tokenizer ──
   Math zones — inline $…$, \(…\), display \[…\]/$$…$$, and the amsmath
   environments (which carry across lines) — get a background wash (.mzone)
   and a differentiated palette: variables italic (.mv), greek/symbol
   commands (.ms), structural commands (.kw), operators (.mo), numbers (.nm),
   delimiters (.md), braces dimmed (.pt). Text mode keeps commands purple and
   colors \begin/\end environment names (.cl). */

const TEX_MATH_ENV = /^(?:align|alignat|aligned|cases|darray|displaymath|eqnarray|equation|gather|gathered|math|multline|split|subequations|[pbBvV]?matrix|smallmatrix)\*?$/;
const TEX_SYM = new Set(('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa '
  + 'lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega '
  + 'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega '
  + 'infty partial nabla hbar ell prime emptyset aleph '
  + 'sum prod int oint lim limsup liminf sup inf max min '
  + 'cdot cdots ldots dots vdots ddots times pm mp div ast star circ bullet '
  + 'leq geq neq approx sim simeq equiv propto ll gg prec succ mid '
  + 'in notin ni subset supset subseteq supseteq cup cap setminus '
  + 'forall exists nexists neg lor land oplus otimes odot perp parallel angle '
  + 'to gets mapsto implies iff Rightarrow Leftarrow Leftrightarrow '
  + 'rightarrow leftarrow leftrightarrow longrightarrow uparrow downarrow').split(' '));

// Stable tokenizer carry states.
const TEX_M = {
  inline: { math: true, close: '$' },
  display: { math: true, close: '$$' },
  paren: { math: true, close: '\\)' },
  bracket: { math: true, close: '\\]' },
};
const texEnvStates = new Map();
function texEnvState(env) {
  if (!texEnvStates.has(env)) texEnvStates.set(env, { math: true, env });
  return texEnvStates.get(env);
}

// verbatim-family environments: their bodies are literal text — a raw `$` in
// there must not open a math zone (it used to wash the entire rest of the file)
const TEX_VERB_ENV = /^(?:verbatim|Verbatim|lstlisting|minted|alltt|filecontents|comment)\*?$/;
const texVerbStates = new Map();
function texVerbState(env) {
  if (!texVerbStates.has(env)) texVerbStates.set(env, { verb: true, env });
  return texVerbStates.get(env);
}

const TEX_RE = /(%.*)|(\\(?:begin|end)\s*\{\s*[A-Za-z*]+\s*\})|(\\[A-Za-z@]+\*?)|(\\.)|(\$\$|\$)|(\d[\d.]*)|([A-Za-z]+)|([=+\-*/<>^_&|'~])|([{}[\]()])/g;
const TEX_BE = /^(\\(?:begin|end))(\s*\{\s*)([A-Za-z*]+)(\s*\})$/;

function texLine(line, st) {
  // inside a verbatim body: literal until the matching \end{env}
  if (st && st.verb) {
    const endRe = new RegExp(`\\\\end\\s*\\{\\s*${st.env.replace('*', '\\*')}\\s*\\}`);
    const m = line.match(endRe);
    if (!m) return [span('st', line), st];
    const be = m[0].match(TEX_BE);
    const endHtml = span('kw', be[1]) + span('pt', be[2]) + span('cl', be[3]) + span('pt', be[4]);
    const [restHtml, ns] = texLine(line.slice(m.index + m[0].length), null);
    return [span('st', line.slice(0, m.index)) + endHtml + restHtml, ns];
  }
  let out = '';
  let math = st && st.math ? '' : null; // open wash buffer for this line
  const flush = () => {
    if (math != null) {
      out += math ? `<span class="mzone">${math}</span>` : '';
      math = null;
    }
  };
  const put = (cls, s) => {
    const h = span(cls, s);
    if (math != null) {
      // leading indentation stays OUTSIDE the wash: a zone that swallows the
      // indent (or leaves an orphan stub before \end) reads as broken
      // highlighting, not as a math region — hug the actual content instead
      if (math === '' && !cls && /^\s+$/.test(s)) { out += h; return; }
      math += h;
    } else out += h;
  };

  TEX_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = TEX_RE.exec(line))) {
    const gap = line.slice(last, m.index);
    if (gap) put('', gap);
    last = TEX_RE.lastIndex;
    const [t, cm, beginEnd, cmd, esc1, dollar, num, word, op, brace] = m;

    if (cm != null) { put('cm', t); break; } // % comment runs to EOL

    if (beginEnd != null) {
      const be = t.match(TEX_BE);
      const env = be[3];
      const opens = be[1] === '\\begin';
      if (st && st.env && !opens && env === st.env) {
        flush(); // the closing \end sits outside the wash
        st = null;
      }
      put('kw', be[1]);
      put('pt', be[2]);
      put('cl', env);
      put('pt', be[4]);
      if (!st?.math && opens && TEX_MATH_ENV.test(env)) {
        st = texEnvState(env);
        math = ''; // wash starts after the \begin{…}
      } else if (!st?.math && opens && TEX_VERB_ENV.test(env)) {
        // rest of the line + following lines are literal until \end{env}
        const [restHtml, ns] = texLine(line.slice(last), texVerbState(env));
        return [out + restHtml, ns];
      }
      continue;
    }

    if (cmd != null) {
      if (!st?.math && /^\\verb\*?$/.test(t)) {
        // \verb<delim>literal<delim> — the argument is literal text; a `$` in
        // there must not toggle math. Consume through the closing delimiter.
        const delim = line[last];
        if (delim && delim !== ' ') {
          const close = line.indexOf(delim, last + 1);
          const end = close < 0 ? line.length : close + 1;
          put('kw', t);
          put('st', line.slice(last, end));
          TEX_RE.lastIndex = end;
          last = end;
          continue;
        }
      }
      put(st?.math && TEX_SYM.has(t.slice(1).replace(/\*$/, '')) ? 'ms' : 'kw', t);
      continue;
    }

    if (esc1 != null) { // single-char commands: \\ \$ \[ \] \( \) \{ \% …
      if (!st?.math && t === '\\[') { st = TEX_M.bracket; math = ''; put('md', t); continue; }
      if (!st?.math && t === '\\(') { st = TEX_M.paren; math = ''; put('md', t); continue; }
      if (st?.math && t === st.close) { put('md', t); flush(); st = null; continue; }
      put(st?.math && t === '\\\\' ? 'wn' : 'kw', t); // row breaks pop in math
      continue;
    }

    if (dollar != null) {
      if (st?.math && (st.close === '$' || st.close === '$$')) {
        put('md', t);
        flush();
        st = null;
      } else if (!st?.math) {
        st = t === '$$' ? TEX_M.display : TEX_M.inline;
        math = '';
        put('md', t);
      } else put('md', t); // stray $ inside an env — just mark it
      continue;
    }

    if (num != null) { put('nm', t); continue; }
    if (word != null) { put(st?.math ? 'mv' : '', t); continue; }
    if (op != null) { put(st?.math ? 'mo' : (t === '&' ? 'wn' : ''), t); continue; }
    if (brace != null) { put('pt', t); continue; }
  }
  const tail = line.slice(last);
  if (tail) put('', tail);
  // an unclosed inline `$` must not wash the entire rest of the document —
  // treat it as ending at the line break (display math and envs still carry)
  const exit = st === TEX_M.inline ? null : (st || null);
  flush();
  return [out, exit];
}

/* tokenize one line given the carry state entering it → [html, exitState] */
function lineTok(L, line, st) {
  if (L.custom) return L.custom(line, st);
  let out = '';
  let i = 0;
  while (st) { // finish a multiline construct first
    const e = line.indexOf(st.end, i);
    if (e < 0) return [out + span(st.cls, line.slice(i)), st];
    out += span(st.cls, line.slice(i, e + st.end.length));
    i = e + st.end.length;
    st = null;
  }
  const re = L.re;
  re.lastIndex = i;
  let last = i, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const g = m.groups || {};
    const t = m[0];
    if (g.open != null) {
      // strip any string prefix (python r/b/f) so the opener finds its config
      const cfg = L.multi[t] || L.multi[t.replace(/^[A-Za-z]+/, '')];
      if (cfg) {
        const e = line.indexOf(cfg.end, m.index + t.length);
        if (e < 0) return [out + span(cfg.cls, line.slice(m.index)), cfg];
        out += span(cfg.cls, line.slice(m.index, e + cfg.end.length));
        re.lastIndex = e + cfg.end.length;
        last = re.lastIndex;
        continue;
      }
      out += esc(t);
    } else {
      const cls = g.cm != null ? 'cm' : g.st != null ? 'st' : g.kwp != null ? 'kw'
        : g.fn != null ? 'fn' : g.nm != null ? 'nm'
          : g.id != null ? (L.kw.has(L.kwLower ? t.toLowerCase() : t) ? 'kw' : '') : '';
      out += span(cls, t);
    }
    last = re.lastIndex;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
  }
  return [out + esc(line.slice(last)), null];
}

/** One-shot highlight of a whole text → html string (read-only views). */
export function hlText(text, ext) {
  const lk = EXT_LANG[ext];
  if (!lk) return null;
  const L = LANGS[lk];
  let st = null, out = '';
  for (const line of String(text).split('\n')) {
    const [h, ns] = lineTok(L, line, st);
    out += h + '\n';
    st = ns;
  }
  return out;
}
