// lib/runner.js — run a pinned file (julia / python / R / shell / one-shot latexmk)
// and stream its output to the UI. One run per project at a time; spawn with an
// args array (never a shell string); never crashes the process.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { broadcast } from './events.js';
import { PROJECTS } from './config.js';
import { containedPath } from './paths.js';
import { problemsFromLog } from './watchers.js';
import { problemCounts, passFromLine } from './texlog.js';
import { runJobStart, runJobOutput, runJobEnd } from './jobs.js';

const TAIL_CAP = 200000; // rolling output kept server-side so reloads mid-run still show it (matches the frontend cap)

// project → { child, info: {rel, cmdLine, state, exitCode, startedAt, ms, tail}, killed }
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

// Walk from `dir` up to (and including) `root` looking for `name`.
function findUp(dir, root, name) {
  let d = dir;
  for (;;) {
    const candidate = path.join(d, name);
    if (fs.existsSync(candidate)) return candidate;
    if (d === root) return null;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

// The .sql runner: execute the file statement-by-statement through the duckdb
// python package (see the .sql branch below for why). Kept as one -c program
// so nothing is written to disk; the script path travels in PM_RUN_FILE like
// the R wrapper's, so nothing is ever interpolated into the program text.
const SQL_SHIM = `
import os, sys
try:
    import duckdb
except ImportError:
    sys.exit("the duckdb python package is not installed for this interpreter - pip install duckdb")
src = open(os.environ["PM_RUN_FILE"], encoding="utf-8").read()
con = duckdb.connect()  # in-memory; ATTACH in the script for a database file
try:
    statements = duckdb.extract_statements(src)
except duckdb.Error as e:
    sys.exit(f"parse error: {e}")
for st in statements:
    head = " ".join(st.query.split())[:88]
    try:
        rel = con.sql(st.query)
        if rel is not None:
            print(f"-- {head}")
            print(rel)
    except duckdb.Error as e:
        print(f"-- {head}", file=sys.stderr)
        sys.exit(f"error: {e}")
`;

function commandFor(project, abs, root) {
  const ext = path.extname(abs).toLowerCase();
  const dir = path.dirname(abs);
  if (ext === '.jl') {
    // honour the nearest Project.toml so the project's package env is active
    const proj = findUp(dir, root, 'Project.toml');
    const args = proj ? [`--project=${path.dirname(proj)}`, abs] : [abs];
    return {
      cmd: 'julia', args, cwd: dir,
      note: proj ? null
        : 'no Project.toml between the file and the project root — running in julia\'s global environment',
    };
  }
  if (ext === '.py') {
    const venv = ['.venv/bin/python', 'venv/bin/python']
      .map((v) => path.join(root, v))
      .find((v) => fs.existsSync(v));
    return {
      cmd: venv || 'python3', args: [abs], cwd: dir,
      note: venv ? null : 'no .venv/venv in the project root — using python3 from PATH',
    };
  }
  if (ext === '.r') {
    // plain `Rscript file.R` reports runtime errors with NO line numbers
    // ("Error in f() : boom"). Wrapping in source(keep.source=TRUE) with
    // show.error.locations makes R append the failing line ("(from file.R#5)")
    // and gives file:line:col for syntax errors; stdout/auto-printing and exit
    // codes stay identical to plain Rscript (verified against R 4.5.2 —
    // deferred warnings gain an "In eval(ei, envir):" prefix, the one known
    // difference). The script path travels in an env var so the user script's
    // commandArgs() stays empty, exactly as under plain Rscript; nothing is
    // ever interpolated into the -e expression.
    return {
      cmd: 'Rscript',
      args: [
        '--no-save', '-e',
        'options(show.error.locations=TRUE); source(Sys.getenv("PM_RUN_FILE"), keep.source=TRUE, print.eval=TRUE)',
      ],
      cwd: dir,
      env: { PM_RUN_FILE: abs },
      display: `Rscript ${path.basename(abs)}`, // the -e wrapper is noise in the UI footer
    };
  }
  if (ext === '.sh') return { cmd: 'bash', args: [abs], cwd: dir };
  if (ext === '.sql') {
    // DuckDB via its python package (the CLI is rarely installed; the package
    // rides the same python the .py branch resolves). In-memory connection —
    // parquet/CSV are queryable in place from the file's own folder, and a
    // database file is a deliberate `ATTACH` in the script, never a guess by
    // us (a wrong guess could contend with a live analysis pipeline's lock).
    // Statements run one at a time so EVERY result set prints, not just the
    // last, with duckdb's own box tables; an error names the statement and
    // its line before exiting non-zero.
    const venv = ['.venv/bin/python', 'venv/bin/python']
      .map((v) => path.join(root, v))
      .find((v) => fs.existsSync(v));
    return {
      cmd: venv || 'python3',
      args: ['-c', SQL_SHIM],
      cwd: dir,
      env: { PM_RUN_FILE: abs },
      display: `duckdb ${path.basename(abs)}`,
      note: 'duckdb, in-memory — parquet/CSV readable from the script\'s folder; ATTACH database files explicitly in the script',
    };
  }
  if (ext === '.tex') {
    // one-shot compile (the live watch's own compile is separate); the artifact
    // watcher picks up the resulting .pdf and the show panel can display it.
    // Same flags as the watcher: -synctex=1 (source↔PDF nav), -file-line-error
    // (parseable errors), nonstopmode without -halt-on-error (report every
    // error, still write the survivable pages). max_print_line in env stops
    // TeX hard-wrapping log lines mid-path.
    return {
      cmd: 'latexmk',
      args: ['-pdf', '-interaction=nonstopmode', '-synctex=1', '-file-line-error', abs],
      cwd: dir,
      env: { max_print_line: '2000', error_line: '254', half_error_line: '238' },
      tex: abs,
    };
  }
  return null;
}

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

export function startRun(project, rel) {
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

    const spec = commandFor(project, abs, realRoot);
    if (!spec) return { error: `don't know how to run ${path.extname(abs) || 'this file'}` };

    const cmdLine = spec.display
      || [spec.cmd.split('/').pop(), ...spec.args.map((a) => {
        if (a === abs) return path.basename(abs);
        // long absolute --project paths drown the UI footer — keep the leaf
        if (a.startsWith('--project=')) return `--project=…/${path.basename(a.slice(10))}`;
        return a;
      })].join(' ');
    const info = {
      rel,
      cmdLine,
      state: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      ms: null,
      tail: '',
      bytes: 0,
    };

    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      detached: true, // own process group, so stop/cleanup reaches grandchildren
    });
    const r = { child, info, killed: false, t0: Date.now() };
    runs.set(project, r);
    // live job card: pid/CPU/elapsed + output-parsed progress (tex compiles
    // keep their own build card — runJobStart skips them by extension)
    if (child.pid) runJobStart(project, rel, child.pid, cmdLine);

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
    const onData = (fd) => (chunk) => {
      try {
        const text = chunk.toString('utf8');
        emit(project, r, text, fd);
        if (fd === undefined) scanTexLines(text);
        // both fds — ProgressMeter.jl and friends report on stderr
        if (runs.get(project) === r) runJobOutput(project, text);
      } catch (err) {
        console.error('[runner] stream handler error:', err.message);
      }
    };
    child.stdout.on('data', onData(undefined));
    child.stderr.on('data', onData(2));
    child.on('error', (err) => {
      const cur = runs.get(project);
      if (!cur || cur.child !== child) return;
      const msg = err.code === 'ENOENT' ? `${spec.cmd} not found on the server's PATH` : err.message;
      emit(project, r, `\n[runner] failed to start: ${msg}\n`, 2);
      cur.info.state = 'error';
      cur.info.ms = Date.now() - cur.t0;
      runJobEnd(project, { state: 'error', ms: cur.info.ms });
      broadcastStatus(project);
    });
    child.on('exit', (code, signal) => {
      const cur = runs.get(project);
      if (!cur || cur.child !== child) return;
      cur.info.exitCode = code;
      cur.info.ms = Date.now() - cur.t0;
      cur.info.state = cur.killed ? 'stopped' : code === 0 ? 'done' : 'error';
      if (spec.tex) {
        // tex runs: surface the .log's errors/warnings to the editor UI
        cur.info.pass = null;
        cur.info.problems = problemsFromLog(project, spec.tex);
        cur.info.counts = problemCounts(cur.info.problems);
      }
      if (signal) emit(project, r, `\n[runner] terminated (${signal})\n`, 2);
      runJobEnd(project, { state: cur.info.state, exitCode: code, ms: cur.info.ms });
      broadcastStatus(project);
    });

    console.log(`[runner] ${project}: ${cmdLine} (cwd ${spec.cwd})`);
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
