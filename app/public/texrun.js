// texrun.js — ▶ runs + the LaTeX machinery, split verbatim out of app.js
// (phase 2): problems strip, Claude-fix suggestions lifecycle, synctex,
// auto-recompile queue, runFile, run/build cards, pane-status sync.

import { passFrac, creepTarget, CREEP_EASE } from './pdfPane.js';
import { texMarkLines, TEX_EXTS } from './texEditor.js';
import { enc, esc, toast, isExtRel } from './util.js';
import {
  state, ui, pdfPanes, fileCache, drafts, runBufs, runSegs, turnTexTouched,
  curTask, perOf, relOf,
} from './store.js';
import { api, apiQuiet } from './net.js';
import { saveFile } from './files.js';
import { selectViewer, getAddedViewers, persistAddedViewers, artPaneKey } from './viewers.js';
import { renderWB, texOpenAt } from './workbench.js';
import { effectiveImpl as editorImpl, requestSave as requestMonacoSave } from './monacoPane.js';

const autoRunQ = {};       // project → [texRel…] auto-compiles waiting on the single run slot
const texInputCache = {};  // project::root → last project-contained dependency list
const texInputLoads = {};  // same key → single-flight discovery promise

/** Discover/cache the editable inputs for a LaTeX root. Pane chrome uses the
 * cache for its document-level dirty dot; compile calls refresh after saves. */
export function primeTexInputs(key, texRel, refresh = false) {
  const ck = `${key}::${texRel}`;
  if (!refresh && Array.isArray(texInputCache[ck])) return Promise.resolve(texInputCache[ck]);
  if (!refresh && texInputLoads[ck]) return texInputLoads[ck];
  const p = apiQuiet('GET', `/api/texdeps/${enc(key)}?tex=${enc(texRel)}`)
    .then((deps) => {
      const files = Array.isArray(deps?.files) && deps.files.includes(texRel)
        ? [...new Set(deps.files)] : null;
      if (files) texInputCache[ck] = files;
      return files;
    })
    .finally(() => { if (texInputLoads[ck] === p) delete texInputLoads[ck]; });
  texInputLoads[ck] = p;
  return p;
}

/* Compile problems for a project: the live latexmk watch, plus the last
   one-shot ▶ run when it was a .tex. Deduped — a watch and a run of the same
   file report the same issues. */
/**
 * De-duplicated LaTeX problems from the live watch + a matching .tex ▶ run.
 * @param {string} key project key
 * @returns {TexProblem[]}
 */
export function texProblemsFor(key) {
  const out = [];
  const seen = new Set();
  const add = (list) => (list || []).forEach((p) => {
    const k = `${p.kind}|${p.file}|${p.line}|${p.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  });
  add(state.pdf?.[key]?.problems);
  const run = state.runs?.[key];
  if (run && /\.tex$/i.test(run.rel || '')) add(run.problems);
  return out;
}

/**
 * Patch the editor's problems strip + line decorations in place.
 * @param {string} key project key
 * @returns {void}
 */
export function renderTexProblems(key) {
  const root = document.getElementById('v-' + key);
  const host = root?.querySelector('#texProblems');
  if (!host) return;
  const probs = texProblemsFor(key);
  const per = perOf(key);
  const fix = state.texfix?.[key];
  const busy = fix?.state === 'running';
  const sugs = openSugs(key);
  const applied = (fix?.suggestions || []).filter((s) => s.status === 'accepted');
  // the strip stays up while Claude is searching, has open suggestions, or
  // just resolved something — even after the problems themselves cleared
  if (!probs.length && !busy && !sugs.length && !applied.length) {
    host.className = '';
    host.innerHTML = '';
    return;
  }
  const c = { errors: 0, warnings: 0, badboxes: 0 };
  probs.forEach((p) => { c[p.kind === 'error' ? 'errors' : p.kind === 'warning' ? 'warnings' : 'badboxes']++; });
  const open = !!per.probOpen && probs.length > 0;
  const chip = (n, cls, one, many) => (n ? `<span class="tpChip ${cls}">${n} ${n === 1 ? one : many}</span>` : '');
  const fixBit = busy
    ? '<span class="tpFixRun"><span class="runSpin">⟳</span> Claude (Sonnet 5) is searching for a fix…</span>'
    : sugs.length
      ? `<span class="tpSugs">✦ ${sugs.length} suggested fix${sugs.length === 1 ? '' : 'es'} — highlighted in the code${applied.length ? ` · ${applied.length} applied` : ''}</span>`
      : applied.length && !c.errors
        ? `<span class="tpSugs">✓ Claude fix applied — ${applied.length} change${applied.length === 1 ? '' : 's'}</span>`
        : applied.length
          ? `<span class="tpSugs">✦ ${applied.length} applied — ⌘S saves & rebuilds</span>`
          : c.errors
            ? '<button class="texBtn tpFix" id="tpFixBtn" title="Claude fix — a read-only Sonnet 5 session suggests fixes you approve (billed)">🔧 Claude fix</button>'
            : '';
  host.className = 'texProblems' + (c.errors ? ' hasErr' : '');
  host.innerHTML = `<div class="tpBar" id="tpBar" title="${probs.length ? `latexmk problems — click to ${open ? 'collapse' : 'expand'}` : 'Claude fix'}">
      <span class="tpCaret">${probs.length ? (open ? '▾' : '▸') : ''}</span>
      ${chip(c.errors, 'err', 'error', 'errors')}
      ${chip(c.warnings, 'warn', 'warning', 'warnings')}
      ${chip(c.badboxes, 'bad', 'bad box', 'bad boxes')}
      ${!probs.length ? '<span class="tpChip" style="color:var(--green)">build ✓</span>' : ''}
      ${fixBit}
    </div>
    ${open ? `<div class="tpList">${probs.slice(0, 40).map((p) => `
      <div class="tpRow ${esc(p.kind)}" data-pf="${esc(p.file || '')}" data-pl="${p.line || ''}">
        <span class="tpIcon">${p.kind === 'error' ? '✗' : p.kind === 'warning' ? '⚠' : '▭'}</span>
        <span class="tpLoc">${esc(p.file || '')}${p.line ? ':' + p.line : ''}</span>
        <span class="tpMsg">${esc(p.message)}</span>
      </div>`).join('')}${probs.length > 40 ? `<div class="tpMore">… ${probs.length - 40} more in the log</div>` : ''}</div>` : ''}`;
  host.querySelector('#tpBar').addEventListener('click', () => {
    per.probOpen = !per.probOpen;
    renderTexProblems(key);
  });
  host.querySelector('#tpFixBtn')?.addEventListener('click', (e) => {
    e.stopPropagation(); // don't toggle the list open/closed
    startTexFix(key);
  });
  host.querySelectorAll('.tpRow[data-pf]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.pf && el.dataset.pl) texOpenAt(key, el.dataset.pf, Number(el.dataset.pl), 1);
  }));
  // keep the gutter tints in sync with the fresh problem set
  const ed = root.querySelector('#codeEditor');
  const hlCode = root.querySelector('#codeHL');
  if (ed && hlCode && TEX_EXTS.includes(ed.dataset.ext)) {
    texMarkLines(hlCode, probs, ed.dataset.rel);
  }
}

/* ─────────────── Claude fix — repair a failing LaTeX build ───────────────
   Card shown in the session pane whenever the project's LaTeX has a serious
   compile failure (live watch in error, or the last .tex run failed). One
   click spawns a sandboxed read-only Sonnet 5 session (BILLED) that returns
   find→replace suggestions; they render as in-editor Apply/Dismiss panes that
   patch the user's unsaved draft — nothing touches disk (and no rebuild
   fires) until the user saves. */

function texBuildErrors(key) {
  const w = state.pdf?.[key];
  if (w && (w.state === 'error' || (w.counts?.errors || 0) > 0)) {
    return { n: w.counts?.errors || 0, dead: !!w.dead };
  }
  const r = state.runs?.[key];
  if (r && /\.tex$/i.test(r.rel || '') && r.state === 'error' && (r.counts?.errors || 0) > 0) {
    return { n: r.counts.errors, dead: false };
  }
  return null;
}

/**
 * @param {string} key project key
 * @returns {TexFixSuggestion[]} the pending Claude-fix suggestions still open
 */
export function openSugs(key) {
  return (state.texfix?.[key]?.suggestions || []).filter((s) => s.status === 'open');
}

/** @type {{ [sugId: string]: number }} */
export const sugStaleAt = {};  // suggestion id → when its find-string stopped matching
/** @type {Set<string>} */
export const sugPulsed = new Set(); // ids that already played the arrival pulse
/** @type {{ [project: string]: (() => void) | null }} */
export const sugRedraw = {};   // project → the mounted editor's decoration renderer
/** @type {{ [project: string]: any }} */
export const texfixRetire = {}; // project → timer walking the success card off stage

/* Patch everything a resolution touches WITHOUT a workbench re-render — a
   full renderWB here would disturb the editor scroll mid-review. */
function sugPatchViews(key) {
  sugRedraw[key]?.();
  renderTexProblems(key);
  const root = document.getElementById('v-' + key);
  root?.querySelectorAll('.texfixCard').forEach((el) => {
    const html = texFixCardHtml(key);
    if (!html) { el.remove(); return; }
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const fresh = holder.firstElementChild;
    el.replaceWith(fresh);
    fresh.querySelector('#texFixBtn')?.addEventListener('click', () => startTexFix(key));
  });
  armTexfixRetire(key); // an Apply may have just completed the success state
}

/**
 * Approve/dismiss a Claude-fix suggestion (bookkeeping POST + editor update).
 * @param {string} key project key
 * @param {string} id suggestion id
 * @param {'accepted' | 'dismissed' | 'stale' | string} status
 * @returns {Promise<void>}
 */
export async function resolveSug(key, id, status) {
  const s = state.texfix?.[key]?.suggestions?.find((x) => x.id === id);
  if (s) s.status = status;
  delete sugStaleAt[id];
  if (ui.view === key) sugPatchViews(key);
  try {
    await api('POST', `/api/texfix/${enc(key)}/resolve`, { id, status });
  } catch { /* the next texfix:status broadcast corrects local state */ }
}

/* A suggestion whose find-string vanished from the buffer (the user probably
   fixed it themselves) gets a grace period before it's quietly retired — an
   undo inside 5s brings its highlight straight back. */
/**
 * A suggestion's find-string stopped matching the live buffer — grace-time it.
 * @param {string} key project key
 * @param {TexFixSuggestion} s
 * @returns {void}
 */
export function markSugStale(key, s) {
  if (sugStaleAt[s.id]) return;
  sugStaleAt[s.id] = Date.now();
  setTimeout(() => {
    const cur = state.texfix?.[key]?.suggestions?.find((x) => x.id === s.id);
    if (cur && cur.status === 'open' && sugStaleAt[s.id]) resolveSug(key, s.id, 'stale');
  }, 5200);
}

/* The "✓ Claude fix applied — build is clean" card is a moment, not a fixture:
   it gets ~4.5s of glory, fades out gracefully, and the fix record is retired
   server-side so no re-render, task switch, or reload brings it back. */
function texfixDoneClean(key) {
  const fix = state.texfix?.[key];
  if (fix?.state !== 'done') return false;
  const all = fix.suggestions || [];
  return all.length > 0
    && !all.some((s) => s.status === 'open')
    && all.some((s) => s.status === 'accepted')
    && !texBuildErrors(key);
}

/**
 * Walk the success card off stage once every suggestion is settled.
 * @param {string} key project key
 * @returns {void}
 */
export function armTexfixRetire(key) {
  if (!texfixDoneClean(key)) {
    // left the success state (new errors, new search) — stand down
    clearTimeout(texfixRetire[key]);
    delete texfixRetire[key];
    return;
  }
  if (texfixRetire[key]) return;
  texfixRetire[key] = setTimeout(() => {
    delete texfixRetire[key];
    if (!texfixDoneClean(key)) return;
    const cards = [...(document.getElementById('v-' + key)
      ?.querySelectorAll('.texfixCard.sugDone') || [])];
    cards.forEach((el) => el.classList.add('fadeAway'));
    // let the fade+collapse play, then clear the record for real
    setTimeout(() => {
      state.texfix[key] = {};
      sugPatchViews(key);
      apiQuiet('POST', `/api/texfix/${enc(key)}/dismiss`, {});
    }, cards.length ? 520 : 0);
  }, 4500);
}

/**
 * The session pane's ✦ Claude-fix card for the project's fix state.
 * @param {string} key project key
 * @returns {string} html
 */
export function texFixCardHtml(key) {
  const errs = texBuildErrors(key);
  const fix = state.texfix?.[key];
  const all = fix?.suggestions || [];
  const open = all.filter((s) => s.status === 'open');
  const applied = all.filter((s) => s.status === 'accepted');
  if (fix?.state === 'running') {
    return `<div class="runHint texfixCard running">
      <span class="runSpin">⟳</span>
      Claude (Sonnet 5) is searching for a fix — suggestions will highlight in the code
    </div>`;
  }
  if (open.length) {
    return `<div class="runHint texfixCard sugReady">
      <span>✦</span> <b>${open.length} suggested fix${open.length === 1 ? '' : 'es'}</b> —
      highlighted in ${esc(open[0].file)}; approve each one there
      ${applied.length ? `<span class="alt">${applied.length} applied so far</span>` : ''}
    </div>`;
  }
  if (applied.length && fix?.state === 'done') {
    const draftPending = fix.tex && drafts[`${key}::${fix.tex}`] != null;
    if (!errs) {
      // resolved: the applied fix went in and the build came back clean
      return `<div class="runHint texfixCard sugDone">
        <span>✓</span> <b>Claude fix applied</b> — build is clean
        <span class="alt">${applied.length} change${applied.length === 1 ? '' : 's'} accepted</span>
      </div>`;
    }
    return `<div class="runHint texfixCard sugReady">
      <span>✦</span> <b>${applied.length} fix${applied.length === 1 ? '' : 'es'} applied</b> —
      ${draftPending ? 'sitting in your unsaved draft · ⌘S saves & rebuilds'
        : 'rebuild still failing — you can search again'}
      ${!draftPending ? `<button id="texFixBtn" title="search again — billed">🔧 search again</button>` : ''}
    </div>`;
  }
  if (!errs) return '';
  const failNote = fix?.state === 'error' ? `<span class="tfNote">last attempt failed: ${esc((fix.error || '').slice(0, 90))}</span>`
    : fix?.state === 'done' && !all.length ? `<span class="tfNote">last search found nothing usable${fix.note ? ` — ${esc(fix.note.slice(0, 80))}` : ''}</span>` : '';
  return `<div class="runHint texfixCard">
    <span>✗</span> <b>LaTeX build failing</b>${errs.n ? ` — ${errs.n} error${errs.n === 1 ? '' : 's'}` : ''}
    <button id="texFixBtn" title="a read-only Sonnet 5 session studies the failure and suggests fixes you approve one by one — billed">🔧 Claude fix</button>
    <span class="alt">Sonnet 5 · suggests, you approve · billed</span>
    ${failNote}
  </div>`;
}

/**
 * POST /api/texfix (billed route, server-guarded) — read-only fix suggestions.
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function startTexFix(key) {
  const t = curTask(key);
  // optimistic — the texfix:status broadcast confirms or corrects
  state.texfix[key] = { state: 'running', startedAt: new Date().toISOString() };
  renderWB(key);
  try {
    await api('POST', `/api/texfix/${enc(key)}`, { taskId: t?.id || null });
  } catch (err) {
    state.texfix[key] = { state: 'error', error: err.message || String(err) };
    renderWB(key);
    toast('Claude fix: ' + (err.message || err));
  }
}

/* Inverse SyncTeX (shared by the live-watch and artifact panes): a PDF
   double-click → source file:line → open the editor there. */
/**
 * Inverse SyncTeX: pdf dblclick → open the source at file:line.
 * @param {string} key project key
 * @param {string} rel pdf rel
 * @param {number} page
 * @param {number} x PDF points, top-left origin
 * @param {number} y
 * @returns {Promise<void>}
 */
export async function synctexEditOpen(key, rel, page, x, y) {
  try {
    const r = await api('GET', `/api/synctex/edit/${enc(key)}?pdf=${enc(rel)}&page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
    if (r?.file) texOpenAt(key, r.file, r.line, r.column || 1);
  } catch (err) {
    toast('synctex: ' + (err.message || err));
  }
}

/* Forward SyncTeX: caret line in `rel` → scroll + flash the live PDF pane. */
/**
 * Forward SyncTeX (⌘J): editor position → pdf highlight box.
 * @param {string} key project key
 * @param {string} rel tex rel
 * @param {number} line
 * @param {number} col
 * @returns {Promise<void>}
 */
export async function texForwardSearch(key, rel, line, col) {
  if (!state.pdf?.[key]) {
    toast('no live PDF — ＋ in the show panel and pick this .tex to watch it');
    return;
  }
  try {
    const r = await api('GET', `/api/synctex/view/${enc(key)}?tex=${enc(rel)}&line=${line}&col=${col || 1}`);
    if (!r || r.page == null) return;
    const per = perOf(key);
    if (per.viewerKey !== 'pdf') {
      per.viewerKey = 'pdf';
      renderWB(key); // mounts the pane
    }
    pdfPanes[key]?.scrollTo(r);
  } catch (err) {
    toast('synctex: ' + (err.message || err));
  }
}

/* Auto-recompile: a session's turn edited .tex files — record them via
   noteTurnTex, then at turn end queueAutoTexRuns fires a one-shot ▶ for each
   deck the user has a pdf tab open for, so slides refresh without a manual ▶.
   Deliberately narrow: the live watch's tex is skipped (the watch recompiles
   it by itself on any change), decks with no open tab are skipped (compiling
   invisibly would surprise), and the DISK version compiles — never an unsaved
   editor draft (auto must not save for you; the merged draft stays yours).
   Compiles share the project's single run slot: pumpAutoRun starts one and
   run:status's terminal ping starts the next. */
/**
 * Record a session-edited .tex for the turn-end auto-recompile sweep.
 * @param {string} project
 * @param {string} rel
 * @returns {void}
 */
export function noteTurnTex(project, rel) {
  if (!/\.tex$/i.test(String(rel || '')) || isExtRel(rel)) return;
  (turnTexTouched[project] ?? (turnTexTouched[project] = new Set())).add(rel);
}

/**
 * Turn end: queue one-shot recompiles for touched .tex files whose pdf has
 * an open viewer tab (live-watch tex skipped; FIFO behind any live run).
 * @param {string} project
 * @param {string[]} rels
 * @param {Task | null} task
 * @returns {void}
 */
export function queueAutoTexRuns(project, rels, task) {
  const watchTex = state.pdf?.[project]?.tex ? relOf(project, state.pdf[project].tex) : null;
  const tabs = new Set(getAddedViewers(project).map(v => v.rel));
  for (const f of (task && Array.isArray(task.context?.files)) ? task.context.files : []) {
    if (/\.pdf$/i.test(String(f))) tabs.add(String(f));
  }
  const q = autoRunQ[project] ?? (autoRunQ[project] = []);
  for (const rel of rels) {
    if (rel === watchTex) continue;
    if (!tabs.has(rel.replace(/\.tex$/i, '.pdf'))) continue;
    if (!q.includes(rel)) q.push(rel);
  }
  if (!q.length) delete autoRunQ[project];
  else pumpAutoRun(project);
}

/**
 * Run-slot free — start the next queued auto-compile, if any.
 * @param {string} project
 * @returns {Promise<void>}
 */
export async function pumpAutoRun(project) {
  const q = autoRunQ[project];
  if (!q || !q.length) return;
  if (state.runs[project]?.state === 'running') return; // run:status terminal ping re-pumps
  const rel = q.shift();
  if (!q.length) delete autoRunQ[project];
  runBufs[project] = ''; // mirror runFile's reset — ▶ output shows THIS run
  delete runSegs[project];
  toast(`auto-compiling ${rel} — a session edited it`);
  const r = await api('POST', '/api/run', { project, rel });
  if (r && r.ok) {
    if (r.run) state.runs[project] = r.run;
    if (ui.view === project) renderWB(project);
    // NO tab select/yank: the deck's tab is already open (that's why it
    // qualified) and artifact:new reloads its pane in place when the pdf lands
  } else {
    pumpAutoRun(project); // refused (a manual run raced in…) — try the next
  }
}

/**
 * ▶ run: save first, then POST /api/run (.tex gets the pdf-tab handoff and
 * quiet-build card; a live-watch tex just re-selects the watch tab).
 * @param {string} key project key
 * @param {string} rel
 * @returns {Promise<void>}
 */
export async function runFile(key, rel) {
  if (state.runs[key]?.state === 'running') {
    toast('a run is already active in this project — ⊘ stop it first');
    perOf(key).sessTab = 'run';
    renderWB(key);
    return;
  }
  const isTex = /\.tex$/i.test(rel);
  // A PDF-pane compile is a document transaction: save dirty inputs that
  // belong to this root (from the server's .fls + source graph), then compile
  // the root. Non-TeX runs retain the old single-file save-first behavior.
  // Re-resolve after each save round: a dirty root or included file may add a
  // brand-new \input edge that was not present in the last .fls/disk scan.
  // Four rounds bound pathological self-changing graphs while covering root
  // -> appendix -> nested-input chains without saving unrelated project work.
  for (let round = 0; round < (isTex ? 5 : 1); round++) {
    let inputs = [rel];
    if (isTex) {
      const files = await primeTexInputs(key, rel, true);
      if (!files) {
        toast(`cannot compile — could not resolve the inputs for ${rel}`);
        return;
      }
      inputs = files.filter((f) => f !== rel).concat(rel);
    }
    const dirtyInputs = inputs.filter((inputRel) => drafts[`${key}::${inputRel}`] != null);
    if (!dirtyInputs.length) break;
    if (round === 4) {
      toast('cannot compile — the document dependency graph is still changing');
      return;
    }
    for (const inputRel of dirtyInputs) {
      const k = `${key}::${inputRel}`;
      const c = fileCache[k];
      if (!c || c.loading || c.error || c.truncated) {
        // A leftover draft with no trustworthy baseline must never be written
        // merely because another document depends on it.
        toast(`cannot compile — reopen ${inputRel} before saving its stale draft`);
        return;
      }
      if (editorImpl() === 'monaco') await requestMonacoSave(k);
      else await saveFile(key, inputRel);
      if (drafts[k] != null) return; // conflict/failure/new typing: never compile stale bytes
    }
  }
  // ▶ on the .tex the live watch (＋ → .tex) already covers: the watch
  // recompiles on save, and a one-shot latexmk beside it would race the same
  // aux/synctex files — just surface its pane
  if (isTex && state.pdf[key] && relOf(key, state.pdf[key].tex) === rel) {
    selectViewer(key, 'pdf');
    renderWB(key);
    return;
  }
  runBufs[key] = '';
  delete runSegs[key];
  const r = await api('POST', '/api/run', { project: key, rel });
  if (r && r.ok) {
    if (r.run) {
      const cur = state.runs[key];
      const sameRun = cur?.startedAt && cur.startedAt === r.run.startedAt;
      const curAt = Date.parse(String(cur?.startedAt || ''));
      const ackAt = Date.parse(String(r.run.startedAt || ''));
      // The POST is only a launch acknowledgement. A very fast no-op can
      // finish over WebSocket before this continuation runs; never regress
      // that same run from terminal -> running, nor replace a newer run.
      const currentIsNewer = Number.isFinite(curAt) && Number.isFinite(ackAt) && curAt > ackAt;
      const terminalAlreadyWon = sameRun && cur?.state !== 'running' && r.run.state === 'running';
      if (!currentIsNewer && !terminalAlreadyWon) state.runs[key] = r.run;
    }
    if (isTex) {
      // the ＋-equivalent: the compiled pdf gets (or reuses) its OWN viewer
      // tab, so draft.pdf and slides.pdf coexist — and LaTeX stays quiet:
      // the pane's bar/verdict + the build card carry the status, no
      // session-pane yank to ▶ output
      ensureTexPdfTab(key, rel);
    } else {
      perOf(key).sessTab = 'run';
    }
    renderWB(key);
  }
}

/* ▶ on a .tex shows its compiled pdf exactly as ＋ → that .pdf would: a
   persisted pdfart viewer tab, selected. One tab per document; the single
   live-watch slot is untouched. An existing tab for the pdf (pinned,
   artifact-listed, or previously added) is reused via the render-time dedup,
   and selectViewer reopens it if it was ×-closed. */
function ensureTexPdfTab(key, texRel) {
  const rel = String(texRel).replace(/\.tex$/i, '.pdf');
  const arr = getAddedViewers(key);
  if (!arr.some(v => v.rel === rel)) {
    arr.push({ rel, kind: 'pdfart' });
    persistAddedViewers(key, arr);
  }
  selectViewer(key, rel);
}

/**
 * ⊘ stop the project's active run.
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function stopRunReq(key) {
  await api('DELETE', `/api/run/${enc(key)}`);
}

/* ▶ in a pdf pane's toolbar: compile the pane's tex source — runFile
   saves an open draft first, so one press does ⌘S-then-run. While THIS tex's
   one-shot run is live the same box is ⊘ and stops it. */
/**
 * The pdf-pane ▶'s click behavior for a tex source (run / stop / save-now).
 * @param {string} key project key
 * @param {string} texRel
 * @returns {void}
 */
export function texPaneRun(key, texRel) {
  const run = state.runs[key];
  if (run?.state === 'running' && run.rel === texRel) { stopRunReq(key); return; }
  runFile(key, texRel);
}

/* Keep every mounted pdf pane's toolbar ▶ honest: ⊘ tracks the project's
   one-shot run of that pane's tex, the amber dot tracks the tex source's
   unsaved draft. The watch pane's ▶ is save-now (the watch recompiles on
   save) so it never shows ⊘ — the staged bar + verdict carry its progress.
   Cheap (a class/glyph toggle per open pdf pane), called from editorChrome,
   run pings, and pane mounts. */
/**
 * Sync every tex ▶ control (pane buttons + editor foot) to run/draft state.
 * @param {string} key project key
 * @returns {void}
 */
export function syncTexRunControls(key) {
  const run = state.runs[key];
  for (const [pk, pane] of Object.entries(pdfPanes)) {
    if (!pane.setRun) continue;
    let texRel = null;
    const watch = pk === key; // watch pane is keyed by the bare project
    if (watch) texRel = state.pdf?.[key]?.tex ? relOf(key, state.pdf[key].tex) : null;
    else if (pk.startsWith(`${key}::`) && pane.texRel) texRel = pane.texRel;
    if (watch && !texRel) { pane.setRun({ show: false }); continue; } // watch deleted
    if (!texRel) continue;
    const running = !watch && run?.state === 'running' && run.rel === texRel;
    const inputs = texInputCache[`${key}::${texRel}`] || [texRel];
    const dirty = inputs.some((inputRel) => drafts[`${key}::${inputRel}`] != null);
    pane.setRun({
      show: true, running, dirty,
      title: running ? `⊘ stop the ${texRel} run`
        : watch ? `save ${texRel} — the live watch recompiles on save${dirty ? '' : ' (no unsaved changes)'}`
          : `compile ${texRel}${dirty ? ' — saves your draft first' : ''}`,
    });
  }
}

export const RUNNABLE_EXTS = ['jl', 'py', 'r', 'sh', 'tex', 'sql'];

function runStatTxt(run) {
  if (!run) return '';
  if (run.state === 'running') return '⟳ running…';
  const secs = run.ms != null ? ` · ${(run.ms / 1000).toFixed(1)}s` : '';
  if (run.state === 'done') return `✓ exit 0${secs}`;
  if (run.state === 'stopped') return `⊘ stopped${secs}`;
  return `✗ exit ${run.exitCode ?? '?'}${secs}`;
}

/* ▶ output — a tab of the session pane (bottom right) */
/**
 * The ▶ output tab's body (build card for .tex, live stream otherwise).
 * @param {string} key project key
 * @param {RunInfo | null | undefined} run
 * @returns {string} html
 */
export function runPaneHtml(key, run) {
  const buf = runBufs[key] || '';
  const segs = runSegs[key];
  const bufHtml = segs?.length
    ? segs.map(s => s.fd === 2 ? `<span class="errOut">${esc(s.text)}</span>` : esc(s.text)).join('')
    : esc(buf);
  // .tex runs: a one-glance build card instead of the latexmk spew — you're
  // never going to read 300 lines of pass output; the verdict + parsed
  // problems are the story, and the raw log stays one disclosure away
  if (run && /\.tex$/i.test(run.rel || '')) {
    return `<div class="runPane texRun">
      <div class="texRunBody">${texRunCardHtml(key, run)}
        <details class="trLog texRunCard" style="margin-top:10px;"><summary>full latexmk log</summary>
          <pre id="runPre" data-key="${esc(key)}">${buf ? bufHtml : '<span class="cm">— log appears here —</span>'}</pre>
        </details>
      </div>
      <div class="runFoot"><span>${esc(run.cmdLine || 'run output')}</span>
        ${run.state === 'running' ? '<button id="stopRunBtn" class="stopBtn">⊘ stop</button>' : ''}
        <span class="runStat ${esc(run.state || '')}">${runStatTxt(run)}</span></div>
    </div>`;
  }
  return `<div class="runPane">
    <div class="runJobSlot"></div>
    <pre id="runPre" data-key="${esc(key)}">${buf ? bufHtml : '<span class="cm">— run output appears here —</span>'}</pre>
    <div class="runFoot"><span>${esc(run?.cmdLine || 'run output')}</span>
      ${run?.state === 'running' ? '<button id="stopRunBtn" class="stopBtn">⊘ stop</button>' : ''}
      <span class="runStat ${esc(run?.state || '')}">${runStatTxt(run)}</span></div>
  </div>`;
}

/* The build card itself — also patched in place per pass ping (updateTexRunCard),
   so compiling doesn't cost full re-renders while the user types. */
function texRunCardHtml(key, run) {
  const base = (run.rel || '').split('/').pop();
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  if (run.state === 'running') {
    const n = run.pass?.n || 0;
    const chips = n
      ? Array.from({ length: n }, (_, i) => i + 1 === n
        ? `<span class="trChip run">${esc(run.pass.rule)} · pass ${n}</span>`
        : `<span class="trChip done">pass ${i + 1} ✓</span>`).join('')
      : '<span class="trChip run">starting…</span>';
    const t0 = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const elapsed = Number.isFinite(t0) ? Math.max(0, (Date.now() - t0) / 1000).toFixed(0) : '';
    return `<div class="texRunCard" data-trkey="${esc(key)}">
      <div class="trHead"><span class="big spin">⟳</span> compiling ${esc(base)}
        <span class="meta" id="texRunElapsed" data-t0="${esc(run.startedAt || '')}">${elapsed && `${elapsed}s`}</span></div>
      <div class="trTrack"><div class="fill" style="--p:${passFrac(n)}"></div></div>
      <div class="trStage" id="texRunStage">${chips}</div>
    </div>`;
  }
  const counts = run.counts || { errors: 0, warnings: 0, badboxes: 0 };
  if (run.state === 'done' && !counts.errors) {
    return `<div class="texRunCard ok">
      <div class="trHead"><span class="big">✓</span> compiled clean
        <span class="meta">${run.ms != null ? secs(run.ms) : ''}${run.pages ? ` · ${run.pages} page${run.pages === 1 ? '' : 's'}` : ''}</span></div>
      ${counts.warnings ? `<div class="trWarnNote"><b>${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}</b> — in the strip under the editor</div>` : ''}
    </div>`;
  }
  if (run.state === 'stopped') {
    return `<div class="texRunCard">
      <div class="trHead"><span class="big" style="color:var(--yellow)">⊘</span> compile stopped
        <span class="meta">${run.ms != null ? secs(run.ms) : ''}</span></div>
    </div>`;
  }
  // error (or done-with-errors: nonstopmode can exit 0 while the log screams)
  const errs = (run.problems || []).filter((p) => p.kind === 'error');
  const shown = errs.slice(0, 8);
  const pdfNote = run.pages ? '' : ' — no PDF';
  return `<div class="texRunCard bad">
    <div class="trHead"><span class="big">✗</span> ${errs.length || 'compile'} error${errs.length === 1 ? '' : 's'}${esc(pdfNote)}
      <span class="meta">${run.ms != null ? secs(run.ms) : ''}</span></div>
    ${shown.map((p) => `<div class="trProb" data-pf="${esc(p.file || '')}" data-pl="${esc(p.line || 1)}">
      <span class="loc">${esc(p.file || '')}${p.line ? ':' + esc(p.line) : ''}</span>
      <span class="msg">${esc(p.message || '')}</span></div>`).join('')}
    ${errs.length > shown.length ? `<div class="trMoreNote">… ${errs.length - shown.length} more in the strip under the editor</div>` : ''}
  </div>`;
}

/* Pass pings while a .tex compiles arrive as run:status broadcasts — patch the
   card's bar/chips/clock in place instead of a full renderWB, so typing in the
   editor during a compile is never disturbed. */
/**
 * Patch the .tex build card's bar/chips in place on run:status pass pings.
 * @param {string} key project key
 * @returns {void}
 */
export function updateTexRunCard(key) {
  const run = state.runs[key];
  const card = document.querySelector(`#v-${key} .texRunCard[data-trkey]`);
  if (!card || !run || run.state !== 'running') return;
  const fill = card.querySelector('.trTrack .fill');
  if (fill) {
    // same continuous creep as the viewer bar — re-aiming an in-flight CSS
    // transition continues from the current position, so no jump, no stall
    fill.style.transition = CREEP_EASE;
    fill.style.setProperty('--p', String(creepTarget(run.pass?.n)));
  }
  const stage = card.querySelector('#texRunStage');
  if (stage) {
    const n = run.pass?.n || 0;
    stage.innerHTML = n
      ? Array.from({ length: n }, (_, i) => i + 1 === n
        ? `<span class="trChip run">${esc(run.pass.rule)} · pass ${n}</span>`
        : `<span class="trChip done">pass ${i + 1} ✓</span>`).join('')
      : '<span class="trChip run">starting…</span>';
  }
}

/* ── the ▶ run of a .tex reports on the pdf pane the user is LOOKING at ──
   The one-shot compile's pdf shows as an artifact tab (the live watch is a
   separate machine): map the run record onto the same bar + verdict chip so
   "did my compile work, and how fast" is answered in the viewer either way. */
function texRunPaneEntry(run) {
  if (!run || !/\.tex$/i.test(run.rel || '')) return null;
  if (run.state === 'running') return { state: 'building', pass: run.pass || null };
  // nonstopmode can exit 0 with errors in the log — errors mean ✗ either way
  if (run.state === 'done' && !run.counts?.errors) return { state: 'built', lastBuildMs: run.ms };
  if (run.state === 'error' || run.counts?.errors) return { state: 'error', errorMs: run.ms };
  return { state: 'stopped' }; // clears the bar + chip
}

/**
 * Drive a mounted pdf pane's staged bar/verdict from the matching .tex run.
 * @param {string} key project key
 * @returns {void}
 */
export function syncTexRunPane(key) {
  const run = state.runs[key];
  syncTexRunControls(key); // ▶/⊘ + amber dot ride the same pings
  const e = texRunPaneEntry(run);
  if (!e) return;
  const pdfRel = run.rel.replace(/\.tex$/i, '.pdf');
  pdfPanes[artPaneKey(key, pdfRel)]?.setBuildStatus(e);
}
