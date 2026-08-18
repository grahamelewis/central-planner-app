// app.js — live frontend for projectManager.
// Renders all views from a single `state` object fed by GET /api/state + the /ws event stream.
// No build step; plain ES module. All user/task text injected into HTML goes through esc().

'use strict';

import {
  enc, esc, SHOW_HOURS, hrs, fmtTok, toast, texComplete,
} from './util.js';
import {
  state, ui, pdfPanes, tailBufs, agentsLive, editsLive, jobsLive,
  jobTimers, drafts, edViews, runBufs, runSegs, runOff, htmlEdits,
  snapsCache, pendingPerms, composerDrafts, queuedMsgs,
  turnTexTouched, pendingComplete, consoleView,
  projKeys, tasksOf, findTask, taskProvider, agentName,
  perOf, artifactUrl, pdfSrc,
} from './store.js';
import { api, apiQuiet, connectWS } from './net.js';
import {
  refreshTranscript, sessionFileChanged, ensureDir, refreshFeed,
} from './files.js';
import { pumps, pumpConsole } from './console.js';
import { syncRunJobCard, fadeJobCard } from './jobs.js';
import {
  renderTexProblems, noteTurnTex, queueAutoTexRuns, pumpAutoRun,
  updateTexRunCard, syncTexRunPane,
} from './texrun.js';
import { pdfStateTxt, artPaneKey } from './viewers.js';
import { sendMsg } from './session.js';
import { voiceOnStream, voiceOnStatus } from './voice.js';
import {
  renderOverview, renderPlan, renderSettings, aboutCache,
  ensureAboutData, renderAbout, renderManage, renderCats, renderCatMan,
  openGitPanel, closeGitPanel,
} from './views.js';
import { form, openModal, closeModal, renderModal } from './modal.js';
import { renderWB, updateLedgerInline, syncStatusbar } from './workbench.js';

// overlay-style scrollbars (Graham 2026-07-30): thumbs paint only while their
// pane is actually scrolling — see the ::-webkit-scrollbar block in style.css.
// Capture phase because scroll events don't bubble; the document's own scroll
// stamps <html> so the page scrollbar (overview) still shows its thumb.
// Every link leaves via a NEW tab: the dashboard is a live SPA — open
// sessions, unsaved drafts, scroll positions — and a same-tab navigation
// loses the spot (Graham 2026-07-30). Delegated so it covers rendered
// markdown/console links (which carry no target=) and future chrome alike.
// In-page #anchors stay in-page; modified clicks (⌘/ctrl/shift/middle) keep
// their native behavior; handlers that already preventDefault win.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  window.open(a.href, '_blank', 'noopener');
});

const scrollFade = new Map(); // element → fade timeout
window.addEventListener('scroll', (e) => {
  const el = e.target === document ? document.documentElement
    : (e.target instanceof Element ? e.target : null);
  if (!el) return;
  el.classList.add('scrolling');
  clearTimeout(scrollFade.get(el));
  scrollFade.set(el, setTimeout(() => {
    el.classList.remove('scrolling');
    scrollFade.delete(el);
  }, 700));
}, { capture: true, passive: true });

/**
 * WS event dispatch — the two halves of a {@link WsEvent} frame, split by
 * net.js's onmessage (`handleEvent(msg.type, msg.payload)`). Unknown event
 * types (e.g. `tick`) fall through the default case by design.
 * @param {WsEventType} type
 * @param {*} p the event's payload ({@link WsEventMap}[type])
 * @returns {void}
 */
export function handleEvent(type, p) {
  switch (type) {
    case 'state': {
      applyState(p);
      renderAll();
      break;
    }
    case 'task:update': {
      if (!p || !p.task) break;
      const arr = state.tasks[p.project] || (state.tasks[p.project] = []);
      const i = arr.findIndex(t => t && t.id === p.task.id);
      if (i >= 0) arr[i] = p.task; else arr.push(p.task);
      if (p.task.status === 'done') refreshFeed(p.project); // "✓ done:" feed row
      renderNav();
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === 'manage') renderManage();
      else if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'session:stream': {
      if (!p) break;
      const k = `${p.project}/${p.id}`;
      const chunk = String(p.chunk ?? '');
      {
        let b = (tailBufs[k] || '') + chunk;
        if (b.length > 200000) {
          b = b.slice(-200000);
          const nl = b.indexOf('\n'); // cut at a line boundary, not mid-marker
          if (nl > 0) b = b.slice(nl + 1);
        }
        tailBufs[k] = b;
      }
      if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(p.project, k));
      voiceOnStream(p.project, p.id); // narrate-progress mode speaks completed sentences
      break;
    }
    case 'update:status': {
      // dashboard self-update: badge on the profile button + Settings section
      if (!p) break;
      state.update = p;
      renderNav();
      if (ui.view === 'settings') renderSettings();
      break;
    }
    case 'auth:status': {
      // Claude sign-in state — drives the amber card in the session pane
      if (!p) break;
      /** @type {AuthState} */
      const was = state.auth || {};
      state.auth = p;
      state.providers = state.providers || {};
      state.providers.claude = {
        ...(state.providers.claude || {}), auth: p,
        connected: p.loggedIn === true || (p.method === 'apikey' && !p.needed),
      };
      if (was.needed && p.needed === false && p.loggedIn) {
        toast('signed in — Claude is reachable again');
      }
      // re-render only when the card is (or was) on screen and its content
      // changed — ambient status checks with nothing to show stay silent
      const sig = (x) => [!!x.needed, !!x.loggingIn, !!x.checking, x.loginError || '', x.method || ''].join('|');
      if ((was.needed || p.needed) && sig(was) !== sig(p) && state.projects[ui.view]) {
        renderWB(ui.view);
      }
      break;
    }
    case 'provider:status': {
      if (!p?.provider || !p.state) break;
      const wasConnected = state.providers?.[p.provider]?.connected;
      state.providers = state.providers || {};
      state.providers[p.provider] = { id: p.provider, name: agentName(p.provider), ...p.state };
      if (wasConnected === false && p.state.connected === true) toast(`${agentName(p.provider)} connected`);
      if (ui.view === 'settings') renderSettings();
      else if (state.projects[ui.view]) {
        renderWB(ui.view);
        const bar = document.querySelector(`#v-${CSS.escape(ui.view)} .statusbar`);
        if (bar) syncStatusbar(bar, ui.view, tasksOf(ui.view), state.ledger?.perProject?.[ui.view] || null);
      }
      break;
    }
    case 'provider:defaults': {
      if (!p) break;
      state.agentDefaults = p;
      if (ui.view === 'settings') renderSettings();
      break;
    }
    case 'session:agents': {
      // live subagent roster of the running turn — feeds the console's fleet
      // board; an empty list clears it. MERGED (by n) rather than replaced so
      // the running→done transition can be stamped — done cards show
      // "Xm ago" from that stamp, which the server payload doesn't carry.
      if (!p) break;
      const k = `${p.project}/${p.id}`;
      if (Array.isArray(p.agents) && p.agents.length) {
        const prev = new Map((agentsLive[k] || []).map(a => [a.n, a]));
        agentsLive[k] = p.agents.map(a => {
          const old = prev.get(a.n);
          const settled = a.status === 'done' || a.status === 'failed';
          return { ...a, _doneAt: settled ? (old?._doneAt || Date.now()) : null };
        });
      } else delete agentsLive[k];
      if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(p.project, k));
      break;
    }
    case 'session:edits': {
      // running ✎ aggregate of the turn's file edits — the strip's edit line.
      // Arrives once per completed edit tool call; the strip patches in place
      // via the console pump, so no full re-render per edit.
      if (!p) break;
      const k = `${p.project}/${p.id}`;
      const had = !!editsLive[k];
      if (p.edits && p.edits.files) editsLive[k] = p.edits;
      else delete editsLive[k];
      if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(p.project, k));
      // the Δ tab itself appears with the FIRST live edit — re-render only on
      // that transition, never per edit
      if (had !== !!editsLive[k] && ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'job:status': {
      // a long-running script's live card: elapsed/CPU/mem (+ parsed progress
      // for ▶ runs). Cards patch in place; a finished job holds its terminal
      // state briefly, then fades away.
      if (!p || !p.job || !p.job.key) break;
      const j = p.job;
      j._recvAt = performance.now();
      jobsLive[j.key] = j;
      if (j.state !== 'running') {
        refreshFeed(j.project); // a finished run lands in the activity feed
        if (!jobTimers[j.key]) {
          jobTimers[j.key] = setTimeout(() => { delete jobTimers[j.key]; fadeJobCard(j.key); }, 6000);
        }
      }
      if (j.source === 'run') {
        syncRunJobCard(j.project);
      } else if (j.taskId) {
        const k = `${j.project}/${j.taskId}`;
        if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(j.project, k));
      }
      break;
    }
    case 'session:status': {
      if (!p) break;
      if (perOf(p.project).interrupting === p.id) perOf(p.project).interrupting = null;
      if (p.status && p.status !== 'running') {
        delete agentsLive[`${p.project}/${p.id}`];
        delete editsLive[`${p.project}/${p.id}`];
        // belt: the server ends the turn's jobs itself, but if that broadcast
        // was missed a still-"running" card must not tick forever. DETACHED
        // jobs are exempt — they outlive the turn by design.
        for (const j of Object.values(jobsLive)) {
          if (j.source === 'session' && j.project === p.project && j.taskId === p.id
            && j.state === 'running' && !j.detached) {
            j.state = 'stopped';
            if (!jobTimers[j.key]) {
              jobTimers[j.key] = setTimeout(() => { delete jobTimers[j.key]; fadeJobCard(j.key); }, 6000);
            }
          }
        }
        // messages typed during the turn were queued (one turn at a time) —
        // the slot is free now, so deliver them as one message. If a ✓
        // complete wrap-up just ended, the task is about to archive (below):
        // park the text in the composer instead of starting a turn under it.
        const ck = `${p.project}/${p.id}`;
        const q = queuedMsgs[ck];
        if (q && q.length) {
          delete queuedMsgs[ck];
          if (pendingComplete[ck]) {
            composerDrafts[ck] = [...q, composerDrafts[ck]].filter(Boolean).join('\n\n');
          } else {
            sendMsg(p.project, p.id, q.join('\n\n'));
          }
        }
        // .tex files this turn edited → auto ▶ the decks whose pdf tab is open
        const touched = turnTexTouched[p.project];
        if (touched && touched.size) {
          delete turnTexTouched[p.project];
          queueAutoTexRuns(p.project, [...touched], findTask(p.project, p.id));
        }
        // a ✓ complete wrap-up turn just ended → accept the handoff + archive
        if (pendingComplete[ck]) {
          delete pendingComplete[ck];
          api('PATCH', `/api/tasks/${enc(p.project)}/${enc(p.id)}`, { status: 'done', archived: true }).then((r) => {
            if (!r) return;
            toast('completed — handoff saved, task archived');
            if (perOf(p.project).taskId === p.id) perOf(p.project).taskId = null;
            if (ui.view === p.project) renderWB(p.project);
          });
        }
      }
      const t = findTask(p.project, p.id);
      const prevStatus = t ? t.status : null; // captured before the write — voice speaks on running→stopped
      if (t && p.status) t.status = p.status;
      if (p.error) {
        const agent = agentName(p.provider || taskProvider(t));
        // an auth failure gets its honest name — raw provider errors are cryptic
        toast(p.authNeeded
          ? `[${p.project} · ${p.id}] turn couldn’t reach ${agent} — sign-in needed (see the session pane)`
          : `[${p.project} · ${p.id}] ${p.error}`);
      }
      if (p.status && p.status !== 'running') {
        // Sync the canonical final answer and repair any legacy Codex stream
        // that glued it directly to commentary (e.g. `sentence. ```latex`).
        refreshTranscript(p.project, p.id, {
          reconcileTail: (p.provider || taskProvider(t)) === 'codex',
        });
      }
      renderNav();
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === p.project) renderWB(p.project);
      // AFTER the re-render: the karaoke highlight must land on the settled
      // formatted console, not the raw tail the render is about to replace
      voiceOnStatus(p.project, p.id, p.status, prevStatus);
      break;
    }
    case 'artifact:new': {
      const a = p && p.artifact;
      if (!a) break;
      const i = state.artifacts.findIndex(x => x.project === a.project && x.rel === a.rel);
      if (i >= 0) state.artifacts.splice(i, 1);
      state.artifacts.unshift(a);
      state.artifacts = state.artifacts.slice(0, 60);
      sessionFileChanged(a.project, a.rel); // an open editor reloads in place
      // the kept viewer stack never recreates its frames on re-render, so a
      // frame showing this file is reloaded in place (hidden ones included);
      // pdf panes reload keep-place — a rebuilt deck stays on your page
      document.querySelectorAll(`#v-${a.project} .artFrame[data-vk]`).forEach(f => {
        if (f.dataset.vk !== a.rel) return;
        if (f.classList.contains('pdfPane')) {
          pdfPanes[artPaneKey(a.project, a.rel)]?.load(
            `${artifactUrl(a.project, a.rel)}?t=${enc(a.mtime)}`,
            { keepPlace: true, builtStamp: a.mtime });
        } else {
          f.src = artifactUrl(a.project, a.rel); // re-setting src forces a reload
        }
      });
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === a.project) renderWB(a.project);
      break;
    }
    case 'run:stream': {
      if (!p || !p.project) break;
      const chunk = String(p.chunk ?? '');
      if (typeof p.off === 'number') {
        // replay protection: state adoption sets runOff to the server's byte
        // count, so a chunk re-delivered across a reconnect is dropped
        if (p.off <= (runOff[p.project] || 0)) break;
        runOff[p.project] = p.off;
      }
      runBufs[p.project] = ((runBufs[p.project] || '') + chunk).slice(-200000);
      {
        // mirror into fd-tagged segments so stderr stays red across re-renders
        const segs = (runSegs[p.project] = runSegs[p.project] || []);
        const lastSeg = segs[segs.length - 1];
        if (lastSeg && lastSeg.fd === p.fd) lastSeg.text += chunk;
        else segs.push({ fd: p.fd, text: chunk });
        let total = segs.reduce((n, s) => n + s.text.length, 0);
        while (total > 200000 && segs.length > 1) total -= segs.shift().text.length;
      }
      const pre = document.querySelector(`#v-${p.project} #runPre`);
      if (pre && pre.dataset.key === p.project) {
        pre.querySelector(':scope > span.cm')?.remove(); // the "output appears here" placeholder
        // stick to the bottom only if the user hasn't scrolled up to read
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre._chars = (pre._chars ?? pre.textContent.length) + chunk.length;
        if (p.fd === 2) {
          // stderr — render in red so tracebacks stand out in noisy output
          const s = document.createElement('span');
          s.className = 'errOut';
          s.textContent = chunk;
          pre.appendChild(s);
        } else {
          pre.appendChild(document.createTextNode(chunk));
        }
        // keep the live DOM in lockstep with the buffers' 200k cap
        while (pre._chars > 200000 && pre.firstChild) {
          const n = pre.firstChild;
          const len = n.textContent.length;
          if (pre._chars - len >= 200000) { pre._chars -= len; n.remove(); }
          else {
            n.textContent = n.textContent.slice(pre._chars - 200000);
            pre._chars = 200000;
          }
        }
        if (stick) pre.scrollTop = pre.scrollHeight;
      }
      break;
    }
    case 'run:status': {
      if (!p || !p.project) break;
      const prevRun = state.runs[p.project];
      if (p.run && p.run.state === 'running' && p.run.startedAt
        && prevRun?.startedAt !== p.run.startedAt) {
        // a NEW run — possibly started from another client, where runFile's
        // local reset never ran: drop the previous run's output
        runBufs[p.project] = '';
        delete runSegs[p.project];
        runOff[p.project] = 0;
        const pre0 = document.querySelector(`#v-${p.project} #runPre`);
        if (pre0) { pre0.textContent = ''; pre0._chars = 0; }
      }
      state.runs[p.project] = p.run;
      if (p.run && p.run.state !== 'running') {
        const what = p.run.state === 'done' ? 'finished ✓'
          : p.run.state === 'error' ? `failed ✗ (exit ${p.run.exitCode ?? '?'})` : p.run.state;
        toast(`run ${what} — ${p.run.rel}` +
          (p.run.ms != null ? ` (${(p.run.ms / 1000).toFixed(1)}s)` : ''));
        pumpAutoRun(p.project); // slot free — next queued auto-compile, if any
      }
      if (ui.view === p.project) {
        // a pass ping mid-compile (running → running, same run) only moves the
        // build card's bar/chips — patch in place; a full render here would
        // disturb the editor for every latexmk pass
        if (p.run?.state === 'running' && prevRun?.state === 'running'
          && prevRun?.startedAt === p.run.startedAt) {
          updateTexRunCard(p.project);
          syncTexRunPane(p.project); // the viewer's bar/chip ride the same pings
        } else renderWB(p.project); // wireWB's mountArtPanes re-syncs the pane
      }
      break;
    }
    case 'task:delete': {
      if (!p || !p.project) break;
      const arr = state.tasks[p.project];
      if (arr) {
        const i = arr.findIndex(t => t && t.id === p.id);
        if (i >= 0) arr.splice(i, 1);
      }
      refreshFeed(p.project); // the deleted task's history left the journal too
      if (perOf(p.project).taskId === p.id) {
        perOf(p.project).taskId = null;
        perOf(p.project).fileTab = null;
      }
      renderAll();
      break;
    }
    case 'session:permission': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      (pendingPerms[pk] = pendingPerms[pk] || []).push({ requestId: p.requestId, tool: p.tool, input: p.input });
      toast(`⏳ approval needed — ${p.tool} (${state.projects[p.project]?.name || p.project})`);
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'session:permission:resolved': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      if (pendingPerms[pk]) {
        pendingPerms[pk] = pendingPerms[pk].filter(x => x.requestId !== p.requestId);
        if (!pendingPerms[pk].length) delete pendingPerms[pk];
      }
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'file:changed': {
      // a session's Edit/Write just landed on disk (mid-turn, live)
      if (!p || !p.project || !p.rel) break;
      noteTurnTex(p.project, p.rel);
      sessionFileChanged(p.project, p.rel);
      break;
    }
    case 'snapshot:new': {
      if (!p || !p.project || !p.entry) break;
      const ck = `${p.project}/${p.entry.task}`;
      const sc = snapsCache[ck];
      if (sc && sc.fetched && !sc.entries.some(e => e.id === p.entry.id)) sc.entries.unshift(p.entry);
      // files changed on disk — refresh what's on screen IN PLACE. The old
      // blind cache delete unmounted an OPEN editor into a "// loading…"
      // shell for a frame: a visible flash that dropped focus mid-typing
      // every time the session checkpointed the file you were working in
      // (docs/editor-scroll-reset-diagnosis.txt).
      (p.entry.files || []).forEach(f => { noteTurnTex(p.project, f.rel); sessionFileChanged(p.project, f.rel); });
      refreshFeed(p.project); // the sidebar's activity feed gains the change-set
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'pdf:status': {
      if (!p || !p.project) break;
      const prev = state.pdf[p.project];
      state.pdf[p.project] = p.entry;
      if (ui.view === 'ov') { renderOverview(); break; }
      if (ui.view !== p.project) break;
      const root = document.getElementById('v-' + p.project);
      const pane = pdfPanes[p.project];
      const mounted = !!(pane && root?.querySelector('#pdfPaneHost')?.contains(pane.el));
      // error appearing/clearing (or the watch dying) changes more than text —
      // the session pane's Claude-fix card comes and goes with it
      const transitioned = (prev?.state !== p.entry?.state)
        || ((prev?.counts?.errors || 0) !== (p.entry?.counts?.errors || 0))
        || (!!prev?.dead !== !!p.entry?.dead);
      if (p.entry && p.entry.state === 'built' && !mounted) {
        // pdf tab exists but the pane isn't up yet (first build, error
        // recovery, or another viewer tab) — a full render brings it up
        renderWB(p.project);
      } else if (transitioned) {
        // full render: card + status + problems all move; the mounted pane
        // survives it (re-attached, reloaded only if a new build landed)
        renderWB(p.project);
      } else {
        // repeat ping (e.g. building…) — patch in place, no rebuild
        if (p.entry && p.entry.state === 'built' && mounted) {
          const src = pdfSrc(p.project);
          if (src) pane.load(`${src}?t=${enc(p.entry.lastBuiltAt || '0')}`, { keepPlace: true, builtStamp: p.entry.lastBuiltAt || '' });
        }
        const t = root?.querySelector('#pdfStateTxt');
        if (t && p.entry) t.textContent = pdfStateTxt(p.entry);
        const pg = root?.querySelector('#pdfPagesTxt');
        if (pg && p.entry) pg.textContent = p.entry.pages ? `${p.entry.pages} pages` : '';
        if (mounted && p.entry) pane.setBuildStatus(p.entry); // staged bar + verdict chip
        renderTexProblems(p.project);
      }
      break;
    }
    case 'texfix:status': {
      if (!p || !p.project) break;
      const hadState = state.texfix[p.project]?.state;
      state.texfix[p.project] = p.fix || {};
      const f = p.fix || {};
      if (f.state === 'done' && hadState === 'running') {
        const n = (f.suggestions || []).filter((s) => s.status === 'open').length;
        toast(n
          ? `✦ Claude suggests ${n} fix${n === 1 ? '' : 'es'} — review them in the editor`
          + (f.costUsd ? ` · $${f.costUsd.toFixed(2)}` : '')
          : 'Claude finished without usable suggestions');
      } else if (f.state === 'error' && hadState === 'running') {
        toast('Claude fix failed — ' + (f.error || 'unknown error'));
      }
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'kaimon:status': {
      const prev = state.kaimon?.install?.state;
      state.kaimon = p || {};
      const inst = state.kaimon.install || {};
      if (prev === 'running' && inst.state === 'done') {
        toast('✓ Kaimon installed — the warm Julia REPL engages on the next turn');
      } else if (prev === 'running' && inst.state === 'error') {
        toast('Kaimon install failed — ' + (inst.error || 'unknown error'));
      }
      // the enable card / warm chip live in the session pane of project views
      if (ui.view !== 'ov' && ui.view !== 'cats' && ui.view !== 'manage' && state.projects[ui.view]) renderWB(ui.view);
      break;
    }
    case 'ledger:update': {
      state.ledger = p || state.ledger;
      renderNav();
      if (ui.view === 'about') { aboutCache.activity = null; ensureAboutData(); }
      if (ui.view === 'ov') renderOverview();
      // NEVER renderWB here: a full innerHTML rebuild every 30s heartbeat
      // would reload the viewer iframes (live pdf loses scroll/zoom) and wipe
      // the composer. Patch the few ledger-driven text nodes in place instead.
      else if (state.projects[ui.view]) updateLedgerInline(ui.view);
      break;
    }
    case 'plan:update': {
      // the 15-min calendar refresh landed — pull the fresh snapshot quietly
      // (mutation routes broadcast full 'state' themselves; this is only the
      // timer's ping, so a fetch every 15 min is nothing)
      loadState().then(() => {
        if (ui.view === 'plan') renderPlan();
        else if (state.projects[ui.view]) renderWB(ui.view);
      }).catch(() => { /* next tick retries */ });
      break;
    }
    default: break;
  }
}

/* ───────────────────────── state load ───────────────────────── */

function applyState(p) {
  if (!p || typeof p !== 'object') return;
  state.user = p.user || {};
  state.projects = p.projects || {};
  // if the project we're viewing just went inactive (or was removed) — e.g. a
  // Manage edit here or on another client — fall back to overview so we don't
  // strand the user on a tab-less workbench (go()'s guard isn't on this path)
  if (!['ov', 'cats', 'manage', 'about', 'settings', 'catman', 'plan'].includes(ui.view)
    && (!state.projects[ui.view] || state.projects[ui.view].status === 'inactive')) {
    ui.view = 'ov';
  }
  state.categories = p.categories || {};
  state.abstracts = p.abstracts || {};
  state.tasks = p.tasks || {};
  state.artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
  state.pdf = p.pdf || {};
  state.ledger = p.ledger || null;
  state.providers = p.providers || {};
  state.agentDefaults = p.agentDefaults || state.agentDefaults;
  state.sessions = Array.isArray(p.sessions) ? p.sessions : [];
  // fleet board + ✎ strip: the snapshot is authoritative, exactly like jobs
  // below — a reload or ws reconnect mid-turn re-seeds the live strips, and
  // rosters from turns that ended while we were away disappear. This is the
  // ONLY path from state.sessions into the strips; the console renders from
  // agentsLive/editsLive alone. (Previously the renderer fell back to the
  // cached state.sessions roster whenever agentsLive was empty — which is
  // exactly the post-turn-end state — so a snapshot taken mid-turn kept
  // resurrecting a dead fleet under every later turn.)
  for (const k of Object.keys(agentsLive)) delete agentsLive[k];
  for (const k of Object.keys(editsLive)) delete editsLive[k];
  for (const s of state.sessions) {
    if (!s || !s.project || !s.id) continue;
    const sk = `${s.project}/${s.id}`;
    if (Array.isArray(s.agents) && s.agents.length) {
      // _doneAt backs the "Xm ago" stamp on settled cards; the snapshot has
      // no transition time, so a freshly-seeded settled card reads "just now"
      agentsLive[sk] = s.agents.filter(Boolean).map(a => ({
        ...a,
        _doneAt: (a.status === 'done' || a.status === 'failed') ? Date.now() : null,
      }));
    }
    if (s.edits && s.edits.files) editsLive[sk] = s.edits;
  }
  state.runs = {};
  for (const [k, run] of Object.entries(p.runs || {})) {
    const { tail, ...rest } = run;
    state.runs[k] = rest;
    // the server tail is authoritative: after a reload OR a ws reconnect the
    // local buffer may have a gap from missed chunks (stderr tags can't be
    // reconstructed, so the recovered text renders uncolored)
    if (tail && tail !== runBufs[k]) {
      runBufs[k] = tail;
      delete runSegs[k];
    }
    if (typeof rest.bytes === 'number') runOff[k] = rest.bytes; // replay guard baseline
  }
  state.texfix = p.texfix || {};
  state.kaimon = p.kaimon || {};
  state.update = p.update || {};
  state.auth = p.auth || {};
  state.plan = p.plan || { deadlines: {}, cal: { sources: [], routes: {}, events: [] } };
  // job cards: the snapshot is authoritative — a reload mid-run re-seeds the
  // live cards, and jobs that ended while we were away disappear
  for (const k of Object.keys(jobsLive)) delete jobsLive[k];
  for (const j of (Array.isArray(p.jobs) ? p.jobs : [])) {
    if (!j || !j.key) continue;
    j._recvAt = performance.now();
    jobsLive[j.key] = j;
    // a just-ended job in the snapshot still needs its fade-away timer
    if (j.state !== 'running' && !jobTimers[j.key]) {
      jobTimers[j.key] = setTimeout(() => { delete jobTimers[j.key]; fadeJobCard(j.key); }, 6000);
    }
  }
  // release PDF panes belonging to projects that vanished or went inactive —
  // each holds a worker-side document, canvases, observers, and timers
  for (const pk of Object.keys(pdfPanes)) {
    const proj = pk.split('::')[0];
    if (!state.projects[proj] || state.projects[proj].status === 'inactive') {
      pdfPanes[pk].destroy();
      delete pdfPanes[pk];
    }
  }
}

/**
 * Fetch /api/state and adopt it (applyState); toasts when unreachable.
 * @returns {Promise<void>}
 */
export async function loadState() {
  const data = await apiQuiet('GET', '/api/state');
  if (data) applyState(data);
  else toast('could not reach server — retrying…');
}

/* ───────────────────────── top-level render ───────────────────────── */

function ensureViews() {
  const host = document.getElementById('projectViews');
  if (!host) return;
  projKeys().forEach(k => {
    if (!document.getElementById('v-' + k)) {
      const d = document.createElement('div');
      d.className = 'view';
      d.id = 'v-' + k;
      host.appendChild(d);
    }
  });
}

/**
 * Render the current view (ui.view) and toggle view visibility.
 * @returns {void}
 */
export function renderAll() {
  ensureViews();
  renderNav();
  if (ui.view === 'ov') renderOverview();
  else if (ui.view === 'cats') renderCats();
  else if (ui.view === 'manage') renderManage();
  else if (ui.view === 'about') renderAbout();
  else if (ui.view === 'settings') renderSettings();
  else if (ui.view === 'catman') renderCatMan();
  else if (ui.view === 'plan') renderPlan();
  else if (state.projects[ui.view]) renderWB(ui.view);
  document.querySelectorAll('#v-ov, #v-cats, #v-manage, #v-about, #v-settings, #v-catman, #v-plan, #projectViews > .view')
    .forEach(x => x.classList.toggle('show', x.id === 'v-' + ui.view));
}

/**
 * Navigate to a view: 'ov' | 'cats' | 'manage' | 'about' | 'settings' |
 * 'catman' | 'plan' | a project key (anything else falls back to overview).
 * Banks the outgoing project's console/editor positions and keeps
 * location.hash on the view.
 * @param {string} v
 * @returns {void}
 */
export function go(v) {
  // before leaving, save the current project's console scroll WHILE its view is
  // still visible — renderAll only re-renders the entered view, so the outgoing
  // project's renderWB never fires to capture it (cross-project scroll memory)
  if (state.projects[ui.view]) {
    const prev = document.getElementById('v-' + ui.view)?.querySelector('#consoleBox');
    if (prev && prev.clientHeight) consoleView[prev.dataset.key] = {
      scrollTop: prev.scrollTop,
      follow: prev._follow !== false,
    };
    // same idea for the outgoing project's editor — renderWB only banks the
    // editor of the view it renders, and that's the INCOMING one here
    const ped = document.getElementById('v-' + ui.view)?.querySelector('#codeEditor');
    if (ped && ped.dataset.fkey) edViews[ped.dataset.fkey] = {
      scrollTop: ped.scrollTop, scrollLeft: ped.scrollLeft,
      selStart: ped.selectionStart, selEnd: ped.selectionEnd,
    };
  }
  // an inactive project has no nav tab / workbench view — fall back to overview
  const isProj = state.projects[v] && state.projects[v].status !== 'inactive';
  ui.view = (v === 'ov' || v === 'cats' || v === 'manage' || v === 'about' || v === 'settings' || v === 'catman' || v === 'plan' || isProj) ? v : 'ov';
  // keep the URL's hash on the current view so a browser reload lands back
  // here instead of the overview (replaceState — no history spam, no events)
  try {
    history.replaceState(null, '', ui.view === 'ov'
      ? location.pathname + location.search
      : `#${ui.view}`);
  } catch { /* sandboxed iframe etc — cosmetic only */ }
  renderAll();
  window.scrollTo(0, 0);
}

/* ───────────────────────── nav ───────────────────────── */

/**
 * Repaint the top nav: brand, update badge, project tabs + status dots, week chip.
 * @returns {void}
 */
export function renderNav() {
  // top-left brand = the configured user name (neutral placeholder until setup)
  const brand = document.getElementById('brandName');
  if (brand) brand.textContent = state.user?.name || 'Central Planner';
  // dashboard-update badge on the profile button — same treatment as the
  // project tabs' waiting badge: one pending action (the update, in Settings).
  // Managed surgically: profileBtn also hosts the popup menu, so no innerHTML.
  const pb = document.getElementById('profileBtn');
  if (pb) {
    let ub = document.getElementById('updBadge');
    if (state.update?.state === 'behind') {
      if (!ub) {
        ub = document.createElement('span');
        ub.id = 'updBadge';
        ub.className = 'badge';
        ub.textContent = '1';
        ub.addEventListener('click', (e) => { e.stopPropagation(); go('settings'); });
        pb.appendChild(ub);
      }
      const n = state.update.behind || 0;
      ub.title = `dashboard update available — ${n} commit${n === 1 ? '' : 's'} behind · open Settings`;
    } else if (ub) {
      ub.remove();
    }
  }
  const host = document.getElementById('navProjects');
  if (!host) return;
  host.innerHTML = projKeys().map(k => {
    // open = real work in the project (not archived, not finished)
    const open = tasksOf(k).filter(t => !t.archived && t.status !== 'done');
    const running = open.some(t => t.status === 'running');
    const waiting = open.filter(t => t.status === 'waiting').length;
    // green (pulsing) = Claude running · amber = waiting on you · the project's
    // own colour = has open work but idle · grey = genuinely empty
    const dot = running ? 'run' : waiting ? 'wait' : open.length ? 'idle' : 'off';
    const dotStyle = dot === 'idle' ? ` style="background:${esc(state.projects[k]?.color || '#888')}"` : '';
    return `<div class="tab ${ui.view === k ? 'on' : ''}" data-v="${esc(k)}">
      <span class="dot ${dot}"${dotStyle}></span>${esc(state.projects[k]?.name || k)}${state.projects[k]?.status === 'trial' ? '<span class="trialTag">trial</span>' : ''}
      ${waiting ? `<span class="badge">${waiting}</span>` : ''}</div>`;
  }).join('');
  host.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => go(el.dataset.v)));
  // descendant selector: project tabs live inside #navProjects, cats inside .right
  document.querySelectorAll('#nav .tab[data-v]').forEach(t => t.classList.toggle('on', t.dataset.v === ui.view));
  const chip = document.getElementById('navWeek');
  if (chip && state.ledger?.totals) {
    chip.innerHTML = SHOW_HOURS
      ? `wk <b>${hrs(state.ledger.totals.seconds)}h</b> · <b class="y">${fmtTok(state.ledger.totals.tokens)} tok</b>`
      : `wk <b class="y">${fmtTok(state.ledger.totals.tokens)} tok</b>`;
  }
}

/* ───────────────────────── workbench ───────────────────────── */

/* compact count for the feed's fixed number columns: the body (sans sign)
   never exceeds 4 chars — "1236" → "1.2k" — so no value can overflow its
   5ch grid track. Raw 4-digit counts (and toLocaleString's commas) used to
   spill leftward out of the dels track and jam into the adds column:
   "+1−236" reading as one blob instead of two ruled columns. */
/**
 * @param {number | string | null | undefined} n
 * @returns {string} ≤4-char count body ("1236" → "1.2k") for the feed's fixed columns
 */
export function afNum(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 9950) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 999500) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

/* ───────────────────────── heartbeat / keyboard / boot ───────────────────────── */

window.addEventListener('beforeunload', (e) => {
  const dirtyHtml = Object.values(htmlEdits).some(s => s && s.dirty);
  if (Object.keys(drafts).length || dirtyHtml) { e.preventDefault(); e.returnValue = ''; }
});

const IDLE_LIMIT_MS = 5 * 60 * 1000; // focused-but-away windows stop logging time
let lastActivity = Date.now();
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
  window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));

function startHeartbeat() {
  setInterval(() => {
    try {
      // week rollover: ledger displays would otherwise show last week's totals
      // until the next ledger event after Monday 00:00
      if (state.ledger?.since && (Date.now() - Date.parse(state.ledger.since)) > 7 * 86400000) {
        loadState().then(renderAll);
      }
      if (!document.hasFocus()) return;
      if (Date.now() - lastActivity > IDLE_LIMIT_MS) return; // present but idle
      const k = ui.view;
      if (!state.projects[k]) return; // only while a project view is open
      apiQuiet('POST', '/api/heartbeat', { project: k, seconds: 30 });
      // sweep expanded folder pins so files created on disk appear without a reload
      for (const rel of perOf(k).openDirs || []) ensureDir(k, rel);
    } catch (err) { console.warn('[ui] heartbeat', err); }
  }, 30000);
}

function wireGlobal() {
  // Julia-style \symbol completion in every prose input — delegated, so it
  // survives the constant re-renders. The code editor handles its own Tab
  // (indentation + .jl completion) and preventDefaults before this runs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    const el = e.target;
    if (!el || el.id === 'codeEditor') return;
    // I3 triple guard, leg (b) — P19: under Monaco the event TARGET is an
    // inner element of the editor DOM (today the hidden .inputarea textarea;
    // an EditContext DIV if the pin ever flips), never the #codeEditor host
    // itself — so the id check above passes dead air. The exclusion is
    // re-anchored to this closest-bail: Tab inside the editor belongs to
    // Monaco (indent now; per-language addCommand at S2/P19), never to the
    // prose \symbol completion. CDP case: ui.monaco-core.test.mjs.
    if (el.closest && el.closest('.monaco-editor')) return;
    const isText = el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type || ''));
    if (!isText) return;
    // converted → eat the Tab; attempted-but-unknown → still eat it, a failed
    // completion must not throw focus across the page
    if (texComplete(el)) e.preventDefault();
  });

  // direct children (Overview) + .right tabs (categories); #navProjects tabs
  // are (re)bound by renderNav on every render, so exclude them here.
  document.querySelectorAll('#nav > .tab[data-v], #nav .right .tab[data-v]').forEach(t =>
    t.addEventListener('click', () => go(t.dataset.v)));
  document.getElementById('openModal')?.addEventListener('click', () => openModal());
  document.getElementById('gitBtn')?.addEventListener('click', openGitPanel);

  // profile menu — placeholder items for now; functionality comes later
  const pb = document.getElementById('profileBtn');
  if (pb) pb.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('profileMenu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'profileMenu';
    menu.innerHTML = ['About You', 'Manage Projects', 'Manage Categories', 'Project History', 'Settings']
      .map(t => `<div class="pmItem" data-pm="${esc(t)}">${esc(t)}</div>`).join('');
    pb.appendChild(menu);
    menu.querySelectorAll('.pmItem').forEach(it => it.addEventListener('click', () => {
      // no stopPropagation: the document once-listener below closes the menu
      if (it.dataset.pm === 'Manage Projects') { go('manage'); return; }
      if (it.dataset.pm === 'Manage Categories') { go('catman'); return; }
      if (it.dataset.pm === 'About You') { go('about'); return; }
      if (it.dataset.pm === 'Settings') { go('settings'); return; }
      toast(`${it.dataset.pm} — coming soon`);
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });
  const gback = document.getElementById('gitBack');
  gback?.addEventListener('click', e => { if (e.target === gback) closeGitPanel(); });
  // Backdrop click closes — but ONLY when the press STARTED on the backdrop.
  // A `click` is dispatched on the nearest common ancestor of mousedown and
  // mouseup, so drag-selecting text inside the modal and releasing past its
  // edge targets #modalBack and used to close the dialog mid-sentence. Track
  // where the press began and require both ends to be the backdrop.
  const back = document.getElementById('modalBack');
  let backPress = false;
  back?.addEventListener('mousedown', e => { backPress = e.target === back; });
  back?.addEventListener('click', e => {
    const fromBackdrop = backPress;
    backPress = false;
    if (fromBackdrop && e.target === back) closeModal();
  });

  // window focus → the editor caret: when the app window itself loses focus
  // (click into another app/screen, or into an artifact iframe) the caret
  // stops blinking and dims, so a live-looking cursor never lies about focus.
  // window blur/focus don't fire for element focus moves — exactly right here.
  window.addEventListener('blur', () => document.documentElement.classList.add('winblur'));
  window.addEventListener('focus', () => document.documentElement.classList.remove('winblur'));

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '0' && e.key <= '5') {
      e.preventDefault();
      if (e.key === '0') { go('ov'); return; }
      const k = projKeys()[+e.key - 1];
      if (k) go(k);
    }
    if (e.key === 'Escape') { closeModal(); closeGitPanel(); }
  });
}

(async function init() {
  try {
    wireGlobal();
    await loadState();
    renderAll();
    connectWS();
    startHeartbeat();
    // deep links: #cats, #ov, #<projectKey>, #new or #new:<category> (Add Task)
    const h = decodeURIComponent((location.hash || '').slice(1));
    if (h === 'git') { openGitPanel(); }
    else if (h === 'new' || h.startsWith('new:')) {
      openModal();
      const cat = h.slice(4);
      if (form && state.categories?.[cat]) { form.category = cat; renderModal(); }
    } else {
      const [v, sub] = h.split(':');
      if (v === 'cats' || v === 'ov' || v === 'manage' || v === 'about' || v === 'settings' || v === 'plan' || state.projects[v]) {
        if (sub === 'console' && state.projects[v]) perOf(v).fileTab = 'tail';
        go(v);
      }
    }
  } catch (err) {
    console.error('[ui] init failed', err);
    toast('UI failed to initialise: ' + (err.message || err));
  }
})();
