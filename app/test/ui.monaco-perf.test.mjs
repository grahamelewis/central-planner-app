// test/ui.monaco-perf.test.mjs — Phase 3 S2.6: the A16 instrumentation SEEDS
// (monaco-s2 §4; CONTRACT "Ladder & exit gates", A16). This file proves the
// instruments EXIST and MOVE — the input-latency keydown→rAF ring fills from
// genuine CDP typing with finite p50/p95, the longtask ring records and dies
// with the boot generation, everything is disarmed under legacy, and the
// vendor bytes harness produces sane cold/warm shapes. Pass/fail BUDGETS are
// deliberately absent: A16 says the numbers are set and ruled at S2b's gate,
// never asserted from estimates.
//
// The standing 200k-char perf case is CP_PERF-gated (skip-by-default, loudly)
// so `npm test` stays fast. S2b invokes it against its budgets with:
//   cd app && CP_PERF=1 node --test test/ui.monaco-perf.test.mjs
// and quotes the `A16 PERF RECORD {…}` line it prints (ready-to-first-edit,
// burst p50/p95, heap delta) plus measureVendorBytes' cold/warm numbers.
//
// Ground rules (monaco-s05 + blueprint §14): typing is GENUINE CDP keystrokes
// (the __mp seam is staging/reads only — it bypasses the input path the
// sampler instruments); every wait is domcontentloaded-based; billing-safe:
// armPage intercepts billed routes on every context and the suite touches GET
// routes and one unbilled POST /api/tasks only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, measureVendorBytes, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const PERF = process.env.CP_PERF === '1';

const FK = {
  main: 'alpha::main.tex',      // 0 — small file: sampler/longtask/legacy cases
  big: 'alpha::perf200k.tex',   // 1 — ~199k chars, UNDER the 200k model cap (T5)
};

const MAIN = '% perf main\n'
  + Array.from({ length: 120 }, (_, i) => `line ${i + 1} content padding text`).join('\n') + '\n';

/* The A16 "representative 200k-char document": hard-UNDER files.js's 200,000
   truncation cap — at or over it P5 routes to the read-only hlText branch and
   M1 never creates a model (T5), which would make the standing case vacuous. */
function buildPerfDoc() {
  const line = '\\textbf{seed} paragraph text with $\\alpha+\\beta$ inline math and \\cite{k} refs padding.\n';
  let body = '\\documentclass{article}\n\\begin{document}\n';
  while (body.length < 199000) body += line;
  return `${body}\\end{document}\n`;
}

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'main.tex'), MAIN);
      const doc = buildPerfDoc();
      assert.ok(doc.length > 190000 && doc.length < 200000,
        `perf doc must sit under the 200k model cap (${doc.length})`);
      fs.writeFileSync(path.join(projRoots.alpha, 'perf200k.tex'), doc);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'a16 perf seeds', category: 'calibration',
    oversight: 'manual',
    context: { files: ['main.tex', 'perf200k.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers (the ui.monaco-core corePage idiom — no vendor proxy here:
      bytes are measured against the REAL sandbox static route) ─────────── */

async function perfPage({ impl = 'monaco', init = null } = {}) {
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const msgs = [];
  page.on('console', (m) => msgs.push(m.text()));
  await page.addInitScript(([impl2, init2]) => {
    localStorage.clear();
    localStorage.setItem('editor:impl', impl2);
    if (init2) for (const [k, v] of Object.entries(init2)) window[k] = v;
  }, [impl, init]);
  await page.goto(`${sb.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, msgs };
}

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

/* ═══ A — the input-latency sampler (§4 item 2) ═══ */

test('A16 sampler: genuine CDP typing fills the ring — p50/p95 finite, census fold matches, blurred typing samples nothing', opts, async () => {
  const { context, page } = await perfPage();
  try {
    await waitEditor(page, FK.main);
    const pre = await page.evaluate(() => window.__mp.perf());
    assert.equal(pre.armed.input, true, 'the sampler armed with the editor (INIT)');
    assert.deepEqual(pre.input, { n: 0, p50: null, p95: null, max: null },
      'zero samples (and null percentiles) before any typing');

    // staging via __mp, the keystrokes themselves genuine CDP (the §2 rule —
    // the sampler instruments exactly the input path __mp bypasses)
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); });
    await page.keyboard.type('sampling burst', { delay: 30 });
    await page.waitForFunction(() => window.__mp.perf().input.n > 0, null, { timeout: 10000 });

    const s = await page.evaluate(() => ({ perf: window.__mp.perf(), c: window.__mp.counters() }));
    assert.ok(s.perf.input.n > 0 && s.perf.input.n <= 512, `ring bounded at 512 (${s.perf.input.n})`);
    assert.ok(Number.isFinite(s.perf.input.p50) && s.perf.input.p50 >= 0, `p50 finite (${s.perf.input.p50})`);
    assert.ok(Number.isFinite(s.perf.input.p95) && s.perf.input.p95 >= s.perf.input.p50,
      `p95 finite and ≥ p50 (${s.perf.input.p95})`);
    assert.ok(Number.isFinite(s.perf.input.max) && s.perf.input.max >= s.perf.input.p95, 'max ≥ p95');
    // the census fold (§4): the same ring read soakCounters gives the
    // 'lru-evict'/save-log lines — one evaluate, one ring, equal numbers
    assert.equal(s.c.latN, s.perf.input.n, 'soak census carries the sample count');
    assert.equal(s.c.latP50, s.perf.input.p50, 'soak census carries p50');
    assert.equal(s.c.latP95, s.perf.input.p95, 'soak census carries p95');

    // armed ⇔ attached AND focused: blurred typing must sample nothing
    await sleep(150); // any pending rAF sample settles first
    const n0 = await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      return window.__mp.perf().input.n;
    });
    await page.keyboard.type('blurred');
    await sleep(250);
    assert.equal(await page.evaluate(() => window.__mp.perf().input.n), n0,
      'no samples while the editor is unfocused');
  } finally {
    await context.close();
  }
});

/* ═══ B — the longtask ring (§4 item 3) + the generation boundary ═══ */

test('A16 longtask ring: armed at READY, records a forced long task, disposed + reset by rebootMonaco', opts, async () => {
  const { context, page } = await perfPage();
  try {
    await waitEditor(page, FK.main);
    assert.equal(await page.evaluate(() => window.__mp.perf().armed.longtask), true,
      'PerformanceObserver(longtask) armed at boot READY');

    // force one long task the observer must see: a TIMER task (not the
    // devtools evaluate itself) busy-waiting well past the 50ms threshold
    await page.evaluate(() => new Promise((res) => {
      setTimeout(() => {
        const t0 = performance.now();
        while (performance.now() - t0 < 150) { /* burn the main thread */ }
        res();
      }, 0);
    }));
    await page.waitForFunction(() => window.__mp.perf().longTasks.length > 0, null, { timeout: 5000 });
    const lt = await page.evaluate(() => window.__mp.perf().longTasks);
    assert.ok(lt.length > 0 && lt.length <= 64, `ring bounded at 64 (${lt.length})`);
    for (const e of lt) {
      assert.ok(Number.isFinite(e.ts) && e.ts >= 0, `ts is ms since page start (${e.ts})`);
      assert.ok(Number.isFinite(e.dur) && e.dur > 0, `dur recorded (${e.dur})`);
    }
    assert.ok(lt.some((e) => e.dur >= 100), 'the forced ~150ms task landed in the ring');

    // the generation boundary: reboot disarms BOTH instruments and resets
    // BOTH rings — the old numbers measured a disposed editor instance
    const rb = await page.evaluate(() => { window.__mp.reboot(); return window.__mp.perf(); });
    assert.deepEqual(rb.armed, { input: false, longtask: false },
      'observer + sampler disposed in the boot-machine cleanup (rebootMonaco route)');
    assert.equal(rb.longTasks.length, 0, 'longtask ring reset for the fresh generation');
    assert.equal(rb.input.n, 0, 'latency ring reset for the fresh generation');
    assert.equal(await page.evaluate(() => window.__mp.state()), 'IDLE');
  } finally {
    await context.close();
  }
});

/* ═══ C — legacy control: nothing armed, nothing sampled, no boot ═══ */

test('A16 under legacy: probe reports armed:false, zero observers/samples, boot never starts, legacy typing never samples', opts, async () => {
  const { context, page } = await perfPage({ impl: 'legacy' });
  try {
    await page.waitForSelector('textarea#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await sleep(1200); // span the idle-warm window — must stay a no-op
    const s = await page.evaluate(() => ({
      state: window.__mp.state(),
      perf: window.__mp.perf(),
      c: window.__mp.counters(),
    }));
    assert.equal(s.state, 'IDLE', 'no boot under legacy');
    assert.deepEqual(s.perf.armed, { input: false, longtask: false },
      'zero instruments armed under legacy (the near-zero-idle-cost gate)');
    assert.deepEqual(s.perf.input, { n: 0, p50: null, p95: null, max: null });
    assert.deepEqual(s.perf.longTasks, []);
    assert.deepEqual({ latN: s.c.latN, latP50: s.c.latP50, latP95: s.c.latP95 },
      { latN: 0, latP50: null, latP95: null }, 'the census fold reads empty under legacy');

    // genuine keystrokes into the legacy textarea: still zero samples
    await page.click('textarea#codeEditor');
    await page.keyboard.type('legacy keys');
    await sleep(250);
    assert.equal(await page.evaluate(() => window.__mp.perf().input.n), 0,
      'legacy typing never reaches the sampler');
  } finally {
    await context.close();
  }
});

/* ═══ D — the vendor bytes harness (§4 item 4): shapes, never budgets ═══ */

test('A16 bytes harness: cold pass fetches real 200s with bytes, warm pass revalidates as 304s below cold transfer', opts, async () => {
  const r = await measureVendorBytes(ui);
  // cold: a fresh cache pulls loader + core + css (at minimum) as real bodies
  assert.ok(r.cold.count >= 3, `cold requested ≥3 vendor resources (${r.cold.count})`);
  assert.ok(r.cold.bytes > 0, `cold encoded bytes measured (${r.cold.bytes})`);
  assert.ok(r.cold.s200 >= 3, `cold responses are real 200s (${r.cold.s200})`);
  assert.equal(r.cold.s304, 0, 'a fresh context has nothing to revalidate');
  for (const row of r.cold.rows) {
    assert.ok(row.url.startsWith('/vendor/monaco/'), `vendor rows only: ${row.url}`);
  }
  // warm: the primed cache revalidates (express.static ETag + max-age=0)
  assert.ok(r.warm.count > 0, `warm pass re-requested the vendor route (${r.warm.count})`);
  assert.ok(r.warm.s304 > 0, `warm requests revalidate as 304s (${r.warm.s304})`);
  assert.ok(r.warm.bytes < r.cold.bytes,
    `warm transfer sits below cold (${r.warm.bytes} < ${r.cold.bytes}) — the S2b compression lever measures against exactly this pair`);
  // the quotable line for S2b's budget ruling (numbers, no judgement here)
  console.log(`A16 VENDOR BYTES cold ${r.cold.count} req / ${r.cold.bytes} B · warm ${r.warm.count} req / ${r.warm.bytes} B (${r.warm.s304}×304)`);
});

/* ═══ E — the CP_PERF=1 standing case (§4 item 5): SKIPPED loudly by default ═══ */

test('A16 standing perf case (CP_PERF gate): 200k-char doc — ready-to-first-edit, typing-burst latency ring, heap delta', opts, async (t) => {
  if (!PERF) {
    const msg = 'A16 STANDING PERF CASE SKIPPED — CP_PERF=1 not set (the S2b gate).\n'
      + '    S2b runs it against its budgets:  cd app && CP_PERF=1 node --test test/ui.monaco-perf.test.mjs';
    console.error(`\n*** ${msg}\n`);
    t.skip(msg);
    return;
  }
  const { context, page } = await perfPage();
  try {
    await waitEditor(page, FK.main);
    const before = await page.evaluate(() => ({
      heapMB: window.__mp.counters().heapMB,
      bootReadyMs: (window.__mp.log().find((e) => e.state === 'READY') || {}).ms ?? null,
    }));

    // open the 200k document — open→editor-live measured wholly in-page
    await page.evaluate(() => {
      window.__perfT0 = performance.now();
      document.querySelector('.ctab.cd[data-fi="1"]').click();
    });
    await waitEditor(page, FK.big);
    const openToEditorMs = await page.evaluate(() => Math.round(performance.now() - window.__perfT0));
    const chars = await page.evaluate((fk) => (window.__mp.text(fk) || '').length, FK.big);
    assert.ok(chars > 190000 && chars < 200000,
      `the doc is MODELED at ${chars} chars — never the >200k read-only branch (T5)`);

    // first genuine keystroke → buffer (the ready-to-first-edit tail; the
    // one CDP round-trip inside the window is noted measurement noise)
    await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(2, 1); });
    await page.evaluate(() => { window.__perfT1 = performance.now(); });
    await page.keyboard.press('X');
    await page.waitForFunction(([fk, n]) => (window.__mp.text(fk) || '').length > n,
      [FK.big, chars], { timeout: 10000 });
    const firstKeyToBufferMs = await page.evaluate(() => Math.round(performance.now() - window.__perfT1));

    // the typing burst, sampled through the A16 latency ring (genuine CDP)
    await page.keyboard.type('burst typing latency sample text for the A16 ring ', { delay: 20 });
    await page.waitForFunction(() => window.__mp.perf().input.n >= 10, null, { timeout: 15000 });
    const after = await page.evaluate(() => ({
      perf: window.__mp.perf(),
      counters: window.__mp.counters(),
    }));

    const rec = {
      doc: 'perf200k.tex',
      chars,
      bootReadyMs: before.bootReadyMs,
      openToEditorMs,
      firstKeyToBufferMs,
      input: after.perf.input,
      longTasks: after.perf.longTasks.length,
      heapMB: {
        before: before.heapMB,
        after: after.counters.heapMB,
        delta: (Number.isFinite(before.heapMB) && Number.isFinite(after.counters.heapMB))
          ? after.counters.heapMB - before.heapMB : null,
      },
    };
    console.log(`A16 PERF RECORD ${JSON.stringify(rec)}`);

    // sane shapes ONLY — the pass/fail budgets are ruled at S2b, never here
    assert.ok(Number.isFinite(rec.openToEditorMs) && rec.openToEditorMs >= 0, 'open→editor measured');
    assert.ok(Number.isFinite(rec.firstKeyToBufferMs) && rec.firstKeyToBufferMs >= 0, 'first-edit tail measured');
    assert.ok(rec.input.n >= 10, `the burst filled the ring (${rec.input.n} samples)`);
    assert.ok(Number.isFinite(rec.input.p50) && Number.isFinite(rec.input.p95) && rec.input.p95 >= rec.input.p50,
      'burst p50/p95 finite and ordered');
    assert.ok(typeof rec.heapMB.after === 'number', 'heapMB rides performance.memory under Chrome');
    assert.ok(rec.heapMB.delta === null || Number.isFinite(rec.heapMB.delta), 'heap delta recorded');
  } finally {
    await context.close();
  }
});
