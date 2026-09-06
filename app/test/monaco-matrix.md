# Monaco-only regression evidence

Updated September 6, 2026. One editor implementation; no Legacy controls or
implementation handoffs remain. This file indexes evidence, not a claim that
manual checks passed. The runner records actual per-test outcomes at a SHA.

## P1 — drafts / dirty / saveChip

- [monaco] `ui.texrun.test.mjs` :: `save chip dual: constant box, dot flips on typing, a chip click saves to disk [impl=monaco]`
- [monaco] `ui.monaco-core.test.mjs` :: `M1: draft-backed creation is dirty at birth; ⌘Z reaches disk baseline; sentinel path refuses save then recovers`
- [monaco] `ui.monaco-stale.test.mjs` :: `A9 GATE: conflict → ⚠ → ⌘Z to the old baseline → automatic fresh reload — saved only after the model shows the NEW disk text; savedAltId===fresh; redo is a no-op`
- [monaco] `ui.monaco-stale.test.mjs` :: `I1 drafts retention: kill the Monaco instance in AltCleanStale (reboot + injected init failure) → the legacy fallback still has drafts[k] on screen, ⚠ retained, preference unchanged; the dead flight's late resolution is dropped`

## P2 — ⌘S save / 409 / recovery

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: type A · ⌘S · type B before the 200 → amber + rebased draft; ⌘Z → saved, draft deleted`
- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: double-⌘S in flight → exactly two ordered PUTs, final clean; triple-⌘S coalesces to the same two`
- [monaco] `ui.monaco-save.test.mjs` :: `T6: a failed PUT toasts, keeps the draft and consumes the seq; a post-dispose 200 is dropped with a log line and zero mutation`
- [monaco] `ui.monaco-save.test.mjs` :: `M5: 409 → cancel is a total no-op (repeatable); accept+clipboard-denied destroys nothing; accept+clipboard-ok reloads disk with the draft (incl. post-⌘S keystrokes) on the clipboard`
- [monaco] `ui.monaco-save.test.mjs` :: `S2.1 re-anchor: files.saveFile under monaco rides the M3 queue (savedAltId === token.altId, coalesced, no double PUT); a no-model fkey keeps the legacy body`
- [monaco] `ui.monaco-save.test.mjs` :: `S2.1 re-anchor: a 409 through files.saveFile lands in the M5 ladder (in-app confirm, drafts intact; cancel is a total no-op)`

## P3 — file:changed reload + 3-way merge

- [monaco] `ui.filechanged.test.mjs` :: `file:changed dual: clean reload in place; non-overlap merges into the draft; overlap pins ⚠ disk [impl=monaco]`
- [monaco] `ui.texauto.test.mjs` :: `turn-end dual: ▶-created deck tab + session file:changed → exactly one queued compile; clean editor reloads [impl=monaco]`
- [monaco] `ui.monaco-merge.test.mjs` :: `A1 GATE: type OURS → non-overlapping THEIRS lands + file:changed → ⌘Z → THEIRS/saved → save is a no-op, THEIRS survives on disk; exactly one signal; caret restored`
- [monaco] `ui.monaco-merge.test.mjs` :: `T2 bail: overlapping edit → ⚠ chip, model still OURS, drafts intact, zero txns, one toast per pinning; ⌘S runs the M5 409 net`
- [monaco] `ui.monaco-merge.test.mjs` :: `serialization: two rapid file:changed events merge in order — the second BASE is the first's committed THEIRS; exactly one signal each`
- [monaco] `ui.monaco-merge.test.mjs` :: `background merge: a non-attached fkey rebases via applyExternal without moving the visible caret; reattach shows MERGED + amber; a background T3 reload lands via cleanReload`

## P4 — external pins

- [monaco] `ui.extedit.test.mjs` :: `P4 dual: external pin edits + ⌘S through the grant; file:changed reloads; 409-cancel and 403 destroy nothing [impl=monaco]`
- [monaco] `ui.monaco-save.test.mjs` :: `an external-pin fkey rides the identical token machine (stubbed /api/extfile — no server mutation); toggle off keeps the legacy save path`
- [unit] `api.extedit.test.mjs` :: `a granted external file saves through the pin grant (and reports mtimeMs)`
- [unit] `api.extedit.test.mjs` :: `the mtime conflict guard refuses a stale save (409)`

## P5 — fetch contract

- [monaco] `ui.monaco-core.test.mjs` :: `M1 clean open, one-signal creation, CRLF/mixed/no-final/BOM byte behavior, >200k → no model`

## P6 — texfix

- [monaco] `ui.monaco-texfix.test.mjs` :: `arrival: sticky mark + ✦ content-widget pane, tracks typing above; apply = ONE undoable typed edit, wire {id, status:'accepted'} verbatim, scroll + strip untouched (no renderWB)`
- [monaco] `ui.monaco-texfix.test.mjs` :: `the user already fixed it: visuals drop, apply REFUSES while stale, and the engine's single 5.2s grace resolves 'stale' exactly once`
- [monaco] `ui.monaco-texfix.test.mjs` :: `apply-guard differential: a range corrupted between arm and click REFUSES (one synchronous re-find, no wrong-text replacement — the unguarded edit is proven wrong), then the re-click is safe`
- [monaco] `ui.monaco-texfix.test.mjs` :: `two files, one find string: only the suggestion's NAMED file gains decoration/widget/edit; tab switches re-arm the active-model-only engine per file`
- [unit] `texfixAnchors.test.mjs` :: `clean apply: replaces exactly the anchored text, resolves applied`
- [unit] `texfixAnchors.test.mjs` :: `REFUSES when the range text has drifted — nothing is edited`

## P7 — SyncTeX forward

- [monaco] `ui.monaco-jumps.test.mjs` :: `forward SyncTeX: ⌘J and ◎ send the monaco caret line/col to /api/synctex/view (stubbed route)`

## P8 — SyncTeX inverse + jumps

- [monaco] `ui.monaco-jumps.test.mjs` :: `a problems-strip row click jumps the monaco editor: caret, 35% reveal geometry, restartable lnFlash, timer release`
- [monaco] `ui.monaco-jumps.test.mjs` :: `I5 precedence: a pending jump beats the reopened file's remembered viewport`
- [monaco] `ui.monaco-jumps.test.mjs` :: `TTL: a jump pending behind a slow fetch expires at 15s — no late reveal; a fresh jump still lands`
- [monaco] `ui.monaco-jumps.test.mjs` :: `a strip click on a ×-closed pin REOPENS the tab and lands the jump (texOpenAt untouched)`

## P9 — compile problems

- [monaco] `ui.monaco-problems.test.mjs` :: `problem rows land as texlog markers (badbox→Hint) with .lnErr/.lnWarn tint parity; rows route per model; empty rows sweep`
- [monaco] `ui.monaco-problems.test.mjs` :: `stale diagnostics: rows past a shrunk dirty buffer clamp to the LAST line — no throw, chip/undo unaffected`
- [monaco] `ui.monaco-problems.test.mjs` :: `a cleanReload txn re-arms markers/tints synchronously against the new text; disposeModel clears texlog markers`
- [monaco] `ui.build-status.test.mjs` :: `run-card dual: a failing .tex run renders the ✗ card; the error-row click jumps the editor to the line [impl=monaco]`
- [unit] `latex.providers.test.mjs` :: `severity map: error→Error, warning→Warning, badbox→Hint`
- [unit] `latex.providers.test.mjs` :: `concern 6: out-of-range lines clamp to the LAST line; columns derive from the clamped line only`

## P10 — completions

- [monaco] `ui.monaco-completions.test.mjs` :: `no-word-noise gate from first mount; \cite{ comma-aware list accepted with Enter (CDP)`
- [monaco] `ui.monaco-completions.test.mjs` :: `A8 proven: a target absent from the first eight surfaces via the incomplete re-query as the prefix grows`
- [monaco] `ui.monaco-completions.test.mjs` :: `the .bib exclusion: no completion provider on 'bibtex' — trigger chars open nothing`
- [monaco] `ui.monaco-completions.test.mjs` :: `closeBrace overtype parity: \ref accept inside the auto-paired } lands text AND caret identically [impl=monaco]`
- [unit] `latex.providers.test.mjs` :: `cite truncation: max 8 items and incomplete:true for the re-query (A8)`
- [unit] `latex.providers.test.mjs` :: `per-key single flight: concurrent queries coalesce onto ONE requestMeta`
- [unit] `latex.providers.test.mjs` :: `metaKey keys the 5s cache per project — no cross-project bleed (risk N1)`

## P11 — pairs / auto-\end / indent

- [monaco] `ui.monaco-commands.test.mjs` :: `Enter after an unclosed \begin inserts the skeleton (single ⌘Z atomic); a closed env falls through (fullNE)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Enter and Tab go to the WIDGET — the guarded commands never fire (the !suggestWidgetVisible conjunct)`
- [monaco] `ui.monaco-commands.test.mjs` :: `A18: with 2 cursors Enter falls through — plain newlines at BOTH carets, NO skeleton despite needsEnd true`
- [unit] `latex.providers.test.mjs` :: `needsEnd counts net depth, star-aware`
- [unit] `latex.providers.test.mjs` :: `latex auto-pairs $…$; bibtex omits the $ pair by contract`

## P12 — ⌘/ + § outline

- [monaco] `ui.monaco-commands.test.mjs` :: `⌘/ toggles whole-line % comments and preserves the selection (native commentLine, comments config)`
- [monaco] `ui.monaco-jumps.test.mjs` :: `§ outline pick jumps through revealAt with the flash; ⇧⌘O lists the SAME texOutline rows and jumps`
- [unit] `latex.providers.test.mjs` :: `texOutline: balanced-brace titles, depth map, caps`
- [unit] `latex.providers.test.mjs` :: `symbols mirror texOutline rows`

## P13 — ▶ run / ⌘⏎

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: ⌘⏎ during an in-flight ⌘S → the compile starts only after the coalesced save commits, on the saved bytes`
- [monaco] `ui.texrun.test.mjs` :: `save chip dual: constant box, dot flips on typing, a chip click saves to disk [impl=monaco]`
- [monaco] `ui.tex-subdir.test.mjs` :: `▶ dual: draft.tex then slides.tex get coexisting pdf tabs; selection never reorders the strip [impl=monaco]`

## P14 — foot chrome

- [monaco] `ui.monaco-core.test.mjs` :: `M1 clean open, one-signal creation, CRLF/mixed/no-final/BOM byte behavior, >200k → no model`
- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`
- [monaco] `ui.dragtab.test.mjs` :: `drag dual: dropping c.tex on the target task pins it once, without switching task or editor [impl=monaco]`

## P15 — wrap policy

- [monaco] `ui.monaco-latex.test.mjs` :: `latex/bibtex routing, ≥3 token classes in the DOM, wash == scanner, wrap policy, A18 indent pin`

## P16 — viewport keep across renderWB

- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`
- [monaco] `ui.monaco-core.test.mjs` :: `M7-T2 mixed-EOL steady state: renderWB storms fire ZERO txns on a clean mixed.tex — caret, undo/redo, chip intact; a genuine disk change still reloads`
- [manual] S2b-GATED (2026-09-06): PENDING: the viewport-keep FEEL — real writing mid-document while a session floods file:changed/run:status renders, judged by eye for caret/scroll/composition stillness on physical hardware. Procedure: long .tex open, type continuously through ≥3 render storms, then flip focus mode twice; any perceptible jump is a Sev-2. Runs during the S2b soak; a test can prove coordinates, not feel.

## P17 — focus mode + editHold

- [monaco] `ui.monaco-core.test.mjs` :: `C2-MF5 editHold: raise blurs + pins readOnly (typing lands nothing, even force-focused); release unpins + hands focus back only if held at raise`
- [monaco] `ui.focus.test.mjs` :: `focus + monaco: the tail repair docks the kept editor on the first valid file, typing lands; no visible file → focusnote parks the host`
- [monaco] `ui.vsplit.test.mjs` :: `vsplit dual: the divider floor keeps sessbar + composer whole under either editor impl [impl=monaco]`

## P18 — Voice Space-PTT

- [monaco] `ui.voice.test.mjs` :: `Space while Monaco focused never mics; Space outside still starts PTT (I3 leg c, pinned textarea surface)`
- [monaco] `ui.voice.test.mjs` :: `I3 leg (b) is load-bearing under EditContext: Space inside the editor still never mics`
- [monaco] `ui.monaco-core.test.mjs` :: `EDITCONTEXT PIN: the default surface is editContext:false and the IME case holds on it`
- [monaco] `ui.monaco-core.test.mjs` :: `I2-IME under editContext:true (EditContext surface)`
- [monaco] `ui.monaco-core.test.mjs` :: `I2-IME under editContext:false (textarea surface)`

## P19 — julia \symbol Tab

- [monaco] `ui.monaco-core.test.mjs` :: `P19 Tab: inside Monaco Tab indents and keeps focus — the prose \symbol handler never fires; \beta⇥ in the composer still completes`
- [monaco] `ui.monaco-commands.test.mjs` :: `julia Tab: \beta⇥ → β; a miss falls through to a NATIVE tab; latex \beta⇥ keeps \beta (context-gated)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Tab in a JULIA model goes to the WIDGET — the guard does real work where the context would otherwise match`
- [unit] `latex.providers.test.mjs` :: `texSymbolMatch: pure core of texComplete (known / miss / none / window)`

## P20 — md ▤ preview

- [monaco] `ui.mdview.test.mjs` :: `P20 dual: typing live-updates the ▤ pane in place — debounce, drafts-as-source, scroll kept [impl=monaco]`
- [monaco] `ui.monaco-commands.test.mjs` :: `P20: typing in a .md model pings mdPreviewSchedule through signalOnce (no rebuild — verify only)`

## P21 — center-tab model

- [monaco] `ui.monaco-m7.test.mjs` :: `close dirty tab → reopen: model/undo/viewState/amber all restored, drafts intact throughout; orphan counter moves (A10 view-close gate)`
- [monaco] `ui.monaco-m7.test.mjs` :: `LRU: 60 clean + 5 dirty models → clean-detached ≤ 50, oldest evicted first, every dirty model + draft survives; counters exist and move across open/evict`
- [monaco] `ui.extratabs.test.mjs` :: `◇ dual: a browser open becomes a persisted focused extra; a pinned file opens its pin tab instead [impl=monaco]`
- [monaco] `ui.dragtab.test.mjs` :: `drag dual: dropping c.tex on the target task pins it once, without switching task or editor [impl=monaco]`

## P22 — prefs touching the editor

- [monaco] `ui.monaco-latex.test.mjs` :: `cp themes: defined before createEditor, palette from live CSS vars, re-applied on an OS scheme flip`
- [monaco] `ui.vsplit.test.mjs` :: `vsplit dual: the divider floor keeps sessbar + composer whole under either editor impl [impl=monaco]`

## E1 — typing

- [monaco] `ui.monaco-core.test.mjs` :: `kept-instance invariant: renderWB storms mid-typing move nothing; viewstate round-trips through tail; focus-mode toggle survives`

## E2 — undo/redo

- [monaco] `ui.monaco-merge.test.mjs` :: `ladder: ⌘Z→THEIRS/saved/drafts deleted; ⇧⌘Z→MERGED/amber/drafts re-materialized; double-⌘Z bottoms at THEIRS; ⌘S writes MERGED on top with no 409`
- [monaco] `ui.monaco-stale.test.mjs` :: `A9 GATE: conflict → ⚠ → ⌘Z to the old baseline → automatic fresh reload — saved only after the model shows the NEW disk text; savedAltId===fresh; redo is a no-op`

## E3 — multi-cursor

- [monaco] `ui.monaco-commands.test.mjs` :: `A18: with 2 cursors Enter falls through — plain newlines at BOTH carets, NO skeleton despite needsEnd true`

## E4 — find/replace

- [manual] S2b-GATED (2026-09-06): PENDING: genuine-input find/replace E2E — ⌘F opens Monaco's find widget, type/replace-all/Escape, buffer and undo verified; retired control was browser-native find (no in-editor widget to test). No automated citation exists yet; owned by S2b's genuine-input E2E block.

## E5 — completion acceptance

- [monaco] `ui.monaco-completions.test.mjs` :: `no-word-noise gate from first mount; \cite{ comma-aware list accepted with Enter (CDP)`
- [monaco] `ui.monaco-completions.test.mjs` :: `\begin{ env skeleton: Enter accepts the snippet — brace consumed, body line indented, \end added`

## E6 — Enter / Tab / ⇧Enter

- [monaco] `ui.monaco-commands.test.mjs` :: `Enter after an unclosed \begin inserts the skeleton (single ⌘Z atomic); a closed env falls through (fullNE)`
- [monaco] `ui.monaco-commands.test.mjs` :: `julia Tab: \beta⇥ → β; a miss falls through to a NATIVE tab; latex \beta⇥ keeps \beta (context-gated)`
- [monaco] `ui.monaco-commands.test.mjs` :: `widget-open Enter and Tab go to the WIDGET — the guarded commands never fire (the !suggestWidgetVisible conjunct)`

## E7 — save mid-flight

- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: type A · ⌘S · type B before the 200 → amber + rebased draft; ⌘Z → saved, draft deleted`
- [monaco] `ui.monaco-save.test.mjs` :: `A3 gate: double-⌘S in flight → exactly two ordered PUTs, final clean; triple-⌘S coalesces to the same two`

## E8 — merge

- [monaco] `ui.monaco-merge.test.mjs` :: `A1 GATE: type OURS → non-overlapping THEIRS lands + file:changed → ⌘Z → THEIRS/saved → save is a no-op, THEIRS survives on disk; exactly one signal; caret restored`
- [monaco] `ui.monaco-merge.test.mjs` :: `typing during the THEIRS fetch: keystrokes between fetch start and the OURS re-read appear in MERGED — never dropped`

## E9 — clipboard failure

- [monaco] `ui.monaco-save.test.mjs` :: `M5: 409 → cancel is a total no-op (repeatable); accept+clipboard-denied destroys nothing; accept+clipboard-ok reloads disk with the draft (incl. post-⌘S keystrokes) on the clipboard`

## E10 — implementation handoff

- [monaco] `ui.monaco-m7.test.mjs` :: `boot-failure recovery: dirty files → injected failed boot (drafts to legacy) → cleared + rebooted to READY → models recreated from the surviving drafts, drafts WIN, ⌘Z reaches the disk baseline`

## G1 — A11 opt-in default (S2 exits with legacy default)

- [monaco] `ui.monaco-only.test.mjs` :: `failed boot offers read-only text, copy and retry; dirty text survives without page reload`

## G2 — I9/A15 coarse-pointer pin

- [monaco] `ui.monaco-boot.test.mjs` :: `A15 hybrid: coarse primary but any-pointer:fine → Monaco (the not-clause matters)`

## G3 — A19 P-EOL-5/6 (eol-normalize ledger + byte fixtures)

- [monaco] `ui.monaco-save.test.mjs` :: `T2 refusal (sentinel → "cannot save yet", zero PUTs); T4a clean chip; P-EOL-5 first-save disclosure`
- [unit] `api.eolledger.test.mjs` :: `a normalizing artifact PUT records the eol-normalize change-set (task:null, before = the mixed disk bytes)`
- [unit] `api.eolledger.test.mjs` :: `the REAL rewind: revert restores the original mixed bytes byte-identically and records revertOf`
- [unit] `latex-corpus.test.mjs` :: `eol-lf files are pure LF`
- [unit] `latex-corpus.test.mjs` :: `eol-crlf files are pure CRLF`
- [unit] `latex-corpus.test.mjs` :: `eol-mixed files really mix CRLF, bare LF, and a bare CR`
- [unit] `latex-corpus.test.mjs` :: `no-final-newline files end without any EOL byte`
- [unit] `latex-corpus.test.mjs` :: `bom files start with U+FEFF`
- [manual] S2b-GATED (2026-09-06): PENDING: physical macOS IME composition on the kept host (A7) — Pinyin/Japanese composed on real hardware through a render storm and an pane retry; the I2-IME CDP cases prove the composition events, not the OS IME panel.
- [manual] S2b-GATED (2026-09-06): PENDING: iPad PWA re-verification (I9/A15) — Monaco interaction on physical touch hardware; re-run during the S2b soak. The former coarse-pointer Legacy pin is removed.
- [manual] S2b-GATED (2026-09-06): PENDING: A16 measured budgets on the packaged /vendor/monaco route — cold/warm transfer bytes, ready-to-first-edit, p50/p95 input latency, long tasks, worker/heap growth + model churn, representative 200k-char documents (CP_PERF=1 standing case); budgets are set and measured at S2b's gate, never asserted from estimates.
- [manual] S2b-GATED (2026-09-06): PENDING: A17 accessibility gate — high-contrast decision, dynamic editor ariaLabel, command/key access to every widget action, live announcements (suggestions/problems/save state), keyboard-only coverage, VoiceOver smoke, prefers-reduced-motion.

## G99 — Monaco-only browser migration and touch attempt

- [monaco] `ui.monaco-only.test.mjs` :: `touch desktop UI attempts Monaco instead of selecting a retired editor`
