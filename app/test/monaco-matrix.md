# Monaco A14 evidence matrix — P1–P22 (Phase 3, S2.EXIT)

CONTRACT.md "Phase 3 — Monaco editor" → "Ladder & exit gates" (A14): **the
evidence matrix is a required exit artifact**, one row per P1–P22 integration
point, plus the genuine-keyboard E2E block. **Verification consumes a recorded
test-run artifact** (`monaco-matrix-run.json`) — commit SHA + dirty flag,
per-test pass/fail with the `[impl=…]` mode tags, per-mode skips, and dated
manual-evidence entries. Proving a cited test *title exists* is
reference-checking, not verification — the standing verifier
(`monaco-matrix.test.mjs`) never greps suite files for titles; the run record
is the only evidence it accepts.

- **Regenerate the run record**: `cd app && node test/monaco-matrix-run.mjs`
  (serial, billing-safe by construction — it shells only to
  `node --test --test-reporter=tap` on the suite files cited below).
- **Verify**: `node --test test/monaco-matrix.test.mjs` (runs inside
  `npm test` too; it SKIPS the evidence check — loudly — when the run record
  is absent, older than 7 days, or recorded at a different SHA than HEAD, and
  verifies fully when the record is fresh).
- **Format (machine-parsed — keep exact)**: each row is an `## <id> — <name>`
  heading (`P1`–`P22`, `E1`–`E10`, `G1`–`G3`, `MX`), followed by bullet lines:
  - `- [dual] ` `` `file.test.mjs` `` ` :: ` `` `title` `` — a
    `testBothImpls` contract; the verifier requires BOTH
    `title [impl=legacy]` AND `title [impl=monaco]` to have passed.
  - `- [legacy] | [monaco] | [unit] ` — a single recorded test (exact title);
    the tag names the implementation mode the evidence speaks for (`unit` =
    impl-agnostic pure/server suite).
  - `- [manual] S2b-GATED (YYYY-MM-DD): …` — evidence NO test can provide.
    S2b-gated items (physical IME/iPad, budgets, accessibility, feel) are
    recorded as dated placeholders and are **never fake-passed**; S2b replaces
    the placeholder with dated actual evidence.
- Numbering is frozen per CONTRACT's P1–P22 index (the seams-doc remap is
  rationale). Legacy-pinned rows (the ui.tex-editor custom-indent block,
  lines 214–310) stay legacy evidence **by design** until S3 — the disclosed
  opt-in-window divergence is noted inline where it applies.

Status of this revision: written 2026-08-17 at S2.EXIT; S2 exits **OPT-IN**
(`editor:impl` stays `'legacy'`-default; A11 — the flip is S2b's own commit).

---

## P1 — drafts / dirty / saveChip

`drafts` stay authoritative; dirty = altId, never bytes; chip truth incl. the
M6 suppressed-clean state.

- [dual] `ui.monaco-settings.test.mjs` :: `KEEP pilot — P1 dirty chip + tab dot: genuine typing dirties, ⌘S writes disk and cleans`
- [dual] `ui.texrun.test.mjs` :: `save chip dual: constant box, dot flips on typing, a chip click saves to disk`
- [monaco] `ui.monaco-core.test.mjs` :: `M1: draft-backed creation is dirty at birth; ⌘Z reaches disk baseline; sentinel path refuses save then recovers`
- [monaco] `ui.monaco-stale.test.mjs` :: `A9 GATE: conflict → ⚠ → ⌘Z to the old baseline → automatic fresh reload — saved only after the model shows the NEW disk text; savedAltId===fresh; redo is a no-op`
- [monaco] `ui.monaco-stale.test.mjs` :: `I1 drafts retention: kill the Monaco instance in AltCleanStale (reboot + injected init failure) → the legacy fallback still has drafts[k] on screen, ⚠ retained, preference unchanged; the dead flight's late resolution is dropped`

## P2 — ⌘S save / 409 / recovery

M3 tokens (`beginSave`/`commitSave`), M5 clipboard-before-destruction, the
S2.1 `files.saveFile` re-anchor with the legacy body byte-identical.

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: type A · ⌘S · type B before the 200 → amber + rebased draft; ⌘Z → saved, draft deleted`
- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: double-⌘S in flight → exactly two ordered PUTs, final clean; triple-⌘S coalesces to the same two`
- [monaco] `ui.monaco-save.test.mjs` :: `T6: a failed PUT toasts, keeps the draft and consumes the seq; a post-dispose 200 is dropped with a log line and zero mutation`
- [monaco] `ui.monaco-save.test.mjs` :: `M5: 409 → cancel is a total no-op (repeatable); accept+clipboard-denied destroys nothing; accept+clipboard-ok reloads disk with the draft (incl. post-⌘S keystrokes) on the clipboard`
- [monaco] `ui.monaco-save.test.mjs` :: `S2.1 re-anchor: files.saveFile under monaco rides the M3 queue (savedAltId === token.altId, coalesced, no double PUT); a no-model fkey keeps the legacy body`
- [monaco] `ui.monaco-save.test.mjs` :: `S2.1 re-anchor: a 409 through files.saveFile lands in the M5 ladder (in-app confirm, drafts intact; cancel is a total no-op)`
- [legacy] `ui.monaco-save.test.mjs` :: `S2.1 re-anchor: files.saveFile under the legacy impl is byte-identical (no token; native confirm on 409)`

## P3 — file:changed reload + 3-way merge

`applyExternal` closed reason set; merge = history rebase (M4); M6 reconcile.

- [dual] `ui.filechanged.test.mjs` :: `file:changed dual: clean reload in place; non-overlap merges into the draft; overlap pins ⚠ disk`
- [dual] `ui.texauto.test.mjs` :: `turn-end dual: ▶-created deck tab + session file:changed → exactly one queued compile; clean editor reloads`
- [monaco] `ui.monaco-merge.test.mjs` :: `A1 GATE: type OURS → non-overlapping THEIRS lands + file:changed → ⌘Z → THEIRS/saved → save is a no-op, THEIRS survives on disk; exactly one signal; caret restored`
- [monaco] `ui.monaco-merge.test.mjs` :: `T2 bail: overlapping edit → ⚠ chip, model still OURS, drafts intact, zero txns, one toast per pinning; ⌘S runs the M5 409 net`
- [monaco] `ui.monaco-merge.test.mjs` :: `serialization: two rapid file:changed events merge in order — the second BASE is the first's committed THEIRS; exactly one signal each`
- [monaco] `ui.monaco-merge.test.mjs` :: `background merge: a non-attached fkey rebases via applyExternal without moving the visible caret; reattach shows MERGED + amber; a background T3 reload lands via cleanReload`

## P4 — external pins

Same model-per-fkey; `cp:` URIs tolerate absolute fkeys; grant/refusal rows.

- [dual] `ui.extedit.test.mjs` :: `P4 dual: external pin edits + ⌘S through the grant; file:changed reloads; 409-cancel and 403 destroy nothing`
- [monaco] `ui.monaco-save.test.mjs` :: `an external-pin fkey rides the identical token machine (stubbed /api/extfile — no server mutation); toggle off keeps the legacy save path`
- [unit] `api.extedit.test.mjs` :: `a granted external file saves through the pin grant (and reports mtimeMs)`
- [unit] `api.extedit.test.mjs` :: `the mtime conflict guard refuses a stale save (409)`

## P5 — fetch contract

Untouched fetch layer; `x-mtime-ms` header-first; 200k/binary → read-only
`hlText`, no model.

- [monaco] `ui.monaco-core.test.mjs` :: `M1 clean open, one-signal creation, CRLF/mixed/no-final/BOM byte behavior, >200k → no model`
- [legacy] `ui.mdview.test.mjs` :: `a ＋-added .md renders from disk and refreshes on file:changed`
- [unit] `hl.test.mjs` :: `hlText(tex) round-trips text exactly (strip tags + unescape === input)`

## P6 — texfix

`texfix {arm, revalidate, resolve}`; the `latex/texfixAnchors.js` engine;
apply flows as typing (M2-unguarded); `'accepted'` wire vocabulary.

- [legacy] `ui.texfix.test.mjs` :: `suggestions arrive: red mark + a readable pane superimposed under it`
- [legacy] `ui.texfix.test.mjs` :: `Apply on the pane lands in the draft and resolves — WITHOUT moving the view`
- [legacy] `ui.texfix.test.mjs` :: `a suggestion the user already fixed goes stale quietly (grace period)`
- [monaco] `ui.monaco-texfix.test.mjs` :: `arrival: sticky mark + ✦ content-widget pane, tracks typing above; apply = ONE undoable typed edit, wire {id, status:'accepted'} verbatim, scroll + strip untouched (no renderWB)`
- [monaco] `ui.monaco-texfix.test.mjs` :: `the user already fixed it: visuals drop, apply REFUSES while stale, and the engine's single 5.2s grace resolves 'stale' exactly once`
- [monaco] `ui.monaco-texfix.test.mjs` :: `apply-guard differential: a range corrupted between arm and click REFUSES (one synchronous re-find, no wrong-text replacement — the unguarded edit is proven wrong), then the re-click is safe`
- [monaco] `ui.monaco-texfix.test.mjs` :: `two files, one find string: only the suggestion's NAMED file gains decoration/widget/edit; tab switches re-arm the active-model-only engine per file`
- [unit] `texfixAnchors.test.mjs` :: `clean apply: replaces exactly the anchored text, resolves applied`
- [unit] `texfixAnchors.test.mjs` :: `REFUSES when the range text has drifted — nothing is edited`

## P7 — SyncTeX forward

`addCommand(⌘J)` + `getPosition()` (1-based).

- [monaco] `ui.monaco-jumps.test.mjs` :: `forward SyncTeX: ⌘J and ◎ send the monaco caret line/col to /api/synctex/view (stubbed route)`
- [legacy] `ui.tex-editor.test.mjs` :: `forward SyncTeX (⌘J) flashes the located box in the PDF`

## P8 — SyncTeX inverse + jumps

`revealAt`: clamp → setPosition → the EXPLICIT 35% reveal → flash; I5
precedence + reopen-×-closed-pins verbatim in `texOpenAt`.

- [monaco] `ui.monaco-jumps.test.mjs` :: `a problems-strip row click jumps the monaco editor: caret, 35% reveal geometry, restartable lnFlash, timer release`
- [monaco] `ui.monaco-jumps.test.mjs` :: `I5 precedence: a pending jump beats the reopened file's remembered viewport`
- [monaco] `ui.monaco-jumps.test.mjs` :: `TTL: a jump pending behind a slow fetch expires at 15s — no late reveal; a fresh jump still lands`
- [monaco] `ui.monaco-jumps.test.mjs` :: `a strip click on a ×-closed pin REOPENS the tab and lands the jump (texOpenAt untouched)`
- [legacy] `ui.monaco-jumps.test.mjs` :: `legacy control: strip click jumps the TEXTAREA caret; boot stays IDLE, zero vendor fetches, zero command fires`
- [legacy] `ui.tex-editor.test.mjs` :: `inverse SyncTeX: double-click in the PDF jumps the editor`

## P9 — compile problems

`setProblems` → `setModelMarkers('texlog')` + whole-line tints; badbox = Hint,
never tinted; boundary clamp to the LAST line; the strip stays outside.

- [monaco] `ui.monaco-problems.test.mjs` :: `problem rows land as texlog markers (badbox→Hint) with .lnErr/.lnWarn tint parity; rows route per model; empty rows sweep`
- [monaco] `ui.monaco-problems.test.mjs` :: `stale diagnostics: rows past a shrunk dirty buffer clamp to the LAST line — no throw, chip/undo unaffected`
- [monaco] `ui.monaco-problems.test.mjs` :: `a cleanReload txn re-arms markers/tints synchronously against the new text; disposeModel clears texlog markers`
- [legacy] `ui.monaco-problems.test.mjs` :: `legacy impl: the strip and texMarkLines tints behave as today; NO monaco problems machinery arms`
- [legacy] `ui.tex-editor.test.mjs` :: `problems strip: warning chips, expand, click jumps the editor`
- [dual] `ui.build-status.test.mjs` :: `run-card dual: a failing .tex run renders the ✗ card; the error-row click jumps the editor to the line`
- [unit] `latex.providers.test.mjs` :: `severity map: error→Error, warning→Warning, badbox→Hint`
- [unit] `latex.providers.test.mjs` :: `concern 6: out-of-range lines clamp to the LAST line; columns derive from the clamped line only`

## P10 — completions

The `latex/texProviders.js` provider; `incomplete:true` re-query (A8);
'latex' only — bibtex gets no provider.

- [monaco] `ui.monaco-completions.test.mjs` :: `no-word-noise gate from first mount; \cite{ comma-aware list accepted with Enter (CDP)`
- [monaco] `ui.monaco-completions.test.mjs` :: `A8 proven: a target absent from the first eight surfaces via the incomplete re-query as the prefix grows`
- [monaco] `ui.monaco-completions.test.mjs` :: `the .bib exclusion: no completion provider on 'bibtex' — trigger chars open nothing`
- [dual] `ui.monaco-completions.test.mjs` :: `closeBrace overtype parity: \ref accept inside the auto-paired } lands text AND caret identically`
- [legacy] `ui.monaco-completions.test.mjs` :: `legacy-untouched control: impl=legacy keeps the .texCompl popup and has NO suggest machinery`
- [legacy] `ui.tex-editor.test.mjs` :: `\ref{ completion lists labels; accept inserts key and closes the brace`
- [unit] `latex.providers.test.mjs` :: `cite truncation: max 8 items and incomplete:true for the re-query (A8)`
- [unit] `latex.providers.test.mjs` :: `per-key single flight: concurrent queries coalesce onto ONE requestMeta`
- [unit] `latex.providers.test.mjs` :: `metaKey keys the 5s cache per project — no cross-project bleed (risk N1)`

## P11 — pairs / auto-\end / indent

Language configuration + the S2.0-proven Enter command; `needsEnd` shared
from `latex/`; the A18 multi-cursor rule. NOTE (disclosed divergence, §2):
the legacy `\item`-alignment indent rows stay LEGACY-PINNED until S3; Monaco
ships Monaco-default Enter indentation during the opt-in window.

- [monaco] `ui.monaco-commands.test.mjs` :: `Enter after an unclosed \begin inserts the skeleton (single ⌘Z atomic); a closed env falls through (fullNE)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Enter and Tab go to the WIDGET — the guarded commands never fire (the !suggestWidgetVisible conjunct)`
- [monaco] `ui.monaco-commands.test.mjs` :: `A18: with 2 cursors Enter falls through — plain newlines at BOTH carets, NO skeleton despite needsEnd true`
- [legacy] `ui.monaco-commands.test.mjs` :: `legacy control: the textarea keeps its own auto-\end and ⌘/; no monaco command ever fires`
- [legacy] `ui.tex-editor.test.mjs` :: `Enter after \begin{env} auto-inserts the matching \end`
- [legacy] `ui.tex-editor.test.mjs` :: `auto-pairs: braces wrap selections and closers overtype`
- [unit] `latex.providers.test.mjs` :: `needsEnd counts net depth, star-aware`
- [unit] `latex.providers.test.mjs` :: `latex auto-pairs $…$; bibtex omits the $ pair by contract`

## P12 — ⌘/ + § outline

Native `commentLine` via the comments config; `texOutline` feeds both the
dropdown and the DocumentSymbolProvider.

- [monaco] `ui.monaco-commands.test.mjs` :: `⌘/ toggles whole-line % comments and preserves the selection (native commentLine, comments config)`
- [monaco] `ui.monaco-jumps.test.mjs` :: `§ outline pick jumps through revealAt with the flash; ⇧⌘O lists the SAME texOutline rows and jumps`
- [legacy] `ui.tex-editor.test.mjs` :: `⌘/ toggles % comments`
- [legacy] `ui.tex-editor.test.mjs` :: `§ outline lists sections with clean titles and jumps on click`
- [unit] `latex.providers.test.mjs` :: `texOutline: balanced-brace titles, depth map, caps`
- [unit] `latex.providers.test.mjs` :: `symbols mirror texOutline rows`

## P13 — ▶ run / ⌘⏎

`addCommand(⌘⏎)` → `runFile`; the amber dot rides `onDirtyChange`.

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: ⌘⏎ during an in-flight ⌘S → the compile starts only after the coalesced save commits, on the saved bytes`
- [dual] `ui.texrun.test.mjs` :: `save chip dual: constant box, dot flips on typing, a chip click saves to disk`
- [dual] `ui.tex-subdir.test.mjs` :: `▶ dual: draft.tex then slides.tex get coexisting pdf tabs; selection never reorders the strip`
- [legacy] `ui.texrun.test.mjs` :: `toolbar ▶ recompiles (⊘ mid-run, same box) and the corner dot tracks the draft`
- [legacy] `ui.texrun.test.mjs` :: `document ▶ saves a dirty included file, then compiles the viewer root`

## P14 — foot chrome

Plain DOM around the editor; host datasets update synchronously in `setFile`
(the kept container preserves `#codeEditor` + datasets — the dual suites'
mount signal).

- [monaco] `ui.monaco-core.test.mjs` :: `M1 clean open, one-signal creation, CRLF/mixed/no-final/BOM byte behavior, >200k → no model`
- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`
- [dual] `ui.dragtab.test.mjs` :: `drag dual: dropping c.tex on the target task pins it once, without switching task or editor`
- [legacy] `ui.texrun.test.mjs` :: `foot ▶/⊘ share one fixed box — a starting run shifts nothing`
- [legacy] `ui.texrun.test.mjs` :: `the save chip: constant box, the dot flips, a click saves`

## P15 — wrap policy

`wordWrap` per `setFile`; scroll rides viewState.

- [monaco] `ui.monaco-latex.test.mjs` :: `latex/bibtex routing, ≥3 token classes in the DOM, wash == scanner, wrap policy, A18 indent pin`
- [legacy] `ui.editor-wrap.test.mjs` :: `a .tex editor soft-wraps: no horizontal scroll, layers agree`
- [legacy] `ui.editor-wrap.test.mjs` :: `code files are untouched: wrap stays off, long lines scroll right`

## P16 — viewport keep across renderWB

Kept-connected host (A7); `saveViewStateFor`; focus captured before detach.

- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`
- [monaco] `ui.monaco-core.test.mjs` :: `M7-T2 mixed-EOL steady state: renderWB storms fire ZERO txns on a clean mixed.tex — caret, undo/redo, chip intact; a genuine disk change still reloads`
- [legacy] `ui.editor-hl.test.mjs` :: `the editor keeps its place across a ≋ console round-trip`
- [legacy] `ui.editor-hl.test.mjs` :: `background events never move a focused editor (the mid-typing top-bump)`
- [manual] S2b-GATED (2026-08-17): the viewport-keep FEEL — real writing mid-document while a session floods file:changed/run:status renders, judged by eye for caret/scroll/composition stillness on physical hardware. Procedure: long .tex open, type continuously through ≥3 render storms, then flip focus mode twice; any perceptible jump is a Sev-2. Runs during the S2b soak; a test can prove coordinates, not feel.

## P17 — focus mode + editHold

`automaticLayout`/`layout()`; `holdEditor` = blur + readOnly; grey and
keyboard can never diverge.

- [monaco] `ui.monaco-core.test.mjs` :: `C2-MF5 editHold: raise blurs + pins readOnly (typing lands nothing, even force-focused); release unpins + hands focus back only if held at raise`
- [monaco] `ui.focus.test.mjs` :: `focus + monaco: the tail repair docks the kept editor on the first valid file, typing lands; no visible file → focusnote parks the host`
- [legacy] `ui.focus.test.mjs` :: `click → sidebar gone, viewer and console side by side; persisted`
- [legacy] `ui.focus.test.mjs` :: `reload restores focus mode; toggling back restores the stacked layout`
- [dual] `ui.vsplit.test.mjs` :: `vsplit dual: the divider floor keeps sessbar + composer whole under either editor impl`

## P18 — Voice Space-PTT

`editContext:false` pin + the explicit `.monaco-editor` bail + CDP proof (the
I3 triple guard). CDP-covered — NOT a physical-device row (§7 disposition 8);
the mic guard is a monaco-side contract and its legacy-behavior control
(Space outside still PTTs) runs inside the same cases.

- [monaco] `ui.voice.test.mjs` :: `Space while Monaco focused never mics; Space outside still starts PTT (I3 leg c, pinned textarea surface)`
- [monaco] `ui.voice.test.mjs` :: `I3 leg (b) is load-bearing under EditContext: Space inside the editor still never mics`
- [monaco] `ui.monaco-core.test.mjs` :: `EDITCONTEXT PIN: the default surface is editContext:false and the IME case holds on it`
- [monaco] `ui.monaco-core.test.mjs` :: `I2-IME under editContext:true (EditContext surface)`
- [monaco] `ui.monaco-core.test.mjs` :: `I2-IME under editContext:false (textarea surface)`

## P19 — julia \symbol Tab

Per-language Tab command; `wireGlobal`'s exclusion is the `.monaco-editor`
bail.

- [monaco] `ui.monaco-core.test.mjs` :: `P19 Tab: inside Monaco Tab indents and keeps focus — the prose \symbol handler never fires; \beta⇥ in the composer still completes`
- [monaco] `ui.monaco-commands.test.mjs` :: `julia Tab: \beta⇥ → β; a miss falls through to a NATIVE tab; latex \beta⇥ keeps \beta (context-gated)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Tab in a JULIA model goes to the WIDGET — the guard does real work where the context would otherwise match`
- [legacy] `ui.tex.test.mjs` :: `editor: .jl files complete like the Julia REPL; plain Tab still indents`
- [legacy] `ui.tex.test.mjs` :: `editor: .tex files never convert — Tab is indentation only`
- [unit] `latex.providers.test.mjs` :: `texSymbolMatch: pure core of texComplete (known / miss / none / window)`

## P20 — md ▤ preview

Model-content ping → `mdPreviewSchedule`; drafts remain the source (P1).

- [dual] `ui.mdview.test.mjs` :: `P20 dual: typing live-updates the ▤ pane in place — debounce, drafts-as-source, scroll kept`
- [monaco] `ui.monaco-commands.test.mjs` :: `P20: typing in a .md model pings mdPreviewSchedule through signalOnce (no rebuild — verify only)`
- [legacy] `ui.mdview.test.mjs` :: `typing in the editor live-updates the pane IN PLACE — scroll and element kept`

## P21 — center-tab model

Untouched tab model; close is a VIEW close; LRU-50 is clean-only (M7/A10).

- [monaco] `ui.monaco-m7.test.mjs` :: `close dirty tab → reopen: model/undo/viewState/amber all restored, drafts intact throughout; orphan counter moves (A10 view-close gate)`
- [monaco] `ui.monaco-m7.test.mjs` :: `LRU: 60 clean + 5 dirty models → clean-detached ≤ 50, oldest evicted first, every dirty model + draft survives; counters exist and move across open/evict`
- [dual] `ui.extratabs.test.mjs` :: `◇ dual: a browser open becomes a persisted focused extra; a pinned file opens its pin tab instead`
- [dual] `ui.dragtab.test.mjs` :: `drag dual: dropping c.tex on the target task pins it once, without switching task or editor`
- [legacy] `ui.extratabs.test.mjs` :: `× closes an extra for good — it stays closed across refreshes`

## P22 — prefs touching the editor

Theme via `cpDefineThemes` from `applyTheme`; dividers via `automaticLayout`;
viewStates in-memory only.

- [monaco] `ui.monaco-latex.test.mjs` :: `cp themes: defined before createEditor, palette from live CSS vars, re-applied on an OS scheme flip`
- [monaco] `ui.monaco-settings.test.mjs` :: `COLD PAGE: module eval clean; Settings flips legacy→monaco→legacy through setImpl with a draft alive (T7/T8 handoff), preference persisted`
- [legacy] `ui.settings.test.mjs` :: `profile menu → Settings → Light: applies, persists, survives reload`
- [dual] `ui.vsplit.test.mjs` :: `vsplit dual: the divider floor keeps sessbar + composer whole under either editor impl`

---

# Genuine-keyboard E2E block (A14, second clause)

Every citation below drives real CDP keystrokes (the `__mp`-bypass rule).

## E1 — typing

- [dual] `ui.monaco-settings.test.mjs` :: `KEEP pilot — P1 dirty chip + tab dot: genuine typing dirties, ⌘S writes disk and cleans`
- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`

## E2 — undo/redo

- [monaco] `ui.monaco-merge.test.mjs` :: `ladder: ⌘Z→THEIRS/saved/drafts deleted; ⇧⌘Z→MERGED/amber/drafts re-materialized; double-⌘Z bottoms at THEIRS; ⌘S writes MERGED on top with no 409`
- [monaco] `ui.monaco-stale.test.mjs` :: `A9 GATE: conflict → ⚠ → ⌘Z to the old baseline → automatic fresh reload — saved only after the model shows the NEW disk text; savedAltId===fresh; redo is a no-op`

## E3 — multi-cursor

- [monaco] `ui.monaco-commands.test.mjs` :: `A18: with 2 cursors Enter falls through — plain newlines at BOTH carets, NO skeleton despite needsEnd true`

## E4 — find/replace

- [manual] S2b-GATED (2026-08-17): genuine-input find/replace E2E — ⌘F opens Monaco's find widget, type/replace-all/Escape, buffer and undo verified; legacy control is browser-native find (no in-editor widget to test). No automated citation exists yet; owned by S2b's genuine-input E2E block.

## E5 — completion acceptance

- [monaco] `ui.monaco-completions.test.mjs` :: `no-word-noise gate from first mount; \cite{ comma-aware list accepted with Enter (CDP)`
- [monaco] `ui.monaco-completions.test.mjs` :: `\begin{ env skeleton: Enter accepts the snippet — brace consumed, body line indented, \end added`

## E6 — Enter / Tab / ⇧Enter

⇧Enter under monaco rides Monaco-native newline (no custom binding — the
guarded commands bind plain Enter and Tab only); its legacy behavior is
pinned below and the monaco-side ⇧Enter feel is watched in the S2b soak.

- [monaco] `ui.monaco-commands.test.mjs` :: `Enter after an unclosed \begin inserts the skeleton (single ⌘Z atomic); a closed env falls through (fullNE)`
- [monaco] `ui.monaco-commands.test.mjs` :: `julia Tab: \beta⇥ → β; a miss falls through to a NATIVE tab; latex \beta⇥ keeps \beta (context-gated)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Enter and Tab go to the WIDGET — the guarded commands never fire (the !suggestWidgetVisible conjunct)`
- [legacy] `ui.tex-editor.test.mjs` :: `⇧Enter stays a plain unindented newline`

## E7 — save mid-flight

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: type A · ⌘S · type B before the 200 → amber + rebased draft; ⌘Z → saved, draft deleted`
- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: double-⌘S in flight → exactly two ordered PUTs, final clean; triple-⌘S coalesces to the same two`

## E8 — merge

- [monaco] `ui.monaco-merge.test.mjs` :: `A1 GATE: type OURS → non-overlapping THEIRS lands + file:changed → ⌘Z → THEIRS/saved → save is a no-op, THEIRS survives on disk; exactly one signal; caret restored`
- [monaco] `ui.monaco-merge.test.mjs` :: `typing during the THEIRS fetch: keystrokes between fetch start and the OURS re-read appear in MERGED — never dropped`

## E9 — clipboard failure

- [monaco] `ui.monaco-save.test.mjs` :: `M5: 409 → cancel is a total no-op (repeatable); accept+clipboard-denied destroys nothing; accept+clipboard-ok reloads disk with the draft (incl. post-⌘S keystrokes) on the clipboard`

## E10 — implementation handoff

- [monaco] `ui.monaco-core.test.mjs` :: `toggle handoff with a draft alive: monaco → legacy shows it, legacy typing wins on re-entry, ⌘Z reaches the disk baseline`
- [monaco] `ui.monaco-m7.test.mjs` :: `setImpl: T7 flush bumps draftRev synchronously; legacy typing cannot bump (deviation pin); T8 re-entry bumps at the boundary and newer wins; draft saved in legacy → clean re-entry replaces the stale buffer`
- [monaco] `ui.monaco-m7.test.mjs` :: `boot-failure recovery: dirty files → injected failed boot (drafts to legacy) → cleared + rebooted to READY → models recreated from the surviving drafts, drafts WIN, ⌘Z reaches the disk baseline`
- [monaco] `ui.monaco-settings.test.mjs` :: `COLD PAGE: module eval clean; Settings flips legacy→monaco→legacy through setImpl with a draft alive (T7/T8 handoff), preference persisted`

---

# Ladder gates exercised in-suite (supporting rows, non-P)

## G1 — A11 opt-in default (S2 exits with legacy default)

- [legacy] `ui.monaco-boot.test.mjs` :: `toggle default: editor:impl unset → legacy editor, dock hidden/empty, zero vendor fetches`
- [legacy] `ui.monaco-core.test.mjs` :: `toggle off → legacy DOM intact, zero vendor fetches, boot never starts`

## G2 — I9/A15 coarse-pointer pin

- [legacy] `ui.monaco-boot.test.mjs` :: `A15 coarse pin: (pointer:coarse) and (not (any-pointer:fine)) → legacy regardless of stored monaco`
- [monaco] `ui.monaco-boot.test.mjs` :: `A15 hybrid: coarse primary but any-pointer:fine → Monaco (the not-clause matters)`
- [legacy] `ui.monaco-settings.test.mjs` :: `A15 pin in the row: on a coarse-only device the Monaco option is locked and inert — no preference write, no boot, the note explains`

## G3 — A19 P-EOL-5/6 (eol-normalize ledger + byte fixtures)

- [monaco] `ui.monaco-save.test.mjs` :: `T2 refusal (sentinel → "cannot save yet", zero PUTs); T4a clean chip; P-EOL-5 first-save disclosure`
- [unit] `api.eolledger.test.mjs` :: `a normalizing artifact PUT records the eol-normalize change-set (task:null, before = the mixed disk bytes)`
- [unit] `api.eolledger.test.mjs` :: `the REAL rewind: revert restores the original mixed bytes byte-identically and records revertOf`
- [unit] `latex-corpus.test.mjs` :: `eol-lf files are pure LF`
- [unit] `latex-corpus.test.mjs` :: `eol-crlf files are pure CRLF`
- [unit] `latex-corpus.test.mjs` :: `eol-mixed files really mix CRLF, bare LF, and a bare CR`
- [unit] `latex-corpus.test.mjs` :: `no-final-newline files end without any EOL byte`
- [unit] `latex-corpus.test.mjs` :: `bom files start with U+FEFF`

---

# MX — beyond the P rows (S2b-gated physical/manual verifications)

Belongs to A7/A15/A16/A17 and the S2b gate, NOT to any P row — recorded here
so the exit artifact carries the full honest ledger of what tests cannot
prove. None of these placeholders count as passes.

- [manual] S2b-GATED (2026-08-17): physical macOS IME composition on the kept host (A7) — Pinyin/Japanese composed on real hardware through a render storm and an impl toggle; the I2-IME CDP cases prove the composition events, not the OS IME panel.
- [manual] S2b-GATED (2026-08-17): iPad PWA re-verification (I9/A15) — the coarse-pointer pin holds on the physical device, legacy editor + A15 feature floor intact; re-run during the S2b soak.
- [manual] S2b-GATED (2026-08-17): A16 measured budgets on the packaged /vendor/monaco route — cold/warm transfer bytes, ready-to-first-edit, p50/p95 input latency, long tasks, worker/heap growth + model churn, representative 200k-char documents (CP_PERF=1 standing case); budgets are set and measured at S2b's gate, never asserted from estimates.
- [manual] S2b-GATED (2026-08-17): A17 accessibility gate — high-contrast decision, dynamic editor ariaLabel, command/key access to every widget action, live announcements (suggestions/problems/save state), keyboard-only coverage, VoiceOver smoke, prefers-reduced-motion.
