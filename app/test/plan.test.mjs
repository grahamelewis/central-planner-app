// lib/plan.js unit tests — deadline store, calendar config/routes, and the
// ICS engine (parse + recurrence expansion). CP_ROOT/CP_PROJECTS_JSON are
// pinned to a throwaway dir BEFORE the dynamic import (config.js reads them
// at import time — the kaimon.test lesson). Pure fs + parsing; no network,
// nothing billed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let plan;
let ROOT;

before(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-plan-'));
  process.env.CP_ROOT = ROOT;
  process.env.CP_PROJECTS_JSON = JSON.stringify({
    alpha: { name: 'alpha', root: path.join(ROOT, 'pa') },
    beta: { name: 'beta', root: path.join(ROOT, 'pb') },
  });
  plan = await import('../lib/plan.js');
});

// ── deadlines ───────────────────────────────────────────────────────────────

test('deadline CRUD: add validates, persists, lists, removes; a bare-domain link gets https', () => {
  const d = plan.addDeadline('alpha', { title: '  AEA submission ', date: '2026-08-14', url: 'aeaweb.org/cfp' });
  assert.ok(d.id.startsWith('dl_'));
  assert.equal(d.title, 'AEA submission');
  assert.equal(d.url, 'https://aeaweb.org/cfp'); // bare domain → https, no time/kind fields
  assert.equal(d.time, undefined);
  assert.equal(d.kind, undefined);
  const listed = plan.listDeadlines('alpha');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, d.id);
  // persisted on disk under ROOT/plan/
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'plan', 'alpha.json'), 'utf8'));
  assert.equal(onDisk.deadlines[0].title, 'AEA submission');
  plan.removeDeadline('alpha', d.id);
  assert.equal(plan.listDeadlines('alpha').length, 0);
});

test('a deadline with no link stores url:"" and keeps it', () => {
  const d = plan.addDeadline('alpha', { title: 'no link', date: '2026-09-01' });
  assert.equal(d.url, '');
  plan.removeDeadline('alpha', d.id);
});

test('deadline validation: bad date / bad link / project / missing title all refuse', () => {
  assert.throws(() => plan.addDeadline('alpha', { title: 'x', date: '14-08-2026' }), /YYYY-MM-DD/);
  assert.throws(() => plan.addDeadline('alpha', { title: 'x', date: '2026-08-14', url: 'javascript:alert(1)' }), /http/);
  assert.throws(() => plan.addDeadline('alpha', { date: '2026-08-14' }), /title/);
  assert.throws(() => plan.addDeadline('nope', { title: 'x', date: '2026-08-14' }), /unknown project/);
  assert.throws(() => plan.removeDeadline('alpha', 'dl_ghost'), /unknown deadline/);
});

test('a corrupt plan file refuses writes instead of clobbering', () => {
  const file = path.join(ROOT, 'plan', 'beta.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.throws(() => plan.addDeadline('beta', { title: 'x', date: '2026-08-14' }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json'); // untouched
  assert.deepEqual(plan.listDeadlines('beta'), []); // display path degrades soft
  fs.rmSync(file);
});

// ── calendar config + routes ────────────────────────────────────────────────

test('sources: validate URL, dedupe, name → id slug; snapshot NEVER leaks the url', () => {
  assert.throws(() => plan.addSource({ icsUrl: 'not a url' }), /valid URL/);
  assert.throws(() => plan.addSource({ icsUrl: 'file:///etc/passwd' }), /http/);
  const s = plan.addSource({ icsUrl: 'https://example.com/secret/basic.ics', name: 'Work Cal' });
  assert.equal(s.id, 'work-cal');
  assert.throws(() => plan.addSource({ icsUrl: 'https://example.com/secret/basic.ics' }), /already/);
  const snap = plan.getPlanSnapshot();
  assert.equal(snap.cal.sources.length, 1);
  assert.equal(snap.cal.sources[0].name, 'Work Cal');
  assert.ok(!JSON.stringify(snap).includes('example.com'), 'secret ics URL must not appear in any snapshot');
  plan.removeSource('work-cal');
  assert.equal(plan.getPlanSnapshot().cal.sources.length, 0);
});

test('routes: file to a project or personal; unknown targets refuse; clear works', () => {
  plan.setRoute('uid1@google.com', 'alpha');
  plan.setRoute('uid2@google.com', 'personal');
  assert.throws(() => plan.setRoute('uid3@google.com', 'nonproject'), /project key or 'personal'/);
  const snap = plan.getPlanSnapshot();
  assert.equal(snap.cal.routes['uid1@google.com'].to, 'alpha');
  assert.equal(snap.cal.routes['uid2@google.com'].to, 'personal');
  plan.clearRoute('uid1@google.com');
  assert.ok(!plan.getPlanSnapshot().cal.routes['uid1@google.com']);
  assert.throws(() => plan.clearRoute('uid1@google.com'), /unknown route/);
  plan.clearRoute('uid2@google.com');
});

// ── ICS parsing ─────────────────────────────────────────────────────────────

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:folded@test',
  'SUMMARY:advisor meeting — a very long line that google',
  ' folds onto the next line\\, with an escaped comma',
  'DTSTART;TZID=America/New_York:20260723T140000',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:utc@test',
  'SUMMARY:one-off utc',
  'DTSTART:20260730T160000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday@test',
  'SUMMARY:conference day',
  'DTSTART;VALUE=DATE:20260801',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gone@test',
  'SUMMARY:cancelled thing',
  'STATUS:CANCELLED',
  'DTSTART:20260730T160000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseICS: folding, escaped text, zoned/UTC/all-day starts, status', () => {
  const evs = plan.parseICS(ICS);
  assert.equal(evs.length, 4);
  const folded = evs.find((e) => e.uid === 'folded@test');
  assert.equal(folded.summary, 'advisor meeting — a very long line that googlefolds onto the next line, with an escaped comma');
  // 14:00 America/New_York in July = 18:00 UTC (EDT)
  assert.equal(new Date(folded.start.ms).toISOString(), '2026-07-23T18:00:00.000Z');
  assert.equal(folded.rrule, 'FREQ=WEEKLY');
  const utc = evs.find((e) => e.uid === 'utc@test');
  assert.equal(new Date(utc.start.ms).toISOString(), '2026-07-30T16:00:00.000Z');
  assert.equal(utc.start.allDay, false);
  const ad = evs.find((e) => e.uid === 'allday@test');
  assert.equal(ad.start.allDay, true);
  assert.equal(evs.find((e) => e.uid === 'gone@test').status, 'CANCELLED');
});

test('recurLabel: weekly / biweekly / every-N / one-off', () => {
  assert.equal(plan.recurLabel('FREQ=WEEKLY'), 'weekly');
  assert.equal(plan.recurLabel('FREQ=WEEKLY;INTERVAL=2'), 'biweekly');
  assert.equal(plan.recurLabel('FREQ=MONTHLY'), 'monthly');
  assert.equal(plan.recurLabel('FREQ=DAILY;INTERVAL=3'), 'every 3 days');
  assert.equal(plan.recurLabel(null), null);
});

// ── recurrence expansion ────────────────────────────────────────────────────

const D = 86400000;
const at = (iso) => Date.parse(iso);

test('weekly expansion honours BYDAY, INTERVAL, COUNT, UNTIL, EXDATE', () => {
  const win = [at('2026-07-01T00:00:00Z'), at('2026-08-31T00:00:00Z')];
  // weekly Thu meeting starting Jul 2 (Thu), UTC for determinism
  const ev = (rrule, exdates = []) => ({
    uid: 'x', start: { ms: at('2026-07-02T15:00:00Z'), allDay: false }, rrule, exdates,
  });
  const weekly = plan.expandOccurrences(ev('FREQ=WEEKLY'), ...win);
  assert.equal(weekly.length, 9); // Jul 2..Aug 27, every Thursday
  assert.equal(new Date(weekly[1]).toISOString(), '2026-07-09T15:00:00.000Z');

  const biweekly = plan.expandOccurrences(ev('FREQ=WEEKLY;INTERVAL=2'), ...win);
  assert.equal(biweekly.length, 5); // Jul 2, 16, 30, Aug 13, 27

  const counted = plan.expandOccurrences(ev('FREQ=WEEKLY;COUNT=3'), ...win);
  assert.equal(counted.length, 3);

  const until = plan.expandOccurrences(ev('FREQ=WEEKLY;UNTIL=20260716T235959Z'), ...win);
  assert.equal(until.length, 3); // Jul 2, 9, 16

  const ex = plan.expandOccurrences(ev('FREQ=WEEKLY;COUNT=3', [at('2026-07-09T15:00:00Z')]), ...win);
  assert.equal(ex.length, 2, 'EXDATE removes exactly its instance');

  // BYDAY MO,WE from a Monday start
  const mw = plan.expandOccurrences({
    uid: 'y', start: { ms: at('2026-07-06T09:00:00Z'), allDay: false },
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', exdates: [],
  }, ...win);
  assert.equal(mw.length, 4);
  assert.deepEqual(mw.map((m) => new Date(m).getUTCDay()), [1, 3, 1, 3]);
});

test('monthly expansion skips short months instead of drifting', () => {
  const occ = plan.expandOccurrences({
    uid: 'm', start: { ms: new Date(2026, 0, 31, 10, 0, 0).getTime(), allDay: false },
    rrule: 'FREQ=MONTHLY', exdates: [],
  }, new Date(2026, 0, 1).getTime(), new Date(2026, 4, 1).getTime());
  // Jan 31, Mar 31 — February has no 31st and must be SKIPPED, not drifted
  assert.deepEqual(occ.map((m) => `${new Date(m).getMonth() + 1}/${new Date(m).getDate()}`), ['1/31', '3/31']);
});

test('one-off events: in-window only; window excludes the past', () => {
  const ev = { uid: 'o', start: { ms: at('2026-07-10T12:00:00Z'), allDay: false }, exdates: [] };
  assert.equal(plan.expandOccurrences(ev, at('2026-07-01T00:00:00Z'), at('2026-08-01T00:00:00Z')).length, 1);
  assert.equal(plan.expandOccurrences(ev, at('2026-07-11T00:00:00Z'), at('2026-08-01T00:00:00Z')).length, 0);
});
