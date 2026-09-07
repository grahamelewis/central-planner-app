// A short correction window for explicit composer submissions. Cancellation
// is authoritative on the server: hiding a bubble is not provider rollback.
import {
  ui, transcripts, tailBufs, composerDrafts, queuedMsgs, pendingComplete,
  pendingPerms, agentsLive, editsLive, findTask, perOf,
} from './store.js';
import { enc, esc, toast } from './util.js';
import { api } from './net.js';
import { renderWB } from './workbench.js';
import { seedTailBuf, shownLen, pumps, pumpConsole } from './console.js';
import { refreshTranscript } from './files.js';
import { noteRunStatus } from './runActivity.js';
import { voiceCancelTurn } from './voice.js';

const WINDOW_MS = 5000;
/** @type {Record<string, any>} */
const submissions = {};
/** @type {Record<string, string[]>} */
const savedDrafts = {};
/** @type {Set<string>} */
export const pausedQueues = new Set();
/** @type {Record<string, Set<string>>} */
const recalledTurns = {};
/** Refreshes started before a recall cannot overwrite its canonical history. */
export const transcriptRevision = {};
const expiryTimers = {};
const activeTurns = {};
const deliveries = new Map();
const needsRebuild = new Set();
const rebuilding = new Set();
let hydrated = false;
const STORAGE_KEY = 'composer:correction:v1';

/** Tab-scoped recovery, never shared across clients or stored on disk by us. */
export function hydrateRecallState() {
  if (hydrated) return;
  hydrated = true;
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    for (const [k, s] of Object.entries(value.submissions || {})) {
      if (typeof s?.requestId !== 'string' || typeof s.text !== 'string') continue;
      submissions[k] = s;
      armExpiry(k, s.deadline);
      if (typeof value.drafts?.[k] === 'string') composerDrafts[k] = value.drafts[k];
    }
    for (const [k, list] of Object.entries(value.savedDrafts || {})) {
      if (Array.isArray(list)) savedDrafts[k] = list.filter(text => typeof text === 'string');
    }
    for (const k of value.paused || []) {
      if (typeof k !== 'string') continue;
      pausedQueues.add(k);
      if (Array.isArray(value.queues?.[k])) queuedMsgs[k] = value.queues[k].filter(text => typeof text === 'string');
    }
  } catch { /* private/blocked storage: in-tab recovery still works */ }
}

export function persistRecallState() {
  try {
    const drafts = {}, queues = {};
    for (const k of Object.keys(submissions)) drafts[k] = composerDrafts[k] || '';
    for (const k of pausedQueues) queues[k] = queuedMsgs[k] || [];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ submissions, savedDrafts,
      drafts, queues, paused: [...pausedQueues] }));
  } catch { /* no persistent storage required */ }
}

const keyOf = (project, id) => `${project}/${id}`;
const redraw = project => { if (ui.view === project) renderWB(project); };
const matches = (s, p) => !!s
  && (!p.requestId || p.requestId === s.requestId)
  && (!p.turnId || !s.turnId || p.turnId === s.turnId)
  && !!((p.requestId && p.requestId === s.requestId) || (p.turnId && p.turnId === s.turnId));
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID requires a secure context; the LAN dashboard can use HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function armExpiry(k, deadline) {
  clearTimeout(expiryTimers[k]);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
  expiryTimers[k] = setTimeout(() => {
    delete expiryTimers[k];
    redraw(k.split('/')[0]);
  }, Math.min(WINDOW_MS, deadline - Date.now()) + 10);
}

export function beginSubmission(project, id, text) {
  const k = keyOf(project, id);
  if (!queuedMsgs[k]?.length) pausedQueues.delete(k);
  const s = { requestId: requestId(), text, deadline: Date.now() + WINDOW_MS,
    phase: 'sending', turnId: null, restored: false };
  submissions[k] = s;
  persistRecallState();
  armExpiry(k, s.deadline);
  return s;
}

export function acknowledgeSubmission(project, id, s, response) {
  if (submissions[keyOf(project, id)] !== s || s.restored) return;
  if (!response) { s.phase = 'failed'; return; }
  s.turnId = response.turnId || s.turnId;
  const serverDeadline = Date.parse(response.recallUntil);
  if (Number.isFinite(serverDeadline)) s.deadline = Math.min(s.deadline, serverDeadline);
  armExpiry(keyOf(project, id), s.deadline);
  if (s.phase === 'sending') s.phase = 'running';
  persistRecallState();
}

export function trackSubmissionDelivery(project, id, s, promise) {
  deliveries.set(s.requestId, promise);
  s.deliveryPending = true;
  promise.then(result => {
    s.deliveryPending = false;
    s.deliveryFailed = !result;
    deliveries.delete(s.requestId);
    if (!result && s.phase === 'failed' && !s.restored) {
      recoverPrompt(keyOf(project, id), s);
      redraw(project);
      focusComposer(project, id);
    }
    persistRecallState();
  });
}

function recoverPrompt(k, s) {
  if (s.draftRecovered) return;
  if (composerDrafts[k]) (savedDrafts[k] ?? (savedDrafts[k] = [])).push(composerDrafts[k]);
  composerDrafts[k] = s.text;
  s.draftRecovered = true;
}

export function canRecall(project, id) {
  const k = keyOf(project, id), s = submissions[k];
  return !!s && !pendingComplete[k] && !s.restored
    && (s.phase === 'sending' || s.phase === 'running') && Date.now() < s.deadline;
}

export function recallPending(project, id) {
  const k = keyOf(project, id);
  return ['recalling', 'recall-recovery'].includes(submissions[k]?.phase)
    || ['recalling', 'recall-recovery'].includes(activeTurns[k]?.phase);
}

export function submissionSending(project, id) {
  return submissions[keyOf(project, id)]?.phase === 'sending';
}

const recoveryFor = k => submissions[k]?.phase === 'recall-recovery'
  ? submissions[k] : activeTurns[k]?.phase === 'recall-recovery' ? activeTurns[k] : null;

export function stopControlHtml(project, task) {
  const correcting = canRecall(project, task.id);
  const recovery = recoveryFor(keyOf(project, task.id));
  const busy = !recovery && (recallPending(project, task.id) || perOf(project).interrupting === task.id);
  if (task.status !== 'running' && !correcting && !busy && !recovery) return '';
  return `<button class="stopBtn${correcting ? ' stopEdit' : ''}" id="interruptBtn"${busy ? ' disabled' : ''}
    title="${recovery ? 'Retry finishing the accepted prompt restoration. New sends stay blocked until recovery completes.' : correcting ? 'Stop and restore this prompt for editing (Esc). Available for five seconds after sending.' : 'Interrupt this turn'}">${busy ? 'Stopping…' : recovery ? 'Retry restore' : correcting ? 'Stop &amp; Edit' : '⏹ stop'}</button>`;
}

export function savedDraftsHtml(project, id) {
  const list = savedDrafts[keyOf(project, id)] || [];
  if (!list.length) return '';
  return `<div class="savedComposerDrafts" aria-label="Preserved unsent drafts">${list.map((text, i) =>
    `<div class="savedComposerDraft"><span><b>Unsent draft preserved</b><small>${esc(text)}</small></span><button class="gbtn" data-restore-draft="${i}">Edit draft</button></div>`).join('')}</div>`;
}

function focusComposer(project, id) {
  if (ui.view !== project || perOf(project).taskId !== id) return;
  const input = document.querySelector(`#v-${CSS.escape(project)} #composerInput`);
  if (input instanceof HTMLTextAreaElement) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

export function restoreSavedDraft(project, id, index) {
  const k = keyOf(project, id), list = savedDrafts[k];
  if (!list || !Number.isInteger(index) || index < 0 || index >= list.length) return;
  const [text] = list.splice(index, 1);
  if (composerDrafts[k]) list.push(composerDrafts[k]);
  composerDrafts[k] = text;
  persistRecallState();
  redraw(project);
  focusComposer(project, id);
}

/** Ignore replayed events from a turn whose removal the server confirmed. */
export function isRecalledEvent(p) {
  const k = p?.project && p.id ? keyOf(p.project, p.id) : null;
  if (!k) return false;
  if (p.turnId && recalledTurns[k]?.has(p.turnId)) return true;
  const s = submissions[k];
  return !!s && ['sending', 'running', 'recalling', 'recall-recovery'].includes(s.phase)
    && !!p.status && p.status !== 'running' && !!(p.turnId || p.requestId) && !matches(s, p);
}

/** Suppress queue draining and speech even if the stop status beats HTTP. */
export function noteRecallStatus(p) {
  const k = keyOf(p.project, p.id), s = submissions[k];
  const phase = p.phase || p.activeTurn?.phase;
  if (p.activeTurn) activeTurns[k] = p.activeTurn;
  else if (p.turnId || p.requestId) activeTurns[k] = { ...p, phase };
  if (matches(s, p.activeTurn || p)) {
    s.turnId = (p.activeTurn || p).turnId || s.turnId;
    if (s.phase === 'sending' && p.status === 'running') s.phase = 'running';
  }
  if (phase === 'recalling' || phase === 'recall-recovery') {
    pausedQueues.add(k);
    if (matches(s, p.activeTurn || p)) s.phase = phase;
    perOf(p.project).interrupting = phase === 'recalling' ? p.id : null;
    persistRecallState();
    return true;
  }
  if (p.status && p.status !== 'running' && s && s.phase !== 'recalling'
    && ((!p.turnId && !p.requestId) || matches(s, p))) {
    s.phase = 'finished';
    persistRecallState();
  }
  return recallPending(p.project, p.id);
}

export function replaceTranscript(project, id, entries) {
  const k = keyOf(project, id);
  needsRebuild.delete(k);
  transcriptRevision[k] = (transcriptRevision[k] || 0) + 1;
  transcripts[k] = { entries, fetched: true };
  tailBufs[k] = '';
  const task = findTask(project, id);
  if (task) seedTailBuf(project, task);
  shownLen[k] = (tailBufs[k] || '').length;
  if (pumps[k]) cancelAnimationFrame(pumps[k]);
  pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
}

function repairTranscript(project, id) {
  const k = keyOf(project, id);
  if (rebuilding.has(k)) return;
  rebuilding.add(k);
  refreshTranscript(project, id, { rebuildTail: true }).finally(() => rebuilding.delete(k));
}

/** Idempotent across event + HTTP acknowledgement, and across reconnects. */
export function applyRecall(p) {
  if (!p?.project || !p.id || !p.turnId || p.status !== 'recalled') return;
  const k = keyOf(p.project, p.id);
  const known = recalledTurns[k] ?? (recalledTurns[k] = new Set());
  const first = !known.has(p.turnId);
  known.add(p.turnId);
  const s = submissions[k];
  const mine = matches(s, p);
  const restore = mine && !s.restored;
  if (!first && !restore) return;
  if ((!p.snapshot && first) || restore) pausedQueues.add(k);
  if (restore) {
    recoverPrompt(k, s); // exact browser input, including whitespace
    s.restored = true;
    s.phase = 'recalled';
  }
  if (first) {
    const task = findTask(p.project, p.id);
    if (!p.snapshot && !p.preserveActive) {
      delete activeTurns[k];
      if (task) task.status = 'waiting';
      perOf(p.project).interrupting = null;
      delete pendingPerms[k];
      delete agentsLive[k];
      delete editsLive[k];
      noteRunStatus({ project: p.project, id: p.id, status: 'waiting' });
      voiceCancelTurn(p.project, p.id);
    }
    if (Array.isArray(p.transcript)) replaceTranscript(p.project, p.id, p.transcript);
    else {
      transcriptRevision[k] = (transcriptRevision[k] || 0) + 1;
      needsRebuild.add(k);
      repairTranscript(p.project, p.id);
    }
  }
  persistRecallState();
  redraw(p.project);
  if (restore) focusComposer(p.project, p.id);
}

/** A missed recall event must not leave cancelled output after reconnect. */
export function syncRecallState(turnStates) {
  for (const [k, value] of Object.entries(turnStates || {})) {
    const [project, id] = k.split('/');
    const last = value?.lastRecalled;
    if (value?.activeTurn) activeTurns[k] = value.activeTurn;
    else delete activeTurns[k];
    if (last) applyRecall({ ...last, project, id, status: 'recalled', snapshot: true });
    if (needsRebuild.has(k)) repairTranscript(project, id);
    const known = recalledTurns[k] ?? (recalledTurns[k] = new Set());
    for (const turnId of value?.recalledTurnIds || []) known.add(turnId);
    if (value?.activeTurn) noteRecallStatus({ ...value.activeTurn, project, id, status: findTask(project, id)?.status });
    else if (submissions[k]?.phase === 'running') submissions[k].phase = 'finished';
  }
}

export async function stopOrRecall(project, id) {
  const k = keyOf(project, id), recovery = recoveryFor(k);
  const s = recovery || submissions[k];
  if (!recovery && (recallPending(project, id) || perOf(project).interrupting === id)) return;
  if (!recovery && !canRecall(project, id)) {
    if (findTask(project, id)?.status !== 'running') return;
    perOf(project).interrupting = id;
    redraw(project);
    const current = activeTurns[k] || s;
    const result = await api('POST', `/api/tasks/${enc(project)}/${enc(id)}/interrupt`, current ? {
      ...(current.turnId ? { turnId: current.turnId } : {}),
      ...(current.requestId ? { requestId: current.requestId } : {}),
    } : undefined);
    if (result) toast('interrupt sent — the turn stops at the next safe point');
    else { perOf(project).interrupting = null; redraw(project); }
    return;
  }
  s.phase = 'recalling';
  if (activeTurns[k]) activeTurns[k].phase = 'recalling';
  pausedQueues.add(k); // BEFORE any await: no racing terminal status may send
  perOf(project).interrupting = id;
  persistRecallState();
  redraw(project);
  const body = {
    requestId: s.requestId, ...(s.turnId ? { turnId: s.turnId } : {}),
  };
  const pendingDelivery = deliveries.get(s.requestId);
  let result = await api('POST', `/api/tasks/${enc(project)}/${enc(id)}/recall`, body, { quiet: !!pendingDelivery });
  // The recall can reach the server before /message. Retry only after that
  // original request succeeds; its original server deadline still applies.
  if (!result && pendingDelivery && !s.restored) {
    let timer;
    const accepted = await Promise.race([pendingDelivery, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), Math.max(0, s.deadline - Date.now()));
    })]);
    clearTimeout(timer);
    if (accepted && !s.restored && Date.now() < s.deadline) {
      result = await api('POST', `/api/tasks/${enc(project)}/${enc(id)}/recall`, body);
    }
  }
  if (result?.status === 'recalled') {
    applyRecall({ ...result, project, id });
    toast('prompt restored — completed file changes are not undone');
  } else if (!s.restored) {
    const needsRecovery = recovery || recoveryFor(k);
    s.phase = needsRecovery ? 'recall-recovery' : 'failed';
    if (activeTurns[k] && !needsRecovery) activeTurns[k].phase = 'running';
    perOf(project).interrupting = null;
    if (s.deliveryFailed && typeof s.text === 'string') recoverPrompt(k, s);
    persistRecallState();
    redraw(project);
    toast(needsRecovery ? 'restoration needs recovery — use Retry restore; history and drafts are kept'
      : 'could not restore the turn — history and unsent text kept; queued messages remain paused');
  }
}
