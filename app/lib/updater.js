// lib/updater.js — keep the dashboard itself up to date with its origin repo.
// Once a day (and once shortly after boot) the app repo is fetched and HEAD is
// compared against its upstream; when commits are waiting the frontend shows a
// badge on the profile button and Settings offers a one-click update
// (fast-forward pull + npm install when app/package*.json changed).
//
// Safety: every git call is execFile with an args array (no shell), fully
// non-interactive, and applyUpdate refuses anything that isn't a clean
// fast-forward — dirty tracked files or local commits diverging from the
// remote get a clear message instead of a merge. Env seams for tests:
//   CP_UPDATE_REPO      repo dir override (harness pins a non-repo → no-op)
//   CP_UPDATE_CHECK_MS  periodic check interval (default 24h)
import fs from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR } from './config.js';
import { broadcast } from './events.js';
import { readDeployment, deployRelease } from './deployment.js';

const execFileAsync = promisify(execFile);

const INSTALLATION_ROOT = process.env.CP_INSTALLATION_ROOT || null;
const installation = INSTALLATION_ROOT ? readDeployment(INSTALLATION_ROOT) : null;
// A test/development override must never redirect an installed updater into a
// different repository before deployment's identity checks can run.
const REPO_DIR = installation?.sourceRoot || (process.env.CP_UPDATE_REPO
  ? path.resolve(process.env.CP_UPDATE_REPO)
  : path.resolve(APP_DIR, '..')); // source checkout, never installed payload
const CHECK_EVERY_MS = Number(process.env.CP_UPDATE_CHECK_MS) > 0
  ? Number(process.env.CP_UPDATE_CHECK_MS)
  : 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3000; // don't compete with boot
const COMMITS_SHOWN = 12;

const log = (...a) => console.log('[updater]', ...a);
const logErr = (...a) => console.error('[updater]', ...a);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Run one git command in the app repo. Never throws — returns
// { ok, code, stdout, stderr, message } like lib/git.js's helper.
async function git(args, { timeout = 60_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: REPO_DIR,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
      },
    });
    return { ok: true, code: 0, stdout, stderr, message: null };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      message: err.killed ? `git ${args[0]} timed out` : (err.message || String(err)),
    };
  }
}

function isRepo() {
  try { return fs.existsSync(path.join(REPO_DIR, '.git')); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Status — one object the snapshot and the update:status event both carry
// ---------------------------------------------------------------------------

// state: 'unknown' (no check yet) | 'unavailable' (not a git checkout / no
// upstream) | 'checking' | 'ok' | 'behind' | 'updating' | 'error'
let status = {
  state: 'unknown',
  branch: null, upstream: null, head: null,
  behind: 0, ahead: 0, dirty: false,
  commits: [],          // incoming [{sha, subject}] — newest first, capped
  lastChecked: null,
  error: null,
  updated: null,        // { from, to, npmInstalled, needsRestart } after an update
};

function setStatus(patch) {
  status = { ...status, ...patch };
  try { broadcast('update:status', status); } catch { /* pre-wss boot */ }
  return status;
}

export function getUpdateStatus() {
  return status;
}

// Resolve the ref we compare against / fast-forward to: the branch's
// configured upstream, else origin/<branch>, else origin/main|master.
async function resolveUpstream(branch) {
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.ok && up.stdout.trim()) return up.stdout.trim();
  for (const cand of [`origin/${branch}`, 'origin/main', 'origin/master']) {
    const r = await git(['rev-parse', '--verify', '--quiet', cand]);
    if (r.ok) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check — fetch + count how far behind upstream we are
// ---------------------------------------------------------------------------

let checkInFlight = null;

export function checkForUpdates() {
  if (checkInFlight) return checkInFlight; // single-flight
  checkInFlight = doCheck().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function doCheck() {
  if (!isRepo()) {
    return setStatus({ state: 'unavailable', error: 'not a git checkout — updates unmanaged', lastChecked: new Date().toISOString() });
  }
  setStatus({ state: 'checking', error: null });

  const br = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.ok ? br.stdout.trim() : null;
  if (!branch || branch === 'HEAD') {
    return setStatus({ state: 'unavailable', branch, error: 'detached HEAD — updates unmanaged', lastChecked: new Date().toISOString() });
  }
  const upstream = await resolveUpstream(branch);
  if (!upstream) {
    return setStatus({ state: 'unavailable', branch, error: 'no upstream remote found', lastChecked: new Date().toISOString() });
  }

  // fetch quietly; being offline must not break the dashboard — fall back to
  // comparing against the last-fetched remote ref and say so
  const remote = upstream.split('/')[0];
  const fetched = await git(['fetch', '--quiet', remote], { timeout: 45_000 });

  const head = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim() || null;
  const deployed = INSTALLATION_ROOT ? readDeployment(INSTALLATION_ROOT) : null;
  const baseline = deployed?.sourceRevision || 'HEAD';
  const behindR = await git(['rev-list', '--count', `${baseline}..${upstream}`]);
  const aheadR = await git(['rev-list', '--count', `${upstream}..HEAD`]);
  if (!behindR.ok) {
    return setStatus({ state: 'error', branch, upstream, head, error: behindR.message || combinedErr(behindR), lastChecked: new Date().toISOString() });
  }
  const behind = Number(behindR.stdout.trim()) || 0;
  const ahead = aheadR.ok ? (Number(aheadR.stdout.trim()) || 0) : 0;

  let commits = [];
  if (behind > 0) {
    const logR = await git(['log', '--pretty=%h%x09%s', '-n', String(COMMITS_SHOWN), `${baseline}..${upstream}`]);
    if (logR.ok) {
      commits = logR.stdout.split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf('\t');
        return { sha: l.slice(0, i), subject: l.slice(i + 1) };
      });
    }
  }
  // untracked files never block a fast-forward — only tracked modifications do
  const dirtyR = await git(['status', '--porcelain', INSTALLATION_ROOT ? '--untracked-files=all' : '--untracked-files=no']);
  const dirty = dirtyR.ok ? dirtyR.stdout.trim().length > 0 : false;

  const next = setStatus({
    state: behind > 0 ? 'behind' : 'ok',
    branch, upstream, head, behind, ahead, dirty, commits,
    lastChecked: new Date().toISOString(),
    error: fetched.ok ? null : `fetch failed (offline?) — comparing against the last-fetched ${upstream}`,
  });
  if (behind > 0) log(`update available: ${behind} commit(s) behind ${upstream}`);
  return next;
}

function combinedErr(r) {
  return `${r.stderr || ''}\n${r.stdout || ''}`.trim().slice(0, 400) || 'git failed';
}

// ---------------------------------------------------------------------------
// Apply — fast-forward to upstream, npm install if the app deps changed
// ---------------------------------------------------------------------------

let updating = false;

export async function applyUpdate() {
  if (updating) throw httpError(409, 'an update is already running');
  updating = true;
  try {
    // always work from a fresh look at the remote
    const s = await checkForUpdates();
    if (s.state === 'unavailable') throw httpError(400, s.error || 'updates unmanaged here');
    if (s.state === 'error') throw httpError(500, s.error || 'update check failed');
    if (!s.behind) return { ok: true, alreadyUpToDate: true };
    if (s.dirty) {
      throw httpError(409, 'local changes present — commit or stash them, then update');
    }
    if (s.ahead > 0) {
      throw httpError(409, `local commits diverge from ${s.upstream} — resolve manually (git pull --rebase)`);
    }

    setStatus({ state: 'updating' });
    const from = INSTALLATION_ROOT ? readDeployment(INSTALLATION_ROOT).sourceRevision : s.head;
    const merged = await git(['merge', '--ff-only', s.upstream]);
    if (!merged.ok) {
      setStatus({ state: 'error', error: `fast-forward failed: ${combinedErr(merged)}` });
      throw httpError(409, `fast-forward failed: ${combinedErr(merged)}`);
    }
    const to = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim() || null;

    if (INSTALLATION_ROOT) {
      try {
        const configured = readDeployment(INSTALLATION_ROOT);
        await deployRelease({ sourceRoot: REPO_DIR, installationRoot: INSTALLATION_ROOT, dataRoot: configured.dataRoot });
      } catch (error) {
        setStatus({ state: 'error', error: 'Release staging failed; the previous production release remains selected.' });
        throw httpError(500, `Release staging failed; previous release retained: ${error.message}`);
      }
      const updated = { from, to, npmInstalled: true, needsRestart: true, productionRelease: true };
      await checkForUpdates();
      setStatus({ updated });
      return { ok: true, ...updated };
    }

    // new dependencies? npm install before the user restarts into them
    let npmInstalled = false;
    let npmError = null;
    const changed = await git(['diff', '--name-only', `${from}..HEAD`, '--', 'app/package.json', 'app/package-lock.json']);
    if (changed.ok && changed.stdout.trim()) {
      log('app dependencies changed — running npm install');
      try {
        // install into the UPDATED checkout's app dir — REPO_DIR, not
        // APP_DIR: they're the same tree in production, but the git ops all
        // honor the CP_UPDATE_REPO override and the install must too (it was
        // the one path a test fixture could point at the real checkout/network)
        await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: path.join(REPO_DIR, 'app'), timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
        });
        npmInstalled = true;
      } catch (err) {
        npmError = (err && err.message) || String(err);
        logErr('npm install failed after update:', npmError);
      }
    }

    const updated = { from, to, npmInstalled, npmError, needsRestart: true };
    log(`updated ${from} → ${to}${npmInstalled ? ' (npm install ran)' : ''}`);
    // recount so the badge clears everywhere; keep the updated note visible
    await checkForUpdates();
    setStatus({ updated });
    return { ok: true, ...updated };
  } finally {
    updating = false;
  }
}

// ---------------------------------------------------------------------------
// Schedule — once shortly after boot, then daily
// ---------------------------------------------------------------------------

export function startUpdateChecks() {
  const kick = () => checkForUpdates().catch((err) => logErr('check failed:', err && err.message));
  setTimeout(kick, FIRST_CHECK_DELAY_MS).unref();
  setInterval(kick, CHECK_EVERY_MS).unref();
}
