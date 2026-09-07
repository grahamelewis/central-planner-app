# Tooling and language fixes — verification

Date: 2026-09-07. Local implementation only; no commit, push, deployment, or
Dropbox synchronization. Existing research and unrelated app changes were kept.

## Risks assessed before implementation

Three agents owned language/backend safety, telemetry/parsers, and UI lifecycle.
The main agent reviewed integration, dependency changes, API guards, and broader
regressions. Agents also cross-reviewed each other's completed work.

| Risk | Fix | Regression evidence |
| --- | --- | --- |
| High: a Cargo manifest section could write into `Object.prototype` merely by being summarized | Null-prototype parser dictionaries; manifest names require own-property lookup | Malicious section/table/key names and inherited filenames; four safety checks failed before the fixes and passed afterward |
| Medium: Refresh reused stale executable/version results | Invalidate underlying caches; obsolete async callbacks cannot replace fresh results; do not restart fresh probes during response assembly | Install/remove/PATH-change fixtures, late version/module callbacks, real Refresh endpoint |
| Medium: TypeScript execution silently supported only erasable syntax | Pin `tsx` 4.23.13 as a runtime dependency; resolve project-local, PATH, then dashboard installation; never install through `npx` during Run | Real enum and constructor-parameter-property execution; existing JS and npm-script runs; missing-executor and resolution-order cases |
| Medium: selecting a Cargo binary could run a different default binary | Explicit `--bin` for conventional binary entry files; refuse uncertain custom layouts | Default-run override and conservative ambiguous-layout refusals |
| Medium: partial probes appeared as complete memory/thread totals | Require complete current-tree coverage, fresh samples, matching process identities; otherwise use whole-tree RSS and unknown threads | Missing/new/reused PIDs, expired samples, 64-PID cap, mixed PSS/RSS |
| Medium: unknown telemetry became zero | Preserve nulls through numeric conversion and duration fallbacks | Browser checks for unknown versus genuine zero, missing terminal duration |
| Medium: a new run inherited old charts/output/Stop state | Fence UI state, both fade stages, and Stop callbacks by key plus start time | Rapid reruns, stale fade callbacks, old Stop responses, retry after failed Stop |
| Medium: delayed Stop could cancel a replacement run | Optional start-time identity checked synchronously at the Stop API | Real replacement-run API test; legacy requests without identity remain compatible |
| Medium: skipped CTest cases counted as passed too | Reconcile passed/failed/skipped totals without duplication | Mixed passed/skipped CTest summary |
| Low: OSC hyperlinks and output bursts lost diagnostic text | Preserve visible OSC labels; parse complete lines before bounding unfinished fragments; flush final EOF fragment once | BEL/ST hyperlinks, large chunks, oversized unfinished line, EOF and split CRLF |
| Low: nested Makefiles had no intended grammar | Classify the basename rather than the entire relative path | Real nested Makefile/GNUmakefile tabs in Monaco |

## Verification runs

- Combined runtime/API/security/pins/highlighting/memory/recall suite: **243 passed,
  3 skipped**, no failures.
- Full job lifecycle/parser/probe/watcher suite: **91 passed, 1 skipped**, no failures.
  Includes real Julia/R/Python/notebook/Cargo/Node/C process discovery and stopping.
- Job-card/feed/Monaco browser suites: **32 passed**.
- Recall/activity/queue browser suites: **25 passed**.
- Settings/provider browser checks: **10 passed**.
- Broader console suite: **20 passed, 2 scroll-position failures**. The same two
  assertions had failed intermittently before this work; an unchanged HEAD
  archive also passed all 22 on a subsequent run. These are not counted as green.
  A read-only instrumented comparison of the first four tests passed 4/4 on
  both current and baseline, with identical scroll position/follow state at
  the assertion boundary. Relevant scroll handlers are unchanged. No new
  regression was established, but the intermittent failures remain unresolved.
- Typecheck and `git diff --check`: passed.

No billed model calls or user-provider history mutations were used. Fixtures
create and stop their own isolated processes.

## Remaining limits and follow-ups

- Go is not installed here: both real Go execution cases were skipped. Two
  DuckDB cases were skipped because the Python module is absent. CMake/Ninja
  behavior is covered through resolver/parser fixtures, not live toolchains.
- Cargo's selected-binary inference is intentionally conservative. Custom target
  declarations, helper modules, unusually encoded manifests, and other uncertain
  layouts require an explicit command. Ordinary project execution remains
  project-wide; this is not a general target-selection UI.
- This is execution and grammar support, not new Rust/Go/C++ language servers or
  TypeScript IDE semantic analysis. Existing semantic-diagnostic policy remains.
- Dependency audit: 10 advisories in existing dependencies (1 low, 6 moderate,
  3 high). None were reported against the added tsx/esbuild/fsevents packages.
  Existing locked package versions were unchanged. No broad `audit fix` was run.

## Execution references

Node's documentation distinguishes native type stripping from third-party
TypeScript execution and records removal of the experimental transform flag in
Node 26; the fix therefore uses an installed executor, not that version-sensitive
flag. [Node TypeScript documentation](https://nodejs.org/api/typescript.html)

Cargo documents explicit binary selection and the interaction with `default-run`.
[Cargo run documentation](https://doc.rust-lang.org/cargo/commands/cargo-run.html)
