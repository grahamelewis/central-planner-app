// lib/jobParsers.js — runtime detection + per-runtime phase/counter parsers,
// each against real output lines (captured for docs/jobcard-mockups/metrics.html
// or taken from the tool's own docs where noted there). Pure text; nothing spawns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobParser, detectRuntime, stripAnsi } from '../lib/jobParsers.js';

// feed lines and return the parser's merged view: last phase, counters, last progress
function run(lang, command, lines) {
  const p = createJobParser(lang, command);
  const seen = { phases: [], progress: null, results: [] };
  for (const line of lines) {
    const r = p.feed(line);
    seen.results.push(r);
    if (r && r.phase) seen.phases.push(r.phase);
    if (r && r.progress) seen.progress = r.progress;
  }
  return { p, ...seen, phase: p.phase, counters: p.counters };
}

test('OSC hyperlinks preserve visible labels for both ST and BEL terminators', () => {
  for (const end of ['\x1b\\', '\x07']) {
    const linked = `\x1b]8;;https://example.test${end}main.cpp\x1b]8;;${end}`;
    assert.equal(stripAnsi(`before ${linked} after`), 'before main.cpp after');
    const { counters } = run('cpp', 'clang++ main.cpp', [`${linked}:3:4: error: bad value`]);
    assert.equal(counters.errors, 1);
    assert.equal(counters.lastError.file, 'main.cpp');
  }
  assert.equal(stripAnsi('\x1b]0;title\x1b\\visible\x1b]0;new\x1b\\'), 'visible');
});

test('CTest summary keeps skipped tests distinct from passed outcomes', () => {
  const { counters } = run('cpp', 'ctest', [
    '1/3 Test #1: pass ................ Passed 0.01 sec',
    '2/3 Test #2: skip ................***Skipped 0.01 sec',
    '3/3 Test #3: bad .................***Failed 0.01 sec',
    '67% tests passed, 1 tests failed out of 3',
  ]);
  assert.equal(counters.passed, 1);
  assert.equal(counters.skipped, 1);
  assert.equal(counters.failed, 1);
});

test('detectRuntime: argv0 / subcommand / prefixes / shell -c', () => {
  const cases = [
    ['julia --project=. src/solve.jl', 'julia'],
    ['cd models && time julia -t 4 fig3.jl', 'julia'],
    ['python3 train.py', 'python'],
    ['.venv/bin/python -m pytest tests/ -q', 'pytest'],
    ['pytest -x', 'pytest'],
    ['uv run pytest', 'pytest'],
    ['python -m papermill in.ipynb out.ipynb', 'papermill'],
    ['Rscript analysis.R', 'r'],
    ['cargo build --release', 'cargo'],
    ['go test ./...', 'go'],
    ['npm test', 'node'],
    ['npx tsc --noEmit', 'tsc'],
    ['npx vite build', 'vite'],
    ['node --test test/', 'node'],
    ['latexmk -pdf paper.tex', 'latex'],
    ['perl /Library/TeX/texbin/latexmk -pdf paper.tex', 'latex'],
    ['pdflatex -interaction=nonstopmode doc.tex', 'latex'],
    ['curl -O https://x/y.tgz', 'curl'],
    ['wget https://x/y.tgz', 'wget'],
    ['rsync -av --progress src/ dst/', 'rsync'],
    ['openrsync -av --progress src/ dst/', 'rsync'],
    ['make -j8', 'make'],
    ['cmake --build build', 'cmake'],
    ['ninja -C build', 'ninja'],
    ['stata-mp -b do run.do', 'stata'],
    ['/Applications/Stata/StataMP.app/Contents/MacOS/StataMP -b do run.do', 'stata'],
    ['papermill in.ipynb out.ipynb', 'papermill'],
    ['jupyter nbconvert --to notebook --execute nb.ipynb', 'nbconvert'],
    ['duckdb build.sql', 'sql'],
    ['bash run.sh', 'shell'],
    ["nohup bash -c 'cd /x; until cargo build; do sleep 5; done' &", 'cargo'],
    ['FOO=1 caffeinate -i julia sim.jl', 'julia'],
    // wave-1 runtimes: the registry's step commands (docs/language-support/PHASE1.md §5)
    ['rustc -o /data/runs/p/bin/hello hello.rs', 'rust'],
    ['cargo run --quiet', 'cargo'],
    ['cargo test', 'cargo'],
    ['go run .', 'go'],
    ['npx tsx hello.ts', 'node'],
    ['tsx hello.ts', 'node'],
    ['deno run -A main.ts', 'node'],
    ['bun test', 'node'],
    ['npx vitest run', 'node'],
    ['npx eslint .', 'node'],
    ['ctest --test-dir build --output-on-failure', 'ctest'],
    ['cc -Wall -O0 -g hello.c -o /data/runs/p/bin/hello', 'cc'],
    ['gcc -c a.c', 'cc'],
    ['g++ -std=c++20 a.cpp -o a', 'cc'],
    ['clang++ a.cpp', 'cc'],
    ['/usr/bin/c++ -o app a.o', 'cc'],
    ['cmake -S . -B build', 'cmake'],
    ['ls -la', null],
    ['', null],
  ];
  for (const [cmd, want] of cases) assert.equal(detectRuntime(cmd), want, cmd);
});

test('createJobParser: falls back to the coarse lang; unknown → inert parser', () => {
  assert.equal(createJobParser('python', 'something-odd x.py').runtime, 'python');
  assert.equal(createJobParser('notebook', '').runtime, 'nbconvert');
  const inert = createJobParser('unknownlang', 'mystery-tool');
  assert.equal(inert.runtime, null);
  assert.equal(inert.feed('iter 3/10'), null);
  // ANSI colour is stripped before matching; \r frames keep the final segment
  const py = createJobParser('python', 'python3 x.py');
  const r = py.feed('\x1b[32m 10%|█         | 1/10 [00:00<00:09,  1.00it/s]\r 20%|██        | 2/10 [00:02<00:08,  1.00it/s]\x1b[0m');
  assert.equal(r.progress.iter, 2);
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
});

test('julia: Precompiling phase with per-package count, ProgressMeter bar, ERROR/@warn counters', () => {
  const s = run('julia', 'julia --project=. solve.jl', [
    'Precompiling packages...',
    '   1234.5 ms  ✓ DataFrames',
    '    987.0 ms  ✓ CSV',
    '  12 dependencies successfully precompiled in 45 seconds. 210 already precompiled.',
    'Computing initial pass...53%|███████████████████████████                       |  ETA: 0:09:02',
    'Progress:  53%|█████        |  ETA: 0:09:02 (12.34  s/it)',
    '┌ Warning: missing column',
    '└ @ Main none:12',
    'ERROR: LoadError: in script',
    'Stacktrace:',
    ' [1] error(s::String)',
  ]);
  assert.deepEqual(s.phases[0], { name: 'precompiling', n: 0, m: null, mSoft: false });
  assert.deepEqual(s.phases[2], { name: 'precompiling', n: 2, m: null, mSoft: false });
  assert.deepEqual(s.phases[3], { name: 'running', n: null, m: null, mSoft: false });
  assert.equal(s.progress.frac, 0.53);
  assert.equal(s.progress.etaS, 9 * 60 + 2);
  assert.deepEqual(s.counters, { warnings: 1, errors: 1 });
  // n/m form (Julia ≥ 1.10 "Precompiling project... (n/m)"-style progress)
  const t = run('julia', 'julia x.jl', ['Precompiling project...', '  Progress [=======>            ]  12/38']);
  assert.deepEqual(t.phase, { name: 'precompiling', n: 12, m: 38, mSoft: false });
  // a finished ProgressMeter bar reports Time: instead of ETA: → frac 1
  const u = run('julia', 'julia x.jl', ['Progress: 100%|██████████████████████████| Time: 0:00:05']);
  assert.equal(u.progress.frac, 1);
});

test('python: tqdm n/m + ETA, unit-scaled bars keep only the %, tracebacks/warnings', () => {
  const s = run('python', 'python3 train.py', [
    'train:  60%|███████████████          | 18/30 [00:00<00:00, 176.32it/s]',
    'download: 100%|████████| 2.00k/2.00k [00:00<00:00, 35.1kB/s]',
    '100%|#########################| 3/3 [00:00<00:00, 66.45it/s]',
    ' 41%|████      | 4120/10000 [00:32<00:46, 89.1it/s]',
    '<string>:1: DeprecationWarning: deprecated thing',
    'WARNING:root:disk almost full',
    'Traceback (most recent call last):',
    '  File "x.py", line 1, in <module>',
    'ValueError: boom',
  ]);
  assert.deepEqual(s.results[0].progress, { frac: 0.6, iter: 18, total: 30, etaS: 0 });
  assert.deepEqual(s.results[0].phase, { name: 'train', n: 18, m: 30, mSoft: false });
  assert.deepEqual(s.results[1].progress, { frac: 1, etaS: 0 }, 'unit-scaled 2.00k is not parsed into ints');
  assert.deepEqual(s.results[3].progress, { frac: 0.41, iter: 4120, total: 10000, etaS: 46 });
  assert.deepEqual(s.counters, { warnings: 2, errors: 1 });
});

test('pytest: collected → tests n/m, glyph lines count outcomes + %, summary sets absolutes', () => {
  const s = run('python', 'python -m pytest tests/', [
    '============================= test session starts ==============================',
    'collected 5 items',
    'tests/test_a.py ..Fsx                                                    [ 60%]',
    'tests/test_b.py::test_two PASSED                                          [ 80%]',
    'tests/test_b.py::test_three FAILED                                        [100%]',
    '=================================== FAILURES ===================================',
    'FAILED tests/test_a.py::test_bad - assert 1 == 2',
    '============== 2 failed, 2 passed, 1 skipped, 1 xfailed, 3 warnings in 0.02s ===============',
  ]);
  assert.equal(s.p.runtime, 'pytest');
  assert.deepEqual(s.phases[0], { name: 'collecting', n: null, m: null, mSoft: false });
  assert.deepEqual(s.phases[1], { name: 'tests', n: 0, m: 5, mSoft: false });
  assert.deepEqual(s.results[2].counters, { passed: 2, failed: 1, skipped: 1 });
  assert.deepEqual(s.results[2].progress, { frac: 0.6, iter: 5, total: 5 });
  assert.deepEqual(s.results[3].counters, { passed: 3 });
  assert.equal(s.results[4].progress.frac, 1);
  assert.deepEqual(s.counters, { passed: 2, failed: 2, skipped: 1, warnings: 3 });
  assert.equal(s.phase.name, 'report');
  // deselected items shrink the denominator; -q summary without = rails
  const t = run('python', 'pytest -q', ['collected 42 items / 3 deselected / 39 selected', '2 passed, 3 deselected in 0.00s']);
  assert.equal(t.phases[0].m, 39);
  assert.equal(t.counters.passed, 2);
  const u = run('python', 'pytest', ['!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!']);
  assert.equal(u.phase.name, 'interrupted');
});

test('cargo: Compiling → phase + crate, Building bar n/m only when printed, warning/error counters, tests', () => {
  const s = run('shell', 'cargo build', [
    '    Updating crates.io index',
    '   Compiling demo v0.1.0 (/Users/x/rs/demo)',
    '   Compiling polars-core v0.41.0',
    '    Building [======>                ] 12/40: syn, serde',
    'warning: unused variable: `x`',
    'warning: `demo` (bin "demo") generated 1 warning (run `cargo fix --bin "demo"` to apply 1 suggestion)',
    'error[E0308]: mismatched types',
    'error: could not compile `demo` (bin "demo") due to 1 previous error',
    '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.86s',
    '     Running `target/debug/demo`',
  ]);
  assert.equal(s.p.runtime, 'cargo');
  assert.deepEqual(s.phases[0], { name: 'fetching', n: null, m: null, mSoft: false });
  assert.deepEqual(s.phases[1], { name: 'compiling', n: 1, m: null, mSoft: false }, 'no denominator without the bar');
  assert.equal(s.results[2].counters.crate, 'polars-core');
  assert.deepEqual(s.results[3].phase, { name: 'compiling', n: 12, m: 40, mSoft: false });
  assert.deepEqual(s.results[3].progress, { frac: 0.3, iter: 12, total: 40 });
  assert.equal(s.counters.warnings, 1, 'the "generated N warnings" total line is not a second warning');
  assert.equal(s.counters.errors, 1, 'the "could not compile" summary is not a second error');
  assert.equal(s.phases.at(-2).name, 'built');
  assert.equal(s.phase.name, 'running');
  const t = run('shell', 'cargo test', [
    '     Running unittests src/main.rs (target/debug/deps/demo-7f1)',
    'running 2 tests',
    'test a ... ok',
    'test b ... FAILED',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    "thread 'main' (6602658) panicked at src/main.rs:1:49:",
  ]);
  assert.deepEqual(t.results[1].phase, { name: 'tests', n: 0, m: 2, mSoft: false });
  assert.deepEqual(t.results[3].progress, { frac: 1, iter: 2, total: 2 });
  assert.deepEqual(t.counters, { passed: 1, failed: 1, skipped: 0, errors: 1, lastError: { file: 'src/main.rs', line: 1, col: 49, msg: 'panicked' } });
});

test('go: ok/FAIL package lines, --- FAIL tests, build errors, PASS/FAIL trailer', () => {
  const s = run('shell', 'go test ./...', [
    'go: downloading golang.org/x/text v0.14.0',
    'ok   archive/tar   0.011s',
    '=== RUN   TestX',
    '--- FAIL: TestX (0.00s)',
    'FAIL archive/zip   0.022s',
    'FAIL example.com/m/broken [build failed]',
    'ok   example.com/m/pkg (cached)',
    'FAIL',
  ]);
  assert.equal(s.phases[0].name, 'fetching');
  assert.deepEqual(s.counters, { ok: 2, failed: 2, lastError: { file: null, line: null, col: null, msg: 'TestX' } }, 'a package with a --- FAIL is not double-counted; a build failure counts once');
  assert.equal(s.phase.name, 'report');
  const t = run('shell', 'go build ./...', ['# example.com/m/pkg', 'pkg/a.go:12:5: undefined: foo', 'panic: runtime error: index out of range [10] with length 0']);
  assert.equal(t.phase.name, 'compiling');
  assert.equal(t.counters.errors, 2);
});

test('node / tsc / vite: TS errors + Found N, vite phases, npm banner, node --test totals, jest', () => {
  const s = run('shell', 'npx tsc --noEmit', [
    "bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/a.ts:4:3 - error TS2304: Cannot find name 'foo'.",
    'Found 2 errors in 2 files.',
  ]);
  assert.equal(s.p.runtime, 'tsc');
  assert.equal(s.counters.errors, 2);
  const v = run('shell', 'npx vite build', [
    'vite v6.4.3 building for production...',
    'transforming...',
    '✓ 3 modules transformed.',
    'rendering chunks...',
    'dist/assets/index-BUczvBw7.js  0.73 kB │ gzip: 0.41 kB',
    '✓ built in 52ms',
  ]);
  assert.deepEqual(v.phases.map((p) => p.name), ['building', 'transforming', 'rendering', 'built']);
  assert.equal(v.counters.modules, 3);
  const n = run('shell', 'npm test', [
    '> x@1.0.0 test',
    '> node --test',
    '✔ good (0.5ms)',
    '✖ bad (0.730084ms)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
    'npm error Lifecycle script `test` failed with error:',
  ]);
  assert.equal(n.phases[0].name, 'test');
  assert.deepEqual(n.counters, { passed: 1, failed: 1, errors: 1 });
  const j = run('shell', 'npx jest', ['Tests:       1 failed, 41 passed, 42 total']);
  assert.deepEqual(j.counters, { failed: 1, passed: 41 });
});

test('latexmk / pdflatex: run number → pass with a soft ≤ max(N,3), page markers, warnings, ! errors', () => {
  const s = run('shell', 'latexmk -pdf paper.tex', [
    "Latexmk: applying rule 'pdflatex'...",
    "Run number 1 of rule 'pdflatex'",
    '[1{/usr/local/texlive/2025/texmf-var/fonts/map/pdftex/updmap/pdftex.map}]',
    'LaTeX Warning: Citation `k1\' on page 1 undefined on input line 3.',
    'Overfull \\hbox (12.3pt too wide) in paragraph at lines 10--12',
    '(./doc.aux) [2] [3]',
    'Output written on doc.pdf (14 pages, 23959 bytes).',
    "Running 'bibtex  \"bib.aux\"'",
    "Run number 2 of rule 'pdflatex'",
    '! LaTeX Error: File `nosuchpkgxyz.sty\' not found.',
    './miss.tex:1: Emergency stop.',
    'Latexmk: Errors, so I did not complete making targets',
  ]);
  assert.equal(s.p.runtime, 'latex');
  assert.deepEqual(s.results[1].phase, { name: 'pdflatex', n: 1, m: 3, mSoft: true });
  assert.equal(s.results[1].counters.pass, 1);
  assert.equal(s.results[1].counters.passesSoft, 3);
  assert.equal(s.results[2].counters.page, 1);
  assert.equal(s.results[5].counters.page, 3, 'largest page marker wins');
  assert.equal(s.results[6].counters.page, 14, 'the Output written line is authoritative');
  assert.equal(s.results[3].counters.warnings, 1);
  assert.equal(s.results[4].counters.overfull, 1);
  assert.equal(s.results[8].counters.warnings, 0, 'warnings reset on each pass (they repeat every run)');
  assert.equal(s.counters.errors, 2);
  assert.equal(s.counters.pass, 2);
  assert.equal(s.phase.name, 'failed');
  const t = run('shell', 'latexmk -pdf x.tex', ["Run number 5 of rule 'pdflatex'", 'Latexmk: All targets (doc.pdf) are up-to-date']);
  assert.equal(t.results[0].phase.m, 5, 'the soft total grows with N');
  assert.equal(t.phase.name, 'done');
});

test('R: loading → running, txtProgressBar %, progress pkg n/m, warnings (immediate + deferred), errors', () => {
  const s = run('r', 'Rscript analysis.R', [
    'Loading required package: Matrix',
    'Attaching package: ‘dplyr’',
    'starting fit',
    '  |========                                |  20%',
    '  |====================                    |  45%',
    '[=====>-----------------] 1/10  10% eta:  0s',
    'Warning message:',
    'In f() : something odd',
    'Warning messages:',
    '1: w 1 ',
    '2: w 2 ',
    'Error in f() : boom',
    'Execution halted',
  ]);
  assert.deepEqual(s.phases.map((p) => p.name), ['loading', 'running', 'halted']);
  assert.equal(s.results[4].progress.frac, 0.45);
  assert.deepEqual(s.results[5].progress, { frac: 0.1, iter: 1, total: 10, etaS: 0 });
  assert.deepEqual(s.counters, { warnings: 3, errors: 1 });
  const t = run('r', 'Rscript -e "rmarkdown::render(\'x.Rmd\')"', ['processing file: report.Rmd', '  |.....          |  42%', 'Output created: report.html']);
  assert.equal(t.phases[0].name, 'rendering');
  assert.equal(t.progress.frac, 0.42);
  assert.equal(t.phase.name, 'rendered');
});

test('curl: meter rows (bytes/total/speed/left) and -# bars; wget dot + bar meters', () => {
  const c = run('shell', 'curl -O https://x/y.tgz', [
    '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
    '                                 Dload  Upload   Total   Spent    Left  Speed',
    ' 58 3906k   58 2265k    0     0  1742k      0  0:00:02  0:00:01  0:00:01 1745k',
    '100 3906k  100 3906k    0     0  3742k      0  0:00:01  0:00:01 --:--:-- 3745k',
  ]);
  assert.equal(c.p.runtime, 'curl');
  assert.deepEqual(c.results[2].progress, { frac: 0.58, etaS: 1 });
  assert.equal(c.results[2].counters.bytes, 2265 * 1024);
  assert.equal(c.results[2].counters.total, 3906 * 1024);
  assert.equal(c.results[2].counters.rateBps, 1745 * 1024);
  assert.equal(c.results[3].progress.frac, 1);
  assert.equal(c.results[3].progress.etaS, undefined, '--:--:-- is not an ETA');
  const hash = run('shell', 'curl -# -O https://x/y', ['#########################################                                 58.0%']);
  assert.equal(hash.progress.frac, 0.58);
  const w = run('shell', 'wget https://x/y.iso', [
    '  1500K .......... .......... 45% 2.35M 3s',
    'y.iso                45%[=======>            ]  412M  18.4MB/s    eta 36s',
  ]);
  assert.equal(w.p.runtime, 'wget');
  assert.deepEqual(w.results[0].progress, { frac: 0.45, etaS: 3 });
  assert.equal(w.results[0].counters.bytes, 1500 * 1024);
  assert.equal(w.results[0].counters.rateBps, Math.round(2.35 * 1024 * 1024));
  assert.deepEqual(w.results[1].progress, { frac: 0.45, etaS: 36 });
  assert.equal(w.results[1].counters.bytes, 412 * 1024 * 1024);
  assert.equal(w.results[1].counters.rateBps, Math.round(18.4 * 1024 * 1024));
});

test('rsync: to-chk (rsync 3) and to-check/xfer# (macOS openrsync) both give files n/m; ir-chk is soft', () => {
  const s = run('shell', 'rsync -av --progress src/ dst/', [
    '      1,234,567  45%   12.34MB/s    0:00:01 (xfr#3, to-chk=40/120)',
    '        3000000 100%  256.39MB/s   00:00:00 (xfer#1, to-check=1/2)',
    '      9,876,543  12%    5.00MB/s    0:00:30 (xfr#7, ir-chk=1000/2000)',
    '      1,234,567  45%   12.34MB/s    0:00:01',
    'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338)',
  ]);
  assert.equal(s.p.runtime, 'rsync');
  assert.deepEqual(s.results[0].progress, { frac: 80 / 120, iter: 80, total: 120 });
  assert.deepEqual(s.results[0].phase, { name: 'transferring', n: 80, m: 120, mSoft: false });
  assert.equal(s.results[0].counters.bytes, 1234567);
  assert.equal(s.results[0].counters.rateBps, 12340000);
  assert.equal(s.results[0].counters.files, 3);
  // openrsync spelling
  assert.deepEqual(s.results[1].progress, { frac: 0.5, iter: 1, total: 2 });
  assert.equal(s.results[1].counters.files, 1);
  assert.equal(s.results[1].counters.bytes, 3000000);
  // ir-chk: the file list is still being scanned → m is soft
  assert.equal(s.results[2].phase.mSoft, true);
  // per-file line without the tail: only the % is honest
  assert.deepEqual(s.results[3].progress, { frac: 0.45 });
  assert.equal(s.counters.errors, 1);
});

test('make / cmake / ninja: cmake %, ninja n/m, make *** Error, compiler diagnostics, configure phases', () => {
  const s = run('shell', 'cmake --build build', [
    '-- Configuring done (1.2s)',
    '-- Generating done (0.1s)',
    '-- Build files have been written to: /x/build',
    '[ 45%] Building CXX object src/CMakeFiles/foo.dir/a.cpp.o',
    'e.c:1:26: error: use of undeclared identifier \'y\'',
    'e.c:2:1: warning: unused variable \'z\' [-Wunused-variable]',
    '[100%] Linking CXX executable foo',
  ]);
  assert.equal(s.p.runtime, 'cmake');
  assert.deepEqual(s.phases.map((p) => p.name), ['generating', 'generated', 'compiling', 'linking']);
  assert.equal(s.results[3].progress.frac, 0.45);
  assert.equal(s.progress.frac, 1);
  assert.deepEqual(s.counters, { errors: 1, warnings: 1, lastError: { file: 'e.c', line: 1, col: 26, msg: "use of undeclared identifier 'y'" } });
  const n = run('shell', 'ninja -C build', ['[12/40] Building CXX object src/a.cpp.o', '[40/40] Linking CXX executable app']);
  assert.deepEqual(n.results[0].progress, { frac: 0.3, iter: 12, total: 40 });
  assert.deepEqual(n.phase, { name: 'linking', n: 40, m: 40, mSoft: false });
  const m = run('shell', 'make -j8', [
    "make[1]: Entering directory '/x/sub'",
    'make: *** [b] Error 1',
    'make: *** [Makefile:12: c] Error 2',
    'make: *** No rule to make target `zzz\'.  Stop.',
    'CMake Error at CMakeLists.txt:3 (find_package):',
  ]);
  assert.equal(m.phases[0].name, 'building');
  assert.equal(m.counters.errors, 4);
});

test('stata batch: nothing ever (stdout is empty by design — the log file is the only source)', () => {
  const s = run('stata', 'stata-mp -b do run.do', ['. regress y x1 x2, robust', 'r(111);', 'iteration 12 of 200', 'end of do-file']);
  assert.equal(s.p.runtime, 'stata');
  assert.ok(s.results.every((r) => r === null));
  assert.equal(s.phase, null);
  assert.deepEqual(s.counters, {});
});

test('papermill / nbconvert: Executing n/m (bar and plain forms), nbconvert phases, cell errors', () => {
  const s = run('notebook', 'papermill in.ipynb out.ipynb', [
    'Input Notebook:  in.ipynb',
    'Executing:  25%|█████████                                        | 1/4 [00:00<?, ?cell/s]',
    'Executing SecondCell:  50%|██████████████████                    | 2/4 [00:01<00:01,  1.50cell/s]',
    'Executing: 12/40',
    'papermill.exceptions.PapermillExecutionError: ',
  ]);
  assert.equal(s.p.runtime, 'papermill');
  assert.deepEqual(s.results[1].phase, { name: 'executing', n: 1, m: 4, mSoft: false });
  assert.deepEqual(s.results[1].progress, { frac: 0.25, iter: 1, total: 4 });
  assert.deepEqual(s.results[2].progress, { frac: 0.5, iter: 2, total: 4 });
  assert.deepEqual(s.results[3].progress, { frac: 0.3, iter: 12, total: 40 });
  assert.equal(s.counters.errors, 1);
  const n = run('notebook', 'jupyter nbconvert --to notebook --execute nb.ipynb', [
    '[NbConvertApp] Converting notebook nb.ipynb to notebook',
    '[NbConvertApp] Executing cell:',
    '[NbConvertApp] Executing cell:',
    'nbclient.exceptions.CellExecutionError: An error occurred while executing the following cell:',
    '[NbConvertApp] Writing 1504 bytes to out.ipynb',
  ]);
  assert.deepEqual(n.phases.map((p) => p.name), ['executing', 'wrote']);
  assert.deepEqual(n.counters, { cells: 2, errors: 1 });
});

test('sql (runner shim): statement heads count, engine errors count', () => {
  const s = run('sql', 'duckdb build.sql', [
    "-- select count(*) from read_parquet('trades.parquet')",
    '┌──────────────┐',
    '-- create table t as select 1',
    'error: Catalog Error: Table with name t already exists!',
  ]);
  assert.deepEqual(s.phase, { name: 'statement', n: 2, m: null, mSoft: false });
  assert.deepEqual(s.counters, { statements: 2, errors: 1 });
});

test('shell scripts: downloader + build patterns both apply inside a .sh run', () => {
  const s = run('shell', 'bash pipeline.sh', [
    '      1,234,567  45%   12.34MB/s    0:00:01 (xfr#3, to-chk=40/120)',
    '[ 45%] Building CXX object src/a.cpp.o',
    'make: *** [all] Error 2',
  ]);
  assert.equal(s.p.runtime, 'shell');
  assert.equal(s.results[0].counters.files, 3);
  assert.equal(s.results[1].progress.frac, 0.45);
  assert.equal(s.counters.errors, 1);
});

test('no server string ever labels exit 137 / SIGKILL as OOM (the parser only echoes what a tool printed)', () => {
  // the only "out of memory" texts are tool-emitted error lines the parser matches verbatim
  const p = createJobParser('python', 'python3 x.py');
  const out = JSON.stringify([p.feed('Killed: 9'), p.feed('exit 137'), p.feed('[runner] terminated (SIGKILL)')]);
  assert.doesNotMatch(out, /oom|out of memory/i);
});

// ---------------------------------------------------------------------------
// Wave-1 runtimes (Rust · Go · Node/TS · C/C++). Real lines captured on this
// machine (cargo/rustc 1.94, node 25.6, clang 17, GNU make 3.81) in temp dirs;
// go, cmake, ninja, ctest, GoogleTest, Catch2, ASan, Jest, Vitest and Mocha
// lines follow each tool's documented output and are marked "(documented)".
// The long temp-dir prefix in the captures is shortened to /tmp/demo.
// ---------------------------------------------------------------------------

const CARGO_TEST_TRANSCRIPT = [
  "   Compiling demo v0.1.0 (/tmp/demo)",
  "    Building [                             ] 0/6: demo, demo(test)            ",
  "warning: unused variable: `unused`",
  " --> src/lib.rs:1:41",
  "  |",
  "1 | pub fn add(a: i32, b: i32) -> i32 { let unused = 3; a + b }",
  "  |                                         ^^^^^^ help: if this is intentional, prefix it with an underscore: `_unused`",
  "  |",
  "  = note: `#[warn(unused_variables)]` (part of `#[warn(unused)]`) on by default",
  "",
  "warning: `demo` (lib) generated 1 warning (run `cargo fix --lib -p demo` to apply 1 suggestion)",
  "    Building [========>                    ] 2/6: integ(test), demo(bin), dem…",
  "warning: `demo` (lib test) generated 1 warning (1 duplicate)",
  "    Building [=============>               ] 3/6: integ(test), demo(bin), dem…",
  "    Building [==================>          ] 4/6: integ(test), demo(bin)      ",
  "    Building [=======================>     ] 5/6: integ(test)                 ",
  "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.27s",
  "     Running unittests src/lib.rs (target/debug/deps/demo-39afa7a4eadb09f1)",
  "",
  "running 3 tests",
  "test tests::ignored ... ignored",
  "test tests::passes ... ok",
  "test tests::fails ... FAILED",
  "",
  "failures:",
  "",
  "---- tests::fails stdout ----",
  "",
  "thread 'tests::fails' (6937328) panicked at src/lib.rs:6:26:",
  "assertion `left == right` failed",
  "  left: 3",
  " right: 4",
  "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
  "",
  "",
  "failures:",
  "    tests::fails",
  "",
  "test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  "",
  "error: test failed, to rerun pass `--lib`",
];

const NODE_TEST_TRANSCRIPT = [
  "✔ good (0.7325ms)",
  "✖ bad (0.686833ms)",
  "﹣ skipped one (0.050166ms) # SKIP",
  "✔ todo one (0.048083ms) # TODO",
  "▶ suite",
  "  ✔ inner ok (0.071333ms)",
  "  ✖ inner bad (0.042792ms)",
  "✖ suite (0.24375ms)",
  "ℹ tests 6",
  "ℹ suites 1",
  "ℹ pass 2",
  "ℹ fail 2",
  "ℹ cancelled 0",
  "ℹ skipped 1",
  "ℹ todo 1",
  "ℹ duration_ms 102.317084",
  "",
  "✖ failing tests:",
  "",
  "test at test/a.test.mjs:4:1",
  "✖ bad (0.686833ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  1 !== 2",
  "  ",
  "      at TestContext.<anonymous> (file:///tmp/demo/test/a.test.mjs:4:28)",
  "      at Test.runInAsyncScope (node:async_hooks:226:14)",
  "      at Test.run (node:internal/test_runner/test:1118:25)",
  "      at Test.processPendingSubtests (node:internal/test_runner/test:787:18)",
  "      at Test.postRun (node:internal/test_runner/test:1247:19)",
  "      at Test.run (node:internal/test_runner/test:1175:12)",
  "      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    actual: 1,",
  "    expected: 2,",
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  "  }",
  "",
  "test at test/a.test.mjs:7:53",
  "✖ inner bad (0.042792ms)",
  "  Error: x",
  "      at TestContext.<anonymous> (file:///tmp/demo/test/a.test.mjs:7:83)",
  "      at Test.runInAsyncScope (node:async_hooks:226:14)",
  "      at Test.run (node:internal/test_runner/test:1118:25)",
  "      at Suite.processPendingSubtests (node:internal/test_runner/test:787:18)",
  "      at Test.postRun (node:internal/test_runner/test:1247:19)",
  "      at Test.run (node:internal/test_runner/test:1175:12)",
  "      at async Promise.all (index 0)",
  "      at async Suite.run (node:internal/test_runner/test:1533:7)",
  "      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7)",
];

const NODE_TEST_TAP = [
  "TAP version 13",
  "# Subtest: good",
  "ok 1 - good",
  "  ---",
  "  duration_ms: 0.725542",
  "  type: 'test'",
  "  ...",
  "# Subtest: bad",
  "not ok 2 - bad",
  "  ---",
  "  duration_ms: 0.906541",
  "  type: 'test'",
  "  location: '/tmp/demo/test/a.test.mjs:4:1'",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "    ",
  "    1 !== 2",
  "    ",
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  expected: 2",
  "  actual: 1",
  "  operator: 'strictEqual'",
  "  stack: |-",
  "    TestContext.<anonymous> (file:///tmp/demo/test/a.test.mjs:4:28)",
  "    Test.runInAsyncScope (node:async_hooks:226:14)",
  "    Test.run (node:internal/test_runner/test:1118:25)",
  "    Test.processPendingSubtests (node:internal/test_runner/test:787:18)",
  "    Test.postRun (node:internal/test_runner/test:1247:19)",
  "    Test.run (node:internal/test_runner/test:1175:12)",
  "    async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3)",
  "  ...",
  "# Subtest: skipped one",
  "ok 3 - skipped one # SKIP",
  "  ---",
  "  duration_ms: 0.07025",
  "  type: 'test'",
  "  ...",
  "# Subtest: todo one",
  "ok 4 - todo one # TODO",
  "  ---",
  "  duration_ms: 0.058334",
  "  type: 'test'",
  "  ...",
  "# Subtest: suite",
  "    # Subtest: inner ok",
  "    ok 1 - inner ok",
  "      ---",
  "      duration_ms: 0.07325",
  "      type: 'test'",
  "      ...",
  "    # Subtest: inner bad",
  "    not ok 2 - inner bad",
  "      ---",
  "      duration_ms: 0.065375",
  "      type: 'test'",
  "      location: '/tmp/demo/test/a.test.mjs:7:53'",
  "      failureType: 'testCodeFailure'",
  "      error: 'x'",
  "      code: 'ERR_TEST_FAILURE'",
  "      stack: |-",
  "        TestContext.<anonymous> (file:///tmp/demo/test/a.test.mjs:7:83)",
  "        Test.runInAsyncScope (node:async_hooks:226:14)",
  "        Test.run (node:internal/test_runner/test:1118:25)",
  "        Suite.processPendingSubtests (node:internal/test_runner/test:787:18)",
  "        Test.postRun (node:internal/test_runner/test:1247:19)",
  "        Test.run (node:internal/test_runner/test:1175:12)",
  "        async Promise.all (index 0)",
  "        async Suite.run (node:internal/test_runner/test:1533:7)",
  "        async Test.processPendingSubtests (node:internal/test_runner/test:787:7)",
  "      ...",
  "    1..2",
  "not ok 5 - suite",
  "  ---",
  "  duration_ms: 0.288875",
  "  type: 'suite'",
  "  location: '/tmp/demo/test/a.test.mjs:7:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..5",
  "# tests 6",
  "# suites 1",
  "# pass 2",
  "# fail 2",
  "# cancelled 0",
  "# skipped 1",
  "# todo 1",
  "# duration_ms 101.995791",
];

const NODE_UNCAUGHT = [
  "hello",
  "/tmp/demo/index.js:1",
  "console.log('hello'); throw new Error('boom');",
  "                      ^",
  "",
  "Error: boom",
  "    at Object.<anonymous> (/tmp/demo/index.js:1:29)",
  "    at Module._compile (node:internal/modules/cjs/loader:1811:14)",
  "    at Module._extensions..js (node:internal/modules/cjs/loader:1942:10)",
  "    at Module.load (node:internal/modules/cjs/loader:1532:32)",
  "    at Module._load (node:internal/modules/cjs/loader:1334:12)",
  "    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)",
  "    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)",
  "    at node:internal/main/run_main_module:33:47",
  "",
  "Node.js v25.6.1",
];

// the per-line results that changed something, as [index, result]
const changes = (s) => s.results.map((r, i) => [i, r]).filter(([, r]) => r);

test('createJobParser: a registry parser key (rust/c/cpp/build/node/go/cargo) resolves without a readable command', () => {
  assert.equal(createJobParser('rust', '/data/runs/p/bin/hello').runtime, 'rust');
  assert.equal(createJobParser('c', '').runtime, 'build');
  assert.equal(createJobParser('cpp', '').runtime, 'build');
  assert.equal(createJobParser('build', '').runtime, 'build');
  assert.equal(createJobParser('node', 'weird-launcher x.ts').runtime, 'node');
  assert.equal(createJobParser('tsx', '').runtime, 'node');
  assert.equal(createJobParser('go', '').runtime, 'go');
  assert.equal(createJobParser('cargo', '').runtime, 'cargo');
  // the command still wins over the coarse key
  assert.equal(createJobParser('cpp', 'ctest --test-dir build').runtime, 'ctest');
  assert.equal(createJobParser('rust', 'cargo test').runtime, 'cargo');
});

test('cargo test: full transcript (real) — compiling n/m → built → tests n/m → report, panic location + message', () => {
  const s = run('cargo', 'cargo test', CARGO_TEST_TRANSCRIPT);
  assert.deepEqual(s.phases.map((p) => `${p.name}${p.n != null ? ` ${p.n}/${p.m}` : ''}`), [
    'compiling 1/null', 'compiling 0/6', 'compiling 2/6', 'compiling 3/6', 'compiling 4/6', 'compiling 5/6',
    'built', 'tests', 'tests 0/3', 'tests 1/3', 'tests 2/3', 'tests 3/3', 'report',
  ]);
  assert.deepEqual(s.counters, {
    crate: 'demo', warnings: 1, skipped: 1, passed: 1, failed: 1, errors: 1,
    lastError: { file: 'src/lib.rs', line: 6, col: 26, msg: 'assertion `left == right` failed' },
  });
  // the Building bar (CARGO_TERM_PROGRESS_WHEN=always) drives progress; the truncated "dem…" tail is fine
  assert.deepEqual(s.results[11].progress, { frac: 2 / 6, iter: 2, total: 6 });
  assert.equal(s.results[12], null, 'the per-crate "generated N warnings" total is not a warning');
  assert.equal(s.results[10], null);
  assert.equal(s.results[3], null, 'a warning location never touches lastError');
  assert.deepEqual(s.results[28].counters, { errors: 1, lastError: { file: 'src/lib.rs', line: 6, col: 26, msg: 'panicked' } });
  assert.deepEqual(s.results[29].counters, { lastError: { file: 'src/lib.rs', line: 6, col: 26, msg: 'assertion `left == right` failed' } });
  assert.equal(s.results[40], null, '"error: test failed, to rerun" is cargo wrap-up, not a diagnostic');
  assert.equal(s.progress.frac, 1);
});

test('cargo build / run / clippy (real): Building bar redraws, Finished/Running, error[E…] with --> location', () => {
  const b = run('cargo', 'cargo build', [
    '   Compiling demo v0.1.0 (/tmp/demo)',
    '    Building [                             ] 0/2: demo                        ',
    'warning: unused variable: `unused`',
    ' --> src/lib.rs:1:41',
    'warning: `demo` (lib) generated 1 warning (run `cargo fix --lib -p demo` to apply 1 suggestion)',
    '    Building [=============>               ] 1/2: demo(bin)                   ',
    '    Building [=============>               ] 1/2: demo(bin)                   ',
    '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.21s',
    '     Running `target/debug/demo`',
    'hello 3',
  ]);
  assert.deepEqual(b.phases.map((p) => p.name), ['compiling', 'compiling', 'compiling', 'built', 'running']);
  assert.equal(b.results[6].phase, undefined, 'a redrawn bar frame moves no phase…');
  assert.equal(b.results[6].counters, undefined, '…and no counter (progress may repeat)');
  assert.deepEqual(b.counters, { crate: 'demo', warnings: 1 });
  const e = run('cargo', 'cargo build', [
    '   Compiling bad v0.1.0 (/tmp/demo/crate2)',
    '    Building [                             ] 0/1: bad(bin)                    ',
    'error[E0308]: mismatched types',
    ' --> src/main.rs:1:26',
    '  |',
    '1 | fn main() { let x: i32 = "a"; let y = undefined_fn(); }',
    '  |                    ---   ^^^ expected `i32`, found `&str`',
    'error[E0425]: cannot find function `undefined_fn` in this scope',
    ' --> src/main.rs:1:39',
    'Some errors have detailed explanations: E0308, E0425.',
    'For more information about an error, try `rustc --explain E0308`.',
    'error: could not compile `bad` (bin "bad") due to 2 previous errors',
  ]);
  assert.deepEqual(e.results[2].counters, { errors: 1, lastError: { file: null, line: null, col: null, msg: 'mismatched types' } });
  assert.deepEqual(e.results[3].counters, { lastError: { file: 'src/main.rs', line: 1, col: 26, msg: 'mismatched types' } });
  assert.equal(e.counters.errors, 2);
  assert.deepEqual(e.counters.lastError, { file: 'src/main.rs', line: 1, col: 39, msg: 'cannot find function `undefined_fn` in this scope' });
  assert.equal(e.results[11], null, '"could not compile" is the wrap-up');
  const c = run('cargo', 'cargo clippy', [
    '    Checking demo v0.1.0 (/tmp/demo)',
    'warning: unused variable: `unused`',
    'warning: `demo` (lib) generated 1 warning (run `cargo clippy --fix --lib -p demo` to apply 1 suggestion)',
    '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.50s',
  ]);
  assert.deepEqual(c.counters, { crate: 'demo', warnings: 1 });
  // older cargo spelled Finished without the word "profile"
  assert.equal(run('cargo', 'cargo build', ['    Finished dev [unoptimized + debuginfo] target(s) in 0.21s']).phase.name, 'built');
  // doc-tests carry spaces in the test name; multiple harnesses add up
  const d = run('cargo', 'cargo test', [
    'running 1 test', 'test tests::a ... ok', 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '   Doc-tests demo', 'running 2 tests', 'test src/lib.rs - add (line 3) ... ok', 'test src/lib.rs - sub (line 9) ... FAILED',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s',
  ]);
  assert.deepEqual(d.counters, { passed: 2, failed: 1, skipped: 0 });
  assert.deepEqual(d.phases.at(-2), { name: 'tests', n: 2, m: 2, mSoft: false });
});

test('rustc (real, single-file path): the same diagnostics, no cargo lines, "N warnings emitted" is a total', () => {
  const w = run('rust', 'rustc -o /data/runs/p/bin/hello /tmp/demo/hello.rs', [
    'warning: unused variable: `unused`',
    ' --> /tmp/demo/hello.rs:1:17',
    '  |',
    '1 | fn main() { let unused = 1; println!("hi"); }',
    '  |                 ^^^^^^ help: if this is intentional, prefix it with an underscore: `_unused`',
    '  |',
    '  = note: `#[warn(unused_variables)]` (part of `#[warn(unused)]`) on by default',
    '',
    'warning: 1 warning emitted',
  ]);
  assert.equal(w.p.runtime, 'rust');
  assert.deepEqual(w.counters, { warnings: 1 });
  assert.equal(w.phase, null, 'rustc prints no phase lines — the runner seeds "compiling" from the step');
  const e = run('rust', 'rustc -o bad bad.rs', [
    'error[E0308]: mismatched types',
    ' --> /tmp/demo/bad.rs:1:26',
    'error[E0425]: cannot find function `undefined_fn` in this scope',
    ' --> /tmp/demo/bad.rs:1:39',
    'error: aborting due to 2 previous errors',
    'Some errors have detailed explanations: E0308, E0425.',
  ]);
  assert.deepEqual(e.counters, { errors: 2, lastError: { file: '/tmp/demo/bad.rs', line: 1, col: 39, msg: 'cannot find function `undefined_fn` in this scope' } });
  // a `rustc --test` binary prints the libtest harness → parser key 'cargo'
  const t = run('cargo', '/data/runs/p/bin/t_test', [
    '', 'running 2 tests', 'test a ... ok', 'test b ... FAILED', '', 'failures:', '', '---- b stdout ----', '',
    "thread 'b' (6937575) panicked at /tmp/demo/t_test.rs:2:18:", 'boom',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace', '', '', 'failures:', '    b', '',
    'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  ]);
  assert.deepEqual(t.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests 0/2', 'tests 1/2', 'tests 2/2', 'report null/null']);
  assert.deepEqual(t.counters, { passed: 1, failed: 1, skipped: 0, errors: 1, lastError: { file: '/tmp/demo/t_test.rs', line: 2, col: 18, msg: 'boom' } });
});

test('go test -v (documented): per-test n, PASS/FAIL/SKIP counters, subtests not double-counted, coverage, package lines', () => {
  const s = run('go', 'go test -v -cover ./...', [
    'go: downloading golang.org/x/text v0.14.0',
    '=== RUN   TestAdd',
    '--- PASS: TestAdd (0.00s)',
    '=== RUN   TestSub',
    '    sub_test.go:12: expected 3, got 4',
    '--- FAIL: TestSub (0.00s)',
    '=== RUN   TestSkip',
    '    skip_test.go:5: not on darwin',
    '--- SKIP: TestSkip (0.00s)',
    '=== RUN   TestParent',
    '=== RUN   TestParent/child',
    '    --- PASS: TestParent/child (0.00s)',
    '--- PASS: TestParent (0.00s)',
    'FAIL',
    'coverage: 81.2% of statements',
    'FAIL\texample.com/m/pkg\t0.022s',
    'ok  \texample.com/m/other\t0.011s\tcoverage: 75.0% of statements',
    '?   \texample.com/m/cmd\t[no test files]',
    'FAIL',
  ]);
  assert.deepEqual(s.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['fetching null/null', 'tests 0/null', 'tests 1/null', 'tests 2/null', 'tests 3/null', 'tests 4/null', 'report null/null']);
  assert.deepEqual(s.counters, {
    passed: 2, failed: 1, skipped: 1, ok: 1, coverage: 75,
    lastError: { file: 'sub_test.go', line: 12, col: null, msg: 'expected 3, got 4' },
  });
  assert.equal(s.results[8].counters.lastError, undefined, "a skipped test's log line is not an error");
  assert.equal(s.results[14].counters.coverage, 81.2);
  assert.equal(s.results[15], null, 'the package FAIL after a --- FAIL is not a second failure');
  assert.equal(s.results[17], null, '"[no test files]" is nothing to count');
});

test('go build errors, panics and exit status (documented): # pkg → compiling, file:line:col → lastError, panic frame', () => {
  const s = run('go', 'go run .', [
    '# example.com/m',
    './main.go:12:3: undefined: foo',
    './main.go:14:9: cannot use "a" (untyped string constant) as int value in assignment',
    'panic: runtime error: index out of range [10] with length 0',
    '',
    'goroutine 1 [running]:',
    'main.main()',
    '\t/Users/x/m/main.go:8 +0x1d',
    'exit status 2',
  ]);
  assert.equal(s.phases[0].name, 'compiling');
  assert.deepEqual(s.results[1].counters, { errors: 1, lastError: { file: './main.go', line: 12, col: 3, msg: 'undefined: foo' } });
  assert.deepEqual(s.results[3].counters, { errors: 3, lastError: { file: null, line: null, col: null, msg: 'panic: runtime error: index out of range [10] with length 0' } });
  assert.deepEqual(s.results[7].counters, { lastError: { file: '/Users/x/m/main.go', line: 8, col: null, msg: 'panic: runtime error: index out of range [10] with length 0' } });
  assert.equal(s.counters.exitStatus, 2);
  // "# pkg [pkg.test]" test-binary build headers and vet-style lines without a column
  const t = run('go', 'go test ./...', ['# example.com/m/pkg [example.com/m/pkg.test]', 'pkg/a_test.go:9: Foo redeclared', 'FAIL\texample.com/m/pkg [build failed]']);
  assert.equal(t.phases[0].name, 'compiling');
  assert.deepEqual(t.counters, { errors: 1, lastError: { file: 'pkg/a_test.go', line: 9, col: null, msg: 'Foo redeclared' }, failed: 1 });
});

test('node --test spec reporter (real, this repo\'s own format): glyphs → n, suite lines skipped, ℹ totals, failing-tests recap → lastError', () => {
  const s = run('node', 'node --test', NODE_TEST_TRANSCRIPT);
  assert.deepEqual(s.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests 1/null', 'tests 2/null', 'tests 3/null', 'tests 4/null', 'tests 5/null', 'tests 6/null', 'report null/null']);
  assert.deepEqual(s.results[0].counters, { passed: 1 });
  assert.deepEqual(s.results[1].counters, { failed: 1 });
  assert.deepEqual(s.results[2].counters, { skipped: 1 });
  assert.deepEqual(s.results[3].counters, { todo: 1 }, 'a TODO test is neither passed nor failed');
  assert.equal(s.results[4], null, '▶ opens a suite');
  assert.equal(s.results[7], null, 'the suite\'s closing ✖ line is not a test');
  assert.equal(s.results[10], null, 'ℹ pass 2 agrees with the per-test count → nothing changes');
  assert.deepEqual(s.results[20].counters, { lastError: { file: 'test/a.test.mjs', line: 4, col: 1, msg: 'bad' } }, 'the recap names the failure but does not count again');
  assert.deepEqual(s.results[21].counters, { lastError: { file: 'test/a.test.mjs', line: 4, col: 1, msg: 'bad: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:' } });
  assert.deepEqual(s.counters, { passed: 2, failed: 2, skipped: 1, todo: 1, lastError: { file: 'test/a.test.mjs', line: 7, col: 53, msg: 'inner bad: Error: x' } });
  assert.equal(s.phase.name, 'report');
  // the same run through npm: the lifecycle banner names the phase first
  const n = run('node', 'npm test', ['', '> demo@1.0.0 test', '> node --test', '', ...NODE_TEST_TRANSCRIPT]);
  assert.equal(n.phases[0].name, 'test');
  assert.deepEqual(n.counters, s.counters);
});

test('node --test TAP reporter (real): ok/not ok with # SKIP / # TODO, nested subtests, suite wrap-up skipped, # totals', () => {
  const s = run('node', 'node --test --test-reporter=tap', NODE_TEST_TAP);
  assert.deepEqual(s.counters, {
    passed: 2, failed: 2, skipped: 1, todo: 1,
    lastError: { file: '/tmp/demo/test/a.test.mjs', line: 7, col: 53, msg: 'inner bad: x' },
  });
  assert.equal(s.phase.name, 'report');
  const wrap = s.results[NODE_TEST_TAP.indexOf('not ok 5 - suite')];
  assert.equal(wrap, null, '"not ok 5 - suite" wraps the nested block; it is not a sixth test');
  assert.deepEqual(s.results[NODE_TEST_TAP.indexOf('ok 3 - skipped one # SKIP')].counters, { skipped: 1 });
  assert.deepEqual(s.results[NODE_TEST_TAP.indexOf('ok 4 - todo one # TODO')].counters, { todo: 1 });
});

test('node: uncaught Error with a stack (real) → errors + lastError from the first non-internal frame; npm error lines', () => {
  const s = run('node', 'node index.js', NODE_UNCAUGHT);
  assert.deepEqual(s.counters, { errors: 1, lastError: { file: '/tmp/demo/index.js', line: 1, col: 29, msg: 'Error: boom' } });
  const n = run('node', 'npm run start', ['', '> demo@1.0.0 start', '> node index.js', '', ...NODE_UNCAUGHT, 'npm error Lifecycle script `start` failed with error:']);
  assert.equal(n.phases[0].name, 'start');
  assert.equal(n.counters.errors, 2);
  const t = run('node', 'node x.js', ['TypeError: x is not a function', '    at main (/x/y.js:3:5)', '    at node:internal/main/run_main_module:33:47']);
  assert.deepEqual(t.counters, { errors: 1, lastError: { file: '/x/y.js', line: 3, col: 5, msg: 'TypeError: x is not a function' } });
});

test('tsc (real): plain and --pretty diagnostics → errors + lastError; "Found N errors" sets the absolute; watch mode resets', () => {
  const s = run('node', 'npx tsc --noEmit bad.ts good.ts', [
    "bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "bad.ts(2,9): error TS2304: Cannot find name 'foo'.",
    "bad.ts(4,3): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
  ]);
  assert.equal(s.p.runtime, 'tsc');
  assert.deepEqual(s.counters, { errors: 3, lastError: { file: 'bad.ts', line: 4, col: 3, msg: "Argument of type 'number' is not assignable to parameter of type 'string'." } });
  const p = run('node', 'npx tsc --noEmit --pretty bad.ts', [
    "\x1b[96mbad.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType 'string' is not assignable to type 'number'.",
    '',
    '\x1b[7m1\x1b[0m const n: number = "str";',
    '\x1b[7m \x1b[0m \x1b[91m      ~\x1b[0m',
    "\x1b[96mbad.ts\x1b[0m:\x1b[93m2\x1b[0m:\x1b[93m9\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2304: \x1b[0mCannot find name 'foo'.",
    "\x1b[96mbad.ts\x1b[0m:\x1b[93m4\x1b[0m:\x1b[93m3\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2345: \x1b[0mArgument of type 'number' is not assignable to parameter of type 'string'.",
    '',
    'Found 3 errors in the same file, starting at: bad.ts\x1b[90m:1\x1b[0m',
  ]);
  assert.equal(p.counters.errors, 3);
  assert.equal(p.phase.name, 'report');
  assert.deepEqual(p.counters.lastError, { file: 'bad.ts', line: 4, col: 3, msg: "Argument of type 'number' is not assignable to parameter of type 'string'." });
  const f = run('node', 'npx tsc', ['Found 1 error in src/a.ts:12', 'Found 3 errors in 2 files.', 'error TS18003: No inputs were found in config file.']);
  assert.equal(f.results[0].counters.errors, 1);
  assert.equal(f.results[1].counters.errors, 3);
  assert.equal(f.counters.errors, 4);
});

test('jest / vitest / mocha (documented): suites + tests absolutes, per-file vitest counts, mocha recap not double-counted', () => {
  const j = run('node', 'npx jest', [
    'PASS src/a.test.ts',
    'FAIL src/b.test.ts',
    '  ● suite › fails',
    '    expect(received).toBe(expected)',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       1 failed, 2 skipped, 8 passed, 11 total',
    'Snapshots:   0 total',
    'Time:        2.345 s',
    'Ran all test suites.',
  ]);
  assert.equal(j.phases[0].name, 'tests');
  assert.deepEqual(j.counters, {
    suites: 2, suitesFailed: 1, failed: 1, skipped: 2, passed: 8, timeS: 2.345,
    lastError: { file: 'src/b.test.ts', line: null, col: null, msg: 'suite › fails' },
  });
  assert.equal(j.phase.name, 'report');
  const v = run('node', 'npx vitest run', [
    ' RUN  v2.1.8 /x',
    ' ✓ src/a.test.ts (3 tests) 12ms',
    ' ❯ src/b.test.ts (2 tests | 1 failed) 20ms',
    ' ↓ src/c.test.ts (2 tests | 2 skipped)',
    ' FAIL  src/b.test.ts > suite > fails',
    'AssertionError: expected 1 to be 2',
    ' Test Files  1 failed | 1 passed | 1 skipped (3)',
    '      Tests  1 failed | 4 passed | 2 skipped (7)',
    '   Start at  10:00:00',
    '   Duration  1.26s (transform 80ms, setup 0ms)',
  ]);
  assert.deepEqual(v.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests 3/null', 'tests 5/null', 'tests 7/null', 'report null/null']);
  assert.deepEqual(v.results[2].counters, { suites: 2, suitesFailed: 1, failed: 1, passed: 4 });
  assert.equal(v.results[5].counters.errors, undefined, 'a failure detail inside a test run is not an uncaught error');
  assert.deepEqual(v.counters, {
    suites: 3, suitesFailed: 1, passed: 4, failed: 1, skipped: 2, timeS: 1.26,
    lastError: { file: 'src/b.test.ts', line: null, col: null, msg: 'AssertionError: expected 1 to be 2' },
  });
  const m = run('node', 'npx mocha', [
    '', '  Array', '    ✓ adds', '    ✓ slow (45ms)', '    1) fails', '',
    '  2 passing (52ms)', '  1 pending', '  1 failing', '',
    '  1) Array', '       fails:', '     AssertionError: expected 1 to equal 2',
  ]);
  assert.deepEqual(m.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests 1/null', 'tests 2/null', 'tests 3/null', 'report null/null']);
  assert.deepEqual(m.counters, { passed: 2, failed: 1, skipped: 1, lastError: { file: null, line: null, col: null, msg: 'fails' } });
});

test('eslint / next / bun (documented): problems summary sets absolutes; ✓ Compiled → built', () => {
  const e = run('node', 'npx eslint .', ['/x/src/a.js', "  1:7  error  'x' is assigned but never used  no-unused-vars", '✖ 3 problems (2 errors, 1 warning)']);
  assert.deepEqual(e.counters, { errors: 2, warnings: 1 });
  assert.equal(e.phase.name, 'report');
  const n = run('node', 'npx next build', ['▲ Next.js 14.2.3', '   Creating an optimized production build ...', ' ✓ Compiled successfully']);
  assert.deepEqual(n.phases.map((p) => p.name), ['building', 'built']);
  assert.equal(detectRuntime('bun run index.ts'), 'node');
});

test('cc / c++ / ld (real): clang diagnostics with location, notes, "N warnings and N errors generated." reconciles, macOS undefined symbols', () => {
  const e = run('build', 'cc -Wall -O0 -g bad.c -o /data/runs/p/bin/bad', [
    "bad.c:2:51: error: use of undeclared identifier 'q'",
    '    2 | int main(void) { int y; int z = 3; printf("%d\\n", q); return 0; }',
    '      |                                                   ^',
    '1 error generated.',
  ]);
  assert.equal(e.p.runtime, 'cc');
  assert.deepEqual(e.counters, { errors: 1, lastError: { file: 'bad.c', line: 2, col: 51, msg: "use of undeclared identifier 'q'" } });
  assert.equal(e.results[3], null, 'the per-unit total agrees with the counted diagnostics');
  const w = run('build', 'cc -Wall -O0 -g warn.c -o warn', [
    "warn.c:2:40: error: incompatible integer to pointer conversion initializing 'char *' with an expression of type 'int' [-Wint-conversion]",
    "warn.c:2:22: warning: unused variable 'unused' [-Wunused-variable]",
    '1 warning and 1 error generated.',
  ]);
  assert.deepEqual(w.counters, { errors: 1, warnings: 1, lastError: { file: 'warn.c', line: 2, col: 40, msg: "incompatible integer to pointer conversion initializing 'char *' with an expression of type 'int' [-Wint-conversion]" } });
  // a lost diagnostic line (pty) — the total still lands
  const lost = run('build', 'cc x.c', ['3 warnings and 2 errors generated.']);
  assert.deepEqual(lost.counters, { warnings: 3, errors: 2 });
  const l = run('build', 'cc -Wall -O0 -g link.c -o link', [
    'Undefined symbols for architecture arm64:',
    '  "_missing_fn", referenced from:',
    '      _main in link-10f47e.o',
    'ld: symbol(s) not found for architecture arm64',
    'clang: error: linker command failed with exit code 1 (use -v to see invocation)',
  ]);
  assert.deepEqual(l.counters, { errors: 1, lastError: { file: null, line: null, col: null, msg: 'undefined symbol _missing_fn' } });
  const x = run('cpp', 'c++ -Wall -O0 -g bad.cpp -o badcpp', [
    "bad.cpp:2:26: error: no viable conversion from 'int' to 'std::string' (aka 'basic_string<char>')",
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1/string:1000:71: note: candidate constructor not viable: no known conversion from 'int' to 'const string &' for 1st argument",
    "bad.cpp:2:33: error: use of undeclared identifier 'undefined_thing'",
    '2 errors generated.',
  ]);
  assert.deepEqual(x.counters, { errors: 2, notes: 1, lastError: { file: 'bad.cpp', line: 2, col: 33, msg: "use of undeclared identifier 'undefined_thing'" } });
  // a running C binary's own lines stay generic (no counters; jobs.js's parseProgressLine handles "step 1/3")
  const bin = run('c', '/data/runs/p/bin/hello', ['step 1/3', 'step 2/3', 'step 3/3']);
  assert.equal(bin.p.runtime, 'build');
  assert.ok(bin.results.every((r) => r === null));
});

test('make (real, GNU make 3.81): compiler echo → compiling, *** Error after a diagnostic is not a second error, No rule, up to date', () => {
  const s = run('build', 'make', [
    'cc -Wall -O0 -g bad.c -o bad',
    "bad.c:2:51: error: use of undeclared identifier 'q'",
    '    2 | int main(void) { int y; int z = 3; printf("%d\\n", q); return 0; }',
    '      |                                                   ^',
    '1 error generated.',
    'make: *** [bad] Error 1',
  ]);
  assert.equal(s.p.runtime, 'make');
  assert.deepEqual(s.phases.map((p) => p.name), ['compiling']);
  assert.deepEqual(s.counters, { errors: 1, lastError: { file: 'bad.c', line: 2, col: 51, msg: "use of undeclared identifier 'q'" } });
  const c = run('build', 'make -C sub', ['in sub', 'false', 'make: *** [all] Error 1']);
  assert.deepEqual(c.counters, { errors: 1, lastError: { file: null, line: null, col: null, msg: 'make: *** [all] Error 1' } });
  const r = run('build', 'make zzz', ["make: *** No rule to make target `zzz'.  Stop."]);
  assert.equal(r.counters.errors, 1);
  assert.equal(run('build', 'make sub', ["make: `sub' is up to date."]).phase.name, 'built');
  // GNU make ≥ 4 / Linux (documented): Entering directory, ld undefined reference, collect2 wrap-up
  const g = run('build', 'make', [
    "make[1]: Entering directory '/x/sub'",
    'cc -Wall -c -o a.o a.c',
    "a.c:4:10: warning: unused variable 'x' [-Wunused-variable]",
    'cc -o app a.o b.o',
    "/usr/bin/ld: a.o: in function `main':",
    "a.c:(.text+0x5): undefined reference to `foo'",
    'collect2: error: ld returned 1 exit status',
    'make[1]: *** [Makefile:3: app] Error 1',
    "make[1]: Leaving directory '/x/sub'",
    'make: *** [Makefile:5: all] Error 2',
  ]);
  assert.deepEqual(g.phases.map((p) => p.name), ['building', 'compiling', 'linking', 'building']);
  assert.deepEqual(g.counters, { warnings: 1, errors: 1, lastError: { file: null, line: null, col: null, msg: 'undefined reference to foo' } }, 'ld context, collect2 and the two propagating make levels add nothing');
  // -k style independent failures at the same level still count separately
  assert.equal(run('build', 'make -k', ['make: *** [a] Error 1', 'make: *** [b] Error 1']).counters.errors, 2);
});

test('cmake / ninja (documented): configure phases, [ n%] compiling → linking → built, ninja [n/m] + FAILED + build stopped', () => {
  const c = run('build', 'cmake --build build', [
    '-- The C compiler identification is AppleClang 17.0.0.17000013',
    '-- Configuring done (1.2s)',
    '-- Generating done (0.1s)',
    '-- Build files have been written to: /x/build',
    '[ 25%] Building C object CMakeFiles/app.dir/src/main.c.o',
    '[ 50%] Building C object CMakeFiles/app.dir/src/util.c.o',
    "/x/src/util.c:12:5: warning: unused variable 'k' [-Wunused-variable]",
    '[ 75%] Linking C executable app',
    '[100%] Built target app',
  ]);
  assert.deepEqual(c.phases.map((p) => p.name), ['configuring', 'generating', 'generated', 'compiling', 'linking', 'built']);
  assert.equal(c.results[5].progress.frac, 0.5);
  assert.deepEqual(c.counters, { warnings: 1 });
  const n = run('build', 'ninja -C build', [
    '[1/4] Building CXX object CMakeFiles/app.dir/a.cpp.o',
    '[2/4] Building CXX object CMakeFiles/app.dir/b.cpp.o',
    'FAILED: CMakeFiles/app.dir/b.cpp.o ',
    '/usr/bin/c++ -o CMakeFiles/app.dir/b.cpp.o -c /x/b.cpp',
    "/x/b.cpp:3:5: error: use of undeclared identifier 'nope'",
    '1 error generated.',
    'ninja: build stopped: subcommand failed.',
  ]);
  assert.equal(n.p.runtime, 'ninja');
  assert.deepEqual(n.results[1].phase, { name: 'compiling', n: 2, m: 4, mSoft: false });
  assert.equal(n.results[3], null, 'the echoed compiler command keeps the n/m phase');
  assert.deepEqual(n.counters, { errors: 1, lastError: { file: '/x/b.cpp', line: 3, col: 5, msg: "use of undeclared identifier 'nope'" } });
  assert.equal(n.results[6], null, '"build stopped" after a counted diagnostic is not another error');
  const silent = run('build', 'ninja', ['[3/4] Linking CXX executable app', 'FAILED: app ', 'ninja: build stopped: subcommand failed.']);
  assert.deepEqual(silent.phase, { name: 'linking', n: 3, m: 4, mSoft: false });
  assert.deepEqual(silent.counters, { lastError: { file: null, line: null, col: null, msg: 'FAILED: app' }, errors: 1 });
  assert.equal(run('build', 'ninja', ['ninja: no work to do.']).phase.name, 'built');
});

test('ctest (documented): Test #n rows → tests n/m with Passed/Failed/Exception, "N% tests passed" report', () => {
  const s = run('build', 'ctest --test-dir build --output-on-failure', [
    'Internal ctest changing into directory: /x/build',
    'Test project /x/build',
    '    Start 1: foo',
    '1/3 Test #1: foo ..............................   Passed    0.01 sec',
    '    Start 2: bar',
    '2/3 Test #2: bar ..............................***Failed    0.02 sec',
    '    Start 3: baz',
    '3/3 Test #3: baz ..............................***Exception: SegFault  0.00 sec',
    '',
    '33% tests passed, 2 tests failed out of 3',
    '',
    'Total Test time (real) =   0.05 sec',
    '',
    'The following tests FAILED:',
    '\t  2 - bar (Failed)',
  ]);
  assert.equal(s.p.runtime, 'ctest');
  assert.deepEqual(s.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests null/null', 'tests 1/3', 'tests 2/3', 'tests 3/3', 'report null/null']);
  assert.deepEqual(s.results[5].progress, { frac: 2 / 3, iter: 2, total: 3 });
  assert.deepEqual(s.counters, { passed: 1, failed: 2, lastError: { file: null, line: null, col: null, msg: 'baz: Exception' } });
  const ok = run('build', 'ctest', ['1/2 Test #1: foo ......   Passed    0.01 sec', '2/2 Test #2: bar ......   Passed    0.01 sec', '100% tests passed, 0 tests failed out of 2']);
  assert.deepEqual(ok.counters, { passed: 2, failed: 0 });
  const half = run('build', 'ctest', ['50% tests passed, 1 tests failed out of 2']);
  assert.deepEqual(half.counters, { failed: 1, passed: 1 });
});

test('GoogleTest / Catch2 / sanitizers (documented) on a running test binary (parser key cpp → build)', () => {
  const g = run('cpp', '/x/build/app_test', [
    '[==========] Running 3 tests from 2 test suites.',
    '[----------] Global test environment set-up.',
    '[----------] 2 tests from Math',
    '[ RUN      ] Math.Adds',
    '[       OK ] Math.Adds (0 ms)',
    '[ RUN      ] Math.Subs',
    '/x/test/math_test.cpp:12: Failure',
    'Expected equality of these values:',
    '[  FAILED  ] Math.Subs (1 ms)',
    '[ RUN      ] Str.Len',
    '[  SKIPPED ] Str.Len (0 ms)',
    '[==========] 3 tests from 2 test suites ran. (5 ms total)',
    '[  PASSED  ] 1 test.',
    '[  SKIPPED ] 1 test, listed below:',
    '[  SKIPPED ] Str.Len',
    '[  FAILED  ] 1 test, listed below:',
    '[  FAILED  ] Math.Subs',
    '',
    ' 1 FAILED TEST',
  ]);
  assert.deepEqual(g.phases.map((p) => `${p.name} ${p.n}/${p.m}`), ['tests 0/3', 'tests 1/3', 'tests 2/3', 'tests 3/3', 'report null/null']);
  assert.deepEqual(g.counters, { suites: 2, passed: 1, failed: 1, skipped: 1, lastError: { file: '/x/test/math_test.cpp', line: 12, col: null, msg: 'Math.Subs' } });
  assert.equal(g.results[16], null, 'the "listed below" recap does not count again');
  assert.deepEqual(run('cpp', './app_test', ['[==========] Running 30 tests from 14 test suites.', '[  PASSED  ] 28 tests.', ' 2 FAILED TESTS']).counters, { suites: 14, passed: 28, failed: 2 });
  const c1 = run('cpp', './tests', ['All tests passed (12 assertions in 3 test cases)']);
  assert.deepEqual(c1.counters, { passed: 3, failed: 0 });
  assert.equal(c1.phase.name, 'report');
  const c2 = run('cpp', './tests', ['/x/t.cpp:9: FAILED:', '  REQUIRE( add(1, 2) == 4 )', 'test cases: 3 | 2 passed | 1 failed', 'assertions: 10 | 9 passed | 1 failed']);
  assert.deepEqual(c2.counters, { lastError: { file: '/x/t.cpp', line: 9, col: null, msg: 'FAILED' }, passed: 2, failed: 1 });
  const a = run('c', './asan', [
    '==1234==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000054 at pc 0x000104d2 bp 0x16f sp 0x16f',
    'WRITE of size 4 at 0x602000000054 thread T0',
    '    #0 0x104d2 in main asan.c:2:44',
    'SUMMARY: AddressSanitizer: heap-buffer-overflow asan.c:2:44 in main',
    '==1234==ABORTING',
  ]);
  assert.deepEqual(a.counters, { errors: 1, lastError: { file: 'asan.c', line: 2, col: 44, msg: 'AddressSanitizer: heap-buffer-overflow on address 0x602000000054 at pc 0x000104d2 bp 0x16f sp 0x16f' } });
  const u = run('c', './ub', ["ub.c:3:12: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'"]);
  assert.deepEqual(u.counters, { errors: 1, lastError: { file: 'ub.c', line: 3, col: 12, msg: "signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'" } });
});

test('idempotence: re-feeding a summary or a \\r-redrawn frame never moves a counter; lastError is compared by value', () => {
  const p = createJobParser('cargo', 'cargo test');
  p.feed('    Building [=============>               ] 1/2: demo(bin)                   ');
  assert.equal(p.feed('    Building [=============>               ] 1/2: demo(bin)                   ').phase, undefined);
  p.feed('error[E0308]: mismatched types');
  p.feed(' --> src/main.rs:1:26');
  const before = p.counters;
  assert.equal(p.feed(' --> src/main.rs:1:26'), null, 'a lone location line (no pending diagnostic) changes nothing');
  assert.deepEqual(p.counters, before);
  const j = createJobParser('node', 'npx jest');
  j.feed('Tests:       1 failed, 41 passed, 42 total');
  assert.equal(j.feed('Tests:       1 failed, 41 passed, 42 total'), null);
  const n = createJobParser('node', 'node --test');
  n.feed('ℹ pass 2');
  assert.equal(n.feed('ℹ pass 2'), null);
  // counters are additive across a multi-step ▶ run's harnesses and packages
  const g = run('go', 'go test ./...', ['ok  \ta\t0.1s', 'ok  \tb\t0.1s', 'ok  \tc\t0.1s']);
  assert.equal(g.counters.ok, 3);
});
