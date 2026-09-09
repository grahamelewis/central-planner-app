// sidebar.js — workbench sidebar sections, split verbatim out of app.js
// (phase 2): lineage chain, ◷ Recent activity feed rows/groups, ◆ next up +
// deadlines + gcal links.

import { enc, esc, statusDot, toast, fmtAgo, fmtJobDur } from './util.js';
import { state, feedCache, allProjKeys, tasksOf, resolveId, perOf } from './store.js';
import { api } from './net.js';
import { ensureFeed } from './files.js';
// PERMANENT: afNum stays in app.js (ui.feed.test.mjs extracts it from there);
// go/loadState stay with the entry module.
import { afNum, go, loadState } from './app.js';
import { renderWB } from './workbench.js';
import { jobTitle } from './jobs.js';

/* ───────────── ◆ next up + ⧉ calendar — stage-1 planning ─────────────
   One countdown block in the workbench sidebar (project-scoped: the same
   three rows in every task of a project) + the ⧉ Calendar page (sources,
   meeting filing, the full deadline list). Deadlines are typed; meetings are
   read from .ics feeds and FILED to projects here — Google is never written.
   Colour contract: deadlines --pink (the app's attention colour; imminent/
   overdue ones pulse), meetings --viewable slate, unfiled --wait amber. */

export const NU_DAY = 86400000;
export const NU_LINGER_MS = 2 * NU_DAY; // a missed deadline lingers 48h in red, then goes

/**
 * @param {number} ms
 * @returns {number} local midnight of the day containing ms
 */
export function nuDayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

/**
 * @param {number} ms
 * @returns {number} whole local days from today to ms (negative = past)
 */
export function nuDaysUntil(ms) {
  return Math.round((nuDayStart(ms) - nuDayStart(Date.now())) / NU_DAY);
}

/**
 * @param {PlanDeadline} d
 * @returns {number} the deadline's local end-of-day timestamp (NaN when dateless)
 */
export function deadlineMs(d) {
  // an untimed deadline is due at end-of-day, so "today" never reads as past
  return Date.parse(`${d.date}T${d.time || '23:59'}`);
}

/* merge for project P: P's deadlines + cached events filed to P; drop the
   past (deadlines linger 48h); sort; the rail slices three */
/**
 * ◆ next up rows: project deadlines + events routed to it, future-first.
 * @param {string} key project key
 * @returns {{ type: 'dl' | 'ev', ms: number, overdue?: boolean, [k: string]: any }[]}
 */
export function planItemsFor(key) {
  /** @type {PlanState} */
  const plan = state.plan || {};
  const now = Date.now();
  const items = [];
  for (const d of (plan.deadlines?.[key] || [])) {
    const ms = deadlineMs(d);
    if (!Number.isFinite(ms) || now - ms > NU_LINGER_MS) continue;
    items.push({ type: 'dl', ms, overdue: ms < now, ...d });
  }
  const routes = plan.cal?.routes || {};
  for (const ev of (plan.cal?.events || [])) {
    if (routes[ev.uid]?.to !== key) continue;
    const ms = Date.parse(ev.start);
    if (!Number.isFinite(ms)) continue;
    // a timed meeting drops once it starts; an all-day one lives through its day
    if (ev.allDay ? nuDayStart(ms) + NU_DAY < now : ms < now) continue;
    items.push({ type: 'mt', ms, title: ev.title, allDay: ev.allDay, uid: ev.uid, recurring: ev.recurring });
  }
  items.sort((a, b) => a.ms - b.ms);
  return items;
}

/* unfiled series (grouped by UID — filing one files them all) */
/**
 * Calendar series (by UID) not yet filed to a project — the triage list.
 * @returns {{ uid: string, [k: string]: any }[]}
 */
export function unfiledSeries() {
  /** @type {PlanState} */
  const plan = state.plan || {};
  const routes = plan.cal?.routes || {};
  const byUid = new Map();
  for (const ev of (plan.cal?.events || [])) {
    if (routes[ev.uid]) continue;
    const cur = byUid.get(ev.uid);
    if (!cur) byUid.set(ev.uid, { ...ev, count: 1 });
    else { cur.count++; if (ev.start < cur.start) Object.assign(cur, ev, { count: cur.count }); }
  }
  return [...byUid.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export const NU_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const NU_MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * "Thu Aug 13" (+ " · 14:30" with withTime) for a next-up row.
 * @param {number} ms
 * @param {boolean} [withTime]
 * @returns {string}
 */
export function nuWhen(ms, withTime) {
  const d = new Date(ms);
  const day = `${NU_DAYS[d.getDay()]} ${NU_MONS[d.getMonth()]} ${d.getDate()}`;
  return withTime ? `${day} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : day;
}

/* the ⤴ one-click "add to Google Calendar" link — a computed URL, no token,
   no API; a COPY, not a sync (the mock's stage-1 recommendation) */
/**
 * calendar.google.com render?action=TEMPLATE link computed from a deadline
 * (a copy, not a sync — no credential).
 * @param {PlanDeadline} d
 * @returns {string}
 */
export function gcalTemplateUrl(d) {
  const ymd = d.date.replace(/-/g, '');
  let dates;
  if (d.time) {
    const s = new Date(`${d.date}T${d.time}`);
    const f = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}T${String(x.getHours()).padStart(2, '0')}${String(x.getMinutes()).padStart(2, '0')}00`;
    dates = `${f(s)}/${f(new Date(s.getTime() + 3600000))}`;
  } else {
    const n = new Date(Date.parse(`${d.date}T00:00`) + NU_DAY);
    dates = `${ymd}/${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
  }
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(d.title)}&dates=${dates}`;
}

/* an optional deadline link → a clickable ↗ host on the row. Guards the href:
   only http(s) is ever made clickable (defence in depth — the store validates
   too, but a hand-edited plan file must not smuggle a javascript: URL here). */
/**
 * @param {*} u
 * @returns {string | null} u when it parses as http(s), else null
 */
export function nuSafeUrl(u) {
  if (!u) return '';
  try { const p = new URL(u); return /^https?:$/.test(p.protocol) ? p.href : ''; }
  catch { return ''; }
}
/**
 * @param {*} u
 * @returns {string} the link's hostname ('' on failure)
 */
export function nuHost(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

/**
 * The sidebar's ◆ Next up section (3-row cap, derived per render).
 * @param {string} key project key
 * @param {Task | null} task
 * @returns {string} html
 */
export function nextUpSectionHtml(key, task) {
  const per = perOf(key);
  const items = planItemsFor(key).slice(0, 3); // three rows, hard cap
  const unfiled = unfiledSeries().length;
  const rows = items.map((it) => {
    const n = nuDaysUntil(it.ms);
    const dl = it.type === 'dl';
    const num = it.overdue ? '!' : String(n);
    const lbl = it.overdue ? 'PAST' : n === 0 ? 'TODAY' : n === 1 ? 'DAY' : 'DAYS';
    const cls = dl ? (it.overdue ? 'ovd' : 'dl') : 'mt';
    const pulse = dl && (it.overdue || n <= 2);
    const withTime = dl ? !!it.time : !it.allDay;
    const url = dl ? nuSafeUrl(it.url) : '';
    const sub = `<span class="g${dl ? ' gdl' : ''}">${dl ? '◆' : '⧉'}</span> ${esc(nuWhen(it.ms, withTime))}`
      + (url ? ` · <a class="nuLink" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">↗ ${esc(nuHost(url))}</a>` : '');
    return `<div class="nuRow" title="${dl ? 'deadline' : 'meeting (from your calendar)'}">
      <span class="nuN ${cls}${pulse ? ' pls' : ''}">${num}<small>${lbl}</small></span>
      <span class="nuWhat"><span class="t">${esc(it.title)}</span><small>${sub}</small></span>
      ${dl ? `<span class="nuActs">
        <a class="nuG" href="${esc(gcalTemplateUrl(it))}" target="_blank" rel="noopener"
          title="add a copy to Google Calendar (opens prefilled — you hit save)">⤴</a>
        <span class="nuX" data-nux="${esc(it.id)}" title="remove this deadline">×</span></span>` : ''}
    </div>`;
  }).join('');

  return `<div class="sh">◆ Next up
      ${unfiled ? `<span class="nuUnf" id="nuUnfiled" title="${unfiled} meeting series aren't filed to a project yet — click to file them">⧉ ${unfiled} unfiled</span>` : ''}
      <span id="nuAddBtn" class="pinAdd" title="add a deadline to this project">＋</span></div>
    ${per.nuOpen ? `<div class="nuPick">
      <input id="nuTitle" placeholder="what's the deadline? e.g. AEA submission" autocomplete="off" spellcheck="false">
      <div class="nuRow2"><input id="nuDate" type="date" title="date"></div>
      <input id="nuLink" type="text" placeholder="link · CFP or conference page (optional)" autocomplete="off" spellcheck="false">
      <label class="nuChk"><input type="checkbox" id="nuGcal"> also add to Google Calendar</label>
      <div class="nuBtns"><button class="nuBtn" id="nuCancel">cancel</button><button class="nuBtn pri" id="nuAdd">add deadline</button></div>
    </div>` : ''}
    ${rows || '<div class="sideNote">nothing dated in the next 30 days — ＋ adds a deadline</div>'}`;
}

/**
 * Wire ◆ Next up's add-deadline row + remove/link handlers.
 * @param {Element} root the sidebar root
 * @param {string} key project key
 * @returns {void}
 */
export function wireNextUp(root, key) {
  const per = perOf(key);
  root.querySelector('#nuAddBtn')?.addEventListener('click', () => {
    per.nuOpen = !per.nuOpen;
    renderWB(key);
    if (per.nuOpen) root.querySelector('#nuTitle')?.focus();
  });
  root.querySelector('#nuUnfiled')?.addEventListener('click', () => go('plan'));
  root.querySelector('#nuCancel')?.addEventListener('click', () => { per.nuOpen = false; renderWB(key); });
  root.querySelector('#nuAdd')?.addEventListener('click', async () => {
    const title = root.querySelector('#nuTitle')?.value?.trim();
    const date = root.querySelector('#nuDate')?.value;
    if (!title) { toast('give the deadline a name'); return; }
    if (!date) { toast('pick a date'); return; }
    const body = { title, date, url: root.querySelector('#nuLink')?.value?.trim() || '' };
    const toGcal = root.querySelector('#nuGcal')?.checked;
    const r = await api('POST', `/api/plan/${enc(key)}/deadlines`, body);
    if (r && r.id) {
      per.nuOpen = false;
      if (toGcal) window.open(gcalTemplateUrl(r), '_blank', 'noopener');
      await loadState(); // don't wait on the ws echo — render the new row now
      renderWB(key);
    }
  });
  root.querySelector('#nuTitle')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { per.nuOpen = false; renderWB(key); }
  });
  root.querySelectorAll('[data-nux]').forEach((el) => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api('DELETE', `/api/plan/${enc(key)}/deadlines/${enc(el.dataset.nux)}`);
    await loadState();
    renderWB(key);
  }));
}

/**
 * The lineage chain section (upstream ids resolved to titles).
 * @param {string} key project key
 * @param {Task | null} task
 * @returns {string} html
 */
export function sideChainHtml(key, task) {
  const ups = Array.isArray(task.upstream) ? task.upstream : [];
  // the FULL chain: transitive ancestors above, descendants below. CSS caps the
  // box at ~2 nodes — scroll up for history, down for follow-ups. Levels walk
  // the upstream DAG breadth-first; the seen-set collapses cycles and diamonds.
  const seen = new Set([task.id]);
  const upLevels = [];
  let frontier = ups.filter(id => !seen.has(id));
  while (frontier.length) {
    frontier.forEach(id => seen.add(id));
    upLevels.unshift(frontier);
    frontier = frontier
      .flatMap(id => { const r = resolveId(id); return r && Array.isArray(r.t.upstream) ? r.t.upstream : []; })
      .filter((id, i, a) => !seen.has(id) && a.indexOf(id) === i);
  }
  const downLevels = [];
  let wave = [task.id];
  while (wave.length) {
    const kids = [];
    allProjKeys().forEach(k2 => tasksOf(k2).forEach(t => {
      if (!seen.has(t.id) && Array.isArray(t.upstream) && t.upstream.some(u => wave.includes(u))) {
        seen.add(t.id);
        kids.push(t.id);
      }
    }));
    if (!kids.length) break;
    downLevels.push(kids);
    wave = kids;
  }
  if (!upLevels.length && !downLevels.length) {
    return `<div class="sideNote">no lineage — ＋ links an upstream task whose handoff feeds this one</div>`;
  }
  const node = (id) => {
    const r = resolveId(id);
    const dot = r ? statusDot(r.t.status) : 'man';
    const title = r ? r.t.title : id;
    // ✕ on direct parents (this task's own links) and direct children (the
    // link lives on the child's upstream — the handler patches that task)
    const isChild = r && Array.isArray(r.t.upstream) && r.t.upstream.includes(task.id);
    const x = ups.includes(id) ? `<span class="schX" data-ux="${esc(id)}" title="unlink this parent task">✕</span>`
      : isChild ? `<span class="schX" data-dx="${esc(id)}" title="unlink this child task">✕</span>` : '';
    return `<div class="schNode" ${r ? `data-lk="${esc(r.k)}" data-lid="${esc(r.t.id)}"` : ''}>
      <span class="tdot ${dot}"></span>${esc(title)}${r && r.t.status === 'done' ? ' ✓' : ''}${x}</div>`;
  };
  const parts = [
    ...upLevels.map(ids => ids.map(node).join('')),
    `<div class="schNode cur"><span class="tdot ${statusDot(task.status)}"></span>${esc(task.title)}</div>`,
    ...downLevels.map(ids => ids.map(node).join('')),
  ];
  return `<div class="sideChain" data-tid="${esc(task.id)}">${parts.join('<div class="schArr">↓ handoff</div>')}</div>`;
}

/* ── ◷ Recent activity — the sidebar feed ──
   Replaces the archived-task dump with a live timeline: file edits (Δ
   change-sets), finished script runs, and task completions. Every row
   navigates: ✎/✚/✂ → that change's diff in the Δ history, ✓ done → the
   archived task, ▶ → the run's output surface. A busy turn is GROUPED (≥3
   files or ≥3 runs fold into one expandable ▸ row) so one calibration sweep
   can't flood the feed. There is deliberately NO archived entry
   point here — archived tasks are reached via ✓ done rows or the overview's
   Recent tasks strip. */

export const FEED_SHOW = 8;     // top-level rows before "…older activity"
export const FEED_GROUP_AT = 3; // a turn's edits/runs fold into one row from here
export const FEED_KIDS = 3;     // an expanded group lists this many, then "…N more"

// typographic verb glyphs (④a in docs/feedmark-mockups.html — Graham's
// 2026-07-31 rethink of the bracket tags): + / Δ / × are marks, not dingbats,
// and Δ is the app's existing change-vocabulary (these rows deep-link into
// the Δ tab). Color-blind safe by SHAPE, not just color; the verb word
// survives in every row's tooltip. Fixed narrow column in CSS.
/** @type {{ [status: string]: { tag: string, cls: string, word: string } }} */
export const FEED_VERB = {
  created: { tag: '+', cls: 'new', word: 'wrote' },
  modified: { tag: 'Δ', cls: 'edit', word: 'edited' },
  deleted: { tag: '×', cls: 'del', word: 'deleted' },
};
/** @type {{ [state: string]: string }} */
export const FEED_RUN_MARK = { done: '✓', error: '✗', stopped: '⊘' };

/**
 * Fixed-column +A −B delta cell.
 * @param {number | null | undefined} adds
 * @param {number | null | undefined} dels
 * @returns {string} html
 */
export function afDelta(adds, dels) {
  const a = adds ? `<span class="a">+${afNum(adds)}</span>` : '';
  const d = dels ? `<span class="d">−${afNum(dels)}</span>` : '';
  return a || d ? `<span class="afD">${a}${a && d ? ' ' : ''}${d}</span>` : '';
}

// fold adjacent runs of the same task (within 10 minutes) into group items
/**
 * Feed items with ≥3 adjacent same-task runs folded into 'runs' groups.
 * @param {string} key project key
 * @returns {FeedItem[]}
 */
export function feedItemsFor(key) {
  const items = feedCache[key]?.items || [];
  const out = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === 'run' && it.taskId) {
      const runs = [it];
      let j = i + 1;
      while (j < items.length && items[j].kind === 'run' && items[j].taskId === it.taskId
        && Math.abs(Date.parse(runs[runs.length - 1].ts) - Date.parse(items[j].ts)) < 600000) {
        runs.push(items[j]);
        j++;
      }
      if (runs.length >= FEED_GROUP_AT) {
        out.push({ kind: 'runs', ts: it.ts, taskId: it.taskId, runs });
        i = j;
        continue;
      }
    }
    out.push(it);
    i++;
  }
  return out;
}

/**
 * @param {string} key project key
 * @param {string | null | undefined} taskId
 * @returns {string} short task label for feed rows ('' when unknown)
 */
export function afTaskLabel(key, taskId) {
  const t = (state.tasks[key] || []).find((x) => x && x.id === taskId);
  return t ? (t.title || t.id) : '';
}

/**
 * One Δ file row (verb glyph · name · ± columns).
 * @param {FeedItem} it the edits item
 * @param {SnapFileChange} f
 * @param {boolean} [kid] indented child of an expanded group
 * @returns {string} html
 */
export function afFileRow(it, f, kid) {
  const v = FEED_VERB[f.status] || FEED_VERB.modified;
  const name = esc(String(f.rel).split('/').pop());
  // no 'new' delta badge anymore — the [new] tag already says it
  return `<div class="afRow" data-nav="diff" data-task="${esc(it.taskId)}" data-eid="${esc(it.eid)}" data-rel="${esc(f.rel)}"
    title="${it.revert ? 'rewound' : v.word} ${esc(f.rel)} — this change's diff in the Δ history">
    <span class="afVm ${it.revert ? 'rew' : v.cls}">${it.revert ? '⟲' : v.tag}</span>
    <span class="nm">${name}</span>
    ${afDelta(f.adds, f.dels)}<span class="afTo">Δ →</span>${kid ? '' : `<span class="afW">${fmtAgo(it.ts)}</span>`}</div>`;
}

// an edits change-set → 1-2 single rows, or one expandable group row
/**
 * A change-set feed entry (single rows or an expandable ▸ group head).
 * @param {string} key project key
 * @param {FeedItem} it
 * @param {Set<string>} open the expanded group ids
 * @returns {string} html
 */
export function afEditHtml(key, it, open) {
  const files = it.files || [];
  if (!files.length) return '';
  if (files.length < FEED_GROUP_AT) return files.map((f) => afFileRow(it, f, false)).join('');
  const gid = `e:${it.eid}`;
  const label = afTaskLabel(key, it.taskId);
  const kids = files.slice(0, FEED_KIDS).map((f) => afFileRow(it, f, true)).join('')
    + (files.length > FEED_KIDS
      ? `<div class="afRow afMore" data-nav="dlist" data-task="${esc(it.taskId)}" title="the full change-set in Δ">
          <span class="afVm"></span><span class="nm">…${files.length - FEED_KIDS} more — all in Δ</span></div>`
      : '');
  return `<div class="afGrp ${open.has(gid) ? 'open' : ''}" data-gid="${esc(gid)}">
    <div class="afRow afHead" data-nav="dlist" data-task="${esc(it.taskId)}"
      title="one turn ${it.revert ? 'rewound' : 'changed'} ${files.length} files — click to expand · Δ → history">
      <span class="afCaret">▸</span><span class="afVm ${it.revert ? 'rew' : 'edit'}">${it.revert ? '⟲' : 'Δ'}</span>
      <span class="nm">${files.length} files${label ? ` · ${esc(label)}` : ''}</span>
      ${afDelta(it.adds, it.dels)}<span class="afTo">Δ →</span><span class="afW">${fmtAgo(it.ts)}</span></div>
    <div class="afKids">${kids}</div></div>`;
}

/**
 * One ▶ run row.
 * @param {FeedItem} it
 * @param {boolean} [kid]
 * @returns {string} html
 */
export function afRunRow(it, kid) {
  const mark = FEED_RUN_MARK[it.state] || '';
  // inline evals carry a prose label ("Pass-through at pe=0.50 fit"), not a
  // path — never basename-split those
  const title = jobTitle(it);
  const name = esc(title.name);
  return `<div class="afRow" data-nav="run" data-task="${esc(it.taskId || '')}" data-src="${esc(it.source)}" data-file="${esc(it.file || '')}"
    title="${esc(title.tooltip)} · ${esc(it.lang)}${it.detached ? ' · detached' : it.bg ? ' · background' : ''} — ${esc(it.state)}">
    <span class="afIc run">▶</span>
    <span class="nm">${kid ? '' : 'ran '}${name} · ${fmtJobDur(it.ms)} ${mark}</span>
    <span class="afTo">▶ →</span>${kid ? '' : `<span class="afW">${fmtAgo(it.ts)}</span>`}</div>`;
}

/**
 * A folded '▶ ran N scripts' group.
 * @param {string} key project key
 * @param {FeedItem} it the runs group
 * @param {Set<string>} open the expanded group ids
 * @returns {string} html
 */
export function afRunsHtml(key, it, open) {
  const gid = `r:${it.taskId}:${it.ts}`;
  const label = afTaskLabel(key, it.taskId);
  const totalMs = it.runs.reduce((n, r) => n + (r.ms || 0), 0);
  const kids = it.runs.slice(0, FEED_KIDS).map((r) => afRunRow(r, true)).join('')
    + (it.runs.length > FEED_KIDS
      ? `<div class="afRow afMore"><span class="afIc"></span><span class="nm">…${it.runs.length - FEED_KIDS} more</span></div>`
      : '');
  return `<div class="afGrp ${open.has(gid) ? 'open' : ''}" data-gid="${esc(gid)}">
    <div class="afRow afHead" data-nav="run" data-task="${esc(it.taskId)}" data-src="session" data-file=""
      title="one turn ran ${it.runs.length} scripts — click to expand">
      <span class="afCaret">▸</span><span class="afIc run">▶</span>
      <span class="nm">ran ${it.runs.length} scripts${label ? ` · ${esc(label)}` : ''}</span>
      <span class="afD">${fmtJobDur(totalMs)}</span><span class="afTo">▶ →</span><span class="afW">${fmtAgo(it.ts)}</span></div>
    <div class="afKids">${kids}</div></div>`;
}

/**
 * A '✓ done' task-completion row.
 * @param {FeedItem} it
 * @returns {string} html
 */
export function afDoneRow(it) {
  return `<div class="afRow" data-nav="task" data-task="${esc(it.taskId)}"
    title="${esc(it.title)} — opens the archived task (handoff, unarchive)">
    <span class="afIc done">✓</span><span class="nm">done: ${esc(it.title)}</span>
    <span class="afTo">task →</span><span class="afW">${fmtAgo(it.ts)}</span></div>`;
}

/**
 * The sidebar's ◷ Recent activity section.
 * @param {string} key project key
 * @param {Task[]} ts the project's tasks
 * @param {Task | null} task the selected task
 * @returns {string} html
 */
export function feedSectionHtml(key, ts, task) {
  // NO archived entry point here — deliberate (Graham removed the header
  // toggle). Archived tasks are reached via the feed's ✓ done rows or the
  // overview's Recent tasks strip, which includes archived tasks.
  const per = perOf(key);
  ensureFeed(key); // fire-and-forget; re-renders once fetched
  const fc = feedCache[key];
  const open = per.afOpen || (per.afOpen = new Set());
  const items = feedItemsFor(key);
  const rows = [];
  for (const it of items) {
    if (rows.length >= FEED_SHOW) break;
    if (it.kind === 'edits') {
      const html = afEditHtml(key, it, open);
      if (html) rows.push(html);
    } else if (it.kind === 'runs') rows.push(afRunsHtml(key, it, open));
    else if (it.kind === 'run') rows.push(afRunRow(it, false));
    else if (it.kind === 'done') rows.push(afDoneRow(it));
  }
  let body = rows.join('');
  if (!body) {
    body = `<div class="sideNote">${fc && fc.fetched
      ? 'no activity yet — edits, runs and completions land here' : 'loading activity…'}</div>`;
  } else if (items.length > rows.length) {
    body += `<div class="afRow afOlder"><span class="afIc"></span><span class="nm">…older activity</span></div>`;
  }
  return `<div class="sh"><span class="shLbl">◷ Recent activity</span></div>
    <div id="actFeed">${body}</div>`;
}
