// latex/texCore.js — the S0 scoped extraction (blueprint §14 A21, seams doc
// "Phase 2 deltas" #1–#3): the pure LaTeX-brain functions and tables that BOTH
// editor paths share, moved here VERBATIM so there is exactly one authority.
//
//   from texEditor.js — texOutline (§ outline parser), needsEnd (unclosed-env
//     depth count), openEnvsIn (unclosed envs above the caret, ex-closure),
//     and the completion vocabulary: COMMON_ENVS, COMMON_COMMANDS and the four
//     line-local context detectors CITE_RE / REF_RE / ENV_RE / CMD_RE;
//   from util.js — TEX_SYMS (the Julia \name→glyph table) and the pure core of
//     texComplete(), split out as texSymbolMatch() (util.js keeps a thin DOM
//     applier — texComplete(el) — importing it back).
//
// Consumers: the legacy path (texEditor.js, util.js) imports everything back
// from here, unchanged in behavior; the Monaco path (texProviders.js and, at
// S1, monacoPane commands) builds on the same exports. Zero app imports,
// DOM-free, node-importable — golden/unit-tested without a browser.

'use strict';

/* ─────────────────────────── static completion data ─────────────────────────── */

export const COMMON_ENVS = [
  'abstract', 'align', 'align*', 'array', 'block', 'cases', 'center', 'columns',
  'description', 'document', 'enumerate', 'equation', 'equation*', 'figure',
  'frame', 'gather', 'itemize', 'lstlisting', 'matrix', 'minipage', 'multline',
  'pmatrix', 'proof', 'quote', 'split', 'subfigure', 'table', 'tabular',
  'theorem', 'tikzpicture', 'titlepage', 'verbatim', 'wrapfigure',
];

// name → arg template appended on accept ('' = none). Caret lands inside the
// first {} (or [] for the optional-arg forms).
/** @type {{ [name: string]: string }} */
export const COMMON_COMMANDS = {
  addbibresource: '{}', alpha: '', autocite: '{}', autoref: '{}',
  bar: '{}', begin: '{}', beta: '', bibliography: '{}', bibliographystyle: '{}',
  bigskip: '', boldsymbol: '{}', caption: '{}', cdot: '', chapter: '{}',
  chi: '', cite: '{}', citep: '{}', citet: '{}', clearpage: '', delta: '',
  documentclass: '{}', dots: '', emph: '{}', end: '{}', ensuremath: '{}',
  epsilon: '', eqref: '{}', eta: '', footnote: '{}', frac: '{}{}', gamma: '',
  geq: '', hat: '{}', hline: '', hspace: '{}', include: '{}',
  includegraphics: '[]{}', infty: '', input: '{}', int: '', iota: '',
  item: '', kappa: '', label: '{}', lambda: '', ldots: '', left: '', leq: '',
  lim: '', maketitle: '', mathbb: '{}', mathbf: '{}', mathcal: '{}',
  mathrm: '{}', mu: '', nabla: '', neq: '', newcommand: '{}{}', newpage: '',
  nocite: '{}', noindent: '', nu: '', omega: '', overline: '{}',
  pagebreak: '', paragraph: '{}', parencite: '{}', partial: '', phi: '', pi: '',
  prod: '', psi: '', qquad: '', quad: '', ref: '{}', renewcommand: '{}{}',
  rho: '', right: '', section: '{}', setlength: '{}{}', sigma: '', sqrt: '{}',
  subsection: '{}', subsubsection: '{}', sum: '', tau: '', text: '{}',
  textbf: '{}', textit: '{}', textsc: '{}', texttt: '{}', theta: '', tilde: '{}',
  title: '{}', today: '', underline: '{}', upsilon: '', usepackage: '[]{}',
  varepsilon: '', varphi: '', vec: '{}', vspace: '{}', widehat: '{}',
  widetilde: '{}', xi: '', zeta: '',
};

/* The four line-local completion contexts (matched against the text before
   the caret; anchored at its end). */
export const CITE_RE = /\\(?:no|paren|text|auto|foot|smart)?[cC]ite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;
export const REF_RE = /\\(?:auto|c|C|eq|page|name|v|f)?ref\*?\{([^{}]*)$/;
export const ENV_RE = /\\(begin|end)\{([A-Za-z*]*)$/;
export const CMD_RE = /\\([a-zA-Z]{1,})$/;

const SECTION_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{(.*)/;
/** @type {{ [name: string]: number }} */
const SEC_DEPTH = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };

/* ─────────────────────────── environments ─────────────────────────── */

/**
 * Environments opened in `text` (everything above the caret) and not yet
 * closed — best \end{} guesses, innermost first.
 * @param {string} text
 * @returns {string[]}
 */
export function openEnvsIn(text) {
  const opens = [];
  const re = /\\(begin|end)\{([A-Za-z*]+)\}/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === 'begin') opens.push(m[2]);
    else {
      const i = opens.lastIndexOf(m[2]);
      if (i >= 0) opens.splice(i, 1);
    }
  }
  return opens.reverse();
}

/**
 * Does `env` still need an \end{env} in `text` (net-positive \begin depth)?
 * @param {string} text
 * @param {string} env
 * @returns {boolean}
 */
export function needsEnd(text, env) {
  const re = new RegExp(`\\\\(begin|end)\\{${env.replace('*', '\\*')}\\}`, 'g');
  let depth = 0;
  let m;
  while ((m = re.exec(text))) depth += m[1] === 'begin' ? 1 : -1;
  return depth > 0;
}

/* ─────────────────────────── outline ─────────────────────────── */

/**
 * Parse \section-family headings → [{depth, title, line}].
 * @param {string} text
 * @returns {{ depth: number, title: string, line: number }[]}
 */
export function texOutline(text) {
  const out = [];
  const nl = String(text).split('\n');
  for (let i = 0; i < nl.length; i++) {
    const m = nl[i].match(SECTION_RE);
    if (!m) continue;
    // balanced-brace scan: `\section{The \emph{big} model}\label{x}` → the
    // title ends at the close matching the OPENING brace, not the line's last
    let depth = 1;
    let title = m[2];
    for (let j = 0; j < title.length; j++) {
      if (title[j] === '{') depth++;
      else if (title[j] === '}' && --depth === 0) { title = title.slice(0, j); break; }
    }
    out.push({ depth: SEC_DEPTH[m[1]] ?? 1, title: title.slice(0, 80) || '(untitled)', line: i + 1 });
    if (out.length >= 200) break;
  }
  return out;
}

/* ── Julia-style LaTeX completion: type \beta then Tab → β ──────────────────
   The glyph table + trailing-\name matcher (pure core of util.texComplete;
   the DOM applier stays in util.js). Names are the Julia/LaTeX set:
   \epsilon ϵ vs \varepsilon ε, \phi ϕ vs \varphi φ. */
/** @type {{ [name: string]: string }} */
export const TEX_SYMS = {
  // greek (Julia/LaTeX names: \epsilon ϵ vs \varepsilon ε, \phi ϕ vs \varphi φ)
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // operators & relations
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  cdots: '⋯', ldots: '…', dots: '…', prime: '′', infty: '∞', partial: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', sqrt: '√', propto: '∝',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡', neq: '≠', ne: '≠',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', prec: '≺', succ: '≻',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', lor: '∨',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙',
  perp: '⊥', parallel: '∥', angle: '∠', therefore: '∴', because: '∵',
  vdash: '⊢', dashv: '⊣', models: '⊨', top: '⊤', bot: '⊥',
  // arrows
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', hookrightarrow: '↪',
  longrightarrow: '⟶', implies: '⟹', iff: '⟺',
  // letterlike & sets (Julia's \bb…/\scr… names)
  hbar: 'ℏ', ell: 'ℓ', wp: '℘', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  bbN: 'ℕ', bbZ: 'ℤ', bbQ: 'ℚ', bbR: 'ℝ', bbC: 'ℂ', bbE: '𝔼', bbP: 'ℙ', bbone: '𝟙',
  scrF: 'ℱ', scrG: '𝒢', scrH: 'ℋ', scrL: 'ℒ', scrO: '𝒪',
  // misc
  degree: '°', checkmark: '✓', dagger: '†', ddagger: '‡', S: '§', P: '¶',
  copyright: '©', euro: '€', pounds: '£', yen: '¥', cent: '¢',
  // super/subscripts: \^2 → ², \_t → ₜ
  '^0': '⁰', '^1': '¹', '^2': '²', '^3': '³', '^4': '⁴', '^5': '⁵', '^6': '⁶', '^7': '⁷',
  '^8': '⁸', '^9': '⁹', '^+': '⁺', '^-': '⁻', '^=': '⁼', '^(': '⁽', '^)': '⁾', '^n': 'ⁿ', '^i': 'ⁱ',
  '_0': '₀', '_1': '₁', '_2': '₂', '_3': '₃', '_4': '₄', '_5': '₅', '_6': '₆', '_7': '₇',
  '_8': '₈', '_9': '₉', '_+': '₊', '_-': '₋', '_=': '₌', '_(': '₍', '_)': '₎',
  '_a': 'ₐ', '_e': 'ₑ', '_i': 'ᵢ', '_j': 'ⱼ', '_k': 'ₖ', '_m': 'ₘ', '_n': 'ₙ', '_t': 'ₜ', '_x': 'ₓ',
};

/**
 * Match a trailing `\name` (or `\^2` / `\_t`) at the end of `before` (the
 * text left of the caret; only the last 24 chars are considered, exactly as
 * the legacy applier sliced).
 * @param {string} before
 * @returns {{ name: string, length: number, sym: string | null } | null}
 *   null = nothing to complete · sym null = a \name attempt, unknown glyph
 */
export function texSymbolMatch(before) {
  const m = String(before).slice(-24).match(/\\([A-Za-z]+|[\^_][0-9A-Za-z+\-=()])$/);
  if (!m) return null;
  return { name: m[1], length: m[0].length, sym: TEX_SYMS[m[1]] || null };
}
