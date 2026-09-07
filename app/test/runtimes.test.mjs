// lib/runtimes.js — the ▶ registry's resolver, with temp project trees.
// Pure planning: nothing here spawns a run or bills anything. Toolchain
// presence is injected through the `probe` seam so the plan is asserted the
// same way on a machine without go/cmake as on one with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-runtimes-')));
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({
  alpha: { name: 'alpha', root: path.join(root, 'proj'), color: '#aabbcc', texWatch: null },
});
process.env.CP_NTFY_TOPIC = '';

const {
  RUNTIMES, runtimeForExt, resolveRunTarget, runnableExts, runLangs, toolchainStatus, hasBin,
  sessionInterpreterRows, sessionArgv0Rows, runtimesSnapshot, shQuote, ptyArgv, nodeStripsTypes, findTsx,
} = await import('../lib/runtimes.js');
const { detectScriptRun, _test: jobsTest } = await import('../lib/jobs.js');

const ALL = () => true; // every binary "installed"
let n = 0;
/** a fresh project tree: files = { 'rel/path': 'content' } → its root */
function tree(files) {
  const dir = path.join(root, `p${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
const resolve = (dir, rel, extra = {}) => resolveRunTarget({ project: 'alpha', abs: path.join(dir, rel), root: dir, probe: ALL, ...extra });
const binDir = path.join(root, 'runs', 'alpha', 'bin');

test('registry: every runtime carries the shared shape, the six originals keep their ids', () => {
  for (const [id, rt] of Object.entries(RUNTIMES)) {
    assert.equal(rt.id, id);
    assert.ok(Array.isArray(rt.exts) && rt.exts.length, `${id} exts`);
    assert.ok(['self', 'child'].includes(rt.pin), `${id} pin`);
    assert.ok(Array.isArray(rt.toolchain), `${id} toolchain`);
    assert.ok(typeof rt.file === 'function' || (rt.project && rt.project.length), `${id} has a recipe`);
  }
  assert.deepEqual(['julia', 'python', 'r', 'shell', 'sql', 'tex'].map((k) => RUNTIMES[k].id), ['julia', 'python', 'r', 'shell', 'sql', 'tex']);
  assert.equal(RUNTIMES.tex.card, false, 'tex keeps its build card — never a job');
});

test('runnableExts() includes the 16 wave-1 extensions and the six originals; ext lookup is case-tolerant', () => {
  const exts = runnableExts();
  for (const e of ['.jl', '.py', '.r', '.sh', '.sql', '.tex']) assert.ok(exts.includes(e), e);
  const fresh = ['.rs', '.go', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.c', '.cc', '.cpp', '.cxx', '.c++', '.C'];
  for (const e of fresh) assert.ok(exts.includes(e), e);
  assert.equal(new Set(exts).size, exts.length, 'deduped');
  assert.equal(runtimeForExt('.R').id, 'r');
  assert.equal(runtimeForExt('.C').id, 'cpp', 'upper-case .C is C++');
  assert.equal(runtimeForExt('.c').id, 'c');
  assert.equal(runtimeForExt('.TS').id, 'node');
  assert.equal(runtimeForExt('.csv'), null);
  // jobs.js's RUN_LANGS: the original rows byte-identical, tex absent
  const langs = runLangs();
  assert.deepEqual(
    Object.fromEntries(Object.entries(langs).filter(([k]) => ['.jl', '.r', '.py', '.sh', '.sql'].includes(k))),
    { '.jl': 'julia', '.r': 'r', '.py': 'python', '.sh': 'shell', '.sql': 'sql' });
  assert.equal(langs['.tex'], undefined);
  assert.equal(langs['.rs'], 'rust');
  assert.equal(langs['.c'], 'c');
  assert.equal(langs['.cpp'], 'cpp');
});

test('Cargo.toml above a .rs → cargo run at the crate root (nearest marker, cwd = crate)', () => {
  const dir = tree({
    'crates/hello/Cargo.toml': '[package]\nname="hello"\nversion="0.1.0"\n',
    'crates/hello/src/bin/tool.rs': 'fn main(){}',
  });
  const r = resolve(dir, 'crates/hello/src/bin/tool.rs');
  assert.equal(r.error, undefined);
  assert.equal(r.runtime, 'rust');
  assert.equal(r.mode, 'run');
  assert.equal(r.steps.length, 1);
  assert.deepEqual([r.steps[0].cmd, r.steps[0].args], ['cargo', ['run', '--bin', 'tool']]);
  assert.equal(r.steps[0].cwd, path.join(dir, 'crates/hello'));
  assert.equal(r.projectRoot, path.join(dir, 'crates/hello'));
  assert.deepEqual(r.phases, ['compiling']);
  assert.equal(r.steps[0].parser, 'cargo');
  assert.equal(r.steps[0].env.CARGO_TERM_PROGRESS_WHEN, 'always');
  assert.equal(r.steps[0].env.CARGO_TERM_COLOR, 'never');
  assert.equal(r.display, 'cargo run --bin tool');
  assert.equal(r.pin, 'self');
  assert.equal(r.card, true);
});

test('Cargo.toml + mode test → cargo test; a tests/ file picks test mode on its own', () => {
  const dir = tree({ 'Cargo.toml': '[package]\n', 'src/main.rs': '', 'tests/it.rs': '' });
  const t = resolve(dir, 'src/main.rs', { mode: 'test' });
  assert.deepEqual([t.steps[0].cmd, t.steps[0].args], ['cargo', ['test']]);
  assert.equal(t.mode, 'test');
  const auto = resolve(dir, 'tests/it.rs');
  assert.equal(auto.mode, 'test', 'tests/ matches testFile');
  assert.match(auto.note, /test file — running in test mode/);
  const forced = resolve(dir, 'tests/it.rs', { mode: 'run' });
  assert.equal(forced.mode, 'run', 'an explicit mode wins over the file-name rule');
});

test('.rs alone → rustc two-step with the binary under <ROOT>/runs/<project>/bin, never in the project', () => {
  const dir = tree({ 'hello.rs': 'fn main(){}' });
  const r = resolve(dir, 'hello.rs');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.phases, ['compiling', 'running']);
  const [c, run] = r.steps;
  assert.equal(c.cmd, 'rustc');
  const out = path.join(binDir, 'hello');
  assert.deepEqual(c.args, ['-o', out, path.join(dir, 'hello.rs')]);
  assert.equal(c.parser, 'rust');
  assert.equal(run.cmd, out);
  assert.equal(run.built, true);
  assert.equal(run.parser, null);
  assert.equal(run.pty, false, 'rust flushes fine when piped — no pty');
  assert.ok(fs.existsSync(binDir), 'bin dir created');
  assert.ok(!out.startsWith(dir), 'compiled output lives outside the user project');
  assert.equal(r.display, 'rustc -o ./hello hello.rs && ./hello');
  assert.equal(r.projectRoot, null);
  // _test.rs alone → rustc --test then run the harness
  const t = resolve(tree({ 'x_test.rs': '' }), 'x_test.rs');
  assert.equal(t.mode, 'test');
  assert.deepEqual(t.steps[0].args.slice(0, 2), ['--test', '-o']);
  assert.equal(t.phases[1], 'tests');
});

test('go.mod → go run . from the file\'s dir for package main, go run <file> otherwise; _test.go → go test ./... at the module root', () => {
  const dir = tree({
    'go.mod': 'module example.com/x\n',
    'cmd/tool/main.go': 'package main\nfunc main(){}\n',
    'pkg/lib/lib.go': 'package lib\n',
    'pkg/lib/lib_test.go': 'package lib\n',
  });
  const main = resolve(dir, 'cmd/tool/main.go');
  assert.equal(main.runtime, 'go');
  assert.deepEqual([main.steps[0].cmd, main.steps[0].args, main.steps[0].cwd], ['go', ['run', '.'], path.join(dir, 'cmd/tool')]);
  assert.equal(main.pin, 'child', 'go run spawns the exe under $TMPDIR/go-build*');
  assert.ok(main.argv0.test('/var/folders/zz/T/go-build123/b001/exe/tool'));
  assert.ok(main.argv0.test('/x/pkg/lib.test'));
  assert.deepEqual(main.phases, ['compiling']);
  const lib = resolve(dir, 'pkg/lib/lib.go');
  assert.deepEqual(lib.steps[0].args, ['run', path.join(dir, 'pkg/lib/lib.go')]);
  const t = resolve(dir, 'pkg/lib/lib_test.go');
  assert.equal(t.mode, 'test');
  assert.deepEqual([t.steps[0].args, t.steps[0].cwd], [['test', './...'], dir]);
  assert.deepEqual(t.phases, ['tests']);
  assert.equal(t.steps[0].parser, 'go');
  // no go.mod: go run <file>
  const lone = resolve(tree({ 'a.go': 'package main\n' }), 'a.go');
  assert.equal(lone.steps[0].args[0], 'run');
  assert.equal(lone.projectRoot, null);
});

test('package.json: scripts.start → npm run start (pin child); scripts.test + a test file → npm test; no scripts → node <file>', () => {
  const dir = tree({
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'node server.js', test: 'node --test' } }),
    'server.js': '',
    'src/thing.test.js': '',
    'lib/x.js': '',
  });
  const start = resolve(dir, 'lib/x.js');
  assert.equal(start.runtime, 'node');
  assert.deepEqual([start.steps[0].cmd, start.steps[0].args, start.steps[0].cwd], ['npm', ['run', 'start'], dir]);
  assert.equal(start.pin, 'child', 'npm → sh → node: pin the node child');
  assert.ok(start.argv0.test('/opt/homebrew/bin/node'));
  assert.match(start.note, /start script/);
  assert.equal(start.projectRoot, dir);
  const t = resolve(dir, 'src/thing.test.js');
  assert.equal(t.mode, 'test');
  assert.deepEqual([t.steps[0].cmd, t.steps[0].args], ['npm', ['test']]);
  assert.deepEqual(t.phases, ['tests']);
  const bare = tree({ 'package.json': '{"name":"bare"}', 'run.js': '' });
  const b = resolve(bare, 'run.js');
  assert.deepEqual([b.steps[0].cmd, b.steps[0].args], ['node', [path.join(bare, 'run.js')]]);
  assert.equal(b.pin, 'self');
  // test mode without a test script: node --test <file>
  const bt = resolve(bare, 'run.js', { mode: 'test' });
  assert.deepEqual(bt.steps[0].args, ['--test', path.join(bare, 'run.js')]);
});

test('all TS/JSX uses an installed tsx executable, never native stripping or npx downloads', () => {
  const dir = tree({ 'a.ts': '', 'b.tsx': '', 'c.jsx': '', 'd.mts': '' });
  assert.equal(nodeStripsTypes('v25.6.1'), true);
  assert.equal(nodeStripsTypes('22.18.0'), true);
  assert.equal(nodeStripsTypes('22.17.9'), false);
  assert.equal(nodeStripsTypes('23.5.0'), false);
  assert.equal(nodeStripsTypes('23.6.0'), true);
  assert.equal(nodeStripsTypes('20.11.0'), false);
  for (const version of ['20.11.0', '25.6.1', '26.0.0']) {
    for (const f of ['a.ts', 'b.tsx', 'c.jsx', 'd.mts']) {
      const r = resolve(dir, f, { nodeVersion: version, tsxBinary: '/fixture/tsx' });
      assert.deepEqual([r.steps[0].cmd, r.steps[0].args], ['/fixture/tsx', [path.join(dir, f)]]);
      assert.equal(r.pin, 'child');
    }
  }
  assert.match(resolve(dir, 'a.ts', { tsxBinary: null }).error, /requires installed tsx/);
  assert.deepEqual(resolve(dir, 'a.ts', { mode: 'test', tsxBinary: '/fixture/tsx' }).steps[0].args,
    ['--test', path.join(dir, 'a.ts')]);
});

test('tsx resolution chooses nearest project installation, then PATH, then dashboard bundle', () => {
  const dir = tree({ 'src/a.ts': '', 'node_modules/.bin/tsx': '', 'src/node_modules/.bin/tsx': '', 'dashboard/node_modules/.bin/tsx': '' });
  for (const rel of ['node_modules/.bin/tsx', 'src/node_modules/.bin/tsx', 'dashboard/node_modules/.bin/tsx']) fs.chmodSync(path.join(dir, rel), 0o755);
  assert.equal(findTsx({ dir: path.join(dir, 'src'), root: dir, which: () => '/path/tsx' }), path.join(dir, 'src/node_modules/.bin/tsx'));
  assert.equal(findTsx({ dir, root: dir, which: () => '/path/tsx' }), path.join(dir, 'node_modules/.bin/tsx'));
  assert.equal(findTsx({ which: () => '/path/tsx', appDir: path.join(dir, 'dashboard') }), '/path/tsx');
  assert.equal(findTsx({ which: () => null, appDir: path.join(dir, 'dashboard') }), path.join(dir, 'dashboard/node_modules/.bin/tsx'));
});

test('selected conventional Cargo binaries override default-run; uncertain targets refuse', () => {
  const dir = tree({ 'Cargo.toml': '[package]\nname="crate"\ndefault-run="other"\n', 'src/bin/tool.rs': '', 'src/bin/nested/main.rs': '', 'src/bin/nested/helper.rs': '' });
  assert.deepEqual(resolve(dir, 'src/bin/tool.rs').steps[0].args, ['run', '--bin', 'tool']);
  assert.deepEqual(resolve(dir, 'src/bin/nested/main.rs').steps[0].args, ['run', '--bin', 'nested']);
  assert.match(resolve(dir, 'src/bin/nested/helper.rs').error, /explicit binary target choice/);
  for (const manifest of [
    '[package]\nname="crate"\n[[bin]]\nname="renamed"\npath="src/bin/tool.rs"',
    'bin = [{ name="tool", path="src/main.rs" }]\n[package]\nname="crate"',
    '[["b\\u0069n"]]\nname="tool"\npath="src/main.rs"\n[package]\nname="crate"',
    '[package]\nname="crate"\nautobins=false',
  ]) {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), manifest + '\n');
    assert.match(resolve(dir, 'src/bin/tool.rs').error, /explicit binary target choice/);
  }
});

test('.c alone → cc two-step, the binary under a pty; .cpp/.cc/.C → c++', () => {
  const dir = tree({ 'hello.c': '', 'w.cpp': '', 'v.cc': '', 'u.C': '' });
  const c = resolve(dir, 'hello.c');
  assert.equal(c.runtime, 'c');
  assert.deepEqual(c.phases, ['compiling', 'running']);
  const out = path.join(binDir, 'hello');
  assert.deepEqual([c.steps[0].cmd, c.steps[0].args], ['cc', ['-Wall', '-O0', '-g', path.join(dir, 'hello.c'), '-o', out]]);
  assert.equal(c.steps[0].parser, 'build');
  assert.equal(c.steps[1].cmd, out);
  assert.equal(c.steps[1].pty, true, 'C stdio block-buffers when piped → pty');
  assert.equal(c.steps[1].parser, null);
  assert.equal(c.buffered, true);
  assert.equal(c.display, 'cc -Wall -O0 -g hello.c -o ./hello && ./hello');
  for (const f of ['w.cpp', 'v.cc', 'u.C']) {
    const r = resolve(dir, f);
    assert.equal(r.runtime, 'cpp', f);
    assert.equal(r.steps[0].cmd, 'c++', f);
    assert.equal(r.steps[1].pty, true);
  }
});

test('Makefile → make in that dir, then ./<basename> decided after the build (deferred step)', () => {
  const dir = tree({ 'src/Makefile': 'prog: prog.c\n\tcc -o prog prog.c\n\ntest:\n\t./prog\n', 'src/prog.c': '' });
  const r = resolve(dir, 'src/prog.c');
  assert.equal(r.projectRoot, path.join(dir, 'src'));
  assert.deepEqual(r.phases, ['building', 'running']);
  assert.deepEqual([r.steps[0].cmd, r.steps[0].args, r.steps[0].cwd], ['make', [], path.join(dir, 'src')]);
  assert.equal(r.steps[0].parser, 'build');
  assert.equal(typeof r.steps[1].deferred, 'function');
  assert.equal(r.steps[1].pty, true);
  assert.equal(r.display, 'make && ./prog');
  // before make ran there is nothing to run → skip with a note
  assert.match(r.steps[1].deferred().skip, /no \.\/prog/);
  // once the build produced ./prog the deferred step resolves to it
  fs.writeFileSync(path.join(dir, 'src/prog'), '#!/bin/sh\n', { mode: 0o755 });
  const got = r.steps[1].deferred();
  assert.deepEqual([got.cmd, got.cwd, got.display], [path.join(dir, 'src/prog'), path.join(dir, 'src'), './prog']);
  // test mode uses the Makefile's test target
  const t = resolve(dir, 'src/prog.c', { mode: 'test' });
  assert.deepEqual([t.steps[0].cmd, t.steps[0].args], ['make', ['test']]);
  const noTarget = resolve(tree({ 'Makefile': 'all:\n\ttrue\n', 'a.c': '' }), 'a.c', { mode: 'test' });
  assert.match(noTarget.error, /no test target/);
});

test('CMakeLists.txt → configure + build + the single produced executable, only when cmake is installed; else it falls through', () => {
  const dir = tree({ 'CMakeLists.txt': 'project(x)\n', 'src/main.cpp': '', 'src/Makefile': 'all:\n\ttrue\n' });
  const withCmake = resolve(dir, 'src/main.cpp', { probe: ALL });
  // nearest level first: src/Makefile sits closer than the top-level CMakeLists
  assert.equal(withCmake.steps[0].cmd, 'make', 'the nearer Makefile wins');
  const top = tree({ 'CMakeLists.txt': 'project(x)\n', 'src/main.cpp': '' });
  const cm = resolve(top, 'src/main.cpp', { probe: ALL });
  assert.deepEqual(cm.phases, ['configuring', 'building', 'running']);
  assert.deepEqual(cm.steps[0].args, ['-S', top, '-B', path.join(top, 'build')]);
  assert.deepEqual(cm.steps[1].args, ['--build', path.join(top, 'build')]);
  assert.equal(typeof cm.steps[2].deferred, 'function');
  assert.match(cm.steps[2].deferred().skip, /no single executable/);
  fs.mkdirSync(path.join(top, 'build'), { recursive: true });
  fs.writeFileSync(path.join(top, 'build/app'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(top, 'build/CMakeCache.txt'), '');
  assert.equal(cm.steps[2].deferred().cmd, path.join(top, 'build/app'));
  fs.writeFileSync(path.join(top, 'build/other'), '#!/bin/sh\n', { mode: 0o755 });
  assert.match(cm.steps[2].deferred().skip, /no single executable/, 'two candidates → stop at built');
  assert.equal(cm.display, 'cmake -S . -B build && cmake --build build && <built executable>');
  const t = resolve(top, 'src/main.cpp', { probe: ALL, mode: 'test' });
  assert.equal(t.steps[2].cmd, 'ctest');
  // no cmake on this PATH → the CMake marker is skipped → single-file c++ recipe
  const without = resolve(top, 'src/main.cpp', { probe: (b) => b !== 'cmake' });
  assert.equal(without.steps[0].cmd, 'c++');
  assert.deepEqual(without.phases, ['compiling', 'running']);
});

test('markers are never searched above the project root', () => {
  const outer = tree({ 'Cargo.toml': '[package]\n', 'inner/main.rs': 'fn main(){}', 'package.json': '{"scripts":{"start":"x"}}', 'inner/a.js': '' });
  const inner = path.join(outer, 'inner');
  const rs = resolveRunTarget({ project: 'alpha', abs: path.join(inner, 'main.rs'), root: inner, probe: ALL });
  assert.equal(rs.steps[0].cmd, 'rustc', 'the Cargo.toml above root is invisible');
  const js = resolveRunTarget({ project: 'alpha', abs: path.join(inner, 'a.js'), root: inner, probe: ALL });
  assert.equal(js.steps[0].cmd, 'node');
  const escaped = resolveRunTarget({ project: 'alpha', abs: path.join(outer, 'main.rs'), root: inner, probe: ALL });
  assert.match(escaped.error, /outside the project root/);
});

test('a missing toolchain answers before spawning; unknown extensions and modes are refused', () => {
  const dir = tree({ 'h.rs': '', 'h.go': '', 'h.c': '', 'data.csv': '' });
  assert.equal(resolve(dir, 'h.rs', { probe: (b) => b !== 'rustc' }).error, 'rustc not found on the server PATH');
  assert.equal(resolve(dir, 'h.go', { probe: () => false }).error, 'go not found on the server PATH');
  assert.equal(resolve(dir, 'h.c', { probe: (b) => b !== 'cc' }).error, 'cc not found on the server PATH');
  assert.equal(resolve(dir, 'data.csv').error, "don't know how to run .csv");
  assert.match(resolve(dir, 'h.rs', { mode: 'bench' }).error, /unknown mode/);
  assert.match(resolve(dir, 'h.c', { mode: 'test' }).error, /no test mode/);
  // the real PATH lookup: a binary every mac/linux has, and one nobody has
  assert.equal(hasBin('sh'), true);
  assert.equal(hasBin('definitely-not-a-binary-xyz'), false);
  if (!hasBin('go')) assert.equal(resolve(dir, 'h.go', { probe: undefined }).error, 'go not found on the server PATH');
});

test('the six original recipes are unchanged: julia --project discovery, python venv + PYTHONUNBUFFERED, R wrapper, bash + cargo env, duckdb shim, latexmk', () => {
  const dir = tree({
    'Project.toml': 'name = "x"\n', 'src/a.jl': '', 'sub/b.py': '', 'c.R': '', 'd.sh': '', 'e.sql': '', 'f.tex': '',
  });
  const jl = resolve(dir, 'src/a.jl');
  assert.deepEqual([jl.steps[0].cmd, jl.steps[0].args], ['julia', [`--project=${dir}`, path.join(dir, 'src/a.jl')]]);
  assert.equal(jl.display, 'julia --project=…/' + path.basename(dir) + ' a.jl');
  const jlBare = resolve(tree({ 'a.jl': '' }), 'a.jl');
  assert.deepEqual(jlBare.steps[0].args.length, 1);
  assert.match(jlBare.note, /global environment/);

  const py = resolve(dir, 'sub/b.py');
  assert.equal(py.steps[0].cmd, 'python3');
  assert.equal(py.steps[0].env.PYTHONUNBUFFERED, '1');
  assert.match(py.note, /python3 from PATH/);
  assert.equal(py.bufferedWithoutEnv, 'PYTHONUNBUFFERED');
  const venvDir = tree({ 'x.py': '' });
  fs.mkdirSync(path.join(venvDir, '.venv/bin'), { recursive: true });
  fs.writeFileSync(path.join(venvDir, '.venv/bin/python'), '#!/bin/sh\n', { mode: 0o755 });
  const pv = resolve(venvDir, 'x.py');
  assert.equal(pv.steps[0].cmd, path.join(venvDir, '.venv/bin/python'));
  assert.equal(pv.note, null);

  const r = resolve(dir, 'c.R');
  assert.equal(r.runtime, 'r');
  assert.equal(r.steps[0].cmd, 'Rscript');
  assert.equal(r.steps[0].args[0], '--no-save');
  assert.equal(r.steps[0].env.PM_RUN_FILE, path.join(dir, 'c.R'));
  assert.equal(r.display, 'Rscript c.R');

  const sh = resolve(dir, 'd.sh');
  assert.deepEqual([sh.steps[0].cmd, sh.steps[0].env.CARGO_TERM_PROGRESS_WIDTH], ['bash', '80']);
  assert.equal(sh.display, 'bash d.sh');

  const sql = resolve(dir, 'e.sql');
  assert.equal(sql.steps[0].args[0], '-c');
  assert.match(sql.steps[0].args[1], /import duckdb/);
  assert.equal(sql.display, 'duckdb e.sql');
  assert.match(sql.note, /in-memory/);

  const tex = resolve(dir, 'f.tex');
  assert.equal(tex.steps[0].cmd, 'latexmk');
  assert.equal(tex.tex, path.join(dir, 'f.tex'));
  assert.equal(tex.card, false);
  assert.equal(tex.steps[0].env.max_print_line, '2000');
});

test('toolchainStatus(): one row per runtime, never throws, reflects this PATH; the snapshot carries exts/byExt/toolchains', () => {
  const st = toolchainStatus();
  for (const id of Object.keys(RUNTIMES)) {
    assert.ok(st[id], id);
    assert.equal(typeof st[id].ok, 'boolean');
    assert.ok(Array.isArray(st[id].missing));
    assert.equal(typeof st[id].bins, 'object');
  }
  assert.equal(st.shell.ok, true, 'bash is everywhere');
  assert.equal(st.go.ok, hasBin('go'));
  if (!hasBin('go')) assert.deepEqual(st.go.missing, ['go']);
  assert.equal(st.c.bins.cmake.optional, true);
  const snap = runtimesSnapshot();
  assert.deepEqual(snap.exts, runnableExts());
  assert.deepEqual(snap.byExt['.rs'], { id: 'rust', label: 'Rust', pin: 'self', buffered: false });
  assert.equal(snap.byExt['.C'].id, 'cpp');
  assert.equal(snap.toolchains.rust.ok, st.rust.ok);
});

test('pty argv: script -q /dev/null on darwin, script -qec on linux; shQuote is POSIX-safe', () => {
  assert.equal(shQuote("it's"), "'it'\\''s'");
  const w = ptyArgv('/x/bin/prog', ['a b', "c'd"]);
  if (!hasBin('script')) { assert.equal(w, null); return; }
  assert.equal(w.cmd, 'script');
  if (process.platform === 'darwin') assert.deepEqual(w.args, ['-q', '/dev/null', '/x/bin/prog', 'a b', "c'd"]);
  else assert.deepEqual(w.args, ['-qec', "'/x/bin/prog' 'a b' 'c'\\''d'", '/dev/null']);
});

test('jobs.js consumes the registry: keyed interpreter table, session rows + argv0 for the new runtimes, findChildPid pins the deepest match', () => {
  const rows = sessionInterpreterRows();
  assert.deepEqual(Object.keys(rows).sort(), ['c', 'cpp', 'go', 'node', 'rust']);
  assert.deepEqual(Object.keys(sessionArgv0Rows()).sort(), ['c', 'cpp', 'go', 'node', 'rust']);
  const { INTERPRETERS, INTERP_ARGV0, RUN_LANGS } = jobsTest;
  assert.equal(INTERPRETERS.python.lang, 'python', 'keyed, not positional');
  assert.equal(INTERPRETERS.rust.lang, 'rust');
  assert.ok(INTERP_ARGV0.julia instanceof RegExp);
  assert.ok(INTERP_ARGV0.go.test('/tmp/go-build42/b001/exe/hello'));
  assert.ok(INTERP_ARGV0.node.test('/usr/local/bin/node'));
  assert.ok(INTERP_ARGV0.rust.test('target/debug/hello'));
  assert.equal(RUN_LANGS['.rs'], 'rust');
  // detection of file-bearing commands for the new runtimes (file-less
  // `cargo run` / `npm test` cards are the session-cards agent's phase-2 work)
  assert.deepEqual(detectScriptRun('rustc -O main.rs'), { lang: 'rust', file: 'main.rs', detached: false, inline: false });
  assert.equal(detectScriptRun('go run ./cmd/tool/main.go').lang, 'go');
  assert.equal(detectScriptRun('node --test src/a.test.mjs').lang, 'node');
  assert.equal(detectScriptRun('cc -Wall -o app app.c').lang, 'c');
  assert.equal(detectScriptRun('c++ -std=c++20 main.cpp -o main').lang, 'cpp');
  assert.equal(detectScriptRun('python3 train.py').lang, 'python', 'python still detected after the re-keying');
  assert.equal(detectScriptRun('python3.12 train.py').lang, 'python');
  // findChildPid: launcher 100 → sh 101 → node 102 (deepest match wins; claimed pids skipped)
  const at = 1_000_000;
  const snap = jobsTest.parsePs([
    `100     1  0.0  1000 00:05 00:00.10 S ?? npm run start`,
    `101   100  0.0  1000 00:05 00:00.10 S ?? sh -c node server.js`,
    `102   101  9.0 50000 00:05 00:00.90 R ?? node server.js`,
    `200     1  0.0  1000 00:05 00:00.10 S ?? node other.js`,
  ].join('\n') + '\n', at);
  assert.equal(jobsTest.findChildPid(snap, 100, /(^|\/)node$/, new Set()), 102);
  assert.equal(jobsTest.findChildPid(snap, 100, /(^|\/)node$/, new Set([102])), null, 'claimed pids are skipped');
  assert.equal(jobsTest.findChildPid(snap, 100, /(^|\/)go$/, new Set()), null);
});
