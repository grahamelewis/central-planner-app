# Central Planner desktop shell — CONTRACT

**This file is the single binding review gate for `desktop/`.** From the moment
it shipped (day 2), `BLUEPRINT.html` rev 2 is the design record and stops being
normative (audit F28: two live normative docs will drift). A change to anything
below is a contract change and must edit this file in the same commit.
`§` references point into `BLUEPRINT.html`, the design record.

## The eight invariants

Verbatim from BLUEPRINT §4.

- **I1.** The shell never starts, kills, restarts, or signals any server
  process, and never mutates `launchctl` state — Phase 1 contains no code path
  that sends a signal or spawns a child.
- **I2.** Phase 1 ships no spawn path. The lifecycle's only verbs are attach,
  wait, and refuse; the spawn fallback exists only in Phase 1.5, gated on its
  five preconditions (§7).
- **I3.** Exactly one notifier WebSocket exists at any time, with reconnect
  backoff capped at 5 s→60 s and a 60 s silence watchdog; HTTP probing uses
  only `GET /m/manifest.webmanifest`; `POST /api/heartbeat`,
  `/api/state`-as-probe, and WS-connect-as-ping are forbidden.
- **I4.** The renderer holds zero privileges: no preload, no IPC, sandbox +
  contextIsolation on; permission check *and* request handlers deny by default,
  allowing only origin-pinned, main-frame `clipboard-sanitized-write`; all
  window-opens denied, with http/https/mailto routed to `shell.openExternal`
  and every other scheme dropped and logged.
- **I5.** No menu item ever binds an accelerator in Cmd+0..5; `resetZoom` lives
  on Cmd+Shift+0.
- **I6.** A live SPA is never reloaded by the shell; intervention happens only
  on main-frame, filtered `did-fail-load` (§2); close hides silently, and the
  draft dialog fires only on paths that actually unload (reload, quit).
- **I7.** `http://127.0.0.1:<port>` in a browser and the phone PWA behave
  identically before, during, and after the shell runs — unconditionally, since
  the shell never owns the server.
- **I8.** At most one lifecycle reconcile loop is active at any moment: every
  trigger (startup, did-fail-load, wake, retry) joins the current generation or
  is dropped; a superseded generation's callbacks are inert.

## Lifecycle state table

States are `serverlink.js` `STATES`, one to one.

| State | Trigger / evidence | Action | Re-probe |
| --- | --- | --- | --- |
| `CONNECTING` | Startup pre-decision; or `TIMEOUT` with raw TCP refusing (transient) | Default splash | 5 s |
| `ATTACH` | Probe `HEALTHY`: 200 + JSON `name === "Central Planner"` | `loadURL http://127.0.0.1:<port>`; open the ONE notifier WS; reconcile missed banners from the snapshot | — (attach ends the generation's loop) |
| `WAIT_LAUNCHD` | `REFUSED` (ECONNREFUSED only) + `launchctl list local.projectmanager` exit 0 (job loaded) | Splash naming `/tmp/projectmanager.log` — KeepAlive is respawning it; NEVER spawn | 1 s for the first 20 s of a contiguous stretch, then 5 s |
| `SERVER_ABSENT` | `REFUSED` + job not loaded | Splash with start instructions (`cd app && npm start`, or load the launchd job); NEVER spawn | 5 s |
| `BLOCKED_OCCUPIED` reason `foreign` | Probe `FOREIGN`: any other HTTP answer (wrong name, 404, non-JSON) | Squatter splash naming the port + `lsof` hint | 5 s |
| `BLOCKED_OCCUPIED` reason `occupied` | Probe `TIMEOUT` + raw TCP accepts (the SIGSTOP'd-server case) | Occupied splash | 5 s |

Footnotes:

- The port is re-resolved and re-validated on every loop iteration (G11).
- Consecutive identical states are de-duped — `onState` fires on change only.
- Every trigger (startup, did-fail-load, wake, retry) joins the single active
  generation; none starts a second loop (I8).

## Probe rules

The **only** HTTP probe is `GET /m/manifest.webmanifest` — 1.5 s timeout,
classified `HEALTHY` (200 + JSON `name === "Central Planner"`) / `FOREIGN`
(any other HTTP answer) / `REFUSED` (ECONNREFUSED only) / `TIMEOUT`.

Forbidden forever, with reasons:

1. `POST /api/heartbeat` — writes wall-clock time to the ledger.
2. `GET /api/state` as a probe — a 228 KB synchronous fs sweep per call.
3. WS-connect-as-ping — every connect costs the server a full snapshot send
   plus throttled auth/codex subprocess spawns.

## Close & quit semantics

- **Close (red button / Cmd+W) hides — silently, no dialog.** The window and
  its page live on (drafts, scroll, view state intact); the app and notifier WS
  stay alive; dock click or a notification click re-shows. Electron fires
  `close` before any DOM unload (F5), so no close-path dialog can or should
  exist.
- **Cmd+Q quits the shell and touches no server, ever** — there is no owned
  mode in Phase 1, so quit sends no signals of any kind; browser tabs and the
  phone PWA are unaffected by construction.
- The `will-prevent-unload` draft dialog fires only on paths that actually
  unload the page: **reload (Cmd+R) and quit**.
- `window-all-closed` never quits — the app is dock-resident.

## The Cmd+0..5 no-shadow rule

No menu item ever binds an accelerator in Cmd+0..5 (the dashboard's view
switching); `resetZoom` lives on Cmd+Shift+0 (I5). `main.js`'s runtime menu
audit logs any violation to shell.log. Re-verify against the pinned Electron on
every version bump — the default View menu binds `resetZoom` to CmdOrCtrl+0,
and menu accelerators fire before the page keydown.

## Cross-folder couplings — the full inventory

An `app/` change touching any of these is a shell change too:

1. Port precedence & `CP_ROOT`-aware config discovery — `CP_PORT` env →
   `config.json` `"port"` → 4242, config located at `CP_ROOT` else repo root
   (`app/lib/config.js:21-24, :50`).
2. `GET /m/manifest.webmanifest` returning 200 JSON with
   `name === "Central Planner"` — the identity probe.
3. The launchd label `local.projectmanager`.
4. The notifier's event names + payload shapes: `session:permission` /
   `session:permission:resolved`, `task:update` (question/handoff transitions),
   `session:status` (error/authNeeded — never question/handoff), and the
   `state` snapshot delivered on WS connect.
5. Init-only hash routing (`app/public/app.js:10240-10253`) — no runtime
   `hashchange` handling exists.
6. The Cmd+0..5 page bindings (view switching).
7. The `beforeunload` draft guard (`app/public/app.js:10063-10066`).
8. Node ≥ 20.
9. The 25 s server WS tick the shell's 60 s watchdog times against.

**Version-skew rule (F16/G13):** an `app/` change touching any listed coupling
updates `desktop/` in the **same commit** *and* triggers a re-pack plus a smoke
re-run. The dashboard's self-update button updates the server, never the
packaged shell — drift is real, and this list is the tripwire.

## Pinned versions

| Package | Version |
| --- | --- |
| `electron` | 43.3.0 (exact) |
| `@electron/packager` | 20.2.0 (exact) |

`package-lock.json` is committed (reproducible packs, F22). The dependency
assertion is `npm ls --omit=dev` printing `(empty)` — zero runtime deps.
Upgrading either pin is a deliberate event that re-runs the day-1 menu
verification (Cmd+0..5) and the day-2 packaged-notification gates (R9).

## Manual smoke matrix

Run against the **packaged** app (`npm run pack` first — dev banners attribute
to "Electron"). Check a box and add initials + date when a row passes.

- [ ] Packaged identity: `dist/Central Planner.app` launches from Finder with
      correct dock name + icon; `codesign --verify --deep --strict` passes.
      (initials/date: ________)
- [ ] Notification gate, window hidden: a staged `session:permission` produces
      a visible macOS banner. (initials/date: ________)
- [ ] Notification gate, window hidden: a staged `task:update` question
      transition produces a visible banner. (initials/date: ________)
- [ ] Notification click focuses/re-shows the window. (initials/date: ________)
- [ ] No banner when the window is focused on that banner's project — and the
      suppression is logged in shell.log. (initials/date: ________)
- [ ] Shell restart re-fires nothing (persisted notify-state).
      (initials/date: ________)
- [ ] A question staged while the notifier was down banners on reconnect
      (snapshot reseed). (initials/date: ________)
- [ ] A notification delivery failure appears in shell.log
      (`Notification 'failed'` listener). (initials/date: ________)
- [ ] Cmd+0 switches to overview; Cmd+1..5 switch projects; Cmd+Shift+0 resets
      zoom. (initials/date: ________)
- [ ] With a draft in a composer: Cmd+R and Cmd+Q each show the native dialog
      and Stay keeps the page; Cmd+W hides instantly with **no** dialog and the
      draft is intact on re-show. (initials/date: ________)
- [ ] Close hides; dock click restores with state intact; Cmd+Q exits and the
      launchd server PID is unchanged; a parallel Chrome tab and the phone PWA
      are unaffected. (initials/date: ________)
- [ ] Sleep/wake: lid closed ~2 min, reopen — a staged event notifies within
      ~5 s of wake. (initials/date: ________)
- [ ] `launchctl kickstart -k` mid-use: the loaded SPA is untouched and
      self-heals; Cmd+R during the outage lands on the splash and auto-returns
      on respawn; a deleted artifact's iframe 404 changes nothing.
      (initials/date: ________)
- [ ] Foreign squatter (`python3 -m http.server 4242`): splash names the
      squatter; attach succeeds after freeing the port. (initials/date: ________)
- [ ] SIGSTOP the server → deterministic TIMEOUT→OCCUPIED classification;
      SIGCONT → recovery. (initials/date: ________)
- [ ] localStorage first-run note sanity: first packaged launch looks like a
      fresh install exactly as the README describes, exactly once.
      (initials/date: ________)
- [ ] Finder launch: shell.log exists; a dropped `file://` link and a
      suppressed banner both appear in it. (initials/date: ________)
- [ ] Battery: a streaming turn with the window occluded, on battery, ~10 min —
      Activity Monitor energy impact: ________ (initials/date: ________)

## Addendum — chrome/page theme sync (2026-08-07)

The native macOS title bar follows `nativeTheme` (system appearance by
default), while the dashboard themes itself from its own Settings — producing
a light page under a dark bar or vice versa. The shell now mirrors the PAGE's
computed `document.body` background into `nativeTheme.themeSource` (and the
resize-flash `backgroundColor`), via `themeFromBackground(bg)` in
serverlink.js (pure, luminance-based, null on no-signal — the chrome is never
flipped blindly). Triggers: every `did-finish-load`, window `focus`, and a
15 s unref'd poll (an in-window Settings toggle fires no event main can see;
≤15 s lag accepted). Mechanism: main-initiated one-shot `executeJavaScript`
read — still no preload, no IPC, nothing exposed to the page (I4 holds).
The dark splash correctly darkens the chrome while it shows.
Regression: the two `themeFromBackground` tests in lifecycle.test.mjs.
