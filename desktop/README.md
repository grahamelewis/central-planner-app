# Central Planner — desktop shell

An Electron client and safe on-demand owner of the one local server: real
window and dock identity, native macOS banners even with the window closed, and
`backgroundThrottling:false` so the dashboard's heartbeat and stale-checks run
at full rate while hidden. It attaches to an existing server or loaded launchd
job; only when both are absent does it start and own one local Node server. The
binding rules live in `CONTRACT.md`; locally retained `BLUEPRINT.html` is the
historical Phase-1 design record (no longer distributed).

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

The shell probes first. A healthy Central Planner is attached; a loaded
`local.projectmanager` job is allowed to recover; a foreign/occupied port is
refused. Only `ECONNREFUSED` plus no loaded job reaches desktop-owned startup.
The server binds before running startup sweeps/watchers, so a launch race exits
without mutating state. Close hides and keeps an owned server running. Cmd+Q
stops only the shell's own child; an attached launchd/manual server is untouched.

The packaged app carries a build-time location hint and persists a validated,
repairable server location in Electron userData. For production, point it at
the separate installation directory containing the stable `app/server.js`
launcher; server releases and durable state are not copied into the desktop
bundle. Development checkouts remain supported. Installation-aware port
resolution reads the preserved data root before probing. See
[the distribution and migration guide](../app/docs/distribution-boundary.md).

## Tailnet access

The top-bar **Tailnet** control manages one private Tailscale Serve mapping for
Central Planner. It never invokes Funnel or `serve reset`, refuses to overwrite
another root handler, and can only be changed from the host Mac. `Tailnet live`
means Tailscale is connected *and* the mapping targets this server; `Tailnet
saved` means the mapping exists but Tailscale is currently offline. Remote
browsers see status only. Clicking a saved/offline chip reconnects Tailscale
with its existing settings before making Central Planner live.

Close hides, so Tailnet access stays live. Cmd+Q warns when remote access or
active work would be interrupted; for a desktop-owned server it disables the
Central Planner Serve mapping and stops that server. Attached launchd/manual
servers and their remote access are left alone.

## Notifications

Allow notifications once in **System Settings → Notifications → Central
Planner** — after launching the **packed** app, not `npm start` (dev banners
attribute to "Electron", a different identity). Banners are best-effort by
design; ntfy phone push stays the durable channel.

Set `notifications.turnEnd` to `false` in the server's `config.json` to mute
turn-end question, handoff, failure, and sign-in alerts in both ntfy and this
desktop shell. Approval-request alerts remain enabled. Restart the server to
load the preference. Older packaged shells need rebuilding to honor it:
`npm run pack -- --stage` prepares a signed bundle in a new `dist/update-*/`
folder without touching the currently running app. Quit the old app before
opening the staged bundle. Muted events are still deduplicated so they do not
replay when alerts are re-enabled.

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
- `…/logs/server.log` beside `shell.log` — a desktop-owned server's stdout and
  stderr.

shell.log records every lifecycle decision with its evidence (probe class,
launchctl exit, generation), every dropped URL scheme, and every banner fired,
suppressed, or failed.

## Mic & voice (G1)

There is no dictation in the shell: Electron ships no speech-recognition
backend, so the mic button hides itself there (the one deliberate `app/` diff).
Voice replies and TTS work natively. Dictate in Chrome or the phone PWA.
