// The half-open-socket recovery. A slept laptop (or dropped VPN path) leaves
// the WS readyState OPEN but dead: onclose never fires, broadcasts silently
// vanish, and the page shows stale state forever while plain HTTP still
// works (the 2026-07-17 "waiting for first build…" incident — the server had
// reached built, the page never heard). The server ticks every 25s; the
// frontend closes a socket that has been silent too long, and the normal
// reconnect + loadState() resync takes it from there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };

let ui, sb, page;
before(async () => {
  if (!fs.existsSync(CHROME)) return;
  ui = await startUI();
  ({ sb, page } = ui);
  await page.goto(sb.base);
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

test('a silent-but-OPEN socket is closed and the page reconnects with a resync', opts, async () => {
  const r = await page.evaluate(async () => {
    const old = window.__ws;
    window.WebSocket.OPEN = 1; // opt in: the stub omits it so the sweep idles in other tests
    const fetches = [];
    const of = window.fetch;
    window.fetch = (...a) => { fetches.push(String(a[0])); return of(...a); };
    window.__wsCloseIfStale(1); // treat >1ms of silence as fatal — page loaded ages ago
    await new Promise((res) => setTimeout(res, 3600)); // reconnect arms after 3s
    window.fetch = of;
    return {
      closed: old.readyState === 3,
      fresh: window.__ws !== old && window.__ws.readyState === 1,
      resynced: fetches.some((u) => u.includes('/api/state')),
    };
  });
  assert.equal(r.closed, true, 'the stale socket was closed');
  assert.equal(r.fresh, true, 'a fresh socket reconnected');
  assert.equal(r.resynced, true, 'reconnect refetched /api/state (the resync)');
});

test('a healthy socket (recent message) is left alone', opts, async () => {
  const r = await page.evaluate(() => {
    const cur = window.__ws;
    // a tick just arrived
    cur.onmessage({ data: JSON.stringify({ type: 'tick', payload: { t: 1 } }) });
    window.__wsCloseIfStale(45000);
    return { sameSocket: window.__ws === cur, open: cur.readyState === 1 };
  });
  assert.equal(r.sameSocket, true, 'socket not replaced');
  assert.equal(r.open, true, 'socket still open');
});
