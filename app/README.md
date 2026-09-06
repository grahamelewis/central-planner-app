# Central Planner

Research-project dashboard ("the social planner's problem, solved locally"):
Claude or Codex sessions per task, HTML/PDF artifact viewers, live latexmk slide
recompiles, time + token ledger. The server lives in `centralPlanner/app/` and
stores configuration and durable state in its parent `centralPlanner/` folder.
Set `CP_ROOT` only when intentionally using a different data root.

## Run

```bash
cd <repo>/app
npm start          # → http://127.0.0.1:4242  (localhost only — never expose)
```

## Layout

- `server.js` + `lib/` — Express + WebSocket server (port 4242)
  - `config.js` — project registry (paths, colors, optional `texWatch`), weekly targets
  - `taskStore.js` — reads/writes `../tasks/<project>.json` (the source of truth; editable by hand)
  - `sessions.js` — provider dispatcher: Claude Agent SDK or Codex app-server, context packets, handoff parsing
  - `codexAppServer.js` — persistent local Codex JSONL client: account, live models, usage, threads and turns
  - `watchers.js` — chokidar artifact indexing + live PDF watches (push-triggered one-shot latexmk compiles on save)
  - `ledger.js` — `../ledger/ledger.jsonl` (your seconds + Claude tokens/cost, weekly summary)
- `public/` — the dashboard frontend (no build step)
- `public/m/` — the phone app (same API/WS; tasks, sessions, add, artifacts; PWA-installable)
- `../categories.json` — category primers injected into sessions
- `../abstracts/<project>.md` — living abstracts (edit freely; injected into context packets)

## Concepts

### Task memory: checkpoint-only pilot

Settings → **Task memory** configures a separate background model. The pilot is
**disabled by default**. Two connections are offered:

- **Claude · this login / subscription** (optional). The writer runs one tool-less,
  single-turn Agent SDK query on the same Claude login the task sessions use, so
  it is billed to your plan exactly like a task turn (the SDK's cost estimate is
  recorded, and the daily/per-request budgets are planning ceilings against it).
  It loads no project files, no settings sources and no CLAUDE.md — only the
  writer instructions and the JSON payload. Requires Claude to be connected under
  AI services.
- **OpenAI · my ChatGPT / Codex subscription** (default). A separate ephemeral
  `codex exec` worker uses Codex's existing ChatGPT sign-in. Connect Codex under
  AI services using ChatGPT, not an API key. Every job checks the account and
  available models, forces ChatGPT authentication, and removes API-key environment
  variables from the worker. There is no Platform API fallback. It consumes the
  same Codex allowance as your tasks. Existing `openai-api` settings migrate to
  this connection with memory disabled until you explicitly enable it.

Model access is not assumed: an unavailable model produces a visible failure, with
no automatic fallback. The default model is `gpt-5.6-luna` at low effort.
Claude Sonnet 5, Haiku 4.5 (no effort ladder), and Opus 5 remain available on the
Claude connection. OpenAI choices and efforts come from your connected Codex
account's model catalog; the saved default must be available before enabling.
The subscription connection defaults to at most **12 memory attempts per UTC day**,
not a dollar budget. This local guard does not measure remaining plan credits.
Claude retains its $0.10 per-request estimated ceiling and zero daily estimated
budget until configured; Settings shows its planning rates.
No paid model comparison has been run. The settings are
independent of the main task agent and apply to the next job, not an in-flight
request.

After a successful Claude or Codex turn, the worker queues one bounded update
from the previous checkpoint and new dashboard transcript text. It does **not**
read arbitrary project files or the provider's full hidden history. Structured
milestone notes included in the conversation are available as source text; this
stage does not add new instructions to the lead agent. Oversized entries are
processed as ordered fragments with an exact cursor and prefix hash, never
silently skipped. Large backlogs may require additional updates from the panel
or later completed turns. Queued work is coalesced and requests run serially.

Use **◫ memory** under a task's goal to inspect its findings, constraints,
uncertainties, next steps, evidence, previous versions, job status, and usage.
Click an evidence ID to read its covered transcript excerpt. **Update checkpoint**
queues a billed update when memory is enabled and the task is idle. Merely opening
Settings or the panel never calls a model. The desktop panel is responsive; the
separate `/m/` phone app does not yet have these controls.

This stage **never resets, compacts, switches, or injects anything into working
agent conversations**. It also never modifies accepted project rules or handoffs.
Validation checks structure, size, source IDs, task identity, and source/revision
freshness—not factual fidelity. Test actual continuation quality before building
automatic context replacement.

Operational details:

- Durable records are `CP_ROOT/memory/<sha256(project, task ID, created)>.json`.
  Each contains identifiable task metadata, checkpoint versions, coverage hashes,
  and job history. This directory is gitignored at the default data root.
- Writes use atomic replacement; malformed stores and symlinks fail closed.
  Task deletion removes its checkpoint record and cancels pending work. In-flight
  requests cannot recreate deleted records. Budget reservations remain.
- `memory/budget.json` records a reservation **before** every request: one daily
  slot for Codex, or an estimated-dollar ceiling for Claude. Timeouts, crashes,
  refusals, and invalid outputs retain their reservation across restarts.
  These are local guards, not provider enforcement. Do not run multiple
  server processes against the same `CP_ROOT`; like task storage, this is a
  single-writer design.
- Input admission bounds the supplied payload using UTF-8 byte length plus a
  framing allowance; Codex adds its own runtime instructions. The Codex worker
  runs in a temporary read-only workspace, ignores user config and rules, disables
  execution features, and rejects tool attempts. Its output-token limit is an
  acceptance check after completion, **not** a hard generation cap. Claude keeps
  its provider output cap. Workers have a 90-second timeout, no automatic job
  retries, and no resumed conversation. Codex may retry transport failures within
  that worker. Ephemeral does not promise zero provider retention.
- Failed/incomplete/stale candidates never replace the last good checkpoint.
  A new completed task turn can queue fresh work; failures do not retry themselves.
  After restart, unfinished jobs appear interrupted and are not automatically
  replayed. A changed covered transcript prefix blocks further synthesis pending
  manual investigation; this pilot does not silently rebuild a new baseline.
- Usage is stored per job and copied into the shared ledger with `action:memory`.
  Codex is marked `costSource:subscription` with zero API-dollar cost (not zero
  subscription consumption). Claude's estimate includes a cache-write premium.
  Missing usage stays unknown; its reservation is still retained.
- `CP_NO_BILLED=1` blocks both transports and the manual update route. Unit tests
  inject synthetic responses in the transports' shared normalized shape;
  browser/API tests use temporary state, no key, and no Claude login.

API endpoints: `GET/PATCH /api/memory/settings`,
`GET /api/tasks/:project/:id/memory`,
`GET /api/tasks/:project/:id/memory/evidence/:revision/:source?offset=0`, and
`POST /api/tasks/:project/:id/memory/update` (202, queues only).

Sources checked 2026-09-04:
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[API pricing](https://developers.openai.com/api/docs/pricing), and
[Codex authentication](https://developers.openai.com/codex/auth/).

### Existing dashboard concepts

- **Task** = unit of work. Oversight: `auto` (runs to completion), `propose` (plan mode),
  `coop` (interactive turns), `manual` (no agent). Category primer + living abstract +
  upstream handoffs + pinned files + notes are assembled into the launch prompt.
- **AI services**: Claude and Codex are independent, peer providers. Each task stores an
  explicit provider and model; Codex tasks also store reasoning effort. Settings shows
  separate connection cards and a default for new tasks. Switching an existing task's
  provider is always confirmed and starts a fresh provider-owned thread—its shared
  dashboard transcript and earlier private thread reference are retained, and there is
  never silent fallback from one service to the other.
- **Categories**: every task wears one; its **primer** is injected into each session of
  that kind. Edit them under your name (top left) → **Manage Categories** — a grouped
  tree plus a full editor (icon, name, group, primer, web-search default). Renaming a
  category or group propagates everywhere, including every past task; deleting one never
  rewrites the past — old tasks keep their label, it just leaves the pickers. Deleting a
  group asks first, since its categories go with it.
- **Handoff**: completing a task (✓ complete) has its session write a final ```handoff
  fenced JSON block; the server parses it into the task record and injects it into
  downstream tasks (`upstream: [...]`). Sessions never propose completion on their own —
  ending a task is always your call.
- **Agent teams**: a session can fan work out to subagents (the SDK's Task tool —
  built-ins like general-purpose/Explore/Plan plus any custom agents the repo defines
  under `.claude/agents/`). The console narrates the whole team: a `◆ agent #N ▶ type —
  what it was asked` line at launch, throttled progress lines with live AI-generated
  summaries ("Analyzing authentication module") plus tool/token counts, the agent's
  inner tool calls prefixed `↳N`, and a `✓ done / ✗ failed` line carrying its final
  report. While agents run, a strip at the stream's end shows the live roster —
  how many are running and what each is doing — and clears when the turn ends.
- **Show panel ＋**: pick any .html/.pdf/.md to display, or a .tex to live-compile
  (a one-shot latexmk fires the instant you save — no polling — and the panel
  reloads on every successful build). Saved htmls and
  recompiled pdfs refresh automatically via the artifact watcher. × closes a tab.
- **Markdown, rendered**: `.md` files display as a themed document (headings,
  KaTeX math, code blocks, tables, images) rather than raw source. An `.md`
  open in the editor gets a **▤ preview** button — the pane then tracks your
  unsaved draft live as you type, keeping your scroll position; `✎ source` in
  the pane's bar jumps back to the editor. If a session edits the file on
  disk, a draft-less pane refreshes itself. This works for **external pins
  too** — files outside the project root open editable (you get the same
  write access the session has, with the same save-conflict guard) and
  preview the same way.
- **Editing**: pinned files open editable in the center pane — type, then ⌘S (or the save
  button) writes to disk atomically. Saves are refused (409) if the file changed on disk
  after you opened it, so a running session's edits never get clobbered silently.
- **Running**: ▶ run (or ⌘⏎ in the editor) executes the open file — `.jl` via julia (auto
  `--project=` from the nearest Project.toml), `.py` via the repo's venv else python3,
  `.r`/`.sh`, `.sql` via DuckDB (in-memory, statement by statement — query parquet/CSV in
  place, `ATTACH` a database file explicitly).
  Unsaved edits are saved first. Output streams into a ▶ output tab; one run per project
  at a time, stoppable from the UI. Server keeps the output tail so reloads don't lose it.
  ▶ on a `.tex` compiles it one-shot and its PDF appears **as its own viewer tab** —
  exactly as if you'd ＋-added that `.pdf` to the show panel. One tab per document, so
  the draft and the slide deck coexist; tabs persist like any ＋-added display, and the
  pane refreshes in place on every recompile. (The ＋ → `.tex` **live watch** remains
  the recompile-on-every-save option; if the watch already covers a `.tex`, ▶ just
  brings its pane forward instead of racing a second latexmk against it.)
  **Quiet builds**: a `.tex` run doesn't steal the session pane or stream the latexmk
  spew — the ▶ output tab holds a one-glance build card (⟳ pass chips while compiling,
  then ✓/✗ + seconds + pages, parsed error rows that click-jump to the line, the raw
  log behind a collapsed ▸ disclosure). The same status rides the PDF pane itself —
  watch pane and ▶-run artifact tab alike: a thin staged bar crosses its top during
  each rebuild (filling at real latexmk pass boundaries) and a toolbar chip next to
  the page number keeps the verdict — ✓ 1.8s or ✗ 0.9s — until your next save; click
  the ✗ to jump to the first error.
- **◆ Next up**: one countdown block in the workbench sidebar (between Pinned
  files and Recent activity) — the next three dated things for the project:
  deadlines you type (pink; imminent/overdue ones pulse, missed ones linger 48h
  in red) and meetings filed from your calendar (slate). ＋ on its header adds
  a deadline inline (title · date · an optional conference/CFP link — the row
  then shows a ↗ that opens it in a new tab); hover a deadline for ⤴ (opens
  Google Calendar's create-event screen
  prefilled — a computed URL, no token, a copy not a sync) and × remove.
- **⧉ Calendar** (top bar, where ⊞ categories used to be — the category editor
  still lives in the profile menu → Manage categories): the planning page.
  Connect your Google Calendar by pasting its **"Secret address in iCal
  format"** URL (Google Calendar → Settings → your calendar) — read-only
  forever, fetched every 15 min, no OAuth, no billed calls, and the secret URL
  never leaves the server (it lives in gitignored `plan/calendar.json`; events
  cache in gitignored `.cache/`). One calendar, many projects: **file each
  meeting series to a project** (or ⊘ personal — parsed, shown nowhere, never
  asked again) — filing a recurring series is one decision for every instance
  (routed by the feed's stable UID). Unfiled meetings appear in no project;
  the amber ⧉ chip on ◆ Next up is the nudge, and clicking it lands here.
- **Recent activity**: the workbench sidebar keeps a live timeline of what
  just happened in the project — file edits with their ±line counts, finished
  script runs with durations, and task completions. Every row goes somewhere:
  an ✎/✚ row opens that change's inline diff in the Δ history, ✓ done opens
  the archived task, ▶ opens the run's output. A busy turn can't flood the
  feed: fifteen edits fold into one expandable `✎ edited 15 files · +240 −60`
  row, a forty-script sweep into one `▶ ran 40 scripts`. Archived tasks are
  reached through their ✓ done rows here, or the overview's Recent tasks
  strip, which lists them too.
- **Sign-in card**: when the dashboard can't reach Claude because your login
  expired (or the server's API key went bad), it says so — an amber card in
  the session pane names the problem, and one click runs the official CLI's
  own browser sign-in (`claude auth login`); the card confirms with
  `claude auth status` and clears itself everywhere once you're back in.
  **↻ Retry turn** then re-runs the turn that died, with the failed exchange
  cleaned from the transcript first. Detection is proactive: checked at boot,
  when a browser connects, and on any failed turn — so a signed-out install
  shows the card before you burn a turn discovering it. If the server
  authenticates via `ANTHROPIC_API_KEY`, the card explains that the key —
  not a browser login — is what needs fixing. Status checks and sign-in are
  account plumbing, never billed calls.
  Codex has its own parallel card backed by the local `codex` CLI and ChatGPT login.
  Its live model catalog and plan rate-limit windows come from `codex app-server`;
  the status bar keeps Claude and Codex usage separate.
- **Job cards**: a script that runs long enough to matter (~8s) gets a live
  status card instead of a silent console — green ▶ RUNNING header, the file in
  mono, `elapsed · %CPU · mem`, a progress bar, and `⊘ stop`, which terminates
  the real process tree. Same card, same colors for Julia, R, and Python; it
  appears in two places. In the **session console**, when Claude's turn runs
  `julia fig3.jl`, `Rscript …`, `python …`, or a notebook (`jupyter nbconvert
  --execute`, papermill, `quarto render`) the card rides at the stream's end
  with process-table stats (pid, %CPU — 340% means four hot threads — and
  memory) and a soft sweeping bar: the script's stdout belongs to the session,
  so the dashboard won't pretend to know the iteration count. Backgrounded
  shells get a card too (tagged `background`), so a long download keeps its
  card while Claude works on other things; truly **detached** launches
  (nohup / `scripts/bg` / trailing `&`) keep theirs even after the turn ends —
  the card lives until the process itself exits, and ⊘ stop works throughout. On a **▶ run** the
  output stream is ours, so the bar is honest: `iter 358/500` counters,
  ProgressMeter/txtProgressBar percentages and reported ETAs are parsed live,
  an ETA is estimated when the script doesn't offer one, and an amber
  `quiet 3m50s` clock warns when a run has printed nothing lately. Quick runs
  never flash a card; a finished one reports ✓/✗/⊘ + duration, lingers a few
  seconds, and fades out.
- **LaTeX**: a genuine editing loop around the live `.tex` watch. The PDF
  renders in-app (PDF.js) and rebuilds land in place — scroll and zoom are
  kept, pages swap only when their fresh pixels are ready. Compile errors and
  warnings appear in a strip under the editor with the offending lines tinted;
  click a row to jump there. SyncTeX both ways: double-click the PDF to jump
  to the source line, ⌘J (or ◎ pdf) to flash the caret's spot in the PDF.
  Typing `\cite{`, `\ref{`, `\begin{`, or any `\command` opens completion —
  bib keys with titles, `\label`s across the whole project, environments
  (Enter after `\begin{env}` auto-inserts the `\end`), and common commands
  with their argument skeletons. `⌘/` toggles `%` comments, braces auto-pair,
  Enter auto-indents (continuation lines line up with `\item`; one level
  deeper after an unclosed `\begin` — ⇧Enter for a flush newline), Backspace
  in leading whitespace dedents a level at a time, and § outline in the
  editor footer jumps between sections. Math lights up: `$…$`, `\[…\]`, and
  the amsmath environments get a subtle wash with variables italic, greek and
  symbol commands green, operators blue, numbers yellow, and delimiters pink.
- **Claude fix**: when the build has a serious compile failure, a card in the
  session pane (and a button on the problems strip) offers **🔧 Claude fix** —
  a sandboxed *read-only* Sonnet 5 session (billed, fast) studies the failure and
  returns **suggestions**, never edits. Each one strikes out the offending
  text in place and superimposes a pane right below it with the complete
  replacement — Apply or Dismiss each one where you're already reading.
  Approving applies the change into *your unsaved draft* — you
  keep typing throughout, nothing can be clobbered, and saving triggers the
  rebuild as usual. Suggestions are anchored to exact text, so they follow
  the code as you edit; one you've already fixed yourself quietly retires.
  Claude stays visible at the bottom while searching, even if the build goes
  clean in the meantime. If the compiler process dies outright on a terminal
  error, the watch flags itself and restarts on your next save.
- **Change history (Δ)**: every session turn that edits files records a change-set
  (journal + before/after blobs in `../snapshots/`). While a turn runs, the console's
  activity strip keeps a live ledger line — `✎ 34 files changed · 5 new · 27 edited ·
  2 deleted · +1,240 −380 · → Δ` — and `→ Δ` jumps to the Δ tab. There, each
  change-set lists its files grouped by folder with a verb (✚ new / ✎ edited /
  ✂ deleted), how many edits each file received, its ±lines, and a per-file ⟲ rewind.
  Click a file and it opens as a full inline unified diff: removed lines struck red,
  added lines washed green, untouched code in place, long unchanged runs folded into
  a clickable "⋯ N–M unchanged" row, and an `edit k/M ◀ ▶` stepper to hop between
  edits. Rewinds are themselves recorded, so they can be undone. Edits to granted
  external pins (files outside the project root) are tracked too — they show with
  the ↗ amber mark and rewind as long as the pin is still granted. Captures direct
  Edit/Write tool calls, not Bash side effects.
- **HTML editing**: ✎ edit in the show panel turns the rendered page itself editable
  (designMode) — type in place, format with the toolbar, ⌘S to save. Scripts are paused
  during editing so MathJax/plot code stays as source and the file round-trips faithfully.
- **Pin kinds**: code pins are read by the session on demand; data pins (.csv/.parquet/
  .dta/.xlsx/…) inject a generated schema card (columns, types, rows, sample) — never the
  contents; folder pins (🗀, trailing `/`) inject a size-annotated tree map. Cards
  regenerate when the file changes and are viewable in the center pane.
- **Pinning**: ＋ in the sidebar's Pinned files header opens the native macOS file dialog
  (served via osascript, so it yields real paths); picks must be inside the project root.
  If the dialog can't open, an in-app fuzzy file search appears instead.
- **Warm Julia REPL**: projects containing `.jl` files (plus a root
  `Project.toml` — the warm session activates the project's own environment) get a persistent
  [Kaimon.jl](https://github.com/kahliburke/Kaimon.jl) REPL, fully managed by the
  dashboard — packages and state stay loaded across a session's turns (and across
  tasks in the same project) instead of re-spawning `julia` for every iteration.
  Nothing to configure: if `kaimon` is installed the daemon starts on demand and
  is reaped when idle; if not, a one-click enable card in the session pane
  installs it (needs Julia ≥ 1.12). A ◉ warm REPL chip in the session bar shows
  it's live. `▶ run` and detached batch jobs keep fresh-process semantics — the
  warm REPL is only offered to the session for interactive iteration. Opt out
  with `"kaimon": false` in `config.json`.

## Notes

- **Editor**: Monaco is the only source editor; there is no Settings choice.
  Old Legacy preferences are ignored. The editor loads on first editable-file
  open, not on dashboard/Settings visits. If loading fails, use the pane's
  **Retry editor** button; unsaved drafts remain in the browser tab. **Copy text**
  and a selectable read-only view remain available. Do not reload/close the page
  before saving or copying unsaved work. The separate `/m` phone app is unchanged.

- **Light mode**: profile menu (your name, top left) → Settings → theme System / Dark /
  Light. System follows the macOS appearance; the choice is saved per-browser.
- **Updates**: once a day the dashboard checks whether your checkout is behind the
  repo it was cloned from. When it is, a small `1` badge appears next to your name
  (top left — click it), and Settings → Updates lists what's new with an
  **⬆ Update now** button (a safe fast-forward pull; it refuses if you have local
  edits or commits, and runs `npm install` when dependencies changed). After an
  update, restart the server and hard-refresh the browser.
- **Tailnet access**: from the host Mac, the top-bar Tailnet control publishes
  the localhost server privately through Tailscale Serve. It shows actual CLI
  state (`live`, saved-but-disconnected, conflict, unavailable), never enables
  public Funnel, and remote clients cannot change it.
- Launching/messaging tasks spawns real Claude Code or Codex turns against your own account (billed or plan-limited). Interrupt from the UI.
- Sessions run with `settingSources: ['project']`, so each repo's `.claude` settings apply.
- The desktop shell can start the server on demand. To keep it running even
  after Cmd+Q or without opening the shell, see `deploy/REMOTE.md` for the
  always-on launchd mode (never run two servers at once).
