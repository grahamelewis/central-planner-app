// lib/jobs.js — the live job monitor behind the RUNNING cards.
// No Claude, no billing: jobs.js only watches processes and parses text.
// Process-level tests spawn REAL interpreters (bash→python3/julia/Rscript,
// mirroring the SDK's topology: server → subprocess → shell → script) and are
// skip-guarded on interpreter availability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

// env seams BEFORE the module (and its config.js import) loads
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-jobs-')));
const proj = path.join(root, 'proj');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({
  alpha: { name: 'alpha', root: proj, color: '#aabbcc', texWatch: null },
});
process.env.CP_NTFY_TOPIC = '';
process.env.CP_JOB_MIN_AGE_MS = '600';
process.env.CP_JOB_POLL_MS = '300';
process.env.CP_JOB_GONE_MS = '800';

// prior runs of med.jl for the history median (3 done runs + 2 that must be
// ignored); the file is read lazily on the first history call
fs.writeFileSync(path.join(root, 'jobhist.json'), JSON.stringify({
  alpha: [
    { ts: '2026-09-01T10:00:00.000Z', file: 'med.jl', lang: 'julia', source: 'run', state: 'done', ms: 100 },
    { ts: '2026-09-02T10:00:00.000Z', file: 'med.jl', lang: 'julia', source: 'run', state: 'error', ms: 99999 },
    { ts: '2026-09-03T10:00:00.000Z', file: 'med.jl', lang: 'julia', source: 'run', state: 'done', ms: 300 },
    { ts: '2026-09-04T10:00:00.000Z', file: 'med.jl', lang: 'julia', source: 'run', state: 'stopped', ms: 5 },
    { ts: '2026-09-05T10:00:00.000Z', file: 'med.jl', lang: 'julia', source: 'session', state: 'done', ms: 200 },
    { ts: '2026-09-05T11:00:00.000Z', file: 'other.jl', lang: 'julia', source: 'run', state: 'done', ms: 7 },
    { ts: '2026-09-05T12:00:00.000Z', file: 'even.py', lang: 'python', source: 'run', state: 'done', ms: 100 },
    { ts: '2026-09-05T13:00:00.000Z', file: 'even.py', lang: 'python', source: 'run', state: 'done', ms: 400 },
  ],
}));

const {
  detectScriptRun, parseProgressLine, getJobs, getJobHistory,
  sessionJobStart, sessionJobEnd, endSessionJobsFor, stopSessionJob,
  runJobStart, runJobOutput, runJobEnd, sessionJobOutput, _test,
} = await import('../lib/jobs.js');

const has = (bin) => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeoutMs = 8000, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error('until() timed out');
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------

test('detectScriptRun: recognizes julia/R/python/notebook runs, skips everything else', () => {
  const yes = [
    ['julia fig3.jl', 'julia', 'fig3.jl'],
    ['julia --project=. --threads=4 models/fig3.jl arg', 'julia', 'models/fig3.jl'],
    ['cd models && julia fig3.jl && latexmk deck.tex', 'julia', 'fig3.jl'],
    ['time julia sim.jl', 'julia', 'sim.jl'],
    ['/opt/homebrew/bin/julia run.jl', 'julia', 'run.jl'],
    ['Rscript analysis.R', 'r', 'analysis.R'],
    ['Rscript --vanilla analysis.r', 'r', 'analysis.r'],
    ['R CMD BATCH sim.R', 'r', 'sim.R'],
    ['python3 train.py', 'python', 'train.py'],
    ['python3.12 train.py', 'python', 'train.py'],
    ['uv run train.py', 'python', 'train.py'],
    // notebooks — the first screenshot's gap: nbconvert in one kernel
    ['cd myproject/models && jupyter nbconvert --to notebook --execute replicate_all.ipynb --output replicate_all.ipynb',
      'notebook', 'replicate_all.ipynb'],
    ['jupyter execute analysis.ipynb', 'notebook', 'analysis.ipynb'],
    ['papermill in.ipynb out.ipynb -p rho 0.97', 'notebook', 'in.ipynb'],
    ['quarto render report.qmd', 'notebook', 'report.qmd'],
  ];
  for (const [cmd, lang, file] of yes) {
    const got = detectScriptRun(cmd);
    assert.ok(got, `should detect: ${cmd}`);
    assert.equal(got.lang, lang, cmd);
    assert.equal(got.file, file, cmd);
    assert.equal(got.detached, false, cmd);
  }
  // flags never win over the real input (--output=x.ipynb is not the target)
  const flagged = detectScriptRun('jupyter nbconvert --output=result.ipynb --execute source.ipynb');
  assert.equal(flagged.file, 'source.ipynb');
  // detached launches are DETECTED with detached:true — their card outlives
  // the tool call (and, for truly detached processes, the turn)
  const det = [
    ['scripts/bg run sim julia sim.jl', 'julia', 'sim.jl'],
    ['nohup julia sim.jl &', 'julia', 'sim.jl'],
    ['julia sim.jl &', 'julia', 'sim.jl'],
    ['Rscript 01_download.R > /tmp/full_run.log 2>&1 &', 'r', '01_download.R'],
    ['setsid python3 train.py', 'python', 'train.py'],
  ];
  // sql runs via a CLI engine
  const sql = detectScriptRun('psql -d research -f queries/build_panel.sql');
  assert.equal(sql.lang, 'sql');
  assert.equal(sql.file, 'queries/build_panel.sql');
  for (const [cmd, lang, file] of det) {
    const got = detectScriptRun(cmd);
    assert.ok(got, `should detect detached: ${cmd}`);
    assert.equal(got.lang, lang, cmd);
    assert.equal(got.file, file, cmd);
    assert.equal(got.detached, true, cmd);
  }
  // INLINE evals — no script file, but a `julia -e` program is often the
  // long GE solve itself (the pass-through screenshot regression: the card
  // never showed because -e one-liners were skipped)
  const inline = [
    ['julia -e "println(1)"', 'julia'],
    ['Rscript -e "summary(x)"', 'r'],
    ['Rscript -e "rmarkdown::render(\'x.Rmd\')"', 'r'],
    ['python3 -c "import time; time.sleep(60)"', 'python'],
    ["julia --project=. <<'EOF'\nsolve()\nEOF", 'julia'],
    // the real command from the screenshot: cd && multi-line julia -e program
    ["cd /Users/x/proj && julia --gcthreads=1 -e '\nusing Pkg; Pkg.activate(\"/Users/x/proj\")\ninclude(joinpath(C,\"income_block_nm.jl\"))\nfit = fit_income_block(pe; restarts=4)\n'", 'julia'],
  ];
  for (const [cmd, lang] of inline) {
    const got = detectScriptRun(cmd);
    assert.ok(got, `should detect inline: ${cmd}`);
    assert.equal(got.lang, lang, cmd);
    assert.equal(got.file, null, cmd);
    assert.equal(got.inline, true, cmd);
  }
  // a file match anywhere beats an inline match
  const mixed = detectScriptRun('julia -e "setup()" && julia run.jl');
  assert.equal(mixed.file, 'run.jl');
  assert.equal(mixed.inline, false);
  // QUOTE-SEVERED detached compounds — the `;` INSIDE a quoted supervisor
  // program lands the script in a segment carrying neither the nohup nor the
  // trailing `&` (the OpenAlex 01_download.R regression: the card never
  // showed and the job closed at the tool_result while the supervisor ran on
  // for hours). The physical line must rescue the detached flag.
  const sup = detectScriptRun(
    'cd /Users/x/proj\n'
    + 'kill 33136 2>/dev/null; pkill -f "01_download.R" 2>/dev/null\n'
    + '/opt/homebrew/bin/Rscript -e \'invisible(parse("reproducible_code/01_download.R")); cat("ok\\n")\' 2>&1 | grep -v Warning\n'
    + "nohup bash -c 'cd /Users/x/proj; until caffeinate -i /opt/homebrew/bin/Rscript reproducible_code/01_download.R >> /tmp/full_run.log 2>&1; do sleep 15; done' >/dev/null 2>&1 </dev/null &\n"
    + 'disown');
  assert.equal(sup.lang, 'r');
  assert.equal(sup.file, 'reproducible_code/01_download.R');
  assert.equal(sup.detached, true, 'nohup/& severed by a quoted `;` still reads as detached');
  // …but a && line continuation is NOT a trailing &
  const cont = detectScriptRun('julia foo.jl &&\necho done');
  assert.equal(cont.detached, false, 'a && continuation is not a background &');
  // an inline eval inside a nohup'd quoted program is detached too
  const supInline = detectScriptRun("nohup bash -c 'julia -e \"while true; solve(); end\"' >/dev/null 2>&1 &");
  assert.equal(supInline.inline, true);
  assert.equal(supInline.detached, true, 'quoted inline eval under nohup reads as detached');
  const no = [
    'ls -la && git status',
    'julia --version',                 // interpreter alone, no eval
    'R CMD INSTALL mypackage',
    'grep -r "julia" docs/',
    'cat notes.txt',
    'nohup ./server --port 8080 &',    // detached but not a script we know
  ];
  for (const cmd of no) {
    assert.equal(detectScriptRun(cmd), null, `should NOT detect: ${cmd}`);
  }
});

test('parseProgressLine: iter counters, bars, percentages, reported ETAs', () => {
  assert.deepEqual(parseProgressLine('iter 358/500'), { iter: 358, total: 500, frac: 0.716 });
  assert.deepEqual(parseProgressLine('Iteration 12 of 40 done'), { iter: 12, total: 40, frac: 0.3 });
  assert.deepEqual(parseProgressLine('[3/10] solving block'), { iter: 3, total: 10, frac: 0.3 });
  assert.deepEqual(parseProgressLine('epoch 5/8'), { iter: 5, total: 8, frac: 0.625 });
  // ProgressMeter.jl: percent + its own ETA (h:mm:ss)
  const pm = parseProgressLine('Progress:  42%|████████░░░| ETA: 0:03:12');
  assert.equal(pm.frac, 0.42);
  assert.equal(pm.etaS, 192);
  // R txtProgressBar (style 3): \r-redrawn bar + percent
  assert.equal(parseProgressLine('  |=============               |  45%').frac, 0.45);
  // m:ss ETA form
  assert.equal(parseProgressLine('ETA: 1:05').etaS, 65);
  // bare percentages in prose must NOT count as progress
  assert.equal(parseProgressLine('the price level was 42% higher'), null);
  assert.equal(parseProgressLine('rates fell 3% in 1997'), null);
  // nonsense ratios rejected
  assert.equal(parseProgressLine('iter 900/500'), null);
});

test('runner job: output drives progress, end seals it', async () => {
  const child = spawn('sleep', ['30']);
  try {
    const job = runJobStart('alpha', 'sim.jl', child.pid, 'julia sim.jl');
    assert.ok(job);
    runJobOutput('alpha', 'warming up\niter 5/10\npartial li');
    runJobOutput('alpha', 'ne\niter 6/10\n');
    await until(() => getJobs().find((j) => j.key === 'run:alpha'), 4000);
    const j = getJobs().find((x) => x.key === 'run:alpha');
    assert.equal(j.source, 'run');
    assert.equal(j.lang, 'julia');
    assert.equal(j.progress.iter, 6);
    assert.equal(j.progress.total, 10);
    assert.ok(j.pid === child.pid);
    assert.ok(j.quietMs != null, 'runner jobs carry a quiet clock');
    runJobEnd('alpha', { state: 'done', exitCode: 0, ms: 1234 });
    const done = getJobs().find((x) => x.key === 'run:alpha');
    assert.equal(done.state, 'done');
    assert.equal(done.progress.frac, 1); // done sweeps the bar full
    // a finished visible job lands in the run history (the activity feed's
    // ▶ rows) and the history file persists across restarts
    const hist = getJobHistory('alpha');
    const rec = hist[hist.length - 1];
    assert.equal(rec.file, 'sim.jl');
    assert.equal(rec.state, 'done');
    assert.ok(rec.ms > 0);
    assert.ok(fs.existsSync(path.join(root, 'jobhist.json')), 'history persisted');
    _test.jobs.delete('run:alpha');
  } finally {
    child.kill('SIGKILL');
  }
});

test('tex runs never become jobs (the build card owns them)', () => {
  const child = spawn('sleep', ['5']);
  try {
    assert.equal(runJobStart('alpha', 'deck.tex', child.pid, 'latexmk deck.tex'), null);
  } finally {
    child.kill('SIGKILL');
  }
});

test('quick session commands never surface a card', async () => {
  // an `echo` with julia-looking text: detection may or may not match, but no
  // real process ever appears, so the job must never become visible
  const job = sessionJobStart('alpha', 'tsk-q', 'toolu_q', 'echo "julia fig3.jl"');
  await sleep(1200); // several polls past MIN_AGE
  assert.equal(getJobs().length, 0);
  if (job) sessionJobEnd('toolu_q', { error: false });
  assert.equal(getJobs().length, 0, 'ending an invisible job leaves no trace');
});

// one process-level lifecycle per language, mirroring the SDK topology
// (this process → bash → interpreter). Each is skip-guarded.
function sessionLifecycle(bin, file, code) {
  return async () => {
    fs.writeFileSync(path.join(proj, file), code);
    const sh = spawn('bash', ['-c', `cd ${proj} && ${bin} ${file}`], { stdio: 'ignore' });
    const cmd = `cd ${proj} && ${bin} ${file}`;
    const job = sessionJobStart('alpha', 'tsk-1', `toolu_${file}`, cmd);
    assert.ok(job, 'command detected as a script run');
    try {
      // pid discovered from the process table + visible after MIN_AGE
      const vis = await until(() => getJobs().find((j) => j.key === job.key), 10000);
      assert.equal(vis.state, 'running');
      assert.ok(vis.pid > 0, 'pid discovered');
      assert.ok(vis.elapsedMs > 0);
      await until(() => {
        const j = getJobs().find((x) => x.key === job.key);
        return j && j.cpu != null && j.mem > 0;
      }, 6000);
      // ⊘ stop kills the real process tree
      stopSessionJob('alpha', job.key);
      await until(() => sh.exitCode !== null || sh.signalCode, 6000);
      await until(() => {
        const j = _test.jobs.get(job.key);
        return j && j.state === 'stopped';
      }, 6000);
    } finally {
      try { process.kill(sh.pid, 'SIGKILL'); } catch { /* already gone */ }
      sessionJobEnd(`toolu_${file}`, { error: false });
      _test.jobs.delete(job.key);
    }
  };
}

test('session job lifecycle: real julia process (discover → stats → stop)',
  { skip: has('julia') ? false : 'julia not installed' },
  sessionLifecycle('julia', 'busy.jl', `
r = Ref(0.0)
t = time()
while time() - t < 30
  r[] += rand()
end
println(r[])
`));

test('session job lifecycle: real R process (discover → stats → stop)',
  { skip: has('Rscript') ? false : 'Rscript not installed' },
  sessionLifecycle('Rscript', 'busy.R', `
x <- 0
t0 <- Sys.time()
while (as.numeric(Sys.time() - t0) < 30) x <- x + sum(sqrt(runif(1e5)))
cat(x, "\\n")
`));

test('endSessionJobsFor: an interrupted turn takes its cards with it', async () => {
  const sh = spawn('bash', ['-c', 'sleep 30'], { stdio: 'ignore' });
  try {
    // fake a running job by hand (no interpreter needed for this path)
    const job = sessionJobStart('alpha', 'tsk-2', 'toolu_end', 'julia never_starts.jl');
    assert.ok(job);
    endSessionJobsFor('alpha', 'tsk-2');
    assert.equal(_test.jobs.has(job.key), false, 'invisible job vanishes outright');
  } finally {
    sh.kill('SIGKILL');
  }
});

test('stopSessionJob: unknown key → 404-shaped error', () => {
  assert.throws(() => stopSessionJob('alpha', 'sess:alpha/nope/x'), /no such job/);
});

const hasPy = has('python3');

test('background job: the launch ack does not end the card — the process does',
  { skip: hasPy ? false : 'python3 not installed' }, async () => {
    fs.writeFileSync(path.join(proj, 'bgsleep.py'), 'import time\ntime.sleep(300)\n');
    const sh = spawn('bash', ['-c', `cd ${proj} && python3 bgsleep.py`], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-bg', 'toolu_bg', 'python3 bgsleep.py', { bg: true });
    assert.ok(job && job.bg === true);
    try {
      await until(() => getJobs().find((j) => j.key === job.key && j.pid), 10000);
      // the immediate "running in background" ack — card must survive it
      sessionJobEnd('toolu_bg', { error: false });
      assert.equal(_test.jobs.get(job.key).state, 'running', 'ack ignored for bg jobs');
      // the PROCESS dying is what ends it (kill the pinned pid, not the bash
      // wrapper — killing bash would just orphan the sleeper)
      const pinned = _test.jobs.get(job.key).pid;
      process.kill(pinned, 'SIGKILL');
      await until(() => _test.jobs.get(job.key)?.state === 'done', 8000);
    } finally {
      try { process.kill(_test.jobs.get(job.key)?.pid, 'SIGKILL'); } catch { /* gone */ }
      try { sh.kill('SIGKILL'); } catch { /* gone */ }
      _test.jobs.delete(job.key);
    }
  });

test('background job: dies with the turn (endSessionJobsFor)',
  { skip: hasPy ? false : 'python3 not installed' }, async () => {
    const sh = spawn('bash', ['-c', `cd ${proj} && python3 bgsleep.py`], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-bg2', 'toolu_bg2', 'python3 bgsleep.py', { bg: true });
    try {
      endSessionJobsFor('alpha', 'tsk-bg2');
      assert.notEqual(_test.jobs.get(job.key)?.state, 'running', 'bg cards end with the turn');
    } finally {
      sh.kill('SIGKILL');
      _test.jobs.delete(job.key);
    }
  });

test('detached job: survives the turn, found by whole-table search, ends with the process',
  { skip: hasPy ? false : 'python3 not installed' }, async () => {
    fs.writeFileSync(path.join(proj, 'dsleep.py'), 'import time\ntime.sleep(300)\n');
    const sh = spawn('bash', ['-c', `cd ${proj} && python3 dsleep.py`], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-det', 'toolu_det',
      `cd ${proj} && nohup python3 dsleep.py > /tmp/dsleep.log 2>&1 &`);
    assert.ok(job && job.detached === true, 'nohup + & detected as detached');
    try {
      const vis = await until(() => getJobs().find((j) => j.key === job.key && j.pid), 10000);
      assert.ok(vis.pid > 0, 'pid found via the whole-table search');
      // the launch ack AND the turn ending both leave it alone
      sessionJobEnd('toolu_det', { error: false });
      endSessionJobsFor('alpha', 'tsk-det');
      assert.equal(_test.jobs.get(job.key).state, 'running', 'detached card outlives the turn');
      // ⊘ stop still works across turns
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
    } finally {
      try { sh.kill('SIGKILL'); } catch { /* gone */ }
      _test.jobs.delete(job.key);
    }
  });

test('supervisor loop: card follows interpreter respawns, ⊘ stop kills the loop itself',
  { skip: hasPy ? false : 'python3 not installed' }, async () => {
    // the crash-resuming pattern sessions build for flaky long runs:
    //   nohup bash -c 'until python3 x.py; do sleep …; done' &
    // the interpreter dies and RESPAWNS — the card must ride across the
    // boundary, and ⊘ stop must kill the loop first or it would just respawn
    fs.writeFileSync(path.join(proj, 'sup_pulse.py'), 'import time\ntime.sleep(300)\n');
    const cmd = `nohup bash -c 'cd ${proj}; until python3 sup_pulse.py; do sleep 0.4; done' >/dev/null 2>&1 & disown`;
    // launch for real, re-parented to launchd like a genuine detached run
    spawn('bash', ['-c', cmd], { stdio: 'ignore', detached: true }).unref();
    const job = sessionJobStart('alpha', 'tsk-sup', 'toolu_sup', cmd);
    assert.ok(job && job.detached === true, 'quoted supervisor launch detected as detached');
    try {
      await until(() => _test.jobs.get(job.key)?.pid, 10000);
      const pid1 = _test.jobs.get(job.key).pid;
      sessionJobEnd('toolu_sup', { error: false });   // launch ack — ignored
      endSessionJobsFor('alpha', 'tsk-sup');          // turn over — survives
      // the interpreter crashes (the OOM case) — the supervisor respawns it
      process.kill(pid1, 'SIGKILL');
      await until(() => {
        const j = _test.jobs.get(job.key);
        return j && j.pid && j.pid !== pid1;
      }, 10000);
      assert.equal(_test.jobs.get(job.key).state, 'running', 'card rode across the crash boundary');
      // ⊘ stop: the supervisor must die too, or it would respawn once more
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
      await sleep(1500); // longer than the loop's 0.4s sleep — a respawn window
      const left = execSync('pgrep -f sup_pulse || true', { encoding: 'utf8' }).trim();
      assert.equal(left, '', 'no supervisor or interpreter left running after stop');
    } finally {
      try { execSync('pkill -f sup_pulse'); } catch { /* already gone */ }
      _test.jobs.delete(job.key);
    }
  });

test('inline eval: a REAL `julia -e` program gets a card titled by the tool description',
  { skip: has('julia') ? false : 'julia not installed' }, async () => {
    const prog = 'julia -e \'t=time(); r=0.0; while time()-t<30 global r+=rand() end; println(r)\'';
    const sh = spawn('bash', ['-c', prog], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-inl', 'toolu_inl', prog,
      { label: 'Pass-through (BPP φ and structural Φ) at pe=0.50 fit' });
    assert.ok(job, 'inline julia -e detected');
    assert.equal(job.inline, true);
    assert.equal(job.file, 'Pass-through (BPP φ and structural Φ) at pe=0.50 fit');
    try {
      const vis = await until(() => getJobs().find((j) => j.key === job.key && j.pid), 10000);
      assert.equal(vis.state, 'running');
      assert.equal(vis.inline, true);
      await until(() => {
        const j = getJobs().find((x) => x.key === job.key);
        return j && j.cpu != null;
      }, 6000);
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
      // history keeps the label + inline flag for the activity feed
      const rec = getJobHistory('alpha').pop();
      assert.equal(rec.inline, true);
      assert.match(rec.file, /Pass-through/);
    } finally {
      try { sh.kill('SIGKILL'); } catch { /* gone */ }
      sessionJobEnd('toolu_inl', { error: false });
      _test.jobs.delete(job.key);
    }
  });

test('notebook job: REAL jupyter nbconvert --execute gets a card, stop kills the kernel tree',
  { skip: has('jupyter') ? false : 'jupyter not installed' }, async () => {
    const nb = {
      cells: [{
        cell_type: 'code', execution_count: null, metadata: {}, outputs: [],
        source: ['import time, random\n', 'x = 0\n', 't = time.time()\n',
          'while time.time() - t < 120:\n', '    x += random.random()\n', 'print(x)\n'],
      }],
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
      nbformat: 4, nbformat_minor: 5,
    };
    fs.writeFileSync(path.join(proj, 'slownb.ipynb'), JSON.stringify(nb));
    const cmd = `cd ${proj} && jupyter nbconvert --to notebook --execute slownb.ipynb --output slownb_out.ipynb`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-nb', 'toolu_nb', cmd);
    assert.ok(job, 'nbconvert command detected');
    assert.equal(job.lang, 'notebook');
    assert.equal(job.file, 'slownb.ipynb');
    try {
      // kernel boot takes a few seconds — then the card must be live w/ stats
      const vis = await until(() => getJobs().find((j) => j.key === job.key && j.pid), 25000);
      assert.equal(vis.state, 'running');
      await until(() => {
        const j = getJobs().find((x) => x.key === job.key);
        return j && j.cpu != null && j.mem > 0;
      }, 10000);
      stopSessionJob('alpha', job.key);
      await until(() => sh.exitCode !== null || sh.signalCode, 10000);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
    } finally {
      try { process.kill(sh.pid, 'SIGKILL'); } catch { /* gone */ }
      sessionJobEnd('toolu_nb', { error: false });
      _test.jobs.delete(job.key);
    }
  });

// ---------------------------------------------------------------------------
// v3 telemetry — synthetic ps tables through the real sweep code, with the
// timer parked and the clock injected, so every number below is exact.
// ---------------------------------------------------------------------------

// one `ps -Ao pid=,ppid=,pcpu=,rss=,etime=,cputime=,state=,tty=,args=` row
const psRow = (pid, ppid, pcpu, rssKB, cputime, state, args, etime = '05:00') =>
  `${String(pid).padStart(6)} ${String(ppid).padStart(5)} ${pcpu.toFixed(1).padStart(5)} ${String(rssKB).padStart(7)} `
  + `${etime.padStart(11)} ${cputime.padStart(10)} ${state.padEnd(4)} ??       ${args}`;
const snapOf = (rows, at) => _test.parsePs(rows.join('\n') + '\n', at);
const pub = (key) => _test.publicJob(_test.jobs.get(key));

// park the timer + pin the clock for one synthetic scenario; always restored
async function synthetic(fn) {
  const t0 = Date.parse('2026-09-06T21:00:00.000Z');
  let t = t0;
  _test.setPolling(false);
  _test.setClock(() => t);
  const clock = { at: () => t, set(ms) { t = t0 + ms; return t; } };
  try {
    await fn(clock, t0);
  } finally {
    for (const k of [..._test.jobs.keys()]) if (k.startsWith('run:') || k.includes('/tsk-syn')) _test.jobs.delete(k);
    _test.setClock(null);
    _test.setPolling(true);
  }
}

test('ps parsing: the cputime column reads [[dd-]hh:]mm:ss[.cc]; state keeps its first letter', () => {
  const snap = snapOf([
    psRow(1, 0, 0.0, 24784, '91:21.30', 'Ss', '/sbin/launchd', '24-10:13:19'),
    psRow(2, 1, 12.5, 1000, '1-02:03:04.50', 'R+', 'julia sim.jl', '1-00:00:01'),
    psRow(3, 1, 0.0, 10, '00:00:01', 'S', 'sleep 30'),
    psRow(4, 1, 0.0, 10, '0:07', 'U', 'rsync'),
  ], 1000);
  assert.equal(snap.procs.get(1).cpuMs, (91 * 60 + 21.3) * 1000);
  assert.equal(snap.procs.get(2).cpuMs, ((26 * 60 + 3) * 60 + 4.5) * 1000);
  assert.equal(snap.procs.get(3).cpuMs, 1000);
  assert.equal(snap.procs.get(4).cpuMs, 7000);
  assert.equal(snap.procs.get(1).state, 'S');
  assert.equal(snap.procs.get(2).state, 'R');
  assert.equal(snap.procs.get(4).state, 'U');
  assert.equal(snap.at, 1000);
  assert.equal(snap.procs.get(2).startMs, 1000 - (86400 + 1) * 1000, 'etime still feeds the start-time guard');
});

test('cores: pcpu basis on the first sweep, Δcputime/Δwall summed over the tree from the second, EMA α=1/3', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'burn.jl', 4242, 'julia burn.jl');
    job.t0 = t0 - 5000; // past MIN_AGE → visible on the first sweep
    // sweep 1: root 150 % + child 50 % (pcpu), cputime 10 s + 5 s
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([
      psRow(4242, 1, 150.0, 100000, '0:10.00', 'R', 'julia burn.jl'),
      psRow(4243, 4242, 50.0, 50000, '0:05.00', 'R', 'julia --worker'),
    ], clock.at()) });
    let j = pub('run:alpha');
    assert.equal(j.cores, 2.0, 'Σ pcpu / 100 on the first sweep');
    assert.equal(j.coresBasis, 'pcpu');
    assert.equal(j.cpu, 200, 'legacy % is still the raw pcpu sum');
    assert.equal(j.mem, 150000 * 1024, 'legacy mem is still the rss sum');
    assert.equal(j.cpuTimeMs, 15000);
    assert.equal(j.procs, 2);
    assert.equal(j.hostCores, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
    assert.equal(j.sampledAt, new Date(t0).toISOString());
    assert.equal(j.pollMs, 300);
    assert.equal(j.stale, false);
    assert.equal(j.health.state, 'computing');
    // sweep 2, +2 s: root +3 s, child +1 s → 4 s / 2 s = 2.0; a NEW child
    // (4244, 9 s of cputime already) must not count until its second sweep
    clock.set(2000);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([
      psRow(4242, 1, 10.0, 100000, '0:13.00', 'R', 'julia burn.jl'),
      psRow(4243, 4242, 10.0, 50000, '0:06.00', 'R', 'julia --worker'),
      psRow(4244, 4242, 400.0, 20000, '0:09.00', 'R', 'julia --worker'),
    ], clock.at()) });
    j = pub('run:alpha');
    assert.equal(j.cores, 2.0, 'Δcputime 4 s over Δwall 2 s');
    assert.equal(j.coresBasis, 'cputime');
    assert.equal(j.procs, 3);
    assert.equal(j.cpuTimeMs, 28000, 'Σ cputime over the live tree');
    // sweep 3, +2 s: only the new child moved (+2 s) → raw 1.0; EMA 2 + (1-2)/3
    clock.set(4000);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([
      psRow(4242, 1, 0.0, 100000, '0:13.00', 'R', 'julia burn.jl'),
      psRow(4243, 4242, 0.0, 50000, '0:06.00', 'S', 'julia --worker'),
      psRow(4244, 4242, 100.0, 20000, '0:11.00', 'R', 'julia --worker'),
    ], clock.at()) });
    j = pub('run:alpha');
    assert.equal(j.cores, 1.67);
    assert.equal(j.coresBasis, 'cputime');
    // cputime that goes DOWN (a pid reused) clamps at 0, never negative
    clock.set(6000);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([
      psRow(4242, 1, 0.0, 100000, '0:01.00', 'R', 'julia burn.jl'),
    ], clock.at()) });
    j = pub('run:alpha');
    assert.ok(j.cores >= 0 && j.cores < 1.67, `clamped and decaying (${j.cores})`);
    assert.equal(j.procs, 1);
  });
});

test('memory: rss until the probe answers; footprint sums the tree + threads; peak is monotone per kind and restarts when the kind flips', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'mem.py', 5100, 'python3 mem.py');
    job.t0 = t0 - 5000;
    const rows = (rootKB, kidKB, cpu = '0:01.00') => snapOf([
      psRow(5100, 1, 100.0, rootKB, cpu, 'R', 'python3 mem.py'),
      psRow(5101, 5100, 0.0, kidKB, '0:00.10', 'S', 'python3 -c from multiprocessing.spawn import spawn_main'),
    ], clock.at());
    await _test.tick({ now: clock.at(), probe: null, snap: rows(100000, 50000) });
    let j = pub('run:alpha');
    assert.equal(j.memKind, 'rss');
    assert.equal(j.memBytes, 150000 * 1024);
    assert.equal(j.memPeakBytes, 150000 * 1024);
    assert.equal(j.threads, null, 'no thread count without the probe');
    // rss drops → peak holds
    clock.set(300);
    await _test.tick({ now: clock.at(), probe: null, snap: rows(80000, 40000, '0:01.30') });
    j = pub('run:alpha');
    assert.equal(j.memBytes, 120000 * 1024);
    assert.equal(j.memPeakBytes, 150000 * 1024, 'peak never goes down');
    // the probe answers with footprints for the whole tree → kind flips, peak restarts
    clock.set(600);
    await _test.tick({ now: clock.at(), snap: rows(80000, 40000, '0:01.60'), probe: new Map([
      [5100, { footprint: 60 * 1024 * 1024, threads: 4, state: 'running' }],
      [5101, { footprint: 20 * 1024 * 1024, threads: 2, state: 'sleeping' }],
    ]) });
    j = pub('run:alpha');
    assert.equal(j.memKind, 'footprint');
    assert.equal(j.memBytes, 80 * 1024 * 1024);
    assert.equal(j.memPeakBytes, 80 * 1024 * 1024, 'peak restarted with the kind');
    assert.equal(j.threads, 6);
    assert.equal(j.mem, 120000 * 1024, 'legacy rss still there');
    // The next (non-probe) tick can carry the footprint for the same tree.
    clock.set(900);
    await _test.tick({ now: clock.at(), probe: null, snap: rows(90000, 40000, '0:01.90') });
    j = pub('run:alpha');
    assert.equal(j.memKind, 'footprint');
    assert.equal(j.memBytes, 80 * 1024 * 1024);
    clock.set(1200);
    await _test.tick({ now: clock.at(), snap: rows(90000, 40000, '0:02.20'), probe: new Map([
      [5100, { footprint: 100 * 1024 * 1024, threads: 5 }],
    ]) });
    j = pub('run:alpha');
    assert.equal(j.memBytes, 130000 * 1024, 'a child still in ps but absent from the probe makes the footprint incomplete');
    assert.equal(j.memKind, 'rss');
    assert.equal(j.threads, null, 'partial thread counts are not whole-tree counts');
    assert.equal(j.memPeakBytes, 130000 * 1024, 'peak resets on truthful RSS fallback');
    // a probe that lacks the ROOT's footprint is not a footprint at all → rss
    clock.set(3500);
    await _test.tick({ now: clock.at(), snap: rows(90000, 40000, '0:04.50'), probe: new Map([[5101, { threads: 2 }]]) });
    j = pub('run:alpha');
    assert.equal(j.memKind, 'rss');
    assert.equal(j.memPeakBytes, 130000 * 1024, 'peak restarted on the flip back to rss');
  });
});

test('memory: cached probes expire and cannot follow changed tree membership or reused PIDs', async () => {
  await synthetic(async (clock, t0) => {
    runJobStart('alpha', 'mem.py', 5200, 'python3 mem.py');
    const snapshot = (child = false, reused = false) => {
      const snap = snapOf([
        psRow(5200, 1, 0, 1000, '0:01.00', 'S', 'python3 mem.py'),
        ...(child ? [psRow(5201, 5200, 0, 2000, '0:01.00', 'S', 'python3 worker.py')] : []),
      ], clock.at());
      for (const row of snap.procs.values()) row.startMs = reused ? t0 - 1000 : t0 - 300000;
      return snap;
    };
    const initial = snapshot();
    const probe = Object.assign(new Map([[5200, { footprint: 100, threads: 2 }]]), {
      _sampledAt: t0, _identities: new Map(initial.procs),
    });
    await _test.tick({ now: clock.at(), snap: initial, probe });
    assert.equal(pub('run:alpha').memKind, 'footprint');
    clock.set(300);
    await _test.tick({ now: clock.at(), snap: snapshot(true), probe });
    assert.equal(pub('run:alpha').memBytes, 3000 * 1024, 'new child requires RSS for the whole tree');
    assert.equal(pub('run:alpha').threads, null);
    clock.set(600);
    await _test.tick({ now: clock.at(), snap: snapshot(), probe });
    assert.equal(pub('run:alpha').memBytes, 100, 'gone child does not contaminate the current total');
    clock.set(900);
    await _test.tick({ now: clock.at(), snap: snapshot(false, true), probe });
    assert.equal(pub('run:alpha').memKind, 'rss', 'same PID with a different birth time is not the probed process');
    clock.set(1000);
    await _test.tick({ now: clock.at(), snap: snapshot(), probe });
    assert.equal(pub('run:alpha').memKind, 'footprint');
    clock.set(1201);
    await _test.tick({ now: clock.at(), snap: snapshot(), probe: null });
    assert.equal(pub('run:alpha').memKind, 'rss', 'carrying a cached map never refreshes its original timestamp');
    assert.equal(pub('run:alpha').threads, null);
    await _test.tick({ now: clock.at(), snap: snapshot(), probe });
    assert.equal(pub('run:alpha').memKind, 'rss', 'explicit stale map is also rejected');
  });
});

test('memory: capped probes and mixed Linux PSS/RSS never present partial footprint totals', async () => {
  await synthetic(async (clock) => {
    runJobStart('alpha', 'many.py', 5300, 'python3 many.py');
    const rows = Array.from({ length: 65 }, (_, i) => psRow(5300 + i, i ? 5300 : 1, 0, 1000, '0:01.00', 'S', 'python3 many.py'));
    const probe = new Map(Array.from({ length: 64 }, (_, i) => [5300 + i, { footprint: 100, threads: 1 }]));
    await _test.tick({ now: clock.at(), snap: snapOf(rows, clock.at()), probe });
    assert.equal(pub('run:alpha').procs, 65);
    assert.equal(pub('run:alpha').memBytes, 65000 * 1024);
    assert.equal(pub('run:alpha').memKind, 'rss');
    assert.equal(pub('run:alpha').threads, null);
    await _test.tick({ now: clock.at(), snap: snapOf(rows.slice(0, 2), clock.at()), probe: new Map([
      [5300, { footprint: 100, threads: 1 }], [5301, { rss: 1000 * 1024, threads: 3 }],
    ]) });
    assert.equal(pub('run:alpha').memBytes, 2000 * 1024);
    assert.equal(pub('run:alpha').memKind, 'rss');
    assert.equal(pub('run:alpha').threads, 4, 'complete thread totals remain independent from unavailable PSS');
  });
});

test('stale: a sweep without the root pid (or no sweep at all) keeps the numbers but flags them', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'gone.jl', 6100, 'julia gone.jl');
    job.t0 = t0 - 5000;
    assert.equal(pub('run:alpha').stale, false, 'starting: nothing to be stale yet');
    assert.equal(pub('run:alpha').sampledAt, null);
    assert.equal(pub('run:alpha').health.state, 'starting');
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(6100, 1, 120.0, 4000, '0:03.00', 'R', 'julia gone.jl')], clock.at()) });
    let j = pub('run:alpha');
    assert.equal(j.stale, false);
    assert.equal(j.cores, 1.2);
    // the root vanished from the table
    clock.set(300);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(1, 0, 0.0, 10, '0:00.00', 'S', 'launchd')], clock.at()) });
    j = pub('run:alpha');
    assert.equal(j.stale, true);
    assert.equal(j.cores, 1.2, 'last value kept for greying, never zeroed');
    assert.equal(j.cpu, 120, 'legacy value kept too');
    assert.equal(j.sampledAt, new Date(t0).toISOString(), 'sampledAt is the last sweep that SAW the pid');
    // it reappears → fresh again
    clock.set(600);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(6100, 1, 120.0, 4000, '0:03.72', 'R', 'julia gone.jl')], clock.at()) });
    j = pub('run:alpha');
    assert.equal(j.stale, false);
    assert.equal(j.sampledAt, new Date(t0 + 600).toISOString());
    assert.equal(j.cores, 1.2, 'Δ 0.72 s over 0.6 s wall, new EMA seed');
    // ps itself failed
    clock.set(900);
    await _test.tick({ now: clock.at(), probe: null, snap: null });
    assert.equal(pub('run:alpha').stale, true);
    // and simply time passing beyond two polls with no sweep at all
    clock.set(1200);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(6100, 1, 120.0, 4000, '0:04.08', 'R', 'julia gone.jl')], clock.at()) });
    assert.equal(pub('run:alpha').stale, false);
    clock.set(1200 + 2 * 300 + 1);
    assert.equal(pub('run:alpha').stale, true, 'now − sampledAt > 2 × pollMs');
  });
});

test('health: computing → idle → stalled after 20 s of < 0.05 cores (owned output must be quiet too); io on U state', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'stall.py', 7100, 'python3 stall.py');
    job.t0 = t0 - 5000;
    const row = (pcpu, cpu, state) => snapOf([psRow(7100, 1, pcpu, 4000, cpu, state, 'python3 stall.py')], clock.at());
    await _test.tick({ now: clock.at(), probe: null, snap: row(100.0, '0:01.00', 'R') });
    let j = pub('run:alpha');
    assert.equal(j.health.state, 'computing');
    assert.equal(j.health.sinceMs, 0);
    clock.set(2000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(0.0, '0:01.00', 'S') });
    j = pub('run:alpha');
    assert.equal(j.cores, 0);
    assert.equal(j.health.state, 'idle', 'low CPU but not yet 20 s');
    clock.set(2000 + 19000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(0.0, '0:01.00', 'S') });
    assert.equal(pub('run:alpha').health.state, 'idle', 'still under 20 s of silence');
    // 20 s of low CPU, but the ▶ stream just spoke → not stalled
    runJobOutput('alpha', 'still here\n');
    clock.set(2000 + 20000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(0.0, '0:01.00', 'S') });
    assert.equal(pub('run:alpha').health.state, 'idle', 'owned output within 20 s keeps it out of stalled');
    // …and once the output has been quiet for 20 s as well: stalled
    clock.set(2000 + 20000 + 20000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(0.0, '0:01.00', 'S') });
    j = pub('run:alpha');
    assert.equal(j.health.state, 'stalled');
    assert.equal(j.health.sinceMs, 21000, 'stalled counts the whole silence: since the last output line (fed at 21 s), detection window included');
    clock.set(2000 + 20000 + 25000);
    assert.equal(pub('run:alpha').health.sinceMs, 26000, 'and keeps counting from there');
    // uninterruptible wait with low CPU → io
    clock.set(2000 + 20000 + 26000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(0.0, '0:01.00', 'U') });
    assert.equal(pub('run:alpha').health.state, 'io');
    // CPU returns → computing at once
    clock.set(2000 + 20000 + 28000);
    await _test.tick({ now: clock.at(), probe: null, snap: row(100.0, '0:03.00', 'R') });
    assert.equal(pub('run:alpha').health.state, 'computing');
    assert.equal(pub('run:alpha').health.sinceMs, 0);
    // a terminal job has no health word (the end summary replaces it)
    runJobEnd('alpha', { state: 'done', exitCode: 0, ms: 50000, exit: { code: 0, signal: null, byUser: false } });
    assert.equal(pub('run:alpha').health, null);
  });
});

test('health for session jobs (output not owned): stalled after 20 s of low CPU alone', async () => {
  await synthetic(async (clock, t0) => {
    const job = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn', 'julia quiet.jl');
    job.t0 = t0 - 5000;
    job.pid = 8100; // pinned by hand — findSessionPid is covered by the lifecycle tests
    const row = () => snapOf([psRow(8100, process.pid, 0.0, 4000, '0:00.50', 'S', 'julia quiet.jl')], clock.at());
    await _test.tick({ now: clock.at(), probe: null, snap: row() });
    assert.equal(pub(job.key).health.state, 'idle');
    assert.deepEqual(pub(job.key).output, { owned: false });
    clock.set(20000);
    await _test.tick({ now: clock.at(), probe: null, snap: row() });
    assert.equal(pub(job.key).health.state, 'stalled');
    assert.equal(pub(job.key).history, null, 'no prior runs of quiet.jl');
  });
});

test('history: median of DONE runs of the same file (errors/stopped excluded); even count averages; inline → null', async () => {
  await synthetic(async (clock, t0) => {
    runJobStart('alpha', 'med.jl', 9100, 'julia med.jl');
    assert.deepEqual(pub('run:alpha').history, { typicalMs: 200, n: 3 });
    _test.jobs.delete('run:alpha');
    runJobStart('alpha', 'even.py', 9101, 'python3 even.py');
    assert.deepEqual(pub('run:alpha').history, { typicalMs: 250, n: 2 });
    _test.jobs.delete('run:alpha');
    runJobStart('alpha', 'never.py', 9102, 'python3 never.py');
    assert.equal(pub('run:alpha').history, null);
    const inline = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_inl', 'julia -e "solve()"', { label: 'med.jl' });
    assert.equal(inline.inline, true);
    assert.equal(pub(inline.key).history, null, 'inline evals have no stable key');
  });
});

test('exit: the runner\'s (code, signal) pair and byUser ride the terminal job; jobhist gains peakMem + cpuTimeMs', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'sig.jl', 9200, 'julia sig.jl');
    job.t0 = t0 - 5000;
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(9200, 1, 100.0, 300000, '0:12.00', 'R', 'julia sig.jl')], clock.at()) });
    assert.equal(pub('run:alpha').exit, null, 'null while running');
    runJobEnd('alpha', { state: 'stopped', exitCode: null, ms: 7000, exit: { code: null, signal: 'SIGTERM', byUser: true } });
    let j = pub('run:alpha');
    assert.deepEqual(j.exit, { code: null, signal: 'SIGTERM', byUser: true });
    assert.equal(j.exitCode, null, 'legacy exitCode mirrors code');
    assert.equal(j.ms, 7000);
    assert.equal(j.cpuTimeMs, 12000, 'end-summary inputs survive the terminal broadcast');
    assert.equal(j.memPeakBytes, 300000 * 1024);
    assert.equal(j.stale, false, 'terminal jobs are never stale');
    const rec = getJobHistory('alpha').pop();
    assert.equal(rec.file, 'sig.jl');
    assert.equal(rec.peakMem, 300000 * 1024);
    assert.equal(rec.cpuTimeMs, 12000);
    _test.jobs.delete('run:alpha');
    // an external SIGKILL: code null, signal carried, byUser false
    const job2 = runJobStart('alpha', 'killed.jl', 9201, 'julia killed.jl');
    job2.t0 = t0 - 5000; job2.visible = true;
    runJobEnd('alpha', { state: 'error', exitCode: null, ms: 100, exit: { code: null, signal: 'SIGKILL', byUser: false } });
    j = pub('run:alpha');
    assert.deepEqual(j.exit, { code: null, signal: 'SIGKILL', byUser: false });
    assert.doesNotMatch(JSON.stringify(j), /oom|out of memory/i, 'SIGKILL is never labelled OOM by the server');
    _test.jobs.delete('run:alpha');
    const job3 = runJobStart('alpha', 'e137.sh', 9202, 'bash e137.sh');
    job3.t0 = t0 - 5000; job3.visible = true;
    runJobEnd('alpha', { state: 'error', exitCode: 137, ms: 100, exit: { code: 137, signal: null, byUser: false } });
    j = pub('run:alpha');
    assert.deepEqual(j.exit, { code: 137, signal: null, byUser: false });
    assert.equal(j.exitCode, 137);
    assert.doesNotMatch(JSON.stringify(j), /oom|out of memory/i, 'exit 137 is never labelled OOM by the server');
    // a session job stopped by the user: no code, byUser from the stop request
    const s = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_stop', 'julia s.jl');
    s.visible = true; s._stopReq = clock.at();
    sessionJobEnd('toolu_syn_stop', { error: false });
    assert.deepEqual(pub(s.key).exit, { code: null, signal: null, byUser: true });
    const s2 = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_err', 'julia s2.jl');
    s2.visible = true;
    sessionJobEnd('toolu_syn_err', { error: true });
    assert.deepEqual(pub(s2.key).exit, { code: null, signal: null, byUser: false }, 'an error tool_result never invents an exit code');
    assert.equal(pub(s2.key).state, 'error');
  });
  // and the server's own sources carry no such label either
  for (const f of ['../lib/jobs.js', '../lib/runner.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bOOM\b|out.of.memory/i, `${f} never labels a kill as out-of-memory`);
  }
});

test('output: \\n lines counted (\\r frames are not), rate over the last 10 s, last line ANSI-stripped ≤ 160 chars, buffered flag', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'out.py', 9300, 'python3 out.py', { buffered: true });
    job.t0 = t0 - 5000;
    let text = '';
    for (let i = 1; i <= 30; i++) text += `\x1b[32miter ${i}/100\x1b[0m\n`;
    runJobOutput('alpha', text);
    runJobOutput('alpha', ' 10%|█    | 1/10\r 20%|██   | 2/10\r 30%|███  | 3/10');
    let j = pub('run:alpha');
    assert.equal(j.output.lines, 30);
    assert.equal(j.output.rate, 3, '30 lines in the window / 10 s');
    assert.equal(j.output.owned, true);
    assert.equal(j.output.buffered, true);
    assert.equal(j.output.last, '20%|██   | 2/10', 'the last COMPLETE frame; the unterminated tail waits');
    assert.equal(j.progress.iter, 30, 'generic fallback still drives progress');
    runJobOutput('alpha', '\n' + 'x'.repeat(500) + '\n');
    j = pub('run:alpha');
    assert.equal(j.output.lines, 32);
    assert.equal(j.output.last.length, 160);
    clock.set(11000);
    j = pub('run:alpha');
    assert.equal(j.output.rate, 0, 'nothing in the last 10 s');
    assert.equal(j.quietMs, 11000);
    _test.jobs.delete('run:alpha');
    const plain = runJobStart('alpha', 'out2.py', 9301, 'python3 out2.py');
    assert.equal(pub('run:alpha').output.buffered, false);
    assert.equal(pub('run:alpha').output.last, null);
    assert.equal(pub('run:alpha').output.lines, 0);
    assert.ok(plain);
  });
});

test('output: large chunks keep complete diagnostics and counts, while oversized fragments stay bounded', async () => {
  await synthetic(async () => {
    const job = runJobStart('alpha', 'main.cpp', 9350, 'clang++ main.cpp');
    runJobOutput('alpha', 'main.cpp:3:4: error: first diagnostic\n' + 'ordinary output\n'.repeat(5000));
    assert.equal(pub('run:alpha').output.lines, 5001);
    assert.equal(pub('run:alpha').counters.errors, 1, 'diagnostic before the old 16 KiB tail boundary is retained');
    runJobOutput('alpha', 'x'.repeat(100000) + 'main.cpp:4:2: error: not a complete diagnostic');
    assert.equal(job._lineBuf.length, 16384);
    runJobOutput('alpha', '\nmain.cpp:5:2: warning: a real next line\n');
    assert.equal(pub('run:alpha').output.lines, 5003);
    assert.equal(pub('run:alpha').counters.errors, 1, 'truncation must not manufacture a diagnostic');
    assert.equal(pub('run:alpha').counters.warnings, 1);
    assert.equal(job._lineBuf, '');
  });
});

test('output: EOF flushes an unfinished diagnostic once without inventing a newline; split CRLF stays exact', async () => {
  await synthetic(async () => {
    const job = runJobStart('alpha', 'main.cpp', 9351, 'clang++ main.cpp');
    job.visible = true;
    runJobOutput('alpha', 'first\r');
    runJobOutput('alpha', '\nsecond\r\nmain.cpp:9:2: error: unfinished');
    assert.equal(pub('run:alpha').output.lines, 2);
    assert.equal(pub('run:alpha').counters.errors, undefined, 'unterminated line waits while running');
    runJobEnd('alpha', { state: 'error', ms: 100 });
    assert.equal(pub('run:alpha').counters.errors, 1);
    assert.equal(pub('run:alpha').output.last, 'main.cpp:9:2: error: unfinished');
    assert.equal(pub('run:alpha').output.lines, 2);
    runJobEnd('alpha', { state: 'error', ms: 100 });
    assert.equal(pub('run:alpha').counters.errors, 1, 'duplicate finish is idempotent');
  });
});

test('phase + counters: the per-runtime parser feeds ▶ runs (pytest); session lines reach it through the hook', async () => {
  await synthetic(async (clock, t0) => {
    const job = runJobStart('alpha', 'run_tests.sh', 9400, 'python3 -m pytest tests/');
    job.t0 = t0 - 5000;
    assert.equal(pub('run:alpha').phase, null);
    assert.deepEqual(pub('run:alpha').counters, {});
    runJobOutput('alpha', 'collected 5 items\ntests/test_a.py ..F.. [100%]\n');
    let j = pub('run:alpha');
    assert.deepEqual(j.phase, { name: 'tests', n: 5, m: 5, mSoft: false });
    assert.deepEqual(j.counters, { passed: 4, failed: 1 });
    assert.equal(j.progress.frac, 1);
    runJobOutput('alpha', '=========== 1 failed, 4 passed in 0.31s ===========\n');
    j = pub('run:alpha');
    assert.equal(j.phase.name, 'report');
    // the session hook (not wired today): parser only, output stays un-owned
    const s = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_out', 'cargo build --release && julia x.jl');
    sessionJobOutput('toolu_syn_out', '   Compiling polars-core v0.41.0\nwarning: unused import\n');
    const sj = pub(s.key);
    assert.deepEqual(sj.phase, { name: 'compiling', n: 1, m: null, mSoft: false });
    assert.deepEqual(sj.counters, { crate: 'polars-core', warnings: 1 });
    assert.deepEqual(sj.output, { owned: false });
    sessionJobOutput('toolu_missing', 'ignored\n'); // unknown id → no-op
  });
});

test('sampler sanity against a real process: `yes > /dev/null` reads ≈ 1.0 core within 3 s at 300 ms polls', async () => {
  const child = spawn('yes', [], { stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    const job = runJobStart('alpha', 'burn.sh', child.pid, 'bash burn.sh');
    assert.ok(job);
    const t0 = Date.now();
    const probeHost = process.platform === 'darwin' || process.platform === 'linux';
    const j = await until(() => {
      const x = getJobs().find((y) => y.key === 'run:alpha');
      return x && x.coresBasis === 'cputime' && Date.now() - t0 >= 2500 && x.memKind
        && (!probeHost || x.memKind === 'footprint') ? x : null;
    }, 8000);
    assert.ok(j.cores >= 0.75 && j.cores <= 1.25, `cores ≈ 1.0 (got ${j.cores}, basis ${j.coresBasis})`);
    assert.ok(['footprint', 'rss'].includes(j.memKind), `memKind reported (${j.memKind})`);
    assert.ok(j.memBytes > 0 && j.memPeakBytes >= j.memBytes);
    assert.equal(j.procs, 1);
    assert.equal(j.health.state, 'computing');
    assert.equal(j.stale, false);
    assert.ok(j.cpuTimeMs >= 2000, `Σ cputime grows with the burn (${j.cpuTimeMs})`);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.equal(j.memKind, 'footprint', 'the probe answers on macOS/Linux');
      assert.ok(j.threads >= 1, 'thread count from the probe');
    }
  } finally {
    child.kill('SIGKILL');
    runJobEnd('alpha', { state: 'stopped', ms: 3000, exit: { code: null, signal: 'SIGKILL', byUser: true } });
    _test.jobs.delete('run:alpha');
  }
});

// ---------------------------------------------------------------------------
// Wave-1 session cards: cargo / go / node / c / cpp launchers. Detection is
// table-driven over a fixture tree; pinning runs REAL processes for the
// installed toolchains (cargo, node/npm, cc — go guarded) and the ps seams for
// the rest (go run's child, cargo watch, the compile chain, an npm relaunch).
// ---------------------------------------------------------------------------

const rs = path.join(proj, 'rs');
const gomod = path.join(proj, 'gomod');
const js = path.join(proj, 'js');
const cm = path.join(proj, 'cm');
const csub = path.join(proj, 'csub');
for (const d of [path.join(rs, 'src'), path.join(rs, 'tools'), gomod, js, cm, csub]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(rs, 'Cargo.toml'), '[package]\nname = "sleepy"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
fs.writeFileSync(path.join(rs, 'src', 'main.rs'), 'fn main() { std::thread::sleep(std::time::Duration::from_secs(8)); println!("done"); }\n');
fs.copyFileSync('/bin/sleep', path.join(rs, 'tools', 'napper')); // a real Mach-O, not a #! script
fs.chmodSync(path.join(rs, 'tools', 'napper'), 0o755);
fs.writeFileSync(path.join(rs, 'tools', 'run.sh'), '#!/bin/sh\nsleep 1\n');
fs.chmodSync(path.join(rs, 'tools', 'run.sh'), 0o755);
fs.writeFileSync(path.join(gomod, 'go.mod'), 'module example.com/acme/gomod\n\ngo 1.22\n');
fs.writeFileSync(path.join(gomod, 'main.go'), 'package main\n\nimport "time"\n\nfunc main() { time.Sleep(8 * time.Second) }\n');
fs.writeFileSync(path.join(js, 'package.json'), JSON.stringify({
  name: '@acme/pkgx', private: true,
  scripts: { sleepy: 'node sleeper.js', test: 'node --test', build: 'node -e 0' },
}));
fs.writeFileSync(path.join(js, 'sleeper.js'), 'setInterval(() => {}, 1000);\n');
fs.writeFileSync(path.join(js, 'sleeper.ts'), 'setInterval(() => {}, 1000);\n');
fs.writeFileSync(path.join(cm, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(cm CXX)\nadd_executable(app main.cpp)\n');
fs.writeFileSync(path.join(cm, 'main.cpp'), 'int main() { return 0; }\n');
fs.writeFileSync(path.join(csub, 'Makefile'), 'all: x\nx: x.c\n\tcc x.c -o x\n');
fs.writeFileSync(path.join(csub, 'x.c'), 'int main(void) { return 0; }\n');
fs.writeFileSync(path.join(csub, 'nap.c'), '#include <unistd.h>\nint main(void) { sleep(8); return 0; }\n');

const detectIn = (cmd) => detectScriptRun(cmd, { root: proj });
async function untilAsync(pred, timeoutMs = 15000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error('untilAsync() timed out');
    await sleep(everyMs);
  }
}
const argsOf = async (pid) => {
  const snap = await _test.psSnapshot();
  return snap && snap.procs.get(pid) ? snap.procs.get(pid).args : null;
};
// kill a spawned shell and everything under it, by pid (never by name: a
// concurrent copy of this suite runs the same scripts from its own tmp dir)
async function killTree(rootPid) {
  const snap = await _test.psSnapshot();
  const pids = snap ? _test.descendantsOf(snap, rootPid, true).reverse() : [rootPid];
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

test('detectScriptRun: cargo / go / node / c / cpp launchers → lang, file and pin (marker walk from the project root, cd tracked)', () => {
  // [command, lang, file, pin] — pin: 'legacy' (interpreter+basename, no pin
  // object), 'self' (launcher is the tree root), 'child' (re-pin to the
  // launcher's child), 'chain' (compile → binary: two matchers)
  const table = [
    ['cd rs && cargo run', 'rust', 'sleepy (cargo run)', 'self'],
    ['cd rs && cargo run --release --bin sleepy2 -- --n 3', 'rust', 'sleepy2 (cargo run)', 'self'],
    ['cd rs && cargo +nightly test', 'rust', 'sleepy (cargo test)', 'self'],
    ['cd rs && cargo build --release', 'rust', 'sleepy (cargo build)', 'self'],
    ['cd rs && cargo watch -x run', 'rust', 'sleepy (cargo watch)', 'self'],
    ['cd rs && cargo build && ./target/debug/sleepy', 'rust', 'target/debug/sleepy', 'chain'],
    ['cd rs && ./target/debug/sleepy', 'rust', 'target/debug/sleepy', 'self'],
    ['./rs/target/release/sleepy --n 3', 'rust', 'rs/target/release/sleepy', 'self'],
    ['cd rs && ./tools/napper 3', 'rust', 'tools/napper', 'self'],
    ['cd rs && rustc -O src/main.rs', 'rust', 'src/main.rs', 'legacy'],
    ['cd gomod && go run .', 'go', 'gomod (go run)', 'child'],
    ['cd gomod && go test ./...', 'go', 'gomod (go test)', 'child'],
    ['cd gomod && go build', 'go', 'gomod (go build)', 'self'],
    ['cd gomod && go build -o bin/gomod ./cmd/gomod && ./bin/gomod', 'go', 'bin/gomod', 'chain'],
    ['cd gomod && go run main.go', 'go', 'main.go', 'child'],
    ['cd gomod && air', 'go', 'gomod (air)', 'self'],
    ['cd js && npm test', 'node', 'pkgx (npm test)', 'child'],
    ['cd js && npm run build', 'node', 'pkgx (npm run build)', 'child'],
    ['cd js && npx vitest run', 'node', 'pkgx (npx vitest)', 'child'],
    ['cd js && npx tsx sleeper.ts', 'node', 'sleeper.ts', 'child'],
    ['cd js && node sleeper.js', 'node', 'sleeper.js', 'legacy'],
    ['cd js && node --test', 'node', 'pkgx (node --test)', 'self'],
    ['cd js && yarn build', 'node', 'pkgx (yarn build)', 'child'],
    ['cd js && pnpm test', 'node', 'pkgx (pnpm test)', 'child'],
    ['cd js && bun test', 'node', 'pkgx (bun test)', 'self'],
    ['cd js && nodemon sleeper.js', 'node', 'sleeper.js', 'self'],
    ['cd csub && make', 'c', 'csub (make)', 'self'],
    ['cd csub && make -j8 all', 'c', 'csub (make all)', 'self'],
    ['make -C csub', 'c', 'csub (make)', 'self'],
    ['cd cm && cmake --build build', 'cpp', 'cm (cmake --build)', 'self'],
    ['cd cm && cmake -S . -B build && cmake --build build', 'cpp', 'cm (cmake)', 'self'],
    ['cd cm && ninja -C build', 'cpp', 'cm (ninja)', 'self'],
    ['cd cm && ctest --test-dir build', 'cpp', 'cm (ctest)', 'self'],
    ['cd cm && ./build/app', 'cpp', 'build/app', 'self'],
    ['cd csub && cc x.c -o x && ./x', 'c', 'x', 'chain'],
    ['cd cm && c++ -std=c++20 main.cpp -o main && ./main', 'cpp', 'main', 'chain'],
    ['cd csub && make && ./x', 'c', 'x', 'chain'],
    ['cd rs && bash -c "cargo test"', 'rust', 'sleepy (cargo test)', 'self'],
  ];
  for (const [cmd, lang, file, pin] of table) {
    const got = detectIn(cmd);
    assert.ok(got, `should detect: ${cmd}`);
    assert.equal(got.lang, lang, cmd);
    assert.equal(got.file, file, cmd);
    assert.equal(got.detached, false, cmd);
    assert.equal(got.inline, false, cmd);
    if (pin === 'legacy') assert.equal(got.pin, undefined, `${cmd}: the interpreter+basename rule suffices`);
    else {
      assert.ok(got.pin && Array.isArray(got.pin.any) && got.pin.any.length >= 1, `${cmd}: carries a pin`);
      assert.ok(got.pin.any.every((m) => m.argv0 instanceof RegExp), cmd);
      if (pin === 'child') assert.ok(got.pin.child instanceof RegExp, `${cmd}: child re-pin`);
      else assert.equal(got.pin.child, null, `${cmd}: no child re-pin`);
      if (pin === 'chain') {
        assert.ok(got.pin.any.length >= 2, `${cmd}: the compiler's matchers + the binary`);
        assert.ok(got.pin.any[got.pin.any.length - 1].argv0.test(`./${file}`), `${cmd}: the tail binary matches`);
        assert.equal(got.pin.compile, false, `${cmd}: the tail is the program, not another build step`);
      }
    }
  }
  // the matchers against what ps actually prints
  const cargo = detectIn('cd rs && cargo run').pin.any;
  assert.ok(cargo[0].argv0.test('/Users/x/.cargo/bin/cargo') && cargo[0].needle.test('/Users/x/.cargo/bin/cargo run --quiet'));
  assert.ok(!cargo[0].needle.test('rustc --crate-name sleepy /Users/x/.cargo/registry/src/x/lib.rs'), 'cargo\'s rustc children are not the launcher');
  assert.ok(cargo[1].argv0.test('target/debug/sleepy'), 'the exec\'d binary keeps the pin');
  const npm = detectIn('cd js && npm run sleepy').pin;
  assert.ok(npm.any[0].argv0.test('npm') && npm.any[0].needle.test('npm run sleepy'), 'npm rewrites its title to `npm run x`');
  assert.ok(npm.any[0].argv0.test('node') && npm.any[0].needle.test('node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run sleepy'));
  assert.ok(!npm.any[0].needle.test('node sleeper.js'), 'the script\'s own node is the CHILD, never the launcher');
  assert.ok(npm.child.test('node') && npm.child.test('/opt/homebrew/bin/node') && !npm.child.test('sh'));
  const go = detectIn('cd gomod && go run .').pin;
  assert.ok(go.any[0].argv0.test('/usr/local/go/bin/go') && go.any[0].needle.test('/usr/local/go/bin/go run .'));
  assert.ok(go.child.test('/var/folders/x/T/go-build4242/b001/exe/gomod') && go.child.test('example.com/acme/gomod.test'));
  assert.ok(!go.any[0].needle.test('/usr/local/go/pkg/tool/darwin_arm64/compile -o x'), 'go\'s compile step is not the launcher');
  // detached + nohup/bash -c wrappers
  const det = detectIn("nohup bash -c 'cd rs && cargo run' > run.log 2>&1 &");
  assert.equal(det.lang, 'rust');
  assert.equal(det.detached, true);
  assert.equal(detectIn('cd js && npm run sleepy &').detached, true);
  // a script file in a later segment still wins over a launcher (the julia card, as before)
  assert.deepEqual(detectIn('cd rs && cargo build --release && julia x.jl'), { lang: 'julia', file: 'x.jl', detached: false, inline: false });
  // not runs
  const no = [
    'cd js && npm install', 'cd js && npm ci', 'cargo --version', 'go version', 'make --version', 'make -n',
    'cd rs && ./nonexistent', 'cd rs && ./tools/run.sh', 'cmake -P script.cmake', 'rm -rf rs/target/debug/sleepy',
    'ls rs/target/debug/', 'strip cm/build/app', '/usr/bin/env', 'cat build/log.txt', 'cd nowhere && make',
    'nohup ./server --port 8080 &', 'node --version', 'npx --version', 'make', // no Makefile at the project root
  ];
  for (const cmd of no) assert.equal(detectIn(cmd), null, `should NOT detect: ${cmd}`);
  // a marker-less cwd falls back to the build-dir hint; a compiled go test
  // binary is the tail of its `go test -c` chain
  assert.equal(detectIn('./target/debug/anything').lang, 'rust', 'target/debug names rust even without Cargo.toml');
  const gt = detectIn('cd gomod && go test -c && ./gomod.test -test.v');
  assert.equal(gt.lang, 'go');
  assert.equal(gt.file, 'gomod.test');
  assert.ok(gt.pin.any[1].argv0.test('./gomod.test'));
  // the marker walk never climbs above the project root
  assert.equal(_test.nearestMarker(path.join(rs, 'src'), proj).id, 'rust');
  assert.equal(_test.nearestMarker(path.join(cm, 'build'), proj).id, 'c');
  assert.equal(_test.nearestMarker(proj, proj), null);
});

test('session pin: REAL `cargo run` — cargo is pinned as the tree root, then execs into target/debug/<crate> on the same pid',
  { skip: has('cargo') ? false : 'cargo not installed' }, async () => {
    execSync('cargo build --quiet', { cwd: rs, stdio: 'ignore', timeout: 180000 });
    const cmd = `cd ${rs} && cargo run --quiet`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-cargo', 'toolu_cargo', cmd);
    assert.ok(job, 'cargo run detected');
    assert.equal(job.lang, 'rust');
    assert.equal(job.file, 'sleepy (cargo run)');
    assert.ok(job._pin && job._pin.tree, 'cargo is a tree-root pin');
    try {
      await until(() => _test.jobs.get(job.key).pid, 15000);
      const pid = _test.jobs.get(job.key).pid;
      // the exec: the SAME pid now runs the binary
      const args = await untilAsync(async () => {
        const a = await argsOf(pid);
        return a && /target\/debug\/sleepy/.test(a) ? a : null;
      }, 15000);
      assert.match(args, /target\/debug\/sleepy/);
      assert.equal(_test.jobs.get(job.key).pid, pid, 'the pin never moved');
      const vis = await until(() => getJobs().find((j) => j.key === job.key && j.cpu != null), 8000);
      assert.equal(vis.lang, 'rust');
      assert.equal(vis.file, 'sleepy (cargo run)');
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
    } finally {
      await killTree(sh.pid);
      sessionJobEnd('toolu_cargo', { error: false });
      _test.jobs.delete(job.key);
    }
  });

test('session pin: REAL `node sleeper.js` (direct: interpreter+basename, no launcher pin)', async () => {
  const cmd = `cd ${js} && node sleeper.js`;
  const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
  const job = sessionJobStart('alpha', 'tsk-node', 'toolu_node', cmd);
  assert.ok(job && job.lang === 'node' && job.file === 'sleeper.js');
  assert.equal(job._pin, null);
  try {
    await until(() => _test.jobs.get(job.key).pid, 15000);
    const args = await argsOf(_test.jobs.get(job.key).pid);
    assert.match(args, /(^|\/)node sleeper\.js$/);
    const vis = await until(() => getJobs().find((j) => j.key === job.key), 10000); // ⊘ lives on a visible card
    assert.equal(vis.lang, 'node');
    stopSessionJob('alpha', job.key);
    await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
  } finally {
    await killTree(sh.pid);
    sessionJobEnd('toolu_node', { error: false });
    _test.jobs.delete(job.key);
  }
});

test('session pin: REAL `npm run sleepy` — npm is found, then the card re-pins ONCE to its node child',
  { skip: has('npm') ? false : 'npm not installed' }, async () => {
    const cmd = `cd ${js} && npm run sleepy`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-npm', 'toolu_npm', cmd);
    assert.ok(job && job.lang === 'node');
    assert.equal(job.file, 'pkgx (npm run sleepy)');
    assert.ok(job._pin.child instanceof RegExp);
    try {
      const args = await untilAsync(async () => {
        const pid = _test.jobs.get(job.key).pid;
        if (!pid) return null;
        const a = await argsOf(pid);
        return a && /(^|\/)node sleeper\.js$/.test(a) ? a : null;
      }, 20000);
      assert.match(args, /node sleeper\.js$/, 'pinned to the script\'s node, not to npm');
      assert.equal(_test.jobs.get(job.key)._pinChild, null, 'the child pin is one-shot');
      assert.ok((_test.jobs.get(job.key)._ancestry || []).length >= 1, 'ancestry recorded from the child (respawn containment)');
      const vis = await until(() => getJobs().find((j) => j.key === job.key), 10000);
      assert.equal(vis.file, 'pkgx (npm run sleepy)');
      // ⊘ stop kills node; npm exits with it
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
      await until(() => sh.exitCode !== null || sh.signalCode, 8000);
    } finally {
      await killTree(sh.pid);
      sessionJobEnd('toolu_npm', { error: false });
      _test.jobs.delete(job.key);
    }
  });

test('session pin: REAL `cc nap.c -o nap && ./nap` — the card follows the compiler into the binary under the same shell',
  { skip: has('cc') ? false : 'cc not installed' }, async () => {
    const cmd = `cd ${csub} && cc nap.c -o nap && ./nap`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-cc', 'toolu_cc', cmd);
    assert.ok(job && job.lang === 'c');
    assert.equal(job.file, 'nap', 'titled by the binary, the work');
    assert.equal(job._pin.any.length, 2);
    try {
      const args = await untilAsync(async () => {
        const pid = _test.jobs.get(job.key).pid;
        if (!pid) return null;
        const a = await argsOf(pid);
        return a && /(^|\/)nap$/.test(a) ? a : null;
      }, 20000);
      assert.match(args, /(^|\/)nap$/);
      assert.equal(_test.jobs.get(job.key).state, 'running', 'never ended between cc and ./nap');
      const vis = await until(() => getJobs().find((j) => j.key === job.key), 10000);
      assert.equal(vis.lang, 'c');
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
    } finally {
      await killTree(sh.pid);
      sessionJobEnd('toolu_cc', { error: false });
      _test.jobs.delete(job.key);
    }
  });

test('session pin: REAL `go run .` — go is found, the card re-pins to the go-build exe',
  { skip: has('go') ? false : 'go not installed' }, async () => {
    const cmd = `cd ${gomod} && go run .`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-go', 'toolu_go', cmd);
    assert.ok(job && job.lang === 'go' && job.file === 'gomod (go run)');
    try {
      const args = await untilAsync(async () => {
        const pid = _test.jobs.get(job.key).pid;
        if (!pid) return null;
        const a = await argsOf(pid);
        return a && _test.INTERP_ARGV0.go.test(a.split(/\s+/)[0]) ? a : null;
      }, 60000);
      assert.match(args, /go-build\d+\/b\d+\/exe\//);
      stopSessionJob('alpha', job.key);
      await until(() => _test.jobs.get(job.key)?.state === 'stopped', 8000);
    } finally {
      await killTree(sh.pid);
      sessionJobEnd('toolu_go', { error: false });
      _test.jobs.delete(job.key);
    }
  });

test('respawn: REAL supervisor loop around `npm run sleepy` — the card follows npm\'s relaunch down to the new node',
  { skip: has('npm') ? false : 'npm not installed' }, async () => {
    const cmd = `cd ${js} && until npm run sleepy; do sleep 0.3; done`;
    const sh = spawn('bash', ['-c', cmd], { stdio: 'ignore' });
    const job = sessionJobStart('alpha', 'tsk-loop', 'toolu_loop', cmd, { bg: true });
    assert.ok(job && job.file === 'pkgx (npm run sleepy)');
    try {
      const pinnedNode = async () => {
        const pid = _test.jobs.get(job.key).pid;
        if (!pid) return null;
        const a = await argsOf(pid);
        return a && /(^|\/)node sleeper\.js$/.test(a) ? pid : null;
      };
      const pid1 = await untilAsync(pinnedNode, 20000);
      process.kill(pid1, 'SIGKILL'); // the program crashes; npm exits 1; the loop relaunches
      const pid2 = await untilAsync(async () => { const p = await pinnedNode(); return p && p !== pid1 ? p : null; }, 20000);
      assert.notEqual(pid2, pid1);
      assert.equal(_test.jobs.get(job.key).state, 'running', 'rode across the relaunch');
    } finally {
      await killTree(sh.pid);
      sessionJobEnd('toolu_loop', { error: false });
      _test.jobs.delete(job.key);
    }
  });

// synthetic ps tables through the real sweep: what this machine can't run
test('seams: `go run .` re-pins from go to its go-build exe (shallowest child), ancestry recorded from the child', async () => {
  await synthetic(async (clock, t0) => {
    const job = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_go', `cd ${gomod} && go run .`);
    assert.ok(job && job._pin.child);
    job.t0 = t0 - 5000;
    const rows = () => snapOf([
      psRow(100, process.pid, 0.0, 3000, '0:00.05', 'S', `bash -c cd ${gomod} && go run .`, '00:02'),
      psRow(101, 100, 5.0, 40000, '0:00.40', 'S', '/usr/local/go/bin/go run .', '00:02'),
      psRow(102, 101, 99.0, 12000, '0:01.20', 'R', '/var/folders/x/T/go-build4242/b001/exe/gomod', '00:01'),
      psRow(103, 102, 1.0, 1000, '0:00.01', 'S', '/var/folders/x/T/go-build4242/b001/exe/gomod', '00:01'), // a worker: never the pin
    ], clock.at());
    await _test.tick({ now: clock.at(), probe: null, snap: rows() });
    const j = _test.jobs.get(job.key);
    assert.equal(j.pid, 102, 'go (101) found, then the exe under it — not the deeper worker');
    assert.equal(j._pinChild, null);
    assert.deepEqual(j._ancestry, [101, 100], 'respawns search under go, then the shell');
    assert.equal(pub(job.key).procs, 2, 'the exe and its worker');
    assert.equal(pub(job.key).lang, 'go');
  });
});

test('seams: `cargo watch -x run` pins the watcher as the tree root and never moves across its restarts', async () => {
  await synthetic(async (clock, t0) => {
    const job = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_watch', `cd ${rs} && cargo watch -x run`);
    assert.ok(job && job._pin.tree && job.file === 'sleepy (cargo watch)');
    job.t0 = t0 - 5000;
    const gen = (bin) => snapOf([
      psRow(200, process.pid, 0.0, 3000, '0:00.05', 'S', 'bash -c cargo watch -x run', '00:03'),
      psRow(201, 200, 1.0, 30000, '0:00.30', 'S', '/Users/x/.cargo/bin/cargo watch -x run', '00:03'),
      psRow(bin.pid, 201, 90.0, 20000, '0:00.90', 'R', bin.args, '00:01'),
    ], clock.at());
    await _test.tick({ now: clock.at(), probe: null, snap: gen({ pid: 202, args: 'target/debug/sleepy' }) });
    assert.equal(_test.jobs.get(job.key).pid, 201, 'the watcher, not the binary under it');
    clock.set(300);
    await _test.tick({ now: clock.at(), probe: null, snap: gen({ pid: 203, args: 'cargo run' }) }); // rebuilding
    clock.set(600);
    await _test.tick({ now: clock.at(), probe: null, snap: gen({ pid: 204, args: 'target/debug/sleepy' }) });
    assert.equal(_test.jobs.get(job.key).pid, 201);
    assert.equal(pub(job.key).state, 'running');
    assert.equal(pub(job.key).procs, 2);
  });
});

test('seams: `cc nap.c -o nap && ./nap` — cc pinned, the card HOLDS while the shell is between steps, follows ./nap, ends when the shell is gone', async () => {
  await synthetic(async (clock, t0) => {
    const job = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_cc', `cd ${csub} && cc nap.c -o nap && ./nap`);
    job.t0 = t0 - 5000;
    const shell = () => psRow(300, process.pid, 0.0, 3000, '0:00.05', 'S', 'bash -c cc nap.c -o nap && ./nap', '00:02');
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([shell(),
      psRow(301, 300, 80.0, 50000, '0:00.30', 'R', '/usr/bin/cc nap.c -o nap', '00:01')], clock.at()) });
    assert.equal(_test.jobs.get(job.key).pid, 301, 'the compiler first');
    // cc exited, ./nap not spawned yet: the shell is alive → hold
    clock.set(300);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([shell()], clock.at()) });
    let j = _test.jobs.get(job.key);
    assert.equal(j.state, 'running');
    assert.equal(j._pidGoneAt, null, 'held on the live parent shell');
    clock.set(600);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([shell(),
      psRow(302, 300, 99.0, 800, '0:00.20', 'R', './nap', '00:01')], clock.at()) });
    j = _test.jobs.get(job.key);
    assert.equal(j.pid, 302, 'followed the chain into the binary');
    assert.deepEqual(j._ancestry, [300]);
    // everything gone (a bg job with no tool_result yet): grace, then done
    clock.set(900);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(1, 0, 0.0, 10, '0:00.00', 'S', 'launchd')], clock.at()) });
    assert.equal(_test.jobs.get(job.key).state, 'running');
    clock.set(900 + 801);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([psRow(1, 0, 0.0, 10, '0:00.00', 'S', 'launchd')], clock.at()) });
    assert.equal(_test.jobs.get(job.key).state, 'done');
  });
});

test('seams: a relaunched npm re-arms the one-shot child pin — pinned to npm until its node appears, then to the node', async () => {
  await synthetic(async (clock, t0) => {
    const job = sessionJobStart('alpha', 'tsk-syn', 'toolu_syn_npm', `cd ${js} && until npm run sleepy; do sleep 0.3; done`, { bg: true });
    job.t0 = t0 - 5000;
    const loop = () => psRow(400, process.pid, 0.0, 3000, '0:00.05', 'S', 'bash -c until npm run sleepy; do sleep 0.3; done', '00:05');
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([loop(),
      psRow(401, 400, 2.0, 60000, '0:00.50', 'S', 'npm run sleepy', '00:02'),
      psRow(402, 401, 50.0, 40000, '0:00.40', 'R', 'node sleeper.js', '00:01')], clock.at()) });
    assert.equal(_test.jobs.get(job.key).pid, 402, 'npm found, node child pinned in the same sweep');
    // node crashed, npm exited, the loop relaunched npm — its node isn't up yet
    clock.set(300);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([loop(),
      psRow(411, 400, 2.0, 60000, '0:00.10', 'S', 'npm run sleepy', '00:00')], clock.at()) });
    let j = _test.jobs.get(job.key);
    assert.equal(j.pid, 411, 'the relaunched launcher is the heir');
    assert.deepEqual(j._pinChild, { root: 411, re: j._pin.child, mode: 'shallowest' }, 're-armed');
    clock.set(600);
    await _test.tick({ now: clock.at(), probe: null, snap: snapOf([loop(),
      psRow(411, 400, 2.0, 60000, '0:00.20', 'S', 'npm run sleepy', '00:00'),
      psRow(412, 411, 50.0, 40000, '0:00.05', 'R', 'node sleeper.js', '00:00')], clock.at()) });
    j = _test.jobs.get(job.key);
    assert.equal(j.pid, 412, '…and down to the new node');
    assert.equal(j._pinChild, null);
    assert.equal(j.state, 'running');
  });
});
