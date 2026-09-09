// workbench.js — work surfaces, persistent editor dock, tabs, previews,
// composer, and LaTeX navigation. Monaco owns editor input and view state.

import { hlFor, hlText } from './hl.js';
import { creepTarget, CREEP_EASE } from './pdfPane.js';
import { texOutlineMenu, TEX_EXTS } from './latex/texUi.js';
import {
  enc, esc, OVS_LABEL, statusDot, SHOW_HOURS, hrs, fmtTok, exactTok, tokenTooltip, extOf,
  isPdfFile, isHtmlFile, isDataFile, pinKindOf, pinLabelOf, PIN_ICON, isExtRel,
  toast, confirmBox, unifiedDiffHtml, fmtAgo, texComplete,
} from './util.js';
import {
  state, ui, pdfPanes, tailBufs, snapFileCache, fileCache, drafts,
  runBufs, htmlEdits, snapsCache, pendingPerms,
  composerDrafts, queuedMsgs, pendingComplete, consoleView,
  tasksOf, findTask, taskProvider, agentName, providerState, resolveId,
  perOf, curTask, relOf, isExternalPin, taskTabRemember, taskTabRecall,
  getClosed, persistClosed, extrasOf, persistExtras, extraRel,
} from './store.js';
import { api } from './net.js';
import { openTaskMemory } from './memory.js';
import {
  ensureTranscript, ensureFile, saveFile, closeTab, openExtraTab, ensureDir,
  dirKidsHtml, ensureCard, pickPin, pinFile, removeExternalPin, pinResultsHtml,
  ensureSnaps, liveEditsOf, ensureSnapFile, startHtmlEdit, saveHtmlEdit,
  endHtmlEdit, htmlEditChrome, saveChipState, editorChrome,
} from './files.js';
import { relativizePaths, updateConsole, shownLen, pumps, seedTailBuf } from './console.js';
import { syncRunJobCard } from './jobs.js';
import {
  renderTexProblems, armTexfixRetire, startTexFix, texForwardSearch,
  runFile, stopRunReq, runnableExts, runPaneHtml,
} from './texrun.js';
import {
  getClosedViewers, persistClosedViewers, selectViewer, getAddedViewers,
  persistAddedViewers, addDisplay, proposalPreview, closeProposal,
  mountPdfPane, artPaneKey, artPaneDestroy, mountArtPanes, viewerHtml,
  syncViewerStack,
} from './viewers.js';
import {
  closeDrops, openDropdown, placeSideMenu, setTaskPerm, setTaskEngine,
  setTaskReasoning, sessionBody, sendMsg,
} from './session.js';
import {
  nextUpSectionHtml, wireNextUp, sideChainHtml, feedSectionHtml,
} from './sidebar.js';
import { wireVoice } from './voice.js';
import { stopOrRecall, restoreSavedDraft, recallPending, persistRecallState, submissionSending } from './undoSend.js';
import { catGroup } from './views.js';
import { openModal } from './modal.js';
import { go } from './app.js';
import {
  attachDock as mpAttachDock, parkHost as mpParkHost,
  setFile as mpSetFile, requestSave as mpRequestSave,
  holdEditor as mpHoldEditor, revealAt as mpRevealAt, getPosition as mpGetPosition,
  text as mpText,
} from './monacoPane.js';

const texRunTickers = {}; // project → interval updating the build card's clock

/* ─────────────── LaTeX navigation: open a source file at a line ───────────────
   Used by inverse SyncTeX (double-click in the PDF) and the problems strip.
   The jump is applied by wireWB once the editor for that file exists (the
   file may still be fetching — ensureFile re-renders when it lands). */

let pendingEdJump = null; // { fkey, line, col, at }

/**
 * Open a source file in the center editor and jump to line:col (the pending
 * jump is applied by wireWB once the editor exists — co-located here by the
 * ESM assignment rule).
 * @param {string} key project key
 * @param {string} rel
 * @param {number} line 1-based
 * @param {number} [col] 1-based
 * @returns {void}
 */
export function texOpenAt(key, rel, line, col) {
  const per = perOf(key);
  const task = curTask(key);
  const files = task ? (Array.isArray(task.context?.files) ? task.context.files : []) : [];
  const pinIdx = files.findIndex(f => pinKindOf(f) === 'code' && relOf(key, f) === rel);
  if (pinIdx >= 0 && pinIdx < 12) {
    // selecting a ×-closed pin must also REOPEN it, or tab normalization
    // silently reverts to the first open tab and the line-jump is dropped
    per.fileTab = pinIdx;
    if (task) {
      const closed = getClosed(key, task);
      if (closed.delete(String(files[pinIdx]))) persistClosed(key, task);
    }
  } else {
    // beyond the 12 visible pin tabs (or unpinned) → an ephemeral extra tab
    const extras = extrasOf(key);
    if (!extras.includes(rel)) { extras.push(rel); persistExtras(key); }
    per.fileTab = 'x:' + rel;
  }
  pendingEdJump = { fkey: `${key}::${rel}`, line: Number(line) || 1, col: Number(col) || 1, at: Date.now() };
  renderWB(key);
}

const SNAP_ICON = { modified: '✎', created: '✚', deleted: '✂' };

/* the ±lines cell for one file record (old journal entries lack the counts) */
function snapDeltaHtml(f) {
  const bits = [];
  if (f.adds) bits.push(`<span class="dAdd">+${f.adds.toLocaleString()}</span>`);
  if (f.dels) bits.push(`<span class="dDel">−${f.dels.toLocaleString()}</span>`);
  return bits.join(' ');
}

function snapChip(f) {
  if (f.status === 'created') return 'new';
  if (f.status === 'deleted') return 'deleted';
  return f.edits ? `${f.edits} edit${f.edits === 1 ? '' : 's'}` : 'edited';
}

/* Δ list — every change-set of the task, its files grouped by folder:
   verb · name · edit count · ±lines · ⟲. Click a row → the full inline diff. */
function snapsHtml(key, task) {
  const sc = snapsCache[`${key}/${task.id}`];
  if (!sc || !sc.fetched) return `<pre><span class="cm">— loading change history… —</span></pre>`;
  const liveEd = task.status === 'running' ? liveEditsOf(key, task.id) : null;
  const liveNote = liveEd
    ? `<div class="snapLiveNote"><span class="csEditVerb">✎</span> turn in progress — `
    + `${liveEd.files} file${liveEd.files === 1 ? '' : 's'} changed so far `
    + `(<span class="dAdd">+${(liveEd.adds || 0).toLocaleString()}</span> <span class="dDel">−${(liveEd.dels || 0).toLocaleString()}</span>) · `
    + `the change-set records here when the turn ends</div>`
    : '';
  if (!sc.entries.length) {
    return `<div class="snapList">${liveNote || `<pre><span class="cm">— no recorded changes yet —
every session turn that edits files records a change-set here,
with inline diffs and one-click rewind —</span></pre>`}</div>`;
  }
  const rows = sc.entries.map(e => {
    const when = new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tot = { adds: 0, dels: 0 };
    (e.files || []).forEach(f => { tot.adds += f.adds || 0; tot.dels += f.dels || 0; });
    // group by folder so a big changeset stays scannable
    const groups = new Map();
    (e.files || []).forEach(f => {
      const cut = f.rel.lastIndexOf('/');
      const dir = cut >= 0 ? f.rel.slice(0, cut + 1) : './';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    });
    const fileRows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, fls]) =>
      `<div class="dgrp">${esc(relativizePaths(dir, key, task.id))}</div>`
      + fls.map(f => `
      <div class="dfrow${(f.external || String(f.rel).startsWith('/')) ? ' extPin' : ''}" data-eid="${esc(e.id)}" data-rel="${esc(f.rel)}" title="${esc(f.rel)} — click for the inline diff">
        <span class="verb snapSt ${esc(f.status)}">${(f.external || String(f.rel).startsWith('/')) ? '↗' : (SNAP_ICON[f.status] || '±')}</span>
        <span class="nm">${esc(f.rel.slice(f.rel.lastIndexOf('/') + 1))}</span>
        <span class="cnt">${esc(snapChip(f))}</span>
        <span class="delt">${snapDeltaHtml(f)}</span>
        <button class="snapBtn snapRevertBtn rw" data-eid="${esc(e.id)}" data-rel="${esc(f.rel)}" title="restore ${esc(f.rel)} to before this change">⟲</button>
      </div>`).join('')).join('');
    return `<div class="snapEntry">
      <div class="snapHead">
        <span class="snapKind ${e.revertOf ? 'rew' : ''}">${e.revertOf ? '⟲ rewind' : 'Δ session edit'}</span>
        <span class="snapTime">${esc(when)}</span>
        <span class="snapCount">${e.files.length} file${e.files.length === 1 ? '' : 's'}</span>
        ${tot.adds || tot.dels ? `<span class="delt"><span class="dAdd">+${tot.adds.toLocaleString()}</span> <span class="dDel">−${tot.dels.toLocaleString()}</span></span>` : ''}
        ${e.files.length > 1 ? `<button class="snapBtn snapRevertAll" data-eid="${esc(e.id)}" title="restore every file in this change-set">⟲ rewind all</button>` : ''}
      </div><div class="dlist">${fileRows}</div></div>`;
  }).join('');
  return `<div class="snapList">${liveNote}${rows}</div>`;
}

/* Δ drill-in — one file's full inline unified diff, with a back link, the
   ⟲ rewind we already have, and an edit N/M ◀ ▶ stepper in the footer.
   Returns {body, foot} for workSurface. */
function snapDiffView(key, task, sv) {
  const entry = (snapsCache[`${key}/${task.id}`]?.entries || []).find(e => e.id === sv.eid);
  const f = entry && (entry.files || []).find(x => x.rel === sv.rel);
  const back = `<button class="snapBtn sdvBack" title="back to the change list">← Δ list</button>`;
  const foot0 = `<div class="cfoot"><span>change history — what sessions edited, rewindable</span><span>${esc(task.id)}</span></div>`;
  if (!entry || !f) {
    return { body: `<div class="sdv"><div class="sdvHead">${back}</div><pre><span class="cm">— this change-set is no longer available —</span></pre></div>`, foot: foot0 };
  }
  const fk = `${key}::${sv.eid}::${sv.rel}`;
  const d = snapFileCache[fk];
  if (!d || d.loading) {
    ensureSnapFile(key, sv.eid, sv.rel);
    return { body: `<div class="sdv"><div class="sdvHead">${back}</div><pre><span class="cm">— loading the diff… —</span></pre></div>`, foot: foot0 };
  }
  if (d.error) {
    return { body: `<div class="sdv"><div class="sdvHead">${back}</div><pre><span class="cm">— ${esc(d.error)} —</span></pre></div>`, foot: foot0 };
  }
  const { html, hunks } = unifiedDiffHtml(d.before, d.after, sv.expanded || []);
  // external files (granted pins, addressed by absolute path) get the app's
  // ↗ amber treatment and a folder-name-relative label — full path in title
  const ext = f.external || String(f.rel).startsWith('/');
  const shown = ext ? relativizePaths(f.rel, key, task.id) : f.rel;
  const body = `<div class="sdv">
    <div class="sdvHead">
      ${back}
      <span class="verb snapSt ${esc(f.status)}${ext ? ' extVerb' : ''}">${ext ? '↗' : (SNAP_ICON[f.status] || '±')}</span>
      <span class="sdvRel${ext ? ' extPin' : ''}" title="${esc(f.rel)}">${esc(shown)}</span>
      <span class="cnt">${esc(snapChip(f))}</span>
      <span class="delt">${snapDeltaHtml(f)}</span>
      <button class="snapBtn snapRevertBtn" data-eid="${esc(sv.eid)}" data-rel="${esc(f.rel)}" title="restore this file to before this change">⟲ rewind file</button>
    </div>
    <div class="sdvScroll" data-fk="${esc(fk)}"><div class="udiff">${html}</div></div>
  </div>`;
  const stepper = hunks
    ? `<span class="sdvStepper">edit <b id="sdvHunkNo">${Math.min((sv.hunk ?? 0) + 1, hunks)}</b> / ${hunks}
       <button class="snapBtn sdvStep" data-d="-1" title="previous edit">◀</button>
       <button class="snapBtn sdvStep" data-d="1" title="next edit">▶</button></span>`
    : '';
  const foot = `<div class="cfoot${ext ? ' extFoot' : ''}"><span>${esc(shown)} · ${esc(snapChip(f))}${f.adds || f.dels ? ` · ${f.adds ? '+' + f.adds.toLocaleString() : ''}${f.dels ? ' −' + f.dels.toLocaleString() : ''}` : ''}</span>
    <span style="margin-left:auto">showing the full file · edits in place${stepper ? ' · ' : ''}</span>${stepper}</div>`;
  return { body, foot };
}

function workSurface(key, task, files, fi) {
  const run = state.runs[key]; // run output itself lives in the session pane now
  // focus mode: the console lives in the session pane (right column), so the
  // center strip drops its ≋ tab. renderWB normally resolves a persisted
  // 'tail' to a real visible file first; when there is no such file, show a
  // note instead (#consoleBox ids must stay unique).
  const focusConsole = focusOn();
  if (focusConsole && fi === 'tail') fi = 'focusnote';
  // Δ badge = file changes recorded for this task; a running turn's live count
  // stands in until its change-set lands (so → Δ works mid-turn)
  const snapEntries = snapsCache[`${key}/${task.id}`]?.entries || [];
  const snapCount = snapEntries.reduce((n, e) => n + ((e.files || []).length), 0)
    || (task.status === 'running' ? (liveEditsOf(key, task.id)?.files || 0) : 0);
  const closed = getClosed(key, task);
  const tabs = files.map((f, i) => {
    // closed → sidebar; pdfs → show panel; folders live in the sidebar browser
    if (closed.has(String(f)) || isPdfFile(f) || pinKindOf(f) === 'folder') return '';
    const kind = pinKindOf(f);
    const rel0 = relOf(key, f);
    const dirty = kind === 'code' && rel0 && drafts[`${key}::${rel0}`] != null;
    const icon = kind !== 'code' ? PIN_ICON[kind] + ' ' : '';
    return `<div class="ctab cd ${fi === i ? 'on' : ''}" data-fi="${i}" draggable="true" title="${esc(String(f))} — drag to reorder, or onto another task's tab to open it there">${icon}${esc(pinLabelOf(f))}${dirty ? '<span class="dirtyDot">●</span>' : ''}<span class="tabX" data-xi="${i}" title="close tab — reopen from the sidebar">×</span></div>`;
  }).join('')
    + (perOf(key).openExtra || []).map((rel) => {
      const xid = 'x:' + rel;
      const dirty = drafts[`${key}::${rel}`] != null;
      const ext = isExtRel(rel); // external file → yellow title, ↗ marker
      return `<div class="ctab cd xtab ${ext ? 'xext ' : ''}${fi === xid ? 'on' : ''}" data-fi="${esc(xid)}" title="${esc(rel)} — ${ext ? 'external — editable, ⌘S saves through the pin grant' : 'opened from the folder browser; not in the context packet'}">${ext ? '↗' : '◇'} ${esc(rel.split('/').pop())}${dirty ? '<span class="dirtyDot">●</span>' : ''}<span class="tabX" data-xi="${esc(xid)}" title="close tab">×</span></div>`;
    }).join('')
    + (focusConsole ? '' : `<div class="ctab cd console ${fi === 'tail' ? 'on' : ''}" data-fi="tail" title="the session conversation — thinking, tools, results, answers">≋ console${(pendingPerms[`${key}/${task.id}`] || []).length ? ' <span class="permDot">⏳</span>' : ''}</div>`)
    + (snapCount ? `<div class="ctab cd ${fi === 'snaps' ? 'on' : ''}" data-fi="snaps" title="files this task's sessions changed — inline diffs + rewind">Δ <span class="snapBadge">${snapCount}</span></div>` : '');
  let body, foot;
  if (fi === 'snaps') {
    // a drill-in belongs to one task's change-set — ignore it on any other task
    const sv = perOf(key).snapView;
    if (sv && sv.task === task.id) {
      ({ body, foot } = snapDiffView(key, task, sv));
    } else {
      body = snapsHtml(key, task);
      foot = `<div class="cfoot"><span>change history — what sessions edited, rewindable · click a file for its diff</span><span>${esc(task.id)}</span></div>`;
    }
  } else if (fi === 'tail') {
    const tk = seedTailBuf(key, task);
    body = `<div class="consoleBox" id="consoleBox" data-key="${esc(tk)}"></div>`;
    foot = `<div class="cfoot"><span>≋ console — full session stream</span><span>${esc(task.id)}</span></div>`;
  } else if (fi === 'focusnote') {
    body = `<div class="noCode inViewer"><div class="big">≋</div><div>the console lives in the <b>session pane</b> while focus mode is on</div></div>`;
    foot = `<div class="cfoot"><span>≋ console — in the session pane (focus mode)</span><span>${esc(task.id)}</span></div>`;
  } else {
    const xrel = extraRel(fi);
    const f = xrel ?? files[fi];
    // extras always take the plain file path (binary/data files come back as a
    // read-only notice from ensureFile's binary sniff)
    const pkKind = xrel != null ? 'code' : pinKindOf(f);
    if (pkKind === 'data' || pkKind === 'folder') {
      // cards, not contents — the same thing the session sees at launch
      const crel = relOf(key, String(f).replace(/\/+$/, ''));
      const cc = crel != null ? fileCache[`${key}::card::${crel}`] : { error: 'outside the project root' };
      const content = !cc || cc.loading
        ? `// generating ${pkKind === 'data' ? 'data card (schema · sample · scale)' : 'folder map'}…`
        : cc.error ? `// ${cc.error}` : cc.text;
      body = `<pre>${esc(content)}</pre>`;
      foot = `<div class="cfoot"><span>${esc(String(f))}</span><span>${pkKind === 'data'
        ? '▦ data card — injected at launch; content stays on disk'
        : '🗀 folder map — injected at launch'}</span></div>`;
      return `<div class="codeHalf codeFull"><div class="ctabs">${tabs}</div>${body}${foot}</div>`;
    }
    // external context files are addressed by their absolute path (relOf
    // can't resolve them); they're EDITABLE like pins — saves go through the
    // task's /api/extfile grant (the same allowlist the session writes with)
    const external = isExtRel(f);
    const rel = external ? String(f) : relOf(key, f);
    const fkey = rel ? `${key}::${rel}` : null;
    const c = fkey ? fileCache[fkey] : null;
    const ext = rel ? String(rel).split('/').pop().split('.').pop().toLowerCase() : '';
    // tex ▶ lives in its pdf pane's toolbar once the document HAS a pane
    // — the foot button only bootstraps a never-compiled doc, then
    // yields for good (addedViewers persists, so this is a one-time handoff)
    const texPdfRel = /\.tex$/i.test(rel || '') ? rel.replace(/\.tex$/i, '.pdf') : null;
    const texHasPane = texPdfRel != null && !external && (
      (state.pdf[key] && relOf(key, state.pdf[key].tex) === rel)
      || getAddedViewers(key).some(v => v.rel === texPdfRel)
      || !!pdfPanes[artPaneKey(key, texPdfRel)]);
    const runBit = rel && !external && runnableExts().includes(ext) && !texHasPane
      ? (run?.state === 'running'
        ? `<button id="runFileBtn" class="stopBtn" data-rel="${esc(rel)}" data-running="1">⊘ stop</button>`
        : `<button id="runFileBtn" class="runBtn" data-rel="${esc(rel)}">▶ run</button>`)
      : '';
    if (rel && c && !c.loading && !c.error && !c.truncated) {
      // editable: drafts hold unsaved text so re-renders never lose keystrokes.
      // EXTERNAL pins are editable too — the user gets the same write access
      // the session already has (saves go through the grant route); only
      // binary/oversized externals fall to the read-only branch below
      const isTex = TEX_EXTS.includes(ext);
      body = `<div class="monacoSlot" id="monacoSlot" data-fkey="${esc(fkey)}" data-rel="${esc(rel)}" data-ext="${esc(ext)}"><div class="mpBooting" role="status">Monaco editor loading…</div></div>`;
      const texBits = isTex
        ? `<button id="texOutlineBtn" class="texBtn" title="jump to a section">§ outline</button>
           <button id="texSyncBtn" class="texBtn" title="show this line in the PDF (⌘J)">◎ pdf</button>`
        : '';
      // markdown gets a rendered live preview in the show panel — it tracks
      // this editor's draft as you type
      const mdBits = (ext === 'md' || ext === 'markdown')
        ? `<button id="mdPreviewBtn" class="texBtn" data-rel="${esc(rel)}" title="rendered view in the show panel — live-updates as you type">▤ preview</button>`
        : '';
      body += isTex ? '<div id="texProblems"></div>' : '';
      const chip = saveChipState(fkey, rel);
      foot = `<div class="cfoot${external ? ' extFoot' : ''}"><span>${esc(String(f))}</span>${runBit}${texBits}${mdBits}
        <span id="saveState" class="${chip.cls}" title="${esc(chip.title)}"><i></i>${chip.txt}</span></div>`;
    } else {
      let content;
      if (!rel) {
        content = `<span class="cm">// ${esc(String(f))}\n// outside the project root — cannot preview here</span>`;
      } else if (!c || c.loading) content = `<span class="cm">// loading ${esc(external ? pinLabelOf(f) : rel)}…</span>`;
      else if (c.error) content = `<span class="cm">// could not load ${esc(external ? pinLabelOf(f) : rel)} — ${esc(c.error)}</span>`;
      else content = (!c.binary && hlFor(ext) && hlText(c.text, ext)) || esc(c.text);
      body = `<pre${external ? ' class="extView"' : ''}>${content}</pre>`;
      const status = external ? '↗ external — read-only (binary or too large)'
        : c?.truncated ? 'too large to edit here — read-only'
          : xrel != null ? '◇ unpinned — not in the launch context' : 'pinned context file';
      foot = `<div class="cfoot${external ? ' extFoot' : ''}"><span>${esc(String(f))}</span>${runBit}<span>${status}</span></div>`;
    }
  }
  return `<div class="codeHalf codeFull"><div class="ctabs">${tabs}</div>${body}${foot}</div>`;
}

/* the usage meter's reset countdown, likewise — the ledger only pushes when
   spend changes, but the clock runs regardless */
setInterval(() => { if (qLimits('claude') || qLimits('codex')) tickQuotas(); }, 1000);

/* patch ledger-driven text in the open workbench without a full re-render */
/**
 * Patch the ledger-driven statusbar text in place (30s heartbeat path —
 * never a full renderWB).
 * @param {string} key project key
 * @returns {void}
 */
export function updateLedgerInline(key) {
  const root = document.getElementById('v-' + key);
  if (!root) return;
  const lg = state.ledger?.perProject?.[key] || null;
  const bar = root.querySelector('.statusbar');
  if (bar) {
    // .sbLeft only — the meter is a sibling that gets patched, so a popover the
    // user has open (or is mid-hover on) survives the heartbeat
    syncStatusbar(bar, key, tasksOf(key), lg);
  }
}

/** Refresh a status bar: rebuild the left segments, mount-or-patch the meter. */
/**
 * Build/patch the workbench statusbar (focus toggle · counts · usage meter).
 * @param {Element} bar the .statusbar element
 * @param {string} key project key
 * @param {Task[]} ts the project's tasks
 * @param {{ seconds?: number, tokensIn?: number, tokensOut?: number, costUsd?: number } | null} lg
 *   the project's ledger row
 * @returns {void}
 */
export function syncStatusbar(bar, key, ts, lg) {
  let left = bar.querySelector(':scope > .sbLeft');
  if (!left) {
    bar.textContent = '';
    left = document.createElement('span');
    left.className = 'sbLeft';
    bar.appendChild(left);
  }
  left.innerHTML = statusbarHtml(key, ts, lg);
  left.querySelector('#focusTog')?.addEventListener('click', () => toggleFocus(key));
  for (const provider of ['claude', 'codex']) {
    const selector = `:scope > .quota[data-provider="${provider}"]`;
    const q = bar.querySelector(selector) || mountQuota(bar, provider);
    q.dataset.project = key;
    paintQuota(q);
  }
}

/* ═══════════ usage meter (right end of .statusbar) ═══════════
   Mockup + rationale: docs/quota-mockups/quota-meter.html.

   state.ledger.usage.limits is [{key,name,sub,pct,spent,budget,resetAt}] — the
   rolling session window plus the two weekly ones (lib/ledger.js). The bar
   always shows limits[0], the session window: it is the one actually hit, and a
   slot that means one fixed thing beats one that is occasionally cleverer.

   Built once per workbench and patched thereafter — never innerHTML — because
   the ledger heartbeat rebuilds the status bar every 30s and the countdown
   repaints every second; either would destroy an open popover mid-read. */
const QUOTA_LEAD = 0;
const qLvl = (p) => (p >= 90 ? 'hot' : p >= 70 ? 'warn' : '');

/** ms → `4d 06h` / `1h 47m` / `12m` / `4m 03s`, tightening as it runs out. */
function fmtLeft(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
    m = Math.floor(s % 3600 / 60), sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (d) return `${d}d ${p2(h)}h`;
  if (h) return `${h}h ${p2(m)}m`;
  if (m >= 5) return `${m}m`;
  return `${m}m ${p2(sec)}s`;
}

const qUsage = (provider = 'claude') => provider === 'codex'
  ? providerState('codex').usage || null
  : state.ledger?.usage || null;
const qLimits = (provider = 'claude') => qUsage(provider)?.limits || null;

/** Keep model-specific allowances out of the global meter unless the selected
    task can actually spend them. The provider marks Spark with scopeModel;
    unscoped rows remain the shared/general Codex allowance. */
function visibleQLimits(provider, q) {
  const limits = qLimits(provider);
  if (provider !== 'codex' || !limits) return limits;
  const model = String(curTask(q.dataset.project)?.model || '').toLowerCase();
  return limits.filter((L) => !L.scopeModel
    || model.includes(String(L.scopeModel).toLowerCase()));
}

/** "just now" / "6m ago" / "2h ago" — how stale the plan reading is. */
function qAgo(iso) {
  const s = fmtAgo(iso);
  if (!s) return null;
  if (s === 'now') return 'just now';
  return /^\d/.test(s) ? s + ' ago' : s; // 7d+: fmtAgo gives a date — keep it
}

/** Create the .quota node (with its popover) once, and wire its interactions. */
function mountQuota(bar, provider = 'claude') {
  const q = document.createElement('div');
  q.className = 'quota';
  q.dataset.provider = provider;
  q.tabIndex = 0;
  q.setAttribute('role', 'button');
  q.setAttribute('aria-label', `${agentName(provider)} usage limits`);
  q.setAttribute('aria-expanded', 'false');
  q.innerHTML = `<span class="qlab"></span>`
    + `<span class="qtrack" role="progressbar" aria-valuemin="0" aria-valuemax="100">`
    + `<span class="qfill"></span></span>`
    + `<b class="qpct"></b><span class="qreset">↻ <b>—</b></span>`
    + `<div class="qpop" hidden></div>`;
  bar.appendChild(q);

  const pop = q.querySelector('.qpop');
  let pinned = false, timer = null;
  const open = () => { pop.hidden = false; q.classList.add('open'); q.setAttribute('aria-expanded', 'true'); };
  const close = () => { pop.hidden = true; q.classList.remove('open'); q.setAttribute('aria-expanded', 'false'); };
  q.addEventListener('mouseenter', () => { clearTimeout(timer); timer = setTimeout(open, 110); });
  q.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!pinned) close(); }, 190);
  });
  q.addEventListener('focus', open);
  q.addEventListener('click', (e) => {
    if (e.target.closest('.qpop')) return; // clicking inside must not un-pin
    pinned = !pinned;
    pinned ? open() : close();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pinned = false; close(); q.blur(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinned = !pinned; pinned ? open() : close(); }
  });
  // outside click closes a pinned panel; the listener unregisters ITSELF the
  // first click after a re-render sweeps its node (no teardown event exists)
  const away = (e) => {
    if (!q.isConnected) { document.removeEventListener('click', away); return; }
    if (!q.contains(e.target)) { pinned = false; close(); }
  };
  document.addEventListener('click', away);
  return q;
}

/** Patch an existing .quota (and its popover) from the current ledger. */
function paintQuota(q) {
  const provider = q.dataset.provider || 'claude';
  const limits = visibleQLimits(provider, q);
  if (!limits || !limits.length) {
    q.style.display = 'none';
    q.parentElement?.classList.add(`no-${provider}-quota`);
    return;
  }
  q.style.display = '';
  q.parentElement?.classList.remove(`no-${provider}-quota`);
  const lead = limits[QUOTA_LEAD];
  const left = (L) => (L.resetAt ? Date.parse(L.resetAt) - Date.now() : NaN);

  q.classList.remove('warn', 'hot');
  const k = qLvl(lead.pct); if (k) q.classList.add(k);
  q.querySelector(':scope > .qlab').textContent = provider === 'codex' ? `Codex · ${lead.name}` : lead.key;
  q.querySelector(':scope > .qtrack > .qfill').style.width = lead.pct + '%';
  q.querySelector(':scope > .qtrack').setAttribute('aria-valuenow', lead.pct);
  q.querySelector(':scope > .qpct').textContent = lead.pct + '%';
  q.querySelector(':scope > .qreset > b').textContent = fmtLeft(left(lead));
  q.title = `${lead.name} (${lead.sub}) — ${qDetail(lead)}`
    + (lead.resetAt ? `, resets in ${fmtLeft(left(lead))}` : ', window not open');

  // the popover is the same meter once per limit; rebuild only when the row set
  // changes, otherwise patch so an open panel is never torn out from under the
  // pointer
  const pop = q.querySelector('.qpop');
  const sig = limits.map((L) => L.key).join('|');
  if (pop.dataset.sig !== sig) {
    pop.dataset.sig = sig;
    pop.innerHTML = `<div class="qpH"><span>${agentName(provider)} usage</span><em>click to pin</em></div>`
      + limits.map((L) => `<div class="qpRow" data-key="${esc(L.key)}">`
        + `<span class="qpN" title="${esc(L.fullSub || L.sub)}">${esc(L.name)}<small>${esc(L.sub)}</small></span>`
        + `<span class="qtrack"><span class="qfill"></span></span>`
        + `<b class="qpct"></b><span class="qreset">↻ <b>—</b></span></div>`).join('')
      + `<div class="qpF"></div>`;
  }
  // the footer says where the numbers came from and how old they are — a plan
  // reading is only refreshed by a turn, so it must never look live
  const u = qUsage(provider);
  const foot = pop.querySelector('.qpF');
  if (u && u.source === 'plan') {
    const ago = qAgo(u.fetchedAt);
    foot.innerHTML = `From your ${agentName(provider)} plan${u.subscription ? ' (' + esc(u.subscription) + ')' : ''}`
      + `, as of <b>${esc(ago || 'unknown')}</b> — refreshed when a task runs.`;
  } else {
    foot.innerHTML = `<b>Estimated</b> from this dashboard's own ledger against the budgets in`
      + ` config.json — Claude-attributed tokens only, not your real plan limits or spending.`
      + (u?.unknownProviderTokens ? ` ${exactTok(u.unknownProviderTokens)} historical tokens with unknown provider excluded.` : '');
  }
  limits.forEach((L, i) => {
    const row = pop.querySelector(`.qpRow[data-key="${CSS.escape(L.key)}"]`);
    if (!row) return;
    row.classList.remove('warn', 'hot', 'lead');
    const rk = qLvl(L.pct); if (rk) row.classList.add(rk);
    if (i === QUOTA_LEAD) row.classList.add('lead');
    row.querySelector('.qfill').style.width = L.pct + '%';
    row.querySelector('.qpct').textContent = L.pct + '%';
    row.querySelector('.qreset b').textContent = fmtLeft(left(L));
    row.title = `${L.name} (${L.fullSub || L.sub}) — ${qDetail(L)}`;
  });
}

/** Hover detail for one limit: real windows report a percentage of plan, the
    estimate reports tokens against the configured budget. */
function qDetail(L) {
  return L.real ? `${L.pct}% of your plan's window used`
    : `${exactTok(L.spent)} of ${exactTok(L.budget)} tokens processed (configured-budget estimate, not subscription allowance)`;
}

/** Repaint every mounted meter — the countdown has to move once a second. */
function tickQuotas() {
  document.querySelectorAll('.quota').forEach(paintQuota);
}

// ── focus mode (2026-08-07): per-browser view state, like theme/dividers.
// The statusbar button shows the TARGET layout: two wide panes = "enter
// focus" (sidebar goes away, viewer + console unstack beside the editor),
// three panes with the narrow sidebar = "come back".
/** @type {() => boolean} focus mode (VSCode-style three-pane) on? */
export const focusOn = () => localStorage.focusMode === '1';
const FOCUS_GO = '<svg width="15" height="11" viewBox="0 0 15 11"><rect x="0" y="0" width="6.8" height="11" rx="1"/><rect x="8.2" y="0" width="6.8" height="11" rx="1"/></svg>';
const FOCUS_BACK = '<svg width="15" height="11" viewBox="0 0 15 11"><rect x="0" y="0" width="3.2" height="11" rx="1"/><rect x="5" y="0" width="4.4" height="11" rx="1"/><rect x="10.8" y="0" width="4.2" height="11" rx="1"/></svg>';
function toggleFocus(key) {
  if (focusOn()) localStorage.removeItem('focusMode');
  else localStorage.focusMode = '1';
  renderWB(key); // the skeleton is KEPT — only the .focus class and chrome change
}

function statusbarHtml(key, ts, lg) {
  const running = ts.filter(t => t.status === 'running').length;
  const waiting = ts.filter(t => t.status === 'waiting').length;
  const queued = ts.filter(t => t.status === 'queued').length;
  const segs = [];
  if (running) segs.push(`<span class="g">● ${running} running</span>`);
  if (waiting) segs.push(`<span class="y">⏸ ${waiting} waiting on you</span>`);
  if (queued) segs.push(`<span>${queued} queued</span>`);
  if (!segs.length) segs.push(`<span style="color:var(--dim)">○ idle</span>`);
  if (lg) segs.push(SHOW_HOURS
    ? `<span title="${esc(tokenTooltip(lg, 'Project this week'))}">wk <b>${hrs(lg.seconds)}h</b> · <b class="p">${fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0))} tok processed</b></span>`
    : `<span title="${esc(tokenTooltip(lg, 'Project this week'))}">wk <b class="p">${fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0))} tok processed</b></span>`);
  const focusBtn = `<span class="focusTog" id="focusTog" title="${focusOn()
    ? 'exit focus mode — bring back the sidebar and stacked panes'
    : 'focus mode — hide the sidebar; editor · viewer · console side by side'}">${focusOn() ? FOCUS_BACK : FOCUS_GO}</span>`;
  return focusBtn + segs.join('');
}

// Fixed chrome of the session pane's .chat column: the .sessTabs strip plus
// every non-log child (composer, sessbar, voice hint, closed bar…), measured
// live so state changes move the number with them. `skip` omits the child
// containing that element (autosize measures the composer itself separately).
// Shared by the vsplit floor (renderWB) and the composer cap (wireWB).
function sessChromePx(chat, skip) {
  let px = 28; // .sessTabs strip
  for (const el of chat.children) {
    if (el.classList.contains('log') || (skip && el.contains(skip))) continue;
    const cs = getComputedStyle(el);
    px += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  return px;
}

/**
 * Render the project workbench (skeleton, tab normalization, keep-alive
 * carries, then wireWB).
 * @param {string} key project key
 * @returns {void}
 */
export function renderWB(key) {
  const root = document.getElementById('v-' + key);
  if (!root || !state.projects[key]) return;
  const per = perOf(key);
  // a live WYSIWYG edit is modal for this project: re-rendering would reload
  // the iframe and destroy the edits, so hold the frame until ✓ done
  if (per.htmlEdit && htmlEdits[key] && root.querySelector('#htmlEditFrame')) return;
  const ts = tasksOf(key);
  const task = curTask(key);
  const lg = state.ledger?.perProject?.[key] || null;

  // show-panel viewer list: pdf watch + project's html artifacts (+ a clicked pdf artifact)
  const viewers = [];
  const pdfEntry = state.pdf?.[key];
  if (pdfEntry) viewers.push({ kind: 'pdf', key: 'pdf', label: '◫ ' + (pdfEntry.pdf ? String(pdfEntry.pdf).split('/').pop() : 'live pdf') });
  state.artifacts.filter(a => a.project === key && a.kind === 'html').slice(0, 8)
    .forEach(a => viewers.push({ kind: 'html', key: a.rel, label: '⌗ ' + a.name }));
  // Pinned PDFs and HTML remain available even outside the recent-artifact
  // window. HTML also keeps its source tab; external pins remain text-only.
  const watchRel = pdfEntry?.pdf ? relOf(key, pdfEntry.pdf) : null;
  (task && Array.isArray(task.context?.files) ? task.context.files : [])
    .filter(f => isPdfFile(f) || isHtmlFile(f))
    .forEach(f => {
      const rel = relOf(key, f);
      if (!rel || rel === watchRel || viewers.some(v => v.key === rel)) return;
      const pdf = isPdfFile(f);
      viewers.push({ kind: pdf ? 'pdfart' : 'html', key: rel, label: (pdf ? '◫ ' : '⌗ ') + String(f).split('/').pop() });
    });
  // displays added by hand via ＋ or a .tex ▶ (dedup against artifacts/pinned
  // pdfs). MUST come before the selected-key fallback below: an added tab that
  // happens to be selected would otherwise be claimed there first and jump to
  // the front of the strip — clicking between two added pdfs swapped them.
  getAddedViewers(key).forEach(v => {
    if (viewers.some(x => x.key === v.rel)) return;
    const glyph = v.kind === 'pdfart' ? '◫ ' : v.kind === 'md' ? '▤ ' : '⌗ ';
    viewers.push({ kind: v.kind, key: v.rel, label: glyph + String(v.rel).split('/').pop() });
  });
  if (per.viewerKey && per.viewerKey !== 'pdf' && per.viewerKey !== '__proposal' && !viewers.some(v => v.key === per.viewerKey)) {
    const a = state.artifacts.find(x => x.project === key && x.rel === per.viewerKey);
    if (a) {
      viewers.push({ kind: a.kind === 'pdf' ? 'pdfart' : 'html', key: a.rel, label: (a.kind === 'pdf' ? '◫ ' : '⌗ ') + a.name });
    } else if (/\.(pdf|html?)$/i.test(per.viewerKey)) {
      // any viewable file (e.g. a paper opened from a folder pin) gets an
      // ephemeral tab — it lives while selected, no pinning required
      const isPdf = /\.pdf$/i.test(per.viewerKey);
      viewers.push({ kind: isPdf ? 'pdfart' : 'html', key: per.viewerKey, label: (isPdf ? '◫ ' : '⌗ ') + per.viewerKey.split('/').pop() });
    } else if (/\.(md|markdown)$/i.test(per.viewerKey)) {
      // markdown renders client-side (marked + KaTeX, console typography);
      // the pane live-updates while the same file is open in the editor
      viewers.push({ kind: 'md', key: per.viewerKey, label: '▤ ' + per.viewerKey.split('/').pop() });
    } else if (isDataFile(per.viewerKey)) {
      // data files get a server-rendered head-of-table preview (pandas)
      viewers.push({ kind: 'datav', key: per.viewerKey, label: '▦ ' + per.viewerKey.split('/').pop() });
    }
  }
  // user-arranged tab order (drag a tab onto another; persisted per project);
  // tabs not in the saved order keep their natural recency order, after it.
  // Added viewers are in the array by now, so dragging THEM sticks too.
  let vOrder = [];
  try { vOrder = JSON.parse(localStorage.getItem(`viewerOrder:${key}`) || '[]'); } catch { /* corrupt */ }
  if (Array.isArray(vOrder) && vOrder.length) {
    const pos = new Map(vOrder.map((k2, i) => [k2, i]));
    const nat = new Map(viewers.map((v, i) => [v.key, i]));
    viewers.sort((a, b) =>
      (pos.has(a.key) ? pos.get(a.key) : 1e9 + nat.get(a.key)) -
      (pos.has(b.key) ? pos.get(b.key) : 1e9 + nat.get(b.key)));
  }

  // a pending proposal preview gets a tab of its own
  if (proposalPreview[key]) {
    viewers.unshift({ kind: 'proposal', key: '__proposal', label: '⌗ ' + proposalPreview[key].title });
  }

  // drop tabs the user closed with × (the live 'pdf' watch tab is never
  // hidden — its × unwatches instead; explicit selection reopens a closed tab)
  const closedV = getClosedViewers(key);
  if (closedV.size) {
    for (let i = viewers.length - 1; i >= 0; i--) {
      if (viewers[i].key !== 'pdf' && closedV.has(viewers[i].key)) viewers.splice(i, 1);
    }
  }

  const vsel = viewers.find(v => v.key === per.viewerKey) || viewers[0] || null;
  if (vsel) per.viewerKey = vsel.key;

  // pinned context files for the current task
  const files = task ? (Array.isArray(task.context?.files) ? task.context.files : []).slice(0, 12) : [];
  const closedSet = task ? getClosed(key, task) : new Set();
  // hydrate the persisted ◇ extra tabs BEFORE tab normalization — this is
  // what lets a refreshed page restore both the tabs and the 'x:' taskTab
  // recall (an empty list used to silently reset the remembered tab)
  extrasOf(key);
  // a visible code-pin tab supersedes an ephemeral tab for the same file
  // (covers pins added from another client — pinFile only dedupes locally)
  if (per.openExtra?.length) {
    const n0 = per.openExtra.length;
    per.openExtra = per.openExtra.filter(r =>
      !files.some(f => pinKindOf(f) === 'code' && relOf(key, f) === r));
    if (per.openExtra.length !== n0) persistExtras(key);
  }
  let fi = per.fileTab;
  // undefined = nothing chosen this session (fresh load) → recall the task's
  // last tab; null = an explicit reset (task deleted, tab closed) → default
  if (fi === undefined && task) fi = taskTabRecall(key, task.id);
  if (fi === 'run') fi = null; // legacy — run output lives in the session pane now
  if (fi === 'snaps' && !(task && (snapsCache[`${key}/${task.id}`]?.entries?.length
    || (task.status === 'running' && liveEditsOf(key, task.id))))) fi = null;
  if (extraRel(fi) != null && !(per.openExtra || []).includes(extraRel(fi))) fi = null;
  if (typeof fi === 'number' && (fi >= files.length || closedSet.has(String(files[fi]))
    || isPdfFile(files[fi]) || pinKindOf(files[fi]) === 'folder')) fi = null;
  const firstOpen = files.findIndex(f =>
    !closedSet.has(String(f)) && !isPdfFile(f) && pinKindOf(f) !== 'folder');
  if (fi == null) {
    fi = firstOpen >= 0 ? firstOpen : 'tail';
  }
  // In focus mode the console is already visible in the right pane, and its
  // old center-tab selection has nowhere to render. Repair a persisted 'tail'
  // through the same visible-tab rules above — never blindly use files[0],
  // which may be a PDF, folder, or closed pin. An extra editor tab is the next
  // valid fallback; with no editor surface at all, workSurface shows a note.
  if (focusOn() && fi === 'tail') {
    if (firstOpen >= 0) fi = firstOpen;
    else if (per.openExtra?.length) fi = 'x:' + per.openExtra[0];
  }
  per.fileTab = fi;
  // every render passes here, so the per-task memory tracks the SETTLED tab
  // for free — no instrumentation on the dozen call sites that set fileTab
  if (task) taskTabRemember(key, task.id, fi);

  const prevPin = root.querySelector('#pinSearch');
  const pinFocused = !!prevPin && document.activeElement === prevPin;
  const prevComp = root.querySelector('#composerInput');
  const compState = prevComp && document.activeElement === prevComp
    ? { selStart: prevComp.selectionStart, selEnd: prevComp.selectionEnd } : null;
  // carry the live console DOM across the render: rebuilding it re-parses and
  // re-typesets the whole transcript (visible flash) and loses scroll position.
  // Capture at-bottom-ness too: content height changes between renders (verb
  // line, final typeset), so "stay at the bottom" must be restored as intent,
  // not as a stale pixel offset
  const prevConsole = root.querySelector('#consoleBox');
  const consoleKeep = prevConsole ? {
    el: prevConsole,
    scrollTop: prevConsole.scrollTop,
    stick: prevConsole.scrollTop + prevConsole.clientHeight >= prevConsole.scrollHeight - 30,
    key: prevConsole.dataset.key,
  } : null;
  // persist the outgoing console's scroll/follow per task — on a task switch the
  // live node is discarded (its key no longer matches, so consoleKeep can't
  // carry it), and without this the returning task would snap back to the bottom.
  // Guard on clientHeight: a renderWB on a HIDDEN project view (returning to a
  // project — renderWB runs before .show) reads scrollTop 0, which would clobber
  // the real value saved on leave; only harvest a console that has layout.
  if (prevConsole && prevConsole.clientHeight) consoleView[prevConsole.dataset.key] = {
    scrollTop: prevConsole.scrollTop,
    follow: prevConsole._follow !== false,
  };
  // ▶ output scroll: stick to the bottom unless the user scrolled up to read
  const prevRun = root.querySelector('#runPre');
  const runKeep = prevRun ? {
    scrollTop: prevRun.scrollTop,
    stick: prevRun.scrollTop + prevRun.clientHeight >= prevRun.scrollHeight - 30,
  } : null;
  // the build card's ▸ full-log disclosure: an innerHTML rebuild would slam it
  // shut mid-read — carry the open state across renders
  const trLogOpen = !!root.querySelector('.texRunBody > .trLog[open]');
  // and its progress bar: a mid-compile rebuild (artifact:new lands while the
  // run is live) must not visibly reset the bar — capture the ACTUAL rendered
  // position (mid-transition), not the transition's target
  let trBarKeep = null;
  {
    const f = root.querySelector('.texRunCard .trTrack .fill');
    const t = f ? getComputedStyle(f).transform : null;
    if (t && t !== 'none') trBarKeep = new DOMMatrixReadOnly(t).a; // scaleX
  }
  // session-pane chat: same treatment — a render (e.g. switching a show-panel
  // tab) must not slam a scrolled-up chat back to the bottom
  const prevChat = root.querySelector('#chatLog');
  const chatKeep = prevChat ? {
    scrollTop: prevChat.scrollTop,
    stick: prevChat.scrollTop + prevChat.clientHeight >= prevChat.scrollHeight - 30,
  } : null;
  // sidebar lineage chain: hold the scroll across renders; a task switch
  // instead defaults to the current node at the bottom (parent visible above)
  const prevSch = root.querySelector('.sideChain');
  const schKeep = prevSch ? { tid: prevSch.dataset.tid, scrollTop: prevSch.scrollTop } : null;

  // persistent skeleton: each render refills the slots below, never the root —
  // so the viewer slot can keep its loaded artifact iframes mounted across
  // renders (detaching an iframe from the DOM forces the browser to reload it)
  let wb = root.querySelector(':scope > .wb');
  if (!wb) {
    // A7: the kept Monaco host must never sit inside a subtree that is about
    // to be innerHTML-replaced — evacuate it first (steady-state no-op: the
    // skeleton is built exactly once, before any dock exists). The .mdock
    // below is the dock: a PERSISTENT sibling of the refilled slots
    // (statusbar/meter idiom) that the slot refills further down never touch.
    if (root.querySelector('.mpHost')) mpParkHost();
    root.innerHTML = `<div class="wb">
      <div class="side"></div>
      <div class="sdivider" title="drag to resize"></div>
      <div class="pane"></div>
      <div class="vdivider" title="drag to resize"></div>
      <div class="pane">
        <div class="ptabs vtabs"></div>
        <div class="pbody rpb">
          <div class="vslot"></div>
          <div class="hdivider" title="drag to resize"></div>
          <div class="fdivider" title="drag to resize"></div>
          <div class="sessHalf"></div>
        </div>
      </div>
      <div class="mdock"></div>
    </div>
    <div class="statusbar"></div>`;
    wb = root.querySelector(':scope > .wb');
    wireDividers(root); // the divider nodes persist — wire them exactly once
  }
  // editHold greys + disables the workbench (incl. the composer's .sessHalf)
  // while a WYSIWYG edit is live — but ONLY when the edited file is the shown
  // viewer. Without the viewerKey check, switching the viewer away (or to
  // another project and back) strands editHold, dead-locking the composer with
  // no visible edit. (renderWB bails above while the edit frame is mounted, so
  // this line only runs when the frame is NOT the active viewer.)
  const editHold = !!htmlEdits[key] && per.viewerKey === htmlEdits[key].rel;
  wb.classList.toggle('editHold', editHold);
  // C2-MF5 (P17, blueprint §2 "Layout & editHold" row): the CSS above only
  // silences POINTERS — the kept Monaco dock is a position:fixed SIBLING of
  // the greyed panes, so a focused editor would keep typing into the buffer
  // under a live hold. The seam blurs + pins readOnly at raise and unpins at
  // release, driven by the SAME expression as the class so the grey and the
  // keyboard can never diverge (raise on the mounting render, release on the
  // ✓ done / strand-recovery render; transition-only, tolerates
  // not-booted/no-editor). The ui.view gate keeps a hypothetical background
  // render of ANOTHER project from releasing the visible project's pin —
  // the kept editor is a singleton, the class is per-view DOM.
  if (ui.view === key) mpHoldEditor(editHold);
  wb.classList.toggle('focus', focusOn()); // focus mode: CSS re-layout on the kept skeleton

  wb.querySelector(':scope > .side').innerHTML = `
      <div class="sh">Task goal</div>
      <div class="abstract">${task ? esc(task.description || task.title || '') : 'no task selected'}</div>
      ${task ? `<div class="taskActs">
        <button class="tact" id="taskMemoryBtn" title="Inspect background checkpoints; conversations are unchanged">◫ memory</button>
        ${!task.archived && task.status !== 'done'
        ? `<span class="tact complete" id="completeTask" title="have ${agentName(taskProvider(task))} write its handoff report, then mark the task done &amp; archive it (a billed turn)">✓ complete</span>`
        : ''}
        ${task.archived
        ? '<span class="tact" id="unarchTask" title="restore to the tab strip and overview">▣ unarchive</span>'
        : '<span class="tact" id="archTask" title="hide from tabs & overview — keeps transcript, handoff, history">▣ archive</span>'}
        <span class="tact danger" id="delTask" title="permanently delete the task, its transcript and change history — files it created stay on disk">✕ delete</span>
      </div>` : ''}
      <div class="sh">⛓ Lineage <span class="anno" style="margin-left:6px">this task</span>
        ${task ? '<span id="linAddBtn" class="pinAdd" title="link an upstream task — its handoff feeds this task">＋</span>' : ''}</div>
      ${task ? sideChainHtml(key, task) : '<div class="sideNote">no tasks yet</div>'}
      <div class="sh">▮ Pinned files <span class="anno" style="margin-left:6px">context</span>
        ${task ? '<span id="pinAddBtn" class="pinAdd" title="pin a file or folder to this task">＋</span>' : ''}</div>
      ${task && per.pinOpen ? `<div class="pinPick">
        <input id="pinSearch" placeholder="search project files…" value="${esc(per.pinQ || '')}"
          autocomplete="off" spellcheck="false">
        <div id="pinResults">${pinResultsHtml(key, task)}</div></div>` : ''}
      ${files.length ? files.map((f, i) => {
        const kind = pinKindOf(f);
        if (isExternalPin(key, f)) {
          // outside the project root — grants the session read/edit access.
          // Folders expand to browse (like in-project 🗀 pins); files open
          // read-only in the center pane. × revokes access.
          const abs = String(f).replace(/\/+$/, '');
          const rm = `<span class="tabX" data-extrm="${esc(String(f))}" title="revoke access — unpin this external path">×</span>`;
          if (kind === 'folder') {
            const open = per.openDirs?.has(abs);
            let row = `<div class="scRow extPin extDir" data-extdk="${esc(abs)}"
              title="external folder — the task agent has read/edit access; click to browse ${esc(String(f))}">
              <span class="nm">${open ? '▾' : '▸'} ↗ 🗀 ${esc(pinLabelOf(f))}</span><span class="lang">ext</span>${rm}</div>`;
            if (open) row += dirKidsHtml(key, abs, 1);
            return row;
          }
          const ic = kind === 'data' ? '▦' : kind === 'pdf' ? '◫' : '▮';
          return `<div class="scRow extPin extFile ${fi === 'x:' + abs ? 'sel' : ''}" data-extfk="${esc(abs)}"
            title="external — you and the session can both edit it; click to open ${esc(String(f))}">
            <span class="nm">↗ ${ic} ${esc(pinLabelOf(f))}</span><span class="lang">ext</span>${rm}</div>`;
        }
        if (kind === 'pdf') {
          const rel = relOf(key, f);
          return `<div class="scRow ${rel && per.viewerKey === rel ? 'sel' : ''}" data-fi="${i}" draggable="true"
            title="pdf — opens in the show panel"><span class="nm">◫ ${esc(pinLabelOf(f))}</span><span class="lang">pdf</span></div>`;
        }
        const isClosed = kind !== 'folder' && closedSet.has(String(f)); // folders have no tab to close
        const icon = isClosed ? '○' : PIN_ICON[kind];
        const chip = kind === 'data' ? 'data' : kind === 'folder' ? 'dir' : esc(extOf(f));
        const frel = kind === 'folder' ? relOf(key, String(f).replace(/\/+$/, '')) : null;
        const dirOpen = frel != null && per.openDirs?.has(frel);
        const selCls = kind === 'folder' ? (dirOpen ? 'sel' : '') : (fi === i ? 'sel' : '');
        let row = `<div class="scRow ${selCls} ${isClosed ? 'closed' : ''}" data-fi="${i}" draggable="true"
          title="${isHtmlFile(f) ? 'open source in edit and rendered HTML in view' : isClosed ? 'closed — click to reopen' : kind === 'data' ? 'data pin — schema card, not contents' : kind === 'folder' ? 'click to browse the folder' : 'drag to reorder'}"><span class="nm">${icon} ${esc(pinLabelOf(f))}</span><span class="lang">${chip}</span></div>`;
        if (dirOpen) row += dirKidsHtml(key, frel, 1);
        return row;
      }).join('')
        : '<div class="sideNote">no pinned context files on this task</div>'}
      ${nextUpSectionHtml(key, task)}
      ${feedSectionHtml(key, ts, task)}`;

  wb.querySelector(':scope > .pane').innerHTML = `
      <div class="ptabs">
        ${ts.filter(t => !t.archived || (task && t.id === task.id)).map(t => `<div class="ptab tk ${task && t.id === task.id ? 'on' : ''}" data-id="${esc(t.id)}">
          <span class="tdot ${statusDot(t.status)}"></span>${t.archived ? '▣ ' : ''}${esc(t.title)}
          <span class="ovs ${esc(t.oversight)}" style="font-size:7.5px;">${OVS_LABEL[t.oversight] || ''}</span>${t.status === 'done' && !t.archived
            ? `<span class="tabX" data-ax="${esc(t.id)}" title="clear the tab — reopen it later from the overview’s Recent tasks">×</span>` : ''}</div>`).join('')}
        <div class="ptab plus" id="newTaskTab" title="new task in ${esc(key)}">＋</div>
      </div>
      <div class="pbody">${task
        ? workSurface(key, task, files, fi)
        : `<div class="noCode"><div class="big">▮</div><div>no tasks in <b>${esc(state.projects[key]?.name || key)}</b> — hit <b>＋</b></div></div>`}</div>`;

  wb.querySelector('.vtabs').innerHTML = `
        ${viewers.map(v => `<div class="ptab vw ${vsel && v.key === vsel.key ? 'on' : ''}" data-vk="${esc(v.key)}" draggable="true" title="${esc(v.key)} — drag to rearrange">${esc(v.label)}${v.kind === 'pdf' ? ' <span style="color:var(--green);font-size:10px;">●</span>' : ''}<span class="tabX" data-vx="${esc(v.key)}" title="${v.kind === 'pdf' ? 'stop watching this .tex' : 'close — reopen from the sidebar or a folder pin'}">×</span></div>`).join('')}
        <div class="ptab plus" id="addViewBtn" title="add a display — .html/.pdf to show, or a .tex to live-compile">＋</div>`;

  // the viewer slot: keep the live iframe stack whenever the selection is a
  // plain artifact and the slot already holds a stack; rebuild it otherwise
  // (live pdf watch, proposal preview, WYSIWYG edit, empty state)
  // release panes whose tabs are gone — the DOM sweep below only covers the
  // keepStack path; a pane can also vanish via a non-artifact re-render
  // (unwatch, proposal, empty state), and each holds a live PDF.js worker doc
  {
    const live = new Set(viewers.map(v => v.key));
    for (const pk of Object.keys(pdfPanes)) {
      if (pk === key && !live.has('pdf')) {
        pdfPanes[pk].destroy();
        delete pdfPanes[pk];
      } else if (pk.startsWith(key + '::') && !live.has(pk.slice(key.length + 2))) {
        pdfPanes[pk].destroy();
        delete pdfPanes[pk];
      }
    }
  }

  const vslot = wb.querySelector('.vslot');
  const liveTop = vslot.querySelector(':scope > .viewerTop');
  const keepStack = !!(liveTop && !htmlEdits[key]
    && vsel && (vsel.kind === 'html' || vsel.kind === 'pdfart' || vsel.kind === 'datav' || vsel.kind === 'md')
    && liveTop.querySelector(':scope > .artFrame[data-vk]')
    && liveTop.querySelector(':scope > .viewerBar'));
  if (keepStack) {
    const live = new Set(viewers.map(v => v.key));
    liveTop.querySelectorAll(':scope > .artFrame[data-vk]').forEach(f => {
      if (!live.has(f.dataset.vk)) {
        // its tab was closed; pdf panes also release their document + timers
        if (f.classList.contains('pdfPane')) artPaneDestroy(key, f.dataset.vk);
        else f.remove();
      }
    });
    syncViewerStack(liveTop, key, vsel);
  } else {
    vslot.innerHTML = viewerHtml(key, vsel, pdfEntry);
  }

  // session pane (bottom right): tabbed — ⌘ session + ▶ output when a run exists
  {
    const run = state.runs[key];
    const hasRun = !!(run || runBufs[key]);
    let st = per.sessTab;
    if (st === 'run' && !hasRun) st = null;
    st = st || 'sess';
    per.sessTab = st;
    const sessTabs = `<div class="sessTabs">
      <div class="stab ${st === 'sess' ? 'on' : ''}" data-st="sess">${task
        ? `<span class="tdot ${statusDot(task.status)}"></span><span class="stitle">⌘ session · ${esc(task.title)}</span>
           <span class="ovs ${esc(task.oversight)}">${OVS_LABEL[task.oversight] || ''}</span>`
        : '⌘ session'}</div>
      ${hasRun ? `<div class="stab runT ${st === 'run' ? 'on' : ''}" data-st="run">▶ output${run?.state === 'running' ? '<span class="runSpin">⟳</span>' : ''}</div>` : ''}
    </div>`;
    const sessBody = st === 'run'
      ? runPaneHtml(key, run)
      : task ? sessionBody(key, task)
        : `<div class="taskHero"><div class="sideNote">no task selected</div></div>`;
    wb.querySelector('.sessHalf').innerHTML = sessTabs + sessBody;
  }

  syncStatusbar(root.querySelector(':scope > .statusbar'), key, ts, lg);

  armTexfixRetire(key); // success state can arrive via any render path
  {
    const freshLog = root.querySelector('.texRunBody > .trLog');
    if (freshLog && trLogOpen) freshLog.open = true;
    // resume the card's bar from exactly where it was, then re-arm the creep
    const freshFill = root.querySelector('.texRunCard[data-trkey] .trTrack .fill');
    if (freshFill && state.runs[key]?.state === 'running') {
      if (trBarKeep != null) {
        freshFill.style.transition = 'none';
        freshFill.style.setProperty('--p', String(trBarKeep));
        void freshFill.offsetWidth;
      }
      freshFill.style.transition = CREEP_EASE;
      freshFill.style.setProperty('--p', String(creepTarget(state.runs[key].pass?.n)));
    }
    const freshRun = root.querySelector('#runPre');
    if (freshRun) {
      freshRun.scrollTop = runKeep && !runKeep.stick ? runKeep.scrollTop : freshRun.scrollHeight;
    }
    const freshChat = root.querySelector('#chatLog');
    if (freshChat) {
      freshChat.scrollTop = chatKeep && !chatKeep.stick ? chatKeep.scrollTop : freshChat.scrollHeight;
    }
    const freshSch = root.querySelector('.sideChain');
    if (freshSch) {
      if (schKeep && schKeep.tid === freshSch.dataset.tid) freshSch.scrollTop = schKeep.scrollTop;
      else {
        // center the current task (parent peeking above, child below). During
        // go() the view is still display:none and all sizes read 0 — place on
        // the next frame, after renderAll's show toggle
        const place = () => {
          const cur = freshSch.querySelector('.schNode.cur');
          if (cur) freshSch.scrollTop = cur.offsetTop - (freshSch.clientHeight - cur.offsetHeight) / 2;
        };
        if (freshSch.clientHeight) place();
        else requestAnimationFrame(place);
      }
    }
  }

  // swap the freshly-rendered empty console for the preserved live one BEFORE
  // wiring, so updateConsole appends to it instead of rebuilding
  if (consoleKeep) {
    const fresh = root.querySelector('#consoleBox');
    if (fresh && fresh.dataset.key === consoleKeep.key) {
      fresh.replaceWith(consoleKeep.el);
      consoleKeep.el.scrollTop = consoleKeep.stick
        ? consoleKeep.el.scrollHeight : consoleKeep.scrollTop;
    }
  }

  wireWB(root, key, task, files);

  // Phase 3 S1 seams (frozen): the monaco path routes the rendered slot's
  // file into the kept editor SYNCHRONOUSLY — M1 creation / reattach
  // reconciliation + the host's #codeEditor datasets happen inside setFile
  // before this render returns — then reconciles the dock (kicks the A6 boot
  // on the first editable open; both are hidden no-ops on the legacy path).
  {
    const slot = root.querySelector('#monacoSlot');
    if (slot && slot.dataset.fkey) {
      const fk = slot.dataset.fkey;
      const c = fileCache[fk];
      mpSetFile(fk, c && !c.loading && !c.error && typeof c.text === 'string' ? c.text : null,
        { mtimeMs: c?.mtimeMs ?? null, ext: slot.dataset.ext || '' });
      // the save chip stays clickable in monaco mode — it just rides the M3
      // token queue instead of files.saveFile (⌘S/⌘⏎ are monacoPane editor
      // commands; this is the same queue, so a click mid-flight coalesces)
      const sc = root.querySelector('#saveState');
      if (sc) sc.addEventListener('click', () => {
        if (drafts[fk] != null) mpRequestSave(fk);
      });
      // Phase 3 S2.5 (I5): the monaco jump consumer — mpSetFile above already
      // ran the attach's viewState restore SYNCHRONOUSLY, so landing the
      // pending jump here beats the remembered viewport by ordering. Same 15s
      // TTL as applyEdJump; a revealAt refusal (boot pending, file still
      // fetching → no model yet) keeps the jump armed for the next render.
      // This is what un-deadens the problems-strip row click and inverse
      // SyncTeX under monaco — both funnel through texOpenAt unchanged.
      if (pendingEdJump && pendingEdJump.fkey === fk) {
        if (Date.now() - pendingEdJump.at > 15000) pendingEdJump = null; // stale
        else if (mpRevealAt(fk, pendingEdJump.line, pendingEdJump.col, { flash: true })) {
          pendingEdJump = null;
        }
      }
      // S2.5 (P7/P12): ◎ and § under monaco — their legacy handlers live in
      // wireWB's textarea#codeEditor-only branch and are verifiably dead here
      if (TEX_EXTS.includes(slot.dataset.ext)) {
        root.querySelector('#texSyncBtn')?.addEventListener('click', () => {
          // forward SyncTeX: the SAME texForwardSearch flow as legacy past
          // the caret-read, retargeted through the getPosition seam (1-based)
          const p = mpGetPosition();
          if (p) texForwardSearch(key, slot.dataset.rel, p.line, p.col);
        });
        root.querySelector('#texOutlineBtn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          // the shared § dropdown over a {value} shim (it reads ed.value
          // once; zero legacy diff) — picks jump through revealAt + flash
          texOutlineMenu(e.currentTarget, { value: mpText(fk) ?? '' }, (ln) => {
            mpRevealAt(fk, ln, 1, { flash: true });
          });
        });
      }
    }
  }
  mpAttachDock(root, key);

  if (pinFocused) {
    const pin = root.querySelector('#pinSearch');
    if (pin) {
      pin.focus();
      pin.setSelectionRange(pin.value.length, pin.value.length);
    }
  }
  if (compState) {
    const comp = root.querySelector('#composerInput');
    if (comp) {
      comp.focus();
      try { comp.setSelectionRange(compState.selStart, compState.selEnd); } catch { /* stale range */ }
    }
  }

  if (task) {
    ensureTranscript(key, task.id);
    ensureSnaps(key, task.id);
    const xrel = extraRel(fi);
    if (xrel != null) ensureFile(key, xrel);
    else if (typeof fi === 'number' && files[fi] != null) {
      const kind = pinKindOf(files[fi]);
      const f = String(files[fi]).replace(/\/+$/, '');
      if (isExtRel(f)) {
        // external pins are addressed by their absolute path (relOf can't
        // resolve them) — without this, the pin's TAB showed "loading…"
        // forever while the sidebar-row path worked
        if (kind === 'code') ensureFile(key, f);
      } else {
        const rel = relOf(key, f);
        if (rel != null) {
          if (kind === 'data') ensureCard(key, rel); // folders have no center tab
          else if (kind === 'code') ensureFile(key, rel);
        }
      }
    }
  }
}

function dragTrack(onMove) {
  // shared drag plumbing: disables iframe pointer-events so the drag
  // doesn't die the moment the cursor crosses an embedded artifact.
  return (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
    const move = (ev) => onMove(ev);
    const up = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function wireDividers(root) {
  const wb = root.querySelector('.wb');
  const rpb = root.querySelector('.rpb');

  // restore persisted sizes
  const savedSide = localStorage.getItem('wbSidePx');
  if (wb && savedSide) wb.style.setProperty('--wb-side', savedSide + 'px');
  const savedCol = localStorage.getItem('wbCenterPx');
  if (wb && savedCol) wb.style.setProperty('--wb-center', savedCol + 'px');
  const savedF = localStorage.getItem('wbFSplit'); // focus viewer/console split
  if (rpb && savedF) rpb.style.setProperty('--fsplit', savedF + '%');
  // the session pane's height floor: its FIXED chrome (tabs strip + every
  // non-log .chat child — composer, sessbar, voice hint, closed bar…) plus a
  // sliver of the grey log gap. Measured live, so state changes (voice chip,
  // wrapped sessbar rows) move the floor with them. The grey gap absorbs
  // shrinking; the buttons never clip.
  const sessMinPx = () => {
    const chat = root.querySelector('.sessHalf .chat');
    if (!chat) return 140; // hero/queued states — a modest generic floor
    return sessChromePx(chat) + 26;
  };
  // vsplit % ceiling for the current geometry (sessHalf spans vsplit+2% → 14px)
  const vsplitMax = () => {
    if (!rpb) return 82;
    const h = rpb.getBoundingClientRect().height;
    if (!h) return 82;
    return Math.min(82, Math.max(15, ((h - 14 - sessMinPx()) / h) * 100 - 2));
  };
  const savedSplit = localStorage.getItem('wbVSplit');
  if (rpb && savedSplit) {
    // clamp on apply too: a % saved on a tall window can clip on a short one.
    // Apply immediately (best effort — the view may render hidden or before
    // fonts settle, both of which under-measure the chrome), then re-measure
    // and re-apply after layout settles so the SETTLED geometry always wins.
    const applyClamped = () => {
      if (!rpb.isConnected) return; // this render was replaced
      const v = Number(savedSplit) || 48;
      const h = rpb.getBoundingClientRect().height;
      rpb.style.setProperty('--vsplit',
        (h ? Math.min(v, vsplitMax()) : v).toFixed(1) + '%');
    };
    applyClamped();
    requestAnimationFrame(() => requestAnimationFrame(applyClamped));
  }
  // the resize story: the window (or column) shrinking AFTER a valid split
  // was applied must not clip the chrome either. The pane is KEPT across
  // renders (viewer-keep), so attach one observer that re-clamps from live
  // geometry — and grows back toward the saved preference when space returns.
  if (rpb && !rpb._vsClamp && typeof ResizeObserver === 'function') {
    rpb._vsClamp = new ResizeObserver(() => {
      if (!rpb.isConnected || !rpb.getBoundingClientRect().height) return;
      const cur = parseFloat(rpb.style.getPropertyValue('--vsplit')) || 48;
      // NB Number(null) is 0 — an unset preference must mean "keep cur",
      // not "collapse the viewer to 0%"
      const savedRaw = localStorage.getItem('wbVSplit');
      const saved = savedRaw == null ? NaN : Number(savedRaw);
      const want = Number.isFinite(saved) ? saved : cur;
      const next = Math.min(want, vsplitMax());
      if (Math.abs(next - cur) > 0.2) rpb.style.setProperty('--vsplit', next.toFixed(1) + '%');
    });
    rpb._vsClamp.observe(rpb);
  }

  const sdiv = root.querySelector('.sdivider');
  if (sdiv && wb) sdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = wb.getBoundingClientRect();
    // half this divider; clamp so the sidebar stays usable and the panes keep their minimums
    const px = Math.min(Math.max(ev.clientX - rect.left - 3, 180), Math.min(460, rect.width - 14 - 280 - 300));
    wb.style.setProperty('--wb-side', px + 'px');
    localStorage.setItem('wbSidePx', String(Math.round(px)));
  }));

  const vdiv = root.querySelector('.vdivider');
  if (vdiv && wb) vdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = wb.getBoundingClientRect();
    // live sidebar width + its divider + half this divider; clamp so neither pane collapses
    const side = wb.querySelector(':scope > .side').getBoundingClientRect().width;
    const px = Math.min(Math.max(ev.clientX - rect.left - side - 7 - 3, 280), rect.width - side - 14 - 300);
    wb.style.setProperty('--wb-center', px + 'px');
    localStorage.setItem('wbCenterPx', String(Math.round(px)));
  }));

  // focus mode's viewer/console split — a peer of the vdivider, clamped so
  // neither pane collapses. Three smoothing rules the other dividers don't
  // need (2026-08-07, "text jumps around a ton" report):
  //   1. rAF-throttled — mousemove outruns the frame rate, and every --fsplit
  //      write relayouts BOTH panes (PDF text layer + KaTeX console);
  //      applying more than one per frame is thrash the eye reads as jumping.
  //   2. The hosted console is RE-ANCHORED through each step: overflow-anchor
  //      is deliberately none there (it manages its own follow), so a width
  //      rewrap slides the view — if it sat at the bottom, keep it there.
  //   3. localStorage persists once, on mouseup — not per move.
  const fdiv = root.querySelector('.fdivider');
  if (fdiv && rpb) {
    let fPending = null;
    let fRaf = 0;
    let fFollow = false; // latched at drag START — mid-drag gap wobble must not flip it
    const anchorConsole = () => {
      if (!fFollow) return;
      const box = rpb.querySelector('.sessHalf #consoleBox');
      if (!box) return;
      // reading scrollHeight flushes any pending layout first
      const want = box.scrollHeight - box.clientHeight;
      if (Math.abs(box.scrollTop - want) > 1) {
        box._prog = (box._prog || 0) + 1; // our write — not a user scroll
        box.scrollTop = want;
      }
    };
    const fApply = () => {
      fRaf = 0;
      if (fPending == null) return;
      rpb.style.setProperty('--fsplit', fPending.toFixed(1) + '%');
      anchorConsole();
    };
    fdiv.addEventListener('mousedown', dragTrack((ev) => {
      const rect = rpb.getBoundingClientRect();
      if (!rect.width) return;
      fPending = Math.min(75, Math.max(25, ((ev.clientX - rect.left) / rect.width) * 100));
      if (!fRaf) fRaf = requestAnimationFrame(fApply);
    }));
    fdiv.addEventListener('mousedown', () => {
      const box = rpb.querySelector('.sessHalf #consoleBox');
      fFollow = !!box && (box._follow
        ?? (box.scrollHeight - box.scrollTop - box.clientHeight < 40));
      const done = () => {
        window.removeEventListener('mouseup', done);
        if (fPending != null) localStorage.setItem('wbFSplit', fPending.toFixed(1));
        // the composer's own ResizeObserver re-autosizes AFTER the drag
        // (narrower pane → taller textarea → shorter console) — re-anchor
        // once those async reflows settle, then let go
        requestAnimationFrame(() => requestAnimationFrame(anchorConsole));
        setTimeout(anchorConsole, 140);
      };
      window.addEventListener('mouseup', done);
    });
  }

  const hdiv = root.querySelector('.hdivider');
  if (hdiv && rpb) hdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = rpb.getBoundingClientRect();
    // ceiling from the session pane's measured chrome — the drag eats the
    // grey gap above the composer, then stops; buttons never leave
    const pct = Math.min(vsplitMax(), Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100));
    rpb.style.setProperty('--vsplit', pct.toFixed(1) + '%');
    localStorage.setItem('wbVSplit', pct.toFixed(1));
  }));
}

function wireFileReorder(root, key, task, files) {
  // Drag a file tab (center) or pinned-file row (sidebar) onto another to
  // reorder. The new order is persisted to task.context.files via PATCH,
  // so future session launches read the files in your order.
  const per = perOf(key);
  let fromIdx = null;

  const commit = async (from, to) => {
    if (from === to || from == null || to == null) return;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return; // pins only — extras aren't draggable
    // `files` is the DISPLAYED slice (first 12); reorder within it but always
    // persist the FULL pinned list, or extras beyond the slice get deleted
    const local = tasksOf(key).find(t => t.id === task.id) || task;
    const full = Array.isArray(local.context?.files) ? local.context.files.slice() : files.slice();
    const order = files.slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const newFull = [...order, ...full.slice(files.length)];
    // keep the selection glued to the file the user had open
    const sel = per.fileTab;
    if (sel !== 'tail' && typeof sel === 'number') {
      per.fileTab = order.indexOf(files[sel]);
    }
    // optimistic local update, then persist (task:update broadcast confirms);
    // PATCH from the fresh local context, not the render-time closure
    local.context = { ...(local.context || {}), files: newFull };
    renderWB(key);
    await api('PATCH', `/api/tasks/${encodeURIComponent(key)}/${encodeURIComponent(task.id)}`,
      { context: { ...local.context, files: newFull } });
  };

  root.querySelectorAll('[data-fi][draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      fromIdx = +el.dataset.fi;
      el.classList.add('dragSrc');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(fromIdx)); } catch { /* required by FF */ }
    });
    el.addEventListener('dragend', () => {
      fromIdx = null;
      root.querySelectorAll('.dragSrc, .dragOver').forEach(x => x.classList.remove('dragSrc', 'dragOver'));
    });
    el.addEventListener('dragover', (e) => {
      if (fromIdx == null || el.dataset.fi === 'tail') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dragOver');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragOver'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragOver');
      commit(fromIdx, +el.dataset.fi);
      fromIdx = null;
    });
  });
}

/* Drag a file tab onto ANOTHER task's tab in the strip: the file opens in
   that task — a context pin, remembered as its selected tab — without leaving
   the task you're on. Same-strip reordering stays wireFileReorder's business;
   this only arms OTHER tasks' tabs as drop targets. Already-pinned drops
   reopen a closed tab instead of duplicating the pin. */
function wireFileToTaskDrag(root, key, task, files) {
  let dragRel = null; // armed by dragstart on a file tab, per render
  root.querySelectorAll('.ctab[data-fi][draggable="true"]').forEach(el => {
    const fi = +el.dataset.fi;
    if (!Number.isFinite(fi) || files[fi] == null) return; // ⌨ tail etc.
    el.addEventListener('dragstart', (e) => {
      dragRel = String(files[fi]);
      // wireFileReorder's dragstart (registered FIRST, but only on 2+-file
      // strips) sets effectAllowed='move' — and browsers CANCEL a drop whose
      // dropEffect isn't permitted, so the cross-task 'copy' drop was dead
      // exactly on multi-file tasks (found via a 2-tab task, 2026-07-31).
      // This listener runs after it: widen to 'all' so both gestures fit.
      try { e.dataTransfer.effectAllowed = 'all'; } catch { /* FF quirks */ }
    });
    el.addEventListener('dragend', () => {
      dragRel = null;
      root.querySelectorAll('.ptab.tk.dragOver').forEach(x => x.classList.remove('dragOver'));
    });
  });
  root.querySelectorAll('.ptab.tk').forEach(tab => {
    if (tab.dataset.id === task.id) return; // its own entry — that's a reorder
    tab.addEventListener('dragover', (e) => {
      if (dragRel == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      tab.classList.add('dragOver');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('dragOver'));
    tab.addEventListener('drop', async (e) => {
      e.preventDefault();
      tab.classList.remove('dragOver');
      if (dragRel == null) return;
      const rel = dragRel;
      dragRel = null;
      const tgt = tasksOf(key).find(t => t.id === tab.dataset.id);
      if (!tgt) return;
      const cur = Array.isArray(tgt.context?.files) ? tgt.context.files : [];
      const idx = cur.indexOf(rel);
      if (idx >= 0) { // already pinned there — surface it rather than duplicate
        const closed = getClosed(key, tgt);
        if (closed.delete(rel)) persistClosed(key, tgt);
        taskTabRemember(key, tgt.id, idx);
        toast(`${pinLabelOf(rel)} is open in “${tgt.title}”`);
        return;
      }
      const next = [...cur, rel];
      tgt.context = { ...(tgt.context || {}), files: next }; // optimistic — the PATCH broadcast confirms
      // a stale closedTabs entry (pinned once, closed, later unpinned) would
      // render the fresh drop as a HIDDEN tab — clear it either way
      const closedT = getClosed(key, tgt);
      if (closedT.delete(rel)) persistClosed(key, tgt);
      taskTabRemember(key, tgt.id, next.length - 1);         // it greets the next visit
      toast(`${pinLabelOf(rel)} opened in “${tgt.title}”`);
      await api('PATCH', `/api/tasks/${enc(key)}/${enc(tgt.id)}`,
        { context: { ...tgt.context, files: next } });
    });
  });
}

function wireViewerReorder(root, key) {
  // drag a show-panel tab onto another to rearrange; order persists per project
  const tabs = [...root.querySelectorAll('.ptab.vw')];
  if (tabs.length < 2) return;
  let fromK = null;
  tabs.forEach(el => {
    el.addEventListener('dragstart', (e) => {
      fromK = el.dataset.vk;
      el.classList.add('dragSrc');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', fromK); } catch { /* required by FF */ }
    });
    el.addEventListener('dragend', () => {
      fromK = null;
      root.querySelectorAll('.dragSrc, .dragOver').forEach(x => x.classList.remove('dragSrc', 'dragOver'));
    });
    el.addEventListener('dragover', (e) => {
      if (fromK == null || el.dataset.vk === fromK) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dragOver');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragOver'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragOver');
      if (fromK == null || fromK === el.dataset.vk) return;
      const keys = tabs.map(t => t.dataset.vk);
      const [moved] = keys.splice(keys.indexOf(fromK), 1);
      keys.splice(keys.indexOf(el.dataset.vk) + (e.offsetX > el.offsetWidth / 2 ? 1 : 0), 0, moved);
      localStorage.setItem(`viewerOrder:${key}`, JSON.stringify(keys));
      fromK = null;
      renderWB(key);
    });
  });
}

function wireWB(root, key, task, files) {
  root.querySelector('#taskMemoryBtn')?.addEventListener('click', () => openTaskMemory(key, task.id, task.title));
  const per = perOf(key);
  wireViewerReorder(root, key);
  mountPdfPane(key, root); // live tex preview — re-attach, reload only on new builds
  mountArtPanes(key, root); // artifact .pdf tabs — same themed pane
  renderTexProblems(key);
  if (task && files.length > 1) wireFileReorder(root, key, task, files);
  if (task && files.length) wireFileToTaskDrag(root, key, task, files);

  root.querySelectorAll('.ptab.tk').forEach(el => el.addEventListener('click', () => {
    if (per.taskId === el.dataset.id) return; // already selected — don't reset tabs
    per.taskId = el.dataset.id;
    per.fileTab = taskTabRecall(key, el.dataset.id); // back to the tab you left it on
    per.sessTab = 'sess';
    renderWB(key);
  }));
  // × on a done task's tab — archives it (same as ▣ archive in the sidebar)
  root.querySelectorAll('.ptab.tk .tabX[data-ax]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't select the tab being dismissed
    const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(el.dataset.ax)}`, { archived: true });
    if (r) {
      const arr = state.tasks[key] || [];
      const i = arr.findIndex(t => t && t.id === r.id);
      if (i >= 0) arr[i] = r; // apply now — don't wait for the broadcast
      toast('archived — reopen it anytime from the overview’s Recent tasks');
      if (per.taskId === el.dataset.ax) per.taskId = null; // fall to the next task
      renderWB(key);
    }
  }));
  // ◷ Recent activity: one delegated handler for every row
  const feedEl = root.querySelector('#actFeed');
  if (feedEl) feedEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.afRow');
    if (!row || row.classList.contains('afOlder')) return;
    // a group header toggles open on plain click; its Δ→/▶→ chip navigates
    if (row.classList.contains('afHead') && !e.target.closest('.afTo')) {
      const grp = row.parentElement;
      grp.classList.toggle('open');
      const open = per.afOpen || (per.afOpen = new Set());
      if (grp.classList.contains('open')) open.add(grp.dataset.gid);
      else open.delete(grp.dataset.gid);
      return;
    }
    const nav = row.dataset.nav;
    const tid = row.dataset.task || null;
    const hasTask = tid && (state.tasks[key] || []).some(t => t && t.id === tid);
    if (nav === 'diff' || nav === 'dlist') {
      if (!hasTask) { toast('that task no longer exists — its history went with it'); return; }
      per.taskId = tid;
      per.sessTab = 'sess';
      await ensureSnaps(key, tid); // the Δ tab needs the entries before it can open
      per.fileTab = 'snaps';
      per.snapView = nav === 'diff'
        ? { task: tid, eid: row.dataset.eid, rel: row.dataset.rel, expanded: [], hunk: null }
        : null;
      renderWB(key);
    } else if (nav === 'task') {
      if (!hasTask) { toast('that task no longer exists'); return; }
      per.taskId = tid;
      per.fileTab = taskTabRecall(key, tid);
      per.sessTab = 'sess';
      renderWB(key);
    } else if (nav === 'run') {
      const src = row.dataset.src;
      const file = row.dataset.file || '';
      if (src === 'run' && state.runs[key]?.rel === file) {
        per.sessTab = 'run'; // this run IS the ▶ output pane's current content
        renderWB(key);
      } else if (hasTask) {
        // session runs stream into the task's console — open it there
        per.taskId = tid;
        per.fileTab = 'tail';
        per.sessTab = 'sess';
        renderWB(key);
      } else if (src === 'run') {
        per.sessTab = 'run';
        renderWB(key);
        toast('only the latest ▶ run’s output is kept');
      } else {
        toast('that run’s task no longer exists');
      }
    }
  });
  root.querySelectorAll('.scKid.dirk').forEach(el => el.addEventListener('click', () => {
    per.openDirs = per.openDirs || new Set();
    const r = el.dataset.dk;
    if (per.openDirs.has(r)) per.openDirs.delete(r);
    else { per.openDirs.add(r); ensureDir(key, r); }
    renderWB(key);
  }));
  root.querySelectorAll('.scKid.filek').forEach(el => el.addEventListener('click', () => {
    const r = el.dataset.fk;
    const ext = r.split('.').pop().toLowerCase();
    // external files can't use the show panel's iframe kinds (it serves
    // in-root paths only) — they open EDITABLE in the center pane instead
    if (!isExtRel(r) && (['pdf', 'html', 'htm'].includes(ext) || isDataFile(r))) {
      selectViewer(key, r); // pdf/html render; data files get a head-rows preview
      renderWB(key);
    } else {
      openExtraTab(key, r); // anything else opens as an ephemeral code tab
    }
  }));
  root.querySelectorAll('[data-extdk]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-extrm]')) return; // the × has its own handler
    per.openDirs = per.openDirs || new Set();
    const r = el.dataset.extdk;
    if (per.openDirs.has(r)) per.openDirs.delete(r);
    else { per.openDirs.add(r); ensureDir(key, r); }
    renderWB(key);
  }));
  root.querySelectorAll('[data-extfk]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-extrm]')) return; // the × has its own handler
    openExtraTab(key, el.dataset.extfk); // editable center-pane tab
  }));
  if (task) {
    root.querySelector('#completeTask')?.addEventListener('click', async () => {
      if (task.status === 'running') { toast('interrupt the running turn before completing'); return; }
      const hasSession = !!task.session;
      const ok = await confirmBox(
        `Complete <b>“${esc(task.title)}”</b>?<br><br>`
        + (hasSession
          ? `${agentName(taskProvider(task))} will write its final <b>handoff report</b> (a real, billed turn), then the task is marked <b>done</b> and archived.`
          : 'This task never ran, so there’s no session to write a report — it’ll just be marked <b>done</b> and archived.'),
        'Complete');
      if (!ok) return;
      if (hasSession) {
        // the launch prompt no longer teaches the handoff format (sessions
        // cannot propose completion) — this message must carry the full schema
        const msg = 'This task is complete — please wrap up. End your message with your final handoff report as a fenced block:\n'
          + '```handoff\n'
          + '{"summary": "...", "artifacts": [["path", "note"]], "numbers": [["key", "value"]], "decisions": ["..."], "next": "..."}\n'
          + '```\n'
          + 'capturing everything accomplished, then stop. No further work.';
        const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/message`, { text: msg });
        if (r) { pendingComplete[`${key}/${task.id}`] = true; toast(`wrapping up — ${agentName(taskProvider(task))} is writing the handoff…`); }
      } else {
        const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { status: 'done', archived: true });
        if (r) { toast('completed & archived'); per.taskId = null; renderWB(key); }
      }
    });
    root.querySelector('#archTask')?.addEventListener('click', async () => {
      if (task.status === 'running') { toast('interrupt the running turn before archiving'); return; }
      const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { archived: true });
      if (r) { toast('archived — reopen it anytime from the overview’s Recent tasks'); per.taskId = null; renderWB(key); }
    });
    root.querySelector('#unarchTask')?.addEventListener('click', async () => {
      const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { archived: false });
      if (r) toast('restored to the tab strip');
    });
    root.querySelector('#delTask')?.addEventListener('click', async () => {
      const refs = tasksOf(key).filter(t => Array.isArray(t.upstream) && t.upstream.includes(task.id));
      const ok = await confirmBox(
        `Are you sure you want to delete <b>“${esc(task.title)}”</b>?<br><br>`
        + 'This removes the task, its transcript and its change history. '
        + 'Files the task created in the project <b>stay on disk</b>.'
        + (task.handoff ? '<br>⚠ Its handoff record will be lost.' : '')
        + (refs.length ? `<br>⚠ ${refs.length} task(s) list it as upstream — their lineage link will dangle.` : '')
        + '<br><br>This cannot be undone.');
      if (!ok) return;
      const r = await api('DELETE', `/api/tasks/${enc(key)}/${enc(task.id)}`);
      if (r) toast('task deleted');
      // task:delete broadcast clears state + selection
    });
  }
  const plus = root.querySelector('#newTaskTab');
  if (plus) plus.addEventListener('click', () => openModal(key));

  root.querySelectorAll('.ptab.vw').forEach(el => el.addEventListener('click', () => {
    per.viewerKey = el.dataset.vk; renderWB(key);
  }));
  root.querySelectorAll('.sessTabs .stab').forEach(el => el.addEventListener('click', () => {
    per.sessTab = el.dataset.st; renderWB(key);
  }));
  // run-pane controls are project-scoped — wire them even with no task selected
  const srb = root.querySelector('#stopRunBtn');
  if (srb) srb.addEventListener('click', () => stopRunReq(key));
  // job cards mount into their slots fresh after every render — the render
  // replaced the slots' DOM (▶ output tab + the session chat)
  syncRunJobCard(key);
  // build-card error rows jump to the offending line, same as the strip
  root.querySelectorAll('.trProb[data-pf]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.pf) texOpenAt(key, el.dataset.pf, Number(el.dataset.pl) || 1, 1);
  }));
  // the compiling card's clock ticks once a second while the run lives
  clearInterval(texRunTickers[key]);
  delete texRunTickers[key];
  if (root.querySelector('#texRunElapsed') && state.runs[key]?.state === 'running') {
    texRunTickers[key] = setInterval(() => {
      const elEl = document.querySelector(`#v-${key} #texRunElapsed`);
      const run = state.runs[key];
      if (!elEl || run?.state !== 'running') {
        clearInterval(texRunTickers[key]);
        delete texRunTickers[key];
        return;
      }
      const t0 = Date.parse(elEl.dataset.t0 || '');
      if (Number.isFinite(t0)) elEl.textContent = `${Math.max(0, (Date.now() - t0) / 1000).toFixed(0)}s`;
    }, 1000);
  }
  root.querySelectorAll('[data-vx]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't let the tab's select-click fire
    const vk = el.dataset.vx;
    if (vk === '__proposal') { closeProposal(key); return; }
    if (vk === 'pdf') {
      // the live watch tab: × stops the live compile watch entirely
      await api('DELETE', `/api/pdf/watch/${enc(key)}`);
      delete state.pdf[key];
      pdfPanes[key]?.destroy();
      delete pdfPanes[key];
      if (per.viewerKey === 'pdf') per.viewerKey = null;
    } else {
      if (/\.pdf$/i.test(vk)) artPaneDestroy(key, vk); // release doc + timers
      const closed = getClosedViewers(key);
      closed.add(String(vk));
      persistClosedViewers(key, closed);
      // a hand-added display is fully removed, not just hidden
      const added = getAddedViewers(key);
      if (added.some(v => v.rel === vk)) {
        persistAddedViewers(key, added.filter(v => v.rel !== vk));
      }
      if (per.viewerKey === vk) per.viewerKey = null; // fall to the next tab
    }
    renderWB(key);
  }));
  root.querySelectorAll('[data-fi]').forEach(el => el.addEventListener('click', () => {
    const v = el.dataset.fi;
    if (extraRel(v) != null) {
      per.fileTab = v;
      const rel = extraRel(v);
      if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`]; // refetch on open
      renderWB(key);
      return;
    }
    if (v === 'tail' || v === 'snaps') {
      per.fileTab = v;
    } else if (isPdfFile(files[+v])) {
      const rel = relOf(key, files[+v]);
      if (!rel) { toast('pdf is outside the project root — cannot display'); return; }
      selectViewer(key, rel); // pdfs open in the show panel (reopens if × closed)
    } else if (pinKindOf(files[+v]) === 'folder') {
      // folders have no center tab — the sidebar row just toggles its browser
      const rel = relOf(key, String(files[+v]).replace(/\/+$/, ''));
      if (rel != null) {
        per.openDirs = per.openDirs || new Set();
        if (per.openDirs.has(rel)) per.openDirs.delete(rel);
        else { per.openDirs.add(rel); ensureDir(key, rel); }
      }
      if (task) { // clear a legacy closed-tab entry from when folders had tabs
        const closed = getClosed(key, task);
        if (closed.delete(String(files[+v]))) persistClosed(key, task);
      }
    } else {
      per.fileTab = +v;
      if (task) { // selecting a closed sidebar row reopens its tab
        const closed = getClosed(key, task);
        if (closed.delete(String(files[+v]))) persistClosed(key, task);
      }
      // refetch on open (unless a draft is in progress): code files have no
      // watcher, so this is what catches external edits going stale
      const kind = pinKindOf(files[+v]);
      const rel = relOf(key, String(files[+v]).replace(/\/+$/, ''));
      if (rel != null && kind === 'code' && drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
      if (rel != null && kind === 'data') delete fileCache[`${key}::card::${rel}`];
      // Only the pinned sidebar row couples the two panes. Clicking a source
      // tab must not steal a preview the user selected independently.
      if (rel != null && isHtmlFile(rel) && el.classList.contains('scRow')) selectViewer(key, rel);
    }
    renderWB(key);
  }));
  root.querySelectorAll('.tabX').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the tab's select-click fire
    if (el.dataset.xi == null) return; // viewer-tab ×s ([data-vx]) have their own handler
    const xrel = extraRel(el.dataset.xi);
    if (xrel != null) {
      // ephemeral tab: × removes it outright (drafts survive in memory and
      // come back if the file is reopened)
      per.openExtra = extrasOf(key).filter(r => r !== xrel);
      persistExtras(key);
      if (per.fileTab === el.dataset.xi) per.fileTab = null; // fall to the next tab
      renderWB(key);
      return;
    }
    closeTab(key, task, +el.dataset.xi, files);
  }));
  root.querySelectorAll('[data-extrm]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (task) removeExternalPin(key, task, el.dataset.extrm);
  }));
  root.querySelectorAll('[data-lid]').forEach(el => el.addEventListener('click', () => {
    const k2 = el.dataset.lk || key;
    perOf(k2).taskId = el.dataset.lid;
    perOf(k2).fileTab = null;
    perOf(k2).sessTab = 'sess';
    if (k2 !== key) go(k2); else renderWB(key);
  }));
  root.querySelectorAll('.schX[data-ux]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // the lineage node click navigates to that task
    const next = (Array.isArray(task.upstream) ? task.upstream : []).filter(u => u !== el.dataset.ux);
    task.upstream = next; // optimistic — the PATCH broadcast confirms
    renderWB(key);
    await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { upstream: next });
  }));
  root.querySelectorAll('.schX[data-dx]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const child = resolveId(el.dataset.dx); // the link lives on the child's upstream
    if (!child) return;
    const next = (Array.isArray(child.t.upstream) ? child.t.upstream : []).filter(u => u !== task.id);
    child.t.upstream = next; // optimistic — the PATCH broadcast confirms
    renderWB(key);
    await api('PATCH', `/api/tasks/${enc(child.k)}/${enc(child.t.id)}`, { upstream: next });
  }));

  // WYSIWYG html editing
  const heb = root.querySelector('#htmlEditBtn');
  if (heb) heb.addEventListener('click', () => startHtmlEdit(key, heb.dataset.rel));
  // markdown: viewer bar's ✎ source → the file in the center editor (pinned
  // tab when it's a pin, ephemeral extra tab otherwise)
  const meb = root.querySelector('#mdEditBtn');
  if (meb) meb.addEventListener('click', () => texOpenAt(key, meb.dataset.rel, 1, 1));
  // and the editor foot's ▤ preview → the rendered pane in the show panel
  const mpb = root.querySelector('#mdPreviewBtn');
  if (mpb) mpb.addEventListener('click', () => {
    perOf(key).viewerKey = mpb.dataset.rel;
    renderWB(key);
  });
  const ef = root.querySelector('#htmlEditFrame');
  if (ef) {
    const hook = () => {
      try {
        const doc = ef.contentDocument;
        if (!doc || !htmlEdits[key]) return;
        doc.designMode = 'on';
        doc.addEventListener('input', () => {
          const st = htmlEdits[key];
          if (!st) return;
          st.gen = (st.gen || 0) + 1;
          if (!st.dirty) { st.dirty = true; htmlEditChrome(key); }
        });
        doc.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveHtmlEdit(key);
          }
        });
      } catch (err) {
        toast('cannot enter edit mode: ' + (err.message || err));
      }
    };
    ef.addEventListener('load', hook);
    if (ef.contentDocument && ef.contentDocument.readyState === 'complete') hook();
  }
  root.querySelectorAll('#editBar button[data-cmd]').forEach(b => {
    // keep the iframe's selection alive — a normal click would steal focus
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const doc = root.querySelector('#htmlEditFrame')?.contentDocument;
      const st = htmlEdits[key];
      if (!doc || !st) return;
      const cmd = b.dataset.cmd;
      try {
        if (cmd === 'link') {
          const u = prompt('Link URL:', 'https://');
          if (u && u.trim()) doc.execCommand('createLink', false, u.trim());
        } else if (b.dataset.arg) {
          doc.execCommand(cmd, false, b.dataset.arg);
        } else {
          doc.execCommand(cmd);
        }
        st.gen = (st.gen || 0) + 1;
        if (!st.dirty) { st.dirty = true; htmlEditChrome(key); }
      } catch { /* command not applicable to selection */ }
    });
  });
  const hsb = root.querySelector('#htmlSaveBtn');
  if (hsb) hsb.addEventListener('click', () => saveHtmlEdit(key));
  const hdb = root.querySelector('#htmlDoneBtn');
  if (hdb) hdb.addEventListener('click', () => endHtmlEdit(key));

  const cp = root.querySelector('#closeProposal');
  if (cp) cp.addEventListener('click', () => closeProposal(key));
  const av = root.querySelector('#addViewBtn');
  if (av) av.addEventListener('click', () => addDisplay(key));
  const un = root.querySelector('#unwatchTex');
  if (un) un.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api('DELETE', `/api/pdf/watch/${enc(key)}`);
    delete state.pdf[key];
    pdfPanes[key]?.destroy();
    delete pdfPanes[key];
    per.viewerKey = null;
    renderWB(key);
  });

  root.querySelector('#texFixBtn')?.addEventListener('click', () => startTexFix(key));

  if (!task) return;

  wireNextUp(root, key); // ◆ next up — countdown rows + the ＋ deadline panel

  const pa = root.querySelector('#pinAddBtn');
  if (pa) pa.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('pinMenu'); // portaled to body
    if (existing) { existing.remove(); return; }
    if (per.pinOpen) { per.pinOpen = false; per.pinQ = ''; renderWB(key); return; }
    const menu = document.createElement('div');
    menu.id = 'pinMenu';
    menu.innerHTML = `
      <div class="pmItem" data-pk="file">▮ pin a file…</div>
      <div class="pmItem" data-pk="folder">🗀 pin a folder…</div>
      <div class="pmSep"></div>
      <div class="pmItem" data-pk="ext-file" title="a file outside the project — grants the task agent read/edit access">↗ external file…</div>
      <div class="pmItem" data-pk="ext-folder" title="a folder outside the project — grants the task agent read/edit access">↗ external folder…</div>`;
    placeSideMenu(menu, pa);
    menu.querySelectorAll('.pmItem').forEach(it => it.addEventListener('click', async () => {
      // no stopPropagation: let the document once-listener fire and clean up
      menu.remove();
      await pickPin(key, task, it.dataset.pk);
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });

  const la = root.querySelector('#linAddBtn');
  if (la) la.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('linMenu'); // portaled to body
    if (existing) { existing.remove(); return; }
    const ups = Array.isArray(task.upstream) ? task.upstream : [];
    // same rules as Add Task → Lineage: chains live within a category GROUP
    // (e.g. any Empirics task can feed any other); archived tasks stay linkable
    // (their handoffs are the point), sorted last, marked ▣; exclude self,
    // already-linked, and tasks already downstream of this one
    const kin = tasksOf(key).filter(t => t.id !== task.id
      && catGroup(t.category) === catGroup(task.category)
      && !ups.includes(t.id) && !(Array.isArray(t.upstream) && t.upstream.includes(task.id)))
      .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
    const item = (t, attr) => `<div class="pmItem" ${attr}="${esc(t.id)}">⛓ ${t.archived ? '▣ ' : ''}${esc(t.title)}<span class="anno">${esc(state.categories?.[t.category]?.name || t.category)} · ${t.archived ? 'archived' : esc(t.status)}</span></div>`;
    const menu = document.createElement('div');
    menu.id = 'linMenu';
    menu.innerHTML = kin.length
      ? `<div class="pmHead">↑ add a parent — its handoff feeds this task</div>`
        + kin.map(t => item(t, 'data-lu')).join('')
        + `<div class="pmHead">↓ add a child — receives this task's handoff</div>`
        + kin.map(t => item(t, 'data-lc')).join('')
      : '<div class="pmEmpty">No tasks to link in this category group.</div>';
    placeSideMenu(menu, la);
    menu.querySelectorAll('.pmItem[data-lu]').forEach(it => it.addEventListener('click', async () => {
      // no stopPropagation: the document once-listener below cleans the menu up
      const next = [...ups, it.dataset.lu];
      task.upstream = next; // optimistic — the PATCH broadcast confirms
      renderWB(key);
      await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { upstream: next });
    }));
    menu.querySelectorAll('.pmItem[data-lc]').forEach(it => it.addEventListener('click', async () => {
      // child links live on the CHILD's upstream array
      const child = tasksOf(key).find(t => t.id === it.dataset.lc);
      const next = [...(Array.isArray(child?.upstream) ? child.upstream : []), task.id];
      if (child) child.upstream = next; // optimistic — the PATCH broadcast confirms
      renderWB(key);
      await api('PATCH', `/api/tasks/${enc(key)}/${enc(it.dataset.lc)}`, { upstream: next });
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });

  const wirePinRows = () => root.querySelectorAll('.pinRow').forEach(el =>
    el.addEventListener('click', () => pinFile(key, task, el.dataset.rel)));
  const ps = root.querySelector('#pinSearch');
  if (ps) {
    ps.addEventListener('input', () => {
      per.pinQ = ps.value;
      const out = root.querySelector('#pinResults');
      if (out) { out.innerHTML = pinResultsHtml(key, task); wirePinRows(); }
    });
    ps.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { per.pinOpen = false; per.pinQ = ''; renderWB(key); }
      else if (e.key === 'Enter') {
        const first = root.querySelector('.pinRow');
        if (first) pinFile(key, task, first.dataset.rel);
      }
    });
    wirePinRows();
  }

  const rb = root.querySelector('#runFileBtn');
  if (rb) rb.addEventListener('click', () => {
    if (rb.dataset.running) stopRunReq(key);
    else runFile(key, rb.dataset.rel);
  });

  // change history: click a file row → its inline unified diff (the drill-in)
  root.querySelectorAll('.dfrow[data-eid]').forEach(rw => rw.addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // ⟲ keeps its own meaning
    per.snapView = { task: task.id, eid: rw.dataset.eid, rel: rw.dataset.rel, expanded: [], hunk: null };
    renderWB(key);
  }));
  root.querySelector('.sdvBack')?.addEventListener('click', () => {
    per.snapView = null;
    renderWB(key);
  });
  // folds expand IN PLACE — swapping the diff body keeps the reader's scroll
  const sdvScroll = root.querySelector('.sdvScroll');
  if (sdvScroll) sdvScroll.addEventListener('click', (e) => {
    const fold = e.target.closest('.udl.fold');
    const sv = per.snapView;
    if (!fold || !sv) return;
    sv.expanded = [...(sv.expanded || []), +fold.dataset.fold];
    const d = snapFileCache[sdvScroll.dataset.fk];
    if (!d || d.loading || d.error) return;
    const keep = sdvScroll.scrollTop;
    sdvScroll.querySelector('.udiff').innerHTML = unifiedDiffHtml(d.before, d.after, sv.expanded).html;
    sdvScroll.scrollTop = keep;
  });
  // edit N/M stepper — jump between the file's edit hunks
  root.querySelectorAll('.sdvStep').forEach(b => b.addEventListener('click', () => {
    const sv = per.snapView;
    const scroller = root.querySelector('.sdvScroll');
    if (!sv || !scroller) return;
    const marks = [...scroller.querySelectorAll('[data-h]')];
    if (!marks.length) return;
    // first press lands ON the first (or last) edit; afterwards it steps + wraps
    sv.hunk = sv.hunk == null
      ? (Number(b.dataset.d) > 0 ? 0 : marks.length - 1)
      : ((sv.hunk + Number(b.dataset.d)) % marks.length + marks.length) % marks.length;
    const el = marks.find(m => Number(m.dataset.h) === sv.hunk);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('hcur');
      setTimeout(() => el.classList.remove('hcur'), 1100);
    }
    const no = root.querySelector('#sdvHunkNo');
    if (no) no.textContent = String(sv.hunk + 1);
  }));
  const doRevert = async (eid, rel) => {
    const what = rel || 'every file in this change-set';
    if (!confirm(`Rewind ${what} to before this change?\n(The rewind is recorded too, so it can be undone.)`)) return;
    const r = await api('POST', `/api/snapshots/${enc(key)}/${enc(eid)}/revert`, rel ? { rel } : {});
    if (r && r.ok) toast('rewound — files restored');
    // the snapshot:new broadcast refreshes history + invalidates file caches
  };
  root.querySelectorAll('.snapRevertBtn').forEach(b =>
    b.addEventListener('click', () => doRevert(b.dataset.eid, b.dataset.rel)));
  root.querySelectorAll('.snapRevertAll').forEach(b =>
    b.addEventListener('click', () => doRevert(b.dataset.eid, null)));

  const send = root.querySelector('#sendBtn');
  const input = root.querySelector('#composerInput');
  if (send && input) {
    const ck = `${key}/${task.id}`;
    // grow with the text: 1 line → 2 → 3 …, scrollable past ~7 lines — AND
    // capped by the room the pane can actually give: in a shrunken
    // session pane the textarea scrolls internally instead of shoving the
    // sessbar buttons out through the overflow:hidden bottom. The cap is
    // measured live (tabs + sessbar + composer chrome + a grey sliver), and
    // a ResizeObserver below re-caps when the pane itself changes size.
    const autosize = () => {
      const sess = root.querySelector('.sessHalf');
      const chat = sess && sess.querySelector('.chat');
      let cap = 170;
      const comp = input.closest('.composer');
      if (sess && chat && comp) {
        const other = sessChromePx(chat, input);
        const ccs = getComputedStyle(comp);
        const chrome = (comp.offsetHeight - input.offsetHeight)
          + (parseFloat(ccs.marginTop) || 0) + (parseFloat(ccs.marginBottom) || 0);
        cap = Math.min(170, Math.max(32, sess.clientHeight - other - chrome - 26));
      }
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, cap) + 'px';
    };
    {
      const sess = root.querySelector('.sessHalf');
      if (sess) {
        // the pane may be KEPT across renders while the composer is rebuilt —
        // refresh the callback each wiring pass so the (single) observer
        // always drives the CURRENT render's autosize
        sess._taCapFn = autosize;
        if (!sess._taCap && typeof ResizeObserver === 'function') {
          sess._taCap = new ResizeObserver(() => { if (sess._taCapFn) sess._taCapFn(); });
          sess._taCap.observe(sess);
        }
      }
    }
    // size to content, but defer if the view has no layout yet: on a project
    // switch renderWB runs while the view is still display:none, so scrollHeight
    // reads 0 and would pin the textarea to height:0 — a present-but-unclickable
    // composer. Mirror the console-scroll restore: size now if visible, else
    // on the next frame (after renderAll's .show toggle gives it layout).
    if (input.clientHeight) autosize(); // restored drafts may already be multi-line
    else requestAnimationFrame(autosize);
    input.addEventListener('input', () => { composerDrafts[ck] = input.value; persistRecallState(); autosize(); });
    const doSend = () => {
      if (recallPending(key, task.id)) return;
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      delete composerDrafts[ck];
      // Normal mode keeps the conversation in the center strip, so sending
      // opens it there. In focus mode the console is already visible at right:
      // preserve the editor the user is actively working in.
      if (!focusOn()) per.fileTab = 'tail';
      // a mid-turn Enter used to POST anyway: the server 409s it (one turn at
      // a time) while the optimistic echo stranded in the live stream and the
      // rest of the answer rendered inside the you-bubble. Queue instead —
      // the session:status turn-end handler delivers it.
      const live = findTask(key, task.id);
      if ((live && live.status === 'running') || submissionSending(key, task.id)) {
        (queuedMsgs[ck] ?? (queuedMsgs[ck] = [])).push(text);
        persistRecallState();
        renderWB(key);
        return;
      }
      sendMsg(key, task.id, text, { explicit: true }); // normal-mode jump is settled before render
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
    });
    // ⏳ queued strip: × pulls a message back out of the queue into the composer
    root.querySelectorAll('[data-unqueue]').forEach(b => b.addEventListener('click', () => {
      const q = queuedMsgs[ck];
      if (!q) return;
      const [t] = q.splice(Number(b.dataset.unqueue), 1);
      if (!q.length) delete queuedMsgs[ck];
      if (t) composerDrafts[ck] = composerDrafts[ck] ? `${t}\n\n${composerDrafts[ck]}` : t;
      persistRecallState();
      renderWB(key);
    }));
    root.querySelectorAll('[data-restore-draft]').forEach(b => b.addEventListener('click', () =>
      restoreSavedDraft(key, task.id, Number(b.getAttribute('data-restore-draft')))));
  }
  const cbox = root.querySelector('#consoleBox');
  if (cbox) {
    // user-scroll intent: scrolling away from the bottom stops the stream
    // from following; scrolling back near it resumes. Our own programmatic
    // writes are excluded via the _prog counter (see updateConsole). The
    // listener rides the kept element across renders — wire it once.
    if (!cbox._wired) {
      cbox._wired = true;
      cbox.addEventListener('scroll', () => {
        if (cbox._prog > 0) { cbox._prog--; return; }
        cbox._follow = cbox.scrollHeight - cbox.scrollTop - cbox.clientHeight < 40;
      });
    }
    const ck2 = cbox.dataset.key;
    const target = (tailBufs[ck2] || '').length;
    // restore this task's saved scroll/follow before painting: seed _follow so
    // updateConsole's stick logic doesn't snap a returning task to the bottom
    const view = consoleView[ck2];
    if (view) cbox._follow = view.follow;
    // FIRST open shows history instantly; a console that's already revealing
    // mid-stream keeps its smooth pump — jumping the cursor on every render
    // dumped a tall block at once and knocked the view off the stream
    if (shownLen[ck2] == null || !pumps[ck2]) shownLen[ck2] = target;
    updateConsole(cbox, ck2, shownLen[ck2]);
    // position scroll once the view has LAYOUT. On a project switch, renderAll
    // renders this view while it's still display:none (the .show toggle runs
    // after), so geometry reads 0 and a scroll write is a no-op — defer to the
    // next frame when visible, mirroring the lineage-chain restore. _prog flags
    // our own write so the scroll listener doesn't read it as a user scroll.
    const applyScroll = () => {
      const before = cbox.scrollTop;
      if (view && view.follow === false) cbox.scrollTop = view.scrollTop; // reader's saved offset
      else if (cbox._follow !== false) cbox.scrollTop = cbox.scrollHeight; // following/default → bottom
      if (cbox.scrollTop !== before) cbox._prog = (cbox._prog || 0) + 1;
    };
    if (cbox.clientHeight) applyScroll();
    else requestAnimationFrame(applyScroll);
  }
  // themed model/permission dropdowns: the pill toggles a menu that's PORTALED
  // to a fixed top-level layer (openDropdown) so it escapes the pane's clip.
  closeDrops(); // tidy up any menu the previous render left open
  document.getElementById('pinMenu')?.remove(); // portaled — a re-render
  document.getElementById('linMenu')?.remove(); // no longer sweeps them away
  root.querySelectorAll('.drop[data-drop]:not(.dropDisabled)').forEach((drop) => {
    drop.querySelector('.dropBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (drop.classList.contains('open')) closeDrops();
      else openDropdown(drop);
    });
    drop.querySelector('.dropMenu')?.addEventListener('click', (e) => e.stopPropagation());
    drop.querySelectorAll('.dropItem').forEach((item) => item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.dataset.val || null, kind = drop.dataset.drop;
      closeDrops();
      if (kind === 'model') setTaskEngine(key, task, item.dataset.provider || taskProvider(task), val);
      else if (kind === 'effort') setTaskReasoning(key, task, val);
      else setTaskPerm(key, task, val);
    }));
  });
  if (!window._dropCloseWired) {
    window._dropCloseWired = true;
    document.addEventListener('click', closeDrops);     // outside-click closes
    window.addEventListener('resize', closeDrops);      // geometry changed → close
    window.addEventListener('scroll', closeDrops, true); // any scroll → close (fixed menu would drift)
  }
  // web-search on/off toggle — same chip on the launch card (queued) and the
  // session bar (running/waiting); flips take effect on the next turn
  // voice: mic gestures, countdown-cancel guards
  if (task) wireVoice(root, key, task);

  const intr = root.querySelector('#interruptBtn');
  if (intr) intr.addEventListener('click', () => stopOrRecall(key, task.id));
  const lb = root.querySelector('#launchBtn');
  if (lb) lb.addEventListener('click', async () => {
    lb.disabled = true; lb.textContent = '⟳ launching…';
    const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/launch`);
    if (!r) { lb.disabled = false; lb.textContent = `▶ Launch ${agentName(taskProvider(task))}`; return; }
    // Focus mode already shows the console beside the editor.
    if (!focusOn()) per.fileTab = 'tail';
    renderWB(key);
  });
  const md = root.querySelector('#markDoneBtn');
  if (md) md.addEventListener('click', () =>
    api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { status: 'done', logNote: 'marked done manually' }));
  const ki = root.querySelector('#kaimonInstallBtn');
  if (ki) ki.addEventListener('click', async () => {
    ki.disabled = true;
    ki.textContent = 'starting…';
    const r = await api('POST', '/api/kaimon/install');
    if (!r) { ki.disabled = false; ki.textContent = 'Enable'; }
    // progress + completion arrive over kaimon:status broadcasts
  });
  const kd = root.querySelector('#kaimonDismissBtn');
  if (kd) kd.addEventListener('click', () => {
    localStorage.kaimonDismissed = '1';
    renderWB(key);
  });

  // Claude sign-in card: the button states are driven by auth:status
  // broadcasts (loggingIn/checking → spinner; needed:false → card gone)
  const asb = root.querySelector('#authSignBtn');
  if (asb) asb.addEventListener('click', async () => {
    asb.disabled = true;
    const r = await api('POST', '/api/auth/login');
    if (!r) asb.disabled = false; // 409/500 — the toast already explained
  });
  const arb = root.querySelector('#authRetryBtn');
  if (arb && task) arb.addEventListener('click', async () => {
    arb.disabled = true;
    const st = await api('POST', '/api/auth/check');
    if (st && st.loggedIn) {
      const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/retry`);
      if (r) toast('signed in — retrying the turn');
    } else {
      arb.disabled = false;
      if (st) toast('still signed out — sign in first');
    }
  });
  const csb = root.querySelector('#codexSignBtn');
  if (csb) csb.addEventListener('click', async () => {
    csb.disabled = true;
    const r = await api('POST', '/api/providers/codex/login');
    if (r?.authUrl) window.open(r.authUrl, '_blank', 'noopener');
    else csb.disabled = false;
  });
  root.querySelector('#codexCheckBtn')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const r = await api('POST', '/api/providers/codex/check');
    if (r) {
      state.providers.codex = { id: 'codex', name: 'Codex', ...r };
      renderWB(key);
    } else e.currentTarget.disabled = false;
  });
  const crb = root.querySelector('#codexRetryBtn');
  if (crb && task) crb.addEventListener('click', async () => {
    crb.disabled = true;
    const st = await api('POST', '/api/providers/codex/check');
    if (st?.connected) {
      const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/retry`);
      if (r) toast('Codex connected — retrying the turn');
    } else {
      crb.disabled = false;
      if (st) toast('Codex is still disconnected — connect it first');
    }
  });

  // (#chatLog scroll is restored by renderWB's chatKeep — pinning it to the
  // bottom here fought users who had scrolled up to re-read)
}
