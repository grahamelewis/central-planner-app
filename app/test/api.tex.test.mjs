// LaTeX editor support routes: /api/texmeta (completion metadata),
// /api/synctex/{view,edit} (source↔PDF), and the live-watch problems
// pipeline. The compile-dependent tests skip when latexmk isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import WebSocket from 'ws';
import { startSandbox } from './serverHarness.mjs';

const hasTex = (() => {
  try { execSync('which latexmk synctex', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const texOpts = { skip: hasTex ? false : 'latexmk/synctex not installed' };

let sb;

const TEX = `\\documentclass{article}
\\begin{document}
\\section{Model}\\label{sec:model}
Aiyagari with a wedge~$\\tau$.
\\begin{equation}\\label{eq:euler}
c^{-\\gamma} = \\beta (1+r) E c'^{-\\gamma}
\\end{equation}
See \\ref{eq:euler} and \\cite{aiyagari1994}.
\\input{notes/appendix}
\\end{document}
`;

const BIB = `@article{aiyagari1994,
  author = {Aiyagari, S. Rao},
  title = {Uninsured Idiosyncratic Risk and Aggregate Saving},
  journal = {QJE},
  year = {1994},
}
@book{ljungqvist2018, title={Recursive Macroeconomic Theory}, year={2018}}
`;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'paper.tex'), TEX);
      fs.writeFileSync(path.join(projRoots.alpha, 'refs.bib'), BIB);
      fs.mkdirSync(path.join(projRoots.alpha, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'notes', 'appendix.tex'),
        '\\section{Robustness}\\label{sec:robust}\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('GET /api/texmeta returns labels (with file:line), bib keys, envs', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/texmeta/alpha');
  assert.equal(status, 200);
  const labels = body.labels.map((l) => l.label).sort();
  assert.deepEqual(labels, ['eq:euler', 'sec:model', 'sec:robust']);
  const robust = body.labels.find((l) => l.label === 'sec:robust');
  assert.equal(robust.file, path.join('notes', 'appendix.tex'));
  assert.equal(robust.line, 1);
  const keys = body.cites.map((c) => c.key).sort();
  assert.deepEqual(keys, ['aiyagari1994', 'ljungqvist2018']);
  assert.match(body.cites.find((c) => c.key === 'aiyagari1994').title, /Uninsured Idiosyncratic/);
  assert.ok(body.envs.includes('equation'));
});

test('texmeta 404s on an unknown project', async () => {
  const { status } = await sb.fetchJson('GET', '/api/texmeta/nope');
  assert.equal(status, 404);
});

test('GET /api/texdeps scopes a root to its editable included sources', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/texdeps/alpha?tex=paper.tex');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.root, 'paper.tex');
  assert.deepEqual(body.files.sort(), ['notes/appendix.tex', 'paper.tex']);

  let bad = await sb.fetchJson('GET', '/api/texdeps/alpha?tex=../paper.tex');
  assert.equal(bad.status, 400, 'traversal refused');
  bad = await sb.fetchJson('GET', '/api/texdeps/alpha?tex=refs.bib');
  assert.equal(bad.status, 400, 'root must be a tex document');
});

test('synctex routes validate their inputs (400s, no traversal)', async () => {
  let r = await sb.fetchJson('GET', '/api/synctex/view/alpha?tex=paper.tex');
  assert.equal(r.status, 400, 'missing line');
  r = await sb.fetchJson('GET', '/api/synctex/view/alpha?tex=../outside.tex&line=1');
  assert.equal(r.status, 400, 'traversal rejected');
  r = await sb.fetchJson('GET', '/api/synctex/view/alpha?tex=refs.bib&line=1');
  assert.equal(r.status, 400, 'non-tex rejected');
  r = await sb.fetchJson('GET', '/api/synctex/edit/alpha?pdf=paper.pdf&page=x&x=1&y=1');
  assert.equal(r.status, 400, 'non-numeric page');
  r = await sb.fetchJson('GET', '/api/synctex/view/alpha?tex=paper.tex&line=2');
  assert.equal(r.status, 404, 'no compiled pdf yet');
});

test('live watch: compile → built with warning problems; break it → error problems; synctex round-trips', texOpts, async (t) => {
  // pin the live watch on the seeded paper (triggers the catch-up compile)
  const w = await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'paper.tex' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  t.after(() => sb.fetchJson('DELETE', '/api/pdf/watch/alpha'));

  // first build completes — \cite with no bibliography ⇒ citation warning
  let pdf = await sb.poll('/api/state', (s) => s.pdf?.alpha?.state === 'built', { timeoutMs: 60000, everyMs: 250 });
  const entry = pdf.pdf.alpha;
  assert.ok(entry.pages >= 1, 'pages counted');
  assert.ok(entry.counts.warnings >= 1, `expected citation warning, got ${JSON.stringify(entry.counts)}`);
  assert.ok(entry.problems.some((p) => /Citation .aiyagari1994/.test(p.message)), 'citation warning present');
  assert.ok(entry.problems.every((p) => !p.file || !path.isAbsolute(p.file)), 'problem paths are project-relative');

  // synctex: forward — line 5 (the equation) maps to page 1 with a position
  const fwd = await sb.fetchJson('GET', '/api/synctex/view/alpha?tex=paper.tex&line=5');
  assert.equal(fwd.status, 200, JSON.stringify(fwd.body));
  assert.equal(fwd.body.page, 1);
  assert.ok(fwd.body.y > 0);

  // synctex: inverse — that same position maps back into paper.tex
  const inv = await sb.fetchJson('GET',
    `/api/synctex/edit/alpha?pdf=paper.pdf&page=1&x=${fwd.body.x}&y=${fwd.body.y}`);
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(inv.body.file, 'paper.tex');
  assert.ok(inv.body.line >= 1);

  // break the doc OUT-OF-BAND (agent-style direct write) — the dep watcher
  // picks up the change, state → error with a located problem
  const texPath = path.join(sb.projRoots.alpha, 'paper.tex');
  fs.writeFileSync(texPath, TEX.replace('\\section{Model}', '\\sectoin{Model}'));
  pdf = await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'error' && s.pdf.alpha.counts?.errors >= 1,
    { timeoutMs: 60000, everyMs: 250 });
  const err = pdf.pdf.alpha.problems.find((p) => p.kind === 'error');
  assert.ok(err, 'error problem recorded');
  assert.equal(err.file, 'paper.tex');
  assert.equal(err.line, 3);
  assert.match(err.message, /Undefined control sequence/);
  assert.ok(pdf.pdf.alpha.errorMs > 0, 'failed cycle carries its duration (the ✗ chip shows it)');

  // fix it again — recovers to built with no errors
  fs.writeFileSync(texPath, TEX);
  pdf = await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'built' && s.pdf.alpha.counts?.errors === 0,
    { timeoutMs: 60000, everyMs: 250 });
  assert.ok(pdf.pdf.alpha.lastBuildMs > 0);
});

test('a save through PUT /artifact recompiles push-style (no poller in the loop)', texOpts, async (t) => {
  const w = await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'paper.tex' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  t.after(() => sb.fetchJson('DELETE', '/api/pdf/watch/alpha'));
  await sb.poll('/api/state', (s) => s.pdf?.alpha?.state === 'built', { timeoutMs: 60000, everyMs: 250 });
  const stamp0 = (await sb.fetchJson('GET', '/api/state')).body.pdf.alpha.lastBuiltAt;

  // the dashboard-save path: the PUT lands → pokeTex fires the compile directly
  const put = await sb.fetchJson('PUT', '/artifact/alpha/paper.tex',
    { content: TEX.replace('a wedge', 'a labor wedge') });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const rebuilt = await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'built' && s.pdf.alpha.lastBuiltAt !== stamp0,
    { timeoutMs: 60000, everyMs: 100 });
  assert.equal(rebuilt.pdf.alpha.counts.errors, 0, 'clean rebuild from the saved content');
});

test('a compile killed mid-flight marks the watch dead; the next save recovers it', texOpts, async (t) => {
  // a doc slow enough (hundreds of empty pages) that the kill lands mid-compile
  const slowPath = path.join(sb.projRoots.alpha, 'slow.tex');
  fs.writeFileSync(slowPath,
    `\\documentclass{article}\\begin{document}\n${'\\null\\newpage\n'.repeat(1200)}end\\end{document}\n`);
  const w = await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'slow.tex' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  t.after(() => sb.fetchJson('DELETE', '/api/pdf/watch/alpha'));

  // the pin's catch-up compile is running now — kill it out from under the
  // watch (scoped by the sandbox's unique tmpdir path, so nothing else matches)
  execSync(`pkill -9 -f "latexmk.*${sb.projRoots.alpha.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" || true`, { shell: '/bin/bash' });
  const dead = await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'error' && s.pdf.alpha.dead === true,
    { timeoutMs: 20000, everyMs: 200 });
  assert.equal(dead.pdf.alpha.dead, true, 'killed compile flagged dead, not silently stuck');

  // pkill -9 orphans latexmk's pdflatex child — let it drain before the
  // recovery compile so the two never write the same aux/pdf concurrently
  for (let i = 0; i < 100; i++) {
    try { execSync('pgrep -f "slow\\.tex"', { stdio: 'ignore' }); } catch { break; }
    await new Promise((r) => setTimeout(r, 200));
  }

  // the fix: every build is a fresh one-shot, so the next save just compiles
  fs.writeFileSync(slowPath, '\\documentclass{article}\\begin{document}ok\\end{document}\n');
  const revived = await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'built' && !s.pdf.alpha.dead,
    { timeoutMs: 60000, everyMs: 250 });
  assert.ok(revived.pdf.alpha.lastBuiltAt, 'rebuild completed after the save');
});

test('a multi-pass rebuild broadcasts exactly ONE built per latexmk cycle', texOpts, async (t) => {
  const w = await sb.fetchJson('POST', '/api/pdf/watch', { project: 'alpha', tex: 'paper.tex' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  t.after(() => sb.fetchJson('DELETE', '/api/pdf/watch/alpha'));
  await sb.poll('/api/state', (s) => s.pdf?.alpha?.state === 'built', { timeoutMs: 60000, everyMs: 250 });

  // real WS client against the sandbox hub — count pdf:status transitions
  const ws = new WebSocket(sb.base.replace('http', 'ws') + '/ws');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  t.after(() => ws.close());
  const states = [];
  const passes = [];
  let finalEntry = null;
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(d);
      if (m.type === 'pdf:status' && m.payload?.project === 'alpha') {
        states.push(m.payload.entry.state);
        if (m.payload.entry.pass) passes.push(m.payload.entry.pass);
        finalEntry = m.payload.entry;
      }
    } catch { /* snapshot frame */ }
  });

  // add a NEW \label + \ref → undefined reference on pass 1 forces a rerun,
  // so this cycle runs pdflatex at least twice (the old per-pass bug's trigger)
  const texPath = path.join(sb.projRoots.alpha, 'paper.tex');
  const src = fs.readFileSync(texPath, 'utf8');
  fs.writeFileSync(texPath, src.replace('\\end{document}',
    'See \\ref{eq:new}.\n\\begin{equation}\\label{eq:new} y = x \\end{equation}\n\\end{document}'));
  const stamp0 = (await sb.fetchJson('GET', '/api/state')).body.pdf.alpha.lastBuiltAt;
  await sb.poll('/api/state',
    (s) => s.pdf?.alpha?.state === 'built' && s.pdf.alpha.lastBuiltAt !== stamp0,
    { timeoutMs: 60000, everyMs: 250 });
  await new Promise((res) => setTimeout(res, 1500)); // catch any stray late transition

  const builts = states.filter((s) => s === 'built').length;
  assert.equal(builts, 1, `one 'built' per save — the viewer reloads once (got: ${states.join(' → ')})`);
  assert.ok(states.includes('building'), 'the building transition was broadcast');

  // the staged bar's food: rule-run boundaries were broadcast during the
  // cycle (this save forces ≥2 pdflatex passes), and the final built entry
  // carries no stale pass
  assert.ok(passes.some((p) => p.rule === 'pdflatex' && p.n >= 2),
    `pass boundaries broadcast, incl. the rerun (got: ${JSON.stringify(passes)})`);
  assert.equal(finalEntry.pass, null, 'built entry carries no stale pass');
  assert.ok(finalEntry.lastBuildMs > 0, 'built entry carries the cycle duration');
});

test('one-shot ▶ run of a .tex attaches problems to the run record', texOpts, async () => {
  const broken = TEX.replace('\\ref{eq:euler}', '\\reff{eq:euler}');
  fs.writeFileSync(path.join(sb.projRoots.alpha, 'oneshot.tex'), broken);
  const r = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'oneshot.tex' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const state = await sb.poll('/api/state',
    (s) => ['done', 'error'].includes(s.runs?.alpha?.state), { timeoutMs: 60000, everyMs: 250 });
  const run = state.runs.alpha;
  assert.equal(run.state, 'error', 'nonstopmode still exits nonzero on errors');
  assert.ok(run.counts.errors >= 1, `expected errors, got ${JSON.stringify(run.counts)}`);
  const err = run.problems.find((p) => p.kind === 'error');
  assert.equal(err.file, 'oneshot.tex');
  assert.match(err.message, /Undefined control sequence/);
  // build-card material: page count scanned from the stream, no stale pass
  assert.ok(run.pages >= 1, `nonstopmode still wrote pages (got ${run.pages})`);
  assert.equal(run.pass, null, 'finished run carries no stale pass');
});

test('the pdfjs vendor bundle is served', async () => {
  const r = await fetch(`${sb.base}/vendor/pdfjs/pdf.min.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /javascript/);
});
