// desktop/main.js — the Electron composition root (BLUEPRINT §2/§4).
// Wiring ONLY: every decision that can be unit-tested lives in serverlink.js;
// this file binds it to real deps. The renderer holds zero privileges (I4):
// the window is a sandboxed browser tab — no injected scripts, no IPC surface.
import { app, BrowserWindow, Menu, Notification, dialog, nativeTheme, powerMonitor, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATES, resolvePort, probe, tcpAccepts, launchdLoaded,
  createLifecycle, createNotifier, shellLog, sanitizeBounds, shouldIntervene,
  themeFromBackground,
} from './serverlink.js';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTING = path.join(DESKTOP_DIR, 'connecting.html');
const DEV_ICON = path.join(DESKTOP_DIR, 'icon.png');
const REPO_HINT = path.join(DESKTOP_DIR, 'repo-location.json');
const DEFAULT_SIZE = { width: 1280, height: 860 };
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const HASH_FOR = { // both BLOCKED reasons (foreign | occupied) share one splash section
  [STATES.CONNECTING]: '',
  [STATES.STARTING_SERVER]: 'starting-server',
  [STATES.WAIT_LAUNCHD]: 'wait-launchd',
  [STATES.SERVER_ABSENT]: 'absent',
  [STATES.SERVER_FAILED]: 'server-failed',
  [STATES.BLOCKED_OCCUPIED]: 'occupied',
};

let win = null;
let quitting = false;
let dashboardOrigin = null;  // set on first ATTACH; null = every origin check fails closed
let lastLoadGen = undefined; // generation tag for did-fail-load staleness (G12)
let themeTimer = null;       // chrome-theme sync poll (unref'd; Settings-toggle lag ≤15s)
let lifecycle = null;
let notifier = null;         // created on first ATTACH (ensureNotifier); disposed on app 'quit'
let boundsTimer = null;
let ownedChild = null;       // set only for a server process this shell spawned
let ownedExpectedExit = false;
let ownedStoppedForQuit = false;
let quitApproved = false;
let quitCheckPending = false;
let ownedExitTimes = [];
let logger = { log: () => {}, path: '' }; // replaced in init(); pre-ready calls no-op
const log = (line) => logger.log(line);

if (!app.requestSingleInstanceLock()) {
  app.quit(); // second shell registers nothing; the first window gets focused instead
} else {
  registerApp();
}

function registerApp() {
  app.on('second-instance', () => {
    if (!win) return;
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', onBeforeQuit);
  app.on('will-quit', onWillQuit);
  // 'quit' only, never before-quit: the draft-guard Stay path aborts a quit
  // and the app keeps running — the notifier must stay alive through it (F5).
  app.on('quit', () => { notifier?.dispose?.(); });
  app.on('activate', () => { win?.show(); win?.focus(); });
  // dock-resident app: only Cmd+Q exits, so all-windows-closed must not quit
  app.on('window-all-closed', () => {});
  app.whenReady().then(init);
}

function init() {
  logger = shellLog(path.join(app.getPath('userData'), 'logs'));
  log(`startup: shell ${app.getVersion()} electron ${process.versions.electron}`);
  // Packaged builds receive icon.icns through Electron Packager. Development
  // launches need an explicit dock icon or macOS shows Electron's identity.
  if (!app.isPackaged && app.dock && fs.existsSync(DEV_ICON)) app.dock.setIcon(DEV_ICON);
  installPermissionHandlers(session.defaultSession);
  Menu.setApplicationMenu(buildMenu());
  auditMenu(Menu.getApplicationMenu());
  createWindow();
  loadSplash(''); // never sit on about:blank while the first probe decides (§4)
  lifecycle = createLifecycle({
    resolvePort: () => resolvePort({ log, repoRoot: knownRepoRoot()?.root }),
    probe: (port) => probe({ port, log }),
    tcpAccepts: (port) => tcpAccepts({ port }),
    launchdLoaded: () => launchdLoaded({ log }),
    startServer: (port) => startOwnedServer(port),
    stopServer: (reason) => stopOwnedServer(reason),
    onState: handleState,
    log,
  });
  lifecycle.trigger('startup');
  powerMonitor.on('resume', () => { lifecycle.trigger('resume'); notifier?.kick?.(); });
}

// ---------------------------------------------------------------- owned server

function serverLocationFile() { return path.join(app.getPath('userData'), 'server-location.json'); }
function ownerFile() { return path.join(app.getPath('userData'), 'server-owner.json'); }

function validRepoRoot(root) {
  if (!root || typeof root !== 'string') return false;
  try {
    return fs.statSync(path.join(root, 'app', 'server.js')).isFile()
      && fs.statSync(path.join(root, 'app', 'package.json')).isFile();
  } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function persistJson(file, value) {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    log(`server-owner: persist failed (${err.message})`);
  }
}

// Non-interactive lookup is also used for probing. Only an actual owned-server
// start can open a picker, so attaching to an existing legacy server stays quiet.
function knownRepoRoot() {
  const persisted = readJson(serverLocationFile())?.repoRoot;
  const packagedHint = readJson(REPO_HINT)?.repoRoot;
  const devRoot = app.isPackaged ? null : path.resolve(DESKTOP_DIR, '..');
  for (const [source, candidate] of [
    ['CP_REPO', process.env.CP_REPO],
    ['persisted', persisted],
    ['packaged hint', packagedHint],
    ['development checkout', devRoot],
  ]) {
    if (!validRepoRoot(candidate)) continue;
    return { root: path.resolve(candidate), source };
  }
  return null;
}

function resolveRepoRoot() {
  const known = knownRepoRoot();
  if (known) {
    persistJson(serverLocationFile(), { repoRoot: known.root });
    log(`server-owner: repo ${known.root} (${known.source})`);
    return known.root;
  }

  const picked = dialog.showOpenDialogSync(win, {
    title: 'Locate the Central Planner folder',
    message: 'Choose the installation or development folder containing app/server.js.',
    properties: ['openDirectory'],
  })?.[0];
  if (validRepoRoot(picked)) {
    const root = path.resolve(picked);
    persistJson(serverLocationFile(), { repoRoot: root });
    log(`server-owner: repo ${root} (chosen)`);
    return root;
  }
  throw new Error('Central Planner repository could not be located');
}

function resolveNode() {
  const candidates = [
    process.env.CP_NODE_BIN,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      const version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
      const major = Number(/^v?(\d+)/.exec(version)?.[1]);
      if (major >= 20) return bin;
      log(`server-owner: ignoring ${bin} (${version || 'unknown version'}; Node 20+ required)`);
    } catch { /* next */ }
  }
  throw new Error('Node.js 20 or newer was not found');
}

function startOwnedServer(port) {
  if (ownedChild && ownedChild.exitCode === null) return Promise.resolve();
  const now = Date.now();
  ownedExitTimes = ownedExitTimes.filter((t) => now - t < 60000);
  if (ownedExitTimes.length >= 2) {
    throw new Error('server exited twice within 60 seconds; automatic restart stopped');
  }
  const repoRoot = resolveRepoRoot();
  // A first-start folder selection can reveal a different configured port than
  // the initial legacy/default probe. Re-probe it before any process is spawned;
  // it may already belong to a running dashboard or another service.
  if (resolvePort({ log, repoRoot }) !== port) {
    queueMicrotask(() => {
      lifecycle?.dispose();
      lifecycle?.trigger('server-location-selected');
    });
    return Promise.resolve();
  }
  const appDir = path.join(repoRoot, 'app');
  const node = resolveNode();
  const serverLog = path.join(app.getPath('userData'), 'logs', 'server.log');
  fs.mkdirSync(path.dirname(serverLog), { recursive: true });
  const fd = fs.openSync(serverLog, 'a');
  let child;
  try {
    child = spawn(node, ['server.js'], {
      cwd: appDir,
      env: {
        ...process.env,
        CP_PORT: String(port),
        PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/Library/TeX/texbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  ownedChild = child;
  ownedExpectedExit = false;
  ownedStoppedForQuit = false;
  log(`server-owner: spawning via ${node} on port ${port}`);

  child.once('exit', (code, signal) => {
    const expected = ownedExpectedExit;
    log(`server-owner: pid ${child.pid} exit code=${code} signal=${signal || '-'} expected=${expected}`);
    if (ownedChild === child) ownedChild = null;
    const rec = readJson(ownerFile());
    if (rec?.pid === child.pid) {
      try { fs.unlinkSync(ownerFile()); } catch { /* already gone */ }
    }
    if (!expected && !quitting) {
      const exitedAt = Date.now();
      ownedExitTimes = ownedExitTimes.filter((t) => exitedAt - t < 60000);
      ownedExitTimes.push(exitedAt);
      lifecycle?.dispose();
      lifecycle?.trigger('owned-server-exit');
    }
  });

  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      persistJson(ownerFile(), {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        repoRoot,
        port,
      });
      log(`server-owner: started pid ${child.pid}`);
      resolve();
    });
    child.once('error', (err) => {
      if (ownedChild === child) ownedChild = null;
      log(`server-owner: spawn failed (${err.message})`);
      reject(err);
    });
  });
}

async function stopOwnedServer(reason = 'quit') {
  const child = ownedChild;
  if (!child || child.exitCode !== null) return;
  ownedExpectedExit = true;
  log(`server-owner: stopping pid ${child.pid} (${reason})`);
  try { child.kill('SIGTERM'); } catch { return; }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, 3000);
    child.once('exit', finish);
  });
}

async function quitImpact() {
  if (!dashboardOrigin) return { active: 0, tailnet: false };
  try {
    const res = await fetch(`${dashboardOrigin}/api/state`, { signal: AbortSignal.timeout(1800) });
    const s = await res.json();
    const sessions = Array.isArray(s.sessions) ? s.sessions.length : 0;
    const runs = Object.values(s.runs || {}).filter((r) => r?.state === 'running').length;
    const jobs = (s.jobs || []).filter((j) => j?.state === 'running').length;
    const fixes = Object.values(s.texfix || {}).filter((f) => f?.state === 'running').length;
    return { active: sessions + runs + jobs + fixes, tailnet: s.tailnet?.configured === true };
  } catch {
    return { active: 0, tailnet: false };
  }
}

function onBeforeQuit(event) {
  flushBounds();
  if (!ownedChild || quitApproved) {
    quitting = true;
    return;
  }
  event.preventDefault();
  if (quitCheckPending) return;
  quitCheckPending = true;
  quitImpact().then(({ active, tailnet }) => {
    const impacts = [];
    if (active) impacts.push(`${active} active job${active === 1 ? '' : 's'} will be interrupted`);
    if (tailnet) impacts.push('Tailnet access will go offline');
    const leave = !impacts.length || dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Quit Central Planner?',
      detail: impacts.join('. ') + '.',
      buttons: ['Stay', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    }) === 1;
    quitCheckPending = false;
    if (!leave) { quitting = false; return; }
    quitApproved = true;
    quitting = true;
    app.quit();
  }).catch(() => {
    quitCheckPending = false;
    quitApproved = true;
    quitting = true;
    app.quit();
  });
}

function onWillQuit(event) {
  if (!ownedChild || ownedStoppedForQuit) return;
  event.preventDefault();
  ownedStoppedForQuit = true;
  const disableTailnet = dashboardOrigin
    ? fetch(`${dashboardOrigin}/api/tailnet/disable`, { method: 'POST', signal: AbortSignal.timeout(5000) })
        .catch((err) => log(`server-owner: tailnet disable on quit failed (${err.message})`))
    : Promise.resolve();
  disableTailnet.finally(() => {
    stopOwnedServer('application quit').finally(() => app.quit());
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  const saved = readBoundsFile();
  const bounds = sanitizeBounds(saved?.bounds, screen.getAllDisplays());
  win = new BrowserWindow({
    ...(bounds ?? DEFAULT_SIZE), // invalid/off-screen saved rect → centered default (F24)
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // G5 — the thing the shell exists to fix
    },
  });
  if (saved?.maximized) win.maximize();
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, scheduleBoundsSave);
  // Close hides, silently — the page (drafts, view state) lives on; only a quit
  // really closes. Electron fires 'close' before any unload, so no dialog here (F5).
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    routeExternal(url, 'window-open'); // same-origin too: "open in browser" is the labeled intent (G2)
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (sameOrigin(url)) return; // only the dashboard origin navigates in-window
    e.preventDefault();
    routeExternal(url, 'will-navigate');
  });
  win.webContents.on('will-prevent-unload', onWillPreventUnload);
  win.webContents.on('did-fail-load', onDidFailLoad);
  // Chrome-vs-page theme sync: the native title bar follows nativeTheme
  // (= system appearance by default) while the dashboard themes itself from
  // its own Settings — a light page under a dark bar, or vice versa. Mirror
  // the PAGE's computed background into the window chrome. Main-initiated
  // one-shot eval: no preload, no IPC, nothing is exposed to the page (I4).
  // Triggers: every finished load, window focus, and a 15 s unref'd poll
  // (the in-window Settings toggle fires no event main can see).
  win.webContents.on('did-finish-load', syncChromeTheme);
  win.on('focus', syncChromeTheme);
  if (!themeTimer) {
    themeTimer = setInterval(syncChromeTheme, 15_000);
    if (typeof themeTimer.unref === 'function') themeTimer.unref();
  }
}

// ---------------------------------------------------------------- bounds persistence

function boundsFile() { return path.join(app.getPath('userData'), 'bounds.json'); }

function readBoundsFile() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); }
  catch { return null; } // missing or corrupt → centered default
}

function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(flushBounds, 500);
}

function flushBounds() { // also called by before-quit so a pending debounce isn't lost
  clearTimeout(boundsTimer);
  boundsTimer = null;
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds: quitting while maximized must not clobber the restore rect
    const payload = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(`${boundsFile()}.tmp`, JSON.stringify(payload));
    fs.renameSync(`${boundsFile()}.tmp`, boundsFile()); // atomic swap
  } catch (err) {
    log(`bounds: save failed (${err.message})`);
  }
}

// ---------------------------------------------------------------- permissions & routing

function installPermissionHandlers(ses) {
  // Deny-by-default on BOTH hooks (F10 — synchronous checks bypass the request
  // handler). The single allowance: origin-pinned, main-frame
  // clipboard-sanitized-write from the shell's own window. Artifact iframes,
  // service workers, and anything pre-attach (dashboardOrigin null) fail closed.
  const allowed = (wc, permission, originish, isMainFrame) =>
    permission === 'clipboard-sanitized-write'
    && dashboardOrigin !== null && sameOrigin(originish)
    && isMainFrame === true
    && win !== null && wc === win.webContents;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = allowed(wc, permission, details.requestingUrl, details.isMainFrame === true);
    if (!ok) log(`perm: denied request ${permission} from ${details.requestingUrl}`);
    cb(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const ok = allowed(wc, permission, requestingOrigin, details?.isMainFrame === true);
    if (!ok) log(`perm: denied check ${permission} from ${requestingOrigin}`);
    return ok;
  });
}

// Handles full URLs and bare origin strings; trailing slashes normalize away.
function sameOrigin(urlish) {
  try { return new URL(urlish).origin === dashboardOrigin; } catch { return false; }
}

function routeExternal(url, context) {
  let scheme;
  try { scheme = new URL(url).protocol; } catch {
    return log(`nav: dropped unparseable url (${context})`);
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) {
    return log(`nav: dropped ${scheme} url (${context})`); // e.g. a crafted file: link (G2)
  }
  log(`nav: external ${scheme} (${context})`);
  shell.openExternal(url).catch((err) => log(`nav: openExternal failed (${err.message})`));
}

// ---------------------------------------------------------------- menu (I5)

function buildMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'fileMenu' }, // supplies Close Window (Cmd+W) → our hide-on-close path
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      // default resetZoom binds Cmd+zero, shadowing the dashboard's view switch (G3)
      { role: 'resetZoom', accelerator: 'CmdOrCtrl+Shift+0' },
      { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]);
}

// Runtime I5 audit: role items carry invisible default accelerators a template
// grep can't see — walk the built menu and flag any Cmd-digit (0..5) binding.
const FORBIDDEN_ACC = /(?:^|\+)(?:Cmd|Command|CmdOrCtrl|CommandOrControl)\+[0-5]$/i;
function auditMenu(menu) {
  for (const item of menu?.items ?? []) {
    const acc = item.accelerator ?? item.getDefaultRoleAccelerator?.();
    if (typeof acc === 'string' && FORBIDDEN_ACC.test(acc)) {
      log(`menu: INVARIANT I5 VIOLATION "${item.label}" binds ${acc}`);
    }
    if (item.submenu) auditMenu(item.submenu);
  }
}

// ---------------------------------------------------------------- draft guard (G4)

function onWillPreventUnload(event) {
  // Fires only on paths that actually unload — reload and quit (F5); close hid
  // the window before any unload could begin, so no close-path dialog exists.
  const leave = dialog.showMessageBoxSync(win, {
    type: 'warning',
    message: 'Unsaved drafts — leave anyway?',
    detail: 'This page has unsent drafts or unsaved edits.',
    buttons: ['Stay', 'Leave'],
    defaultId: 0,
    cancelId: 0,
  }) === 1;
  // preventDefault INVERTS the renderer's veto — calling it permits the unload
  if (leave) event.preventDefault();
  // Stay during a Cmd+Q: before-quit already ran, so the flag must reset or the
  // next Cmd+W would really close the window instead of hiding it
  else {
    quitting = false;
    quitApproved = false;
  }
  log(`draft-guard: ${leave ? 'leave' : 'stay'}`);
}

// ---------------------------------------------------------------- lifecycle sink

function isDashboardUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' && p.hostname === '127.0.0.1';
  } catch { return false; }
}

function loadSplash(hash) {
  if (!win) return;
  // superseded loads reject with ERR_ABORTED — did-fail-load is the real signal
  win.loadFile(CONNECTING, hash ? { hash } : {}).catch(() => {});
}

function handleState(s) {
  log(`state: ${s.name}${s.reason ? '/' + s.reason : ''} port ${s.port} gen ${s.gen}`);
  if (!win) return;
  const onDashboard = isDashboardUrl(win.webContents.getURL());
  if (s.name === STATES.ATTACH) {
    dashboardOrigin = `http://127.0.0.1:${s.port}`;
    lastLoadGen = s.gen; // always — a later Cmd+R failure must not be misjudged stale
    ensureNotifier();    // §4 diagram: "ATTACHED — open the ONE notifier WS"
    // hostname-only check (any port): a port change under a loaded SPA is the
    // accepted G11 limit — manual Cmd+R is the recovery, never a forced reload
    if (onDashboard) return log('attach: already on dashboard — not reloading (I6)');
    win.loadURL(`${dashboardOrigin}/`).catch(() => {});
    return;
  }
  // Splash states while the SPA is loaded: do NOTHING (I6) — the page's own 3 s
  // WS reconnect self-heals a server blip; swapping to the splash would lose drafts.
  if (onDashboard) return log(`state: ${s.name} while SPA loaded — leaving page alone (I6)`);
  loadSplash(HASH_FOR[s.name] ?? '');
}

async function syncChromeTheme() {
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
  try {
    const bg = await win.webContents.executeJavaScript(
      'getComputedStyle(document.body).backgroundColor', false);
    const mode = themeFromBackground(bg);
    if (mode && nativeTheme.themeSource !== mode) {
      nativeTheme.themeSource = mode;
      // resize-flash color behind the page follows too
      win.setBackgroundColor(mode === 'light' ? '#f7f6f3' : '#14161a');
      log(`theme: chrome → ${mode} (page bg ${bg})`);
    }
  } catch { /* mid-navigation teardown — the next trigger catches it */ }
}

function onDidFailLoad(event, errorCode, errorDescription, validatedURL, isMainFrame) {
  const fe = { errorCode, validatedURL, isMainFrame, generation: lastLoadGen };
  if (!shouldIntervene(fe, lifecycle?.generation)) {
    return log(`did-fail-load: ignored ${errorCode} ${validatedURL} main=${isMainFrame}`);
  }
  log(`did-fail-load: ${errorCode} ${errorDescription} ${validatedURL} — showing splash, probing`);
  loadSplash('');
  lifecycle?.trigger('did-fail-load'); // joins or starts per I8 — serialization is serverlink's
}

// ---------------------------------------------------------------- notifier (T3)

// First ATTACH lazily creates + starts the one notifier (I3). Later ATTACHes
// only kick a dead link — fresh HEALTHY evidence skips a pending ≤60 s backoff
// without churning a healthy socket. powerMonitor 'resume' (init) also kicks.
function ensureNotifier() {
  if (notifier) {
    if (!notifier.connected) notifier.kick();
    return;
  }
  notifier = createNotifier({
    getPort: () => resolvePort({ log, repoRoot: knownRepoRoot()?.root }), // same installation binding as lifecycle
    WebSocketImpl: globalThis.WebSocket, // Node's native global — no ws dep (R2)
    NotificationImpl: Notification,
    statePath: path.join(app.getPath('userData'), 'notify-state.json'),
    isFocusedOnProject,
    onClick: onNotificationClick,
    log,
  });
  notifier.start();
}

// Zero-IPC project awareness (F14): suppress only when the window is focused
// AND the dashboard URL's '#<key>' hash names the banner's project. The splash
// never suppresses; an empty hash (overview) suppresses nothing.
function isFocusedOnProject(project) {
  if (!win || win.isDestroyed() || !win.isFocused()) return false;
  const u = win.webContents.getURL();
  if (!isDashboardUrl(u)) return false;
  try {
    const key = decodeURIComponent(new URL(u).hash.slice(1));
    return key !== '' && key === String(project);
  } catch { return false; }
}

// Click → re-show/focus the live window, which keeps its current view (F8 —
// honest scope: no runtime hash routing in app/). win === null happens only
// post-crash (close hides): a fresh window CAN deep-link via the SPA's
// init-time hash routing (app.js:10240-10253).
function onNotificationClick(project) {
  if (win) {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  createWindow();
  if (dashboardOrigin) {
    win.loadURL(`${dashboardOrigin}/#${encodeURIComponent(String(project))}`).catch(() => {});
  } else {
    loadSplash('');
    lifecycle?.trigger('notification-click');
  }
}
