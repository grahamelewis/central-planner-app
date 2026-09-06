// test/uiHarness.mjs — drive the real dashboard in headless Chrome against a
// sandboxed server (serverHarness.mjs).
//
// Two safety layers against billed Claude calls:
//   1. page.route() fulfills /launch and /message before they leave the browser
//   2. the WebSocket is stubbed, so the page never talks to the real session
//      machinery anyway — tests push synthetic WS events via wsPush()
//
// Instrumentation (installed before the page loads):
//   window.__shifts    — Layout Instability API entries with per-node sources
//   window.__ws        — the stubbed socket; wsPush() feeds it server events
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startSandbox } from './serverHarness.mjs';

// Resolved Chrome path — CP_CHROME overrides the default /Applications install
// (the CI seam). UI test files import this for their skip guards, so a bad
// CP_CHROME skips the suites instead of failing mid-launch.
export const CHROME = process.env.CP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Arm a page with the harness safety + instrumentation layers (billed-route
 * interception, WS stub, layout-shift telemetry). startUI does this for its
 * page; tests that open EXTRA contexts (e.g. the Monaco boot suite needs a
 * cold cache per failure mode) call it on each fresh page before goto.
 */
export async function armPage(page) {
  // ---- safety: billed routes never reach the server ----
  await page.route('**/api/tasks/*/*/memory/update', (r) => r.fulfill({ status: 403, json: { error: 'blocked in ui tests' } }));
  await page.route('**/api/tasks/*/*/message', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/tasks/*/*/launch', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/tasks/*/*/retry', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/profile/generate', (r) => r.fulfill({ status: 502, json: { error: 'blocked in ui tests' } }));
  await page.route('**/api/texfix/**', (r) => r.fulfill({ json: { ok: true } }));
  // not billed, but /api/auth/login would pop the DEV machine's browser —
  // tests override these with their own page.route when they need real bodies
  await page.route('**/api/auth/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/providers/codex/**', (r) => r.fulfill({ json: { ok: true, connected: false } }));

  await page.addInitScript(() => {
    // stub the WebSocket: the app assigns on* properties, never addEventListener
    // NOTE: no `static OPEN = 1` on purpose — the app's half-open staleness
    // sweep compares readyState === WebSocket.OPEN, so under the stub it
    // idles and can't close the socket mid-test during long quiet waits.
    // The liveness test opts in by assigning WebSocket.OPEN itself.
    window.__wsSent = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        window.__ws = this;
        setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
      }
      send(d) { window.__wsSent.push(String(d)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    };

    // layout-shift telemetry: which nodes moved, from where to where
    window.__shifts = [];
    const describe = (n) => {
      if (!n || !n.tagName) return '?';
      const id = n.id ? `#${n.id}` : '';
      const cls = n.className && typeof n.className === 'string'
        ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${n.tagName.toLowerCase()}${id}${cls}`;
    };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shifts.push({
            t: Math.round(e.startTime),
            value: +e.value.toFixed(4),
            sources: (e.sources || []).map((s) => ({
              node: describe(s.node),
              from: { x: s.previousRect.x, y: s.previousRect.y, w: s.previousRect.width, h: s.previousRect.height },
              to: { x: s.currentRect.x, y: s.currentRect.y, w: s.currentRect.width, h: s.currentRect.height },
            })),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* older chrome — shifts just stay empty */ }
  });
}

export async function startUI({ seed, viewport = { width: 1600, height: 1000 }, trial = [], monacoProxy = false } = {}) {
  const sb = await startSandbox({ seed, trial, monacoProxy });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  } catch (err) {
    // Close the sandbox before rethrowing — an open server handle here would
    // keep the node --test child alive forever (hang, not a failure).
    await sb.stop();
    const src = process.env.CP_CHROME ? ' (from CP_CHROME)' : '';
    throw new Error(`uiHarness: failed to launch Chrome at ${CHROME}${src}: ${err.message}`);
  }
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await armPage(page);

  /** Feed the page one synthetic server WS event. */
  const wsPush = (type, payload) => page.evaluate(([t, p]) => {
    if (window.__ws && window.__ws.onmessage) {
      window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
    }
  }, [type, payload]);

  /** Drain and reset the layout-shift log. */
  const takeShifts = () => page.evaluate(() => {
    const s = window.__shifts;
    window.__shifts = [];
    return s;
  });

  return {
    sb,
    browser,
    page,
    wsPush,
    takeShifts,
    async stop() {
      await browser.close().catch(() => {});
      await sb.stop();
    },
  };
}

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* Monaco regression runner: each case gets a fresh browser context.
   The server and browser are shared; page-global loaders, models, caches,
   and preferences never leak from an earlier case. */

/**
 * A fresh context with billed-route protection and error capture.
 * @param {{ browser: import('playwright-core').Browser,
 *           sb: { base: string, vendor?: { base: string, clear(): void } | null } }} u
 *   the suite's startUI handle (its sandbox server is shared across passes)
 * @param {'monaco'} impl retained as the recorded mode label
 * @param {{ viewport?: { width: number, height: number }, hash?: string,
 *           init?: Record<string, unknown> | null }} [opts]
 *   `hash` is the deep link ('#alpha' default); `init` seeds window overrides.
 * @returns {Promise<{ context: import('playwright-core').BrowserContext,
 *                     page: import('playwright-core').Page,
 *                     msgs: string[], errors: string[] }>}
 */
export async function implPage(u, impl, { viewport = { width: 1600, height: 1000 }, hash = '#alpha', init = null } = {}) {
  // vendor proxy (when the suite runs one): drop stale injection rules + hit
  // logs so no earlier case's failure mode leaks into this pass
  if (u.sb.vendor) u.sb.vendor.clear();
  const context = await u.browser.newContext({ viewport });
  const page = await context.newPage();
  await armPage(page);
  const msgs = [];
  const errors = [];
  page.on('console', (m) => msgs.push(m.text()));
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript((init2) => {
    localStorage.clear();
    // Monaco is the sole implementation; no preference to seed.
    if (init2) for (const [k, v] of Object.entries(init2)) window[k] = v;
  }, init);
  await page.goto(`${u.sb.vendor ? u.sb.vendor.base : u.sb.base}/${hash}`, { waitUntil: 'domcontentloaded' });
  return { context, page, msgs, errors };
}

/**
 * Register one Monaco contract in its own isolated context. The suite
 * supplies a run-time accessor because its before() hook owns setup.
 * @param {string} name the contract's title (mode tag appended per pass)
 * @param {{ ui: () => { browser: import('playwright-core').Browser, sb: any },
 *           skip?: Partial<Record<'monaco', string | boolean>>
 *                | ((impl: 'monaco') => string | boolean | undefined),
 *           page?: { viewport?: { width: number, height: number },
 *                    hash?: string, init?: Record<string, unknown> | null } }} cfg
 *   `skip` is PER MODE — a skipped mode reports as that mode's own skip.
 * @param {(pass: { impl: 'monaco',
 *                  ui: any, t: import('node:test').TestContext,
 *                  context: import('playwright-core').BrowserContext,
 *                  page: import('playwright-core').Page,
 *                  msgs: string[], errors: string[] }) => Promise<void>} body
 * @returns {void}
 */
export function testMonaco(name, cfg, body) {
  for (const impl of /** @type {('monaco')[]} */ (['monaco'])) {
    const modeSkip = typeof cfg.skip === 'function' ? cfg.skip(impl) : cfg.skip && cfg.skip[impl];
    const skip = !fs.existsSync(CHROME) ? 'Google Chrome not installed' : modeSkip || false;
    test(`${name} [impl=${impl}]`, { skip }, async (t) => {
      const u = cfg.ui();
      const pass = await implPage(u, impl, cfg.page || {});
      try {
        await body({ impl, ui: u, t, ...pass });
      } finally {
        await pass.context.close();
      }
    });
  }
}

/* Buffer assertions and caret staging use the read-only/test seams.
   Actual typing still uses genuine browser keystrokes. */

/**
 * @returns {{ monaco: boolean,
 *   wait: (page: import('playwright-core').Page, fkey: string, timeout?: number) => Promise<void>,
 *   text: (page: import('playwright-core').Page, fkey: string) => Promise<string | null>,
 *   caretStart: (page: import('playwright-core').Page) => Promise<void>,
 *   caretEnd: (page: import('playwright-core').Page) => Promise<void> }}
 */
export function edDriver() {
  return {
    monaco: true,
    async wait(page, fkey, timeout = 25000) {
      await page.waitForFunction(fk => window.__mp?.state() === 'READY' && window.__mp.activeFkey() === fk
        && !!document.querySelector('.view.show .wb > .mdock.on .monaco-editor'), fkey, { timeout });
    },
    text: (page, fkey) => page.evaluate(fk => window.__mp.text(fk), fkey),
    async caretStart(page) { await page.evaluate(() => { window.__mp.focus(); window.__mp.setPosition(1, 1); }); },
    async caretEnd(page) { await page.evaluate(() => {
      window.__mp.focus(); const lines = String(window.__mp.getText() ?? '').split('\n');
      window.__mp.setPosition(lines.length, lines.at(-1).length + 1);
    }); },
  };
}

/** Feed ONE page (an implPage pass) a synthetic server WS event. */
export const wsPushTo = (page, type, payload) => page.evaluate(([t, p]) => {
  if (window.__ws && window.__ws.onmessage) {
    window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
  }
}, [type, payload]);

/** Split `text` into chunks of `n`-ish chars — adversarial mid-token splits. */
export function chunked(text, n = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

/* ── Phase 3 S2.6 / A16 seed (monaco-s2 §4 item 4): the vendor bytes harness ──
   Cold vs warm transfer for /vendor/monaco/* measured over CDP Network
   events against the sandbox's REAL static route (the A5 spike methodology,
   now repeatable): explicitly boot Monaco in a fresh context, then reload in
   the SAME context replays every request against the primed HTTP cache —
   express.static serves ETag + max-age=0, so warm requests revalidate as
   304s. encodedDataLength is the on-the-wire size (identity-encoded today —
   compression is exactly the S2b lever this exists to measure before/after).
   Numbers are RETURNED, never judged: the byte budgets are S2b's ruling.

   NOT armPage here, deliberately: any page.route() disables Chromium's HTTP
   cache for the page (verified empirically — the warm pass re-downloads
   every byte), which erases the very cold/warm distinction this harness
   exists to measure. The billed-route armor is an init-script fetch guard
   instead (the app is fetch-only — no XHR), the WS stub rides the same init
   script, and the sandbox's CP_NO_BILLED=1 + empty ANTHROPIC_API_KEY layers
   stand behind both. The measurement itself performs no POST at all. */

/**
 * Measure the /vendor/monaco transfer profile: one cold pass (fresh context,
 * empty cache) and one warm pass (same context, reload) to boot READY each.
 * @param {{ browser: import('playwright-core').Browser, sb: { base: string } }} u
 *   the suite's startUI handle — measurement always targets `sb.base`
 *   directly (the sandbox static route), NEVER the failure-injection proxy
 * @param {{ hash?: string, settleMs?: number, timeout?: number }} [opts]
 *   `settleMs` lets trailing worker/css fetches land after READY
 * @returns {Promise<{ cold: object, warm: object }>} per pass: `count`,
 *   summed `bytes` (encodedDataLength), `s200` (real bodies), `s304`
 *   (revalidations), `fromCache`, and the raw `rows`
 */
export async function measureVendorBytes(u, { hash = '#alpha', settleMs = 600, timeout = 30000 } = {}) {
  const context = await u.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  // the cache-preserving safety layer (see the harness comment above)
  await page.addInitScript(() => {
    const BILLED = /\/api\/(?:tasks\/[^/]+\/[^/]+\/(?:launch|message|retry)|profile\/generate|texfix\/)/;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && BILLED.test(url)) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'billed route blocked (measureVendorBytes guard)' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return realFetch(input, init);
    };
    // the armPage WS stub, verbatim minus layout-shift telemetry
    window.__wsSent = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        window.__ws = this;
        setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
      }

      send(d) { window.__wsSent.push(String(d)); }

      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const byId = new Map(); // requestId → row (this pass's /vendor/monaco/* traffic)
  cdp.on('Network.requestWillBeSent', (e) => {
    const i = e.request.url.indexOf('/vendor/monaco/');
    if (i < 0) return;
    byId.set(e.requestId, { url: e.request.url.slice(i), status: 0, encodedBytes: 0, fromCache: false });
  });
  cdp.on('Network.requestServedFromCache', (e) => {
    const r = byId.get(e.requestId);
    if (r) r.fromCache = true;
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = byId.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    if (e.response.fromDiskCache) r.fromCache = true;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = byId.get(e.requestId);
    if (r) r.encodedBytes = e.encodedDataLength;
  });
  await page.addInitScript(() => {
    localStorage.clear();
    // Measurements trigger the same boot explicitly, without relying on idle warmup.
  });
  const pass = async () => {
    await page.waitForFunction(() => !!window.__mp);
    await page.evaluate(() => window.__mp.ensure());
    await page.waitForFunction(() => window.__mp && window.__mp.state() === 'READY',
      null, { timeout, polling: 100 });
    await sleep(settleMs); // trailing fetches + their loadingFinished events
    const rows = [...byId.values()];
    return {
      count: rows.length,
      bytes: rows.reduce((n, r) => n + r.encodedBytes, 0),
      s200: rows.filter((r) => r.status === 200 && !r.fromCache).length,
      s304: rows.filter((r) => r.status === 304).length,
      fromCache: rows.filter((r) => r.fromCache).length,
      rows,
    };
  };
  try {
    await page.goto(`${u.sb.base}/${hash}`, { waitUntil: 'domcontentloaded' });
    const cold = await pass();
    byId.clear();
    await page.reload({ waitUntil: 'domcontentloaded' });
    const warm = await pass();
    return { cold, warm };
  } finally {
    await context.close();
  }
}
