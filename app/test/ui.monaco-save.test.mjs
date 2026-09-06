// test/ui.monaco-save.test.mjs — Phase 3 S1.3: the M3 save begin/commit token
// machine (A3) and the M5 409 recovery machine, driven through the real
// keybindings (⌘S / ⌘⏎) on the kept Monaco editor. Section I (S2.1(a)) adds
// the files.saveFile re-anchor: a save driven through files.saveFile — not
// the keybinding — rides the same token queue under the monaco impl (chip
// clean via savedAltId === token.altId; 409 → the M5 ladder), while the
// legacy impl and no-model fkeys keep the pre-S2.1 path byte-identical
// (CONTRACT M3, residual closed).
//
// Ground rules (monaco-s05 §M3/§M5 + blueprint §14 A3):
//   - typing/undo are GENUINE CDP keystrokes; the __mp seam is used only to
//     read state (and to stage sentinel/eviction cases the input path cannot);
//   - every PUT goes through a page.route gate so an in-flight save can be
//     held open for exactly the mid-flight-typing window the A3 gate needs;
//   - billing-safe: armPage() intercepts the five billed routes on every
//     context, and this file touches ONLY the unbilled /artifact PUT+GET, a
//     stubbed /api/extfile PUT (no server mutation at all), a stubbed
//     /api/run, and GET /api/state. A grep guard below pins that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX_DIR = path.join(APP_DIR, 'test', 'fixtures', 'eol');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FK = {
  save: 'alpha::save.tex',       // 0 — the token machine's main subject
  run: 'alpha::run.py',          // 1 — ⌘⏎ save-first ordering
  conflict: 'alpha::conflict.tex', // 2 — M5
  mixed: 'alpha::mixed.tex',     // 3 — P-EOL-5 first-save disclosure
};
const SAVE_TEXT = '% save fixture\nalpha\nbeta\ngamma\n';
const CONFLICT_TEXT = '% conflict fixture\nours line\n';

let ui, sb, task, extFile, alphaRoot;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ root, projRoots }) => {
      alphaRoot = projRoots.alpha;
      fs.writeFileSync(path.join(projRoots.alpha, 'save.tex'), SAVE_TEXT);
      fs.writeFileSync(path.join(projRoots.alpha, 'run.py'), 'print("hello")\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'conflict.tex'), CONFLICT_TEXT);
      fs.copyFileSync(path.join(FIX_DIR, 'mixed.tex'), path.join(projRoots.alpha, 'mixed.tex'));
      const extDir = path.join(root, 'ext-notes');
      fs.mkdirSync(extDir, { recursive: true });
      extFile = path.join(extDir, 'outside.tex');
      fs.writeFileSync(extFile, '% external pin\nline one\n');
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco save', category: 'calibration', oversight: 'manual',
    context: { files: ['save.tex', 'run.py', 'conflict.tex', 'mixed.tex', extFile] },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  assert.ok(task && task.id, 'task record captured');
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return null; } };

/**
 * The PUT gate: records every save PUT and can hold one open (the in-flight
 * window the A3 gates type into), abort it (T6), or 409 it (M5). GET requests
 * to the same route ride `cfg.get` so the recovery-reload failure branch can
 * be injected too.
 */
function saveGate(page, pattern = '**/artifact/**') {
  const puts = [];
  const cfg = { put: 'pass', get: 'pass', hold: false };
  let held = [];
  page.route(pattern, async (route) => {
    const req = route.request();
    if (req.method() !== 'PUT') {
      if (cfg.get === 'hold') await new Promise((res) => held.push(res));
      if (cfg.get === 'abort') { await route.abort('failed'); return; }
      await route.continue();
      return;
    }
    puts.push({ url: req.url(), body: safeJson(req.postData()), at: Date.now() });
    if (cfg.hold) await new Promise((res) => held.push(res));
    if (cfg.put === 'abort') { await route.abort('failed'); return; }
    if (cfg.put === '409') {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'file changed on disk' }) });
      return;
    }
    await route.continue();
  });
  return {
    puts,
    cfg,
    hold(v = true) { cfg.hold = v; },
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

async function savePage({ impl = 'monaco' } = {}) {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  await armPage(page);
  const msgs = [];
  const errs = [];
  page.on('console', (m) => msgs.push(m.text()));
  page.on('pageerror', (e) => errs.push(String(e && e.message)));
  await page.addInitScript((impl2) => {
    if (impl2) localStorage.setItem('editor:impl', impl2);
    // clipboard stub: the M5 I6 gate needs BOTH a verified write (payload
    // captured) and a denial, and neither may depend on host permissions
    window.__clipped = null;
    window.__clipDeny = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t) => {
          if (window.__clipDeny) throw new Error('clipboard denied (test stub)');
          window.__clipped = String(t);
        },
      },
    });
  }, impl);
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, msgs, errs };
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
    save: window.__mp.saveState(f),
  };
}, fk);

const waitLog = (page, fk, ev, timeout = 10000) => page.waitForFunction(
  ([f, e]) => window.__mp.saveLog(f).some((x) => x.ev === e), [fk, ev], { timeout, polling: 40 });

const typeAt = async (page, line, col, text) => {
  await page.evaluate(([l, c]) => { window.__mp.focus(); window.__mp.setPosition(l, c); }, [line, col]);
  await page.keyboard.type(text);
};

const pressSave = async (page) => {
  await page.evaluate(() => window.__mp.focus());
  await page.keyboard.press(`${MOD}+s`);
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

/* ═══ node-side guards: billed routes and the P-EOL-1 save serialization ═══ */

test('this suite touches no billed route; the save path never bare-getValue()s', () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // the five billed routes, spelled in halves so this guard cannot match itself
  const billed = ['/laun' + 'ch', '/mess' + 'age', '/ret' + 'ry', '/api/prof' + 'ile/generate', '/api/tex' + 'fix'];
  for (const b of billed) {
    assert.equal(src.includes(b), false, `the save suite must never mention the billed route ${b}`);
  }
  const pane = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  // the M3 save path serializes through serialize() only (P-EOL-1: TextDefined
  // + preserveBOM); a bare getValue() would silently drop a BOM onto disk
  assert.equal(pane.split('.getValue(').length - 1, 1, 'exactly one .getValue( in monacoPane — inside serialize()');
  const begin = pane.slice(pane.indexOf('export function beginSave'), pane.indexOf('export function commitSave'));
  assert.match(begin, /text: m \? serialize\(m\) : draft/, 'the token text is the P-EOL-1 serialization');
  assert.equal(/await/.test(begin), false, 'beginSave is synchronous end to end (no await between capture and dispatch)');
  // the A3 defect guard, statically: no 200 path may capture the CURRENT altId
  const commit = pane.slice(pane.indexOf('export function commitSave'), pane.indexOf('function noteEolNormalized'));
  assert.match(commit, /savedAltId\.set\(fkey, token\.altId\)/, 'commitSave captures token.altId');
  assert.equal(/savedAltId\.set\(fkey, m\.getAlternativeVersionId\(\)\)/.test(commit), false,
    'no 200 path may capture the CURRENT altId (the audit A3 defect)');
  // S2.1(a) re-anchor, statically: the monaco+model gate sits at the top of
  // files.saveFile, and the legacy body below it is monaco-free (CONTRACT M3
  // "legacy and no-model paths byte-identical")
  const filesSrc = fs.readFileSync(path.join(APP_DIR, 'public', 'files.js'), 'utf8');
  const sf = filesSrc.slice(filesSrc.indexOf('export async function saveFile'),
    filesSrc.indexOf('export function closeTab'));
  assert.match(sf, /mpText\(k\) != null\) return mpRequestSave\(k\);/,
    'saveFile carries the S2.1 monaco+model gate');
  const gateMark = 'return mpRequestSave(k);';
  const belowGate = sf.slice(sf.indexOf(gateMark) + gateMark.length);
  assert.equal(/mpRequestSave|mpText|beginSave|commitSave|monaco/i.test(belowGate), false,
    'below the gate the legacy save body is monaco-free (the byte-identical rule)');
});

/* ═══ A — the A3 mid-flight typing + undo gate (T4b) ═══ */

test('A3 gate: type A · ⌘S · type B before the 200 → amber + rebased draft; ⌘Z → saved, draft deleted', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'A');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const tokenText = await page.evaluate((fk) => window.__mp.text(fk), FK.save);

    gate.hold();
    await pressSave(page);
    await gate.waitPuts(1);
    const putBody = gate.puts[0].body;
    assert.equal(putBody.content, tokenText, 'the PUT body IS token.text (synchronous capture)');
    assert.ok(Number.isFinite(putBody.baseMtimeMs), 'a finite baseline rode along');

    // …B lands while the PUT is in flight (T3: editing is unconstrained)
    await page.keyboard.type('B');
    await page.waitForFunction(([fk, t]) => window.__mp.store().drafts[fk] !== t, [FK.save, tokenText]);
    const mid = await snap(page, FK.save);
    assert.equal(mid.save.inFlight.text, tokenText, 'the in-flight token still describes the PUT bytes');

    gate.hold(false);
    gate.release();
    await waitLog(page, FK.save, 'commit-rebase');

    const after = await snap(page, FK.save);
    const c = await chip(page);
    assert.ok(c.cls.includes('dirty'), `chip stays amber after the 200 (falsely-clean guard) — ${c.txt}`);
    assert.equal(after.draft, after.text, 'drafts[k] == the CURRENT model text (materialized)');
    assert.equal(after.cache.text, tokenText, 'fileCache[k] is exactly the PUT bytes');
    assert.equal(after.base, after.cache.mtimeMs, 'draftBase[k] rebased onto the response mtime');
    assert.ok(Number.isFinite(after.base), 'the response mtime is finite (header-first, JSON fallback)');
    assert.equal(after.savedAlt, mid.save.inFlight.altId,
      'savedAltId === token.altId — the altId OF THE PUT BYTES (A3), never the current one');
    assert.equal(fs.readFileSync(path.join(alphaRoot, 'save.tex'), 'utf8'), tokenText, 'disk holds the PUT bytes');

    // …and the proof: undoing the mid-flight keystroke lands exactly on the
    // saved state and truthfully reads clean
    await undoToClean(page, FK.save);
    const undone = await snap(page, FK.save);
    const c2 = await chip(page);
    assert.equal(undone.text, tokenText, '⌘Z removed B — the model is the saved text');
    assert.equal(undone.draft, null, 'the clean transition deleted drafts[k]');
    assert.equal(undone.base, null);
    assert.ok(!c2.cls.includes('dirty'), `chip flips to saved (${c2.txt})`);
  } finally {
    await context.close();
  }
});

/* ═══ B — serialization: double/triple ⌘S coalesce to exactly two PUTs ═══ */

test('A3 gate: double-⌘S in flight → exactly two ordered PUTs, final clean; triple-⌘S coalesces to the same two', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);

    // round 1 — two ⌘S while one PUT is held, with typing in between so the
    // coalesced follow-up has something to write (T8 fires only while dirty)
    await typeAt(page, 2, 1, 'ONE');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    gate.hold();
    await pressSave(page);
    await gate.waitPuts(1);
    await page.keyboard.type('TWO');
    await pressSave(page);
    await pressSave(page); // T7: coalesced onto the same single flag
    const during = await snap(page, FK.save);
    assert.equal(gate.puts.length, 1, 'a second PUT never starts before the first settles');
    assert.equal(during.save.pending, true, 'the second/third ⌘S set ONE pending flag');

    gate.hold(false);
    gate.release();
    await gate.waitPuts(2);
    await waitLog(page, FK.save, 'commit-clean');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] == null, FK.save);

    assert.equal(gate.puts.length, 2, 'exactly two PUTs for the double-⌘S');
    assert.ok(gate.puts[0].at <= gate.puts[1].at, 'strictly ordered');
    assert.equal(gate.puts[0].body.content.includes('TWO'), false, 'PUT 1 carried the pre-typing bytes');
    assert.ok(gate.puts[1].body.content.includes('ONETWO'), 'PUT 2 carried the fresh token');
    const clean = await snap(page, FK.save);
    assert.equal(clean.dirty, false, 'final state clean');
    assert.equal(clean.cache.text, gate.puts[1].body.content);
    assert.equal(fs.readFileSync(path.join(alphaRoot, 'save.tex'), 'utf8'), gate.puts[1].body.content);

    // round 2 — three ⌘S in flight coalesce to the SAME two PUTs
    const base = gate.puts.length;
    await typeAt(page, 2, 1, 'X');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    gate.hold();
    await pressSave(page);
    await gate.waitPuts(base + 1);
    await page.keyboard.type('Y');
    await pressSave(page);
    await pressSave(page);
    await pressSave(page);
    gate.hold(false);
    gate.release();
    await gate.waitPuts(base + 2);
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] == null, FK.save);
    await sleep(400); // any spurious third PUT would have landed by now
    assert.equal(gate.puts.length, base + 2, 'triple-⌘S coalesces to the same two PUTs');
    const c = await chip(page);
    assert.ok(!c.cls.includes('dirty'), `chip saved after the coalesced round (${c.txt})`);

    // ⌘S belongs to the pinned input surface: with focus in the composer the
    // editor command must not fire (the legacy global keydown path is
    // untouched, so nothing else claims it either)
    await typeAt(page, 2, 1, 'FOCUS');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const beforeBlur = gate.puts.length;
    await page.click('#v-alpha .codeHalf .cfoot'); // blur: focus leaves the editor
    await page.waitForFunction(() => !window.__mp.hasTextFocus(), null, { timeout: 5000 });
    await page.keyboard.press(`${MOD}+s`);
    await sleep(400);
    assert.equal(gate.puts.length, beforeBlur, '⌘S outside the editor dispatches nothing');
    assert.ok((await chip(page)).cls.includes('dirty'), 'and the file is still unsaved');
    await page.evaluate(() => window.__mp.focus());
    await pressSave(page);
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] == null, FK.save);
    assert.equal(gate.puts.length, beforeBlur + 1, '…while ⌘S inside the editor saves');
  } finally {
    await context.close();
  }
});

/* ═══ C — ⌘⏎ save-first ordering (P13) ═══ */

test('A3 gate: ⌘⏎ during an in-flight ⌘S → the compile starts only after the coalesced save commits, on the saved bytes', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);
    const runs = [];
    const pyPath = path.join(alphaRoot, 'run.py');
    await page.route('**/api/run', async (route) => {
      runs.push({ at: Date.now(), disk: fs.readFileSync(pyPath, 'utf8'), body: safeJson(route.request().postData()) });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await clickTab(page, 1, FK.run);
    await typeAt(page, 1, 1, '# RUN MARK\n');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.run);
    const draft = await page.evaluate((fk) => window.__mp.text(fk), FK.run);

    gate.hold();
    await pressSave(page);
    await gate.waitPuts(1);
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+Enter`); // ⌘⏎ while the save is in flight
    await sleep(300);
    assert.equal(runs.length, 0, 'no compile is dispatched while the save is in flight');

    gate.hold(false);
    gate.release();
    const t0 = Date.now();
    while (runs.length === 0 && Date.now() - t0 < 10000) await sleep(30);
    assert.equal(runs.length, 1, 'the compile ran exactly once, after the save');
    assert.equal(runs[0].disk, draft, 'the bytes on disk at compile time ARE the last-saved bytes');
    assert.equal(gate.puts.length, 1, 'the ⌘⏎ coalesced onto the in-flight save — no extra PUT');
    assert.equal(runs[0].body.rel, 'run.py');
    const s = await snap(page, FK.run);
    assert.equal(s.dirty, false, 'clean after the save-first run');
  } finally {
    await context.close();
  }
});

/* ═══ D — T6 network error + the stale-seq drop ═══ */

test('T6: a failed PUT toasts, keeps the draft and consumes the seq; a post-dispose 200 is dropped with a log line and zero mutation', opts, async () => {
  const { context, page, msgs, errs } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'NET');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const before = await snap(page, FK.save);

    gate.cfg.put = 'abort';
    await pressSave(page);
    await waitLog(page, FK.save, 'net-error');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('save failed'));
    const afterFail = await snap(page, FK.save);
    assert.equal(afterFail.draft, before.draft, 'the draft is untouched by a network failure');
    assert.equal(afterFail.cache.text, before.cache.text, 'fileCache untouched');
    assert.equal(afterFail.dirty, true, 'still Dirty');
    assert.equal(afterFail.save.seq, before.save.seq + 1, 'the seq was consumed');
    assert.ok((await chip(page)).cls.includes('dirty'));

    // the next ⌘S issues a FRESH token with an incremented seq and succeeds
    gate.cfg.put = 'pass';
    await pressSave(page);
    await waitLog(page, FK.save, 'commit-clean');
    const ok = await snap(page, FK.save);
    assert.equal(ok.save.seq, before.save.seq + 2, 'fresh token, incremented seq');
    assert.equal(ok.dirty, false);

    // ── stale drop: dispose the model while a PUT is in flight ──
    await typeAt(page, 2, 1, 'STALE');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const preDrop = await snap(page, FK.save);
    gate.hold();
    await pressSave(page);
    await gate.waitPuts(3);
    await page.evaluate((fk) => window.__mp.evictForTest(fk), FK.save); // dispose/handoff
    gate.hold(false);
    gate.release();
    await waitLog(page, FK.save, 'stale-drop');
    const post = await snap(page, FK.save);
    assert.equal(post.draft, preDrop.draft, 'a stale 200 mutates nothing (drafts)');
    assert.equal(post.cache.text, preDrop.cache.text, 'a stale 200 mutates nothing (fileCache)');
    assert.ok(msgs.some((m) => m.includes('stale save response dropped')), 'the drop is logged');
    assert.deepEqual(errs, [], 'no page error from the late response');
  } finally {
    await context.close();
  }
});

/* ═══ E — T2 refusal, the two §2 chip guards, and the P-EOL-5 disclosure ═══ */

test('T2 refusal (sentinel → "cannot save yet", zero PUTs); T4a clean chip; P-EOL-5 first-save disclosure', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);

    // permanently-amber guard: a quiet save (nothing typed mid-flight) → clean
    await typeAt(page, 2, 1, 'Q');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    await pressSave(page);
    await waitLog(page, FK.save, 'commit-clean');
    const quiet = await snap(page, FK.save);
    assert.equal(quiet.dirty, false, 'T4a: clean when altId AND value still match the token');
    assert.equal(typeof quiet.savedAlt, 'number', 'savedAltId is the token altId, a real model state');
    assert.equal(quiet.draft, null, 'drafts deleted on the clean path');
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'chip reads saved (permanently-amber guard)');

    // ── T2: a sentinel model (no trustworthy baseline) refuses ──
    const putsBefore = gate.puts.length;
    await page.evaluate((fk) => {
      const s = window.__mp.store();
      s.drafts[fk] = window.__mp.text(fk) + '\nSENTINEL DRAFT\n';
      delete s.fileCache[fk];
      delete s.draftBase[fk];
      window.__mp.evictForTest(fk);
      window.__mp.setFile(fk, null, { mtimeMs: null, ext: 'tex' });
    }, FK.save);
    const sent = await snap(page, FK.save);
    assert.equal(sent.savedAlt, 'DIRTY_SENTINEL');
    await pressSave(page); // the real ⌘S keybinding on the sentinel model
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('cannot save yet'),
      null, { timeout: 5000 });
    await sleep(300);
    assert.equal(gate.puts.length, putsBefore, 'a sentinel model dispatches ZERO PUTs');
    const stillThere = await snap(page, FK.save);
    assert.equal(stillThere.draft, sent.draft, 'the refusal destroyed nothing');
    assert.equal(stillThere.save.seq, sent.save.seq, 'a refusal issues no token');

    // ── P-EOL-5: the first save of a mixed-EOL file discloses the normalize ──
    await clickTab(page, 3, FK.mixed);
    assert.equal(await page.evaluate(() => document.querySelector('#eolChip').textContent),
      'EOL: mixed → will normalize to LF on save', 'the pre-save disclosure is the load-time chip');
    await typeAt(page, 1, 1, 'M');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.mixed);
    await pressSave(page);
    await waitLog(page, FK.mixed, 'eol-normalized');
    const eol = await page.evaluate((fk) => ({
      chip: document.querySelector('#eolChip').textContent,
      rec: window.__mp.saveState(fk).eolNormalized,
      disk: window.__mp.store().fileCache[fk].text,
    }), FK.mixed);
    assert.equal(eol.chip, 'EOL: normalized to LF on save (mixed on disk)', 'the chip states the fact after the save');
    assert.equal(eol.rec.to, 'LF');
    assert.equal(eol.disk.includes('\r'), false, 'the bytes written are the normalized form');
    assert.equal(fs.readFileSync(path.join(alphaRoot, 'mixed.tex'), 'utf8'), eol.disk, 'disk == the PUT bytes');
  } finally {
    await context.close();
  }
});

/* ═══ F — M5: cancel · clipboard denied · clipboard verified ═══ */

test('M5: 409 → cancel is a total no-op (repeatable); accept+clipboard-denied destroys nothing; accept+clipboard-ok reloads disk with the draft (incl. post-⌘S keystrokes) on the clipboard', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    await clickTab(page, 2, FK.conflict);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'DRAFT ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.conflict);

    // a real disk change under the draft (mtime pushed past the 250ms grace)
    const cpath = path.join(alphaRoot, 'conflict.tex');
    fs.writeFileSync(cpath, '% conflict fixture\nTHEIR LINE\n');
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(cpath, future, future);

    // ── T1: cancel ──
    const before = await snap(page, FK.conflict);
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbCancel');
    await sleep(250);
    const cancelled = await snap(page, FK.conflict);
    assert.deepEqual(
      { d: cancelled.draft, b: cancelled.base, c: cancelled.cache, s: cancelled.stale },
      { d: before.draft, b: before.base, c: before.cache, s: before.stale },
      'cancel changes NOTHING (drafts/draftBase/fileCache/diskStale byte-identical)');
    assert.ok((await chip(page)).cls.includes('dirty'), 'chip stays amber after a cancel');
    assert.equal(await page.evaluate(() => window.__clipped), null, 'cancel never touches the clipboard');

    // …and it is repeatable: the same ⌘S 409s identically
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbCancel');
    await sleep(250);
    const cancelled2 = await snap(page, FK.conflict);
    assert.equal(cancelled2.draft, before.draft, 'second cancel is identical');
    assert.equal(gate.puts.length, 2, 'each ⌘S made exactly one PUT');

    // ── T3: accept with a denied clipboard destroys NOTHING (I6) ──
    await page.evaluate(() => { window.__clipDeny = true; });
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbGo');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('clipboard unavailable'),
      null, { timeout: 8000 });
    const denied = await snap(page, FK.conflict);
    assert.equal(denied.draft, before.draft, 'the affirmative confirm ALONE destroyed nothing (I6)');
    assert.ok(denied.cache, 'fileCache intact');
    assert.ok((await chip(page)).cls.includes('dirty'), 'chip still amber');

    // ── T2/T4/T5: accept with a verified clipboard ──
    // type AFTER the ⌘S so the payload-is-current-text rule has teeth
    await page.evaluate(() => { window.__clipDeny = false; });
    gate.hold();
    await pressSave(page);
    await gate.waitPuts(4);
    await typeAt(page, 2, 1, 'POST-SAVE ');
    const liveDraft = await page.evaluate((fk) => window.__mp.text(fk), FK.conflict);
    gate.hold(false);
    gate.release();
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    gate.cfg.get = 'hold'; // freeze the reload GET to inspect the chip mid-recovery
    await page.click('#confirmBack .cbGo');
    await waitLog(page, FK.conflict, 'recovery-destroy');
    await sleep(150);
    const mid = await page.evaluate((fk) => ({
      chip: document.querySelector('#saveState')?.textContent.trim() ?? null,
      draft: window.__mp.store().drafts[fk] ?? null,
      recovering: window.__mp.saveState(fk).recovering,
    }), FK.conflict);
    assert.equal(mid.draft, null, 'the draft is gone the moment the clipboard write is verified');
    assert.equal(mid.recovering, true);
    assert.equal(/(^|\s)saved/.test(mid.chip || ''), false,
      `no 'saved' frame between destruction and reload (${mid.chip})`);
    gate.cfg.get = 'pass';
    gate.release();
    await waitLog(page, FK.conflict, 'recovery-reload');
    await waitEditor(page, FK.conflict);

    const rec = await snap(page, FK.conflict);
    const clipped = await page.evaluate(() => window.__clipped);
    assert.equal(clipped, liveDraft, 'the clipboard payload is the CURRENT text at accept time, post-⌘S keystrokes included');
    assert.ok(clipped.includes('POST-SAVE '), '…which the pre-Monaco path would have lost');
    assert.equal(rec.text, '% conflict fixture\nTHEIR LINE\n', 'the model shows the fresh disk text');
    assert.equal(rec.draft, null, 'drafts destroyed only after the verified write');
    assert.equal(rec.base, null);
    assert.equal(rec.stale, false, 'diskStale cleared on the T4 path');
    assert.equal(rec.dirty, false, 'savedAltId captured from the fresh bytes inside the txn');
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'chip reads saved AFTER the reload, not before');

    // ⌘Z is a no-op: the reconciliation rule cleared the undo stack
    await page.evaluate(() => window.__mp.focus());
    await page.keyboard.press(`${MOD}+z`);
    await sleep(200);
    const undone = await snap(page, FK.conflict);
    assert.equal(undone.text, rec.text, '⌘Z cannot resurrect pre-conflict text');
    assert.equal(undone.draft, null, 'and cannot manufacture a draft');
  } finally {
    await context.close();
  }
});

/* ═══ G — M5 falsely-amber guard, pendingSave clearing, reload-fetch failure ═══ */

test('M5: recovery savedAltId === current altId; a coalesced pendingSave never auto-fires post-recovery; a failed reload keeps the read-only branch and reseeds on reopen', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    await clickTab(page, 2, FK.conflict);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'MINE ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.conflict);

    const cpath = path.join(alphaRoot, 'conflict.tex');
    fs.writeFileSync(cpath, '% conflict fixture\nDISK ONE\n');
    let future = new Date(Date.now() + 10000);
    fs.utimesSync(cpath, future, future);

    // double-⌘S where the FIRST 409s: the second sets pendingSave, and
    // recovery must clear it (a queued save would re-conflict immediately)
    gate.hold();
    await pressSave(page);
    await gate.waitPuts(1);
    await pressSave(page); // coalesced pending
    assert.equal((await snap(page, FK.conflict)).save.pending, true);
    gate.hold(false);
    gate.release();
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbGo');
    await waitLog(page, FK.conflict, 'recovery-reload');
    await waitEditor(page, FK.conflict);
    await sleep(500); // any auto-fired save would have dispatched by now
    const afterRec = await snap(page, FK.conflict);
    assert.equal(gate.puts.length, 1, 'zero spontaneous PUTs after the recovery (pendingSave cleared)');
    assert.equal(afterRec.save.pending, false);
    assert.equal(afterRec.text, '% conflict fixture\nDISK ONE\n');

    // falsely-amber guard (§2 row 4): typing one char goes amber, ⌘Z goes saved
    await typeAt(page, 2, 1, 'z');
    await page.waitForFunction((fk) => window.__mp.isDirty(fk), FK.conflict);
    assert.ok((await chip(page)).cls.includes('dirty'));
    await undoToClean(page, FK.conflict);
    assert.ok(!(await chip(page)).cls.includes('dirty'), 'savedAltId === the post-recovery altId');

    // ── T6: the recovery reload's GET fails ──
    await typeAt(page, 2, 1, 'AGAIN ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.conflict);
    fs.writeFileSync(cpath, '% conflict fixture\nDISK TWO\n');
    future = new Date(Date.now() + 20000);
    fs.utimesSync(cpath, future, future);
    gate.cfg.get = 'abort';
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbGo');
    await waitLog(page, FK.conflict, 'recovery-fetch-failed');
    await sleep(300);
    const failed = await page.evaluate((fk) => {
      const c = window.__mp.store().fileCache[fk];
      return {
        savedAlt: window.__mp.savedAlt(fk),
        cacheText: c && typeof c.text === 'string' ? c.text : null,
        draft: window.__mp.store().drafts[fk] ?? null,
        chip: document.querySelector('#saveState')?.textContent.trim() ?? null,
        clipped: window.__clipped,
      };
    }, FK.conflict);
    assert.equal(failed.savedAlt, 'DIRTY_SENTINEL', 'the model can never read clean after a failed reload');
    // the recovery leaves fileCache absent; the render that follows may have
    // re-entered it as a {loading}/{error} placeholder — either way it holds
    // NO text, and the tab-click path drops it so the next open refetches
    assert.equal(failed.cacheText, null, 'no cached text survives a failed reload (the next open refetches)');
    assert.equal(failed.draft, null, 'the draft was already verifiably on the clipboard');
    assert.ok(failed.clipped.includes('AGAIN '), 'the clipboard holds the destroyed draft');
    assert.equal(/(^|\s)saved/.test(failed.chip || ''), false, `no 'saved' chip over stale text (${failed.chip})`);

    // reopen → reseeded from disk, clean, savedAltId real again
    gate.cfg.get = 'pass';
    await clickTab(page, 0, FK.save);
    await clickTab(page, 2, FK.conflict);
    const reseeded = await snap(page, FK.conflict);
    assert.equal(reseeded.text, '% conflict fixture\nDISK TWO\n', 'reopening reseeds from disk');
    assert.equal(typeof reseeded.savedAlt, 'number', 'a real altId replaced the sentinel');
    assert.equal(reseeded.dirty, false);
    assert.ok(!(await chip(page)).cls.includes('dirty'));
  } finally {
    await context.close();
  }
});

/* ═══ H — external pins ride the identical machine; toggle-off is untouched ═══ */

test('an external-pin fkey rides the identical token machine (stubbed /api/extfile — no server mutation); toggle off keeps the legacy save path', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const extFk = `alpha::${extFile}`;
    const calls = [];
    let status = 200;
    await page.route('**/api/extfile/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'PUT') { await route.continue(); return; }
      calls.push({ url: req.url(), body: safeJson(req.postData()) });
      if (status === 409) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'file changed on disk' }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, mtimeMs: Date.now() }) });
    });

    await page.click('#v-alpha .side [data-extfk]');
    await waitEditor(page, extFk);
    await typeAt(page, 2, 1, 'EXT ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, extFk);
    await pressSave(page);
    await waitLog(page, extFk, 'commit-clean');
    assert.equal(calls.length, 1, 'one PUT through the pin-grant route');
    assert.match(calls[0].url, new RegExp(`/api/extfile/alpha/${task.id}$`), 'the task-scoped grant route');
    assert.equal(calls[0].body.path, extFile, 'the absolute path rides in the body');
    assert.ok(Number.isFinite(calls[0].body.baseMtimeMs), 'same baseline guard');
    const okState = await snap(page, extFk);
    assert.equal(okState.dirty, false, 'the identical T4a clean commit');
    assert.equal(okState.cache.text, calls[0].body.content);
    assert.equal(fs.readFileSync(extFile, 'utf8'), '% external pin\nline one\n',
      'the stub wrote nothing to disk (refusal-path testing only)');

    // …and a 409 from the same route runs the identical M5 prompt; cancel is
    // still a total no-op
    status = 409;
    await typeAt(page, 2, 1, 'MORE ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, extFk);
    const pre = await snap(page, extFk);
    await pressSave(page);
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    await page.click('#confirmBack .cbCancel');
    await sleep(250);
    const post = await snap(page, extFk);
    assert.equal(post.draft, pre.draft, 'extpin 409 + cancel mutates nothing');
    assert.equal(post.cache.text, pre.cache.text);
    assert.equal(calls.length, 2);
  } finally {
    await context.close();
  }


});

/* ═══ I — S2.1(a): files.saveFile re-anchored onto the M3 tokens ═══
   The residual-closing contract (CONTRACT M3): a save driven through
   files.saveFile — NOT the keybinding — rides the token queue whenever the
   impl is monaco AND a model exists for the fkey; a 409 through that path
   lands in the M5 ladder; the legacy impl and no-model fkeys keep the
   pre-S2.1 body byte-identical. The in-page `import('/files.js')` returns
   the SAME module instance the app loaded (one URL, one registry entry),
   so these calls exercise the real export, not a copy. */

/** Fire files.saveFile without awaiting it (window.__sfSettled tracks it). */
const fireSaveFile = (page, rel) => page.evaluate((r) => {
  window.__sfSettled = false;
  return import('/files.js').then((m) => {
    m.saveFile('alpha', r).then(() => { window.__sfSettled = true; });
  });
}, rel);

/** Run files.saveFile to completion (its promise settles at queue idle). */
const runSaveFile = (page, rel) => page.evaluate(
  (r) => import('/files.js').then((m) => m.saveFile('alpha', r)), rel);

test('S2.1 re-anchor: files.saveFile under monaco rides the M3 queue (savedAltId === token.altId, coalesced, no double PUT); a no-model fkey keeps the legacy body', opts, async () => {
  const { context, page } = await savePage();
  try {
    await waitEditor(page, FK.save);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'VIAFILES ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const tokenText = await page.evaluate((fk) => window.__mp.text(fk), FK.save);
    const seq0 = await page.evaluate((fk) => window.__mp.saveState(fk).seq, FK.save);

    gate.hold();
    await fireSaveFile(page, 'save.tex');
    await gate.waitPuts(1);
    const during = await snap(page, FK.save);
    assert.ok(during.save.inFlight, 'the PUT is M3-issued: a live token exists');
    assert.equal(during.save.seq, seq0 + 1, 'beginSave issued exactly one fresh seq');
    assert.equal(during.save.inFlight.text, tokenText, 'token.text is the P-EOL-1 model serialization');
    assert.equal(gate.puts[0].body.content, tokenText, 'the PUT body IS token.text');
    assert.ok(Number.isFinite(gate.puts[0].body.baseMtimeMs), 'the finite baseline rode along');
    const tokenAlt = during.save.inFlight.altId;
    assert.equal(typeof tokenAlt, 'number', 'the token carries the model altId');

    // a second files.saveFile while the PUT is live coalesces onto the SAME
    // queue (T7) — the double-dispatch hunt: never a second concurrent PUT
    await fireSaveFile(page, 'save.tex');
    await sleep(200);
    assert.equal(gate.puts.length, 1, 'a concurrent files.saveFile never double-dispatches');
    assert.equal((await snap(page, FK.save)).save.pending, true, 'it set the ONE coalesced flag');

    gate.hold(false);
    gate.release();
    await waitLog(page, FK.save, 'commit-clean');
    await page.waitForFunction(() => window.__sfSettled === true, null, { timeout: 8000 });
    const after = await snap(page, FK.save);
    assert.equal(after.savedAlt, tokenAlt,
      'the chip flipped clean VIA THE TOKEN MACHINE — savedAltId === token.altId');
    assert.equal(after.dirty, false, 'altId-clean (never a byte comparison)');
    assert.equal(after.draft, null, 'drafts deleted on the T4a clean commit');
    assert.equal(after.cache.text, tokenText, 'fileCache is exactly the PUT bytes');
    assert.ok(!(await chip(page)).cls.includes('dirty'),
      'the chip realigned immediately — no reattach-reconciliation wait (the closed residual)');
    assert.equal(gate.puts.length, 1, 'exactly one PUT for the coalesced pair (drafts were clean)');
    assert.equal(fs.readFileSync(path.join(alphaRoot, 'save.tex'), 'utf8'), tokenText, 'disk holds the PUT bytes');

    // ── the no-model half of the gate: a monaco-impl fkey WITHOUT a model
    //    keeps today's legacy body (no token, no model created) ──
    const noModelDraft = '% conflict fixture\nNOMODEL DRAFT\n';
    const statMs = fs.statSync(path.join(alphaRoot, 'conflict.tex')).mtimeMs;
    await page.evaluate(([fk, draft, base]) => {
      const s = window.__mp.store();
      s.drafts[fk] = draft;
      s.draftBase[fk] = base; // trustworthy baseline without ever opening the tab
    }, [FK.conflict, noModelDraft, statMs]);
    assert.equal(await page.evaluate((fk) => window.__mp.models().includes(fk), FK.conflict), false,
      'precondition: no model exists for the fkey');
    await runSaveFile(page, 'conflict.tex');
    const nm = await page.evaluate((fk) => ({
      seq: window.__mp.saveState(fk).seq,
      model: window.__mp.models().includes(fk),
      draft: window.__mp.store().drafts[fk] ?? null,
      cache: window.__mp.store().fileCache[fk]?.text ?? null,
    }), FK.conflict);
    assert.equal(nm.seq, 0, 'the M3 machine never issued a token — the legacy body ran');
    assert.equal(nm.model, false, 'and manufactured no model');
    assert.equal(nm.draft, null, 'the legacy body cleared the draft exactly as before');
    assert.equal(nm.cache, noModelDraft, 'fileCache updated by the legacy body');
    assert.equal(gate.puts.length, 2, 'one further PUT, same wire protocol');
    assert.equal(fs.readFileSync(path.join(alphaRoot, 'conflict.tex'), 'utf8'), noModelDraft);
  } finally {
    await context.close();
  }
});

test('S2.1 re-anchor: a 409 through files.saveFile lands in the M5 ladder (in-app confirm, drafts intact; cancel is a total no-op)', opts, async () => {
  const { context, page } = await savePage();
  try {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });
    await waitEditor(page, FK.save);
    const gate = saveGate(page);
    await typeAt(page, 2, 1, 'CONFLICT409 ');
    await page.waitForFunction((fk) => window.__mp.store().drafts[fk] != null, FK.save);
    const before = await snap(page, FK.save);

    gate.cfg.put = '409';
    await fireSaveFile(page, 'save.tex');
    await page.waitForSelector('#confirmBack', { timeout: 8000 });
    assert.equal(dialogs.length, 0, 'the M5 in-app confirm, never the legacy native confirm');
    const mid = await snap(page, FK.save);
    assert.equal(mid.draft, before.draft, 'drafts intact while the M5 prompt is up');
    assert.equal(mid.cache.text, before.cache.text, 'fileCache intact (409 never mutates)');
    assert.equal(await page.evaluate(() => window.__sfSettled), false,
      "the caller's promise tracks the M5 flow (settles only when the queue is idle)");

    await page.click('#confirmBack .cbCancel');
    await page.waitForFunction(() => window.__sfSettled === true, null, { timeout: 8000 });
    const cancelled = await snap(page, FK.save);
    assert.equal(cancelled.draft, before.draft, 'cancel is a total no-op — the draft survives');
    assert.equal(cancelled.cache.text, before.cache.text, 'fileCache untouched');
    assert.ok((await chip(page)).cls.includes('dirty'), 'chip stays amber');
    assert.equal(await page.evaluate(() => window.__clipped), null, 'cancel never touches the clipboard');
    const log = await page.evaluate((fk) => window.__mp.saveLog(fk).map((e) => e.ev), FK.save);
    assert.ok(log.includes('http-409'), 'the 409 went through the M3 response path');
    assert.ok(log.includes('recovery-cancel'), '…and entered M5 (T1 cancel)');
    assert.equal(dialogs.length, 0, 'zero native dialogs end to end');
  } finally {
    await context.close();
  }
});
