// /api/plan — deadlines, calendar sources, filing routes, refresh. The .ics
// feed comes from a throwaway LOCAL http server (no external network); every
// route here is unbilled by design.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startSandbox } from './serverHarness.mjs';

let sb;
let icsSrv;
let icsUrl;

// events land inside the 30-day horizon regardless of when the test runs
function utcStamp(daysAhead, h = 14) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(h)}0000Z`;
}
function dateStamp(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

const ICS = () => [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:advisor@test',
  'SUMMARY:advisor meeting',
  `DTSTART:${utcStamp(3)}`,
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:talk@test',
  'SUMMARY:macro lunch talk',
  `DTSTART:${utcStamp(6, 16)}`,
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:conf@test',
  'SUMMARY:conference day',
  `DTSTART;VALUE=DATE:${dateStamp(9)}`,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

before(async () => {
  icsSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(ICS());
  });
  await new Promise((r) => icsSrv.listen(0, '127.0.0.1', r));
  icsUrl = `http://127.0.0.1:${icsSrv.address().port}/basic.ics`;
  sb = await startSandbox({});
});
after(async () => {
  if (sb) await sb.stop();
  icsSrv?.close();
});

test('deadlines: create → snapshot → delete; refusal paths', async () => {
  const r = await sb.fetchJson('POST', '/api/plan/alpha/deadlines', {
    title: 'AEA submission', date: '2026-08-14', url: 'www.aeaweb.org/cfp',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;

  const st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.deadlines.alpha.length, 1);
  assert.equal(st.body.plan.deadlines.alpha[0].title, 'AEA submission');
  assert.equal(st.body.plan.deadlines.alpha[0].url, 'https://www.aeaweb.org/cfp', 'the link is normalized and stored');
  assert.deepEqual(st.body.plan.deadlines.beta, []);

  const bad = await sb.fetchJson('POST', '/api/plan/alpha/deadlines', { title: 'x', date: 'Aug 14' });
  assert.equal(bad.status, 400);
  const noProj = await sb.fetchJson('POST', '/api/plan/ghost/deadlines', { title: 'x', date: '2026-08-14' });
  assert.equal(noProj.status, 404);

  const del = await sb.fetchJson('DELETE', `/api/plan/alpha/deadlines/${id}`);
  assert.equal(del.status, 200);
  const gone = await sb.fetchJson('DELETE', `/api/plan/alpha/deadlines/${id}`);
  assert.equal(gone.status, 404);
});

test('sources: connect fetches the feed; events land; the secret URL never leaves the server', async () => {
  const r = await sb.fetchJson('POST', '/api/plan/cal/sources', { icsUrl, name: 'work' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, 'work');

  const st = await sb.poll('/api/state', (s) => (s.plan?.cal?.events || []).length >= 2, { timeoutMs: 15000, everyMs: 200 });
  const events = st.plan.cal.events;
  const advisor = events.filter((e) => e.uid === 'advisor@test');
  assert.ok(advisor.length >= 4, `weekly series expanded across the horizon (${advisor.length})`);
  assert.equal(advisor[0].recurring, 'weekly');
  assert.equal(events.filter((e) => e.uid === 'talk@test').length, 1);
  assert.equal(events.filter((e) => e.uid === 'conf@test').length, 0, 'all-day excluded by default');
  assert.equal(st.plan.cal.sources[0].error, null);
  assert.ok(st.plan.cal.sources[0].count >= 2);
  assert.ok(!JSON.stringify(st.plan).includes('127.0.0.1'), 'ics URL (a secret) must never appear in /api/state');

  const dup = await sb.fetchJson('POST', '/api/plan/cal/sources', { icsUrl });
  assert.equal(dup.status, 400);
  const badUrl = await sb.fetchJson('POST', '/api/plan/cal/sources', { icsUrl: 'file:///etc/passwd' });
  assert.equal(badUrl.status, 400);
});

test('includeAllDay: toggling refetches and admits the all-day event', async () => {
  const r = await sb.fetchJson('PATCH', '/api/plan/cal', { includeAllDay: true });
  assert.equal(r.status, 200);
  const st = await sb.poll('/api/state', (s) => (s.plan?.cal?.events || []).some((e) => e.uid === 'conf@test'),
    { timeoutMs: 15000, everyMs: 200 });
  const conf = st.plan.cal.events.find((e) => e.uid === 'conf@test');
  assert.equal(conf.allDay, true);
});

test('filing: route a series, see it in state, unfile it; bad targets refuse', async () => {
  const r = await sb.fetchJson('POST', '/api/plan/cal/route', { uid: 'advisor@test', to: 'alpha' });
  assert.equal(r.status, 200);
  let st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.cal.routes['advisor@test'].to, 'alpha');

  const bad = await sb.fetchJson('POST', '/api/plan/cal/route', { uid: 'talk@test', to: 'ghost' });
  assert.equal(bad.status, 400);

  const personal = await sb.fetchJson('POST', '/api/plan/cal/route', { uid: 'talk@test', to: 'personal' });
  assert.equal(personal.status, 200);

  const un = await sb.fetchJson('DELETE', `/api/plan/cal/route?uid=${encodeURIComponent('talk@test')}`);
  assert.equal(un.status, 200);
  st = await sb.fetchJson('GET', '/api/state');
  assert.ok(!st.body.plan.cal.routes['talk@test']);
  assert.equal(st.body.plan.cal.routes['advisor@test'].to, 'alpha'); // untouched
});

test('a dead feed keeps the stale cache instead of blanking (and reports the error)', async () => {
  const before2 = await sb.fetchJson('GET', '/api/state');
  const hadEvents = before2.body.plan.cal.events.length;
  assert.ok(hadEvents > 0);
  icsSrv.close(); // the calendar goes unreachable
  await new Promise((r) => setTimeout(r, 50));
  const rf = await sb.fetchJson('POST', '/api/plan/cal/refresh');
  assert.equal(rf.status, 200);
  const st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.cal.events.length, hadEvents, 'stale beats blank');
  assert.ok(st.body.plan.cal.sources[0].error, 'the failure is reported on the source');
});

test('removing the source drops its events but keeps the filings', async () => {
  const r = await sb.fetchJson('DELETE', '/api/plan/cal/sources/work');
  assert.equal(r.status, 200);
  const st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.cal.sources.length, 0);
  assert.equal(st.body.plan.cal.events.length, 0);
  assert.equal(st.body.plan.cal.routes['advisor@test'].to, 'alpha', 'filings survive a reconnect');
});
