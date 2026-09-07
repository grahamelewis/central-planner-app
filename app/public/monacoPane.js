// Monaco is the only editable source surface. Drafts remain authoritative
// outside the editor; the kept host preserves focus, undo, and composition.
// Boot failure shows a recoverable pane, never a second editing engine.

/* eslint-disable no-console */

import { drafts, draftBase, diskStale, fileCache, artifactUrl, curTask, ui, themeHooks } from './store.js';
import { editorChrome, fetchFileInto } from './files.js';
// the S0 latex brain — pure data + pure functions, zero app/monaco imports of
// their own, so these two are cycle-free (unlike the app-module imports above)
import {
  latexLanguageId, bibtexLanguageId, langForTexExt,
  latexMonarch, bibtexMonarch, latexConfiguration, bibtexConfiguration,
} from './latex/texLang.js';
import { scanLineZones, TEX_ZONE_INITIAL } from './latex/texZones.js';
import {
  createLatexCompletionProvider, createLatexSymbolProvider, markersForProblems,
} from './latex/texProviders.js';
import { createTexfixAnchors } from './latex/texfixAnchors.js';
import { needsEnd, texSymbolMatch } from './latex/texCore.js';
import { mdPreviewSchedule, mdPreviewCancel } from './viewers.js';
import {
  runFile, isRunnable, texForwardSearch, texProblemsFor, openSugs, resolveSug, sugStaleAt, sugPulsed, sugRedraw,
} from './texrun.js';
import { renderWB } from './workbench.js';
import { toast, esc, enc, isExtRel, confirmBox } from './util.js';

// window carries the AMD loader globals (require/define — RETAINED for the
// page lifetime per amended I8), window.monaco, and the __mp test seams; cast
// once rather than sprinkling ambient declarations.
const w = /** @type {any} */ (window);

const VS_BASE = '/vendor/monaco/vs';
// Retired browser preferences cannot select a removed implementation.
try { localStorage.removeItem('editor:impl'); } catch { /* private mode */ }

/* ─────────────────────────── boot state machine (A6) ───────────────────────────
   ensureMonaco() creates bootPromise SYNCHRONOUSLY on first call (single-flight:
   the idle-warm/first-open race gets the same promise) and arms ONE deadline
   timer spanning LOADER → CSS_VERIFY. Every edge below keys on a detector the
   A6 spike proved empirically; the promise ALWAYS SETTLES — resolve({ok:false})
   after fallback, never reject. Never gate anything on window 'load': the
   core-hang case emits zero events and blocks window load indefinitely. */

let bootPromise = null;      // created synchronously, single-flight
let resolveBoot = null;
let bootState = 'IDLE'; // IDLE → LOADER → CORE → INIT → CSS_VERIFY → READY | FAILED
let bootStarts = 0;          // how many boot sequences ever began (single-flight proof)
let bootGen = 0;             // bumped by rebootMonaco() — the "try Monaco again" affordance
let bootT0 = 0;
const bootLog = [];          // milestones: {t, state, ...detail} (soak-log seed, A16)
let deadlineTimer = null;
let cssTimer = null;
let retried = false;         // one auto-retry, net-class loader/core failures only
const bootNodes = [];        // injected <script>/<link> nodes — removed on cleanup
let lastWindowError = '';    // SyntaxError text for the loader-corrupt diagnostic
let cssErrorSeen = false;    // capturing listener saw the editor.main.css link fail

// post-READY degradation (never triggers fallback)
let workerDegraded = false;
const langDegradedSet = new Set();

let editor = null;           // the singleton kept editor instance
let host = null;             // #codeEditor.mpHost — the kept node Monaco owns (A7)
let park = null;             // #mpPark — offscreen holding container on <body>
let bootFailure = null; // safe stage label for the recoverable error pane
let lastAttach = null;       // { root, key } of the most recent dock attach

/* ─────────────── model machine state (M1/M2/M7, S1.2) ───────────────
   One ITextModel per fkey, ever — the cp: URI registry is the single
   authority. savedAltId is only ever (a) the alternative version id of text
   that was fileCache disk bytes with a finite mtimeMs at capture time, or
   (b) DIRTY_SENTINEL (M1 invariant). All maps are in-memory only. */

const DIRTY_SENTINEL = 'DIRTY_SENTINEL'; // no real altId (a positive int) can equal it
const models = new Map();         // fkey → ITextModel
const savedAltId = new Map();     // fkey → number | DIRTY_SENTINEL
const eolProfiles = new Map();    // fkey → {lf,crlf,cr,bom,finalNewline,pure,eol} (P-EOL-2)
const baselineRaw = new Map();    // fkey → RAW disk text-of-record — set in the SAME txn as
//   every savedAltId capture from disk bytes (never from any other source).
//   Monaco destroys mixed EOLs irreversibly at createModel (A19), so
//   serialize(model) can NEVER equal a non-pure disk text; the reattach
//   reconciliation therefore detects "disk unchanged" raw-to-raw against this
//   record (M7 T2 steady-state no-op) instead of serialize-to-raw.
const viewStates = new Map();     // fkey → ICodeEditorViewState (saveViewState on detach)
const modelListeners = new Map(); // fkey → IDisposable (the generic drafts listener)
const txnOpen = new Map();        // fkey → reason — the per-fkey origin flag (M2)
const suppressedSeen = new Set(); // canary bookkeeping: txn writes whose sync event was observed
let activeFkey = null;            // the fkey currently attached to the kept editor
let pendingFile = null;           // latest setFile args — applied when boot is READY
let editHeld = false;             // C2-MF5/P17 editHold — readOnly pinned for the hold lifetime
let heldHadFocus = false;         // editHold hand-back memory: had text focus at raise?
let inComposition = false;        // A7 belt — from editor.onDidCompositionStart/End
let compositionEnds = 0;          // test surface for the I2-IME case
let chromeSignals = 0;            // count of editorChrome emissions (spy surface)
let previewSignals = 0;           // count of mdPreviewSchedule emissions
let txnSyncVerified = 0;          // synchronicity-canary passes (M2 test surface)
const dirtyCbs = [];              // onDirtyChange(cb) — P1's push-style seam

/* ─────────────── M7 lifecycle state (A10/A4, s05 §M7 — full-M7 task) ───────────────
   LRU-50 is a soft cap on CLEAN, DETACHED models ONLY — dirty models are
   NEVER candidates (A10 verbatim; M7 invariant 1). Recency is a monotonic
   tick bumped on create/attach; eviction walks oldest-first through the
   reallyDispose disposal matrix. fileCache survives eviction (fetch-layer
   property); undo-history loss on clean eviction is documented behavior,
   same as today (T3). The orphan set records fkeys whose tab was × closed
   while a model existed (T4) — observability only: LRU eligibility is
   COMPUTED (clean ∧ detached ∧ no machine mid-flight), never stored, so
   T5's "a commitSave 200 lands on an orphan → clean → LRU-eligible" needs
   no transition code at all. draftRev/modelSyncRev track newer
   shared drafts that must be reconciled into retained models. All maps are in-memory only (P22 parity). */
const LRU_CAP = 50;             // A10: the clean-detached soft cap
let lruTick = 0;                // monotonic recency clock
const lruSeq = new Map();       // fkey → tick at last create/attach (T1/T2 recency)
const orphans = new Set();      // fkeys view-closed with a live model (T4)
let lruEvictions = 0;           // soak counter (A10/A16)
const draftRev = new Map();     // fkey → monotonic revision of drafts[fkey] (A4)
const modelSyncRev = new Map(); // fkey → the draftRev the model last materialized/synced at

const projOf = (fkey) => fkey.slice(0, Math.max(0, fkey.indexOf('::')));
const relOfFkey = (fkey) => {
  const i = fkey.indexOf('::');
  return i < 0 ? fkey : fkey.slice(i + 2); // tolerates absolute extpin fkeys
};
// wrap policy (P15): per-filetype, not a pref — matches legacy softWrap
// (isTex && hlOn) exactly; TEX_EXTS mirrors texEditor.js (incl. bib)
const WRAP_EXTS = ['tex', 'sty', 'cls', 'bib'];

/* langFor — the closed whitelist (§2 AMD row): everything else is plaintext.
   The tex family routes through the S0 brain's own table (langForTexExt —
   the single source shared with the registered grammars, §6 "Routing"); the
   rest of the whitelist stays here. An unregistered id tokenizes as
   plaintext, which is safe. */
function langFor(ext) {
  const e = String(ext || '').toLowerCase();
  const tex = langForTexExt(e); // tex/sty/cls → latex, bib → bibtex (S0)
  if (tex) return tex;
  switch (e) {
    case 'jl': return 'julia';
    case 'py': return 'python';
    case 'r': return 'r';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'sql': return 'sql';
    case 'json': return 'json';
    case 'md': case 'rmd': case 'qmd': return 'markdown';
    // ── wave 1 (docs/language-support/RUNTIMES.md, editor row) ──
    // Every id below ships in monaco-editor 0.56 (basic-languages/
    // monaco.contribution.js; `c` is registered by the cpp chunk). Ids are
    // handed to createModel EXPLICITLY, so Monaco's own extension claims
    // (objective-c on .m, r on .rmd) never apply — this table is the source.
    // `ext` is basename(rel).split('.').pop().toLowerCase() (workbench), so a dotless
    // name arrives whole: Makefile → 'makefile', GNUmakefile → 'gnumakefile'.
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'typescript';
    case 'c': return 'c';                        // .C (C++) folds to 'c' here — same grammar family
    case 'h': case 'cc': case 'cpp': case 'cxx': case 'c++':
    case 'hpp': case 'hxx': case 'hh': return 'cpp'; // .h → cpp (RUNTIMES.md)
    case 'toml': return 'ini';                   // Cargo.toml: no toml grammar in Monaco; ini colours [tables], key = value, "strings", # comments
    case 'yaml': case 'yml': return 'yaml';
    // Makefile / *.mk: Monaco has no makefile grammar. `shell` is the nearest
    // fit — recipe lines ARE shell (commands, $VARS, "strings", # comments);
    // targets and := assignments stay plain, which is honest rather than wrong.
    case 'makefile': case 'gnumakefile': case 'mk': return 'shell';
    // labelled plaintext: go.mod / go.sum ('mod' / 'sum'), *.cmake, and
    // CMakeLists.txt ('txt' → the default) have no Monaco grammar — on purpose
    case 'mod': case 'sum': case 'cmake': return 'plaintext';
    default: return 'plaintext';
  }
}

/* P-EOL-2: the EOL profile is computed from the RAW text BEFORE createModel
   and kept for the model's lifetime. pure === one uniform EOL kind (or none)
   and no lone CR (Monaco cannot represent CR — the A19 spike measured lone-CR
   → CRLF normalization). Dominant EOL: majority wins, ties → LF (measured:
   3×LF vs 2×CRLF → LF); a pure-CR file normalizes to CRLF. */
function eolProfile(text) {
  let lf = 0, crlf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
    } else if (c === 10) lf++;
  }
  const bom = text.charCodeAt(0) === 0xFEFF;
  const finalNewline = text.length > 0 && /[\n\r]$/.test(text);
  const kinds = (lf ? 1 : 0) + (crlf ? 1 : 0) + (cr ? 1 : 0);
  const pure = kinds <= 1 && cr === 0;
  const eol = crlf > lf ? '\r\n' : lf > 0 ? '\n' : (crlf > 0 || cr > 0) ? '\r\n' : '\n';
  return { lf, crlf, cr, bom, finalNewline, pure, eol };
}

/* P-EOL-1: the ONLY serialization of a model anywhere in this module — bare
   getValue() silently drops a BOM and is forbidden on any path whose output
   can reach disk (drafts ARE the save path: files.saveFile PUTs drafts[k]). */
function serialize(m) {
  const pref = w.monaco?.editor?.EndOfLinePreference?.TextDefined ?? 0;
  return m.getValue(pref, /* preserveBOM */ true);
}

/* ═══════ S1.4 — grammar registration, theme bridge, mzone wash (§2/§6) ═══════ */

const initTrace = []; // INIT-order proof: ['langs', 'themes', 'create'] — the
//                       themes are defined BEFORE the first createEditor
//                       (§2 Theme row: no stock-vs-dark flash); __mp surface

/* §5 step 4 (as amended by the A5 design consequence — steps 3/5 DELETED):
   register the Monarch grammars + language configurations from the S0 brain.
   texLang.js is plain data with no monaco import of its own; registration is
   the ONLY place its objects meet monaco.*. Safe to re-run on a reboot
   generation (register() merges by id; the providers replace). Completion
   providers land in registerLatexProviders below (S2.2) — they need the
   per-generation disposal the Monarch setters don't. */
function registerTexLanguages(monaco) {
  monaco.languages.register({ id: latexLanguageId });
  monaco.languages.setMonarchTokensProvider(latexLanguageId, latexMonarch());
  monaco.languages.setLanguageConfiguration(latexLanguageId, latexConfiguration);
  monaco.languages.register({ id: bibtexLanguageId });
  monaco.languages.setMonarchTokensProvider(bibtexLanguageId, bibtexMonarch());
  monaco.languages.setLanguageConfiguration(bibtexLanguageId, bibtexConfiguration);
}

/* wave 1 (docs/language-support/RUNTIMES.md, editor row): Monaco's TS/JS
   language service resolves imports against files it can see — here that is
   the open models only, never node_modules or a tsconfig — so every bare
   import (`import x from 'nope'`) would squiggle "Cannot find module" and
   every DOM/node global would be "not defined". Semantic validation is muted
   for both services; syntax validation (real typos) stays. The `typescript`
   namespace ships in editor.main (the worker itself loads lazily), so this
   runs at INIT; a missing namespace (a trimmed build) is a no-op. */
function muteTsSemantics(monaco) {
  try {
    const ts = monaco.languages && monaco.languages.typescript;
    if (!ts) return;
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      if (d && typeof d.setDiagnosticsOptions === 'function') {
        d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      }
    }
  } catch (e) {
    console.warn('[monaco] could not mute TS semantic diagnostics', e);
  }
}

/* ═══════ S2.2 — latex completion provider registration (P10, monaco-s2 §1) ═══════ */

let completionProvider = null;  // the live factory instance — __mp.providerComplete drives it
const providerDisposables = []; // registration handles, disposed per boot generation (risk N3)

/* S2.2 (P10): the S0 completion factory registered for 'latex' ONLY, at boot
   INIT next to registerTexLanguages — 'bibtex' gets NO completion provider
   (the factory's own header rule: the .bib exclusions for free).
   registerCompletionItemProvider APPENDS (unlike the Monarch setters, which
   replace), so the handle joins providerDisposables and dies in
   cleanupPartialBoot with its boot generation — no double registration
   across rebootMonaco (risk N3, A20 disposal discipline).
     requestMeta plumbing (review concern 3): the project is resolved from
   the ACTIVE model's fkey at call time (the legacy source route —
   GET /api/texmeta/:project, unbilled), the factory's 5s cache is keyed per
   project via metaKey (risk N1: no ≤5s cross-project wrong-list bleed), and
   the closure carries its boot generation: a response landing after
   rebootMonaco is thrown away HERE, because disposing the registration
   cannot cancel an already-returned promise — the throw rides the factory's
   degrade path and never caches. */
function registerLatexProviders(monaco) {
  disposeLatexProviders(); // belt: one live registration set per generation
  const gen = bootGen;
  completionProvider = createLatexCompletionProvider(monaco, {
    metaKey: () => (activeFkey ? projOf(activeFkey) : ''),
    requestMeta: async () => {
      const proj = activeFkey ? projOf(activeFkey) : '';
      if (!proj) throw new Error('texmeta: no active project'); // factory degrades to empty
      const res = await fetch(`/api/texmeta/${enc(proj)}`); // GET only — unbilled
      if (!res.ok) throw new Error(`texmeta ${res.status}`);
      const meta = await res.json();
      if (gen !== bootGen) throw new Error('texmeta: stale boot generation (discarded, N3)');
      return meta;
    },
  });
  providerDisposables.push(
    monaco.languages.registerCompletionItemProvider(latexLanguageId, completionProvider),
    // S2.5 (P12): the DocumentSymbolProvider — ⇧⌘O arrives free, fed by the
    // SAME texOutline as the § dropdown so the two can never disagree. The
    // handle rides providerDisposables and dies with its boot generation,
    // exactly like the completion registration above (N3).
    monaco.languages.registerDocumentSymbolProvider(latexLanguageId, createLatexSymbolProvider(monaco)),
  );
}

function disposeLatexProviders() {
  while (providerDisposables.length) {
    const d = providerDisposables.pop();
    try { d.dispose(); } catch { /* already disposed */ }
  }
  completionProvider = null;
}

/* ── theme bridge (§2 Theme row, P22) ──
   cpDefineThemes() reads the LIVE computed CSS variables the legacy
   highlighter paints with — style.css stays the single palette source — and
   defines 'cp-dark'/'cp-light' with literal hex: defineTheme understands
   neither var() nor color-mix(), so rgb()/rgba() values are normalized to hex
   and an unparseable value simply DROPS its rule (R12: that token falls back
   to the base vs/vs-dark color instead of breaking the boot). NOTE: Monaco
   themes are GLOBAL per page (one standalone theme service) — a hard
   constraint on any future second editor instance. */

const CP_THEME = { name: null, defines: 0 }; // read-only via __mp.themeInfo()

const CP_VARS = ['--purple', '--green', '--faint', '--blue', '--yellow', '--pink',
  '--ink', '--dim', '--well-edit', '--well-deep', '--sel'];

/** @param {string} raw a computed CSS var value @returns {string | null} '#rrggbb(aa)' or null (R12) */
function normalizeColor(raw) {
  const v = String(raw || '').trim();
  let m = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let h = m[1].toLowerCase();
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    return h.length === 6 || h.length === 8 ? '#' + h : null; // 5/7 digits = malformed
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    let out = '#' + hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]);
    if (m[4] != null) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out += hex2(a * 255);
    }
    return out;
  }
  return null; // color-mix()/hsl()/var()/empty — tolerated, rule omitted (R12)
}

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  /** @type {{ [k: string]: string | null }} */
  const p = {};
  for (const v of CP_VARS) p[v] = normalizeColor(cs.getPropertyValue(v));
  return p;
}

/* CP-THEME-RULES-BEGIN — token FOREGROUNDS only (I7): token-background theme
   rules silently don't render in the standalone theme service, so the mzone
   wash must never migrate here — it lives as the decorations pass below. */
function cpThemeData(p, base) {
  /** @type {any[]} */
  const rules = [];
  const tr = (token, hex, fontStyle) => {
    if (!hex && !fontStyle) return; // unparseable palette entry → inherit (R12)
    const r = /** @type {any} */ ({ token });
    if (hex) r.foreground = hex.slice(1); // token rules take bare RRGGBB
    if (fontStyle) r.fontStyle = fontStyle;
    rules.push(r);
  };
  // the legacy hl.js palette, class-for-class (style.css .codeHalf rules):
  tr('keyword', p['--purple']);              // .kw — commands / structural
  tr('string', p['--green']);                // .st — \verb + verbatim bodies
  tr('comment', p['--faint'], 'italic');     // .cm
  tr('number', p['--yellow']);               // .nm
  tr('tag', p['--blue']);                    // .cl — tag.env / tag.entry-key
  tr('attribute.name', p['--blue']);         // bibtex field names
  tr('type', p['--blue']);                   // .cl analog in the basic langs
  tr('punctuation', p['--faint']);           // .pt — braces dimmed
  tr('delimiter.math', p['--pink']);         // .md — $ $$ \( \) \[ \]
  tr('keyword.symbol.math', p['--green']);   // .ms — TEX_SYM greek/symbols
  tr('variable.math', p['--ink'], 'italic'); // .mv — italics keep Menlo advance
  tr('operator.math', p['--blue']);          // .mo
  tr('warn', p['--yellow']);                 // .wn — \\ and & flags
  /** @type {{ [k: string]: string }} */
  const colors = {};
  const col = (k, hex) => { if (hex) colors[k] = hex; };
  col('editor.background', p['--well-edit']); // legacy .codeEdit:focus surface
  col('editor.foreground', p['--ink']);
  col('editorLineNumber.foreground', p['--dim']);
  col('editorLineNumber.activeForeground', p['--ink']);
  col('editor.selectionBackground', p['--sel']); // 8-digit hex rides through
  col('editorCursor.foreground', p['--green']);  // legacy .codeEdit caret-color
  col('editorWidget.background', p['--well-deep']);
  return { base, inherit: true, rules, colors };
}
/* CP-THEME-RULES-END */

/**
 * Define/redefine cp-dark + cp-light from the live CSS variables, then apply
 * the one matching the current app theme. Tolerates monaco-not-booted (a
 * pre-INIT theme flip is a no-op; boot re-runs this at INIT). Re-run whole on
 * every applyTheme flip so a future palette edit in style.css lands without a
 * reload. The light palette only exists under html[data-theme="light"], so
 * the attribute is flipped, read, and restored — all synchronously inside one
 * task (two style recalcs, zero paints).
 * @returns {void}
 */
function cpDefineThemes() {
  const monaco = w.monaco;
  if (!monaco || !monaco.editor) return; // tolerate monaco-not-booted
  const html = document.documentElement;
  const had = html.dataset.theme; // applyTheme's two shapes: 'light' | absent
  let dark, light;
  try {
    delete html.dataset.theme;
    dark = readPalette();
    html.dataset.theme = 'light';
    light = readPalette();
  } finally {
    if (had === undefined) delete html.dataset.theme;
    else html.dataset.theme = had;
  }
  monaco.editor.defineTheme('cp-dark', cpThemeData(dark, 'vs-dark'));
  monaco.editor.defineTheme('cp-light', cpThemeData(light, 'vs'));
  CP_THEME.defines++;
  cpSetTheme();
}

function cpSetTheme() {
  if (!w.monaco || !w.monaco.editor) return;
  const name = document.documentElement.dataset.theme === 'light' ? 'cp-light' : 'cp-dark';
  CP_THEME.name = name;
  w.monaco.editor.setTheme(name); // global per page — see the bridge header
}

let themeHookArmed = false;
/* the ONE additive hook into store.applyTheme (§2 Theme row): Settings clicks
   AND live OS scheme changes both land in applyTheme, so both re-read the
   freshly-stamped palette here. NOT registered at module eval — the
   store↔monacoPane ESM cycle rule in the header ('used strictly inside
   functions') — armed once at INIT; reboot generations keep it. */
function armThemeHook() {
  if (themeHookArmed) return;
  themeHookArmed = true;
  themeHooks.push(() => {
    try { cpDefineThemes(); } catch (e) { console.warn('[monaco] theme sync failed (R12)', e); }
  });
}

/* ── mzone math wash (§2 "mzone math wash", I7) ──
   DECORATIONS, NEVER THEME RULES: token-background rules silently don't
   render in the standalone theme service — any "simplification" moving the
   wash into cpThemeData breaks it invisibly (stated invariant I7). Ranges
   come from texZones.scanLineZones — the SAME shared scanner that seeds the
   Monarch math states, both pinned by the A13 golden corpus, so tokenizer and
   wash can never drift. The decorations are MODEL-owned (deltaDecorations on
   the ITextModel): they ride the model across setModel tab switches and die
   with it in reallyDispose. Re-armed (a) in rearmAfterTxn after EVERY M2 txn
   commit, (b) on genuine dock (re)attach in applyFile, (c) debounced ~120ms
   behind idle edits (R13: the wash may lag the tokenizer one debounce frame
   during fast typing — visual-only, tuned here in S1). */

const washIds = new Map();    // fkey → decoration id[] (model-owned)
const washTimers = new Map(); // fkey → idle-edit debounce timer
const WASH_MS = 120;          // the R13 debounce

function washCompute(m) {
  const monaco = w.monaco;
  const out = [];
  // getLinesContent(): model lines with no EOL bytes — columns align with
  // model positions exactly (serialize() would re-prepend a BOM and shift
  // line 1; this path never reaches disk, so P-EOL-1 does not bind it)
  const lines = m.getLinesContent();
  let st = TEX_ZONE_INITIAL;
  for (let i = 0; i < lines.length; i++) {
    const { zones, exit } = scanLineZones(lines[i], st);
    for (const [s, e] of zones) {
      if (e <= s) continue;
      out.push({
        range: new monaco.Range(i + 1, s + 1, i + 1, e + 1),
        // content-hugging inline span; the class is styled from the SAME CSS
        // vars as the legacy .codeHalf .mzone (style.css .mdock .mpWash)
        options: {
          inlineClassName: 'mpWash',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    st = exit;
  }
  return out;
}

/* synchronous full re-arm — total over every model state: non-latex models
   (and departed ones) clear; a pending debounce is superseded */
function washRearm(fkey) {
  const t = washTimers.get(fkey);
  if (t) { clearTimeout(t); washTimers.delete(fkey); }
  const m = models.get(fkey);
  if (!m) { washIds.delete(fkey); return; }
  const old = washIds.get(fkey) || [];
  if (m.getLanguageId() !== latexLanguageId) {
    if (old.length) m.deltaDecorations(old, []); // stay total if a language ever changes
    washIds.delete(fkey);
    return;
  }
  washIds.set(fkey, m.deltaDecorations(old, washCompute(m)));
}

/* the debounced idle-edit path (R13) — txn commits re-arm synchronously and
   cancel any pending timer via washRearm above */
function washSchedule(fkey) {
  const m = models.get(fkey);
  if (!m || m.getLanguageId() !== latexLanguageId) return;
  const t = washTimers.get(fkey);
  if (t) clearTimeout(t);
  washTimers.set(fkey, setTimeout(() => {
    washTimers.delete(fkey);
    if (models.has(fkey)) washRearm(fkey);
  }, WASH_MS));
}

/* ── S2.3 — compile problems: 'texlog' markers + tint parity (P9) ──
   (monaco-s2 §1 S2.3; CONTRACT "P9 compile problems" + the reserved
   setProblems seam.) setProblems(project, rows) fans the project's FULL
   problem set out to every open model of that project and re-applies on
   model create/attach and after every M2 txn — included-file diagnostics
   must land on the included file's model even while it is backgrounded;
   per-model row routing (p.file === rel) rides the S0 factory
   (markersForProblems, A20). Severity error→Error / warning→Warning /
   badbox→Hint; tints are a PARALLEL isWholeLine decoration pair
   .lnErr/.lnWarn for error/warning ONLY — badboxes are deliberately
   untinted (blueprint §2 problems row: the Hint severity carries the
   exclusion; one additive .mdock CSS pair on the legacy tint palette vars,
   the .mpWash precedent). Boundary clamping (review concern 6) is the
   factory's: this module passes the TARGET model's LIVE getLineCount() /
   getLineMaxColumn at EVERY application — apply and re-apply, never
   cached — so a stale diagnostic from the last disk compile clamps to the
   LAST line instead of throwing mid-repaint; the strip stays the precise
   navigation source.
     Arrival wiring: the strip renderer (texrun.renderTexProblems) is
   legacy-SHARED and stays untouched (its no-renderWB in-place contract
   included, I4) — monacoPane consumes the same signal by observing the
   rendered strip host: #texProblems is patched (className + innerHTML) on
   EVERY problems change, both the renderWB leg and the pdf:status
   patch-in-place leg, so a mutation observer on it fires exactly when the
   strip learns something, and the handler re-reads texProblemsFor(key) —
   the unchanged source. renderWB replaces the host node (and its wireWB
   strip pass runs BEFORE attachDock), so the observer is re-attached — and
   an attach refresh run — once per render in attachDock; it is never armed
   under the legacy impl. Markers/decorations are NOT content writes: all of
   this lives outside the M2-GUARDED-WRITES block by design. */

const texProblems = new Map(); // project → TexProblem[] — the latest compile rows
//   (plain data: survives reboot generations; models re-apply on attach)
const tintIds = new Map();     // fkey → tint decoration id[] (model-owned, die in reallyDispose)
let stripObserver = null;      // MutationObserver on the ACTIVE view's #texProblems host
let stripObserved = null;      // the host node currently observed (replaced every renderWB)

/* apply the stored rows to ONE model — markers + tints, clamped per concern 6 */
function applyProblems(fkey, m) {
  const monaco = w.monaco;
  if (!monaco || !m || (typeof m.isDisposed === 'function' && m.isDisposed())) return;
  const markers = markersForProblems(monaco, texProblems.get(projOf(fkey)) || [], relOfFkey(fkey), {
    // the TARGET model's live geometry, read at THIS application (concern 6:
    // the model may have shrunk since the rows arrived — never cache these)
    lineCount: m.getLineCount(),
    lineMaxColumn: (ln) => m.getLineMaxColumn(ln),
  });
  monaco.editor.setModelMarkers(m, 'texlog', markers);
  const S = monaco.MarkerSeverity;
  const tints = markers
    .filter((r) => r.severity === S.Error || r.severity === S.Warning) // badbox (Hint) never tints
    .map((r) => ({
      range: new monaco.Range(r.startLineNumber, 1, r.startLineNumber, 1),
      options: {
        isWholeLine: true,
        className: r.severity === S.Error ? 'lnErr' : 'lnWarn',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
  tintIds.set(fkey, m.deltaDecorations(tintIds.get(fkey) || [], tints));
}

/**
 * Frozen seam (P9 — reserved at S1, landed S2.3): install the project's full
 * compile-problem set. Fans out to every open model of the project — empty
 * rows sweep them ALL (clear-on-green) — and the stored rows re-apply on
 * every later model create/attach and txn re-arm.
 * @param {string} project
 * @param {TexProblem[] | null | undefined} rows
 * @returns {void}
 */
export function setProblems(project, rows) {
  texProblems.set(project, Array.isArray(rows) ? rows : []);
  for (const [fkey, m] of models) {
    if (projOf(fkey) === project) applyProblems(fkey, m);
  }
}

/* re-read the unchanged source (texrun.texProblemsFor: live watch + last
   .tex ▶ run, deduped) and fan out — the strip renderer stays outside */
function problemsRefresh(project) {
  setProblems(project, texProblemsFor(project));
}

/* the S2.3 leg of rearmAfterTxn (CONTRACT M2: the commit "re-arms what the
   flush destroyed (wash, tints, markers…)"): a txn body may replace the text
   wholesale, so the stored rows are re-clamped against the model's NEW line
   count. Total over model state, like washRearm. */
function tintsRearm(fkey) {
  const m = models.get(fkey);
  if (!m) { tintIds.delete(fkey); return; }
  applyProblems(fkey, m);
}

/* per-render observer maintenance — called from attachDock (the wireWB
   seam). Legacy impl: machinery stays disarmed. The unconditional refresh
   covers rows that arrived while this project was backgrounded (the strip
   pass of THIS render ran before attachDock, on a host node the previous
   observer no longer watched). */
function observeProblems(root, key) {
  const strip = root.querySelector('#texProblems');
  if (strip !== stripObserved) {
    if (stripObserver) { stripObserver.disconnect(); stripObserver = null; stripObserved = null; }
    if (strip) {
      stripObserver = new MutationObserver(() => problemsRefresh(key));
      // childList: renderTexProblems assigns innerHTML on every patch;
      // attributes: the clear leg may assign an unchanged className/empty
      // innerHTML with no child mutation — the attribute SET still fires
      stripObserver.observe(strip, { childList: true, attributes: true });
      stripObserved = strip;
    }
  }
  problemsRefresh(key);
}

/* ── S2.4 — texfix: the anchors engine + ✦ content-widget pane (P6) ──
   (monaco-s2 §1 S2.4 post-remediation; CONTRACT P6 + the reserved seam
   `texfix {arm, revalidate, resolve}`.) The S0 engine — createTexfixAnchors,
   with the SYNCHRONOUS apply guard, the 120ms revalidate debounce and the
   5.2s stale grace all inside it — is hosted against the live model through
   the AnchorHost adapter in texfixCreate; this module owns only the host,
   the visuals and the protocol wiring. The legacy wireWB
   renderSugs/applySug/sugLayer closures are untouched (legacy stays
   byte-identical).
     ACTIVE-MODEL-ONLY (review concern 2): ONE engine per project, bound to
   the currently ATTACHED model. texfixArm(project) filters openSugs(project)
   to s.file === relOfFkey(activeFkey) — the engine knows only `find`, so
   this filter is the ONLY thing preventing identical text in two files from
   anchoring (and applying) in the wrong file. Suggestions for other files
   stay card-only until their file becomes active (exact legacy semantics:
   the sugLayer only ever decorated the visible file); a tab switch / dock
   attach re-arms against the new active model, releasing the old engine,
   decorations and widgets (widgets are per-editor-view).
     Visuals: the engine's tracked ranges ARE the .sugMark inline decorations
   (stickiness NeverGrowsWhenTypingAtEdges; findMatches literal, limit 2 —
   the second hit only detects ambiguity, first-match keeps indexOf parity);
   the ✦ pane is an IContentWidget under the match END (preference BELOW
   then ABOVE, allowEditorOverflow:false) hosting the SAME .sugPane DOM/CSS
   as legacy; the arrival pulse rides sugPulsed — once per id, ever. Stale
   visuals = widget + decoration down (the legacy find-missing semantics),
   with sugStaleAt keeping the shared bookkeeping — but the ENGINE owns the
   single 5.2s grace: markSugStale's legacy timer is never armed here (risk
   N2's single-owner rule), so grace expiry resolves 'stale' exactly once,
   through resolveSug's existing POST.
     Protocol: texfixArm registers the project's sugRedraw handle — the only
   externally-addressable handle (seams delta 4) — so texrun's sugPatchViews
   patches decorations/widget/card in place on every resolution; renderWB is
   never called and apply moves neither scroll nor view (I4).
     Apply (review concern 1): the engine's apply(id) asserts range-text ===
   find IMMEDIATELY before the edit; a mismatch runs ONE synchronous re-find,
   then re-anchors ({reason:'moved'} — the re-click is safe) or marks stale —
   either way THAT apply is refused, so wrong-text replacement is
   structurally impossible (R5). Success resolves 'accepted' through
   resolveSug — POST /api/texfix/:project/resolve {id, status:'accepted'};
   the server vocabulary is accepted | dismissed | stale (lib/texfix.js).
   The edit itself flows AS TYPING through texfixApplyAsTyping (CONTRACT M2:
   deliberately UNguarded — no txn; drafts/chrome/undo ride the normal
   M2-idle pipeline; one ⌘Z reverts the whole apply). */

let tfx = null; // the single active-model-only engine record:
//   { project, fkey, engine, entries: Map<id, {sug, fresh, node, widget, added}>, trackClass }
const texfixRedraws = new Map(); // project → stable sugRedraw closure (identity for dereg)

function texfixRedrawFor(project) {
  let f = texfixRedraws.get(project);
  if (!f) { f = () => texfixArm(project); texfixRedraws.set(project, f); }
  return f;
}

function texfixRemoveWidget(e) {
  if (e.added && e.widget && editor) {
    try { editor.removeContentWidget(e.widget); } catch { /* editor mid-teardown */ }
  }
  e.added = false;
}

/* release the whole record: widgets off the editor, engine disposed (its
   tracked decorations die via the host's untrack), redraw handle
   deregistered. Rides the disposal matrix (reallyDispose), the T7 flush,
   and every re-arm. */
function texfixRelease() {
  if (!tfx) return;
  const rec = tfx;
  tfx = null; // engine callbacks fired during dispose see no live record
  for (const e of rec.entries.values()) texfixRemoveWidget(e);
  rec.entries.clear();
  try { rec.engine.dispose(); } catch { /* model already disposed */ }
  if (sugRedraw[rec.project] === texfixRedraws.get(rec.project)) delete sugRedraw[rec.project];
}

/* the ✦ pane: the legacy .sugPane DOM verbatim, hosted as an IContentWidget
   under the match end. getPosition reads the ENGINE's live range each layout
   (null while stale → hidden belt; the paint pass removes the widget too). */
function texfixBuildWidget(rec, e) {
  const s = e.sug;
  const node = document.createElement('div');
  node.className = 'sugPane' + (e.fresh ? ' pulse' : '');
  node.innerHTML = `
    <div class="sugHead">✦ Claude suggests${s.why ? `<span class="sugWhy"> — ${esc(s.why)}</span>` : ''}</div>
    <div class="sugNew">${esc(s.replace)}</div>
    <div class="sugBtns">
      <button class="sugApply">✓ Apply</button>
      <button class="sugDismiss">Dismiss</button>
      <span class="sugFrom">into your unsaved draft — ⌘S keeps it</span>
    </div>`;
  node.addEventListener('mousedown', (ev) => ev.stopPropagation());
  node.querySelector('.sugApply').addEventListener('click', (ev) => { ev.stopPropagation(); texfixApply(s.id); });
  node.querySelector('.sugDismiss').addEventListener('click', (ev) => {
    ev.stopPropagation();
    resolveSug(rec.project, s.id, 'dismissed'); // wire: {id, status:'dismissed'}
  });
  e.node = node;
  e.widget = {
    getId: () => 'cp.texfix.' + s.id,
    getDomNode: () => node,
    allowEditorOverflow: false, // R10: clipped to the editor, like the sugClip layer
    getPosition: () => {
      const st = rec.engine.state(s.id);
      const r = st && st.status === 'anchored' ? st.range : null;
      if (!r) return null;
      const P = w.monaco.editor.ContentWidgetPositionPreference;
      return {
        position: { lineNumber: r.endLineNumber, column: r.endColumn },
        preference: [P.BELOW, P.ABOVE], // under the match end; above only when below can't fit
      };
    },
  };
}

/* reconcile ONE suggestion's widget with the engine's state — add/lay out
   while anchored, remove while stale/gone. Decorations need no paint pass:
   the engine's tracked range IS the .sugMark decoration. */
function texfixPaint(rec, id) {
  if (tfx !== rec || !editor) return;
  const e = rec.entries.get(id);
  if (!e) return;
  const st = rec.engine.state(id);
  if (!st || st.status !== 'anchored' || !st.range) { texfixRemoveWidget(e); return; }
  if (!e.widget) texfixBuildWidget(rec, e);
  if (!e.added) { editor.addContentWidget(e.widget); e.added = true; }
  else editor.layoutContentWidget(e.widget);
}

function texfixCreate(project, fkey) {
  const m = models.get(fkey);
  const monaco = w.monaco;
  /** @type {any} */
  const rec = { project, fkey, entries: new Map(), trackClass: 'sugMark', engine: null };
  const aHost = {
    // literal, limit 2 — the ambiguity probe; first-match keeps indexOf
    // parity (the engine header's contract, texfixAnchors.js)
    findMatches: (text, limit) => m.findMatches(text, false, false, true, null, false, limit)
      .map((f) => f.range),
    getValueInRange: (r) => m.getValueInRange(r),
    track: (range) => m.deltaDecorations([], [{
      range,
      options: {
        inlineClassName: rec.trackClass, // 'sugMark' (+' pulse' only during a fresh arm)
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }])[0],
    rangeOf: (id) => m.getDecorationRange(id),
    untrack: (id) => { try { m.deltaDecorations([id], []); } catch { /* model disposed */ } },
    applyEdit: (r, text2) => texfixApplyAsTyping(m, r, text2),
  };
  rec.engine = createTexfixAnchors(aHost, {
    onStale: (id) => {
      if (tfx !== rec) return;
      // shared bookkeeping only — the legacy 5200ms markSugStale timer is
      // NEVER armed here: the engine owns the single grace (risk N2)
      if (!sugStaleAt[id]) sugStaleAt[id] = Date.now();
      texfixPaint(rec, id);
    },
    onReanchor: (id) => {
      if (tfx !== rec) return;
      delete sugStaleAt[id]; // undo brought the text back — grace canceled by the engine
      texfixPaint(rec, id);
    },
    onResolve: (id, reason) => {
      // engine-initiated ends: grace expiry resolves 'stale' through the
      // wire; 'applied' is texfixApply's own resolveSug('accepted') call
      if (tfx !== rec || reason !== 'stale') return;
      const e = rec.entries.get(id);
      if (e) { texfixRemoveWidget(e); rec.entries.delete(id); }
      // String(): the engine types ids string|number; ours are server strings
      resolveSug(rec.project, String(id), 'stale'); // POST {id, status:'stale'} — exactly once
    },
  });
  return rec;
}

/**
 * Frozen seam (P6) — arm: sync the texfix engine with the project's open
 * suggestions against the ACTIVE model (concern 2: active-model-only; other
 * files of the project stay card-only). Called on dock attach, model attach,
 * txn re-arm, and via the registered sugRedraw handle on every resolution.
 * @param {string} project
 * @returns {void}
 */
function texfixArm(project) {
  if (!project) return;
  const fkey = activeFkey;
  const live = bootState === 'READY' && !!editor
    && !!fkey && projOf(fkey) === project && models.has(fkey);
  if (!live) {
    if (tfx && tfx.project === project) texfixRelease();
    return;
  }
  if (tfx && tfx.fkey !== fkey) texfixRelease(); // re-arm releases the old engine/visuals
  if (!tfx) tfx = texfixCreate(project, fkey);
  const rec = tfx;
  // seams delta 4: the only externally-addressable handle — resolution
  // patching (sugPatchViews) lands here, never in renderWB (I4)
  sugRedraw[project] = texfixRedrawFor(project);
  const rel = relOfFkey(fkey);
  const want = openSugs(project).filter((s) => s.file === rel); // the concern-2 ownership filter
  const wantIds = new Set(want.map((s) => s.id));
  for (const id of rec.engine.ids()) {
    if (!wantIds.has(id)) rec.engine.resolve(id, 'superseded'); // resolved elsewhere — silent
  }
  for (const [id, e] of [...rec.entries]) {
    if (!wantIds.has(id)) { texfixRemoveWidget(e); rec.entries.delete(id); }
  }
  for (const s of want) {
    if (!rec.entries.has(s.id)) {
      const fresh = !sugPulsed.has(s.id); // pulse once per id, ever
      if (fresh) sugPulsed.add(s.id);
      rec.entries.set(s.id, { sug: s, fresh, node: null, widget: null, added: false });
      rec.trackClass = fresh ? 'sugMark pulse' : 'sugMark'; // arm() tracks SYNCHRONOUSLY
      rec.engine.arm(s); // a miss already fired onStale (stale visuals + the engine's grace)
      rec.trackClass = 'sugMark';
    }
    texfixPaint(rec, s.id);
  }
}

/**
 * Frozen seam (P6) — revalidate: rides onIdleEdit. The engine debounces the
 * re-anchor pass (its own 120ms); the widget layout refreshes per edit so
 * panes track typing immediately (decorations track by stickiness for free).
 * @param {string} fkey
 * @returns {void}
 */
function texfixRevalidate(fkey) {
  if (!tfx || tfx.fkey !== fkey) return;
  tfx.engine.revalidate();
  for (const id of tfx.entries.keys()) texfixPaint(tfx, id);
}

/**
 * Frozen seam (P6) — resolve: the external-resolution leg (dismissed /
 * superseded / applied elsewhere). Engine + visuals only — the caller owns
 * any POST (resolveSug's optimistic patch reaches us via sugRedraw anyway).
 * @param {string | number} id
 * @param {string} [reason]
 * @returns {void}
 */
function texfixResolve(id, reason) {
  if (!tfx) return;
  tfx.engine.resolve(id, reason || 'resolved');
  const e = tfx.entries.get(id);
  if (e) { texfixRemoveWidget(e); tfx.entries.delete(id); }
  delete sugStaleAt[id];
}

/** Frozen seam (CONTRACT P6, reserved at S1 — landed S2.4). */
export const texfix = { arm: texfixArm, revalidate: texfixRevalidate, resolve: texfixResolve };

/* the M2 rearmAfterTxn leg (CONTRACT M2: the commit "re-arms what the flush
   destroyed (… texfix at S2)"): a txn body may have replaced the text
   wholesale, so the engine re-arms from scratch against the model's NEW
   text — release + full arm. The pulse cannot replay (sugPulsed is per-id,
   forever). Total over engine state, like washRearm/tintsRearm. */
function texfixRearm(fkey) {
  if (!tfx || tfx.fkey !== fkey) return;
  const project = tfx.project;
  texfixRelease();
  texfixArm(project);
}

/**
 * The ✦ pane's Apply (and the __mp surface): the engine's SYNCHRONOUS guard
 * decides. ok → the edit already landed as typing; resolve 'accepted'
 * through the existing POST (the exact wire: {id, status:'accepted'}).
 * Refusal {reason:'moved'} → the engine re-found and re-anchored: the
 * decorations re-point and the re-click is now safe. {reason:'stale'} →
 * stale visuals (onStale already fired) + the engine's grace runs.
 * @param {string | number} id suggestion id
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function texfixApply(id) {
  if (!tfx) return { ok: false, reason: 'unknown' };
  const rec = tfx;
  const r = rec.engine.apply(id);
  if (r.ok) {
    focusEditor(); // legacy parity: hand focus back to the editor after the button click
    // resolveSug's synchronous half patches card/strip/decorations in place
    // (its sugPatchViews rides our sugRedraw handle — never renderWB, I4)
    resolveSug(rec.project, String(id), 'accepted'); // String(): engine ids type string|number
  } else {
    texfixPaint(rec, id); // 'moved': widget re-points at the re-anchor; 'stale': widget down
  }
  return r;
}

/* ═══════ S2.5 — SyncTeX jumps (P7/P8), outline picks (P12), and the
   Enter/Tab language commands (P11/P19) — monaco-s2 §1 S2.5 ═══════

   Jumps first: revealAt is the applyEdJump heir (legacy workbench.js:111–133)
   behind the CONTRACT P8 reserved seam — clamp → setPosition → the EXPLICIT
   35%-height reveal → focus → a restartable whole-line lnFlash decoration
   (heir of texEditor.texJumpFlash; painted by the additive `.mdock .lnFlash`
   rule on the SAME keyframes as the legacy overlay flash). Jump/flash/reveal
   move the viewport and decorations only — they are NOT content writes, so
   none of this runs under an M2 transaction (CONTRACT M2 binds writes). */

const flashIds = new Map();    // fkey → decoration id[] (model-owned; die in reallyDispose)
const flashTimers = new Map(); // fkey → the 1.9s release timer

function flashClear(fkey) {
  const t = flashTimers.get(fkey);
  if (t) { clearTimeout(t); flashTimers.delete(fkey); }
  const m = models.get(fkey);
  const old = flashIds.get(fkey) || [];
  if (m && old.length) m.deltaDecorations(old, []);
  flashIds.delete(fkey);
}

/* restartable on purpose (legacy texJumpFlash parity: re-flash restarts the
   animation): clear FIRST, then decorate fresh — the new decoration renders a
   new view node, so the CSS animation re-runs from 0% */
function flashArm(fkey, m, line) {
  flashClear(fkey);
  flashIds.set(fkey, m.deltaDecorations([], [{
    range: new w.monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: 'lnFlash',
      stickiness: w.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }]));
  flashTimers.set(fkey, setTimeout(() => flashClear(fkey), 1900));
}

/**
 * Frozen seam (CONTRACT P8, reserved at S1 — landed S2.5): jump the ATTACHED
 * editor to fkey's line:col. Clamp to model bounds → setPosition → the A20
 * EXPLICIT 35% reveal — `setScrollTop(getTopForLineNumber(line) − 0.35 ×
 * getLayoutInfo().height)`, NEVER revealPositionNearTop (P8 indexes the
 * explicit form; legacy parity is the `− ed.clientHeight * 0.35` in
 * workbench's applyEdJump) → focus → restartable lnFlash when asked.
 * @param {string} fkey
 * @param {number} line 1-based
 * @param {number} [col] 1-based
 * @param {{ flash?: boolean }} [opts]
 * @returns {boolean} true when the jump landed — fkey is the attached model;
 *   false lets the caller keep its pending jump armed (boot/fetch still due)
 */
export function revealAt(fkey, line, col, opts = {}) {
  if (!editor || bootState !== 'READY') return false;
  const m = models.get(fkey);
  if (!m || editor.getModel() !== m) return false;
  const ln = Math.min(Math.max(1, Number(line) || 1), m.getLineCount());
  const cl = Math.min(Math.max(1, Number(col) || 1), m.getLineMaxColumn(ln));
  editor.setPosition({ lineNumber: ln, column: cl });
  editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(ln) - editor.getLayoutInfo().height * 0.35));
  editor.focus();
  if (opts && opts.flash) flashArm(fkey, m, ln);
  return true;
}

/**
 * Frozen seam (CONTRACT P7, reserved at S1 — landed S2.5): the active
 * editor's caret, 1-based on both axes (Monaco positions already are — the
 * ⌘J/◎ forward-SyncTeX callers pass this straight to texForwardSearch).
 * @returns {{ line: number, col: number } | null}
 */
export function getPosition() {
  const p = editor && editor.getPosition();
  return p ? { line: p.lineNumber, col: p.column } : null;
}

/* ── the P11/P19 Enter/Tab commands — the §6 S2.0 spike verdict is BINDING ──
   Mechanism: context-expression addCommand, with !suggestWidgetVisible
   REQUIRED in BOTH contexts (q4.suggest-tab-unguarded: an unguarded Tab
   command provably STEALS the key from the open suggest widget). Dist quirks
   (measured, §6): addCommand dynamic rules are PAGE-GLOBAL and SURVIVE
   editor.dispose() — so every boot generation re-registers the IDENTICAL
   context strings (among equal matches the LAST-registered rule wins: the
   newest generation shadows the zombies) and the handlers read LIVE module
   state (`editor`/`bootGen` at call time), never per-generation objects.
   The registration-time generation is closed over for BOOKKEEPING only
   (cmdFires — the zombie-shadowing census __mp.commandInfo exposes). */

const CTX_ENTER = 'textInputFocus && !suggestWidgetVisible';
const CTX_TAB = "editorLangId == 'julia' && !suggestWidgetVisible";
const cmdFires = []; // {gen, cmd} — which generation's handler ran (test census)

// the legacy auto-\end trigger, verbatim (texEditor.js Enter branch): the
// line-before-caret ends on \begin{env} plus optional [..]/{..} argument tails
const BEGIN_LINE_RE = /\\begin\{([A-Za-z*]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/;

/* P11 Enter — latex auto-\end. Fires for EVERY guarded Enter (the context is
   language-agnostic by the spike's binding wording), so every non-skeleton
   path falls through via editor.trigger('keyboard','type',{text:'\n'}) —
   measured byte-identical to native Enter (§6 Q1: leading-indent keep AND
   the bracket-pair case), including multi-cursor (Q5). A18: any selection
   count ≠ 1 (and any non-empty selection) falls through. */
function cmdEnter(gen) {
  cmdFires.push({ gen, cmd: 'enter' });
  if (!editor) return;
  const m = editor.getModel();
  const sels = editor.getSelections();
  if (m && sels && sels.length === 1 && sels[0].isEmpty()
    && m.getLanguageId() === latexLanguageId) {
    const pos = sels[0].getPosition();
    const before = m.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const bm = before.match(BEGIN_LINE_RE);
    // needsEnd over the FULL buffer — the §6 Q2 spec correction, binding:
    // text-up-to-caret wrongly re-inserts on a closed env (measured:
    // full-buffer false / up-to-caret true on \begin{itemize}\n\end{itemize})
    if (bm && needsEnd(serialize(m), bm[1])) {
      const indent = (before.match(/^[ \t]*/) || [''])[0];
      const monaco = w.monaco;
      // legacy caret parity (texEditor.js): body line, after `indent + '  '`
      commandEditAsTyping('cp-auto-end',
        new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        `\n${indent}  \n${indent}\\end{${bm[1]}}`,
        new monaco.Selection(pos.lineNumber + 1, indent.length + 3, pos.lineNumber + 1, indent.length + 3));
      return;
    }
  }
  editor.trigger('keyboard', 'type', { text: '\n' });
}

/* P19 Tab — julia \symbol. The context already gates to julia models, so
   .tex Tab stays PURE native (the ui.monaco-core P19 row) — nothing here
   ever sees it. A miss (and A18 multi-cursor / non-empty selection) falls
   through via editor.trigger('keyboard','tab',{}) — measured byte-identical
   to native Tab (§6 Q3: caret-mid-line tab-stop spaces AND multi-line
   selection indent; type-'\t' and indentLines are REJECTED alternatives). */
function cmdTab(gen) {
  cmdFires.push({ gen, cmd: 'tab' });
  if (!editor) return;
  const m = editor.getModel();
  const sels = editor.getSelections();
  if (m && sels && sels.length === 1 && sels[0].isEmpty()) {
    const pos = sels[0].getPosition();
    const before = m.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const hit = texSymbolMatch(before); // the S0 pure core (util.texComplete parity)
    if (hit && hit.sym) {
      commandEditAsTyping('cp-julia-symbol',
        new w.monaco.Range(pos.lineNumber, pos.column - hit.length, pos.lineNumber, pos.column),
        hit.sym);
      return;
    }
  }
  editor.trigger('keyboard', 'tab', {});
}

/* P7 ⌘J — forward SyncTeX from the live caret: the SAME texForwardSearch
   flow the legacy path uses (toast-bail without a live PDF, /api/synctex/view
   GET, pane scroll+flash) past the caret-read. Latex models only (the plan's
   gate; the ⌘⏎ pattern — the handler reads live state and no-ops elsewhere). */
function cmdForwardSync() {
  if (!activeFkey || !editor) return;
  const m = editor.getModel();
  if (!m || m.getLanguageId() !== latexLanguageId) return;
  const p = getPosition();
  if (p) texForwardSearch(projOf(activeFkey), relOfFkey(activeFkey), p.line, p.col);
}

function toState(state, detail) {
  bootState = state;
  const entry = Object.assign({ t: bootT0 ? Math.round(performance.now() - bootT0) : 0, state }, detail || {});
  bootLog.push(entry);
  return entry;
}

/**
 * Boot Monaco (idempotent). First call creates the promise synchronously and
 * starts the machine; every later call — including the idle-warm vs first-open
 * race — returns the SAME promise.
 * @returns {Promise<{ok: boolean, monaco?: any, stage?: string, detail?: any}>}
 */
export function ensureMonaco() {
  if (bootPromise) return bootPromise;
  bootStarts++;
  bootT0 = performance.now();
  bootPromise = new Promise((res) => { resolveBoot = res; });
  w.__monacoReady = bootPromise;
  // the single deadline — the ONLY detector for hung fetches (core-hang emits
  // zero events); spans LOADER → CSS_VERIFY including the one auto-retry
  const deadlineMs = typeof w.__mpDeadlineMs === 'number' ? w.__mpDeadlineMs : 10000;
  deadlineTimer = setTimeout(() => fail('deadline', { lastState: bootState }), deadlineMs);
  armGlobalListeners();
  toState('LOADER');
  startLoader();
  return bootPromise;
}

/* edge 2 (script.onerror → loader/net) and edge 3 (onload + typeof check →
   loader/parse: a corrupt loader FIRES onload and never onerror — the typeof
   require.config probe after onload is the mandatory detector) */
function startLoader() {
  // retry re-entry: if a live AMD loader survived the failed attempt (core-net
  // fail), don't re-execute loader.js — jump straight to CORE
  if (w.require && typeof w.require.config === 'function') {
    toState('CORE', retried ? { retry: 1 } : undefined);
    startCore();
    return;
  }
  const url = `${VS_BASE}/loader.js`;
  const s = document.createElement('script');
  s.src = url;
  bootNodes.push(s);
  s.onerror = () => fail('loader', { kind: 'net', url });
  s.onload = () => {
    if (!w.require || typeof w.require.config !== 'function') {
      fail('loader', { kind: 'parse', url, err: lastWindowError || null });
      return;
    }
    toState('CORE');
    startCore();
  };
  document.head.appendChild(s);
}

/* edge 5: the AMD errback fires for transitive deps with a structured error —
   log moduleId/neededBy/phase, NEVER err.message ("[object Event]") */
function startCore() {
  w.require.config({ paths: { vs: VS_BASE } });
  w.require(['vs/editor/editor.main'], () => {
    toState('INIT', { ms: Math.round(performance.now() - bootT0) });
    try {
      initWiring(); // edge 7: try/catch around ALL wiring — an uncaught throw
      //             surfaces only as an unhandledrejection and pends forever
    } catch (err) {
      fail('init', { message: err && err.message, stack: err && err.stack });
      return;
    }
    toState('CSS_VERIFY');
    verifyCss();
  }, (err) => {
    const nb = err && err.neededBy; // the vs loader hands back an array of dependents
    fail('core', {
      moduleId: err && err.moduleId,
      neededBy: Array.isArray(nb) ? nb.join(',') : nb,
      phase: (err && err.phase) || 'loading',
    });
  });
}

/* INIT: create the singleton editor in the kept host with the ratified option
   set (A18 keeps default tokenization caps; detectIndentation:false is
   contractual two-space). EditContext surface: unpinned until the S1 I2-IME
   pin task — tests drive both surfaces via window.__mpEditContext. */
function initWiring() {
  if (w.__mpInitThrow) throw new Error('injected init failure (test seam __mpInitThrow)');
  const monaco = w.monaco;
  if (!monaco || !monaco.editor) throw new Error('editor.main resolved but window.monaco.editor is missing');
  // ── boot INIT step (§5 step 4, A5 design consequence): register
  // 'latex'/'bibtex' and define the cp themes BEFORE the first createEditor —
  // no stock-theme flash. NO eager basic-language preload (§14 A5: the public
  // ids do not exist; lazy activation via the RETAINED AMD globals delivers a
  // tokenizer 26–27ms after first open). ──
  initTrace.length = 0;
  registerTexLanguages(monaco);
  registerLatexProviders(monaco); // S2.2: completions for 'latex' only (P10)
  muteTsSemantics(monaco);        // wave 1: no "Cannot find module" squiggles
  initTrace.push('langs');
  try {
    cpDefineThemes();
  } catch (e) {
    // a palette failure degrades to the stock theme (R12) — never to FALLBACK
    console.warn('[monaco] cpDefineThemes failed — stock theme (R12)', e);
  }
  initTrace.push('themes');
  armThemeHook(); // later applyTheme flips re-run the define+set pass
  ensurePark();
  host = document.createElement('div');
  // the kept host carries the #codeEditor contact surface (P14): root-scoped
  // consumers (files.editorChrome, texrun's chrome sync) re-anchor to its
  // data-fkey/-rel/-ext, updated synchronously in setFile. The legacy
  // textarea keeps the same id — the two never coexist inside one view root,
  // and workbench's legacy paths select `textarea#codeEditor`.
  host.id = 'codeEditor';
  host.className = 'mpHost';
  if (pendingFile) {
    host.dataset.fkey = pendingFile.fkey;
    host.dataset.rel = relOfFkey(pendingFile.fkey);
    host.dataset.ext = pendingFile.ext;
  }
  park.appendChild(host);
  editor = monaco.editor.create(host, {
    editContext: w.__mpEditContext !== undefined ? !!w.__mpEditContext : false,
    automaticLayout: true,
    autoDetectHighContrast: false,
    quickSuggestions: false,      // S2.2 no-word-noise gate: ONLY the trigger
    wordBasedSuggestions: 'off',  // characters open the widget — asserted from
    //                               first mount (ui.monaco-completions)
    minimap: { enabled: false },
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false, // A18: two-space is contractual — never sniffed
    // cp themes were defined just above; a cpDefineThemes failure (R12) left
    // CP_THEME.name null and the stock base theme stands in
    theme: CP_THEME.name || (document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark'),
    value: '',
    language: 'plaintext',
  });
  initTrace.push('create'); // the §5 ordering proof: langs → themes → create
  // NO eager language preload (A5: the public basic-language module ids do not
  // exist; lazy activation via the retained AMD loader delivers a tokenizer
  // 26–27ms after first open) and NO MonacoEnvironment.getWorkerUrl / manual
  // CSS link — the dist self-sets both.
  //
  // A7 belt: the inComposition flag rides editor.onDidCompositionStart/End —
  // DOM composition listeners are WRONG here (under the EditContext surface
  // they never fire; the editor-level events fire on both surfaces).
  editor.onDidCompositionStart(() => { inComposition = true; });
  editor.onDidCompositionEnd(() => { inComposition = false; compositionEnds++; });
  // P2/P13 (M3): ⌘S and ⌘⏎ are EDITOR commands — they fire only while the
  // pinned input surface has focus (Monaco's keybinding service owns the
  // preventDefault), so the legacy textarea keydown path in workbench.js is
  // untouched and the toggle-off behavior stays byte-identical.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    if (activeFkey) requestSave(activeFkey);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    if (!activeFkey) return;
    // gated on the ▶ registry: a file no runtime claims gets a toast, not a
    // POST that comes back 400
    const rel = relOfFkey(activeFkey);
    if (!isRunnable(rel)) {
      const m = /\.([^./\\]+)$/.exec(String(rel || ''));
      toast(`no runner for ${m ? `.${m[1]}` : 'this file'}`);
      return;
    }
    runAfterSave(activeFkey);
  });
  // S2.5 (P7): ⌘J forward SyncTeX — same registration shape as ⌘S/⌘⏎ above
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, cmdForwardSync);
  // S2.5 (P11/P19): the spiked Enter/Tab commands — context strings VERBATIM
  // from the §6 S2.0 verdict (binding), re-registered with IDENTICAL contexts
  // each boot generation so the newest rules shadow the page-global zombies
  // that survive editor.dispose() (§6 dist quirks). `gen` is captured for the
  // cmdFires census only — the handlers read live module state.
  {
    const gen = bootGen;
    editor.addCommand(monaco.KeyCode.Enter, () => cmdEnter(gen), CTX_ENTER);
    editor.addCommand(monaco.KeyCode.Tab, () => cmdTab(gen), CTX_TAB);
    // NB addCommand returns string|null (NOT an IDisposable — §6): nothing to
    // bank; disposal is by shadowing, per the quirk above.
  }
  armLatencySampler(); // A16 seed (§4 item 2) — dies with this editor instance
}

/* edges 9/10: CSS_VERIFY — the dist self-injects <link …editor.main.css> with
   no error handling of its own; a 404 is silent to the AMD chain (editor
   "works" unstyled = unusable). Poll link.sheet ≤2s, one reinject retry. */
function latestCssLink() {
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  let found = null;
  links.forEach((l) => {
    const href = String(l.getAttribute('href') || l.href || '');
    if (href.includes('/vendor/monaco/') && href.includes('editor.main.css')) found = l;
  });
  return /** @type {any} */ (found);
}

function verifyCss() {
  const budget = 2000;
  let attempt = 0; // 0 = the self-injected link; 1 = our one reinject retry
  let t0 = Date.now();
  const tick = () => {
    if (bootState !== 'CSS_VERIFY') return; // superseded (deadline fired)
    const link = latestCssLink();
    let rules = 0;
    try { rules = link && link.sheet ? link.sheet.cssRules.length : 0; } catch { rules = 0; }
    if (rules > 0) { ready(rules); return; }
    const bad = cssErrorSeen || (link && link._mpErr) || Date.now() - t0 > budget;
    if (bad) {
      if (attempt === 0) {
        attempt = 1;
        cssErrorSeen = false;
        t0 = Date.now();
        toState('CSS_VERIFY', { reinject: 1 });
        const fresh = document.createElement('link');
        fresh.rel = 'stylesheet';
        fresh.href = link ? link.href : `${VS_BASE}/editor/editor.main.css`;
        fresh.onerror = () => { /** @type {any} */ (fresh)._mpErr = true; };
        bootNodes.push(fresh);
        document.head.appendChild(fresh);
      } else {
        fail('css', { href: link ? link.href : `${VS_BASE}/editor/editor.main.css` });
        return;
      }
    }
    cssTimer = setTimeout(tick, 50);
  };
  tick();
}

function ready(ruleCount) {
  clearTimeout(deadlineTimer);
  deadlineTimer = null;
  toState('READY', { ruleCount, ms: Math.round(performance.now() - bootT0) });
  armLongTasks(); // A16 seed (§4 item 3): observer arms at READY only — never under legacy
  const settle = resolveBoot;
  resolveBoot = null;
  if (settle) settle({ ok: true, monaco: w.monaco });
  // a setFile that raced the boot is applied now, before the dock shows
  try { applyFile(); } catch (e) { console.warn('[monaco] deferred setFile failed', e); }
  if (lastAttach && lastAttach.root.isConnected) syncDock(lastAttach.root);
}

function netClass(stage, detail) {
  return (stage === 'loader' && detail && detail.kind === 'net')
    || (stage === 'core' && (!detail || detail.phase == null || detail.phase === 'loading'));
}

function fail(stage, detail) {
  // pre-READY states only: post-READY degradation NEVER falls back, and a
  // second failure signal after FAILED/FALLBACK is a no-op
  if (bootState !== 'LOADER' && bootState !== 'CORE' && bootState !== 'INIT' && bootState !== 'CSS_VERIFY') return;
  toState('FAILED', Object.assign({ stage }, detail || {}));
  cleanupPartialBoot();
  if (!retried && stage !== 'deadline' && netClass(stage, detail)) {
    // edge 12: one auto-retry for net-class loader/core failures; the single
    // deadline stays armed and spans the retry
    retried = true;
    toState('LOADER', { retry: 1 });
    startLoader();
    return;
  }
  clearTimeout(deadlineTimer);
  deadlineTimer = null;
  showBootFailure(stage, detail);
}

/* cleanup: dispose the partial editor, remove injected nodes, clear timers.
   Drafts live in store.js and are untouched by design — nothing here may
   reach into app state. */
function cleanupPartialBoot() {
  clearTimeout(cssTimer);
  cssTimer = null;
  disarmPerfSeeds(); // A16 seeds die with the boot generation (§4)
  disposeLatexProviders(); // S2.2/N3: registrations die with their boot generation
  if (editor) { try { editor.dispose(); } catch { /* partial editor */ } editor = null; }
  if (host) { try { host.remove(); } catch { /* detached */ } host = null; }
  while (bootNodes.length) { const n = bootNodes.pop(); try { n.remove(); } catch { /* gone */ } }
  // the dist self-injects its css link outside our bootNodes list — sweep it
  // too (bounded: reinjects were already removed above)
  for (let i = 0; i < 4; i++) {
    const l = latestCssLink();
    if (!l) break;
    try { l.remove(); } catch { break; }
  }
}

// Failure is terminal for this generation, but never destroys drafts.
function showBootFailure(stage, detail) {
  bootFailure = stage;
  console.warn('[monaco] editor unavailable', { stage });
  hideAllDocks();
  const settle = resolveBoot;
  resolveBoot = null;
  if (settle) settle({ ok: false, stage, detail });
  if (lastAttach?.root.isConnected) renderBootFailure(lastAttach.root);
}

function renderBootFailure(root) {
  const slot = root.querySelector('#monacoSlot');
  if (!slot || !bootFailure) return;
  const fkey = slot.dataset.fkey;
  if (slot.querySelector('.mpFailure')) return;
  slot.innerHTML = '<section class="mpFailure" role="alert"><h3>Editor could not load</h3><p>Your unsaved text is still held in this tab. Retry without reloading the page, or copy the text before closing it.</p><div><button class="gbtn mpRetry">Retry editor</button> <button class="gbtn mpCopy">Copy text</button></div><pre tabindex="0" aria-label="Read-only file text"></pre><p class="mpCopyStatus" role="status"></p></section>';
  const content = () => drafts[fkey] ?? fileCache[fkey]?.text ?? '';
  slot.querySelector('pre').textContent = content();
  slot.querySelector('.mpCopy').addEventListener('click', async () => {
    const status = slot.querySelector('.mpCopyStatus');
    try { await navigator.clipboard.writeText(content()); status.textContent = 'Text copied.'; }
    catch { status.textContent = 'Clipboard unavailable. Select and copy the read-only text above.'; }
  });
  slot.querySelector('.mpRetry').addEventListener('click', () => {
    const key = lastAttach?.key;
    rebootMonaco();
    if (key) renderWB(key);
  });
}

/**
 * Re-arm a fresh boot generation — the explicit "try Monaco again" affordance
 * Clears the recoverable failure state; the next ensureMonaco() runs a
 * brand-new machine.
 * @returns {void}
 */
export function rebootMonaco() {
  clearTimeout(deadlineTimer);
  deadlineTimer = null;
  if (resolveBoot) {
    // never strand an awaiting caller: a mid-flight generation settles ok:false
    const settle = resolveBoot;
    resolveBoot = null;
    settle({ ok: false, stage: 'reboot', detail: null });
  }
  // a fresh generation gets a fresh model registry: the old models belong to
  // the disposed editor/monaco instance. Dirty text is safe — drafts (the
  // single source of truth) live in store.js and are untouched.
  for (const [fkey, m] of [...models]) reallyDispose(fkey, m);
  pendingFile = null;
  cleanupPartialBoot();
  bootPromise = null;
  resolveBoot = null;
  bootState = 'IDLE';
  bootLog.length = 0;
  latCount = 0;      // the A16 rings are per-generation: the old numbers
  ltRing.length = 0; // measured a disposed editor/monaco instance (§4)
  retried = false;
  bootFailure = null;
  workerDegraded = false;
  langDegradedSet.clear();
  lastWindowError = '';
  cssErrorSeen = false;
  bootGen++;
}

/* ───────────── capturing listeners: diagnostics + post-READY degradation ─────────────
   One capturing window 'error' listener sees non-bubbling resource errors
   (script/link) AND runtime ErrorEvents (a failed worker importScripts
   propagates to window.onerror). unhandledrejection: the lazy language
   loader rejects with the raw DOM Event — no message/stack, so the handler
   MUST guard reason instanceof Event and attribute by URL only. */

let listenersArmed = false;

// Lazy chunk names are vs/<id>-<hash>.js in the 0.56 min build. Every id
// langFor can return must be here so a failed chunk is attributed (wave 1:
// rust, go, javascript, typescript, cpp, ini, yaml, shell — all present).
const LANG_IDS = new Set([
  'python', 'julia', 'markdown', 'r', 'shell', 'sql', 'json', 'yaml', 'html',
  'css', 'xml', 'cpp', 'csharp', 'java', 'typescript', 'javascript', 'ini',
  'dockerfile', 'perl', 'lua', 'rust', 'go', 'ruby', 'php', 'swift', 'bat',
]);
// ids with no chunk of their own: `c` is registered by the cpp chunk, so a
// failed cpp chunk degrades both
const LANG_CHUNK_RIDERS = { cpp: ['c'] };

function maybeLangDegraded(src) {
  const m = String(src).match(/\/vs\/([a-z0-9_]+)-[\w-]+\.js(\?|$)/i);
  if (!m || !LANG_IDS.has(m[1]) || langDegradedSet.has(m[1])) return;
  langDegradedSet.add(m[1]);
  for (const rider of LANG_CHUNK_RIDERS[m[1]] || []) langDegradedSet.add(rider);
  console.warn(`[monaco] language chunk failed — '${m[1]}' stays plaintext (editing unaffected).`, src);
}

function markWorkerDegraded(msg) {
  if (workerDegraded) return;
  workerDegraded = true;
  // Monaco's own recovery is real: it logs "Falling back to loading web worker
  // code in main thread" and continues — stay READY, log once
  console.warn('[monaco] editor worker failed — Monaco continues on the main thread.', msg);
}

function armGlobalListeners() {
  if (listenersArmed) return;
  listenersArmed = true;
  window.addEventListener('error', (ev) => {
    const anyEv = /** @type {any} */ (ev);
    const t = anyEv.target;
    const isResource = t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK');
    if (isResource) {
      const src = String(t.src || t.href || '');
      if (!src.includes('/vendor/monaco/')) return;
      if (src.includes('editor.main.css')) { cssErrorSeen = true; return; }
      maybeLangDegraded(src);
      return;
    }
    // runtime ErrorEvent — keep the text for the loader-corrupt diagnostic;
    // a propagated worker importScripts failure marks workerDegraded
    const msg = String(anyEv.message || '');
    if (msg) lastWindowError = msg;
    if (/importScripts|web worker/i.test(msg) || /editor\.worker/.test(String(anyEv.filename || ''))) {
      markWorkerDegraded(msg);
    }
  }, true);
  window.addEventListener('unhandledrejection', (ev) => {
    const r = /** @type {any} */ (ev).reason;
    if (r instanceof Event) {
      // raw DOM Event (lazy chunk loader) — no message/stack; URL is the only attribution
      const src = /** @type {any} */ (r).target ? String(/** @type {any} */ (r).target.src || '') : '';
      if (src.includes('/vendor/monaco/')) {
        maybeLangDegraded(src);
        ev.preventDefault();
      }
    }
  });
}

/* ═══════════════ M2 — mutation transaction / origin guard (A2) ═══════════════
   Per-fkey guard around every internal write. Monaco 0.56 flushes
   onDidChangeModelContent SYNCHRONOUSLY, so the flag never needs to span a
   task boundary — and a canary asserts that premise on every guarded write
   (fails loudly if a Monaco upgrade makes the event async). Transactions are
   synchronous end-to-end: no await can occur between beginTxn and commit
   because the body is a plain synchronous function. Exactly one
   dirty/chrome/preview signal per transaction, emitted after commit. */

const TXN_REASONS = new Set([
  'seedCreate', 'cleanReload', 'mergeRebase', 'recoveryReload', 'draftReconcile', 'eolSetup',
]);

function beginTxn(fkey, reason) {
  if (!TXN_REASONS.has(reason)) {
    throw new Error(`monacoPane M2: unknown txn reason '${reason}' (closed set: ${[...TXN_REASONS].join(', ')})`);
  }
  if (txnOpen.has(fkey)) {
    throw new Error(`monacoPane M2: re-entrant txn on ${fkey} ('${txnOpen.get(fkey)}' still open)`);
  }
  txnOpen.set(fkey, reason);
}

/* the one signal per txn (and per idle edit): chip + dirty dot + ▶ amber via
   the unedited files.editorChrome pipeline, plus at most one md preview ping */
function signalOnce(fkey) {
  const key = projOf(fkey);
  chromeSignals++;
  editorChrome(key);
  const rel = relOfFkey(fkey);
  if (/\.(md|markdown)$/i.test(rel)) {
    previewSignals++;
    mdPreviewSchedule(key, rel);
  }
  for (const cb of dirtyCbs) {
    try { cb(fkey); } catch (e) { console.warn('[monaco] onDirtyChange callback failed', e); }
  }
  paintRecoveryChip(fkey); // M5: never a 'saved' frame mid-recovery
}

/* per-txn re-arm of everything a flush destroys (M2 T4). S1.4 wires the
   mzone wash; S2.3 wires the problems markers/tints; S2.4 wires the texfix
   engine/decorations/widgets. */
function rearmAfterTxn(fkey) {
  texfixRearm(fkey); // S2.4: engine re-armed from scratch against the post-txn text (P6)
  washRearm(fkey); // S1.4: synchronous — a txn body may replace text wholesale
  tintsRearm(fkey); // S2.3: markers + tints from the stored rows, re-clamped
  //   against the model's post-txn line count (concern 6)
}

/**
 * Run one M2 transaction: origin flag armed for the (synchronous) body, flag
 * cleared on EVERY exit path (finally — an exception can never wedge the fkey
 * in permanent suppression), then re-arm + exactly ONE signal.
 * @param {string} fkey
 * @param {string} reason enumerated TXN_REASONS member
 * @param {() => void} body all internal writes + their bookkeeping, synchronous
 * @returns {void}
 */
function runTxn(fkey, reason, body) {
  beginTxn(fkey, reason);
  let err = null;
  try {
    if (w.__mpTxnThrow) { // test seam: exception-path injection (M2 T6/T7)
      w.__mpTxnThrow = false;
      throw new Error('injected txn failure (__mpTxnThrow)');
    }
    body();
  } catch (e) {
    err = e; // bookkeeping stays pinned at pre-txn values — bodies write
    //         model text first, bookkeeping last, in one synchronous block
  } finally {
    txnOpen.delete(fkey);
  }
  rearmAfterTxn(fkey);
  signalOnce(fkey);
  if (err) throw err;
}

/* M2-GUARDED-WRITES-BEGIN
   The ONLY raw internal writes in this module. Every mutation of a model by
   monacoPane flows through these three wrappers; each asserts an open
   transaction for its fkey and runs the synchronicity canary. A bare
   setValue/pushEditOperations/setEOL anywhere else in this file is a fossil
   (grep-tested in ui.monaco-core.test.mjs). */
function assertTxn(fkey) {
  if (!txnOpen.has(fkey)) {
    throw new Error(`monacoPane M2: internal write outside a transaction (${fkey})`);
  }
}
function canaryCheck(fkey, m, v0) {
  if (!modelListeners.has(fkey)) return; // seeding writes precede the listener (M1 T6)
  if (m.getVersionId() !== v0 && !suppressedSeen.has(fkey)) {
    throw new Error('monacoPane M2: onDidChangeModelContent was NOT synchronous — '
      + 'the origin-guard premise is broken (Monaco upgrade?)');
  }
  txnSyncVerified++;
}
function txnSetValue(fkey, m, text) {
  assertTxn(fkey);
  suppressedSeen.delete(fkey);
  const v0 = m.getVersionId();
  m.setValue(text); // clears the undo stack — every caller wants exactly that
  canaryCheck(fkey, m, v0);
}
function txnPushEdits(fkey, m, text) {
  assertTxn(fkey);
  suppressedSeen.delete(fkey);
  const v0 = m.getVersionId();
  m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
  canaryCheck(fkey, m, v0);
}
function txnSetEol(fkey, m, prof) {
  assertTxn(fkey);
  if (m.getEOL() === prof.eol) return; // nothing to change — no event, no canary
  suppressedSeen.delete(fkey);
  const v0 = m.getVersionId();
  m.setEOL(prof.eol === '\r\n'
    ? w.monaco.editor.EndOfLineSequence.CRLF
    : w.monaco.editor.EndOfLineSequence.LF);
  canaryCheck(fkey, m, v0);
}
/* texfix apply (S2.4/P6) — DELIBERATELY UNGUARDED (CONTRACT M2 verbatim:
   "texfix apply is deliberately UNguarded — it flows as typing"). This is
   NOT an internal write: it opens no transaction, so the live content
   listener runs the normal M2-idle pipeline — drafts/chrome/preview/undo,
   exactly what a keystroke produces — and the engine's synchronous guard
   (P6/R5) asserted range-text === find immediately before this call. It
   lives INSIDE the guarded-writes block deliberately, next to the wrappers
   it is the sanctioned exception to, so the fossil grep's block stays the
   one home of every model mutation this module performs. The engine is
   active-model-only (concern 2), so the edit always rides the attached
   editor, wrapped in undo stops — one ⌘Z reverts the whole apply. */
function texfixApplyAsTyping(m, range, text) {
  if (!editor || editor.getModel() !== m) {
    throw new Error('monacoPane texfix: apply on a non-attached model (active-model-only)');
  }
  editor.pushUndoStop();
  editor.executeEdits('texfix', [{ range, text }]);
  editor.pushUndoStop();
}
/* command edit (S2.5/P11/P19) — DELIBERATELY UNGUARDED, the
   texfixApplyAsTyping precedent above: the auto-\end skeleton and the julia
   \symbol replacement are the user's own keystroke, so the edit flows as
   typing through the normal M2-idle pipeline (drafts/chrome/preview/undo).
   Wrapped in undo stops per the §6 S2.0 spike verdict (Q2, binding): the
   executeEdits is atomic under undo — ONE ⌘Z restores the exact pre-keystroke
   buffer, the second is a no-op. Only ever called from the Enter/Tab command
   handlers, which run inside the focused editor by construction. */
function commandEditAsTyping(source, range, text, selection) {
  editor.pushUndoStop();
  editor.executeEdits(source, [{ range, text }], selection ? [selection] : undefined);
  editor.pushUndoStop();
}
/* M2-GUARDED-WRITES-END */

/* ═════════════ M2-idle data plane (P1) + the generic listener ═════════════
   The dirty bit is model.getAlternativeVersionId() !== savedAltId — O(1),
   undo-aware, EOL-immune; NEVER a byte comparison (P-EOL-4: a mixed-EOL file
   differs from disk at rest, and open+close must write nothing). */

function onIdleEdit(fkey, m) {
  const dirty = m.getAlternativeVersionId() !== savedAltId.get(fkey); // sentinel ⇒ always true
  if (dirty) {
    if (drafts[fkey] == null) draftBase[fkey] = fileCache[fkey]?.mtimeMs; // baseline at first divergence
    drafts[fkey] = serialize(m);
    modelSyncRev.set(fkey, bumpDraftRev(fkey)); // the model IS the writer — in sync (M7 T7/T8)
  } else if (!diskStale.has(fkey)) {
    delete drafts[fkey]; // clean — the normal transition
    delete draftBase[fkey];
  } else {
    // alt-clean while diskStale — the clean transition is SUPPRESSED
    // (M6 T1 / A9): the text equals the OLD disk baseline, which is still a
    // draft relative to the NEW disk; deleting it would disarm the 409 net,
    // and the chip must keep showing ⚠, never plain 'saved'. The draft is
    // RETAINED but refreshed to the on-screen text (P1 keeps drafts true on
    // every event — a concurrent M4 merge re-reading OURS, a legacy
    // fallback, a ⌘S token, and reconcileOnAttach's drafts-newer-wins probe
    // must all see what the user is looking at, never the pre-undo text: a
    // stale draft would make every same-fkey render reseed the undone text
    // back as a dirty edit); draftBase stays pinned on the OLD mtime so
    // the 409 net stays armed. Then the reconcile-fetch auto-reload leg
    // fires (AltCleanStale → Reconciling): only verified fresh disk bytes
    // may ever flip this chip to 'saved' (A9 verbatim).
    modelSyncRev.set(fkey, bumpDraftRev(fkey)); // refreshed FROM the model — in sync (M7);
    //   rev first: ui.monaco-stale pins the write→staleReconcile adjacency
    drafts[fkey] = serialize(m);
    staleReconcile(fkey, m);
  }
  signalOnce(fkey);
  washSchedule(fkey); // mzone wash trails idle typing ~120ms (R13, S1.4)
  texfixRevalidate(fkey); // S2.4 (P6): engine-debounced re-anchor + widget layout per edit
}

/* M1 T6: the generic model→drafts listener attaches strictly AFTER EOL +
   baseline seeding — no listener ever observes a seeding write. While a txn
   is open the listener mutates nothing (suppressedSeen is canary
   bookkeeping, not app state); suppression is per-event via the flag, so a
   setValue flush is covered even though setModel never happened. */
function attachContentListener(fkey, m) {
  // model-level name: ITextModel.onDidChangeContent (the editor-level alias
  // is onDidChangeModelContent) — same synchronous flush, model-scoped
  const d = m.onDidChangeContent(() => {
    if (txnOpen.has(fkey)) { suppressedSeen.add(fkey); return; }
    onIdleEdit(fkey, m);
  });
  modelListeners.set(fkey, d);
}

/* ═══════════ M1 — model creation & baseline seeding (A4, A19) ═══════════ */

/**
 * Create the model for fkey (M1 T1–T6). Returns null on T5 (no trustworthy
 * baseline AND no draft — this machine never creates a model it cannot
 * honor; the >200k/binary/loading/error renders never even call us because
 * workbench keeps those on the read-only hlText <pre> branch).
 * @param {string} fkey
 * @param {string | null} text disk baseline (fileCache bytes) or null
 * @param {number | null} mtimeMs
 * @param {string} ext
 * @returns {any} ITextModel | null
 */
function createFor(fkey, text, mtimeMs, ext) {
  if (models.has(fkey)) throw new Error(`monacoPane M1: duplicate creation for ${fkey}`);
  const monaco = w.monaco;
  const draft = drafts[fkey]; // read-only: creation mutates none of
  //                             drafts/draftBase/diskStale/fileCache
  const trustworthy = typeof text === 'string' && Number.isFinite(mtimeMs);
  if (!trustworthy && draft == null) return null;                    // T5
  const baseText = trustworthy ? text : draft;                       // T4 seeds from the draft
  const prof = eolProfile(baseText);                                 // P-EOL-2: BEFORE createModel
  const uri = monaco.Uri.parse('cp:' + encodeURIComponent(fkey));    // tolerates :: and extpin fkeys
  let m = null;
  runTxn(fkey, 'seedCreate', () => {
    m = monaco.editor.createModel(baseText, langFor(ext), uri);
    // A18: two-space is CONTRACTUAL. detectIndentation:false on the editor
    // covers attach-time sniffing; this model-level pin makes creation
    // deterministic too — a 4-space-indented file must never flip the
    // resolved tabSize/insertSpaces. (No content event — outside the guard.)
    m.updateOptions({ tabSize: 2, insertSpaces: true });
    models.set(fkey, m);
    eolProfiles.set(fkey, prof);
    txnSetEol(fkey, m, prof); // A19: EOL fixed here for the model's lifetime
    if (trustworthy) {
      savedAltId.set(fkey, m.getAlternativeVersionId()); // captured from disk bytes only
      baselineRaw.set(fkey, text); // the raw disk record rides with every capture
      if (draft != null && draft !== baseText) {
        // T3 — dirty at birth: baseline is the DISK text, the draft rides on
        // top as exactly ONE undoable edit. ⌘Z legitimately reaches the disk
        // baseline and truthfully reads clean; redo re-materializes the
        // draft through the normal M2-idle pipeline.
        m.pushStackElement();
        txnPushEdits(fkey, m, draft);
        m.pushStackElement();
      }
    } else {
      savedAltId.set(fkey, DIRTY_SENTINEL); // T4 — never a falsely-clean chip;
      //                                       saveFile's finite-baseline refusal guards the PUT
    }
    attachContentListener(fkey, m); // T6 — strictly after seeding
  }); // ← the txn commit emits the creation's exactly-one chrome signal
  return m;
}

// Reconcile retained models against authoritative drafts and disk bytes.
function reconcileOnAttach(fkey, m, text, mtimeMs) {
  if (inComposition && fkey === activeFkey) return; // A7 belt: never a destructive
  //                                                   write under a live composition
  const draft = drafts[fkey];
  const trustworthy = typeof text === 'string' && Number.isFinite(mtimeMs);
  const sentinel = savedAltId.get(fkey) === DIRTY_SENTINEL;
  try {
    if (draft != null) {
      const mtext = serialize(m); // one serialization per pass (a storm-path hot spot)
      // an observed divergence IS a newer external (legacy) materialization:
      // account for the revision at the moment of observation (M7 T8 / A4)
      if (mtext !== draft) bumpDraftRev(fkey);
      if (trustworthy && (sentinel || mtext !== draft)) {
        // newer drafts[k] ALWAYS wins (A4) — and a sentinel model whose
        // fileCache later resolved re-seeds onto the real baseline (M1 T7):
        // disk text beneath (undo cleared), draft back as ONE dirty edit.
        runTxn(fkey, 'draftReconcile', () => {
          txnSetValue(fkey, m, text);
          const prof = eolProfile(text);
          eolProfiles.set(fkey, prof);
          txnSetEol(fkey, m, prof);
          savedAltId.set(fkey, m.getAlternativeVersionId());
          baselineRaw.set(fkey, text);
          if (draft !== text) {
            m.pushStackElement();
            txnPushEdits(fkey, m, draft);
            m.pushStackElement();
          }
        });
      } else if (!trustworthy && mtext !== draft) {
        // T8 with NO trustworthy baseline (cache mid-load/error): the
        // authoritative draft must still win — M1 T4 shape: materialize it
        // over the stale buffer, savedAltId falls to DIRTY_SENTINEL (never a
        // falsely-clean chip; beginSave's finite-baseline refusal guards the
        // PUT). Without this leg a retained stale model would HIDE the
        // legacy draft — the exact lie T8's Holds forbids.
        runTxn(fkey, 'draftReconcile', () => {
          txnSetValue(fkey, m, draft);
          savedAltId.set(fkey, DIRTY_SENTINEL);
          baselineRaw.delete(fkey);
        });
      }
      // every exit of this branch leaves model text === drafts[k] — record it
      modelSyncRev.set(fkey, draftRev.get(fkey) || 0);
      return;
    }
    const alt = m.getAlternativeVersionId();
    if (!trustworthy) return;
    if (!sentinel && text === baselineRaw.get(fkey)) return;
    // ^ raw-to-raw short-circuit BEFORE any serialize comparison: the incoming
    //   text IS the disk record savedAltId was captured from, so there is
    //   nothing to reconcile. serialize-vs-raw can never match for a non-pure
    //   file (A19 normalization) — without this guard every background
    //   renderWB fired a spurious cleanReload on a clean mixed-EOL file
    //   (caret teleported to (1,1), undo/redo destroyed: the S1.2 churn bug).
    //   A genuine disk change differs raw-to-raw and falls through.
    if (serialize(m) === text) {
      // text already matches disk — realign the bookkeeping if a save landed
      // outside M3 (since S2.1's files.saveFile re-anchor that means a
      // LEGACY-side save before an impl handoff — the M7 T8 detector's
      // realign, no longer load-bearing for same-impl saves): model text IS
      // the disk bytes, so the capture source is legal per the savedAltId
      // invariant. No model write.
      if (alt !== savedAltId.get(fkey)) { savedAltId.set(fkey, alt); baselineRaw.set(fkey, text); }
      return;
    }
    // clean (or draftless-dirty, i.e. saved/reverted elsewhere) model whose
    // text diverged from disk → cleanReload: setValue, undo CLEARED (⌘Z must
    // not resurrect pre-reload text as a dirty draft — C1-MF3), fresh capture
    runTxn(fkey, 'cleanReload', () => {
      txnSetValue(fkey, m, text);
      const prof = eolProfile(text);
      eolProfiles.set(fkey, prof);
      txnSetEol(fkey, m, prof);
      savedAltId.set(fkey, m.getAlternativeVersionId());
      baselineRaw.set(fkey, text);
    });
  } catch (e) {
    // a failed reconcile txn must never break the render — the flag is
    // already cleared (runTxn finally) and the next event/render re-runs it
    console.warn('[monaco] reconcile txn failed', fkey, e);
  }
}

/* ═══════════ frozen seams: setFile / applyExternal / dispose / … ═══════════ */

/**
 * Frozen seam (P5/P14): route the active file into the kept editor. Updates
 * the host container's #codeEditor datasets SYNCHRONOUSLY — before any
 * render returns — and, once boot is READY, runs M1 creation or the
 * reattach reconciliation and swaps the model in.
 * @param {string} fkey `${project}::${rel}` (rel may be an absolute extpin path)
 * @param {string | null} text disk baseline text (null = no trustworthy cache)
 * @param {{ mtimeMs?: number | null, ext?: string, readOnly?: boolean }} [opts]
 * @returns {void}
 */
export function setFile(fkey, text, opts = {}) {
  pendingFile = {
    fkey,
    text: typeof text === 'string' ? text : null,
    mtimeMs: Number.isFinite(opts.mtimeMs) ? opts.mtimeMs : null,
    ext: String(opts.ext || ''),
    readOnly: !!opts.readOnly,
  };
  if (host) {
    host.dataset.fkey = fkey;
    host.dataset.rel = relOfFkey(fkey);
    host.dataset.ext = pendingFile.ext;
  }
  if (bootState === 'READY' && editor) applyFile();
}

function applyFile() {
  if (!pendingFile || !editor || bootState !== 'READY') return;
  const { fkey, text, mtimeMs, ext, readOnly } = pendingFile;
  const wasParked = !!(host && park && host.parentElement === park);
  if (activeFkey && activeFkey !== fkey) saveViewStateFor(activeFkey);
  // S2.4: widgets are per-editor-view — release the departing file's texfix
  // host BEFORE the model switch so no widget dangles across setModel; the
  // arm at the end of this apply re-arms against the new active model
  if (tfx && tfx.fkey !== fkey) texfixRelease();
  let m = models.get(fkey);
  if (!m) {
    m = createFor(fkey, text, mtimeMs, ext); // M1
    if (!m) return; // T5 — the read-only branch owns this render
  } else {
    reconcileOnAttach(fkey, m, text, mtimeMs);
  }
  const switched = editor.getModel() !== m;
  if (switched) editor.setModel(m);
  if (switched || wasParked) {
    // restore ONLY on a genuine (re)attach — restoring on every same-fkey
    // background render would yank the caret/scroll mid-typing (I2)
    const vs = viewStates.get(fkey);
    if (vs) editor.restoreViewState(vs);
    // re-arm the wash on a genuine (re)attach too (blueprint §5 model
    // lifecycle: "re-arm per-editor state … mzone wash" on setModel); the
    // decorations are model-owned, so same-fkey background renders skip this
    washRearm(fkey);
    // S2.3: problems re-apply on model create/attach — rows that arrived
    // while this model was backgrounded (or before it existed) land now,
    // re-clamped against the model's live line count (concern 6)
    tintsRearm(fkey);
  }
  editor.updateOptions({
    // a live editHold outranks the caller (C2-MF5): the hold-raise render
    // routes the slot's file through here AFTER holdEditor(true) ran at the
    // .editHold class toggle — a bare !!readOnly would unpin in the same
    // render. Also covers a boot completing mid-hold: the first applyFile on
    // the fresh editor re-asserts the recorded flag.
    readOnly: editHeld || !!readOnly,
    wordWrap: WRAP_EXTS.includes(ext) ? 'on' : 'off',
  });
  activeFkey = fkey;
  // M7: a (re)opened view is no orphan (T4 → T2); recency rides every
  // create/attach, and the soft cap is enforced at the same moment (T3 —
  // "on model creation (or attach), when the clean-detached count exceeds
  // the cap, evict oldest-first"). The sweep never sees this fkey as a
  // candidate: it is the attached model.
  orphans.delete(fkey);
  lruTouch(fkey);
  lruSweep();
  syncEolChip(fkey);
  paintRecoveryChip(fkey); // a render mid-recovery repaints the honest chip
  texfixArm(projOf(fkey)); // S2.4: sync the engine with the newly-active model (concern 2)
  editor.layout();
}

/* P-EOL-5 disclosure: when the load profile is not pure, a persistent chip
   sits next to the save chip from load — normalization is disclosed BEFORE
   the first save (the eol-normalize ledger event lands with the M3 task).
   Re-injected on every apply because renderWB refills the foot. */
function syncEolChip(fkey) {
  const slot = document.getElementById('monacoSlot');
  const foot = slot && slot.closest('.codeHalf')?.querySelector('.cfoot');
  if (!foot) return;
  const prof = eolProfiles.get(fkey);
  let chip = foot.querySelector('#eolChip');
  if (!prof || prof.pure !== false) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    const save = foot.querySelector('#saveState');
    if (!save) return;
    chip = document.createElement('span');
    chip.id = 'eolChip';
    chip.className = 'eolChip';
    save.before(chip);
  }
  const kind = prof.eol === '\r\n' ? 'CRLF' : 'LF';
  const done = eolNormalized.get(fkey);
  // the disclosure is on screen from LOAD; after the first save it states the
  // fact instead of the intent (P-EOL-5 — the load-time profile is kept, so
  // the disclosure survives every later render of this model)
  chip.textContent = done
    ? `EOL: normalized to ${done.to} on save (mixed on disk)`
    : `EOL: mixed → will normalize to ${kind} on save`;
  chip.title = done
    ? 'this file mixed line endings on disk; the editor normalized them at open and the save wrote '
      + 'the normalized form (the write is a change-history entry like any other — rewindable)'
    : 'this file mixes line endings on disk; the editor normalized them at open — '
      + 'the first save writes the normalized form (disclosed here, recorded in the ledger, rewindable)';
}

/**
 * Frozen seam (A4): apply an external change to fkey's model — background
 * and orphan models included, never waiting for a renderWB. Reasons are the
 * CLOSED set {cleanReload, mergeRebase, recoveryReload, draftReconcile}; an
 * unknown reason throws (fossil/exhaustiveness guard). Payloads:
 *   cleanReload / recoveryReload — string newText (+ opts.mtimeMs)
 *   mergeRebase — { theirs, merged } (A1 history rebase: THEIRS becomes a
 *     real model state with undo cleared; one MERGED edit only if it differs)
 *   draftReconcile — string disk baseline; drafts[fkey] (if any) wins on top
 * Bookkeeping of fileCache/drafts/draftBase/diskStale stays with the calling
 * machine (M4/M5, their S1 tasks) — this runs the model-side txn.
 * @param {string} fkey
 * @param {string | { theirs: string, merged: string }} payload
 * @param {string} reason
 * @returns {boolean} true when a model existed (the txn ran, or a cleanReload
 *   found the bytes already reconciled — the M4 T3 idempotence no-op below)
 */
export function applyExternal(fkey, payload, reason) {
  if (!['cleanReload', 'mergeRebase', 'recoveryReload', 'draftReconcile'].includes(reason)) {
    throw new Error(`monacoPane: unknown applyExternal reason '${reason}'`);
  }
  const m = models.get(fkey);
  if (!m) return false; // no model — store maps are already the authority
  if (reason === 'mergeRebase') {
    const { theirs, merged } = /** @type {{theirs: string, merged: string}} */ (payload);
    // M4 T5 best-effort caret (P3's felt continuity): capture position +
    // scroll BEFORE the txn and restore them CLAMPED after — only when this
    // model is the one attached to the kept editor. A background merge (A4 /
    // M7 T6) runs the txn with live===false and must never move the visible
    // editor's caret/scroll/focus. Correctness over caret: the txn is
    // unconditional; the restore is advisory (setPosition validates → clamps
    // into MERGED, setScrollTop clamps to the new scroll range).
    const live = !!editor && editor.getModel() === m;
    const pos = live ? editor.getPosition() : null;
    const scrollTop = live ? editor.getScrollTop() : 0;
    runTxn(fkey, 'mergeRebase', () => {
      txnSetValue(fkey, m, theirs); // undo cleared — pre-merge OURS unreachable (A1)
      savedAltId.set(fkey, m.getAlternativeVersionId()); // THEIRS is a real model state
      baselineRaw.set(fkey, theirs); // THEIRS is the new disk record (M4)
      if (merged !== theirs) {
        m.pushStackElement();
        txnPushEdits(fkey, m, merged); // the ONLY undoable step: THEIRS → MERGED
        m.pushStackElement();
      }
    });
    if (pos) {
      editor.setPosition(pos); // validated — never throws on a shrunk document
      editor.setScrollTop(scrollTop);
    }
  } else if (reason === 'draftReconcile') {
    reconcileOnAttach(fkey, m, String(payload), fileCache[fkey]?.mtimeMs ?? Date.now());
  } else {
    const text = String(payload);
    // M4 T3 idempotence (cleanReload ONLY): when the payload already IS this
    // model's raw baseline on a clean, draftless model there is nothing to
    // reload — the attached fkey's render just reconciled these bytes
    // (reconcileOnAttach's raw-to-raw rule), and re-running the txn would
    // clear live undo and burn a signal for a no-op. Raw-to-raw on purpose:
    // serialize(m) can never equal a non-pure disk text (A19), baselineRaw
    // can. recoveryReload stays unconditional — M5 relies on its txn to
    // capture savedAltId from the fresh bytes inside the atomic commit (and
    // a mid-recovery model is altId-dirty anyway). A DIRTY_SENTINEL
    // savedAltId can never equal a real altId, so a sentinel model always
    // falls through to the txn.
    if (reason === 'cleanReload' && drafts[fkey] == null
      && baselineRaw.get(fkey) === text
      && m.getAlternativeVersionId() === savedAltId.get(fkey)) {
      return true; // the model already holds exactly these bytes
    }
    runTxn(fkey, reason, () => {
      txnSetValue(fkey, m, text); // undo cleared (reconciliation rule)
      const prof = eolProfile(text);
      eolProfiles.set(fkey, prof);
      txnSetEol(fkey, m, prof);
      savedAltId.set(fkey, m.getAlternativeVersionId());
      baselineRaw.set(fkey, text);
    });
  }
  return true;
}

/* ═══════════════ M3 — save begin/commit tokens (A3) ═══════════════
   The A3 seam pair replaces text(fkey)+markSaved(fkey,mtimeMs). This module
   is the save DRIVER: it speaks the identical wire protocol files.saveFile
   speaks — PUT {content, baseMtimeMs} to /artifact (or {path, content,
   baseMtimeMs} to the pin-grant /api/extfile route), response mtime
   header-first — and since S2.1 files.saveFile itself re-anchors onto this
   queue (the monaco+model gate at its top; caller swap, no protocol change).

   The two structural rules, both defects the audit found in the old code:
     · token capture is SYNCHRONOUS — nothing awaits between reading
       drafts/altId and dispatching the PUT, so the body is token.text by
       construction and token.altId truly describes the bytes on the wire;
     · after ANY 200, savedAltId[k] := token.altId — the altId OF THE PUT
       BYTES, never the current altId (otherwise undoing mid-flight typing
       never reads clean: the permanently-amber chip).
   At most one PUT per fkey is ever in flight; a second ⌘S while one is live
   sets ONE coalesced pendingSave flag (never a queue of N), and a response
   whose seq is no longer the latest issued is dropped with a log line and
   zero mutation (dispose / handoff / 409-recovery all retire seqs). */

const saveSeq = new Map();       // fkey → last issued token seq (monotonic)
const inFlight = new Map();      // fkey → the live token — at most ONE per fkey
const pendingSave = new Set();   // fkey → the single coalesced follow-up (T7)
const saveWaiters = new Map();   // fkey → [resolve…] — queue-idle promises (⌘⏎)
const recovering = new Set();    // fkeys between M5 destruction and reload commit
const eolNormalized = new Map(); // fkey → {from, to, at} — the P-EOL-5 record
const saveLog = [];              // ordering proof + A16 soak-log seed

function logSave(fkey, ev, detail) {
  saveLog.push(Object.assign({ t: Date.now(), fkey, ev }, detail || {}));
  if (saveLog.length > 200) saveLog.shift();
}

/**
 * Frozen seam (A3, M3 T1/T2): capture the save token for fkey.
 * SYNCHRONOUS BY CONTRACT — the caller MUST dispatch the PUT with token.text
 * without an intervening await. Returns null when there is nothing to save
 * (no draft) or when the save is refused: no finite baseline (cache
 * mid-load/error) or a DIRTY_SENTINEL model whose disk bytes never resolved —
 * saving then could overwrite a newer on-disk version with the 409 guard
 * disarmed, so files.js's guard + toast are ported verbatim (T2).
 * @param {string} fkey
 * @returns {{fkey: string, project: string, rel: string, text: string,
 *            baseMtimeMs: number, altId: number | null, seq: number} | null}
 */
export function beginSave(fkey) {
  const draft = drafts[fkey];
  if (draft == null) return null; // nothing unsaved (files.js:219 verbatim)
  const base = draftBase[fkey] ?? fileCache[fkey]?.mtimeMs;
  if (!Number.isFinite(base) || savedAltId.get(fkey) === DIRTY_SENTINEL) {
    toast('cannot save yet — file state unknown, reopen the tab first');
    logSave(fkey, 'refused', { reason: 'no-finite-baseline' });
    return null;
  }
  const m = models.get(fkey) || null;
  // Close the open undo element at the save boundary. Without this the A3
  // gate is unachievable BY CONSTRUCTION: Monaco coalesces a continuous
  // typing run into ONE undo element, so a ⌘Z after "type A · ⌘S · type B"
  // would remove A *and* B and could never land on token.altId — the saved
  // state would be unreachable and the chip permanently amber. This mutates
  // no text (no content event, no version-id change: altId below is
  // identical either side of it), it only makes the saved state a real undo
  // stop — the same thing every editor does on save.
  if (m) m.pushStackElement();
  const seq = (saveSeq.get(fkey) || 0) + 1;
  saveSeq.set(fkey, seq);
  const token = {
    fkey,
    project: projOf(fkey),
    rel: relOfFkey(fkey),
    // P-EOL-1: the save path serializes with TextDefined + preserveBOM. The
    // M2-idle pipeline keeps drafts[k] === serialize(m) after every event, so
    // this is the same bytes — read from the model because the model is what
    // the user is looking at, and altId below describes exactly this text.
    text: m ? serialize(m) : draft,
    baseMtimeMs: base,
    altId: m ? m.getAlternativeVersionId() : null,
    seq,
  };
  logSave(fkey, 'begin', { seq, bytes: token.text.length, base });
  return token;
}

/**
 * Frozen seam (A3, M3 T4a/T4b + the stale-seq guard): apply a 200 for the
 * token. T4a (current altId AND value both still match the token) → clean:
 * drafts/draftBase deleted. Every other 200 → rebase: the CURRENT text is
 * materialized as the draft and rebased onto the response mtime. Both paths
 * capture savedAltId := token.altId.
 * @param {string} fkey
 * @param {*} token the token beginSave returned
 * @param {number | null} responseMtime the save response's mtimeMs
 * @returns {'clean' | 'rebase' | 'stale'}
 */
export function commitSave(fkey, token, responseMtime) {
  if (!token || saveSeq.get(fkey) !== token.seq) {
    console.warn('[monaco] stale save response dropped — seq no longer expected', fkey,
      { got: token && token.seq, expected: saveSeq.get(fkey) });
    logSave(fkey, 'stale-drop', { seq: token && token.seq });
    return 'stale'; // zero mutation: dispose / handoff / recovery already moved on
  }
  const m = models.get(fkey) || null;
  const mtime = Number.isFinite(responseMtime) ? Number(responseMtime) : null;
  const cur = m ? serialize(m) : drafts[fkey];
  const altOk = !m || token.altId == null || m.getAlternativeVersionId() === token.altId;
  // our write IS the disk state now (fileCache := exactly the PUT bytes)
  fileCache[fkey] = { text: token.text, mtimeMs: mtime };
  diskStale.delete(fkey);
  // ── the A3 correction, on EVERY 200 path: the altId of the PUT BYTES ──
  if (m && token.altId != null) savedAltId.set(fkey, token.altId);
  baselineRaw.set(fkey, token.text); // …and the raw disk record rides with it
  const clean = altOk && cur === token.text;
  if (clean) {
    delete drafts[fkey]; // T4a — nothing landed while the save was in flight
    delete draftBase[fkey];
  } else {
    drafts[fkey] = cur;      // T4b — mid-flight keystrokes survive…
    draftBase[fkey] = mtime; // …rebased onto our own write (files.js:277-281)
    if (models.has(fkey)) modelSyncRev.set(fkey, bumpDraftRev(fkey)); // cur read from the model (M7)
  }
  noteEolNormalized(fkey, token);
  logSave(fkey, clean ? 'commit-clean' : 'commit-rebase', { seq: token.seq, mtime });
  signalOnce(fkey);
  return clean ? 'clean' : 'rebase';
}

/* P-EOL-5 disclosure: the first save of a file that loaded with MIXED line
   endings writes the normalized form. The disclosure chip has been on screen
   since load (syncEolChip); at the moment it becomes fact we keep a local
   record and flip the chip to past tense, plus one toast.
   S2 RESIDUAL: the blueprint wants this in the rewindable ledger. No unbilled
   route records editor-side facts today (/api/decisions is the user's own
   decision log — wrong surface; the time/token ledger is session-scoped), so
   S2 adds the event when the save path moves server-side. */
function noteEolNormalized(fkey, token) {
  const prof = eolProfiles.get(fkey);
  if (!prof || prof.pure !== false || eolNormalized.has(fkey)) return;
  const to = prof.eol === '\r\n' ? 'CRLF' : 'LF';
  eolNormalized.set(fkey, { from: 'mixed', to, at: Date.now() });
  logSave(fkey, 'eol-normalized', { to, bytes: token.text.length });
  toast(`line endings normalized to ${to} on save (${token.rel} mixed them on disk)`);
  syncEolChip(fkey);
}

function putUrl(token) {
  // external pins save through their grant route (the same allowlist the
  // session writes with); in-root files through /artifact — files.js verbatim
  return isExtRel(token.rel)
    ? `/api/extfile/${enc(token.project)}/${enc(curTask(token.project)?.id || '')}`
    : artifactUrl(token.project, token.rel);
}

function putBody(token) {
  return isExtRel(token.rel)
    ? JSON.stringify({ path: token.rel, content: token.text, baseMtimeMs: token.baseMtimeMs })
    : JSON.stringify({ content: token.text, baseMtimeMs: token.baseMtimeMs });
}

/* the save response's mtime: x-mtime-ms header first (precise, and the shape
   every other route uses), the JSON body second */
function respMtime(res, body) {
  const h = Number(res.headers.get('x-mtime-ms'));
  if (Number.isFinite(h) && h > 0) return h;
  return Number.isFinite(body && body.mtimeMs) ? body.mtimeMs : null;
}

/* T1: capture + dispatch in ONE synchronous block — beginSave() and fetch()
   with nothing awaited between them. */
function startSave(fkey) {
  const token = beginSave(fkey);
  if (!token) { settleSave(fkey, { clearPending: true }); return; }
  inFlight.set(fkey, token);
  const body = putBody(token); // token.text by construction
  let p;
  try {
    p = fetch(putUrl(token), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) { // a synchronous throw (bad URL) is a T6 too
    onSaveError(fkey, token, err);
    return;
  }
  p.then((res) => onSaveResponse(fkey, token, res), (err) => onSaveError(fkey, token, err));
}

async function onSaveResponse(fkey, token, res) {
  if (res.status === 409) {
    logSave(fkey, 'http-409', { seq: token.seq });
    await conflict409(fkey, token); // T5 → M5; drafts are NEVER touched here
    settleSave(fkey, { clearPending: true }); // recovery never auto-fires a save
    return;
  }
  if (!res.ok) {
    let msg = `save failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON body */ }
    toast(msg);
    logSave(fkey, 'http-error', { seq: token.seq, status: res.status });
    settleSave(fkey); // T6 — token discarded, drafts untouched, still Dirty
    return;
  }
  let body = {};
  try { body = await res.json(); } catch { /* 2xx with no JSON */ }
  commitSave(fkey, token, respMtime(res, body));
  toast('saved ' + token.rel);
  settleSave(fkey);
}

function onSaveError(fkey, token, err) {
  toast('save failed: ' + ((err && err.message) || err));
  logSave(fkey, 'net-error', { seq: token.seq });
  settleSave(fkey); // T6 — the seq is consumed; the next ⌘S issues a fresh one
}

/* T7/T8: the queue is one flag deep. On settle, a pending request starts a
   FRESH token (new text/altId/seq) only while the file is still dirty. */
function settleSave(fkey, opts = {}) {
  inFlight.delete(fkey);
  if (opts.clearPending) pendingSave.delete(fkey);
  if (pendingSave.has(fkey)) {
    pendingSave.delete(fkey);
    if (drafts[fkey] != null) { startSave(fkey); return; }
  }
  const ws = saveWaiters.get(fkey);
  saveWaiters.delete(fkey);
  if (ws) for (const r of ws) { try { r(); } catch (e) { console.warn('[monaco] save waiter failed', e); } }
}

function waitSaveIdle(fkey) {
  if (!inFlight.has(fkey) && !pendingSave.has(fkey)) return Promise.resolve();
  return new Promise((res) => {
    const arr = saveWaiters.get(fkey) || [];
    arr.push(res);
    saveWaiters.set(fkey, arr);
  });
}

/**
 * ⌘S / save-chip click / ▶'s save-first: run the M3 queue for fkey.
 * Coalesces onto the in-flight save (T7) instead of ever issuing a second
 * concurrent PUT; the returned promise settles when the fkey's queue is idle.
 * @param {string} fkey
 * @returns {Promise<void>}
 */
export function requestSave(fkey) {
  if (!fkey) return Promise.resolve();
  if (inFlight.has(fkey)) pendingSave.add(fkey); // T7 — one flag, never a queue
  else startSave(fkey);
  return waitSaveIdle(fkey);
}

/**
 * ⌘⏎ (P13): save-first, then compile — the compile step waits for the
 * COALESCED save to commit, so runFile never compiles bytes older than the
 * last commitSave for this fkey. Bounded: mid-flight typing gets one more
 * round through the same queue; a refusal/409/network failure leaves the
 * draft in place and the run is skipped (files.js's "save failed — don't run
 * the stale on-disk version" rule).
 * @param {string} fkey
 * @returns {Promise<void>}
 */
export async function runAfterSave(fkey) {
  if (!fkey) return;
  for (let i = 0; i < 3 && drafts[fkey] != null; i++) {
    const before = saveSeq.get(fkey) || 0;
    await requestSave(fkey);
    if ((saveSeq.get(fkey) || 0) === before) break; // refused — no token issued
  }
  if (drafts[fkey] != null) return; // the save did not land — never run stale bytes
  await runFile(projOf(fkey), relOfFkey(fkey));
}

/* ═══════════════ M5 — 409 recovery ═══════════════
   Entered from M3 T5 with the retired token. The clipboard write must SUCCEED
   before any destructive step (I6): the affirmative confirm alone destroys
   nothing. The prompt is the in-app confirmBox, not native confirm() —
   Chrome silences a repeated native confirm ("prevent this page from creating
   more dialogs"), which would break M5's "cancel is infinitely repeatable"
   invariant outright. */

async function conflict409(fkey, token) {
  pendingSave.delete(fkey);
  // retire the token: a late 200 for it (or any queued save) must be inert
  saveSeq.set(fkey, (saveSeq.get(fkey) || 0) + 1);
  const project = projOf(fkey);
  const rel = relOfFkey(fkey);
  const ok = await confirmBox(
    `<b>${esc(rel)}</b> changed on disk (a session or another machine edited it).<br><br>`
    + 'Load the NEW version? Your unsaved text is copied to the clipboard first.<br>'
    + 'Cancel keeps your draft (saving will keep failing until you reload).',
    'Load new version');
  if (!ok) { logSave(fkey, 'recovery-cancel'); return; } // T1 — a total no-op
  const m = models.get(fkey) || null;
  // T2: the payload is the CURRENT text at ACCEPT time — a superset of
  // token.text when the user kept typing after ⌘S (the pre-Monaco gap: those
  // keystrokes were never on the clipboard, yet drafts[k] was destroyed)
  const payload = m ? serialize(m) : drafts[fkey];
  if (payload == null) { logSave(fkey, 'recovery-nodraft'); return; }
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(payload);
      copied = true;
    }
  } catch { copied = false; /* denied, or absent over plain-http remote access */ }
  if (!copied) { // T3 (I6) — NOTHING is deleted on an unverified clipboard
    toast('clipboard unavailable — draft kept; copy your text manually, then close the tab to reload');
    logSave(fkey, 'recovery-clipboard-failed');
    return;
  }
  // ── T4: the ONLY destruction path in this module. Every delete below is
  //    dominated by the verified clipboard write above. ──
  delete drafts[fkey];
  delete draftBase[fkey];
  delete fileCache[fkey];
  diskStale.delete(fkey);
  pendingSave.delete(fkey); // a queued coalesced save must NOT re-conflict
  recovering.add(fkey);     // …and the chip may not read 'saved' until the
  signalOnce(fkey);         //    fresh bytes are actually in the model
  logSave(fkey, 'recovery-destroy');
  await recoveryReload(fkey, project, rel);
}

async function recoveryReload(fkey, project, rel) {
  await fetchFileInto(fkey, project, rel); // P5 fetch contract (GET, unbilled)
  const c = fileCache[fkey];
  const good = !!c && !c.error && !c.loading && !c.truncated
    && typeof c.text === 'string' && Number.isFinite(c.mtimeMs);
  if (!good) {
    // T6 — no trustworthy fresh text. fileCache stays ABSENT so the next open
    // refetches and M1 re-runs; the model can never read clean meanwhile.
    if (!c || c.error || c.loading) delete fileCache[fkey];
    if (models.has(fkey)) savedAltId.set(fkey, DIRTY_SENTINEL);
    recovering.delete(fkey);
    logSave(fkey, 'recovery-fetch-failed');
    toast('could not reload from disk — your draft is on the clipboard; reopen the tab to retry');
    // no chrome signal here: with the draft gone the chip would read 'saved'
    // over stale text. The render below rebuilds the foot honestly (loading /
    // read-only branch), and a hidden view's next render does the same.
    if (ui.view === project) renderWB(project);
    return;
  }
  // T5 — the M2 recoveryReload txn: setValue, undo CLEARED (⌘Z must not
  // resurrect pre-conflict text as a dirty draft), setEOL, and savedAltId
  // captured from the fresh disk bytes INSIDE the atomic commit. Works on a
  // background/unattached model too (A4/M7 T6).
  const applied = applyExternal(fkey, c.text, 'recoveryReload');
  recovering.delete(fkey);
  logSave(fkey, 'recovery-reload', { mtime: c.mtimeMs, applied });
  // applyExternal's txn already signalled with the recovery chip still armed
  // (and without a model there was no signal at all) — repaint the truth once
  signalOnce(fkey);
  toast('reloaded from disk — your draft is on the clipboard');
  if (ui.view === project) renderWB(project);
}

/* the chip may show 'saved' only after the fresh disk bytes are in the model
   (M5 invariant). editorChrome is drafts-driven and drafts are already gone
   during the reload, so every signal — and every render — repaints over it. */
function paintRecoveryChip(fkey) {
  if (!recovering.has(fkey)) return;
  const root = document.getElementById('v-' + projOf(fkey));
  const ed = root && root.querySelector('#codeEditor');
  if (!ed || ed.dataset.fkey !== fkey) return;
  const ss = root.querySelector('#saveState');
  if (!ss) return;
  ss.className = 'saveChip stale';
  ss.title = 'save conflict — your draft is on the clipboard; reloading the disk version…';
  ss.innerHTML = '<i></i>reloading…';
}

/* ═══════════════ M6 — disk-stale undo (A9) ═══════════════
   Entered from onIdleEdit's suppressed-clean branch: diskStale[k] is set (an
   M4 bail pinned ⚠) and an undo landed the model back on savedAltId
   (AltCleanStale). The altId bit alone would delete the draft and read
   'saved' while the on-screen text is the OLD disk version — the A9 lie. The
   suppression half lives in onIdleEdit; this is the reconcile-fetch
   auto-reload leg (M6 T1→T3): fetch the CURRENT disk (GET, unbilled — the
   same route shape M4's THEIRS fetch and M5's recovery reload read) and
   install it through one atomic M2 recoveryReload txn. Deliberately NOT
   fetchFileInto: that writes fileCache unconditionally, and fileCache is
   M4's frozen BASE while a draft exists — every leg but T3 must leave it
   byte-untouched (T4's fetched bytes are DISCARDED, T5 is non-destructive). */

const staleFlights = new Map(); // fkey → {rev} — single-flight per fkey; rev =
//   getAlternativeVersionId() at fetch start (A20 revision-check discipline)

/* M6 T1/T6: fire (or coalesce onto) the reconcile fetch. Called on EVERY
   suppressed-clean event, so a type-then-undo shimmy during the flight
   re-lands here without stacking a second GET (single-flight), and a
   StaleHeld/discard survivor re-arms on the NEXT alt-clean event — the
   natural retry (T6: infinitely retryable, never degrades). */
function staleReconcile(fkey, m) {
  if (staleFlights.has(fkey)) return; // one flight per fkey, ever
  const flight = { rev: m.getAlternativeVersionId() }; // recorded at fetch start (A20)
  staleFlights.set(fkey, flight);
  logSave(fkey, 'stale-fetch', { rev: flight.rev });
  staleFetchFresh(fkey, flight);
}

async function staleFetchFresh(fkey, flight) {
  const project = projOf(fkey);
  const rel = relOfFkey(fkey);
  let fresh = null;
  let mtime = null;
  try {
    const url = isExtRel(rel)
      ? `/api/extfile/${enc(project)}/${enc(curTask(project)?.id || '')}?path=${enc(rel)}`
      : artifactUrl(project, rel);
    const res = await fetch(url); // GET only — no billed route, no server mutation
    if (res.ok) {
      fresh = await res.text();
      mtime = Number(res.headers.get('x-mtime-ms'))
        || Date.parse(res.headers.get('last-modified') || '') || null;
    }
  } catch { /* net error — the T5 leg below */ }
  if (staleFlights.get(fkey) !== flight) return; // superseded: dispose/reboot
  //   retired the flight mid-fetch — a NEW model's altIds must never be
  //   compared against this record (A20 cancellation discipline)
  staleFlights.delete(fkey); // settle FIRST — every leg below may re-arm
  const m = models.get(fkey);
  if (!m) { logSave(fkey, 'stale-discard', { why: 'no-model' }); return; }
  // T5 — fetch failed / untrustworthy (M4 T2's own trust bar: finite mtime,
  // ≤200k, no NUL — only a fresh, VERIFIED disk version may become the saved
  // baseline while stale, A9 verbatim) → StaleHeld: ⚠ retained, drafts
  // retained, savedAltId untouched, fileCache untouched. Non-destructive;
  // the next alt-clean event (or a file:changed re-entering M4 through
  // mergeRuns — serialization keeps the machines from interleaving) re-arms.
  if (typeof fresh !== 'string' || !Number.isFinite(mtime)
    || fresh.length > 200000 || fresh.includes('\u0000')) {
    logSave(fkey, 'stale-held');
    return;
  }
  // T4 — revision moved (typing/redo landed while fetching): discard the
  // fetched bytes silently (A20), remain StaleDirty — text is never replaced
  // under a moving caret. altId on purpose, not versionId: a type-then-undo
  // round trip DURING the flight restores the recorded altId and therefore
  // the recorded TEXT (altId is undo-aware), so applying is still truthful.
  if (m.getAlternativeVersionId() !== flight.rev) {
    logSave(fkey, 'stale-discard', { why: 'revision' });
    return;
  }
  // …and cleared meanwhile (an M4 merge/dissolve or a save-200 committed
  // while we fetched — each clears diskStale inside its own machine): M6
  // already exited; installing now would double-commit
  if (!diskStale.has(fkey)) {
    logSave(fkey, 'stale-discard', { why: 'cleared' });
    return;
  }
  // T3 — the M2 recoveryReload-flavor txn: ONE atomic commit installs the
  // verified fresh bytes AND retires the suppressed-clean bookkeeping. This
  // is the only place drafts[k] may die while diskStale is set (M6 invariant
  // 2), and diskStale clears in the same commit — so the txn's exactly-one
  // signal paints 'saved' truthfully, and no frame between the undo and this
  // commit ever showed plain 'saved' (invariant 1: the chip never lies).
  runTxn(fkey, 'recoveryReload', () => {
    if (serialize(m) !== fresh) {
      // undo CLEARED (reconciliation rule applied to the recovery flavor):
      // nothing of the user's is lost — their content equals the old disk
      // baseline (alt-clean) — and redo must not resurrect the stale
      // baseline as a dirty draft (M6 invariant 6)
      txnSetValue(fkey, m, fresh);
      const prof = eolProfile(fresh);
      eolProfiles.set(fkey, prof);
      txnSetEol(fkey, m, prof);
    }
    // else: the external change round-tripped back — the model text IS the
    // fresh disk bytes; capture with NO write and the undo stack intact (T3)
    savedAltId.set(fkey, m.getAlternativeVersionId()); // captured from disk bytes only
    baselineRaw.set(fkey, fresh); // the raw disk record rides with the capture
    fileCache[fkey] = { text: fresh, mtimeMs: mtime }; // commit: fresh IS the disk record
    diskStale.delete(fkey);
    delete drafts[fkey];
    delete draftBase[fkey];
  });
  logSave(fkey, 'stale-reload', { mtime, rev: flight.rev });
}

/**
 * Frozen seam: bank the live view state (caret/scroll/selection) for fkey —
 * called before every detach/park; restored on the next genuine attach.
 * @param {string} fkey
 * @returns {void}
 */
export function saveViewStateFor(fkey) {
  if (!editor || !fkey) return;
  const m = models.get(fkey);
  if (m && editor.getModel() === m) viewStates.set(fkey, editor.saveViewState());
}

// Model lifecycle: clean detached models may be evicted; dirty text and
// draft/model revisions remain independent of the live editor instance.

/** @param {string} fkey @returns {number} the new (monotonic per-fkey) draft revision */
function bumpDraftRev(fkey) {
  const r = (draftRev.get(fkey) || 0) + 1;
  draftRev.set(fkey, r);
  return r;
}

function lruTouch(fkey) { lruSeq.set(fkey, ++lruTick); }

/* the T3 candidate predicate — COMPUTED, never stored (A10): clean AND
   detached. The belts exclude models a machine holds mid-flight even in a
   momentarily alt-clean frame: an in-flight/queued M3 save (its commit must
   land on a live model), an M5 recovery window (drafts are deliberately
   gone — disposing would strand the reload), an M6 reconcile flight (A20
   flight-identity would drop the result, wasting the retry), and a pinned
   ⚠ (diskStale ⇒ the retained draft is the 409 net — those models read
   dirty anyway; the check is a belt). */
function lruEligible(fkey, m) {
  if (editor && editor.getModel() === m) return false;                    // attached (Active*)
  if (drafts[fkey] != null) return false;                                 // dirty — NEVER a candidate
  if (m.getAlternativeVersionId() !== savedAltId.get(fkey)) return false; // dirty bit (sentinel ⇒ dirty)
  if (inFlight.has(fkey) || pendingSave.has(fkey)) return false;          // M3 mid-flight
  if (recovering.has(fkey) || staleFlights.has(fkey)) return false;       // M5/M6 mid-flight
  if (diskStale.has(fkey)) return false;                                  // ⚠ pinned (belt)
  return true;
}

/* M7 T3: the A10 soft cap. Runs on every create/attach (applyFile) and on a
   view close (noteViewClose); evicts oldest-recency-first through the total
   disposal matrix until the clean-detached census is back under the cap.
   fileCache survives (fetch-layer property) — a reopen refetch-seeds a fresh
   model; the undo history of an evicted CLEAN model is lost, documented
   behavior same as today's legacy editor. __mpLruCap is a pre-sweep test
   seam (the __mpDeadlineMs idiom) — production always runs at LRU_CAP. */
function lruSweep() {
  const cap = typeof w.__mpLruCap === 'number' ? w.__mpLruCap : LRU_CAP;
  const cands = [];
  for (const [fkey, m] of models) if (lruEligible(fkey, m)) cands.push(fkey);
  if (cands.length <= cap) return;
  cands.sort((a, b) => (lruSeq.get(a) || 0) - (lruSeq.get(b) || 0)); // oldest first
  while (cands.length > cap) {
    const fkey = cands.shift();
    const m = models.get(fkey);
    if (!m) continue;
    reallyDispose(fkey, m);
    lruEvictions++;
    logSave(fkey, 'lru-evict', soakCounters()); // the A16 soak line: census at eviction
  }
}

/**
 * Frozen seam (A10 / M7 T4): a center tab was × closed. Close is a VIEW
 * close — this disposes NOTHING: a dirty model (its draft, undo stack,
 * savedAltId) is retained until save/revert/explicit discard (OrphanDirty);
 * a clean model merely becomes an LRU-eligible orphan (OrphanTracked) for
 * the T3 sweep to reap under cap pressure. A commitSave 200 landing on a
 * dirty orphan (close raced an in-flight ⌘S) transitions it clean → LRU-
 * eligible with no code here (T5 — eligibility is computed, and M3's
 * stale-seq guard already makes a post-dispose 200 harmless). No-op without
 * a model (legacy mode, never-opened tabs, card/pdf pins).
 * @param {string} fkey
 * @returns {void}
 */
export function noteViewClose(fkey) {
  if (!models.has(fkey)) return;
  orphans.add(fkey); // observability only — never consulted by lruEligible
  lruSweep();
}

/**
 * A10/A16 soak counters — the census the soak log records and the __mp seam
 * exposes. heapMB rides performance.memory when the browser has it (Chrome;
 * cheap — no GC forced), null elsewhere. latN/latP50/latP95 fold the A16
 * input-latency ring in (§4 item 2) so the 'lru-evict' saveLog lines carry
 * the typing-latency census too — computed on read, null until a sample
 * lands (always, under legacy).
 * @returns {{models: number, dirty: number, cleanDetached: number,
 *            orphans: number, evictions: number, heapMB: number | null,
 *            latN: number, latP50: number | null, latP95: number | null}}
 */
function soakCounters() {
  let dirty = 0;
  let cleanDetached = 0;
  for (const [fkey, m] of models) {
    if (drafts[fkey] != null || m.getAlternativeVersionId() !== savedAltId.get(fkey)) dirty++;
    if (lruEligible(fkey, m)) cleanDetached++;
  }
  const mem = /** @type {any} */ (performance).memory;
  const lat = latStats();
  return {
    models: models.size,
    dirty,
    cleanDetached,
    orphans: orphans.size,
    evictions: lruEvictions,
    heapMB: mem && mem.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    latN: lat.n,
    latP50: lat.p50,
    latP95: lat.p95,
  };
}

/**
 * Frozen seam (A10): the EXPLICIT-DISCARD arm of M7 T5 (and the legacy
 * "close disposes" caller shape, kept for compatibility) — a dirty model
 * (its draft, undo stack, savedAltId) is NEVER disposed here; only a clean
 * model actually falls through to the disposal matrix. The × close path
 * itself routes through noteViewClose — a view close disposes nothing; the
 * T3 LRU sweep is the only eviction pressure.
 * @param {string} fkey
 * @returns {void}
 */
export function disposeModel(fkey) {
  const m = models.get(fkey);
  if (!m) return;
  const dirty = drafts[fkey] != null || m.getAlternativeVersionId() !== savedAltId.get(fkey);
  if (dirty) return;
  reallyDispose(fkey, m);
}

/* the disposal matrix (A10/A20) — total: nothing may reference the fkey after */
function reallyDispose(fkey, m) {
  // S2.4: the texfix engine + widgets leave with their model, FIRST — the
  // engine's untrack still needs the live model (A20 "nothing left behind")
  if (tfx && tfx.fkey === fkey) texfixRelease();
  if (editor && editor.getModel() === m) editor.setModel(null);
  if (activeFkey === fkey) activeFkey = null;
  // M3: retiring the seq makes any in-flight response a stale drop (M7 T5 —
  // "a post-dispose stale 200 is dropped"); waiters must never hang on a
  // queue that no longer exists (a pending ⌘⏎ awaits one).
  saveSeq.delete(fkey);
  inFlight.delete(fkey);
  pendingSave.delete(fkey);
  recovering.delete(fkey);
  // M6: retire any in-flight reconcile fetch — the resolver's flight-identity
  // check then drops its result, so a recreated model's altIds can never be
  // compared against a dead flight's revision (A20 cancellation discipline)
  staleFlights.delete(fkey);
  eolNormalized.delete(fkey);
  const ws = saveWaiters.get(fkey);
  saveWaiters.delete(fkey);
  if (ws) for (const r of ws) { try { r(); } catch { /* settled */ } }
  const l = modelListeners.get(fkey);
  if (l) { try { l.dispose(); } catch { /* already gone */ } }
  modelListeners.delete(fkey);
  // S1.4: the wash timer must never fire on a disposed model; the decoration
  // ids themselves die with the model dispose below
  const wt = washTimers.get(fkey);
  if (wt) clearTimeout(wt);
  washTimers.delete(fkey);
  washIds.delete(fkey);
  // S2.5: the lnFlash release timer must never fire on a disposed model; the
  // decoration ids themselves die with the model dispose below
  const ft = flashTimers.get(fkey);
  if (ft) clearTimeout(ft);
  flashTimers.delete(fkey);
  flashIds.delete(fkey);
  // S2.3: the tint decoration ids die with the model dispose below; the map
  // entry leaves here (matrix totality — zero maps reference the fkey after)
  tintIds.delete(fkey);
  // M7 T3 matrix "cancel timers" — the preview-debounce half: the ~250ms
  // mdPreview one-shot signalOnce arms for .md files may not stay pending
  // against a retired fkey (it reads drafts/fileCache only — a belt, not a
  // leak — but the matrix is total: every named step runs)
  mdPreviewCancel(fkey);
  models.delete(fkey);
  viewStates.delete(fkey);
  savedAltId.delete(fkey);
  eolProfiles.delete(fkey);
  baselineRaw.delete(fkey);
  txnOpen.delete(fkey);
  suppressedSeen.delete(fkey);
  // M7: recency/orphan/ownership bookkeeping leaves with the model (matrix
  // totality — after Disposed, zero maps reference the fkey). draftRev is
  // conceptually a property of drafts[k], but the reboot path is the only
  // dirty-model disposal and it recreates model + revs together from the
  // surviving draft (M1 T3), so deleting here keeps the pair consistent.
  lruSeq.delete(fkey);
  orphans.delete(fkey);
  draftRev.delete(fkey);
  modelSyncRev.delete(fkey);
  // the disposal matrix's marker step (M7 T3): clear this model's 'texlog'
  // markers BEFORE dispose — S2.3 SETS them (setProblems/applyProblems), so
  // this clearing is now load-bearing: a stale marker row keyed to a dead
  // model's URI may never survive into a recreated model's generation (A20)
  try { if (w.monaco && w.monaco.editor) w.monaco.editor.setModelMarkers(m, 'texlog', []); } catch { /* partial */ }
  try { m.dispose(); } catch { /* partial */ }
  // matrix complete: texfix engine/widgets left at the top of this function
  // (S2.4); the mzone wash, 'texlog' markers and .lnErr/.lnWarn tints left
  // above (S1.4 / full-M7 / S2.3)
}

/**
 * Frozen seam: the altId dirty bit (P-EOL-4 — never a byte comparison).
 * @param {string} fkey
 * @returns {boolean}
 */
export function isDirty(fkey) {
  const m = models.get(fkey);
  if (!m) return drafts[fkey] != null; // no model → the store is the authority
  return m.getAlternativeVersionId() !== savedAltId.get(fkey);
}

/**
 * Frozen seam: the model's current text under the P-EOL-1 serialization.
 * @param {string} fkey
 * @returns {string | null}
 */
export function text(fkey) {
  const m = models.get(fkey);
  return m ? serialize(m) : null;
}

/**
 * Frozen seam: push-style dirty signal — fired once per idle edit and once
 * per transaction commit, alongside the editorChrome pipeline (P1).
 * @param {(fkey: string) => void} cb
 * @returns {void}
 */
export function onDirtyChange(cb) { dirtyCbs.push(cb); }

/** Frozen seam: belt-and-braces relayout (focus mode, divider drags). */
export function layout() { if (editor) editor.layout(); }

/** Frozen seam: focus the kept editor (editHold hand-back etc.). */
export function focusEditor() { if (editor) editor.focus(); }

/**
 * Frozen seam (P17, C2-MF5 — blueprint §2 "Layout & editHold" row): the
 * WYSIWYG editHold. The `.editHold` CSS silences POINTERS only, and the kept
 * dock is a position:fixed SIBLING of the greyed panes — a still-focused
 * Monaco would keep routing keystrokes into the buffer under a live hold. So
 * the raise leg explicitly blurs the editor (remembering whether it had text
 * focus) and pins `updateOptions({readOnly:true})` for the hold lifetime;
 * the release leg drops the pin and hands focus back ONLY when the editor
 * had it at raise (symmetric hand-back — releasing a hold the user entered
 * with the caret elsewhere must never yank focus into the editor).
 * Transition-only and idempotent: renderWB reconciles the same state on
 * every pass. Tolerates every pre-READY boot state and no-editor calls —
 * the flag alone is recorded, and applyFile's `readOnly: editHeld || …`
 * re-asserts it when an editor materializes mid-hold.
 * @param {boolean} on raise (true) / release (false)
 * @returns {void}
 */
export function holdEditor(on) {
  const want = !!on;
  if (want === editHeld) return; // transition-only — repeat reconciles are no-ops
  editHeld = want;
  if (want) {
    heldHadFocus = !!(editor && editor.hasTextFocus());
    if (editor) {
      // Monaco exposes no editor.blur() — blur the focused inner surface
      // (the pinned textarea, or a widget input) directly
      const dom = editor.getDomNode();
      const ae = document.activeElement;
      if (dom && ae instanceof HTMLElement && dom.contains(ae)) ae.blur();
      editor.updateOptions({ readOnly: true });
    }
    return;
  }
  if (editor) {
    editor.updateOptions({ readOnly: false });
    if (heldHadFocus) editor.focus();
  }
  heldHadFocus = false;
}

/* ─────────────────────────── kept dock (A7) ───────────────────────────
   The active editor host (#mpHost) lives OUTSIDE every innerHTML replacement
   boundary: parked offscreen on <body> until a workbench render offers a
   #monacoSlot, then appended into that workbench's persistent .mdock (a
   build-once sibling of the refilled slots — the statusbar/meter idiom) and
   positioned over the slot. renderWB refills .side/.pane/.vtabs/.sessHalf
   around it; none of those is an ancestor of the dock. */

function ensurePark() {
  if (park && park.isConnected) return;
  park = document.getElementById('mpPark');
  if (!park) {
    park = document.createElement('div');
    park.id = 'mpPark';
    park.className = 'mpPark';
    document.body.appendChild(park);
  }
}

/**
 * Evacuate the kept host to the offscreen park (A7 belt: called before any
 * skeleton rebuild that would otherwise innerHTML an ancestor of the host).
 * @returns {void}
 */
export function parkHost() {
  if (!host) return;
  ensurePark();
  if (host.parentElement !== park) {
    // bank the caret/scroll before the host leaves the dock — the next
    // genuine attach (tab back from ≋ console, project return) restores it
    if (activeFkey) saveViewStateFor(activeFkey);
    park.appendChild(host);
  }
}

let slotRO = null; // ResizeObserver on the live slot → dock geometry sync

function positionDock(dock, slot) {
  const r = slot.getBoundingClientRect();
  dock.style.left = `${r.left}px`;
  dock.style.top = `${r.top}px`;
  dock.style.width = `${r.width}px`;
  dock.style.height = `${r.height}px`;
}

function hideAllDocks() {
  document.querySelectorAll('.wb > .mdock.on').forEach((d) => {
    d.classList.remove('on');
    d.removeAttribute('style');
  });
  if (slotRO) { slotRO.disconnect(); slotRO = null; }
  parkHost();
}

/**
 * Reconcile this workbench's dock with the current render: show the kept
 * editor over the #monacoSlot placeholder when the monaco path is active and
 * boot is READY; hide + park otherwise. Idempotent; safe in legacy mode.
 * @param {Element} root the project view root (#v-<key>)
 * @returns {void}
 */
export function syncDock(root) {
  const dock = root.querySelector(':scope > .wb > .mdock');
  if (!dock) return;
  const slot = root.querySelector('#monacoSlot');
  const active = bootState === 'READY' && !!slot && !!host;
  if (!active) {
    dock.classList.remove('on');
    dock.removeAttribute('style');
    if (host && dock.contains(host)) parkHost();
    return;
  }
  if (host.parentElement !== dock) dock.appendChild(host);
  dock.classList.add('on');
  positionDock(dock, slot);
  if (slotRO) slotRO.disconnect();
  slotRO = new ResizeObserver(() => {
    if (slot.isConnected) positionDock(dock, slot);
  });
  slotRO.observe(slot);
  if (editor) editor.layout(); // automaticLayout belt-and-braces after re-append
}

/**
 * wireWB seam: called once per render. Kicks the boot on the first editable
 * open of the monaco path and reconciles the dock either way.
 * @param {Element} root the project view root
 * @param {string} key project key
 * @returns {void}
 */
export function attachDock(root, key) {
  lastAttach = { root, key };
  if (root.querySelector('#monacoSlot')) {
    const p = ensureMonaco(); // single-flight — the idle warm may already own it
    p.then((r) => {
      if (!r.ok) { renderBootFailure(root); return; }
      const a = lastAttach;
      if (a && a.root.isConnected) syncDock(a.root);
    });
  }
  syncDock(root);
  observeProblems(root, key); // S2.3: strip-signal observer + attach refresh
  texfixArm(key); // S2.4: engine sync + the sugRedraw handle for this render (P6)
}

window.addEventListener('resize', () => {
  if (lastAttach && lastAttach.root.isConnected) syncDock(lastAttach.root);
});

// Boot lazily on editable-file open. Settings/dashboard visits load no Monaco assets.

/* ─────────────────── A16 perf seeds (S2.6, monaco-s2 §4) ───────────────────
   Instrumentation only — the pass/fail budgets are ruled at S2b (CONTRACT
   "Ladder & exit gates", A16). Near-zero cost when idle and STRICTLY
   monaco-gated: the input sampler is an editor.onKeyDown listener (it can
   only exist post-INIT and Monaco only delivers it keydowns while the pinned
   input surface has focus — armed ⇔ attached AND focused), and the longtask
   observer arms at boot READY and dies with the generation
   (cleanupPartialBoot / rebootMonaco). Under legacy neither exists and the
   read-only __mp.perf() probe reports armed:false. No timers anywhere; at
   most ONE rAF is ever pending; the ring slot is the only per-sample write
   (the Float64Array is allocated once, lazily, at first INIT — module eval
   under legacy allocates nothing). */

const LAT_RING_N = 512;    // §4 item 2's "~500 entries" — bounded, overwrite-oldest
let latRing = null;        // Float64Array(LAT_RING_N), allocated at first INIT
let latCount = 0;          // monotonic sample count; slot = latCount % LAT_RING_N
let latT0 = 0;             // the pending keydown's performance.now()
let latRafPending = false; // at most ONE rAF in flight — later keydowns coalesce
let latDisp = null;        // the onKeyDown IDisposable — dies with the editor

/* module-level on purpose: requestAnimationFrame(latRafTick) allocates no
   closure per sample (§4: "deliberately crude and cheap — one listener + one
   rAF, no observers on the hot path"). */
function latRafTick() {
  if (!latRafPending) return; // disarmed mid-flight (cleanup/reboot)
  latRafPending = false;
  latRing[latCount % LAT_RING_N] = performance.now() - latT0;
  latCount++;
}

function armLatencySampler() {
  if (!latRing) latRing = new Float64Array(LAT_RING_N);
  latDisp = editor.onKeyDown(() => {
    if (latRafPending) return; // one sample per frame, keydown → NEXT rAF
    latRafPending = true;
    latT0 = performance.now();
    requestAnimationFrame(latRafTick);
  });
}

/* p50/p95 computed ON READ only (__mp.perf() / the soak census — probe and
   eviction frequency, never per keystroke). Values rounded to 0.1ms. */
function latStats() {
  const n = Math.min(latCount, LAT_RING_N);
  if (!n || !latRing) return { n: 0, p50: null, p95: null, max: null };
  const a = Array.from(latRing.subarray(0, n)).sort((x, y) => x - y);
  const at = (q) => Math.round(a[Math.round(q * (n - 1))] * 10) / 10;
  return { n, p50: at(0.5), p95: at(0.95), max: at(1) };
}

const LT_RING_N = 64; // §4 item 3: the same bounded-ring discipline as bootLog/saveLog
const ltRing = [];    // {ts, dur} ms — oldest shifted out
let ltObserver = null; // armed at READY only — NEVER under legacy

function armLongTasks() {
  if (ltObserver || typeof PerformanceObserver !== 'function') return;
  try {
    ltObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        ltRing.push({ ts: Math.round(e.startTime), dur: Math.round(e.duration) });
        if (ltRing.length > LT_RING_N) ltRing.shift();
      }
    });
    ltObserver.observe({ type: 'longtask', buffered: false });
  } catch {
    ltObserver = null; // 'longtask' unsupported — the probe reports armed:false
  }
}

/* the generation boundary: called from cleanupPartialBoot (fail paths AND
   rebootMonaco route through it) — the observer and listener may never
   outlive the editor/monaco instance they measured. */
function disarmPerfSeeds() {
  latRafPending = false; // a pending latRafTick becomes a no-op
  if (latDisp) { try { latDisp.dispose(); } catch { /* editor died first */ } latDisp = null; }
  if (ltObserver) { try { ltObserver.disconnect(); } catch { /* already gone */ } ltObserver = null; }
}

/* ─────────────────────────── window.__mp test seam ───────────────────────────
   The frozen seam list's test surface (window.__merge3 tradition). Boot +
   toggle + the M1/M2 model-machine surface. Test-only: app code never calls
   __mp — and at least one ui.monaco-core case drives genuine CDP keystrokes
   because this seam bypasses the input path. */
let spyDisp = null;
let spyHits = 0;
w.__mp = {
  // boot machine + toggle
  ensure: ensureMonaco,
  reboot: rebootMonaco,
  state: () => bootState,
  log: () => bootLog.slice(),
  bootCount: () => bootStarts,
  generation: () => bootGen,
  degraded: () => ({ worker: workerDegraded, langs: [...langDegradedSet] }),
  // post-boot lazy-language trigger (the lang-block injection case)
  setLanguage: (id) => {
    if (!editor || !w.monaco) throw new Error('no editor');
    w.monaco.editor.setModelLanguage(editor.getModel(), String(id));
  },
  // ── frozen seams (fkey-routed; no-arg forms hit the active model) ──
  setFile,
  applyExternal,
  beginSave,
  commitSave,
  requestSave,
  runAfterSave,
  saveViewStateFor,
  disposeModel,
  isDirty,
  text,
  layout,
  focus: focusEditor,
  holdEditor,
  getText: (fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    return m ? serialize(m) : null;
  },
  // behaves like typing: undoable, flows through the normal M2-idle pipeline
  setText: (t, fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    if (!m) throw new Error('no model');
    if (editor && editor.getModel() === m) {
      editor.pushUndoStop();
      editor.executeEdits('__mp', [{ range: m.getFullModelRange(), text: String(t) }]);
      editor.pushUndoStop();
    } else {
      m.applyEdits([{ range: m.getFullModelRange(), text: String(t) }]);
    }
  },
  pushEdit: (t, range, fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    if (!m) throw new Error('no model');
    const r = range || m.getFullModelRange();
    if (editor && editor.getModel() === m) {
      editor.pushUndoStop();
      editor.executeEdits('__mp', [{ range: r, text: String(t) }]);
      editor.pushUndoStop();
    } else {
      m.applyEdits([{ range: r, text: String(t) }]);
    }
  },
  getPosition, // S2.5: the frozen P7 seam (1-based both axes)
  setPosition: (line, col) => { if (editor) editor.setPosition({ lineNumber: line, column: col }); },
  // S2.5: multi-cursor staging for the A18 fall-through cases (the keystroke
  // itself stays genuine CDP — this only places the cursors)
  setSelections: (list) => {
    if (!editor || !w.monaco) throw new Error('no editor');
    editor.setSelections(list.map((s) => new w.monaco.Selection(
      s.line, s.col, s.line2 ?? s.line, s.col2 ?? s.col,
    )));
  },
  getSelections: () => (editor ? editor.getSelections().map((s) => ({
    line: s.selectionStartLineNumber, col: s.selectionStartColumn,
    line2: s.positionLineNumber, col2: s.positionColumn,
  })) : null),
  revealLine: (line) => { if (editor) editor.revealLineInCenter(line); },
  // ── S2.5 jump/flash/command surface ──
  revealAt, // the frozen P8 seam
  // the 35%-reveal geometry probe: scrollTop vs the formula's inputs, all
  // read from the live editor in one evaluate (the A20 geometric assert)
  viewGeom: (line) => (editor ? {
    scrollTop: editor.getScrollTop(),
    top: editor.getTopForLineNumber(Number(line) || 1),
    height: editor.getLayoutInfo().height,
    lineHeight: editor.getOption(w.monaco.editor.EditorOption.lineHeight),
  } : null),
  flashInfo: (fkey) => {
    const m = models.get(fkey);
    const ids = flashIds.get(fkey) || [];
    return {
      ids: ids.slice(),
      pending: flashTimers.has(fkey),
      lines: m ? ids.map((id) => m.getDecorationRange(id)).filter((r) => !!r).map((r) => r.startLineNumber) : [],
    };
  },
  // the per-generation fire census (the §6 zombie-shadowing quirk's assert)
  commandInfo: () => ({ generation: bootGen, fires: cmdFires.map((f) => ({ ...f })) }),
  // S2.2: drive the REGISTERED completion provider against a model/position —
  // the retargeted ui.tex-editor completion rows and the async-discipline
  // cases call this. It bypasses the input path, so the suggest-widget cases
  // in ui.monaco-completions drive genuine CDP keystrokes (the §2 rule).
  providerComplete: (line, col, fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    if (!m) throw new Error('no model');
    if (!completionProvider) throw new Error('no completion provider (pre-INIT?)');
    const pos = Number.isFinite(line) && Number.isFinite(col)
      ? { lineNumber: line, column: col }
      : editor.getPosition();
    const token = new w.monaco.CancellationTokenSource().token;
    return completionProvider.provideCompletionItems(m, pos, { triggerKind: 0 }, token);
  },
  // S2.2 read-only registration census (the reboot/N3 cases)
  providerInfo: () => ({ registered: providerDisposables.length, live: !!completionProvider }),
  // S2.2 no-word-noise gate surface: the pinned create options, live
  suggestOptions: () => (editor ? {
    quickSuggestions: editor.getRawOptions().quickSuggestions,
    wordBasedSuggestions: editor.getRawOptions().wordBasedSuggestions,
  } : null),
  // ── M1/M2 inspection surface ──
  // lazy on purpose: a top-level reference to store's const bindings could
  // hit the TDZ under ESM cycle evaluation orders; a call site is runtime
  store: () => ({ drafts, draftBase, diskStale, fileCache }), // live references — tests only
  models: () => [...models.keys()],
  modelId: (fkey) => { const m = models.get(fkey); return m ? m.id : null; },
  savedAlt: (fkey) => (savedAltId.has(fkey) ? savedAltId.get(fkey) : null),
  eol: (fkey) => eolProfiles.get(fkey) || null,
  rawBaseline: (fkey) => (baselineRaw.has(fkey) ? baselineRaw.get(fkey) : null),
  getEOL: (fkey) => { const m = models.get(fkey); return m ? m.getEOL() : null; },
  activeFkey: () => activeFkey,
  editorId: () => (editor ? editor.getId() : null),
  hasTextFocus: () => !!(editor && editor.hasTextFocus()),
  // C2-MF5 editHold surface (read-only): the recorded hold flag + hand-back
  // memory + the editor's LIVE readOnly option (null pre-editor)
  editHold: () => ({
    held: editHeld,
    hadFocus: heldHadFocus,
    readOnly: editor ? editor.getRawOptions().readOnly === true : null,
  }),
  getScrollTop: () => (editor ? editor.getScrollTop() : 0),
  setScrollTop: (px) => { if (editor) editor.setScrollTop(px); },
  inComposition: () => inComposition,
  compositionEnds: () => compositionEnds,
  editContext: () => (editor ? editor.getRawOptions().editContext !== false : null),
  txnOpen: () => [...txnOpen.keys()],
  // ── S1.4 grammar/theme/wash inspection surface (read-only) ──
  language: (fkey) => { const m = models.get(fkey); return m ? m.getLanguageId() : null; },
  washRanges: (fkey) => {
    const m = models.get(fkey);
    if (!m) return null;
    return (washIds.get(fkey) || [])
      .map((id) => m.getDecorationRange(id))
      .filter((r) => !!r)
      .map((r) => [r.startLineNumber, r.startColumn, r.endColumn])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  },
  washPending: (fkey) => washTimers.has(fkey),
  // ── S2.3 problems surface ──
  setProblems, // the frozen seam (P9)
  // this model's 'texlog' markers, straight from the marker service (owner +
  // resource keyed — the per-model routing/isolation proof reads THIS)
  texMarkers: (fkey) => {
    const m = models.get(fkey);
    if (!m || !w.monaco) return null;
    const S = w.monaco.MarkerSeverity;
    const name = { [S.Error]: 'error', [S.Warning]: 'warning', [S.Info]: 'info', [S.Hint]: 'hint' };
    return w.monaco.editor.getModelMarkers({ owner: 'texlog', resource: m.uri })
      .map((r) => ({
        line: r.startLineNumber,
        endLine: r.endLineNumber,
        col: r.startColumn,
        endCol: r.endColumn,
        severity: name[r.severity] || String(r.severity),
        message: r.message,
      }))
      .sort((a, b) => a.line - b.line || a.col - b.col);
  },
  // the live tint decorations (parity check: badbox rows must never appear)
  tintRanges: (fkey) => {
    const m = models.get(fkey);
    if (!m) return null;
    return (tintIds.get(fkey) || [])
      .map((id) => {
        const r = m.getDecorationRange(id);
        const o = m.getDecorationOptions(id);
        return r && o ? { line: r.startLineNumber, cls: o.className || '' } : null;
      })
      .filter((x) => !!x)
      .sort((a, b) => a.line - b.line || (a.cls < b.cls ? -1 : 1));
  },
  // read-only machinery census (the legacy-control row asserts observing:false)
  problemsInfo: () => ({
    observing: !!stripObserver,
    projects: [...texProblems.keys()],
    rows: [...texProblems.values()].reduce((n, v) => n + v.length, 0),
  }),
  // ── S2.4 texfix surface ──
  texfix, // the frozen seam (P6): {arm, revalidate, resolve}
  texfixApply, // the ✦ pane's Apply path (engine guard + the accepted wire)
  texfixState: (id) => (tfx ? tfx.engine.state(id) : null),
  texfixInfo: () => (tfx ? {
    project: tfx.project,
    fkey: tfx.fkey,
    ids: tfx.engine.ids(),
    widgets: [...tfx.entries.values()].filter((e) => e.added).length,
    redrawRegistered: sugRedraw[tfx.project] === texfixRedraws.get(tfx.project),
  } : null),
  themeInfo: () => ({ ...CP_THEME }),
  initTrace: () => initTrace.slice(),
  wordWrap: () => (editor ? editor.getRawOptions().wordWrap : null),
  indentInfo: (fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    const o = m ? m.getOptions() : null;
    return {
      detectIndentation: editor ? editor.getRawOptions().detectIndentation : null,
      tabSize: o ? o.tabSize : null,
      insertSpaces: o ? o.insertSpaces : null,
    };
  },
  // ── M3/M5 inspection surface ──
  saveState: (fkey) => ({
    seq: saveSeq.has(fkey) ? saveSeq.get(fkey) : 0,
    inFlight: inFlight.has(fkey) ? { ...inFlight.get(fkey) } : null,
    pending: pendingSave.has(fkey),
    recovering: recovering.has(fkey),
    eolNormalized: eolNormalized.get(fkey) || null,
  }),
  saveLog: (fkey) => saveLog.filter((e) => !fkey || e.fkey === fkey).map((e) => ({ ...e })),
  // M6 inspection surface: the reconcile flight (read-only)
  staleState: (fkey) => ({
    inFlight: staleFlights.has(fkey),
    rev: staleFlights.has(fkey) ? staleFlights.get(fkey).rev : null,
  }),
  // ── M7 lifecycle surface ──
  noteViewClose,    // the T4 view-close seam (same entry files.closeTab calls)
  counters: soakCounters, // A10/A16 soak census (models/dirty/cleanDetached/orphans/evictions/heapMB + lat fold)
  // ── A16 perf probe (S2.6, §4 — read-only; the budgets are S2b's ruling) ──
  // armed.input ⇔ the onKeyDown sampler exists (an editor is live; Monaco
  // only feeds it keydowns while focused); armed.longtask ⇔ the READY-armed
  // observer is connected. Both are false under legacy by construction.
  perf: () => ({
    armed: { input: !!latDisp, longtask: !!ltObserver },
    input: latStats(),                        // keydown→next-rAF ring: {n, p50, p95, max} ms
    longTasks: ltRing.map((e) => ({ ...e })), // bounded {ts, dur} ms ring
  }),
  draftRev: (fkey) => draftRev.get(fkey) || 0,
  modelSyncRev: (fkey) => modelSyncRev.get(fkey) || 0,
  lruInfo: (fkey) => {
    const m = models.get(fkey);
    return {
      seq: lruSeq.get(fkey) || 0,
      orphan: orphans.has(fkey),
      eligible: m ? lruEligible(fkey, m) : false,
    };
  },
  // matrix-totality probe (read-only): which per-fkey maps still hold an
  // entry — after reallyDispose EVERY field must read false (A10/A20)
  m7State: (fkey) => ({
    model: models.has(fkey),
    viewState: viewStates.has(fkey),
    listener: modelListeners.has(fkey),
    washTimer: washTimers.has(fkey),
    washIds: washIds.has(fkey),
    flashTimer: flashTimers.has(fkey),
    flashIds: flashIds.has(fkey),
    tints: tintIds.has(fkey),
    texfix: !!(tfx && tfx.fkey === fkey),
    lru: lruSeq.has(fkey),
    orphan: orphans.has(fkey),
    savedAlt: savedAltId.has(fkey),
    baseline: baselineRaw.has(fkey),
    eol: eolProfiles.has(fkey),
    saveSeq: saveSeq.has(fkey),
    inFlight: inFlight.has(fkey),
    pending: pendingSave.has(fkey),
    staleFlight: staleFlights.has(fkey),
    draftRev: draftRev.has(fkey),
    syncRev: modelSyncRev.has(fkey),
  }),
  signals: () => ({ chrome: chromeSignals, preview: previewSignals, txnSync: txnSyncVerified }),
  resetSignals: () => { chromeSignals = 0; previewSignals = 0; },
  // content-event spy (M1 listener-order proof): counts raw model events on
  // the given (default: active) model from the moment it is armed
  spyContent: (fkey) => {
    const m = fkey ? models.get(fkey) : editor && editor.getModel();
    if (!m) throw new Error('no model');
    if (spyDisp) spyDisp.dispose();
    spyHits = 0;
    spyDisp = m.onDidChangeContent(() => { spyHits++; });
  },
  spyCount: () => spyHits,
  // force-dispose regardless of dirtiness — creation-path tests only
  evictForTest: (fkey) => { const m = models.get(fkey); if (m) reallyDispose(fkey, m); },
};
