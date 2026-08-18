// test/ui.monaco-stale.test.mjs — Phase 3 M6: the disk-stale undo machine
// (blueprint §14 A9 / monaco-s05 §M6). The suppression half (onIdleEdit keeps
// drafts + ⚠ while diskStale) plus the reconcile-fetch auto-reload leg: undo
// back to savedAltId under ⚠ fires a GET for the CURRENT disk and only
// verified fresh bytes — installed through one atomic M2 recoveryReload txn —
// may ever flip the chip to 'saved'. The full §M6 test list lives here:
// besides the GATE/held/chip/discard/409 legs, test F pins the
// file:changed-while-StaleHeld arm (routes through mergeRuns into M4 — the
// T1 drafts-refresh amendment makes OURS===BASE, so the "or the next
// file:changed" retry of T5/T6 lands as M4's trivial-merge dissolve commit),
// test G is the I1 drafts-retention proof across a simulated boot failure
// (kill the instance in AltCleanStale → the legacy fallback still has
// drafts[k] on screen), and test H covers T3's no-write round-trip branch
// (fresh === serialize(m): capture with the undo stack INTACT). Test D
// drives the literal mid-flight REDO (T7) before its typing (T4) leg.
//
// Ground rules (the ui.monaco-save / ui.monaco-merge idioms):
//   - typing/undo/redo are GENUINE CDP keystrokes; the __mp seam reads state;
//   - the ⚠ entry state is a REAL M4 bail: an overlapping disk write + a
//     synthetic file:changed through the stubbed WS (merge suite recipe);
//   - the reconcile GET rides a page.route gate so the Reconciling window is
//     held open exactly as long as each case needs (A20 hold/abort/discard);
//   - chip truth is a FRAME spy: a MutationObserver on #saveState with
//     attributeOldValue records every value the class attribute ever held —
//     transient writes a microtask-batched callback would miss appear as
//     oldValue frames, so a single lying 'saved' paint cannot hide;
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

// one file per test — the machine rewrites disk, and each test opens a fresh context
const FK = {
  gate: 'alpha::sgate.tex',   // 0 — the A9 GATE success leg + redo no-op
  held: 'alpha::sheld.tex',   // 1 — the A9 fetch-failure leg (StaleHeld → retry)
  chip: 'alpha::schip.tex',   // 2 — chip-truth frames + single-flight coalescing
  abort: 'alpha::sabort.tex', // 3 — redo (T7) + typing (T4) during the reconcile
  net: 'alpha::snet.tex',     // 4 — ⌘S in AltCleanStale → the 409 net intact
  fcheld: 'alpha::sfcheld.tex', // 5 — file:changed while StaleHeld → mergeRuns → M4
  fall: 'alpha::sfall.tex',   // 6 — I1 drafts retention across a simulated boot failure
  round: 'alpha::sround.tex', // 7 — T3's no-write round-trip branch
};
const REL = Object.fromEntries(Object.entries(FK).map(([k, v]) => [k, v.split('::')[1]]));

/** 32 pure-LF lines: '% <tag> fixture' + 30 body lines + final newline. */
const baseOf = (tag) => `% ${tag} fixture\n`
  + Array.from({ length: 30 }, (_, i) => `${tag} l${i + 1} body text`).join('\n') + '\n';
/** Replace 1-indexed line `ln` — the THEIRS builder. */
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
      for (const rel of Object.values(REL)) {
        fs.writeFileSync(path.join(alphaRoot, rel), baseOf(rel.replace(/\.tex$/, '')));
      }
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco stale', category: 'calibration', oversight: 'manual',
    context: { files: Object.values(REL) },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  assert.ok(task && task.id, 'task record captured');
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers (the ui.monaco-save / ui.monaco-merge idioms) ───────────── */

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return null; } };

/**
 * The artifact gate: records PUTs/GETs; GETs can be held open (the
 * Reconciling window), aborted (the T5 fetch-failure leg), or passed.
 */
function netGate(page, pattern = '**/artifact/**') {
  const puts = [];
  const gets = [];
  const cfg = { get: 'pass' }; // 'pass' | 'hold' | 'abort'
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
    if (cfg.get === 'abort') { await route.abort('failed'); return; }
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

async function stalePage() {
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
    flight: window.__mp.staleState(f),
  };
}, fk);

const waitLog = (page, fk, ev, timeout = 10000) => page.waitForFunction(
  ([f, e]) => window.__mp.saveLog(f).some((x) => x.ev === e), [fk, ev], { timeout, polling: 40 });

/** waitLog, count-aware — for suites that walk the same event twice. */
const waitLogN = (page, fk, ev, n, timeout = 10000) => page.waitForFunction(
  ([f, e, k]) => window.__mp.saveLog(f).filter((x) => x.ev === e).length >= k,
  [fk, ev, n], { timeout, polling: 40 });

const typeAt = async (page, line, col, text) => {
  await page.evaluate(([l, c]) => { window.__mp.focus(); window.__mp.setPosition(l, c); }, [line, col]);
  await page.keyboard.type(text);
};

const pressSave = async (page) => {
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(`${MOD}+s`);
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

/**
 * Enter the M6 machine for real: type an overlapping edit, land an
 * overlapping THEIRS on disk (future mtime — past the server's 250ms 409
 * grace), fire file:changed → merge3 refuses → M4 T2 bail pins ⚠ (diskStale).
 * Returns the THEIRS bytes now on disk.
 */
async function pinStale(page, key) {
  const fk = FK[key];
  const rel = REL[key];
  await typeAt(page, 2, 1, 'MINE ');
  await page.waitForFunction((f) => window.__mp.store().drafts[f] != null, fk);
  const fpath = path.join(alphaRoot, rel);
  const THEIRS = withLine(baseOf(rel.replace(/\.tex$/, '')), 2, `CLAUDE ${rel} overlap line`);
  fs.writeFileSync(fpath, THEIRS);
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(fpath, future, future);
  await push(page, 'file:changed', { project: 'alpha', rel });
  await page.waitForFunction((f) => window.__mp.store().diskStale.has(f), fk, { timeout: 10000 });
  return THEIRS;
}

/* ── the chip-truth frame spy ────────────────────────────────────────────
   Records {cls, old, fresh} for every value #saveState's class ever holds:
   live frames read the CURRENT class + whether the model already shows the
   expected fresh text; attributeOldValue frames expose transient writes that
   were overwritten before any callback ran (old:true, fresh unknowable). */
const installChipSpy = (page, fk, expect) => page.evaluate(([f, exp]) => {
  const el = document.querySelector('#saveState');
  window.__chipFrames = [];
  const live = () => window.__chipFrames.push({
    cls: el.className, old: false, fresh: window.__mp.text(f) === exp,
  });
  live(); // frame 0 — the state the spy starts from
  window.__chipMo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === 'class' && typeof r.oldValue === 'string') {
        window.__chipFrames.push({ cls: r.oldValue, old: true, fresh: null });
      }
    }
    live();
  });
  window.__chipMo.observe(el, {
    attributes: true, attributeOldValue: true, childList: true, subtree: true, characterData: true,
  });
}, [fk, expect]);

const takeChipFrames = (page) => page.evaluate(() => {
  if (window.__chipMo) { window.__chipMo.disconnect(); window.__chipMo = null; }
  const f = window.__chipFrames || [];
  window.__chipFrames = [];
  return f;
});

// STRICT on purpose (M6 invariant-2 pin): only the ⚠ class counts as a warn
// frame. The machine window always carries it — saveChipState computes
// stale = drafts && diskStale, and both hold at every frame until the atomic
// T3 commit — so a transient 'saveChip dirty' paint (diskStale cleared while
// drafts still alive: an invariant-2 breach) must fall through to the plain
// branch and fail the old/fresh checks, never slip past as a warn frame.
const isWarn = (cls) => /stale/.test(String(cls));

/** Every frame ⚠ — or (expectPlainTail) a monotone ⚠…⚠ → saved…saved flip
    where every 'saved' frame is live and already shows the fresh text. */
function assertChipTruth(frames, { expectPlainTail }) {
  assert.ok(frames.length > 0, 'the spy recorded frames');
  const firstPlain = frames.findIndex((f) => !isWarn(f.cls));
  if (!expectPlainTail) {
    assert.equal(firstPlain, -1, `zero 'saved' frames expected — got ${JSON.stringify(frames[firstPlain])}`);
    return;
  }
  assert.ok(firstPlain > 0, `at least one ⚠ frame precedes the flip (${JSON.stringify(frames)})`);
  for (let i = firstPlain; i < frames.length; i++) {
    assert.ok(!isWarn(frames[i].cls), `no ⚠ frame after the flip (frame ${i}: ${JSON.stringify(frames[i])})`);
  }
  for (const f of frames) {
    if (isWarn(f.cls)) continue;
    // an old:true plain frame would mean 'saved' was painted TWICE — i.e.
    // once before the atomic commit: the A9 lie
    assert.equal(f.old, false, `no transient 'saved' paint — ${JSON.stringify(f)}`);
    assert.equal(f.fresh, true, `every 'saved' frame already shows the NEW disk text — ${JSON.stringify(f)}`);
  }
}

/* ═══ node-side guard: no billed routes; the M6 structural rules hold ═══ */

test('this suite touches no billed route; the M6 leg keeps the frozen-BASE and atomic-commit rules', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // the five billed routes, spelled in halves so this guard cannot match itself
  const billed = ['/laun' + 'ch', '/mess' + 'age', '/ret' + 'ry', '/api/prof' + 'ile/generate', '/api/tex' + 'fix'];
  for (const b of billed) {
    assert.equal(src.includes(b), false, `the stale suite must never mention the billed route ${b}`);
  }
  const pane = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  // the suppressed-clean branch retains+refreshes the draft, then fires the leg
  const idle = pane.slice(pane.indexOf('function onIdleEdit'), pane.indexOf('function attachContentListener'));
  assert.match(idle, /drafts\[fkey\] = serialize\(m\);\s*\n\s*staleReconcile\(fkey, m\);/,
    'the suppressed-clean branch keeps drafts true and fires staleReconcile (M6 T1)');
  // the M6 block: a bare GET, never fetchFileInto — fileCache is M4's frozen
  // BASE and only the T3 commit may move it
  const m6 = pane.slice(pane.indexOf('M6 — disk-stale undo'), pane.indexOf('export function saveViewStateFor'));
  assert.ok(m6.length > 0, 'the M6 section exists');
  assert.equal(m6.includes('fetchFileInto('), false, 'M6 never fetches into the frozen fileCache BASE');
  assert.equal(/method:/.test(m6), false, 'the reconcile fetch is a bare GET (unbilled, no mutation)');
  assert.match(m6, /runTxn\(fkey, 'recoveryReload'/, 'the install is the recoveryReload-flavor M2 txn');
  // drafts die and diskStale clears inside the SAME atomic commit — and
  // nowhere else in the machine (M6 invariant 2)
  const txn = m6.slice(m6.indexOf("runTxn(fkey, 'recoveryReload'"));
  assert.ok(txn.includes('delete drafts[fkey];') && txn.includes('diskStale.delete(fkey);'),
    'drafts destruction and diskStale clearing share the atomic T3 commit');
  assert.equal(m6.split('delete drafts[fkey];').length - 1, 1,
    'exactly one drafts destruction in the whole machine');
  // the disposal matrix retires an in-flight flight (A20)
  assert.match(pane, /staleFlights\.delete\(fkey\);/, 'reallyDispose clears the reconcile flight');
});

/* ═══ A — the A9 GATE, success leg (M6 T1→T3) + redo no-op ═══ */

test('A9 GATE: conflict → ⚠ → ⌘Z to the old baseline → automatic fresh reload — saved only after the model shows the NEW disk text; savedAltId===fresh; redo is a no-op', opts, async () => {
  const { context, page, errs } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    const gate = netGate(page);
    const THEIRS = await pinStale(page, 'gate');
    const pre = await snap(page, FK.gate);
    assert.equal(pre.stale, true, '⚠ pinned (M4 T2 bail — M6 entry state)');
    assert.ok(pre.draft.includes('MINE '), 'the draft is pinned on screen');
    assert.match((await chip(page)).cls, /stale/, 'chip warns before the undo');

    const g0 = gate.gets.length;
    await installChipSpy(page, FK.gate, THEIRS);
    await undoToClean(page, FK.gate); // genuine ⌘Z back to savedAltId → T1 fires
    await waitLog(page, FK.gate, 'stale-reload');
    await page.waitForFunction((fk) => !window.__mp.store().diskStale.has(fk), FK.gate, { timeout: 5000 });
    const frames = await takeChipFrames(page);

    const s = await snap(page, FK.gate);
    assert.equal(s.text, THEIRS, 'the model shows the NEW disk text — the automatic fresh reload');
    assert.equal(s.draft, null, 'drafts retired inside the atomic commit');
    assert.equal(s.base, null);
    assert.equal(s.stale, false, 'diskStale cleared in the same commit');
    assert.equal(s.dirty, false, 'savedAltId === the fresh altId');
    assert.equal(typeof s.savedAlt, 'number', 'a real altId captured from the fresh bytes');
    assert.equal(s.cache.text, THEIRS, 'fileCache commit is exactly the fresh bytes');
    assert.ok(Number.isFinite(s.cache.mtimeMs), '…with the fresh finite mtime (A9: verified disk only)');
    assert.ok(!(await chip(page)).cls.includes('dirty') && !(await chip(page)).cls.includes('stale'),
      "chip reads plain 'saved' after the reload");
    assertChipTruth(frames, { expectPlainTail: true }); // ⚠ every frame until the fresh text is in
    assert.equal(gate.gets.length, g0 + 1, 'exactly one reconcile GET');

    // redo after the completed reload is a no-op — the undo stack was cleared
    // (reconciliation rule): the stale baseline is unreachable in either direction
    await redoOnce(page);
    await sleep(250);
    let post = await snap(page, FK.gate);
    assert.equal(post.text, THEIRS, '⇧⌘Z cannot resurrect the old baseline');
    assert.equal(post.draft, null, '…and cannot manufacture a draft');
    assert.equal(post.dirty, false);
    await undoOnce(page);
    await sleep(250);
    post = await snap(page, FK.gate);
    assert.equal(post.text, THEIRS, '⌘Z is equally dead — the reload is the floor');
    assert.deepEqual(errs, [], 'no page errors');
  } finally {
    await context.close();
  }
});

/* ═══ B — the A9 GATE, fetch-failure leg (T5 StaleHeld → T6 retry) ═══ */

test('A9 GATE failure leg: reconcile GET fails → ⚠ retained, drafts retained, savedAltId untouched, zero saved frames; un-stub → the next alt-clean event retries and completes', opts, async () => {
  const { context, page } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 1, FK.held);
    const gate = netGate(page);
    const THEIRS = await pinStale(page, 'held');
    const pre = await snap(page, FK.held);

    gate.cfg.get = 'abort'; // the reconcile GET dies on the wire (T5)
    await installChipSpy(page, FK.held, THEIRS);
    await undoToClean(page, FK.held);
    await waitLog(page, FK.held, 'stale-held');
    await sleep(200);
    const frames = await takeChipFrames(page);
    assertChipTruth(frames, { expectPlainTail: false }); // ZERO 'saved' frames

    const held = await snap(page, FK.held);
    assert.equal(held.stale, true, '⚠ retained — fetch failure is non-destructive');
    assert.notEqual(held.draft, null, 'drafts retained (the 409 net stays armed)');
    assert.equal(held.draft, held.text, 'the draft mirrors the on-screen text (P1 stays true)');
    assert.equal(held.text.includes('MINE '), false, 'the screen shows the undone (old baseline) text');
    assert.equal(held.savedAlt, pre.savedAlt, 'savedAltId untouched — only verified fresh bytes may move it');
    assert.equal(held.cache.text, pre.cache.text, 'fileCache untouched (the frozen M4 BASE)');
    assert.equal(held.base, pre.base, 'draftBase still the OLD mtime');
    assert.equal(held.flight.inFlight, false, 'the flight settled — infinitely retryable');
    assert.match((await chip(page)).cls, /stale/, 'chip still warns');

    // un-stub → the retry re-arms on the NEXT alt-clean event (the natural
    // onIdleEdit path): type, undo — T6 → T1 → T3 completes the reload
    gate.cfg.get = 'pass';
    await typeAt(page, 3, 1, 'R');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.held);
    assert.equal((await snap(page, FK.held)).stale, true, 'still ⚠ while dirty again (StaleDirty)');
    await undoToClean(page, FK.held);
    await waitLog(page, FK.held, 'stale-reload');
    const done = await snap(page, FK.held);
    assert.equal(done.text, THEIRS, 'the retry completed the reload');
    assert.equal(done.draft, null);
    assert.equal(done.stale, false);
    assert.equal(done.dirty, false);
    assert.ok(!(await chip(page)).cls.includes('stale') && !(await chip(page)).cls.includes('dirty'));

    const log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.held);
    assert.equal(log.filter((e) => e.ev === 'stale-fetch').length, 2, 'two flights: the held one + the retry');
    assert.equal(log.filter((e) => e.ev === 'stale-held').length, 1, 'one StaleHeld');
    assert.equal(log.filter((e) => e.ev === 'stale-reload').length, 1, 'one completed reload');
  } finally {
    await context.close();
  }
});

/* ═══ C — chip-truth frames through a held reconcile + single-flight ═══ */

test('chip truth: every frame between the undo and the fetch resolving shows ⚠; a type-then-undo shimmy during the flight coalesces (single-flight) and the reload still lands', opts, async () => {
  const { context, page } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 2, FK.chip);
    const gate = netGate(page);
    const THEIRS = await pinStale(page, 'chip');

    const g0 = gate.gets.length;
    gate.cfg.get = 'hold'; // freeze the Reconciling window open
    await installChipSpy(page, FK.chip, THEIRS);
    await undoToClean(page, FK.chip);
    await gate.waitGets(g0 + 1); // the reconcile GET is in flight, held
    let mid = await snap(page, FK.chip);
    assert.equal(mid.flight.inFlight, true, 'Reconciling — the flight is live');
    assert.equal(typeof mid.flight.rev, 'number', 'the model revision was recorded at fetch start (A20)');

    // shimmy: type (T7 → StaleDirty), undo back (T1 re-entry) — the second
    // alt-clean event must coalesce onto the SAME flight, never stack a GET
    await typeAt(page, 2, 1, 'Z');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.chip);
    await undoToClean(page, FK.chip);
    await sleep(300);
    assert.equal(gate.gets.length, g0 + 1, 'single-flight: the shimmy fired no second GET');
    mid = await snap(page, FK.chip);
    assert.equal(mid.flight.inFlight, true, 'still the one flight');
    assert.equal(mid.stale, true);
    assert.notEqual(mid.draft, null, 'drafts retained across the whole held window');
    // every frame so far — install → undo → shimmy — warned
    const midFrames = await page.evaluate(() => window.__chipFrames.slice());
    for (const f of midFrames) {
      assert.ok(isWarn(f.cls), `⚠ at every frame while the fetch is unresolved — ${JSON.stringify(f)}`);
    }

    gate.cfg.get = 'pass';
    gate.release();
    // the shimmy round-tripped the altId back to the recorded revision, so
    // the fetched bytes are still truthful and the reload applies (A20:
    // altId — undo-aware — is the revision check, not versionId)
    await waitLog(page, FK.chip, 'stale-reload');
    const frames = await takeChipFrames(page);
    assertChipTruth(frames, { expectPlainTail: true });
    const s = await snap(page, FK.chip);
    assert.equal(s.text, THEIRS, 'fresh bytes installed');
    assert.equal(s.stale, false);
    assert.equal(s.dirty, false);
    assert.equal(s.draft, null);
    const log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.chip);
    assert.equal(log.filter((e) => e.ev === 'stale-fetch').length, 1, 'one flight, ever');
  } finally {
    await context.close();
  }
});

/* ═══ D — Reconciling interrupted: the T7 redo leg, then the T4 typing leg ═══ */

test('redo immediately after T1 (before the fetch returns) → StaleDirty, the eventual resolution is a revision no-op; typing during a second reconcile discards too — model, fileCache, savedAltId untouched; the third flight completes', opts, async () => {
  const { context, page } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 3, FK.abort);
    const gate = netGate(page);
    const THEIRS = await pinStale(page, 'abort');

    // ── leg 1 (the mandated T7 literal): a genuine ⇧⌘Z lands while the fetch
    // is in flight — redo re-materializes the undone edit, the altId moves
    // off the recorded revision, and the eventual resolution must be a
    // no-op on exactly the A20 revision check ──
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await undoToClean(page, FK.abort);
    await gate.waitGets(g0 + 1); // Reconciling, held
    await redoOnce(page); // T7 → StaleDirty before the fetch returns
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.abort);
    const preR = await snap(page, FK.abort);
    assert.equal(preR.stale, true, 'StaleDirty — ⚠ stands through the redo');
    assert.equal(preR.draft, preR.text, 'the redo re-materialized the draft through the normal pipeline');
    gate.cfg.get = 'pass';
    gate.release(); // the fetch resolves WITH the fresh bytes — now stale to the model
    await waitLogN(page, FK.abort, 'stale-discard', 1);
    await sleep(200);
    const r = await snap(page, FK.abort);
    assert.equal(r.text, preR.text, 'the redone text is untouched — the resolution was a no-op');
    assert.notEqual(r.text, THEIRS, 'the fetched bytes were NOT installed after the redo');
    assert.equal(r.cache.text, preR.cache.text, 'fileCache untouched (frozen M4 BASE)');
    assert.equal(r.savedAlt, preR.savedAlt, 'savedAltId untouched by the discarded fetch');
    assert.equal(r.stale, true, 'still StaleDirty');
    let log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.abort);
    assert.equal(log.filter((e) => e.ev === 'stale-discard').at(-1).why, 'revision', 'redo leg discarded on the A20 revision check');

    // ── leg 2 (T4): typing lands while a SECOND reconcile is in flight ──
    gate.cfg.get = 'hold';
    await undoToClean(page, FK.abort);
    await gate.waitGets(g0 + 2); // flight 2, held
    await typeAt(page, 2, 1, 'Q');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.abort);
    const preRelease = await snap(page, FK.abort);
    assert.equal(preRelease.stale, true);

    gate.cfg.get = 'pass';
    gate.release();
    await waitLogN(page, FK.abort, 'stale-discard', 2);
    await sleep(200);

    const s = await snap(page, FK.abort);
    assert.equal(s.text, preRelease.text, 'the model text is untouched — never replaced under a moving caret');
    assert.ok(s.text.includes('Q'), 'the mid-flight keystroke survives');
    assert.notEqual(s.text, THEIRS, 'the fetched bytes were NOT installed');
    assert.equal(s.cache.text, preRelease.cache.text, 'fileCache untouched — the fetched bytes are fully discarded (frozen M4 BASE)');
    assert.equal(s.cache.mtimeMs, preRelease.cache.mtimeMs, '…mtime included');
    assert.equal(s.stale, true, 'StaleDirty — ⚠ stands');
    assert.equal(s.savedAlt, preRelease.savedAlt, 'savedAltId untouched by a discarded fetch');
    assert.equal(s.draft, s.text, 'drafts stayed true through the abort');
    assert.equal(s.flight.inFlight, false, 'the flight settled');
    log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.abort);
    assert.equal(log.filter((e) => e.ev === 'stale-discard').at(-1).why, 'revision', 'typing leg discarded on the A20 revision check');
    assert.match((await chip(page)).cls, /stale/, 'chip still warns');

    // the machine re-arms: undoing back to the baseline fires a FRESH flight
    // that completes normally (discard never degrades the machine)
    await undoToClean(page, FK.abort);
    await waitLog(page, FK.abort, 'stale-reload');
    const done = await snap(page, FK.abort);
    assert.equal(done.text, THEIRS, 'the retry after two discards installed the fresh bytes');
    assert.equal(done.stale, false);
    assert.equal(done.dirty, false);
    assert.equal(gate.gets.length, g0 + 3, 'exactly three GETs: two discarded flights + the completing one');
  } finally {
    await context.close();
  }
});

/* ═══ E — ⌘S in AltCleanStale: the 409 net was never disarmed ═══ */

test('⌘S while AltCleanStale → the PUT carries the OLD baseline and 409s (M5 prompt); cancel keeps the suppressed-clean state; the held reconcile then completes normally', opts, async () => {
  const { context, page } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 4, FK.net);
    const gate = netGate(page);
    const THEIRS = await pinStale(page, 'net'); // disk mtime pushed past the 250ms grace
    const pre = await snap(page, FK.net);

    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await undoToClean(page, FK.net);
    await gate.waitGets(g0 + 1); // AltCleanStale with the reconcile held open

    // the suppression kept drafts ⇒ beginSave still issues a token with
    // base = draftBase (the OLD mtime) ⇒ the server 409s ⇒ M5's prompt
    const p0 = gate.puts.length;
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    assert.equal(gate.puts.length, p0 + 1, 'the ⌘S dispatched a real PUT — the net was never disarmed');
    assert.equal(gate.puts[p0].body.baseMtimeMs, pre.base, 'the PUT rode the OLD baseline (draftBase pinned)');
    await page.click('#confirmBack .cbCancel'); // M5 T1 — a total no-op
    await sleep(250);
    const c = await snap(page, FK.net);
    assert.notEqual(c.draft, null, 'cancel kept the draft — the suppressed-clean state survives M5');
    assert.equal(c.stale, true, '⚠ retained');
    assert.equal(c.flight.inFlight, true, 'the reconcile flight is still live');
    assert.match((await chip(page)).cls, /stale/, 'chip still warns');
    assert.equal(fs.readFileSync(path.join(alphaRoot, REL.net), 'utf8'), THEIRS,
      'the 409 stopped the stale bytes from reaching disk');

    // release the reconcile: nothing in the ⌘S/409/cancel round moved the
    // model revision, so the fetched fresh bytes still apply (T3)
    gate.cfg.get = 'pass';
    gate.release();
    await waitLog(page, FK.net, 'stale-reload');
    const done = await snap(page, FK.net);
    assert.equal(done.text, THEIRS, 'the reload completed after the 409 round');
    assert.equal(done.draft, null);
    assert.equal(done.stale, false);
    assert.equal(done.dirty, false);
    assert.ok(!(await chip(page)).cls.includes('stale') && !(await chip(page)).cls.includes('dirty'),
      "chip reads 'saved' — truthfully, at last");
  } finally {
    await context.close();
  }
});

/* ═══ F — file:changed while StaleHeld → routes through mergeRuns into M4 ═══ */

test('file:changed while StaleHeld routes through mergeRuns into M4: OURS===BASE (the refreshed draft) merges trivially and the reload lands as M4\'s dissolve commit; serialization spy — no second fetch while the merge is in flight, M6 stays quiescent and never commits', opts, async () => {
  const { context, page, errs } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 5, FK.fcheld);
    const gate = netGate(page);
    await pinStale(page, 'fcheld');

    gate.cfg.get = 'abort'; // T5: the reconcile GET dies on the wire → StaleHeld
    await undoToClean(page, FK.fcheld);
    await waitLog(page, FK.fcheld, 'stale-held');
    const held = await snap(page, FK.fcheld);
    assert.equal(held.stale, true, 'StaleHeld: ⚠ retained');
    assert.equal(held.flight.inFlight, false, 'the failed flight settled');
    // the T1 drafts-refresh amendment (s05 §M6), observed: the retained draft
    // was refreshed to the on-screen undone text, which IS the frozen BASE —
    // this is what makes the merge below trivial (OURS===BASE)
    assert.equal(held.draft, held.cache.text, 'drafts[k] === fileCache BASE in StaleHeld');

    // the session lands ANOTHER overlapping write and file:changed fires:
    // drafts[k] is non-null (retained by suppression), so sessionFileChanged
    // chains it into mergeRuns → autoMergeDisk → M4 — the "or the next
    // file:changed" retry arm of T5/T6. Hold the merge's THEIRS fetch open
    // to inspect the window.
    const rel = REL.fcheld;
    const THEIRS2 = withLine(baseOf(rel.replace(/\.tex$/, '')), 2, `CLAUDE2 ${rel} second overlap`);
    fs.writeFileSync(path.join(alphaRoot, rel), THEIRS2);
    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await installChipSpy(page, FK.fcheld, THEIRS2);
    await push(page, 'file:changed', { project: 'alpha', rel });
    await gate.waitGets(g0 + 1); // the merge's THEIRS fetch is in flight, held

    // serialization spy (the mergeRuns chain, merge-suite E idiom entered
    // from the M6 state): a second file:changed during the held window must
    // NOT fetch — it queues strictly behind merge 1
    await push(page, 'file:changed', { project: 'alpha', rel });
    await sleep(300);
    assert.equal(gate.gets.length, g0 + 1,
      'no second fetch while merge 1 is in flight (mergeRuns serialization)');
    // …and M6 never interleaves: no reconcile flight of its own, no new
    // stale-fetch, stores + model byte-untouched while the window is open
    const mid = await snap(page, FK.fcheld);
    assert.equal(mid.flight.inFlight, false, 'M6 fired no flight of its own (quiescent in StaleHeld)');
    assert.equal(mid.stale, true, '⚠ stands across the held window');
    assert.equal(mid.draft, held.draft, 'drafts untouched across the held window');
    assert.equal(mid.text, held.text, 'model untouched across the held window');
    assert.equal(mid.savedAlt, held.savedAlt, 'savedAltId untouched');
    let log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.fcheld);
    assert.equal(log.filter((e) => e.ev === 'stale-fetch').length, 1, 'still just the ONE (failed) M6 fetch, ever');

    gate.cfg.get = 'pass';
    gate.release();
    // OURS===BASE ⇒ merge3(BASE, BASE, THEIRS2) === THEIRS2 ⇒ M4's dissolve
    // commit retires drafts/draftBase and clears diskStale in files.js's one
    // synchronous block, then applyExternal(mergeRebase) installs THEIRS2
    // with undo cleared and savedAltId := the fresh altId — the automatic
    // fresh reload, delivered through M4 instead of the M6 flight
    await page.waitForFunction(([fk, t]) => window.__mp.text(fk) === t, [FK.fcheld, THEIRS2], { timeout: 10000 });
    await sleep(400); // let the queued merge 2 (draft-vanished branch) settle too
    const frames = await takeChipFrames(page);
    assertChipTruth(frames, { expectPlainTail: true }); // ⚠ every frame until THEIRS2 is in

    const s = await snap(page, FK.fcheld);
    assert.equal(s.text, THEIRS2, 'the model shows the NEW disk text — the reload landed through M4');
    assert.equal(s.draft, null, 'drafts retired by the dissolve commit');
    assert.equal(s.base, null, '…draftBase too');
    assert.equal(s.stale, false, '⚠ cleared in the same commit');
    assert.equal(s.dirty, false, 'savedAltId === the fresh altId');
    assert.equal(typeof s.savedAlt, 'number');
    assert.equal(s.cache.text, THEIRS2, 'fileCache commit is exactly the fresh bytes');
    assert.ok(Number.isFinite(s.cache.mtimeMs), '…with a finite mtime (the M4 trust bar)');
    log = await page.evaluate((fk) => window.__mp.saveLog(fk), FK.fcheld);
    assert.equal(log.filter((e) => e.ev === 'stale-reload').length, 0,
      'M6 never committed — M4 owned the reload (no interleaving)');
    assert.equal(log.filter((e) => e.ev === 'stale-fetch').length, 1, 'M6 fired no further flight');
    assert.ok(await page.evaluate(() => document.getElementById('toast').textContent.includes('merged the session')),
      'the M4 merge toast fired — the reload routed through autoMergeDisk, not the M6 leg');
    // mergeRebase cleared the undo stack: nothing on either side of history
    await redoOnce(page);
    await sleep(200);
    assert.equal((await snap(page, FK.fcheld)).text, THEIRS2, '⇧⌘Z cannot resurrect anything pre-merge');
    assert.deepEqual(errs, [], 'no page errors');
  } finally {
    await context.close();
  }
});

/* ═══ G — I1 drafts retention: simulated boot failure in AltCleanStale ═══ */

test('I1 drafts retention: kill the Monaco instance in AltCleanStale (reboot + injected init failure) → the legacy fallback still has drafts[k] on screen, ⚠ retained, preference unchanged; the dead flight\'s late resolution is dropped', opts, async () => {
  const { context, page, errs } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 6, FK.fall);
    const gate = netGate(page);
    await pinStale(page, 'fall');

    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await undoToClean(page, FK.fall);
    await gate.waitGets(g0 + 1); // AltCleanStale, the reconcile GET held open
    const pre = await snap(page, FK.fall);
    assert.equal(pre.stale, true, '⚠ pinned — the machine state under test');
    assert.notEqual(pre.draft, null, 'the suppressed-clean draft is live');
    assert.equal(pre.flight.inFlight, true, 'Reconciling — the flight is held');

    // ── kill the Monaco instance: a fresh boot generation with an injected
    // INIT failure (the A6 __mpInitThrow seam, armed BEFORE reboot so no
    // clean re-boot can slip in between). reboot disposes every model —
    // drafts live in store.js and are untouched by design (I1) — and the
    // failed generation runs edge 13's atomic fallback: forcedLegacy pinned
    // session-only, the registered fallbackCb re-renders the legacy editor. ──
    const boot = await page.evaluate(() => {
      window.__mpInitThrow = true;
      window.__mp.reboot();
      return window.__mp.ensure();
    });
    assert.equal(boot.ok, false, 'the injected boot failed');
    assert.equal(boot.stage, 'init');
    await page.waitForSelector('textarea#codeEditor', { timeout: 10000 });

    const after = await page.evaluate((fk) => {
      const s = window.__mp.store();
      const ta = document.querySelector('textarea#codeEditor');
      const ss = document.querySelector('#saveState');
      return {
        state: window.__mp.state(),
        forced: window.__mp.forcedLegacy(),
        impl: window.__mp.impl(),
        stored: localStorage.getItem('editor:impl'),
        draft: s.drafts[fk] ?? null,
        base: s.draftBase[fk] ?? null,
        stale: s.diskStale.has(fk),
        taFkey: ta ? ta.dataset.fkey : null,
        taValue: ta ? ta.value : null,
        chip: ss ? ss.className : null,
        monacoNodes: document.querySelectorAll('.monaco-editor').length,
        models: window.__mp.models(),
        flight: window.__mp.staleState(fk),
      };
    }, FK.fall);
    assert.equal(after.state, 'FALLBACK_LEGACY', 'the boot machine ended in the atomic fallback');
    assert.equal(after.forced, true, 'session-only fallback pin');
    assert.equal(after.impl, 'legacy');
    assert.equal(after.stored, 'monaco', 'the stored preference is NEVER written by a failed boot (A6)');
    assert.equal(after.draft, pre.draft, 'drafts[k] survived the kill byte-identical (I1)');
    assert.equal(after.base, pre.base, 'draftBase still pinned on the OLD mtime — the 409 net stays armed');
    assert.equal(after.stale, true, '⚠ survived the kill');
    assert.equal(after.taFkey, FK.fall, 'the legacy fallback rendered this fkey');
    assert.equal(after.taValue, pre.draft, 'the legacy textarea seeds from drafts[k] — the draft is ON SCREEN');
    assert.match(String(after.chip), /stale/,
      'the chip still warns across the implementation boundary (saveChipState reads drafts+diskStale)');
    assert.equal(after.monacoNodes, 0, 'the Monaco DOM is gone');
    assert.deepEqual(after.models, [], 'the model registry was disposed (reboot)');
    assert.equal(after.flight.inFlight, false, 'reallyDispose retired the reconcile flight (A20)');

    // release the held GET: the dead flight's late resolution must be dropped
    // by the flight-identity check — zero store mutation, zero errors
    gate.cfg.get = 'pass';
    gate.release();
    await sleep(400);
    const post = await page.evaluate((fk) => {
      const s = window.__mp.store();
      return {
        draft: s.drafts[fk] ?? null,
        stale: s.diskStale.has(fk),
        reloads: window.__mp.saveLog(fk).filter((e) => e.ev === 'stale-reload').length,
      };
    }, FK.fall);
    assert.equal(post.draft, pre.draft, 'the late resolution mutated nothing');
    assert.equal(post.stale, true, '⚠ still stands — nothing pretended to reconcile');
    assert.equal(post.reloads, 0, 'no stale-reload was ever logged — the dead flight dropped silently');
    assert.deepEqual(errs, [], 'no page errors across the kill');
    // Scope boundary, on purpose: the legacy input path (workbench.js)
    // deletes drafts[k] when the textarea round-trips back to
    // fileCache[k].text with no diskStale suppression — pre-existing legacy
    // behavior outside this machine (the legacy editor stays byte-untouched
    // in Phase 3). This test pins the HANDOFF: the fallback itself destroys
    // nothing, per the s05 §M6 I1 bullet.
  } finally {
    await context.close();
  }
});

/* ═══ H — T3's no-write branch: the external change round-tripped back ═══ */

test('T3 no-write round-trip: the reconcile fetch returns bytes identical to the undone model → capture with NO setValue — undo stack intact (⇧⌘Z re-materializes the typing as a plain dirty edit), chip saved, fileCache/savedAltId committed', opts, async () => {
  const { context, page } = await stalePage();
  try {
    await waitEditor(page, FK.gate);
    await clickTab(page, 7, FK.round);
    const gate = netGate(page);
    await pinStale(page, 'round');
    const BASE = baseOf(REL.round.replace(/\.tex$/, ''));

    const g0 = gate.gets.length;
    gate.cfg.get = 'hold';
    await installChipSpy(page, FK.round, BASE);
    await undoToClean(page, FK.round);
    await gate.waitGets(g0 + 1); // Reconciling, held
    // …the session reverts its own write while the fetch is held: disk goes
    // BACK to the original baseline — exactly the bytes the undone model
    // already shows (fresh === serialize(m) at resolution time)
    const fpath = path.join(alphaRoot, REL.round);
    fs.writeFileSync(fpath, BASE);
    const future = new Date(Date.now() + 20000);
    fs.utimesSync(fpath, future, future);
    gate.cfg.get = 'pass';
    gate.release();
    await waitLog(page, FK.round, 'stale-reload');
    const frames = await takeChipFrames(page);
    assertChipTruth(frames, { expectPlainTail: true }); // ⚠ until the (identical) fresh bytes verify

    const s = await snap(page, FK.round);
    assert.equal(s.text, BASE, 'the model already showed the fresh bytes — nothing was written');
    assert.equal(s.draft, null, 'drafts retired inside the atomic commit');
    assert.equal(s.base, null);
    assert.equal(s.stale, false, 'diskStale cleared in the same commit');
    assert.equal(s.dirty, false, 'savedAltId captured from the CURRENT altId — no event, no write');
    assert.equal(s.cache.text, BASE, 'fileCache committed the verified fresh bytes');
    assert.ok(Number.isFinite(s.cache.mtimeMs), '…with the fresh finite mtime');

    // the distinguishing observable vs the setValue branch (test A's dead
    // redo): the undo stack SURVIVED — ⇧⌘Z re-materializes the pre-undo
    // typing as an ordinary dirty edit through the normal M2-idle pipeline
    await redoOnce(page);
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.round, { timeout: 5000 });
    const redone = await snap(page, FK.round);
    assert.notEqual(redone.text, BASE, '⇧⌘Z re-applied the typed edit — the stack was NOT cleared (T3 no-write)');
    assert.equal(redone.draft, redone.text, 'the redo flows through the normal pipeline — an ordinary draft');
    assert.equal(redone.stale, false, 'no ⚠: this is plain Dirty, not the machine');
    await undoToClean(page, FK.round);
    assert.equal((await snap(page, FK.round)).draft, null, '…and undo reads clean again (savedAltId is real)');
  } finally {
    await context.close();
  }
});
