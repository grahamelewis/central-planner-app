// latex/texZones.js — the shared math-zone scanner (Phase 3 S0, blueprint §5/§6).
//
// ONE source of truth for "where is math" (invariant I7): the Monarch grammar
// (texLang.js) seeds its math/verbatim states from the env alternations and
// symbol set exported here, and the S1 mzone decorations pass consumes
// scanMathZones() — so the tokenizer and the background wash can never drift.
// Both are pinned by the SAME frozen legacy goldens
// (test/latex-corpus/goldens/, the A13 oracle): scanMathZones() must reproduce
// hl.js's `.mzone` column ranges byte-for-byte over the corpus
// (test/texzones.test.mjs), and the grammar's normalized tokens must match the
// same fixtures (test/latex.monarch.test.mjs).
//
// The scanner is a faithful port of hl.js texLine() with the HTML emission
// deleted and column arithmetic kept. hl.js itself stays untouched until the
// ratified S3 prune; the goldens are the anti-drift gate between the copies.
// Zero app imports; DOM-free; runs under node and the browser alike.

'use strict';

/* ── shared vocabulary (seeds the Monarch grammar too) ── */

/** amsmath math environments (carry math state across lines), sans star. */
export const TEX_MATH_ENVS = 'align|alignat|aligned|cases|darray|displaymath|eqnarray|equation|gather|gathered|math|multline|split|subequations|[pbBvV]?matrix|smallmatrix';
/** Anchored whole-name test incl. optional star — hl.js TEX_MATH_ENV parity. */
export const TEX_MATH_ENV = new RegExp(`^(?:${TEX_MATH_ENVS})\\*?$`);

/** verbatim-family environments: literal bodies, raw $ never opens math. */
export const TEX_VERB_ENVS = 'verbatim|Verbatim|lstlisting|minted|alltt|filecontents|comment';
/** Anchored whole-name test incl. optional star — hl.js TEX_VERB_ENV parity. */
export const TEX_VERB_ENV = new RegExp(`^(?:${TEX_VERB_ENVS})\\*?$`);

/** Greek/symbol command names classed `ms` in math mode (hl.js TEX_SYM). */
export const TEX_SYM = new Set(('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa '
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

/* ── carry states — stable interned references (=== comparable, like hl.js) ── */

/** @typedef {{ math?: boolean, close?: string, env?: string, verb?: boolean }} TexZoneState */

const TEX_M = {
  inline: { math: true, close: '$' },
  display: { math: true, close: '$$' },
  paren: { math: true, close: '\\)' },
  bracket: { math: true, close: '\\]' },
};
/** @type {Map<string, TexZoneState>} */
const envStates = new Map();
function envState(env) {
  let s = envStates.get(env);
  if (!s) { s = { math: true, env }; envStates.set(env, s); }
  return s;
}
/** @type {Map<string, TexZoneState>} */
const verbStates = new Map();
function verbState(env) {
  let s = verbStates.get(env);
  if (!s) { s = { verb: true, env }; verbStates.set(env, s); }
  return s;
}

/** The line-start state of a fresh document (text mode). */
export const TEX_ZONE_INITIAL = null;

/* The token regex + \begin/\end splitter — byte-identical to hl.js TEX_RE /
   TEX_BE. Group order: comment · \begin/\end composite · command · single-char
   escape · $$/$ · number · word · operator · brace. */
const TEX_RE = /(%.*)|(\\(?:begin|end)\s*\{\s*[A-Za-z*]+\s*\})|(\\[A-Za-z@]+\*?)|(\\.)|(\$\$|\$)|(\d[\d.]*)|([A-Za-z]+)|([=+\-*/<>^_&|'~])|([{}[\]()])/g;
const TEX_BE = /^(\\(?:begin|end))(\s*\{\s*)([A-Za-z*]+)(\s*\})$/;

/**
 * Scan ONE logical line (hl.js '\n'-split semantics: CR bytes stay inside the
 * line) entering with carry state `st` → the `.mzone` wash column ranges and
 * the exit state for the next line.
 *
 * Ported from hl.js texLine(): every put()/flush() below mirrors an HTML
 * emission there; only the columns are kept. The subtle rules are preserved
 * deliberately — leading indentation stays OUTSIDE the wash while the zone
 * buffer is empty; the closing \end{env} sits outside the wash while closing
 * $ / $$ / \) / \] sit inside; an unclosed inline `$` dies at EOL while
 * display/paren/bracket/env states carry.
 *
 * @param {string} line one logical line, no '\n'
 * @param {TexZoneState | null} st carry state entering the line
 * @returns {{ zones: [number, number][], exit: TexZoneState | null }}
 */
export function scanLineZones(line, st) {
  // inside a verbatim body: literal until the matching \end{env} — no zones
  if (st && st.verb) {
    const endRe = new RegExp(`\\\\end\\s*\\{\\s*${st.env.replace('*', '\\*')}\\s*\\}`);
    const m = line.match(endRe);
    if (!m) return { zones: [], exit: st };
    const restStart = /** @type {number} */ (m.index) + m[0].length;
    const rest = scanLineZones(line.slice(restStart), null);
    return {
      zones: rest.zones.map(([s, e]) => /** @type {[number, number]} */ ([s + restStart, e + restStart])),
      exit: rest.exit,
    };
  }

  /** @type {[number, number][]} */
  const zones = [];
  let col = 0;
  let open = !!(st && st.math); // hl.js: math != null (wash buffer open)
  let zStart = -1;              // hl.js: math === '' ⇔ zStart < 0 (buffer empty)
  let zEnd = -1;

  const flush = () => {
    if (open) {
      if (zStart >= 0) zones.push([zStart, zEnd]);
      open = false;
      zStart = zEnd = -1;
    }
  };
  const openWash = () => { open = true; zStart = zEnd = -1; }; // hl.js: math = ''
  /** @param {string} cls @param {string} s */
  const put = (cls, s) => {
    const start = col;
    col += s.length;
    if (open) {
      // leading indentation stays OUTSIDE the wash (hl.js put(), verbatim rule)
      if (zStart < 0 && !cls && /^\s+$/.test(s)) return;
      if (zStart < 0) zStart = start;
      zEnd = col;
    }
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
      const be = /** @type {RegExpMatchArray} */ (t.match(TEX_BE));
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
        st = envState(env);
        openWash(); // wash starts after the \begin{…}
      } else if (!st?.math && opens && TEX_VERB_ENV.test(env)) {
        // rest of the line + following lines are literal until \end{env}
        const rest = scanLineZones(line.slice(last), verbState(env));
        for (const [s, e] of rest.zones) zones.push([s + last, e + last]);
        return { zones, exit: rest.exit };
      }
      continue;
    }

    if (cmd != null) {
      if (!st?.math && /^\\verb\*?$/.test(t)) {
        // \verb<delim>literal<delim> — argument is literal; $ must not toggle
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
      if (!st?.math && t === '\\[') { st = TEX_M.bracket; openWash(); put('md', t); continue; }
      if (!st?.math && t === '\\(') { st = TEX_M.paren; openWash(); put('md', t); continue; }
      if (st?.math && t === st.close) { put('md', t); flush(); st = null; continue; }
      put(st?.math && t === '\\\\' ? 'wn' : 'kw', t);
      continue;
    }

    if (dollar != null) {
      if (st?.math && (st.close === '$' || st.close === '$$')) {
        put('md', t);
        flush();
        st = null;
      } else if (!st?.math) {
        st = t === '$$' ? TEX_M.display : TEX_M.inline;
        openWash();
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
  // an unclosed inline `$` must not wash the rest of the document — it dies
  // at the line break (display math and environments still carry)
  const exit = st === TEX_M.inline ? null : (st || null);
  flush();
  return { zones, exit };
}

/**
 * Scan a whole text → per-line `.mzone` wash column ranges, using hl.js's
 * '\n'-split line semantics (CR bytes stay inside their logical line).
 * @param {string} text
 * @returns {[number, number][][]} zones[lineIndex] = [[startCol, endCol], …]
 */
export function scanMathZones(text) {
  /** @type {[number, number][][]} */
  const out = [];
  /** @type {TexZoneState | null} */
  let st = TEX_ZONE_INITIAL;
  for (const line of String(text).split('\n')) {
    const { zones, exit } = scanLineZones(line, st);
    out.push(zones);
    st = exit;
  }
  return out;
}
