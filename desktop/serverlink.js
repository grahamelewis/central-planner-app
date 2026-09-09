// desktop/serverlink.js — the shell's server link: lifecycle + notifier.
// Process ownership remains outside this pure module: main.js injects start
// and stop effects. The lifecycle serializes their decisions alongside attach,
// launchd wait, and occupied-port refusal. The launchctl use here remains the
// READ-ONLY `launchctl list local.projectmanager` query, and nothing imports
// electron: every effectful
// dependency (fetch, net, execFile, fs, ws, timers, clock) is injectable so
// test/lifecycle.test.mjs runs under plain `node --test` with fakes only.
// The notifier half (createNotifier: the one WS + native banners) sits at the
// bottom of this file under the same injectability rule.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4242;
const MIN_VISIBLE = 100; // px of window that must land on some display to keep saved bounds

export const STATES = {
  CONNECTING: 'CONNECTING',             // pre-decision / transient TIMEOUT — default splash
  STARTING_SERVER: 'STARTING_SERVER',   // no server + no launchd: desktop-owned child is booting
  ATTACH: 'ATTACH',                     // healthy server found; caller loadURLs, loop ends
  WAIT_LAUNCHD: 'WAIT_LAUNCHD',         // REFUSED + job loaded: KeepAlive is bringing it back
  SERVER_ABSENT: 'SERVER_ABSENT',       // REFUSED + job not loaded: splash with start instructions
  SERVER_FAILED: 'SERVER_FAILED',       // owned child failed to spawn or missed its readiness budget
  BLOCKED_OCCUPIED: 'BLOCKED_OCCUPIED', // the §4 diagram's BLOCKED_FOREIGN box; reason: 'foreign' | 'occupied'
};

const validPort = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535;

// The production launcher pins its data root. Resolve the same binding BEFORE
// probing, even when the shell inherited CP_ROOT for an older checkout. A
// partial/corrupt installation must not silently fall back to a blank dashboard.
export function installationDataRoot(repoRoot, { fs: fsi = fs } = {}) {
  if (!repoRoot) return null;
  const root = path.resolve(repoRoot);
  const marker = path.join(root, '.central-planner-installation.json');
  const pointer = path.join(root, 'deployment.json');
  const stat = file => {
    try { return fsi.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const markerStat = stat(marker), pointerStat = stat(pointer);
  if (!markerStat && !pointerStat) return null; // ordinary legacy checkout
  const ordinaryFile = value => value && value.isFile() && !value.isSymbolicLink();
  if (!ordinaryFile(markerStat) || !ordinaryFile(pointerStat)) throw new Error('Invalid production installation metadata');
  const owner = JSON.parse(fsi.readFileSync(marker, 'utf8'));
  const config = JSON.parse(fsi.readFileSync(pointer, 'utf8'));
  const id = /^release-[0-9a-f-]{36}$/;
  if (!owner || !config || owner.version !== 1 || config.version !== 1
    || owner.installationRoot !== fsi.realpathSync(root)
    || typeof owner.sourceRoot !== 'string' || !path.isAbsolute(owner.sourceRoot)
    || typeof owner.dataRoot !== 'string' || !path.isAbsolute(owner.dataRoot)
    || config.sourceRoot !== owner.sourceRoot || config.dataRoot !== owner.dataRoot
    || !id.test(config.active) || (config.previous !== null && !id.test(config.previous))) {
    throw new Error('Production installation ownership and pointer disagree');
  }
  const data = stat(config.dataRoot);
  if (!data || !data.isDirectory() || data.isSymbolicLink()
    || fsi.realpathSync(config.dataRoot) !== config.dataRoot) throw new Error('Production data root is missing or changed');
  return config.dataRoot;
}

// Port resolution — mirrors app/lib/config.js:21-24,:50 (coupling #1):
// CP_PORT env → config.json "port" (located via CP_ROOT env, else the repo
// root = parent of desktop/) → 4242. Garbage falls through to the next source
// WITH a log line; '' counts as absent (config.js gates on truthiness); a
// missing config.json is a normal fresh clone and stays silent. repoRoot is a
// checkout override. A validated installation instead pins its recorded data root.
export function resolvePort({ env = process.env, readFile = fs.readFileSync, log = () => {}, repoRoot } = {}) {
  const installedRoot = installationDataRoot(repoRoot);
  const root = installedRoot || (env.CP_ROOT ? path.resolve(env.CP_ROOT) : (repoRoot ?? path.resolve(DESKTOP_DIR, '..')));
  if (env.CP_PORT) {
    if (validPort(env.CP_PORT)) return Number(env.CP_PORT);
    log(`port: invalid CP_PORT "${env.CP_PORT}" — falling through`);
  }
  let raw;
  try {
    raw = readFile(path.join(root, 'config.json'), 'utf8');
  } catch {
    return DEFAULT_PORT; // no config.json yet — fresh clone, silent (config.js:34-36)
  }
  try {
    const cfg = JSON.parse(raw);
    const p = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg.port : undefined;
    if (p !== undefined) {
      if (validPort(p)) return Number(p);
      log(`port: invalid config.json "port" ${JSON.stringify(p)} — falling through`);
    }
  } catch (err) {
    log(`port: config.json unparseable (${err.message}) — falling through`);
  }
  return DEFAULT_PORT;
}

// Identity check (coupling #2): HEALTHY iff 200 + JSON name === "Central
// Planner". Any other HTTP answer — 404, 500, wrong name, non-JSON — is a
// FOREIGN process answering on our port.
export function classifyProbe({ status, body }) {
  if (status === 200) {
    try { if (JSON.parse(body).name === 'Central Planner') return 'HEALTHY'; } catch {}
  }
  return 'FOREIGN';
}

// Walk err.cause chains (incl. AggregateError.errors from Node fetch's
// happy-eyeballs) looking for a syscall code. Depth-capped against cycles.
function hasCode(err, code) {
  for (let e = err, i = 0; e && i < 8; e = e.cause, i++) {
    if (e.code === code) return true;
    if (Array.isArray(e.errors) && e.errors.some((x) => x && x.code === code)) return true;
  }
  return false;
}

// The only HTTP probe the shell ever makes (I3). Never throws.
// REFUSED is ECONNREFUSED only (§4 diagram); unexpected network errors map to
// TIMEOUT — conservative: TIMEOUT just re-probes at 5 s and runs the TCP
// check, it never claims WAIT/ABSENT evidence it doesn't have.
export async function probe({ port, fetchImpl = globalThis.fetch, timeoutMs = 1500, log = () => {} }) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/m/manifest.webmanifest`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', cache: 'no-store',
    });
    return classifyProbe({ status: res.status, body: await res.text() });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'TIMEOUT';
    if (hasCode(err, 'ECONNREFUSED')) return 'REFUSED';
    log(`probe: unexpected error ${err?.cause?.code || err?.code || err?.message || err} — treating as TIMEOUT`);
    return 'TIMEOUT';
  }
}

// Raw-TCP check, used only after a TIMEOUT classification: something holding
// the port open without answering HTTP (e.g. a SIGSTOP'd server, F26) is
// OCCUPIED, not absent.
export function tcpAccepts({ port, connect = net.connect, timeoutMs = 1000 }) {
  return new Promise((resolve) => {
    let sock;
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      try { sock?.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    try { sock = connect({ host: '127.0.0.1', port }); } catch { return finish(false); }
    timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

// READ-ONLY launchd query (coupling #3) — exit 0 means the job is loaded.
// A missing launchctl (non-darwin dev box) is "not loaded" with a log line:
// SERVER_ABSENT is the honest splash when launchd evidence is unavailable.
export function launchdLoaded({ execFile = execFileCb, log = () => {} } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('launchctl', ['list', 'local.projectmanager'], (err) => {
        if (!err) return resolve(true);
        if (err.code === 'ENOENT') log('launchctl: binary missing — treating job as not loaded');
        resolve(false);
      });
    } catch (err) {
      log(`launchctl: query failed (${err.message}) — treating job as not loaded`);
      resolve(false);
    }
  });
}

// The single-flight reconcile loop (I8). One generation is active at a time;
// trigger() joins the active loop (collapsing a pending sleep, or riding an
// in-flight probe) and only starts a NEW generation when the loop is idle.
// dispose()/supersession makes every pending continuation inert. The port is
// re-resolved every iteration (G11). Consecutive identical states are deduped
// before onState (no splash-reload flicker); every decision is logged with
// its evidence regardless (§2 shell-log row).
export function createLifecycle({
  resolvePort: resolvePortDep,
  probe: probeDep,
  tcpAccepts: tcpDep,
  launchdLoaded: launchdDep,
  startServer: startServerDep,
  stopServer: stopServerDep = async () => {},
  onState,
  log = () => {},
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  now = Date.now,
}) {
  let gen = 0;
  let active = false;
  let timer = null;
  let inFlight = false;
  let waitSince = null;  // start of the current contiguous WAIT_LAUNCHD stretch
  let lastState = null;
  let startAttempted = false;
  let startSince = null;
  let startFailed = null;

  const stale = (g) => g !== gen || !active;

  function emit(s) {
    const same = lastState && lastState.name === s.name
      && lastState.reason === s.reason && lastState.port === s.port;
    lastState = s;
    if (!same) onState(s);
  }

  function schedule(g, ms) {
    timer = setT(() => { timer = null; if (!stale(g)) iterate(g); }, ms);
  }

  async function iterate(g) {
    inFlight = true;
    try {
      let port;
      try { port = resolvePortDep(); }
      catch (error) {
        const reason = error?.message || String(error);
        log(`lifecycle: invalid server configuration (${reason})`);
        emit({ name: STATES.SERVER_FAILED, reason, gen: g });
        return schedule(g, 5000);
      }
      const cls = await probeDep(port);
      if (stale(g)) return;
      log(`lifecycle: gen ${g} port ${port} probe ${cls}`);
      if (cls === 'HEALTHY') {
        waitSince = null;
        emit({ name: STATES.ATTACH, port, gen: g });
        active = false; // attach ends this generation's loop
        return;
      }
      if (cls === 'FOREIGN') {
        waitSince = null;
        if (startAttempted) {
          try { await stopServerDep('port became occupied by a foreign HTTP service'); }
          catch (err) { log(`lifecycle: gen ${g} owned stop failed (${err?.message || err})`); }
        }
        emit({ name: STATES.BLOCKED_OCCUPIED, reason: 'foreign', port, gen: g });
        return schedule(g, 5000);
      }
      if (cls === 'TIMEOUT') {
        const up = await tcpDep(port);
        if (stale(g)) return;
        log(`lifecycle: gen ${g} tcp ${up ? 'accepts' : 'refuses'}`);
        waitSince = null;
        if (up) {
          emit({ name: STATES.BLOCKED_OCCUPIED, reason: 'occupied', port, gen: g });
          return schedule(g, 5000);
        }
        if (startAttempted && !startFailed) {
          emit({ name: STATES.STARTING_SERVER, port, gen: g });
          return schedule(g, 500);
        }
        emit({ name: STATES.CONNECTING, port, gen: g }); // transient — stay on the default splash
        return schedule(g, 5000);
      }
      // REFUSED → consult launchd (read-only) for WAIT vs ABSENT
      const loaded = await launchdDep();
      if (stale(g)) return;
      log(`lifecycle: gen ${g} launchd ${loaded ? 'loaded' : 'not loaded'}`);
      if (loaded) {
        if (waitSince === null) waitSince = now();
        emit({ name: STATES.WAIT_LAUNCHD, port, gen: g });
        // cadence: 1 s for the first 20 s of a contiguous WAIT stretch, then 5 s forever
        return schedule(g, now() - waitSince < 20000 ? 1000 : 5000);
      }
      waitSince = null;
      if (typeof startServerDep !== 'function') {
        emit({ name: STATES.SERVER_ABSENT, port, gen: g });
        return schedule(g, 5000);
      }
      if (startFailed) {
        emit({ name: STATES.SERVER_FAILED, reason: startFailed, port, gen: g });
        return schedule(g, 5000);
      }
      if (!startAttempted) {
        startAttempted = true;
        startSince = now();
        emit({ name: STATES.STARTING_SERVER, port, gen: g });
        try {
          await startServerDep(port);
        } catch (err) {
          if (stale(g)) return;
          startFailed = err?.message || String(err);
          log(`lifecycle: gen ${g} owned start failed (${startFailed})`);
          emit({ name: STATES.SERVER_FAILED, reason: startFailed, port, gen: g });
          return schedule(g, 5000);
        }
        if (stale(g)) return;
        return schedule(g, 250);
      }
      if (now() - startSince >= 15000) {
        startFailed = 'server did not become ready within 15 seconds';
        try { await stopServerDep(startFailed); }
        catch (err) { log(`lifecycle: gen ${g} owned stop failed (${err?.message || err})`); }
        if (stale(g)) return;
        emit({ name: STATES.SERVER_FAILED, reason: startFailed, port, gen: g });
        return schedule(g, 5000);
      }
      emit({ name: STATES.STARTING_SERVER, port, gen: g });
      return schedule(g, 500);
    } finally {
      inFlight = false;
    }
  }

  return {
    trigger(reason = '') {
      log(`lifecycle: trigger(${reason}) gen ${gen} active ${active}`);
      if (!active) {
        gen += 1;
        active = true;
        waitSince = null;
        startAttempted = false;
        startSince = null;
        startFailed = null;
        lastState = null;
        iterate(gen);
      } else if (timer !== null) {
        clearT(timer);   // join: collapse the sleep, probe now, same generation
        timer = null;
        iterate(gen);
      }
      // else: a probe is in flight — it IS the immediate probe; no-op
    },
    dispose() {
      gen += 1;          // every pending timer and in-flight await goes stale
      active = false;
      inFlight = false;
      if (timer !== null) { clearT(timer); timer = null; }
    },
    get generation() { return gen; },
    get state() { return lastState; },
  };
}

// Append-only shell log with a single ~1 MB rotation to shell.log.1 (§2 shell
// log row). Never throws — logging can never crash or wedge the shell.
export function shellLog(dir, { fs: fsi = fs, maxBytes = 1024 * 1024, now = () => new Date() } = {}) {
  const file = path.join(dir, 'shell.log');
  let bytes = 0;
  try { fsi.mkdirSync(dir, { recursive: true }); } catch { /* log() will no-op */ }
  try { bytes = fsi.statSync(file).size; } catch { /* fresh file */ }
  return {
    path: file,
    log(line) {
      try {
        const entry = `${now().toISOString()} ${line}\n`;
        fsi.appendFileSync(file, entry); // O_APPEND — atomic enough per write for a log
        bytes += Buffer.byteLength(entry);
        if (bytes > maxBytes) {
          fsi.renameSync(file, `${file}.1`); // single rotation — overwrites any previous .1
          bytes = 0;
        }
      } catch { /* swallowed by design */ }
    },
  };
}

// Classify a CSS background-color string as a 'light' or 'dark' theme by
// relative luminance; null = no signal (unparseable, or fully transparent).
// The shell reads the PAGE's computed background and mirrors it into
// nativeTheme, so the macOS title bar follows the dashboard's own theme
// choice instead of the system appearance (Graham, 2026-08-07 — light page
// was rendering under a dark system title bar).
export function themeFromBackground(bg) {
  // String.match, not RegExp-dot-e-x-e-c — the I1/I2 source scan is strict
  const m = String(bg || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null; // transparent
  const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  return lum >= 128 ? 'light' : 'dark';
}

// Saved window bounds are kept only when ≥ MIN_VISIBLE×MIN_VISIBLE px land on
// some connected display's workArea; otherwise null → caller re-centers (F24).
export function sanitizeBounds(bounds, displays) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const visible = (Array.isArray(displays) ? displays : []).some((d) => {
    const a = d && d.workArea;
    if (!a) return false;
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
    return w >= MIN_VISIBLE && h >= MIN_VISIBLE;
  });
  return visible ? bounds : null;
}

// did-fail-load filter (G12/F11): intervene only for a main-frame failure on
// the current generation that isn't ERR_ABORTED (-3, incl. draft-vetoed
// reloads) or an expected connecting.html transition. An undefined generation
// (a navigation main.js never tagged) is NOT stale — it intervenes when the
// other filters pass.
export function shouldIntervene(failEvent, currentGen) {
  if (!failEvent || !failEvent.isMainFrame) return false;
  if (failEvent.errorCode === -3) return false;
  if (typeof failEvent.validatedURL === 'string' && failEvent.validatedURL.includes('connecting.html')) return false;
  if (Number.isInteger(failEvent.generation) && failEvent.generation !== currentGen) return false;
  return true;
}

// ---------------------------------------------------------------- notifier (T3)

const NOTIFY_BACKOFF_MIN = 5000;   // first reconnect delay
const NOTIFY_BACKOFF_MAX = 60000;  // backoff cap — the connects/min bound is a test (I3/G9)
const NOTIFY_WATCHDOG_MS = 60000;  // server ticks every 25 s (coupling #9): 60 s silent = half-open (G10)
const NOTIFY_CAP = 500;            // persisted-identity cap, pruned oldest-first

// Banner bodies stay generic and short — privacy default mirroring notify.js:
// never tool input, question text, or error text (§2 notification row).
const NOTIFY_BODIES = {
  approval: 'A tool call is waiting for approval.',
  question: 'Open Central Planner to answer.',
  handoff: 'A handoff summary is ready to review.',
  signin: 'Sign in from the dashboard to continue.',
  failed: 'Open Central Planner for details.',
};

// FNV-1a 32-bit → 8 hex chars. Deterministic across restarts (identities are
// persisted) with no crypto import — a de-dupe key, not a security hash.
function hashText(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The desktop notifier: ONE persistent WS to /ws (I3), the F1-corrected event
// map, snapshot reconciliation, persisted de-dupe, 60 s watchdog, capped
// backoff, focus+project suppression. Every effectful dep is injectable; the
// module never imports electron — main.js passes the real WebSocket global and
// Electron's Notification. Delivery is best-effort by design (R6): ntfy stays
// the durable channel.
export function createNotifier({
  getPort,                          // re-resolved on EVERY connect (G11)
  WebSocketImpl,
  NotificationImpl,
  statePath,                        // notify-state.json (main.js: under userData)
  isFocusedOnProject = () => false,
  onClick = () => {},
  log = () => {},
  fs: fsi = fs,
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  now = Date.now,
}) {
  let sock = null;
  let sockGen = 0;        // staleness token: teardown bumps it, so late close/error/
                          // watchdog callbacks from an abandoned socket are inert
  let reconnectTimer = null;
  let watchdogTimer = null;
  let backoffMs = NOTIFY_BACKOFF_MIN;
  let disposed = false;
  let started = false;
  let connected = false;
  const notified = new Map();    // identity → ts; Map insertion order IS age order
  const permBanners = new Map(); // String(requestId) → live banner, closed on :resolved
  const titles = new Map();      // `${project}:${id}` → task title, seeded by every frame
  let turnEndNotifications = true; // legacy servers omit the preference

  // -- persistence: {v:1, entries:[[identity, ts], ...]} — atomic tmp+rename;
  //    failures are logged, never thrown (shellLog culture).
  function loadState() {
    let raw;
    try { raw = fsi.readFileSync(statePath, 'utf8'); } catch { return; } // fresh install — silent
    try {
      const data = JSON.parse(raw);
      if (data && data.v === 1 && Array.isArray(data.entries)) {
        for (const e of data.entries) {
          if (Array.isArray(e) && typeof e[0] === 'string') notified.set(e[0], Number(e[1]) || 0);
        }
      }
    } catch (err) {
      log(`notify: state unparseable (${err.message}) — starting empty`);
    }
  }

  function persistState() {
    try {
      fsi.writeFileSync(`${statePath}.tmp`, JSON.stringify({ v: 1, entries: [...notified] }));
      fsi.renameSync(`${statePath}.tmp`, statePath);
    } catch (err) {
      log(`notify: state write failed (${err.message})`);
    }
  }

  // -- socket lifecycle (I3: one live socket ever) -------------------------

  function teardown(gen, why) {
    if (gen !== sockGen) return; // stale caller — a newer socket already exists
    sockGen += 1;                // invalidate every handler captured on this socket
    connected = false;
    if (watchdogTimer !== null) { clearT(watchdogTimer); watchdogTimer = null; }
    const s = sock;
    sock = null;
    if (s) {
      try { s.close?.(); } catch { /* already gone */ }
      log(`notify: socket down (${why})`);
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, NOTIFY_BACKOFF_MAX);
    log(`notify: reconnect in ${delay} ms`);
    reconnectTimer = setT(() => { reconnectTimer = null; connect(); }, delay);
  }

  function armWatchdog(gen) {
    if (watchdogTimer !== null) clearT(watchdogTimer);
    watchdogTimer = setT(() => {
      watchdogTimer = null;
      if (gen !== sockGen || disposed) return;
      // 60 s of silence against a 25 s tick means a half-open socket, not a
      // down server — reconnect immediately, not via backoff; worst case is
      // still only 1 connect/min (G10/F13).
      log('notify: watchdog — 60 s of silence, reconnecting');
      teardown(gen, 'watchdog');
      connect();
    }, NOTIFY_WATCHDOG_MS);
  }

  function connect() {
    if (disposed) return;
    if (reconnectTimer !== null) { clearT(reconnectTimer); reconnectTimer = null; }
    const gen = ++sockGen;
    const port = getPort();
    let s;
    try {
      s = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`);
    } catch (err) {
      log(`notify: ws construct failed (${err.message})`);
      return scheduleReconnect();
    }
    sock = s;
    log(`notify: connecting gen ${gen} port ${port}`);
    s.onopen = () => {
      if (gen !== sockGen || disposed) return;
      connected = true;
      log(`notify: connected gen ${gen}`);
      armWatchdog(gen);
    };
    s.onmessage = (ev) => {
      if (gen !== sockGen || disposed) return;
      armWatchdog(gen); // ANY inbound frame is liveness — tick included
      // reset ONLY on an inbound frame, never on bare open: an accept-then-
      // close flapper keeps climbing the ladder, holding the G9 bound (each
      // WS connect costs the server a full snapshot plus subprocess work)
      backoffMs = NOTIFY_BACKOFF_MIN;
      handleFrame(ev && ev.data);
    };
    const down = (why) => () => {
      if (gen !== sockGen || disposed) return;
      teardown(gen, why); // gen bump makes the error-then-close double-fire inert
      scheduleReconnect();
    };
    s.onclose = down('close');
    s.onerror = down('error');
  }

  // -- frame handling: the F1-corrected event map (§2) ---------------------

  function handleFrame(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); }
    catch { return log('notify: unparseable frame ignored'); }
    if (!msg || typeof msg !== 'object') return;
    const p = msg.payload;
    switch (msg.type) {
      case 'state': return onSnapshot(p);
      case 'task:update': return onTaskUpdate(p);
      case 'session:permission': return onPermission(p);
      case 'session:permission:resolved': return onPermissionResolved(p);
      case 'session:status': return onSessionStatus(p);
      default: // 'tick' and unknown types: the watchdog reset above is all they do
    }
  }

  const titleKey = (project, id) => `${project}:${id}`;
  function rememberTitle(project, task) {
    if (task.id != null && typeof task.title === 'string' && task.title) {
      titles.set(titleKey(project, task.id), task.title);
    }
  }
  const titleOf = (project, id) => titles.get(titleKey(project, id)) || String(id);

  // The hash-bearing identity set IS the transition detector: null→text fires
  // (new identity), same text twice de-dupes (member), a different text fires
  // (new hash) — and snapshot reseeding falls out of the same membership check.
  function questionBanner(project, task) {
    fire({
      identity: `q:${project}:${task.id}:${hashText(task.question)}`,
      title: `❓ ${titleOf(project, task.id)} — Claude is asking`,
      body: NOTIFY_BODIES.question,
      project,
    });
  }

  // No hash by contract: a handoff banners once per task (§8).
  function handoffBanner(project, task) {
    fire({
      identity: `h:${project}:${task.id}`,
      title: `📋 ${titleOf(project, task.id)} — handoff recorded`,
      body: NOTIFY_BODIES.handoff,
      project,
    });
  }

  // Connect snapshot — reconciliation covers sleep/backoff gaps: only tasks
  // sitting at 'waiting' with an unnotified question/handoff fire. Pending
  // approvals are absent from the snapshot — accepted best-effort (R6).
  function onSnapshot(payload) {
    if (typeof payload?.notifications?.turnEnd === 'boolean') turnEndNotifications = payload.notifications.turnEnd;
    const tasks = payload && payload.tasks;
    if (!tasks || typeof tasks !== 'object') return;
    for (const [project, list] of Object.entries(tasks)) {
      if (!Array.isArray(list)) continue;
      for (const task of list) {
        if (!task || task.id == null) continue;
        rememberTitle(project, task);
        if (task.status !== 'waiting') continue;
        if (typeof task.question === 'string' && task.question) questionBanner(project, task);
        if (task.handoff != null) handoffBanner(project, task);
      }
    }
  }

  function onTaskUpdate(payload) {
    if (!payload || typeof payload !== 'object') return;
    const { project, task } = payload;
    if (project == null || !task || task.id == null) return;
    rememberTitle(project, task);
    if (typeof task.question === 'string' && task.question) questionBanner(project, task);
    if (task.handoff != null) handoffBanner(project, task);
  }

  function onPermission(payload) {
    if (!payload || payload.requestId == null) return;
    const { project, id, requestId } = payload;
    const n = fire({
      identity: `perm:${requestId}`,
      title: `⏳ approval needed — ${titleOf(project, id)}`,
      body: NOTIFY_BODIES.approval,
      project,
    });
    if (n) permBanners.set(String(requestId), n);
  }

  // Fires on allow, deny, interrupt, and turn-end (sessions.js:918/1152/1561/
  // 1747): close the live banner and forget the identity, so a genuinely new
  // request with a recycled id after a restart banners again.
  function onPermissionResolved(payload) {
    if (!payload || payload.requestId == null) return;
    const key = String(payload.requestId);
    const n = permBanners.get(key);
    if (n) {
      permBanners.delete(key);
      try { n.close?.(); } catch { /* banner already gone */ }
    }
    if (notified.delete(`perm:${payload.requestId}`)) {
      persistState();
      log(`notify: cleared perm:${payload.requestId}`);
    }
  }

  // THE F1 RULE: question/handoff never ride session:status (they reach the
  // wire only via updateTask() → task:update). This handler reads ONLY
  // project/id/error/authNeeded — stray question/handoff keys on the payload
  // are unreachable by construction. Regression pinned in §8 tests.
  function onSessionStatus(payload) {
    if (!payload || typeof payload !== 'object') return;
    const { project, id, error, authNeeded } = payload;
    if (project == null || id == null) return;
    if (authNeeded) {
      fire({
        identity: `e:${project}:${id}:${hashText(String(error ?? 'auth'))}`,
        title: `✗ ${titleOf(project, id)} — sign-in needed`,
        body: NOTIFY_BODIES.signin,
        project,
      });
    } else if (error) {
      fire({
        identity: `e:${project}:${id}:${hashText(String(error))}`,
        title: `✗ ${titleOf(project, id)} — turn failed`,
        body: NOTIFY_BODIES.failed,
        project,
      });
    }
  }

  // -- the one choke point every banner goes through -----------------------

  function fire({ identity, title, body, project }) {
    if (notified.has(identity)) return null;
    // Recorded BEFORE the suppression check: a suppressed banner is delivery-
    // equivalent (the user was looking at that project) and must not replay
    // on the next reconnect's snapshot.
    notified.set(identity, now());
    while (notified.size > NOTIFY_CAP) notified.delete(notified.keys().next().value);
    persistState();
    if (!turnEndNotifications && !identity.startsWith('perm:')) {
      log(`notify: suppressed ${identity} (turn-end alerts disabled)`);
      return null;
    }
    if (isFocusedOnProject(project)) {
      log(`notify: suppressed ${identity} (focused on ${project})`); // still logged (R8)
      return null;
    }
    let n = null;
    try {
      n = new NotificationImpl({ title, body });
      n.on?.('click', () => {
        try { onClick(project); } catch (err) { log(`notify: click handler failed (${err.message})`); }
      });
      n.on?.('failed', (_ev, err) => log(`notify: delivery failed ${identity} (${err})`)); // G7 triage
      n.show?.();
      log(`notify: fired ${identity}`);
    } catch (err) {
      log(`notify: banner failed ${identity} (${err?.message || err})`);
    }
    return n;
  }

  // -- public surface ------------------------------------------------------

  return {
    start() {
      if (started || disposed) return;
      started = true;
      try { fsi.mkdirSync(path.dirname(statePath), { recursive: true }); } catch { /* persistState logs */ }
      loadState();
      connect();
    },
    // powerMonitor resume: a post-wake socket is suspect — drop it, skip any
    // pending backoff, reconnect now. One reconnect = one snapshot: fine per wake.
    kick() {
      if (disposed || !started) return;
      backoffMs = NOTIFY_BACKOFF_MIN;
      if (reconnectTimer !== null) { clearT(reconnectTimer); reconnectTimer = null; }
      if (sock) teardown(sockGen, 'kick');
      connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== null) { clearT(reconnectTimer); reconnectTimer = null; }
      teardown(sockGen, 'dispose'); // also clears the watchdog
    },
    get connected() { return connected; },
  };
}
