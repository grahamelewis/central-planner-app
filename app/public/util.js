// util.js — pure helpers, formatters, diff/merge algorithms, toast/confirm,
// tex symbol completion — no app-state reads. Moved verbatim from app.js (phase 2).

export const enc = encodeURIComponent;

/**
 * HTML-escape for interpolation into markup (null/undefined → '').
 * @param {*} s
 * @returns {string}
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** @type {{ [oversight: string]: string }} */
export const OVS_LABEL = { auto: 'AUTO', propose: 'PROP', coop: 'COOP', manual: 'MAN' };

/**
 * Task status → status-dot css class.
 * @param {string | null | undefined} s
 * @returns {string}
 */
export function statusDot(s) {
  return { running: 'run', waiting: 'ask', queued: 'q', manual: 'man', done: 'done' }[s] || 'q';
}

// Feature flag: show the personal "hours logged" counter on the dashboard.
// Disabled for now — the heartbeat/ledger infrastructure still records hours;
// this only hides the display (ring, ledger column, wk chip).
// Flip back to true to restore it.
export const SHOW_HOURS = false;

/**
 * Seconds → hours with one decimal.
 * @param {number | null | undefined} sec
 * @returns {string}
 */
export function hrs(sec) { return ((sec || 0) / 3600).toFixed(1); }
/**
 * Token count → compact "1.2M" / "34k" form.
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function fmtTok(n) {
  n = n || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
}
/**
 * Uppercased file extension, '?' when none.
 * @param {*} f path or file name
 * @returns {string}
 */
export function extOf(f) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(f || ''));
  return m ? m[1].toUpperCase() : '?';
}
/**
 * mtime → "HH:MM" today, else "Mon D"; '' when unparsable.
 * @param {number | string | Date | null | undefined} mtime
 * @returns {string}
 */
export function fmtWhen(mtime) {
  try {
    const d = new Date(mtime);
    // @ts-ignore — deliberate JS idiom: isNaN(Date) probes valueOf() for NaN (invalid date)
    if (isNaN(d)) return '';
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toTimeString().slice(0, 5);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}
/**
 * ISO-8601 week number of a Date ('' on failure).
 * @param {Date} d
 * @returns {number | string}
 */
export function isoWeek(d) {
  try {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    // @ts-ignore — deliberate JS idiom: Date − Date coerces via valueOf() to ms
    return Math.ceil((((x - y0) / 86400000) + 1) / 7);
  } catch { return ''; }
}

export const isPdfFile = (f) => String(f || '').toLowerCase().endsWith('.pdf');
/** @param {unknown} f */
export const isHtmlFile = (f) => /\.html?$/i.test(String(f || ''));

/* pin kinds: code (read on demand) · data (schema card) · folder (tree map) · pdf (viewer) */
export const DATA_EXTS_C = ['csv', 'tsv', 'parquet', 'dta', 'rds', 'rdata', 'feather', 'xlsx', 'xls'];
export const isDataFile = (f) => DATA_EXTS_C.includes(String(f || '').split('.').pop().toLowerCase());
/* server-rendered head-of-table page (pandas) — iframed in the show panel */
export const dataviewUrl = (key, rel) => `/api/datahead/${enc(key)}?rel=${enc(rel)}`;
/**
 * Pin card kind for a context.files entry.
 * @param {*} f pin path ('…/' = folder)
 * @returns {'folder' | 'pdf' | 'data' | 'code'}
 */
export function pinKindOf(f) {
  const s = String(f || '');
  if (s.endsWith('/')) return 'folder';
  if (isPdfFile(s)) return 'pdf';
  return DATA_EXTS_C.includes(s.split('.').pop().toLowerCase()) ? 'data' : 'code';
}
export const pinLabelOf = (f) => {
  const s = String(f || '');
  return s.endsWith('/') ? s.replace(/\/+$/, '').split('/').pop() + '/' : s.split('/').pop();
};
/** @type {{ [pinKind: string]: string }} */
export const PIN_ICON = { code: '▮', data: '▦', folder: '🗀', pdf: '◫' };

// A "rel" that is really an absolute path is an external file/dir — the
// dashboard addresses external context by its absolute path, and the fetch
// helpers below route those to the allowlisted /api/extls + /api/extfile
// routes instead of the in-root /api/ls + /artifact.
export const isExtRel = (r) => String(r || '').startsWith('/');

let toastTimer = null;
/**
 * Show the transient status toast (4s).
 * @param {*} msg stringified into the toast
 * @returns {void}
 */
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(msg);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* in-app confirm dialog — native confirm() can be silenced by the browser,
   and a styled danger button reads clearer. msg is HTML (esc() the parts). */
/**
 * In-app confirm dialog.
 * @param {string} msg HTML (esc() the interpolated parts)
 * @param {string} [goLabel]
 * @returns {Promise<boolean>} true = confirmed
 */
export function confirmBox(msg, goLabel = 'Delete') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.id = 'confirmBack';
    back.innerHTML = `<div id="confirmBox">
      <div class="cbMsg">${msg}</div>
      <div class="cbBtns">
        <button class="cbCancel">Cancel</button>
        <button class="cbGo">${esc(goLabel)}</button>
      </div></div>`;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    back.querySelector('.cbCancel').addEventListener('click', () => done(false));
    back.querySelector('.cbGo').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    back.querySelector('.cbCancel').focus(); // Enter defaults to the safe side
  });
}

/* Line-level 3-way merge: null = conflict (caller falls back to ⚠ disk).
   Both sides' diffs vs base are computed as replacement hunks in base
   coordinates; disjoint hunks interleave, identical twins collapse, anything
   overlapping (or two different insertions at one point) is a conflict —
   conservative on purpose: a false conflict just means the old manual flow. */
/**
 * Line-level 3-way merge.
 * @param {string} baseText
 * @param {string} oursText
 * @param {string} theirsText
 * @returns {string | null} merged text, or null = conflict (caller falls back to ⚠ disk)
 */
export function merge3(baseText, oursText, theirsText) {
  if (oursText === theirsText) return oursText;
  const base = baseText.split('\n');
  const ha = lineDiff(base, oursText.split('\n'));
  const hb = lineDiff(base, theirsText.split('\n'));
  if (!ha || !hb) return null;
  const hunks = [...ha, ...hb.map(h => ({ ...h, b: true }))]
    .sort((x, y) => x.bs - y.bs || x.be - y.be || (x.b ? 1 : -1));
  const out = [];
  let cursor = 0;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const nx = hunks[i + 1];
    if (nx && !nx.b !== !h.b) {
      const twins = nx.bs === h.bs && nx.be === h.be
        && nx.lines.length === h.lines.length && nx.lines.every((l, j) => l === h.lines[j]);
      if (twins) hunks.splice(i + 1, 1); // both sides made the same edit
      else if ((h.bs < nx.be && nx.bs < h.be)
        || (h.bs === h.be && nx.bs === nx.be && h.bs === nx.bs)) return null;
    }
    if (h.bs < cursor) return null; // overlaps an already-applied hunk
    out.push(...base.slice(cursor, h.bs), ...h.lines);
    cursor = h.be;
  }
  out.push(...base.slice(cursor));
  return out.join('\n');
}

/* LCS line diff → replacement hunks {bs, be, lines}: base[bs,be) becomes
   `lines`. Common prefix/suffix trimmed first (typical case: tiny middle);
   a pathological middle returns null rather than an O(n·m) blowup. */
/**
 * Diff two line arrays into replacement hunks in base coordinates.
 * @param {string[]} a base lines
 * @param {string[]} b changed lines
 * @returns {{ bs: number, be: number, lines: string[], b?: boolean }[] | null}
 *   hunks, or null when the bounded LCS gave up (caller treats as conflict)
 */
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (!n && !m) return [];
  if (n * m > 4000000) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = am[i] === bm[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, hs = -1, ins = null;
  const flush = (endI) => {
    if (hs >= 0) { hunks.push({ bs: pre + hs, be: pre + endI, lines: ins }); hs = -1; ins = null; }
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) { flush(i); i++; j++; }
    else {
      if (hs < 0) { hs = i; ins = []; }
      if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { ins.push(bm[j]); j++; }
      else i++;
    }
  }
  flush(i);
  return hunks;
}
window.__merge3 = merge3; // test seam (§-debug idiom) — the engine has no other observable surface

/* line diff: trim common prefix/suffix, LCS-align the middle (bounded) */
/**
 * @param {string | null | undefined} aText
 * @param {string | null | undefined} bText
 * @returns {string[][]} per-line ops: ['=' | '-' | '+', line]
 */
export function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length, eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = a.slice(0, pre).map(l => ['=', l]);
  const mA = a.slice(pre, ea), mB = b.slice(pre, eb);
  if (mA.length * mB.length > 4000000) {
    // too big to align precisely — show as wholesale replace
    mA.forEach(l => ops.push(['-', l]));
    mB.forEach(l => ops.push(['+', l]));
  } else if (mA.length || mB.length) {
    const n = mA.length, m = mB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = mA[i] === mB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (mA[i] === mB[j]) { ops.push(['=', mA[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', mA[i]]); i++; }
      else { ops.push(['+', mB[j]]); j++; }
    }
    while (i < n) ops.push(['-', mA[i++]]);
    while (j < m) ops.push(['+', mB[j++]]);
  }
  a.slice(ea).forEach(l => ops.push(['=', l]));
  return ops;
}

/**
 * Compact diff HTML (permission-card previews).
 * @param {string | null | undefined} before
 * @param {string | null | undefined} after
 * @returns {string}
 */
export function diffHtml(before, after) {
  const ops = diffLines(before, after);
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] === '=') {
      let j = i;
      while (j < ops.length && ops[j][0] === '=') j++;
      const run = j - i;
      if (run > 8) { // collapse long unchanged stretches to 3 lines of context
        for (let k2 = i; k2 < i + 3; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
        out.push(`<div class="dl skip">··· ${run - 6} unchanged lines ···</div>`);
        for (let k2 = j - 3; k2 < j; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
      } else {
        for (let k2 = i; k2 < j; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
      }
      i = j - 1;
    } else if (ops[i][0] === '-') {
      out.push(`<div class="dl del">${esc(ops[i][1])}</div>`);
    } else {
      out.push(`<div class="dl add">${esc(ops[i][1])}</div>`);
    }
  }
  return `<div class="diffBox">${out.join('')}</div>`;
}

/* ── the Δ file view: full-file unified diff with line numbers ──
   Removed lines struck red (old line numbers), added lines washed green (new
   numbers), untouched code in place. Long unchanged runs fold into a clickable
   "⋯ N–M unchanged" row (3 context lines kept around each edit). Each edit
   hunk's first row carries data-h for the ◀ ▶ stepper. */
export const FOLD_MIN_HIDDEN = 4; // fold only when it actually hides a few lines

/**
 * Full-file unified diff with line numbers and fold rows (the Δ inline view).
 * @param {string | null | undefined} before
 * @param {string | null | undefined} after
 * @param {number[]} [expanded] fold anchors (op indexes) the user opened
 * @returns {{ html: string, hunks: number }}
 */
export function unifiedDiffHtml(before, after, expanded = []) {
  const ops = diffLines(before ?? '', after ?? '');
  const out = [];
  let oldN = 0, newN = 0, hunks = 0;
  const row = (cls, g, s, t, extra = '') =>
    out.push(`<div class="udl ${cls}"${extra}><span class="g">${g}</span><span class="s">${s}</span><span class="t">${esc(t)}</span></div>`);
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === '=') {
      let j = i;
      while (j < ops.length && ops[j][0] === '=') j++;
      const run = j - i;
      // context stays visible next to an edit; nothing to anchor at the file's ends
      const headCtx = i === 0 ? 0 : 3;
      const tailCtx = j === ops.length ? 0 : 3;
      const hidden = run - headCtx - tailCtx;
      if (hidden >= FOLD_MIN_HIDDEN && !expanded.includes(i)) {
        for (let k2 = 0; k2 < headCtx; k2++) { oldN++; newN++; row('ctx', newN, ' ', ops[i + k2][1]); }
        const from = newN + 1;
        oldN += hidden; newN += hidden;
        out.push(`<div class="udl fold" data-fold="${i}" title="click to show these lines">`
          + `<span class="g">⋯</span><span class="t">${from}–${newN} unchanged</span></div>`);
        for (let k2 = run - tailCtx; k2 < run; k2++) { oldN++; newN++; row('ctx', newN, ' ', ops[i + k2][1]); }
      } else {
        for (let k2 = 0; k2 < run; k2++) { oldN++; newN++; row('ctx', newN, ' ', ops[i + k2][1]); }
      }
      i = j;
    } else {
      // one edit hunk: a contiguous run of −/+ lines
      let j = i;
      while (j < ops.length && ops[j][0] !== '=') j++;
      const mark = ` data-h="${hunks++}"`;
      let first = true;
      for (let k2 = i; k2 < j; k2++) {
        const [op, txt] = ops[k2];
        if (op === '-') { oldN++; row('delln', oldN, '−', txt, first ? mark : ''); }
        else { newN++; row('addln', newN, '+', txt, first ? mark : ''); }
        first = false;
      }
      i = j;
    }
  }
  return { html: out.join(''), hunks };
}

/**
 * ISO timestamp → "now" / "34m" / "5h" / "3d" / "Mon D".
 * @param {*} ts anything Date.parse can chew ('' on failure)
 * @returns {string}
 */
export function fmtAgo(ts) {
  const ms = Date.now() - Date.parse(ts || 0);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Job elapsed ms → "1:23:45" / "4:56" clock text.
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function fmtJobDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
/**
 * ETA seconds → "~30s" / "~5m" / "~1.5h" ('' when unknown).
 * @param {number | null | undefined} s
 * @returns {string}
 */
export function fmtJobEta(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 90) return `~${Math.max(5, Math.round(s / 5) * 5)}s`;
  if (s < 5400) return `~${Math.round(s / 60)}m`;
  return `~${(s / 3600).toFixed(1)}h`;
}
/**
 * rss bytes → "1.2G" / "340M" ('—' when unknown).
 * @param {number | null | undefined} b
 * @returns {string}
 */
export function fmtJobMem(b) {
  if (!Number.isFinite(b) || b <= 0) return '—';
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)}G` : `${Math.max(1, Math.round(b / 1e6))}M`;
}

/* ── Julia-style LaTeX completion: type \beta then Tab → β ──────────────────
   Works in every prose input (composer, Add Task fields, searches) via the
   delegated handler in wireGlobal; the code editor opts in for .jl files only
   (its Tab is indentation, and .tex files are full of intentional \alpha).
   Phase 3 S0 scoped extraction (blueprint §14 A21): the glyph table and the
   trailing-\name matcher moved verbatim to latex/texCore.js (TEX_SYMS,
   texSymbolMatch); texComplete below stays as the thin DOM applier. This
   import (and the matching one in texEditor.js) is S0's only sanctioned
   legacy diff; behavior is byte-identical. */
export { TEX_SYMS, texSymbolMatch } from './latex/texCore.js';
import { texSymbolMatch as texSymbolMatchCore } from './latex/texCore.js';

/* Replace a trailing \name (or \^2 / \_t) before the caret with its symbol.
   → true (converted) | 'miss' (a \name attempt, unknown) | false (nothing). */
/**
 * Julia-style \symbol → glyph completion at the caret of a text input.
 * Thin DOM applier over texCore.texSymbolMatch (the pure matcher).
 * @param {*} el textarea/input with a collapsed selection
 * @returns {boolean | 'miss'} true = converted · 'miss' = \name unknown · false = not applicable
 */
export function texComplete(el) {
  const pos = el.selectionStart;
  if (pos == null || pos !== el.selectionEnd) return false;
  const m = texSymbolMatchCore(el.value.slice(0, pos));
  if (!m) return false;
  if (!m.sym) return 'miss';
  const start = pos - m.length;
  el.setSelectionRange(start, pos);
  // execCommand keeps native undo (⌘Z restores the \name); fall back if gone
  if (!document.execCommand || !document.execCommand('insertText', false, m.sym)) {
    el.setRangeText(m.sym, start, pos, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
