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

This is the recommended way to run Central Planner. The desktop app can also
start a server on demand, and `app/deploy/REMOTE.md` sets one up to start at
login. Whichever you choose, run only one server against this folder at a time.

The current folder already includes installed dependencies so the migrated app
can continue running immediately. `package-lock.json` remains the reproducible
source of truth for future installs.

## Desktop window

The optional Electron shell attaches to an existing server, waits for a loaded
launchd service, or starts one local server when neither exists. It stops only a
server it started itself; an attached launchd or manual server is left running.

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

See `desktop/README.md` for notification, signing, ownership, and quit semantics.

## Private tailnet access

The dashboard's top bar can publish Central Planner to your own Tailscale
network through Tailscale Serve, and turn it off again. It is off by default,
the server itself stays bound to `127.0.0.1`, and Funnel — public internet
exposure — is never used. This is a dashboard feature: it works in a browser
tab, with or without the desktop app.

Read this before turning it on. Central Planner has no login of its own, so
every device on your tailnet that can reach the URL gets full control of the
dashboard — including running code in your project folders and spending money
through your AI accounts. Keep your tailnet to your own devices. Access can only
be switched on or off from the host Mac.

`app/deploy/REMOTE.md` covers the always-on host setup.

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
