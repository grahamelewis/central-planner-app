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

const {
  detectScriptRun, parseProgressLine, getJobs, getJobHistory,
  sessionJobStart, sessionJobEnd, endSessionJobsFor, stopSessionJob,
  runJobStart, runJobOutput, runJobEnd, _test,
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
