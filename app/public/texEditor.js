// texEditor.js — LaTeX smarts for the plain-textarea code editor: caret-popup
// completion (\cite bib keys · \ref labels · \begin environments · commands),
// auto-closing pairs, auto-\end on Enter, ⌘/ comment toggle, a § outline
// menu, and ⌘J forward SyncTeX. Self-contained: app.js hands in callbacks
// (requestMeta / forwardSearch / jumpToLine) and re-dispatches 'input' events
// keep drafts + the highlight overlay in sync — every programmatic edit here
// goes through setRangeText + a bubbling input event, same as typing.

'use strict';

// Phase 3 S0 scoped extraction (blueprint §14 A21): the pure completion
// vocabulary + context detectors, openEnvsIn, needsEnd and texOutline moved
// verbatim into latex/texCore.js — the one shared authority for both editor
// paths. This import (and the matching one in util.js) is S0's only sanctioned
// legacy diff; behavior here is byte-identical.
import {
  COMMON_ENVS, COMMON_COMMANDS, CITE_RE, REF_RE, ENV_RE, CMD_RE,
  openEnvsIn, needsEnd, texOutline,
} from './latex/texCore.js';

export const TEX_EXTS = ['tex', 'sty', 'cls', 'bib'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ─────────────────────────── caret pixel position ───────────────────────────
   The editor is strictly monospace (ui-monospace, letter-spacing 0), so
   column → x is one multiplication. Wide glyphs (α, ⌘) may drift a few px —
   the popup only needs to land near the caret. */

let charW = null;
function caretXY(ed) {
  // soft-wrapped editors (wrap="soft") install a wrap-aware measurer — the
  // grid math below would drift by one row per wrap above the caret
  if (typeof ed._caretXY === 'function') {
    try {
      const p = ed._caretXY();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* fall through to grid math */ }
  }
  const cs = getComputedStyle(ed);
  if (charW == null) {
    const canvas = caretXY._c || (caretXY._c = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    charW = ctx.measureText('0000000000').width / 10;
  }
  const upto = ed.value.slice(0, ed.selectionStart);
  const line = upto.split('\n').length - 1;
  const col = upto.length - (upto.lastIndexOf('\n') + 1);
  const lh = parseFloat(cs.lineHeight) || 19;
  return {
    x: parseFloat(cs.paddingLeft) + col * charW - ed.scrollLeft,
    y: parseFloat(cs.paddingTop) + (line + 1) * lh - ed.scrollTop,
  };
}

/* ─────────────────────────── attach ─────────────────────────── */

/**
 * Wire LaTeX behaviors onto a .tex/.sty/.cls/.bib editor textarea.
 * opts: { requestMeta() → Promise<{labels,cites,envs,commands}>,
 *         forwardSearch(line, col), jumpToLine(line) }
 * Register BEFORE the generic keydown handler — when the popup is open this
 * module owns Tab/Enter/arrows via stopImmediatePropagation.
 */
export function texEditorAttach(ed, opts = {}) {
  const wrap = ed.closest('.edWrap') || ed.parentElement;
  let pop = null;        // completion popup element
  let items = [];        // current completion items
  let sel = 0;           // highlighted index
  let replaceFrom = 0;   // buffer offset the accepted text replaces from
  let meta = null;       // last fetched texmeta
  let metaAt = 0;

  const isBib = /\.bib$/i.test(ed.dataset.rel || '');

  async function freshMeta() {
    if (meta && Date.now() - metaAt < 5000) return meta;
    try {
      meta = await opts.requestMeta?.() || meta || { labels: [], cites: [], envs: [], commands: [] };
      metaAt = Date.now();
    } catch { meta = meta || { labels: [], cites: [], envs: [], commands: [] }; }
    return meta;
  }

  function close() {
    pop?.remove();
    pop = null;
    items = [];
  }

  // openEnvsIn (unclosed environments above the caret) now lives in
  // latex/texCore.js — imported above, same behavior.

  /** Inspect the text before the caret → completion items (or null). */
  async function compute() {
    const upto = ed.value.slice(0, ed.selectionStart);
    let m;

    if (!isBib && (m = upto.match(CITE_RE))) {
      const prefix = m[1].split(',').pop().trim();
      const md = await freshMeta();
      replaceFrom = ed.selectionStart - prefix.length;
      return md.cites
        .filter((c) => c.key.toLowerCase().includes(prefix.toLowerCase()))
        .slice(0, 8)
        .map((c) => ({ kind: 'cite', label: c.key, detail: c.title || c.file, insert: closeBrace(c.key) }));
    }

    if (!isBib && (m = upto.match(REF_RE))) {
      const prefix = m[1];
      const md = await freshMeta();
      replaceFrom = ed.selectionStart - prefix.length;
      return md.labels
        .filter((l) => l.label.toLowerCase().includes(prefix.toLowerCase()))
        .slice(0, 8)
        .map((l) => ({ kind: 'ref', label: l.label, detail: `${l.file}:${l.line}`, insert: closeBrace(l.label) }));
    }

    if (!isBib && (m = upto.match(ENV_RE))) {
      const [, which, prefix] = m;
      const md = await freshMeta();
      replaceFrom = ed.selectionStart - prefix.length;
      const pool = which === 'end'
        ? [...new Set([...openEnvsIn(upto), ...COMMON_ENVS, ...md.envs])]
        : [...new Set([...md.envs, ...COMMON_ENVS])].sort();
      return pool
        .filter((e2) => e2.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, 8)
        .map((e2) => ({
          kind: 'env', label: e2,
          detail: which === 'begin' ? 'environment — inserts \\end too' : 'close environment',
          insert: which === 'begin' ? null : closeBrace(e2),
          env: which === 'begin' ? e2 : null,
        }));
    }

    if ((m = upto.match(CMD_RE))) {
      const prefix = m[1];
      if (prefix.length < 2) return null;
      const md = await freshMeta();
      const names = [...new Set([...Object.keys(COMMON_COMMANDS), ...md.commands])].sort();
      replaceFrom = ed.selectionStart - prefix.length;
      return names
        .filter((n) => n.startsWith(prefix) && n !== prefix)
        .slice(0, 8)
        .map((n) => ({
          kind: 'cmd', label: '\\' + n, detail: COMMON_COMMANDS[n] || '',
          insert: n + (COMMON_COMMANDS[n] || ''),
          caretBack: (COMMON_COMMANDS[n] || '').includes('{}')
            ? (COMMON_COMMANDS[n].length - COMMON_COMMANDS[n].indexOf('{}') - 1) : 0,
        }));
    }
    return null;
  }

  // completing inside `\ref{eq:eu|` → append the `}` only when it's missing
  function closeBrace(text) {
    return ed.value[ed.selectionStart] === '}' ? text : text + '}';
  }

  function paint() {
    if (!items.length) { close(); return; }
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'texCompl';
      wrap.appendChild(pop);
    }
    const { x, y } = caretXY(ed);
    pop.style.left = `${Math.max(4, Math.min(x, wrap.clientWidth - 300))}px`;
    pop.style.top = `${y + 3}px`;
    const icon = { cite: '❞', ref: '§', env: '⧉', cmd: '\\' };
    pop.innerHTML = items.map((it, i) => `
      <div class="tcItem ${i === sel ? 'on' : ''}" data-i="${i}">
        <span class="tcIcon tc-${it.kind}">${icon[it.kind]}</span>
        <span class="tcLabel">${esc(it.label)}</span>
        ${it.detail ? `<span class="tcDetail">${esc(it.detail)}</span>` : ''}
      </div>`).join('');
    pop.querySelectorAll('.tcItem').forEach((el2) => {
      el2.addEventListener('mousedown', (e) => { e.preventDefault(); accept(Number(el2.dataset.i)); });
    });
  }

  function accept(i) {
    const it = items[i];
    if (!it) { close(); return; }
    if (it.kind === 'env' && it.env) {
      // \begin{itemize| → close the brace, open a body line, add \end{itemize}.
      // Always EMIT the closing brace: when an auto-paired '}' already sits at
      // the caret, the replace range consumes it (selectionStart + 1), so the
      // emitted one takes its place — omitting it produced unclosed LaTeX.
      const lineStart = ed.value.lastIndexOf('\n', replaceFrom - 1) + 1;
      const indent = (ed.value.slice(lineStart).match(/^[ \t]*/) || [''])[0];
      const hasBrace = ed.value[ed.selectionStart] === '}';
      const text = `${it.env}}\n${indent}  \n${indent}\\end{${it.env}}`;
      ed.setRangeText(text, replaceFrom, ed.selectionStart + (hasBrace ? 1 : 0), 'end');
      const caret = replaceFrom + it.env.length + 2 + indent.length + 2; // middle line
      ed.setSelectionRange(caret, caret);
    } else {
      ed.setRangeText(it.insert, replaceFrom, ed.selectionStart, 'end');
      if (it.caretBack) {
        const p = ed.selectionStart - it.caretBack;
        ed.setSelectionRange(p, p);
      } else if (!it.insert.endsWith('}') && ed.value[ed.selectionStart] === '}') {
        // the auto-paired `}` was already there — hop over it
        ed.setSelectionRange(ed.selectionStart + 1, ed.selectionStart + 1);
      }
    }
    close();
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let computeSeq = 0;
  async function refresh() {
    const seq = ++computeSeq;
    const found = await compute();
    if (seq !== computeSeq) return; // superseded by a newer keystroke
    if (!found || !found.length) { close(); return; }
    items = found;
    sel = 0;
    paint();
  }

  ed.addEventListener('input', () => { refresh(); });
  ed.addEventListener('click', close);
  ed.addEventListener('blur', () => setTimeout(close, 120)); // let item mousedown land

  ed.addEventListener('keydown', (e) => {
    // popup navigation owns its keys ahead of the generic handlers
    if (pop && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        paint();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        accept(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
    }

    // ⌘/ — toggle % comments over the selection (or current line)
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      toggleComment(ed);
      return;
    }

    // ⌘J — forward SyncTeX from the caret
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      const upto = ed.value.slice(0, ed.selectionStart);
      const line = upto.split('\n').length;
      const col = upto.length - (upto.lastIndexOf('\n') + 1) + 1;
      opts.forwardSearch?.(line, col);
      return;
    }

    // Enter: right after an unclosed \begin{env} → auto-insert the matching
    // \end; otherwise auto-indent — the new line keeps this line's leading
    // whitespace (so text under \item lines up with \item) and goes one level
    // deeper when the caret leaves a net-unclosed \begin on the line.
    // ⇧Enter stays a plain unindented newline (the escape hatch).
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const s = ed.selectionStart;
      const en = ed.selectionEnd;
      const lineStart = ed.value.lastIndexOf('\n', s - 1) + 1;
      const before = ed.value.slice(lineStart, s);
      const indent = (before.match(/^[ \t]*/) || [''])[0];
      if (s === en && !isBib) {
        const m = before.match(/\\begin\{([A-Za-z*]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/);
        if (m && needsEnd(ed.value, m[1])) {
          e.preventDefault();
          ed.setRangeText(`\n${indent}  \n${indent}\\end{${m[1]}}`, s, s, 'end');
          const caret = s + 1 + indent.length + 2;
          ed.setSelectionRange(caret, caret);
          ed.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      const opens = (before.match(/\\begin\{/g) || []).length;
      const closes = (before.match(/\\end\{/g) || []).length;
      const deeper = !isBib && opens > closes ? '  ' : '';
      if (indent || deeper) {
        e.preventDefault();
        const text = '\n' + indent + deeper;
        // execCommand keeps native ⌘Z granularity; fall back if it's gone
        if (!document.execCommand || !document.execCommand('insertText', false, text)) {
          ed.setRangeText(text, s, en, 'end');
          ed.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
    }

    // auto-closing pairs (+ wrap selection, overtype closers, pair backspace)
    const PAIRS = { '{': '}', '[': ']', '(': ')', $: '$' };
    if (PAIRS[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = ed.selectionStart;
      const en = ed.selectionEnd;
      if (s !== en) { // wrap the selection
        e.preventDefault();
        ed.setRangeText(e.key + ed.value.slice(s, en) + PAIRS[e.key], s, en, 'select');
        ed.setSelectionRange(s + 1, en + 1);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (e.key === '$' && ed.value[s] === '$') { // overtype the auto $
        e.preventDefault();
        ed.setSelectionRange(s + 1, s + 1);
        return;
      }
      if (e.key !== '$' || !isBib) {
        e.preventDefault();
        ed.setRangeText(e.key + PAIRS[e.key], s, s, 'end');
        ed.setSelectionRange(s + 1, s + 1);
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    if ((e.key === '}' || e.key === ']' || e.key === ')') && ed.selectionStart === ed.selectionEnd
      && ed.value[ed.selectionStart] === e.key && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); // overtype an auto-inserted closer
      ed.setSelectionRange(ed.selectionStart + 1, ed.selectionStart + 1);
      return;
    }
    if (e.key === 'Backspace' && ed.selectionStart === ed.selectionEnd
      && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = ed.selectionStart;
      const two = ed.value.slice(s - 1, s + 1);
      if (['{}', '[]', '()', '$$'].includes(two)) {
        e.preventDefault();
        ed.setRangeText('', s - 1, s + 1, 'end');
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      // dedent: with the caret in a line's leading whitespace, step back one
      // indentation level (the previous 2-space stop) — from \item depth to
      // the enclosing \begin's depth in one press — instead of space-by-space
      const lineStart = ed.value.lastIndexOf('\n', s - 1) + 1;
      const before = ed.value.slice(lineStart, s);
      if (before.length && /^ +$/.test(before)) {
        e.preventDefault();
        const remove = before.length % 2 === 0 ? 2 : 1;
        ed.setSelectionRange(s - remove, s);
        // execCommand keeps native ⌘Z granularity; fall back if it's gone
        if (!document.execCommand || !document.execCommand('delete')) {
          ed.setRangeText('', s - remove, s, 'end');
          ed.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
  });

  return { close, refreshMeta: () => { metaAt = 0; } };
}

// needsEnd moved to latex/texCore.js (S0 scoped extraction) — imported above.

export function toggleComment(ed) {
  const s = ed.selectionStart;
  const en = ed.selectionEnd;
  const ls = ed.value.lastIndexOf('\n', s - 1) + 1;
  let le = ed.value.indexOf('\n', Math.max(en - 1, s));
  if (le < 0) le = ed.value.length;
  const block = ed.value.slice(ls, le);
  const lines = block.split('\n');
  const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*%/.test(l));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    return allCommented ? l.replace(/^(\s*)%\s?/, '$1') : l.replace(/^(\s*)/, '$1% ');
  }).join('\n');
  ed.setRangeText(out, ls, le, 'select');
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ─────────────────────────── outline ─────────────────────────── */

/* texOutline moved to latex/texCore.js (S0 scoped extraction) — re-exported
   here so the module's public surface is unchanged. */
export { texOutline };

/** Open the § outline dropdown anchored to `btn`; jumpToLine on pick. */
export function texOutlineMenu(btn, ed, jumpToLine) {
  document.getElementById('texOutlineMenu')?.remove();
  const entries = texOutline(ed.value);
  const menu = document.createElement('div');
  menu.id = 'texOutlineMenu';
  menu.innerHTML = entries.length
    ? entries.map((s) => `<div class="pmItem" data-ln="${s.line}" style="padding-left:${13 + s.depth * 14}px">${esc(s.title)}</div>`).join('')
    : '<div class="pmItem" style="cursor:default">no \\section headings yet</div>';
  btn.parentElement.appendChild(menu);
  menu.querySelectorAll('.pmItem[data-ln]').forEach((it) => it.addEventListener('click', () => {
    jumpToLine(Number(it.dataset.ln));
  }));
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

/* ─────────────────────── overlay line decorations ─────────────────────── */

/** Flash a line in the highlight overlay after a jump (inverse sync / problems). */
export function texJumpFlash(codeEl, line) {
  const ln = codeEl?.children?.[line - 1];
  if (!ln) return;
  ln.classList.remove('lnFlash'); // restart the animation if re-flashed
  void ln.offsetWidth;
  ln.classList.add('lnFlash');
  setTimeout(() => ln.classList.remove('lnFlash'), 1900);
}

/** Tint overlay lines that carry compile problems for this file. Re-applied
 *  after every overlay repaint (paintHL rebuilds line spans). */
export function texMarkLines(codeEl, problems, rel) {
  if (!codeEl) return;
  for (const el of codeEl.querySelectorAll('.lnErr, .lnWarn')) {
    el.classList.remove('lnErr', 'lnWarn');
  }
  for (const p of problems || []) {
    if (p.file !== rel || !p.line || p.kind === 'badbox') continue;
    const ln = codeEl.children[p.line - 1];
    if (ln) ln.classList.add(p.kind === 'error' ? 'lnErr' : 'lnWarn');
  }
}
