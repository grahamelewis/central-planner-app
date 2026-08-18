#!/usr/bin/env node
// Fake `claude` CLI for auth tests — no test may ever run the real one (a
// real `auth login` pops the dev machine's browser). Honors the surface
// lib/auth.js uses:
//   claude auth status --json   → {loggedIn, authMethod, email}; exit 1 when
//                                  signed out (models the stricter CLI — the
//                                  JSON verdict must win over the exit code)
//   claude auth login           → per FAKE_CLAUDE_LOGIN_MODE:
//       success (default)  write loggedIn:true to the state file, exit 0
//       fail               print an error, exit 1
//       hang               never exit (the timeout path)
// Sign-in state lives in FAKE_CLAUDE_STATE_FILE (JSON {loggedIn, email}) so
// tests flip it mid-run.
import fs from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE_FILE || '';
const read = () => {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { loggedIn: false }; }
};

if (args[0] === 'auth' && args[1] === 'status') {
  const s = read();
  process.stdout.write(JSON.stringify({
    loggedIn: !!s.loggedIn,
    authMethod: 'claude.ai',
    email: s.email || null,
  }) + '\n');
  process.exit(s.loggedIn ? 0 : 1);
}

if (args[0] === 'auth' && args[1] === 'login') {
  const mode = process.env.FAKE_CLAUDE_LOGIN_MODE || 'success';
  if (mode === 'hang') {
    setInterval(() => {}, 1 << 30);
  } else if (mode === 'fail') {
    process.stderr.write('Unable to open browser: display not found\n');
    process.exit(1);
  } else {
    setTimeout(() => {
      try { fs.writeFileSync(stateFile, JSON.stringify({ loggedIn: true, email: 'fake@example.com' })); } catch { /* no state file */ }
      process.stdout.write('Login successful\n');
      process.exit(0);
    }, 150);
  }
} else if (!(args[0] === 'auth' && args[1] === 'status')) {
  process.stderr.write(`fake-claude: unsupported args ${args.join(' ')}\n`);
  process.exit(2);
}
