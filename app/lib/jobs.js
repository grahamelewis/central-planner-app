// lib/jobs.js — live monitor for long-running script executions ("job cards").
//
// Two sources feed one registry:
//   'session' — a task turn's Bash tool call that runs a julia/R/python script
//               (detected from the streamed tool_use command). The process is
//               spawned by the SDK subprocess, so its stdout is NOT visible —
//               stats come from polling the process table: pid, %CPU, memory.
//   'run'     — the ▶ run path (lib/runner.js). We own the child, so on top of
//               the process stats the output stream is parsed for real progress
//               (iter N/M, percentages, ProgressMeter/txtProgressBar bars,
//               reported ETAs) plus a "quiet" clock (time since last output).
//
// One `ps` sweep (~every 2s) serves every live job. A job only becomes VISIBLE
// (broadcast as `job:status`, included in the snapshot's `jobs`) once it has
// run for MIN_AGE — quick scripts come and go without a card ever flashing.
// Ended jobs broadcast a terminal state and linger briefly for reloads.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { broadcast } from './events.js';
import { PROJECTS, ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';

const log = (...args) => console.log('[jobs]', ...args);
const logErr = (...args) => console.error('[jobs]', ...args);

// env seams so tests don't need to wait 8s per card
const MIN_AGE_MS = Number(process.env.CP_JOB_MIN_AGE_MS ?? 8000);
const POLL_MS = Math.max(250, Number(process.env.CP_JOB_POLL_MS ?? 2000));
const LINGER_MS = 30000;       // ended visible jobs stay for snapshot reloads
// session pid vanished but no tool_result yet (&& chains; also the ONLY end
// signal for backgrounded/detached jobs)
const PID_GONE_GRACE_MS = Number(process.env.CP_JOB_GONE_MS ?? 10000);
// bg/detached job whose process was never found — retire the watch instead of
// polling ps until the server restarts
const PID_FIND_TIMEOUT_MS = Number(process.env.CP_JOB_FIND_MS ?? 10 * 60 * 1000);
const KILL_ESCALATE_MS = 6000; // SIGTERM → SIGKILL if the tree ignores it

// key → job (see publicJob for the wire shape; underscore fields are internal)
const jobs = new Map();
let pollTimer = null;
let polling = false;

// ---------------------------------------------------------------------------
// Command detection — does this Bash command run a julia/R/python script file?
// ---------------------------------------------------------------------------

const INTERPRETERS = [
  { names: ['julia'], lang: 'julia', ext: /\.jl$/i },
  { names: ['rscript', 'r'], lang: 'r', ext: /\.(r|rmd)$/i },
  { names: ['python', 'python3', 'python2', 'uv'], lang: 'python', ext: /\.py$/i },
  // notebooks: `jupyter nbconvert --execute x.ipynb`, `jupyter execute`,
  // papermill, quarto render — the kernel does the long compute
  { names: ['jupyter', 'jupyter-nbconvert', 'jupyter-execute', 'jupyter-run', 'nbconvert', 'papermill'], lang: 'notebook', ext: /\.ipynb$/i },
  { names: ['quarto'], lang: 'notebook', ext: /\.(qmd|ipynb|rmd)$/i },
  { names: ['duckdb', 'psql', 'sqlite3', 'mysql'], lang: 'sql', ext: /\.sql$/i },
];

// inline-eval markers: `julia -e '…'`, `Rscript -e`, `python -c`, heredocs
const INLINE_FLAGS = new Set(['-e', '-E', '--eval', '-c']);

/**
 * Detect a script run inside a (possibly compound) shell command.
 * Token-based: per segment (split on && || ; |), find an interpreter token,
 * then the first later NON-FLAG token with the matching extension (so
 * `--output=out.ipynb` never wins over the actual input notebook). Returns
 * { lang, file, detached, inline } or null.
 *   detached — scripts/bg, nohup, setsid, or a trailing `&`: the card
 *     outlives the tool call (and, for truly detached processes, the turn).
 *   inline — `-e`/`-c`/heredoc evals with NO script file (file:null): a
 *     multi-minute GE solve is often a `julia -e` program, not a .jl file.
 *     A file match anywhere in the command beats an inline match.
 */
export function detectScriptRun(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  // Quote-severed compounds — `nohup bash -c 'until Rscript x.R; do …; done' &`
  // (a crash-resuming supervisor loop): the split below doesn't understand
  // quotes, so the `;` INSIDE the quoted program lands x.R in a segment that
  // carries neither the nohup nor the trailing `&`, and the per-segment flag
  // misses. The physical LINE still holds all three — a detach-marked line
  // containing the matched token makes the hit detached. (The [^&] guard keeps
  // a line-continuation `&&` from reading as a trailing `&`.)
  const detachedLine = (tok) => tok != null && cmd.split('\n').some((l) => l.includes(tok)
    && (/(^|\s)(nohup|setsid)\s/.test(l) || /(^|[\s/])scripts\/bg(\s|$)/.test(l)
      || /(^|[^&])&\s*$/.test(l)));
  let inlineHit = null;
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    let detached = /&\s*$/.test(seg);
    const tokens = seg.trim().replace(/&\s*$/, '').split(/\s+/)
      .map((t) => t.replace(/^['"]+|['"]+$/g, ''));
    let spec = null;
    let interpTok = null;
    let inline = false;
    let noInline = false; // module/subcommand runs: `python -m pip install -e .`
    let skipNext = false; // value-consuming flags: `--output out.ipynb`
    for (const tok of tokens) {
      if (!spec) {
        const base = tok.split('/').pop().toLowerCase();
        if (base === 'nohup' || base === 'setsid' || /(^|\/)scripts\/bg$/.test(tok)) {
          detached = true;
          continue;
        }
        spec = INTERPRETERS.find((i) => i.names.includes(base))
          || (/^python[\d.]*$/.test(base) ? INTERPRETERS[2] : null);
        if (spec) interpTok = tok;
        // `uv`'s own -e belongs to pip, never an eval
        if (spec && base === 'uv') noInline = true;
        continue;
      }
      if (skipNext) { skipNext = false; continue; }
      if (tok === '-m') noInline = true; // module run, not an inline program
      if (tok === '--output' || tok === '-o') { skipNext = true; continue; }
      if (INLINE_FLAGS.has(tok) || tok.startsWith('<<')) inline = true;
      if (tok.startsWith('-')) continue; // flags (incl. --output=x.ipynb)
      if (spec.ext.test(tok)) {
        return { lang: spec.lang, file: tok, detached: detached || detachedLine(tok), inline: false };
      }
    }
    if (spec && inline && !noInline && !inlineHit) {
      inlineHit = { lang: spec.lang, file: null, detached: detached || detachedLine(interpTok), inline: true };
    }
  }
  return inlineHit;
}

// display path: project-relative when the file sits under the project root
function displayFile(project, file) {
  try {
    const root = PROJECTS[project] && PROJECTS[project].root;
    if (root && file.startsWith(root.replace(/\/+$/, '') + '/')) {
      return file.slice(root.replace(/\/+$/, '').length + 1);
    }
  } catch { /* display only */ }
  return file;
}

// ---------------------------------------------------------------------------
// Progress parsing (runner jobs — the sources whose output we can see)
// ---------------------------------------------------------------------------

const ITER_RE = /(?:^|[^\w])(?:iter(?:ations?)?|steps?|epochs?|gen(?:erations?)?|draws?|samples?|reps?|sims?|folds?|rounds?|trials?|batch(?:es)?|it)\.?\s*[:#=]?\s*(\d+)\s*(?:\/|of\b|out of\b)\s*(\d+)/i;
const BRACKET_RE = /[[(](\d+)\s*\/\s*(\d+)[\])]/;
const PCT_RE = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%/;
const BARISH_RE = /[|┤┫]?[=＝#█▓▒░>▏▎▍▌▋▊▉·.]{4,}|Progress|progress|complete|finished/;
// ProgressMeter.jl / tqdm style reported ETA: "ETA: 0:03:12" (h:mm:ss) or "ETA: 2 days, 1:02:03"
const ETA_RE = /\bETA:?\s+(?:(\d+)\s*days?,?\s*)?(\d+):(\d{2})(?::(\d{2}))?/i;

/** Parse one output line → {iter, total, frac, etaS} (any subset) or null. */
export function parseProgressLine(line) {
  const s = String(line);
  if (!s || s.length > 2000) return null;
  const out = {};
  const eta = s.match(ETA_RE);
  if (eta) {
    const days = Number(eta[1] || 0);
    const a = Number(eta[2]); const b = Number(eta[3]); const c = eta[4] == null ? null : Number(eta[4]);
    // h:mm:ss when three parts, m:ss when two
    out.etaS = days * 86400 + (c == null ? a * 60 + b : a * 3600 + b * 60 + c);
  }
  let m = s.match(ITER_RE) || s.match(BRACKET_RE);
  if (m) {
    const iter = Number(m[1]); const total = Number(m[2]);
    if (total > 1 && total < 1e9 && iter >= 0 && iter <= total) {
      out.iter = iter; out.total = total; out.frac = iter / total;
    }
  }
  if (out.frac == null && BARISH_RE.test(s)) {
    m = s.match(PCT_RE);
    if (m) {
      const pct = Number(m[1]);
      if (pct >= 0 && pct <= 100) out.frac = pct / 100;
    }
  }
  return Object.keys(out).length ? out : null;
}

// feed a chunk of output into a job: quiet clock + line-wise progress
function feedOutput(job, chunk) {
  const now = Date.now();
  job.lastOutputAt = now;
  job._lineBuf = (job._lineBuf || '') + String(chunk);
  if (job._lineBuf.length > 16384) job._lineBuf = job._lineBuf.slice(-8192);
  // \r matters: ProgressMeter and R's txtProgressBar redraw with \r, no \n
  let cut;
  while ((cut = job._lineBuf.search(/[\r\n]/)) !== -1) {
    const line = job._lineBuf.slice(0, cut);
    job._lineBuf = job._lineBuf.slice(cut + 1);
    const p = parseProgressLine(line);
    if (p) noteProgress(job, p, now);
  }
}

function noteProgress(job, p, now) {
  const prog = job.progress || (job.progress = {});
  if (p.iter != null) { prog.iter = p.iter; prog.total = p.total; }
  if (p.frac != null) {
    // a lower frac by a wide margin = a new phase/loop — restart the history
    if (prog.frac != null && p.frac < prog.frac - 0.15) {
      job._hist = [];
      job._etaEma = null;
      delete prog.etaS;
    }
    prog.frac = p.frac;
    (job._hist = job._hist || []).push({ t: now, frac: p.frac });
    if (job._hist.length > 50) job._hist.shift();
  }
  if (p.etaS != null) {
    prog.etaS = p.etaS; // the script's own ETA beats our estimate
    job._etaReportedAt = now;
  } else if (prog.frac != null && (!job._etaReportedAt || now - job._etaReportedAt > 30000)) {
    const est = estimateEta(job, now);
    if (est != null) prog.etaS = est;
  }
}

function estimateEta(job, now) {
  const h = job._hist || [];
  if (h.length < 2) return null;
  const first = h[0]; const last = h[h.length - 1];
  const dt = (last.t - first.t) / 1000;
  const df = last.frac - first.frac;
  if (dt < 5 || df < 0.005) return null;
  const raw = (1 - last.frac) * (dt / df);
  if (!Number.isFinite(raw) || raw < 0 || raw > 48 * 3600) return null;
  // EMA so the display doesn't jitter with every line
  job._etaEma = job._etaEma == null ? raw : job._etaEma * 0.7 + raw * 0.3;
  return Math.round(job._etaEma);
}

// ---------------------------------------------------------------------------
// Registry + lifecycle
// ---------------------------------------------------------------------------

function publicJob(j) {
  const now = Date.now();
  return {
    key: j.key,
    source: j.source,
    project: j.project,
    taskId: j.taskId || null,
    file: j.file,
    lang: j.lang,
    command: j.command || null,
    state: j.state,
    bg: !!j.bg,
    detached: !!j.detached,
    inline: !!j.inline,
    stopping: !!j._stopReq,
    startedAt: new Date(j.t0).toISOString(),
    elapsedMs: j.state === 'running' ? now - j.t0 : (j.ms != null ? j.ms : now - j.t0),
    pid: j.pid || null,
    cpu: j.cpu != null ? j.cpu : null,
    mem: j.mem != null ? j.mem : null,
    progress: j.progress && j.progress.frac != null
      ? {
        frac: Math.min(1, Math.max(0, j.progress.frac)),
        iter: j.progress.iter ?? null,
        total: j.progress.total ?? null,
        etaS: j.progress.etaS ?? null,
      }
      : null,
    quietMs: j.source === 'run' && j.state === 'running' && j.lastOutputAt
      ? now - j.lastOutputAt : null,
    exitCode: j.exitCode ?? null,
    ms: j.ms ?? null,
  };
}

function emitJob(j) {
  if (!j.visible) return;
  try { broadcast('job:status', { project: j.project, job: publicJob(j) }); } catch (err) {
    logErr('broadcast failed:', err.message);
  }
}

function finish(j, state, extra = {}) {
  if (!j || j.state !== 'running') return;
  j.state = state;
  j.ms = Date.now() - j.t0;
  j.endedAt = Date.now();
  Object.assign(j, extra);
  if (j.progress && state === 'done') j.progress.frac = 1;
  if (j.visible) {
    emitJob(j);
    recordHistory(j); // the sidebar's activity feed remembers finished runs
  } else {
    jobs.delete(j.key); // never shown — nothing to clean up on screen
  }
  log(`${j.key} ${state} after ${(j.ms / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Run history — finished (visible) jobs, for the sidebar activity feed.
// Persisted so a server restart doesn't blank the feed's ▶ rows.
// ---------------------------------------------------------------------------

const HIST_CAP = 50;
const HIST_FILE = path.join(ROOT, 'jobhist.json');
let history = null; // {project: [record, ...]} oldest → newest

function loadHistory() {
  if (history) return history;
  history = {};
  try {
    if (fs.existsSync(HIST_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') history = parsed;
    }
  } catch (err) {
    logErr('job history unreadable — starting fresh:', err.message);
  }
  return history;
}

function recordHistory(j) {
  try {
    const h = loadHistory();
    const arr = h[j.project] || (h[j.project] = []);
    arr.push({
      ts: new Date(j.endedAt).toISOString(),
      file: j.file,
      lang: j.lang,
      source: j.source,
      state: j.state,
      ms: j.ms,
      taskId: j.taskId || null,
      bg: !!j.bg,
      detached: !!j.detached,
      ...(j.inline ? { inline: true } : {}),
    });
    if (arr.length > HIST_CAP) arr.splice(0, arr.length - HIST_CAP);
    writeFileAtomic(HIST_FILE, JSON.stringify(h));
  } catch (err) {
    logErr('job history record failed:', err.message);
  }
}

/** Finished runs for a project, oldest → newest (activity-feed source). */
export function getJobHistory(project) {
  const arr = loadHistory()[project];
  return Array.isArray(arr) ? arr.map((r) => ({ ...r })) : [];
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(tick, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

// ---------------------------------------------------------------------------
// Process-table sweep
// ---------------------------------------------------------------------------

// etime is [[dd-]hh:]mm:ss → ms of process age (start-time guard for detached
// pid discovery — never adopt an unrelated pre-existing run of the same script)
function etimeMs(s) {
  const m = String(s || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

function psSnapshot() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,tty=,args='],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        const now = Date.now();
        const procs = new Map(); // pid → {ppid, pcpu, rss, startMs, tty, args}
        const kids = new Map();  // ppid → [pid]
        for (const line of String(stdout).split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d:-]+)\s+(\S+)\s+(.*)$/);
          if (!m) continue;
          const pid = Number(m[1]); const ppid = Number(m[2]);
          const age = etimeMs(m[5]);
          procs.set(pid, {
            ppid, pcpu: Number(m[3]), rss: Number(m[4]),
            startMs: age == null ? null : now - age,
            tty: m[6],
            args: m[7],
          });
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push(pid);
        }
        resolve({ procs, kids });
      });
  });
}

function descendantsOf(snap, rootPid, includeRoot = false) {
  const out = includeRoot ? [rootPid] : [];
  const queue = [(rootPid)];
  const seen = new Set([rootPid]);
  while (queue.length) {
    for (const c of snap.kids.get(queue.shift()) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

const INTERP_ARGV0 = {
  julia: /(^|\/)julia(-[\w.]+)?$/i,
  r: /(^|\/)(Rscript|R)$/,
  python: /(^|\/)(python[\d.]*|uv)$/i,
  // nbconvert/papermill run under python; quarto is its own binary
  notebook: /(^|\/)(python[\d.]*|jupyter(-[\w.]+)?|papermill|quarto)$/i,
  sql: /(^|\/)(duckdb|psql|sqlite3|mysql)$/i,
  shell: /(^|\/)(bash|sh|zsh)$/,
};

// find the process for a session job: argv0 looks like the interpreter AND —
// when the job runs a script FILE — the args mention its basename. INLINE
// evals (`julia -e '…'`) have no filename to anchor on and match on the
// interpreter alone. Foreground/background tool runs search OUR descendants;
// detached launches (nohup/&/scripts/bg re-parent to launchd) search the
// whole table but must be TERMINAL-LESS — the user's own interactive REPL
// always has a tty and must never be adopted (Stop would kill it). EVERY
// job requires freshness: its process starts at (or after, behind an
// approval gate) its own tool call, so anything meaningfully older belongs
// to someone else — another task running the same script name, or the
// kaimon warm-REPL daemon (also excluded by name). Among candidates the one
// whose start time is closest to the job's own start wins, then a deeper
// descendant of the winner is preferred (juliaup's shim keeps the real
// binary as its child, started the same instant).
function findSessionPid(snap, job, claimed) {
  const base = job.inline ? null : String(job.file || '').split('/').pop();
  const re = INTERP_ARGV0[job.lang];
  if ((!base && !job.inline) || !re) return null;
  const pool = job.detached ? [...snap.procs.keys()] : descendantsOf(snap, process.pid);
  const candidates = [];
  for (const pid of pool) {
    if (claimed.has(pid) || pid === process.pid) continue;
    const p = snap.procs.get(pid);
    if (!p) continue;
    if (base && !p.args.includes(base)) continue;
    if (/kaimon/i.test(p.args)) continue; // never the warm REPL's tree
    const argv0 = p.args.split(/\s+/)[0] || '';
    if (!re.test(argv0)) continue;
    if (p.startMs != null && p.startMs < job.t0 - 30000) continue;
    if (job.detached && p.tty && p.tty !== '??' && p.tty !== '-') continue;
    candidates.push(pid);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const d = (pid) => {
      const s = snap.procs.get(pid).startMs;
      return s == null ? Infinity : Math.abs(s - job.t0);
    };
    return d(a) - d(b);
  });
  let best = candidates[0];
  for (const c of candidates) {
    if (c !== best && descendantsOf(snap, best).includes(c)) best = c;
  }
  return best;
}

// the pinned pid's private ancestor chain, recorded at pin time — stops
// before launchd/init AND before our own process (whose descendants span
// every task's shells, so they'd defeat the containment guarantee below)
function ancestryOf(snap, pid) {
  const chain = [];
  let cur = snap.procs.get(pid);
  while (cur && cur.ppid > 1 && cur.ppid !== process.pid && chain.length < 6) {
    chain.push(cur.ppid);
    cur = snap.procs.get(cur.ppid);
  }
  return chain;
}

// A supervisor loop (`nohup bash -c 'until Rscript x.R; do …; done' &`)
// respawns its interpreter after every crash. The vanished pid's immediate
// parent usually died with it (a caffeinate/sh wrapper waiting on the child),
// so re-pin by searching the nearest STILL-ALIVE recorded ancestor's
// descendants for the same interpreter + script. Tree containment replaces
// the freshness guard here: the chain never includes launchd or this server,
// so the search can't wander into another task's processes.
function findRespawn(snap, job, claimed) {
  const re = INTERP_ARGV0[job.lang];
  if (!re) return null;
  const base = job.inline ? null : String(job.file || '').split('/').pop();
  const root = (job._ancestry || []).find((pid) => snap.procs.has(pid));
  if (!root) return null;
  for (const pid of descendantsOf(snap, root)) {
    if (claimed.has(pid) || pid === process.pid) continue;
    const p = snap.procs.get(pid);
    if (!p) continue;
    if (base && !p.args.includes(base)) continue;
    if (/kaimon/i.test(p.args)) continue;
    if (!re.test(p.args.split(/\s+/)[0] || '')) continue;
    return pid;
  }
  return null;
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    // GC ended jobs past their linger
    for (const j of [...jobs.values()]) {
      if (j.state !== 'running' && j.endedAt && now - j.endedAt > LINGER_MS) jobs.delete(j.key);
    }
    if (!jobs.size) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const running = [...jobs.values()].filter((j) => j.state === 'running');
    if (!running.length) return;

    const snap = await psSnapshot();
    if (snap) {
      const claimed = new Set(running.map((j) => j.pid).filter(Boolean));
      for (const j of running) {
        // discover the pid of a session job (runner jobs are born with one)
        if (!j.pid && j.source === 'session') {
          const pid = findSessionPid(snap, j, claimed);
          if (pid) {
            j.pid = pid;
            j._ancestry = ancestryOf(snap, pid);
            claimed.add(pid);
            // late first sighting (approval gate, slow start): the clock
            // starts when the process actually appears, not at the tool call
            if (now - j.t0 > 5000) j.t0 = now;
            log(`${j.key} → pid ${pid}`);
          } else if ((j.bg || j.detached) && now - j.t0 > PID_FIND_TIMEOUT_MS) {
            // bg/detached jobs have no tool_result to end them — a process
            // that never appeared (crashed on launch, mis-detected command)
            // must not keep an invisible zombie job polling ps forever
            finish(j, 'done');
          }
        }
        if (j.pid) {
          if (snap.procs.has(j.pid)) {
            j._pidGoneAt = null;
            let cpu = 0; let rss = 0;
            for (const pid of descendantsOf(snap, j.pid, true)) {
              const p = snap.procs.get(pid);
              if (p) { cpu += p.pcpu; rss += p.rss; }
            }
            j.cpu = Math.round(cpu);
            j.mem = rss * 1024; // ps rss is KB
            // a stop was requested but the tree ignores SIGTERM → escalate
            if (j._stopReq && now - j._stopReq > KILL_ESCALATE_MS && !j._killed) {
              j._killed = true;
              for (const pid of descendantsOf(snap, j.pid, true)) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* raced exit */ }
              }
            }
          } else if (j.source === 'session') {
            // process gone but no tool_result yet — the shell may be running a
            // later command in a && chain; give the result a grace window
            if (j._stopReq) finish(j, 'stopped');
            else {
              const heir = findRespawn(snap, j, claimed);
              if (heir) {
                // a supervisor loop respawned the interpreter — follow it
                j.pid = heir;
                j._ancestry = ancestryOf(snap, heir);
                claimed.add(heir);
                j._pidGoneAt = null;
                log(`${j.key} → respawned pid ${heir}`);
              } else if (j.detached && (j._ancestry || []).some((p) => snap.procs.has(p))) {
                // between crash and respawn (the loop's sleep): the launch
                // tree is still alive, so hold the card — either a respawn
                // appears (re-pinned above) or the supervisor itself exits
                // (then the grace below ends the job)
                j._pidGoneAt = null;
              } else if (!j._pidGoneAt) j._pidGoneAt = now;
              else if (now - j._pidGoneAt > PID_GONE_GRACE_MS) finish(j, 'done');
            }
          }
        }
      }
    }
    // visibility + steady broadcast (elapsed/cpu/quiet tick for every client)
    for (const j of running) {
      if (j.state !== 'running') continue; // finished during this sweep
      if (!j.visible && now - j.t0 >= MIN_AGE_MS && (j.source === 'run' || j.pid)) {
        j.visible = true;
        log(`${j.key} visible (${j.lang} ${j.file})`);
      }
      emitJob(j);
    }
  } catch (err) {
    logErr('tick failed:', err.message);
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Session-source hooks (lib/sessions.js)
// ---------------------------------------------------------------------------

/** A Bash tool_use streamed. Registers a watch when the command runs a script
    OR an inline eval; harmless no-op otherwise. `bg` = the tool's
    run_in_background flag — the process runs on after its tool_result, so
    only the process table (or the turn ending) finishes the card. `label` =
    the tool call's own description — the card's title for inline evals,
    which have no filename to show. */
export function sessionJobStart(project, taskId, toolUseId, command, { bg = false, label = '' } = {}) {
  try {
    if (!toolUseId || !PROJECTS[project]) return null;
    const hit = detectScriptRun(command);
    if (!hit) return null;
    const key = `sess:${project}/${taskId}/${toolUseId}`;
    if (jobs.has(key)) return jobs.get(key);
    const squeezed = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const job = {
      key,
      source: 'session',
      project,
      taskId,
      toolUseId,
      file: hit.inline
        ? (squeezed || String(command).replace(/\s+/g, ' ').trim().slice(0, 60))
        : displayFile(project, hit.file),
      lang: hit.lang,
      command: String(command).slice(0, 300),
      state: 'running',
      t0: Date.now(),
      visible: false,
      pid: null,
      bg: !!bg,
      detached: !!hit.detached,
      inline: !!hit.inline,
    };
    jobs.set(key, job);
    ensurePolling();
    return job;
  } catch (err) {
    logErr('sessionJobStart failed:', err.message);
    return null;
  }
}

/** tool_progress heartbeat — elapsed_time_seconds is authoritative for how
    long the tool has actually been executing. */
export function sessionJobProgress(toolUseId, elapsedSeconds) {
  try {
    if (!toolUseId || !Number.isFinite(elapsedSeconds)) return;
    for (const j of jobs.values()) {
      if (j.source !== 'session' || j.toolUseId !== toolUseId || j.state !== 'running') continue;
      const t0 = Date.now() - elapsedSeconds * 1000;
      if (Math.abs(t0 - j.t0) > 3000) j.t0 = t0;
      return;
    }
  } catch { /* display only */ }
}

/** The Bash tool_result landed. For a foreground run that IS the end; for a
    backgrounded/detached launch it's just the launch ack — the process runs
    on, and the card ends when the process does (an error ack means it never
    started). */
export function sessionJobEnd(toolUseId, { error = false } = {}) {
  try {
    if (!toolUseId) return;
    for (const j of jobs.values()) {
      if (j.source !== 'session' || j.toolUseId !== toolUseId) continue;
      if ((j.bg || j.detached) && !error && !j._stopReq) return;
      finish(j, j._stopReq ? 'stopped' : error ? 'error' : 'done');
      return;
    }
  } catch { /* display only */ }
}

/** Turn over (completed, errored, or interrupted) — background shells die
    with the turn, so their cards end here too. Truly DETACHED jobs survive
    the turn by design: their card stays live until the process exits. */
export function endSessionJobsFor(project, taskId, state = 'stopped') {
  try {
    for (const j of jobs.values()) {
      if (j.source === 'session' && j.project === project && j.taskId === taskId && j.state === 'running') {
        if (j.detached) continue;
        finish(j, j._stopReq ? 'stopped' : state);
      }
    }
  } catch { /* display only */ }
}

// ---------------------------------------------------------------------------
// Runner-source hooks (lib/runner.js)
// ---------------------------------------------------------------------------

const RUN_LANGS = { '.jl': 'julia', '.r': 'r', '.py': 'python', '.sh': 'shell', '.sql': 'sql' };

/** A ▶ run started. tex compiles keep their own build card — not a job. */
export function runJobStart(project, rel, pid, command) {
  try {
    if (!PROJECTS[project] || !pid) return null;
    const ext = ('.' + String(rel).split('.').pop()).toLowerCase();
    const lang = RUN_LANGS[ext];
    if (!lang) return null;
    const key = `run:${project}`;
    const job = {
      key,
      source: 'run',
      project,
      file: rel,
      lang,
      command: String(command || '').slice(0, 300),
      state: 'running',
      t0: Date.now(),
      visible: false,
      pid,
      lastOutputAt: Date.now(),
    };
    jobs.set(key, job); // one run per project — a new run replaces the old card
    ensurePolling();
    return job;
  } catch (err) {
    logErr('runJobStart failed:', err.message);
    return null;
  }
}

export function runJobOutput(project, chunk) {
  try {
    const j = jobs.get(`run:${project}`);
    if (j && j.state === 'running') feedOutput(j, chunk);
  } catch { /* display only */ }
}

export function runJobEnd(project, { state = 'done', exitCode = null, ms = null } = {}) {
  try {
    const j = jobs.get(`run:${project}`);
    if (!j) return;
    // the runner's own duration is authoritative — it must land BEFORE
    // finish() broadcasts the terminal state and records the history row
    finish(j, state === 'running' ? 'done' : state,
      { exitCode, ...(ms != null ? { ms } : {}) });
  } catch { /* display only */ }
}

// ---------------------------------------------------------------------------
// Stop + snapshot
// ---------------------------------------------------------------------------

/** Stop a SESSION job: SIGTERM the process and its descendants (individually —
    never the group, which the SDK subprocess may share). Runner jobs stop via
    runner.stopRun (server dispatches by key prefix). The job stays 'running'
    with stopping:true until the process actually dies — honest state. */
export function stopSessionJob(project, key) {
  const j = jobs.get(String(key));
  if (!j || j.source !== 'session' || j.project !== project) {
    const err = new Error(`no such job: ${key}`);
    err.status = 404;
    throw err;
  }
  if (j.state !== 'running') return { ok: true };
  if (!j.pid) {
    const err = new Error('job process not identified yet — try again in a moment');
    err.status = 409;
    throw err;
  }
  j._stopReq = Date.now();
  psSnapshot().then((snap) => {
    const pids = snap ? descendantsOf(snap, j.pid, true) : [j.pid];
    pids.reverse(); // children first
    // a supervisor loop would respawn the interpreter the moment it dies —
    // kill the loop FIRST. Only recorded ancestors that have re-parented to
    // launchd qualify: while the turn is live the chain can still contain
    // the SDK's own shell, which must survive its tool call.
    if (snap) {
      const sups = (j._ancestry || []).filter((a) => snap.procs.get(a)?.ppid === 1);
      pids.unshift(...sups);
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }).catch(() => { try { process.kill(j.pid, 'SIGTERM'); } catch { /* gone */ } });
  emitJob(j); // stopping:true reaches the card immediately
  return { ok: true };
}

/** Visible jobs for the /api/state snapshot (reload mid-run re-seeds cards). */
export function getJobs() {
  return [...jobs.values()].filter((j) => j.visible).map(publicJob);
}

// test seam: reach the internals without exporting them for production use
export const _test = { jobs, tick, findSessionPid, descendantsOf, psSnapshot, feedOutput };
