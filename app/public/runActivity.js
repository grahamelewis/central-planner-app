// Shared running status for the console and overview. Only structured server
// events supply activity; transcript prose and old tool lines are never parsed.
import { esc } from './util.js';
import { state, pendingPerms, perOf, findTask } from './store.js';

/** @type {Map<string, { turnStartedAt: string | null, label: string }>} */
const turns = new Map();
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const labelOf = (activity) => typeof activity?.label === 'string' && activity.label.trim()
  ? activity.label.trim().slice(0, 80) : 'Working';

/** A status boundary resets the clock/activity, never the session's age. */
export function noteRunStatus(p) {
  const key = `${p.project}/${p.id}`;
  if (p.status !== 'running') { turns.delete(key); return; }
  const started = stamp(p.turnStartedAt);
  if (!turns.has(key) || turns.get(key).turnStartedAt !== started) {
    turns.set(key, { turnStartedAt: started, label: 'Working' });
  }
}

export function noteRunActivity(p) {
  if (findTask(p.project, p.id)?.status !== 'running') return;
  const started = stamp(p.turnStartedAt);
  if (!started) return;
  const key = `${p.project}/${p.id}`;
  const previous = turns.get(key);
  // Late events from a previous turn must not resurrect its tool or clock.
  if (previous?.turnStartedAt && Date.parse(started) < Date.parse(previous.turnStartedAt)) return;
  turns.set(key, { turnStartedAt: started, label: labelOf(p.activity) });
  syncRunActivities();
}

/** State snapshots are authoritative across reloads and reconnections. */
export function seedRunActivities(sessions) {
  turns.clear();
  for (const s of sessions) {
    if (s?.status !== 'running' || findTask(s.project, s.id)?.status !== 'running') continue;
    turns.set(`${s.project}/${s.id}`, { turnStartedAt: stamp(s.turnStartedAt), label: labelOf(s.activity) });
  }
}

function display(project, id, now = Date.now()) {
  const turn = turns.get(`${project}/${id}`);
  const mode = perOf(project).interrupting === id ? 'stopping'
    : pendingPerms[`${project}/${id}`]?.length ? 'approval' : 'running';
  const label = mode === 'stopping' ? 'Stopping' : mode === 'approval' ? 'Awaiting approval' : turn?.label || 'Working';
  // An older server may not supply the new timestamp: omit the time rather
  // than presenting page-open time or total session age as elapsed this turn.
  let elapsed = '';
  if (turn?.turnStartedAt) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(turn.turnStartedAt)) / 1000));
    const mm = Math.floor(seconds / 60), ss = String(seconds % 60).padStart(2, '0');
    elapsed = mm < 60 ? `${mm}:${ss}` : `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${ss}`;
  }
  return { label, elapsed, mode };
}

export function runActivityHtml(project, task) {
  const d = display(project, task.id);
  return `<span class="runActivity" data-project="${esc(project)}" data-task="${esc(task.id)}" data-mode="${d.mode}">
    <span class="runActivityDot" aria-hidden="true"></span>
    <span class="runActivityLabel" role="status" aria-live="polite" aria-atomic="true">${esc(d.label)}</span>
    <span class="runActivityTime" role="timer" aria-live="off" title="Elapsed this turn (including approval waits)"${d.elapsed ? '' : ' hidden'}>${d.elapsed}</span>
  </span>`;
}

/** Patch subnodes only: no console redraw, scroll jump, or pulse restart. */
export function syncRunActivities() {
  document.querySelectorAll('.runActivity').forEach(el => {
    const { project, task } = el.dataset;
    el.hidden = findTask(project, task)?.status !== 'running';
    if (el.hidden) return;
    const d = display(project, task);
    if (el.dataset.mode !== d.mode) el.dataset.mode = d.mode;
    const label = el.querySelector('.runActivityLabel');
    const time = el.querySelector('.runActivityTime');
    if (label.textContent !== d.label) label.textContent = d.label;
    if (time.textContent !== d.elapsed) time.textContent = d.elapsed;
    time.hidden = !d.elapsed;
  });
}

setInterval(syncRunActivities, 1000);
