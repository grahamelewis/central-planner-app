// test/latex.providers.test.mjs — S0 unit gate for the DI'd provider factories
// (latex/texProviders.js) and the extracted pure brain (latex/texCore.js):
// the four completion contexts against a model shim, cite comma-awareness,
// \end unclosed-first ordering, snippet shapes, §14 A8 isIncomplete re-query,
// the .bib exclusions, marker mapping (badbox→Hint, per-model filtering, A20),
// and the texOutline/needsEnd/openEnvsIn/texSymbolMatch extraction.
// S2.2 (monaco-s2 §1, review concern 3) grows the async-discipline rows: the
// full (model, position, context, token) signature, the per-metaKey cache +
// single flight, the post-await cancellation/version/disposal bails, and the
// closeBrace consume-range parity (the legacy hop, ported).
// Node-only, zero app-module imports (the latex/ package is standalone), no
// monaco: factories take a stub namespace — that is the DI contract.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLatexCompletionProvider, createLatexSymbolProvider,
  markersForProblems, snippetizeArgs, latexTriggerCharacters,
} from '../public/latex/texProviders.js';
import * as providersModule from '../public/latex/texProviders.js';
import {
  texOutline, needsEnd, openEnvsIn, texSymbolMatch, TEX_SYMS,
  COMMON_COMMANDS,
} from '../public/latex/texCore.js';
import { latexConfiguration, bibtexConfiguration, langForTexExt } from '../public/latex/texLang.js';

/* ── the DI stubs ── */

const monacoStub = {
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  languages: {
    CompletionItemKind: { Function: 1, Module: 8, Reference: 17 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    SymbolKind: { Namespace: 2 },
  },
};

/** Minimal ITextModel shim: exactly the surface the factories consume.
 *  S2.2 adds the async-discipline surface: getVersionId (bump() = an edit
 *  landing mid-request), isDisposed/dispose (a reboot mid-request). */
class ModelShim {
  constructor(text) {
    this.lines = String(text).split('\n');
    this._ver = 1;
    this._disposed = false;
  }
  getValue() { return this.lines.join('\n'); }
  getLineContent(n) { return this.lines[n - 1] ?? ''; }
  getVersionId() {
    if (this._disposed) throw new Error('ModelShim: getVersionId on a disposed model');
    return this._ver;
  }
  bump() { this._ver++; }
  isDisposed() { return this._disposed; }
  dispose() { this._disposed = true; }
  getValueInRange(r) {
    const out = [];
    for (let ln = r.startLineNumber; ln <= r.endLineNumber; ln++) {
      const line = this.getLineContent(ln);
      const s = ln === r.startLineNumber ? r.startColumn - 1 : 0;
      const e = ln === r.endLineNumber ? r.endColumn - 1 : line.length;
      out.push(line.slice(s, e));
    }
    return out.join('\n');
  }
}

/** Build (model, position) from text with a `¦` caret marker. */
function caret(text) {
  const idx = text.indexOf('¦');
  assert.ok(idx >= 0, 'caret marker missing');
  const clean = text.slice(0, idx) + text.slice(idx + 1);
  const before = clean.slice(0, idx).split('\n');
  return {
    model: new ModelShim(clean),
    position: { lineNumber: before.length, column: before[before.length - 1].length + 1 },
  };
}

const META = {
  labels: [
    { label: 'eq:euler', file: 'main.tex', line: 12 },
    { label: 'eq:budget', file: 'model.tex', line: 44 },
    { label: 'fig:impulse', file: 'main.tex', line: 90 },
  ],
  cites: [
    { key: 'rivera2024heterogeneous', title: 'Heterogeneous Agents under Synthetic Shocks' },
    { key: 'doe2019numerical', file: 'refs.bib' },
    ...Array.from({ length: 10 }, (_, i) => ({ key: `sample${i}common`, title: `Sample ${i}` })),
  ],
  envs: ['synthenv'],
  commands: ['mycustomcmd'],
};

const provider = () => createLatexCompletionProvider(monacoStub, { requestMeta: async () => META });
// the full S2.2 signature: context + token ride every call (the token stub is
// live-mutable so the cancellation rows can flip it mid-request)
const token = () => ({ isCancellationRequested: false });
const complete = async (text, p = provider(), tok = token()) => {
  const { model, position } = caret(text);
  return p.provideCompletionItems(model, position, { triggerKind: 0 }, tok);
};

/** A one-shot resolvable gate for the deferred-requestMeta rows. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((rs, rj) => { resolve = rs; reject = rj; });
  return { promise, resolve, reject };
}

/** Meta with exactly these cite keys (the async rows' distinguishable data). */
const mkMeta = (keys) => ({
  labels: [], envs: [], commands: [],
  cites: keys.map((k) => ({ key: k, title: `Title of ${k}` })),
});

/* ── completion contexts ── */

describe('latex completion provider (P10)', () => {
  test('trigger characters are the legacy trio', () => {
    assert.deepEqual(latexTriggerCharacters, ['\\', '{', ',']);
    assert.deepEqual(provider().triggerCharacters, ['\\', '{', ',']);
  });

  test('cite context: substring filter, detail = title||file, closing brace appended', async () => {
    const r = await complete('Text \\cite{river¦');
    assert.equal(r.suggestions.length, 1);
    const s = r.suggestions[0];
    assert.equal(s.label, 'rivera2024heterogeneous');
    assert.equal(s.kind, monacoStub.languages.CompletionItemKind.Reference);
    assert.equal(s.detail, 'Heterogeneous Agents under Synthetic Shocks');
    assert.equal(s.insertText, 'rivera2024heterogeneous}');
    assert.deepEqual(s.range, { startLineNumber: 1, startColumn: 12, endLineNumber: 1, endColumn: 17 });
    assert.equal(r.incomplete, false);
  });

  test('cite closeBrace parity: an existing } is CONSUMED — brace emitted, range +1 (the legacy hop)', async () => {
    const r = await complete('\\cite{doe¦}'); // caret col 10, auto-paired } at it
    assert.equal(r.suggestions[0].insertText, 'doe2019numerical}');
    assert.deepEqual(r.suggestions[0].range,
      { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 },
      'endColumn consumes the auto-paired } so the caret lands AFTER the emitted brace');
  });

  test('ref/end closeBrace parity: same consume rule on the other closing-brace contexts', async () => {
    const ref = await complete('\\ref{eq:eu¦}'); // caret col 11
    assert.equal(ref.suggestions[0].insertText, 'eq:euler}');
    assert.equal(ref.suggestions[0].range.endColumn, 12, '\\ref consumes the }');
    const end = await complete('\\begin{itemize}\nx\n\\end{ite¦}'); // caret col 9 on line 3
    assert.equal(end.suggestions[0].insertText, 'itemize}');
    assert.equal(end.suggestions[0].range.endColumn, 10, '\\end consumes the }');
  });

  test('cmd closeBrace parity: no-arg command consumes (legacy hop); arg snippet does not', async () => {
    // legacy accept(): insert 'alpha' does NOT end in '}' + '}' at caret → hop
    const noArg = await complete('\\emph{x\\alp¦}');
    const s = noArg.suggestions.find((x) => x.label === '\\alpha');
    assert.ok(s, 'alpha offered');
    assert.equal(s.insertText, 'alpha}');
    assert.equal(s.range.endColumn, 13, 'no-arg cmd consumes the auto-paired }');
    // arg template ends in '}' → legacy never hopped → no consume here either
    const argd = await complete('\\fr¦}');
    const f = argd.suggestions.find((x) => x.label === '\\frac');
    assert.equal(f.insertText, 'frac{$1}{$2}');
    assert.equal(f.range.endColumn, 4, 'snippet range stops at the caret — the } stays');
  });

  test('cite comma-awareness: prefix is the segment after the last comma', async () => {
    const r = await complete('\\cite{doe2019numerical,river¦');
    assert.equal(r.suggestions.length, 1);
    assert.equal(r.suggestions[0].label, 'rivera2024heterogeneous');
    // range replaces only the post-comma prefix (5 chars)
    assert.equal(r.suggestions[0].range.startColumn, r.suggestions[0].range.endColumn - 5);
  });

  test('cite truncation: max 8 items and incomplete:true for the re-query (A8)', async () => {
    const r = await complete('\\cite{common¦'); // matches all 10 sampleNcommon keys
    assert.equal(r.suggestions.length, 8);
    assert.equal(r.incomplete, true);
    // sortText pins our order against Monaco re-sorting
    assert.deepEqual(r.suggestions.map((s) => s.sortText), [...r.suggestions.map((s) => s.sortText)].sort());
  });

  test('ref context: detail is file:line', async () => {
    const r = await complete('see \\eqref{eq:eu¦');
    assert.equal(r.suggestions.length, 1);
    assert.equal(r.suggestions[0].label, 'eq:euler');
    assert.equal(r.suggestions[0].detail, 'main.tex:12');
  });

  test('env after \\begin{: sorted pool, snippet inserts the \\end skeleton', async () => {
    const r = await complete('\\begin{ite¦');
    const s = r.suggestions[0];
    assert.equal(s.label, 'itemize');
    assert.equal(s.insertText, 'itemize}\n\t$0\n\\end{itemize}');
    assert.equal(s.insertTextRules, monacoStub.languages.CompletionItemInsertTextRule.InsertAsSnippet);
    assert.equal(s.detail, 'environment — inserts \\end too');
  });

  test('env after \\begin{ with an auto-paired } at the caret: range consumes it', async () => {
    const r = await complete('\\begin{ite¦}');
    const s = r.suggestions[0];
    assert.equal(s.insertText, 'itemize}\n\t$0\n\\end{itemize}'); // brace always emitted
    assert.equal(s.range.endColumn, 12); // caret col 11 + the consumed }
  });

  test('\\end{ orders unclosed environments first, innermost first', async () => {
    const r = await complete('\\begin{figure}\n\\begin{itemize}\n\\item x\n\\end{¦');
    const labels = r.suggestions.map((s) => s.label);
    assert.deepEqual(labels.slice(0, 2), ['itemize', 'figure']); // openEnvsIn order
    assert.equal(r.suggestions[0].detail, 'close environment');
    assert.equal(r.suggestions[0].insertText, 'itemize}');
  });

  test('meta envs join the \\begin pool', async () => {
    const r = await complete('\\begin{synthe¦');
    assert.equal(r.suggestions[0].label, 'synthenv');
  });

  test('cmd context: ≥2 chars, snippet arg templates, detail = template', async () => {
    const r = await complete('\\fr¦');
    const s = r.suggestions.find((x) => x.label === '\\frac');
    assert.ok(s, 'frac offered');
    assert.equal(s.detail, '{}{}');
    assert.equal(s.insertText, 'frac{$1}{$2}');
    assert.equal(s.insertTextRules, monacoStub.languages.CompletionItemInsertTextRule.InsertAsSnippet);
  });

  test('cmd context: optional-arg template and meta commands', async () => {
    const r1 = await complete('\\usepa¦');
    assert.equal(r1.suggestions[0].insertText, 'usepackage[$1]{$2}');
    const r2 = await complete('\\mycust¦');
    assert.equal(r2.suggestions[0].label, '\\mycustomcmd');
    assert.equal(r2.suggestions[0].insertText, 'mycustomcmd');
    assert.equal(r2.suggestions[0].insertTextRules, undefined); // no args → plain
  });

  test('cmd context: no-arg commands insert plainly', async () => {
    const r = await complete('\\alph¦');
    const s = r.suggestions.find((x) => x.label === '\\alpha');
    assert.equal(s.insertText, 'alpha');
    assert.equal(s.insertTextRules, undefined);
  });

  test('1-char cmd prefix: empty but incomplete:true so Monaco re-queries (A8)', async () => {
    const r = await complete('\\f¦');
    assert.equal(r.suggestions.length, 0);
    assert.equal(r.incomplete, true);
  });

  test('no context → empty complete list', async () => {
    const r = await complete('plain prose here¦');
    assert.deepEqual(r, { suggestions: [], incomplete: false });
  });

  test('meta is cached for the TTL and a failing requestMeta degrades to empty', async () => {
    let calls = 0;
    const p = createLatexCompletionProvider(monacoStub, {
      requestMeta: async () => { calls++; return META; },
    });
    await complete('\\cite{a¦', p);
    await complete('\\cite{b¦', p);
    assert.equal(calls, 1, '5s cache: one fetch for two queries');

    let fails = 0;
    const failing = createLatexCompletionProvider(monacoStub, {
      requestMeta: async () => { fails++; throw new Error('offline'); },
    });
    const r = await complete('\\cite{a¦', failing);
    assert.deepEqual(r.suggestions, []); // degrades, never throws
    await complete('\\cite{a¦', failing);
    assert.equal(fails, 2, 'a failure is never cached as fresh — the next query retries');
  });

  test('a failing refresh degrades to the STALE cached meta, never to empty (S2.2)', async () => {
    let n = 0;
    const p = createLatexCompletionProvider(monacoStub, {
      metaTtlMs: 0, // every query refetches — the second one fails
      requestMeta: async () => { n++; if (n > 1) throw new Error('offline'); return META; },
    });
    const r1 = await complete('\\cite{river¦', p);
    assert.equal(r1.suggestions[0].label, 'rivera2024heterogeneous');
    const r2 = await complete('\\cite{river¦', p);
    assert.equal(r2.suggestions[0].label, 'rivera2024heterogeneous',
      'the stale slot serves when the refresh fails');
    assert.equal(n, 2);
  });

  test('bibtex gets NO completion provider (the .bib exclusions for free)', () => {
    const factoryNames = Object.keys(providersModule).filter((n) => /^create/.test(n));
    assert.deepEqual(factoryNames.sort(), ['createLatexCompletionProvider', 'createLatexSymbolProvider'],
      'only latex factories exist — registration is latex-only by construction');
  });
});

/* ── S2.2 async discipline (monaco-s2 §1 S2.2, review concern 3 / A20) ──
   The factory-level halves of the four mandated async cases; their end-to-end
   twins (real page, held /api/texmeta routes) live in
   ui.monaco-completions.test.mjs. */

describe('S2.2 async discipline (per-key cache, single flight, post-await bails)', () => {
  test('metaKey keys the 5s cache per project — no cross-project bleed (risk N1)', async () => {
    let key = 'alpha';
    const calls = [];
    const metas = { alpha: mkMeta(['alphakey2026']), beta: mkMeta(['betakey2026']) };
    const p = createLatexCompletionProvider(monacoStub, {
      metaKey: () => key,
      requestMeta: async () => { calls.push(key); return metas[key]; },
    });
    const r1 = await complete('\\cite{¦', p);
    key = 'beta';
    const r2 = await complete('\\cite{¦', p); // alpha's fresh slot must NOT serve beta
    key = 'alpha';
    const r3 = await complete('\\cite{¦', p); // alpha's slot is still fresh — no 3rd fetch
    assert.deepEqual(calls, ['alpha', 'beta'], 'one fetch per project, cache per key');
    assert.deepEqual(r1.suggestions.map((s) => s.label), ['alphakey2026']);
    assert.deepEqual(r2.suggestions.map((s) => s.label), ['betakey2026']);
    assert.deepEqual(r3.suggestions.map((s) => s.label), ['alphakey2026']);
  });

  test('per-key single flight: concurrent queries coalesce onto ONE requestMeta', async () => {
    const d = deferred();
    let calls = 0;
    const p = createLatexCompletionProvider(monacoStub, {
      requestMeta: () => { calls++; return d.promise; },
    });
    const q1 = complete('\\cite{sample¦', p);
    const q2 = complete('\\cite{common¦', p); // rapid A8 re-query while the GET flies
    d.resolve(META);
    const [r1, r2] = await Promise.all([q1, q2]);
    assert.equal(calls, 1, 'the second query rode the in-flight promise');
    assert.ok(r1.suggestions.length > 0 && r2.suggestions.length > 0,
      'both queries were answered from the one response');
  });

  test('edit-during-request: a moved getVersionId bails empty, non-incomplete', async () => {
    const d = deferred();
    const p = createLatexCompletionProvider(monacoStub, { requestMeta: () => d.promise });
    const { model, position } = caret('\\cite{river¦');
    const q = p.provideCompletionItems(model, position, { triggerKind: 0 }, token());
    model.bump(); // the edit lands while the meta GET is in flight
    d.resolve(META);
    assert.deepEqual(await q, { suggestions: [], incomplete: false },
      'a late list never outlives the text it was computed against (A20)');
  });

  test('cancellation-during-request: token.isCancellationRequested bails empty', async () => {
    const d = deferred();
    const p = createLatexCompletionProvider(monacoStub, { requestMeta: () => d.promise });
    const { model, position } = caret('\\cite{river¦');
    const tok = token();
    const q = p.provideCompletionItems(model, position, { triggerKind: 0 }, tok);
    tok.isCancellationRequested = true; // Monaco cancelled (newer query/widget closed)
    d.resolve(META);
    assert.deepEqual(await q, { suggestions: [], incomplete: false });
  });

  test('reboot-during-request: a DISPOSED model bails empty without touching getVersionId', async () => {
    const d = deferred();
    const p = createLatexCompletionProvider(monacoStub, { requestMeta: () => d.promise });
    const { model, position } = caret('\\cite{river¦');
    const q = p.provideCompletionItems(model, position, { triggerKind: 0 }, token());
    model.dispose(); // rebootMonaco's reallyDispose sweep, mid-request
    d.resolve(META);
    assert.deepEqual(await q, { suggestions: [], incomplete: false },
      'isDisposed is checked FIRST — getVersionId on a disposed model would throw');
  });

  test('switch-project mid-request + out-of-order resolution: entry-key caching, no overwrite', async () => {
    let key = 'alpha';
    const gates = { alpha: deferred(), beta: deferred() };
    const calls = [];
    const p = createLatexCompletionProvider(monacoStub, {
      metaKey: () => key,
      requestMeta: () => { calls.push(key); return gates[key].promise; },
    });
    const qA = complete('\\cite{¦', p); // flight opened under 'alpha'
    key = 'beta'; //                       the project switches mid-flight
    const qB = complete('\\cite{¦', p); // flight opened under 'beta'
    gates.beta.resolve(mkMeta(['betakey2026'])); // the NEWER response lands first
    assert.deepEqual((await qB).suggestions.map((s) => s.label), ['betakey2026']);
    gates.alpha.resolve(mkMeta(['alphakey2026'])); // the slow OLD response lands late
    assert.deepEqual((await qA).suggestions.map((s) => s.label), ['alphakey2026'],
      'the late response still answers ITS OWN query truthfully');
    // …and cached under its ENTRY key: both re-queries serve from cache
    const rB2 = await complete('\\cite{¦', p);
    assert.deepEqual(rB2.suggestions.map((s) => s.label), ['betakey2026'],
      "the slow old response did not overwrite the newer key's cache");
    key = 'alpha';
    const rA2 = await complete('\\cite{¦', p);
    assert.deepEqual(rA2.suggestions.map((s) => s.label), ['alphakey2026']);
    assert.deepEqual(calls, ['alpha', 'beta'], 'two fetches ever — re-queries were cache hits');
  });
});

/* ── language configuration data (P11 slice) ── */

describe('language configurations (texLang)', () => {
  test('latex auto-pairs $…$; bibtex omits the $ pair by contract', () => {
    assert.ok(latexConfiguration.autoClosingPairs.some((p) => p.open === '$'));
    assert.ok(!bibtexConfiguration.autoClosingPairs.some((p) => p.open === '$'));
    assert.equal(latexConfiguration.comments.lineComment, '%');
  });
  test('extension routing: tex/sty/cls → latex, bib → bibtex, others → null', () => {
    assert.equal(langForTexExt('tex'), 'latex');
    assert.equal(langForTexExt('sty'), 'latex');
    assert.equal(langForTexExt('cls'), 'latex');
    assert.equal(langForTexExt('bib'), 'bibtex');
    assert.equal(langForTexExt('jl'), null);
  });
});

/* ── markers mapping (P9, A20) ── */

describe('markersForProblems', () => {
  const problems = [
    { kind: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence' },
    { kind: 'warning', file: 'main.tex', line: 9, message: 'Overfull alert' },
    { kind: 'badbox', file: 'main.tex', line: 11, message: 'Overfull \\hbox' },
    { kind: 'error', file: 'included.tex', line: 2, message: 'other file' },
    { kind: 'error', file: 'main.tex', line: null, message: 'no line' },
  ];

  test('severity map: error→Error, warning→Warning, badbox→Hint', () => {
    const rows = markersForProblems(monacoStub, problems, 'main.tex');
    assert.deepEqual(rows.map((r) => r.severity), [8, 4, 1]);
    assert.equal(rows[2].message, 'Overfull \\hbox');
  });

  test('A20: rows are filtered to the exact model file; line-less rows dropped', () => {
    const rows = markersForProblems(monacoStub, problems, 'main.tex');
    assert.equal(rows.length, 3, 'included.tex and line:null rows excluded');
    assert.ok(rows.every((r) => r.startLineNumber === r.endLineNumber));
  });

  test('endColumn rides the injected lineMaxColumn', () => {
    const rows = markersForProblems(monacoStub, problems, 'main.tex', { lineMaxColumn: (ln) => ln * 10 });
    assert.equal(rows[0].endColumn, 30);
  });

  test('empty/null input → no rows', () => {
    assert.deepEqual(markersForProblems(monacoStub, null, 'main.tex'), []);
  });

  /* ── S2.3 boundary clamping (monaco-s2 §1, review concern 6) ── */

  test('concern 6: out-of-range lines clamp to the LAST line; columns derive from the clamped line only', () => {
    // stale-diagnostics shape: rows from the last DISK compile pointing past
    // a dirty model's current 3-line buffer
    const stale = [
      { kind: 'error', file: 'main.tex', line: 118, message: 'stale error' },
      { kind: 'warning', file: 'main.tex', line: 3, message: 'still in range' },
      { kind: 'badbox', file: 'main.tex', line: 999, message: 'stale box' },
    ];
    const called = [];
    // the real model.getLineMaxColumn THROWS out of range — the shim asserts
    // the "columns from the clamped line ONLY" property by doing the same
    const lineMaxColumn = (ln) => {
      if (ln > 3) throw new Error(`getLineMaxColumn(${ln}) out of range — the real model throws`);
      called.push(ln);
      return ln + 10;
    };
    const rows = markersForProblems(monacoStub, stale, 'main.tex', { lineCount: 3, lineMaxColumn });
    assert.deepEqual(rows.map((r) => [r.startLineNumber, r.endLineNumber]),
      [[3, 3], [3, 3], [3, 3]], 'out-of-range rows land on the LAST line (explicit policy)');
    assert.equal(rows[0].endColumn, 13, 'endColumn == lineMaxColumn(clamped), never the stale line');
    assert.deepEqual(rows.map((r) => r.startColumn), [1, 1, 1]);
    assert.deepEqual([...new Set(called)], [3], 'lineMaxColumn only ever saw in-range lines');
    assert.deepEqual(rows.map((r) => r.severity), [8, 4, 1], 'severities survive the clamp');
  });

  test('concern 6: in-range rows under lineCount pass through untouched (clamp is boundary-only)', () => {
    const rows = markersForProblems(monacoStub, problems, 'main.tex',
      { lineCount: 50, lineMaxColumn: (ln) => ln * 10 });
    assert.deepEqual(rows.map((r) => r.startLineNumber), [3, 9, 11]);
    assert.equal(rows[0].endColumn, 30, 'columns still ride the (unclamped) line');
  });

  test('concern 6: no lineCount opt → the historical pure pass-through (unit-shim compat)', () => {
    const rows = markersForProblems(monacoStub,
      [{ kind: 'error', file: 'main.tex', line: 118, message: 'x' }], 'main.tex');
    assert.equal(rows[0].startLineNumber, 118, 'shims that own their bounds keep the old shape');
  });
});

/* ── document symbols (P12) ── */

describe('latex symbol provider', () => {
  test('symbols mirror texOutline rows', () => {
    const model = new ModelShim('intro\n\\section{Model}\ntext\n\\subsection{The \\emph{big} shock}\\label{x}\n');
    const syms = createLatexSymbolProvider(monacoStub).provideDocumentSymbols(model);
    assert.deepEqual(syms.map((s) => [s.name, s.range.startLineNumber]),
      [['Model', 2], ['The \\emph{big} shock', 4]]);
    assert.ok(syms.every((s) => s.kind === monacoStub.languages.SymbolKind.Namespace));
    assert.ok(syms.every((s) => s.selectionRange.startLineNumber === s.range.startLineNumber));
  });
});

/* ── the extracted pure brain (texCore) ── */

describe('texCore extraction (S0 scoped extraction, A21)', () => {
  test('texOutline: balanced-brace titles, depth map, caps', () => {
    const rows = texOutline('\\section{The \\emph{big} model}\\label{x}\n\\paragraph{Deep}\n\\section{}');
    assert.deepEqual(rows[0], { depth: 1, title: 'The \\emph{big} model', line: 1 });
    assert.equal(rows[1].depth, 4);
    assert.equal(rows[2].title, '(untitled)');
    // 80-char title cap + 200-entry cap
    const long = texOutline(`\\section{${'x'.repeat(200)}}`);
    assert.equal(long[0].title.length, 80);
    const many = texOutline(Array.from({ length: 250 }, (_, i) => `\\section{S${i}}`).join('\n'));
    assert.equal(many.length, 200);
  });

  test('needsEnd counts net depth, star-aware', () => {
    assert.equal(needsEnd('\\begin{align}\nx', 'align'), true);
    assert.equal(needsEnd('\\begin{align}\nx\n\\end{align}', 'align'), false);
    assert.equal(needsEnd('\\begin{align*}\nx', 'align*'), true);
    assert.equal(needsEnd('\\begin{align}\\begin{align}\\end{align}', 'align'), true);
  });

  test('openEnvsIn: unclosed envs, innermost first, closes matched innermost-out', () => {
    assert.deepEqual(openEnvsIn('\\begin{figure}\\begin{itemize}\\begin{center}\\end{center}'),
      ['itemize', 'figure']);
    assert.deepEqual(openEnvsIn('no envs'), []);
  });

  test('texSymbolMatch: pure core of texComplete (known / miss / none / window)', () => {
    assert.deepEqual(texSymbolMatch('x \\beta'), { name: 'beta', length: 5, sym: 'β' });
    assert.deepEqual(texSymbolMatch('\\^2'), { name: '^2', length: 3, sym: '²' });
    assert.deepEqual(texSymbolMatch('\\_t'), { name: '_t', length: 3, sym: 'ₜ' });
    assert.equal(texSymbolMatch('\\notasymbolxyz').sym, null); // 'miss' path
    assert.equal(texSymbolMatch('no backslash'), null);
    // the \ falls outside the legacy 24-char window → no match
    assert.equal(texSymbolMatch('\\' + 'a'.repeat(30)), null);
    assert.equal(TEX_SYMS.alpha, 'α');
  });

  test('snippetizeArgs turns arg templates into ordered tabstops', () => {
    assert.equal(snippetizeArgs('{}{}'), '{$1}{$2}');
    assert.equal(snippetizeArgs('[]{}'), '[$1]{$2}');
    assert.equal(snippetizeArgs(''), '');
    assert.equal(snippetizeArgs(COMMON_COMMANDS.includegraphics), '[$1]{$2}');
  });
});
