// ◆ Next up (workbench sidebar) + the ⧉ Calendar page — stage-1 planning.
// Seeded plan/cache files, real (unbilled) /api/plan calls through the
// sandbox server; the WS is stubbed so the UI's own post-mutation loadState
// is what keeps the page current (also the production instant-echo path).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };

const D = 86400000;
const iso = (days, h = 14) => { const d = new Date(Date.now() + days * D); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const ymd = (days) => { const d = new Date(Date.now() + days * D); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const dayDiff = (days) => Math.round((new Date(new Date(Date.now() + days * D).setHours(0, 0, 0, 0))
  - new Date(new Date().setHours(0, 0, 0, 0))) / D);

let ui, sb, page;
before(async () => {
  if (!fs.existsSync(CHROME)) return;
  ui = await startUI({
    seed: ({ root }) => {
      fs.mkdirSync(path.join(root, 'plan'), { recursive: true });
      fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
      fs.writeFileSync(path.join(root, 'plan', 'alpha.json'), JSON.stringify({
        deadlines: [{ id: 'dl_aea', title: 'AEA submission', date: ymd(28), url: 'https://www.aeaweb.org/', created: iso(0) }],
      }));
      fs.writeFileSync(path.join(root, 'plan', 'calendar.json'), JSON.stringify({
        sources: [], includeAllDay: false,
        routes: {
          'advisor@t': { to: 'alpha', filed: iso(0) },
          'talk@t': { to: 'alpha', filed: iso(0) },
        },
      }));
      fs.writeFileSync(path.join(root, '.cache', 'gcal.json'), JSON.stringify({
        fetched: iso(0),
        events: [
          { uid: 'volley@t', src: 'personal', title: 'pickup volleyball', start: iso(2, 12), allDay: false, recurring: 'weekly' },
          { uid: 'advisor@t', src: 'work', title: 'advisor meeting', start: iso(6), allDay: false, recurring: 'weekly' },
          { uid: 'talk@t', src: 'work', title: 'macro lunch talk', start: iso(13, 12), allDay: false, recurring: null },
        ],
        sources: {},
      }));
    },
  });
  ({ sb, page } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Crosswalk', category: 'calibration', oversight: 'manual',
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .nuRow', { timeout: 15000 });
  await sleep(200);
});
after(async () => { if (ui) await ui.stop(); });

const railState = () => page.evaluate(() => ({
  rows: [...document.querySelectorAll('#v-alpha .nuRow')].map((r) => ({
    title: r.querySelector('.nuWhat .t')?.textContent,
    n: r.querySelector('.nuN')?.textContent.trim(),
    cls: r.querySelector('.nuN')?.className,
  })),
  unfiled: document.querySelector('#nuUnfiled')?.textContent.trim() || null,
}));

test('◆ next up: three merged rows in order — meetings slate, deadlines pink; the unfiled chip counts series', opts, async () => {
  const s = await railState();
  assert.equal(s.rows.length, 3, JSON.stringify(s.rows));
  assert.deepEqual(s.rows.map((r) => r.title), ['advisor meeting', 'macro lunch talk', 'AEA submission']);
  assert.equal(s.rows[0].n, `${dayDiff(6)}DAYS`);
  assert.equal(s.rows[2].n, `${dayDiff(28)}DAYS`);
  assert.match(s.rows[0].cls, /\bmt\b/, 'meeting number is slate');
  assert.match(s.rows[2].cls, /\bdl\b/, 'deadline number is pink');
  assert.equal(s.unfiled, '⧉ 1 unfiled', 'one unfiled SERIES (volleyball), not per-instance');
});

test('＋ adds a deadline through the inline panel; hover-× removes it', opts, async () => {
  await page.click('#v-alpha #nuAddBtn');
  await page.waitForSelector('#v-alpha .nuPick', { timeout: 5000 });
  await page.evaluate((d) => {
    document.querySelector('#nuTitle').value = 'grant report';
    document.querySelector('#nuDate').value = d;
  }, ymd(4));
  await page.click('#v-alpha #nuAdd');
  await sleep(600); // POST + loadState + renderWB
  let s = await railState();
  assert.equal(s.rows[0].title, 'grant report', `new deadline sorts first (${JSON.stringify(s.rows)})`);
  assert.match(s.rows[0].cls, /\bdl\b/);

  // × (hover affordance — click it directly) deletes server-side
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .nuRow')]
      .find((r) => r.textContent.includes('grant report'))
      .querySelector('.nuX').click();
  });
  await sleep(600);
  s = await railState();
  assert.ok(!s.rows.some((r) => r.title === 'grant report'), 'deleted row gone');
  const st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.deadlines.alpha.length, 1, 'server kept only the seeded deadline');
});

test('the unfiled chip opens ⧉ Calendar; filing a series moves it and clears the chip', opts, async () => {
  await page.click('#v-alpha #nuUnfiled');
  await page.waitForSelector('#v-plan.show .planFileCard', { timeout: 5000 });
  const row = await page.evaluate(() => document.querySelector('#v-plan .planFileCard')?.textContent || '');
  assert.match(row, /pickup volleyball/, 'the unfiled series is offered for filing');

  // filing to a project is now a <select> change (Personal/Skip stay clicks)
  await page.evaluate(() => {
    const sel = document.querySelector('#v-plan [data-filesel]');
    sel.value = 'beta';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(600);
  const after2 = await page.evaluate(() => ({
    unfiledRows: document.querySelectorAll('#v-plan .planFileCard').length,
    filed: [...document.querySelectorAll('#v-plan .planFiled')].map((f) => f.textContent),
  }));
  assert.equal(after2.unfiledRows, 0, 'nothing left to file');
  assert.ok(after2.filed.some((f) => f.includes('pickup volleyball') && f.includes('beta')), JSON.stringify(after2.filed));

  // back in the alpha workbench: the chip is gone, and beta's meeting stays out of alpha's rail
  await page.evaluate(() => { document.querySelector('#nav .tab[data-v="alpha"]')?.click(); });
  await sleep(400);
  const s = await railState();
  assert.equal(s.unfiled, null, 'no unfiled chip once everything is filed');
  assert.ok(!s.rows.some((r) => r.title === 'pickup volleyball'), 'a series filed to beta never shows in alpha');
});

test('the plan page lists every deadline with a ⤴ prefilled Google link; nav has ⧉ Calendar, no ⊞ categories', opts, async () => {
  await page.evaluate(() => { document.querySelector('#nav .tab[data-v="plan"]')?.click(); });
  await sleep(300);
  const dl = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#v-plan .planDl')].find((r) => r.textContent.includes('AEA submission'));
    return row ? { text: row.textContent, href: row.querySelector('.planDlGcal')?.getAttribute('href') } : null;
  });
  assert.ok(dl, 'the seeded deadline is listed');
  assert.match(dl.href, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=AEA%20submission&dates=\d{8}\/\d{8}$/,
    `computed template link, no token (${dl.href})`);
  assert.match(dl.text, /[A-Z][a-z]{2} \d{1,2}, \d{4}/, `friendly date shown (${dl.text})`);
  assert.doesNotMatch(dl.text, /\d{4}-\d{2}-\d{2}/, 'no ISO date, no recurrence text');
  const nav = await page.evaluate(() => ({
    plan: !!document.querySelector('#nav .tab[data-v="plan"]'),
    cats: !!document.querySelector('#nav .tab[data-v="cats"]'),
  }));
  assert.equal(nav.plan, true);
  assert.equal(nav.cats, false, 'the ⊞ categories top-bar shortcut is gone (editor stays in the profile menu)');
});

test('deadlines are addable ON the plan page; section headers carry no glyphs', opts, async () => {
  const heads = await page.evaluate(() => ({
    h2: document.querySelector('#v-plan .planHead .planTitle')?.textContent.trim(),
    shs: [...document.querySelectorAll('#v-plan .planSec .planSecHead h2')]
      .map((s) => s.textContent.trim()),
  }));
  assert.equal(heads.h2, 'Calendar');
  assert.deepEqual(heads.shs, ['Deadlines', 'Meetings', 'Calendars'], 'plain professional headers');

  await page.evaluate((d) => {
    document.querySelector('#pdProj').value = 'beta';
    document.querySelector('#pdTitle').value = 'referee report';
    document.querySelector('#pdDate').value = d;
    document.querySelector('#pdLink').value = 'example.org/referee';
  }, ymd(10));
  await page.click('#v-plan #pdAdd');
  await sleep(600);
  const row = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#v-plan .planDl')].find((x) => x.textContent.includes('referee report'));
    return r ? { text: r.textContent, href: r.querySelector('.planDlLink')?.getAttribute('href') } : null;
  });
  assert.ok(row, 'the new deadline is listed');
  assert.match(row.text, /↗ example\.org/, 'the link host is shown on the row');
  assert.match(row.text, /[A-Z][a-z]{2} \d{1,2}, \d{4}/, 'the friendly date is shown on the row');
  assert.doesNotMatch(row.text, /\d{4}-\d{2}-\d{2}/, 'no ISO date, no recurrence text');
  assert.equal(row.href, 'https://example.org/referee', 'the clickable link is the normalized url');
  const st = await sb.fetchJson('GET', '/api/state');
  assert.equal(st.body.plan.deadlines.beta.length, 1);
  assert.equal(st.body.plan.deadlines.beta[0].url, 'https://example.org/referee');
});
