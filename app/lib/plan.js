// lib/plan.js — Stage-1 planning: per-project deadlines + a read-only Google
// Calendar feed filed to projects (mockups/planning-stages.html, stage 1).
//
// Three files, and the split matters (all under the gitignored data ROOT, so
// a pushed clone ships none of it and a fresh clone boots clean):
//   ROOT/plan/<project>.json  deadlines only — yours, per project
//   ROOT/plan/calendar.json   GLOBAL: the .ics sources (SECRET URLs — never
//                             exposed in snapshots) + the routing table
//                             (VEVENT UID → project | 'personal'). One line
//                             per SERIES: every instance shares its UID.
//   ROOT/.cache/gcal.json     disposable event cache, refetched every 15 min
//
// Read-only forever: the .ics URL physically cannot write back to Google, and
// nothing in here spawns a billed Claude call.
import fs from 'fs';
import path from 'path';
import { ROOT, PROJECTS } from './config.js';
import { writeFileAtomic } from './paths.js';
import { broadcast } from './events.js';

const PLAN_DIR = path.join(ROOT, 'plan');
const CAL_FILE = path.join(PLAN_DIR, 'calendar.json');
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'gcal.json');

const POLL_MS = process.env.CP_PLAN_POLL_MS ? Number(process.env.CP_PLAN_POLL_MS) : 15 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const HORIZON_DAYS = 30;   // only events in the next ~30 days are cached/asked about
const MAX_ICS_BYTES = 5 * 1024 * 1024;

function assertProject(project) {
  if (typeof project !== 'string' || !Object.prototype.hasOwnProperty.call(PROJECTS, project)) {
    const e = new Error(`unknown project '${project}'`);
    e.status = 404;
    throw e;
  }
}

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// Optional deadline link (conference / CFP page). Empty → ''. A bare domain
// ("aeaweb.org/cfp") gets https://. Only http(s) survives — this is rendered as
// a clickable href, so javascript:/data: etc. must never pass.
function normalizeUrl(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (s.length > 2048) throw bad('link too long');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`; // no scheme → assume https
  let u;
  try { u = new URL(s); } catch { throw bad('link is not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('the link must be http(s)');
  return u.href;
}

// ── deadlines (per project) ─────────────────────────────────────────────────

function planFile(project) {
  return path.join(PLAN_DIR, `${project}.json`);
}

// Missing → empty (fresh project). Corrupt must THROW on the write path — a
// later write would otherwise clobber the file (taskStore discipline).
function readPlanFile(project) {
  const file = planFile(project);
  if (!fs.existsSync(file)) return { deadlines: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.deadlines)) {
    throw new Error(`${file} is not a plan file — refusing to touch it`);
  }
  return parsed;
}

function writePlanFile(project, data) {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  writeFileAtomic(planFile(project), JSON.stringify(data, null, 2) + '\n');
}

export function listDeadlines(project) {
  assertProject(project);
  try {
    return readPlanFile(project).deadlines;
  } catch (err) {
    console.error(`[plan] plan/${project}.json unreadable:`, err.message);
    return []; // display path — one corrupt file must not blank the app
  }
}

export function addDeadline(project, fields) {
  assertProject(project);
  const f = fields && typeof fields === 'object' ? fields : {};
  const title = typeof f.title === 'string' ? f.title.trim().slice(0, 200) : '';
  if (!title) throw bad('title is required');
  const date = typeof f.date === 'string' ? f.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw bad('date must be YYYY-MM-DD');
  }
  const url = normalizeUrl(f.url); // optional conference/CFP link; '' if none

  const data = readPlanFile(project); // throws on corrupt — never clobber
  const id = `dl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const deadline = { id, title, date, url, created: new Date().toISOString() };
  data.deadlines.push(deadline);
  writePlanFile(project, data);
  return deadline;
}

export function removeDeadline(project, id) {
  assertProject(project);
  const data = readPlanFile(project);
  const before = data.deadlines.length;
  data.deadlines = data.deadlines.filter((d) => d && d.id !== id);
  if (data.deadlines.length === before) {
    const e = new Error(`unknown deadline '${id}'`);
    e.status = 404;
    throw e;
  }
  writePlanFile(project, data);
  return { ok: true };
}

// ── calendar config (global) ────────────────────────────────────────────────

function defaultCal() {
  return { sources: [], includeAllDay: false, routes: {} };
}

function readCal() {
  if (!fs.existsSync(CAL_FILE)) return defaultCal();
  const parsed = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sources)
    || !parsed.routes || typeof parsed.routes !== 'object') {
    throw new Error(`${CAL_FILE} is not a calendar config — refusing to touch it`);
  }
  return { ...defaultCal(), ...parsed };
}

function readCalSoft() {
  try {
    return readCal();
  } catch (err) {
    console.error('[plan] calendar.json unreadable:', err.message);
    return defaultCal();
  }
}

function writeCal(cal) {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  writeFileAtomic(CAL_FILE, JSON.stringify(cal, null, 2) + '\n');
}

export function addSource({ icsUrl, name } = {}) {
  const url = typeof icsUrl === 'string' ? icsUrl.trim() : '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw bad('not a valid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw bad('the calendar URL must be http(s)');
  if (url.length > 2048) throw bad('URL too long');
  const cal = readCal();
  if (cal.sources.some((s) => s.icsUrl === url)) throw bad('this calendar is already connected');
  const label = (typeof name === 'string' && name.trim() ? name.trim() : `calendar ${cal.sources.length + 1}`).slice(0, 40);
  let id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cal';
  while (cal.sources.some((s) => s.id === id)) id += 'x';
  cal.sources.push({ id, name: label, icsUrl: url });
  writeCal(cal);
  scheduleRefresh(); // fetch soon; the POST response doesn't wait on the network
  return { id, name: label };
}

export function removeSource(id) {
  const cal = readCal();
  const before = cal.sources.length;
  cal.sources = cal.sources.filter((s) => s.id !== id);
  if (cal.sources.length === before) {
    const e = new Error(`unknown source '${id}'`);
    e.status = 404;
    throw e;
  }
  // routes are kept on purpose: re-connecting the same calendar later finds
  // its series already filed (routes are tiny and harmless while orphaned)
  writeCal(cal);
  const cache = readCacheSoft();
  cache.events = cache.events.filter((ev) => ev.src !== id);
  delete (cache.sources || {})[id];
  writeCache(cache);
  return { ok: true };
}

export function setIncludeAllDay(v) {
  const cal = readCal();
  cal.includeAllDay = !!v;
  writeCal(cal);
  scheduleRefresh();
  return { ok: true };
}

export function setRoute(uid, to) {
  const u = typeof uid === 'string' ? uid.trim() : '';
  if (!u || u.length > 512) throw bad('uid required');
  if (to !== 'personal' && !Object.prototype.hasOwnProperty.call(PROJECTS, to)) {
    throw bad(`'to' must be a project key or 'personal'`);
  }
  const cal = readCal();
  cal.routes[u] = { to, filed: new Date().toISOString() };
  writeCal(cal);
  return { ok: true };
}

export function clearRoute(uid) {
  const cal = readCal();
  if (!Object.prototype.hasOwnProperty.call(cal.routes, uid)) {
    const e = new Error('unknown route');
    e.status = 404;
    throw e;
  }
  delete cal.routes[uid];
  writeCal(cal);
  return { ok: true };
}

// ── event cache (disposable) ────────────────────────────────────────────────

function readCacheSoft() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { fetched: null, events: [], sources: {} };
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.events)) return { fetched: null, events: [], sources: {} };
    return { sources: {}, ...parsed };
  } catch {
    return { fetched: null, events: [], sources: {} }; // a cache never blocks anything
  }
}

function writeCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeFileAtomic(CACHE_FILE, JSON.stringify(cache) + '\n');
}

// ── ICS parsing ─────────────────────────────────────────────────────────────
// Minimal but honest RFC 5545 subset: folded lines, escaped text values,
// DTSTART in UTC / zoned (TZID, via Intl — node ships full ICU) / floating /
// all-day, RRULE FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL/COUNT/UNTIL/
// BYDAY(weekly), EXDATE, RECURRENCE-ID overrides, STATUS:CANCELLED.

function unfoldLines(text) {
  const raw = String(text).split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function parseProp(line) {
  // NAME;PARAM=v;PARAM=v:value — params never contain ':' in google feeds;
  // a quoted param value may, so scan honestly.
  let i = 0, inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...paramBits] = head.split(';');
  const params = {};
  for (const p of paramBits) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(v) {
  return String(v).replace(/\\n/gi, ' · ').replace(/\\([,;\\])/g, '$1');
}

// wall-clock in `tz` → UTC ms. Two-pass offset correction handles DST edges.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const wallOf = (ms) => {
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms)) p[part.type] = part.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  let ms = guess - (wallOf(guess) - guess);
  ms -= wallOf(ms) - guess; // second pass: correct across a DST boundary
  return ms;
}

// → { ms, allDay, date? } or null. Floating times use the server's zone.
function parseIcsDate(value, params = {}) {
  const v = String(value).trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { ms: new Date(+m[1], +m[2] - 1, +m[3]).getTime(), allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  if (params.TZID) {
    try {
      return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, +s, params.TZID), allDay: false };
    } catch {
      // unknown zone id — fall through to floating
    }
  }
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
}

export function parseICS(text) {
  const events = [];
  let cur = null;
  for (const line of unfoldLines(text)) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': cur.uid = prop.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(prop.value).trim(); break;
      case 'DTSTART': cur.start = parseIcsDate(prop.value, prop.params); break;
      case 'RRULE': cur.rrule = prop.value.trim(); break;
      case 'STATUS': cur.status = prop.value.trim().toUpperCase(); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseIcsDate(prop.value, prop.params); break;
      case 'EXDATE':
        for (const part of prop.value.split(',')) {
          const d = parseIcsDate(part, prop.params);
          if (d) cur.exdates.push(d.ms);
        }
        break;
      default: break;
    }
  }
  return events.filter((e) => e.uid && e.start);
}

const DAY_MS = 86_400_000;
const BYDAY_IDX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// "↻ weekly" chips: a human label from the RRULE, or null for one-offs
export function recurLabel(rrule) {
  if (!rrule) return null;
  const r = parseRrule(rrule);
  const n = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const base = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[r.FREQ];
  if (!base) return 'recurring';
  if (n === 1) return base;
  if (r.FREQ === 'WEEKLY' && n === 2) return 'biweekly';
  return `every ${n} ${{ DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months', YEARLY: 'years' }[r.FREQ]}`;
}

function parseRrule(text) {
  const r = {};
  for (const part of String(text).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return r;
}

// Occurrence starts (ms) for one VEVENT inside [winStart, winEnd].
export function expandOccurrences(ev, winStart, winEnd) {
  const startMs = ev.start.ms;
  const isEx = (ms) => ev.exdates.some((x) => Math.abs(x - ms) < 1000
    || (ev.start.allDay && Math.abs(x - ms) < DAY_MS));
  if (!ev.rrule) {
    return startMs >= winStart && startMs <= winEnd && !isEx(startMs) ? [startMs] : [];
  }
  const r = parseRrule(ev.rrule);
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    return startMs >= winStart && startMs <= winEnd ? [startMs] : [];
  }
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = r.COUNT ? Math.max(1, parseInt(r.COUNT, 10)) : null;
  let until = null;
  if (r.UNTIL) {
    const u = parseIcsDate(r.UNTIL, {});
    if (u) until = u.allDay ? u.ms + DAY_MS - 1 : u.ms;
  }
  // step in the event's own wall-clock (via a Date in local semantics of the
  // stored ms): recompute each occurrence from calendar fields so months of
  // different lengths and DST shifts can't drift the series.
  const base = new Date(startMs);
  const out = [];
  let made = 0;
  const push = (ms) => {
    if (until !== null && ms > until) return false;
    made++;
    if (ms >= winStart && ms <= winEnd && !isEx(ms) && ms >= startMs) out.push(ms);
    return count === null || made < count;
  };
  if (freq === 'WEEKLY') {
    const days = (r.BYDAY ? r.BYDAY.split(',') : []).map((d) => BYDAY_IDX[d.trim().slice(-2)])
      .filter((d) => d !== undefined);
    const wanted = days.length ? days : [base.getDay()];
    // walk week by week from the start's week; inside a week, each wanted day
    outer:
    for (let week = 0; week < 320; week += interval) {
      const weekBase = startMs + week * 7 * DAY_MS;
      if (until !== null && weekBase - 7 * DAY_MS > until) break;
      if (weekBase > winEnd + 7 * DAY_MS) break;
      for (const wd of [...wanted].sort((a, b) => a - b)) {
        const ms = weekBase + (wd - base.getDay()) * DAY_MS;
        if (ms < startMs) continue;
        if (!push(ms)) break outer;
      }
    }
  } else {
    const stepUnit = { DAILY: null, MONTHLY: 'month', YEARLY: 'year' }[freq];
    for (let i = 0; i < 1000; i++) {
      let ms;
      if (freq === 'DAILY') {
        ms = startMs + i * interval * DAY_MS;
      } else {
        const d = new Date(base.getTime());
        if (stepUnit === 'month') d.setMonth(d.getMonth() + i * interval);
        else d.setFullYear(d.getFullYear() + i * interval);
        if (d.getDate() !== base.getDate()) continue; // Feb 30 → skip, not drift
        ms = d.getTime();
      }
      if (ms > winEnd || (until !== null && ms > until)) break;
      if (!push(ms)) break;
    }
  }
  return out;
}

// ── the refresh loop ────────────────────────────────────────────────────────

let refreshTimer = null;
let inFlight = null;
let pending = false;

async function fetchOne(source, cal, winStart, winEnd) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.icsUrl, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_ICS_BYTES) throw new Error('feed too large');
    const parsed = parseICS(text);

    // RECURRENCE-ID overrides replace one instance of their master series
    const overridden = new Map(); // uid → Set(original start ms)
    for (const ev of parsed) {
      if (ev.recurrenceId) {
        if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
        overridden.get(ev.uid).add(ev.recurrenceId.ms);
      }
    }
    const events = [];
    for (const ev of parsed) {
      if (ev.status === 'CANCELLED') continue;
      if (ev.start.allDay && !cal.includeAllDay) continue;
      const skip = !ev.recurrenceId ? overridden.get(ev.uid) : null;
      for (const ms of expandOccurrences(ev, winStart, winEnd)) {
        if (skip && skip.has(ms)) continue;
        events.push({
          uid: ev.uid,
          src: source.id,
          title: (ev.summary || '(untitled)').slice(0, 200),
          start: new Date(ms).toISOString(),
          allDay: !!ev.start.allDay,
          recurring: recurLabel(ev.rrule),
        });
      }
    }
    return { events, error: null };
  } finally {
    clearTimeout(t);
  }
}

export async function refreshCal() {
  if (inFlight) { pending = true; return inFlight; }
  inFlight = (async () => {
    try {
      const cal = readCalSoft();
      if (!cal.sources.length) {
        writeCache({ fetched: new Date().toISOString(), events: [], sources: {} });
        return;
      }
      const prev = readCacheSoft();
      const now = new Date();
      const winStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const winEnd = winStart + HORIZON_DAYS * DAY_MS;
      const events = [];
      const srcStatus = {};
      for (const source of cal.sources) {
        try {
          const r = await fetchOne(source, cal, winStart, winEnd);
          events.push(...r.events);
          srcStatus[source.id] = { count: r.events.length, error: null, fetched: new Date().toISOString() };
        } catch (err) {
          // stale beats blank: keep the source's previous pull on a bad fetch
          const kept = prev.events.filter((ev) => ev.src === source.id);
          events.push(...kept);
          srcStatus[source.id] = {
            count: kept.length,
            error: String(err.message || err).slice(0, 200),
            fetched: prev.sources?.[source.id]?.fetched || null,
          };
          console.error(`[plan] calendar fetch failed (${source.id}):`, err.message);
        }
      }
      events.sort((a, b) => a.start.localeCompare(b.start));
      writeCache({ fetched: new Date().toISOString(), events, sources: srcStatus });
      broadcast('plan:update', {});
    } catch (err) {
      console.error('[plan] refresh error:', err.message);
    } finally {
      inFlight = null;
      if (pending) { pending = false; scheduleRefresh(); }
    }
  })();
  return inFlight;
}

let scheduleT = null;
function scheduleRefresh() {
  // debounce bursts (add source + toggle all-day) into one fetch
  clearTimeout(scheduleT);
  scheduleT = setTimeout(() => { refreshCal(); }, 300);
  if (typeof scheduleT.unref === 'function') scheduleT.unref();
}

export function initPlan() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (readCalSoft().sources.length) refreshCal();
  }, POLL_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  if (readCalSoft().sources.length) scheduleRefresh();
}

// ── the snapshot ────────────────────────────────────────────────────────────
// NOTE: source icsUrls are SECRETS (anyone with one can read the calendar) —
// they are never included here, so no /api/state response ever carries them.

export function getPlanSnapshot() {
  const deadlines = {};
  for (const key of Object.keys(PROJECTS)) deadlines[key] = listDeadlines(key);
  const cal = readCalSoft();
  const cache = readCacheSoft();
  return {
    deadlines,
    cal: {
      sources: cal.sources.map((s) => ({
        id: s.id,
        name: s.name || s.id,
        ...(cache.sources?.[s.id] || { count: 0, error: null, fetched: null }),
      })),
      includeAllDay: !!cal.includeAllDay,
      routes: cal.routes,
      events: cache.events,
      fetched: cache.fetched,
    },
  };
}
