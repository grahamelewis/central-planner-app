// latex/texLang.js — Monarch 'latex' + 'bibtex' grammars and language
// configurations (Phase 3 S0, blueprint §6). Plain data + pure builders: no
// monaco import — registration happens in monacoPane at S1
// (languages.register / setMonarchTokensProvider / setLanguageConfiguration).
//
// The latex grammar's math/verbatim states are SEEDED from texZones.js (the
// shared zone scanner — invariant I7) and its tokenization is pinned to the
// legacy hl.js tokenizer via the frozen A13 goldens: test/latex.monarch.test.mjs
// runs this grammar inside real Monaco (headless Chrome) over the corpus and
// asserts the normalized token runs equal the fixtures. hl.js semantics that
// look odd are deliberate and frozen: a single `$` also closes `$$` display
// math; `&` is `warn` in text but `operator.math` in math; `\end{env}` pops the
// innermost matching env without nesting; an unclosed inline `$` dies at EOL
// (Monarch: the `@eos` guard pops `@mathInline` on the token that reaches the
// line end — verified against the 0.56 monarch lexer, which passes
// `pos === lineLength` to case guards).
//
// The bibtex grammar is a separate language (madoko-seeded, new semantics —
// deliberately NOT legacy-parity: legacy ran .bib through the tex tokenizer).
// bibtex gets no $ auto-closing pair and (at S2) no completion provider.

'use strict';

import { TEX_MATH_ENVS, TEX_VERB_ENVS, TEX_SYM } from './texZones.js';

export const latexLanguageId = 'latex';
export const bibtexLanguageId = 'bibtex';

/**
 * Language routing for the extensions the LaTeX brain owns.
 * @param {string} ext lowercase extension without dot
 * @returns {string | null}
 */
export function langForTexExt(ext) {
  if (ext === 'tex' || ext === 'sty' || ext === 'cls') return latexLanguageId;
  if (ext === 'bib') return bibtexLanguageId;
  return null;
}

/* ── eos wrapper: make a state die at end-of-line ──
   Wraps every non-transitioning action in cases{'@eos': …+'@pop'} so the token
   that reaches the line end also pops the state. Used by @mathInline only —
   display/paren/bracket/env states carry across lines, inline `$` must not. */
/** @param {*} action @returns {*} */
function eosPop(action) {
  if (typeof action === 'string') {
    return { cases: { '@eos': { token: action, next: '@pop' }, '@default': action } };
  }
  if (Array.isArray(action)) {
    const a = action.slice();
    a[a.length - 1] = eosPop(a[a.length - 1]);
    return a;
  }
  if (action && action.cases) {
    /** @type {{ [k: string]: any }} */
    const cases = {};
    for (const k of Object.keys(action.cases)) cases[k] = eosPop(action.cases[k]);
    return { cases };
  }
  if (action && action.token != null && !action.next) {
    return { cases: { '@eos': { ...action, next: '@pop' }, '@default': action } };
  }
  return action; // already transitions (@pop close rules) — leave it
}

/* Shared math-mode rule list. Order mirrors hl.js TEX_RE alternation:
   composite \begin/\end · command · escapes · comment · $ · number · word ·
   operator · brace. State-specific pops are threaded via options. */
/**
 * @param {{ endPop?: boolean, close?: 'paren' | 'bracket' | null, dollarPops?: boolean }} [opts]
 * @returns {any[]}
 */
function mathRules({ endPop = false, close = null, dollarPops = false } = {}) {
  /** @type {any[]} */
  const rules = [];
  if (endPop) {
    // \end{<this env>} — $S2 is the env carried in the state name
    // ('mathEnv.align*'); monarch escapes it, exactly the legacy endRe
    rules.push([/(\\end)(\s*\{\s*)($S2)(\s*\})/,
      ['keyword', 'punctuation', 'tag.env', { token: 'punctuation', next: '@pop' }]]);
  }
  // any other \begin/\end composite is inert inside math (legacy: no nesting)
  rules.push([/(\\(?:begin|end))(\s*\{\s*)([A-Za-z*]+)(\s*\})/,
    ['keyword', 'punctuation', 'tag.env', 'punctuation']]);
  // commands: TEX_SYM names (± trailing *) → ms, else structural kw
  rules.push([/\\[A-Za-z@@]+\*?/,
    { cases: { '@mathSymbols': 'keyword.symbol.math', '@default': 'keyword' } }]);
  if (close === 'paren') rules.push([/\\\)/, { token: 'delimiter.math', next: '@pop' }]);
  if (close === 'bracket') rules.push([/\\\]/, { token: 'delimiter.math', next: '@pop' }]);
  rules.push([/\\\\/, 'warn']); // row breaks pop in math
  rules.push([/\\./, 'keyword']);
  rules.push([/%.*/, 'comment']); // runs to EOL, stays inside the wash
  rules.push(dollarPops
    ? [/\$\$|\$/, { token: 'delimiter.math', next: '@pop' }] // a lone $ closes $$ too (legacy)
    : [/\$\$|\$/, 'delimiter.math']); // stray $ inside an env — just mark it
  rules.push([/\d[\d.]*/, 'number']);
  rules.push([/[A-Za-z]+/, 'variable.math']);
  rules.push([/[=+\-*/<>^_&|'~]+/, 'operator.math']);
  rules.push([/[{}[\]()]+/, 'punctuation']);
  rules.push([/[ \t]+/, '']);
  return rules;
}

/**
 * The Monarch 'latex' grammar (IMonarchLanguage-shaped plain object).
 * @returns {any}
 */
export function latexMonarch() {
  return {
    defaultToken: '', // unmatched chars (unicode, punctuation, lone \) are plain — legacy gaps
    tokenPostfix: '',
    ignoreCase: false,
    // attribute fragments referenced from rules
    mathEnvNames: TEX_MATH_ENVS,
    verbEnvNames: TEX_VERB_ENVS,
    mathSymbols: [...TEX_SYM].flatMap((s) => ['\\' + s, '\\' + s + '*']),
    tokenizer: {
      root: [
        // \verb<delim>literal<delim> — argument is literal, $ never toggles
        // math. Delimiter rules mirror the legacy lexer's greed: after \verb*
        // any non-space char is the delimiter; after unstarred \verb the
        // delimiter cannot be a letter/@/* (those would extend the command).
        [/(\\verb\*)([^ ])([^]*?)(\2)/, ['keyword', 'string', 'string', 'string']],
        [/(\\verb)([^A-Za-z@@* ])([^]*?)(\2)/, ['keyword', 'string', 'string', 'string']],
        [/(\\verb\*)([^ ])([^]*)/, ['keyword', 'string', 'string']],
        [/(\\verb)([^A-Za-z@@* ])([^]*)/, ['keyword', 'string', 'string']],
        // \begin{math-env} → parameterized state push; wash starts after the {…}
        [/(\\begin)(\s*\{\s*)((?:@mathEnvNames)\*?)(\s*\})/,
          ['keyword', 'punctuation', 'tag.env', { token: 'punctuation', next: '@mathEnv.$3' }]],
        // \begin{verbatim-family} → literal body until the matching \end
        [/(\\begin)(\s*\{\s*)((?:@verbEnvNames)\*?)(\s*\})/,
          ['keyword', 'punctuation', 'tag.env', { token: 'punctuation', next: '@verbatim.$3' }]],
        // any other \begin/\end composite
        [/(\\(?:begin|end))(\s*\{\s*)([A-Za-z*]+)(\s*\})/,
          ['keyword', 'punctuation', 'tag.env', 'punctuation']],
        [/\\[A-Za-z@@]+\*?/, 'keyword'],
        [/\\\[/, { token: 'delimiter.math', next: '@mathBracket' }],
        [/\\\(/, { token: 'delimiter.math', next: '@mathParen' }],
        [/\\./, 'keyword'], // single-char commands: \\ \$ \% \{ \, …
        [/%.*/, 'comment'],
        [/\$\$/, { token: 'delimiter.math', next: '@mathDisplay' }],
        // inline $: at EOL it opens nothing that survives the line (legacy
        // inline zones die at the line break), so don't push a carrying state
        [/\$/, { cases: { '@eos': 'delimiter.math', '@default': { token: 'delimiter.math', next: '@mathInline' } } }],
        [/\d[\d.]*/, 'number'],
        [/[A-Za-z]+/, ''],
        [/&/, 'warn'],
        [/[=+\-*/<>^_|'~]+/, ''],
        [/[{}[\]()]+/, 'punctuation'],
        [/[ \t]+/, ''],
      ],
      mathEnv: mathRules({ endPop: true }),
      mathDisplay: mathRules({ dollarPops: true }),
      mathParen: mathRules({ close: 'paren' }),
      mathBracket: mathRules({ close: 'bracket' }),
      // inline math dies at EOL: every rule is eos-wrapped, plus an any-char
      // catchall so even unmatched trailing chars pop the state at line end
      mathInline: [
        ...mathRules({ dollarPops: true }).map(([re, action]) => [re, eosPop(action)]),
        [/[^]/, { cases: { '@eos': { token: '', next: '@pop' }, '@default': '' } }],
      ],
      // verbatim body: literal 'string' until \end{<this env>} ($S2)
      verbatim: [
        [/(\\end)(\s*\{\s*)($S2)(\s*\})/,
          ['keyword', 'punctuation', 'tag.env', { token: 'punctuation', next: '@pop' }]],
        [/[^\\]+/, 'string'],
        [/\\/, 'string'],
      ],
    },
  };
}

/**
 * The Monarch 'bibtex' grammar — madoko-seeded, deliberately new semantics
 * (legacy hl.js ran .bib through the tex tokenizer; that parity is not kept).
 * @returns {any}
 */
export function bibtexMonarch() {
  return {
    defaultToken: '',
    tokenPostfix: '',
    ignoreCase: true,
    tokenizer: {
      root: [
        [/%.*/, 'comment'],
        // @entrytype{ … — the cite key is the first field-free token
        [/(@@[a-zA-Z]+)(\s*)([{(])/, ['keyword', '', { token: 'punctuation', next: '@entry' }]],
        [/@@[a-zA-Z]+/, 'keyword'],
        [/[^@@%]+/, 'comment'], // free text between entries is implicit comment
        [/@@/, 'comment'],
      ],
      entry: [
        [/[ \t\r\n]+/, ''],
        [/%.*/, 'comment'],
        [/([^\s,={}()"#]+)(\s*)(,)/, ['tag.entry-key', '', 'punctuation']],
        [/([a-zA-Z][\w-]*)(\s*)(=)/, ['attribute.name', '', 'operator']],
        [/\{/, { token: 'punctuation', next: '@braceValue' }],
        [/"/, { token: 'string', next: '@quoteValue' }],
        [/\d+/, 'number'],
        [/#/, 'operator'],
        [/,/, 'punctuation'],
        [/[})]/, { token: 'punctuation', next: '@pop' }],
        [/[^\s,={}()"#]+/, ''], // bare values: months, @string names
      ],
      // brace-delimited field value; nested braces stay string-classed
      braceValue: [
        [/[^{}]+/, 'string'],
        [/\{/, { token: 'string', next: '@braceInner' }],
        [/\}/, { token: 'punctuation', next: '@pop' }],
      ],
      braceInner: [
        [/[^{}]+/, 'string'],
        [/\{/, { token: 'string', next: '@braceInner' }],
        [/\}/, { token: 'string', next: '@pop' }],
      ],
      quoteValue: [
        [/[^"{]+/, 'string'],
        [/\{/, { token: 'string', next: '@braceInner' }],
        [/"/, { token: 'string', next: '@pop' }],
      ],
    },
  };
}

/* ── language configurations (P11) ──
   Plain objects — no monaco enums used. latex auto-pairs $…$; bibtex omits the
   $ pair by contract ("the .bib exclusions for free"). */

export const latexConfiguration = {
  comments: { lineComment: '%' },
  brackets: /** @type {[string, string][]} */ ([['{', '}'], ['[', ']'], ['(', ')']]),
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
  ],
  wordPattern: /\\?[A-Za-z@]+\*?/,
};

export const bibtexConfiguration = {
  comments: { lineComment: '%' },
  brackets: /** @type {[string, string][]} */ ([['{', '}'], ['[', ']'], ['(', ')']]),
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
  wordPattern: /[A-Za-z][\w-]*/,
};
