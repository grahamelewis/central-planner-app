// jobs.js — live job cards, split verbatim out of app.js (phase 2):
// build-once/patch-in-place renderer, tick, reconcile, fade-out, 1s clock.

import { enc, fmtJobDur, fmtJobEta, fmtJobMem } from './util.js';
import { jobsLive, jobEntered } from './store.js';
import { api } from './net.js';
import { pumps, pumpConsole } from './console.js';

/* ── live job cards ──
   A long-running script (julia / R / python) gets a status card: elapsed,
   %CPU, memory, pid, ⊘ stop — plus a real progress bar, iter counter and ETA
   when the output stream is ours to parse (▶ runs). Session jobs (Claude's
   Bash tool) show an indeterminate sweep: their stdout belongs to the SDK.
   Cards are built once and PATCHED in place — the bar's width transition and
   the 1s clock tick must never be reset by an innerHTML rebuild. */

const JOB_STATE_TXT = { running: 'running', done: 'done', error: 'failed', stopped: 'stopped' };

const JOB_LANG_TXT = { julia: 'julia', r: 'R', python: 'python', notebook: 'notebook', shell: 'shell', sql: 'sql' };

/* time-dependent fields only — runs on every 1s tick AND on every patch */
function jobCardTick(el) {
  const job = el._job;
  if (!job) return;
  const live = job.state === 'running';
  const drift = live ? performance.now() - job._recvAt : 0;
  const elapsedEl = el.querySelector('.jobElapsed');
  const txt = fmtJobDur((job.ms != null && !live ? job.ms : job.elapsedMs) + drift);
  if (elapsedEl.textContent !== txt) elapsedEl.textContent = txt;
  // quiet: how long the ▶ run has printed nothing — visible from 10s up
  const quiet = live && job.quietMs != null ? job.quietMs + drift : null;
  const qWrap = el.querySelector('.jsQuiet');
  const showQ = quiet != null && quiet >= 10000;
  qWrap.classList.toggle('on', showQ);
  if (showQ) el.querySelector('.jobQuiet').textContent = fmtJobDur(quiet);
}

function renderJobCard(el, job) {
  const fresh = el._jobKey !== job.key;
  if (fresh) {
    el._jobKey = job.key;
    el.className = 'jobCard';
    el.dataset.jobkey = job.key;
    // the entrance fade plays ONCE per JOB, not once per DOM element: renderWB
    // re-inserts the kept console (restarting every CSS animation inside) and
    // the ▶ output pane rebuilds its slot outright — a card re-entering the
    // document must not blink back in from opacity 0 (the "panel disappears
    // and reappears" flicker on every prompt send). The class carrying the
    // animation is removed right after it plays, so re-insertions have
    // nothing to replay.
    if (!jobEntered.has(job.key)) {
      jobEntered.add(job.key);
      el.classList.add('jobNew');
      setTimeout(() => el.classList.remove('jobNew'), 450);
    }
    el.innerHTML = `
      <div class="jobHead">
        <span class="jobDot"></span><span class="jobState"></span>
        <span class="jobLang"></span>
        <button class="jobStop" title="terminate this process">⊘ stop</button>
      </div>
      <div class="jobFile"></div>
      <div class="jobStats">
        <span class="jobStat">elapsed <b class="jobElapsed">—</b></span>
        <span class="jobStat"><b class="jobCpu">—</b> CPU</span>
        <span class="jobStat jsMem">mem <b class="jobMem">—</b></span>
        <span class="jobStat jsQuiet">quiet <b class="jobQuiet"></b></span>
      </div>
      <div class="jobTrack"><div class="jobFill"></div></div>
      <div class="jobFoot"><span class="jobIter"></span><span class="jobMeta"></span></div>`;
    el.querySelector('.jobStop').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'stopping…';
      await api('POST', `/api/jobs/${enc(job.project)}/stop`, { key: job.key });
    });
  }
  el._job = job;
  const st = job.state;
  const stopping = st === 'running' && job.stopping;
  el.dataset.state = st;
  el.classList.toggle('stopping', !!stopping);
  const stTxt = stopping ? 'stopping…' : (JOB_STATE_TXT[st] || st);
  const stEl = el.querySelector('.jobState');
  if (stEl.textContent !== stTxt) stEl.textContent = stTxt;
  // the chip names the runtime — and whether the process outlives the tool
  // call (background dies with the turn; detached survives even that)
  el.querySelector('.jobLang').textContent = (JOB_LANG_TXT[job.lang] || job.lang || '')
    + (job.detached ? ' · detached' : job.bg ? ' · background' : '');
  const fileEl = el.querySelector('.jobFile');
  if (fileEl.textContent !== job.file) fileEl.textContent = job.file;
  fileEl.title = job.command || job.file;
  const stopBtn = el.querySelector('.jobStop');
  if (stopping && !stopBtn.disabled) { stopBtn.disabled = true; stopBtn.textContent = 'stopping…'; }
  el.querySelector('.jobCpu').textContent = job.cpu != null ? `${job.cpu}%` : '—';
  const memWrap = el.querySelector('.jsMem');
  memWrap.classList.toggle('on', job.mem != null);
  if (job.mem != null) el.querySelector('.jobMem').textContent = fmtJobMem(job.mem);
  // the bar: honest width when progress is parseable, a soft sweep otherwise
  const fill = el.querySelector('.jobFill');
  const frac = st === 'done' ? 1 : job.progress ? job.progress.frac : null;
  if (frac != null) {
    fill.classList.remove('indet');
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 1000) / 10;
    const cur = parseFloat(fill.style.width) || 0;
    if (fresh || pct < cur - 8) {
      // no glide when there's nothing honest to glide FROM: a freshly (re)built
      // element starts at width 0 (a rebuilt ▶ output card would re-sweep
      // 0→42% on every render), and a new phase/loop snaps back rather than
      // animating in reverse
      fill.style.transition = 'none';
      fill.style.width = `${pct}%`;
      void fill.offsetWidth; // commit the snap before re-enabling the glide
      fill.style.transition = '';
    } else {
      fill.style.width = `${pct}%`;
    }
  } else if (st === 'running') {
    if (!fill.classList.contains('indet')) {
      fill.classList.add('indet');
      fill.style.width = '';
    }
  } else {
    fill.classList.remove('indet'); // error/stopped: freeze where it was
  }
  // footer: iter/% on the left, ETA · pid (or exit code) on the right
  const iterEl = el.querySelector('.jobIter');
  const pr = job.progress;
  const iterTxt = pr && pr.iter != null && pr.total != null ? `iter ${pr.iter}/${pr.total}`
    : pr && pr.frac != null ? `${Math.round(pr.frac * 100)}%`
      : `started ${new Date(job.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (iterEl.textContent !== iterTxt) iterEl.textContent = iterTxt;
  const bits = [];
  if (st === 'running' && pr && pr.etaS != null) bits.push(`ETA ${fmtJobEta(pr.etaS)}`);
  if (st === 'error' && job.exitCode != null) bits.push(`exit ${job.exitCode}`);
  if (job.pid) bits.push(`pid ${job.pid}`);
  const metaTxt = bits.join(' · ');
  const metaEl = el.querySelector('.jobMeta');
  if (metaEl.textContent !== metaTxt) metaEl.textContent = metaTxt;
  jobCardTick(el);
}

/* reconcile a container's cards against a job list (keyed, patch-in-place) */
/**
 * Build-once/patch-in-place job cards inside a container (console strip).
 * @param {Element} container
 * @param {JobInfo[]} jobs
 * @returns {void}
 */
export function syncJobCards(container, jobs) {
  const want = new Set(jobs.map(j => j.key));
  [...container.children].forEach(el => {
    if (!want.has(el._jobKey)) el.remove();
  });
  for (const job of jobs) {
    let el = [...container.children].find(c => c._jobKey === job.key);
    if (!el) { el = document.createElement('div'); container.appendChild(el); }
    renderJobCard(el, job);
  }
}

/* the ▶ output tab's card rides in a slot above the stream */
/**
 * The ▶ output tab's single job-card slot for the project's active run.
 * @param {string} project
 * @returns {void}
 */
export function syncRunJobCard(project) {
  const slot = document.querySelector(`#v-${project} .runJobSlot`);
  if (!slot) return;
  const job = jobsLive[`run:${project}`];
  syncJobCards(slot, job ? [job] : []);
}


/* a finished card fades out, then leaves the layout */
/**
 * Fade a finished job's card out (terminal state held ~6s first).
 * @param {string} key job key
 * @returns {void}
 */
export function fadeJobCard(key) {
  const j = jobsLive[key];
  document.querySelectorAll('.jobCard').forEach(el => {
    if (el._jobKey === key) el.classList.add('gone');
  });
  setTimeout(() => {
    delete jobsLive[key];
    jobEntered.delete(key); // the entrance may play again if the key returns
    if (!j) return;
    if (j.source === 'run') {
      syncRunJobCard(j.project);
    } else if (j.taskId) {
      const k = `${j.project}/${j.taskId}`;
      const box = document.querySelector(`#v-${j.project} #consoleBox`);
      // go through the pump, not updateConsole directly — a direct call with
      // no `upto` would dump the whole unrevealed stream backlog for one
      // frame mid-reveal, then snap backwards on the next pump frame
      if (box && box.dataset.key === k && !pumps[k]) {
        pumps[k] = requestAnimationFrame(() => pumpConsole(j.project, k));
      }
    }
  }, 450);
}

/* the running cards' clocks tick locally between server pushes */
setInterval(() => {
  document.querySelectorAll('.jobCard').forEach(el => {
    if (el._job && el._job.state === 'running') jobCardTick(el);
  });
}, 1000);
