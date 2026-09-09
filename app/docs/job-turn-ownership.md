# Job summaries belong to their originating turn

## Cause

Completed jobs used to be retained in a task-wide browser map and displayed
after the single wrapper containing the entire conversation. Every new prompt
therefore appeared above old job summaries. This was an ownership/layout bug,
not fixed-position CSS or a Julia process continuing to run.

A separate title bug truncated inline commands to 60 characters and then
treated the result as a path. A saved Julia command ending `/Users/gra` became
the displayed name `gra`.

## Implementation

- Jobs carry immutable `jobRunId`, `appTurnId`, `taskCreated`, and `createdAt`.
  Execution `startedAt` can still be corrected from process telemetry; it is
  not the new identity. Scoped completion/progress callbacks avoid confusing
  similarly named tools in different tasks/turns.
- Events and bounded persisted job history retain these fields. State snapshots
  carry history so reconnect and reload can rebuild completed summaries.
- The console tracks raw text boundaries using trusted stream and transcript
  metadata, including optimistic request IDs. Model text cannot forge an owner.
- Completed cards and their eventual compact summaries render as owned console
  segments before the next turn. They participate in the existing segment
  reconciler rather than being inserted as unrelated DOM children.
- Stable segment keys preserve later prompts and answers when a late summary
  is inserted above them. Because the console disables browser scroll anchoring,
  explicit viewport compensation preserves an already-paused reader's position,
  including a prompt near the top or a long answer spanning the viewport.
- Only running jobs remain at the live tail. Detached work stays visible and
  stoppable while retaining its original owner. Legacy jobs with unknown turn
  ownership remain in Recent Activity; they are not guessed onto a new prompt.
- File paths and display labels are separate. Only actual file paths receive
  basename shortening. Legacy inline command fragments use an honest generic
  title, not a fabricated filename or reconstructed command.

## Four post-fix regression hypotheses

| Hypothesis | Checks |
| --- | --- |
| H1: late events/reconnect move, duplicate, or resurrect jobs | Finish A then send B; B before A's fade; replay terminal/running snapshots; immutable identity despite timing correction; reused task IDs |
| H2: detached work becomes hidden or Stop targets the wrong run | Detached A through turn B; completion anchored to A; Stop preserves jobRunId; stale Stop cannot terminate a replacement |
| H3: history/recall/streaming loses content or disrupts scrolling | Seed owned transcript plus persisted jobs; recall/reset; optimistic rejection; bounded raw buffer; final-answer repair; browser scroll and node stability |
| H4: title changes misname files or introduce unsafe markup | Exact saved `/Users/gra`; real filenames across runtimes; slashes in labels/URLs/expressions; generated launcher titles; sidebar; HTML escaping |

## Boundaries

Two existing console auto-follow tests still fail: recognizing a reader's scroll
away from the live bottom, and retaining that position at turn completion.
An independent agent reproduced both failures on unchanged Git HEAD.
The new insertion tests separately verify preservation
once the console has accepted the paused-reader state; they do not claim to fix
the pre-existing scroll-intent problem.

History remains bounded (50 terminal jobs per project). Older summaries beyond
that existing retention limit are not a permanent audit archive. Legacy jobs
do not acquire guessed turn ownership. The tests use isolated app stores and
simulated provider streams; no billed model requests are needed.

Deployment is separate: editing this workspace does not replace a running app
from another checkout.

## Verification

- Full non-browser suite: 1,098 passed, 0 failed, 5 skipped.
- New browser placement suite: 10 passed; both viewport cases also passed a
  separate repeat run.
- Existing tooling-card browser suite: 18 passed.
- Broader browser regression selection (console, feed, labels, Stop & Edit,
  streaming, fences, math): 252 passed, with the two baseline failures above.
- TypeScript validation and `git diff --check`: passed.

The post-fix review caught and corrected two additional regressions before
handoff: a fade transition skipped by a content-only render signature, and a
late-insertion viewport jump despite preserved DOM nodes. It also hardened the
supervisor Stop test to inspect and clean up only its uniquely named temporary
process tree, avoiding interference between concurrent test runs.
