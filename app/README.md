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

- **Light mode**: profile menu (your name, top left) → Settings → theme System / Dark /
  Light. System follows the macOS appearance; the choice is saved per-browser.
- **Updates**: once a day the dashboard checks whether your checkout is behind the
  repo it was cloned from. When it is, a small `1` badge appears next to your name
  (top left — click it), and Settings → Updates lists what's new with an
  **⬆ Update now** button (a safe fast-forward pull; it refuses if you have local
  edits or commits, and runs `npm install` when dependencies changed). After an
  update, restart the server and hard-refresh the browser.
- Launching/messaging tasks spawns real Claude Code or Codex turns against your own account (billed or plan-limited). Interrupt from the UI.
- Sessions run with `settingSources: ['project']`, so each repo's `.claude` settings apply.
- To run the server permanently on a desktop and use it from a laptop anywhere,
  see `deploy/REMOTE.md` (Tailscale + launchd; never run two servers at once).
