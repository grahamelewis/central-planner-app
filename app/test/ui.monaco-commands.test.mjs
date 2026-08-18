// test/ui.monaco-commands.test.mjs — Phase 3 S2.5: the P11/P19 Enter/Tab
// commands + ⌘/ + the P20 md-preview ping under the monaco impl (monaco-s2 §1
// S2.5; the §6 S2.0 spike verdict is BINDING law here). Covers, against the
// real vendored 0.56 dist and with GENUINE CDP keystrokes throughout:
//   - auto-\end (P11): Enter after an unclosed \begin{env} inserts the
//     skeleton with legacy caret parity, atomic under ONE ⌘Z (undo-stop-
//     wrapped executeEdits, spike Q2); a CLOSED env falls through cleanly —
//     the full-buffer needsEnd spec correction (the spike's fullNE case);
//   - suggest-widget precedence (spike Q4): with the widget open, Enter and
//     Tab go to the WIDGET — the guarded commands never fire
//     (!suggestWidgetVisible in BOTH contexts, the binding conjunct);
//   - A18 (spike Q5): 2 cursors → the handlers fall through byte-identically
//     to native (plain newlines, NO skeleton even with needsEnd true);
//   - julia Tab (P19, spike Q3): \beta⇥ → β in a .jl model; a miss falls
//     through to a NATIVE tab (trigger 'tab' — tab-stop spaces); .tex Tab
//     stays pure (the context never fires — zero census entries); widget-open
//     Tab in the MATCHING julia context goes to the widget (stub provider —
//     the q4 steal case);
//   - ⌘/ (P12): native commentLine over the S0 comments config — whole-line
//     % toggle, selection preserved;
//   - P20: the md-preview ping rides onIdleEdit (verify-only, one assert);
//   - reboot (the §6 dist quirk): rules are page-global and survive
//     dispose — after rebootMonaco the newest generation's re-registration
//     SHADOWS the zombies (generation fire census, __mp.commandInfo);
//   - a legacy control: zero command fires; the legacy textarea keeps its
//     own auto-\end byte-identically.
//
// Billing-safe: armPage intercepts the billed routes on every context; this
// file touches GET routes and one unbilled POST /api/tasks only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUI, armPage, sleep, CHROME } from './uiHarness.mjs';
import { latexConfiguration, bibtexConfiguration } from '../public/latex/texLang.js';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FK = {
  env: 'alpha::env.tex',   // 0 — the Enter/⌘/ subject
  jl: 'alpha::calc.jl',    // 1 — the julia Tab subject
  md: 'alpha::notes.md',   // 2 — the P20 ping subject
};

// line 2 \begin{itemize} is UNCLOSED over the full buffer (the skeleton
// case); lines 4/5 are a BALANCED pair (the fullNE fall-through case)
const ENV_TEX = [
  '% commands playground',
  '\\begin{itemize}',
  '',
  '\\begin{center}',
  '\\end{center}',
  'text line six',
  '',
].join('\n');

const CALC_JL = 'x = 1\n\n';
const NOTES_MD = '# notes\n\nbody text\n';

let ui, sb;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    monacoProxy: true,
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'env.tex'), ENV_TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'calc.jl'), CALC_JL);
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.md'), NOTES_MD);
    },
  });
  ({ sb } = ui);
  await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco commands', category: 'calibration', oversight: 'manual',
    context: { files: ['env.tex', 'calc.jl', 'notes.md'] },
  });
});
after(async () => { if (ui) await ui.stop(); });

/* ── helpers ─────────────────────────────────────────────────────────── */

async function cmdPage(impl = 'monaco') {
  sb.vendor.clear();
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript((impl2) => { localStorage.setItem('editor:impl', impl2); }, impl);
  await page.goto(`${sb.vendor.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

const clickTab = async (page, fi, fkey) => {
  await page.click(`.ctab.cd[data-fi="${fi}"]`);
  if (fkey) await waitEditor(page, fkey);
};

/** Focus the kept editor and park the caret (staging only — keystrokes are CDP). */
const stageCaret = (page, line, col) => page.evaluate(([l, c]) => {
  window.__mp.focus();
  window.__mp.setPosition(l, c);
}, [line, col]);

const mpText = (page, fkey) => page.evaluate((fk) => window.__mp.text(fk), fkey);
const mpLine = (page, fkey, ln) => page.evaluate(([fk, n]) => window.__mp.text(fk).split('\n')[n - 1], [fkey, ln]);
const firesOf = (page, cmd) => page.evaluate((c) => (
  window.__mp.commandInfo().fires.filter((f) => f.cmd === c).length
), cmd);
const widgetVisible = (page) => page.evaluate(() => !!document.querySelector('.suggest-widget.visible'));
const waitRow = (page, needle, timeout = 20000) => page.waitForFunction((s) => {
  const el = document.querySelector('.suggest-widget.visible');
  if (!el) return false;
  return [...el.querySelectorAll('.monaco-list-row')]
    .some((r) => ((r.getAttribute('aria-label') || r.textContent) || '').includes(s));
}, needle, { timeout, polling: 60 });

/* ═══ node-side: the binding context strings + the S0 comments config ═══ */

test('S2.5 fossil guard: the spike-verdict context strings appear VERBATIM; the S0 comments config carries %', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'public', 'monacoPane.js'), 'utf8');
  // the §6 verdict strings, binding — !suggestWidgetVisible REQUIRED on both
  assert.ok(src.includes("'textInputFocus && !suggestWidgetVisible'"),
    'Enter context is the verdict string verbatim');
  assert.ok(src.includes('"editorLangId == \'julia\' && !suggestWidgetVisible"'),
    'Tab context is the verdict string verbatim (julia-gated + widget-guarded)');
  // the REJECTED fallthrough alternatives must not creep in (spike Q3)
  assert.ok(!/trigger\('keyboard',\s*'type',\s*\{\s*text:\s*'\\t'/.test(src),
    "type-'\\t' is a rejected Tab fallthrough (inserts literal tab, destroys selections)");
  assert.ok(!src.includes('editor.action.indentLines'),
    'indentLines is a rejected Tab fallthrough (indents line start, not caret)');
  assert.ok(!/\.revealPositionNearTop\(|\.revealLineNearTop\(/.test(src),
    'P8 mandates the EXPLICIT setScrollTop reveal — never a NearTop reveal call');
  // the P12 comments config (texLang unit assert — ⌘/ rides it natively)
  assert.deepEqual(latexConfiguration.comments, { lineComment: '%' }, 'latex line comment is %');
  assert.deepEqual(bibtexConfiguration.comments, { lineComment: '%' }, 'bibtex line comment is %');
});

/* ═══ A — auto-\end: skeleton + atomic ⌘Z; closed env falls through ═══ */

test('Enter after an unclosed \\begin inserts the skeleton (single ⌘Z atomic); a closed env falls through (fullNE)', opts, async () => {
  const { context, page, errors } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    // skeleton: caret at the end of the unclosed \begin{itemize} line
    await stageCaret(page, 2, '\\begin{itemize}'.length + 1);
    await page.keyboard.press('Enter');
    const lines = ENV_TEX.split('\n');
    const wantSkeleton = [
      lines[0], '\\begin{itemize}', '  ', '\\end{itemize}', ...lines.slice(2),
    ].join('\n');
    assert.equal(await mpText(page, FK.env), wantSkeleton,
      'the skeleton landed: body line indented two spaces, matching \\end below');
    assert.deepEqual(await page.evaluate(() => window.__mp.getPosition()), { line: 3, col: 3 },
      'caret on the indented body line (legacy parity: indent + 2, 1-based)');
    assert.equal(await firesOf(page, 'enter'), 1, 'the guarded Enter command fired once');

    // atomic: ONE ⌘Z restores the exact pre-Enter buffer; a second is a no-op
    await page.keyboard.press(`${MOD}+z`);
    await sleep(150);
    assert.equal(await mpText(page, FK.env), ENV_TEX, 'one ⌘Z restored the byte-exact buffer (spike Q2)');
    assert.equal(await page.evaluate((fk) => window.__mp.isDirty(fk), FK.env), false,
      'clean again — the whole skeleton was ONE undo stop');
    await page.keyboard.press(`${MOD}+z`);
    await sleep(150);
    assert.equal(await mpText(page, FK.env), ENV_TEX, 'the second ⌘Z is a no-op');

    // fullNE: \begin{center} is CLOSED over the full buffer — needsEnd false,
    // clean fall-through to a plain newline (the up-to-caret form would
    // re-insert here — the binding §6 Q2 spec correction)
    await stageCaret(page, 4, '\\begin{center}'.length + 1);
    await page.keyboard.press('Enter');
    const t = await mpText(page, FK.env);
    assert.equal((t.match(/\\end\{center\}/g) || []).length, 1, 'NO second \\end{center} (full-buffer needsEnd)');
    assert.equal(t.split('\n')[4], '', 'a plain newline landed instead');
    assert.equal(t.split('\n')[5], '\\end{center}', 'the balanced pair rides one line down, untouched');
    assert.equal(await firesOf(page, 'enter'), 2, 'both Enters fired the command (⌘Z never does) — the closed case fell through INSIDE it');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ B — spike Q4: the open suggest widget owns Enter AND Tab ═══ */

test('widget-open Enter and Tab go to the WIDGET — the guarded commands never fire (the !suggestWidgetVisible conjunct)', opts, async () => {
  const { context, page } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    // Enter accept — the completion provider is live (S2.2), COMMON_ENVS
    // needs no texmeta payload
    await stageCaret(page, 7, 1);
    await page.keyboard.type('\\begin{ite', { delay: 25 });
    await waitRow(page, 'itemize');
    const enter0 = await firesOf(page, 'enter');
    await page.keyboard.press('Enter');
    await sleep(200);
    assert.equal(await mpLine(page, FK.env, 7), '\\begin{itemize}',
      'the widget accepted the env snippet — Enter reached the WIDGET');
    assert.equal(await firesOf(page, 'enter'), enter0, 'the guarded Enter command did NOT fire (spike Q4)');
    assert.equal(await widgetVisible(page), false, 'accept closed the widget');

    // Tab accept on a fresh trigger — latex Tab has no command at all
    // (julia-gated context), so this doubles as the .tex-Tab-pure control.
    // Leave the snippet, open a fresh line under the accepted skeleton
    // (this Enter rides the command's plain fall-through — not asserted here)
    await page.keyboard.press('Escape');
    await stageCaret(page, 9, '\\end{itemize}'.length + 1);
    await page.keyboard.press('Enter');
    await page.keyboard.type('\\begin{cen', { delay: 25 });
    await waitRow(page, 'center');
    const tab0 = await firesOf(page, 'tab');
    await page.keyboard.press('Tab');
    await sleep(200);
    assert.equal(await mpLine(page, FK.env, 10), '\\begin{center}',
      'the widget accepted on Tab — nothing stole the key');
    assert.equal(await firesOf(page, 'tab'), tab0, 'zero Tab command fires in a latex model (P19 exclusion)');
  } finally {
    await context.close();
  }
});

/* ═══ C — A18 (spike Q5): multi-cursor falls through byte-identically ═══ */

test('A18: with 2 cursors Enter falls through — plain newlines at BOTH carets, NO skeleton despite needsEnd true', opts, async () => {
  const { context, page, errors } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    // cursors at the end of the UNCLOSED \begin{itemize} line and of line 6
    await page.evaluate(() => {
      window.__mp.focus();
      window.__mp.setSelections([
        { line: 2, col: '\\begin{itemize}'.length + 1 },
        { line: 6, col: 'text line six'.length + 1 },
      ]);
    });
    await page.keyboard.press('Enter');
    // the native multi-cursor outcome, computed: '\n' at both carets
    const lines = ENV_TEX.split('\n');
    const want = [
      lines[0], lines[1], '', lines[2], lines[3], lines[4], lines[5], '', lines[6],
    ].join('\n');
    assert.equal(await mpText(page, FK.env), want,
      'byte-identical native multi-cursor Enter (trigger-type fall-through, spike Q5)');
    assert.ok(!(await mpText(page, FK.env)).includes('\\end{itemize}'),
      'the sharp case: needsEnd true + 2 cursors → NO skeleton (A18)');
    assert.equal(await firesOf(page, 'enter'), 1, 'the command fired and fell through');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ D — P19 julia Tab: hit converts, miss indents natively, .tex stays pure ═══ */

test('julia Tab: \\beta⇥ → β; a miss falls through to a NATIVE tab; latex \\beta⇥ keeps \\beta (context-gated)', opts, async () => {
  const { context, page, errors } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    await clickTab(page, 1, FK.jl);
    assert.equal(await page.evaluate((fk) => window.__mp.language(fk), FK.jl), 'julia',
      'the .jl model carries the julia language id (the context key input)');
    await stageCaret(page, 2, 1);
    await page.keyboard.type('\\beta');
    await page.keyboard.press('Tab');
    assert.equal(await mpLine(page, FK.jl, 2), 'β', '\\beta⇥ converted via texSymbolMatch (spike Q3)');
    assert.equal(await firesOf(page, 'tab'), 1, 'the julia Tab command fired');
    // miss #1: nothing to convert → native tab (tab-stop spaces at the caret)
    await page.keyboard.press('Tab');
    assert.match(await mpLine(page, FK.jl, 2), /^β +$/, 'native tab fall-through inserted tab-stop spaces');
    // miss #2: a \name with no glyph stays put, tab indents after it
    await page.keyboard.type('\\qqqq');
    await page.keyboard.press('Tab');
    assert.match(await mpLine(page, FK.jl, 2), /^β +\\qqqq +$/,
      'unknown \\name untouched — the miss fell through natively');
    assert.equal(await firesOf(page, 'tab'), 3, 'every julia Tab fired the command');

    // latex control: same keystrokes in the .tex model — the context never
    // fires, Tab is PURE indentation, \beta survives (P19 exclusion)
    await clickTab(page, 0, FK.env);
    await stageCaret(page, 7, 1);
    await page.keyboard.type('\\beta');
    await page.keyboard.press('Tab');
    const texLine = await mpLine(page, FK.env, 7);
    assert.match(texLine, /^\\beta[\t ]+$/, `.tex Tab indented, no conversion: ${JSON.stringify(texLine)}`);
    assert.ok(!texLine.includes('β'), '\\beta untouched in latex');
    assert.equal(await firesOf(page, 'tab'), 3, 'zero NEW tab fires in the latex model');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ D2 — spike Q4 in the MATCHING context: julia widget-open Tab ═══ */

test('widget-open Tab in a JULIA model goes to the WIDGET — the guard does real work where the context would otherwise match', opts, async () => {
  const { context, page, errors } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    await clickTab(page, 1, FK.jl);
    // Production julia ships NO completion provider (P10 is latex-only), so
    // the widget needs a page-registered stub to open at all — the spike Q4
    // recipe (window.monaco staging, the ui.monaco-m7 precedent). This is the
    // one context where an UNGUARDED Tab rule provably steals the key
    // (q4.suggest-tab-unguarded); test B's latex leg never matches the
    // julia-gated context, guard or no guard.
    await page.evaluate(() => {
      window.monaco.languages.registerCompletionItemProvider('julia', {
        provideCompletionItems: (model, position) => {
          const wd = model.getWordUntilPosition(position);
          return {
            suggestions: [{
              label: 'betamax',
              kind: window.monaco.languages.CompletionItemKind.Text,
              insertText: 'betamax_accepted',
              range: new window.monaco.Range(
                position.lineNumber, wd.startColumn, position.lineNumber, wd.endColumn,
              ),
            }],
          };
        },
      });
    });
    await stageCaret(page, 2, 1);
    await page.keyboard.type('beta', { delay: 20 });
    assert.equal(await widgetVisible(page), false,
      'quickSuggestions stays off — typing alone opens nothing (the no-word-noise gate)');
    await page.keyboard.press('Control+Space'); // native triggerSuggest keybinding
    await waitRow(page, 'betamax');
    const tab0 = await firesOf(page, 'tab');
    await page.keyboard.press('Tab');
    await sleep(200);
    assert.equal(await mpLine(page, FK.jl, 2), 'betamax_accepted',
      'Tab reached the WIDGET (accept) — the julia Tab command did not steal the key (spike Q4)');
    assert.equal(await firesOf(page, 'tab'), tab0,
      'zero tab command fires while the widget was open — the !suggestWidgetVisible conjunct did the work');
    assert.equal(await widgetVisible(page), false, 'accept closed the widget');
    assert.deepEqual(errors, [], 'no pageerror');
  } finally {
    await context.close();
  }
});

/* ═══ E — P12 ⌘/: native commentLine over the S0 config, selection preserved ═══ */

test('⌘/ toggles whole-line % comments and preserves the selection (native commentLine, comments config)', opts, async () => {
  const { context, page } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    const before = await mpText(page, FK.env);
    await page.evaluate(() => {
      window.__mp.focus();
      window.__mp.setSelections([{ line: 4, col: 1, line2: 6, col2: 5 }]);
    });
    await page.keyboard.press(`${MOD}+/`);
    const on = (await mpText(page, FK.env)).split('\n');
    assert.match(on[3], /^% \\begin\{center\}/, 'line 4 commented');
    assert.match(on[4], /^% \\end\{center\}/, 'line 5 commented');
    assert.match(on[5], /^% text line six/, 'line 6 commented');
    const sel = (await page.evaluate(() => window.__mp.getSelections()))[0];
    assert.equal(sel.line, 4, 'selection start line preserved');
    assert.equal(sel.line2, 6, 'selection end line preserved');
    await page.keyboard.press(`${MOD}+/`);
    assert.equal(await mpText(page, FK.env), before, 'the second ⌘/ round-trips the buffer byte-exactly');
    const sel2 = (await page.evaluate(() => window.__mp.getSelections()))[0];
    assert.equal(`${sel2.line}-${sel2.line2}`, '4-6', 'selection still spans the same lines');
  } finally {
    await context.close();
  }
});

/* ═══ F — P20 verify-only: the md-preview ping rides onIdleEdit ═══ */

test('P20: typing in a .md model pings mdPreviewSchedule through signalOnce (no rebuild — verify only)', opts, async () => {
  const { context, page } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    await clickTab(page, 2, FK.md);
    const p0 = (await page.evaluate(() => window.__mp.signals())).preview;
    await stageCaret(page, 3, 1);
    await page.keyboard.type('x');
    await page.waitForFunction((n) => window.__mp.signals().preview > n, p0, { timeout: 5000 });
    // the one-line P20 assert: the idle edit emitted a preview ping (S1.2 rail)
    assert.ok((await page.evaluate(() => window.__mp.signals())).preview > p0, 'preview ping rode the idle edit');
  } finally {
    await context.close();
  }
});

/* ═══ G — the §6 dist quirk: reboot re-registration shadows the zombies ═══ */

test('reboot: a stale generation\'s command never fires again — the newest re-registration shadows the zombie rules', opts, async () => {
  const { context, page, errors } = await cmdPage();
  try {
    await waitEditor(page, FK.env);
    assert.equal(await page.evaluate(() => window.__mp.generation()), 0, 'generation 0 boots first');
    await stageCaret(page, 6, 3);
    await page.keyboard.press('Enter'); // gen-0 handler fires
    let fires = await page.evaluate(() => window.__mp.commandInfo().fires);
    assert.deepEqual(fires.filter((f) => f.cmd === 'enter'), [{ gen: 0, cmd: 'enter' }],
      'the generation-0 registration handled the first Enter');

    await page.evaluate(() => window.__mp.reboot()); // dispose — the dist keeps the old rules alive (quirk)
    await clickTab(page, 1); // re-render → attachDock → a fresh boot generation
    await clickTab(page, 0);
    await waitEditor(page, FK.env);
    assert.equal(await page.evaluate(() => window.__mp.generation()), 1, 'generation 1 rebooted');
    await stageCaret(page, 6, 3);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab'); // latex: the julia context still fires nothing, any generation
    fires = await page.evaluate(() => window.__mp.commandInfo().fires);
    assert.deepEqual(fires.filter((f) => f.cmd === 'enter'),
      [{ gen: 0, cmd: 'enter' }, { gen: 1, cmd: 'enter' }],
      'post-reboot Enter ran the NEWEST generation\'s handler — the gen-0 zombie never fired again');
    assert.deepEqual(fires.filter((f) => f.cmd === 'tab'), [],
      'the julia-gated Tab rule stayed silent in latex across generations');
    assert.deepEqual(errors, [], 'no pageerror across the reboot');
  } finally {
    await context.close();
  }
});

/* ═══ H — legacy control: zero command machinery; legacy auto-\end untouched ═══ */

test('legacy control: the textarea keeps its own auto-\\end and ⌘/; no monaco command ever fires', opts, async () => {
  const { context, page } = await cmdPage('legacy');
  try {
    await page.waitForSelector('#v-alpha textarea#codeEditor[data-ext="tex"]', { timeout: 15000 });
    await page.click('#v-alpha textarea#codeEditor');
    await page.evaluate(() => {
      const ed = document.querySelector('#v-alpha textarea#codeEditor');
      const pos = ed.value.indexOf('\\begin{itemize}') + '\\begin{itemize}'.length;
      ed.setSelectionRange(pos, pos);
    });
    await page.keyboard.press('Enter');
    const val = await page.evaluate(() => document.querySelector('#v-alpha textarea#codeEditor').value);
    assert.ok(val.includes('\\end{itemize}'), 'the LEGACY auto-\\end still runs (texEditorAttach, byte-identical path)');
    const st = await page.evaluate(() => ({
      boot: window.__mp.state(),
      fires: window.__mp.commandInfo().fires.length,
      monacoDom: !!document.querySelector('.monaco-editor'),
    }));
    assert.equal(st.boot, 'IDLE', 'no boot under legacy');
    assert.equal(st.fires, 0, 'no S2.5 command ever fired');
    assert.equal(st.monacoDom, false, 'no monaco DOM');
    assert.equal(sb.vendor.hits.length, 0, 'zero /vendor/monaco fetches');
  } finally {
    await context.close();
  }
});
