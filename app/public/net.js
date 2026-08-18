// net.js — the wire, split verbatim out of app.js (phase 2): the HTTP wrapper
// and the WebSocket lifecycle (connect/reconnect, half-open staleness sweep,
// test hook).

import { toast } from './util.js';
import { loadState, renderAll, handleEvent } from './app.js';

/* ───────────────────────── toast + fetch ───────────────────────── */

/**
 * JSON fetch wrapper — resolves with the parsed response body, or null after
 * toasting on any failure (non-2xx, network error); `opts.quiet` suppresses
 * the toast.
 * @param {string} method
 * @param {string} url
 * @param {*} [body] JSON-encoded when not undefined
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<any>} parsed JSON (or {} for a non-JSON 2xx) | null
 */
export async function api(method, url, body, opts = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      if (!opts.quiet) toast(`${method} ${url} → ${data.error || res.status}`);
      return null;
    }
    return data;
  } catch (err) {
    if (!opts.quiet) toast(`${method} ${url} failed: ${err.message || err}`);
    return null;
  }
}
/** @type {(method: string, url: string, body?: any) => Promise<any>} */
export const apiQuiet = (m, u, b) => api(m, u, b, { quiet: true });

/* ───────────────────────── websocket ───────────────────────── */

let wsFirst = true;
/** @type {WebSocket | null} */
let wsCur = null;     // the live socket — the staleness sweep below closes it
let wsLastMsg = 0;    // when the last message (any type, incl. ticks) arrived
/**
 * Open (or re-open) the /ws socket; reconnects itself every 3s on close and
 * re-syncs state on every reconnect after the first.
 * @returns {void}
 */
export function connectWS() {
  let ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'; // https when proxied (tailscale serve)
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { setTimeout(connectWS, 3000); return; }
  wsCur = ws;
  wsLastMsg = Date.now();
  ws.onopen = async () => {
    wsLastMsg = Date.now();
    if (!wsFirst) { await loadState(); renderAll(); }
    wsFirst = false;
  };
  ws.onmessage = (ev) => {
    wsLastMsg = Date.now();
    /** @type {WsEvent} */
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { handleEvent(msg.type, msg.payload); }
    catch (err) { console.warn('[ui] event handler error', msg.type, err); }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

/* Half-open detection. A slept laptop (or a dropped VPN path) leaves the
   socket readyState OPEN but dead: onclose never fires, broadcasts silently
   vanish, and the page goes stale while plain HTTP still works. The server
   ticks every 25s, so >60s of silence means the pipe is gone — close it and
   let onclose's reconnect + loadState() resync everything. A focus nudge
   catches the wake-from-sleep case immediately instead of up to 60s later. */
/**
 * Close the socket if it has been silent longer than quietMs (half-open pipe)
 * so the onclose reconnect path can heal the page.
 * @param {number} quietMs
 * @returns {void}
 */
export function wsCloseIfStale(quietMs) {
  if (wsCur && wsCur.readyState === WebSocket.OPEN && Date.now() - wsLastMsg > quietMs) {
    try { wsCur.close(); } catch { /* noop */ }
  }
}
setInterval(() => wsCloseIfStale(60_000), 15_000);
window.addEventListener('focus', () => wsCloseIfStale(45_000));
window.addEventListener('online', () => wsCloseIfStale(45_000));
window.__wsCloseIfStale = wsCloseIfStale; // test hook (module scope hides it)
