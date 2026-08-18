// pdfPane.js — in-app PDF renderer for live LaTeX previews (PDF.js, served
// from /vendor/pdfjs). Replaces the reload-the-iframe approach so rebuilds
// keep scroll + zoom, never white-flash, and support SyncTeX both ways:
// double-click a page → onSyncEdit(page, x, y) (PDF points, top-left origin,
// the synctex convention) → the caller jumps the editor; scrollTo() flashes a
// highlight box from a forward search.
//
// Rendering: every page gets a fixed-size box up front (stable scrollbar),
// canvases render lazily for the viewport ±1 page and far pages are freed.
// A rebuild loads the new document into the existing boxes page-by-page —
// old pixels stay until each page's fresh canvas is ready.

'use strict';

import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const RENDER_MARGIN = 1;   // pages beyond the viewport to keep rendered
const MAX_LIVE = 10;       // rendered canvases kept before far ones are freed
const PAGE_GAP = 12;       // px between pages (matches .pdfPageBox margin)

// PDF.js 6 owns document/worker teardown through PDFDocumentLoadingTask, not
// PDFDocumentProxy. Keep one idempotent cleanup promise per task so a stale
// generation and pane destruction can safely converge on the same resource.
const taskDestructions = new WeakMap();
function destroyLoadingTask(task) {
  if (!task) return Promise.resolve();
  const existing = taskDestructions.get(task);
  if (existing) return existing;
  const cleanup = Promise.resolve()
    .then(() => task.destroy())
    .catch((err) => {
      console.warn('[pdfPane] loading-task cleanup failed:', err?.message || err);
    });
  taskDestructions.set(task, cleanup);
  return cleanup;
}

/** Honest progress for the staged build bar: latexmk gives no percentages,
 *  only rule-run boundaries, so the bar fills in steps as passes complete
 *  (a typical cycle is 1–3 pdflatex runs) and only 'built' reaches 1. */
export function passFrac(n) {
  if (!n) return 0.08;                       // building, no rule announced yet
  return [0.45, 0.78, 0.88][n - 1] || 0.9;
}

/** The bar must move CONTINUOUSLY, not sit frozen between pass boundaries:
 *  each boundary starts one long front-loaded transition that quickly clears
 *  the honest stop for pass n, then creeps toward (never past) the next stop.
 *  Only 'built' may take it to 1. */
export function creepTarget(n) {
  return [0.4, 0.73, 0.86, 0.93][Math.min(n || 0, 3)];
}
export const CREEP_EASE = 'transform 12s cubic-bezier(.08,.82,.17,1)';

export function createPdfPane({ onSyncEdit, buildStatus = false, onVerdictClick, onRunClick } = {}) {
  const el = document.createElement('div');
  el.className = 'pdfPane';
  el.innerHTML = `
    <div class="pdfToolbar">
      <span class="pzRun" hidden><b>▶</b><i class="pzDot"></i></span>
      <span class="pzBtn" data-pz="out" title="zoom out">−</span>
      <span class="pzPct" title="reset to fit width">fit</span>
      <span class="pzBtn" data-pz="in" title="zoom in">＋</span>
      <span class="pdfPageNo" title="jump to a page"></span>
    </div>
    <div class="pdfScroll"></div>`;
  const scroll = el.querySelector('.pdfScroll');
  const pageNo = el.querySelector('.pdfPageNo');
  const pctEl = el.querySelector('.pzPct');

  // ▶ leads the zoom cluster on tex-backed panes. ONE fixed box —
  // every state swaps glyph + color only, the geometry never moves; the
  // corner dot signals an unsaved tex draft. The pane only draws the control;
  // meaning (run vs stop vs save-now) lives in the caller's onRunClick and
  // the state fed through setRun.
  const runEl = el.querySelector('.pzRun');
  if (onRunClick) runEl.addEventListener('click', () => onRunClick());

  // live-watch panes carry the build status: a staged bar across the top of
  // the box + a ✓/✗/⟳ verdict chip in the toolbar (see setBuildStatus below)
  let buildBar = null;
  let verdict = null;
  if (buildStatus) {
    buildBar = document.createElement('div');
    buildBar.className = 'pdfBuildBar off';
    buildBar.innerHTML = '<div class="fill"></div>';
    el.prepend(buildBar);
    verdict = document.createElement('span');
    verdict.className = 'pdfVerdict';
    verdict.hidden = true;
    pageNo.before(verdict);
    verdict.addEventListener('click', () => {
      if (onVerdictClick) onVerdictClick(pane.lastBuildState);
    });
  }

  const pane = {
    el,
    doc: null,
    worker: null,       // one explicit PDFWorker reused across this pane's reloads
    loadingTask: null,  // committed task backing pane.doc/current page renders
    pendingTask: null,  // newest getDocument still loading/reading geometry
    retiredTasks: new Map(), // previous task → delayed cleanup timer (at most one)
    boxes: [],          // per page: {box, canvas?, textDiv?, renderedScale, renderTask, wPt, hPt}
    scale: 1,
    fit: true,          // fit-width until the user zooms explicitly
    savedScroll: 0,     // survives DOM re-parenting (renderWB rebuilds hosts)
    builtStamp: null,   // callers compare against entry.lastBuiltAt
    generation: 0,      // invalidates in-flight loads/renders
    destroyed: false,
  };

  function ensureWorker() {
    if (!pane.worker || pane.worker.destroyed) {
      pane.worker = new pdfjsLib.PDFWorker({ name: 'central-planner-pdf' });
    }
    return pane.worker;
  }

  // Old pixels may still be on screen while the replacement canvases settle,
  // so retain the immediately previous transport briefly. Anything older can
  // no longer back a visible render and is cleaned immediately; reload storms
  // are therefore bounded to current + pending + one retired document.
  function retireCommittedTask(task) {
    if (!task) return;
    for (const [older, timer] of pane.retiredTasks) {
      clearTimeout(timer);
      pane.retiredTasks.delete(older);
      void destroyLoadingTask(older);
    }
    const timer = setTimeout(() => {
      pane.retiredTasks.delete(task);
      void destroyLoadingTask(task);
    }, 2000);
    pane.retiredTasks.set(task, timer);
  }

  function cancelPendingTask() {
    const task = pane.pendingTask;
    pane.pendingTask = null;
    if (task) void destroyLoadingTask(task);
  }

  scroll.addEventListener('scroll', () => {
    pane.savedScroll = scroll.scrollTop;
    scheduleRender();
  });

  // divider drags resize the pane — refit (debounced, drags fire per-frame)
  let refitTimer = null;
  const ro = new ResizeObserver(() => {
    if (!pane.fit || !pane.doc) return;
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => pane.refit(), 150);
  });
  ro.observe(scroll);

  el.querySelectorAll('.pzBtn').forEach((b) => b.addEventListener('click', () => {
    const factor = b.dataset.pz === 'in' ? 1.2 : 1 / 1.2;
    setZoom(pane.scale * factor, false);
  }));
  pctEl.addEventListener('click', () => setZoom(fitScale(), true));

  // click the page indicator → the current page pre-selected in an input →
  // type a number, Enter jumps (no cryptic placeholder; typing replaces)
  pageNo.addEventListener('click', () => {
    if (!pane.doc || pageNo.querySelector('input')) return;
    const total = pane.boxes.length;
    const cur = pageNo.textContent.split('/')[0].trim() || '1';
    pageNo.innerHTML = `<input class="pzJump" type="text" inputmode="numeric"> / ${total}`;
    const inp = pageNo.querySelector('input');
    inp.value = cur;
    inp.focus();
    inp.select();
    let settled = false;
    const done = (commit) => {
      if (settled) return;
      settled = true;
      const n = commit ? Math.max(1, Math.min(total, parseInt(inp.value, 10) || 0)) : 0;
      if (commit && n) pane.scrollToPage(n);
      renderVisible(); // repaints the plain "x / y" text
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(false));
  });

  scroll.addEventListener('dblclick', (e) => {
    if (!onSyncEdit) return;
    const box = e.target.closest('.pdfPageBox');
    if (!box) return;
    const r = box.getBoundingClientRect();
    // CSS px → PDF points; synctex measures from the page's top-left
    const x = (e.clientX - r.left) / pane.scale;
    const y = (e.clientY - r.top) / pane.scale;
    onSyncEdit(Number(box.dataset.page), x, y);
  });

  function fitScale() {
    const w = pane.boxes[0]?.wPt;
    if (!w || !scroll.clientWidth) return pane.scale;
    return Math.max(0.2, (scroll.clientWidth - 28) / w);
  }

  function setZoom(scale, fit) {
    scale = Math.min(4, Math.max(0.2, scale));
    if (!pane.doc || scale === pane.scale) { pane.fit = fit; paintPct(); return; }
    // keep the top-visible point stable through the zoom
    const anchor = (scroll.scrollTop + 1) / Math.max(1, scroll.scrollHeight);
    pane.scale = scale;
    pane.fit = fit;
    sizeBoxes();
    scroll.scrollTop = anchor * scroll.scrollHeight - 1;
    pane.savedScroll = scroll.scrollTop;
    for (const b of pane.boxes) b.renderedScale = null; // stale — re-raster
    paintPct();
    scheduleRender();
  }

  function paintPct() {
    pctEl.textContent = pane.fit ? 'fit' : `${Math.round(pane.scale * 100)}%`;
  }

  function sizeBoxes() {
    for (const b of pane.boxes) {
      b.box.style.width = `${b.wPt * pane.scale}px`;
      b.box.style.height = `${b.hPt * pane.scale}px`;
    }
  }

  function visibleRange() {
    const top = scroll.scrollTop;
    const bottom = top + scroll.clientHeight;
    let first = 0;
    let last = pane.boxes.length - 1;
    let y = 0;
    for (let i = 0; i < pane.boxes.length; i++) {
      const h = pane.boxes[i].hPt * pane.scale + PAGE_GAP;
      if (y + h > top) { first = i; break; }
      y += h;
    }
    let y2 = y;
    for (let i = first; i < pane.boxes.length; i++) {
      y2 += pane.boxes[i].hPt * pane.scale + PAGE_GAP;
      if (y2 >= bottom) { last = i; break; }
    }
    return [first, last];
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderVisible(); });
  }

  async function renderPage(i, gen) {
    const b = pane.boxes[i];
    if (!b || b.renderedScale === pane.scale || b.rendering) return;
    b.rendering = true;
    // capture the scale at entry: a zoom mid-flight must not stamp these
    // (old-scale) pixels as current — the finally block re-schedules instead
    const scale = pane.scale;
    try {
      const page = await pane.doc.getPage(i + 1);
      if (gen !== pane.generation) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: page.getViewport({ scale: scale * dpr }),
      });
      b.renderTask = task;
      await task.promise;
      if (gen !== pane.generation) return;
      // swap in the fresh canvas only now — the old pixels covered the wait
      b.box.querySelector('canvas')?.remove();
      b.box.prepend(canvas);
      b.canvas = canvas;
      b.renderedScale = scale;
      await paintTextLayer(b, page, viewport, gen, scale);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('[pdfPane] render page', i + 1, err?.message || err);
      }
    } finally {
      b.rendering = false;
      // superseded by a newer generation or a zoom while in flight — repaint
      // under the CURRENT state so no page is left stale with no self-heal
      if (gen !== pane.generation || b.renderedScale !== pane.scale) scheduleRender();
    }
  }

  async function paintTextLayer(b, page, viewport, gen, scale = pane.scale) {
    try {
      const div = document.createElement('div');
      div.className = 'textLayer';
      div.style.setProperty('--scale-factor', String(scale));
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: false }),
        container: div,
        viewport,
      });
      await tl.render();
      if (gen !== pane.generation) return;
      b.box.querySelector('.textLayer')?.remove();
      b.box.appendChild(div);
      b.textDiv = div;
    } catch { /* selectable text is a nicety — never block the canvas on it */ }
  }

  function freeFarPages(first, last) {
    const live = pane.boxes.filter((b) => b.canvas);
    if (live.length <= MAX_LIVE) return;
    for (const b of live) {
      const i = pane.boxes.indexOf(b);
      if (i >= first - RENDER_MARGIN - 1 && i <= last + RENDER_MARGIN + 1) continue;
      b.canvas.remove();
      b.textDiv?.remove();
      b.canvas = null;
      b.textDiv = null;
      b.renderedScale = null;
    }
  }

  // the page the reader would SAY they're on: the one covering the most of
  // the viewport — a sliver of the previous page at the top must not win
  // (it used to: the label read the top-visible page, so a jump that landed
  // a subpixel shy of the boundary reported the page before the target)
  function dominantPage(first, last) {
    const top = scroll.scrollTop;
    const bottom = top + scroll.clientHeight;
    let y = 0;
    for (let i = 0; i < first; i++) y += pane.boxes[i].hPt * pane.scale + PAGE_GAP;
    let best = first;
    let bestPx = -1;
    for (let i = first; i <= last; i++) {
      const h = pane.boxes[i].hPt * pane.scale + PAGE_GAP;
      const overlap = Math.min(y + h, bottom) - Math.max(y, top);
      if (overlap > bestPx) { bestPx = overlap; best = i; }
      y += h;
    }
    return best;
  }

  function renderVisible() {
    if (!pane.doc || !pane.boxes.length) return;
    const [first, last] = visibleRange();
    // reserve the width of the widest possible indicator ("NN / NN") so the
    // current page growing a digit (9 → 10) never shifts its toolbar
    // neighbors (border-box: the clickable padding+border ride on top)
    const d = String(pane.boxes.length).length;
    pageNo.style.minWidth = `calc(${2 * d + 3}ch + 16px)`;
    pageNo.textContent = `${dominantPage(first, last) + 1} / ${pane.boxes.length}`;
    const gen = pane.generation;
    for (let i = Math.max(0, first - RENDER_MARGIN); i <= Math.min(pane.boxes.length - 1, last + RENDER_MARGIN); i++) {
      renderPage(i, gen);
    }
    freeFarPages(first, last);
  }

  const staleNote = (on) => {
    let n = el.querySelector('.pdfStaleNote');
    if (on && !n) {
      n = document.createElement('span');
      n.className = 'pdfStaleNote';
      n.textContent = 'showing previous build ⟳';
      pageNo.before(n);
    } else if (!on && n) n.remove();
  };

  /** (Re)load `url`. keepPlace preserves scroll + zoom (rebuild); otherwise
   *  starts at the top in fit-width. Old pages stay visible until replaced,
   *  and a failed load (a mid-write read during a rebuild, a transient parse
   *  error) NEVER wipes a good render — it keeps the reader's page and
   *  retries with backoff. */
  pane.load = async (url, { keepPlace = true, builtStamp = null } = {}) => {
    if (pane.destroyed) return;
    const gen = ++pane.generation;
    clearTimeout(pane.retryTimer);
    cancelPendingTask();
    if (builtStamp !== pane.tryStamp) { // a genuinely new build resets the budget
      pane.tryStamp = builtStamp;
      pane.loadTries = 0;
    }
    let task = null;
    let doc = null;
    try {
      task = pdfjsLib.getDocument({ url, worker: ensureWorker() });
      pane.pendingTask = task;
      doc = await task.promise;
    } catch (err) {
      if (pane.pendingTask === task) pane.pendingTask = null;
      void destroyLoadingTask(task);
      if (gen !== pane.generation) return;
      pane.loadTries += 1;
      if (pane.loadTries <= 3) {
        staleNote(true);
        pane.retryTimer = setTimeout(() => {
          if (gen === pane.generation) pane.load(url, { keepPlace: true, builtStamp });
        }, 500 * pane.loadTries);
        return;
      }
      staleNote(false);
      if (!pane.boxes.length) {
        scroll.innerHTML = `<div class="pdfLoadErr">could not render the PDF — ${String(err?.message || err).slice(0, 200)}</div>`;
      } else {
        console.error('[pdfPane] keeping the previous render — load kept failing:', err?.message || err);
      }
      return;
    }
    if (gen !== pane.generation || pane.destroyed) {
      if (pane.pendingTask === task) pane.pendingTask = null;
      void destroyLoadingTask(task);
      return;
    }
    pane.loadTries = 0;
    staleNote(false);

    // page geometry up front → stable boxes, stable scrollbar
    const dims = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (gen !== pane.generation || pane.destroyed) {
        if (pane.pendingTask === task) pane.pendingTask = null;
        void destroyLoadingTask(task);
        return;
      }
      const vp = page.getViewport({ scale: 1 });
      dims.push({ wPt: vp.width, hPt: vp.height });
    }

    const oldTask = pane.loadingTask;
    pane.pendingTask = null;
    pane.loadingTask = task;
    pane.doc = doc;
    pane.builtStamp = builtStamp;

    const sameShape = keepPlace && pane.boxes.length === dims.length
      && pane.boxes.every((b, i) => Math.abs(b.hPt - dims[i].hPt) < 0.5 && Math.abs(b.wPt - dims[i].wPt) < 0.5);

    if (sameShape) {
      // rebuild in place: keep boxes + old pixels, just mark them stale
      pane.boxes.forEach((b, i) => {
        b.wPt = dims[i].wPt;
        b.hPt = dims[i].hPt;
        b.renderedScale = null;
        try { b.renderTask?.cancel(); } catch { /* finished */ }
      });
    } else {
      const keepScroll = keepPlace ? pane.savedScroll : 0;
      scroll.innerHTML = '';
      pane.boxes = dims.map((d, i) => {
        const box = document.createElement('div');
        box.className = 'pdfPageBox';
        box.dataset.page = String(i + 1);
        scroll.appendChild(box);
        return { box, canvas: null, textDiv: null, renderedScale: null, ...d };
      });
      sizeBoxes();
      scroll.scrollTop = keepScroll;
      pane.savedScroll = scroll.scrollTop;
    }
    if (pane.fit) { pane.scale = fitScale(); sizeBoxes(); }
    paintPct();
    scheduleRender();
    retireCommittedTask(oldTask); // after the last old renders settle
  };

  /** Forward search: scroll to a synctex view result and flash its box. */
  pane.scrollTo = ({ page, v = null, H = null, h = null, W = null }) => {
    const b = pane.boxes[page - 1];
    if (!b) return;
    let y = 0;
    for (let i = 0; i < page - 1; i++) y += pane.boxes[i].hPt * pane.scale + PAGE_GAP;
    const targetInPage = v != null ? Math.max(0, (v - (H || 12)) * pane.scale) : 0;
    scroll.scrollTop = Math.max(0, y + targetInPage - scroll.clientHeight * 0.35);
    pane.savedScroll = scroll.scrollTop;
    scheduleRender();
    // flash the located box
    b.box.querySelector('.syncFlash')?.remove();
    const f = document.createElement('div');
    f.className = 'syncFlash';
    const top = v != null ? (v - (H || 12)) * pane.scale : 0;
    f.style.top = `${Math.max(0, top - 2)}px`;
    f.style.left = `${h != null ? Math.max(0, h * pane.scale - 4) : 0}px`;
    f.style.width = W ? `${W * pane.scale + 8}px` : '96%';
    f.style.height = `${((H || 12) + 6) * pane.scale}px`;
    b.box.appendChild(f);
    setTimeout(() => f.remove(), 1800);
  };

  /** Scroll page n's top edge to the top of the viewport — landing 1px
   *  INSIDE the page, so fractional scroll rounding can never leave a sliver
   *  of the previous page claiming the indicator. */
  pane.scrollToPage = (n) => {
    let y = 0;
    for (let i = 0; i < Math.min(n, pane.boxes.length) - 1; i++) y += pane.boxes[i].hPt * pane.scale + PAGE_GAP;
    scroll.scrollTop = y <= 0 ? 0 : y + 1;
    pane.savedScroll = scroll.scrollTop;
    scheduleRender();
  };

  /** The toolbar ▶: {show, running, dirty, title} — any subset. Fixed box,
   *  glyph+color swap only (▶ ↔ ⊘); dirty toggles the amber corner dot. */
  pane.setRun = (o = {}) => {
    if ('show' in o) runEl.hidden = !o.show;
    if ('running' in o) {
      runEl.classList.toggle('running', !!o.running);
      runEl.firstElementChild.textContent = o.running ? '⊘' : '▶';
    }
    if ('dirty' in o) runEl.classList.toggle('dirty', !!o.dirty);
    if ('title' in o) runEl.title = o.title;
  };

  /** Feed one watch/run status entry into the pane's bar + verdict chip
   *  ({state, pass, lastBuildMs, errorMs, dead}). Building fills the bar at
   *  pass boundaries; built completes it and fades; the chip persists until
   *  the next save so the toolbar always answers "did my last save build". */
  pane.setBuildStatus = (e) => {
    if (!buildBar || !e) return;
    const fill = buildBar.firstElementChild;
    clearTimeout(pane.barFadeTimer);
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
    if (e.state === 'building') {
      if (pane.lastBuildState !== 'building') {
        // a fresh build: snap invisibly to the start — the bar must NEVER be
        // seen animating backwards from a previous run's position
        fill.style.transition = 'none';
        fill.style.setProperty('--p', '0.02');
        void fill.offsetWidth; // commit the snap before the transition arms
      }
      buildBar.classList.remove('off');
      // continuous motion: quickly clears this pass's stop, then keeps
      // creeping toward the next one until the next boundary re-aims it
      fill.style.transition = CREEP_EASE;
      fill.style.setProperty('--p', String(creepTarget(e.pass?.n)));
      verdict.hidden = false;
      verdict.className = 'pdfVerdict bld';
      verdict.title = 'compiling — click for the ▶ output pane';
      verdict.innerHTML = `<span class="vspin">⟳</span> ${e.pass ? `${escTxt(e.pass.rule)} · pass ${e.pass.n}` : 'compiling…'}`;
    } else if (e.state === 'built') {
      if (pane.lastBuildState === 'building') {
        // the transition: run the bar to the end, then fade — no layout shift
        buildBar.classList.remove('off');
        fill.style.transition = 'transform .4s ease';
        fill.style.setProperty('--p', '1');
        pane.barFadeTimer = setTimeout(() => buildBar.classList.add('off'), 450);
      } else {
        // mounting on (or re-pinged with) an already-built entry — stay quiet
        buildBar.classList.add('off');
        fill.style.transition = 'none';
        fill.style.setProperty('--p', '1');
      }
      verdict.hidden = false;
      verdict.className = 'pdfVerdict ok';
      verdict.title = 'compiled clean — click for the ▶ output pane';
      verdict.textContent = `✓ ${e.lastBuildMs ? secs(e.lastBuildMs) : ''}`.trim();
    } else if (e.state === 'error') {
      buildBar.classList.add('off');
      verdict.hidden = false;
      verdict.className = 'pdfVerdict no';
      verdict.title = e.dead ? 'compiler crashed — restarts on your next save'
        : 'build failed — click for the details';
      verdict.textContent = `✗ ${e.errorMs ? secs(e.errorMs) : ''}`.trim();
    } else {
      // stopped / unknown — clear the whole surface rather than freeze it
      buildBar.classList.add('off');
      verdict.hidden = true;
    }
    pane.lastBuildState = e.state;
  };
  const escTxt = (s) => String(s).replace(/[<>&"]/g, '');

  /** Re-parenting (renderWB innerHTML rebuilds) zeroes scrollTop — restore. */
  pane.restoreScroll = () => {
    if (Math.abs(scroll.scrollTop - pane.savedScroll) > 1) scroll.scrollTop = pane.savedScroll;
    scheduleRender();
  };

  /** Container width changed (divider drag) — refit if in fit mode. */
  pane.refit = () => {
    if (pane.fit && pane.doc) setZoom(fitScale(), true);
  };

  pane.destroy = () => {
    if (pane.destroyed) return pane.cleanupPromise || Promise.resolve();
    pane.destroyed = true;
    pane.generation++;
    ro.disconnect();
    clearTimeout(refitTimer);
    clearTimeout(pane.retryTimer);
    clearTimeout(pane.barFadeTimer);
    for (const b of pane.boxes) { try { b.renderTask?.cancel(); } catch { /* done */ } }
    const tasks = new Set([pane.pendingTask, pane.loadingTask].filter(Boolean));
    for (const [task, timer] of pane.retiredTasks) {
      clearTimeout(timer);
      tasks.add(task);
    }
    pane.pendingTask = null;
    pane.loadingTask = null;
    pane.retiredTasks.clear();
    pane.doc = null;
    pane.boxes = [];
    el.remove();
    const worker = pane.worker;
    pane.cleanupPromise = Promise.allSettled([...tasks].map(destroyLoadingTask))
      .finally(() => {
        try { worker?.destroy(); } catch { /* already gone */ }
        if (pane.worker === worker) pane.worker = null;
      });
    return pane.cleanupPromise;
  };

  return pane;
}
