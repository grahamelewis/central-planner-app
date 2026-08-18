Walk me through setting up Central Planner.

First, **read `README.md` and `SETUP.md`**, then give me a short summary of what
this tool is and the exact steps you'll take. **Do NOT edit any files or run any
commands yet** — wait for my confirmation.

After I confirm, follow `SETUP.md`:
1. Verify **Node ≥ 20** (`node -v`) and that at least one supported AI service is
   reachable: Claude via an **`ANTHROPIC_API_KEY`** (the supported path) or a
   Claude Code login, and/or Codex via an installed, signed-in `codex` CLI. If
   neither is connected, explain that manual tasks still work but agent tasks do
   not; point me to <https://platform.claude.com> for
   a key, and tell me how to export it.
2. Run `npm install` in `app/`.
3. Write a minimal `config.json` from `config.example.json` — ask me for my name
   and (optionally) one project folder + display name. Keep it minimal; I'll add
   the rest visually.
4. Start the server (`cd app && npm start`) and tell me to open
   <http://localhost:4242>.
5. Point me to the **Manage Projects** tab to add my other projects with the
   **⌖ browse…** folder picker.

Confirm with me before each file write or command — keep me in control
throughout.
