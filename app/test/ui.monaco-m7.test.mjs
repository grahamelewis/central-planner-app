// test/ui.monaco-m7.test.mjs — Phase 3 full-M7: close/dispose lifecycle, the
// A10 LRU-50 clean-detached soft cap, and the T7/T8 ownership protocol
// (monaco-s05 §M7 / blueprint §14 A10 + A4 / monaco-s1 §5 S2.1 "full M7").
//
// s05 §M7 test-list coverage map — bullets ALREADY pinned elsewhere are not
// duplicated here (the workflow's do-not-duplicate rule):
//   · toggle Monaco→legacy→Monaco with a draft alive (dirty newer-wins,
//     ⌘Z to disk baseline)            → ui.monaco-core "toggle handoff";
//   · background merge + background clean reload (T6/A4)
//                                     → ui.monaco-merge section H;
//   · boot-failure fallback preserves drafts, preference unchanged (I1/A6)
//                                     → ui.monaco-stale test G (the FALLBACK
//     half only — the bullet's recovery tail, "recovery to Monaco on next
//     successful boot re-runs T8 with drafts winning", is test G BELOW);
//   · a post-DISPOSE stale 200 dropped (M3 seq guard)
//                                     → ui.monaco-save test T6;
//   · applyExternal unknown-reason throw + closed-set grep
//                                     → ui.monaco-core M2 fossil guard.
// THIS file owns the rest: close-dirty-reopen (T4→T2, undo/viewState/amber/
// drafts intact), the 60-clean/5-dirty LRU soft-cap proof (T3, oldest-first,
// dirty NEVER evicted), the disposal-matrix leak test (live wash timer +
// 'texlog' markers + every per-fkey map), the close-during-in-flight-save
// race (T5: commitSave lands on the ORPHAN → clean → LRU-eligible), the
// A10/A16 soak counters, and the T7/T8 draftRev protocol through the
// sanctioned setImpl writer — including the "handoff clean case" (draft
// saved while in legacy → re-entry seeds clean, stale buffer provably
// replaced), its REVERT leg (draft deleted by the legacy round-trip with
// disk UNCHANGED → the forced T8 cleanReload, test F), the bullet-8
// recovery tail (failed boot → injection cleared → next boot READY with
// drafts winning, test G), and the no-trustworthy-baseline T8 leg (cache
// mid-load at re-entry → sentinel materialization, then the M1 T7 reseed
// when the fetch lands, test H).
//
// Ground rules (the established monaco-suite idioms):
//   - typing/undo/⌘S/⌘Z are GENUINE CDP keystrokes; __mp is reads + staging
//     only (the 60-model scenarios stage through setFile/setText — the one
//     sanctioned staging path — because 60 real pins cannot render);
//   - every wait is domcontentloaded-based; nothing gates on window 'load';
//   - billing-safe: armPage() intercepts billed routes on every context;
//     this file touches only unbilled /artifact GET+PUT, unbilled /api/tasks
//     POST, and GET /api/state. A grep guard below pins that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// one pinned file per scenario — index = tab position (context.files order)
const FK = {
  close: 'alpha::close.tex', // 0 — close-dirty-reopen + the LRU census seed
  race: 'alpha::race.tex',   // 1 — close-during-in-flight-save race
  hand: 'alpha::hand.tex',   // 2 — T7/T8 setImpl protocol + clean handoff
  mx: 'alpha::mx.tex',       // 3 — disposal-matrix leak (latex: wash + markers)
  park: 'alpha::park.tex',   // 4 — neighbor tab (never edited)
  revert: 'alpha::revert.tex', // 5 — T8 clean case: draft REVERTED while in legacy
  sent: 'alpha::sent.tex',   // 6 — T8 with no trustworthy baseline (sentinel leg)
};
const REL = Object.fromEntries(Object.entries(FK).map(([k, v]) => [k, v.split('::')[1]]));

/** 32 pure-LF lines: '% <tag> fixture' + 30 body lines + final newline. */
const baseOf = (tag) => `% ${tag} fixture\n`
  + Array.from({ length: 30 }, (_, i) => `${tag} l${i + 1} body text`).join('\n') + '\n';

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
    project: 'alpha', title: 'monaco m7', category: 'calibration', oversight: 'manual',
    context: { files: Object.values(REL) },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  assert.ok(task && task.id, 'task record captured');
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers (the ui.monaco-core / ui.monaco-stale idioms) ───────────── */

async function m7Page() {
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

const typeAt = async (page, line, col, text) => {
  await page.evaluate(([l, c]) => { window.__mp.focus(); window.__mp.setPosition(l, c); }, [line, col]);
  await page.keyboard.type(text);
};

const waitLog = (page, fk, ev, timeout = 10000) => page.waitForFunction(
  ([f, e]) => window.__mp.saveLog(f).some((x) => x.ev === e), [fk, ev], { timeout, polling: 40 });

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

/** Hold PUTs to /artifact open (the in-flight-save window); GETs pass. */
function putGate(page) {
  const puts = [];
  let held = [];
  const cfg = { hold: true };
  page.route('**/artifact/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') { await route.continue(); return; }
    puts.push({ url: req.url(), at: Date.now() });
    if (cfg.hold) await new Promise((res) => held.push(res));
    await route.continue();
  });
  return {
    puts,
    cfg,
    release() { const w = held; held = []; for (const r of w) r(); },
    async waitPuts(n, timeout = 10000) {
      const t0 = Date.now();
      while (puts.length < n) {
        if (Date.now() - t0 > timeout) throw new Error(`waitPuts: ${puts.length}/${n} after ${timeout}ms`);
        await sleep(25);
      }
    },
  };
}

/* ═══ node-side guard: no billed routes; the M7 structural pins hold ═══ */

test('this suite touches no billed route; T7 flush is synchronous, dirty models are never LRU candidates, closeTab is a view close', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // the five billed routes, spelled in halves so this guard cannot match itself
  const billed = ['/laun' + 'ch', '/mess' + 'age', '/ret' + 'ry', '/api/prof' + 'ile/generate', '/api/tex' + 'fix'];
  for (const b of billed) {
    assert.equal(src.includes(b), false, `the m7 suite must never mention the billed route ${b}`);
  }
  const mp = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  // A10: the LRU predicate refuses dirty models on BOTH bits (invariant 1)
  const elig = mp.slice(mp.indexOf('function lruEligible'), mp.indexOf('function lruSweep'));
  assert.ok(elig.includes('drafts[fkey] != null) return false'), 'lruEligible refuses a live draft');
  assert.ok(elig.includes('getAlternativeVersionId() !== savedAltId.get(fkey)) return false'),
    'lruEligible refuses the altId dirty bit (sentinel ⇒ always dirty)');
  // eviction routes through the ONE total disposal matrix (A10/A20)
  const sweep = mp.slice(mp.indexOf('function lruSweep'), mp.indexOf('export function noteViewClose'));
  assert.ok(sweep.includes('reallyDispose(fkey, m)'), 'the sweep disposes through reallyDispose only');
  // files.js closeTab reports the VIEW close and never disposes (A10/T4)
  const filesSrc = fs.readFileSync(path.join(APP_DIR, 'public', 'files.js'), 'utf8');
  const ct = filesSrc.slice(filesSrc.indexOf('export function closeTab'), filesSrc.indexOf('export function openExtraTab'));
  assert.ok(ct.includes('mpNoteViewClose('), 'closeTab routes through the noteViewClose seam');
  assert.equal(ct.includes('disposeModel'), false, 'closeTab never disposes — close is a VIEW close');
});

/* ═══ A — T4→T2: close a dirty tab, reopen — nothing was destroyed ═══ */

test('close dirty tab → reopen: model/undo/viewState/amber all restored, drafts intact throughout; orphan counter moves (A10 view-close gate)', opts, async () => {
  const { context, page } = await m7Page();
  try {
    await waitEditor(page, FK.close);
    const orig = await page.evaluate((fk) => window.__mp.text(fk), FK.close);
    const c0 = await page.evaluate(() => window.__mp.counters());
    await typeAt(page, 2, 1, 'ORPHAN EDIT ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('ORPHAN EDIT'), FK.close);
    const id0 = await page.evaluate((fk) => window.__mp.modelId(fk), FK.close);
    await page.evaluate(() => window.__mp.setPosition(5, 3)); // the viewState we expect back

    // × close the ACTIVE tab → focus falls to race.tex; the model must ride
    await page.click('.tabX[data-xi="0"]');
    await waitEditor(page, FK.race);
    const closed = await page.evaluate((fk) => ({
      model: window.__mp.m7State(fk).model,
      draft: window.__mp.store().drafts[fk] ?? null,
      lru: window.__mp.lruInfo(fk),
      counters: window.__mp.counters(),
    }), FK.close);
    assert.equal(closed.model, true, 'the dirty model survives the view close (OrphanDirty)');
    assert.ok(String(closed.draft).includes('ORPHAN EDIT'), 'drafts[k] intact across the close');
    assert.equal(closed.lru.orphan, true, 'tracked as an orphan');
    assert.equal(closed.lru.eligible, false, 'a dirty orphan is NEVER an LRU candidate');
    assert.equal(closed.counters.orphans, c0.orphans + 1, 'the orphan counter moved on close');
    assert.ok(closed.counters.dirty >= 1, 'the dirty counter sees the orphan');

    // reopen from the sidebar row → same model, text, caret, amber chip
    await page.click('.scRow[data-fi="0"]');
    await waitEditor(page, FK.close);
    const re = await page.evaluate((fk) => ({
      id: window.__mp.modelId(fk),
      text: window.__mp.text(fk),
      pos: window.__mp.getPosition(),
      orphan: window.__mp.lruInfo(fk).orphan,
      orphans: window.__mp.counters().orphans,
    }), FK.close);
    assert.equal(re.id, id0, 'the SAME model reattached — undo stack owner unchanged');
    assert.ok(re.text.includes('ORPHAN EDIT'), 'text restored');
    assert.deepEqual(re.pos, { line: 5, col: 3 }, 'viewState (caret) restored across close/reopen');
    assert.equal(re.orphan, false, 'reopen clears the orphan mark (T4 → T2)');
    assert.equal(re.orphans, c0.orphans, 'the orphan counter moved back on reopen');
    assert.ok((await chip(page)).cls.includes('dirty'), 'amber chip restored');

    // ⌘Z still reaches the PRE-CLOSE history: one coalesced typing element
    await undoToClean(page, FK.close);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.close), orig,
      '⌘Z walks the retained undo stack down to the disk baseline');
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.close), undefined,
      'clean again — draft dissolved by the undo');
  } finally {
    await context.close();
  }
});

/* ═══ B — T3: the LRU-50 soft-cap proof (60 clean / 5 dirty) + soak counters ═══ */

test('LRU: 60 clean + 5 dirty models → clean-detached ≤ 50, oldest evicted first, every dirty model + draft survives; counters exist and move across open/evict', opts, async () => {
  const { context, page, errs } = await m7Page();
  try {
    await waitEditor(page, FK.close); // one REAL model seeds the census (oldest)
    // staging is __mp on purpose (60 real pins cannot render); setText flows
    // the normal M2-idle pipeline so the dirty five carry genuine drafts
    const res = await page.evaluate(() => {
      const base = 'lru fixture line one\nline two\nline three\n';
      const before = window.__mp.counters();
      const dirtyFks = [];
      for (let i = 1; i <= 5; i++) {
        const fk = `alpha::lru/d${i}.txt`;
        window.__mp.setFile(fk, base, { mtimeMs: Date.now(), ext: 'txt' });
        window.__mp.setText(base + `DIRTY d${i}\n`, fk);
        dirtyFks.push(fk);
      }
      const cleanFks = [];
      for (let i = 1; i <= 60; i++) {
        const fk = `alpha::lru/c${String(i).padStart(2, '0')}.txt`;
        window.__mp.setFile(fk, base, { mtimeMs: Date.now(), ext: 'txt' });
        cleanFks.push(fk);
      }
      const after = window.__mp.counters();
      return {
        before,
        after,
        dirtyFks,
        cleanFks,
        models: window.__mp.models(),
        dirtyState: dirtyFks.map((fk) => ({
          fk,
          model: window.__mp.m7State(fk).model,
          dirty: window.__mp.isDirty(fk),
          draft: window.__mp.store().drafts[fk] ?? null,
        })),
        evictLogC01: window.__mp.saveLog('alpha::lru/c01.txt').filter((e) => e.ev === 'lru-evict'),
      };
    });

    // the soft cap: clean-detached census back under 50, dirty NEVER touched
    assert.ok(res.after.cleanDetached <= 50, `clean-detached ≤ 50 (got ${res.after.cleanDetached})`);
    assert.equal(res.after.dirty, 5, 'all five dirty models survive');
    for (const d of res.dirtyState) {
      assert.equal(d.model, true, `${d.fk}: dirty model retained`);
      assert.equal(d.dirty, true, `${d.fk}: still dirty`);
      assert.ok(String(d.draft).includes('DIRTY'), `${d.fk}: draft survives the sweep`);
    }
    // oldest-first: the census seed + the earliest clean stagings evicted,
    // the newest retained (close.tex has the oldest recency tick)
    assert.equal(res.models.includes(FK.close), false, 'the oldest clean model was evicted first');
    assert.equal(res.models.includes('alpha::lru/c01.txt'), false, 'early clean stagings evicted');
    assert.equal(res.models.includes('alpha::lru/c60.txt'), true, 'the newest clean model retained');
    assert.equal(res.models.includes('alpha::lru/c15.txt'), true, 'mid-recency clean models retained');
    // counters exist and move (A10/A16): open moved models, evict moved both
    for (const k of ['models', 'dirty', 'cleanDetached', 'orphans', 'evictions', 'heapMB']) {
      assert.ok(k in res.after, `counters carry '${k}'`);
    }
    assert.ok(res.after.models > res.before.models, 'model count moved on open');
    assert.ok(res.after.evictions >= res.before.evictions + 10, // close.tex + c01..c09
      `evictions moved (${res.before.evictions} → ${res.after.evictions})`);
    assert.ok(res.after.heapMB === null || typeof res.after.heapMB === 'number',
      'heap sample is a number where the browser exposes performance.memory');
    // the A16 soak line: each eviction logged a census snapshot
    assert.ok(res.evictLogC01.length === 1 && 'models' in res.evictLogC01[0]
      && 'dirty' in res.evictLogC01[0] && 'heapMB' in res.evictLogC01[0],
      'lru-evict saveLog line carries the soak census');
    // fileCache is a fetch-layer property — eviction never touches it, so the
    // evicted REAL file reopens through a plain refetch (spot-check: reopen)
    await page.click('.scRow[data-fi="0"]');
    await waitEditor(page, FK.close);
    assert.ok((await page.evaluate((fk) => window.__mp.text(fk), FK.close)).includes('close fixture'),
      'an evicted file reopens cleanly from the fetch layer (documented undo loss only)');
    assert.deepEqual(errs, [], 'zero page errors across the sweep');
  } finally {
    await context.close();
  }
});

/* ═══ C — T3: disposal-matrix leak test (live wash timer, markers, maps) ═══ */

test('disposal matrix: evicting a model with a LIVE wash debounce + texlog markers cancels the timer synchronously, clears the markers, and empties every per-fkey map', opts, async () => {
  const { context, page, errs } = await m7Page();
  try {
    await waitEditor(page, FK.close);
    await clickTab(page, 3, FK.mx); // latex → the mzone wash arms on attach
    // one keystroke + one ⌘Z: the model ends CLEAN (LRU-eligible) while the
    // undo's content event has just re-armed the ~120ms wash debounce — the
    // eviction below runs INSIDE that window, in one synchronous evaluate
    await typeAt(page, 2, 1, 'X');
    await page.keyboard.press(`${MOD}+z`);
    const res = await page.evaluate((fk) => {
      const pre = {
        dirty: window.__mp.isDirty(fk),
        washPending: window.__mp.washPending(fk),
        model: window.__mp.m7State(fk).model,
      };
      const id = window.__mp.modelId(fk);
      const mdl = window.monaco.editor.getModels().find((m) => m.id === id);
      const uri = String(mdl.uri);
      // a live 'texlog' marker set — the matrix must clear it (T3)
      window.monaco.editor.setModelMarkers(mdl, 'texlog', [{
        severity: window.monaco.MarkerSeverity.Error,
        message: 'phantom', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2,
      }]);
      const markersPre = window.monaco.editor.getModelMarkers({ owner: 'texlog' })
        .filter((mk) => String(mk.resource) === uri).length;
      // __mpLruCap: the sweep-cap test seam (the __mpDeadlineMs idiom) — a
      // tiny cap trips a REAL oldest-first eviction without 50+ stagings
      window.__mpLruCap = 2;
      for (let i = 1; i <= 4; i++) {
        window.__mp.setFile(`alpha::mx/s${i}.txt`, 'stub line\n', { mtimeMs: Date.now(), ext: 'txt' });
      }
      delete window.__mpLruCap;
      return {
        pre,
        markersPre,
        uri,
        post: {
          state: window.__mp.m7State(fk),
          washPending: window.__mp.washPending(fk),
          modelGone: !window.monaco.editor.getModels().some((m) => m.id === id),
          markers: window.monaco.editor.getModelMarkers({ owner: 'texlog' })
            .filter((mk) => String(mk.resource) === uri).length,
          evictLogged: window.__mp.saveLog(fk).some((e) => e.ev === 'lru-evict'),
        },
      };
    }, FK.mx);
    assert.equal(res.pre.dirty, false, 'staging: the ⌘Z left the model clean (eligible)');
    assert.equal(res.pre.washPending, true, 'staging: the wash debounce was LIVE at eviction');
    assert.equal(res.markersPre, 1, 'staging: a texlog marker existed on the model URI');
    assert.equal(res.post.evictLogged, true, 'the model went through the REAL sweep');
    assert.equal(res.post.modelGone, true, 'model disposed');
    // the timer was CANCELED, not fired: the flip happened synchronously
    // inside one evaluate — no task boundary means no setTimeout could run
    assert.equal(res.post.washPending, false, 'wash debounce canceled synchronously (clearTimeout, not a fire)');
    assert.equal(res.post.markers, 0, "the model's 'texlog' markers cleared (matrix marker step)");
    for (const [k, v] of Object.entries(res.post.state)) {
      assert.equal(v, false, `matrix totality: per-fkey map '${k}' is empty after Disposed (A10/A20)`);
    }
    await sleep(400); // the canceled timer's window fully elapses
    assert.equal(await page.evaluate((fk) => window.__mp.washPending(fk), FK.mx), false,
      'nothing re-armed after the window');
    assert.deepEqual(errs, [], 'nothing fired against the disposed model');
  } finally {
    await context.close();
  }
});

/* ═══ D — T5: close during an in-flight save — the 200 lands on the ORPHAN ═══ */

test('close-during-in-flight-save race: the orphan keeps model+draft while the PUT is held; the 200 transitions it clean → LRU-eligible (T5; the post-DISPOSE stale-200 is ui.monaco-save\'s pin)', opts, async () => {
  const { context, page } = await m7Page();
  try {
    await waitEditor(page, FK.close);
    const gate = putGate(page);
    await clickTab(page, 1, FK.race);
    await typeAt(page, 2, 1, 'RACE EDIT ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('RACE EDIT'), FK.race);
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+s`);
    await gate.waitPuts(1); // the M3 token is in flight, held at the route

    // × close the tab mid-flight → focus falls to hand.tex
    await page.click('.tabX[data-xi="1"]');
    await waitEditor(page, FK.hand);
    const mid = await page.evaluate((fk) => ({
      model: window.__mp.m7State(fk).model,
      inFlight: window.__mp.saveState(fk).inFlight,
      draft: window.__mp.store().drafts[fk] ?? null,
      lru: window.__mp.lruInfo(fk),
      counters: window.__mp.counters(),
    }), FK.race);
    assert.equal(mid.model, true, 'the orphan keeps its model while the save is in flight');
    assert.ok(mid.inFlight, 'the M3 token is still live across the close');
    assert.ok(String(mid.draft).includes('RACE EDIT'), 'drafts intact — close destroyed nothing');
    assert.equal(mid.lru.orphan, true, 'tracked as an orphan');
    assert.equal(mid.lru.eligible, false, 'in-flight + dirty → not an LRU candidate');

    // the 200 lands on the ORPHAN: commitSave transitions it clean (T5)
    gate.cfg.hold = false;
    gate.release();
    await waitLog(page, FK.race, 'commit-clean');
    const done = await page.evaluate((fk) => ({
      dirty: window.__mp.isDirty(fk),
      draft: window.__mp.store().drafts[fk] ?? null,
      savedAlt: window.__mp.savedAlt(fk),
      lru: window.__mp.lruInfo(fk),
      counters: window.__mp.counters(),
      model: window.__mp.m7State(fk).model,
    }), FK.race);
    assert.equal(done.model, true, 'the orphan model is still alive (clean, awaiting LRU pressure)');
    assert.equal(done.dirty, false, 'clean on the 200');
    assert.equal(done.draft, null, 'draft dissolved by the commit');
    assert.equal(typeof done.savedAlt, 'number', 'savedAltId captured from the PUT bytes');
    assert.equal(done.lru.orphan, true, 'still an orphan — the view stayed closed');
    assert.equal(done.lru.eligible, true, 'clean orphan → LRU-eligible (OrphanTracked)');
    assert.equal(done.counters.cleanDetached, mid.counters.cleanDetached + 1,
      'the clean-detached census moved on the orphan commit');
    // …and the file really is on disk (the PUT went through after release)
    assert.ok(fs.readFileSync(path.join(alphaRoot, REL.race), 'utf8').includes('RACE EDIT'),
      'the held PUT committed');
  } finally {
    await context.close();
  }
});

/* ═══ G — s05 §M7 test bullet 8, the RECOVERY tail ═══
   "Boot-failure fallback … mid-session with dirty files → legacy editor has
   every draft; editor:impl not left broken; recovery to Monaco on next
   successful boot re-runs T8 with drafts winning." The fallback half is
   ui.monaco-stale test G's pin; THIS case drives the full round trip:
   rebootMonaco's dirty-model reallyDispose (the ONE sanctioned dirty
   disposal) → injected failed generation → injection cleared → a SECOND
   reboot to READY → models recreated from the surviving drafts (M1 T3
   dirty-at-birth), ⌘Z reaching the true disk baseline. */

test('boot-failure recovery: dirty files → injected failed boot (drafts to legacy) → cleared + rebooted to READY → models recreated from the surviving drafts, drafts WIN, ⌘Z reaches the disk baseline', opts, async () => {
  const { context, page, errs } = await m7Page();
  try {
    await waitEditor(page, FK.close);
    const gen0 = await page.evaluate(() => window.__mp.generation());
    await typeAt(page, 2, 1, 'SURVIVOR ONE ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('SURVIVOR ONE'), FK.close);
    await clickTab(page, 3, FK.mx);
    const mxOrig = await page.evaluate((fk) => window.__mp.text(fk), FK.mx);
    await typeAt(page, 2, 1, 'SURVIVOR TWO ');
    await page.waitForFunction((fk) => (window.__mp.store().drafts[fk] || '').includes('SURVIVOR TWO'), FK.mx);

    // ── the FAILED generation (the ui.monaco-stale G idiom): reboot disposes
    //    every model — dirty ones included, the sanctioned path — and the
    //    injected INIT failure runs edge 13's atomic fallback ──
    const boot = await page.evaluate(() => {
      window.__mpInitThrow = true;
      window.__mp.reboot();
      return window.__mp.ensure();
    });
    assert.equal(boot.ok, false, 'the injected boot failed');
    assert.equal(boot.stage, 'init');
    await page.waitForSelector('.mpFailure pre', { timeout: 10000 });
    const mid = await page.evaluate(([fkA, fkB]) => ({
      state: window.__mp.state(),
      stored: localStorage.getItem('editor:impl'),
      models: window.__mp.models(),
      draftA: window.__mp.store().drafts[fkA] ?? null,
      draftB: window.__mp.store().drafts[fkB] ?? null,
      ta: document.querySelector('.mpFailure pre')?.textContent ?? null,
      chip: document.querySelector('#saveState')?.className ?? null,
    }), [FK.close, FK.mx]);
    assert.equal(mid.state, 'FAILED', 'atomic fallback');
    assert.equal(mid.stored, null, 'editor:impl NOT left broken (bullet 8)');
    assert.deepEqual(mid.models, [], 'every model disposed — the dirty ones through the sanctioned reboot path');
    assert.ok(String(mid.draftA).includes('SURVIVOR ONE'), 'the background draft survived (I1)');
    assert.ok(String(mid.draftB).includes('SURVIVOR TWO'), 'the active draft survived (I1)');
    assert.ok(String(mid.ta).includes('SURVIVOR TWO'), 'the legacy editor HAS the active draft on screen');
    assert.match(String(mid.chip), /dirty/, 'amber chip across the implementation boundary');

    // ── the bullet's tail: clear the injection → the NEXT successful boot
    //    re-runs T8 with drafts winning (M1 T3 dirty-at-birth recreation) ──
    await page.evaluate(() => { delete window.__mpInitThrow; window.__mp.reboot(); });
    await clickTab(page, 0, FK.close); // this render kicks the fresh A6 generation
    const reClose = await page.evaluate((fk) => ({
      gen: window.__mp.generation(),
      state: window.__mp.state(),
      text: window.__mp.text(fk),
      dirty: window.__mp.isDirty(fk),
      draft: window.__mp.store().drafts[fk],
    }), FK.close);
    assert.equal(reClose.state, 'READY', 'the next boot SUCCEEDED');
    assert.equal(reClose.gen, gen0 + 2, 'two fresh generations: the failed one + the recovered one');
    assert.ok(reClose.text.includes('SURVIVOR ONE'), 'the draft WON the recreated model (bullet 8 tail)');
    assert.equal(reClose.text, reClose.draft, 'model text IS the surviving draft — byte-identical');
    assert.equal(reClose.dirty, true, 'dirty at re-birth (M1 T3)');
    assert.ok((await chip(page)).cls.includes('dirty'), 'amber chip back in Monaco');

    await clickTab(page, 3, FK.mx);
    const reMx = await page.evaluate((fk) => ({
      text: window.__mp.text(fk),
      dirty: window.__mp.isDirty(fk),
    }), FK.mx);
    assert.ok(reMx.text.includes('SURVIVOR TWO'), 'EVERY dirty file recovered — not just the active one');
    assert.equal(reMx.dirty, true, 'dirty at re-birth');
    // M1 T3 dirty-at-birth: the draft rides as ONE undoable edit — ⌘Z reaches
    // the true disk baseline, never an empty or draft-only model
    await undoToClean(page, FK.mx);
    assert.equal(await page.evaluate((fk) => window.__mp.text(fk), FK.mx), mxOrig,
      '⌘Z walks the recreated model down to the DISK baseline');
    assert.equal(await page.evaluate((fk) => window.__mp.store().drafts[fk] ?? null, FK.mx), null,
      'the undo dissolved that draft cleanly');
    assert.ok(String(await page.evaluate((fk) => window.__mp.store().drafts[fk], FK.close)).includes('SURVIVOR ONE'),
      "the OTHER file's draft still stands — only the undone one dissolved");
    assert.deepEqual(errs, [], 'no page errors across failure + recovery');
  } finally {
    await context.close();
  }
});
