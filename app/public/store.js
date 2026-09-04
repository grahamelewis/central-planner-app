// store.js — the shared-state home, split verbatim out of app.js (phase 2):
// the `state` object + ui view-state, every cross-module cache, state-derived
// lookup helpers, provider/model helpers + model constants, theme, and the
// per-task localStorage tab state.

import { enc, isExtRel } from './util.js';
import { renderSettings } from './views.js';

/** @type {{ [fkey: string]: { lang?: string, text?: string, lines?: any[], states?: any[], [k: string]: any } }} */
export const hlStores = {}; // fkey → highlighter cache ({lang, text, lines, states})
/** @type {{ [paneKey: string]: PdfPane }} */
export const pdfPanes = {}; // project → live PDF.js pane; its element is re-attached
                     // across renders so rebuilds never lose scroll/zoom
window.__pdfPanes = pdfPanes; // debug handle for out-of-repo QA probe scripts

/* ───────────────────────── state ───────────────────────── */

/** @type {StateSnapshot} */
export const state = {
  projects: {},   // key → {name, root, color, texWatch}
  categories: {},
  abstracts: {},
  tasks: {},      // key → Task[]
  artifacts: [],
  pdf: {},        // key → {tex, pdf, state, lastBuildMs, lastBuiltAt, pages}
  ledger: null,   // weekSummary()
  providers: {},  // Claude + Codex account state and live model catalogs
  agentDefaults: { provider: 'claude', model: 'claude-opus-5', reasoningEffort: 'high' },
  sessions: [],
  runs: {},       // key → {rel, cmdLine, state, exitCode, startedAt, ms}
  texfix: {},     // key → {state, startedAt, ms, model, taskId, tex,
                  //        suggestions:[{id,file,find,replace,why,status}], note, error, costUsd}
  kaimon: {},     // {enabled, available, julia:{key→bool}, daemon:{state,port,…}|null,
                  //  install:{state,error,tail}} — the warm-Julia-REPL integration
  update: {},     // dashboard self-update: {state:'unknown|unavailable|checking|ok|
                  //  behind|updating|error', behind, ahead, dirty, branch, upstream,
                  //  head, commits:[{sha,subject}], lastChecked, error, updated}
  plan: { deadlines: {}, cal: { sources: [], routes: {}, events: [] } },
                  // ◆ next up + ⧉ calendar: deadlines per project; cal =
                  // {sources:[{id,name,count,error,fetched}] (NO urls — secret),
                  //  includeAllDay, routes:{uid→{to}}, events:[occurrences], fetched}
  tailnet: { state: 'checking', available: false, configured: false, connected: false },
                  // host Tailscale Serve state for the top-bar private-access control
};

/** @type {UiState} */
export const ui = {
  view: 'ov',     // 'ov' | 'cats' | 'manage' | projectKey
  per: {},        // projectKey → { taskId, fileTab (index|'tail'|null), viewerKey }
  manageOpen: new Set(), // expanded `${project}::${category}` rows on the manage page
};

/** @type {{ [taskKey: string]: string }} */
export const tailBufs = {};      // `${project}/${id}` → accumulated session:stream text
/** @type {{ [taskKey: string]: AgentInfo[] }} */
export const agentsLive = {};    // `${project}/${id}` → live subagent roster for the
                          // running turn [{n,type,desc,status,summary,tools,tokens}]
                          // (session:agents events; RE-SEEDED — replaced, never
                          // merged — from each state.sessions snapshot in
                          // applyState, and the ONLY thing the fleet board
                          // renders from: a stale snapshot roster must never
                          // resurrect under a later turn)
/** @type {{ [taskKey: string]: EditsAggregate }} */
export const editsLive = {};     // `${project}/${id}` → live ✎ file-edit aggregate for the
                          // running turn {files,created,modified,deleted,adds,dels}
                          // (session:edits events; re-seeded like agentsLive)
/** @type {{ [jobKey: string]: JobInfo }} */
export const jobsLive = {};      // job.key → live job-card data for a long-running
                          // script (job:status events; seeded from state.jobs).
                          // `_recvAt` (perf.now at receipt) drives local ticking.
/** @type {{ [jobKey: string]: any }} */
export const jobTimers = {};     // job.key → timeout that fades a finished card away
export const jobEntered = new Set(); // job.keys whose card has PLAYED its entrance —
                          // rebuilt/re-inserted cards must not replay the fade
/** @type {{ [snapBlobKey: string]: SnapBlobEntry }} */
export const snapFileCache = {}; // `${project}::${entryId}::${rel}` → {before,after,status}
                          // | {loading} | {error} — blobs for the Δ diff view
/** @type {{ [taskKey: string]: { entries: TranscriptEntry[], fetched?: boolean } }} */
export const transcripts = {};   // `${project}/${id}` → { entries:[{role,text,ts}], fetched }
/** @type {{ [fkey: string]: FileCacheEntry }} */
export const fileCache = {};     // `${project}::${rel}` → { text, mtimeMs } | { error } | { loading }
/** @type {{ [fkey: string]: string }} */
export const drafts = {};        // `${project}::${rel}` → unsaved editor text (survives re-renders)
/** @type {{ [fkey: string]: EdView }} */
export const edViews = {};       // fkey → { scrollTop, scrollLeft, selStart, selEnd } — the editor's
                          // place, remembered across TAB ROUND-TRIPS (≋ console and back,
                          // file A → B → A, project switches); in-memory, per session
export const diskStale = new Set(); // fkeys where an agent changed DISK under an unsaved draft
/** @type {{ [fkey: string]: number }} */
export const draftBase = {};     // `${project}::${rel}` → disk mtimeMs the draft started from —
                          // frozen at first keystroke so cache refreshes can't re-baseline
                          // a stale draft over someone else's newer write
/** @type {{ [project: string]: string }} */
export const runBufs = {};       // project → accumulated run output (plain text)
/** @type {{ [project: string]: RunSeg[] }} */
export const runSegs = {};       // project → [{fd, text}] — same content, stderr-tagged
                          // (absent after a reload: the server tail is colorless)
/** @type {{ [project: string]: number }} */
export const runOff = {};        // project → highest run:stream byte offset applied —
                          // drops chunks replayed across a ws reconnect
/** @type {{ [taskKey: string]: Set<string> }} */
export const closedCache = {};   // `${project}/${taskId}` → Set of closed-tab file strings
/** @type {{ [project: string]: HtmlEditState }} */
export const htmlEdits = {};     // project → { rel, doctype, baseMtimeMs, dirty } — live WYSIWYG edit
/** @type {{ [taskKey: string]: { entries: SnapshotEntry[], fetched?: boolean } }} */
export const snapsCache = {};    // `${project}/${taskId}` → { entries:[…], fetched } — change history
/** @type {{ [project: string]: { items: FeedItem[], fetched?: boolean } }} */
export const feedCache = {};     // project → { items:[…], fetched } — ◷ Recent activity sidebar feed
/** @type {{ [project: string]: any }} */
export const feedTimers = {};    // project → debounce timer for feed refreshes
/** @type {{ [taskKey: string]: PermRequest[] }} */
export const pendingPerms = {};  // `${project}/${taskId}` → [{requestId, tool, input}, …] awaiting approval
/** @type {{ [taskKey: string]: string }} */
export const composerDrafts = {}; // `${project}/${taskId}` → unsent composer text (survives re-renders)
/** @type {{ [taskKey: string]: string[] }} */
export const queuedMsgs = {};     // `${project}/${taskId}` → [text…] typed mid-turn — one turn at a
                           // time, so these hold until session:status ends the turn, then send
/** @type {{ [project: string]: Set<string> }} */
export const turnTexTouched = {}; // project → Set of .tex rels a session edited this turn — flushed
                           // at turn end into auto ▶ recompiles of decks with an open pdf tab
/** @type {{ [taskKey: string]: boolean }} */
export const pendingComplete = {}; // `${project}/${taskId}` → true while a ✓ complete wrap-up turn is in flight;
                            // when that turn ends we accept the handoff (status:done) + archive
/** @type {{ [taskKey: string]: ConsoleViewState }} */
export const consoleView = {}; // `${project}/${id}` → { scrollTop, follow } — console scroll kept across task switches

/* ───────────────────────── theme ───────────────────────── */
/* 'system' | 'dark' | 'light' in localStorage; the <head> bootstrap applied it
   before first paint, this keeps it live (Settings clicks + macOS switching) */

export const sysLight = matchMedia('(prefers-color-scheme: light)');

/* additive hook rail (Phase 3 S1): monacoPane registers its cpDefineThemes
   sync here at boot INIT — applyTheme stays the single flip pipeline
   (blueprint §2 Theme row / P22) and store.js keeps zero Monaco knowledge.
   Hooks run AFTER the data-theme stamp so they read the fresh palette; they
   are registered lazily (never at module eval — the store↔monacoPane ESM
   cycle must stay function-scoped). */
/** @type {(() => void)[]} */
export const themeHooks = [];

/** @returns {'system' | 'dark' | 'light' | string} the persisted theme choice */
export function themePref() {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
}

/**
 * Stamp html[data-theme] from the preference (live system tracking).
 * @returns {void}
 */
export function applyTheme() {
  const t = themePref();
  const light = t === 'light' || (t === 'system' && sysLight.matches);
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  for (const cb of themeHooks) {
    try { cb(); } catch (e) { console.warn('theme hook failed', e); }
  }
}

/**
 * Persist + apply a theme choice.
 * @param {'system' | 'dark' | 'light' | string} t (from data-th attributes)
 * @returns {void}
 */
export function setTheme(t) {
  try { localStorage.setItem('theme', t); } catch { /* private mode — session-only */ }
  applyTheme();
  if (ui.view === 'settings') renderSettings();
}

sysLight.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });

/* ───────────────────────── helpers ───────────────────────── */

// projKeys() is the VISIBLE set (nav, overview, shortcuts, add-task) — it hides
// 'inactive' projects. allProjKeys() is the full set for lookups (resolveId,
// lineage) and the Manage tab, which must still see inactive ones to reactivate.
/** @returns {string[]} VISIBLE project keys (hides 'inactive') */
export function projKeys() { return Object.keys(state.projects).filter(k => state.projects[k]?.status !== 'inactive'); }
/** @returns {string[]} every project key, inactive included */
export function allProjKeys() { return Object.keys(state.projects); }
/**
 * @param {string} k project key
 * @returns {Task[]}
 */
export function tasksOf(k) { return Array.isArray(state.tasks[k]) ? state.tasks[k] : []; }
/**
 * @param {string} k project key
 * @param {string} id task id
 * @returns {Task | null}
 */
export function findTask(k, id) { return tasksOf(k).find(t => t && t.id === id) || null; }

/**
 * @param {Task | null | undefined} task
 * @returns {'claude' | 'codex'}
 */
export function taskProvider(task) { return task?.provider === 'codex' ? 'codex' : 'claude'; }
/**
 * @param {string | null | undefined} provider
 * @returns {string} display name
 */
export function agentName(provider) { return provider === 'codex' ? 'Codex' : 'Claude'; }
/**
 * Live account/model state for a provider, with an honest fallback row when
 * the snapshot hasn't delivered one (claude synthesizes from `state.auth`).
 * @param {string} provider
 * @returns {ProviderState}
 */
export function providerState(provider) {
  if (state.providers?.[provider]) return state.providers[provider];
  if (provider === 'claude') {
    /** @type {AuthState} */
    const a = state.auth || {};
    return { id: 'claude', name: 'Claude', auth: a, connected: a.loggedIn === true || (a.method === 'apikey' && !a.needed), models: [] };
  }
  return { id: provider, name: agentName(provider), connected: false, models: [] };
}
/**
 * @param {string} provider
 * @returns {ModelInfo[]} live catalog, falling back to CLAUDE_MODELS
 */
export function providerModels(provider) {
  const rows = providerState(provider).models;
  if (Array.isArray(rows) && rows.length) return rows;
  return provider === 'claude' ? CLAUDE_MODELS : [];
}
/**
 * True only when the provider has POSITIVELY reported it can't run turns.
 * @param {string} provider
 * @returns {boolean}
 */
export function providerExplicitlyBlocked(provider) {
  const p = providerState(provider);
  if (provider === 'claude') return !!(p.auth || state.auth)?.needed;
  return !!p.lastChecked && p.connected !== true;
}

/**
 * Find a task by id across every project (lineage lookups).
 * @param {string} id
 * @returns {{ k: string, t: Task } | null}
 */
export function resolveId(id) {
  for (const k of allProjKeys()) {
    const t = findTask(k, id);
    if (t) return { k, t };
  }
  return null;
}

/**
 * @param {string} k project key
 * @returns {PerProject} the project's UI state slot (created on demand)
 */
export function perOf(k) { return ui.per[k] ?? (ui.per[k] = {}); }

/**
 * The project's selected task, falling back to running/waiting/first
 * (never auto-selecting an archived one).
 * @param {string} k project key
 * @returns {Task | null}
 */
export function curTask(k) {
  const per = perOf(k);
  let t = per.taskId ? findTask(k, per.taskId) : null;
  if (!t) {
    // fallback never auto-selects an archived task
    const ts = tasksOf(k).filter(x => !x.archived);
    t = ts.find(x => x.status === 'running' || x.status === 'waiting') || ts[0] || null;
    per.taskId = t ? t.id : null;
  }
  return t;
}

/* map context.files entry → path relative to project root, or null if outside */
/**
 * Map a context.files entry to a project-root-relative path.
 * @param {string} project
 * @param {*} file pin entry (relative or absolute)
 * @returns {string | null} null = outside the project root
 */
export function relOf(project, file) {
  const root = state.projects[project]?.root || '';
  let f = String(file || '').trim();
  if (!f) return null;
  if (f.startsWith('/')) {
    const r = root.endsWith('/') ? root : root + '/';
    if (root && (f === root || f.startsWith(r))) return f.slice(r.length).replace(/^\/+/, '');
    return null;
  }
  return f.replace(/^\.\//, '');
}

// an EXTERNAL pin: an absolute path OUTSIDE the project root (relOf can't
// resolve it to a project-relative path). These grant the session read/edit
// access via additionalDirectories; in the dashboard they browse + open
// READ-ONLY (Claude edits them, not this editor).
/**
 * @param {string} key project key
 * @param {*} f pin entry
 * @returns {boolean} absolute path OUTSIDE the project root?
 */
export function isExternalPin(key, f) {
  const raw = String(f || '').replace(/\/+$/, '');
  return raw.startsWith('/') && relOf(key, raw) === null;
}

/**
 * /artifact URL for an in-root file.
 * @param {string} project
 * @param {string} rel
 * @returns {string}
 */
export function artifactUrl(project, rel) {
  return `/artifact/${enc(project)}/` + String(rel).split('/').map(enc).join('/');
}

/* one URL for any readable file — in-root via /artifact, granted external
   pins via their allowlisted /api/extfile route (task-scoped) */
/**
 * One URL for any readable file (in-root /artifact, external /api/extfile).
 * @param {string} project
 * @param {string} rel root-relative, or absolute for a granted external pin
 * @returns {string}
 */
export function fileUrl(project, rel) {
  return isExtRel(rel)
    ? `/api/extfile/${enc(project)}/${enc(curTask(project)?.id || '')}?path=${enc(rel)}`
    : artifactUrl(project, rel);
}

/**
 * URL of the live watch's compiled pdf, if any.
 * @param {string} key project key
 * @returns {string | null}
 */
export function pdfSrc(key) {
  const e = state.pdf?.[key];
  if (!e || !e.pdf) return null;
  const rel = relOf(key, e.pdf);
  return rel ? artifactUrl(key, rel) : null;
}

/* last-open center tab per TASK — UI-only state (localStorage): coming back
   to a task reopens what you were looking at (console included) instead of
   defaulting to the first file. O(1) lookup on switch; written only when the
   value actually changes, so render hot paths never touch localStorage. */
/** @type {{ [project: string]: { [taskId: string]: number | string | null } }} */
export const taskTabCache = {}; // projectKey → { taskId: fileTab } (insertion = recency)
/**
 * @param {string} key project key
 * @returns {{ [taskId: string]: number | string | null }} last-open tab per task (localStorage-backed)
 */
export function taskTabsOf(key) {
  if (!taskTabCache[key]) {
    try {
      const m = JSON.parse(localStorage.getItem(`taskTab:${key}`) || '{}');
      taskTabCache[key] = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch { taskTabCache[key] = {}; }
  }
  return taskTabCache[key];
}
/**
 * Remember a task's active center tab (writes only on change; pruned to 60).
 * @param {string} key project key
 * @param {string} taskId
 * @param {number | string | null} tab
 * @returns {void}
 */
export function taskTabRemember(key, taskId, tab) {
  const m = taskTabsOf(key);
  if (m[taskId] === tab) return;
  delete m[taskId]; // re-insert newest-last → the prune below drops the stalest
  m[taskId] = tab;
  const ids = Object.keys(m);
  for (const id of ids.slice(0, Math.max(0, ids.length - 60))) delete m[id];
  try { localStorage.setItem(`taskTab:${key}`, JSON.stringify(m)); } catch { /* private mode */ }
}
/* the restore side of the deal — renderWB re-validates whatever comes back
   (pins change, tabs close), so a stale value degrades to the old default */
/**
 * @param {string} key project key
 * @param {string} taskId
 * @returns {number | string | null} the remembered tab (renderWB re-validates)
 */
export function taskTabRecall(key, taskId) {
  return taskTabsOf(key)[taskId] ?? null;
}

/* closed tabs — UI-only state (localStorage), so closing a tab never touches
   the task record: the file stays pinned and in the context packet */
/**
 * @param {string} key project key
 * @param {Task} task
 * @returns {Set<string>} the task's closed-tab file strings (localStorage-backed)
 */
export function getClosed(key, task) {
  const ck = `${key}/${task.id}`;
  if (!closedCache[ck]) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(`closedTabs:${ck}`) || '[]'); } catch { /* corrupt */ }
    closedCache[ck] = new Set(Array.isArray(arr) ? arr.map(String) : []);
  }
  return closedCache[ck];
}

/**
 * @param {string} key project key
 * @param {Task} task
 * @returns {void}
 */
export function persistClosed(key, task) {
  const ck = `${key}/${task.id}`;
  if (closedCache[ck]) localStorage.setItem(`closedTabs:${ck}`, JSON.stringify([...closedCache[ck]]));
}

/* ephemeral (◇ extra) tabs — per-browser VIEW state, same family as closed
   tabs / taskTab / addedViewers: persisted in localStorage so a refresh keeps
   the ad-hoc files you opened (folder browser, Δ jumps, ✎ source) AND the
   taskTab recall of an 'x:' tab passes normalization again. Capped so the
   list can't grow without bound; a persisted rel whose file has since gone
   renders the normal could-not-load tab with its × to dismiss. */
export const OPEN_EXTRA_CAP = 15;
/**
 * @param {string} key project key
 * @returns {string[]} the project's ◇ extra tab rels (hydrated from localStorage)
 */
export function extrasOf(key) {
  const per = perOf(key);
  if (!per.openExtra) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(`openExtra:${key}`) || '[]'); } catch { /* corrupt */ }
    per.openExtra = Array.isArray(arr)
      ? arr.filter((r) => typeof r === 'string' && r).slice(-OPEN_EXTRA_CAP)
      : [];
  }
  return per.openExtra;
}
/**
 * @param {string} key project key
 * @returns {void}
 */
export function persistExtras(key) {
  const per = perOf(key);
  if (!per.openExtra) return;
  if (per.openExtra.length > OPEN_EXTRA_CAP) {
    per.openExtra = per.openExtra.slice(-OPEN_EXTRA_CAP); // oldest tabs yield
  }
  try { localStorage.setItem(`openExtra:${key}`, JSON.stringify(per.openExtra)); } catch { /* private mode */ }
}

/** @type {(fi: *) => string | null} 'x:<rel>' tab id → rel (null for pins/'tail') */
export const extraRel = (fi) => (typeof fi === 'string' && fi.startsWith('x:')) ? fi.slice(2) : null;

/* session model choices — frontier models only, always explicit. Mirrors
   DEFAULT_MODEL in lib/taskStore.js: legacy tasks with model:null run (and
   display as) the default. */
export const DEFAULT_MODEL = 'claude-opus-5';
/** @type {ModelInfo[]} */
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5', label: 'Opus 5', isDefault: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
// Kept as a compatibility alias for the existing UI tests and any locally
// pinned extensions; live rendering uses providerModels().
export const MODELS = CLAUDE_MODELS;
/* reasoning effort — one control for both providers. Codex's ladder is
   minimal→xhigh, Claude's (the Agent SDK `effort` option) low→max; the shared
   middle rungs carry across a provider switch. Mirrors lib/models.js. */
/** @type {{ id: string, label: string }[]} */
export const CODEX_EFFORTS = [
  { id: 'minimal', label: 'minimal' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
];
/** @type {{ id: string, label: string }[]} */
export const CLAUDE_EFFORTS = [
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
];
// Kept as a compatibility alias (the Codex ladder, as before).
export const REASONING_EFFORTS = CODEX_EFFORTS;
export const DEFAULT_EFFORT = 'high';
/** @param {string} provider @returns {{ id: string, label: string }[]} */
export const effortsFor = (provider) => (provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS);
/** Nearest level the provider accepts (minimal↔low, max↔xhigh); unknown → high. */
export function coerceEffort(provider, effort) {
  if (effortsFor(provider).some(r => r.id === effort)) return effort;
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  return DEFAULT_EFFORT;
}
