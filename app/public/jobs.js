// jobs.js — live job cards v3 (telemetry strip · expanded card · feed row).
// Build-once/patch-in-place renderer, tick, reconcile, fade-out → feed row,
// 1s clock, and the client-side sample history (ring buffers, phase timeline,
// output tail) that the expanded card plots. Spec: docs/jobcard-mockups/
// IMPLEMENTATION.md §2 (family A, cards-a.html).

import {
  enc, esc, fmtJobDur, fmtDurShort, fmtCores, fmtBytes, fmtRate, fmtCount,
} from './util.js';
import { jobsLive, jobEntered, jobTimers, perOf } from './store.js';
import { api } from './net.js';
import { pumps, pumpConsole } from './console.js';
import * as consoleMod from './console.js';
import { renderWB } from './workbench.js';
import { rowModel, groupModel, tallyParts } from './runledger.js';

/* ── live job cards ──
   Every slot carries a measurement or an honest absence: a HEALTH WORD owns
   the band (computing / stalled 48s / waiting on I/O / starting), cores where
   %CPU stood, footprint with its peak, the process count where the pid sat.
   The bar is the parsed fraction and nothing else; unknown progress says so
   and, with history, draws a dotted ruler against the usual duration. No
   decorative sweep. Cards are built once and PATCHED in place — the bar's
   width transition and the 1s clock tick must never be reset by an innerHTML
   rebuild. Old events (cpu/mem only) still render, labelled % / rss. */

// wave-1 runtime ids from lib/runtimes.js; `make`/`cmake`/`ninja` cards carry
// their project's runtime (c/cpp — or rust/go/node for a wrapping Makefile)
const JOB_LANG_TXT = { julia: 'julia', r: 'R', python: 'python', notebook: 'notebook', shell: 'shell', sql: 'sql', rust: 'rust', go: 'go', node: 'node', c: 'C', cpp: 'C++' };
const HIST_MAX = 150;   // sparkline ring buffer, per key (≈ 5 min at 2 s)
const PROG_MAX = 60;    // parsed-fraction samples for the client-side rate ETA
const TAIL_MAX = 12;    // output.last history (the card shows the last 3)

/** Terminal snapshots kept for the session feed after the card fades. */
/** @type {{ [jobKey: string]: JobInfo }} */
export const jobsEnded = {};
const jobExpanded = new Set(); // keys whose card is expanded (memory only)

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const push = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };
const fmtInt = (n) => (n == null ? '' : Number(n).toLocaleString());
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

/** Keys identify slots; immutable run IDs identify invocations. Old servers
 * only have startedAt, retained as a compatibility fallback, never elapsedMs. */
export const sameJobRun = (a, b) => !!a && !!b && a.key === b.key
  && (a.jobRunId && b.jobRunId ? a.jobRunId === b.jobRunId
    : a.startedAt != null && b.startedAt != null && a.startedAt === b.startedAt);

/** A settled invocation cannot become running again through replay/resync. */
export function shouldAcceptJobSnapshot(previous, incoming) {
  if (previous && incoming && previous.key === incoming.key && previous.jobRunId && incoming.jobRunId
      && previous.jobRunId !== incoming.jobRunId) {
    const before = Date.parse(previous.createdAt), next = Date.parse(incoming.createdAt);
    if (Number.isFinite(before) && Number.isFinite(next) && next < before) return false;
  }
  return !(sameJobRun(previous, incoming) && ['done', 'error', 'stopped'].includes(previous.state)
    && incoming.state === 'running');
}

/** File paths and human/launcher labels are different data. Only the former
 * may be reduced to a basename. In old inline records `file` may be a command
 * cut in the middle of /Users/gra: never treat that fragment as a filename. */
export function jobTitle(job) {
  const display = typeof job.displayTitle === 'string' ? job.displayTitle.trim() : '';
  const file = typeof job.file === 'string' ? job.file : '';
  const command = typeof job.command === 'string' ? job.command : '';
  const generic = `inline ${{ julia: 'Julia', python: 'Python', r: 'R', node: 'Node', shell: 'shell', sql: 'SQL' }[job.lang] || job.lang || 'program'}`;
  const raw = display || file;
  let name;
  if (job.titleKind === 'label' || job.titleKind === 'inline') name = display || (job.inline ? generic : 'program');
  else if (job.inline) name = display || generic;
  else if (job.titleKind === 'file') name = raw.split('/').filter(Boolean).pop() || raw || 'program';
  // Legacy launcher names already use "project (launcher target)". Slashes
  // inside targets are not path separators for the complete label.
  else if (display || /\([^)]*\)\s*$/.test(file)) name = raw;
  else if (file) name = file.split('/').filter(Boolean).pop() || file;
  else name = command || 'program';
  if (!job.inline && job.titleKind !== 'label' && /\/$/.test(raw) && !name.endsWith('/')) name += '/';
  const tooltip = command || (job.inline && !display && file
    ? `Recorded inline label/command excerpt: ${file}` : raw || name);
  return { name, tooltip };
}

function clearJobFade(key) {
  if (jobTimers[key]) clearTimeout(jobTimers[key]);
  delete jobTimers[key];
}

/** Capture the terminal invocation, not just its reusable project key. */
export function scheduleJobFade(job) {
  if (jobTimers[job.key]) return;
  const timer = setTimeout(() => {
    if (jobTimers[job.key] !== timer) return;
    delete jobTimers[job.key];
    fadeJobCard(job.key, job);
  }, 6000);
  jobTimers[job.key] = timer;
}

/**
 * Carry the client-side history from the previous snapshot of a job onto the
 * new one and append this event's sample. Called from the job:status intake
 * (app.js) before the new object replaces the old in jobsLive.
 * @param {JobInfo | undefined} prev
 * @param {JobInfo} j
 * @returns {JobInfo} j, with `_hist` attached
 */
export function absorbJob(prev, j) {
  if (!shouldAcceptJobSnapshot(prev, j)) return prev;
  const same = sameJobRun(prev, j);
  if (!same || j.state === 'running') clearJobFade(j.key);
  if (!same) {
    jobEntered.delete(j.key);
    jobExpanded.delete(j.key);
  }
  const h = same && prev._hist ? prev._hist : {
    cores: [], mem: [], t: [], prog: [], phases: [], stalls: [], tail: [], lastSample: undefined, lastLine: null,
  };
  j._hist = h;
  const el = num(j.elapsedMs) || 0;
  const hs = j.health && j.health.state;
  // one sample per successful sweep (sampledAt); one per event when absent
  const stamp = j.sampledAt || null;
  if (j.state === 'running' && !j.stale && hs !== 'starting' && (stamp == null || stamp !== h.lastSample)) {
    h.lastSample = stamp;
    const c = j.cores != null ? num(j.cores) : (j.cpu != null ? num(j.cpu) / 100 : null);
    const m = j.memBytes != null ? num(j.memBytes) : num(j.mem);
    // the server restarts memPeakBytes when the kind flips (rss → footprint);
    // the sparkline must not mix the two scales either
    const mk = j.memBytes != null ? (j.memKind || 'rss') : 'rss';
    if (h.memKind && h.memKind !== mk) h.mem = h.mem.map(() => null);
    h.memKind = mk;
    if (c != null || m != null) { push(h.cores, c, HIST_MAX); push(h.mem, m, HIST_MAX); push(h.t, el, HIST_MAX); }
  }
  const frac = fracOf(j);
  if (frac != null && j.state === 'running') push(h.prog, [el, frac], PROG_MAX);
  // phase timeline: spawn → (parser phase words) → running
  const pname = j.phase && j.phase.name ? String(j.phase.name) : null;
  if (!h.phases.length) h.phases.push({ name: 'start', at: 0, k: 'queue' });
  const cur = h.phases[h.phases.length - 1];
  if (pname) {
    if (cur.name !== pname) h.phases.push({ name: pname, at: el, k: 'blue' });
  } else if (j.state === 'running' && (cur.k === 'blue' || (cur.name === 'start' && (hs ? hs !== 'starting' : !!j.pid)))) {
    h.phases.push({ name: 'running', at: el, k: 'run' }); // a parser phase ended, or the pid got pinned
  }
  // stalled windows (hatched on the timeline)
  if (hs === 'stalled') {
    const from = Math.max(0, el - (num(j.health.sinceMs) || 0));
    const last = h.stalls[h.stalls.length - 1];
    if (last && Math.abs(last.from - from) < 5000) last.to = el;
    else h.stalls.push({ from, to: el });
  }
  const line = j.output && j.output.last;
  if (line && line !== h.lastLine) { h.lastLine = line; push(h.tail, String(line), TAIL_MAX); }
  return j;
}

/* ── derived facts ── */

/** parsed fraction: progress.frac, else a hard phase n/m — never anything else */
function fracOf(job) {
  const pr = job.progress;
  if (pr && Number.isFinite(pr.frac)) return Math.min(1, Math.max(0, pr.frac));
  const ph = job.phase;
  if (ph && !ph.mSoft && num(ph.m) > 0 && num(ph.n) != null) return Math.min(1, Math.max(0, ph.n / ph.m));
  return null;
}

/** band colour key + head words for a job's state × health */
function bandOf(job) {
  const st = job.state;
  const hs = job.health && job.health.state;
  const since = job.health ? fmtDurShort(num(job.health.sinceMs) || 0) : '';
  if (st === 'done') return { hk: 'run', state: 'done', health: '' };
  if (st === 'error') {
    const ex = exitTxt(job);
    return { hk: 'red', state: ex ? `failed · ${ex}` : 'failed', health: '' };
  }
  if (st === 'stopped') {
    const byUser = !job.exit || job.exit.byUser !== false;
    return { hk: 'yellow', state: byUser ? 'stopped · by you' : 'stopped', health: '' };
  }
  if (job.stopping) return { hk: 'yellow', state: 'stopping…', health: '' };
  if (hs === 'starting' || (st === 'running' && !job.health && !job.pid && job.cpu == null)) {
    return { hk: 'queue', state: 'starting · pid not pinned', health: '', starting: true };
  }
  if (hs === 'stalled') return { hk: 'wait', state: `stalled ${since}`, health: '', stalled: true };
  if (hs === 'idle') return { hk: 'wait', state: 'running', health: `idle ${since}` };
  if (hs === 'io') return { hk: 'blue', state: 'running', health: 'waiting on I/O' };
  if (hs === 'computing') return { hk: 'run', state: 'running', health: 'computing' };
  return { hk: 'run', state: 'running', health: '' }; // old event: no health word
}

/** ms since the last output line: the wire's quietMs (▶ runs), else the stalled window so far */
function quietOf(job) {
  const q = num(job.quietMs);
  return q != null ? q : (num(job.health && job.health.sinceMs) || 0);
}

const HEALTH_TITLE = {
  computing: '≥ 0.05 cores over the last poll, summed over the process tree',
  stalled: '< 0.05 cores and no output for ≥ 20 s — a heuristic; a sleep() looks the same',
  idle: '< 0.05 cores for less than 20 s so far',
  io: 'process state U (uninterruptible wait): waiting on disk or network',
};

function exitTxt(job) {
  const ex = job.exit || null;
  const sig = ex && ex.signal ? String(ex.signal) : null;
  const code = ex && ex.code != null ? ex.code : job.exitCode;
  const oom = sig === 'SIGKILL' ? ' · often out of memory' : '';
  if (sig && code != null) return `exit ${code} (${sig}${oom})`;
  if (sig) return `${sig}${oom}`;
  if (code != null) return `exit ${code}`;
  return null;
}

/** counters → "138 passed · 2 failed · 3 warnings" (html, failures/errors in red) */
function countersHtml(c, { skipProgress = false } = {}) {
  if (!c) return [];
  const out = [];
  if (c.passed != null || c.failed != null || c.skipped != null || c.ok != null) {
    if (c.ok != null) out.push(`${fmtInt(c.ok)} ok`);
    if (c.passed != null) out.push(`${fmtInt(c.passed)} passed`);
    if (c.failed) out.push(`<span class="jpBad">${fmtInt(c.failed)} failed</span>`);
    else if (c.failed === 0 && c.passed == null && c.ok == null) out.push('0 failed');
    if (c.skipped) out.push(`${fmtInt(c.skipped)} skipped`);
  }
  if (c.todo) out.push(`${fmtInt(c.todo)} todo`);
  // suites (jest/vitest/gtest files or cases): failures in red; the plain
  // count only when no per-test tally says more
  if (c.suitesFailed) out.push(`<span class="jpBad">${fmtInt(c.suitesFailed)} suite${c.suitesFailed === 1 ? '' : 's'} failed</span>`);
  else if (c.suites && c.passed == null && c.failed == null) out.push(`${fmtInt(c.suites)} suite${c.suites === 1 ? '' : 's'}`);
  if (c.warnings) out.push(`<span class="jpWarn">${fmtInt(c.warnings)} warning${c.warnings === 1 ? '' : 's'}</span>`);
  if (c.errors) out.push(`<span class="jpBad">${fmtInt(c.errors)} error${c.errors === 1 ? '' : 's'}</span>`);
  if (c.notes) out.push(`${fmtInt(c.notes)} note${c.notes === 1 ? '' : 's'}`);
  // the most recent located compiler/test diagnostic: "last: src/main.rs:12:5 mismatched types"
  const le = c.lastError && typeof c.lastError === 'object' ? c.lastError : null;
  if (le && (le.file || le.msg)) {
    const loc = le.file ? `${le.file}${le.line != null ? `:${le.line}${le.col != null ? `:${le.col}` : ''}` : ''}` : '';
    const msg = String(le.msg || '');
    const short = msg.length > 60 ? msg.slice(0, 59) + '…' : msg;
    out.push(`<span class="jpLast" title="${esc([loc, msg].filter(Boolean).join(' '))}"><span class="jpMut">last:</span> ${esc([loc, short].filter(Boolean).join(' '))}</span>`);
  }
  if (c.coverage != null) out.push(`coverage ${Number(c.coverage) % 1 ? Number(c.coverage).toFixed(1) : fmtInt(c.coverage)}%`);
  if (c.modules) out.push(`${fmtInt(c.modules)} modules`);
  if (c.exitStatus != null) out.push(`<span class="jpBad">program exit ${fmtInt(c.exitStatus)}</span>`);
  if (c.timeS != null) out.push(`<span class="jpMut">reported ${fmtDurShort(Number(c.timeS) * 1000)}</span>`);
  if (!skipProgress && c.page != null) out.push(`page ${fmtInt(c.page)}`);
  if (c.pass != null) {
    const soft = c.passesSoft != null ? ` <span class="est" title="last build's pass count — an estimate">of ≈${c.passesSoft}</span>` : '';
    out.push(`pass ${c.pass}${soft}`);
  }
  if (!skipProgress && c.rateBps != null) out.push(`${fmtBytes(c.rateBps)}/s`);
  return out;
}

/** progress line, left half (running) → html */
function progLeftHtml(job, band) {
  const pr = job.progress, ph = job.phase, c = job.counters || {};
  let main = '';
  if (pr && pr.iter != null && pr.total != null) {
    main = `iter ${fmtInt(pr.iter)}/${fmtInt(pr.total)}${Number.isFinite(pr.frac) ? ` · ${Math.round(pr.frac * 100)}%` : ''}`;
  } else if (ph && ph.n != null && ph.m != null) {
    main = `${esc(ph.name || 'phase')} ${fmtInt(ph.n)}/${ph.mSoft ? `<span class="est" title="total is an estimate">≈${fmtInt(ph.m)}</span>` : fmtInt(ph.m)}`;
  } else if (c.bytes != null) {
    main = c.total ? `${fmtBytes(c.bytes)} / ${fmtBytes(c.total)} · ${Math.round(Math.min(1, c.bytes / c.total) * 100)}%` : fmtBytes(c.bytes);
  } else if (pr && Number.isFinite(pr.frac)) {
    main = `${Math.round(pr.frac * 100)}%`;
  } else if (c.crate) {
    main = `${esc((ph && ph.name) || 'compiling')} ${esc(c.crate)}`;
  } else if (c.page != null) {
    main = `page ${fmtInt(c.page)}`;
  } else if (ph && ph.name) {
    main = esc(ph.name);
  }
  const notes = countersHtml(c, { skipProgress: true });
  if (c.page != null && main && !main.startsWith('page')) notes.push(`page ${fmtInt(c.page)}`);
  if (c.rateBps != null) notes.push(`${fmtBytes(c.rateBps)}/s`);
  if (band.stalled && job.output && job.output.owned) notes.push(`<span class="jpStall">no output ${fmtDurShort(quietOf(job))}</span>`);
  const left = main ? `<span class="jpMain">${main}</span>` : '<span class="jpDim">no progress info</span>';
  return notes.length ? `${left} <span class="jpSep">·</span> <span class="jpNote">${notes.join(' <span class="jpSep">·</span> ')}</span>` : left;
}

/** ETA seconds: the tool's own when printed, else a linear extrapolation of the parsed fraction over the last 30 s */
function etaOf(job) {
  const pr = job.progress;
  if (pr && Number.isFinite(pr.etaS) && pr.etaS >= 0) return { s: pr.etaS, src: 'printed by the tool; assumes a constant rate' };
  const frac = fracOf(job);
  const h = job._hist;
  if (frac == null || !h || h.prog.length < 2) return null;
  if (frac >= 1) return { s: 0, src: 'parsed counter at 100 %' };
  const now = h.prog[h.prog.length - 1];
  const win = h.prog.filter(p => now[0] - p[0] <= 30000);
  const first = win[0];
  const dt = now[0] - first[0], df = now[1] - first[1];
  if (dt < 4000 || df <= 0) return null;
  return { s: ((1 - frac) / (df / dt)) / 1000, src: 'linear extrapolation of the parsed counter over the last 30 s' };
}

/** progress line, right half (running) → html; withheld ETAs say why */
function progRightHtml(job, band, hasMain) {
  const ph = job.phase, hist = job.history;
  const withheld = (why, title) => `<span class="jpNoEta" title="${esc(title)}">ETA — ${why}</span>`;
  const frac = fracOf(job);
  if (band.stalled && (hasMain || frac != null)) return withheld('stalled', 'no progress samples while stalled; extrapolating would invent a finish time');
  const eta = etaOf(job);
  if (eta) return `<span class="est" title="estimate — ${esc(eta.src)}">≈ETA ${fmtDurShort(eta.s * 1000)}</span>`;
  if (ph && ph.mSoft) return withheld('total unknown', 'the total is itself an estimate');
  if (ph && ph.n != null && ph.m != null) return withheld('rate uneven', 'step times vary too much for a linear ETA');
  if (ph && ph.name && ph.m == null && !hist) return withheld('total unknown', 'the count is not known until this phase finishes');
  if (frac != null) return withheld('rate uneven', 'not enough progress samples yet for a steady rate');
  if (hist && num(hist.typicalMs) > 0) {
    return `<span class="est" title="median of ${hist.n} past run${hist.n === 1 ? '' : 's'} of this command — a ruler, not a progress bar">≈usually ${fmtDurShort(hist.typicalMs)} · n=${hist.n}</span>`;
  }
  if (!hasMain) return '<span class="jpDim">no history yet</span>';
  return '';
}

/** terminal states: the progress line becomes the end summary */
function endSummaryHtml(job) {
  const st = job.state;
  const ms = num(job.ms) != null ? num(job.ms) : num(job.elapsedMs);
  const dur = fmtJobDur(ms);
  const peak = num(job.memPeakBytes);
  const cpux = num(job.cpuTimeMs) != null && ms > 0 ? `${(job.cpuTimeMs / ms).toFixed(1)}×` : null;
  const facts = [];
  if (peak) facts.push(`peak ${fmtBytes(peak)}`);
  if (cpux) facts.push(`cpu ${cpux}`);
  const counters = countersHtml(job.counters);
  if (st === 'done') return { k: 'ok', html: ['✓ ' + dur, ...facts, ...counters].join(' · ') };
  if (st === 'error') {
    const ex = exitTxt(job);
    return { k: 'bad', html: [`✗ ${ex || 'failed'}`, ...counters, dur, ...facts.filter(f => f.startsWith('peak'))].join(' · ') };
  }
  const byUser = !job.exit || job.exit.byUser !== false;
  const frac = fracOf(job);
  const where = frac != null ? `at ${Math.round(frac * 100)}%` : `at ${dur}`;
  return { k: 'stop', html: [`⊘ stopped${byUser ? ' by you' : ''} <span class="jpMut">${where}</span>`, ...facts.filter(f => f.startsWith('peak'))].join(' · ') };
}

/** the telemetry strip → html */
function stripHtml(job, band, stale) {
  const cell = (cls, title, inner) => `<span class="jobCell${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${inner}</span>`;
  if (band.starting) return cell('note', 'the interpreter pid is not pinned yet: every process number is —, never 0', '<em>no sample yet · pid not pinned</em>');
  const cells = [];
  const out = job.output;
  if (job.state !== 'running') {
    const peak = num(job.memPeakBytes);
    const ms = num(job.ms) != null ? num(job.ms) : num(job.elapsedMs);
    if (peak) cells.push(cell('', 'highest footprint sample during the run', `<em>peak</em> <b>${fmtBytes(peak)}</b>`));
    if (num(job.cpuTimeMs) != null && ms > 0) cells.push(cell('', 'total CPU time ÷ wall time', `<em>cpu</em> <b>${(job.cpuTimeMs / ms).toFixed(1)}×</b>`));
    if (out && out.owned && out.lines != null) cells.push(cell('', 'lines received on the owned stdout/stderr pipe', `<b>${fmtCount(out.lines)}</b> <em>ln</em>`));
    return cells.join('');
  }
  const dimmed = stale || job.coresBasis === 'pcpu' ? ' dim' : '';
  if (job.cores != null) {
    const c = num(job.cores);
    const hc = num(job.hostCores);
    const basis = job.coresBasis === 'pcpu' ? ' · first sweep: ps pcpu basis' : ' — Δcputime ÷ Δwall, summed over the tree';
    cells.push(cell(`cores${c != null && c < 0.05 ? ' wait' : ''}${dimmed}`, `${fmtCores(c)}${hc ? ` of ${hc}` : ''} cores${basis}`, `<b>${fmtCores(c)}</b> <em>cores</em>`));
  } else if (job.cpu != null) {
    cells.push(cell(`cores${dimmed}`, 'legacy: ps pcpu summed over the process tree (100 = one core)', `<b>${num(job.cpu)}</b><em>%</em>`));
  }
  if (job.memBytes != null) {
    const rss = job.memKind === 'rss';
    const peak = num(job.memPeakBytes);
    cells.push(cell(dimmed.trim(), rss ? 'Σ resident set size (footprint unavailable) — over-counts shared pages' : 'physical footprint summed over the tree · ▲ peak since spawn',
      `<em>${rss ? 'rss' : 'mem'}</em> <b>${fmtBytes(job.memBytes)}</b>${peak ? ` <span class="pk" title="peak since spawn">▲${fmtBytes(peak)}</span>` : ''}`));
  } else if (job.mem != null) {
    cells.push(cell(dimmed.trim(), 'Σ resident set size over the process tree (legacy)', `<em>rss</em> <b>${fmtBytes(job.mem)}</b>`));
  }
  if (job.procs != null) cells.push(cell(dimmed.trim(), `${job.procs} process${job.procs === 1 ? '' : 'es'} in the pid's tree${job.threads != null ? ` · ${job.threads} threads` : ''}`, `<b>${num(job.procs)}</b> <em>${job.procs === 1 ? 'proc' : 'procs'}</em>`));
  if (out) {
    if (out.owned) {
      const t = out.buffered ? 'lines on the owned pipe — Python block-buffers stdout when piped, so counts may lag in 8 KiB bursts' : 'lines received on the owned stdout/stderr pipe · rate over the last 10 s';
      cells.push(cell(`out${dimmed}`, t, `<b>${fmtCount(out.lines)}</b> <em>ln</em> <em>·</em> <b>${fmtRate(out.rate)}</b><em>/s</em> <i class="src" title="▶ run: the dashboard owns stdout/stderr">▶</i>`));
    } else {
      cells.push(cell('note', 'launched by the agent\'s shell — stdout/stderr reach the dashboard only in the tool result', '<em>output not visible · session</em>'));
    }
  }
  return cells.join('');
}

/* ── expanded card ── */

function sparkSvg(vals, cls, { peak = false, peakLbl = '' } = {}) {
  const W = 300, H = 38;
  const pts = [];
  vals.forEach((v, i) => { if (v != null && Number.isFinite(v)) pts.push([i, v]); });
  if (pts.length < 2) return `<div class="spBox ${cls}"><span class="spNone">${pts.length ? 'one sample' : 'no samples yet'}</span></div>`;
  const n = vals.length;
  const max = Math.max(...pts.map(p => p[1])) * 1.1 || 1;
  const xy = pts.map(([i, v]) => [(i / (n - 1)) * W, H - (v / max) * (H - 4)]);
  const line = xy.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `M${xy[0][0].toFixed(1)},${H} ` + xy.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${xy[xy.length - 1][0].toFixed(1)},${H} Z`;
  let extras = '';
  if (peak) {
    let pi = 0;
    pts.forEach((p, k) => { if (p[1] > pts[pi][1]) pi = k; });
    extras = `<i class="spPk" style="left:min(${((pts[pi][0] / (n - 1)) * 100).toFixed(1)}%, calc(100% - 3px));top:${((xy[pi][1] / H) * 100).toFixed(1)}%" title="peak ${esc(peakLbl)}"></i>`;
  }
  return `<div class="spBox ${cls}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="spA" d="${area}"/><polyline class="spL" points="${line}" vector-effect="non-scaling-stroke"/></svg>${extras}</div>`;
}

function expandedHtml(job, band) {
  const h = job._hist || { cores: [], mem: [], t: [], prog: [], phases: [], stalls: [], tail: [] };
  const live = job.state === 'running';
  const el = live ? (num(job.elapsedMs) || 0) : (num(job.ms) != null ? num(job.ms) : num(job.elapsedMs) || 0);
  const hist = job.history;
  const usual = hist && num(hist.typicalMs) > 0 ? hist.typicalMs : 0;
  const total = Math.max(el, usual, 1) * 1.12;
  const pct = (ms) => `${Math.max(0, Math.min(100, (ms / total) * 100)).toFixed(2)}%`;
  let segs = '';
  const cap = [];
  h.phases.forEach((p, i) => {
    const to = i + 1 < h.phases.length ? h.phases[i + 1].at : el;
    const dur = Math.max(0, to - p.at);
    segs += `<i class="ph ${p.k}" style="left:${pct(p.at)};width:${pct(dur)}" title="${esc(p.name)} ${fmtDurShort(dur)}"></i>`;
    cap.push(`<span><i class="sw ${p.k}"></i>${esc(p.name)} <b>${fmtDurShort(dur)}</b>${i + 1 === h.phases.length && live ? '…' : ''}</span>`);
  });
  let stalledMs = 0;
  for (const s of h.stalls) {
    stalledMs += Math.max(0, s.to - s.from);
    segs += `<i class="ph hatch" style="left:${pct(s.from)};width:${pct(Math.max(0, s.to - s.from))}" title="stalled ${fmtDurShort(s.to - s.from)}: < 0.05 cores, no output"></i>`;
  }
  if (stalledMs) cap.push(`<span><i class="sw wait"></i>stalled <b>${fmtDurShort(stalledMs)}</b></span>`);
  segs += `<i class="phNow" style="left:${pct(el)}" title="now · ${fmtDurShort(el)}"></i>`;
  if (usual) {
    segs += `<i class="phGhost" style="left:${pct(usual)}" title="usual total ≈${fmtDurShort(usual)} (median of ${hist.n} runs)"></i>`;
    cap.push(`<span class="est" title="the dotted tick on the bar: median of ${hist.n} past runs">┆ ≈usual ${fmtDurShort(usual)} · n=${hist.n}</span>`);
  } else cap.push('<span class="jpDim">no history for this command</span>');
  const coresNow = h.cores.length ? h.cores[h.cores.length - 1] : null;
  const coreSamples = h.cores.filter(v => v != null);
  const coresMax = coreSamples.length ? Math.max(...coreSamples) : null;
  const memNow = h.mem.length ? h.mem[h.mem.length - 1] : null;
  const memSamples = h.mem.filter(v => v != null);
  const memMax = memSamples.length ? Math.max(...memSamples) : null;
  const hc = num(job.hostCores);
  const legacyCpu = job.cores == null && job.cpu != null;
  const sparks = `
    <div class="spRow"><div class="spLbl"><em>${legacyCpu ? 'cpu' : 'cores'}</em><b class="${coresNow != null && coresNow < 0.05 ? 'wait' : 'cores'}">${legacyCpu ? (coresNow == null ? '—' : `${Math.round(coresNow * 100)}%`) : fmtCores(coresNow)}</b><span class="sub">max ${legacyCpu ? (coresMax == null ? '—' : `${Math.round(coresMax * 100)}%`) : fmtCores(coresMax)}${hc ? ` · of ${hc}` : ''}</span></div>${sparkSvg(h.cores, 'cores')}</div>
    <div class="spRow"><div class="spLbl"><em>${job.memKind === 'rss' || (job.memBytes == null && job.mem != null) ? 'rss' : 'mem'}</em><b class="mem">${fmtBytes(memNow)}</b><span class="sub">▲ peak ${fmtBytes(num(job.memPeakBytes) ?? memMax)}</span></div>${sparkSvg(h.mem, 'mem', { peak: true, peakLbl: fmtBytes(memMax) })}</div>`;
  const out = job.output;
  let tail;
  if (out && out.owned) {
    const lines = h.tail.slice(-3);
    const quiet = band.stalled ? `<div class="quiet">— no output for ${fmtDurShort(quietOf(job))} —</div>` : '';
    tail = `<div class="xH"><span>output</span><b>${fmtCount(out.lines)} ln · ${fmtRate(out.rate)}/s</b></div>
      <div class="xTailBox">${lines.length ? lines.map(l => `<div class="${/error|failed|traceback|^!\s/i.test(l) ? 'bad' : /warn/i.test(l) ? 'quiet' : ''}">${esc(l)}</div>`).join('') : '<div class="jpDim">no output lines yet</div>'}${quiet}</div>`;
  } else {
    tail = `<div class="xH"><span>output</span><span class="sub">not visible · ${out ? 'session' : 'no stream on this event'}</span></div>
      <div class="xTailBox"><div class="jpDim">launched by the agent's shell — stdout/stderr reach the dashboard only in the tool result</div></div>`;
  }
  const procs = num(job.procs);
  const thr = num(job.threads);
  const pidBtn = job.pid ? `<button class="pidBtn" data-pid="${esc(String(job.pid))}" title="click to copy the pinned pid">pid ${esc(String(job.pid))} ⧉</button>` : '<span class="sub">pid not pinned</span>';
  const proc = `<div class="xH"><span>process</span><b>${procs != null ? `${procs} ${procs === 1 ? 'proc' : 'procs'}` : '— procs'}${thr != null ? ` · ${thr} thr` : ''}</b>${pidBtn}</div>`;
  const sampled = job.state !== 'running' ? 'at exit' : (job.sampledAt ? '' : 'no sample yet');
  const foot = `<span>started <b>${esc(clock(job.startedAt))}</b></span><span>sampled <b class="xSampled">${sampled}</b> <span title="ps -A sweep interval">· poll ${fmtDurShort(num(job.pollMs) || 2000)}</span></span>${job.state !== 'running' && exitTxt(job) ? `<span>exit <b>${esc(exitTxt(job))}</b></span>` : ''}`;
  return `<div class="xPh"><div class="xH"><span>phases</span><span class="sub">boundaries from the output parser + spawn/exit</span></div><div class="phBar">${segs}</div><div class="phCap">${cap.join('')}</div></div>
    <div class="xTail">${tail}</div>
    <div class="xSp">${sparks}</div>
    <div class="xTree">${proc}</div>
    <div class="xFoot">${foot}</div>`;
}

/* ── actions ── */

/**
 * Terminate a job's process tree via the stop route (shared by the card's ⊘
 * button and the feed row's ⊘ stop).
 * @param {JobInfo} job
 * @param {HTMLButtonElement | null} [btn]
 * @returns {Promise<void>}
 */
export async function stopJob(job, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'stopping…'; }
  const result = await api('POST', `/api/jobs/${enc(job.project)}/stop`, {
    key: job.key, ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.jobRunId ? { jobRunId: job.jobRunId } : {}),
  });
  if (!result && btn?.isConnected) {
    const owner = btn.closest('.jobCard, .jobFeedRow');
    if (sameJobRun(owner?._job, job) && owner._job.state === 'running' && !owner._job.stopping) {
      btn.disabled = false;
      btn.textContent = '⊘ stop';
    }
  }
}

function copyPid(pid, btn) {
  const p = String(pid);
  const done = () => {
    if (!btn) return;
    const was = btn.textContent;
    btn.textContent = `copied ${p}`;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('copied'); }, 1200);
  };
  (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(p) : Promise.reject(new Error('no clipboard')))
    .then(done, () => {
      // fallback: a transient textarea + execCommand (older/insecure contexts)
      try {
        const ta = document.createElement('textarea');
        ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      } catch { /* nothing to do */ }
      done();
    });
}

function setExpanded(el, on) {
  const job = el._job;
  if (!job) return;
  if (on) jobExpanded.add(job.key); else jobExpanded.delete(job.key);
  el.classList.toggle('expanded', on);
  el.setAttribute('aria-expanded', on ? 'true' : 'false');
  const more = el.querySelector('.jobMore');
  if (more) { more.textContent = on ? '▴' : '▾'; more.title = on ? 'collapse' : 'expand: timeline, sparklines, output tail, process, pid'; }
  const x = el.querySelector('.jobX');
  x.classList.toggle('off', !on);
  if (on) x.innerHTML = expandedHtml(job, bandOf(job));
  else x.innerHTML = '';
  jobCardTick(el);
}

/* ── tick: time-dependent fields only — runs on every 1s tick AND on every patch ── */

/**
 * Patch the time-dependent fields of a card (elapsed clock, stale tag, sample
 * age); also used by the 1s interval.
 * @param {Element} el
 * @returns {void}
 */
export function jobCardTick(el) {
  const job = el._job;
  if (!job) return;
  const live = job.state === 'running';
  const drift = live ? performance.now() - job._recvAt : 0;
  const elapsedEl = el.querySelector('.jobElapsed');
  const txt = fmtJobDur((job.ms != null && !live ? job.ms : job.elapsedMs) + drift);
  if (elapsedEl.textContent !== txt) elapsedEl.textContent = txt;
  // stale: the server flags it (pid vanished / sweep failed); the client also
  // flags a card whose events have stopped arriving for 3 polls (skew-free)
  const poll = num(job.pollMs) || 2000;
  const sampledAge = job.sampledAt ? Date.now() - Date.parse(job.sampledAt) : null;
  let stale = false;
  if (live && !(bandOf(job).starting)) {
    if (job.stale) stale = true;
    else if (drift > 3 * poll) stale = true;
  }
  el.classList.toggle('stale', stale);
  const tag = el.querySelector('.jobStale');
  if (stale) {
    const age = Math.max(sampledAge != null ? sampledAge : 0, drift);
    const t = `stale ${fmtDurShort(age)}`;
    if (tag.textContent !== t) tag.textContent = t;
    tag.title = `last successful sample was ${fmtDurShort(age)} ago — numbers are frozen, not zero`;
  } else if (tag.textContent) tag.textContent = '';
  const samp = el.querySelector('.xSampled');
  if (samp && live) {
    const t = sampledAge != null ? `${fmtDurShort(Math.max(0, sampledAge))} ago` : 'no sample yet';
    if (samp.textContent !== t) samp.textContent = t;
  }
}

/* ── the card ── */

function buildJobCard(el, job) {
  el.innerHTML = `
    <div class="jobHead">
      <span class="jobDot"></span><span class="jobState"></span>
      <span class="jobLang"><span class="jlTxt"></span></span>
      <span class="jobHealth"></span>
    </div>
    <div class="jobTail">
      <span class="jobStale"></span>
      <span class="jobElapsed">—</span>
      <button class="jobStop" title="terminate this process tree">⊘ stop</button>
      <span class="jobMore" aria-hidden="true" title="expand: timeline, sparklines, output tail, process, pid">▾</span>
    </div>
    <div class="jobFile"></div>
    <div class="jobProg"><span class="jpL"></span><span class="jpR"></span></div>
    <div class="jobTrack off"><div class="jobFill"></div></div>
    <div class="jobRuler off"><i class="rNow"></i><i class="rTick"></i></div>
    <div class="jobStats"></div>
    <div class="jobX off"></div>`;
  el.setAttribute('role', 'group');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-expanded', 'false');
  el.querySelector('.jobStop').addEventListener('click', (e) => {
    e.stopPropagation();
    stopJob(el._job, /** @type {HTMLButtonElement} */ (e.currentTarget));
  });
  el.querySelector('.jobLang').addEventListener('click', (e) => {
    const j = el._job;
    if (!j || !j.pid) return; // no pid: the click falls through to expand
    e.stopPropagation();
    copyPid(j.pid, null);
    const chip = /** @type {HTMLElement} */ (e.currentTarget);
    chip.classList.add('copied');
    chip.dataset.copied = `copied ${j.pid}`;
    setTimeout(() => { chip.classList.remove('copied'); delete chip.dataset.copied; }, 1200);
  });
  // click anywhere on the strip (except the buttons) toggles the expanded card
  el.addEventListener('click', (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t.closest('button, a, .pidBtn')) {
      const pb = t.closest('.pidBtn');
      if (pb) { e.stopPropagation(); copyPid(pb.getAttribute('data-pid'), pb); }
      return;
    }
    if (window.getSelection && String(window.getSelection()).length) return; // text selection, not a toggle
    setExpanded(el, !el.classList.contains('expanded'));
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('expanded')) {
      e.preventDefault(); e.stopPropagation();
      setExpanded(el, false);
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      setExpanded(el, !el.classList.contains('expanded'));
    }
  });
}

function renderJobCard(el, job) {
  const fresh = !sameJobRun(el._job, job);
  if (fresh) {
    // Replacing the node also drops old click handlers and pending button
    // callbacks. A new run never inherits its predecessor's progress bar.
    if (el._job) {
      const replacement = document.createElement('div');
      el.replaceWith(replacement);
      el = replacement;
    }
    el._jobKey = job.key;
    el.className = 'jobCard';
    el.dataset.jobkey = job.key;
    // the entrance fade plays ONCE per JOB, not once per DOM element: renderWB
    // re-inserts the kept console (restarting every CSS animation inside) and
    // the ▶ output pane rebuilds its slot outright — a card re-entering the
    // document must not blink back in from opacity 0. The class carrying the
    // animation is removed right after it plays.
    if (!jobEntered.has(job.key)) {
      jobEntered.add(job.key);
      el.classList.add('jobNew');
      setTimeout(() => el.classList.remove('jobNew'), 450);
    }
    buildJobCard(el, job);
  }
  el._job = job;
  const st = job.state;
  if (st === 'running') el.classList.remove('gone');
  const band = bandOf(job);
  el.dataset.state = st;
  el.dataset.hk = band.hk;
  el.classList.toggle('stopping', !!(st === 'running' && job.stopping));
  const stEl = el.querySelector('.jobState');
  if (stEl.textContent !== band.state) stEl.textContent = band.state;
  stEl.title = band.stalled ? HEALTH_TITLE.stalled : '';
  const hEl = el.querySelector('.jobHealth');
  if (hEl.textContent !== band.health) hEl.textContent = band.health;
  hEl.className = `jobHealth ${band.hk}`;
  hEl.title = HEALTH_TITLE[job.health && job.health.state] || '';
  // the chip names the runtime, the mode (background dies with the turn;
  // detached survives even that) and the parser's phase word; hover = pid
  const chip = el.querySelector('.jobLang');
  const chipTxt = (JOB_LANG_TXT[job.lang] || job.lang || '')
    + (job.detached ? ' · detached' : job.bg ? ' · background' : '')
    + (job.phase && job.phase.name && st === 'running' ? ` · ${job.phase.name}` : '');
  const jl = chip.querySelector('.jlTxt');
  if (jl.textContent !== chipTxt) jl.textContent = chipTxt;
  chip.title = job.pid ? `pid ${job.pid} · click to copy` : (band.starting ? 'pid not pinned yet' : '');
  chip.classList.toggle('hasPid', !!job.pid);
  const fileEl = el.querySelector('.jobFile');
  const title = jobTitle(job);
  const fileTxt = job.displayTitle || job.inline ? title.name : job.command || job.file || '';
  if (fileEl.textContent !== fileTxt) fileEl.textContent = fileTxt;
  fileEl.title = title.tooltip;
  const stopBtn = el.querySelector('.jobStop');
  if (st === 'running' && job.stopping && !stopBtn.disabled) { stopBtn.disabled = true; stopBtn.textContent = 'stopping…'; }
  // ── progress line ──
  const pl = el.querySelector('.jpL'), pr = el.querySelector('.jpR');
  let lh, rh;
  if (band.starting) {
    lh = '<span class="jpDim">pid not pinned yet</span>';
    rh = '<span class="jpDim">first sample in ≤ 2 s</span>';
  } else if (st !== 'running') {
    const end = endSummaryHtml(job);
    lh = `<span class="jpEnd ${end.k}">${end.html}</span>`;
    rh = '';
  } else {
    lh = progLeftHtml(job, band);
    rh = progRightHtml(job, band, !lh.startsWith('<span class="jpDim">'));
  }
  if (pl._h !== lh) { pl._h = lh; pl.innerHTML = lh; }
  if (pr._h !== rh) { pr._h = rh; pr.innerHTML = rh; }
  // ── track: the parsed fraction, else the history ruler, else nothing ──
  const track = el.querySelector('.jobTrack');
  const fill = el.querySelector('.jobFill');
  const ruler = el.querySelector('.jobRuler');
  let frac = fracOf(job);
  if (st === 'done' && (frac != null || el._hadBar)) frac = 1;
  if (frac != null && st === 'running') el._hadBar = true;
  if (frac != null) {
    track.classList.remove('off');
    ruler.classList.add('off');
    const pct = Math.round(frac * 1000) / 10;
    const cur = parseFloat(fill.style.width) || 0;
    if (fresh || pct < cur - 8) {
      // no glide when there's nothing honest to glide FROM: a freshly (re)built
      // element starts at width 0, and a new phase/loop snaps back rather than
      // animating in reverse
      fill.style.transition = 'none';
      fill.style.width = `${pct}%`;
      void fill.offsetWidth; // commit the snap before re-enabling the glide
      fill.style.transition = '';
    } else {
      fill.style.width = `${pct}%`;
    }
    el._lastFrac = frac;
  } else if (st !== 'running' && el._hadBar) {
    // terminal: the bar freezes where it was, in the state colour
    track.classList.remove('off');
    ruler.classList.add('off');
  } else if (st === 'running' && job.history && num(job.history.typicalMs) > 0) {
    track.classList.add('off');
    ruler.classList.remove('off');
    const f = Math.min(1, (num(job.elapsedMs) || 0) / job.history.typicalMs);
    ruler.classList.toggle('over', (num(job.elapsedMs) || 0) > job.history.typicalMs);
    ruler.querySelector('.rNow').style.left = `${(f * 100).toFixed(1)}%`;
    ruler.title = `elapsed ${fmtJobDur(job.elapsedMs)} against the usual ≈${fmtDurShort(job.history.typicalMs)} (n=${job.history.n}) — a ruler from history, not a progress bar`;
  } else {
    track.classList.add('off');
    ruler.classList.add('off');
  }
  // ── the strip ──
  const stale = el.classList.contains('stale');
  const stats = el.querySelector('.jobStats');
  const sh = stripHtml(job, band, stale);
  if (stats._h !== sh) { stats._h = sh; stats.innerHTML = sh; }
  // ── expanded ──
  const wantX = jobExpanded.has(job.key);
  if (wantX !== el.classList.contains('expanded')) setExpanded(el, wantX);
  else if (wantX) el.querySelector('.jobX').innerHTML = expandedHtml(job, band);
  jobCardTick(el);
}

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

/* ── feed rows: the run ledger — what stays in the session feed after the
   card fades. One fixed-height row per run (docs/runfeed-mockups/: the
   vocabulary per runtime, the tally header, collapse and fold), rendered from
   runledger.js's pure models; a detached job still running keeps a live row. ── */

// the ledger's open state, keyed by turn id so a broadcast re-render never
// resets it (a container without a turn gets its own scope id)
const ledgerOpen = new Set();  // scope → the group is expanded ("show all")
const foldOpen = new Set();    // `${scope}|${foldKey}` → the fold shows its runs
let ledgerScopeSeq = 0;

/** @param {Element} container */
function ledgerScope(container) {
  const host = /** @type {any} */ (container);
  const seg = /** @type {HTMLElement | null} */ (container.closest('.cs-jobs'));
  const turn = (seg && seg.dataset.turnId) || /** @type {HTMLElement} */ (container).dataset.turnId;
  if (turn) return `turn:${turn}`;
  if (!host._lgScope) host._lgScope = `el:${++ledgerScopeSeq}`;
  return host._lgScope;
}

/** the essentials → html (`<b>` for the values, red/yellow where flagged) */
function essHtml(m) {
  return m.essentials.map((x) => `${x.label ? `<span class="jfLbl">${esc(x.label)}</span> ` : ''}<span class="${x.bad ? 'jpBad' : x.warn ? 'jpWarn' : 'jfV'}">${esc(x.value)}</span>`).join(' · ');
}

/**
 * A terminal row's inner html from its model. A fold head adds the ×n badge
 * and the glyph ladder (oldest → newest) before the last run's facts.
 * @param {JobInfo} job
 * @param {import('./runledger.js').RowModel} m
 * @param {{ fold?: { n: number, open: boolean, ladder: { state: string, glyph: string }[] } | null }} [o]
 */
function ledgerRowHtml(job, m, { fold = null } = {}) {
  const acts = job.source === 'run' ? '<span class="jfAct out" title="open the ▶ output tab">output</span>' : '';
  const badge = fold ? `<span class="jfN" title="${fold.n} runs of this file in sequence — click to ${fold.open ? 'fold' : 'open'}">×${fold.n} ${fold.open ? '▴' : '▾'}</span>` : '';
  const seq = fold ? `<span class="jfSeq" title="oldest → newest">${fold.ladder.map((l) => `<span class="${l.state}">${l.glyph}</span>`).join(' ')}</span>` : '';
  const aux = m.aux ? `<span class="jfAux"> · ${esc(m.aux)}</span>` : '';
  const el = m.errorLine;
  const err = el ? `<span class="jfErr" title="${esc([el.loc, el.msg].filter(Boolean).join(' · '))}">${el.loc ? `<b>${esc(el.loc)}</b> · ` : ''}${esc(el.msg)}</span>` : '';
  const title = [m.essText, m.aux].filter(Boolean).join(' · ');
  return `<span class="jfIco">${m.glyph}</span><span class="jfRt">${esc(m.runtimeLabel)}</span><span class="jfCmd" title="${esc(m.tooltip)}">${esc(m.file)}</span>${badge}`
    + `<span class="jfSum" title="${esc(title)}">${seq}<span class="jfEss">${essHtml(m)}</span>${aux}</span>`
    + `${m.timeText ? `<span class="jfTime">${esc(m.timeText)}</span>` : ''}${acts}${err}`;
}

/** the group header: `14 runs · 11 ✓ · 2 ✗ · 1 ⊘ · 4m12s` + show all ▾ / collapse ▴ */
function ledgerHeadHtml(g, open) {
  const cls = { n: 'lgN', span: 'lgSpan' };
  const parts = tallyParts(g.tally).map((p) => `<span class="${cls[p.k] || p.k}">${esc(p.text)}</span>`).join(' · ');
  const act = g.many ? `<button class="lgAct" type="button" title="${open ? 'fold the passing runs back into a count' : 'every run, in order'}">${open ? 'collapse ▴' : 'show all ▾'}</button>` : '';
  return parts + act;
}

/**
 * One feed row's inner HTML — a terminal run per the ledger vocabulary
 * (`✓ julia · fit_model.jl · 4m32s · ▲1.4G`, `✗ pytest · tests/ · 138 passed · 2 failed`,
 * `⊘ rsync · stopped by you at 61%`), or, for a detached job still running,
 * the live `▶ … · 86% · 8m40s · ≈2m left`.
 * @param {JobInfo} job
 * @returns {{ cls: string, html: string }}
 */
export function jobFeedRow(job) {
  const st = job.state;
  const live = st === 'running';
  if (!live) {
    const m = rowModel(job, jobTitle(job));
    return { cls: m.state, html: ledgerRowHtml(job, m) };
  }
  const rt = (JOB_LANG_TXT[job.lang] || job.lang || '') + (job.detached ? ' · detached' : job.bg ? ' · background' : '');
  const { name, tooltip } = jobTitle(job);
  const band = bandOf(job);
  const frac = fracOf(job);
  const eta = band.stalled ? null : etaOf(job);
  const sum = ['still running', frac != null ? `<b>${Math.round(frac * 100)}%</b>` : '', `<span class="jfEl">${fmtJobDur(job.elapsedMs)}</span>`,
    eta ? `<span class="est" title="estimate — ${esc(eta.src)}">≈${fmtDurShort(eta.s * 1000)} left</span>` : band.stalled ? `<span class="jpStall">stalled ${fmtDurShort(num(job.health.sinceMs) || 0)}</span>` : '']
    .filter(Boolean).join(' · ');
  const acts = [];
  if (job.source === 'run') acts.push('<span class="jfAct out" title="open the ▶ output tab">output</span>');
  acts.push('<button class="jfAct stop" title="terminate this process tree">⊘ stop</button>');
  const html = `<span class="jfIco">▶</span><span class="jfRt">${esc(rt)}</span><span class="jfCmd" title="${esc(tooltip)}">${esc(name)}</span>`
    + `<span class="jfSum" title="${esc(sum.replace(/<[^>]+>/g, ''))}">${sum}</span>${acts.join('')}`;
  return { cls: 'live', html };
}

/* the aux cell (`· 0 errors`, `· 212 lines`) is shown only when the row has
   room for it whole — measured after render, hidden as a unit, never clipped */
function fitAux(row) {
  const aux = /** @type {HTMLElement | null} */ (row.querySelector(':scope > .jfSum > .jfAux'));
  if (!aux) return;
  aux.hidden = false;
  const cs = getComputedStyle(row);
  const gap = parseFloat(cs.columnGap) || 0;
  const kids = [...row.children].filter((c) => !c.classList.contains('jfErr'));
  let need = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) + gap * Math.max(0, kids.length - 1);
  // natural widths: the file and the sum may already be squeezed, so read their content width, not their box
  for (const c of kids) need += c.classList.contains('jfCmd') ? Math.max(c.scrollWidth, 70) : c.classList.contains('jfSum') ? c.scrollWidth : c.getBoundingClientRect().width;
  if (need > row.getBoundingClientRect().width + 0.5) aux.hidden = true;
}
function fitAuxAll(container) {
  for (const row of container.querySelectorAll(':scope > .jobFeedRow')) fitAux(row);
}

/** the nearest scrolling ancestor (the console box) */
function scrollerOf(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/* Expand/collapse in place: console.js owns the scroll compensation
   (`expandInPlace(box, el, mutate)`: reader below → shifted by the delta,
   reader above → untouched, reader inside on a shrink → the block's top
   pinned). Outside a scroller (the ▶ slot) the mutation simply runs. */
function expandInPlace(box, el, mutate) {
  if (!box) { mutate(); return; }
  consoleMod.expandInPlace(box, el, mutate);
}

/** build the ledger's ordered items (header, rows, folds, count lines, live rows) */
function ledgerItems(container, jobs) {
  const scope = ledgerScope(container);
  const live = jobs.filter((j) => j.state === 'running');
  const done = jobs.filter((j) => j.state !== 'running');
  const open = ledgerOpen.has(scope);
  const folds = new Set([...foldOpen].filter((k) => k.startsWith(`${scope}|`)).map((k) => k.slice(scope.length + 1)));
  const g = done.length ? groupModel(done, { open, folds, title: jobTitle }) : null;
  /** @type {{ key: string, cls: string, html: string, job?: JobInfo | null, fold?: string | null, title?: string }[]} */
  const items = [];
  if (g && g.header) items.push({ key: 'head', cls: 'lgHead', html: ledgerHeadHtml(g, open) });
  if (g) {
    for (const r of g.rows) {
      if (r.type === 'more') {
        items.push({ key: r.key, cls: 'lgMore', html: esc(r.text), title: `${r.n} passing run${r.n === 1 ? '' : 's'} — click to show all` });
      } else if (r.type === 'row') {
        items.push({ key: r.key, cls: `jobFeedRow ${r.model.state}`, html: ledgerRowHtml(r.job, r.model), job: r.job });
      } else {
        // an open fold's head carries no job key: its runs are the records
        items.push({ key: r.key, cls: `jobFeedRow ${r.model.state} fold${r.open ? ' open' : ''}`, html: ledgerRowHtml(r.job, r.model, { fold: r }), job: r.open ? null : r.job, fold: r.foldKey });
        if (r.open) for (const c of r.runs) items.push({ key: c.key, cls: `jobFeedRow ${c.model.state} child`, html: ledgerRowHtml(c.job, c.model), job: c.job });
      }
    }
  }
  for (const j of live) {
    const { cls, html } = jobFeedRow(j);
    items.push({ key: `r:${j.key}`, cls: `jobFeedRow ${cls}`, html, job: j });
  }
  return { items, scope };
}

/** keyed reconcile: a row whose content is unchanged keeps its node (and its place) */
function renderLedger(container, jobs) {
  const { items } = ledgerItems(container, jobs);
  const old = new Map();
  for (const c of [...container.children]) {
    const k = /** @type {HTMLElement} */ (c).dataset.key;
    if (k && !old.has(k)) old.set(k, c); else c.remove();
  }
  const want = new Set(items.map((i) => i.key));
  for (const [k, c] of old) if (!want.has(k)) c.remove();
  let cursor = container.firstElementChild;
  for (const it of items) {
    let el = /** @type {any} */ (old.get(it.key));
    if (!el) { el = document.createElement('div'); el.dataset.key = it.key; }
    if (el.className !== it.cls) el.className = it.cls;
    if (el._h !== it.html) { el._h = it.html; el.innerHTML = it.html; }
    if (it.title) el.title = it.title;
    if (it.job) { el._job = it.job; el._jobKey = it.job.key; el.dataset.jobkey = it.job.key; }
    else { el._job = null; el._jobKey = null; delete el.dataset.jobkey; }
    if (it.fold) el.dataset.fold = it.fold; else delete el.dataset.fold;
    if (el !== cursor) container.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
  }
  fitAuxAll(container);
}

/**
 * Reconcile a container of feed rows against a job list: the turn's ledger
 * (header, folds, collapse) for the terminal runs, a live row per running
 * detached job. Keyed; a row's innerHTML is rebuilt only when its content changes.
 * @param {Element} container
 * @param {JobInfo[]} jobs
 * @returns {void}
 */
export function syncJobFeed(container, jobs) {
  const host = /** @type {any} */ (container);
  host._jfJobs = jobs;
  if (!host._jfWired) {
    host._jfWired = true;
    container.addEventListener('click', (e) => {
      const t = /** @type {Element} */ (e.target);
      const scope = ledgerScope(container);
      const rerender = () => renderLedger(container, host._jfJobs || []);
      if (t.closest('.lgAct') || t.closest('.lgMore')) {
        expandInPlace(scrollerOf(container), container, () => {
          if (ledgerOpen.has(scope)) ledgerOpen.delete(scope); else ledgerOpen.add(scope);
          rerender();
        });
        return;
      }
      const row = /** @type {any} */ (t.closest('.jobFeedRow'));
      if (!row) return;
      if (t.closest('.jfAct.stop')) { if (row._job) stopJob(row._job, /** @type {HTMLButtonElement} */ (t.closest('.jfAct.stop'))); return; }
      if (t.closest('.jfAct.out')) { if (row._job) { perOf(row._job.project).sessTab = 'run'; renderWB(row._job.project); } return; }
      if (row.classList.contains('fold')) {
        const k = `${scope}|${row.dataset.fold}`;
        expandInPlace(scrollerOf(container), container, () => {
          if (foldOpen.has(k)) foldOpen.delete(k); else foldOpen.add(k);
          rerender();
        });
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      host._jfRo = new ResizeObserver(() => fitAuxAll(container));
      host._jfRo.observe(container);
    }
  }
  renderLedger(container, jobs);
}

/* the ▶ output tab's card rides in a slot above the stream */
/**
 * The ▶ output tab's single job-card slot for the project's active run — the
 * live card while it runs, the end-summary feed row once it has faded.
 * @param {string} project
 * @returns {void}
 */
export function syncRunJobCard(project) {
  const slot = document.querySelector(`#v-${project} .runJobSlot`);
  if (!slot) return;
  const key = `run:${project}`;
  const job = jobsLive[key];
  if (job) {
    [...slot.children].forEach(el => { if (el.classList.contains('jobFeedRow')) el.remove(); });
    syncJobCards(slot, [job]);
  } else {
    [...slot.children].forEach(el => { if (el.classList.contains('jobCard')) el.remove(); });
    const ended = jobsEnded[key];
    syncJobFeed(slot, ended ? [ended] : []);
  }
}

/* a finished card fades out, then leaves the layout — its end summary stays
   in the feed as one line */
/**
 * Fade a finished job's card out (terminal state held ~6s first), then keep
 * the terminal snapshot for the feed row.
 * @param {string} key job key
 * @param {JobInfo} [expected] terminal invocation captured by its hold timer
 * @returns {void}
 */
export function fadeJobCard(key, expected = jobsLive[key]) {
  const j = jobsLive[key];
  if (!sameJobRun(j, expected) || j.state === 'running') return;
  document.querySelectorAll('.jobCard').forEach(el => {
    if (sameJobRun(el._job, expected)) el.classList.add('gone');
  });
  setTimeout(() => {
    const latest = jobsLive[key];
    if (!sameJobRun(latest, expected) || latest.state === 'running') return;
    delete jobsLive[key];
    jobEntered.delete(key); // the entrance may play again if the key returns
    jobExpanded.delete(key);
    if (latest.state !== 'running') {
      latest._endedAt = latest._endedAt || new Date().toISOString();
      jobsEnded[key] = latest;
      // keep the feed bounded: the 40 most recent ended jobs
      const keys = Object.keys(jobsEnded);
      if (keys.length > 40) delete jobsEnded[keys[0]];
    }
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
  document.querySelectorAll('.jobFeedRow.live .jfEl').forEach(s => {
    const row = s.closest('.jobFeedRow');
    const j = row && row._job;
    if (!j || j.state !== 'running') return;
    const t = fmtJobDur((num(j.elapsedMs) || 0) + (performance.now() - j._recvAt));
    if (s.textContent !== t) s.textContent = t;
  });
}, 1000);
