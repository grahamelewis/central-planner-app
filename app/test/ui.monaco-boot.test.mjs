// test/ui.monaco-boot.test.mjs — Phase 3 S1: the A6 boot state machine, the
// editor:impl toggle (default legacy, §14-A15 coarse pin), and the kept dock
// skeleton (A7), tested per the monaco-s05 §A6 test spec:
//   - failure injection is SERVER-SIDE (serverHarness vendor proxy) — never
//     page.route, which misses dedicated-worker importScripts;
//   - every wait is domcontentloaded-based — the core-hang case blocks
//     window 'load' forever, so nothing here (or in the boot machine) may
//     depend on it;
//   - every injection case asserts: bootPromise settled (never pending),
//     legacy editor present + editable, draft text survives, and the
//     persisted editor:impl preference unchanged (fallback never writes it).
// Billing-safe: armPage() intercepts billed routes + stubs the WS on every
// context this file opens; only GET routes and /api/tasks POST (task create,
// unbilled) are exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEX = '\\documentclass{article}\n\\begin{document}\nHello boot machine\n\\end{document}\n';

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), TEX);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'boot machine', category: 'calibration',
    oversight: 'manual', context: { files: ['notes.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * Fresh context + page through the vendor proxy — a COLD cache per failure
 * mode (a warm cache would satisfy a blocked URL from memory and hide the
 * injection). `impl` seeds localStorage['editor:impl']; `init` seeds window
 * overrides (__mpDeadlineMs, __mpInitThrow, …); `inject` arms proxy rules;
 * `touch` enables CDP touch emulation (Chrome then reports pointer:coarse +
 * any-pointer:coarse — the A15 coarse-only profile); `hybridShim` layers a
 * matchMedia wrapper reporting any-pointer:fine TRUE on top of the touch
 * profile — Chrome's emulation cannot express a genuine coarse-primary +
 * fine-secondary device, so the hybrid case shims the media API boundary.
 */
async function bootPage({ impl = null, init = null, inject = null, touch = false, hybridShim = false } = {}) {
  if (inject) sb.vendor.set(inject); else sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const msgs = [];
  page.on('console', (m) => msgs.push(m.text()));
  if (touch) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  if (hybridShim) {
    await page.addInitScript(() => {
      // hybrid device profile: any-pointer:fine is TRUE (a fine pointer
      // exists), so ANY query relying on `not (any-pointer:fine)` must lose —
      // everything else passes through to the real (touch-emulated) engine
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        const s = String(q).replace(/\s+/g, '');
        if (s.includes('any-pointer:fine')) {
          const matches = s.includes('not(any-pointer:fine)') ? false : true;
          return /** @type {any} */ ({
            media: String(q), matches, onchange: null,
            addEventListener() {}, removeEventListener() {},
            addListener() {}, removeListener() {}, dispatchEvent: () => false,
          });
        }
        return orig(q);
      };
    });
  }
  await page.addInitScript(([impl2, init2]) => {
    if (impl2) localStorage.setItem('editor:impl', impl2);
    if (init2) for (const [k, v] of Object.entries(init2)) window[k] = v;
  }, [impl, init]);
  // NEVER waitUntil:'load' — the hang cases stall window 'load' forever
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, msgs };
}

const waitSettle = (page, timeout = 25000) => page.waitForFunction(
  () => window.__mp && ['READY', 'FALLBACK_LEGACY'].includes(window.__mp.state()),
  null, { timeout, polling: 100 },
);

/** bootPromise must be SETTLED — race it against a sentinel timeout. */
const settledResult = (page) => page.evaluate(() => Promise.race([
  window.__monacoReady,
  new Promise((res) => setTimeout(() => res('PENDING'), 1500)),
]));

const bootStates = (page) => page.evaluate(() => window.__mp.log().map((e) => e.state));

/**
 * The shared fallback drill: start on the LEGACY editor, type a draft, flip
 * the toggle to 'monaco' in-session, re-render (file-tab click), let the
 * armed injection kill the boot, and assert the atomic fallback contract.
 */
async function runFallbackCase({ inject, init = null, expectStage, extraChecks }) {
  const { context, page, msgs } = await bootPage({ impl: null, inject });
  try {
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
    // a real draft, typed through the keyboard — the fallback must preserve it
    await page.click('#codeEditor');
    await page.keyboard.type('DRAFTMARK');
    await page.waitForFunction(() => document.querySelector('#codeEditor').value.includes('DRAFTMARK'));
    // flip the toggle + test overrides, then re-render via the file tab
    await page.evaluate((ov) => {
      localStorage.setItem('editor:impl', 'monaco');
      if (ov) for (const [k, v] of Object.entries(ov)) window[k] = v;
    }, init);
    await page.click('.ctab.cd[data-fi="0"]');
    await waitSettle(page);

    assert.equal(await page.evaluate(() => window.__mp.state()), 'FALLBACK_LEGACY',
      `boot must end in FALLBACK_LEGACY (console: ${msgs.slice(-6).join(' | ')})`);
    // bootPromise settled — resolved {ok:false}, never pending, never rejected
    const r = await settledResult(page);
    assert.notEqual(r, 'PENDING', 'bootPromise must be settled, not pending');
    assert.equal(r.ok, false);
    assert.equal(r.stage, expectStage, `fallback stage: expected ${expectStage}, got ${r.stage}`);
    // legacy editor present, draft intact, still editable
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 10000 });
    const val = await page.evaluate(() => document.querySelector('#codeEditor').value);
    assert.ok(val.includes('DRAFTMARK'), 'the draft text must survive the fallback');
    await page.click('#codeEditor');
    await page.keyboard.type('Z');
    const val2 = await page.evaluate(() => document.querySelector('#codeEditor').value);
    assert.notEqual(val2, val, 'the legacy editor must be editable after fallback');
    // the stored preference is NEVER persisted off — session memory only
    assert.equal(await page.evaluate(() => localStorage.getItem('editor:impl')), 'monaco',
      'fallback must not write localStorage[editor:impl]');
    assert.equal(await page.evaluate(() => window.__mp.forcedLegacy()), true);
    // no monaco DOM left behind; the dock is hidden and empty
    assert.equal(await page.evaluate(() => document.querySelectorAll('.monaco-editor').length), 0);
    assert.equal(await page.evaluate(() => {
      const d = document.querySelector('#v-alpha .wb > .mdock');
      return d ? getComputedStyle(d).display : 'missing';
    }), 'none');
    if (extraChecks) await extraChecks(page, msgs);
  } finally {
    await context.close();
  }
}

/* ── baseline: READY, milestones, single-flight, kept dock ───────────── */

test('baseline → READY: milestones logged, single-flight under the idle-warm/first-open race, kept dock live', opts, async () => {
  const { context, page } = await bootPage({ impl: 'monaco' });
  try {
    await waitSettle(page);
    assert.equal(await page.evaluate(() => window.__mp.state()), 'READY');
    const states = await bootStates(page);
    for (const s of ['LOADER', 'CORE', 'INIT', 'CSS_VERIFY', 'READY']) {
      assert.ok(states.includes(s), `boot log must contain the ${s} milestone (got ${states.join('→')})`);
    }
    assert.ok(states.indexOf('LOADER') < states.indexOf('CORE')
      && states.indexOf('CORE') < states.indexOf('INIT')
      && states.indexOf('INIT') < states.indexOf('CSS_VERIFY')
      && states.indexOf('CSS_VERIFY') < states.indexOf('READY'), 'milestones in machine order');
    // single-flight: two synchronous ensureMonaco() calls share ONE promise,
    // and the whole session (idle warm + first-open attach + these two calls)
    // started exactly one boot sequence and injected exactly one loader tag
    const sf = await page.evaluate(() => ({
      same: window.__mp.ensure() === window.__mp.ensure(),
      count: window.__mp.bootCount(),
      loaders: document.querySelectorAll('script[src*="/vendor/monaco/vs/loader.js"]').length,
    }));
    assert.equal(sf.same, true, 'concurrent ensureMonaco() calls must return the same promise');
    assert.equal(sf.count, 1, 'exactly one boot sequence for the whole session');
    assert.equal(sf.loaders, 1, 'exactly one injected loader script tag');
    const r = await settledResult(page);
    assert.equal(r.ok, true, 'bootPromise resolves {ok:true} at READY');
    // the kept dock: live Monaco editor inside .mdock.on, no legacy textarea
    // (the kept host itself carries the #codeEditor id + datasets since S1.2
    // — the P14 contact surface for editorChrome — so the check is
    // textarea-scoped: the legacy editor specifically must not render)
    await page.waitForSelector('#v-alpha .wb > .mdock.on .monaco-editor', { timeout: 15000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('textarea#codeEditor').length), 0,
      'monaco mode renders no legacy textarea');
    await page.waitForSelector('#monacoSlot', { timeout: 5000 });

    // kept-instance mini-storm (full I2 suite lands with ui.monaco-core): the
    // SAME host node must survive tab round-trips through ≋ console — the
    // renders refill sibling slots, never an ancestor of the dock (A7)
    await page.evaluate(() => { document.querySelector('.mpHost')._stamp = 'keep'; });
    for (let i = 0; i < 2; i++) {
      await page.click('.ctab.cd[data-fi="tail"]');
      await page.waitForSelector('#consoleBox', { timeout: 5000 });
      await page.click('.ctab.cd[data-fi="0"]');
      await page.waitForSelector('#monacoSlot', { timeout: 5000 });
    }
    const kept = await page.evaluate(() => ({
      stamp: document.querySelector('.mpHost') && document.querySelector('.mpHost')._stamp,
      state: window.__mp.state(),
      boots: window.__mp.bootCount(),
      docked: !!document.querySelector('#v-alpha .wb > .mdock.on .mpHost'),
    }));
    assert.equal(kept.stamp, 'keep', 'the kept host node survived the render storm');
    assert.equal(kept.state, 'READY');
    assert.equal(kept.boots, 1, 'no re-boot across renders');
    assert.equal(kept.docked, true, 'host re-docked after the console round-trip');
    assert.equal(await page.evaluate(() => localStorage.getItem('editor:impl')), 'monaco');
  } finally {
    await context.close();
  }
});

/* ── loader failures ─────────────────────────────────────────────────── */

test('loader-block → FALLBACK(loader/net) via script.onerror, one auto-retry first', opts, async () => {
  await runFallbackCase({
    inject: [{ target: 'loader', kind: 'block' }],
    expectStage: 'loader',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      const fails = log.filter((e) => e.state === 'FAILED' && e.stage === 'loader');
      assert.ok(fails.length >= 2, 'net-class loader failure retries once (two FAILED entries)');
      assert.equal(fails[0].kind, 'net', 'detector: script.onerror → loader/net');
      assert.ok(String(fails[0].url).includes('/vendor/monaco/vs/loader.js'), 'failed URL logged');
      assert.ok(log.some((e) => e.state === 'LOADER' && e.retry === 1), 'the retry re-entered LOADER');
    },
  });
});

test('loader-corrupt → FALLBACK(loader/parse) via the typeof require.config check (onload fires, onerror does NOT)', opts, async () => {
  await runFallbackCase({
    inject: [{ target: 'loader', kind: 'corrupt' }],
    expectStage: 'loader',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      const f = log.find((e) => e.state === 'FAILED' && e.stage === 'loader');
      assert.ok(f, 'a FAILED(loader) entry exists');
      assert.equal(f.kind, 'parse',
        'corruption is detected by the typeof-require.config-after-onload check, not onerror');
      // parse-class is NOT net-class: no auto-retry
      const fails = log.filter((e) => e.state === 'FAILED' && e.stage === 'loader');
      assert.equal(fails.length, 1, 'no auto-retry for a parse failure');
    },
  });
});

/* ── core failures ───────────────────────────────────────────────────── */

test('core-block → FALLBACK(core) with moduleId + neededBy logged (never err.message)', opts, async () => {
  await runFallbackCase({
    inject: [{ target: 'core', kind: 'block' }],
    init: { __mpDeadlineMs: 6000 },
    expectStage: 'core',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      const f = log.find((e) => e.state === 'FAILED' && e.stage === 'core');
      assert.ok(f, 'a FAILED(core) entry exists');
      assert.equal(typeof f.moduleId, 'string', 'AMD errback moduleId logged');
      assert.ok(/editor/.test(f.moduleId), `moduleId names the blocked chunk (${f.moduleId})`);
      assert.equal(typeof f.neededBy, 'string', 'neededBy logged (the transitive-dep attribution)');
      assert.ok(!JSON.stringify(log).includes('[object Event]'),
        'err.message is useless for AMD errors and must never be logged');
    },
  });
});

test('core-hang → FALLBACK(deadline): zero events, zero reliance on window load', opts, async () => {
  await runFallbackCase({
    inject: [{ target: 'core', kind: 'hang' }],
    init: { __mpDeadlineMs: 2500 },
    expectStage: 'deadline',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      const f = log.find((e) => e.state === 'FAILED' && e.stage === 'deadline');
      assert.ok(f, 'the single deadline timer is the sole detector for the hang');
      assert.equal(f.lastState, 'CORE', 'deadline records the last state reached');
    },
  });
});

test('core-hang: zero signal while hung — the machine holds in CORE, and boot never references window load', opts, async () => {
  // while the core fetch stalls there is NO errback, NO onerror, NO console
  // entry — and the pending script tag delays window 'load' whenever the hang
  // starts pre-load, which is why every wait in this file (and every step of
  // the machine) is domcontentloaded-based. The deadline is the sole detector.
  const { context, page } = await bootPage({
    impl: 'monaco',
    init: { __mpDeadlineMs: 4000 },
    inject: [{ target: 'core', kind: 'hang' }],
  });
  try {
    await page.waitForFunction(() => window.__mp && window.__mp.state() === 'CORE', null, { timeout: 15000 });
    await sleep(900); // the hang emits ZERO events in this window
    const mid = await page.evaluate(() => ({
      state: window.__mp.state(),
      failed: window.__mp.log().filter((e) => e.state === 'FAILED').length,
    }));
    assert.equal(mid.state, 'CORE', 'no signal before the deadline — the machine holds in CORE');
    assert.equal(mid.failed, 0, 'the hang produced zero failure events');
    await waitSettle(page, 20000);
    assert.equal(await page.evaluate(() => window.__mp.state()), 'FALLBACK_LEGACY');
    const r = await settledResult(page);
    assert.equal(r.stage, 'deadline', 'only the deadline detects the hang class');
    // structural mandate: the boot machine itself never gates on window 'load'
    const src = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
    assert.ok(!/addEventListener\(\s*['"]load['"]/.test(src), 'monacoPane must never listen for window load');
  } finally {
    await context.close();
  }
});

/* ── css / worker / lang / init ──────────────────────────────────────── */

test('css-block → one reinject retry, then FALLBACK(css)', opts, async () => {
  await runFallbackCase({
    inject: [{ target: 'css', kind: 'block' }],
    expectStage: 'css',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      assert.ok(log.some((e) => e.state === 'CSS_VERIFY' && e.reinject === 1),
        'exactly one reinject retry before failing');
      const f = log.find((e) => e.state === 'FAILED' && e.stage === 'css');
      assert.ok(f && String(f.href).includes('editor.main.css'), 'failed href logged');
      // the reinject really refetched: the proxy saw the css URL at least twice
      const cssHits = sb.vendor.hits().filter((u) => u.includes('editor.main.css'));
      assert.ok(cssHits.length >= 2, `css fetched ≥2 times (got ${cssHits.length})`);
    },
  });
});

test('worker-block → READY + workerDegraded + Monaco main-thread console warning (no fallback)', opts, async () => {
  const { context, page, msgs } = await bootPage({
    impl: 'monaco',
    inject: [{ target: 'worker', kind: 'block' }],
  });
  try {
    await waitSettle(page);
    assert.equal(await page.evaluate(() => window.__mp.state()), 'READY',
      'a worker failure is post-READY degradation, never fallback');
    await page.waitForFunction(() => window.__mp.degraded().worker === true, null, { timeout: 10000 });
    // Monaco's own auto-recovery warning — the editor continues on the main thread
    const warned = msgs.some((m) => /falling back to loading web worker code in main thread|could not create web worker/i.test(m));
    assert.ok(warned, `Monaco's main-thread fallback warning must appear (console: ${msgs.slice(-8).join(' | ')})`);
    // still a working editor, preference untouched
    await page.waitForSelector('#v-alpha .wb > .mdock.on .monaco-editor', { timeout: 15000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('editor:impl')), 'monaco');
    const r = await settledResult(page);
    assert.equal(r.ok, true);
  } finally {
    await context.close();
  }
});

test('lang-block (python post-boot) → READY + langDegraded(python), editing keeps working (no fallback)', opts, async () => {
  const { context, page } = await bootPage({
    impl: 'monaco',
    inject: [{ target: 'lang:python', kind: 'block' }],
  });
  try {
    await waitSettle(page);
    assert.equal(await page.evaluate(() => window.__mp.state()), 'READY');
    // trigger the lazy chunk after boot — A5: no eager preload, languages
    // activate through the retained AMD loader on first encounter
    await page.evaluate(() => window.__mp.setLanguage('python'));
    await page.waitForFunction(() => window.__mp.degraded().langs.includes('python'), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__mp.state()), 'READY', 'lang failure never falls back');
    assert.equal(await page.evaluate(() => window.__mp.forcedLegacy()), false);
    // plaintext degradation only — the buffer still edits
    const roundtrip = await page.evaluate(() => {
      window.__mp.setText('x = 1');
      return window.__mp.getText();
    });
    assert.equal(roundtrip, 'x = 1');
    assert.equal(await page.evaluate(() => localStorage.getItem('editor:impl')), 'monaco');
    const r = await settledResult(page);
    assert.equal(r.ok, true);
  } finally {
    await context.close();
  }
});

test('init-throw (test seam in wiring) → FALLBACK(init) with a real stack', opts, async () => {
  await runFallbackCase({
    inject: null, // nothing blocked — the failure is our own wiring throwing
    init: { __mpInitThrow: true },
    expectStage: 'init',
    extraChecks: async (page) => {
      const log = await page.evaluate(() => window.__mp.log());
      const f = log.find((e) => e.state === 'FAILED' && e.stage === 'init');
      assert.ok(f, 'a FAILED(init) entry exists — the try/catch around wiring caught the throw');
      assert.ok(String(f.message).includes('injected init failure'), 'the Error message is logged');
      assert.ok(typeof f.stack === 'string' && f.stack.length > 0, 'a stack is logged');
    },
  });
});

/* ── toggle + A15 device pin ─────────────────────────────────────────── */

test('toggle default: editor:impl unset → legacy editor, dock hidden/empty, zero vendor fetches', opts, async () => {
  const { context, page } = await bootPage({ impl: null });
  try {
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await sleep(1200); // let the idle-warm window pass — it must be a no-op
    const s = await page.evaluate(() => ({
      impl: window.__mp.impl(),
      state: window.__mp.state(),
      boots: window.__mp.bootCount(),
      slot: document.querySelectorAll('#monacoSlot').length,
      monaco: document.querySelectorAll('.monaco-editor').length,
      dockDisplay: getComputedStyle(document.querySelector('#v-alpha .wb > .mdock')).display,
      dockEmpty: document.querySelector('#v-alpha .wb > .mdock').innerHTML === '',
      // the legacy editor DOM is the full pre-Monaco structure
      edWrap: !!document.querySelector('.edWrap .edGutter #edGutterInner')
        && !!document.querySelector('.edWrap #codeHL')
        && !!document.querySelector('.edWrap #codeEditor'),
    }));
    assert.equal(s.impl, 'legacy', 'default is legacy');
    assert.equal(s.state, 'IDLE', 'no boot ever started');
    assert.equal(s.boots, 0);
    assert.equal(s.slot, 0, 'no monaco slot in legacy renders');
    assert.equal(s.monaco, 0);
    assert.equal(s.dockDisplay, 'none', 'the dock is display:none in legacy mode');
    assert.equal(s.dockEmpty, true, 'the dock is empty in legacy mode');
    assert.equal(s.edWrap, true, 'legacy editor structure byte-for-byte intact (wrap+gutter+overlay)');
    const vendorHits = sb.vendor.hits();
    assert.equal(vendorHits.length, 0,
      `legacy mode must fetch nothing from /vendor/monaco (saw: ${vendorHits.join(', ')})`);
  } finally {
    await context.close();
  }
});

test('A15 coarse pin: (pointer:coarse) and (not (any-pointer:fine)) → legacy regardless of stored monaco', opts, async () => {
  // CDP touch emulation → Chrome reports pointer:coarse + any-pointer:coarse
  // (verified: the pin query matches natively under this emulation)
  const { context, page } = await bootPage({ impl: 'monaco', touch: true });
  try {
    await page.waitForSelector('#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await sleep(1200);
    const s = await page.evaluate(() => ({
      pinned: window.__mp.pinnedCoarse(),
      impl: window.__mp.impl(),
      stored: localStorage.getItem('editor:impl'),
      state: window.__mp.state(),
      boots: window.__mp.bootCount(),
      monaco: document.querySelectorAll('.monaco-editor').length,
    }));
    assert.equal(s.pinned, true, 'coarse-only device is pinned');
    assert.equal(s.impl, 'legacy', 'the pin overrides the stored preference');
    assert.equal(s.stored, 'monaco', 'the stored preference itself is untouched');
    assert.equal(s.state, 'IDLE', 'no boot on a pinned device');
    assert.equal(s.boots, 0);
    assert.equal(s.monaco, 0);
    assert.equal(sb.vendor.hits().length, 0, 'pinned device fetches nothing from /vendor/monaco');
  } finally {
    await context.close();
  }
});

test('A15 hybrid: coarse primary but any-pointer:fine → Monaco (the not-clause matters)', opts, async () => {
  // touch emulation supplies the coarse primary; the shim supplies the fine
  // secondary pointer Chrome's emulation cannot express — the pin's
  // not(any-pointer:fine) clause must then yield Monaco
  const { context, page } = await bootPage({ impl: 'monaco', touch: true, hybridShim: true });
  try {
    const mq = await page.evaluate(() => ({
      pinned: window.__mp.pinnedCoarse(),
      coarse: matchMedia('(pointer:coarse)').matches,
      anyFine: matchMedia('(any-pointer:fine)').matches,
    }));
    assert.equal(mq.coarse, true, 'the primary pointer really is coarse');
    assert.equal(mq.anyFine, true, 'a fine pointer exists (hybrid)');
    assert.equal(mq.pinned, false, 'a device with ANY fine pointer is not pinned');
    await waitSettle(page);
    assert.equal(await page.evaluate(() => window.__mp.state()), 'READY');
    await page.waitForSelector('#v-alpha .wb > .mdock.on .monaco-editor', { timeout: 15000 });
  } finally {
    await context.close();
  }
});

/* ── A7 source guard: no innerHTML write ever touches the dock's ancestry ── */

test('workbench source: the dock is never inside an innerHTML target, and the one skeleton build parks the host first', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'workbench.js'), 'utf8');
  const lines = src.split('\n');
  const writes = [];
  lines.forEach((l, i) => { if (/\.innerHTML\s*=/.test(l) && !/==/.test(l.split('.innerHTML')[1] || '')) writes.push({ i: i + 1, l }); });
  assert.ok(writes.length > 0, 'sanity: workbench has innerHTML slot refills');
  for (const wr of writes) {
    assert.ok(!/mdock|mpHost|mpPark/.test(wr.l),
      `innerHTML write at workbench.js:${wr.i} must not target the dock/host: ${wr.l.trim()}`);
  }
  // the single root.innerHTML (skeleton build-once) is guarded by the A7 park
  const rootWrites = writes.filter((wr) => /root\.innerHTML\s*=/.test(wr.l));
  assert.equal(rootWrites.length, 1, 'exactly one root.innerHTML skeleton build');
  const before = lines.slice(Math.max(0, rootWrites[0].i - 10), rootWrites[0].i - 1).join('\n');
  assert.ok(/mpParkHost/.test(before),
    'the skeleton rebuild must evacuate the kept host first (A7 belt)');
  // and the dock itself is a build-once sibling inside that skeleton
  assert.ok(/<div class="mdock"><\/div>/.test(src), 'the .mdock persists in the build-once skeleton');
});
