// test/ui.monaco-completions.test.mjs — Phase 3 S2.2: the latex completion
// provider wired into monacoPane (P10, monaco-s2 §1 S2.2 post-remediation).
// Covers, against the real vendored 0.56 dist:
//   - the no-word-noise gate (quickSuggestions:false / wordBasedSuggestions
//     'off' asserted from FIRST MOUNT; prose typing opens nothing) and the
//     trigger trio ['\\','{',','] opening the widget;
//   - genuine CDP typing through the suggest widget: \cite{ comma-awareness,
//     \ref{, the \begin{ env skeleton — each accepted with Enter (the widget
//     owns Enter, the S2.0 spike verdict / R9);
//   - A8 proven, not assumed: a target ABSENT from the first eight becomes
//     reachable by typing more — only a real re-query (incomplete:true) can
//     surface it, Monaco's client filter alone cannot;
//   - the closeBrace consume/hop overtype parity case, run under BOTH impls
//     with identical final text + caret (the pre-specced range workaround);
//   - the four mandated async-discipline cases (review concern 3) end to end,
//     with held /api/texmeta routes: switch-project-during-request,
//     edit-during-request, reboot-during-request, out-of-order resolution;
//   - the .bib exclusion (no provider on 'bibtex') and a legacy-untouched
//     control (suggest machinery absent under impl=legacy — S3 rule).
//
// Ground rules (monaco-s05 + blueprint §14): typing drives GENUINE CDP
// keystrokes; __mp is read-only here except focus/setPosition staging,
// providerComplete (the sanctioned S2.2 driver for the async cases — it
// bypasses the input path, which is why the widget cases above type for
// real), pushEdit (the edit-during-request edit), and reboot (its case's
// subject). Billing-safe: armPage intercepts the five billed routes on every
// context; this file touches GET routes (/api/texmeta is unbilled) and one
// unbilled POST /api/tasks per project only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME, testMonaco } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// the pinned files, by tab index (context.files order)
const FK = {
  main: 'alpha::main.tex',   // 0 — the typing playground (lines 3+ empty)
  async: 'alpha::async.tex', // 1 — `\cite{` on line 1: the providerComplete anchor
  bib: 'alpha::refs.bib',    // 2 — the .bib exclusion subject
  beta: 'beta::beta.tex',    // beta 0 — the switch-project/out-of-order partner
};

const MAIN_TEX = '% completions playground\ntext line two\n\n\n\n\n';
const ANCHOR_TEX = '\\cite{\npadding line\n'; // caret (1,7) → CITE prefix ''
const REFS_BIB = '@article{knuth84,\n  title = {Literate Programming},\n}\n';

const EMPTY_META = { labels: [], cites: [], envs: [], commands: [] };
const META = {
  labels: [{ label: 'eq:euler', file: 'main.tex', line: 2 }],
  cites: [
    { key: 'doe2019numerical', title: 'Numerical Methods' },
    { key: 'rivera2024heterogeneous', title: 'Heterogeneous Agents under Synthetic Shocks' },
  ],
  envs: [],
  commands: [],
};
const mkMeta = (keys) => ({
  labels: [], envs: [], commands: [],
  cites: keys.map((k) => ({ key: k, title: `Title of ${k}` })),
});

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'main.tex'), MAIN_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'async.tex'), ANCHOR_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'refs.bib'), REFS_BIB);
      fs.writeFileSync(path.join(projRoots.beta, 'beta.tex'), ANCHOR_TEX);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco completions', category: 'calibration',
    oversight: 'manual', context: { files: ['main.tex', 'async.tex', 'refs.bib'] },
  });
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'beta', title: 'beta completions', category: 'calibration',
    oversight: 'manual', context: { files: ['beta.tex'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

async function mkPage({ impl = 'monaco', project = 'alpha' } = {}) {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript((impl2) => { localStorage.setItem('editor:impl', impl2); }, impl);
  await page.goto(`${sb.vendor.base}/#${project}`, { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

/** Boot READY + the kept editor live on `fkey` inside `proj`'s visible dock. */
const waitEditor = (page, fkey, proj = 'alpha', timeout = 25000) => page.waitForFunction(([fk, v]) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector(`#v-${v} .wb > .mdock.on .monaco-editor`)
), [fkey, proj], { timeout, polling: 100 });

const clickTab = async (page, fi, fkey, proj = 'alpha') => {
  await page.click(`#v-${proj} .ctab.cd[data-fi="${fi}"]`);
  if (fkey) await waitEditor(page, fkey, proj);
};

/** One-shot resolvable gate (the held-route control for the async cases). */
function deferred() {
  let resolve, reject;
  const promise = new Promise((rs, rj) => { resolve = rs; reject = rj; });
  return { promise, resolve, reject };
}

/**
 * Intercept GET /api/texmeta/:project — the ONLY meta source both editor
 * paths use. `spec[project]` is the payload (read at fulfill time, so tests
 * may swap it mid-flight); `gates[project]`, when set, holds the response
 * until the test resolves it (set it back to null before releasing so later
 * fetches flow freely). Returns the per-project hit counter.
 */
async function routeTexmeta(page, spec, gates = null) {
  const hits = {};
  await page.route('**/api/texmeta/**', async (r) => {
    const proj = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop());
    hits[proj] = (hits[proj] || 0) + 1;
    if (gates && gates[proj]) await gates[proj].promise;
    await r.fulfill({ json: spec[proj] || EMPTY_META });
  });
  return hits;
}

/** Poll a node-side condition (the held-route hit counters). */
async function until(fn, ms = 15000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(step); }
  throw new Error('until: condition not met in time');
}

const widgetRows = (page) => page.evaluate(() => {
  const el = document.querySelector('.suggest-widget.visible');
  if (!el) return null;
  return [...el.querySelectorAll('.monaco-list-row')]
    .map((r) => r.getAttribute('aria-label') || r.textContent || '');
});

// generous by design: node --test runs suite files in parallel (§3 CHR —
// contention starves headless Chrome; a 10s budget flaked in-suite while
// passing standalone), so widget waits get the waitEditor-class allowance
const waitRow = (page, needle, timeout = 20000) => page.waitForFunction((s) => {
  const el = document.querySelector('.suggest-widget.visible');
  if (!el) return false;
  return [...el.querySelectorAll('.monaco-list-row')]
    .some((r) => ((r.getAttribute('aria-label') || r.textContent) || '').includes(s));
}, needle, { timeout, polling: 60 });

const widgetVisible = (page) => page.evaluate(() => !!document.querySelector('.suggest-widget.visible'));

const mpLine = (page, fkey, ln) => page.evaluate(([fk, n]) => window.__mp.text(fk).split('\n')[n - 1], [fkey, ln]);

/** Stage the caret at (line, col) of the active monaco model and focus. */
const stageCaret = (page, line, col) => page.evaluate(([l, c]) => {
  window.__mp.focus();
  window.__mp.setPosition(l, c);
}, [line, col]);

/* ═══ node-side: the registration fossil guard ═══ */

test('S2.2 fossil guard: ONE registerCompletionItemProvider — latex only, disposed per boot generation', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  assert.equal(src.split('registerCompletionItemProvider(').length - 1, 1,
    'exactly one registration call site (a second would double-register across reboots, N3)');
  assert.ok(/registerCompletionItemProvider\(latexLanguageId, completionProvider\)/.test(src),
    "the registration is for 'latex' — bibtex gets NO completion provider (the .bib exclusions for free)");
  assert.ok(/disposeLatexProviders\(\); \/\/ S2\.2\/N3/.test(src),
    'cleanupPartialBoot disposes the registrations with their boot generation (N3)');
  assert.ok(/if \(gen !== bootGen\) throw/.test(src),
    'requestMeta discards a response from a dead boot generation (disposal cannot cancel a returned promise)');
});

/* ═══ A — first-mount options, no word-noise, comma-aware cite through Enter ═══ */

test('no-word-noise gate from first mount; \\cite{ comma-aware list accepted with Enter (CDP)', opts, async () => {
  const { context, page } = await mkPage();
  try {
    const hits = await routeTexmeta(page, { alpha: META });
    await waitEditor(page, FK.main);

    // the pinned create options, live on the first mount (S2.2 gate). The
    // 0.56 dist normalizes quickSuggestions:false to the per-scope all-'off'
    // object in raw options — accept either spelling of "fully off".
    const so = await page.evaluate(() => window.__mp.suggestOptions());
    const qsOff = so.quickSuggestions === false
      || (!!so.quickSuggestions && typeof so.quickSuggestions === 'object'
        && Object.values(so.quickSuggestions).every((v) => v === 'off' || v === false));
    assert.ok(qsOff, `quickSuggestions fully off from first mount (got ${JSON.stringify(so.quickSuggestions)})`);
    assert.equal(so.wordBasedSuggestions, 'off', "wordBasedSuggestions 'off' from first mount");

    // prose typing opens NOTHING (no word-noise; only trigger chars query)
    await stageCaret(page, 3, 1);
    await page.keyboard.type('hello wor', { delay: 25 });
    await sleep(600);
    assert.equal(await widgetVisible(page), false, 'prose typing never opens the widget');

    // \cite{ … , … — the comma is a trigger char; the prefix is the segment
    // after the LAST comma (legacy comma-awareness, ported through the factory)
    await stageCaret(page, 4, 1);
    await page.keyboard.type('\\cite{doe2019numerical,riv', { delay: 25 });
    await waitRow(page, 'rivera2024heterogeneous');
    await page.keyboard.press('Enter'); // the widget owns Enter (S2.0 verdict)
    const line = await mpLine(page, FK.main, 4);
    assert.equal(line, '\\cite{doe2019numerical,rivera2024heterogeneous}',
      'range replaced only the post-comma prefix; the auto-paired } was consumed');
    const pos = await page.evaluate(() => window.__mp.getPosition());
    assert.deepEqual(pos, { line: 4, col: line.length + 1 }, 'caret after the emitted } (the legacy hop)');
    assert.equal(await widgetVisible(page), false, 'accept closed the widget');
    assert.equal(hits.alpha, 1, 'one texmeta GET for the whole burst (5s cache + single flight)');
  } finally {
    await context.close();
  }
});

/* ═══ B — \begin{ env skeleton through accept-with-Enter ═══ */

test('\\begin{ env skeleton: Enter accepts the snippet — brace consumed, body line indented, \\end added', opts, async () => {
  const { context, page } = await mkPage();
  try {
    await routeTexmeta(page, { alpha: META });
    await waitEditor(page, FK.main);
    await stageCaret(page, 4, 1);
    await page.keyboard.type('\\begin{ite', { delay: 25 });
    await waitRow(page, 'itemize');
    await page.keyboard.press('Enter');
    assert.equal(await mpLine(page, FK.main, 4), '\\begin{itemize}',
      'exactly one } — the skeleton emitted it and consumed the auto-paired one');
    assert.equal(await mpLine(page, FK.main, 5), '  ',
      'the snippet \\t body line normalized to the contractual two-space indent (A18)');
    assert.equal(await mpLine(page, FK.main, 6), '\\end{itemize}', 'the matching \\end landed');
    const pos = await page.evaluate(() => window.__mp.getPosition());
    assert.deepEqual(pos, { line: 5, col: 3 }, 'caret at $0 on the indented body line');
  } finally {
    await context.close();
  }
});

/* ═══ C — A8: absent-from-first-eight becomes reachable by typing more ═══ */

test('A8 proven: a target absent from the first eight surfaces via the incomplete re-query as the prefix grows', opts, async () => {
  const { context, page } = await mkPage();
  try {
    const pool = [...Array.from({ length: 10 }, (_, i) => `common0${i}`), 'commonXtarget'];
    const hits = await routeTexmeta(page, { alpha: mkMeta(pool) });
    await waitEditor(page, FK.main);
    await stageCaret(page, 4, 1);
    await page.keyboard.type('\\cite{common', { delay: 25 });
    await waitRow(page, 'common00');
    const first = await widgetRows(page);
    assert.equal(first.length, 8, 'max 8 items shown (the A8 truncation)');
    assert.ok(!first.some((r) => r.includes('commonXtarget')),
      'the target is NOT in the first eight (meta order truncates it away)');
    // typing one more char can only surface the target through a REAL
    // re-query: the widget's 8 client-filterable items do not contain it
    await page.keyboard.type('X');
    await waitRow(page, 'commonXtarget');
    const second = await widgetRows(page);
    assert.deepEqual(second.length, 1, 'the re-queried list narrowed to the target');
    await page.keyboard.press('Enter');
    assert.equal(await mpLine(page, FK.main, 4), '\\cite{commonXtarget}');
    assert.equal(hits.alpha, 1, 'the re-query hit the 5s per-project cache — no second GET');
  } finally {
    await context.close();
  }
});

/* ═══ D — closeBrace consume/hop overtype parity, BOTH impls (dedicated case) ═══ */

testMonaco('closeBrace overtype parity: \\ref accept inside the auto-paired } lands text AND caret identically', {
  ui: () => ui,
}, async ({ impl, page }) => {
  await routeTexmeta(page, { alpha: META });
  const EXPECT = '\\ref{eq:euler}';
  if (impl === 'monaco') {
    await waitEditor(page, FK.main);
    await stageCaret(page, 4, 1);
    await page.keyboard.type('\\ref{eq:eu', { delay: 25 });
    await waitRow(page, 'eq:euler');
    await page.keyboard.press('Enter');
    assert.equal(await mpLine(page, FK.main, 4), EXPECT);
    const pos = await page.evaluate(() => window.__mp.getPosition());
    assert.deepEqual(pos, { line: 4, col: EXPECT.length + 1 },
      'monaco: the emitted } replaced the auto-paired one, caret AFTER it (consume)');
  } else {
    await page.waitForSelector('#v-alpha textarea#codeEditor', { timeout: 15000 });
    // stage the caret at the start of (empty) line 4 — the legacy analog of
    // setPosition(4,1)
    await page.evaluate(() => {
      const ed = document.querySelector('#v-alpha textarea#codeEditor');
      const off = ed.value.split('\n').slice(0, 3).reduce((a, s) => a + s.length + 1, 0);
      ed.focus();
      ed.setSelectionRange(off, off);
    });
    await page.keyboard.type('\\ref{eq:eu', { delay: 25 });
    await page.waitForFunction(() => {
      const it = document.querySelectorAll('#v-alpha .texCompl .tcItem');
      return [...it].some((el) => el.textContent.includes('eq:euler'));
    }, { timeout: 20000, polling: 60 });
    await page.keyboard.press('Enter');
    const got = await page.evaluate(() => {
      const ed = document.querySelector('#v-alpha textarea#codeEditor');
      const lines = ed.value.split('\n');
      const off = lines.slice(0, 3).reduce((a, s) => a + s.length + 1, 0);
      return { line: lines[3], col: ed.selectionStart - off + 1 };
    });
    assert.equal(got.line, EXPECT);
    assert.equal(got.col, EXPECT.length + 1,
      'legacy: closeBrace suppressed the append and the accept hopped past the closer');
  }
});

/* ═══ E — the four async-discipline cases (held /api/texmeta routes) ═══
   Each drives providerComplete (the sanctioned seam — the promise must be
   observable to assert the bail shape) against a held route; the CDP-typing
   duty for this slice is discharged by sections A–D above. */

test('async: edit-during-request — the in-flight query bails empty once the model version moves', opts, async () => {
  const { context, page, errors } = await mkPage();
  try {
    const g = deferred();
    const gates = { alpha: g };
    const hits = await routeTexmeta(page, { alpha: META }, gates);
    await waitEditor(page, FK.main);
    await clickTab(page, 1, FK.async);
    await page.evaluate((fk) => { window.__pc = window.__mp.providerComplete(1, 7, fk); return null; }, FK.async);
    await until(() => hits.alpha === 1);
    // the edit lands while the texmeta GET is held open
    await page.evaluate((fk) => window.__mp.pushEdit('x', {
      startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1,
    }, fk), FK.async);
    gates.alpha = null; // later fetches flow freely …
    g.resolve(); //        … and the held response lands NOW, after the edit
    const r = await page.evaluate(() => window.__pc);
    assert.deepEqual(r, { suggestions: [], incomplete: false },
      'post-await bail: a moved getVersionId returns the empty non-incomplete list (A20)');
    // the bailed query's response still seeded the per-project cache (same
    // key, same generation — only the LIST died with its revision)
    const r2 = await page.evaluate((fk) => window.__mp.providerComplete(1, 7, fk), FK.async);
    assert.deepEqual(r2.suggestions.map((s) => s.label).sort(),
      ['doe2019numerical', 'rivera2024heterogeneous'], 'a fresh query answers from the cache');
    assert.equal(hits.alpha, 1, 'no second GET was needed');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

test('async: reboot-during-request — the dead-generation response is discarded; the next boot re-registers once', opts, async () => {
  const { context, page, errors } = await mkPage();
  try {
    const g = deferred();
    const gates = { alpha: g };
    const spec = { alpha: mkMeta(['stalepoisonkey2026']) }; // the DEAD generation's payload
    const hits = await routeTexmeta(page, spec, gates);
    await waitEditor(page, FK.main);
    await clickTab(page, 1, FK.async);
    await page.evaluate((fk) => { window.__pc = window.__mp.providerComplete(1, 7, fk); return null; }, FK.async);
    await until(() => hits.alpha === 1);
    await page.evaluate(() => window.__mp.reboot()); // models disposed, generation bumped
    assert.deepEqual(await page.evaluate(() => window.__mp.providerInfo()),
      { registered: 0, live: false }, 'reboot disposed the registration with its generation (N3)');
    gates.alpha = null;
    g.resolve(); // the poisoned response lands on the DEAD generation
    const r = await page.evaluate(() => window.__pc);
    assert.deepEqual(r, { suggestions: [], incomplete: false },
      'disposed-model bail — isDisposed checked before getVersionId, no throw');
    // fresh generation: the tab clicks re-render → attachDock → a new boot
    spec.alpha = META;
    await clickTab(page, 0, FK.main);
    await clickTab(page, 1, FK.async);
    // S2.5 grew the per-generation set to TWO handles: the completion
    // provider + the P12 DocumentSymbolProvider (same providerDisposables
    // rail, same per-generation disposal). The no-stacking proof is the
    // count staying AT the per-generation size after a reboot cycle.
    assert.deepEqual(await page.evaluate(() => window.__mp.providerInfo()),
      { registered: 2, live: true }, 'the new generation registered its set exactly once — no stacking');
    const r2 = await page.evaluate((fk) => window.__mp.providerComplete(1, 7, fk), FK.async);
    const labels = r2.suggestions.map((s) => s.label);
    assert.ok(!labels.includes('stalepoisonkey2026'),
      'the dead-generation payload never reached a live list or cache');
    assert.deepEqual(labels.sort(), ['doe2019numerical', 'rivera2024heterogeneous']);
    assert.equal(hits.alpha, 2, 'the new generation fetched fresh meta for itself');
    assert.deepEqual(errors, [], 'no pageerror across a reboot with a response in flight');
  } finally {
    await context.close();
  }
});

/** The single seeded beta task auto-selects on view entry; belt: click its
 *  task tab if the workbench is not up yet. */
async function betaWorkbench(page) {
  try {
    await waitEditor(page, FK.beta, 'beta', 6000);
  } catch {
    await page.evaluate(() => {
      const el = document.querySelector('#v-beta .ptab.tk[data-id]');
      if (el) el.click();
    });
    await waitEditor(page, FK.beta, 'beta');
  }
}

test('async: switch-project-during-request — entry-keyed caching, no cross-project bleed', opts, async () => {
  const { context, page, errors } = await mkPage();
  try {
    const g = deferred();
    const gates = { alpha: g };
    const hits = await routeTexmeta(page, {
      alpha: mkMeta(['alphaonlykey2026']),
      beta: mkMeta(['betaonlykey2026']),
    }, gates);
    await waitEditor(page, FK.main);
    await clickTab(page, 1, FK.async);
    await page.evaluate((fk) => { window.__pc = window.__mp.providerComplete(1, 7, fk); return null; }, FK.async);
    await until(() => hits.alpha === 1);
    // the project switches while alpha's GET is held open
    await page.evaluate(() => document.querySelector('#navProjects .tab[data-v="beta"]').click());
    await betaWorkbench(page);
    const rB = await page.evaluate((fk) => window.__mp.providerComplete(1, 7, fk), FK.beta);
    assert.deepEqual(rB.suggestions.map((s) => s.label), ['betaonlykey2026'],
      "beta's query fetched beta's meta — the held alpha flight never bled in");
    gates.alpha = null;
    g.resolve(); // alpha's slow response lands AFTER the switch
    const rA = await page.evaluate(() => window.__pc);
    assert.deepEqual(rA.suggestions.map((s) => s.label), ['alphaonlykey2026'],
      'the late response answers ITS OWN still-valid query truthfully (entry-keyed, never re-keyed)');
    assert.equal(hits.beta, 1, "beta fetched once, for beta's own query");
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

test('async: out-of-order resolution — the slow old response never overwrites the newer cache or list', opts, async () => {
  const { context, page, errors } = await mkPage();
  try {
    const g = deferred();
    const gates = { alpha: g };
    const hits = await routeTexmeta(page, {
      alpha: mkMeta(['slowalphakey2026']),
      beta: mkMeta(['betaonlykey2026']),
    }, gates);
    await waitEditor(page, FK.main);
    await clickTab(page, 1, FK.async);
    await page.evaluate((fk) => { window.__pc = window.__mp.providerComplete(1, 7, fk); return null; }, FK.async);
    await until(() => hits.alpha === 1);
    await page.evaluate(() => document.querySelector('#navProjects .tab[data-v="beta"]').click());
    await betaWorkbench(page);
    // the NEWER (beta) response resolves first …
    const rB = await page.evaluate((fk) => window.__mp.providerComplete(1, 7, fk), FK.beta);
    assert.deepEqual(rB.suggestions.map((s) => s.label), ['betaonlykey2026']);
    // … then the OLD (alpha) response lands late
    gates.alpha = null;
    g.resolve();
    await page.evaluate(() => window.__pc); // settled — the late write is done
    const rB2 = await page.evaluate((fk) => window.__mp.providerComplete(1, 7, fk), FK.beta);
    assert.deepEqual(rB2.suggestions.map((s) => s.label), ['betaonlykey2026'],
      "the newer key's cache/list survives the out-of-order landing");
    assert.ok(!rB2.suggestions.some((s) => s.label.includes('slowalphakey')), 'no cross-key overwrite');
    assert.equal(hits.alpha, 1, 'single flight: the slow alpha GET was never re-issued');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ F — exclusions: the .bib rule and the legacy-untouched control ═══ */

test("the .bib exclusion: no completion provider on 'bibtex' — trigger chars open nothing", opts, async () => {
  const { context, page } = await mkPage();
  try {
    await routeTexmeta(page, { alpha: META });
    await waitEditor(page, FK.main);
    await clickTab(page, 2, FK.bib);
    assert.equal(await page.evaluate((fk) => window.__mp.language(fk), FK.bib), 'bibtex');
    await stageCaret(page, 1, 18); // end of '@article{knuth84,'
    await page.keyboard.type('\\cite{do', { delay: 25 });
    await sleep(700);
    assert.equal(await widgetVisible(page), false,
      'a .bib buffer gets no widget — the same keystrokes open one under latex (section A)');
  } finally {
    await context.close();
  }
});
