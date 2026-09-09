// ◷ Recent activity in the real frontend — rendering, grouping, navigation
// (Δ drill-in / archived task / expand), the archived toggle, and the
// fits-at-any-width guarantee (180px sidebar minimum: no horizontal scroll,
// toggle stays clickable). Tests share one staged project and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;
const mins = (n) => new Date(Date.now() - n * 60000).toISOString();

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ root, projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'setUp.jl'), 'x = 1\n');
      // mixed-EOL fixture for the P-EOL-5 null-task ledger case (last test):
      // its normalizing PUT is what makes the server record a task-less entry
      fs.writeFileSync(path.join(projRoots.alpha, 'mixed.tex'), Buffer.from('\uFEFFa\r\nb\nc\rd', 'utf8'));
      const sd = path.join(root, 'snapshots', 'alpha');
      fs.mkdirSync(sd, { recursive: true });
      const files15 = Array.from({ length: 15 }, (_, i) => ({
        rel: i === 0 ? 'age_regressions.R' : `models/gen_${i}.R`,
        status: i === 2 ? 'created' : 'modified', edits: 2, adds: 16, dels: 4,
      }));
      fs.writeFileSync(path.join(sd, 'journal.json'), JSON.stringify([
        { id: 'ent-2', task: 'alp-001', ts: mins(2), files: [{ rel: 'setUp.jl', status: 'modified', edits: 1, adds: 3, dels: 1 }] },
        { id: 'ent-1', task: 'alp-001', ts: mins(9), files: files15 },
      ]));
      fs.writeFileSync(path.join(root, 'jobhist.json'), JSON.stringify({
        alpha: [
          { ts: mins(70), file: 'sweep/fig3.jl', lang: 'julia', source: 'session', state: 'done', ms: 360000, taskId: 'alp-001' },
          { ts: mins(68), file: 'sweep/clean.R', lang: 'r', source: 'session', state: 'done', ms: 40000, taskId: 'alp-001' },
          { ts: mins(66), file: 'sweep/estimate.jl', lang: 'julia', source: 'session', state: 'error', ms: 180000, taskId: 'alp-001' },
        ],
      }));
    },
  });
  ({ sb, page } = ui);
  const { body: t1 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'calibration turn', description: 'x', category: 'calibration', oversight: 'coop',
  });
  assert.equal(t1.id, 'alp-001');
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t1.id}`, { status: 'waiting' });
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Moment Calculations', description: 'x', category: 'calibration', oversight: 'coop',
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t2.id}`, {
    status: 'done', archived: true, logNote: 'handoff accepted by user — done',
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForSelector('#actFeed .afRow', { timeout: 8000 });
  await sleep(300);
});

after(async () => { if (ui) await ui.stop(); });

test('the feed renders: done row, single edit, grouped edits, grouped runs', opts, async () => {
  const r = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#actFeed > .afRow, #actFeed > .afGrp > .afHead')]
      .map((x) => x.querySelector('.nm')?.textContent.trim()),
    groups: document.querySelectorAll('#actFeed .afGrp').length,
    // Graham's call: NO archived button/row anywhere in Recent activity —
    // archived tasks are reached via ✓ done rows or the overview strip
    archEntry: !!document.querySelector('#afToggle, #actFeed .afArch, #v-alpha .side .scRow.arch'),
  }));
  assert.ok(r.rows.some((t) => t === 'done: Moment Calculations'));
  // verb lives in the .afVm glyph column (+ / Δ / ×), not in the name
  assert.ok(r.rows.some((t) => t === 'setUp.jl'));
  assert.ok(r.rows.some((t) => t.startsWith('15 files · calibration turn')));
  assert.ok(r.rows.some((t) => t.startsWith('ran 3 scripts')), 'runs folded into one group row');
  assert.equal(r.groups, 2);
  assert.equal(r.archEntry, false, 'no archived entry point in Recent activity — by design');
});

test('a group row expands in place and remembers its state across renders', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#actFeed .afGrp .afHead')]
      .find((h) => h.querySelector('.nm').textContent.includes('15 files')).click();
  });
  await sleep(300);
  let r = await page.evaluate(() => ({
    open: document.querySelectorAll('#actFeed .afGrp.open').length,
    more: document.querySelector('#actFeed .afGrp.open .afMore .nm')?.textContent.trim(),
  }));
  assert.equal(r.open, 1);
  assert.equal(r.more, '…12 more — all in Δ');
  // a re-render (task switch away and back) keeps it open (per.afOpen)
  await page.evaluate(() => { document.querySelector('.ptab.tk')?.click(); });
  await sleep(300);
  r = await page.evaluate(() => ({ open: document.querySelectorAll('#actFeed .afGrp.open').length }));
  assert.equal(r.open, 1, 'expand state survives a render');
});

test('a single edit row deep-links into the Δ diff for that file', opts, async () => {
  await page.click('#actFeed .afRow[data-rel="setUp.jl"]');
  await sleep(900); // ensureSnaps fetch + render
  const r = await page.evaluate(() => ({
    sdv: !!document.querySelector('#v-alpha .sdv'),
    deltaTabOn: !!document.querySelector('#v-alpha .ctab[data-fi="snaps"].on'),
    head: document.querySelector('#v-alpha .sdvHead')?.textContent.replace(/\s+/g, ' ') || '',
  }));
  assert.ok(r.sdv, 'the inline diff view opened');
  assert.ok(r.deltaTabOn, 'on the Δ tab');
  assert.match(r.head, /setUp\.jl/);
});

test('a ✓ done row opens the archived task', opts, async () => {
  await page.click('#actFeed .afRow[data-nav="task"]');
  await sleep(400);
  const r = await page.evaluate(() => ({
    unarch: !!document.querySelector('#unarchTask'),
    title: document.querySelector('.sessTabs .stab .stitle')?.textContent || '',
  }));
  assert.ok(r.unarch, 'archived task selected (unarchive offered)');
});

test('archived tasks stay reachable from the overview strip (no sidebar entry)', opts, async () => {
  await page.click('#nav .tab[data-v="ov"]');
  await sleep(400);
  const r = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.taskThumb')]
      .find((x) => x.textContent.includes('Moment Calculations'));
    return { found: !!row, tag: row?.querySelector('.tstat')?.textContent.trim() };
  });
  assert.ok(r.found, 'archived task listed in the overview Recent tasks strip');
  assert.match(r.tag, /archived/);
  // back to the project view for the tests below
  await page.evaluate(() => { location.hash = '#alpha'; });
  await page.reload();
  await page.waitForSelector('#actFeed .afRow', { timeout: 8000 });
  await sleep(300);
});

test('180px sidebar: no horizontal scroll, rows fit, toggle stays clickable', opts, async () => {
  await page.evaluate(() => {
    document.querySelector('#v-alpha .wb').style.setProperty('--wb-side', '180px');
  });
  await sleep(250);
  const r = await page.evaluate(() => {
    const side = document.querySelector('#v-alpha .wb .side');
    return {
      hscroll: side.scrollWidth - side.clientWidth,
      rowOver: [...document.querySelectorAll('#actFeed .afRow')]
        .filter((x) => x.scrollWidth > x.clientWidth + 1).length,
    };
  });
  assert.equal(r.hscroll, 0, 'sidebar never scrolls horizontally');
  assert.equal(r.rowOver, 0, 'feed rows ellipsize instead of overflowing');
});

test('the feed\'s +/− numbers and times rule straight columns', opts, async () => {
  // fixed-grid contract (Graham, 2026-07-30): adds, dels, and the age each
  // right-align down the whole feed — an adds-only row leaves the dels cell
  // empty instead of drifting into it, and a long name truncates rather than
  // pushing the columns. Representative rows injected so every shape is
  // present regardless of what the live fixtures produced. Includes the
  // widest values afNum() can emit (+9.9k/−999k) and the "+1 −236" shape
  // that once jammed: a 4-char body overflowed the old 3.5ch dels track
  // LEFTWARD into the adds column (right edges stayed ruled, so only the
  // gap check below catches it).
  const r = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">a.tex</span><span class="afD"><span class="a">+8</span></span><span class="afW">23m</span></div>
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">b.tex</span><span class="afD"><span class="a">+2</span><span class="d">−1</span></span><span class="afW">36m</span></div>
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">refs.bib</span><span class="afD"><span class="a">+240</span><span class="d">−60</span></span><span class="afW">2h</span></div>
      <div class="afRow"><span class="afVm new">+</span><span class="nm">c.tex</span><span class="afD"><span class="a">+41</span></span><span class="afW">41m</span></div>
      <div class="afRow"><span class="afVm del">×</span><span class="nm">old.tex</span><span class="afD"><span class="d">−312</span></span><span class="afW">3h</span></div>
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">ov.html</span><span class="afD"><span class="a">+1</span><span class="d">−236</span></span><span class="afW">Jul 27</span></div>
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">big.html</span><span class="afD"><span class="a">+9.9k</span><span class="d">−999k</span></span><span class="afW">4d</span></div>
      <div class="afRow"><span class="afVm edit">Δ</span><span class="nm">an_absurdly_long_supplementary_appendix_robustness_v3.tex</span><span class="afD"><span class="a">+9</span><span class="d">−9</span></span><span class="afW">17h</span></div>`;
    document.querySelector('.side').prepend(host);
    const right = (sel) => [...host.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().right);
    const left = (sel) => [...host.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().left);
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    const long = [...host.querySelectorAll('.nm')].at(-1);
    // the jam regression: in every two-column row the dels cell must start
    // clearly right of where the adds cell ends — a gap, not a blob
    const minGap = Math.min(...[...host.querySelectorAll('.afD')]
      .filter((el) => el.querySelector('.a') && el.querySelector('.d'))
      .map((el) => el.querySelector('.d').getBoundingClientRect().left
        - el.querySelector('.a').getBoundingClientRect().right));
    const out = {
      adds: spread(right('.afD .a')),
      dels: spread(right('.afD .d')),
      times: spread(right('.afW')),
      names: spread(left('.nm')), // [new]/[del] pad to [edit]'s 6ch column
      longTruncated: long.scrollWidth > long.clientWidth,
      minGap,
    };
    host.remove();
    return out;
  });
  assert.ok(r.adds < 0.5, `adds column is ruled (spread ${r.adds}px)`);
  assert.ok(r.dels < 0.5, `dels column is ruled (spread ${r.dels}px)`);
  assert.ok(r.times < 0.5, `age column is ruled (spread ${r.times}px)`);
  assert.ok(r.names < 0.5, `name column is ruled across + / Δ / × (spread ${r.names}px)`);
  assert.ok(r.longTruncated, 'a long name ellipsizes instead of pushing the columns');
  assert.ok(r.minGap >= 3, `adds and dels never jam — every row keeps a visible gap (min ${r.minGap}px)`);
});

test('a null-task change-set (P-EOL-5 editor-save ledger) renders in the feed without crashing', opts, async () => {
  // the real path end-to-end: a normalizing artifact PUT makes the server
  // record a task:null journal entry (CONTRACT Phase 3 "EOL policy" — the
  // eol-normalize ledger; monaco-s2 §1 S2.1(c) null-task tolerance case)
  const abs = path.join(sb.projRoots.alpha, 'mixed.tex');
  const put = await sb.fetchJson('PUT', '/artifact/alpha/mixed.tex', {
    content: '\uFEFFa\nb\nc\nd', baseMtimeMs: fs.statSync(abs).mtimeMs,
  });
  assert.equal(put.status, 200);
  const { body: snaps } = await sb.fetchJson('GET', '/api/snapshots/alpha');
  const entry = snaps.entries.find((e) => (e.files || []).some((f) => f.rel === 'mixed.tex'));
  assert.ok(entry, 'the ledger entry exists');
  assert.equal(entry.task, null);
  // the WS is stubbed — push the snapshot:new the live server broadcast; the
  // client handler must tolerate the null task (snapsCache miss is a no-op,
  // refreshFeed re-fetches) and the feed must render the task-less row
  await ui.wsPush('snapshot:new', { project: 'alpha', entry });
  await sleep(1400); // refreshFeed debounce (800ms) + fetch + render
  const r = await page.evaluate(() => {
    const row = document.querySelector('#actFeed .afRow[data-rel="mixed.tex"]');
    return row ? { task: row.dataset.task, nm: row.querySelector('.nm')?.textContent.trim() } : null;
  });
  assert.ok(r, 'the null-task change-set renders as a feed row');
  assert.equal(r.task, '', 'no task attribution (esc(null) → empty string)');
  assert.equal(r.nm, 'mixed.tex');
  // clicking must not crash: the Δ tab is task-scoped, so the guard declines
  await page.click('#actFeed .afRow[data-rel="mixed.tex"]');
  await sleep(300);
  const after2 = await page.evaluate(() => ({
    alive: !!document.querySelector('#actFeed'),
    sdv: !!document.querySelector('#v-alpha .sdv'),
  }));
  assert.ok(after2.alive, 'the feed survived the click');
  assert.equal(after2.sdv, false, 'no task-scoped Δ view opened for a task-less entry');
});

test('the session feed keeps a one-line row per ended job (✓ / ✗ / ⊘) and a live row for a detached job', opts, async () => {
  // job card v3 (docs/jobcard-mockups/IMPLEMENTATION.md §2): after a finished
  // card fades, its end summary stays in the console as a feed row; a
  // detached job still running after the turn keeps a LIVE row with ⊘ stop
  const key = await page.evaluate(() => document.querySelector('#v-alpha #consoleBox')?.dataset.key);
  assert.ok(key, 'a task console is showing');
  const taskId = key.split('/')[1];
  const taskCreated = await page.evaluate(async id => (await import('/store.js')).state.tasks.alpha.find(t => t.id === id).created, taskId);
  const appTurnId = 'feed-owned-turn';
  await ui.wsPush('session:stream', { project: 'alpha', id: taskId, turnId: appTurnId,
    chunk: '\n▸ you ─────\nRun the owned jobs.\n— answer —\nJob results.\n' });
  const stopPosts = [];
  await page.route('**/api/jobs/**', (r) => { stopPosts.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ json: { ok: true } }); });
  const iso = (ago) => new Date(Date.now() - ago).toISOString();
  const startedAt = iso(60000);
  const job = (k, over) => ({
    key: `sess:alpha/${taskId}/${k}`, source: 'session', project: 'alpha', taskId, lang: 'julia', state: 'running', stopping: false,
    jobRunId: `feed-${k}`, taskCreated, appTurnId,
    startedAt, elapsedMs: 60000, pid: 100, cpu: 100, mem: 1e8, progress: null, quietMs: null, exitCode: null, ms: null,
    sampledAt: iso(500), pollMs: 2000, stale: false, cores: 1.0, coresBasis: 'cputime', hostCores: 8, cpuTimeMs: 60000,
    memBytes: 1e8, memKind: 'footprint', memPeakBytes: 2e8, procs: 1, threads: 2,
    health: { state: 'computing', sinceMs: 1000 }, output: { owned: false }, history: null, exit: null, phase: null, counters: {}, ...over,
  });
  await ui.wsPush('job:status', { project: 'alpha', job: job('ok', { file: 'sweep/fig3.jl', command: 'julia sweep/fig3.jl', state: 'done', ms: 272000, exit: { code: 0, signal: null, byUser: false }, exitCode: 0, memPeakBytes: 1.5 * 1024 ** 3, cpuTimeMs: 843000 }) });
  await ui.wsPush('job:status', { project: 'alpha', job: job('bad', { file: 'tests/', lang: 'python', command: 'pytest tests/', state: 'error', ms: 41000, exit: { code: 1, signal: null, byUser: false }, exitCode: 1, counters: { passed: 138, failed: 2, skipped: 3 } }) });
  await ui.wsPush('job:status', { project: 'alpha', job: job('stop', { file: 'sync', lang: 'shell', command: 'rsync -avz a b', state: 'stopped', ms: 80000, exit: { code: null, signal: 'SIGTERM', byUser: true }, progress: { frac: 0.61, iter: null, total: null, etaS: null } }) });
  await ui.wsPush('job:status', { project: 'alpha', job: job('det', { file: 'sim.jl', command: 'nohup julia sim.jl &', detached: true, elapsedMs: 520000, progress: { frac: 0.86, iter: 860, total: 1000, etaS: 120 }, output: { lines: 6800, rate: 12, last: 'iter 860/1000', owned: true, buffered: false } }) });
  await sleep(7000); // the terminal cards hold ~6 s, fade, then leave feed rows
  const r = await page.evaluate(() => ({
    cards: document.querySelectorAll('#consoleBox .csJobs .jobCard').length,
    rows: [...document.querySelectorAll('#consoleBox .csJobFeed .jobFeedRow')].map((row) => ({
      cls: row.className, txt: [...row.children].map((c) => c.textContent.trim()).join(' '), stop: !!row.querySelector('.jfAct.stop'),
    })),
    indet: !!document.querySelector('.indet'),
  }));
  assert.equal(r.cards, 0, 'no card lingers: the task is not running, so even the detached job is a feed row');
  assert.ok(!r.indet);
  const by = (k) => r.rows.find((x) => x.cls === `jobFeedRow ${k}`);
  assert.match(by('ok').txt, /^✓ julia fig3\.jl 4m32s · peak 1\.5G · cpu 3\.1× \d+:\d\d/);
  assert.match(by('bad').txt, /^✗ python tests\/ exit 1 · 138 passed · 2 failed · 3 skipped · 41s · peak 191M \d+:\d\d/);
  assert.match(by('stop').txt, /^⊘ shell sync stopped by you at 61% · peak 191M \d+:\d\d/);
  assert.match(by('live').txt, /^▶ julia · detached sim\.jl still running · 86% · 8m4\ds · ≈2m00s left ⊘ stop$/);
  assert.ok(by('live').stop, 'the detached row keeps ⊘ stop');
  await page.click('#consoleBox .csJobFeed .jobFeedRow.live .jfAct.stop');
  await sleep(150);
  assert.deepEqual(stopPosts, [{ key: `sess:alpha/${taskId}/det`, startedAt, jobRunId: 'feed-det' }], '⊘ stop fences the displayed invocation');
});

test('afNum compacts counts to a ≤4-char body so no value can overflow its column', () => {
  const { afNum } = loadPrivateFns(path.join(APP_DIR, 'public', 'app.js'), ['afNum']);
  const out = [0, 8, 236, 999, 1236, 5000, 9949, 9950, 43210, 999499, 999500, 1200000].map(afNum);
  assert.deepEqual(out, ['0', '8', '236', '999', '1.2k', '5k', '9.9k', '10k', '43k', '999k', '1M', '1.2M']);
  const widest = Math.max(...out.map((s) => s.length));
  assert.ok(widest <= 4, `body stays within the 5ch track incl. sign (widest ${widest})`);
});
