// console.js — the console rendering pipeline, split verbatim out of app.js
// (phase 2): markdown+KaTeX engines, tex-macro harvest, fence enhancer,
// segment parser, updateConsole + reveal pump, permission cards, transcript
// seeding, running activity.

import { enc, esc, pinKindOf, isExtRel, toast, diffHtml } from './util.js';
import {
  state, tailBufs, agentsLive, editsLive, jobsLive, pendingPerms, queuedMsgs,
  transcripts, fileCache,
  perOf, relOf, isExternalPin, artifactUrl, agentName, taskProvider,
} from './store.js';
import { pausedQueues } from './undoSend.js';
import { api } from './net.js';
import { ensureFile } from './files.js';
import { syncJobCards, syncJobFeed, jobsEnded } from './jobs.js';
import { getAddedViewers, showProposalInPanel } from './viewers.js';
import { renderWB } from './workbench.js';
import { runActivityHtml, syncRunActivities } from './runActivity.js';

/* ── console rendering: markdown + LaTeX, web-claude style ──
   The stream buffer is parsed into typed segments (you / thinking / answer /
   tool / result / meta). Earlier segments are immutable, so updates only
   re-render the LAST segment — that's what makes streaming text smooth. */

/**
 * Markdown → sanitized HTML through the app pipeline (marked + DOMPurify +
 * math stash); plain-escaped fallback when the CDN scripts are absent.
 * @param {string} text
 * @param {{ chat?: boolean }} [opts] chat = console engine (raw HTML shown literally)
 * @returns {string}
 */
export function md(text, { chat = false } = {}) {
  // protect math from the markdown parser ($x_t$ underscores etc.), then
  // parse, sanitize, and restore the math for KaTeX to typeset
  const stash = [];
  // private-use-area sentinels — effectively impossible in real prose, unlike
  // a literal '@@MATH0@@' which Claude could legitimately write
  const SL = '', SR = '';
  const protectedText = String(text).replace(
    /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^\n$]+\$)/g,
    (m) => { stash.push(m); return `${SL}${stash.length - 1}${SR}`; });
  let html = null;
  try {
    if (window.marked && window.DOMPurify) {
      // FORBID style: DOMPurify's default allows <style> elements and style
      // attributes, and md() output lands in the TOP-LEVEL document (console
      // + rendered-markdown pane) — a viewed .md could otherwise restyle or
      // overlay the whole dashboard. KaTeX is unaffected: katexEl() typesets
      // into the DOM after sanitization.
      html = DOMPurify.sanitize(mdEngine(chat).parse(protectedText, { breaks: true, mangle: false, headerIds: false }),
        { FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] });
    }
  } catch { /* fall back to plain */ }
  if (html == null) html = esc(protectedText).replace(/\n/g, '<br>');
  return html.replace(new RegExp(`${SL}(\\d+)${SR}`, 'g'), (_, i) => esc(stash[+i] ?? ''));
}

/* Two configured marked instances, built lazily (the CDN script loads
   deferred, so they can't exist at eval time). Both replace marked's GFM
   `del` tokenizer: upstream pairs SINGLE tildes into strikethrough, and
   Claude's prose uses ~ for "approximately" — one unlucky pair per paragraph
   ("(~97–98%) … ≤~2018", or "(~2.8GB) … \"~2.8 GB\"" 2,800 chars later in a
   handoff packet) struck out everything between them and split any **bold**
   spanning the boundary. Strikethrough now requires ~~ on both sides.
   The chat engine (console segments) additionally drops raw-HTML parsing:
   console text is conversation, not a document, so "data/<format>/<entity>/…"
   shows literally instead of losing its placeholders to the sanitizer. The
   .md viewer keeps real HTML (GitHub-style).
   See docs/console-tilde-strikethrough-diagnosis.txt. */
let mdEngines = null;
function mdEngine(chat) {
  if (!mdEngines) {
    /** @this {{ lexer: { inlineTokens(src: string): any[] } }} */
    function del(src) {
      const m = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?=[^~]|$)/.exec(src);
      // null (not false — false would fall back to marked's built-in rule)
      return m && { type: 'del', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    }
    const doc = new marked.Marked();
    doc.use({ tokenizer: { del } });
    const conv = new marked.Marked();
    conv.use({ tokenizer: { del, html: () => null, tag: () => null } });
    mdEngines = { doc, conv };
  }
  return chat ? mdEngines.conv : mdEngines.doc;
}

/**
 * Typeset $…$/$$…$$ inside an element with KaTeX auto-render (no-op without
 * the CDN script; deliberately skips <pre>/<code>).
 * @param {Element} el
 * @param {{ [name: string]: string } | null} [macros] harvested \newcommand dialect
 * @returns {void}
 */
export function katexEl(el, macros) {
  try {
    if (window.renderMathInElement) {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        // KaTeX mutates the macros object on \def/\gdef — hand it a copy
        macros: macros ? { ...macros } : undefined,
        ignoredTags: ['pre', 'code', 'script', 'style', 'textarea'],
      });
    }
  } catch { /* partial math mid-stream — renders once complete */ }
}

/* ── raw|formatted LaTeX fences (design: docs/fence-toggle-mockup.html, A) ──
   katexEl deliberately skips <pre>/<code>, so a fenced LaTeX block shows as
   source. Eligible (tex-ish) fences get a header strip — lang label, a
   raw|formatted pill, ⧉ copy-source — and "formatted" re-renders the fence
   text through the SAME pipeline as answer prose (md chat engine → KaTeX with
   the paper's macro dialect), after a light structural pass for what KaTeX
   can't do (equation/align envs, lists, the lemma family, proof, \emph,
   \cite, \label chips). A reading aid, NOT a compiler — the pdf pane stays ground
   truth. Default raw; the choice is stored per fence-content hash in
   fenceView (NEVER on the DOM node — segments rebuild on macro-harvest bumps,
   re-segmentation, and renderWB, and the enhancer re-applies from the store). */
const fenceView = {}; // `${project}/${taskId}` → Map(srcHash → true when formatted)
function fenceHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function texishFence(code) {
  const lang = ([...code.classList].find(c => c.startsWith('language-')) || '').slice(9);
  if (/^(tex|latex)$/i.test(lang)) return lang.toLowerCase();
  if (lang) return null; // an explicitly-tagged other language is never tex
  const t = code.textContent;
  let hits = 0;
  if ((t.match(/\$[^\n$]+\$/g) || []).length >= 2) hits++;
  if (/\\begin\{/.test(t)) hits++;
  if (/\\\[|\\\(/.test(t)) hits++;
  return hits >= 2 ? 'tex' : null;
}

/* LaTeX list indentation is meaningful to TeX but four leading spaces start a
   Markdown code block. Convert the small list dialect emitted in answers into
   real Markdown lists before md() sees it. A stack (rather than a regexp over
   whole environments) keeps nested enumerate/itemize pairs well-defined. */
const TEX_EXPLICIT_LIST = '\uE102tex-explicit-list\uE103';
const TEX_FORMATTED_ENVS = new Set([
  'enumerate', 'itemize', 'equation', 'align', 'gather', 'lemma', 'theorem',
  'proposition', 'corollary', 'remark', 'definition', 'proof',
  // These only occur inside math delimiters; KaTeX handles them directly.
  'aligned', 'alignedat', 'gathered', 'split', 'cases', 'matrix', 'pmatrix',
  'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'array', 'smallmatrix',
]);
function romanNumeral(n) {
  /** @type {Array<[number, string]>} */
  const table = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [value, glyph] of table) {
    while (n >= value) { out += glyph; n -= value; }
  }
  return out;
}
function alphaNumeral(n) {
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}
function enumerateLabeler(options) {
  const raw = /(?:^|,)\s*label\s*=\s*([^,]+)/.exec(options || '')?.[1]?.trim();
  if (!raw) return null;
  const token = /\\(alph|Alph|arabic|roman|Roman)(?:\*|\{[^}]*\})/.exec(raw);
  if (!token) return null;
  return (i) => {
    let value;
    if (token[1] === 'arabic') value = String(i);
    else if (token[1] === 'roman' || token[1] === 'Roman') value = romanNumeral(i);
    else value = alphaNumeral(i);
    if (token[1] === 'Alph' || token[1] === 'Roman') value = value.toUpperCase();
    return raw.replace(token[0], value);
  };
}
function balancedTexLists(lines) {
  const stack = [];
  for (const line of lines) {
    const t = line.trimStart();
    const begin = /^\\begin\{(enumerate|itemize)\}(?:\[[^\]]*\])?\s*(?:%.*)?$/.exec(t);
    if (begin) { stack.push(begin[1]); continue; }
    const end = /^\\end\{(enumerate|itemize)\}\s*(?:%.*)?$/.exec(t);
    if (end && stack.pop() !== end[1]) return false;
  }
  return stack.length === 0;
}
function texListsMarkdown(src) {
  const lines = src.split('\n');
  if (!balancedTexLists(lines)) return src;
  const out = [];
  const stack = [];
  for (const line of lines) {
    const t = line.trimStart();
    const begin = /^\\begin\{(enumerate|itemize)\}(?:\[([^\]]*)\])?\s*(?:%.*)?$/.exec(t);
    if (begin) {
      const labeler = begin[1] === 'enumerate' ? enumerateLabeler(begin[2]) : null;
      out.push('');
      if (labeler) out.push(`${' '.repeat(stack.length * 3)}${TEX_EXPLICIT_LIST}`);
      out.push('');
      stack.push({ env: begin[1], labeler, item: 0 });
      continue;
    }
    const end = /^\\end\{(enumerate|itemize)\}\s*(?:%.*)?$/.exec(t);
    if (end && stack.at(-1)?.env === end[1]) {
      stack.pop();
      out.push('');
      continue;
    }
    const item = stack.length
      ? /^\\item(?![A-Za-z@])(?:\[([^\]]*)\])?\s*(.*)$/.exec(t)
      : null;
    if (item) {
      const frame = stack.at(-1);
      frame.item++;
      const marker = frame.env === 'enumerate' ? '1.' : '-';
      const label = item[1] ? `[${item[1]}]` : frame.labeler?.(frame.item);
      const body = [label, item[2]].filter(Boolean).join(' ');
      out.push(`${' '.repeat((stack.length - 1) * 3)}${marker}${body ? ` ${body}` : ''}`);
      continue;
    }
    // Continuations receive indentation owned by the generated Markdown list,
    // never the source's cosmetic TeX indentation (the original bug trigger).
    if (stack.length && t) out.push(`${' '.repeat(stack.length * 3)}${t}`);
    else out.push(t ? line : '');
  }
  return out.join('\n');
}

// If an environment is outside the supported structural subset, keep it
// visibly literal but remove TeX's cosmetic indentation while inside it. This
// prevents a blank line + four spaces from swallowing the remaining preview.
function defuseUnsupportedTexIndent(src) {
  const stack = [];
  return src.split('\n').map((line) => {
    const t = line.trimStart();
    const begin = /^\\begin\{([^}]+)\}/.exec(t);
    const end = /^\\end\{([^}]+)\}/.exec(t);
    const active = stack.length > 0;
    const env = begin?.[1].replace(/\*$/, '');
    if (begin && !TEX_FORMATTED_ENVS.has(env)) stack.push(begin[1]);
    const result = (active || (begin && !TEX_FORMATTED_ENVS.has(env)) || /^\\item\b/.test(t)) ? t : line;
    if (end && stack.at(-1) === end[1]) stack.pop();
    return result;
  }).join('\n');
}

function unsupportedTexEnvironments(src) {
  const envs = new Set();
  for (const match of src.matchAll(/\\begin\{([^}]+)\}/g)) {
    const env = match[1].replace(/\*$/, '');
    if (!TEX_FORMATTED_ENVS.has(env)) envs.add(env);
  }
  return [...envs];
}

function decorateTexLists(root) {
  root.querySelectorAll('p').forEach((p) => {
    if (p.textContent.trim() !== TEX_EXPLICIT_LIST) return;
    if (p.nextElementSibling?.tagName === 'OL') p.nextElementSibling.classList.add('texListExplicit');
    p.remove();
  });
}
// structural pre-pass: LaTeX → markdown+math the chat pipeline can render
function texFenceMarkdown(src) {
  let t = texListsMarkdown(defuseUnsupportedTexIndent(src));
  // display environments → $$…$$ (align family via aligned); \label → chip
  t = t.replace(/\\begin\{(equation|align|gather)\*?\}([\s\S]*?)\\end\{\1\*?\}/g, (m, env, body) => {
    let label = '';
    body = body.replace(/\\label\{([^}]*)\}/g, (_, l) => { label = l; return ''; }).trim();
    const math = env === 'equation' ? body : `\\begin{aligned}${body}\\end{aligned}`;
    return `\n$$${math}$$${label ? ` \`(${label})\`` : ''}\n`;
  });
  t = t.replace(/\\begin\{(lemma|theorem|proposition|corollary|remark|definition)\}(\[[^\]]*\])?/g,
    (_, env, ttl) => `\n**${env[0].toUpperCase() + env.slice(1)}**${ttl ? ` *(${ttl.slice(1, -1)})*` : ''}**.** `);
  t = t.replace(/\\end\{(lemma|theorem|proposition|corollary|remark|definition)\}/g, '\n');
  t = t.replace(/\\begin\{proof\}/g, '\n**Proof.** ').replace(/\\end\{proof\}/g, ' ∎\n');
  t = t.replace(/\\emph\{([^}]*)\}/g, '*$1*');
  t = t.replace(/\\textbf\{([^}]*)\}/g, '**$1**').replace(/\\textit\{([^}]*)\}/g, '*$1*');
  t = t.replace(/\\cite[tp]?\{([^}]*)\}/g, '`[$1]`');
  t = t.replace(/\\label\{([^}]*)\}/g, '`($1)`'); // stragglers outside the envs above
  return t;
}
function enhanceTexFences(segEl, project, taskId, macros) {
  const vk = `${project}/${taskId}`;
  const store = fenceView[vk] || (fenceView[vk] = new Map());
  segEl.querySelectorAll('.csMd pre > code').forEach((code) => {
    if (code.closest('.fenceBox')) return; // idempotent across pumps
    const lang = texishFence(code);
    if (!lang) return;
    const pre = code.parentElement;
    const src = code.textContent.replace(/\n$/, '');
    const h = fenceHash(src);
    const box = document.createElement('div');
    box.className = 'fenceBox';
    const head = document.createElement('div');
    head.className = 'fenceHead';
    head.innerHTML = `<span class="fenceLang">${esc(lang)}</span>`
      + '<span class="fenceSeg"><span data-v="raw">raw</span><span data-v="fmt">formatted</span></span>'
      + '<span class="fenceCopy" title="copy the LaTeX source">⧉</span>';
    pre.replaceWith(box);
    box.append(head, pre);
    const apply = (fmt) => {
      if (fmt && !box.querySelector(':scope > .fenceFmt')) {
        const f = document.createElement('div');
        f.className = 'fenceFmt csMd';
        f.innerHTML = md(texFenceMarkdown(src), { chat: true });
        decorateTexLists(f);
        const unsupported = unsupportedTexEnvironments(src);
        if (unsupported.length) {
          const note = document.createElement('div');
          note.className = 'fencePartial';
          note.textContent = `partially formatted · ${unsupported.join(', ')} left literal`;
          f.prepend(note);
        }
        katexEl(f, macros);
        box.appendChild(f);
      }
      box.classList.toggle('fmt', fmt);
      head.querySelectorAll('.fenceSeg span').forEach(s =>
        s.classList.toggle('on', (s.dataset.v === 'fmt') === fmt));
    };
    head.querySelector('.fenceSeg').addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (!v) return;
      const fmt = v === 'fmt';
      if (fmt) store.set(h, true); else store.delete(h);
      if (store.size > 50) store.delete(store.keys().next().value); // cap per task
      apply(fmt);
    });
    head.querySelector('.fenceCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(src); toast('LaTeX source copied'); }
      catch { toast('⚠ copy failed'); }
    });
    apply(store.get(h) === true);
  });
}

/* ── the paper's math dialect ──
   Claude's console math speaks the pinned paper's shorthand ($\E$, $\ah$,
   $\Hs$ …) — natural, the session lives inside that .tex. KaTeX only knows
   standard LaTeX, and with throwOnError:false it paints any unknown control
   sequence red (errorColor) — the "phantom red letters"
   (docs/console-red-math-diagnosis.txt). Fix: harvest \newcommand-style
   definitions from each task's pinned .tex files into KaTeX's `macros`.
   texMacroRev bumps whenever a harvest changes; updateConsole/syncMdPane
   stamp what they typeset with (el._mac) and re-typeset on mismatch — that
   covers pins whose async fetch lands AFTER the console first painted
   (ensureFile's renderWB re-enters them). */
const texMacroCache = {}; // `${project}::${rel}` → { src, macros }
/** @type {number} */
export let texMacroRev = 1;

function parseTexMacros(tex) {
  const out = {};
  // strip % comments (keeping \%) so commented-out definitions can't win
  const src = String(tex).replace(/(^|[^\\])%[^\n]*/g, '$1');
  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*(?:\{\s*\\([A-Za-z@]+|[^A-Za-z@\s\\{}])\s*\}|\\([A-Za-z@]+|[^A-Za-z@\s\\{}]))/g;
  for (let m; (m = re.exec(src));) {
    const [, kind, star] = m;
    const name = m[3] ?? m[4];
    let i = re.lastIndex;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    ws();
    let optDefault = false;
    if (src[i] === '[') { // [nargs] — KaTeX infers arity from #n, drop it
      const c = src.indexOf(']', i); if (c === -1) continue; i = c + 1; ws();
      if (src[i] === '[') { // [default] — optional-arg macros aren't expressible
        const c2 = src.indexOf(']', i); if (c2 === -1) continue; i = c2 + 1; ws();
        optDefault = true;
      }
    }
    if (src[i] !== '{') continue;
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    if (depth !== 0) break; // unbalanced to EOF — nothing more to harvest
    re.lastIndex = j + 1;   // resume AFTER the body — never scan inside it
    if (optDefault) continue;
    let body = src.slice(i + 1, j);
    if (body.length > 500) continue; // math shorthand, not a tikz library
    if (kind === 'DeclareMathOperator') body = `\\operatorname${star}{${body}}`;
    body = body
      .replace(/\\mathbbm\b/g, '\\mathbb')  // bbm package — not in KaTeX
      .replace(/\\bm\b/g, '\\boldsymbol')   // bm package
      .replace(/\\ensuremath\b/g, '');      // no-op in math mode
    if (kind === 'providecommand' && ('\\' + name) in out) continue;
    out['\\' + name] = body;
  }
  return out;
}

window.__parseTexMacros = parseTexMacros; // test hook (module scope hides it)

/* harvest ONE project .tex into texMacroCache: parse when its content is
   cached (bumping texMacroRev on change so stamped segments re-typeset),
   fetch it when never seen — the arrival renderWB re-typesets. A missing
   file caches an error entry, so a wrong sibling guess costs one 404 ever. */
function harvestTex(project, rel) {
  if (!/\.tex$/i.test(rel || '')) return;
  const fk = `${project}::${rel}`;
  const c = fileCache[fk];
  if (!c) { ensureFile(project, rel); return; }
  if (c.loading || c.error || c.binary || !c.text) return;
  const h = texMacroCache[fk];
  if (!h || h.src !== c.text) {
    texMacroCache[fk] = { src: c.text, macros: parseTexMacros(c.text) };
    texMacroRev++;
  }
}

function texMacrosFor(project, task) {
  const pins = task && Array.isArray(task.context?.files) ? task.context.files : [];
  const out = {};
  for (const f of pins) {
    const rel = String(f || '');
    if (!/\.tex$/i.test(rel)) continue;
    harvestTex(project, rel);
    const h = texMacroCache[`${project}::${rel}`];
    if (h) Object.assign(out, h.macros);
  }
  return out;
}

/* v2.12: the dialect often lives in files the task never pinned — the
   session reads the paper itself with tools and answers in its macros.
   Widen the harvest to every source the dashboard can see: the tex SIBLING
   of each pinned/open pdf (the same pdf→tex mapping the toolbar ▶ uses),
   the live watch's tex, and any project .tex already fetched for other
   reasons (tabs, Δ views). External pdf pins are skipped — a sibling guess
   outside the pin grant would only 403. */
function harvestTexAround(project, task) {
  const pins = task && Array.isArray(task.context?.files) ? task.context.files : [];
  for (const f of pins) {
    const rel = String(f || '');
    if (/\.pdf$/i.test(rel) && !isExtRel(rel)) harvestTex(project, rel.replace(/\.pdf$/i, '.tex'));
  }
  for (const v of getAddedViewers(project)) {
    if (v && typeof v.rel === 'string' && /\.pdf$/i.test(v.rel) && !isExtRel(v.rel)) {
      harvestTex(project, v.rel.replace(/\.pdf$/i, '.tex'));
    }
  }
  const w = state.pdf?.[project];
  if (w?.tex) {
    const r = relOf(project, w.tex);
    if (r) harvestTex(project, r);
  }
  for (const fk in fileCache) {
    if (fk.startsWith(`${project}::`) && /\.tex$/i.test(fk)) {
      harvestTex(project, fk.slice(project.length + 2));
    }
  }
}

/* everything harvested for a project so far */
function texMacrosHarvested(project) {
  const out = {};
  for (const fk in texMacroCache) {
    if (fk.startsWith(`${project}::`)) Object.assign(out, texMacroCache[fk].macros);
  }
  return out;
}

/* the paper dialect a renderer should use: widen the sources, then union —
   project-wide harvest first, the task's own pinned tex last so explicit
   pins win any conflict. Callers read texMacroRev AFTER this (it may bump). */
/**
 * Every KaTeX macro visible to the task's console/md panes (project-wide
 * harvest + pinned-tex dialect; explicit pins win conflicts).
 * @param {string} project
 * @param {Task | null | undefined} task
 * @returns {{ [name: string]: string }}
 */
export function texMacrosVisible(project, task) {
  harvestTexAround(project, task);
  return Object.assign(texMacrosHarvested(project), texMacrosFor(project, task));
}

/**
 * Split the accumulated session stream into typed console segments.
 * @param {string} buf tailBufs text
 * @returns {{ type: string, text: string }[]} segment types: you/ans/ques/tool/think/meta/agent/…
 */
export function parseConsole(buf) {
  const segs = [];
  let cur = null;
  let inFence = false; // blank lines inside ``` blocks are kept as content
  const start = (type) => { cur = { type, text: '' }; segs.push(cur); };
  const solo = (type, text) => { segs.push({ type, text }); cur = null; };
  const content = (line) => {
    if (!cur) { if (!line.trim() && !inFence) return; start('ans'); }
    cur.text += (cur.text ? '\n' : '') + line;
  };
  // Framing markers are SERVER-injected delimiters between distinct chunks of
  // the stream — a real code fence never legitimately spans one. They
  // therefore ESCAPE an open fence (reset inFence and parse normally). This
  // is the fix for the console-formatting dropout: an UNCLOSED ``` in a
  // streaming answer/thinking block used to swallow every later marker into
  // one giant trailing segment, which the live tail renders as raw escaped
  // text — the whole console below the fence opener "lost its formatting"
  // until the closing fence streamed in (or forever, if the turn ended with
  // an odd fence count). See docs/console-formatting-bug-diagnosis.txt.
  // Tradeoff (accepted there): a marker-shaped line QUOTED inside a fenced
  // block now mis-splits it — rare, cosmetic, and far cheaper than the whole
  // console going raw.
  const marker = (line) => {
    if (/^▸ you ─+$/.test(line)) return () => start('you');
    // History seeding uses the selected provider's display name (for example
    // "claude" or "codex"). `you` is handled above; every other generated
    // speaker boundary starts an assistant answer.
    if (/^▸ [^\n]+ ─+$/.test(line)) return () => start('ans');
    if (line === '∴ thinking…') return () => start('think');
    if (line === '— answer —') return () => start('ans');
    if (line.startsWith('⟐ ')) return () => solo('meta', line.slice(2));
    if (/^◆ agent /.test(line)) return () => solo('agent', line);
    if (/^(?:↳\d*)? ?\[tool: /.test(line)) return () => solo('tool', line);
    if (/^(?:↳\d*)? ?\[(result|✗ error)\] /.test(line)) {
      return () => solo(line.includes('[✗ error]') ? 'err' : 'res',
        line.replace(/^(?:↳\d*)? ?\[(result|✗ error)\] /, ''));
    }
    if (line.startsWith('⏳ approval')) return () => solo('appr', line);
    if (/^— turn /.test(line)) return () => solo('turn', line.replace(/^— /, '').replace(/ —$/, ''));
    return null;
  };
  for (const line of String(buf).split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; content(line); continue; }
    const m = marker(line);
    if (m) { inFence = false; m(); continue; }
    // Claude's protocol question ("end your message with a line starting
    // QUESTION:") gets its own segment so the console lights it up like the
    // session pane does — everything from the QUESTION line to the next
    // marker is the question block. Only in Claude's answer flow: never
    // inside the user's packet echo (which QUOTES the protocol) or a fence.
    if (!inFence && (!cur || cur.type === 'ans' || cur.type === 'ques') && QUES_RE.test(line)) {
      start('ques');
      const rest = line.replace(QUES_RE, '');
      if (rest.trim()) cur.text = rest;
      continue;
    }
    content(line);
  }
  return segs.filter(s => s.text.trim() !== '' || s.type === 'turn');
}

// the canonical form is `QUESTION: …` (what the server's status parser
// recognizes), but Claude dresses it up often enough — bold, a heading, the
// colon inside or outside the bold — that the console matches those too
const QUES_RE = /^(?:#{1,4}\s+)?(?:\*\*|__)?QUESTION(?::\s*(?:\*\*|__)?|(?:\*\*|__):)\s*/;

function consoleSegHtml(s) {
  switch (s.type) {
    case 'you': return `<div class="csTag csYou">you</div><div class="csMd">${md(s.text, { chat: true })}</div>`;
    case 'think': return `<div class="csTag">∴ thinking</div><div class="csMd csThink">${md(s.text, { chat: true })}</div>`;
    case 'ques': return `<div class="csTag csQues">✳ question — needs you</div><div class="csMd">${md(s.text, { chat: true })}</div>`;
    case 'ans': return `<div class="csMd">${md(s.text, { chat: true })}</div>`;
    case 'tool': return esc(s.text);
    case 'agent': return esc(s.text);
    case 'res': return `<span class="csResTag">↩</span> ${esc(s.text)}`;
    case 'err': return `<span class="csErrTag">✗</span> ${esc(s.text)}`;
    case 'appr': return esc(s.text);
    case 'meta': return `⟐ ${esc(s.text)}`;
    case 'turn': return esc(s.text);
    default: return esc(s.text);
  }
}

/* the actively-streaming segment, rendered as PLAIN escaped text — no markdown,
   no KaTeX. pre-wrap CSS (.csRaw) preserves newlines, so growth is append-only
   and nothing above it reflows or re-typesets. It settles into consoleSegHtml()
   the instant it's no longer the tail (a new segment starts) or the turn ends. */
function consoleSegRaw(s) {
  const tag = s.type === 'think' ? '<div class="csTag">∴ thinking</div>'
    : s.type === 'ques' ? '<div class="csTag csQues">✳ question — needs you</div>' : '';
  const cls = s.type === 'think' ? 'csMd csThink csRaw' : 'csMd csRaw';
  return `${tag}<div class="${cls}">${esc(s.text)}</div>`;
}

/* Show paths relative to the project root (external pins by their folder name)
   in the console stream — the absolute /Users/…/ prefix repeated on every tool
   line, bash command, and result is pure noise. Only KNOWN roots are stripped,
   so real content is never mangled. */
/**
 * Shorten absolute project paths in stream text to root-relative ones.
 * @param {string} text
 * @param {string} project
 * @param {string} [taskId]
 * @returns {string}
 */
export function relativizePaths(text, project, taskId) {
  if (!text) return text;
  const subs = [];
  const task = (state.tasks[project] || []).find(x => x && x.id === taskId);
  const files = task && Array.isArray(task.context?.files) ? task.context.files : [];
  for (const f of files) {
    if (!isExternalPin(project, f)) continue;
    const raw = String(f).replace(/\/+$/, '');
    // folder pin → the folder; file pin → its parent dir. Strip to the folder's
    // own name so you still see which external area a path belongs to.
    const dir = pinKindOf(f) === 'folder' ? raw : raw.slice(0, raw.lastIndexOf('/'));
    if (dir) subs.push([dir, dir.slice(dir.lastIndexOf('/') + 1)]);
  }
  const root = String(state.projects[project]?.root || '').replace(/\/+$/, '');
  if (root) subs.push([root, '']); // project root → project-relative
  subs.sort((a, b) => b[0].length - a[0].length); // longest prefix first
  for (const [from, to] of subs) {
    const e = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(e + '/', 'g'), to ? to + '/' : ''); // <from>/x → <to>/x
    text = text.replace(new RegExp(e + `(?=[\\s"')\\]:,]|$)`, 'g'), to || '.'); // bare <from>
  }
  return text;
}

/**
 * Render the console box's segments up to a reveal cursor (patches settled
 * segments in place; the pump advances `upto`).
 * @param {Element} box #consoleBox
 * @param {string} k `${project}/${id}`
 * @param {number} [upto] characters of tailBufs[k] to reveal (default: all)
 * @returns {void}
 */
export function updateConsole(box, k, upto) {
  // follow-the-stream is an explicit intent bit (box._follow), maintained by
  // the user-scroll listener in wireWB. Height-based "near the bottom" guesses
  // fail when the scrollback is shorter than the threshold: every position —
  // including the top — measures as near-bottom, and streaming drags a reader
  // who scrolled up to re-read.
  const stick = box._follow !== false;
  const [project, taskId] = k.split('/');
  const raw = tailBufs[k] || '';
  if (upto == null) upto = raw.length;
  let wrap = box.querySelector(':scope > .csegWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'csegWrap';
    box.appendChild(wrap);
  }
  // slice in RAW coords (keeps the stream-reveal offsets aligned), THEN
  // relativize just the visible portion before parsing
  const segs = parseConsole(relativizePaths(raw.slice(0, upto), project, taskId));
  // the tail renders raw only while the turn is live; once it stops running the
  // last segment settles into formatted markdown + KaTeX (one paint). Opening a
  // finished task's console has running=false, so it's fully formatted at once.
  const t = (state.tasks[project] || []).find(x => x && x.id === taskId);
  const running = !!(t && t.status === 'running');
  // the paper's math dialect — pins, pdf-sibling tex, watch tex, and any
  // project .tex already seen. Computed BEFORE macRev is read
  // (harvesting bumps the rev)
  const macros = texMacrosVisible(project, t);
  const macRev = texMacroRev;
  if (!segs.length) {
    wrap.innerHTML = '<div class="csEmpty">— the conversation streams here: thinking, tools, results, answers —</div>';
    wrap._n = 0;
  } else {
    if (wrap._n === 0 && wrap.firstChild) wrap.innerHTML = ''; // the empty-state note
    // Streaming legitimately re-segments the tail (a fence opener swallows
    // later lines; a growing last line turns into a marker): find the first
    // segment that differs from the DOM and refresh from there — never wipe
    // the whole console, which flashes, drops scroll anchoring, and forces a
    // full re-typeset
    const lastIdx = segs.length - 1;
    const isStream = (type) => type === 'think' || type === 'ans' || type === 'ques';
    const typesets = (type) => type === 'you' || isStream(type);
    // raw = plain text (no markdown/KaTeX): only the live tail of a running turn
    const rawAt = (j) => running && j === lastIdx && isStream(segs[j].type);
    const kids = wrap.children;
    const fresh = (el, j) => el
      && el._txt === segs[j].text
      && el.className === `cseg cs-${segs[j].type}`
      && el._raw === rawAt(j)
      // typeset with an older macro set → stale (a pinned .tex landed/changed)
      && (rawAt(j) || !typesets(segs[j].type) || el._mac === macRev);
    let first = 0;
    while (first < Math.min(kids.length, segs.length) && fresh(kids[first], first)) first++;
    while (wrap.children.length > segs.length) wrap.lastElementChild.remove();
    for (let j = first; j < segs.length; j++) {
      let el = wrap.children[j];
      if (el && fresh(el, j)) continue;
      if (!el) { el = document.createElement('div'); wrap.appendChild(el); }
      const seg = segs[j];
      const raw = rawAt(j);
      const cls = `cseg cs-${seg.type}`;
      if (raw) {
        // already streaming raw → grow the text node only (true append, no
        // wrapper rebuild); otherwise lay out the raw shell once
        const body = el._raw && el.className === cls ? el.querySelector(':scope > .csRaw') : null;
        if (body) body.textContent = seg.text;
        else { el.className = cls; el.innerHTML = consoleSegRaw(seg); }
      } else {
        el.className = cls;
        el.innerHTML = consoleSegHtml(seg);
        if (typesets(seg.type)) {
          katexEl(el, macros);
          el._mac = macRev;
          enhanceTexFences(el, project, taskId, macros);
        }
      }
      el._txt = seg.text;
      el._raw = raw;
    }
    wrap._n = segs.length;
  }

  // live approval card rides at the end of the stream — part of the console,
  // not the buffer
  const perm = (pendingPerms[k] || [])[0];
  let card = box.querySelector(':scope > .permCard');
  if (perm) {
    if (!card || card._reqId !== perm.requestId) {
      if (card) card.remove();
      card = document.createElement('div');
      card.className = 'permCard csPerm';
      card._reqId = perm.requestId;
      card.innerHTML = permCardInner(perm);
      box.appendChild(card);
      wirePermCard(card, project, taskId, perm);
    }
  } else if (card) {
    card.remove();
  }

  // Live activity at the stream's end — only while a turn truly runs.
  // (Created/patched here; PLACED by the shared tail-order pass below.)
  let verbEl = box.querySelector(':scope > .csVerb');
  if (running) {
    if (!verbEl) {
      verbEl = document.createElement('div');
      verbEl.className = 'csVerb';
      verbEl.innerHTML = runActivityHtml(project, t);
    }
    syncRunActivities();
  } else if (verbEl) {
    verbEl.remove();
    verbEl = null;
  }
  // queued-message note rides with the verb: composer sends during a turn
  // wait (one turn at a time) and deliver at turn end — say so where the
  // user is actually looking
  let qEl = box.querySelector(':scope > .csQueued');
  const nq = running ? (queuedMsgs[k] || []).length : 0;
  if (nq) {
    if (!qEl) {
      qEl = document.createElement('div');
      qEl.className = 'csQueued';
    }
    if (qEl._n !== nq || qEl.dataset.paused !== String(pausedQueues.has(k))) {
      qEl._n = nq;
      qEl.dataset.paused = String(pausedQueues.has(k));
      qEl.textContent = `⏳ ${nq === 1 ? 'message' : nq + ' messages'} queued — ${pausedQueues.has(k) ? 'paused; return to composer when ready' : 'sends when this turn ends'}`;
    }
  } else if (qEl) {
    qEl.remove();
    qEl = null;
  }
  // live activity strip — which agents the turn is running AND the running
  // ✎ file-edit aggregate. agentsLive/editsLive are the single source of
  // truth (ws events; applyState re-seeds them from each state.sessions
  // snapshot for the reload-mid-turn case) — no state.sessions fallback here,
  // so the turn-end clear is final and a stale snapshot can't resurrect a
  // dead fleet under the next turn.
  // the FULL roster, not just running: finished cards stay on the board,
  // dimmed with their verdicts, until the turn ends (stragglers stay legible)
  const roster = running ? (agentsLive[k] || []).filter(Boolean) : [];
  const liveEd0 = running ? editsLive[k] : null;
  const liveEd = liveEd0 && liveEd0.files ? liveEd0 : null;
  let agEl = box.querySelector(':scope > .csAgents');
  if (roster.length || liveEd) {
    if (!agEl) {
      agEl = document.createElement('div');
      agEl.className = 'csAgents';
      // → Δ jumps to the change ledger; delegated so innerHTML swaps keep it
      agEl.addEventListener('click', (e) => {
        if (!e.target.closest('.csToDelta')) return;
        perOf(project).snapView = null; // land on the list, not a stale drill-in
        perOf(project).fileTab = 'snaps';
        renderWB(project);
      });
    }
    const fmtTok = (n) => ((n = Number(n) || 0) >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
    const fmtDur = (ms) => {
      const s = Math.round((Number(ms) || 0) / 1000);
      return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
    };
    const ago = (t) => {
      if (!t) return '';
      const m = Math.floor((Date.now() - t) / 60000);
      return m < 1 ? 'just now' : m + 'm ago';
    };
    const sig = JSON.stringify([roster, liveEd]);
    if (agEl._sig !== sig) {
      agEl._sig = sig;
      // ── fleet board (docs/agentview-mockups ②, Graham's pick) ──
      const run = roster.filter(a => a.status === 'running');
      const done = roster.filter(a => a.status === 'done');
      const fail = roster.filter(a => a.status === 'failed');
      const head = `<div class="csAgentsHead">◆ ${roster.length} agent${roster.length === 1 ? '' : 's'}`
        + (run.length ? ` · ${run.length} running` : '')
        + (done.length ? ` · <span class="csOk">✓${done.length}</span>` : '')
        + (fail.length ? ` · <span class="csBad">✗${fail.length}</span>` : '') + '</div>';
      const card = (a) => `<div class="csACard ${esc(a.status)}" title="${esc(a.desc || '')}">`
        + `<div class="csAHd"><span class="csAN">◆ #${esc(String(a.n))}</span>`
        + `<span class="csASt">${a.status === 'running' ? '◌' : a.status === 'done' ? '✓' : '✗'}</span></div>`
        + `<div class="csADesc">${esc(a.desc || a.type || 'agent')}</div>`
        + `<div class="csAAct">${esc(a.summary || (a.status === 'running' ? '…' : ''))}</div>`
        + `<div class="csAMeta">${a.tools ? `${esc(String(a.tools))} tools · ` : ''}${fmtTok(a.tokens)} tok · `
        + `${a.status === 'running' ? esc(fmtDur(a.ms)) : esc(ago(a._doneAt) || a.status)}</div></div>`;
      let grid;
      if (roster.length > 8) {
        // large team: group by agent type; settled agents fold into the
        // header count so the board stays one screen — only live cards render
        const types = [...new Set(roster.map(a => a.type || 'agent'))];
        grid = types.map(t => {
          const of = roster.filter(a => (a.type || 'agent') === t);
          const settled = of.filter(a => a.status !== 'running').length;
          const failed = of.filter(a => a.status === 'failed').length;
          return `<div class="csAPhase">${esc(t)} — ${settled}/${of.length}`
            + (failed ? ` <span class="csBad">✗${failed}</span>` : '') + '</div>'
            + `<div class="csFleet">${of.filter(a => a.status === 'running').map(card).join('')}</div>`;
        }).join('');
      } else {
        grid = `<div class="csFleet">${roster.map(card).join('')}</div>`;
      }
      const agentBits = roster.length ? head + grid : '';
      const editBits = liveEd
        ? `<div class="csEditLine${roster.length ? ' below' : ''}"><span class="csEditTxt"><span class="csEditVerb">✎</span> `
        + `${liveEd.files.toLocaleString()} file${liveEd.files === 1 ? '' : 's'} changed`
        + (liveEd.created ? ` · <span class="csEdNew">${liveEd.created} new</span>` : '')
        + (liveEd.modified ? ` · ${liveEd.modified} edited` : '')
        + (liveEd.deleted ? ` · <span class="csEdDel">${liveEd.deleted} deleted</span>` : '')
        + ` · <span class="dAdd">+${(liveEd.adds || 0).toLocaleString()}</span> <span class="dDel">−${(liveEd.dels || 0).toLocaleString()}</span>`
        + `</span><span class="csToDelta" title="open the change ledger">Δ →</span></div>`
        : '';
      agEl.innerHTML = agentBits + editBits;
    }
  } else if (agEl) {
    agEl.remove();
    agEl = null;
  }
  // live job cards — long-running scripts this task's turn is executing
  // (job:status events; state.jobs seeds after a reload). Independent of
  // `running`: a just-finished card holds its terminal state while it fades.
  const mine = (j) => j && j.source === 'session' && j.project === project && j.taskId === taskId;
  const byStart = (a, b) => (a.startedAt < b.startedAt ? -1 : 1);
  // a DETACHED job outlives the turn: while the turn runs it keeps its full
  // card; once the turn has ended it collapses to a live feed row (⊘ stop
  // still reachable) beside the ended jobs' one-line end summaries
  const myJobs = Object.values(jobsLive)
    .filter(j => mine(j) && (running || !(j.detached && j.state === 'running')))
    .sort(byStart);
  let jobsEl = box.querySelector(':scope > .csJobs');
  if (myJobs.length) {
    if (!jobsEl) {
      jobsEl = document.createElement('div');
      jobsEl.className = 'csJobs';
    }
    syncJobCards(jobsEl, myJobs);
  } else if (jobsEl) {
    jobsEl.remove();
    jobsEl = null;
  }
  // the session feed: what stays after a card fades — one row per ended job
  // (✓ / ✗ / ⊘ + end summary), plus the live row of a detached job after the turn
  const feedJobs = [
    ...Object.values(jobsEnded).filter(mine),
    ...(running ? [] : Object.values(jobsLive).filter(j => mine(j) && j.detached && j.state === 'running')),
  ].sort(byStart);
  let feedEl = box.querySelector(':scope > .csJobFeed');
  if (feedJobs.length) {
    if (!feedEl) {
      feedEl = document.createElement('div');
      feedEl.className = 'csJobFeed';
    }
    syncJobFeed(feedEl, feedJobs);
  } else if (feedEl) {
    feedEl.remove();
    feedEl = null;
  }
  // ── tail placement, move-free when already in order ──
  // The strips ride at the stream's end as: verb, agents, jobs. appendChild
  // on a node that is ALREADY in the document detaches and re-inserts it,
  // which restarts its CSS animations and repaints — with a verb present
  // (a running turn) the old per-element appends re-moved all three every
  // pump frame, and the job card visibly blinked whenever anything rendered
  // ("the running panel disappears then reappears"). New segments append
  // inside .csegWrap, so once the tail is in order it STAYS in order — the
  // common case is zero DOM moves.
  const tail = [verbEl, qEl, agEl, feedEl, jobsEl].filter(Boolean);
  if (tail.length) {
    let inOrder = true;
    let node = box.lastElementChild;
    for (let i = tail.length - 1; i >= 0 && inOrder; i--) {
      if (node !== tail[i]) inOrder = false;
      else node = node.previousElementSibling;
    }
    if (!inOrder) for (const el of tail) box.appendChild(el);
  }
  // first paint lands at the bottom; afterwards follow the stream unless the
  // user scrolled away — scrolling back mustn't be fought
  if (stick) {
    const before = box.scrollTop;
    box.scrollTop = box.scrollHeight; // setter clamps to the real maximum
    // our own write fires one scroll event — flag it so the wireWB listener
    // doesn't mistake it for the user scrolling
    if (box.scrollTop !== before) box._prog = (box._prog || 0) + 1;
  }
}

/* smooth sequential reveal: incoming chunks land in tailBufs instantly, but
   the console advances a cursor toward the target each animation frame, so
   text flows in steadily instead of appearing in blocks */
/** @type {{ [taskKey: string]: number }} */
export const shownLen = {};   // k → characters revealed so far
/** @type {{ [taskKey: string]: number }} */
export const pumps = {};      // k → pending rAF id
/**
 * The reveal pump: one rAF chain per task key, easing shownLen toward the
 * buffer's end and re-rendering each frame.
 * @param {string} project
 * @param {string} k `${project}/${id}`
 * @returns {void}
 */
export function pumpConsole(project, k) {
  pumps[k] = 0;
  const target = (tailBufs[k] || '').length;
  const box = document.querySelector(`#v-${project} #consoleBox`);
  if (!box || box.dataset.key !== k) { shownLen[k] = target; return; } // console not open — no replay later
  if (shownLen[k] == null || shownLen[k] > target) shownLen[k] = target;
  if (shownLen[k] < target) {
    const gap = target - shownLen[k];
    shownLen[k] = Math.min(target, shownLen[k] + Math.max(3, Math.ceil(gap / 16)));
    // reschedule even if a render frame throws — the cursor already advanced,
    // so a bad frame skips, the pump survives, and the reveal still terminates
    try {
      updateConsole(box, k, shownLen[k]);
    } catch (err) {
      console.warn('[ui] console render frame failed', err);
    } finally {
      pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
    }
  } else {
    try {
      updateConsole(box, k, target);
    } catch (err) {
      console.warn('[ui] console render failed', err); // next chunk re-enters
    }
  }
}

/* ── permission approvals — diff + rendered preview before approving ── */

async function fetchCurrent(key, fileish) {
  const rel = relOf(key, String(fileish || ''));
  if (!rel) return null; // outside the project root — can't read it
  try {
    const r = await fetch(artifactUrl(key, rel));
    if (r.status === 404) return ''; // new file — proposal creates it
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/* apply the proposed Write/Edit/MultiEdit to `current` without executing it */
function proposedContent(perm, current) {
  const inp = perm.input || {};
  if (perm.tool === 'Write') return String(inp.content ?? '');
  if (current == null) return null;
  if (perm.tool === 'Edit') {
    const old = String(inp.old_string ?? ''), nw = String(inp.new_string ?? '');
    return inp.replace_all ? current.split(old).join(nw) : current.replace(old, nw);
  }
  if (perm.tool === 'MultiEdit' && Array.isArray(inp.edits)) {
    let txt = current;
    for (const e of inp.edits) {
      const old = String(e.old_string ?? ''), nw = String(e.new_string ?? '');
      txt = e.replace_all ? txt.split(old).join(nw) : txt.replace(old, nw);
    }
    return txt;
  }
  return null;
}

const PERM_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function permCardInner(perm) {
  const inp = perm.input || {};
  const fileish = inp.file_path || inp.notebook_path || inp.path || null;
  const isEdit = PERM_EDIT_TOOLS.includes(perm.tool);
  const isHtml = fileish && /\.html?$/i.test(String(fileish));
  const detail = perm.tool === 'Bash'
    ? `<pre class="permCmd">${esc(String(inp.command || ''))}</pre>`
    : fileish ? `<div class="permFile">${esc(String(fileish))}</div>` : '';
  return `
    <div class="ph">⏳ approval needed — <b>${esc(perm.tool)}</b>${inp.description ? ' · ' + esc(String(inp.description).slice(0, 120)) : ''}</div>
    ${detail}
    <div class="permBtns">
      ${isEdit ? `<button class="pbtn permDiff">± diff</button>` : ''}
      ${isEdit && isHtml ? `<button class="pbtn permPrev">⌗ rendered preview</button>` : ''}
      <span style="flex:1"></span>
      <button class="pbtn deny permDeny">✗ deny</button>
      <button class="pbtn allow permAllow">✓ approve</button>
    </div>
    <div class="permDiffBox"></div>`;
}

function wirePermCard(card, project, taskId, perm) {
  const resolveIt = (allow) => {
    // one decision per request — double-clicks were 404ing the second resolve
    card.querySelectorAll('.permAllow, .permDeny').forEach(b => { b.disabled = true; });
    return api('POST', `/api/tasks/${enc(project)}/${enc(taskId)}/permission`, { requestId: perm.requestId, allow });
  };
  card.querySelector('.permAllow')?.addEventListener('click', () => resolveIt(true));
  card.querySelector('.permDeny')?.addEventListener('click', () => resolveIt(false));
  card.querySelector('.permDiff')?.addEventListener('click', async () => {
    const box = card.querySelector('.permDiffBox');
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; return; } // toggle off
    box.innerHTML = '<div class="sideNote">computing diff…</div>';
    const inp = perm.input || {};
    if (perm.tool === 'Edit') {
      box.innerHTML = diffHtml(String(inp.old_string ?? ''), String(inp.new_string ?? ''));
      return;
    }
    const current = await fetchCurrent(project, inp.file_path || inp.notebook_path || '');
    const proposed = proposedContent(perm, current);
    box.innerHTML = (current == null || proposed == null)
      ? '<div class="sideNote">cannot diff — file outside the project root or unsupported tool input</div>'
      : diffHtml(current, proposed);
  });
  card.querySelector('.permPrev')?.addEventListener('click', async () => {
    const inp = perm.input || {};
    const fileish = String(inp.file_path || '');
    const current = await fetchCurrent(project, fileish);
    const proposed = proposedContent(perm, current);
    if (proposed == null) { toast('cannot preview this proposal'); return; }
    showProposalInPanel(project, proposed, 'proposed · ' + (fileish.split('/').pop() || perm.tool));
  });
}

// Seed a task's console buffer from its saved transcript after a reload, so
// the ≋ stream shows the conversation so far wherever the console mounts —
// the center tab, or the session pane in focus mode. Returns the task key.
/**
 * Seed tailBufs from the fetched transcript when the live buffer is empty
 * (shared by both console hosts — center tab and focus-mode session pane).
 * @param {string} key project key
 * @param {Task} task
 * @returns {string} the task's tail-buffer key
 */
export function seedTailBuf(key, task) {
  const tk = `${key}/${task.id}`;
  if (!tailBufs[tk]) {
    const tr = transcripts[tk];
    if (tr?.entries?.length) {
      tailBufs[tk] = tr.entries.map(e =>
        (e.role === 'user' ? '\n▸ you ─────────\n' : `\n▸ ${agentName(e.provider || taskProvider(task)).toLowerCase()} ──────\n`) + e.text + '\n'
        // rebuild the "— turn done · … —" divider saved on the assistant entry
        + (e.turnLine ? `${e.turnLine}\n` : '')).join('');
    }
  }
  return tk;
}
