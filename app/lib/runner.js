// lib/runner.js — run a pinned file and stream its output to the UI. WHAT to
// run comes from lib/runtimes.js (resolveRunTarget: the registry's per-runtime
// recipe — julia/python/R/shell/sql/tex as before, plus rust/go/node/c/cpp —
// resolved against the nearest project marker); this module only executes the
// plan: sequential steps in one run, an optional pty for block-buffering
// runtimes, the job card hooks, the tex build card. One run per project at a
// time; spawn with an args array (never a shell string); never crashes the
// process.
import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from './events.js';
import { PROJECTS } from './config.js';
import { containedPath } from './paths.js';
import { problemsFromLog } from './watchers.js';
import { problemCounts, passFromLine } from './texlog.js';
import { runJobStart, runJobStep, runJobOutput, runJobEnd } from './jobs.js';
import { resolveRunTarget, ptyArgv } from './runtimes.js';

const TAIL_CAP = 200000; // rolling output kept server-side so reloads mid-run still show it (matches the frontend cap)

// project → { child, info: {rel, cmdLine, display, runtime, mode, phase, phases, step, state, exitCode, startedAt, ms, tail}, killed, spec }
const runs = new Map();

function broadcastStatus(project) {
  try {
    const r = runs.get(project);
    if (!r) return;
    const { tail, ...rest } = r.info;
    broadcast('run:status', { project, run: rest });
  } catch (err) {
    console.error('[runner] broadcast run:status failed:', err.message);
  }
}

// Merge a pty-wrapped stream: script(1) echoes the \n it receives as \r\n
// (a bare \r — a progress bar's redraw — passes through untouched) and, with
// stdin on /dev/null, prints "^D\b\b" once at the start. A trailing \r is held
// until the next chunk so a \r\n split across chunks still collapses.
function ptyClean(r, text) {
  let t = text;
  if (r.ptyCR) { t = '\r' + t; r.ptyCR = false; }
  if (!r.ptySeen) { r.ptySeen = true; t = t.replace(/^\^D\x08\x08/, ''); }
  if (t.endsWith('\r')) { r.ptyCR = true; t = t.slice(0, -1); }
  return t.replace(/\r\n/g, '\n');
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Append + broadcast for a SPECIFIC run record — late chunks from a superseded
// child must never leak into the next run's output.
function emit(project, r, chunk, fd) {
  if (runs.get(project) !== r) return;
  r.info.tail = (r.info.tail + chunk).slice(-TAIL_CAP);
  r.info.bytes = (r.info.bytes || 0) + chunk.length; // cumulative — lets clients
  try {                                              // drop replayed chunks after a reconnect
    broadcast('run:stream', { project, chunk, off: r.info.bytes, ...(fd ? { fd } : {}) }); // fd 2 = stderr (UI colors it)
  } catch (err) {
    console.error('[runner] broadcast run:stream failed:', err.message);
  }
}

// the run's terminal state: exit code/signal of the step that ended it,
// tex problems for compiles, the job card's end, one status broadcast
function finishRun(project, r, { code, signal }) {
  const cur = runs.get(project);
  if (!cur || cur !== r || r.info.state !== 'running') return;
  r.info.exitCode = code;
  r.info.ms = Date.now() - r.t0;
  r.info.state = r.killed ? 'stopped' : code === 0 ? 'done' : 'error';
  if (r.spec.tex) {
    // tex runs: surface the .log's errors/warnings to the editor UI
    r.info.pass = null;
    r.info.problems = problemsFromLog(project, r.spec.tex);
    r.info.counts = problemCounts(r.info.problems);
  }
  // the signal NAME rides the job's exit (code and signal are mutually
  // exclusive in Node); byUser = our own SIGTERM (stop button / shutdown)
  runJobEnd(project, {
    state: r.info.state, exitCode: code, ms: r.info.ms,
    exit: { code, signal: signal || null, byUser: !!r.killed },
  });
  broadcastStatus(project);
}

// Spawn step i of the run's plan. Steps run sequentially in ONE run: a
// non-zero exit ends the run with that step's code/signal (its stderr is
// already in the tail); exit 0 with steps left launches the next. A step
// marked `pty` runs under script(1) when it is installed — C/C++ stdio
// block-buffers when piped, so the card would otherwise see nothing until
// exit — with stderr merged into the one stream; the plain pipe is the
// fallback. A `deferred` step (cmake/make's produced executable) is decided
// only once its build step has run.
function launchStep(project, r, i) {
  const { spec } = r;
  let step = spec.steps[i];
  if (step.deferred) {
    let resolved = null;
    try { resolved = step.deferred(); } catch (err) { resolved = { skip: err.message }; }
    if (!resolved || resolved.skip) {
      emit(project, r, `[runner] ${(resolved && resolved.skip) || 'nothing to run'}\n`);
      r.info.phase = 'built';
      r.info.step = { i, n: spec.steps.length };
      finishRun(project, r, { code: 0, signal: null });
      return;
    }
    step = { ...step, ...resolved, deferred: null };
  }
  r.info.step = { i, n: spec.steps.length };
  r.info.phase = step.phase || null;
  r.info.cmdLine = step.display; // the footer shows the step that is running
  if (i > 0) emit(project, r, `[runner] ${step.display}\n`);

  let argv = { cmd: step.cmd, args: step.args || [] };
  let pty = false;
  if (step.pty) {
    const wrapped = ptyArgv(step.cmd, step.args || []);
    if (wrapped) { argv = wrapped; pty = true; }
  }
  const env = { ...process.env, ...(step.env || {}) };
  const child = spawn(argv.cmd, argv.args, {
    cwd: step.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: true, // own process group, so stop/cleanup reaches grandchildren
  });
  r.child = child;
  r.pty = pty;
  r.ptySeen = false;
  r.ptyCR = false;

  // live job card: pid/CPU/elapsed + output-parsed progress (tex compiles
  // keep their own build card — spec.card is false for them)
  if (child.pid && spec.card) {
    // block-buffered stdout (python without PYTHONUNBUFFERED; C/C++ when the
    // pty fallback kicked in) makes the card's line rate a fiction — say so
    const buffered = spec.buffered
      ? !pty
      : !!(spec.bufferedWithoutEnv && !env[spec.bufferedWithoutEnv]);
    // under script(1) the spawned pid is the wrapper — pin its child, the program
    const pin = pty ? 'child' : (spec.pin || 'self');
    const argv0 = pty ? new RegExp(`${escapeRe(step.cmd)}$`) : spec.argv0;
    // the card's phase chip follows the step of a MULTI-step plan (compiling
    // → running); a single-step run keeps phase null until its parser reads
    // one from the output, exactly as before the registry
    const phase = spec.steps.length > 1 ? step.phase : null;
    const opts = { buffered, lang: spec.runtime, phase, parser: step.parser, pin, argv0 };
    if (i === 0) runJobStart(project, r.info.rel, child.pid, step.display, opts);
    else runJobStep(project, { pid: child.pid, command: step.display, ...opts });
  }

  // tex runs: scan stdout lines for latexmk's rule announcements + page
  // counts so the UI's build card shows honest progress without the raw log
  let texLineBuf = '';
  const scanTexLines = (chunk) => {
    if (!spec.tex) return;
    texLineBuf += chunk;
    if (texLineBuf.length > 16384) texLineBuf = texLineBuf.slice(-8192); // stray newline-less floods
    let nl;
    while ((nl = texLineBuf.indexOf('\n')) !== -1) {
      const line = texLineBuf.slice(0, nl);
      texLineBuf = texLineBuf.slice(nl + 1);
      const pass = passFromLine(line);
      const pages = line.match(/^Output written on [^(]*\((\d+) pages?/);
      if (pass) {
        r.info.pass = pass;
        broadcastStatus(project);
      } else if (pages) {
        r.info.pages = Number(pages[1]);
      }
    }
  };
  // both fds, in arrival order — ProgressMeter.jl, tqdm and the cargo bar
  // report on stderr, and the parsers expect one merged stream
  const onData = (fd) => (chunk) => {
    try {
      if (r.child !== child) return;
      let text = chunk.toString('utf8');
      if (pty) text = ptyClean(r, text);
      if (!text) return;
      emit(project, r, text, pty ? undefined : fd);
      if (fd === undefined) scanTexLines(text);
      if (runs.get(project) === r) runJobOutput(project, text);
    } catch (err) {
      console.error('[runner] stream handler error:', err.message);
    }
  };
  child.stdout.on('data', onData(undefined));
  child.stderr.on('data', onData(2));
  child.on('error', (err) => {
    const cur = runs.get(project);
    if (!cur || cur !== r || r.child !== child || r.info.state !== 'running') return;
    const msg = err.code === 'ENOENT' ? `${argv.cmd} not found on the server's PATH` : err.message;
    emit(project, r, `\n[runner] failed to start: ${msg}\n`, 2);
    r.info.state = 'error';
    r.info.ms = Date.now() - r.t0;
    runJobEnd(project, { state: 'error', ms: r.info.ms, exit: { code: null, signal: null, byUser: false } });
    broadcastStatus(project);
  });
  // settle on 'close' (all output drained — macOS pipes to node are async, so
  // 'exit' can beat the last chunk) or 1.5 s after 'exit' if an orphaned
  // grandchild keeps the pipe open
  let exited = null;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    const cur = runs.get(project);
    if (!cur || cur !== r || r.child !== child || r.info.state !== 'running') return;
    const { code, signal } = exited;
    if (!r.killed && code === 0 && i + 1 < spec.steps.length) {
      broadcastStatus(project); // phase/footer move with the next step
      launchStep(project, r, i + 1);
      broadcastStatus(project);
      return;
    }
    if (signal) emit(project, r, `\n[runner] terminated (${signal})\n`, 2);
    finishRun(project, r, { code, signal });
  };
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    const t = setTimeout(settle, 1500);
    if (t.unref) t.unref();
  });
  child.on('close', () => { if (exited) settle(); });
  console.log(`[runner] ${project}: ${step.display} (cwd ${step.cwd}${pty ? ', pty' : ''})`);
}

/**
 * Start a ▶ run of `rel` in `project`. `mode` 'run' | 'test' (default: the
 * registry's rule — test when the file looks like a test file). Returns
 * { ok, run } — run carries the resolved `display`, `phases`, `runtime`,
 * `mode` and the live `step`/`phase` — or { error } (unknown project or
 * file, escape, a run already active, no runtime, missing toolchain).
 */
export function startRun(project, rel, { mode = null } = {}) {
  try {
    const cfg = PROJECTS[project];
    if (!cfg) return { error: `unknown project: ${project}` };
    if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) {
      return { error: 'rel path required' };
    }
    const existing = runs.get(project);
    if (existing && existing.info.state === 'running') {
      return { error: 'a run is already active in this project — stop it first' };
    }

    // same containment discipline as /artifact: lexical check, then realpath
    const contained = containedPath(project, rel);
    if (!contained) return { error: `forbidden or not found: ${rel}` };
    const { abs, root: realRoot } = contained;

    const spec = resolveRunTarget({ project, abs, root: realRoot, mode: mode || undefined });
    if (!spec || spec.error) return { error: (spec && spec.error) || `don't know how to run ${path.extname(abs) || 'this file'}` };

    const info = {
      rel,
      cmdLine: spec.steps[0].display,
      display: spec.display,
      runtime: spec.runtime,
      mode: spec.mode,
      phase: spec.steps[0].phase || null,
      phases: spec.phases,
      step: { i: 0, n: spec.steps.length },
      state: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      ms: null,
      tail: '',
      bytes: 0,
    };
    const r = { child: null, info, killed: false, t0: Date.now(), spec, pty: false };
    runs.set(project, r);
    launchStep(project, r, 0);
    broadcastStatus(project);
    // the env note goes out AFTER the first status broadcast: non-initiating
    // clients reset their buffers on the new-run status, which would wipe it
    if (spec.note) emit(project, r, `[runner] ${spec.note}\n`);
    return { ok: true, run: { ...info } };
  } catch (err) {
    console.error('[runner] startRun error:', err.message);
    return { error: err.message };
  }
}

function killGroup(child, signal) {
  // detached spawn → the child leads its own process group; signalling the
  // group (-pid) reaches grandchildren (e.g. processes started by a .sh run)
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already dead */ }
  }
}

export function stopRun(project) {
  try {
    const r = runs.get(project);
    if (!r || r.info.state !== 'running') return { ok: true };
    r.killed = true;
    killGroup(r.child, 'SIGTERM');
    return { ok: true };
  } catch (err) {
    console.error('[runner] stopRun error:', err.message);
    return { error: err.message };
  }
}

export function getRuns() {
  const out = {};
  for (const [project, r] of runs.entries()) {
    out[project] = { ...r.info };
  }
  return out;
}

// Kill child groups on shutdown. Runs on the process 'exit' event, which the
// SIGINT/SIGTERM handlers in watchers.js trigger via process.exit() — both
// modules are always imported together by server.js.
function killAll() {
  for (const r of runs.values()) {
    if (r && r.child && r.info.state === 'running') {
      r.killed = true;
      killGroup(r.child, 'SIGTERM');
    }
  }
}
process.on('exit', killAll);
