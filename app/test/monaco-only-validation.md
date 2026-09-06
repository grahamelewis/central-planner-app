# Monaco-only validation — September 6, 2026

Tested source commit: `3d372a7e30631d654d6ed523a2cff623fa262f54`.
This is a local implementation; GitHub and the running Dropbox checkout were
not updated as part of this editor cleanup. The separate `/m` interface and
desktop shell have no changes.

## Results

- `npm run typecheck`: passed.
- Fresh `monaco-matrix-run.mjs`: 277 passed, 1 failed, no skips across 30 suites.
  The complete results are in `monaco-matrix-run.json`, including the failure.
- `node --test test/monaco-matrix.test.mjs`: both checks passed at the tested
  source SHA. All automated citations across the 36 matrix rows matched passes.
- The failure is the voice suite's “first answer sentence carries the karaoke
  wash” assertion. The same test failed on an isolated copy of pre-change
  commit `b7c8c4b`; editor-focused microphone guards passed on both versions.
- Read-only syntax highlighting: all 28 checks passed separately.
- Additional browser checks passed for HTML pins, Settings, Julia Tab behavior,
  PDF rendering, and forward/inverse SyncTeX.
- Visually inspected Settings and the injected boot-failure screen. Unsaved
  text was visible with Retry and Copy controls; retry restored the dirty draft.

The run's dirty flag includes the generated evidence artifact and unrelated
untracked research documents; tracked implementation files were committed and
unchanged during the run. The evidence-only commit comes after the tested SHA.
The verifier intentionally requests a new recording on later HEADs.

## Recovery and remaining manual work

Rollback tag: `monaco-before-legacy-removal-b7c8c4b`. Shared-helper extraction,
Monaco-only behavior, and retired-file deletion are separate commits. A reverse
patch applicability check against that tag passed without changing working
files. Deleted files remain recoverable in Git.

The matrix explicitly retains six pending manual entries, including physical
touch/IME, accessibility, writing/viewport feel, and performance-budget checks.
No physical-device or multi-day soak pass is claimed.
