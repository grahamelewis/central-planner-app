# Central Planner — desktop shell

An attach-only Electron client of the one local server: real window and dock
identity, native macOS banners even with the window closed, and
`backgroundThrottling:false` so the dashboard's heartbeat and stale-checks run
at full rate while hidden. The shell contains **no code path that starts,
signals, or restarts a server** — it attaches, waits, or refuses, nothing else.
The binding rules live in `CONTRACT.md`; `BLUEPRINT.html` is the design record.

## Run / pack / test

```sh
cd desktop
npm install          # devDeps only: electron + @electron/packager, pinned exact
npm start            # dev shell (banners attribute to "Electron" in dev)
npm run pack         # → dist/Central Planner.app, ad-hoc signed;
                     #   codesign --verify --deep --strict must pass
npm test             # node --test, injected fakes — no Electron, no network
npm ls --omit=dev    # must print (empty): zero runtime deps
```

Packing needs Node ≥ 22.12 (an `@electron/packager` floor; this machine runs
25.x). If the .app was ever moved through a quarantining channel and Gatekeeper
balks, right-click → Open once.

## The one-server rule

The launchd job `local.projectmanager` owns port 4242 with KeepAlive and is the
only server. The shell attaches to it, waits for it, or refuses the port —
never spawns a rival. Browser tabs and the phone PWA keep working alongside
the shell, unconditionally. On a machine with no server at all: `cd app &&
npm start`, or load the launchd job — the shell's splash says the same.

## Notifications

Allow notifications once in **System Settings → Notifications → Central
Planner** — after launching the **packed** app, not `npm start` (dev banners
attribute to "Electron", a different identity). Banners are best-effort by
design; ntfy phone push stays the durable channel.

### No banner? Two different failures, two different fixes (G7)

Check `shell.log` first:

- **`notify: … failed` lines present** → signature/attribution problem. System
  Settings **cannot** fix this. Run `codesign --verify --deep --strict
  "dist/Central Planner.app"` and re-pack.
- **shell.log silent about the event** → permission denial. Fix it in System
  Settings → Notifications.

Also: banners are deliberately suppressed while the window is focused **on that
project** — suppressions are logged, not shown.

## First launch looks like a fresh install (G6)

Electron has its own profile partition, so Chrome's localStorage doesn't carry
over: theme, pane widths, per-task tabs, open viewers, and voice prefs reset
once. About two minutes to re-set; it never happens again. Drafts were never at
risk — they are in-memory only.

**Port-change caveat (G11):** a loaded page keeps talking to its old origin
until a manual Cmd+R — the shell never reloads a live SPA. And a new port is a
new browser origin, so expect one more one-time view-state reset.

## Logs

- `/tmp/projectmanager.log` — the launchd **server's** log, not ours.
- `~/Library/Application Support/Central Planner/logs/shell.log` — the packaged
  shell's log. Under `npm start` the userData name differs:
  `~/Library/Application Support/central-planner-desktop/logs/shell.log`.

shell.log records every lifecycle decision with its evidence (probe class,
launchctl exit, generation), every dropped URL scheme, and every banner fired,
suppressed, or failed.

## Mic & voice (G1)

There is no dictation in the shell: Electron ships no speech-recognition
backend, so the mic button hides itself there (the one deliberate `app/` diff).
Voice replies and TTS work natively. Dictate in Chrome or the phone PWA.
