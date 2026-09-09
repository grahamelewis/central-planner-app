# Task-memory worker recovery

This repair captures inspectable checkpoint histories and useful failure
diagnostics. It does not inject checkpoints into foreground prompts, compact
sessions, or automatically process the entire historical backlog.

## Why the old worker failed

The Codex adapter classified every item other than an agent message or
reasoning as a tool operation. A non-execution diagnostic could therefore
terminate the worker. An injected diagnostic reproduced that false positive.
The historical triggering item was not retained, so the original failures
cannot be attributed to a particular warning with certainty.

Failed attempts retained their daily reservations. Subsequent completed
foreground turns triggered new attempts until the global daily limit was
reached. Zero successful revisions meant every attempt revisited the earliest
transcript material.

## Repair boundaries

- Classify known diagnostics separately from executable tools. Diagnostics
  alone are not a successful checkpoint: a successful terminal result, valid
  checkpoint structure/source references, and successful process exit remain
  required. Actual tools and unsupported/malformed protocol data fail closed.
- Retain bounded, categorical event diagnostics without raw output, arbitrary
  provider messages, commands, prompts, or credentials.
- Run non-generating readiness checks before reserving a daily slot, and
  recheck task identity and activity before dispatch.
- A deterministic worker incompatibility pauses its connection durably.
  Repeated prompts do not consume more worker slots while paused.
- Explicit resume clears the selected connection's pause; it does not launch
  a request, reset the daily cap, or refund past reservations.
- Coalesce pending task work. Busy or budget-blocked work does not generate
  repeated blocked-job records. A later foreground completion or explicit
  update can re-evaluate it. There is no new autonomous retry or midnight
  backlog-draining loop.
- Preserve existing checkpoint, attempt, and reservation history. Unknown
  usage remains unknown, including after a timeout or interruption.

The memory panel distinguishes successful revisions, failed attempts, and
blocked attempts. It displays the connection pause, remaining shared daily
slots/reset, and exactly how much of the transcript a checkpoint covers.
Structural validation is not a factual-accuracy score.

## Verification and live rollout

Automated checks use isolated stores and simulated Codex output. They exercise
diagnostic-then-success, diagnostic-then-tool, fatal/unknown/malformed output,
usage preservation, durable pauses, duplicate triggers, budget limits, task
identity changes, and checkpoint reload/evidence lookup.

The integrated fixture includes an initial instruction, a correction from
0.5 to 0.05 per year, and an unresolved unit conversion. It proves that those
inputs reach the adapter and that the supplied checkpoint/evidence survive
storage; it does not measure a real model's synthesis accuracy.

Before calling live generation verified, run one idle task through the normal
reservation and accounting path. Do not bypass an exhausted daily cap. Inspect
the resulting checkpoint against its actual covered sources, including user
constraints, corrections, exact numbers, uncertainty, and next steps. A first
chunk of a long conversation is not necessarily current with the latest prompt.

Deployment and process restart are separate from editing this checkout. Never
start a second server or an independent memory writer against the live data
directory. Further backlog recovery and active-context replacement require
separate verification.

## Implementation verification — September 9, 2026

- Final non-browser regression suite: 1,138 passed, zero failed, five skipped.
- Memory panel browser checks: eight passed. Related prompt recall, Codex
  stream rendering, and usage-meter browser checks: 31 passed.
- Type checking and whitespace/diff checks passed.
- Independent reviews caught and closed an inherited debounce timer that
  could dispatch after resume, and concurrent Claude readiness checks that
  could otherwise exceed the dollar budget. Both have regression coverage.

No live generation was performed. A read-only check of the running Dropbox
installation found all 12 of its September 9 UTC-day reservations already
used. Those reservations and all historical records were preserved. This
checkout has not been deployed to that installation by this implementation.
The next live checkpoint still needs source-by-source accuracy review after
deployment and when its normal budget permits a request.

A global pause originating in another task may require Refresh in an already
open, idle memory panel; server-side admission enforces it immediately.
