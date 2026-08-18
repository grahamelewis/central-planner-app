// latex/texProviders.js — DI'd Monaco provider factories (Phase 3 S0,
// blueprint §5 / P9 / P10 / P12). Pure: NO monaco import — every factory takes
// the monaco namespace as a parameter, so the module runs under node against a
// model shim (test/latex.providers.test.mjs) and registers for real in
// monacoPane at S2 (registration is latex-only: the bibtex language gets no
// completion provider — the .bib exclusions for free).
//
// The completion logic ports texEditorAttach's compute() contexts verbatim via
// the shared texCore.js detectors (CITE_RE/REF_RE/ENV_RE/CMD_RE — one
// authority, §14 A21): cite comma-awareness, ref detail file:line, \end
// unclosed-first ordering, ≥2-char command prefixes, max 8 items, the
// texmeta 5s cache, close-brace awareness. Per §14 A8 every truncated (or
// too-short-prefix) result is `incomplete: true` so Monaco re-queries as the
// prefix grows while the widget is open.
//
// S2.2 (monaco-s2 §1, review concern 3 — the async A20 discipline):
// `provideCompletionItems` carries the FULL Monaco signature
// (model, position, context, token); the meta cache is keyed per project via
// the `metaKey` opt (risk N1: the old single slot bled a ≤5s wrong list
// across projects) with a per-key single flight (rapid incomplete-list
// re-queries coalesce onto ONE requestMeta, never stacked GETs); and after
// every await the query bails with an empty non-incomplete list when Monaco
// cancelled it, the model was disposed (a reboot mid-request), or an edit
// moved getVersionId — a late list never outlives the state it was computed
// against. The closing-brace rule is the pre-specced range workaround: the
// `}` is always EMITTED and an auto-paired `}` at the caret is CONSUMED by
// the replace range, so the caret lands after the brace — the legacy
// consume/hop outcome (texEditor.js closeBrace + the accept() hop) exactly.

'use strict';

import {
  COMMON_ENVS, COMMON_COMMANDS, CITE_RE, REF_RE, ENV_RE, CMD_RE,
  openEnvsIn, texOutline,
} from './texCore.js';

/** @typedef {{ labels: {label: string, file?: string, line?: number}[],
 *              cites: {key: string, title?: string, file?: string}[],
 *              envs: string[], commands: string[] }} TexMeta */

const EMPTY_META = { labels: [], cites: [], envs: [], commands: [] };

/** Stable rank → sortText so Monaco preserves our ordering (unclosed-first). */
const ord = (/** @type {number} */ i) => String(i).padStart(4, '0');

/** '{}{}' → '{$1}{$2}', '[]{}' → '[$1]{$2}' — snippet tabstops per arg slot. */
/** @param {string} template @returns {string} */
export function snippetizeArgs(template) {
  let n = 0;
  return template.replace(/\{\}|\[\]/g, (pair) => (pair === '{}' ? `{$${++n}}` : `[$${++n}]`));
}

/** Trigger characters for the latex completion provider (P10). */
export const latexTriggerCharacters = ['\\', '{', ','];

/**
 * Completion provider factory ('latex' only — never register for 'bibtex').
 * @param {any} monaco the monaco namespace (DI)
 * @param {{ requestMeta?: () => Promise<TexMeta>, metaKey?: () => string,
 *           maxItems?: number, metaTtlMs?: number }} [opts]
 *   `metaKey` names the cache slot the CURRENT query belongs to (monacoPane
 *   passes the active project) — captured once at query entry.
 * @returns {any} a monaco.languages.CompletionItemProvider
 */
export function createLatexCompletionProvider(monaco, opts = {}) {
  const maxItems = opts.maxItems ?? 8;
  const metaTtlMs = opts.metaTtlMs ?? 5000;
  const metaKey = () => String(opts.metaKey ? opts.metaKey() : '');
  /** @type {Map<string, { meta: TexMeta, at: number }>} per-key 5s cache (N1) */
  const metaCache = new Map();
  /** @type {Map<string, Promise<TexMeta>>} per-key single flight (concern 3) */
  const metaFlights = new Map();

  async function freshMeta() {
    // the key is captured at ENTRY: a response to a request issued for
    // project A caches under A even when the active project moved while the
    // GET was in flight — per-key slots are disjoint, so an out-of-order
    // (slow, old) resolution can never overwrite a newer key's cache
    const key = metaKey();
    const hit = metaCache.get(key);
    if (hit && Date.now() - hit.at < metaTtlMs) return hit.meta;
    const flying = metaFlights.get(key);
    if (flying) return flying; // coalesce concurrent re-queries onto one GET
    const flight = (async () => {
      try {
        const md = (await opts.requestMeta?.()) || EMPTY_META;
        metaCache.set(key, { meta: md, at: Date.now() });
        return md;
      } catch {
        // degrade, never throw (offline, or monacoPane's dead-boot-generation
        // discard): serve the stale slot if one exists, else empty — and the
        // TTL is NOT refreshed, so the next query retries the fetch
        const stale = metaCache.get(key);
        return stale ? stale.meta : EMPTY_META;
      } finally {
        metaFlights.delete(key);
      }
    })();
    metaFlights.set(key, flight);
    return flight;
  }

  const Kind = () => monaco.languages.CompletionItemKind;
  const SnippetRule = () => monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  return {
    triggerCharacters: latexTriggerCharacters,

    /**
     * Full Monaco signature (S2.2, review concern 3). `context` is unused —
     * the four detectors re-derive the context from the text itself; `token`
     * feeds the post-await bail below.
     * @param {any} model needs getValueInRange + getLineContent +
     *   getVersionId (+ isDisposed under the real monaco)
     * @param {{ lineNumber: number, column: number }} position
     * @param {any} [_context] monaco CompletionContext
     * @param {any} [token] monaco CancellationToken
     */
    async provideCompletionItems(model, position, _context, token) {
      // A20 async discipline: the entry revision is recorded and after EVERY
      // await the query bails empty (non-incomplete) when Monaco cancelled
      // it, the model was disposed (a reboot mid-request), or an edit moved
      // the version — a late list must never outlive the state it was
      // computed against. isDisposed is checked FIRST: getVersionId throws
      // on a disposed model.
      const verAtEntry = model.getVersionId();
      const bailed = () => !!(
        (token && token.isCancellationRequested)
        || (typeof model.isDisposed === 'function' && model.isDisposed())
        || model.getVersionId() !== verAtEntry
      );
      const BAIL = { suggestions: [], incomplete: false };
      const upto = model.getValueInRange({
        startLineNumber: 1, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: position.column,
      });
      const lineText = String(model.getLineContent(position.lineNumber));
      const nextChar = lineText.slice(position.column - 1, position.column);
      // closeBrace parity (the S2.2 dedicated case; blueprint §2 completions
      // row, pre-specced range workaround): the `}` is always EMITTED and,
      // when an auto-paired `}` already sits at the caret, the replace range
      // grows one column to CONSUME it. Monaco puts the caret at the end of
      // the inserted text, so it lands AFTER the brace either way — exactly
      // the legacy accept() outcome (closeBrace suppress-the-append THEN hop
      // over the existing closer). Merely omitting the brace (the pre-parity
      // shape) left the caret BEFORE the auto-paired closer — the one
      // overtype divergence the parity case caught.
      const consume = nextChar === '}' ? 1 : 0;
      const range = (/** @type {number} */ prefixLen, cons = 0) => ({
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - prefixLen),
        endLineNumber: position.lineNumber,
        endColumn: position.column + cons,
      });
      const list = (/** @type {any[]} */ suggestions, incomplete = false) =>
        ({ suggestions, incomplete });
      let m;

      if ((m = upto.match(CITE_RE))) {
        const prefix = m[1].split(',').pop().trim();
        const md = await freshMeta();
        if (bailed()) return BAIL;
        const pool = md.cites.filter((c) => c.key.toLowerCase().includes(prefix.toLowerCase()));
        return list(pool.slice(0, maxItems).map((c, i) => ({
          label: c.key,
          kind: Kind().Reference,
          detail: c.title || c.file || '',
          insertText: c.key + '}',
          range: range(prefix.length, consume),
          sortText: ord(i),
        })), pool.length > maxItems);
      }

      if ((m = upto.match(REF_RE))) {
        const prefix = m[1];
        const md = await freshMeta();
        if (bailed()) return BAIL;
        const pool = md.labels.filter((l) => l.label.toLowerCase().includes(prefix.toLowerCase()));
        return list(pool.slice(0, maxItems).map((l, i) => ({
          label: l.label,
          kind: Kind().Reference,
          detail: `${l.file}:${l.line}`,
          insertText: l.label + '}',
          range: range(prefix.length, consume),
          sortText: ord(i),
        })), pool.length > maxItems);
      }

      if ((m = upto.match(ENV_RE))) {
        const which = m[1];
        const prefix = m[2];
        const md = await freshMeta();
        if (bailed()) return BAIL;
        // \end → environments still open above the caret FIRST (unclosed-first)
        const pool = (which === 'end'
          ? [...new Set([...openEnvsIn(upto), ...COMMON_ENVS, ...md.envs])]
          : [...new Set([...md.envs, ...COMMON_ENVS])].sort())
          .filter((e) => e.toLowerCase().startsWith(prefix.toLowerCase()));
        return list(pool.slice(0, maxItems).map((env, i) => (which === 'begin'
          ? {
            label: env,
            kind: Kind().Module,
            detail: 'environment — inserts \\end too',
            // the skeleton legacy accept() built, as a snippet: close the
            // brace, open an indented body line, add the matching \end (the
            // shared consume rule eats an auto-paired `}` at the caret)
            insertText: `${env}}\n\t$0\n\\end{${env}}`,
            insertTextRules: SnippetRule(),
            range: range(prefix.length, consume),
            sortText: ord(i),
          }
          : {
            label: env,
            kind: Kind().Module,
            detail: 'close environment',
            insertText: env + '}',
            range: range(prefix.length, consume),
            sortText: ord(i),
          })), pool.length > maxItems);
      }

      if ((m = upto.match(CMD_RE))) {
        const prefix = m[1];
        const md = await freshMeta();
        if (bailed()) return BAIL;
        // a 1-char prefix shows nothing yet, but stays incomplete so Monaco
        // re-queries as the prefix grows (§14 A8)
        if (prefix.length < 2) return list([], true);
        const names = [...new Set([...Object.keys(COMMON_COMMANDS), ...md.commands])].sort();
        const pool = names.filter((n) => n.startsWith(prefix) && n !== prefix);
        return list(pool.slice(0, maxItems).map((n, i) => {
          const template = COMMON_COMMANDS[n] || '';
          const hasArgs = template.includes('{}') || template.includes('[]');
          return {
            label: '\\' + n,
            kind: Kind().Function,
            detail: template,
            // arg templates become snippets (caret into $1 — the legacy
            // caretBack parity; the template's own trailing `}` means legacy
            // never hopped, so no consume). A NO-arg command accepted at an
            // auto-paired `}` emits + consumes it — the legacy hop
            // (accept(): insert not ending in '}' + '}' at caret → hop).
            insertText: hasArgs ? n + snippetizeArgs(template)
              : n + (consume ? '}' : ''),
            ...(hasArgs ? { insertTextRules: SnippetRule() } : {}),
            range: range(prefix.length, hasArgs ? 0 : consume),
            sortText: ord(i),
          };
        }), pool.length > maxItems);
      }

      return { suggestions: [], incomplete: false };
    },
  };
}

/**
 * Map compile problems → monaco markers for ONE model (P9, §14 A20: rows are
 * filtered to the exact source file so included-file diagnostics never land on
 * wrong lines). Severity: error→Error, warning→Warning, badbox→Hint (the
 * deliberate tint exclusion rides the Hint severity).
 *
 * Boundary clamping (S2.3, monaco-s2 §1 review concern 6): a diagnostic from
 * the last DISK compile can point past a dirty model's CURRENT line count, and
 * the real model.getLineMaxColumn THROWS on an out-of-range line — mid-repaint.
 * Clamping is THIS helper's job. Explicit policy: an out-of-range problem
 * lands on the LAST line — the marker stays visible near where the content
 * ended, and the problems strip remains the precise navigation source (the
 * strip stays outside the editor). Columns are always derived from the CLAMPED
 * line (startColumn 1, endColumn lineMaxColumn(clamped)), so `lineMaxColumn`
 * is never called out of range. Callers pass the TARGET model's live
 * getLineCount() at EVERY apply and re-apply (monacoPane's fan-out does —
 * never cached); omitting `lineCount` keeps the historical pure pass-through
 * for unit shims that own their own bounds.
 * @param {any} monaco the monaco namespace (DI)
 * @param {TexProblem[] | null | undefined} problems
 * @param {string} rel the model's project-relative path
 * @param {{ lineMaxColumn?: (line: number) => number, lineCount?: number }} [opts]
 * @returns {any[]} IMarkerData rows for setModelMarkers(model, 'texlog', rows)
 */
export function markersForProblems(monaco, problems, rel, opts = {}) {
  const lineMaxColumn = opts.lineMaxColumn || (() => 1000);
  const lineCount = Number.isFinite(opts.lineCount) && opts.lineCount >= 1
    ? Math.floor(/** @type {number} */ (opts.lineCount)) : Infinity;
  const S = monaco.MarkerSeverity;
  /** @type {{ [kind: string]: number }} */
  const sev = { error: S.Error, warning: S.Warning, badbox: S.Hint };
  return (problems || [])
    .filter((p) => p.file === rel && typeof p.line === 'number' && p.line > 0)
    .map((p) => {
      // clamp FIRST, derive columns from the clamped line ONLY (concern 6)
      const line = Math.max(1, Math.min(Math.floor(/** @type {number} */ (p.line)), lineCount));
      return {
        severity: sev[p.kind || ''] ?? S.Info,
        message: p.message || '(no message)',
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: lineMaxColumn(line),
      };
    });
}

/**
 * DocumentSymbolProvider fed by the extracted texOutline (P12): the same rows
 * as the § dropdown, so ⇧⌘O arrives free and can never disagree with it.
 * @param {any} monaco the monaco namespace (DI)
 * @returns {any}
 */
export function createLatexSymbolProvider(monaco) {
  return {
    /** @param {any} model needs getValue */
    provideDocumentSymbols(model) {
      return texOutline(model.getValue()).map((s) => {
        const range = {
          startLineNumber: s.line, startColumn: 1,
          endLineNumber: s.line, endColumn: 1,
        };
        return {
          name: s.title,
          detail: '',
          kind: monaco.languages.SymbolKind.Namespace,
          tags: [],
          range,
          selectionRange: range,
        };
      });
    },
  };
}
