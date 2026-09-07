// Shared configuration — single source of truth for paths and projects.
// Other modules import from here; do not duplicate these constants.
//
// All user-specific values live in a gitignored `config.json` at the repo root
// (see config.example.json for the shape). This file is just the loader: it
// resolves each setting as  env var > config.json > built-in default. The repo
// ships with NO personal data — projects/name come only from config.json, which
// the guided setup writes. The CP_* env vars still take precedence so the test
// harness (test/serverHarness.mjs) keeps running against throwaway dirs:
//   CP_ROOT           data root (tasks/, ledger/, snapshots/, transcripts/, …)
//   CP_PORT           listen port
//   CP_PROJECTS_JSON  the whole projects object as JSON
//   CP_NTFY_TOPIC     override ntfy topic ('' silences pushes)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

export const APP_DIR = path.resolve(__dirname, '..');          // .../projectManager/app
// dataRoot is env-only (CP_ROOT): it locates config.json itself, so it can't
// live inside that file. Defaults to the repo root (the parent of app/).
export const ROOT = env.CP_ROOT ? path.resolve(env.CP_ROOT) : path.resolve(APP_DIR, '..');

// Load config.json from the data root. Missing → blank (triggers first-run
// setup). Malformed → fail SOFT: log loudly and start blank so the dashboard
// still loads and the user can fix the file, rather than crashing the server.
function loadUserConfig() {
  const file = path.join(ROOT, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // no config.json yet — fresh clone / pre-setup
  }
  try {
    const cfg = JSON.parse(raw);
    return (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  } catch (err) {
    console.error(`\n[config] ${file} is not valid JSON: ${err.message}`);
    console.error('[config] starting with NO projects — fix config.json and restart.\n');
    return {};
  }
}

const CFG = loadUserConfig();
const ntfy = (CFG.notifications && typeof CFG.notifications === 'object') ? CFG.notifications : {};

export const PORT = env.CP_PORT ? Number(env.CP_PORT) : (CFG.port || 4242);

// PROJECTS stays a plain, MUTABLE object — the in-process tests (paths/pins)
// inject and delete their own key. Never freeze it or make it a getter.
export const PROJECTS = env.CP_PROJECTS_JSON
  ? JSON.parse(env.CP_PROJECTS_JSON)
  : (CFG.projects && typeof CFG.projects === 'object' ? CFG.projects : {});

// Display name shown top-left and in the generated profile. Blank → the UI
// shows a neutral placeholder until setup runs.
export const USER_NAME = (CFG.user && typeof CFG.user.name === 'string') ? CFG.user.name : '';

// Directory names the artifact watcher, the pin-a-file picker, the folder-pin
// tree map and the /api/ls listings all skip. Beyond the classic dependency /
// data dirs this carries the wave-1 language build outputs, so `cargo build`
// churn in target/ or a `next build` never floods artifact:new or a tree map:
//   target (cargo)   dist/build/out (bundlers, cmake -B build, tsc outDir)
//   .next/.nuxt/.turbo/.cache/coverage (node toolchains)   .gradle (jvm)
// Deliberately NOT here: `bin` (a real source dir in Go's cmd layout and in
// scripts/bin; cargo and cmake outputs live under target/ and build/ anyway)
// and `vendor` unconditionally — Go's vendored modules are ignored only when a
// go.mod sits beside the vendor dir (IGNORE_DIR_IF_SIBLING); a research
// project's own vendor/ of third-party tex/js stays visible.
export const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules', '.git', 'data', '_literature', 'literature', '.claude', 'renv', '.venv', '__pycache__',
  'target', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.gradle',
]);
// name → sibling files, any one of which (in the same parent dir) makes the
// directory ignored. Users can extend this via artifactGlobs.ignoreDirIfSibling.
export const IGNORE_DIR_IF_SIBLING = Object.freeze({ vendor: ['go.mod'] });

// config.json's `artifactGlobs` overrides per key (a user setting only
// `maxDepth` keeps the default ignores; `ignoreDirs` REPLACES the whole list).
export const ARTIFACT_GLOBS = (() => {
  const o = (CFG.artifactGlobs && typeof CFG.artifactGlobs === 'object') ? CFG.artifactGlobs : {};
  return {
    ignoreDirs: Array.isArray(o.ignoreDirs) ? o.ignoreDirs.map(String) : [...DEFAULT_IGNORE_DIRS],
    ignoreDirIfSibling: (o.ignoreDirIfSibling && typeof o.ignoreDirIfSibling === 'object')
      ? o.ignoreDirIfSibling : IGNORE_DIR_IF_SIBLING,
    maxDepth: typeof o.maxDepth === 'number' && o.maxDepth > 0 ? o.maxDepth : 6,
  };
})();

const IGNORE_DIR_SET = new Set(ARTIFACT_GLOBS.ignoreDirs);

/**
 * Is a directory entry one the scanners skip? `name` is the entry's basename,
 * `parentDir` its containing directory (absolute) — needed only for the
 * sibling-conditional names (vendor/ next to a go.mod); the plain-name check
 * costs nothing. Never throws.
 */
export function isIgnoredDir(name, parentDir) {
  if (IGNORE_DIR_SET.has(name)) return true;
  const siblings = ARTIFACT_GLOBS.ignoreDirIfSibling[name];
  if (!Array.isArray(siblings) || !parentDir) return false;
  for (const s of siblings) {
    try { if (fs.existsSync(path.join(parentDir, s))) return true; } catch { /* unreadable → not ignored */ }
  }
  return false;
}

export const WEEKLY_HOUR_TARGET = typeof CFG.weeklyHourTarget === 'number' ? CFG.weeklyHourTarget : 35;

// FALLBACK budgets for the status bar's usage meter (lib/ledger.js →
// usageWindows). On an OAuth login the meter shows the REAL plan windows the
// Agent SDK reports (lib/usage.js) and these are unused; they only apply before
// the first turn has fetched a reading, or on an ANTHROPIC_API_KEY install
// where no plan windows exist. They are the user's own targets — no API
// exposes a subscription's remaining quota — and THE DEFAULTS ARE GUESSES,
// sized for heavy agent use so a fresh install doesn't sit pegged at 100%.
//   "usageLimits": false     → PLAN-ONLY: real windows when available, and the
//                              meter hides when there is no reading, rather
//                              than estimating against an invented budget
export const USAGE_LIMITS = (() => {
  const u = CFG.usageLimits;
  if (u === false) return null;
  const o = (u && typeof u === 'object') ? u : {};
  const num = (v, dflt) => (typeof v === 'number' && v > 0 ? v : dflt);
  return {
    sessionHours: num(o.sessionHours, 5),
    sessionTokens: num(o.sessionTokens, 10_000_000),
    weeklyTokens: num(o.weeklyTokens, 150_000_000),
    // the model with its own weekly cap, and that cap
    topModel: typeof o.topModel === 'string' ? o.topModel : 'claude-fable-5-1',
    topModelWeeklyTokens: num(o.topModelWeeklyTokens, 30_000_000),
  };
})();

// Kaimon warm-Julia-REPL integration (default ON when the kaimon binary is
// installed; the dashboard manages the daemon itself — see lib/kaimon.js).
//   "kaimon": false                          → disable entirely
//   "kaimon": { "bin"?, "idleMinutes"? }     → optional tuning
// A legacy v0 block ({"mcpServer": …}, the removed bring-your-own-daemon
// shape) is ignored with a warning rather than misread.
export const KAIMON_CFG = (() => {
  const k = CFG.kaimon;
  if (k === false) return { enabled: false };
  if (k && typeof k === 'object') {
    if (k.mcpServer) {
      console.error('[config] legacy kaimon block ignored — the dashboard now manages the daemon itself; set "kaimon": false to disable');
      return { enabled: true };
    }
    return {
      enabled: true,
      bin: typeof k.bin === 'string' ? k.bin : null,
      idleMinutes: typeof k.idleMinutes === 'number' && k.idleMinutes > 0 ? k.idleMinutes : null,
    };
  }
  return { enabled: true };
})();

// Push notifications via ntfy.sh. The topic is the only secret — anyone who
// knows it can read/send on it, so keep it random. Empty string disables
// notifications. Default is OFF — a clone must opt in via config.json.
export const NTFY_TOPIC = env.CP_NTFY_TOPIC !== undefined ? env.CP_NTFY_TOPIC : (ntfy.ntfyTopic || '');
// Base URL notifications link to (e.g. a tailscale serve URL). Empty → no link.
export const NTFY_CLICK_BASE = ntfy.ntfyClickBase || '';
// ntfy.sh is a PUBLIC broker — anyone who learns the topic can read pushes.
// false (default): notifications carry only the task title + event type.
// true: include question text / handoff summaries / tool details in the body.
export const NTFY_DETAIL = ntfy.ntfyDetail === true;
// Questions, handoffs, errors and sign-in notices at turn end can be muted
// independently of approval requests. Also sent to the desktop notifier.
export const NOTIFY_TURN_END = ntfy.turnEnd !== false;
