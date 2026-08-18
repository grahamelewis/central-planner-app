// test/ui.monaco-merge.test.mjs — Phase 3 M4: the 3-way merge (file:changed
// under a draft) routed into the Monaco model — files.js's mergeRuns /
// autoMergeDisk calling applyExternal(mergeRebase), the A1 HISTORY REBASE.
//
// Ground rules (monaco-s05 §M4 + blueprint §14 A1, P3 row):
//   - typing/undo/redo are GENUINE CDP keystrokes; the __mp seam reads state
//     (and stages the one draft-vanished case the input path cannot);
//   - external disk writes are real fs writes + a synthetic file:changed
//     through the stubbed WS (the exact path production merges take —
//     ui.filechanged.test.mjs's recipe);
//   - merge fetches ride a page.route gate so the fetch window (typing during
//     fetch, draft-vanished race, strict serialization) is held open exactly
//     as long as each case needs;
//   - billing-safe: armPage() intercepts the five billed routes on every
//     context; this file touches only unbilled /artifact GET+PUT, unbilled
//     /api/tasks POST, and GET /api/state. A grep guard below pins that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// one file per test — merges rewrite disk, and each test opens a fresh context
const FK = {
  gate: 'alpha::gate.tex',       // 0 — the A1 GATE verbatim
  ladder: 'alpha::ladder.tex',   // 1 — undo/redo ladder + rebase-save
  dissolve: 'alpha::dissolve.tex', // 2 — T4
  bail: 'alpha::bail.tex',       // 3 — T2 (overlap) + the 409 net
  serial: 'alpha::serial.tex',   // 4 — mergeRuns strict serialization
  race: 'alpha::race.tex',       // 5 — T3 draft-vanished (active model)
  fetch: 'alpha::fetch.tex',     // 6 — typing during the THEIRS fetch
  bg: 'alpha::bg.tex',           // 7 — background-model merge + background T3
  front: 'alpha::front.tex',     // 8 — the visible file while bg merges
};
const REL = Object.fromEntries(Object.entries(FK).map(([k, v]) => [k, v.split('::')[1]]));

/** 32 pure-LF lines: '% <tag> fixture' + 30 body lines + final newline. */
const baseOf = (tag) => `% ${tag} fixture\n`
  + Array.from({ length: 30 }, (_, i) => `${tag} l${i + 1} body text`).join('\n') + '\n';
/** Replace 1-indexed line `ln` — the non-overlapping THEIRS builder. */
const withLine = (text, ln, s) => {
  const a = text.split('\n');
  a[ln - 1] = s;
  return a.join('\n');
};

let ui, sb, task, alphaRoot;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      alphaRoot = projRoots.alpha;
      for (const [k, rel] of Object.entries(REL)) fs.writeFileSync(path.join(alphaRoot, rel), baseOf(k));
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco merge', category: 'calibration', oversight: 'manual',
    context: { files: Object.values(REL) },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  assert.ok(task && task.id, 'task record captured');
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers (the ui.monaco-save idioms) ─────────────────────────────── */

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return null; } };

/**
 * The artifact gate: records PUTs/GETs and can hold GETs open — the merge's
 * THEIRS fetch window (typing-during-fetch, T3 race, serialization) is opened
 * exactly as long as a case needs, then released.
 */
function netGate(page, pattern = '**/artifact/**') {
  const puts = [];
  const gets = [];
  const cfg = { get: 'pass' }; // 'pass' | 'hold'
  let held = [];
  page.route(pattern, async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      puts.push({ url: req.url(), body: safeJson(req.postData()), at: Date.now() });
      await route.continue();
      return;
    }
    gets.push({ url: req.url(), at: Date.now() });
    if (cfg.get === 'hold') await new Promise((res) => held.push(res));
    await route.continue();
  });
  return {
    puts,
    gets,
    cfg,
    release() { const w = held; held = []; for (const r of w) r(); },
    async waitGets(n, timeout = 10000) {
      const t0 = Date.now();
      while (gets.length < n) {
        if (Date.now() - t0 > timeout) throw new Error(`waitGets: ${gets.length}/${n} after ${timeout}ms`);
        await sleep(25);
      }
    },
  };
}

async function mergePage() {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  await armPage(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message)));
  await page.addInitScript(() => { localStorage.setItem('editor:impl', 'monaco'); });
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, errs };
}

/** One synthetic server WS event → the stubbed socket (the production path). */
const push = (page, type, payload) => page.evaluate(([t, p]) => {
  if (window.__ws && window.__ws.onmessage) {
    window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
  }
}, [type, payload]);

const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

const clickTab = async (page, fi, fkey) => {
  await page.click(`.ctab.cd[data-fi="${fi}"]`);
  if (fkey) await waitEditor(page, fkey);
};

const chip = (page) => page.evaluate(() => {
  const el = document.querySelector('#saveState');
  return el ? { cls: el.className, txt: el.textContent.trim() } : null;
});

const snap = (page, fk) => page.evaluate((f) => {
  const s = window.__mp.store();
  return {
    draft: s.drafts[f] ?? null,
    base: s.draftBase[f] ?? null,
    cache: s.fileCache[f] ? { text: s.fileCache[f].text ?? null, mtimeMs: s.fileCache[f].mtimeMs ?? null } : null,
    stale: s.diskStale.has(f),
    savedAlt: window.__mp.savedAlt(f),
    dirty: window.__mp.isDirty(f),
    text: window.__mp.text(f),
  };
}, fk);

const typeAt = async (page, line, col, text) => {
  await page.evaluate(([l, c]) => { window.__mp.focus(); window.__mp.setPosition(l, c); }, [line, col]);
  await page.keyboard.type(text);
};

const undoOnce = async (page) => {
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(`${MOD}+z`);
};
const redoOnce = async (page) => {
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(`${MOD}+Shift+z`);
};

/** ⌘Z until the altId dirty bit reads clean (bounded). */
async function undoToClean(page, fkey, max = 20) {
  await page.evaluate(() => window.__mp.focus());
  for (let i = 0; i < max; i++) {
    if (!(await page.evaluate((fk) => window.__mp.isDirty(fk), fkey))) return i;
    await page.keyboard.press(`${MOD}+z`);
    await sleep(50);
  }
  throw new Error(`undoToClean: still dirty after ${max} ⌘Z`);
}

/* ═══ node-side guard: no billed routes; the caller speaks only the seam ═══ */

test('this suite touches no billed route; files.js merges route ONLY through the frozen seam', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // the five billed routes, spelled in halves so this guard cannot match itself
  const billed = ['/laun' + 'ch', '/mess' + 'age', '/ret' + 'ry', '/api/prof' + 'ile/generate', '/api/tex' + 'fix'];
  for (const b of billed) {
    assert.equal(src.includes(b), false, `the merge suite must never mention the billed route ${b}`);
  }
  const filesSrc = fs.readFileSync(path.join(APP_DIR, 'public', 'files.js'), 'utf8');
  // the caller side owns store bookkeeping and speaks ONLY applyExternal —
  // monacoPane stays the sole owner of monaco.* and of raw model writes
  // (the M2 guarded block; ui.monaco-core greps monacoPane's side)
  assert.equal(/window\.monaco/.test(filesSrc), false, 'files.js never touches window.monaco');
  for (const raw of ['.setValue(', '.pushEditOperations(', '.setEOL(']) {
    assert.equal(filesSrc.includes(raw), false, `files.js must not carry a raw model write (${raw})`);
  }
  // the payloads are the contract shapes, reasons from the A4 closed set
  assert.match(filesSrc, /mpApplyExternal\(fk, \{ theirs, merged \}, 'mergeRebase'\)/,
    'the merge routes {theirs, merged} through mergeRebase');
  assert.match(filesSrc, /mpApplyExternal\(fk, c2\.text, 'cleanReload'\)/,
    'the T3 race routes the fresh text through cleanReload');
  // the bail closure is byte-identical to the pre-M4 shape: no model call may
  // ever creep into it (M4 invariant: the bail path touches nothing)
  const bail = filesSrc.slice(filesSrc.indexOf('const bail = ()'), filesSrc.indexOf('let theirs'));
  assert.ok(bail.length > 0 && !bail.includes('mpApplyExternal') && !bail.includes('drafts['),
    'the bail path stays model- and draft-free');
});

/* ═══ A — the A1 GATE verbatim (§14 A1 / M4 T5) + signal discipline ═══ */

test('A1 GATE: type OURS → non-overlapping THEIRS lands + file:changed → ⌘Z → THEIRS/saved → save is a no-op, THEIRS survives on disk; exactly one signal; caret restored', opts, async () => {
  const { context, page, errs } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    await typeAt(page, 2, 1, '% OURS ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.gate);
    const pos0 = await page.evaluate(() => window.__mp.getPosition());
    await page.evaluate(() => window.__mp.resetSignals());

    // the session's non-overlapping edit lands on disk, then the broadcast
    const THEIRS = withLine(baseOf('gate'), 20, 'gate THEIRS twenty');
    fs.writeFileSync(path.join(alphaRoot, REL.gate), THEIRS);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.gate });
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('THEIRS twenty'), FK.gate, { timeout: 10000 });

    const merged = await snap(page, FK.gate);
    const sig = await page.evaluate(() => window.__mp.signals());
    assert.ok(merged.text.includes('% OURS ') && merged.text.includes('THEIRS twenty'),
      'MERGED carries both sides (T5 rebase)');
    assert.equal(merged.draft, merged.text, 'drafts[k] == MERGED');
    assert.equal(merged.base, merged.cache.mtimeMs, 'draftBase rebased onto the new disk mtime');
    assert.equal(merged.cache.text, THEIRS, 'fileCache commit is THEIRS (the frozen BASE moves forward)');
    assert.equal(merged.stale, false);
    assert.equal(typeof merged.savedAlt, 'number', 'savedAltId is the altId of THEIRS — a real model state');
    assert.ok((await chip(page)).cls.includes('dirty'), 'chip amber after a rebase');
    assert.equal(sig.chrome, 1, 'exactly ONE chrome signal for the whole merge txn (signal discipline)');
    assert.equal(sig.preview, 0, 'no preview ping (tex)');
    // M4 T5 best-effort caret: position captured pre-txn, restored post-txn
    assert.deepEqual(await page.evaluate(() => window.__mp.getPosition()), pos0,
      'the caret sits where typing left it — the rebase never teleported it');
    assert.equal(await page.evaluate(() => window.__mp.hasTextFocus()), true, 'focus kept');

    // ⌘Z — the ONLY undoable step is THEIRS→MERGED: one undo lands on THEIRS
    await undoOnce(page);
    await page.waitForFunction((fk) => !window.__mp.isDirty(fk), FK.gate, { timeout: 5000 });
    const undone = await snap(page, FK.gate);
    assert.equal(undone.text, THEIRS, '⌘Z reaches CURRENT DISK — THEIRS, exactly');
    assert.equal(undone.draft, null, 'drafts deleted via the M2-idle clean transition');
    assert.ok(!(await chip(page)).cls.includes('dirty'), "chip reads 'saved' at THEIRS");

    // a second ⌘Z bottoms out at THEIRS — pre-merge OURS unreachable at ANY depth
    await undoOnce(page);
    await sleep(200);
    const bottom = await snap(page, FK.gate);
    assert.equal(bottom.text, THEIRS, 'undo bottoms out at THEIRS, never older');
    assert.equal(bottom.text.includes('% OURS '), false, 'pre-merge OURS is structurally unreachable (A1)');

    // …and the gate's point: a subsequent save is a no-op that leaves THEIRS
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+s`);
    await sleep(400);
    assert.equal(gate.puts.length, 0, 'a clean post-undo ⌘S dispatches ZERO PUTs');
    assert.equal(fs.readFileSync(path.join(alphaRoot, REL.gate), 'utf8'), THEIRS,
      'THEIRS survives on disk — the A1 data-loss hole is closed');
    assert.deepEqual(errs, [], 'no page errors');
  } finally {
    await context.close();
  }
});

/* ═══ B — the undo/redo ladder + rebase-save (M4 rows 2/3) ═══ */

test('ladder: ⌘Z→THEIRS/saved/drafts deleted; ⇧⌘Z→MERGED/amber/drafts re-materialized; double-⌘Z bottoms at THEIRS; ⌘S writes MERGED on top with no 409', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 1, FK.ladder);
    await typeAt(page, 2, 1, '% OURS ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.ladder);

    const THEIRS = withLine(baseOf('ladder'), 20, 'ladder THEIRS twenty');
    fs.writeFileSync(path.join(alphaRoot, REL.ladder), THEIRS);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.ladder });
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('THEIRS twenty'), FK.ladder, { timeout: 10000 });
    const MERGED = (await snap(page, FK.ladder)).text;
    assert.ok(MERGED.includes('% OURS ') && MERGED !== THEIRS);

    // down: MERGED → THEIRS
    await undoOnce(page);
    await page.waitForFunction((fk) => !window.__mp.isDirty(fk), FK.ladder, { timeout: 5000 });
    let s = await snap(page, FK.ladder);
    assert.equal(s.text, THEIRS, '⌘Z → THEIRS');
    assert.equal(s.draft, null, 'drafts deleted');
    assert.equal(s.base, null, 'draftBase deleted');
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'chip saved');

    // up: THEIRS → MERGED (drafts re-materialized through the normal pipeline)
    await redoOnce(page);
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.ladder, { timeout: 5000 });
    s = await snap(page, FK.ladder);
    assert.equal(s.text, MERGED, '⇧⌘Z → MERGED');
    assert.equal(s.draft, MERGED, 'drafts re-materialized == MERGED');
    assert.ok((await chip(page)).cls.includes('dirty'), 'chip amber again');

    // double-⌘Z bottoms at THEIRS — never anything older
    await undoOnce(page);
    await undoOnce(page);
    await sleep(200);
    s = await snap(page, FK.ladder);
    assert.equal(s.text, THEIRS, 'double-⌘Z bottoms out at THEIRS');
    assert.equal(s.dirty, false);

    // back to MERGED, then ⌘S: writes MERGED on top of THEIRS with no 409
    await redoOnce(page);
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.ladder, { timeout: 5000 });
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+s`);
    await page.waitForFunction(
      (fk) => window.__mp.saveLog(fk).some((x) => x.ev === 'commit-clean'), FK.ladder, { timeout: 10000 });
    assert.equal(await page.evaluate(() => !!document.querySelector('#confirmBack')), false,
      'no 409 dialog — draftBase was rebased onto the merge mtime');
    assert.equal(fs.readFileSync(path.join(alphaRoot, REL.ladder), 'utf8'), MERGED,
      'disk now holds MERGED, written on top of THEIRS');
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'clean after the rebase-save');
  } finally {
    await context.close();
  }
});

/* ═══ C — dissolve (T4): the draft's edits are already all on disk ═══ */

test('T4 dissolve: disk catches up to the draft → chip saved, drafts deleted, ⌘Z no-op, savedAltId === current altId, one signal', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 2, FK.dissolve);
    await typeAt(page, 2, 1, '% SAME ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.dissolve);
    const cur = await page.evaluate((fk) => window.__mp.text(fk), FK.dissolve);
    await page.evaluate(() => window.__mp.resetSignals());

    // the session writes EXACTLY the draft's text (merged === THEIRS)
    fs.writeFileSync(path.join(alphaRoot, REL.dissolve), cur);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.dissolve });
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] == null, FK.dissolve, { timeout: 10000 });

    const s = await snap(page, FK.dissolve);
    const sig = await page.evaluate(() => window.__mp.signals());
    assert.equal(s.text, cur, 'model text unchanged by the dissolve');
    assert.equal(s.draft, null, 'drafts deleted — the edits are all on disk');
    assert.equal(s.base, null);
    assert.equal(s.dirty, false, 'savedAltId === current altId (§2 merge-dissolve falsely-amber guard)');
    assert.equal(typeof s.savedAlt, 'number');
    assert.equal(s.cache.text, cur, 'fileCache commit is THEIRS (== the draft text)');
    assert.ok(!(await chip(page)).cls.includes('dirty'), "chip reads 'saved'");
    assert.equal(sig.chrome, 1, 'exactly one signal for the dissolve txn');

    // ⌘Z is a no-op: setValue cleared the undo stack, no MERGED edit was pushed
    await undoOnce(page);
    await sleep(200);
    const undone = await snap(page, FK.dissolve);
    assert.equal(undone.text, cur, '⌘Z is a no-op — pre-merge OURS unreachable');
    assert.equal(undone.draft, null, 'no draft manufactured');
  } finally {
    await context.close();
  }
});

/* ═══ D — bail (T2): overlapping hunks → ⚠, model untouched, 409 net ═══ */

test('T2 bail: overlapping edit → ⚠ chip, model still OURS, drafts intact, zero txns, one toast per pinning; ⌘S runs the M5 409 net', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 3, FK.bail);
    await typeAt(page, 2, 1, 'MINE ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.bail);
    const pre = await snap(page, FK.bail);
    await page.evaluate(() => window.__mp.resetSignals());

    // the session rewrites the SAME line differently — merge3 must refuse
    const bpath = path.join(alphaRoot, REL.bail);
    fs.writeFileSync(bpath, withLine(baseOf('bail'), 2, 'CLAUDE bail l1 body text'));
    const future = new Date(Date.now() + 10000); // past the 250ms grace, for the 409 below
    fs.utimesSync(bpath, future, future);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.bail });
    await page.waitForFunction((fk) => window.__mp.store().diskStale.has(fk), FK.bail, { timeout: 10000 });

    const s = await snap(page, FK.bail);
    const sig = await page.evaluate(() => window.__mp.signals());
    const c = await chip(page);
    assert.equal(s.text, pre.text, 'the model still shows OURS — the bail touched nothing');
    assert.equal(s.text.includes('CLAUDE'), false, 'disk did not overwrite the draft');
    assert.equal(s.draft, pre.draft, 'drafts intact');
    assert.equal(s.base, pre.base, 'draftBase intact');
    assert.equal(s.cache.text, pre.cache.text, 'BASE stays frozen — fileCache untouched');
    assert.equal(s.dirty, true);
    assert.equal(sig.chrome, 0, 'ZERO model txns on the bail path (M4 invariant)');
    assert.match(c.cls, /stale/, 'chip carries the stale class');
    assert.match(c.txt, /⚠ disk/, `chip warns (${JSON.stringify(c.txt)})`);
    assert.ok(await page.evaluate(() => document.getElementById('toast').textContent.includes("couldn't auto-merge")),
      'the first pinning toasts');

    // a second overlapping event: still pinned, but NO second toast
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    fs.writeFileSync(bpath, withLine(baseOf('bail'), 2, 'CLAUDE AGAIN bail l1 body text'));
    fs.utimesSync(bpath, future, future);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.bail });
    await sleep(700);
    assert.equal(await page.evaluate(() => document.getElementById('toast').textContent.includes('auto-merge')), false,
      'one toast per pinning — the second bail is silent');
    assert.equal((await snap(page, FK.bail)).draft, pre.draft, 'still pinned, still intact');

    // a later ⌘S runs the 409 net (M5): the conflict dialog appears; cancel
    // is a total no-op — the draft survives
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+s`);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbCancel');
    await sleep(250);
    const post = await snap(page, FK.bail);
    assert.equal(post.draft, pre.draft, '409 + cancel mutates nothing');
    assert.equal(post.stale, true, 'still ⚠ until reconciled');
  } finally {
    await context.close();
  }
});

/* ═══ E — serialization: two rapid file:changed events run strictly in order ═══ */

test('serialization: two rapid file:changed events merge in order — the second BASE is the first\'s committed THEIRS; exactly one signal each', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    await clickTab(page, 4, FK.serial);
    await typeAt(page, 2, 1, '% NOTE ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.serial);
    await page.evaluate(() => window.__mp.resetSignals());

    const spath = path.join(alphaRoot, REL.serial);
    const V2 = withLine(baseOf('serial'), 12, 'serial V2 twelve');
    const V3 = withLine(V2, 25, 'serial V3 twentyfive');
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';

    fs.writeFileSync(spath, V2);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.serial });
    await gate.waitGets(g0 + 1); // merge 1's THEIRS fetch dispatched, held
    await push(page, 'file:changed', { project: 'alpha', rel: REL.serial });
    await sleep(250);
    assert.equal(gate.gets.length, g0 + 1,
      'merge 2 never fetches while merge 1 is in flight (mergeRuns serialization)');

    gate.release(); // fetch 1 reads V2 → merge 1 commits; merge 2's fetch holds next
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('V2 twelve'), FK.serial, { timeout: 10000 });
    const mid = await snap(page, FK.serial);
    assert.equal(mid.cache.text, V2, "merge 2's BASE is merge 1's committed THEIRS (frozen fileCache)");
    assert.ok(mid.text.includes('% NOTE ') && mid.draft === mid.text, 'MERGED1 rides as the draft');

    fs.writeFileSync(spath, V3);
    await gate.waitGets(g0 + 2); // merge 2's fetch dispatched, held
    gate.cfg.get = 'pass';
    gate.release(); // fetch 2 reads V3
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('V3 twentyfive'), FK.serial, { timeout: 10000 });

    const fin = await snap(page, FK.serial);
    const sig = await page.evaluate(() => window.__mp.signals());
    assert.equal(fin.cache.text, V3, 'final fileCache is V3');
    for (const mark of ['% NOTE ', 'V2 twelve', 'V3 twentyfive']) {
      assert.ok(fin.text.includes(mark), `MERGED2 carries ${JSON.stringify(mark)}`);
    }
    assert.equal(fin.draft, fin.text, 'drafts == the final MERGED');
    assert.equal(fin.base, fin.cache.mtimeMs, 'draftBase rebased onto V3\'s mtime');
    assert.equal(sig.chrome, 2, 'exactly one signal per merge txn — two merges, two signals');
    assert.ok((await chip(page)).cls.includes('dirty'));
  } finally {
    await context.close();
  }
});

/* ═══ F — T3: the draft vanishes during the THEIRS fetch (active model) ═══ */

test('T3 draft-vanished race: undo-to-clean during the fetch → plain reload, no resurrection, chip saved, undo cleared — and only ONE txn (idempotence guard)', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    await clickTab(page, 5, FK.race);
    await typeAt(page, 2, 1, '% TEMP ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.race);

    const THEIRS = withLine(baseOf('race'), 20, 'race THEIRS twenty');
    fs.writeFileSync(path.join(alphaRoot, REL.race), THEIRS);
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await push(page, 'file:changed', { project: 'alpha', rel: REL.race });
    await gate.waitGets(g0 + 1); // the merge's THEIRS fetch is in flight, held

    // …the draft vanishes meanwhile (reverted by undo — OURS re-read after
    // the fetch must observe null, M4 T3)
    await undoToClean(page, FK.race);
    assert.equal((await snap(page, FK.race)).draft, null, 'the draft is gone pre-release');
    await page.evaluate(() => window.__mp.resetSignals());

    gate.cfg.get = 'pass';
    gate.release();
    await page.waitForFunction(([fk, t]) => window.__mp.text(fk) === t, [FK.race, THEIRS], { timeout: 10000 });

    const s = await snap(page, FK.race);
    const sig = await page.evaluate(() => window.__mp.signals());
    assert.equal(s.text, THEIRS, 'plain reload — the model shows the fresh disk text');
    assert.equal(s.draft, null, 'NO draft resurrection');
    assert.equal(s.dirty, false);
    assert.equal(s.stale, false);
    assert.ok(!(await chip(page)).cls.includes('dirty'), "chip reads 'saved'");
    // exactly one cleanReload txn ran (the attached model's render
    // reconciliation); the seam call behind it no-oped on the M4 T3
    // idempotence guard instead of double-clearing undo
    assert.equal(sig.chrome, 1, 'one txn total — the applyExternal follow-up was the idempotent no-op');
    await undoOnce(page);
    await sleep(200);
    assert.equal((await snap(page, FK.race)).text, THEIRS, '⌘Z cannot resurrect pre-reload text');
  } finally {
    await context.close();
  }
});

/* ═══ G — typing during the fetch appears in MERGED (OURS re-read after) ═══ */

test('typing during the THEIRS fetch: keystrokes between fetch start and the OURS re-read appear in MERGED — never dropped', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    await clickTab(page, 6, FK.fetch);
    await typeAt(page, 2, 1, '% EARLY ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.fetch);

    const THEIRS = withLine(baseOf('fetch'), 20, 'fetch THEIRS twenty');
    fs.writeFileSync(path.join(alphaRoot, REL.fetch), THEIRS);
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await push(page, 'file:changed', { project: 'alpha', rel: REL.fetch });
    await gate.waitGets(g0 + 1);

    // keystrokes keep landing while the fetch is in flight
    await typeAt(page, 2, 1, 'LATE ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('LATE '), FK.fetch);

    gate.cfg.get = 'pass';
    gate.release();
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('THEIRS twenty'), FK.fetch, { timeout: 10000 });

    const s = await snap(page, FK.fetch);
    for (const mark of ['% EARLY ', 'LATE ', 'THEIRS twenty']) {
      assert.ok(s.text.includes(mark), `MERGED carries ${JSON.stringify(mark)} (OURS re-read AFTER the fetch)`);
    }
    assert.equal(s.draft, s.text, 'drafts == MERGED, mid-fetch keystrokes included');
    assert.ok((await chip(page)).cls.includes('dirty'));
  } finally {
    await context.close();
  }
});

/* ═══ H — background-model merge (A4/M7 T6) + background T3 routing ═══ */

test('background merge: a non-attached fkey rebases via applyExternal without moving the visible caret; reattach shows MERGED + amber; a background T3 reload lands via cleanReload', opts, async () => {
  const { context, page } = await mergePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    await clickTab(page, 7, FK.bg);
    await typeAt(page, 2, 1, '% BGNOTE ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.bg);
    await clickTab(page, 8, FK.front); // bg parks; its dirty model is retained

    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(3, 2); });
    await page.evaluate(() => window.__mp.resetSignals());
    const THEIRS_BG = withLine(baseOf('bg'), 20, 'bg THEIRS twenty');
    fs.writeFileSync(path.join(alphaRoot, REL.bg), THEIRS_BG);
    await push(page, 'file:changed', { project: 'alpha', rel: REL.bg });
    await page.waitForFunction((fk) => (window.__mp.text(fk) || '').includes('THEIRS twenty'), FK.bg, { timeout: 10000 });

    const bg = await snap(page, FK.bg);
    const vis = await page.evaluate(() => ({
      pos: window.__mp.getPosition(),
      focus: window.__mp.hasTextFocus(),
      active: window.__mp.activeFkey(),
      sig: window.__mp.signals(),
    }));
    assert.ok(bg.text.includes('% BGNOTE ') && bg.text.includes('THEIRS twenty'),
      'the BACKGROUND model rebased directly — no renderWB attach needed (A4)');
    assert.equal(bg.draft, bg.text, 'drafts == MERGED for the background fkey');
    assert.equal(bg.dirty, true);
    assert.equal(typeof bg.savedAlt, 'number', 'savedAltId is THEIRS\'s altId on the background model too');
    assert.equal(vis.active, FK.front, 'the visible editor stayed on front.tex');
    assert.deepEqual(vis.pos, { line: 3, col: 2 }, 'the visible caret NEVER moved (M4/M7 T6)');
    assert.equal(vis.focus, true, 'focus kept');
    assert.equal(vis.sig.chrome, 1, 'one signal for the background merge txn');

    // reattach: the merged text + amber chip are simply there (bridges M7 T6)
    await clickTab(page, 7, FK.bg);
    assert.ok((await chip(page)).cls.includes('dirty'), 'amber on reattach');
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.bg), bg.text, 'reattach shows MERGED');
    await clickTab(page, 8, FK.front);

    // ── background T3: the draft vanishes mid-fetch on a parked model — the
    // fresh bytes must reach it via applyExternal(cleanReload), because
    // refreshFile's renderWB only reconciles the attached fkey ──
    const THEIRS2 = withLine(THEIRS_BG, 25, 'bg SECOND twentyfive');
    fs.writeFileSync(path.join(alphaRoot, REL.bg), THEIRS2);
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await push(page, 'file:changed', { project: 'alpha', rel: REL.bg });
    await gate.waitGets(g0 + 1); // the merge fetch is held
    // stage the vanish (the input path cannot undo a background model): the
    // draft was saved/reverted elsewhere while the fetch was in flight
    await page.evaluate((fk) => {
      const s = window.__mp.store();
      delete s.drafts[fk];
      delete s.draftBase[fk];
    }, FK.bg);
    await page.evaluate(() => { window.__mp.setPosition(3, 2); window.__mp.resetSignals(); });
    gate.cfg.get = 'pass';
    gate.release();
    await page.waitForFunction(([fk, t]) => window.__mp.text(fk) === t, [FK.bg, THEIRS2], { timeout: 10000 });

    const t3 = await snap(page, FK.bg);
    const vis2 = await page.evaluate(() => ({
      pos: window.__mp.getPosition(),
      active: window.__mp.activeFkey(),
      sig: window.__mp.signals(),
    }));
    assert.equal(t3.text, THEIRS2, 'the background model reloaded the fresh bytes (T3 via cleanReload)');
    assert.equal(t3.draft, null, 'no resurrection');
    assert.equal(t3.dirty, false, 'clean under the new baseline');
    assert.equal(typeof t3.savedAlt, 'number');
    assert.equal(vis2.active, FK.front);
    assert.deepEqual(vis2.pos, { line: 3, col: 2 }, 'the visible caret never moved during the background reload');
    assert.equal(vis2.sig.chrome, 1, 'one cleanReload txn — front\'s reconcile was a steady-state no-op');

    // reattach bg: fresh text, saved chip, ⌘Z a no-op (undo cleared)
    await clickTab(page, 7, FK.bg);
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'saved on reattach');
    await undoOnce(page);
    await sleep(200);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.bg), THEIRS2,
      '⌘Z cannot resurrect the vanished draft');
  } finally {
    await context.close();
  }
});
