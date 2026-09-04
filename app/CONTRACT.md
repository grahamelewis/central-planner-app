# Central Planner — Build Contract (v1)

Single Node.js process serving a research-project dashboard. **All modules MUST conform to this
contract exactly** — module interfaces, REST routes, WS event names, and JSON schemas below are
frozen. Plain JavaScript, ESM (`"type":"module"`), Node >= 20. No TypeScript, no bundler, no
frameworks beyond the fixed dependency list.

## Fixed dependencies (package.json already written — do not add others)
- express ^4
- ws ^8
- chokidar ^4
- @anthropic-ai/claude-agent-sdk (latest)

## File tree & ownership

```
centralPlanner/
  app/
    server.js            ← Agent CORE
    lib/config.js        ← already written (read it; import from it)
    lib/events.js        ← Agent CORE
    lib/taskStore.js     ← Agent CORE
    lib/ledger.js        ← Agent CORE
    lib/sessions.js      ← Agent SESSIONS
    lib/watchers.js      ← Agent WATCHERS
    public/index.html    ← Agent FRONTEND
    public/app.js        ← Agent FRONTEND
    public/style.css     ← Agent FRONTEND
  tasks/<project>.json   ← seed data already written (taskStore reads/writes)
  categories.json        ← seed data already written
  abstracts/<key>.md     ← seed data already written (living abstracts)
  ledger/ledger.jsonl    ← append-only, ledger.js owns
```

Each agent writes ONLY its own files. Import other modules per the signatures below and trust them.

## lib/config.js (already exists — import, never modify)

```js
export const PORT = 4242;
export const ROOT;          // absolute path to centralPlanner/
export const APP_DIR;       // centralPlanner/app
export const PROJECTS = {   // key → { name, root, color, texWatch, status }  (loaded from config.json)
  myproject: { name:'My Project', root:'/absolute/path/to/project', color:'#7ef5c2', texWatch:null, status:'active' },
  // … one entry per project …
};
export const ARTIFACT_GLOBS;   // { ignoreDirs: [...], maxDepth: 6 }
export const WEEKLY_HOUR_TARGET = 35;
// FALLBACK usage-meter budgets (user's own targets, not read from Anthropic).
// null when config has "usageLimits": false — PLAN-ONLY mode: real windows when
// lib/usage.js has a reading, and no meter at all when it doesn't.
export const USAGE_LIMITS = {
  sessionHours: 5, sessionTokens: 1e7, weeklyTokens: 1.5e8,
  topModel: 'claude-fable-5-1', topModelWeeklyTokens: 3e7,
};
```

## lib/events.js (Agent CORE)

WS hub + event bus. Exports:

```js
export function initWss(httpServer)        // attach ws.Server at path '/ws'
export function broadcast(type, payload)   // JSON.stringify({type, payload}) to all clients
export function onClientConnect(fn)        // fn(socketSend) called per new client (send snapshot)
```

Liveness: the hub broadcasts `tick {t}` every 25s (unref'd interval). A half-open
connection (slept laptop, dropped tailscale path) stays readyState OPEN on both ends
while silently eating broadcasts — the page keeps working over plain HTTP but never
hears another event. The tick guarantees a healthy socket is never quiet for long;
the frontend (`wsCloseIfStale`) closes any socket silent >60s (15s sweep; focus and
online events probe at >45s for instant wake-from-sleep recovery), and the normal
onclose → reconnect → `loadState()` resync path heals the page. Clients ignore
unknown event types, so `tick` needs no handler case.

## lib/taskStore.js (Agent CORE)

Owns `ROOT/tasks/<project>.json` (each file = JSON array of task objects) and `ROOT/categories.json`.
Synchronous fs is fine. Every mutation: write file atomically (tmp+rename), then
`broadcast('task:update', {project, task})`.

```js
export function listTasks(project)             // → Task[]
export function allTasks()                     // → {project: Task[]}
export function getTask(project, id)           // → Task | null
export function createTask(project, fields)    // assigns id `${project.slice(0,3)}-<n>`, created ISO; → Task
export function updateTask(project, id, patch) // shallow merge, appends {ts,note} to task.log if patch.logNote; → Task
export function getCategories()                // → categories.json parsed
export function getAbstract(project)           // → string (abstracts/<project>.md contents or '')
```

### Task schema (canonical)

```json
{
  "id": "myp-001",
  "title": "...", "description": "...",
  "project": "myproject",
  "category": "calibration",
  "upstream": ["myp-000"],
  "oversight": "auto|propose|coop|manual",
  "status": "queued|running|waiting|done|manual",
  "question": null,
  "provider": "claude|codex",
  "model": "provider model id or null",
  "reasoningEffort": "minimal|low|medium|high|xhigh",
  "context": {
    "include_abstract": true, "include_last_session": true,
    "include_sibling_tasks": true, "include_category_primer": true,
    "web_search": { "enabled": false, "sources": [] },
    "files": ["relative/or/absolute/paths"],
    "notes": "..."
  },
  "session": null,
  "providerSessions": {},
  "handoff": null,
  "created": "ISO", "due": null, "log": []
}
```

`session` is the active provider's compatibility alias. Claude sessions carry
`{provider:'claude', sdkSessionId, ...}`; Codex sessions carry
`{provider:'codex', threadId, model, reasoningEffort, ...}`. `providerSessions`
retains provider-owned thread history across an explicitly-confirmed provider
switch. The shared dashboard transcript is not discarded. Providers never
silently fall back to one another.
`handoff` when set: `{ summary, artifacts: [[path, note],...], numbers: [[k,v],...], decisions: [..], next }`.

## lib/ledger.js (Agent CORE)

Append-only JSONL at `ROOT/ledger/ledger.jsonl`. Lines:
`{"ts":ISO,"type":"time","project":k,"seconds":30}` and
`{"ts":ISO,"type":"tokens","project":k,"taskId":id,"in":n,"out":n,"costUsd":x,"model":id}`.
`model` was added later — entries without it count toward the all-models usage
window but cannot be attributed to the per-model one.

```js
export function logTime(project, seconds)
export function logTokens(project, taskId, tokensIn, tokensOut, costUsd, model)
export function weekSummary()  // → { since, perProject: {k:{seconds,tokensIn,tokensOut,costUsd}},
                               //     totals: {seconds,tokens,costUsd},
                               //     hourTarget, usage }  (week starts Monday 00:00 local)
export function usageWindows(nowMs?)  // → { limits: [{key,name,sub,pct,spent,budget,resetAt}], source: 'estimate' } | null
```
After logTime/logTokens: `broadcast('ledger:update', weekSummary())`.

`usageWindows()` is the **fallback** estimate behind the status bar's usage
meter (mockup: `docs/quota-mockups/quota-meter.html`): the session row is a
SLIDING last-`sessionHours` sum — `resetAt` = oldest in-window turn +
`sessionHours`, so it slides forward under continuous use (a budget meter, NOT
a mirror of claude.ai's anchored sessions) and is `null` when no window is
open — plus the all-models and per-model weekly windows on the
Monday-00:00-local boundary. Spend is real; the budgets are the user's own
targets from `USAGE_LIMITS`. Returns `null` when the meter is disabled. Nothing
imports it directly: it reaches the UI embedded as `weekSummary().usage`, which
prefers `realUsage()` (below) and falls back to this, so the payload carries
`source: 'plan' | 'estimate'`.

## lib/usage.js (Agent CORE)

Real plan usage windows — the figures claude.ai shows under Settings → Usage.

```js
export function normalizeUsage(payload)          // SDK payload → { limits, subscription } | null
export function recordUsage(payload, nowMs?)     // cache a pull; → true if it produced rows
export function realUsage(nowMs?)                // → { limits, source:'plan', subscription, fetchedAt } | null
```

`sessions.js` pulls it once per turn via the Query object's
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, on the first
`assistant` message. It must happen **mid-stream**: a string prompt makes a
single-turn query and the SDK closes stdin at the first result, after which
control requests can no longer be sent. The call is fire-and-forget — a slow or
missing usage endpoint never stalls or fails a turn.

Constraints that shaped this, each of which has a test:

- **OAuth only.** `ANTHROPIC_API_KEY` installs get `rate_limits_available:
  false`; they keep the estimate.
- **Rows are derived, never assumed.** A window that is null or absent produces
  no row, so a per-model cap the account doesn't have can't show as a permanent
  0%. On a live Max account `seven_day_opus`/`seven_day_sonnet` were **both
  null** while a Fable cap was in use — the figure was only in `model_scoped[]`
  (with `limits[]` `kind:'weekly_scoped'` as the older fallback).
- **Units differ by channel.** This endpoint reports `utilization` as **0-100**;
  the pushed `rate_limit_event` reports the same quantity as a **0-1 fraction**.
  Mixing them is a silent 100× error, so the event is not read for values.
- **`resets_at` mixes formats** — ISO at the top level, unix seconds inside
  `limits[]`.
- **The method name will change** when the API stabilises; call sites
  feature-detect and fall back.

Readings are stamped `fetchedAt` and withheld after 24h. Because a pull only
rides along with a turn, the UI states the age rather than implying it's live.

## lib/sessions.js (Agent SESSIONS)

Drives Claude Code via `@anthropic-ai/claude-agent-sdk`'s `query()`. One *task* maps to one SDK
session id, reused across turns via `options.resume`. Each call to `query()` is one TURN: the
agent runs its agentic loop to completion for that turn (this is how autopilot does a whole task
in one turn). Process exits between turns; that's fine.

```js
export function launchTask(project, id)              // assemble context packet, start turn 1
export function sendMessage(project, id, text)       // resume session with a new user turn
export function interrupt(project, id)               // q.interrupt() on the active turn if any
export function activeSessions()                     // → [{project, id, startedAt, status}]
```

### SDK usage (essential API — follow this)

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
const q = query({
  prompt: text,                          // string per turn
  options: {
    cwd: PROJECTS[project].root,
    resume: task.session?.sdkSessionId,  // undefined on first turn
    permissionMode,                      // see oversight mapping
    settingSources: ['project'],         // respect each repo's .claude settings
    allowedTools,                        // see below
    systemPrompt: { type: 'preset', preset: 'claude_code', append: oversightAppendix },
    includePartialMessages: true,
  }
});
for await (const msg of q) {
  // msg.type === 'system' && msg.subtype === 'init'  → msg.session_id (store it)
  // msg.type === 'stream_event'                       → partial deltas:
  //     msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta'
  //     → broadcast('session:stream', {project, id, chunk: msg.event.delta.text})
  // msg.type === 'assistant' → full message; for tool_use blocks broadcast a one-line summary:
  //     broadcast('session:stream', {project, id, chunk:`\n[tool: ${block.name}] ${short}\n`})
  // msg.type === 'result' → msg.usage {input_tokens, output_tokens}, msg.total_cost_usd,
  //     msg.result (final text), msg.session_id
}
```

### Oversight → SDK mapping
- `auto`    → permissionMode `'auto'`  (model classifier approves routine calls; dangerous ones still ask; was `'acceptEdits'` in v1. The 🛡 per-task override can force `'bypassPermissions'` — passed with `allowDangerouslySkipPermissions: true`.)
- `propose` → permissionMode `'plan'`
- `coop`    → permissionMode `'auto'`  (classifier, same as auto — coop's oversight is conversational; 🛡 override `'default'` restores ask-first; was `'default'` in v1)
- `manual`  → launchTask must refuse (400)

`allowedTools`: omit (defaults) — but when `context.web_search.enabled`, ensure `'WebSearch'` and
`'WebFetch'` are included via `allowedTools: ['WebSearch','WebFetch']`? NO — allowedTools as an
allowlist would *restrict* everything else. Instead leave tools default; when web_search is
DISABLED pass `disallowedTools: ['WebSearch','WebFetch']`. This flag is editable post-creation and
re-read at the start of every turn, so a toggle takes effect on the next turn.

### Context packet (turn 1 prompt) — assemble in this order
1. Category primer: from `getCategories()[task.category].primer` (if include_category_primer)
2. Living abstract: `getAbstract(project)` (if include_abstract)
3. Upstream handoffs: for each `task.upstream` id, the upstream task's `handoff` JSON (if any)
4. Sibling tasks: one-line list of other tasks in the project w/ status (if include_sibling_tasks)
5. Pinned files: "Read these before starting:" + `context.files` (in-root pins).
   `context.files` entries that are ABSOLUTE paths OUTSIDE the project root are
   EXTERNAL pins (`lib/extpins.js`): they're listed in a separate "External
   context" packet section AND their directories (a file → its parent; a folder
   → itself) are passed as `additionalDirectories` in the turn's `query()`, so
   the session can Read/Edit them. This is an allowlist — only explicitly-pinned
   external paths are reachable; nothing else outside the root is. Add via
   `POST /api/pickfile {external:true}` (skips containment, returns `{path}`);
   the sidebar renders them amber with a × to revoke. External pins OPEN
   EDITABLE in the dashboard editor (v2.9.1 — addressed by absolute path):
   reads via GET `/api/extfile/:project/:id?path=`, saves via PUT
   `/api/extfile/:project/:id {path, content, baseMtimeMs}` — the same
   `isPathGranted` allowlist the session writes with, the same 409 mtime
   conflict guard as PUT /artifact. External `.md` gets the rendered ▤
   preview too (`fileUrl()` routes in-root files to /artifact and granted
   externals to /api/extfile — relative images/links in the pane resolve
   through the same grant). Binary/oversized externals stay read-only.
6. User notes: `context.notes`
7. The task itself: title + description
8. Protocol footer (ALWAYS, verbatim semantics):
   - "If you are blocked and need the user, end your message with a line starting `QUESTION:`."
   - Deliberately NO completion protocol: sessions are never told how (or invited) to declare
     the task complete — the \`\`\`handoff schema is taught only by the ✓ complete wrap-up
     message (the session's ability to propose ending a task was removed 2026-08-04).

### After each turn (result message)
- WHOLE-TREE usage: the result's `usage` counts ONLY the top-level loop — subagent and
  Workflow tokens are EXCLUDED (SDK docs: "undercounts as soon as nesting occurs"; the
  overnight-workflow 3M-token undercount, 2026-07-31). `parseModelUsage(msg)` reads
  `modelUsage` (whole tree, per model; camelCase wire, snake tolerated; cache tokens fold
  into `in` like `fullInputTokens`) and, when present, OVERRIDES usageIn/usageOut with the
  cross-model sums. `total_cost_usd` always included the tree — cost was never wrong.
- store/refresh `task.session` (sdkSessionId, counters += whole-tree usage, costUsd +=
  total_cost_usd, turns++)
- `logTokens(...)` — one row PER MODEL from the breakdown (honest attribution for mixed
  fleets); single task-model row only as the no-modelUsage fallback. Regression:
  `sessions.usage.test.mjs`
- parse final text: if a ```handoff fenced block parses as JSON → `updateTask(... {handoff, status:'waiting'})` —
  in practice only the ✓ complete wrap-up turn produces one (sessions are never taught the format
  otherwise, and nothing renders a handoff on a waiting task); the dashboard's `pendingComplete`
  then PATCHes `status:'done', archived:true`. Only the user closes a task, ever.
  else if /^QUESTION:(.*)$/m → status `'waiting'`, `question` = captured text
  else → status `'waiting'`, question null
- broadcast `session:status` `{project, id, status, tokens:{in,out}, costUsd}`
- on turn start: status `'running'`, broadcast same event
- on error: status `'waiting'`, broadcast with `error` field; never crash the server

Keep an in-memory transcript per task `{role, text, ts}[]` (user turns + final assistant texts +
streamed text accumulates into the pending assistant entry). Export it via
`getTranscript(project,id)` → array. (Server exposes it in /api/state.)

## lib/watchers.js (Agent WATCHERS)

```js
export function startArtifactWatchers()  // chokidar over each PROJECTS[k].root for **/*.html and **/*.pdf
export function getArtifacts()           // → [{project, path(abs), rel, name, mtime, kind:'html'|'pdf'}] newest-first, max 60
export function watchTex(project, texPathAbs)  // pin a live compile; returns {ok} or {error}
export function unwatchTex(project)
export function pokeTex(project, absPath)      // push: a file was saved via the app — recompile now
export function getPdfWatches()          // → {project: {tex, pdf, state:'building'|'built'|'error', lastBuildMs, lastBuiltAt, pages}}
```

Rules:
- chokidar: ignore dirs named `node_modules|\.git|data|_literature|literature` and depth > 6;
  `ignoreInitial: false` but seed initial list without broadcasting; after ready, on add/change
  broadcast `artifact:new` {artifact}. The same watcher's filter also passes LaTeX
  dependency extensions (`.tex .bib .sty .cls .bst .tikz .eps .png .jpg .jpeg`) so
  out-of-band edits (agent sessions, external editors, regenerated figures) feed the
  live compile below; those files are never recorded as artifacts.
- live compile: a watch is a pinned `.tex`, NOT a resident process (v1 was `latexmk
  -pvc`, which POLLS — $sleep_time defaults to 2s of dead air after every save).
  Every trigger — pokeTex from PUT /artifact (the zero-latency push path) or a
  dep-extension/pdf change from the artifact watcher (the compile's own outputs
  excluded) — coalesces 150ms, then runs ONE
  `latexmk -pdf -interaction=nonstopmode -synctex=1 -file-line-error <file>` with
  `cwd: dirname(tex)`. NEVER pass user input through a shell — use spawn(cmd, argsArray).
  latexmk's fdb/MD5 check is the relevance filter: an irrelevant trigger exits ~80ms
  without announcing a rule, so no 'building' state is broadcast for it. Triggers
  landing mid-compile set a pending flag → one follow-up compile of the newest state.
  Parse stdout lines: `Latexmk: applying rule` → 'building'; `Latexmk: All targets`
  (or exit 0 — finalize is idempotent) → 'built', once per cycle; `Latexmk: Errors` →
  'error'. A nonzero exit with no Errors line → 'error' + `dead:true` (killed/crashed;
  the next trigger simply spawns a fresh one-shot — no revive watcher exists anymore).
  Broadcast `pdf:status` with the getPdfWatches()[project] entry. Track build duration.
  Pages: parse `Output written on ... (N pages` from the .log if easy, else null.
  Known trade vs -pvc: dependencies OUTSIDE the project root no longer trigger
  (chokidar watches the root only; -pvc statted every dep) — papers are self-contained
  in practice, and an in-root save still recompiles everything.
- watchTex validates: texPathAbs must be inside the project root (path.resolve check) and
  end .tex. Pinning triggers an immediate catch-up compile (MD5-skips straight to 'built'
  when the pdf is already current).
- Kill an in-flight compile child on unwatch and on process exit (SIGTERM, on 'exit' hook).

## lib/plan.js — planning stage 1 (◆ next up + ⧉ calendar)

Design source: `mockups/planning-stages.html` (stage 1 only; stage 2 is parked
there; the mockup contains personal content and is not shipped in this repo).
Three files, all under the gitignored data ROOT (`/plan/` + `/.cache/` in .gitignore —
a pushed repo ships no personal data, a fresh clone boots with an empty planner):

- `plan/<project>.json` — `{deadlines:[{id,title,date,url,created}]}` (`url` optional — an
  http(s) conference/CFP link, `''` if none; day-only, no time/type). Per-project and yours;
  meetings are never stored here.
- `plan/calendar.json` — GLOBAL: `{sources:[{id,name,icsUrl}], includeAllDay, routes:{uid→{to,filed}}}`.
  `icsUrl` is a SECRET (Google's "secret address in iCal format" — read access to the
  whole calendar): it is **never included in getPlanSnapshot()**, so no /api/state
  response or WS frame carries it. `routes` files a VEVENT UID to a project key or
  `'personal'`; one line per SERIES (all instances share the UID). Absent = unfiled =
  shown nowhere. Removing a source keeps its routes (reconnecting finds filings intact).
- `.cache/gcal.json` — disposable expanded-occurrence cache, refetched every 15 min
  (`CP_PLAN_POLL_MS` seam); delete it any time.

The ICS engine is a deliberate no-dependency RFC 5545 subset: folded lines, escaped
text, DTSTART UTC/TZID (via Intl — node ships ICU)/floating/all-day, RRULE
DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL/COUNT/UNTIL/BYDAY(weekly), EXDATE,
RECURRENCE-ID overrides, STATUS:CANCELLED. Monthly short-month occurrences are
SKIPPED, never drifted. Fetches are 10s-timeout, http(s)-only, size-capped; a failed
fetch keeps the source's previous events (stale beats blank) and reports the error on
the source. Read-only forever: nothing here can write to Google, and nothing is billed.

Routes (server.js, all unbilled; mutations broadcast a full `state` snapshot; the
15-min timer broadcasts `plan:update` and clients re-pull): POST/DELETE
`/api/plan/:project/deadlines(/:id)`, POST/DELETE `/api/plan/cal/sources(/:id)`,
PATCH `/api/plan/cal` {includeAllDay}, POST `/api/plan/cal/route` {uid,to} /
DELETE `?uid=`, POST `/api/plan/cal/refresh`. Snapshot key: `plan`.

Frontend: `nextUpSectionHtml` renders ◆ Next up in the workbench sidebar between
▮ Pinned files and ◷ Recent activity — project-scoped (mock Q1), three rows hard cap,
derived per render (no file holds "the countdown"): merge project deadlines + events
routed to it, drop the past (deadlines linger 48h in red — mock Q4), sort, slice 3.
Colour contract (mock §palette): deadline `--pink` (pulses when ≤2 days or overdue),
meeting `--viewable`, unfiled chip `--wait`, primary buttons `--green`, remove `--red`
— tokens only, both themes free. The ⧉ Calendar top-bar tab (view `plan`, replacing
the ⊞ categories shortcut — the cats view stays hash-reachable and the editor stays in
the profile menu) renders sources / filing triage / every deadline — the deadlines
section has its own inline add row (project select · title · date · optional link), the
same POST the rail's ＋ uses. Section headers are PLAIN TEXT ("sources", "filing",
"deadlines" — no glyphs; a deliberate professional-look request). "skip for now" is
an in-memory per-session Set. The ⤴ Google link is `calendar.google.com/render?action=
TEMPLATE&…` computed from the stored deadline — a copy, not a sync, no credential.

## server.js (Agent CORE)

Express + http + ws. Bind **127.0.0.1** only. Wire-up:
- `express.static(APP_DIR + '/public')`
- `GET /artifact/:project/*` → serve file at `PROJECTS[project].root + '/' + wildcard`.
  SECURITY: resolve and verify the result startsWith(projectRoot + sep); 403 otherwise.
  Set headers so html renders in iframe (default is fine; no CSP needed for v1).
- JSON body parsing; all /api errors → `res.status(4xx|500).json({error})`; wrap handlers in try/catch.

### REST routes
```
GET    /api/state                      → snapshot (below)
POST   /api/tasks                      {project, ...fields}        → Task (201)
PATCH  /api/tasks/:project/:id         {patch}                     → Task
POST   /api/tasks/:project/:id/launch                              → {ok:true}   (calls sessions.launchTask)
POST   /api/tasks/:project/:id/message {text}                      → {ok:true}   (sessions.sendMessage)
POST   /api/tasks/:project/:id/interrupt                           → {ok:true}
POST   /api/providers/codex/check                                  → Codex provider state
POST   /api/providers/codex/login                                  → {ok,authUrl,loginId}
POST   /api/providers/codex/logout                                 → Codex provider state
POST   /api/providers/codex/models                                 → refreshed Codex provider state
PATCH  /api/providers/defaults                                     → {provider,model,reasoningEffort}
POST   /api/pdf/watch                  {project, tex}              → result of watchTex
DELETE /api/pdf/watch/:project                                     → {ok:true}
POST   /api/heartbeat                  {project, seconds}          → {ok:true}   (ledger.logTime)
GET    /api/transcript/:project/:id    → {transcript: [...]}
```

### GET /api/state snapshot shape (frontend depends on this exactly)
```json
{
  "projects": { "<key>": {"name","root","color","texWatch"} },
  "categories": { ... },
  "abstracts": { "<key>": "md string" },
  "tasks": { "<key>": [Task, ...] },
  "artifacts": [ ... getArtifacts() ],
  "pdf": { ... getPdfWatches() },
  "ledger": { ... weekSummary() },
  "providers": { "claude": {...}, "codex": {...} },
  "agentDefaults": { "provider", "model", "reasoningEffort" },
  "sessions": [ ... activeSessions() ]
}
```

On WS client connect: send `{type:'state', payload: <same snapshot>}` via onClientConnect.
Startup: initWss, startArtifactWatchers, then for each project with `texWatch` set, watchTex it.
Log one line per request is unnecessary; keep console output minimal but log server start + errors.

## WS events (server → client) — names are frozen
```
state            full snapshot
task:update      {project, task}
session:stream   {project, id, chunk}
session:status   {project, id, status, tokens?, costUsd?, error?}
artifact:new     {artifact}
pdf:status       {project, entry}
ledger:update    weekSummary()
provider:status  {provider, state}
provider:defaults {provider, model, reasoningEffort}
```
Client → server WS messages: none (frontend uses REST). Reconnect: client re-fetches /api/state.

## public/ (Agent FRONTEND)

Adapt the visual design of `dashboard_hybrid.html` — the original design mockup, not shipped in this repo (READ IT —
reuse its CSS wholesale into style.css, its layout into index.html, its render functions into
app.js) but replace ALL mock data with live data:

- On load: `fetch('/api/state')` → render; open `ws://localhost:4242/ws`; handle every event above
  (update state object, re-render affected view).
- Overview (bento): sessions cell (tasks with status running/waiting across projects), Up Next
  (queued+waiting+manual, waiting pinned), week ring + weekly ledger from `ledger` summary
  (hours per project; token cost vs budget), live deck tile (first pdf watch entry), artifact strip
  (artifacts list; click → open project workbench AND select it in show panel).
- Workbench per project: task tabs from tasks[project]; lineage from task.upstream (resolve ids →
  titles). A FILE tab dragged onto ANOTHER task's tab opens the file there — appended to that
  task's `context.files` (or its closed tab reopened — never duplicated) and remembered via
  `taskTabRemember` as the tab that greets the next visit — WITHOUT switching away from the
  current task (`wireFileToTaskDrag`; covers single-file tasks, which the reorder wiring's
  `files.length > 1` gate never arms). Its dragstart MUST widen `effectAllowed` to `'all'`:
  the reorder wiring's dragstart (registered first, on multi-file strips) sets `'move'`, and
  real browsers CANCEL a drop whose `dropEffect` isn't permitted — so the cross-task `'copy'`
  drop was silently dead from any 2+-file task while working from 1-file ones (2026-07-31).
  Regression: `ui.dragtab.test.mjs`, which drags via Playwright's REAL drag
  (`page.dragAndDrop`) from a two-file source — synthesized DragEvents bypass effect
  negotiation and cannot catch this class. The sidebar's ＋ menus (pin-a-file `#pinMenu`, add-lineage `#linMenu`) are portaled to
  the body as FIXED boxes by `placeSideMenu` — clamped on-screen, height capped to the room below —
  never absolutely anchored inside their `.sh` header: the sidebar is the leftmost column, and a
  right-anchored 300px menu in a ~250px column escapes through x=0 into unreachable overflow
  (regression: `ui.sidemenus.test.mjs`); center = code surface — v1 shows the *transcript-reported* files? NO: v1 center shows
  the task's `context.files` if they exist + a "⌨ tail" tab streaming session:stream chunks
  (append to a pre). Fetch file contents via /artifact/:project/<rel> as text for display
  (no syntax highlighting required; monospace pre is fine).
- Session pane (bottom right): transcript from /api/transcript + live chunks; composer POSTs
  /api/tasks/:p/:id/message; interrupt button POSTs interrupt; queued tasks show launch card w/
  context chips + Launch button → /launch; a waiting task's question renders ONLY in the
  ≋ console (the pink cs-ques block — the session pane's duplicate was removed); done
  tasks show handoff card (render task.handoff) + closed bar.
- Show panel (top right): tabs = pdf watch (iframe `/artifact/<p>/<relpdf>` reloaded on pdf:status
  built) + html artifacts of that project (iframe sandboxed `sandbox="allow-scripts"`).
- Add Task modal: full form from mockup (title, description, category pills from categories,
  project, lineage = multiselect of existing project tasks, oversight, context chips:
  abstract/last session/siblings/primer toggles, web search toggle, files (comma-separated text
  input), notes, launch: queue|start now). Save → POST /api/tasks (+ optional /launch). The JSON
  preview pane updates live from the actual form state (build the object, JSON.stringify, syntax
  highlight basic or plain).
- Web-search toggle (on/off only) is also editable in-task after creation — on the launch card
  (queued) and in the session bar next to model/oversight (running/waiting); hidden for
  done/archived/manual. Flips via PATCH /api/tasks/:p/:id with the full context; takes effect next turn.
- Categories view: render from categories data (read-only v1, ✎ disabled).
- Heartbeat: every 30s while document.hasFocus(), POST /api/heartbeat {project: currentView==
  overview ? null→skip : projectKey, seconds:30}. Only when a project view is open.
- Keyboard: ⌘0 overview, ⌘1..5 projects (order of PROJECTS keys).
- No build step: app.js plain ES module loaded with <script type="module">.

## Coding standards (all agents)
- ESM imports with explicit `.js` extensions.
- No top-level await in lib modules (server.js may use it).
- Every exported function defensive: bad project key or id → throw Error('...') which server
  catches → 400/404.
- Paths: always path.resolve + containment checks before reading user-supplied paths.
- Console: prefix logs `[core]`, `[sessions]`, `[watchers]`.

## v2 addendum — surface added since the v1 freeze (the lists above are historical)

New modules: `lib/runner.js` (run pinned files), `lib/pins.js` (data/folder cards),
`lib/snapshots.js` (change history + rewind), `lib/git.js`, `lib/notify.js` (ntfy push),
`lib/dataview.js` (pandas head-of-table preview), `public/hl.js` (editor syntax overlay),
`public/m/` (phone PWA).

SQL (v2.10): `.sql` is a first-class script type. Editor: `hl.js` gains a `sql` language
(keywords case-insensitively via the config's `kwLower` flag; `--` and `/* */` comments,
''-doubled strings, numbers) mapped from the `.sql` extension. ▶ run: `runner.js` executes
the file through the **duckdb python package** (same venv-else-python3 resolution as `.py`;
the CLI is rarely installed) — an in-memory connection in the file's own folder, so parquet/
CSV are queryable in place and a database file is a deliberate `ATTACH` in the script, never
guessed (a guess could contend with a live pipeline's lock). Statements run one at a time
via `duckdb.extract_statements`, so EVERY result set prints as duckdb's box table headed by
its statement (`-- SELECT …`), not just the last; the first error names its statement and
fails the run. Job cards: `RUN_LANGS['.sql']`, and session-side detection recognizes
`duckdb`/`psql`/`sqlite3`/`mysql` running a `.sql` file (lang `'sql'`, matching argv0 set
in INTERP_ARGV0).

Tex compile toolbar (v2.11, frontend-only — design study in `docs/texrun-mockups/`): the
tex ▶ lives in the PDF pane's toolbar, leading the − fit ＋ zoom cluster (`.pzRun`, built by
`pdfPane.js` when `onRunClick` is passed; state via `pane.setRun({show,running,dirty,title})`).
THE GEOMETRY CONTRACT: one fixed 34px box — every state swaps glyph + color only (▶ idle /
⊘ while THAT tex's one-shot run is live, click stops it); the amber corner dot = the tex
source has an unsaved draft. ▶ always saves-then-compiles (`runFile` has always saved first).
Which panes: pdfart tabs get it after a one-shot HEAD probe for the sibling `.tex` on the
/artifact route (revealed at pane birth, never mid-interaction; `pane.texRel` marks success);
the live-watch pane's ▶ is SAVE-NOW (the watch recompiles on save — a one-shot would race the
same aux/synctex files), so it never shows ⊘ and hides if the watch is deleted. State rides
`syncTexRunControls(project)` — called from `editorChrome` (keystroke dirty), `syncTexRunPane`
(run pings), and pane mounts. The editor foot only BOOTSTRAPS a never-compiled doc: its
`#runFileBtn` renders for a tex only while no watch/addedViewers/mounted pane exists for the
doc's pdf, then yields for good (addedViewers persists — a one-time handoff, not a squirm).
Foot geometry is locked too: `▶ run`/`⊘ stop` share one fixed 58px box (all runnables), and
the save note is the fixed-width `.saveChip` — saved (dim) / unsaved (amber, pulsing) /
`⚠ disk` (red — a session moved the disk under a dirty draft; same ⌘S reload/merge recovery),
full wording in the tooltip, click-to-save replaces the old materializing [save] button.
Regression: `ui.texrun.test.mjs`.

Session-pane height floor (frontend-only): the right pane's viewer/session
divider used a blind 82% ceiling — on short windows the remaining slice was
smaller than the session pane's fixed chrome, clipping the composer/sessbar
below `overflow:hidden`. Three layers now guarantee the buttons never leave:
(1) `.chat .log{min-height:0}` — load-bearing; without it the flex log
refuses to shrink below content and shoves the chrome out the bottom;
(2) the `hdivider` drag and the persisted-value restore clamp against
`sessMinPx()` — the tabs strip + every non-log `.chat` child measured LIVE
(voice chips, wrapped sessbar rows move the floor) + a ~26px sliver of the
grey gap; the restore re-applies after layout settles (double rAF) since a
hidden/unsettled render under-measures; (3) a ResizeObserver on the KEPT
`.rpb` re-clamps when the window/column shrinks later and grows back toward
the saved preference when space returns (NB `Number(null)` is 0 — an unset
preference means "keep current", never "collapse the viewer to 0%"). The
composer's autosize obeys the same law (v2.13): its growth cap is
`min(170, room the pane can give)` — measured live like `sessMinPx`, re-capped
by a ResizeObserver on the sessHalf when the pane changes size (the pane may
be KEPT across renders while the composer is rebuilt, so the observer calls
`sess._taCapFn`, refreshed each wiring pass) — past the cap the textarea
scrolls internally; a tall draft regrows toward the design cap when room
returns. Regression: `ui.vsplit.test.mjs` (drag floor, persisted clamp,
⇧Enter growth, live resize).

Editor pointer input, softWrap files (frontend-only): Chrome's textarea soft-wraps at a
slightly different effective width than the pixel-identical overlay pre — the delta is a
function of the pane's fractional width, so NO static CSS parity exists (diagnosis with the
probe chain: `docs/editor-click-offset-diagnosis.txt` — a constant fudge fixes one pane
width and breaks another; do not retry it). Since the user aims at the OVERLAY's glyphs,
pointer input is hit-tested against the overlay with PURE GEOMETRY — deliberately NOT
`caretPositionFromPoint`, whose hit resolution is not coordinate-consistent under
zoom/display scaling, and whose misses (line ends, blank lines, the jagged gap beside
break-word math rows) used to fall back to the NATIVE hit test, re-admitting the bug exactly
there. `pointerdown/-move/-up` on the textarea are intercepted (softWrap only): the logical
line by binary search over the `.ln` spans' viewport rects, the visual row from the line's
Range rects, the column by binary search over glyph rects with nearest-boundary rounding —
the SAME rulers the caret paint uses, so input and paint cannot disagree under any zoom,
DPR, or layer divergence. `setSelectionRange` drives the textarea; its private layout never
sees the gesture. Click-chording is counted manually (PointerEvent.detail is 0 on
pointerdown) by wall clock — NOT event timestamps (synthesized events can carry equal
stamps) — and any keystroke ends the chord (click → type → quick same-spot click is not a
double-click): 1×=caret / shift=extend, 2×=word, 3×=line; drags edge-nudge-scroll; native
handles only pre-paint editors, non-wrap files, and touch. `caretPt`'s EOL fallback anchors
to the char before the caret (a newline-only Range can collapse to no rects), then the line
element's own offset — NEVER the legacy line×lh grid, which ignores wraps above.
The hit test is also RACE-PROOF against background rebuilds (2026-07-31): a build transition's
renderWB paints the fresh overlay at mount (pan 0) BEFORE the viewport restore moves the
textarea, and Chrome delivers queued clicks ahead of the async scroll re-sync — in that window
a click used to resolve through top-of-file geometry (caret set hundreds of lines off; the next
keystrokes spliced there and caret-follow yanked the pane to the top: the "typing while
compiling" corruption, docs/editor-click-race-diagnosis.txt). Two layers close it: posFromPoint
re-aligns via hlSync when the layers' pans disagree >1px, and the restore pans the overlay
synchronously (`ed._hlSync`, exposed by the wiring — the `sess._taCapFn` idiom) right after
setting ed.scrollTop. Regression: `ui.editor-clickrace.test.mjs` (mis-panned-overlay click,
same-tick rebuild invariant, build-lands-mid-flow storyline; discrimination-verified — both
adversarial tests fail with either layer disabled).
Regression: `ui.editor-click.test.mjs` (the
math-dense fixture line provably diverges at the harness viewport, so its click matrix fails
against the native hit test; plus EOL / blank-line / jagged-gap cases).

Editor scroll sync, softWrap files (frontend-only): the same wrap-column divergence means the
two layers can disagree on TOTAL height, so the textarea (the scroll surface — it owns the
wheel and the scrollbar) can out-scroll the overlay or stop short of its last rows. Two
invariants keep the pane honest: (1) the line-number gutter's translateY keys off the
OVERLAY's clamp-checked `scrollTop` — the layer the user reads — never raw `ed.scrollTop`
(the numbers used to sail on past the text, which sat clamped at its own shorter end); (2)
after every repaint/rewrap (`hlPaint`, the softWrap ResizeObserver), `syncScrollRange` pads
the shorter layer's bottom up to the taller one, so both scroll ranges stay equal, scrolling
is 1:1 down to the last row, and the overlay's tail is always reachable. Regression:
`ui.editor-scrollsync.test.mjs` (forced-divergence scroll matrix, both directions).

Viewport sturdiness: the document never wobbles. The root declares `overflow-x:hidden;
overscroll-behavior:none` (style.css, top): a Mac two-finger scroll over a pane — a delta no
pane consumes, which chains to the viewport — can neither pan the page sideways nor
rubber-band it on EITHER axis (nor trigger the swipe-back gesture). The axes are
deliberately asymmetric: no view ever creates horizontal document overflow, so x is also
`overflow:hidden`-locked, but y must stay free — the OVERVIEW legitimately scrolls the
document when the project list outgrows the window; it simply no longer bounces at its ends.
Do not "fix" a vertical wobble report by locking overflow-y. Scrollbar thumbs paint only
while their pane is scrolling: a capture-phase listener stamps the scrolled element (document
→ `<html>`) with `.scrolling`, cleared ~700ms after the last event — the 8px gutter stays
reserved (styling `::-webkit-scrollbar` opts out of macOS overlay bars, and the paint-only
toggle means panes never reflow; load-bearing for the editor's two-layer geometry). Regression:
`ui.overscroll.test.mjs` (root locks declared; task view slack-free on both axes; overview
still scrolls vertically; thumb invisible at rest / painted mid-scroll / faded after).

raw|formatted LaTeX fences (design: `docs/fence-toggle-mockup.html`, variant A — header
strip with lang label · pill · ⧉ copy-source): `katexEl` deliberately skips `<pre>/<code>`,
so fenced LaTeX shows as source; tex-ish fences (lang `tex/latex`, or ≥2 math signals in an
untagged fence — an explicitly-tagged other language NEVER qualifies) get chrome from
`enhanceTexFences`, run after each settled segment render. "Formatted" re-renders the fence
text through the same md-chat + KaTeX + `texMacrosVisible` pipeline as answer prose after
`texFenceMarkdown`'s structural pass (equation/align→`$$`, lemma family, proof→∎,
`\emph/\textbf`, `\cite*`/`\label` → code chips) — a READING AID, not a compiler; the pdf
pane stays ground truth. Default raw; the choice lives in `fenceView` keyed by fence-content
hash (never on the DOM — segments rebuild on macro bumps/re-segmentation/renderWB and the
enhancer re-applies), capped 50/task; ⧉ always copies the verbatim source. Regression:
`ui.fence.test.mjs`.

Links never navigate the SPA tab: a delegated document-level click handler sends every
`a[href]` (except in-page `#anchors`) to `window.open(_blank, noopener)` — covers rendered
markdown/console links that carry no `target=`; modified clicks (⌘/ctrl/shift/middle) and
handlers that already `preventDefault` keep their behavior. Regression: the "links in
rendered content open in a NEW tab" test in `ui.console.test.mjs`.

Theming (frontend-only, desktop app): every themed color in `style.css` is a CSS variable on
`:root`; `html[data-theme="light"]` (one override block at the end of the file) is the light
palette. A Settings view (profile menu ▾ → Settings) holds a System / Dark / Light control;
the choice persists in `localStorage.theme` and 'system' tracks `prefers-color-scheme` live.
A `<head>` bootstrap in `index.html` applies the attribute before the stylesheet loads (no
flash). `public/m/` is still dark-only.

Per-browser VIEW state (localStorage, never the task record): theme, pane
dividers, closed tabs (`closedTabs:`), each task's last-active tab
(`taskTab:`), show-panel added viewers + order + closed set, AND the ◇
ephemeral extra tabs (`openExtra:<project>`, cap 15 — hydrated via
`extrasOf(key)` BEFORE tab normalization so a reload restores both the tabs
and an 'x:' last-tab recall; every mutation writes through `persistExtras`).
Task pins (`context.files`) stay server-side — tabs are never context.

LaTeX editor: `lib/texlog.js` (parse `-file-line-error` logs → problems), `lib/synctex.js`
(TeX Live `synctex` CLI wrappers), `lib/texmeta.js` (bounded project scan: labels/bib keys/
envs/commands for completion), `public/pdfPane.js` (PDF.js viewer: virtualized pages + text
layer, keep-place reloads, zoom, dblclick → inverse SyncTeX), `public/texEditor.js`
(completion popup, auto-pairs, auto-`\end`, ⌘/ toggle, § outline, ⌘J forward SyncTeX).
Dependency added: `pdfjs-dist`, served at `/vendor/pdfjs` from node_modules (offline-safe).
Both latexmk spawns (watchers live compile, runner one-shot) now pass `-synctex=1 -file-line-error`
WITHOUT `-halt-on-error` (nonstopmode reports every error and still writes survivable pages),
with `max_print_line=2000` in the env. `pdf:status` entries and tex run records gain
`problems: [{file, line, kind, message}]` (project-relative paths) + `counts`. LaTeX routes:
```
GET /api/synctex/view/:project?tex=&line=&col=   source→PDF {page,x,y,h,v,W,H} (422 if unmapped)
GET /api/synctex/edit/:project?pdf=&page=&x=&y=  PDF→source {file, line, column} (project-rel)
GET /api/texmeta/:project                        {labels, cites, envs, commands}
POST /api/texfix/:project {taskId}               BILLED — read-only Sonnet 5 suggests fixes
                                                 (409 running · 400 nothing failing)
POST /api/texfix/:project/resolve {id, status}   approve/dismiss/stale bookkeeping
```
`lib/texfix.js`: allowedTools Read/Grep/Glob (it can edit NOTHING), maxTurns 20, 5-min
ceiling; the reply is a JSON array of {file, find, replace, why} validated server-side
(containment, verbatim anchor in the dispatched content or on disk, cap 10) into
`suggestions` with per-item status. The editor highlights each open suggestion at its
find-string in the LIVE buffer (string-anchored → survives concurrent typing); approving
applies it into the user's unsaved draft — Claude never writes, so there is nothing to
merge. Tokens → ledger. Snapshot gains `texfix` ({project → fix state}); WS event added:
`texfix:status {project, fix}`. Watch resilience: a compile that dies without latexmk
reporting errors (e.g. killed) gets `dead:true`; since every build is a fresh one-shot,
the next save/trigger recovers by itself. The frontend keeps `location.hash` on the current view (replaceState), so a
browser reload restores the open workbench.

**Kaimon warm-REPL** (`lib/kaimon.js`, default ON): the dashboard MANAGES a
[Kaimon.jl](https://github.com/kahliburke/Kaimon.jl) daemon itself — zero user
config. A task turn in an AUTO-DETECTED Julia project (`*.jl` under the root
AND a root `Project.toml` — Kaimon's `start_session` hard-requires the latter,
so global-env Julia projects stay on plain Bash julia; cached 60s) lazily
boots ONE `kaimon --headless -p <freeport>` child
(Kaimon's native topology: one daemon per machine, one warm session per
PROJECT path, created by the model via `start_session` and persisting across
turns AND tasks — packages/state stay loaded instead of re-spawning `julia`),
injects `mcpServers:{kaimon:{type:'http',url:'…/mcp'}}` into `query()` once the
daemon answers (bounded wait ~15s; a cold boot continues in the background and
the NEXT turn adopts it), and auto-approves `mcp__kaimon__*` in `canUseTool` —
EXCEPT permMode 'default' (ask-first override → normal approval card) and
'plan'/propose (tools not injected at all; evals must not run in plan mode).
Lifecycle: idle-reap ~30min after the last Julia turn (never under an active
turn), `process.on('exit')` sweep, startup orphan sweep via a `ROOT`
state-file (`{pid, ownerPid}`; group-kill, `ps`-command guard against pid
recycling). First use seeds `<XDG_CONFIG_HOME>/kaimon/config.json` (lax =
localhost-only, INTEGER `created_at` — Kaimon's loader requires Int64; only
when absent) and merges Julia projects with a root `Project.toml` into
Kaimon's `projects.json` allowlist (which gates `start_session`). HARMLESS BY
DESIGN: `mcpFragmentFor(project)` → null (no injection, session unchanged) on
kaimon:false / non-Julia project / no binary / failed boot (60s cooldown) /
any error. Binary absent → a one-click enable card in the session pane runs
`]app add Kaimon` via POST `/api/kaimon/install` (403 under `CP_NO_BILLED`;
needs Julia ≥ 1.12). Steering: computation primer + PROTOCOL_FOOTER
(`start_session` once, then `ex` with `q:false` for values). `▶ run` and
`scripts/bg` stay fresh-process (warm-REPL state leakage would break
isolated/batch runs). Config: `"kaimon": false` kill-switch, optional
`{bin, idleMinutes}`; a legacy `{mcpServer:…}` block is ignored with a warning.
Env seams (tests): `CP_KAIMON_BIN/_CONFIG_DIR/_CACHE_DIR/_WAIT_MS/_IDLE_MS` —
the harness pins BIN to a nonexistent path so no test can spawn real Julia.
Snapshot gains `kaimon` (`{enabled, available, julia:{key→bool}, daemon|null,
install}`); WS event added: `kaimon:status` (same payload).

**Quiet builds** (v2.1): compiles report status, not logs. `texlog.passFromLine(line)`
parses latexmk's `Run number N of rule 'x'` boundaries. `pdf:status` entries gain
`pass: {n, rule}|null` (broadcast per boundary while `building`, null otherwise) and
`errorMs` (duration of a FAILED cycle; `lastBuildMs` stays successful-only). Tex run
records gain `pass` (live, null once finished) and `pages` (scanned from the stream —
an up-to-date run that recompiles nothing reports no pages). Frontend: BOTH pdf pane kinds
(`createPdfPane({buildStatus:true, onVerdictError})` — the live watch fed by
pdf:status, and artifact panes fed by `syncTexRunPane` mapping the run record of a
matching `.tex` ▶ run) show a 3px staged bar across the top. The bar moves
CONTINUOUSLY: each pass boundary starts one front-loaded 12s transition
(`CREEP_EASE`) that quickly clears the honest `passFrac(n)` stop then creeps toward
`creepTarget(n)` just under the next stop — never backwards (fresh builds snap to
0.02 with transitions off first), never frozen, 1 only on built (then fades ~450ms;
mounting on an already-built entry stays quiet). Toolbar verdict chip: `⟳ rule ·
pass N` → `✓ 1.8s` / `✗ 0.9s` (persists until the next save/run; clicking ✗ jumps
to the first error). For `.tex` ▶ runs
the output tab renders a build card (verdict + pass chips + click-to-jump error rows +
the raw log behind a collapsed `▸ full latexmk log` disclosure) instead of streaming
the log, and run:status pings that only advance `pass` patch the card in place (no
renderWB). **▶ on a `.tex` = one-shot run + the ＋-equivalent pdf tab** (`runFile` →
`ensureTexPdfTab`): after the `/api/run` POST succeeds, the output pdf rel
(`tex.replace(.tex → .pdf)`) is pushed into the project's persisted addedViewers as
kind `pdfart` (unless present) and selected — one tab per document, so several `.tex`
files' pdfs coexist exactly like hand-＋-added displays. The render-time dedup reuses
an existing tab for the same rel (pinned/artifact/added); `selectViewer` reopens a
×-closed one. `syncTexRunPane` already keys the bar/verdict by that same pdf rel, and
`artifact:new` reloads the pane in place when the compile lands (including a pane that
mounted 404 because the pdf didn't exist yet). runFile does NOT auto-switch the
session pane to ▶ output for `.tex` (quiet builds); non-tex runs keep the live stream
and the auto-switch. One exception: if the project's live watch (＋ → `.tex`) already
covers the file, ▶ just re-selects the `pdf` watch tab and starts nothing — a one-shot
latexmk beside the watch's own compile would race the same aux/synctex files.

### Routes added
```
DELETE /api/tasks/:project/:id                       delete task (+ transcript, snapshots)
POST   /api/tasks/:project/:id/permission            {requestId, allow, message?} approval-card answer
POST   /api/run               {project, rel}         run a file (runner.js); one per project
DELETE /api/run/:project                             stop the active run
POST   /api/jobs/:project/stop {key}                 stop a job card's process (see Job cards)
POST   /api/tasks/:project/:id/retry                 BILLED — re-run the last turn (sign-in card's ↻;
                                                     403 under CP_NO_BILLED, 409 mid-turn, 400 no history)
POST   /api/auth/check                               run `claude auth status` now → auth state (not billed)
POST   /api/auth/login                               run the CLI's browser sign-in (409 already running,
                                                     400 when auth is via ANTHROPIC_API_KEY)
GET    /api/feed/:project                            ◷ Recent activity items (see Sidebar activity feed)
PUT    /api/extfile/:project/:id {path, content,     save an edited EXTERNAL pin (grant-checked;
                                  baseMtimeMs}       409 on mtime conflict, 403 ungranted)
GET    /api/ls/:project?rel=                         folder-pin browser listing
GET    /api/pincard/:project?rel=                    data/folder card (kind from on-disk stat)
GET    /api/datahead/:project?rel=&rows=&format=     head-rows preview (html default | json)
GET    /api/files/:project                           project file list (pin search)
POST   /api/pickfile                                 native macOS file dialog (local only)
GET    /api/snapshots/:project/:id  (+ diff/rewind)  change history
/api/git/*                                           status, pull, commit-push, delegate
PUT    /artifact/:project/*                          save editor buffer (mtime conflict guard)
POST   /api/update/check                             re-check the dashboard's own repo vs origin
POST   /api/update                                   fast-forward the checkout (409 dirty/diverged)
POST   /api/categories                               create category (409 dup, 400 bad name)
PATCH  /api/categories/:key                          edit icon/group/primer/webSearch
POST   /api/categories/:key/rename {to}              rename + RETAG every task, all projects
DELETE /api/categories/:key                          delete — tasks keep their label
POST   /api/catgroups/rename {from, to}              rename a group (members move along)
POST   /api/catgroups/delete {name}                  delete group + its categories (UI confirms)
GET    /api/profile                                  the About-You card ({} before first generate)
POST   /api/profile/generate                         BILLED (one haiku call) — 403 under CP_NO_BILLED,
                                                     502 when the upstream call fails
POST   /api/projects                                 add a project (201; Manage Projects tab)
PATCH  /api/projects/:key                            edit a project (name/root/status/…)
POST   /api/pickfolder                               native macOS folder dialog (local only)
GET    /api/activity                                 ledger.dailyActivity() (overview heatmap)
GET    /api/commits                                  recent commits of the dashboard's own repo
GET    /api/extls/:project/:id?dir=                  granted external-folder listing (403 ungranted)
POST   /api/texfix/:project/dismiss                  drop the pending Claude-fix suggestion (unbilled)
```

### About You & Manage Projects (Agent CORE + FRONTEND)
The profile card (Settings → About You) renders `GET /api/profile` (`profile.json` at the
repo root, gitignored — it holds the user's name/bio) and rebuilds it with the ↻ button via
`POST /api/profile/generate` (lib/profile.js) — a real BILLED call, guarded like
/launch//message/retry by `CP_NO_BILLED`. Manage Projects (nav tab) drives
`POST /api/projects` / `PATCH /api/projects/:key` (lib/projectStore.js — key/name/root
validation lives there; `status: inactive` hides a project from nav and overview) with the
folder picker on `POST /api/pickfolder`. Both broadcast a fresh `state` snapshot, and the
snapshot carries the profile under its `user` key.

### WS events added
`run:status` `run:stream` (`{chunk, off, fd?}` — off = cumulative bytes for reconnect dedup,
fd 2 = stderr) · `snapshot:new` · `session:permission` / `session:permission:resolved`
(propose-mode previews ride the permission payload into the `__proposal` viewer tab — there is
no separate `proposal:*` event). Snapshot adds a `runs` field ({project → run info incl. tail}).
`session:agents` `{project, id, agents:[{n, type, desc, status:'running'|'done'|'failed',
summary, tools, tokens}]}` — the live subagent roster of the running turn (see
**Agent teams** below); an empty list means the turn ended or has no agents. Snapshot
`sessions[]` entries gain the same `agents` field; `applyState` REPLACES the client's
live rosters from it (reload/reconnect mid-turn re-seeds, dead rosters vanish) and the
renderer reads ONLY the live copy — a direct snapshot fallback used to resurrect a
stale fleet under every later turn (fossil-panel bug, fixed 2026-08-03).
`update:status` — the dashboard self-updater's status object (see **Self-update** below);
the snapshot carries the same object as a top-level `update` field.
`session:edits` `{project, id, edits: {files, created, modified, deleted, adds, dels} | null}`
— the running turn's live ✎ file-edit aggregate, emitted once per completed edit tool
call (see **Δ tab v2** below). Snapshot `sessions[]` entries carry the same `edits` field,
re-seeded by `applyState` exactly like `agents`; clients drop the live copy on the
turn-ending `session:status`, which lands AFTER `snapshot:new`.
`file:changed {project, rel}` — broadcast MID-TURN the moment a session's Edit/Write
tool result lands. `rel` is root-relative for project-contained paths; for a granted
external pin (see **External pins**) it is the absolute path, matching the pin's
`rel` convention. Ungranted outside-root paths are not broadcast. Clean open editors reload the file
in place (scroll/caret kept). An unsaved draft is never clobbered: the client
3-way-merges the disk change INTO the draft (base = the fileCache text, which is
deliberately frozen while a draft exists; `merge3`/`lineDiff` in app.js) — a clean
merge rebases `draftBase` onto the new disk mtime so save/▶ just work, while an
overlapping edit (or any doubt: truncated/binary/unfetchable) pins the draft behind
the footer's ⚠ changed-on-disk warning with the PUT-time 409 flow as the safety net.
The turn-end `snapshot:new` cache purge remains as the catch-all.
Session-edited `.tex` files are also collected per turn (`file:changed` +
`snapshot:new` files; bash side-effects are invisible here as everywhere) and at the
turn-ending `session:status` each one whose compiled sibling pdf has an open viewer
tab (added/▶ tabs plus the turn task's pdf pins) is auto-recompiled through the
project's single one-shot run slot, queued FIFO behind any live run — the live
watch's own tex is skipped (the watch recompiles it by itself), no tab is
selected, and the DISK version compiles, never an unsaved editor draft.
`job:status {project, job}` — a long-running script's live status card (see **Job
cards** below); broadcast per poll tick while the job is visible and on transitions.
The snapshot carries the same objects as a top-level `jobs` array.
`auth:status` — the Claude sign-in state (see **Sign-in card** below); the snapshot
carries the same object as a top-level `auth` field. `session:status` error
broadcasts gain `authNeeded: true` when the turn's error classifies as an auth
failure, so clients can name the failure honestly instead of toasting SDK noise.

**Agent teams** (v2.2): sessions can fan work out to subagents via the SDK's Task
tool — available by default (built-in agents plus any the repo defines in
`.claude/agents/`, loaded through `settingSources: ['project']`; `options.agents`
stays open for programmatic definitions). `query()` gains
`agentProgressSummaries: true`, so the SDK forks each running subagent ~every 30s
into a short present-tense summary (rides the agent's own prompt cache — near-free).
**Subagents are FORCED FOREGROUND** (2026-08-03): a dashboard turn is one CLI
process, and a background agent dies with it the moment the turn ends — twice
in one day a mid-flight agent team was orphaned that way. A `PreToolUse` hook
(`forceForegroundAgents`) rewrites every Task/Agent spawn to
`run_in_background: false` (isolation:'remote' exempt — cloud agents survive
on their own), so the turn stays open until the whole team reports; the
`AGENT_TEAM_APPENDIX` system-prompt line and the turn-1 protocol footer tell
the model the same rule. Belt: `tracker.clear()` at turn end emits
`◆ agent #N ⚠ lost` lines for anything still running (interrupt, CLI crash),
and runTurn re-appends that note after the finalText transcript replacement so
the loss is in the stored record, not just the live stream. Revisit all of
this if sessions ever move to one long-lived process (streaming input mode) —
then background agents become safe and the hook should go.
`lib/sessions.js`'s per-turn `createAgentTracker` fuses four sources — the Task
tool_use block (spawn moment), the SDK's `task_started`/`task_progress`/`task_updated`
system messages, the Task tool_result, and `task_notification` — into TWO channels.
Since CLI 2.1.x subagents run in the BACKGROUND by default, so the tool_result is
normally a launch ack (matched structurally: `^Async agent launched` or
"working/running in the background" — the phrasing has drifted once already, and a
missed match stamped ✓ on agents that had just started: the premature-checkmark bug,
fixed 2026-08-03) → `⇢ backgrounded`, status stays running. Authoritative completion
is `task_notification` (terminal status + final summary + whole-run usage
{total_tokens, tool_uses, duration_ms}), with `task_updated` as belt; a non-ack
tool_result still settles a synchronous agent directly. Settled cards ignore
straggler `task_progress` frames (async summaries can land after the finish). Stream
text (the durable transcript record, styled as segment kind `cs-agent`): `◆ agent #N ▶
type — description` on launch, `◆ agent #N ✓ done — report` / `✗ failed — error` /
`⇢ backgrounded` on settle, `↳N` prefixes on the agent's inner tool/result lines.
Progress emits NO stream text (the old throttled `◆ agent #N · …` lines spammed
multi-agent transcripts — removed 2026-07-30); it rides ONLY the un-throttled
`session:agents` roster, whose entries carry `{n, type, desc, status, summary, tools,
tokens, ms}` (`ms` = live elapsed, frozen at completion). Non-agent tasks
(backgrounded shell, monitors, `skip_transcript` housekeeping) are excluded. The
console renders the roster as the FLEET BOARD (`.csAgents`, design:
`docs/agentview-mockups/` variant ②, picked over a color-only design for
color-blind safety): header counts (`◆ N agents · R running · ✓D · ✗F`) + a card
grid — mission, live note, tools/tok/clock per agent. Finished cards stay on the
board DIMMED with verdict + "ago" (the frontend stamps the running→done transition;
rosters are merged by `n`, not replaced) while stragglers keep a live clock; past 8
agents the board groups by agent type and folds settled cards into the group counts;
an empty roster clears the board at turn end (tracker `clear()` in the turn's
`finally`). Regression: `ui.agents-fleet.test.mjs` (choreography: mid-flight,
stragglers, no-rebuild signature, 24-agent grouping, clear, fossil-panel
source pin) + `sessions.agents.test.mjs` (no progress stream lines; roster `ms`
semantics; launch-ack vs completion; task_notification authority).

**Markdown viewer** (v2.9): the show panel renders `.md`/`.markdown` — kind
'md' in the viewer stack, a THEMED div (`.artFrame.mdPane` > `.mdBody.csMd`),
NOT an iframe: content comes from the app's own pipeline (`md()` = marked +
DOMPurify + math-stash, `katexEl`), so it matches the console typography in
both themes. `md()` runs one of two lazily-built marked instances
(`mdEngine(chat)`): both require `~~` for strikethrough (marked's stock GFM
rule pairs SINGLE tildes, and prose "approximately" tildes struck out whole
spans — docs/console-tilde-strikethrough-diagnosis.txt); the chat engine
(console segments pass `{chat:true}`) additionally shows raw HTML literally
(`data/<format>/…` placeholders survive), while this doc pane keeps real
HTML, GitHub-style, still DOMPurify-sanitized. KaTeX (`katexEl(el, macros)`)
speaks the paper's dialect: `\newcommand`/`\DeclareMathOperator` definitions
are harvested (`parseTexMacros`, cached by file text) and passed as KaTeX
`macros` — without this, `$\ah$`-style preamble shorthand painted red
(errorColor fallback; docs/console-red-math-diagnosis.txt). Harvest SOURCES
(v2.12 — `texMacrosVisible(project, task)`, used by console AND md pane):
the task's pinned `.tex` files (fetched on demand; explicit pins win
conflicts), the `.tex` SIBLING of every pinned/open non-external pdf (the
toolbar ▶'s pdf→tex mapping — a wrong guess 404s once and caches the error),
the live watch's tex, any project `.tex` already in fileCache (tabs, Δ
views), and everything previously harvested project-wide — so a PINLESS task
still renders the dialect its session reads with tools (the task-015 red-\Hs
case). `texMacroRev` bumps when a harvest changes; console segments and md
panes are stamped (`._mac`) and re-typeset on mismatch, healing math rendered
before any source's fetch landed. Openable via the ＋ picker, an ephemeral tab for any selected
`.md` (folder-pin flow), or the `▤ preview` button that `.md` files get in
the center editor's footer. `syncMdPane(key, rel)` fills the shown pane:
the editor's UNSAVED DRAFT when one exists (live preview — the editor's
input handler pings it debounced 250ms; the viewer bar says "previewing your
unsaved draft"), else the cached/fetched disk copy (`ensureFile`); it patches
only when the source changed and keeps the reader's scrollTop. Relative
images/links resolve against the file's folder via `/artifact`; links open
`target=_blank` (never navigate the dashboard) and bare `#` anchors are
inert (location.hash is the app's view routing). The pane rides the kept
viewer stack (keepStack includes 'md') — tab switches don't re-render;
`file:changed` freshness flows through the existing refreshFile → renderWB →
syncViewerStack chain (a draft is never clobbered — it IS the preview). The
viewer bar offers `✎ source` (opens the file in the center editor via the
pin/extra-tab path) and `raw ↗`. `.md` files are deliberately NOT indexed as
artifacts (a repo full of READMEs would flood the strip) — md views come
from pins, the editor, and ＋. Tests: `test/ui.mdview.test.mjs`.

**Sidebar activity feed** (v2.8): the workbench sidebar's archived-task dump
is replaced by **◷ Recent activity** — a merged, newest-first timeline of what
happened in the project. `GET /api/feed/:project` assembles ≤40 items from
three sources: Δ change-sets (`listSnapshots(project)` — `{kind:'edits', ts,
taskId, eid, revert, files:[{rel,status,adds,dels}], adds, dels}`), finished
runs (`jobs.getJobHistory` — every VISIBLE job records `{ts, file, lang,
source, state, ms, taskId, bg, detached}` on finish into an in-memory ring,
cap 50/project, persisted at `ROOT/jobhist.json` so restarts keep the feed),
and task completions (`{kind:'done', ts, taskId, title}`; ts = the closing
log note, else lastTurnAt). GROUPING (frontend): a change-set with ≥3 files
folds into one expandable ▸ row (`Δ 15 files · task · +240 −60`), and
≥3 adjacent same-task runs within 10 min fold into `▶ ran N scripts`; expanded
groups list 3 then "…N more". Singles stay single. File rows carry
`+`/`Δ`/`×`/`⟲` verb GLYPHS (feedmark-mockups ④a, 2026-07-31 — typographic
marks replacing the short-lived bracket tags; Δ deliberately matches the Δ
history tab the rows deep-link into). `.afVm` is a fixed 12px centered column
at a fixed font size so head/kid rows align; the verb word survives in the
tooltip; color-blind safe by SHAPE, not just color. Run/done rows keep their
`▶`/`✓` glyphs; the +/− deltas and the age sit in fixed `.afD`/`.afW` columns
(`ui.feed.test.mjs` pins all four columns). NAVIGATION: ✎/✚/✂/⟲ rows →
select the task, `ensureSnaps`, then the file's inline diff in the Δ tab
(`per.snapView`); group heads → the Δ list (plain click toggles expand, the
Δ→ chip navigates); ✓ done → selects the archived task; ▶ rows → the ▶ output
pane when they are its current run, else the task's console. Freshness:
feedCache per project, refetched (debounced 800ms) on `snapshot:new`, terminal
`job:status`, task done, and `task:delete`. There is NO archived-list entry
point in this section — BY DESIGN (user decision 2026-07-13; do not re-add a
toggle/row). Archived tasks are reached via the feed's ✓ done rows and the
overview's Recent tasks strip (which lists archived tasks of every status);
unarchive lives on the selected task's sidebar actions. Narrow-sidebar
guarantee: feed rows ellipsize (`.nm`), header annotation chips shrink before
action buttons (＋), `.taskActs` wraps — no horizontal scroll at the 180px
minimum (regression-tested in `test/ui.feed.test.mjs`).

**Sign-in card** (v2.7): `lib/auth.js` — the dashboard's truth about "can we
reach Claude?". A signed-out install used to fail turns with cryptic SDK
toasts; now an amber card in the session pane (and on queued tasks' launch
cards) says so and fixes it. DETECTION, three layers: a boot check (~5s,
`CP_AUTH_BOOT_MS`), a throttled check whenever a dashboard client connects,
and on EVERY turn error — `classifyAuthError` (exported; /login, invalid
api key, authentication_error, expired/revoked OAuth, 401…) flags the
`session:status` broadcast instantly, and a confirming `claude auth status
--json` run catches auth failures with unrecognized wording. The CLI verdict
is authoritative: `loggedIn:true` clears `needed`, a successful turn clears it
too, and a missing CLI reports `available:false` without nagging (no card the
user can't act on). THE FIX: `startLogin()` spawns the CLI's own
`claude auth login` (browser OAuth; 4-min timeout), then re-checks — the card
holds its spinner until the verdict, and clears everywhere via `auth:status`.
An `ANTHROPIC_API_KEY` in the server env means browser login can't fix it —
`method:'apikey'` renders the update-the-key copy with no Sign in button, and
/api/auth/login refuses (400). "↻ Retry turn" re-checks sign-in, then POSTs
the retry route, which pops the failed exchange (last user prompt + partial
assistant text) from the transcript and re-runs the same prompt — the
conversation reads as if the failure never happened. Auth state shape:
`{needed, reason, loggedIn, email, method, checking, loggingIn, loginError,
lastChecked, available}`. Binary resolution: `CP_CLAUDE_BIN` (test seam —
serverHarness pins /nonexistent so no sandbox ever pops a real browser;
`test/fixtures/fake-claude.mjs` is the injectable fake) → PATH → ~/.local/bin
→ /opt/homebrew/bin → /usr/local/bin. Auth status/login are account plumbing,
NOT billed calls; the retry route IS billed and is 403-blocked under
`CP_NO_BILLED`. The same release makes the session pane (and console)
narrow-proof: every card/hint/handoff/question wraps (`overflow-wrap:
anywhere`, flex-wrap on hint/launch/artifact rows, `min-width:0` on the
composer), console tables scroll in place, and `test/ui.auth.test.mjs` holds a
no-horizontal-overflow regression across states at the 300px pane minimum.

**Job cards** (v2.6): `lib/jobs.js` — a live monitor for long-running script
executions, surfaced as a status card (elapsed · %CPU · mem · pid · ⊘ stop ·
progress bar). Two sources feed one registry: **'session'** — a task turn's
Bash tool call whose command runs a julia/R/python script or a NOTEBOOK
(`jupyter nbconvert/execute`, papermill, `quarto render`, `uv run`; lang
'notebook'/'python') — detected from the streamed tool_use via
`detectScriptRun` (flag tokens like `--output=x.ipynb` never win over the
real input). INLINE evals — `julia -e '…'` / `Rscript -e` / `python -c` /
heredocs with no script file — are jobs too (v2.6.2; a multi-minute GE solve
is often a `-e` program): `inline:true`, `file:null`, the card titled by the
tool call's own `description`; pid discovery matches the interpreter among
FRESH processes only (start-time guard + an explicit kaimon exclusion, so the
warm-REPL julia daemon is never adopted); the 8s visibility gate keeps
trivial one-liners cardless. Backgrounded (`run_in_background`) and
DETACHED launches (nohup/setsid/`scripts/bg`/trailing `&`) are tracked too
(v2.6.1): `bg`/`detached` flags ride the job. A bg/detached job's tool_result
is just the launch ack — it ends only when its PROCESS exits (pid-gone grace,
`CP_JOB_GONE_MS`) or, for bg, when the turn ends (the SDK reaps background
shells); a DETACHED job survives the turn — its card stays in the console and
the session chat until the process dies, and ⊘ stop keeps working across
turns. The process is the SDK's, so stats come from one `ps -axo` sweep (~2s,
only while jobs live): the pid is found among OUR process descendants by
interpreter argv0 + script basename (deepest match — juliaup shims keep the
real binary as a child); detached jobs (re-parented to launchd) search the
whole table, guarded by process start time (etime) so a pre-existing run of
the same script is never adopted. %CPU and rss summed over the pid's subtree. Its stdout is NOT observable → no
progress/quiet; the card shows an indeterminate sweep. `tool_progress`
messages re-anchor the clock to actual execution time (approval waits don't
count). The tool_result ends the job (`error` → ✗); the turn's `finally` ends
any leftovers; a vanished pid ends it after a 10s grace (compound `&&`
commands). **'run'** — runner.js hands over child.pid + both output fds, so
the card adds parsed progress (`iter N/M`, `[N/M]`, bar+% (ProgressMeter,
txtProgressBar), reported `ETA h:mm:ss`; ETA estimated from a sliding
frac-history + EMA otherwise; a frac drop >0.15 = new phase, history resets)
and `quietMs` (time since last output byte). `.tex` keeps its build card —
never a job. VISIBILITY: a job broadcasts only after MIN_AGE (~8s; session
jobs also need a found pid) — quick scripts never flash a card. Ended visible
jobs broadcast a terminal state (`done|error|stopped`) and linger ~30s for
reload seeding; ended invisible jobs vanish silently. STOP: `POST
/api/jobs/:project/stop {key}` — `run:*` keys delegate to runner.stopRun
(group kill); session keys SIGTERM the pid subtree individually (never the
group — the SDK shell may share it), escalating to SIGKILL after ~6s;
`stopping:true` rides the broadcasts until the process actually dies. Env
seams (tests): `CP_JOB_MIN_AGE_MS`, `CP_JOB_POLL_MS`. Snapshot gains `jobs`
(visible jobs, `[{key, source:'session'|'run', project, taskId, file, lang,
state, stopping, startedAt, elapsedMs, pid, cpu, mem, progress:{frac, iter,
total, etaS}|null, quietMs, exitCode, ms}]`); WS event added: `job:status
{project, job}` (per poll tick + on transitions). Frontend: one `.jobCard`
component in two mounts — the session console's strip (under the agents
roster, filtered to the open task) and a `.runJobSlot` atop the ▶ output tab.
Cards are built once and PATCHED in place (bar width transitions and the 1s
local clock must survive updates); session cards sweep indeterminately, run
cards fill honestly (backwards >8% snaps without a reverse glide), `quiet`
appears amber from 10s, terminal cards hold ~6s then fade out.

Job cards v2.6.3 — SUPERVISOR LOOPS. Sessions launch crash-resuming runs as
`nohup bash -c 'until Rscript x.R; do …; done' &`. (1) Detection: the segment
split doesn't understand quotes, so the `;` inside the quoted program used to
sever the nohup/`&` from the segment where x.R is found → `detached:false` →
the card died with the tool_result while the run went on for hours. Now any
detach-marked PHYSICAL LINE (nohup/setsid/`scripts/bg`/trailing `&`, where a
`&&` continuation does NOT count) containing the matched token makes the hit
detached. (2) Respawn-following: at pin time the job records the pid's private
ancestor chain (stops before launchd AND before this server, whose descendants
span every task). When the pinned pid vanishes, the nearest still-alive
recorded ancestor's descendants are searched for the same interpreter+script
and the card re-pins — tree containment replaces the freshness guard, so no
cross-task adoption. Between crash and respawn (the loop's sleep) a detached
job whose ancestor still lives is HELD rather than graced out. (3) ⊘ stop
kills recorded ancestors that have re-parented to launchd FIRST (the loop
would otherwise just respawn); ancestors still under the SDK's live shell are
never touched.

**Manage Categories** (v2.5): the profile menu gains ❏ Manage Categories — a
two-pane master–detail editor (view key `catman`, reserved in projectStore)
over `categories.json`: grouped tree left (per group ✎ rename / ⠿ delete,
＋ Category / ＋ Group), editor right (curated icon picker, name, group
dropdown, primer textarea, web-search default toggle; the unused legacy
`defaults.artifact` field is deliberately NOT surfaced — unknown defaults keys
are preserved on disk untouched). `lib/categoryStore.js` owns the writes
(atomic; a fresh clone's first edit materializes categories.example.json into
the user's own file; corrupt json throws rather than being clobbered).
Load-bearing semantics: **rename propagates** — the key and display name
unify to the new value and `taskStore.retagCategory` rewrites task.category
across every project, past and present (response carries `retagged`);
**deletes never rewrite the past** — a deleted category's (or deleted group's
member categories') tasks keep their now-dangling label, which every consumer
already renders as a plain string (pickers simply stop offering it);
**group deletion is confirmed in the UI** (confirmBox names the group and
counts the categories going with it). Groups are labels on categories — an
empty ＋ Group is client-local until a category is saved into it. Every
mutation re-broadcasts a full state snapshot so Add-Task pickers refresh
live. Group routes live under `/api/catgroups` so a category literally named
"group" can never shadow them. The read-only Categories view links in via
"✎ manage categories".

**Self-update** (v2.3): `lib/updater.js` keeps the dashboard current with the repo
it was cloned from. Once shortly after boot and then daily (override:
`CP_UPDATE_CHECK_MS`), it fetches the app checkout's upstream (branch `@{upstream}`,
falling back to `origin/<branch>` → `origin/main|master`) and counts
`HEAD..upstream`. Status object (snapshot `update` + `update:status` WS event):
`{state:'unknown|unavailable|checking|ok|behind|updating|error', behind, ahead,
dirty, branch, upstream, head, commits:[{sha,subject}] (≤12 incoming), lastChecked,
error, updated}`. When `behind`, the frontend puts a `1` badge on the profile button
(same pill as the project tabs' waiting badge; click → Settings) and Settings shows
an **Updates** card — version, status, incoming commit list, **Update now** +
**Check now** buttons. `POST /api/update` is a guarded fast-forward: refuses (409)
on dirty tracked files or local commits diverging from upstream, `merge --ff-only`
otherwise, runs `npm install` in `app/` when the delta touches `app/package*.json`,
and reports `{from, to, npmInstalled, needsRestart:true}` — the card then says
"restart the server to finish". Being offline degrades gracefully (compares against
the last-fetched ref, notes the fetch failure); a non-git install reports
`unavailable`. All git calls are execFile arg-arrays, non-interactive
(GIT_TERMINAL_PROMPT=0, ssh BatchMode). Env seams: `CP_UPDATE_REPO` points the
updater at a different checkout — the test harness pins it to the sandbox root so
no test ever fetches the real repo (`test/api.update.test.mjs` runs against a
throwaway bare-origin + clone fixture).

**Δ tab v2 — the file-by-file ledger** (v2.4): seeing how Claude edits things.
Journal entries' `files[]` gain `edits` (how many edit tool calls hit the file
this turn — `snapshots.createTracker.note()` now counts repeats), `adds`, and
`dels` (bounded-LCS line counts, `snapshots.diffCounts`, exported). Old entries
without the fields render gracefully. Three surfaces:
1. **Live strip line**: after every successful edit tool result, sessions.js asks
   the turn's tracker for `liveCounts(file)` (one bounded diff of just that file)
   and broadcasts `session:edits` (event above). The console activity strip —
   shared with the agents roster — renders `✎ N files changed · X new · Y edited ·
   Z deleted · +A −B · → Δ`; `→ Δ` jumps to the Δ tab, which is reachable
   mid-turn (a "turn in progress" note stands in until the change-set records).
2. **Δ list**: each change-set renders its files grouped by folder — verb
   (✚ new / ✎ edited / ✂ deleted — `SNAP_ICON` changed from ±/+/−) · name ·
   edit-count chip · ±lines · per-file ⟲; header carries the change-set ±totals.
   The tab badge counts FILE changes (`Δ 34`), not change-sets. The old
   inline-expanding "diff" button is gone — clicking the row drills in.
2b. **External pins are tracked too** (v2.4.1): edits to files OUTSIDE the
   project root were invisible to all three surfaces — `createTracker` resolved
   paths via containment only. Now `createTracker(project, taskId, files)` takes
   the task's pin list and `resolveTarget` also accepts paths granted by an
   external pin (`isPathGranted`, the same allowlist as the session's
   `additionalDirectories`), keyed by their ABSOLUTE path (the app-wide
   "absolute rel = external" convention) with `external: true` on the file
   record. Ungranted outside paths stay untracked. The Δ list/diff render them
   with the ↗ amber treatment, group headers and labels relativized to the pin's
   folder name; rewind refuses if the pin has since been removed (re-checked at
   revert time against the task's CURRENT pins). `broadcastFileChanged` also
   announces granted external edits (`rel` = abs path), so open ↗ viewer tabs
   live-reload mid-turn like in-root editors do.
3. **Inline unified diff** (`perOf(key).snapView`, validated per task): the full
   file with line numbers — removed lines struck red at their old numbers, added
   lines washed green at their new ones, untouched code in place; unchanged runs
   ≥4 hidden lines fold into a clickable "⋯ N–M unchanged" row that expands IN
   PLACE (scroll kept — no renderWB); header = ← back · file · chip · ± ·
   ⟲ rewind file; footer = an `edit k/M ◀ ▶` stepper over the hunks (first press
   lands on edit 1, wraps, flashes the landed-on hunk). Blobs fetched once per
   entry+file into `snapFileCache`. `diffHtml` (the compact old renderer) remains
   for permission-card previews only.

### Task schema additions
`model` (per-task model, always explicit — new tasks default to `DEFAULT_MODEL`
('claude-opus-5', exported by taskStore.js); legacy tasks with null are coerced to it at
launch, never to the SDK's own default), `permMode` (null | 'default' | 'acceptEdits' | 'auto' |
'bypassPermissions' — prompting override; ignored for oversight 'propose', which always runs
plan mode), `archived`.

### Semantics changed from v1
- Handoff = completion **record**, written on request only: sessions cannot propose ending a
  task (the footer's "when COMPLETE, emit ```handoff" instruction, the waiting-state accept
  banner, and `#acceptDoneBtn` were removed 2026-08-04) — the user closes a task via
  ✓ complete (wrap-up turn writes the handoff, then PATCH status 'done' + archived; PATCH
  status 'done' is refused 409 while a turn is active). A successful turn without a handoff
  still clears a stale one. Non-done upstream handoffs are injected flagged "PROPOSED, not
  yet accepted".
- Oversight → permissionMode: auto → 'auto' (classifier), coop → 'auto', propose → 'plan'
  (locked). 'bypassPermissions' is passed with `allowDangerouslySkipPermissions: true`.

## Voice layer (v2.7 — Agent FRONTEND, frontend-only)
Browser-native speech in/out for task sessions. **Zero server surface**: no new
routes, no vendors, no keys, nothing in the ledger — the voice→message arrow is
`SpeechRecognition → transcript → POST /message`, and speech-out reads the same
`session:stream`/`tailBufs` text the ≋ console renders. All in `public/app.js`
(voice module after `sendMsg`) + `public/m/m.js` (phone mic) + CSS at the end of
both stylesheets.

- **Speech in**: `#micBtn` in the composer (renders only when the browser has
  SpeechRecognition — a peer of ⏹ stop/Send). Hold mic (or hold Space outside
  inputs) = push-to-talk; quick tap locks hands-free; Esc discards. Transcript
  streams into the REAL `#composerInput` (drafts/autosize via a synthetic
  `input` event with `voiceSt.setting` guarding the cancel listener).
- **Auto-send beat**: on release, `#sendBtn` becomes an amber `Send · N`
  countdown (`voicePrefs().autoSend`, default 3s; 0 = immediate). Any edit,
  focus, Esc, ⏎ or manual Send cancels/absorbs it. Fires by clicking the real
  Send button — one send path.
- **Speech out**: per-task `voicetog` chip in the sessbar (`data-voicetoggle`,
  purple, a peer of `webtog`; persisted in `localStorage.voiceTasks`, default
  from prefs). On running→stopped (`voiceOnStatus`, called at the END of the
  `session:status` case so the highlight lands on the settled DOM), the turn's
  speakable prose = `parseConsole(tailBufs[k])` segments of type `ans`/`ques`
  after the last `you` — tool/think/meta NEVER speak. `voiceStrip` turns
  code/tables/math into short spoken asides. Sentences queue through
  `speechSynthesis`; `.speakPill` (sticky, in `#consoleBox`) shows position +
  pause/stop; `.speakNow` karaoke-wraps the current sentence's text nodes
  (best-effort, one 600ms retry for reveal-pump lag). 'narrate' mode
  (`voiceOnStream`, 600ms throttle) speaks sentences as they complete
  mid-turn, holding back the unfinished tail. Barge-in (mic/Space while
  speaking) cancels playback only — NEVER the turn.
- **Settings › Voice** (`voiceSecHtml`/`voiceSecWire` in renderSettings):
  replies default, device voice picker (async `voiceschanged` refresh), rate,
  final/narrate, auto-send pause, barge-in — all in `localStorage.voicePrefs`.
  The Updates section now carries `id="updSec"` (tests anchor to it).
- **Phone** (`/m/`): hold-to-talk `#aMic` in the task-sheet composer — sends on
  release (hands-free semantics), no countdown. Input only for now; the
  full-screen orb surface + phone speech-out are follow-ups.
- **Secure-context rule**: the mic exists only on HTTPS or localhost. Remote =
  the tailscale serve URL (deploy/REMOTE.md); the not-allowed error path toasts
  exactly that.
- Tests: `test/ui.voice.test.mjs` (mic/chip render, per-task persistence,
  pill + karaoke on turn end, settings persistence). Headless Chrome has both
  speech APIs; audio itself is never asserted.

### Decisions ledger + packet honesty (2026-08-07 — the learning-loop release, slice 1)

Born from the transcript audit in `docs/private/memory-daemon-options.html`
(gitignored): corrections were being captured but never ROUTED — a handoff
reaches only explicit downstream lineage, so a term ban taught in one task was
violated by its siblings the same day; the coop drafts-not-edits protocol was
re-taught by hand ≥6 times in two months; all abstracts sat untouched while
packets presented them as current.

New module `lib/decisions.js` — per-project decisions ledger + standing note at
`ROOT/decisions/<project>.json` (gitignored; recreated on first write):
`{standing, entries: [{id, text, scope: 'prose'|'code'|'math'|'all', source,
created, status: 'active'|'retired'}]}`. Entries are RETIRED, never deleted
(audit trail). Cap 100 active; the injected block is budgeted at ~2400 chars —
over budget the OLDEST rules drop first and the omission is stated in the block
itself. Atomic writes; a corrupt file reads as empty; nothing here can fail a
billed turn (`projectAppendix` swallows everything).

Injection: `oversightAppendix(task)` now appends `projectAppendix(task.project)`
— the one choke point BOTH providers pass through EVERY turn (Claude
`systemPrompt.append`, Codex `developerInstructions`), so an accepted rule
reaches ongoing sessions and every sibling immediately. The future memory
distiller only ever PROPOSES entries; `addDecision` is called on user approval
alone (✓ complete wrap-up cards, drop 2).

Coop appendix: `OVERSIGHT_APPENDIX.coop` now carries the FULL drafts-not-edits
protocol on every turn (the old lean turn-2+ one-liner is gone — every
documented violation happened mid-task, exactly where the lean text ruled).
The turn-1 align-first appendix is unchanged.

Living abstract: packet section 2 uses `getAbstractInfo(project)` (new, in
taskStore — text + mtime) and appends a staleness note via
`staleAbstractNote(mtimeMs, now)` when the abstract is ≥21 days untouched.

Snapshots: journal cap 200 → 500, and pruned entries are HARVESTED to
`snapshots/<project>/archive.jsonl` (blob text inlined, 50MB cap, append-only)
before their blobs are deleted — the proposed-vs-kept deltas are the future
style distiller's raw signal and no longer evaporate.

Routes (all unbilled; mutations broadcast `decisions:update {project,
decisions}`; snapshot gains `decisions` = `{key → {standing, entries}}`):
```
GET    /api/decisions/:project           → {standing, entries}
POST   /api/decisions/:project           {text, scope?, source?}  → entry (201)
PATCH  /api/decisions/:project           {standing}               → {standing}
DELETE /api/decisions/:project/:id       retire (never hard-delete) → entry
```
Regression: `test/decisions.test.mjs` (store, formatters incl. budget
trimming, real-source `oversightAppendix`/`buildContextPacket` extraction,
API round-trip).

### Session-bar simplification (2026-08-07, same day, per Graham)

Web search and voice replies are **always on**; their per-task toggles are
gone. The sessbar now shows only: model picker · reasoning · 🛡 permission
override · warm-REPL chip · token/turn count. The `oversight <LABEL>` and
`category <name>` spans under the composer are removed (oversight keeps its
tab chip; categories live on in packets and the category manager).

- Server: `WebSearch`/`WebFetch` are never disallowed — stored
  `context.web_search.enabled` is ignored for gating (the field persists for
  schema compat; the Add Task modal writes `enabled: true`). The packet's web
  section renders only a sources preference; the Codex disable note is gone.
- Frontend: `setTaskWebSearch`, both `data-webtoggle` chips, the
  `data-voicetoggle` chip, `voiceTaskMap`/`setTaskVoice`, and Settings'
  voice-replies default are removed; `taskVoiceOn()` returns true (TTS
  availability still gates actual speech). Sources remain editable in the Add
  Task modal (always-visible input) and display on the launch card.
- Regression: `ui.voice.test.mjs` reworked — asserts the toggles are ABSENT,
  speech fires with zero setup, and the sessbar carries no oversight/category
  labels.

### Focus mode (2026-08-07, per Graham — VSCode-style)

The statusbar's leftmost control (`.focusTog`, bottom-left corner) toggles
FOCUS MODE: the workbench sidebar disappears and the right column unstacks —
**editor | viewer | console** side by side, three clean panes. Implementation
is deliberately CSS-only on the kept skeleton (`.wb.focus` re-grids the
columns; `.viewerTop`/`.sessHalf` override their `--vsplit` geometry to
left/right halves; `.hdivider` hides): mounted PDF panes, artifact iframes,
and the editor's two-layer geometry all survive the toggle untouched. The
button shows the TARGET layout (two-pane glyph → enter, three-pane glyph
with the narrow sidebar → exit). Per-browser view state:
`localStorage.focusMode`, like theme/dividers — never on the task record.
The vdivider still drags the editor/right-pair split in both modes; the
viewer/console split is fixed 50/50 in focus (v1 — no third divider).
Regression: `test/ui.focus.test.mjs`.

### Focus mode v2 (2026-08-07, same evening — Graham's three refinements)

1. **The viewer/console barrier drags.** New `.fdivider` in the rpb skeleton —
   full-height peer of the vdivider (top:0/bottom:0 of the pane body), visible
   only in focus, col-resize on `--fsplit` (clamped 25–75%), persisted as
   `wbFSplit` like the other dividers.
2. **The console lives in the session pane.** In focus mode `sessionBody`
   hosts `#consoleBox` (same id/data-key contract) above the composer — watch
   the stream and talk in one pane. The center strip DROPS its ≋ tab (ids
   stay unique); a persisted 'tail' selection falls back to the first file,
   or a pointer note when the task has none. The transcript seed logic is
   extracted to `seedTailBuf(key, task)` (shared by both hosts), and every
   painter (pump, wireWB initial paint, karaoke, keep/transplant) already
   targets `#consoleBox` by id/data-key, so the mechanism is host-agnostic
   by construction. The "follow along in the ≋ console tab" and pending-
   approval pointer hints are suppressed in focus (the console is right
   there). Manual/queued tasks keep their cards — no session, no console.
3. Layout: `.viewerTop`/`.sessHalf` split on `--fsplit` (default 50%).
Regression: `ui.focus.test.mjs` grown to 5 tests (console hosting + live
stream paint, full-height barrier drag + persistence).

### iPad/iPhone install surfaces (2026-08-10)

The dashboard is installable on all three screens with ONE brand mark
(generated from `desktop/icon.svg` — the same identity as the Mac shell):
- **iPhone** — the existing `/m/` PWA, unchanged (its manifest `name` is the
  desktop shell's IDENTITY PROBE — coupling #2 — and must never drift; the
  icons were refreshed to the shared mark, same filenames).
- **iPad + desktop-browser installs** — NEW root `manifest.webmanifest`
  (scope `/`, standalone) + `public/icons/icon-{180,192,512}.png` +
  apple-touch-icon/web-app metas in `index.html`. The existing phone redirect
  (`min(screen dimension) < 700` + mobile UA → `/m/`) already routes iPads to
  the full dashboard — no routing change.
- Reachability is Tailscale per `deploy/REMOTE.md` (`tailscale serve --bg
  4242`); the server never binds beyond 127.0.0.1.

### Desktop ownership + Tailnet control (2026-08-18)

The server's bind is the startup transaction boundary: `server.listen(PORT,
'127.0.0.1')` must succeed before auth/Codex checks, artifact watchers,
calendar/update loops, Kaimon and stranded-task sweeps, or configured TeX
watches run. A bind error sets a nonzero process exit and may mutate no durable
state. Regression: `test/startup.bind.test.mjs`.

`lib/tailnet.js` owns the private-access status machine and only the root HTTPS
Serve handler that proxies this process's `127.0.0.1:<PORT>`. Snapshot key:
`tailnet`; WS event: `tailnet:status`; routes: GET `/api/tailnet/status`, POST
`/api/tailnet/enable`, POST `/api/tailnet/disable`. Mutations require a loopback
Host, refuse requests carrying Tailscale identity headers, and reject a
non-local browser `Origin` (localhost cannot be used as a cross-site control
endpoint). The controller:

- distinguishes configured Serve intent from Tailscale connectivity (`live`
  requires both);
- reconnects a deliberately stopped Tailscale client with no-flag `tailscale
  up` (saved preferences are preserved) when local enable is requested;
- never calls Funnel or `serve reset`;
- refuses a foreign root handler and refuses to disable a shared endpoint;
- discovers the macOS bundled CLI with `TAILSCALE_BE_CLI=1` as well as normal
  CLI integration paths; and
- is pinned off in the server test harness via `CP_TAILSCALE_BIN=''` so tests
  never read or alter the developer's real Serve configuration.

The root path is deliberate: the SPA, APIs, PWA, artifacts, and WebSocket use
root-relative URLs. A subpath mapping is unsupported without a separate
base-path migration.
Regression: `test/api.pwa.test.mjs` (manifests, icon paths, head identity,
and the probe-coupling guard).

## Phase 2 — frontend decomposed into native ES modules (2026-08-10)

`public/app.js` (~10,400 lines, one file) is now **15 native ES modules served
as-is** — NO bundler, a deliberate plan revision: the no-build-step runtime,
the self-updater, `npm start`, and the test harness are all untouched, and
`index.html` did not change (`<script type="module" src="app.js">` stays the
sole entry). Every slice was a **verbatim code move**: moved code is
byte-identical to the pre-split file except (a) an added `export` keyword on
moved top-level declarations, (b) added `import` statements, (c) deletions at
the source site. No renames, no refactors, no reformatting. The pre-split tree
is tagged `pre-phase2`; `public/m/`, `hl.js`, `pdfPane.js`, and `texEditor.js`
(the three already-separate modules) are byte-identical to that tag.

### The 15-module map

**`app.js`** — the ENTRY, now a thin boot module. Retains exactly: the WS
event dispatch (`handleEvent`), state adoption (`applyState`/`loadState`),
view routing (`go`/`renderAll`/`renderNav`/`ensureViews`), the delegated
new-tab `<a>` click listener, the scrollbar-thumb `scrollFade` capture
listener, the `beforeunload` dirty-draft guard, `IDLE_LIMIT_MS` +
`lastActivity` activity listeners, `startHeartbeat`, `wireGlobal`, `afNum`,
and the init IIFE — which MUST stay the TAIL of the file: ESM evaluates the
full import graph before the entry's own top-level code, so
`wireGlobal`/`loadState`/`connectWS`/`startHeartbeat` see every module
initialized. Exports: `handleEvent, loadState, renderAll, go, renderNav,
afNum`. `applyState` and `ensureViews` stay private.

**`util.js`** — pure helpers: formatters (`esc, enc, hrs, fmtTok, fmtAgo,
fmtWhen`, job/duration/mem), diff/merge algorithms (`merge3, lineDiff,
diffLines, diffHtml, unifiedDiffHtml`), `toast`/`confirmBox`, file-kind
predicates + pin icons, `TEX_SYMS`/`texComplete`. No app-state reads. Owns
`toastTimer` (private) and the `window.__merge3` test hook.

**`net.js`** — `api`/`apiQuiet` HTTP wrappers + the WebSocket lifecycle:
`connectWS`, reconnect, the half-open staleness sweep (`wsCloseIfStale`, also
`window.__wsCloseIfStale`). Owns `wsFirst/wsCur/wsLastMsg` (private lets). Its
staleness `setInterval` runs at module eval — safe because `wsCloseIfStale`
null-checks the socket and `connectWS` only runs from the init IIFE.

**`store.js`** — THE state home: the `state` object, `ui` view-state
(`ui.view`, `ui.per`, `ui.manageOpen`), and every cross-module cache —
`tailBufs, agentsLive, editsLive, jobsLive, jobTimers, jobEntered, fileCache,
drafts, draftBase, diskStale, transcripts, edViews, runBufs, runSegs, runOff,
snapFileCache, snapsCache, feedCache, feedTimers, pendingPerms,
composerDrafts, queuedMsgs, turnTexTouched, pendingComplete, consoleView,
htmlEdits, pdfPanes` (+ `window.__pdfPanes`), `hlStores` — plus state-derived
lookups (`projKeys, tasksOf, findTask, perOf, curTask, artifactUrl, fileUrl,
pdfSrc`, …), provider/model helpers and the model constants
(`DEFAULT_MODEL, CLAUDE_MODELS, MODELS, REASONING_EFFORTS` — `MODELS =
CLAUDE_MODELS` dereferences at eval time, so the four consts live together in
source order), theming (`themePref/applyTheme/setTheme` + the `sysLight`
listener), and per-task localStorage tab state behind functions only
(`getClosed/persistClosed/taskTabsOf/taskTabRemember/taskTabRecall`,
`extrasOf/persistExtras`).

**`files.js`** — the file/transcript/pin/snapshot/feed data layer: fetch+cache
(`ensureFile/refreshFile/fetchFileInto`), the 3-way auto-merge orchestration
(`sessionFileChanged/autoMergeDisk`), `saveFile`, dir browser + pin picker,
WYSIWYG html edit (`startHtmlEdit/saveHtmlEdit/endHtmlEdit`), editor chrome
patching (`editorChrome/saveChipState`), `ensureFeed/refreshFeed`,
`ensureSnaps/ensureSnapFile`, `liveEditsOf`. Owns `fileLists, dirCache,
mergeRuns, mergeToastAt` (module-private).

**`console.js`** — the console rendering pipeline: `md` (the two lazily-built
marked engines) + `katexEl`, the tex-macro harvest (`texMacrosVisible`,
`texMacroRev`, `window.__parseTexMacros`), the fence enhancer, the segment
parser (`parseConsole`), `updateConsole` + the reveal pump
(`pumps/pumpConsole/shownLen`), permission cards, transcript seeding
(`seedTailBuf`), the `claudeVerb` rotator. Owns `fenceView, texMacroCache,
mdEngines` (private).

**`jobs.js`** — live job cards: the build-once/patch-in-place renderer
(`syncJobCards/syncRunJobCard/fadeJobCard`), tick/reconcile/fade-out, the 1s
clock interval (module eval).

**`texrun.js`** — ▶ runs + LaTeX machinery: the problems strip
(`texProblemsFor/renderTexProblems`), the Claude-fix suggestions lifecycle
(`startTexFix/resolveSug/markSugStale` + the `sugStaleAt/sugPulsed/sugRedraw/
texfixRetire` exported const objects), synctex (`synctexEditOpen/
texForwardSearch`), the auto-recompile queue (`noteTurnTex/queueAutoTexRuns/
pumpAutoRun`, private `autoRunQ`), `runFile/stopRunReq`, run/build cards
(`runPaneHtml/updateTexRunCard`), pane-status sync (`syncTexRunPane/
syncTexRunControls`).

**`viewers.js`** — the show panel: viewer tab persistence
(`getClosedViewers/getAddedViewers/selectViewer/addDisplay`), pdf pane
mount/reuse (`mountPdfPane/artPaneKey/mountArtPanes`), artifact frames + the
kept stack (`viewerHtml/syncViewerStack`), the md pane renderer
(`mdPreviewSchedule`, private `mdPreviewTimers`), the proposal preview tab
(`proposalPreview` exported const object, `showProposalInPanel/
closeProposal`).

**`session.js`** — the session pane: launch/manual/handoff/auth/kaimon cards,
`sessionBody` + the composer html, the themed dropdown portal
(`openDropdown/closeDrops/placeSideMenu`, private `_openDrop`), model/perm/
effort selectors + task PATCH setters (`setTaskEngine/setTaskModel/
setTaskReasoning/setTaskPerm`), `sendMsg`.

**`sidebar.js`** — workbench sidebar sections: the lineage chain
(`sideChainHtml`), ◷ Recent activity rows/groups (`feedItemsFor/
feedSectionHtml` + the `afDelta/afFileRow/…` row builders and `FEED_*`
constants), ◆ next up + deadlines + gcal links (`nextUpSectionHtml/wireNextUp`
+ `nu*` helpers).

**`workbench.js`** — the workbench hub: `workSurface` + Δ views, `renderWB`
(skeleton, tab normalization, keep-alive carries), dividers + drag wiring, the
giant `wireWB` (editor overlay/caret/selection/pointer, suggestion
decorations, composer), `syncStatusbar` + the usage meter,
`updateLedgerInline`, focus mode (`focusOn`), and the `pendingEdJump` nav —
`texOpenAt`/`applyEdJump` are CO-LOCATED here by the ESM assignment rule
(below). Owns `texRunTickers` (private). Also home of the quota 1s tick.

**`voice.js`** — the browser-native voice layer: STT push-to-talk/lock/
countdown, the TTS queue + karaoke highlight (`voiceOnStream/voiceOnStatus`),
mic UI sync (`voiceSyncUi/wireVoice`), the Settings section
(`voiceSecHtml/voiceSecWire`), the global Space/Esc gesture block (guarded by
`SR_CTOR || TTS` at module eval). Owns `voiceSt` (const object, voice-only).

**`views.js`** — full-page views + panels: overview bento (`renderOverview`),
⧉ Calendar (`renderPlan`), category helpers/groups (`catGroup/catGroups/
groupColor`), Settings (`renderSettings`), About (`renderAbout/
ensureAboutData` + the `aboutCache` exported const object), Manage projects
(`renderManage`), Categories browser + editor (`renderCats/renderCatMan`),
the git panel (`openGitPanel/closeGitPanel`). Owns `commitsShown, catman,
planSkip, gitState` (private).

**`modal.js`** — the Add-task modal: `form`/`stashedForm` state (lets,
assigned only here), open/close/stash semantics, `renderModal`, the JSON
preview, saveTask. Exports `form, openModal, closeModal, renderModal`.

### Shared-state doctrine

Mutable state shared across modules lives in **`store.js`** as exported
`const` objects (or behind exported functions — the localStorage caches).
The binding itself is NEVER reassigned; writers replace/mutate **properties**
(`applyState` replaces `state`'s properties wholesale; handleEvent/files/
texrun/session/workbench mutate optimistically). Property writes on an
imported `const` object are legal ESM and are the sanctioned cross-module
mutation idiom — also used outside the store where a single module owns the
object: `sugRedraw[key] = …`/`delete sugStaleAt[id]` (texrun's objects,
written by workbench's `wireWB`), `aboutCache.activity = null` (views' object,
written by app.js's `ledger:update` case), `form.category = cat` (modal's
binding, property-written by the init IIFE).

**Two sanctioned live bindings** — reassigned `let`s imported read-only
(importing a reassigned `let` is a legal LIVE binding for consumers that never
assign it; do NOT wrap these in accessor functions):
- `texMacroRev` (console.js): SOLE writer is console's tex-macro harvest;
  read raw by `viewers.syncMdPane` (`pane._mac === texMacroRev`) and console's
  own `updateConsole`.
- `form` (modal.js): all assignments stay in modal.js; app.js's init IIFE
  reads the live binding (`if (form && …)`) and property-writes
  `form.category`.

**The co-location rule**: ESM forbids ASSIGNING an imported binding, so every
writer of a module-level reassigned `let` must live in that let's module.
This is what pins `texOpenAt` and `applyEdJump` (plus two `wireWB` closures —
the writers of `pendingEdJump`) into workbench.js; other modules only CALL
`texOpenAt` via import.

### Init order & reachability

The init IIFE is the tail of app.js, after all imports — ESM evaluates the
full static import graph first, so every module's top-level side effects
(test hooks, intervals, listeners) have run before boot. **Every module MUST
be reachable from app.js's static import graph** or those side effects never
run: app.js imports 13 of the 14 directly; `sidebar.js` is reachable via
workbench.js and views.js; `hl.js`/`pdfPane.js`/`texEditor.js` via
workbench/texrun/viewers. Verified at runtime (2026-08-10, uiHarness page
load): `window.__merge3`, `__parseTexMacros`, `__wsCloseIfStale`, and
`__pdfPanes` are all set on boot. Cycles (net↔app, files↔workbench,
jobs↔console, texrun↔workbench, store↔views, voice↔views, session↔voice) are
all call-time-only and safe: moved functions are hoisted declarations, and no
top-level `const`/`let` in any module reads another app module's export at
evaluation time (no TDZ hazard).

### Test pins (source-level assertions that lock code to a file)

- `ui.agents-fleet.test.mjs` reads `public/app.js` and asserts the
  `for (const k of Object.keys(agentsLive)) delete agentsLive[k]` loop and its
  `editsLive` twin (applyState's replace-never-merge seed) plus the NEGATIVE
  guard `!/sess\.agents|sess\.edits/` — pinning `applyState` in app.js.
- `ui.feed.test.mjs` extracts `function afNum(` from `public/app.js` via
  `extractFunction` — pinning `afNum` there (sidebar imports it from
  `./app.js`).

### Audit findings (flagged 2026-08-10 — the boot-audit slice)

1. **Fossil-guard coverage gap**: ui.agents-fleet's negative guard
   (`/sess\.agents|sess\.edits/`) scans ONLY `public/app.js`. Pre-split it
   covered the whole frontend; now the 14 sibling modules are outside it — a
   snapshot-roster fallback reintroduced in console.js or workbench.js would
   not fail the test. All 14 audited clean today; the tests themselves are
   deliberately untouched by Phase 2. Known coverage gap.
2. **Static syntax net misses the new modules**: `static.test.mjs`'s fixed
   file list (`lib/*.js`, `server.js`, `public/app.js`, `public/hl.js`,
   `public/m/m.js`) does not `node --check` the 14 new public modules — a
   parse error in one surfaces as mass UI-test failure instead of a named
   static failure. All 14 pass `node --check` as of this audit. Recorded for
   the CI slice's job summary.

### Typing gate (typing slice, 2026-08-10)

`npm run typecheck` = `tsc --noEmit -p tsconfig.json`, devDep
`typescript@7.0.2` (exact-pinned). Types only — zero runtime code generated
or changed. `app/tsconfig.json`: `allowJs` + `checkJs`, `noEmit`, target
`ES2022`, module `ESNext`, moduleResolution `bundler`, `skipLibCheck`;
`strict` is OFF this phase with three strict-family flags ON —
`noImplicitThis`, `strictBindCallApply`, `noFallthroughCasesInSwitch`.
Includes `public/*.js` + `types/*.d.ts`; excludes `public/m`, `pdfPane.js`,
`texEditor.js` (untouchable modules stay outside the gate; `hl.js` is inside
and passes).

Ambient declarations (global scope, referenced from JSDoc by bare name — no
type imports in the .js files):
- **`types/contract.d.ts`** — the shapes frozen in this document: the
  `/api/state` snapshot, the Task record, the WS-event discriminated union
  (keyed on the type `handleEvent` switches on), and the store.js shapes.
- **`types/globals.d.ts`** — CDN deferred-script globals (marked, DOMPurify,
  KaTeX auto-render — all undefined-able), test hooks / window app-globals
  (the uiHarness contract), and deliberate lenient DOM shims (members this
  codebase uses on `Element`/`EventTarget`/`Event` declared there instead of
  ~150 call-site casts, which would have edited executable text).

`@ts-ignore` count at the gate's introduction: **2**, both in `util.js`.
Adding more requires a comment on the line above explaining why.

### CI (ci slice, 2026-08-10)

`.github/workflows/ci.yml` — one job on `macos-latest` (Node 22, npm cache
keyed on both lockfiles), for pushes to main + PRs, with cancel-in-progress
concurrency: app `npm test` → `npm run typecheck` → desktop `npm ci && npm
test`. Billing safety is structural: `CP_NO_BILLED=1` at the job level
(belt-and-braces over the server-side sandbox guard) and NO secrets of any
kind configured. Chrome comes from the **`CP_CHROME` seam** in
`app/test/uiHarness.mjs`: the harness exports the resolved `CHROME` path
(`CP_CHROME` env override, else the standard /Applications install); UI
suites' skip guards import it, so a missing browser skips the UI suites
gracefully instead of hanging the job.

### Final audit (2026-08-10 — this section is the audit slice's record)

All three gates green on the audited tree: app suite **728/728**, `tsc
--noEmit` clean, desktop suite **57/57**. `public/m/`, `hl.js`, `pdfPane.js`,
`texEditor.js`, `lib/`, and `server.js` verified byte-identical to the
`pre-phase2` tag; `index.html` unchanged.

Line inventory (`wc -l`, entry + 14 new modules; pre-split `app.js` was
10,317):

| module | lines | | module | lines |
|---|---|---|---|---|
| workbench.js | 2979 | | voice.js | 609 |
| views.js | 1522 | | viewers.js | 541 |
| console.js | 923 | | sidebar.js | 513 |
| **app.js (entry)** | **924** | | util.js | 504 |
| files.js | 776 | | store.js | 464 |
| texrun.js | 707 | | modal.js | 354 |
| session.js | 622 | | jobs.js | 211 |
| net.js | 97 | | | |

No duplicate top-level definitions across the 15 modules. (The module-local
`esc` helpers inside `hl.js` and `texEditor.js` predate Phase 2 and are
module-scoped — not conflicts with util.js's exported `esc`.)

**56 dead exports** — exported during the verbatim move but never imported by
a sibling. Kept deliberately (deleting the `export` keyword is a code edit
outside the audit's mandate); nearly all are over-exports whose call sites
stayed in-module, plus two pre-existing dead functions in texEditor.js
(`toggleComment`, `texOutline` — already unreferenced at `pre-phase2`).
files.js: `autoMergeDisk, ensureFileList, fetchFileInto, refreshFile` ·
net.js: `wsCloseIfStale` · session.js: `PERM_MODES, authCardHtml,
codexAuthCardHtml, dropHtml, dropPortal, handoffCard, kaimonCardHtml,
launchCard, manualCard, modelSelHtml, permSelHtml, providerModelSelHtml,
reasoningSelHtml, setTaskModel` · sidebar.js: `FEED_GROUP_AT, FEED_KIDS,
FEED_RUN_MARK, FEED_SHOW, FEED_VERB, NU_DAY, NU_LINGER_MS, afDelta,
afDoneRow, afEditHtml, afFileRow, afRunRow, afRunsHtml, afTaskLabel,
feedItemsFor, nuDayStart, nuDaysUntil, nuWhen, planItemsFor` · store.js:
`CLAUDE_MODELS, MODELS, OPEN_EXTRA_CAP, applyTheme, closedCache, sysLight,
taskTabCache, taskTabsOf` · texrun.js: `texfixRetire` · util.js:
`DATA_EXTS_C, FOLD_MIN_HIDDEN, TEX_SYMS, diffLines, lineDiff` · voice.js:
`taskVoiceOn, voiceSyncUi`.

For the Monaco phase: the editor surface (overlay/caret/selection/pointer +
suggestion decorations) lives in `workbench.js`'s `wireWB`; `texEditor.js`
and `pdfPane.js` remain untouched pre-phase2 modules and are OUTSIDE the
typing gate's include set; the DOM-leniency shims in `types/globals.d.ts`
are scoped to current usage and will need revisiting when editor DOM code is
replaced rather than moved. (That phase has since started — see **Phase 3**
below, which is the binding Monaco contract.)

## Phase 3 — Monaco editor (transcribed at S1, 2026-08-14 — SOLE normative source)

This section transcribes the Phase 3 blueprint's normative content per its own
closing rule: from S1 on, **CONTRACT.md is the sole binding document** for the
Monaco editor — the gitignored design family (`docs/private/monaco-blueprint.html`
§14-amended, `monaco-s05.html` machines/spikes, `monaco-s1.html` build record,
`monaco-seams.md` P1–P22 remap) is rationale and history only and yields wherever
it disagrees. It reflects the IMPLEMENTED state: the blueprint as amended by its
§14 audit dispositions, plus the two amendments **ratified by Graham 2026-08-14**
(M6 drafts-refreshed; M7 T7/T8 bookkeeper move — both below). Dependency added:
`monaco-editor` **0.56.0** (exact pin), served offline-safe at `/vendor/monaco`
from node_modules (the pdfjs pattern). S1 is functionally complete; S2 wires the
providers (completions, markers/tints, texfix, SyncTeX `revealAt`/⌘J, outline,
auto-`\end`/julia-Tab) behind the same seams.

### Toggle & device gate
`localStorage['editor:impl']`: `'legacy'` (default) | `'monaco'`, per-browser like
`theme`. `setImpl(next)` (monacoPane) is the **sanctioned writer**: flipping to
legacy runs the synchronous M7-T7 flush BEFORE the preference changes hands.
Coarse pointers are pinned legacy permanently and automatically — the predicate
is `(pointer: coarse) and (not (any-pointer: fine))` with a maxTouchPoints
fallback; **hybrid (fine+touch) devices get Monaco** (`pinnedCoarse`). A boot
fallback forces legacy for the session only (`forcedLegacy` — the preference is
NEVER persisted off; `rebootMonaco()` is the "try again" affordance).

### Module boundary & frozen seams
`public/monacoPane.js` is the ONLY module touching `monaco.*`. The pure LaTeX
brain lives in `public/latex/` (`texCore/texLang/texZones/texProviders/
texfixAnchors` — scoped extraction, imported by BOTH editor paths; one authority).
Consumers use seams, never `window.monaco`. Implemented seams:
`effectiveImpl/storedImpl/pinnedCoarse/setImpl` · `ensureMonaco/rebootMonaco/
onFallback` · `attachDock(root,key)/syncDock/parkHost` · `setFile(fkey, text,
{mtimeMs, ext, readOnly})` · `applyExternal(fkey, payload, reason)` ·
`beginSave(fkey)`/`commitSave(fkey, token, responseMtime)` ·
`requestSave/runAfterSave` · `saveViewStateFor` · `noteViewClose` (view close) ·
`disposeModel` (explicit discard; never disposes dirty) · `isDirty/text/
onDirtyChange` · `layout/focusEditor` · `holdEditor`. Reserved for S2:
`revealAt`, `getPosition`, `setProblems`, `texfix {arm, revalidate, resolve}`.
Test seam: `window.__mp` (+ `window.__monacoReady`, `__mpEditContext`); at least
one test must drive genuine CDP keystrokes past it.

### Boot state machine (A6)
`IDLE→LOADER→CORE→INIT→CSS_VERIFY→READY`, else `FAILED→FALLBACK_LEGACY`. The
promise is created synchronously, single-flight, and ALWAYS settles (resolves
`{ok:false,…}` — never rejects). Proven detectors per stage: loader
`script.onerror`; loader-corrupt = onload + `typeof require.config !==
'function'` (onerror never fires); core = AMD errback logging
`moduleId/neededBy/phase` (never `err.message`); INIT wrapped in try/catch
(an uncaught throw is unhandledrejection + eternal pend); CSS_VERIFY polls
`link.sheet` ≤2s with one reinject. One 10s deadline spans LOADER→CSS_VERIFY —
the SOLE detector for hangs; **never gate any boot step (or test wait) on
window `load`**. One auto-retry, net-class loader/core failures only. Fallback
is atomic: partial boot cleaned up, legacy rendered, **drafts preserved**,
stage+detail logged (A16 soak log). Post-READY degradation NEVER falls back:
worker failure → `workerDegraded` (Monaco's own main-thread recovery); a lazy
language chunk 404 → `langDegraded(id)`, plaintext tokens (rejection `reason`
is a raw DOM Event — guard `instanceof Event`).

**AMD globals are load-bearing (old I8 INVERTED).** The delete-define step and
the eager seven-language preload are DEAD (A5 — the basic-language
implementations are content-hashed private modules; every not-yet-opened
language arrives as a late `define(...)`). `window.define`/`window.require`
are retained for the page lifetime; delete-define is a demoted optional
post-S2 spike. Never hard-code content hashes (tests use hash-prefix regexes).

### EditContext pin + the mic guard (I3/P18/P19)
The editor is created with **`editContext:false`** (pinned 2026-08-11) — the
input surface is a real `<textarea>`, so existing tag-based guards stay
meaningful. Triple guard, all landed: (a) the pin (asserted on the create
options; `__mpEditContext` test override; the I2-IME CDP case runs under BOTH
surfaces every suite run); (b) explicit `closest('.monaco-editor')` bails in
voice.js's Space-PTT keydown and app.js `wireGlobal`'s Tab handler; (c) real
CDP-keystroke tests, including the differential proof that leg (b) alone holds
under `editContext:true`. Space while typing in Monaco must never start the
mic; Tab inside Monaco indents (the prose `\symbol` handler never fires).

### Kept-connected host (A7 — the transplant idiom is DEAD)
The active editor host (`#codeEditor.mpHost`) lives **OUTSIDE every innerHTML
replacement boundary**: parked offscreen in `#mpPark` on `<body>`, docked into
a per-workbench persistent `.mdock` (built once, sibling of the refilled
slots — the statusbar/meter idiom) and positioned over the `#monacoSlot`
placeholder that `renderWB` emits. A host found inside a to-be-replaced
subtree is a bug, never a transplant (same-frame detach+refocus measurably
kills IME composition). Belt: destructive renders defer while `inComposition`
(from `editor.onDidCompositionStart/End` — DOM composition listeners are wrong
under EditContext). Datasets on the host update synchronously in `setFile`.

### Data plane (P1) — drafts stay authoritative
The `drafts` map remains the single source of truth for unsaved text; the
dirty bit is `model.getAlternativeVersionId() !== savedAltId` (O(1),
undo-aware — **byte comparison is banned in dirty decisions, P-EOL-4**). Dirty
→ `drafts[k] = serialize(model)` materialized on the same event; clean →
`delete drafts[k]` (overridden by M6 while `diskStale`). `savedAltId` is only
ever (a) the altId of text that was disk bytes with a finite mtime at capture
time, or (b) `DIRTY_SENTINEL` (no real altId can equal it; blocks saves via
the finite-baseline refusal). Its five transitions — creation, save-200
(token altId, never current), merge-dissolve, 409-recovery reload, clean
reload — each carry a falsely-amber/falsely-clean guard test.

**Reconciliation rule** (post-A1 form): a CLEAN model whose text ≠
`fileCache[k].text` on attach/reload → `setValue`, undo CLEARED (⌘Z must not
resurrect pre-conflict text as a dirty draft); a DIRTY model under a
`file:changed` goes through the M4 history rebase, never a plain replace.

### The seven machines (M1–M7) — implemented invariants
- **M1 creation**: one `ITextModel` per fkey (`cp:` URI registry); seeding runs
  in a `seedCreate` txn; a model created while `drafts[k]!=null` is **dirty at
  birth** (disk baseline + one dirty edit; unsaved text is never marked clean);
  no trustworthy fileCache → seed from draft with `DIRTY_SENTINEL`; >200k/
  binary/loading/error → no model (read-only `hlText` branch, P5 unchanged);
  listeners attach ONLY after EOL/baseline seeding.
- **M2 origin guard**: every internal write (`setValue/setEOL/
  pushEditOperations`) runs inside a per-fkey synchronous transaction —
  reasons are the closed set `{seedCreate, cleanReload, mergeRebase,
  recoveryReload, legacyHandoff, eolSetup}` (unknown throws). The suppressed
  listener mutates nothing; commit applies bookkeeping atomically, re-arms
  what the flush destroyed (wash, tints, markers; texfix at S2), and emits
  **exactly one** chrome/preview signal; `finally` clears the flag; a
  synchronicity canary fails loudly if a Monaco upgrade makes the event async.
  texfix apply is deliberately UNguarded — it flows as typing.
- **M3 save tokens (A3)**: `beginSave → {text, baseMtimeMs, altId, seq}` /
  `commitSave(fkey, token, responseMtime)`; per-fkey serialization, at most one
  PUT in flight, second ⌘S coalesces to ONE `pendingSave`; clean requires
  current altId AND value to match the token, else rebase with `savedAltId :=
  token.altId` (never the current altId) + draftBase := response mtime;
  stale-seq responses drop with a log line; 409/network failure never mutates
  drafts. The only save serialization is `serialize(m)` (P-EOL-1); bare
  `getValue()` is banned in the save path by a static test. S1 residual
  CLOSED at S2.1: `files.saveFile` routes monaco-impl saves of modeled fkeys
  through the tokens (caller swap, no protocol change; legacy and no-model
  paths byte-identical).
- **M4 merge = history rebase (A1)**: on a successful 3-way merge,
  `setValue(THEIRS)` with undo CLEARED (THEIRS becomes a real model state),
  `savedAltId := altId(THEIRS)`, then ONE undoable MERGED edit iff it differs.
  ⌘Z reaches current disk, **never pre-merge OURS** — so no undo+save sequence
  can overwrite the external change. Dissolve (`merged === THEIRS`) → clean.
  The bail path is byte-identical to legacy (model/drafts/savedAltId
  untouched; `diskStale` ⚠). OURS is re-read AFTER the fetch; `mergeRuns`
  serialization is preserved; background models get the rebase via
  `applyExternal` without waiting for a render; best-effort caret capture/
  clamped restore applies to the attached model only.
- **M5 409 recovery**: clipboard-verified-**before**-destruction (I6 — a
  failed/denied clipboard write destroys nothing); the payload is the model
  text AT ACCEPT TIME (post-⌘S keystrokes included); recovery is one
  `recoveryReload` txn — undo cleared, `savedAltId` from the fresh bytes
  inside the atomic commit; `pendingSave` is cleared (recovery never
  auto-fires a save); no 'saved' chip frame between destruction and reload;
  cancel is a total no-op.
- **M6 disk-stale undo (A9)**: the chip NEVER shows plain 'saved' while
  `diskStale.has(k)` — the alt-clean transition is suppressed and a reconcile
  fetch fires (single-flight per fkey; the model revision recorded at fetch
  start is the **altId**, so a type-then-undo shimmy still applies truthfully
  — A20 discipline); only fresh, verified disk bytes may become the baseline;
  fetch failure is non-destructive and retry re-arms. **Ratified amendment
  (2026-08-14)**: in the suppressed-clean state drafts are *retained but
  REFRESHED* — `drafts[k] := serialize(model)` on every suppressed-clean
  event while `draftBase` stays pinned on the OLD mtime (the 409 net stays
  armed); consequence: OURS === BASE, so a `file:changed` merges trivially
  through M4's dissolve — that is how the retry arm is delivered.
- **M7 lifecycle & handoff (A10/A4)**: close is a VIEW close
  (`noteViewClose` via `files.closeTab`) — it destroys neither drafts nor a
  dirty model's undo stack. **Dirty models are never disposed and never LRU
  candidates**; "LRU-50" is a soft cap on clean, DETACHED models only,
  oldest-first, through the total disposal matrix (model, viewState, markers,
  decorations, widgets, timers, listeners, save tokens, stale-flight
  identity — nothing left behind). `applyExternal` reasons are the closed set
  `{cleanReload, mergeRebase, recoveryReload, legacyHandoff}` and update
  background/orphan models directly. Monaco→legacy (`setImpl` or boot
  fallback) is a synchronous T7 flush; on re-entry a newer `drafts[k]`
  **always wins** (A4). **Ratified amendment (2026-08-14)**: the T7/T8
  `draftRev` bookkeeper lives monacoPane-side (legacy stays byte-untouched
  until S3) — `draftRev`/`modelSyncRev` count materializations monacoPane
  performs or observes, and a legacy write is detected TEXTUALLY at the T8
  boundary (text-divergence ⇔ an external materialization happened);
  outcomes unchanged. Soak counters (A10/A16): `__mp.counters()` +
  `'lru-evict'` census lines.

### EOL policy (A19, P-EOL-1..6)
P-EOL-1 save serialization is `model.getValue(TextDefined, /*BOM*/true)` only.
P-EOL-2 an EOL profile `{lf, crlf, cr, bom, finalNewline, pure}` is computed
from the raw bytes BEFORE `createModel` and kept for the model's lifetime.
P-EOL-3 pure files (LF or CRLF, ±BOM, ±final newline) round-trip
byte-identical; a 1-char edit is a 1-line diff. P-EOL-4 dirty is never decided
by byte comparison (a mixed file differs from disk at rest — open+close must
write nothing). P-EOL-5 mixed EOLs are normalized at model creation
(irreversible in Monaco): a persistent "EOL: mixed → will normalize" chip
shows from load, and the first save records an `eol-normalize` event carrying
the load profile — disclosed before, recorded when, rewindable after (the
ratified A19 contract amendment). P-EOL-6 the 12 byte-level fixtures are
standing P-matrix assertions.

### Tokenization & indent (A18)
Keep Monaco's defaults: `maxTokenizationLineLength` 20,000 (per-line CHARS —
line count never triggers anything) and `stopRenderingLineAfter` 10,000. Any
raise is **page-global** (measured leak) — never a per-pane knob, and needs
re-ratification. Token-driven code must survive a line's tokens collapsing to
one null token between keystrokes. `detectIndentation:false` — two-space
indent is contractual (editor + per-model `tabSize:2, insertSpaces:true`).
Custom Enter/Tab commands (S2) must handle ALL selections atomically or fall
through to native when `getSelections().length !== 1`.

### Theme (R12) & math wash (I7)
`cpDefineThemes()` reads the LIVE computed CSS vars — both palettes via a
synchronous `data-theme` flip/restore — and defines `cp-dark`/`cp-light`
BEFORE the first `createEditor` (no stock-theme flash). `defineTheme` accepts
**literal hex only** (no `var()`/`color-mix()`): values are normalized and an
unparseable value DROPS that one rule to the base vs/vs-dark color — a palette
change degrades a color, never the boot (R12). Re-runs ride the additive
`store.themeHooks` rail at the end of `applyTheme` (armed lazily at INIT —
store.js keeps zero Monaco knowledge). **Monaco themes are GLOBAL per page**
(one standalone theme service) — a hard constraint on any future second
editor instance. style.css stays the single palette source.
The mzone math wash is **decorations, never theme** — token-background theme
rules silently don't render in the standalone theme service. It is model-owned
(`washCompute` over `getLinesContent()`, column-exact) and consumes
`texZones.scanLineZones`, the SAME scanner that seeds the Monarch math states,
pinned by one golden corpus; re-armed synchronously after every M2 commit and
on dock attach, 120ms debounced behind idle edits (R13). One additive CSS
rule (`.mdock .mpWash`) on the legacy mzone palette var.

### editHold (P17)
`holdEditor(on)`: raise records whether the editor had text focus, blurs the
focused inner surface, and pins `updateOptions({readOnly:true})` for the hold
lifetime (pointer-events CSS never silenced keyboards); release unpins and
hands focus back only if held at raise. Transition-only and idempotent;
tolerates pre-READY boot (`applyFile` re-asserts via `readOnly: editHeld ||
…`). The caller is `renderWB`, driven by the SAME expression as the
`.editHold` class and gated `mpImpl()==='monaco' && ui.view===key` — grey and
keyboard can never diverge; the legacy path is untouched.

### Standing invariants (I1–I10, as amended)
I1 drafts survive editor death — unsaved text always exists in `drafts`
outside Monaco; no loader failure or disposal bug can destroy a draft.
I2 renders are non-destructive — a background `renderWB` mid-typing moves
neither caret, scroll, focus, undo, nor an in-flight IME composition.
I3 Space never mics while editing (triple guard above). I4 patch-in-place
contracts hold (saveChip survives `editorChrome` patches; texfix resolution
never calls `renderWB`; suggestion review never disturbs scroll). I5 jump
precedence — `pendingEdJump` (15s TTL) beats viewState restore; `texOpenAt`
reopens ×-closed pins or the jump drops (S2 wires `revealAt`). I6 save
contract verbatim — `x-mtime-ms` header-first, the server's 250ms 409 grace,
clipboard-before-destruction, mid-flight rebase. I7 the wash is decorations,
never theme. I8 (INVERTED) the AMD globals are load-bearing for the page
lifetime. I9 coarse pointers never get Monaco (automatic, per-device, not a
preference). I10 demolition (S3) is gated on the objective soak and split per
A12 — behavior-preserving precursors, a tagged pre-demolition SHA, ONE
pure-deletion commit, and a PASSING rollback drill; the retired-test count is
**five** geometry files + an `hl.test.mjs` shrink (the old "six" wording is
corrected). hl.js is PRUNED, not deleted (ratified): tokenizer + `hlText` +
passive overlay serve the coarse-pointer editor and every read-only view. At
S3 the touch-fallback parity contract (A15 feature floor) is written into
this document — including a disposition for the legacy input handler's known
A9 lie (byte-equality clean check with no diskStale suppression), documented
and deliberately untouched until then (legacy stays byte-identical).

### Tests & billing
Suites: `ui.monaco-boot/-core/-save/-latex/-merge/-stale/-m7` (+ the grown
`ui.voice` PTT cases); failure injection is server-side in the sandbox harness
(hash-prefix URL regexes). No new billed surface — every Monaco route is a GET
or the existing PUT save path; the WS-stub and `CP_NO_BILLED` layers apply
unchanged.

### Ladder & exit gates (A11 · A14 · A16 · A17 · objective soak)
The stage ladder: **S2** (providers wired — complete but OPT-IN) → **S2b**
(default flip) → **SOAK** → **S3** (demolition, per I10) → **S4** (polish,
cut-first).
- **A11 — opt-in first, flip alone.** S2 lands the complete provider behavior
  while `'legacy'` stays the default; nothing in S2 flips anything. The
  default flip is its OWN tiny reversible commit (S2b), gated separately on
  the A14 matrix, the A16 measured budgets, the A17 accessibility gate, and
  the A14 genuine-input E2Es.
- **A14 — the evidence matrix is a required exit artifact.** One row per
  P1–P22 integration point (index below), plus genuine-keyboard E2Es for
  typing, undo/redo, multi-cursor, find/replace, completion acceptance,
  Enter/Tab/⇧Enter, save-midflight, merge, clipboard failure, and
  implementation handoff. Matrix verification consumes a **recorded test-run
  artifact** — commit SHA, editor-implementation mode, per-test pass/fail,
  per-mode skips, and dated manual-evidence entries; proving a cited test
  *title exists* is reference-checking, not verification.
- **A16 — measured budgets before the flip.** Performance claims are
  MEASUREMENTS on the packaged `/vendor/monaco` route: cold/warm transfer
  bytes, ready-to-first-edit, p50/p95 input latency, long tasks, worker/heap
  growth and model churn, representative 200k-char documents. Pass/fail
  budgets are set at S2b's gate; soak logging is local-only (boot stage,
  fallback reason, invariant violations).
- **A17 — accessibility gate (at S2b).** A high-contrast decision independent
  of the AMD workaround (auto-detect retained or a tested HC theme); dynamic
  editor `ariaLabel`; command/key access to every widget action; live
  announcements for suggestions/problems/save state; keyboard-only coverage;
  a VoiceOver smoke test; `prefers-reduced-motion` behavior.
- **Objective soak rule (A11).** One FIXED SHA; ≥4 real writing days AND ≥6
  sessions including one ≥2h; exit = zero Sev-1/Sev-2 defects and zero
  draft/model invariant violations in the local soak log; any Sev fix
  restarts the clock (test-only changes do not). iPad PWA re-verified during
  the soak.

### P1–P22 integration checklist (index)
One line per integration point; the A14 matrix carries one evidence row per
entry. The numbering is frozen (the seams-doc remap is rationale/history).
- **P1** drafts/dirty/saveChip — `drafts` stay authoritative; `isDirty/text/
  onDirtyChange` seams.
- **P2** ⌘S save / 409 / recovery — `beginSave`/`commitSave` tokens (M3/M5);
  ⌘S is a monacoPane `addCommand`.
- **P3** file:changed reload + 3-way merge — `applyExternal` closed reason
  set; merge = history rebase (M4).
- **P4** external pins — same model-per-fkey; `cp:` URIs tolerate absolute
  fkeys; the save branch unchanged.
- **P5** fetch contract — untouched; `x-mtime-ms` header-first; 200k/binary →
  read-only `hlText`, no model.
- **P6** texfix — `texfix {arm, revalidate, resolve}`; the
  `latex/texfixAnchors.js` engine; apply flows as typing (M2-unguarded).
- **P7** SyncTeX forward — `addCommand(⌘J)` + `getPosition()` (1-based).
- **P8** SyncTeX inverse + jumps — `revealAt(fkey, line, col, {flash})`:
  clamp → setPosition → the EXPLICIT 35%-height reveal (never
  `revealPositionNearTop`) → flash decoration.
- **P9** compile problems — `setProblems` → `setModelMarkers('texlog')` +
  whole-line tint decorations; rows filtered per model; badbox is Hint
  severity and never tinted; the problems strip stays outside.
- **P10** completions — the provider from `latex/texProviders.js`;
  `incomplete:true` re-query discipline (A8); 'latex' only — bibtex gets no
  provider.
- **P11** pairs / auto-`\end` / indent — language configuration + the spiked
  Enter command; `needsEnd` shared from `latex/`; the A18 multi-cursor rule.
- **P12** ⌘/ + § outline — native `commentLine` via the comments config;
  `texOutline` feeds both the dropdown and the DocumentSymbolProvider.
- **P13** ▶ run / ⌘⏎ — `addCommand(⌘⏎)` → `runFile`; the amber dot rides
  `onDirtyChange`.
- **P14** foot chrome — plain DOM around the editor; host datasets update
  synchronously in `setFile`.
- **P15** wrap policy — `wordWrap` per `setFile`; scroll rides viewState.
- **P16** viewport keep across renderWB — kept-connected host (A7);
  `saveViewStateFor`; focus captured before detach.
- **P17** focus mode + editHold — `automaticLayout`/`layout()`; `holdEditor`
  = blur + readOnly.
- **P18** Voice Space-PTT — `editContext:false` + the explicit
  `.monaco-editor` bail in voice.js + CDP test (the I3 triple guard).
- **P19** julia `\symbol` Tab — per-language Tab command; `wireGlobal`'s
  exclusion is the `.monaco-editor` bail.
- **P20** md ▤ preview — model-content ping → `mdPreviewSchedule`; drafts
  remain the source (P1).
- **P21** center-tab model — untouched; close is a VIEW close; LRU-50 is
  clean-only (M7/A10).
- **P22** prefs touching the editor — theme via `cpDefineThemes` from
  `applyTheme`; dividers via `automaticLayout`; viewStates in-memory only.
