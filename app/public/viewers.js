// viewers.js — the show panel, split verbatim out of app.js (phase 2):
// viewer tab persistence (closed/added), pdf pane mount/reuse, artifact
// frames + kept stack, md pane renderer, proposal preview tab, addDisplay.

import { createPdfPane } from './pdfPane.js';
import { enc, esc, toast, dataviewUrl } from './util.js';
import {
  state, pdfPanes, fileCache, drafts, runBufs, htmlEdits,
  curTask, perOf, relOf, artifactUrl, fileUrl, pdfSrc,
} from './store.js';
import { api } from './net.js';
import { ensureFile } from './files.js';
import { md, katexEl, texMacrosVisible, texMacroRev } from './console.js';
import {
  synctexEditOpen, texPaneRun, primeTexInputs, syncTexRunControls, syncTexRunPane,
} from './texrun.js';
import { renderWB, texOpenAt } from './workbench.js';

/* closed show-panel tabs — UI-only, persisted per project like closed file tabs */
/** @typedef {{ kind: string, key: string, label?: string, rel?: string, [k: string]: any }} ViewerSel
    one renderWB-built viewer-tab descriptor (pdf watch / artifact / added / md / __proposal) */

/**
 * @param {string} key project key
 * @returns {Set<string>} ×-closed viewer keys (localStorage-backed)
 */
export function getClosedViewers(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(`closedViewers:${key}`) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
/**
 * @param {string} key project key
 * @param {Set<string>} set
 * @returns {void}
 */
export function persistClosedViewers(key, set) {
  localStorage.setItem(`closedViewers:${key}`, JSON.stringify([...set]));
}
/* explicitly opening a viewer brings it back from closed */
/**
 * Select a show-panel tab (reopening it if ×-closed) and re-render.
 * @param {string} key project key
 * @param {string} vk viewer key ('pdf' | rel | '__proposal' | …)
 * @returns {void}
 */
export function selectViewer(key, vk) {
  perOf(key).viewerKey = vk;
  const closed = getClosedViewers(key);
  if (closed.delete(String(vk))) persistClosedViewers(key, closed);
}

/* displays added by hand via the ＋ tab — persisted per project, so they stay
   in the strip even when they fall out of the recent-artifacts window */
/**
 * @param {string} key project key
 * @returns {{ kind: string, rel: string }[]} ＋-added display tabs (localStorage-backed)
 */
export function getAddedViewers(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(`addedViewers:${key}`) || '[]');
    return Array.isArray(arr) ? arr.filter(v => v && v.rel) : [];
  } catch { return []; }
}
/**
 * @param {string} key project key
 * @param {{ kind: string, rel: string }[]} arr
 * @returns {void}
 */
export function persistAddedViewers(key, arr) {
  localStorage.setItem(`addedViewers:${key}`, JSON.stringify(arr));
}

/* ＋ tab: pick a display for the show panel. .tex → live latexmk watch;
   .html/.pdf → display tab. Both then refresh themselves: the artifact
   watcher broadcasts on save and the panel re-renders. */
/**
 * ＋ tab flow: pick a file → live watch (.tex) or a persisted display tab.
 * @param {string} key project key
 * @returns {Promise<void>}
 */
export async function addDisplay(key) {
  let rel = null;
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    const r = await api('POST', '/api/pickfile', {
      project: key,
      types: ['tex', 'pdf', 'html', 'htm', 'md', 'markdown'],
      prompt: 'Show in {name} — .tex live-compiles, .html/.pdf display',
    });
    if (!r || r.canceled) return;
    rel = r.rel;
  } else {
    // remote: the native dialog would open on the server's screen
    rel = prompt(`Path to a .tex / .html / .pdf / .md in ${state.projects[key]?.name || key} (relative to project root):`, '');
    if (!rel || !rel.trim()) return;
    rel = rel.trim();
  }
  const ext = rel.split('.').pop().toLowerCase();
  if (ext === 'tex') {
    const r = await api('POST', '/api/pdf/watch', { project: key, tex: rel });
    if (r && !r.error) {
      if (!state.pdf[key]) state.pdf[key] = { tex: rel, pdf: null, state: 'building' };
      selectViewer(key, 'pdf');
      toast(`watching ${rel} — recompiles and refreshes on every save`);
      renderWB(key);
    } else if (r && r.error) toast(r.error);
  } else if (ext === 'pdf' || ext === 'html' || ext === 'htm' || ext === 'md' || ext === 'markdown') {
    const arr = getAddedViewers(key);
    if (!arr.some(v => v.rel === rel)) {
      arr.push({ rel, kind: ext === 'pdf' ? 'pdfart' : (ext === 'md' || ext === 'markdown') ? 'md' : 'html' });
      persistAddedViewers(key, arr);
    }
    selectViewer(key, rel);
    renderWB(key);
  } else {
    toast(`the show panel displays .html, .pdf and .md (or .tex to live-compile) — got .${ext}`);
  }
}

/* proposal previews render INSIDE the show panel as a closable tab —
   never a full-screen takeover */
/** @type {{ [project: string]: { html: string, title?: string } }} */
export const proposalPreview = {}; // project → { html, title }

/**
 * Show a propose-mode preview in the __proposal viewer tab.
 * @param {string} key project key
 * @param {string} html
 * @param {string} [title]
 * @returns {void}
 */
export function showProposalInPanel(key, html, title) {
  proposalPreview[key] = { html, title };
  perOf(key).viewerKey = '__proposal';
  renderWB(key);
}

/**
 * @param {string} key project key
 * @returns {void}
 */
export function closeProposal(key) {
  delete proposalPreview[key];
  if (perOf(key).viewerKey === '__proposal') perOf(key).viewerKey = null;
  renderWB(key);
}

/**
 * One-line live-watch status text.
 * @param {PdfWatchEntry} e
 * @returns {string}
 */
export function pdfStateTxt(e) {
  return e.state === 'building'
    ? `⟳ building${e.pass ? ` · ${e.pass.rule} pass ${e.pass.n}` : ''}…`
    : e.state === 'error'
      ? (e.dead ? '✗ compiler crashed — restarts on your next save' : '✗ build error')
      : `built${e.lastBuildMs ? ' in ' + (e.lastBuildMs / 1000).toFixed(1) + 's' : ''} ✓`;
}

// Mount (or re-attach) the project's PDF.js pane into a freshly rendered
// viewer slot, and (re)load the document only when a new build landed.
/**
 * Mount (or re-attach) the project's live-watch PDF pane into a fresh render.
 * @param {string} key project key
 * @param {Element} root the project view root
 * @returns {void}
 */
export function mountPdfPane(key, root) {
  const host = root.querySelector('#pdfPaneHost');
  if (!host) return;
  let pane = pdfPanes[key];
  if (!pane) {
    pane = pdfPanes[key] = createPdfPane({
      buildStatus: true, // the live watch carries the staged bar + ✓/✗ verdict
      onSyncEdit: (page, x, y) => {
        const e = state.pdf?.[key];
        const rel = e?.pdf ? relOf(key, e.pdf) : null; // resolve at click time — the watch can move
        if (rel) synctexEditOpen(key, rel, page, x, y);
      },
      onVerdictClick: () => verdictClick(key),
      // The watch pane still uses the document transaction: save every dirty
      // included source, then runFile recognizes the live-watch root and
      // returns without starting a competing one-shot latexmk.
      onRunClick: () => {
        const e = state.pdf?.[key];
        const texRel = e?.tex ? relOf(key, e.tex) : null;
        if (!texRel) return;
        texPaneRun(key, texRel);
      },
    });
  }
  if (pane.el.parentElement !== host) host.appendChild(pane.el);
  pane.restoreScroll(); // re-parenting zeroes the scroll position
  const e = state.pdf?.[key];
  pane.setBuildStatus(e);
  const watchTexRel = e?.tex ? relOf(key, e.tex) : null;
  if (watchTexRel) void primeTexInputs(key, watchTexRel).then(() => syncTexRunControls(key));
  syncTexRunControls(key);
  const src = pdfSrc(key);
  if (src && (e?.lastBuiltAt || '') !== (pane.builtStamp ?? '__never')) {
    pane.load(`${src}?t=${enc(e?.lastBuiltAt || '0')}`, { keepPlace: true, builtStamp: e?.lastBuiltAt || '' });
  }
}

/* ── artifact .pdf tabs render through the same themed pane ──
   Chrome's iframe viewer brought its own gray toolbar (thumbnails, title,
   Drive, download, print) that can't be styled. One pane per open pdf tab,
   kept across renders like the live-watch pane; rebuilt files reload in
   place (keep-place) via artifact:new; dblclick still inverse-SyncTeXes
   when a .synctex.gz sits next to the pdf. */

/**
 * @param {string} key project key
 * @param {string} rel
 * @returns {string} pdfPanes cache key for an artifact pane
 */
export function artPaneKey(key, rel) { return `${key}::${rel}`; }

/* clicking the toolbar verdict (✓/✗/⟳) opens the ▶ output pane — the build
   card holds the story behind the chip. A live watch with no run to show
   falls back to jumping the editor to the first compile error. */
function verdictClick(key) {
  if (state.runs[key] || runBufs[key]) {
    perOf(key).sessTab = 'run';
    renderWB(key);
    return;
  }
  const err = state.pdf?.[key]?.problems?.find((pr) => pr.kind === 'error');
  if (err && err.file) texOpenAt(key, err.file, err.line || 1, 1);
}

function getArtPane(key, rel) {
  const pk = artPaneKey(key, rel);
  let pane = pdfPanes[pk];
  if (!pane) {
    const texRel = /\.pdf$/i.test(rel) ? rel.replace(/\.pdf$/i, '.tex') : null;
    pane = pdfPanes[pk] = createPdfPane({
      // a ▶ run of the matching .tex reports on THIS pane too (bar + verdict)
      // — syncTexRunPane feeds it; unrelated pdfs simply never get fed
      buildStatus: true,
      onSyncEdit: (page, x, y) => synctexEditOpen(key, rel, page, x, y),
      onVerdictClick: () => verdictClick(key),
      onRunClick: texRel ? () => texPaneRun(key, texRel) : null,
    });
    pane.el.classList.add('artFrame');
    pane.el.dataset.vk = rel;
    // toolbar ▶ only on TEX-BACKED pdfs: probe once for the sibling source
    // (HEAD is header-only on the /artifact GET route). The reveal happens at
    // pane birth, before anyone is aiming — never mid-interaction.
    if (texRel) {
      fetch(artifactUrl(key, texRel), { method: 'HEAD' })
        .then(async (r) => {
          if (!r.ok) return;
          pane.texRel = texRel;
          await primeTexInputs(key, texRel);
          syncTexRunControls(key);
        })
        .catch(() => { /* no sibling .tex — the pane stays a plain viewer */ });
    }
  }
  return pane;
}

function artPaneStamp(key, rel) {
  return state.artifacts.find((a) => a.project === key && a.rel === rel)?.mtime || 'init';
}

/** Get the pane element for an artifact pdf, loading only when the file
 *  actually changed since the last load (stamp = artifact mtime). */
function mountedArtPaneEl(key, rel) {
  const pane = getArtPane(key, rel);
  const stamp = artPaneStamp(key, rel);
  if (stamp !== pane.builtStamp) {
    pane.load(`${artifactUrl(key, rel)}?t=${enc(stamp)}`, { keepPlace: true, builtStamp: stamp });
  }
  syncTexRunControls(key); // ▶/⊘ + dot may have moved while the tab was hidden
  return pane;
}

/**
 * Destroy a cached artifact pdf pane (tab closed / project gone).
 * @param {string} key project key
 * @param {string} rel
 * @returns {void}
 */
export function artPaneDestroy(key, rel) {
  const pk = artPaneKey(key, rel);
  pdfPanes[pk]?.destroy();
  delete pdfPanes[pk];
}

/**
 * Mount/re-attach every artifact pdf pane the current render shows.
 * @param {string} key project key
 * @param {Element} root the project view root
 * @returns {void}
 */
export function mountArtPanes(key, root) {
  root.querySelectorAll('.pdfPaneHost.artHost[data-vk]').forEach((host) => {
    const rel = host.dataset.vk;
    const pane = mountedArtPaneEl(key, rel);
    pane.el.classList.toggle('vhid', host.classList.contains('vhid'));
    host.replaceWith(pane.el);
    pane.restoreScroll(); // re-parenting zeroes the scroll position
  });
  syncTexRunPane(key); // a fresh mount adopts the current run's verdict
  // a freshly-rendered markdown pane starts as an empty shell — fill it
  root.querySelectorAll('.mdPane[data-vk]:not(.vhid)').forEach((p) => syncMdPane(key, p.dataset.vk));
}

/**
 * The show panel: tabs strip + the selected viewer's frame html.
 * @param {string} key project key
 * @param {ViewerSel | null} vsel the selected viewer descriptor
 * @param {PdfWatchEntry | null | undefined} pdfEntry
 * @returns {string} html
 */
export function viewerHtml(key, vsel, pdfEntry) {
  if (!vsel) {
    return `<div class="viewerTop"><div class="noCode inViewer"><div class="big">⌗</div>
      <div>no artifacts yet in <b>${esc(state.projects[key]?.name || key)}</b><br>
      html + pdf files appear here as sessions create them<br>
      <span style="font-size:11px;">or ⊕ watch a .tex for a live-compiled deck</span></div></div></div>`;
  }
  if (vsel.kind === 'pdf') {
    const src = pdfSrc(key);
    const e = pdfEntry || {};
    return `<div class="viewerTop">
      ${src && (e.lastBuiltAt || e.state === 'built')
        ? `<div class="pdfPaneHost" id="pdfPaneHost"></div>`
        : `<div class="pdfPage"><div class="t1">waiting for first build…</div><div class="t2">${esc(e.tex || '')}</div></div>`}
      <div class="viewerBar" id="pdfStatusBar">
        <span class="rec"><i></i>watching ${esc((e.tex && relOf(key, e.tex)) || e.tex || '')}</span>
        <span id="pdfPagesTxt">${e.pages ? `${esc(e.pages)} pages` : ''}</span>
        <span id="pdfStateTxt" style="margin-left:auto;">${esc(pdfStateTxt(e))}</span>
        <span id="unwatchTex" style="cursor:pointer;color:var(--dim);" title="stop watching">✕ unwatch</span>
      </div></div>`;
  }
  if (vsel.kind === 'proposal') {
    const pp = proposalPreview[key] || { html: '', title: '' };
    return `<div class="viewerTop">
      <iframe class="artFrame" sandbox="allow-scripts" srcdoc="${esc(pp.html)}" title="proposal preview"></iframe>
      <div class="viewerBar"><span style="color:var(--yellow)">⌗ ${esc(pp.title)} — read-only preview of the proposed change</span>
      <span id="closeProposal" style="margin-left:auto;cursor:pointer;color:var(--dim);">✕ close</span></div></div>`;
  }
  const url = artifactUrl(key, vsel.key);
  if (vsel.kind === 'pdfart') {
    // the themed pane mounts into this host in wireWB (mountArtPanes)
    return `<div class="viewerTop">
      <div class="pdfPaneHost artHost" data-vk="${esc(vsel.key)}"></div>
      <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
  }
  if (vsel.kind === 'datav') {
    // fully sandboxed: the page is static html+css from our own server
    return `<div class="viewerTop">
      <iframe class="artFrame" data-vk="${esc(vsel.key)}" sandbox="" src="${esc(dataviewUrl(key, vsel.key))}&t=${Date.now()}" title="${esc(vsel.label)}"></iframe>
      <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
  }
  if (vsel.kind === 'md') {
    // rendered markdown — a themed div (not an iframe): the content comes
    // from OUR renderer (marked + DOMPurify + KaTeX, console typography),
    // filled by syncMdPane after mount; live-updates from the editor's draft
    return `<div class="viewerTop">
      <div class="artFrame mdPane" data-vk="${esc(vsel.key)}"><div class="mdBody csMd"></div></div>
      <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
  }
  // html artifact — either the live WYSIWYG editor or the normal scripted view
  if (htmlEdits[key] && htmlEdits[key].rel === vsel.key) {
    return `<div class="viewerTop">
      <div class="editBar" id="editBar">
        <button data-cmd="bold" title="bold (⌘B)"><b>B</b></button>
        <button data-cmd="italic" title="italic (⌘I)"><i>I</i></button>
        <button data-cmd="underline" title="underline (⌘U)"><u>U</u></button>
        <span class="ebSep"></span>
        <button data-cmd="formatBlock" data-arg="h1" title="heading 1">H1</button>
        <button data-cmd="formatBlock" data-arg="h2" title="heading 2">H2</button>
        <button data-cmd="formatBlock" data-arg="h3" title="heading 3">H3</button>
        <button data-cmd="formatBlock" data-arg="p" title="normal paragraph">¶</button>
        <span class="ebSep"></span>
        <button data-cmd="insertUnorderedList" title="bullet list">•≡</button>
        <button data-cmd="insertOrderedList" title="numbered list">1≡</button>
        <button data-cmd="link" title="make selection a link">⛓</button>
        <button data-cmd="removeFormat" title="strip formatting from selection">✕fmt</button>
        <span class="ebSep"></span>
        <button data-cmd="undo" title="undo">↶</button>
        <button data-cmd="redo" title="redo">↷</button>
        <span id="htmlDirty" class="ebDirty"></span>
        <button id="htmlSaveBtn" class="ebSave" title="write to disk (⌘S)">save</button>
        <button id="htmlDoneBtn" class="ebDone" title="finish editing">✓ done</button>
      </div>
      <iframe id="htmlEditFrame" class="artFrame" sandbox="allow-same-origin" src="${esc(url)}" title="editing ${esc(vsel.key)}"></iframe>
      <div class="viewerBar"><span style="color:var(--yellow)">✎ editing ${esc(vsel.key)} — click into the page and type. Scripts are paused, so math/plots show as source.</span></div>
    </div>`;
  }
  return `<div class="viewerTop">
    <iframe class="artFrame" data-vk="${esc(vsel.key)}" sandbox="allow-scripts" src="${esc(url)}" title="${esc(vsel.label)}"></iframe>
    <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
}

/* bar under a plain artifact iframe (html or pdf file) — shared by the full
   render and the in-place tab switch */
function artBarHtml(key, vsel) {
  const url = artifactUrl(key, vsel.key);
  if (vsel.kind === 'pdfart') {
    return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span style="margin-left:auto;"><a href="${esc(url)}" target="_blank">open in browser ↗</a></span>`;
  }
  if (vsel.kind === 'datav') {
    return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span>▦ data preview — head rows via pandas</span>
    <span style="margin-left:auto;"><a href="${esc(dataviewUrl(key, vsel.key))}" target="_blank">open in browser ↗</a></span>`;
  }
  if (vsel.kind === 'md') {
    return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span id="mdSrcNote">▤ rendered markdown${drafts[`${key}::${vsel.key}`] != null ? ' — <span style="color:var(--yellow)">previewing your unsaved draft</span>' : ''}</span>
    <span id="mdEditBtn" data-rel="${esc(vsel.key)}" style="margin-left:auto;cursor:pointer;color:var(--green);" title="open the source in the editor">✎ source</span>
    <span style="margin-left:14px;"><a href="${esc(fileUrl(key, vsel.key))}" target="_blank">raw ↗</a></span>`;
  }
  return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span id="htmlEditBtn" data-rel="${esc(vsel.key)}" style="margin-left:auto;cursor:pointer;color:var(--green);" title="edit this page in place">✎ edit</span>
    <span style="margin-left:14px;"><a href="${esc(url)}" target="_blank">open in browser ↗</a></span>`;
}

/* the kept viewer stack: every plain artifact iframe (html / pdf file) stays
   mounted once shown — detaching an iframe makes the browser reload it, so
   hidden tabs are display:none'd, never removed. This surfaces vsel's frame,
   creating it on first visit, and rebuilds the bar fresh (wireWB rewires it). */
/**
 * Reconcile the KEPT viewer stack (iframes/panes survive re-renders; only
 * visibility and stale srcs change).
 * @param {Element} top the viewer pane host
 * @param {string} key project key
 * @param {ViewerSel | null} vsel
 * @returns {void}
 */
export function syncViewerStack(top, key, vsel) {
  const bar = top.querySelector(':scope > .viewerBar');
  let frame = top.querySelector(`:scope > .artFrame[data-vk="${CSS.escape(vsel.key)}"]`);
  if (!frame) {
    if (vsel.kind === 'pdfart') {
      frame = mountedArtPaneEl(key, vsel.key).el; // themed pane, not an iframe
    } else if (vsel.kind === 'md') {
      frame = document.createElement('div');
      frame.className = 'artFrame mdPane';
      frame.dataset.vk = vsel.key;
      frame.innerHTML = '<div class="mdBody csMd"></div>';
    } else {
      frame = document.createElement('iframe');
      frame.className = 'artFrame';
      frame.dataset.vk = vsel.key;
      frame.title = vsel.label || vsel.key;
      const url = artifactUrl(key, vsel.key);
      if (vsel.kind === 'datav') {
        frame.setAttribute('sandbox', '');
        frame.src = `${dataviewUrl(key, vsel.key)}&t=${Date.now()}`;
      } else { frame.setAttribute('sandbox', 'allow-scripts'); frame.src = url; }
    }
    top.insertBefore(frame, bar);
    if (vsel.kind === 'pdfart') pdfPanes[artPaneKey(key, vsel.key)]?.restoreScroll();
  }
  top.querySelectorAll(':scope > .artFrame[data-vk]').forEach(f =>
    f.classList.toggle('vhid', f.dataset.vk !== vsel.key));
  if (vsel.kind === 'md') syncMdPane(key, vsel.key);
  bar.innerHTML = artBarHtml(key, vsel);
}

/* ── rendered markdown pane ──
   Fills the shown .mdPane with the CURRENT text of its file: the editor's
   unsaved draft when one exists (live preview while typing — the editor's
   input handler calls this debounced), else the cached/fetched disk copy
   (refreshed on file:changed while a session edits it). Renders with the
   console's own pipeline (md() = marked + DOMPurify + math stash; katexEl),
   patches only when the source actually changed, and keeps the reader's
   scroll position across re-renders. */
function syncMdPane(key, rel) {
  const pane = document.querySelector(`#v-${key} .mdPane[data-vk="${CSS.escape(rel)}"]`);
  if (!pane) return;
  const fk = `${key}::${rel}`;
  let text = drafts[fk];
  if (text == null) {
    const c = fileCache[fk];
    if (!c) {
      // fetch once, then re-sync when it lands
      ensureFile(key, rel).then(() => syncMdPane(key, rel));
      pane.querySelector('.mdBody').innerHTML = '<span class="cm">— loading…</span>';
      pane._src = null;
      return;
    }
    if (c.loading) return; // the in-flight fetch above re-syncs on arrival
    text = c.error ? `*could not load ${rel} — ${c.error}*` : c.text;
  }
  // the bar's draft note stays honest while typing (no full render happens)
  if (perOf(key).viewerKey === rel) {
    const note = document.querySelector(`#v-${key} #mdSrcNote`);
    if (note) {
      note.innerHTML = `▤ rendered markdown${drafts[fk] != null
        ? ' — <span style="color:var(--yellow)">previewing your unsaved draft</span>' : ''}`;
    }
  }
  // paper-dialect math for the pane too — same widened sources as the
  // console. Computed before the rev is read — harvesting bumps it.
  const macros = texMacrosVisible(key, curTask(key));
  if (pane._src === text && pane._mac === texMacroRev) return; // unchanged — don't re-typeset
  pane._src = text;
  pane._mac = texMacroRev;
  const body = pane.querySelector('.mdBody');
  const keep = pane.scrollTop;
  body.innerHTML = md(text);
  katexEl(body, macros);
  // relative images/links resolve against the FILE's folder — /artifact for
  // in-root files, the task's /api/extfile grant for external pins; every
  // link opens a new tab — a click must never navigate the dashboard away
  const dir = rel.split('/').slice(0, -1).join('/');
  const resolve = (src) => fileUrl(key, (dir ? dir + '/' : '') + src.replace(/^\.\//, ''));
  const isRelative = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
  body.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (isRelative(src)) img.src = resolve(src);
  });
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (isRelative(href)) a.href = resolve(href);
    if (String(a.getAttribute('href') || '').startsWith('#')) {
      // md() renders without header ids, and location.hash is the app's view
      // routing — a stray in-page anchor must not hijack it
      a.addEventListener('click', (e) => e.preventDefault());
    } else {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  });
  pane.scrollTop = keep;
}

// live preview while typing: the editor's input handler pings this — one
// pending render per file, ~250ms after the last keystroke
const mdPreviewTimers = {};
/**
 * Debounced (250ms) live md-pane refresh from the editor's unsaved draft.
 * @param {string} key project key
 * @param {string} rel
 * @returns {void}
 */
export function mdPreviewSchedule(key, rel) {
  const fk = `${key}::${rel}`;
  clearTimeout(mdPreviewTimers[fk]);
  mdPreviewTimers[fk] = setTimeout(() => syncMdPane(key, rel), 250);
}

/**
 * Cancel the pending debounced preview for one fkey — the M7 disposal-matrix
 * "cancel timers (preview debounce)" step (monaco-s05 §M7 T3). Only
 * monacoPane.reallyDispose calls this, strictly for the fkey it is retiring;
 * a no-op when nothing is pending, and the legacy editor path never routes
 * through it (legacy renders own no models to dispose).
 * @param {string} fk `${key}::${rel}`
 * @returns {void}
 */
export function mdPreviewCancel(fk) {
  clearTimeout(mdPreviewTimers[fk]);
  delete mdPreviewTimers[fk];
}
