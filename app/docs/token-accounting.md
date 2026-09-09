# Token accounting: meaning, guarantees, and verification

## What the benchmark measures

The useful benchmark is **provider-reported tokens processed**, not the number
of words visible in a conversation and not the current context-window size.
Repeated input on separate model calls counts each time it is processed.
Cached input is part of input, not an extra amount to add to an already
cache-inclusive provider input total. Reasoning is a subset of output when
the provider reports it that way, not an additional output charge.

Provider event interpretation was checked against the
[official Codex app-server documentation](https://developers.openai.com/codex/app-server/)
and the installed Claude Agent SDK contracts. The implementation tests the
actual application notification handlers as well as pure accounting helpers.

Keep three measurements separate:

1. Tokens processed, with input/cache/output breakdown and completeness.
2. Monetary estimates with their source and model attribution; these are not
   an invoice. Unknown monetary cost is not zero.
3. Subscription quota utilization supplied by the account provider; it cannot
   be reconstructed exactly from a generic token count.

## Historical data

Existing records must not be silently multiplied, replaced, or retroactively
declared accurate. Earlier Codex accounting retained only the last model call
of each turn. One inspected seven-call turn reported 1,268,709 tokens while
the dashboard stored 187,965. The error factor is workload-dependent.

Old task counters form an unverified baseline. New accounting can be accurate
for newly observed work without making that old baseline accurate. A future
repair must reconcile provider histories, identify counter resets and forks,
exclude replayed observations, retain provenance, and present a preview before
any historical correction is applied. No historical backfill is part of this
implementation.

New multi-model snapshots use a version-2 `token-batch` JSONL record so a crash
cannot commit half a model breakdown. The app flattens these batches and
resolves repeated `usageId` snapshots before summing. External ledger readers
must do the same. Old app versions that understand only standalone `tokens`
rows are not compatible readers for these new records.

Superseded provisional model records are retained as zero-valued tombstones,
not deleted. They do not create false unknown-cost warnings or anchor an active
quota window. Writers remember attempted identities even when write confirmation
fails, because bytes may already have reached disk before an `fsync` error.

## Review invariants

- Every logical usage record has stable provider/task/turn identity.
- Repeated delivery must not increase usage. A cumulative snapshot updates the
  same logical record; the append-only ledger retains its revisions.
- Restart produces the same effective totals as the running process.
- Updating a snapshot must not move its usage to a different calendar day.
- Failed persistence must be visible; an in-memory number must not be called
  durably recorded when its write failed.
- Stop, recall and output deletion cannot refund consumed usage.
- Resumed/forked history must not be charged again as new work.
- A decreasing provider cumulative total is not automatically negative usage,
  nor permission to count the whole old history again. Reset evidence and
  replay handling are required; unresolved discontinuities remain partial.
- Child-agent accounting requires verified ownership and provider aggregation
  semantics. A parent-thread-only number must be labeled with that scope.
- Final Claude model usage supersedes partial stream observations. Multiple
  content-block messages with the same response ID are not separate calls.
- A usage-bearing result followed by an exception still consumed resources.
- Memory, profile and LaTeX helper work belongs in the ledger even when its
  output is invalid or cannot be applied.
- Invalid/negative/non-finite counts are rejected, not coerced into convincing
  zeroes. Partial, unknown and legacy coverage remain visible.

## Adversarial test matrix

| Area | Required cases |
| --- | --- |
| Codex calls | Multiple calls per turn, repeated notifications, no usage event, missing breakdown |
| Provider history | Fresh thread, resume, fork, new-turn counter reset, ambiguous decrease, stale/out-of-order replay |
| Interrupted work | Stop, recall, provider failure, lost start acknowledgement, dashboard restart |
| Claude streams | Repeated same-ID blocks, multiple IDs, missing final result, authoritative per-model replacement |
| Helpers | Success, invalid output, result then throw, timeout after usage, missing telemetry |
| Ledger | Cold first write, warm write, restart, duplicate snapshot, revised snapshot, failed write, stable date/scope |
| Interpretation | Cached input/output subsets, mixed models, global profile work, provider-separated quota fallback |
| UI | Exact-number disclosure, partial and legacy labels, unknown cost distinct from zero, unchanged plan percentages |

The tests use isolated temporary stores and synthetic provider streams. They
must not launch real model calls or write to the user's provider histories.
Passing fixtures establish behavior for tested provider contracts, not invoice
equivalence or completeness of telemetry the provider never emits.

## Remaining limits

- Codex foreground totals cover the observed thread. Child-agent activity is
  flagged as incomplete until its ownership and accounting can be verified;
  it is not guessed from transcript length.
- A missing resume baseline or ambiguous counter discontinuity produces partial
  accounting. The tracker favors avoiding a double charge over inventing a
  complete total from insufficient evidence.
- A provider can process tokens before it emits usage. Durable observations
  survive restart, but tokens never reported before a crash/disconnection cannot
  be recovered by this implementation. That requires provider-history reconciliation.
- The ledger assumes one dashboard writer per data directory. It is not a
  multi-process database; do not run concurrent servers against the same store.
- Revisions retain their first accounting timestamp. A turn crossing midnight
  is attributed to that date, not split into an invoice-grade per-request timeline.
- API prices, cache rates, subscription quota rules, and model routing differ.
  Exact processed-token counts are useful workload benchmarks but are not, by
  themselves, exact dollar-spend comparisons.

Before treating a historical dashboard total as a financial benchmark, reconcile
it against provider records. Before treating a new total as complete, inspect its
coverage label. The existing cumulative task totals intentionally retain the
unverified historical baseline.

## Verification results — September 8, 2026

- Full non-UI suite: **1,072 passed, 5 skipped, 0 failed**, across 79 test files.
- Selected browser regressions (usage, providers, memory, recall, HTML pins,
  math and fences): **240 passed, 0 failed**. After the final memory-label
  changes, its expanded browser suite was rerun: **3 passed, 0 failed**
  (overlaps the selected run; these are not additive totals).
- Typecheck and `git diff --check` passed.
- Independent replay matrix: 100 deterministic scenarios of 20 model calls
  each, with duplicate and stale notifications, preserved expected counts.
- The actual Codex turn handler reproduces the seven-call resume/reset fixture
  as **1,268,709** tokens instead of **187,965**.
- An isolated server boot recovers revised ledger usage on `/api/state`, before
  any prompt, without changing task or ledger bytes. Provider/action/task-creation
  filters prevent unrelated records entering that session counter.
- Failure tests cover result-then-throw, ambiguous disk-write confirmation,
  model replacement, lost start acknowledgment, constructor/spawn failure, and
  late timeout callbacks after memory deletion.

Tests made no billed provider requests and did not alter user history. This is
local implementation verification, not a live-provider billing reconciliation
or deployment to another checkout.
