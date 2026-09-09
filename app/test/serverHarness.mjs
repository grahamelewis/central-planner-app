// test/serverHarness.mjs — boot a fully sandboxed Central Planner server.
// A throwaway data ROOT + two throwaway project roots in os.tmpdir(), a free
// port, and CP_* env overrides (see lib/config.js) so the child process never
// reads or writes the real projectManager folder, never collides with the
// live server on 4242, and never sends ntfy pushes.
//
// SAFE ROUTES ONLY: tests must never POST /api/tasks/:p/:id/launch, /message,
// or /api/profile/generate — those spawn real billed Claude sessions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* ── Monaco boot-failure injection (Phase 3 S1, monaco-s05 §A6 test spec) ──
   Injection is SERVER-SIDE — a tiny HTTP proxy in front of the sandbox that
   the page uses as its origin — never page.route: Playwright's page-level
   interception does not reliably see dedicated-worker importScripts, while a
   real HTTP hop covers every fetch surface. Modes: block = 404 · corrupt =
   truncate to 700 bytes · hang = never respond. Targets match by
   hash-PREFIX regexes (the dist's chunk names are content-hashed — never
   hard-code a hash, per A5). */
const VENDOR_TARGETS = {
  loader: /^\/vendor\/monaco\/vs\/loader\.js(\?|$)/,
  core: /^\/vendor\/monaco\/vs\/editor-[\w-]+\.js(\?|$)/,
  css: /^\/vendor\/monaco\/vs\/editor\/editor\.main\.css(\?|$)/,
  worker: /^\/vendor\/monaco\/vs\/assets\/editor\.worker-[\w-]+\.js(\?|$)/,
};

function vendorTargetRe(target) {
  if (VENDOR_TARGETS[target]) return VENDOR_TARGETS[target];
  const m = /^lang:([a-z0-9_]+)$/.exec(String(target));
  if (m) return new RegExp(`^/vendor/monaco/vs/${m[1]}-[\\w-]+\\.js(\\?|$)`);
  throw new Error(`unknown vendor injection target: ${target}`);
}

async function startVendorProxy(upstreamPort) {
  const port = await freePort();
  let rules = []; // [{ re, kind: 'block' | 'corrupt' | 'hang' }]
  const hits = []; // /vendor/monaco/* URLs the page actually requested
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/vendor/monaco/')) hits.push(url);
    const rule = rules.find((r) => r.re.test(url));
    if (rule && rule.kind === 'block') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('injected 404 (vendor proxy)');
      return;
    }
    if (rule && rule.kind === 'hang') {
      req.resume(); // stall forever — the socket is destroyed at stop()
      return;
    }
    const up = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      path: url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (ur) => {
      if (rule && rule.kind === 'corrupt') {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          const buf = Buffer.concat(chunks).subarray(0, 700);
          const h = { ...ur.headers };
          delete h['content-length'];
          delete h['transfer-encoding'];
          delete h['content-encoding'];
          delete h.etag;
          delete h['last-modified'];
          res.writeHead(ur.statusCode || 200, { ...h, 'content-length': String(buf.length) });
          res.end(buf);
        });
        return;
      }
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* torn down */ } });
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    /** Arm rules: [{ target: 'loader'|'core'|'css'|'worker'|'lang:<id>', kind }] (or a single object). */
    set(list) {
      rules = (Array.isArray(list) ? list : [list])
        .map((r) => ({ re: r.re || vendorTargetRe(r.target), kind: r.kind }));
      hits.length = 0;
    },
    clear() { rules = []; hits.length = 0; },
    hits: () => hits.slice(),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      // Stop accepting before dropping sockets, including injected hangs.
      // Otherwise a late worker request can slip between the two operations.
      try { server.closeAllConnections?.(); } catch { /* node < 18.2 */ }
    }),
  };
}

/**
 * Boot a sandboxed server. `seed({ root, projRoots })` runs after the dirs
 * exist but before the server starts — drop fixture files there.
 * `monacoProxy: true` adds the vendor failure-injection proxy (returned as
 * `vendor: { base, set, clear, hits }` — point the page at vendor.base).
 * Returns { base, root, projRoots, fetchJson, rawRequest, poll, logs, stop }.
 */
export async function startSandbox({ seed, trial = [], extraProjects = {}, kaimonBin, updateRepo, claudeBin, monacoProxy = false } = {}) {
  // realpath: os.tmpdir() is a symlink on macOS (/var → /private/var), and a
  // symlinked project root makes containedPath's lexical check reject real
  // paths handed back from its own realpath step (production roots are real)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sandbox-')));
  const projRoots = {};
  for (const key of ['alpha', 'beta']) {
    projRoots[key] = path.join(root, `proj-${key}`);
    fs.mkdirSync(projRoots[key], { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'abstracts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'categories.json'), JSON.stringify({
    calibration: { name: 'calibration', primer: 'Calibration primer text.' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'abstracts', 'alpha.md'), '# Alpha abstract\n');
  if (seed) await seed({ root, projRoots });

  // extraProjects: raw entries placed FIRST in the projects block (e.g. the
  // `"//": "comment"` string config.example.json ships) — key order matters
  // to the derived pin rule
  const projects = { ...extraProjects };
  for (const [key, proot] of Object.entries(projRoots)) {
    projects[key] = { name: key, root: proot, color: '#aabbcc', texWatch: null, trial: trial.includes(key) };
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // belt-and-braces on top of CP_NO_BILLED: even if a guard is missed,
      // the sandboxed server holds no API credential to bill with
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '', // memory worker must never inherit a real credential
      CP_ROOT: root,
      CP_PORT: String(port),
      CP_PROJECTS_JSON: JSON.stringify(projects),
      CP_NTFY_TOPIC: '', // never push from tests
      CP_NO_BILLED: '1', // hard-block billed Claude dispatch (defense-in-depth)
      // kaimon: deterministic OFF — the dev machine may have the real binary
      // (available:true locally / false on CI → flaky assertions), and no test
      // may ever spawn a real Julia daemon or write to ~/.config/kaimon
      CP_KAIMON_BIN: kaimonBin || '/nonexistent-kaimon',
      CP_KAIMON_CONFIG_DIR: path.join(root, 'kaimon-config'),
      // self-updater: point at the sandbox root (not a git repo) so no test
      // ever `git fetch`es the real dashboard checkout; a dedicated test can
      // pass a fixture clone via updateRepo
      CP_UPDATE_REPO: updateRepo || root,
      // auth: never run the REAL claude CLI from a sandbox (a login would pop
      // the dev machine's browser); dedicated tests inject a fake via claudeBin
      CP_CLAUDE_BIN: claudeBin || '/nonexistent-claude-cli',
      CP_AUTH_BOOT_MS: '150', // boot check runs fast (no-op with the pin above)
      // Same guard for Codex: boot/model/account checks must never touch the
      // developer's real CLI or account from the test sandbox.
      CP_CODEX_BIN: '/nonexistent-codex-cli',
      CP_CODEX_BOOT_MS: '150',
      // Tailnet controls must never inspect or mutate the developer machine's
      // real Tailscale Serve configuration from a sandbox.
      CP_TAILSCALE_BIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  // wait until /api/state answers
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`sandbox server exited before becoming ready:\n${logs}`);
    }
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw new Error(`sandbox server never became ready:\n${logs}`);
    }
    await new Promise((res) => setTimeout(res, 100));
  }

  /** fetch a JSON API route → { status, body, headers }. */
  async function fetchJson(method, route, body) {
    const r = await fetch(base + route, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  }

  /**
   * Raw HTTP request with the path sent byte-for-byte (fetch/URL normalize
   * dot segments — including %2e%2e — which defeats traversal tests).
   */
  function rawRequest(method, rawPath, body) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.connect(port, '127.0.0.1', () => {
        const payload = body !== undefined ? JSON.stringify(body) : '';
        socket.write(
          `${method} ${rawPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: close\r\n' +
          (payload
            ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
            : '') +
          '\r\n' + payload);
      });
      socket.on('data', (d) => chunks.push(d));
      socket.on('error', reject);
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = Number((text.match(/^HTTP\/1\.1 (\d+)/) || [])[1]) || 0;
        resolve({ status, text });
      });
    });
  }

  /** Re-fetch `route` until `pred(body)` is truthy (default timeout 10s). */
  async function poll(route, pred, { timeoutMs = 10000, everyMs = 100 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await fetchJson('GET', route);
      if (pred(body)) return body;
      if (Date.now() > end) {
        throw new Error(`poll timed out on ${route}; last body: ${JSON.stringify(body).slice(0, 500)}`);
      }
      await new Promise((res) => setTimeout(res, everyMs));
    }
  }

  const vendor = monacoProxy ? await startVendorProxy(port) : null;

  return {
    base,
    root,
    projRoots,
    vendor,
    fetchJson,
    rawRequest,
    poll,
    logs: () => logs,
    async stop() {
      if (vendor) await vendor.close(); // first: destroys any injected hung sockets
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 3000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
      });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
