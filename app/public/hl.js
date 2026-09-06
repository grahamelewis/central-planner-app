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
  json: {
    re: /(?<st>"(?:\\.|[^"\\])*")|(?<nm>-?\b\d[\d.]*(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z]\w*)/g,
    multi: {},
    kw: new Set(['true', 'false', 'null']),
  },
  md: { custom: mdLine },
};

const EXT_LANG = {
  jl: 'jl', py: 'py', r: 'r', sh: 'sh', bash: 'sh', zsh: 'sh',
  tex: 'tex', sty: 'tex', cls: 'tex', bib: 'tex',
  json: 'json', md: 'md', rmd: 'md', qmd: 'md', markdown: 'md',
  sql: 'sql',
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
