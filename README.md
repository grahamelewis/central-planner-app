# Central Planner

Central Planner is a local, single-user research dashboard. It runs one resumable
Claude or Codex session per task and keeps the rest of the working loop beside it:
project files, LaTeX editing and live PDF compilation, artifact viewers, task
handoffs, change history, calendar planning, and time/token accounting.

This folder is the complete local application. It is intentionally separate from
the public website repository.

## Folder layout

```text
centralPlanner/
  app/            Node server and browser UI
  desktop/        optional Electron desktop shell
  config.json     local configuration and project registry
  tasks/          task records
  transcripts/    shared conversation history
  snapshots/      per-turn change history and rewind data
  ledger/         time and token ledger
  abstracts/      project abstracts injected into sessions
  decisions/      project decision ledgers
  plan/           deadlines and private calendar configuration
```

The durable data directories and `config.json` are local state. Back them up, and
do not publish them: they contain project history and may contain private paths or
calendar URLs.

## Run the server

Requirements: Node 20 or newer and at least one configured AI service for agent
tasks. Manual tasks work without an AI account.

```bash
cd app
npm install        # only needed after a fresh copy or dependency change
npm start
```

Open <http://127.0.0.1:4242>. The server binds to localhost and has no public-web
authentication; do not expose it directly to the internet.

The current folder already includes installed dependencies so the migrated app
can continue running immediately. `package-lock.json` remains the reproducible
source of truth for future installs.

## Desktop window

The optional Electron shell attaches to the same local server; it never starts a
second server.

```bash
cd desktop
npm start
```

To rebuild the packaged macOS app:

```bash
cd desktop
npm install
npm run pack
```

See `desktop/README.md` for notification, signing, and lifecycle details. For an
always-on server reached over a private Tailscale network, see
`app/deploy/REMOTE.md`.

## Configuration and first-run setup

- Existing installation: edit `config.json` or use Manage Projects in the app.
- Fresh installation: follow `SETUP.md`, starting from `config.example.json`.
- Optional tools: `latexmk` plus a TeX distribution for LaTeX; Julia, Python, R,
  or DuckDB for their corresponding file-runner features.

## Development and verification

```bash
cd app
npm test
npm run typecheck

cd ../desktop
npm test
```

The automated app tests block billed AI dispatch. The application source is under
`app/`; the desktop shell is under `desktop/`; live user state stays at this root.

