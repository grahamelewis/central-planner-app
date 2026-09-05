// views.js — full-page views + panels, split verbatim out of app.js
// (phase 2): overview bento, ⧉ Calendar page, category helpers/groups,
// Settings (services/updates/theme), About (heatmap/commits), Manage
// projects, Categories browser + editor, git panel.

import {
  enc, esc, OVS_LABEL, statusDot, SHOW_HOURS, hrs, fmtTok, fmtWhen, isoWeek,
  toast, confirmBox, fmtAgo,
} from './util.js';
import {
  state, ui, themePref, setTheme,
  projKeys, allProjKeys, tasksOf, taskProvider, agentName,
  providerState, providerModels, perOf, taskTabRecall,
  DEFAULT_MODEL, effortsFor, coerceEffort,
} from './store.js';
import { api, apiQuiet } from './net.js';
import { mountMemorySettings } from './memory.js';
import { claudeVerb } from './console.js';
import {
  deadlineMs, unfiledSeries, NU_DAYS, NU_MONS, gcalTemplateUrl, nuSafeUrl,
  nuHost,
} from './sidebar.js';
import { voiceSecHtml, voiceSecWire } from './voice.js';
// Phase 3 S2.1(b): the Settings Editor row (CONTRACT "Toggle & device gate")
// writes through monacoPane's sanctioned seams. NOTE this import closes the
// indirect ESM eval-order cycle views → monacoPane → workbench → views
// (monacoPane imports workbench's renderWB; workbench imports our catGroup).
// It is benign ONLY under the monacoPane header rule: every binding below is
// accessed strictly inside functions, never at module-eval time — pinned by
// the cold-page Settings smoke (ui.monaco-settings.test.mjs).
import { effectiveImpl, storedImpl, pinnedCoarse, setImpl, rebootMonaco } from './monacoPane.js';
// PERMANENT: routing, state adoption and the nav live with the entry module.
import { go, loadState, renderAll, renderNav, handleEvent } from './app.js';

/* ───────────────────────── overview ───────────────────────── */

/**
 * The overview bento (sessions · up-next · week ring · live deck · artifacts).
 * @returns {void}
 */
export function renderOverview() {
  const bento = document.getElementById('bento');
  if (!bento) return;
  const lw = state.ledger;

  // sessions cell — running/waiting tasks across projects
  const live = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => {
    if (!t.archived && (t.status === 'running' || t.status === 'waiting')) live.push({ k, t });
  }));
  const avCls = ['g', 'b', 'p', 'y'];
  const sessionsHtml = live.length ? live.map(({ k, t }, i) => {
    const wait = t.status === 'waiting';
    const per = lw?.perProject?.[k];
    const tok = per ? fmtTok((per.tokensIn || 0) + (per.tokensOut || 0)) : '0';
    const sub = wait
      ? esc(t.question ? 'asked: ' + t.question : 'turn finished — waiting for you')
      : `<span class="claudeVerb">${claudeVerb()}…</span> · turn ${t.session?.turns ?? 1}`;
    return `<div class="agentCard" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <div class="av ${wait ? 'y' : avCls[i % 4]}">${wait ? '?' : '⚙'}</div>
      <div><div class="nm">${esc(state.projects[k]?.name || k)} · ${esc(t.title)} <span class="providerTag ${taskProvider(t)}">${agentName(taskProvider(t))}</span></div>
      <div class="st">${sub}</div></div>
      <div class="tm ${wait ? 'y' : ''}">${wait ? '⏸ needs you' : '● running'}<small>${tok} tok this wk</small></div>
    </div>`;
  }).join('') : `<div class="sideNote" style="padding:16px 4px;">no active sessions — open a project and launch a queued task</div>`;

  // up next — queued + waiting + manual, waiting pinned
  const order = { waiting: 0, queued: 1, manual: 2 };
  const next = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => { if (!t.archived && t.status in order) next.push({ k, t }); }));
  next.sort((a, b) => (order[a.t.status] - order[b.t.status]));
  const nextHtml = next.slice(0, 9).map(({ k, t }) => {
    const wait = t.status === 'waiting';
    const pr = wait ? 'ask' : 'q';
    return `<div class="taskRow ${wait ? 'ask' : ''}" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <span class="pr ${pr}"></span>
      <span class="lbl">${wait ? '<b>Answer:</b> ' : ''}${esc(t.title)}</span>
      <span class="providerTag ${taskProvider(t)}">${agentName(taskProvider(t))}</span>
      <span class="ovs ${esc(t.oversight)}">${OVS_LABEL[t.oversight] || ''}</span>
      <span class="proj">${esc(state.projects[k]?.name || k)}</span></div>`;
  }).join('') || `<div class="sideNote" style="padding:14px 4px;">queue is empty — ＋ ADD TASK to create one</div>`;

  // week ring: outer = hours logged vs target, inner = how much of the week
  // has elapsed (the pace to compare against)
  const secs = lw?.totals?.seconds || 0;
  const tokens = lw?.totals?.tokens || 0;
  const hourTarget = lw?.hourTarget || 35;
  const weekFrac = lw?.since
    ? Math.min(1, (Date.now() - Date.parse(lw.since)) / (7 * 86400000)) : 0;
  const C1 = 2 * Math.PI * 42, C2 = 2 * Math.PI * 30;
  const o1 = C1 * (1 - Math.min(1, secs / 3600 / hourTarget));
  const o2 = C2 * (1 - weekFrac);
  const pct = Math.round(100 * Math.min(1, secs / 3600 / hourTarget));
  const wkPct = Math.round(weekFrac * 100);
  // with hours off, the ring shows week-elapsed and the figure shows agent tokens
  const ringMainOffset = SHOW_HOURS ? o1 : C1 * (1 - weekFrac);
  const ringInner = SHOW_HOURS
    ? `<circle class="bg" cx="50" cy="50" r="30" style="stroke-width:7"/>
       <circle class="fg2" cx="50" cy="50" r="30" style="stroke-width:7;stroke-dasharray:${C2.toFixed(1)};stroke-dashoffset:${o2.toFixed(1)}"/>`
    : '';
  const ringNumHtml = SHOW_HOURS
    ? `${hrs(secs)}h<small>of ${hourTarget}h · ${pct}%</small>`
    : `${fmtTok(tokens)}<small>agent tok · wk ${wkPct}%</small>`;
  const ringSplitHtml = SHOW_HOURS
    ? `<i style="background:var(--green)"></i>you — ${hrs(secs)}h logged<br>
       <i style="background:var(--purple)"></i>week — ${wkPct}% elapsed<br>
       <span style="color:var(--dim)">agents — ${fmtTok(tokens)} tok</span>`
    : `<i style="background:var(--green)"></i>week — ${wkPct}% elapsed<br>
       <span style="color:var(--dim)">agents — ${fmtTok(tokens)} tok</span>`;

  // weekly ledger table (the Σ you hours column is gated behind SHOW_HOURS)
  const lgRows = projKeys().map(k => {
    const e = lw?.perProject?.[k];
    if (!e) return '';
    const col = state.projects[k]?.color || '#888';
    return `<tr data-go="${esc(k)}" style="cursor:pointer;">
      <td class="pn"><i style="background:${esc(col)}"></i>${esc(state.projects[k]?.name || k)}</td>
      ${SHOW_HOURS ? `<td class="sumh">${hrs(e.seconds)}h</td>` : ''}
      <td class="sumt">${fmtTok((e.tokensIn || 0) + (e.tokensOut || 0))}</td></tr>`;
  }).join('');
  const ledgerHtml = lgRows
    ? `<table class="ledger">
        <tr><th>project</th>${SHOW_HOURS ? '<th>Σ you</th>' : ''}<th>Σ agent tok</th></tr>
        ${lgRows}
        <tr class="tot"><td class="pn">Σ week</td>
          ${SHOW_HOURS ? `<td class="sumh">${hrs(secs)}h</td>` : ''}
          <td class="sumt">${fmtTok(tokens)}</td></tr>
      </table>
      <div class="lgNote">${SHOW_HOURS
        ? `Hours <b>${hrs(secs)}h of ${hourTarget}h</b> weekly target · agents <b>${fmtTok(tokens)} tok</b> alongside.`
        : `Agents <b>${fmtTok(tokens)} tok</b> this week.`}</div>`
    : `<div class="sideNote" style="padding:14px 4px;">${SHOW_HOURS
        ? 'nothing logged this week yet — hours accrue while a project workbench is focused'
        : 'no agent activity logged this week yet'}</div>`;

  // live deck (first pdf watch)
  const pdfKey = Object.keys(state.pdf || {}).find(k => state.pdf[k]);
  const pe = pdfKey ? state.pdf[pdfKey] : null;
  const deckHtml = pe
    ? `<div class="pdfGlass" data-go="${esc(pdfKey)}" data-viewer="pdf">
        <div class="live"><i></i>${pe.state === 'building' ? 'BUILDING' : 'LIVE'}</div>
        <div style="font-size:17px;font-weight:600;">${esc(state.projects[pdfKey]?.name || pdfKey)}</div>
        <div>${esc(pe.tex || '')}</div>
        ${pe.pages ? `<div style="font-size:10px;color:#888;margin-top:6px;">— ${esc(pe.pages)} pages —</div>` : ''}
      </div>
      <div class="pdfFoot"><span>${esc(pe.tex || '')}</span>
        <span>${pe.state === 'building' ? '⟳ building…' : pe.state === 'error' ? '✗ build error' : `built${pe.lastBuildMs ? ' in ' + (pe.lastBuildMs / 1000).toFixed(1) + 's' : ''} ✓`}</span></div>`
    : `<div class="pdfGlass" style="cursor:default;color:#888;">
        <div style="font-size:13px;">no live deck</div>
        <div style="font-size:10.5px;margin-top:4px;">watch a .tex from a project's show panel →</div>
      </div><div class="pdfFoot"><span>latexmk · compile on save</span><span>idle</span></div>`;

  // recent tasks strip — every status, closed/archived included, newest activity first
  const recent = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => {
    recent.push({ k, t, ts: Date.parse(t.session?.lastTurnAt || t.created || '') || 0 });
  }));
  recent.sort((a, b) => b.ts - a.ts);
  const TSTAT = { running: ['●', 'run'], waiting: ['⏸', 'wait'], queued: ['◌', 'q'], manual: ['✎', 'man'], done: ['✓', 'done'] };
  const stripHtml = recent.slice(0, 16).map(({ k, t, ts }) => {
    const [ic, cls] = t.archived ? ['▣', 'arch'] : (TSTAT[t.status] || ['·', 'man']);
    return `<div class="thumb taskThumb" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <b>${esc(t.title)}</b>
      <span class="pj">${esc(state.projects[k]?.name || k)}${ts ? ' · ' + esc(fmtWhen(ts)) : ''}</span>
      <span class="tstat ${cls}">${ic} ${t.archived ? 'archived' : esc(t.status)}</span>
    </div>`;
  }).join('')
    || `<div class="sideNote" style="padding:10px 4px;">no tasks yet — ＋ ADD TASK to create one</div>`;

  bento.innerHTML = `
    <div class="cell c-sessions">
      <div class="ch">Agent sessions <span class="anno">click → workbench</span></div>
      <div class="cellScroll">${sessionsHtml}</div>
    </div>
    <div class="cell c-next">
      <div class="ch">Up next <span class="anno">needs-you pinned</span></div>
      ${nextHtml}
      <div class="taskFoot">tasks persist in <code>projectManager/tasks/&lt;project&gt;.json</code></div>
    </div>
    <div class="cell c-ring">
      <div class="ch">Week ${isoWeek(new Date())}</div>
      <div class="ringWrap">
        <svg class="ring" viewBox="0 0 100 100">
          <circle class="bg" cx="50" cy="50" r="42"/>
          <circle class="fg" cx="50" cy="50" r="42" style="stroke-dasharray:${C1.toFixed(1)};stroke-dashoffset:${ringMainOffset.toFixed(1)}"/>
          ${ringInner}
        </svg>
        <div class="ringNum">${ringNumHtml}</div>
      </div>
      <div class="ringSplit">${ringSplitHtml}</div>
    </div>
    <div class="cell c-ledger">
      <div class="ch">Weekly ledger <span class="anno">${SHOW_HOURS ? 'your hours + claude tokens' : 'claude tokens'}</span></div>
      ${ledgerHtml}
    </div>
    <div class="cell c-pdf">
      <div class="ch">Live deck <span class="anno">recompiles on .tex save</span></div>
      ${deckHtml}
    </div>
    <div class="cell c-gallery">
      <div class="ch">Recent tasks <span class="anno">closed + archived included, newest first · click → task</span></div>
      <div class="thumbStrip">${stripHtml}</div>
    </div>`;

  bento.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.go;
    if (el.dataset.tid) {
      perOf(k).taskId = el.dataset.tid;
      perOf(k).fileTab = taskTabRecall(k, el.dataset.tid); // renderWB re-validates
    }
    if (el.dataset.viewer) perOf(k).viewerKey = el.dataset.viewer;
    go(k);
  }));
}

/* ── the ⧉ Calendar page — deadlines · meetings · calendars ── */

const planSkip = new Set(); // "skip for now" — quiet until the next reload

// "2026-08-19" → "Aug 19, 2026" (friendly, tabular deadline date)
function planFmtDate(dstr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dstr || '');
  if (!m) return dstr || '';
  return `${NU_MONS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// meeting start → "Thu, Jul 23 · 2:00 PM" (12-hour); all-day drops the time
function planFmtWhen(startStr, withTime) {
  const ms = Date.parse(startStr);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const day = `${NU_DAYS[d.getDay()]}, ${NU_MONS[d.getMonth()]} ${d.getDate()}`;
  if (!withTime) return day;
  let h = d.getHours();
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${day} · ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

/**
 * The ⧉ Calendar page (sources / filing triage / deadlines).
 * @returns {void}
 */
export function renderPlan() {
  const host = document.getElementById('planFrame');
  if (!host) return;
  /** @type {PlanState} */
  const plan = state.plan || {};
  const cal = plan.cal || { sources: [], routes: {}, events: [] };
  const sources = cal.sources || [];
  const routes = cal.routes || {};

  // ── deadlines, grouped by project (first card) ──
  const dlGroups = projKeys().map((k) => {
    const ds = [...(plan.deadlines?.[k] || [])].sort((a, b) => a.date.localeCompare(b.date));
    if (!ds.length) return '';
    const color = state.projects[k]?.color || '#888';
    const pname = state.projects[k]?.name || k;
    const rows = ds.map((d) => {
      const u = nuSafeUrl(d.url);
      const past = deadlineMs(d) < Date.now();
      return `<li class="planDl${past ? ' past' : ''}">
        <span class="planDlDate">${esc(planFmtDate(d.date))}</span>
        <span class="planDlTitle">${esc(d.title)}</span>
        ${u
          ? `<a class="planDlLink" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">↗ ${esc(nuHost(u))}</a>`
          : '<span class="planDlLink"></span>'}
        <a class="planDlGcal" href="${esc(gcalTemplateUrl(d))}" target="_blank" rel="noopener" aria-label="Add ${esc(d.title)} to Google Calendar" title="add a copy to Google Calendar">⤴</a>
        <button class="px" data-dldel="${esc(k)}::${esc(d.id)}" aria-label="Remove deadline ${esc(d.title)}" title="remove">×</button>
      </li>`;
    }).join('');
    return `<div class="planDlGroup">
      <div class="planDlGroupHead"><span class="pd" style="background:${esc(color)}"></span>${esc(pname)}</div>
      <ul class="planDlList">${rows}</ul>
    </div>`;
  }).join('');

  // ── meetings: to file (middle card) ──
  const unfiled = unfiledSeries().filter((s) => !planSkip.has(s.uid));
  const toFileCards = unfiled.map((s) => {
    const srcName = sources.find((x) => x.id === s.src)?.name || s.src;
    return `<div class="planFileCard">
      <div class="planFileTop">
        <span class="planFileTitle">${esc(s.title)}</span>
        <span class="planFileWhen">${esc(planFmtWhen(s.start, !s.allDay))}</span>
      </div>
      <div class="planFileMeta">from ${esc(srcName)}</div>
      <div class="planFileTo">
        <span class="planFileLbl">File to</span>
        <select class="planFileSel" data-filesel="${esc(s.uid)}" aria-label="File ${esc(s.title)} to a project">
          <option value="" disabled selected>Choose a project…</option>
          ${projKeys().map((k) => `<option value="${esc(k)}">${esc(state.projects[k]?.name || k)}</option>`).join('')}
        </select>
        <span class="planFileSep">·</span>
        <button class="nuBtn" data-fileto="${esc(s.uid)}" data-to="personal">Personal</button>
        <button class="nuBtn" data-skip="${esc(s.uid)}">Skip</button>
      </div>
    </div>`;
  }).join('');
  const toFileEmpty = `<div class="planEmpty"><span class="planEmptyIc">✓</span> ${sources.length
    ? 'All caught up — every meeting is filed. New ones show up here.'
    : 'Connect a calendar below to start pulling in meetings.'}</div>`;

  // ── meetings: filed (dedup by uid) ──
  const seen = new Set();
  const filedRows = (cal.events || []).filter((ev) => {
    if (!routes[ev.uid] || seen.has(ev.uid)) return false;
    seen.add(ev.uid);
    return true;
  }).map((ev) => {
    const to = routes[ev.uid].to;
    const personal = to === 'personal';
    const name = personal ? 'Personal' : (state.projects[to]?.name || to);
    const color = personal ? '' : (state.projects[to]?.color || '#888');
    return `<li class="planFiled${personal ? ' personal' : ''}">
      <span class="planChip${personal ? ' muted' : ''}"><span class="pd"${personal ? '' : ` style="background:${esc(color)}"`}></span>${esc(name)}</span>
      <div class="planFiledMain">
        <span class="planFiledTitle">${esc(ev.title)}</span>
        <span class="planFiledMeta">${esc(planFmtWhen(ev.start, !ev.allDay))}</span>
      </div>
      <button class="px" data-unfile="${esc(ev.uid)}" aria-label="Unfile ${esc(ev.title)}" title="unfile — it returns to the list above">×</button>
    </li>`;
  }).join('');

  // ── calendars: sources (last card) ──
  const srcRows = sources.map((s) => {
    const n = s.count || 0;
    // fmtAgo gives 'now' (<1m), a relative unit like '5m'/'2h'/'3d', or an absolute
    // date ('Jul 15', >7d). Only the relative form takes "ago" — the others read wrong with it.
    const a = s.fetched ? fmtAgo(s.fetched) : '';
    const synced = !a ? '' : a === 'now' ? ' · synced just now' : /^\d/.test(a) ? ` · synced ${esc(a)} ago` : ` · synced ${esc(a)}`;
    return `<li class="planSrc">
      <span class="planSrcDot ${s.error ? 'err' : 'ok'}" aria-hidden="true"></span>
      <div class="planSrcMain">
        <span class="planSrcName">${esc(s.name)}</span>
        <span class="planSrcMeta">${n} event${n === 1 ? '' : 's'}${synced}${s.error ? ` · ${esc(s.error)}` : ''}</span>
      </div>
      <button class="px" data-rmsrc="${esc(s.id)}" aria-label="Disconnect ${esc(s.name)}" title="disconnect — filings are kept in case you reconnect">×</button>
    </li>`;
  }).join('');

  host.innerHTML = `<div class="planWrap">
    <div class="planHead">
      <h1 class="planTitle">Calendar</h1>
      <p class="planLede">Deadlines you type, plus read-only meetings pulled from Google Calendar.</p>
      <span class="planPrivacy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        Read-only &amp; private — nothing writes back to Google, and your secret link stays in a local file.
      </span>
    </div>

    <section class="planSec" aria-labelledby="planH-dl">
      <div class="planSecHead"><h2 id="planH-dl">Deadlines</h2></div>
      <p class="planSecSub">Each deadline shows in its project's <b>Next up</b> rail, counting down.</p>
      <div class="planAdd planDlAdd">
        <select id="pdProj" class="cmIn" aria-label="Project for the new deadline">
          ${projKeys().map((k) => `<option value="${esc(k)}">${esc(state.projects[k]?.name || k)}</option>`).join('')}
        </select>
        <input id="pdTitle" class="cmIn" placeholder="What's due?  e.g. AEA submission" aria-label="Deadline title" autocomplete="off">
        <input id="pdDate" type="date" class="cmIn" aria-label="Deadline date">
        <input id="pdLink" class="cmIn" type="text" placeholder="Link (optional)" aria-label="Deadline link" autocomplete="off" spellcheck="false">
        <button class="nuBtn pri" id="pdAdd">Add</button>
      </div>
      ${dlGroups || '<div class="planNote">No deadlines anywhere yet — add one above.</div>'}
    </section>

    <section class="planSec" aria-labelledby="planH-mt">
      <div class="planSecHead"><h2 id="planH-mt">Meetings</h2></div>
      <p class="planSecSub">Assign each meeting to a project so it appears in that project's <b>Next up</b> rail. Filing stays local — Google is never changed.</p>

      <div class="planSubhead"><h3>To file</h3>${unfiled.length ? `<span class="planPill amber">${unfiled.length} waiting</span>` : ''}</div>
      ${unfiled.length ? toFileCards : toFileEmpty}

      ${filedRows ? `<div class="planSubhead planSubheadFiled"><h3>Filed</h3><span class="planHint">Hover a row and press × to unfile and re-assign.</span></div>
      <ul class="planFiledList">${filedRows}</ul>` : ''}
    </section>

    <section class="planSec" aria-labelledby="planH-cal">
      <div class="planSecHead"><h2 id="planH-cal">Calendars</h2>${sources.length ? `<span class="planSecCount">${sources.length} connected</span>` : ''}</div>
      ${srcRows
        ? `<ul class="planSrcList">${srcRows}</ul>`
        : '<div class="planNote">No calendar connected — in Google Calendar: Settings → your calendar → “Secret address in iCal format”, then paste it below.</div>'}
      <div class="planAdd planCalAdd">
        <div class="planField">
          <label class="planFieldLabel" for="psName">Name</label>
          <input id="psName" class="cmIn" placeholder="Work, Personal…" autocomplete="off">
        </div>
        <div class="planField">
          <label class="planFieldLabel" for="psUrl">Secret iCal address</label>
          <input id="psUrl" class="cmIn" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false">
        </div>
        <button class="nuBtn pri" id="psConnect">Connect</button>
      </div>
      <div class="planOpts">
        <label class="planSwitch"><input type="checkbox" id="psAllDay" ${cal.includeAllDay ? 'checked' : ''}><span class="planSwitchTrack"></span> Include all-day events</label>
        ${sources.length ? '<button class="nuBtn" id="psRefresh" title="fetches every 15 min on its own">↻ Refresh now</button>' : ''}
      </div>
    </section>
  </div>`;

  // one delegated handler for the whole page; every mutation re-pulls state
  // so the page is right immediately (the ws broadcast is the belt)
  const apply = async (fn) => { await fn(); await loadState(); renderPlan(); };
  host.onclick = async (e) => {
    const fileto = e.target.closest('[data-fileto]');
    if (fileto) { await apply(() => api('POST', '/api/plan/cal/route', { uid: fileto.dataset.fileto, to: fileto.dataset.to })); return; }
    const skip = e.target.closest('[data-skip]');
    if (skip) { planSkip.add(skip.dataset.skip); renderPlan(); return; }
    const unfile = e.target.closest('[data-unfile]');
    if (unfile) { await apply(() => api('DELETE', `/api/plan/cal/route?uid=${enc(unfile.dataset.unfile)}`)); return; }
    const rmsrc = e.target.closest('[data-rmsrc]');
    if (rmsrc) { await apply(() => api('DELETE', `/api/plan/cal/sources/${enc(rmsrc.dataset.rmsrc)}`)); return; }
    const dldel = e.target.closest('[data-dldel]');
    if (dldel) {
      const [k, id] = dldel.dataset.dldel.split('::');
      await apply(() => api('DELETE', `/api/plan/${enc(k)}/deadlines/${enc(id)}`));
      return;
    }
    if (e.target.closest('#pdAdd')) {
      const proj = host.querySelector('#pdProj')?.value;
      const title = host.querySelector('#pdTitle')?.value?.trim();
      const date = host.querySelector('#pdDate')?.value;
      if (!title) { toast('give the deadline a name'); return; }
      if (!date) { toast('pick a date'); return; }
      await apply(() => api('POST', `/api/plan/${enc(proj)}/deadlines`, {
        title,
        date,
        url: host.querySelector('#pdLink')?.value?.trim() || '',
      }));
      return;
    }
    if (e.target.closest('#psConnect')) {
      const url = host.querySelector('#psUrl')?.value?.trim();
      if (!url) { toast('paste the secret .ics URL first'); return; }
      const r = await api('POST', '/api/plan/cal/sources', {
        icsUrl: url, name: host.querySelector('#psName')?.value?.trim() || '',
      });
      if (r && r.id) toast('connected — fetching events now');
      await loadState(); renderPlan();
      return;
    }
    if (e.target.closest('#psRefresh')) {
      toast('refreshing…');
      await apply(() => api('POST', '/api/plan/cal/refresh'));
      return;
    }
  };
  // filing is now a select (change, not click) — delegated so it survives
  // re-renders without stacking listeners; the all-day toggle rides along
  host.onchange = async (e) => {
    const fs = e.target.closest('[data-filesel]');
    if (fs) {
      const to = e.target.value;
      if (!to) return; // still on the "Choose a project…" placeholder
      await apply(() => api('POST', '/api/plan/cal/route', { uid: fs.dataset.filesel, to }));
      return;
    }
    if (e.target.id === 'psAllDay') {
      await api('PATCH', '/api/plan/cal', { includeAllDay: e.target.checked });
      await loadState(); renderPlan();
    }
  };
}

/* ───────────────────────── categories ───────────────────────── */

/* the group ("partition") a category belongs to — lineage chains live within it */
/**
 * @param {string} k category key
 * @returns {string} the category's group label
 */
export function catGroup(k) {
  const c = (state.categories || {})[k];
  return (c && typeof c === 'object' && c.group) || 'Other';
}

/* group categories by their `group` field, preserving categories.json order */
/**
 * @returns {Array<[string, Array<[string, any]>]>} [group, [categoryKey, category][]]
 *   pairs in first-seen order
 */
export function catGroups() {
  const order = [];
  const byGroup = new Map();
  for (const [k, raw] of Object.entries(state.categories || {})) {
    const c = (typeof raw === 'string') ? { primer: raw } : (raw || {});
    const g = c.group || 'Other';
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push([k, c]);
  }
  return order.map(g => [g, byGroup.get(g)]);
}

/* designation accent colors: [text, chip background] */
const GROUP_COLOR = {
  'Structural': ['var(--purple)', 'var(--des-structural)'],
  'Empirics': ['var(--blue)', 'var(--blue-d)'],
  'Literature': ['var(--yellow)', 'var(--des-literature)'],
  'Final Goods': ['var(--green)', 'var(--des-final)'],
};
/** @type {(g: string) => string[]} group label → [color, dim-color] CSS tokens */
export const groupColor = (g) => GROUP_COLOR[g] || ['var(--blue)', 'var(--blue-d)'];

/* ───────────────────────── settings (profile menu) ───────────────────────── */

/* the Updates card in Settings — status + incoming commits + the button */
function updateSecHtml() {
  /** @type {UpdateStatus} */
  const u = state.update || {};
  const agoTxt = (iso) => {
    if (!iso) return 'never';
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)}h ago`;
  };
  const ver = u.head ? `${esc(u.branch || '')} @ ${esc(u.head)}` : '';
  let line;
  switch (u.state) {
    case 'behind': {
      const n = u.behind || 0;
      line = `<b class="updBehind">⬆ ${n} update${n === 1 ? '' : 's'} available</b> from ${esc(u.upstream || 'origin')}`;
      break;
    }
    case 'ok':
      line = `✓ up to date${u.ahead ? ` (${u.ahead} local commit${u.ahead === 1 ? '' : 's'} ahead)` : ''} · checked ${agoTxt(u.lastChecked)}`;
      break;
    case 'checking': line = '⟳ checking…'; break;
    case 'updating': line = '⟳ updating…'; break;
    case 'unavailable': line = esc(u.error || 'updates unmanaged here'); break;
    case 'error': line = `✗ ${esc(u.error || 'update check failed')}`; break;
    default: line = 'not checked yet';
  }
  const busy = u.state === 'checking' || u.state === 'updating';
  const buttons = `
    ${u.state === 'behind' || u.state === 'updating'
    ? `<button class="gbtn go" id="updGo" ${busy ? 'disabled' : ''}>${u.state === 'updating' ? '⟳ updating…' : '⬆ Update now'}</button>` : ''}
    <button class="gbtn" id="updCheck" ${busy ? 'disabled' : ''}>${u.state === 'checking' ? 'checking…' : 'Check now'}</button>`;
  const commits = (u.state === 'behind' && Array.isArray(u.commits) && u.commits.length)
    ? `<div class="updList">${u.commits.map(c =>
      `<div class="updCommit"><span class="sha">${esc(c.sha)}</span> ${esc(c.subject)}</div>`).join('')}
      ${u.behind > u.commits.length ? `<div class="updCommit more">… and ${u.behind - u.commits.length} more</div>` : ''}</div>`
    : '';
  const warn = (u.state === 'behind' && u.dirty)
    ? '<div class="updNote warn">⚠ local changes present — the update will refuse until they are committed or stashed</div>'
    : (u.state === 'behind' && u.ahead)
      ? `<div class="updNote warn">⚠ ${u.ahead} local commit${u.ahead === 1 ? '' : 's'} diverge from the remote — resolve manually</div>`
      : '';
  const done = u.updated
    ? `<div class="updNote ok">✓ updated ${esc(u.updated.from || '')} → ${esc(u.updated.to || '')}${u.updated.npmInstalled ? ' · dependencies installed' : ''}${u.updated.npmError ? ` · ⚠ npm install failed (${esc(u.updated.npmError)})` : ''} — <b>restart the server</b> (and hard-refresh the browser) to finish</div>`
    : '';
  return `
    <div class="setSec" id="updSec">
      <h3>Updates</h3>
      <div class="setRow">
        <div class="setLbl">Dashboard${ver ? `<small>${ver}</small>` : ''}</div>
        <div class="updCtl">${buttons}</div>
      </div>
      <div class="updStatus">${line}</div>
      ${warn}${commits}${done}
    </div>`;
}

function serviceStateText(provider) {
  const p = providerState(provider);
  if (p.checking) return ['checking', 'checking…'];
  if (p.connected) {
    const detail = provider === 'codex'
      ? (p.account?.email || p.account?.planType || 'ChatGPT account')
      : ((p.auth || state.auth)?.email || ((p.auth || state.auth)?.method === 'apikey' ? 'API key' : 'signed in'));
    return ['connected', detail];
  }
  if (p.available === false) return ['missing', provider === 'codex' ? 'CLI not installed' : 'CLI not found'];
  return ['disconnected', p.error || p.loginError || 'not connected'];
}

function servicesSecHtml() {
  const defs = state.agentDefaults || { provider: 'claude', model: DEFAULT_MODEL, reasoningEffort: 'high' };
  const providerOptions = ['claude', 'codex'];
  const selectedModels = providerModels(defs.provider);
  const bothDisconnected = providerOptions.every(p => !providerState(p).connected);
  const cards = providerOptions.map((provider) => {
    const p = providerState(provider);
    const [status, detail] = serviceStateText(provider);
    const count = providerModels(provider).length;
    const actions = provider === 'claude'
      ? `<button class="gbtn" id="svcClaudeCheck">Refresh</button>${p.connected || (p.auth || state.auth)?.method === 'apikey' ? '' : '<button class="gbtn go" id="svcClaudeConnect">Sign in</button>'}`
      : `<button class="gbtn" id="svcCodexCheck">Refresh</button>${p.connected
        ? '<button class="gbtn danger" id="svcCodexDisconnect">Disconnect</button>'
        : p.available === false ? '' : '<button class="gbtn go" id="svcCodexConnect">Connect</button>'}`;
    return `<div class="serviceCard ${provider}">
      <div class="serviceMark">${provider === 'codex' ? '⌘' : '✦'}</div>
      <div class="serviceBody"><div class="serviceTitle">${agentName(provider)} <span class="serviceStatus ${status}"><i></i>${esc(status)}</span></div>
        <div class="serviceDetail">${esc(detail)} · ${count || 'no'} model${count === 1 ? '' : 's'} ${count ? 'available' : 'loaded'}</div></div>
      <div class="serviceActions">${actions}</div>
    </div>`;
  }).join('');
  const modelOptions = selectedModels.length
    ? selectedModels.map(m => `<option value="${esc(m.id)}" ${defs.model === m.id ? 'selected' : ''}>${esc(m.label || m.id)}</option>`).join('')
    : `<option value="" selected>${defs.provider === 'codex' ? 'Codex default' : 'No models loaded'}</option>`;
  return `<div class="setSec serviceSec">
    <h3>AI services</h3>
    <div class="serviceGrid">${cards}</div>
    ${bothDisconnected ? '<div class="serviceNotice">No AI service is connected. Manual tasks still work; connect Claude or Codex before launching an agent task.</div>' : ''}
    <div class="setRow defaultAgentRow">
      <div class="setLbl">New task default<small>Existing tasks keep their provider and model. Switching a task later always crosses an explicit new-thread boundary.</small></div>
      <div class="agentDefaultCtl">
        <select id="defaultProvider" aria-label="Default AI service">${providerOptions.map(p => `<option value="${p}" ${defs.provider === p ? 'selected' : ''}>${agentName(p)}</option>`).join('')}</select>
        <select id="defaultModel" aria-label="Default model">${modelOptions}</select>
        <select id="defaultEffort" aria-label="Default reasoning effort">${effortsFor(defs.provider).map(r => `<option value="${r.id}" ${defs.reasoningEffort === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
      </div>
    </div>
  </div>`;
}

/**
 * The Settings view (theme · agent defaults · providers · voice · updates).
 * @returns {void}
 */
export function renderSettings() {
  const host = document.getElementById('settingsFrame');
  if (!host) return;
  const cur = themePref();
  const opts = [
    ['system', '◐ System', 'follows the macOS appearance'],
    ['dark', '● Dark', 'the classic night dashboard'],
    ['light', '○ Light', 'paper mode for bright rooms'],
  ];
  // Phase 3 S2.1(b) — the Editor row reflects REALITY (CONTRACT "Toggle &
  // device gate"): effectiveImpl is what a code tab renders right now — the
  // A15 pin (I9) and the session boot-fallback both override a stored
  // 'monaco', so selection follows the effective impl, and the note says why
  // when it diverges from the raw preference. (All monacoPane access is
  // function-scope — see the import note above.)
  const edImpl = effectiveImpl();
  const edPinned = pinnedCoarse();
  const edForced = !edPinned && edImpl === 'legacy' && storedImpl() === 'monaco';
  const edNote = edPinned
    ? 'this device is pinned to the legacy editor — touch-first hardware, automatic, not a preference'
    : edForced
      ? 'Monaco could not boot — using the legacy editor for this session (your saved preference is unchanged)'
      : edImpl === 'monaco'
        ? 'Monaco (beta) — per-browser, like the theme'
        : 'the classic editor — Monaco (beta) is opt-in, per-browser like the theme';
  host.innerHTML = `
    <h1>Settings</h1>
    ${servicesSecHtml()}
    <div class="setSec" id="memorySettings"><h3>Task memory</h3><p>Loading memory settings…</p></div>
    <div class="setSec">
      <h3>Appearance</h3>
      <div class="setRow">
        <div class="setLbl">Theme<small>${esc(opts.find(o => o[0] === cur)?.[2] || '')}</small></div>
        <div class="segCtl" id="themeSeg">
          ${opts.map(([v, label]) =>
    `<div class="segOpt ${cur === v ? 'on' : ''}" data-th="${esc(v)}">${esc(label)}</div>`).join('')}
        </div>
      </div>
      <div class="setRow">
        <div class="setLbl">Editor<small>${esc(edNote)}</small></div>
        <div class="segCtl" id="editorSeg">
          <div class="segOpt ${edImpl === 'legacy' ? 'on' : ''}" data-ed="legacy">✎ Legacy</div>
          <div class="segOpt ${edImpl === 'monaco' ? 'on' : ''}${edPinned ? ' locked' : ''}" data-ed="monaco">▤ Monaco (beta)</div>
        </div>
        ${edForced ? '<button class="gbtn" id="edImplRetry">↻ Try Monaco again</button>' : ''}
      </div>
    </div>
    ${voiceSecHtml()}
    ${updateSecHtml()}`;
  host.querySelectorAll('[data-th]').forEach(el =>
    el.addEventListener('click', () => setTheme(el.dataset.th)));
  // Phase 3 S2.1(b): the toggle writes ONLY through setImpl, the sanctioned
  // writer (CONTRACT "Toggle & device gate": flipping to legacy runs the
  // synchronous M7-T7 flush BEFORE the preference changes hands, so the
  // legacy renderers that follow read just-re-asserted drafts). The A15 pin
  // is not a preference — a locked option is inert (I9).
  host.querySelectorAll('#editorSeg [data-ed]').forEach(el =>
    el.addEventListener('click', () => {
      if (el.classList.contains('locked')) return;
      setImpl(el.dataset.ed === 'monaco' ? 'monaco' : 'legacy');
      renderSettings();
    }));
  // boot-fallback recovery: rebootMonaco is the "try again" affordance
  // (CONTRACT "Toggle & device gate") — it clears the session-only
  // forcedLegacy pin and re-arms a fresh boot generation; the next code-tab
  // render boots a brand-new machine. The preference itself never moved.
  host.querySelector('#edImplRetry')?.addEventListener('click', () => {
    rebootMonaco();
    renderSettings();
  });
  const saveDefaults = async (patch) => {
    const r = await api('PATCH', '/api/providers/defaults', patch);
    if (r) { state.agentDefaults = r; renderSettings(); toast('new-task agent default saved'); }
  };
  host.querySelector('#defaultProvider')?.addEventListener('change', (e) => {
    const provider = e.target.value;
    const models = providerModels(provider);
    saveDefaults({
      provider,
      model: models.find(m => m.isDefault)?.id || models[0]?.id || null,
      reasoningEffort: coerceEffort(provider, state.agentDefaults?.reasoningEffort),
    });
  });
  host.querySelector('#defaultModel')?.addEventListener('change', (e) => saveDefaults({ model: e.target.value || null }));
  host.querySelector('#defaultEffort')?.addEventListener('change', (e) => saveDefaults({ reasoningEffort: e.target.value }));
  host.querySelector('#svcClaudeCheck')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/auth/check');
    if (r) { state.auth = r; handleEvent('auth:status', r); renderSettings(); }
  });
  host.querySelector('#svcClaudeConnect')?.addEventListener('click', () => api('POST', '/api/auth/login'));
  host.querySelector('#svcCodexCheck')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/providers/codex/check');
    if (r) { state.providers.codex = { id: 'codex', name: 'Codex', ...r }; renderSettings(); }
  });
  host.querySelector('#svcCodexConnect')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/providers/codex/login');
    if (r?.authUrl) window.open(r.authUrl, '_blank', 'noopener');
  });
  host.querySelector('#svcCodexDisconnect')?.addEventListener('click', async () => {
    const yes = await confirmBox('Disconnect <b>Codex</b> from this dashboard?<br><small>Existing transcripts and task threads stay recorded, but Codex turns cannot run until you connect again.</small>', 'Disconnect');
    if (!yes) return;
    const r = await api('POST', '/api/providers/codex/logout');
    if (r) { state.providers.codex = { id: 'codex', name: 'Codex', ...r }; renderSettings(); }
  });
  mountMemorySettings(host);
  voiceSecWire(host);
  // update actions — the server broadcasts update:status transitions
  // (checking/updating/result), which re-render this view live
  host.querySelector('#updCheck')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/update/check');
    if (r) { state.update = r; renderNav(); if (ui.view === 'settings') renderSettings(); }
  });
  host.querySelector('#updGo')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/update'); // errors toast (dirty/diverged/…)
    if (r && r.ok && !r.alreadyUpToDate) {
      toast(`updated to ${r.to} — restart the server to finish`);
    }
  });
}

/* ───────────────────────── about you (profile menu) ───────────────────────── */

/** @type {{ profile: any, activity: any, commits: any, loading: boolean, generating: boolean }}
    About-view data bundle — app.js's ledger:update case invalidates activity. */
export const aboutCache = { profile: null, activity: null, commits: null, loading: false, generating: false };
const COMMITS_PREVIEW = 8; // shown initially; "show more" reveals in steps
let commitsShown = COMMITS_PREVIEW;

/**
 * Fetch the About-view data bundle (profile, activity, commits) once.
 * @param {boolean} [force] refetch even when cached
 * @returns {Promise<void>}
 */
export async function ensureAboutData(force) {
  if (aboutCache.loading) return;
  if (!force && aboutCache.profile && aboutCache.activity && aboutCache.commits) return;
  aboutCache.loading = true;
  try {
    const [profile, activity, commits] = await Promise.all([
      apiQuiet('GET', '/api/profile'),
      apiQuiet('GET', '/api/activity'),
      apiQuiet('GET', '/api/commits'),
    ]);
    if (profile) aboutCache.profile = profile;
    if (activity) aboutCache.activity = activity;
    if (commits) aboutCache.commits = commits.commits || [];
  } finally {
    aboutCache.loading = false;
  }
  if (ui.view === 'about') renderAbout();
}

const dayKeyOf = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* GitHub-style activity heatmap: 53 Monday-start week columns ending today.
   Green ramp = your logged hours; purple = days only Claude worked. */
function heatmapHtml(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // this week's Monday
  start.setDate(start.getDate() - 52 * 7);                     // 52 weeks earlier

  const level = (d) => {
    if (!d || (!d.seconds && !d.tokens)) return 'l0';
    if (!d.seconds) return 'lC'; // Claude worked, you didn't log time
    const h = d.seconds / 3600;
    return h < 1 ? 'l1' : h < 2.5 ? 'l2' : h < 5 ? 'l3' : 'l4';
  };
  const tip = (date, d) => {
    const base = `${DOWS[(date.getDay() + 6) % 7]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    if (!d || (!d.seconds && !d.tokens)) return `${base} — no activity`;
    const bits = [];
    if (d.seconds) bits.push(`${(d.seconds / 3600).toFixed(1)}h you`);
    if (d.tokens) bits.push(`${fmtTok(d.tokens)} tok`);
    if (d.costUsd) bits.push(`$${d.costUsd.toFixed(2)}`);
    const per = Object.entries(d.perProject || {}).sort((a, b) => b[1] - a[1])
      .map(([k, s]) => `${state.projects[k]?.name || k} ${(s / 3600).toFixed(1)}h`).join(', ');
    return `${base} — ${bits.join(' · ')}${per ? ` (${per})` : ''}`;
  };

  let monthCells = '';
  let gridCells = '';
  const stats = { seconds: 0, tokens: 0, costUsd: 0, active: 0, streak: 0, bestStreak: 0 };
  for (let w = 0; w < 53; w++) {
    const weekStartD = new Date(start);
    weekStartD.setDate(start.getDate() + w * 7);
    // label the column when the month changes within its first week
    monthCells += `<span class="hmMonth">${weekStartD.getDate() <= 7 ? MONTHS[weekStartD.getMonth()] : ''}</span>`;
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(weekStartD);
      date.setDate(weekStartD.getDate() + dow);
      if (date > today) { gridCells += '<span class="hmCell future"></span>'; continue; }
      const d = days[dayKeyOf(date)];
      gridCells += `<span class="hmCell ${level(d)}" title="${esc(tip(date, d))}"></span>`;
      if (d) {
        stats.seconds += d.seconds || 0;
        stats.tokens += d.tokens || 0;
        stats.costUsd += d.costUsd || 0;
        if (d.seconds || d.tokens) {
          stats.active++;
          stats.streak++;
          stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
        } else stats.streak = 0;
      } else stats.streak = 0;
    }
  }
  return `
    <div class="hmWrap">
      <div class="hmMonths">${monthCells}</div>
      <div class="hmBody">
        <div class="hmDows"><span>Mon</span><span>Wed</span><span>Fri</span></div>
        <div class="hmGrid">${gridCells}</div>
      </div>
      <div class="hmFoot">
        <span class="hmStat"><b>${hrs(stats.seconds)}h</b> logged</span>
        <span class="hmStat"><b>${stats.active}</b> active day${stats.active === 1 ? '' : 's'}</span>
        <span class="hmStat"><b>${stats.bestStreak}</b> day best streak</span>
        <span class="hmStat"><b class="p">${fmtTok(stats.tokens)}</b> tok · <b class="p">$${stats.costUsd.toFixed(0)}</b></span>
        <span class="hmLegend">less <span class="hmCell l0"></span><span class="hmCell l1"></span><span class="hmCell l2"></span><span class="hmCell l3"></span><span class="hmCell l4"></span> more · <span class="hmCell lC"></span> Claude only</span>
      </div>
    </div>`;
}

function commitsHtml(commits) {
  if (!commits) return '<div class="sideNote">loading commits…</div>';
  if (!commits.length) return '<div class="sideNote">no commits found in the project repos</div>';
  const hidden = commits.length - commitsShown;
  const shown = hidden > 0 ? commits.slice(0, commitsShown) : commits;
  const byDay = new Map();
  shown.forEach(c => {
    const d = new Date(c.ts);
    const k = dayKeyOf(d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  });
  return [...byDay.entries()].map(([k, list]) => {
    const d = new Date(list[0].ts);
    return `<div class="cmDay">${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}</div>`
      + list.map(c => `<div class="cmRow" title="${esc(c.author || '')} · ${esc(c.hash || '')}">
          <span class="pdot" style="background:${esc(state.projects[c.project]?.color || '#888')}"></span>
          <span class="cmProj">${esc(state.projects[c.project]?.name || c.project)}</span>
          <span class="cmMsg">${esc(c.subject || '')}</span>
          <span class="cmHash">${esc(c.short || '')}</span>
        </div>`).join('');
  }).join('')
    + (hidden > 0 ? `<div class="cmMore" id="cmMore">▾ show ${Math.min(hidden, 20)} more <span>(${hidden} hidden)</span></div>` : '')
    + (hidden <= 0 && commits.length > COMMITS_PREVIEW ? `<div class="cmMore" id="cmLess">▴ collapse</div>` : '');
}

/**
 * The About You view.
 * @returns {void}
 */
export function renderAbout() {
  const host = document.getElementById('aboutFrame');
  if (!host) return;
  ensureAboutData();
  const p = aboutCache.profile;
  const act = aboutCache.activity;
  const bio = p?.bio;
  const interests = p?.interests || [];
  host.innerHTML = `
    <div class="aboutHead">
      <div class="avatar">g</div>
      <div class="aboutId">
        <h1>${esc(p?.name || state.user?.name || 'Researcher')}</h1>
        ${bio
      ? `<div class="aboutBio">${esc(bio)}</div>`
      : `<div class="aboutBio dim">${aboutCache.generating
        ? 'Claude is reading your projects and writing your profile…'
        : p ? 'No profile yet — Claude writes this from your abstracts, tasks and activity.' : 'loading…'}</div>`}
        ${interests.length ? `<div class="aboutInts">${interests.map(i => `<span class="intChip">${esc(i)}</span>`).join('')}</div>` : ''}
        <div class="aboutMeta">
          ${p?.generatedAt ? `<span>written by Claude · ${esc(new Date(p.generatedAt).toLocaleDateString())}</span>` : ''}
          <span id="profileGen" class="${aboutCache.generating ? 'busy' : ''}">${aboutCache.generating ? '⟳ writing…' : '↻ let Claude rewrite it'}</span>
        </div>
      </div>
    </div>
    <div class="aboutSec"><h3>▦ Activity <span class="anno">past 12 months — green is your time, purple is Claude working solo</span></h3>
      ${act ? heatmapHtml(act.days || {}) : '<div class="sideNote">loading activity…</div>'}
    </div>
    <div class="aboutSec"><h3>⎇ Recent commits <span class="anno">across all project repos</span></h3>
      <div class="cmFeed">${commitsHtml(aboutCache.commits)}</div>
    </div>`;

  host.querySelector('#cmMore')?.addEventListener('click', () => {
    commitsShown += 20;
    renderAbout();
  });
  host.querySelector('#cmLess')?.addEventListener('click', () => {
    commitsShown = COMMITS_PREVIEW;
    renderAbout();
  });
  host.querySelector('#profileGen')?.addEventListener('click', async () => {
    if (aboutCache.generating) return;
    aboutCache.generating = true;
    renderAbout();
    const r = await api('POST', '/api/profile/generate');
    aboutCache.generating = false;
    if (r && !r.error) {
      aboutCache.profile = r;
      toast('profile rewritten by Claude ✓');
    }
    renderAbout();
  });
}

/* ───────────────────────── manage projects (profile menu) ───────────────────────── */

/* undirected components over upstream links — a task's "chain" is everything
   reachable through lineage; size 1 = unchained */
function chainSizes(ts) {
  const present = new Set(ts.map(t => t.id));
  const parent = new Map(ts.map(t => [t.id, t.id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  ts.forEach(t => (Array.isArray(t.upstream) ? t.upstream : []).forEach(u => {
    if (!present.has(u)) return; // dangling lineage link
    const ra = find(t.id), rb = find(u);
    if (ra !== rb) parent.set(ra, rb);
  }));
  const size = new Map();
  ts.forEach(t => { const r = find(t.id); size.set(r, (size.get(r) || 0) + 1); });
  return { sizeOf: (id) => size.get(find(id)) || 1, rootOf: (id) => find(id) };
}

/**
 * The Manage Projects view.
 * @returns {void}
 */
export function renderManage() {
  const host = document.getElementById('manageFrame');
  if (!host) return;
  const catOrder = Object.keys(state.categories || {});
  const sections = allProjKeys().map(k => {  // Manage shows inactive projects too
    const proj = state.projects[k] || {};
    const ts = tasksOf(k); // full history — archived included, marked ▣
    const chains = chainSizes(ts);
    const byCat = new Map();
    ts.forEach(t => {
      const c = t.category || 'uncategorized';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(t);
    });
    const cats = [...byCat.keys()].sort((a, b) => {
      const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      return ((ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)) || a.localeCompare(b);
    });
    const catRows = cats.map(c => {
      const list = byCat.get(c);
      const done = list.filter(t => t.status === 'done').length;
      const ck = `${k}::${c}`;
      const open = ui.manageOpen.has(ck);
      // chains first (longest chain up top, members grouped), then unchained;
      // ties fall back to creation order
      const sorted = list.slice().sort((a, b) => {
        const sa = chains.sizeOf(a.id), sb = chains.sizeOf(b.id);
        const ga = sa > 1 ? 0 : 1, gb = sb > 1 ? 0 : 1;
        if (ga !== gb) return ga - gb;
        if (ga === 0) {
          if (sb !== sa) return sb - sa;
          const ra = chains.rootOf(a.id), rb = chains.rootOf(b.id);
          if (ra !== rb) return ra < rb ? -1 : 1;
        }
        return String(a.created || '').localeCompare(String(b.created || ''));
      });
      const rows = open ? sorted.map(t => {
        const sz = chains.sizeOf(t.id);
        const isDone = t.status === 'done';
        return `<div class="mpTask ${isDone ? 'done' : ''}" data-mt="${esc(k)}::${esc(t.id)}" title="open in the workbench">
          <span class="tdot ${statusDot(t.status)}"></span>
          ${sz > 1 ? `<span class="mpChain" title="part of a ${sz}-task chain">⛓${sz}</span>` : '<span class="mpChain solo">·</span>'}
          <span class="mpTitle">${t.archived ? '▣ ' : ''}${esc(t.title)}</span>
          <span class="mpId">${esc(t.id)}</span>
          <span class="mpSt ${esc(t.status)}">${isDone ? '✓ done' : esc(t.status)}</span>
        </div>`;
      }).join('') : '';
      return `<div class="mpCat ${open ? 'open' : ''}" data-mpc="${esc(ck)}">
          <span class="caret">${open ? '▾' : '▸'}</span> ${esc(c)}
          <span class="mpCount">${list.length} task${list.length === 1 ? '' : 's'} · ${done} done</span>
        </div>
        ${open ? `<div class="mpList">${rows}</div>` : ''}`;
    }).join('');
    const doneAll = ts.filter(t => t.status === 'done').length;
    const status = ['active', 'trial', 'inactive'].includes(proj.status) ? proj.status : 'active';
    const pills = ['active', 'trial', 'inactive'].map(s =>
      `<span class="mpStPill ${status === s ? 'on' : ''}" data-pkst="${esc(k)}::${s}">${s}</span>`).join('');
    return `<div class="mpProj ${status === 'inactive' ? 'mpInactive' : ''}">
      <div class="mpHead">
        <input type="color" class="mpColor" data-pk="${esc(k)}" value="${esc(proj.color || '#888888')}" title="project color">
        <input class="mpName" data-pk="${esc(k)}" value="${esc(proj.name || k)}" spellcheck="false" title="display name — Enter or click away to save">
        <span class="mpKey" title="permanent id — tasks, ledger and snapshots are stored under it, so it can't be changed">${esc(k)}</span>
        <span class="mpStatus">${pills}</span>
        ${status !== 'inactive' ? `<span class="mpOpen" data-mpgo="${esc(k)}" title="open the workbench">open ›</span>` : ''}
        <span class="mpCount">${ts.length} task${ts.length === 1 ? '' : 's'} · ${doneAll} done</span>
      </div>
      ${catRows || '<div class="sideNote" style="padding:4px 12px;">no tasks yet</div>'}
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="catHead">
      <h1>🗂 Manage projects</h1>
      <span class="sub">rename, recolor, or set a designation — active (default) · trial (tag in the nav) · inactive (hidden from nav &amp; overview). Changes save to config.json.</span>
    </div>
    <div class="mpNew">
      <input type="color" id="npColor" value="#7ea2f5" title="color">
      <input id="npName" placeholder="New project name" spellcheck="false">
      <input id="npRoot" placeholder="/absolute/path/to/the/project/folder" spellcheck="false">
      <button type="button" id="npBrowse" class="pickBtn" title="choose the folder with your computer's file picker">⌖ browse…</button>
      <button id="npCreate" class="mpAdd">＋ Create project</button>
    </div>
    ${sections}`;
  host.querySelectorAll('.mpCat').forEach(el => el.addEventListener('click', () => {
    const ck = el.dataset.mpc;
    if (ui.manageOpen.has(ck)) ui.manageOpen.delete(ck); else ui.manageOpen.add(ck);
    renderManage();
  }));
  host.querySelectorAll('.mpTask').forEach(el => el.addEventListener('click', () => {
    const p = el.dataset.mt.split('::')[0];
    const tid = el.dataset.mt.slice(p.length + 2);
    perOf(p).taskId = tid;
    perOf(p).fileTab = taskTabRecall(p, tid);
    perOf(p).sessTab = 'sess';
    go(p);
  }));
  host.querySelectorAll('[data-mpgo]').forEach(el => el.addEventListener('click', () => go(el.dataset.mpgo)));
  // rename — commit on Enter / blur; skip if unchanged. The state broadcast re-renders.
  host.querySelectorAll('.mpName').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('change', () => {
      const name = el.value.trim();
      if (!name || name === (state.projects[el.dataset.pk]?.name || '')) return;
      api('PATCH', `/api/projects/${enc(el.dataset.pk)}`, { name });
    });
  });
  host.querySelectorAll('.mpColor').forEach(el => el.addEventListener('change', () =>
    api('PATCH', `/api/projects/${enc(el.dataset.pk)}`, { color: el.value })));
  host.querySelectorAll('.mpStPill').forEach(el => el.addEventListener('click', () => {
    const [k, s] = el.dataset.pkst.split('::');
    if ((state.projects[k]?.status || 'active') === s) return; // already that designation
    api('PATCH', `/api/projects/${enc(k)}`, { status: s });
  }));
  const nbrowse = host.querySelector('#npBrowse');
  if (nbrowse) nbrowse.addEventListener('click', async () => {
    // native folder picker — same as the pinned-files ＋; the dialog opens on
    // the SERVER's screen, so it only works when browsing locally
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
      toast('the folder dialog opens on the server machine — type the path here instead');
      return;
    }
    nbrowse.textContent = '…';
    const r = await api('POST', '/api/pickfolder', { prompt: 'Choose the project folder' });
    nbrowse.textContent = '⌖ browse…';
    if (r && r.path) host.querySelector('#npRoot').value = r.path;
  });
  const npc = host.querySelector('#npCreate');
  if (npc) npc.addEventListener('click', async () => {
    const name = host.querySelector('#npName').value.trim();
    const root = host.querySelector('#npRoot').value.trim();
    const color = host.querySelector('#npColor').value;
    if (!name) { toast('enter a project name'); return; }
    if (!root) { toast('enter the project folder path'); return; }
    const r = await api('POST', '/api/projects', { name, root, color, status: 'active' });
    if (r) toast(`created "${name}" (key: ${r.key})`);
  });
}

/**
 * The read-only categories browser.
 * @returns {void}
 */
export function renderCats() {
  const host = document.getElementById('catsFrame');
  if (!host) return;
  const groups = catGroups();
  host.innerHTML = `
    <div class="catHead">
      <h1>⊞ Task categories</h1>
      <span class="sub">each category is a primer injected at the top of every session of that kind</span>
    </div>
    ${groups.map(([g, entries]) => {
      const [fg, bg] = groupColor(g);
      return `
      <div class="catGroupHead" style="--gfg:${fg};--gbg:${bg};">
        <span class="cgChip">${esc(g)}</span>
        <span class="cgLine"></span>
        <span class="cgCount">${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}</span>
      </div>
      <div class="catGrid">${entries.map(([k, c]) => {
        const name = c.name || k;
        const icon = c.icon || name.slice(0, 1);
        const metas = Object.entries(c)
          .filter(([mk]) => !['name', 'primer', 'icon', 'group'].includes(mk))
          .map(([mk, mv]) => `<span>${esc(mk)} <b>${esc(typeof mv === 'object' ? JSON.stringify(mv) : mv)}</b></span>`)
          .join('');
        return `<div class="catCard">
          <div class="cn"><span class="ic" style="background:${bg};color:${fg}">${esc(icon)}</span> ${esc(name)}
            ${name !== k ? `<span class="ckey">${esc(k)}</span>` : ''}</div>
          <div class="primer">${c.primer ? esc(c.primer) : '<i>no primer set</i>'}</div>
          ${metas ? `<div class="meta">${metas}</div>` : ''}
        </div>`;
      }).join('')}</div>`;
    }).join('') || '<div class="sideNote">no categories found in categories.json</div>'}
    <div class="catFoot">categories live in <b>projectManager/categories.json</b> · injection order at launch:
      <b>category primer</b> → living abstract → upstream handoffs → sibling tasks → pinned files → your notes.
      · <span class="catManageLink" id="catManageLink">✎ manage categories</span></div>`;
  host.querySelector('#catManageLink')?.addEventListener('click', () => go('catman'));
}

/* ───────────────────────── manage categories (profile menu) ─────────────────
   Two-pane master–detail editor over categories.json: grouped tree on the
   left (✎ rename / ⠿ delete per group, ＋ Category / ＋ Group), full editor on
   the right (icon picker · name · group · primer · web-search default).
   Semantics: RENAME propagates to every task ever tagged (server retags);
   DELETE (category or group) leaves tasks untouched — the past keeps its
   labels. Groups live on their categories, so an empty new group is local
   until a category is saved into it. */

const CAT_ICONS = ['⌕', '∴', '⚙', '∑', '∫', '∮', '∂', 'λ', 'π', 'Σ', 'Δ', '⌖', '⚖', '∿', '¶',
  '◫', '▦', '▤', '▥', '⊟', '◆', '◇', '●', '○', '★', '✦', '✎', '✓', '✗', '⟲',
  '⇄', '⬇', '⬆', '⌫', '▶', '■', '▲', '❏', '⊞', '⊕', '🛡'];

const catman = {
  sel: null,          // selected category key (null + isNew → creating)
  isNew: false,
  drafts: {},         // key (or '__new') → {icon, name, group, primer, webSearch}
  pendingGroups: [],  // added locally; real once a category is saved into them
  groupEdit: null,    // group currently being renamed inline
  iconPop: false,
};

function catmanBase(key) {
  const c = (state.categories || {})[key];
  if (!c || typeof c !== 'object') return null;
  return {
    icon: c.icon || '◆',
    name: c.name || key,
    group: c.group || 'Other',
    primer: c.primer || '',
    webSearch: !!(c.defaults && c.defaults.web_search),
  };
}

/* the draft being edited (created lazily from the saved values) */
function catmanDraft() {
  const k = catman.isNew ? '__new' : catman.sel;
  if (!k) return null;
  if (!catman.drafts[k]) {
    catman.drafts[k] = catman.isNew
      ? { icon: '◆', name: '', group: catman.pendingGroups[0] || catGroups()[0]?.[0] || 'Other', primer: '', webSearch: false }
      : { ...catmanBase(catman.sel) };
  }
  return catman.drafts[k];
}

/* categories changed on the server — re-pull the snapshot (works with or
   without the WS broadcast) and re-render whatever view is open */
async function catmanRefresh() {
  await loadState();
  renderAll();
}

/**
 * The ❏ Manage Categories master–detail editor.
 * @returns {void}
 */
export function renderCatMan() {
  const host = document.getElementById('catmanFrame');
  if (!host) return;
  const cats = state.categories || {};
  const groups = catGroups();
  // drop pending groups that became real, keep the rest
  catman.pendingGroups = catman.pendingGroups.filter(g => !groups.some(([gg]) => gg === g));
  if (!catman.isNew && (!catman.sel || !cats[catman.sel])) {
    catman.sel = Object.keys(cats)[0] || null;
  }
  const nCats = Object.keys(cats).length;
  const nGroups = groups.length + catman.pendingGroups.length;

  const groupRow = (g, count, pending) => catman.groupEdit === g
    ? `<div class="cmGrp"><input class="cmGinp" id="cmGinp" data-g="${esc(g)}" data-pending="${pending ? '1' : ''}" value="${esc(g)}"></div>`
    : `<div class="cmGrp" data-g="${esc(g)}"><span class="gname">${esc(g)}</span>${pending ? '<span class="cmPendTag">empty — add a category</span>' : ''}
        <span class="gctl"><span class="cmGRen" data-g="${esc(g)}" data-pending="${pending ? '1' : ''}" title="rename group — every category in it moves along">✎</span>
        <span class="cmGDel" data-g="${esc(g)}" data-pending="${pending ? '1' : ''}" data-n="${count}" title="delete group${count ? ' and its categories' : ''}">⠿</span></span></div>`;

  const tree = groups.map(([g, entries]) =>
    groupRow(g, entries.length, false)
    + entries.map(([k, c]) =>
      `<div class="cmCat ${!catman.isNew && catman.sel === k ? 'sel' : ''}" data-k="${esc(k)}">${esc(c.icon || '◆')} ${esc(c.name || k)}</div>`).join(''))
    .join('')
    + catman.pendingGroups.map(g => groupRow(g, 0, true)).join('')
    + `<div class="cmTreeFoot">
        <div class="cmAdd" id="cmAddCat">＋ Category</div>
        <div class="cmAdd grouplvl" id="cmAddGrp">＋ Group</div>
      </div>`;

  let editor;
  const d = catmanDraft();
  if (!d) {
    editor = '<div class="cmEmpty">no categories yet — ＋ Category starts one</div>';
  } else {
    const base = catman.isNew ? null : catmanBase(catman.sel);
    const groupOpts = [...new Set([...groups.map(([g]) => g), ...catman.pendingGroups, d.group])];
    const keyNote = !catman.isNew && catman.sel !== d.name
      ? `<div class="cmKeyNote">id: <b>${esc(catman.sel)}</b> — saving a new name renames it and retags every task, past and present</div>`
      : '<div class="cmKeyNote">renaming retags every task ever filed under it — past and present</div>';
    editor = `
      <div class="cmEdRow">
        <div class="cmField">
          <span class="cmLab">Icon</span>
          <button class="cmIconBtn" id="cmIconBtn">${esc(d.icon || '◆')}</button>
          <div class="cmIconPop" id="cmIconPop" ${catman.iconPop ? '' : 'hidden'}>
            <div class="cmLab" style="margin-bottom:7px">pick an icon</div>
            <div class="cmIconPad">${CAT_ICONS.map(g =>
              `<span class="ic ${g === d.icon ? 'on' : ''}" data-ic="${esc(g)}">${esc(g)}</span>`).join('')}</div>
          </div>
        </div>
        <div class="cmField" style="flex:1"><span class="cmLab">Name</span>
          <input class="cmIn" id="cmName" value="${esc(d.name)}" placeholder="category name"></div>
        <div class="cmField"><span class="cmLab">Group</span>
          <select class="cmIn" id="cmGroup">${groupOpts.map(g =>
            `<option ${g === d.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      </div>
      ${keyNote}
      <div class="cmField"><span class="cmLab">Primer — injected into every ${esc(d.name || 'such')} task</span>
        <textarea class="cmIn cmPrimer" id="cmPrimer" placeholder="what a session of this kind should know and do">${esc(d.primer)}</textarea></div>
      <label class="cmTog"><input type="checkbox" id="cmWeb" ${d.webSearch ? 'checked' : ''}> web search on by default</label>
      <div class="cmSave">
        <button class="gbtn go" id="cmSave">${catman.isNew ? 'Create' : 'Save'}</button>
        <button class="gbtn" id="cmRevert">Revert</button>
        ${catman.isNew ? '' : `<button class="gbtn cmDel" id="cmDelete">delete category</button>`}
      </div>`;
  }

  host.innerHTML = `
    <div class="catHead">
      <h1>❏ Manage Categories</h1>
      <span class="sub">${nCats} categor${nCats === 1 ? 'y' : 'ies'} · ${nGroups} group${nGroups === 1 ? '' : 's'} —
        primers are injected into every task of their kind</span>
    </div>
    <div class="cmWrap">
      <div class="cmTree">${tree}</div>
      <div class="cmEd">${editor}</div>
    </div>
    <div class="cmFoot">renames propagate to all tasks · deletes never rewrite the past (old tasks keep their labels) ·
      groups live on their categories, so an empty group disappears on reload</div>`;

  // ---- tree wiring ----
  host.querySelectorAll('.cmCat').forEach(el => el.addEventListener('click', () => {
    catman.isNew = false;
    catman.sel = el.dataset.k;
    catman.iconPop = false;
    renderCatMan();
  }));
  host.querySelector('#cmAddCat')?.addEventListener('click', () => {
    catman.isNew = true;
    catman.iconPop = false;
    delete catman.drafts.__new;
    renderCatMan();
    host.querySelector('#cmName')?.focus();
  });
  host.querySelector('#cmAddGrp')?.addEventListener('click', () => {
    let name = 'New Group';
    for (let n = 2; catGroups().some(([g]) => g === name) || catman.pendingGroups.includes(name); n++) {
      name = `New Group ${n}`;
    }
    catman.pendingGroups.push(name);
    catman.groupEdit = name;
    renderCatMan();
  });
  host.querySelectorAll('.cmGRen').forEach(el => el.addEventListener('click', () => {
    catman.groupEdit = el.dataset.g;
    renderCatMan();
  }));
  const ginp = host.querySelector('#cmGinp');
  if (ginp) {
    ginp.focus();
    ginp.select();
    const commit = async () => {
      const from = ginp.dataset.g;
      const pending = ginp.dataset.pending === '1';
      const to = ginp.value.trim();
      catman.groupEdit = null;
      if (!to || to === from) { renderCatMan(); return; }
      if (pending) {
        const i = catman.pendingGroups.indexOf(from);
        if (i >= 0) catman.pendingGroups[i] = to;
        renderCatMan();
        return;
      }
      const r = await api('POST', '/api/catgroups/rename', { from, to });
      if (r) toast(`group renamed — ${r.moved} categor${r.moved === 1 ? 'y' : 'ies'} moved along`);
      await catmanRefresh();
    };
    ginp.addEventListener('blur', commit);
    ginp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ginp.blur(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); catman.groupEdit = null; ginp.removeEventListener('blur', commit); renderCatMan(); }
    });
  }
  host.querySelectorAll('.cmGDel').forEach(el => el.addEventListener('click', async () => {
    const g = el.dataset.g;
    if (el.dataset.pending === '1') { // never saved — just forget it
      catman.pendingGroups = catman.pendingGroups.filter(x => x !== g);
      renderCatMan();
      return;
    }
    const n = Number(el.dataset.n) || 0;
    const yes = await confirmBox(
      `Delete the group “<b>${esc(g)}</b>” and its ${n} categor${n === 1 ? 'y' : 'ies'}?<br>
       <small>Existing tasks keep their category labels — nothing in the past is rewritten;
       the categories just leave the pickers.</small>`, 'Delete group');
    if (!yes) return;
    const r = await api('POST', '/api/catgroups/delete', { name: g });
    if (r) {
      (r.removed || []).forEach(k => delete catman.drafts[k]);
      if (r.removed?.includes(catman.sel)) catman.sel = null;
      toast(`group deleted — ${r.removed.length} categor${r.removed.length === 1 ? 'y' : 'ies'} removed (tasks keep their labels)`);
    }
    await catmanRefresh();
  }));

  // ---- editor wiring (keystrokes edit the draft in place — no re-render) ----
  const draftKey = catman.isNew ? '__new' : catman.sel;
  const bind = (id, fn) => host.querySelector(id)?.addEventListener('input', (e) => {
    const dd = catman.drafts[draftKey];
    if (dd) fn(dd, e.target);
  });
  bind('#cmName', (dd, t) => { dd.name = t.value; });
  bind('#cmPrimer', (dd, t) => { dd.primer = t.value; });
  host.querySelector('#cmGroup')?.addEventListener('change', (e) => {
    const dd = catman.drafts[draftKey];
    if (dd) dd.group = e.target.value;
  });
  host.querySelector('#cmWeb')?.addEventListener('change', (e) => {
    const dd = catman.drafts[draftKey];
    if (dd) dd.webSearch = e.target.checked;
  });
  host.querySelector('#cmIconBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    catman.iconPop = !catman.iconPop;
    host.querySelector('#cmIconPop').hidden = !catman.iconPop;
  });
  host.querySelectorAll('#cmIconPop .ic').forEach(el => el.addEventListener('click', () => {
    const dd = catman.drafts[draftKey];
    if (dd) dd.icon = el.dataset.ic;
    catman.iconPop = false;
    host.querySelector('#cmIconPop').hidden = true;
    host.querySelector('#cmIconBtn').textContent = el.dataset.ic;
  }));

  host.querySelector('#cmSave')?.addEventListener('click', async () => {
    const dd = catman.drafts[draftKey];
    if (!dd) return;
    const name = dd.name.trim();
    if (!name) { toast('the category needs a name'); return; }
    if (catman.isNew) {
      const r = await api('POST', '/api/categories', {
        key: name, icon: dd.icon, group: dd.group, primer: dd.primer, webSearch: dd.webSearch,
      });
      if (!r) return; // api() toasted the reason (409 duplicate etc.)
      delete catman.drafts.__new;
      catman.isNew = false;
      catman.sel = r.key;
      toast(`category “${name}” created`);
    } else {
      let key = catman.sel;
      const base = catmanBase(key);
      if (name !== base.name) {
        const r = await api('POST', `/api/categories/${enc(key)}/rename`, { to: name });
        if (!r) return; // duplicate/invalid — keep the draft for fixing
        toast(`renamed to “${name}” — ${r.retagged} task${r.retagged === 1 ? '' : 's'} retagged`);
        delete catman.drafts[key];
        key = r.key;
        catman.sel = key;
      }
      const r2 = await api('PATCH', `/api/categories/${enc(key)}`, {
        icon: dd.icon, group: dd.group, primer: dd.primer, webSearch: dd.webSearch,
      });
      if (!r2) return;
      delete catman.drafts[key];
      if (name === base.name) toast('category saved');
    }
    await catmanRefresh();
  });
  host.querySelector('#cmRevert')?.addEventListener('click', () => {
    delete catman.drafts[draftKey];
    catman.iconPop = false;
    renderCatMan();
  });
  host.querySelector('#cmDelete')?.addEventListener('click', async () => {
    const key = catman.sel;
    const label = catmanBase(key)?.name || key;
    const yes = await confirmBox(
      `Delete the category “<b>${esc(label)}</b>”?<br>
       <small>Existing tasks keep the “${esc(label)}” label — nothing in the past is rewritten;
       it just leaves the pickers.</small>`, 'Delete');
    if (!yes) return;
    const r = await api('DELETE', `/api/categories/${enc(key)}`);
    if (r) {
      delete catman.drafts[key];
      catman.sel = null;
      toast(`category deleted — existing tasks keep “${label}”`);
    }
    await catmanRefresh();
  });
}

/* ───────────────────────── git panel ───────────────────────── */

const gitState = { open: false, key: null, info: null, busy: false, log: '' };

/**
 * Open the dashboard-repo git panel.
 * @returns {void}
 */
export function openGitPanel() {
  gitState.open = true;
  gitState.key = state.projects[ui.view] ? ui.view : projKeys()[0];
  gitState.info = null;
  gitState.log = '';
  document.getElementById('gitBack').classList.add('show');
  renderGitPanel();
  refreshGitInfo();
}

/**
 * @returns {void}
 */
export function closeGitPanel() {
  gitState.open = false;
  document.getElementById('gitBack').classList.remove('show');
}

async function refreshGitInfo() {
  const k = gitState.key;
  const info = await api('GET', `/api/git/${enc(k)}`);
  if (gitState.key !== k || !gitState.open) return; // switched away meanwhile
  gitState.info = info;
  renderGitPanel();
}

function gitDiffColor(text) {
  return String(text).split('\n').map(l => {
    const e = esc(l);
    if (l.startsWith('+++') || l.startsWith('---')) return `<span class="gdh">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="gdm">${e}</span>`;
    if (l.startsWith('+')) return `<span class="gda">${e}</span>`;
    if (l.startsWith('-')) return `<span class="gdd">${e}</span>`;
    return e;
  }).join('\n');
}

function renderGitPanel() {
  const host = document.getElementById('gitPanel');
  if (!host || !gitState.open) return;
  const k = gitState.key;
  const info = gitState.info;
  const name = state.projects[k]?.name || k;

  const pills = projKeys().map(p =>
    `<span class="pill gp ${p === gitState.key ? 'on' : ''}" data-gp="${esc(p)}">${esc(state.projects[p]?.name || p)}</span>`).join('');

  let body;
  if (!info) {
    body = `<div class="sideNote">reading repository state…</div>`;
  } else if (!info.repo) {
    body = `<div class="sideNote" style="padding:18px 4px;">
      <b>${esc(name)}</b> is not a git repository.<br><br>
      To put it under version control: <code>cd ${esc(state.projects[k]?.root || '')} && git init</code>,
      add a .gitignore (exclude <code>data/raw</code>, build artifacts), then create a GitHub repo
      with <code>gh repo create</code>. After that this panel lights up.</div>`;
  } else {
    const dirty = info.dirty || [];
    const upBit = info.upstream
      ? `→ ${esc(info.upstream)} <span class="gAhead">${info.ahead ? `↑${info.ahead}` : ''} ${info.behind ? `↓${info.behind}` : ''}</span>${!info.ahead && !info.behind ? '<span class="gOk">✓ in sync</span>' : ''}`
      : '<span class="gWarn">no upstream — first push will set one</span>';
    body = `
      <div class="gHead">
        <span class="gBranch">⎇ ${esc(info.branch || '?')}</span> ${upBit}
        ${info.conflicted ? '<span class="gErr">⚠ merge conflicts present</span>' : ''}
      </div>
      ${info.lastCommit ? `<div class="gLast">last: <b>${esc(info.lastCommit.hash)}</b> ${esc(info.lastCommit.msg)} <span>· ${esc(fmtWhen(info.lastCommit.when))}</span></div>` : ''}
      <div class="gFiles">
        <div class="gfHead">${dirty.length ? `${dirty.length} changed file${dirty.length === 1 ? '' : 's'}` : 'working tree clean'}</div>
        ${dirty.slice(0, 60).map(d => `
          <div class="gFile" data-grel="${esc(d.path)}">
            <span class="gs ${/\?\?/.test(d.s) ? 'new' : /D/.test(d.s) ? 'del' : 'mod'}">${esc(d.s)}</span>
            <span class="gp2">${esc(d.path)}</span><span class="gdiffLink">diff</span>
          </div>`).join('')}
        ${dirty.length > 60 ? `<div class="sideNote">… ${dirty.length - 60} more</div>` : ''}
      </div>
      <div class="gDiffBox" id="gDiffBox"></div>
      <input type="text" id="gMsg" placeholder="commit message (empty → checkpoint timestamp)" autocomplete="off">
      <div class="gBtns">
        <button class="gbtn" id="gPull" ${gitState.busy ? 'disabled' : ''}>⇣ pull</button>
        <button class="gbtn go" id="gSync" ${gitState.busy ? 'disabled' : ''}>⇡ commit &amp; push</button>
        <button class="gbtn ai" id="gSteward" ${gitState.busy ? 'disabled' : ''}
          title="launch a session that groups changes into logical commits, writes messages, and pushes">🤖 delegate cleanup</button>
        <span style="flex:1"></span>
        <button class="gbtn" id="gRefresh">↻</button>
      </div>
      ${gitState.log ? `<pre class="gLog">${gitDiffColor(gitState.log)}</pre>` : ''}`;
  }

  const GH = `<svg class="ghIcon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
  host.innerHTML = `
    <div class="gTop"><span class="gTitle">${GH} GitHub</span>
      <div class="pills" style="display:inline-flex;gap:6px;margin-left:14px;">${pills}</div>
      <span id="gitClose" style="margin-left:auto;cursor:pointer;color:var(--dim);">✕</span></div>
    ${body}`;

  host.querySelector('#gitClose').addEventListener('click', closeGitPanel);
  host.querySelectorAll('[data-gp]').forEach(el => el.addEventListener('click', () => {
    if (gitState.busy) { toast('an action is running — hold on'); return; }
    gitState.key = el.dataset.gp; gitState.info = null; gitState.log = '';
    renderGitPanel(); refreshGitInfo();
  }));
  host.querySelector('#gRefresh')?.addEventListener('click', refreshGitInfo);
  host.querySelectorAll('.gFile').forEach(el => el.addEventListener('click', async () => {
    const box = host.querySelector('#gDiffBox');
    if (box._rel === el.dataset.grel && box.innerHTML) { box.innerHTML = ''; box._rel = null; return; }
    box._rel = el.dataset.grel;
    box.innerHTML = '<div class="sideNote">loading diff…</div>';
    const d = await api('GET', `/api/git/${enc(k)}/diff?rel=${enc(el.dataset.grel)}`);
    if (box._rel !== el.dataset.grel) return;
    box.innerHTML = d && d.diff ? `<pre class="gLog">${gitDiffColor(d.diff)}</pre>` : '<div class="sideNote">no diff (binary or unchanged)</div>';
  }));
  const act = async (label, fn) => {
    gitState.busy = true; gitState.log = `${label}…`; renderGitPanel();
    const r = await fn();
    gitState.busy = false;
    if (r && r.steps) {
      gitState.log = r.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.step}\n${s.output || ''}`.trim()).join('\n');
    } else {
      gitState.log = r ? (r.output || (r.ok ? 'done ✓' : r.error || 'failed')) : 'request failed';
    }
    await refreshGitInfo();
  };
  host.querySelector('#gPull')?.addEventListener('click', () =>
    act('pulling', () => api('POST', `/api/git/${enc(k)}/pull`)));
  host.querySelector('#gSync')?.addEventListener('click', () =>
    act('committing & pushing', () => api('POST', `/api/git/${enc(k)}/sync`,
      { message: host.querySelector('#gMsg')?.value || '' })));
  host.querySelector('#gSteward')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/git/${enc(k)}/steward`);
    if (r && r.ok) {
      toast(`repo steward launched (${r.id}) — watch its console`);
      closeGitPanel();
      perOf(k).taskId = r.id;
      perOf(k).fileTab = 'tail';
      go(k);
    }
  });
}
