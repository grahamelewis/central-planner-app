// desktop/main.js — the Electron composition root (BLUEPRINT §2/§4).
// Wiring ONLY: every decision that can be unit-tested lives in serverlink.js;
// this file binds it to real deps. The renderer holds zero privileges (I4):
// the window is a sandboxed browser tab — no injected scripts, no IPC surface.
// Nothing here starts, stops, or messages any server process (I1/I2).
import { app, BrowserWindow, Menu, Notification, dialog, nativeTheme, powerMonitor, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATES, resolvePort, probe, tcpAccepts, launchdLoaded,
  createLifecycle, createNotifier, shellLog, sanitizeBounds, shouldIntervene,
  themeFromBackground,
} from './serverlink.js';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTING = path.join(DESKTOP_DIR, 'connecting.html');
const DEV_ICON = path.join(DESKTOP_DIR, 'icon.png');
const DEFAULT_SIZE = { width: 1280, height: 860 };
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const HASH_FOR = { // both BLOCKED reasons (foreign | occupied) share one splash section
  [STATES.CONNECTING]: '',
  [STATES.WAIT_LAUNCHD]: 'wait-launchd',
  [STATES.SERVER_ABSENT]: 'absent',
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
  app.on('before-quit', () => { quitting = true; flushBounds(); });
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
    resolvePort: () => resolvePort({ log }),
    probe: (port) => probe({ port, log }),
    tcpAccepts: (port) => tcpAccepts({ port }),
    launchdLoaded: () => launchdLoaded({ log }),
    onState: handleState,
    log,
  });
  lifecycle.trigger('startup');
  powerMonitor.on('resume', () => { lifecycle.trigger('resume'); notifier?.kick?.(); });
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
  else quitting = false;
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
    getPort: () => resolvePort({ log }), // re-resolved per connect (G11)
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
