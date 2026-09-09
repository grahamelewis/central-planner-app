# Setting up Central Planner

The easiest path: run `claude` in this folder and type **`/setup`** — or just
open Claude here on a fresh clone and it will offer to walk you through it. You
can also follow these steps by hand.

## Prerequisites

- **Node ≥ 20** — check with `node -v`. (On Node below 22.13, `npm install`
  prints a benign `EBADENGINE` warning for `pdfjs-dist` — the in-app PDF
  renderer works fine there; the warning is safe to ignore.)
- **Access to at least one AI service.** Central Planner can run Claude Agent SDK
  sessions and Codex app-server threads. Calls use your account and there is
  **no dashboard spend cap.** For Claude, the supported path is an Anthropic
  API key (pay-as-you-go): get one at <https://platform.claude.com>, then set it
  in your environment:
  ```
  export ANTHROPIC_API_KEY=sk-ant-...
  ```
  (add it to your shell profile to persist). Alternatively, if you already use
  Claude Code, the dashboard's sessions can run on that login and no API key is
  needed. Either way, task launches, messages, and the profile feature spend on
  whichever credentials you use. For Codex, install and sign into the local
  `codex` CLI (`codex login`); the dashboard then discovers its current models
  and plan usage automatically. You may connect either service or both. Manual
  tasks work with neither.

## 1. Install

```
cd app
npm install
```

## 2. Configure

Copy the example config to `config.json` (the gitignored file the app reads), or
let `/setup` write it for you:

```
cp config.example.json config.json      # from the repo root
```

`config.json` holds your name and your projects. The minimum to start is your
name — you can add projects here, but it's easier to do it visually after launch
(step 4). Fields:

- `user.name` — shown top-left in the dashboard.
- `projects.<key>` — a project. The **key** is a permanent identifier (your
  tasks, ledger, and snapshots are stored under it), so pick a short slug and
  don't change it later. Each project has:
  - `name` — display name (can differ from the key, and can be changed anytime).
  - `root` — absolute path to the project folder.
  - `color` — a hex color for the nav dot.
  - `texWatch` — optional path (relative to `root`) to a `.tex` file to
    live-recompile in the show panel, or `null`.
  - `status` — `active` (default, no tag) · `trial` (tagged in the nav) ·
    `inactive` (hidden from the nav and overview).
  - `pinOrder` — optional; the project's slot on the top bar (1–7, ⌘1–⌘7).
    Leave it out and the bar shows your first seven non-inactive projects
    until you pin one from Manage Projects.
- `agents` — default service, model, and Codex reasoning effort for new tasks;
  the same defaults are editable under Settings → AI services.
- `notifications`, `port`, `weeklyHourTarget`, `artifactGlobs`, `usageLimits`,
  `kaimon` — all optional; see `config.example.json` for the shape and defaults.

`config.json` is gitignored — your paths and name are never committed.

## 3. Start it

```
cd app
npm start
```

Open <http://localhost:4242>.

## 4. Add your projects (visual)

In the dashboard, open **Manage Projects** (via the name menu, top-left). Click
**＋ Create project**, use the **⌖ browse…** button to pick a folder with your
computer's native file picker, set a display name and designation, and you're
ready to create tasks. You can rename, recolor, or re-designate any project here
later; changes save back to `config.json` automatically.

## Notes

- **No login.** The dashboard binds to localhost. For always-on / remote access
  see `app/deploy/REMOTE.md` (Tailscale) — never expose it on a public tunnel.
- **Optional tools**, only needed for specific features: `latexmk` + a TeX
  distribution (live PDF recompile), and `julia` / `python` / `R` (the in-app
  file runner). The dashboard runs fine without them.
