#!/usr/bin/env node
// Fake kaimon binary for billing-safe tests. Honors the real CLI surface the
// dashboard uses (`--headless -p PORT`) and serves HTTP on /mcp — enough for
// lib/kaimon.js's spawn + readiness-poll + kill lifecycle. Failure modes for
// the retry/cooldown paths via FAKE_KAIMON_MODE:
//   (unset)        listen and answer /mcp (the happy path)
//   never-listens  start but never open the port (boot-timeout path)
//   exit-1         die immediately (bind-failure/retry path)
import http from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('-p') + 1] || 0);
const mode = process.env.FAKE_KAIMON_MODE || '';

if (mode === 'exit-1') process.exit(1);
if (mode === 'never-listens') {
  setInterval(() => {}, 1 << 30); // stay alive, never bind
} else {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jsonrpc":"2.0","id":0,"result":{}}');
  });
  srv.listen(port, '127.0.0.1');
}
// die on SIGTERM like the real daemon (default handler); keep running otherwise
