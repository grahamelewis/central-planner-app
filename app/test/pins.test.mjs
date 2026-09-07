// test/pins.test.mjs — pinKind() string classification, pinCard()'s
// stat-derived kind (a folder pin stored without its trailing slash must still
// be recognized as a folder via st.isDirectory(), not misread as code), the
// manifest cards (Cargo.toml / package.json / go.mod / CMakeLists.txt /
// Makefile), the folder map's build-dir ignores, and the server/client
// pin-kind lists staying one list.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp } from './helpers.mjs';
import { PROJECTS, DEFAULT_IGNORE_DIRS, ARTIFACT_GLOBS, isIgnoredDir } from '../lib/config.js';
import { pinKind, pinCard, DATA_EXTS, MANIFEST_NAMES } from '../lib/pins.js';
import * as pinkinds from '../public/pinkinds.js';

describe('pinKind (string classification)', () => {
  test('trailing slash => folder', () => {
    assert.equal(pinKind('some/dir/'), 'folder');
    assert.equal(pinKind('a/b/c.csv/'), 'folder', 'trailing slash wins over ext');
  });

  test('data extensions => data', () => {
    for (const ext of DATA_EXTS) assert.equal(pinKind(`f.${ext}`), 'data', ext);
    assert.equal(pinKind('DATA.CSV'), 'data', 'case-insensitive');
  });

  test('code/text extensions => code', () => {
    for (const f of ['main.py', 'a.R', 'notes.md', 'x.tex', 'noext', 'script.sh']) {
      assert.equal(pinKind(f), 'code', f);
    }
  });

  test('project manifests => manifest (exact basename, anywhere in the tree)', () => {
    for (const name of Object.keys(MANIFEST_NAMES)) {
      assert.equal(pinKind(name), 'manifest', name);
      assert.equal(pinKind(`crates/core/${name}`), 'manifest', `nested ${name}`);
    }
    // near-misses stay code: lockfiles, backups, other toml/json
    for (const f of ['package-lock.json', 'Cargo.lock', 'Cargo.toml.bak', 'pyproject.toml', 'tsconfig.json', 'go.sum', 'cmakelists.txt', 'Makefile.am']) {
      assert.equal(pinKind(f), 'code', f);
    }
    assert.equal(pinKind('Cargo.toml/'), 'folder', 'trailing slash still wins');
  });

  test('handles empty / non-string input', () => {
    assert.equal(pinKind(''), 'code');
    assert.equal(pinKind(null), 'code');
    assert.equal(pinKind(undefined), 'code');
  });
});

describe('pinCard (stat-derived kind)', () => {
  const KEY = '__pins_test__';
  let root;

  before(() => {
    root = fs.realpathSync(mkTmp('cp-pins-'));
    fs.mkdirSync(path.join(root, 'mydir'));
    fs.writeFileSync(path.join(root, 'mydir', 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'mydir', 'b.txt'), 'b');
    fs.writeFileSync(path.join(root, 'data.csv'), 'x,y\n1,2\n3,4\n');
    fs.writeFileSync(path.join(root, 'script.py'), 'print(1)\n');
    PROJECTS[KEY] = { name: 'pins-test', root };
  });

  after(() => { delete PROJECTS[KEY]; rmTmp(root); });

  test('a directory pin WITH trailing slash yields a folder card', async () => {
    const r = await pinCard(KEY, 'mydir/');
    assert.equal(r.kind, 'folder');
    assert.match(r.card, /folder map of mydir/);
    assert.match(r.card, /a\.txt/);
  });

  test('a directory pin WITHOUT trailing slash is still a folder (stat wins)', async () => {
    // Regression guard: the dashboard strips trailing slashes; a suffix-only
    // check would misread this as 'code' and refuse the card.
    const r = await pinCard(KEY, 'mydir');
    assert.equal(r.kind, 'folder');
    assert.match(r.card, /folder map of mydir/);
  });

  test('a csv file yields a data card with schema + sample', async () => {
    const r = await pinCard(KEY, 'data.csv');
    assert.equal(r.kind, 'data');
    assert.match(r.card, /format: csv/);
    assert.match(r.card, /columns/);
    assert.match(r.card, /\bx\b/);
  });

  test('a code file has no card (the session reads it directly)', async () => {
    const r = await pinCard(KEY, 'script.py');
    assert.ok(r.error, 'should be an error result');
    assert.match(r.error, /code pins have no card/);
  });

  test('a missing / out-of-root path returns an error, never throws', async () => {
    const r = await pinCard(KEY, '../escape.csv');
    assert.ok(r.error);
    assert.match(r.error, /not found or outside the project/);
  });

  test('an unknown project returns an error', async () => {
    const r = await pinCard('no-such-project', 'data.csv');
    assert.ok(r.error);
  });
});

// ---------------------------------------------------------------------------
// Manifest cards — one per format, node-only parsing, ≤ 40 lines
// ---------------------------------------------------------------------------
describe('pinCard (manifest cards)', () => {
  const KEY = '__pins_manifest_test__';
  let root;
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const lineCount = (card) => card.split('\n').length;

  before(() => {
    root = fs.realpathSync(mkTmp('cp-pins-manifest-'));
    PROJECTS[KEY] = { name: 'pins-manifest-test', root };
    w('rs/Cargo.toml', [
      '[package]', 'name = "sim-engine"', 'version = "0.3.1"', 'edition = "2021"', 'rust-version = "1.75"',
      'description = "Monte-Carlo engine"', '',
      '[lib]', 'name = "simengine"', '',
      '[[bin]]', 'name = "sim"', 'path = "src/main.rs"', '', '[[bin]]', 'name = "sim-bench"', '',
      '[dependencies]', 'serde = { version = "1", features = ["derive"] }', 'rand = "0.8"',
      'tokio = { version = "1", features = [', '  "rt-multi-thread",', '  "macros",', '] }', 'anyhow = "1"', '',
      '[dependencies.clap]', 'version = "4"', '',
      "[target.'cfg(unix)'.dependencies]", 'libc = "0.2"', '',
      '[dev-dependencies]', 'criterion = "0.5"', 'proptest = "1"', '',
      '[build-dependencies]', 'cc = "1"', '',
      '[features]', 'default = ["fast"]', 'fast = []', '',
    ].join('\n'));
    w('ws/Cargo.toml', [
      '[workspace]', 'resolver = "2"', 'members = [', '  "crates/core",', '  "crates/cli", # the binary', '  "tools/*",', ']',
      'exclude = ["old"]', '', '[workspace.package]', 'version = "1.2.0"', 'edition = "2021"', '',
      '[workspace.dependencies]', 'serde = "1"', 'thiserror = "1"', '',
    ].join('\n'));
    // auto-discovered targets: no [lib]/[[bin]] but src/main.rs on disk
    w('auto/Cargo.toml', '[package]\nname = "tiny"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
    w('auto/src/main.rs', 'fn main() {}\n');
    const scripts = Object.fromEntries([
      ['start', 'node server.js'], ['test', 'node --test test/*.test.mjs'],
      ...Array.from({ length: 18 }, (_, i) => [`s${i}`, `node scripts/${i}.js --flag`]),
    ]);
    w('package.json', JSON.stringify({
      name: '@lab/dash', version: '2.0.0', type: 'module', private: true, engines: { node: '>=20' },
      main: 'src/index.js', bin: { dash: 'bin/dash.js' }, scripts,
      dependencies: { express: '^4', ws: '^8' }, devDependencies: { typescript: '^5' }, workspaces: ['packages/*'],
    }, null, 2));
    w('broken/package.json', '{ "name": "oops", ');
    w('go/go.mod', [
      'module github.com/lab/sim', '', 'go 1.22', '', 'toolchain go1.22.3', '',
      'require (', '\tgithub.com/spf13/cobra v1.8.0', '\tgolang.org/x/sync v0.7.0',
      '\tgithub.com/inconshreveable/mousetrap v1.1.0 // indirect', ')', '',
      'require gonum.org/v1/gonum v0.15.0', '', 'replace golang.org/x/sync => ../sync', '',
    ].join('\n'));
    w('cm/CMakeLists.txt', [
      'cmake_minimum_required(VERSION 3.16)', 'project(SimEngine VERSION 0.4.2 LANGUAGES C CXX) # main project',
      'set(CMAKE_CXX_STANDARD 17)', 'find_package(Threads REQUIRED)', 'find_package(Eigen3 3.4)',
      'add_library(simcore STATIC src/core.cpp src/rng.cpp)', 'add_library(simplugins SHARED', '  src/plugins.cpp)',
      'add_executable(sim src/main.cpp)', 'add_executable(sim_tests tests/main.cpp)',
      'add_subdirectory(third_party/fmt)', 'enable_testing()', 'add_test(NAME unit COMMAND sim_tests)', '',
    ].join('\n'));
    w('mk/Makefile', [
      '# build the paper and the sims', 'CC := cc', 'CFLAGS ?= -O2 -Wall', 'OBJS = a.o b.o',
      '.PHONY: all clean test \\', '\tpaper', '', 'all: sim paper', '', 'sim: $(OBJS)', '\t$(CC) $(CFLAGS) -o $@ $^', '',
      '%.o: %.c', '\t$(CC) -c $<', '', 'paper: paper.pdf', 'paper.pdf: paper.tex', '\tlatexmk -pdf paper.tex', '',
      '$(OBJS): common.h', '', 'test check: sim', '\t./sim --self-test', '', 'clean::', '\trm -f sim *.o', '',
    ].join('\n'));
    // a manifest the server must not choke on: 60 [[bin]] tables → capped output
    w('big/Cargo.toml', '[package]\nname = "big"\nversion = "1.0.0"\n' + Array.from({ length: 60 }, (_, i) => `[[bin]]\nname = "b${i}"\n`).join('')
      + '[dependencies]\n' + Array.from({ length: 40 }, (_, i) => `dep${i} = "1"\n`).join(''));
  });

  after(() => { delete PROJECTS[KEY]; rmTmp(root); });

  test('Cargo.toml → package, deps (table/target forms too), dev/build deps, targets, features', async () => {
    const r = await pinCard(KEY, 'rs/Cargo.toml');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /^manifest: Cargo\.toml \(Rust · cargo\)/);
    assert.match(r.card, /package: sim-engine v0\.3\.1 · edition 2021 · rust ≥ 1\.75/);
    assert.match(r.card, /dependencies: 6 — serde, rand, tokio, anyhow, clap, libc/);
    assert.match(r.card, /dev-dependencies: 2 — criterion, proptest/);
    assert.match(r.card, /build-dependencies: 1 — cc/);
    assert.match(r.card, /targets: lib simengine · bin sim, sim-bench/);
    assert.match(r.card, /features: 2 — default, fast/);
    assert.doesNotMatch(r.card, /rt-multi-thread/, 'multi-line arrays are consumed, not misread as keys');
    assert.ok(lineCount(r.card) <= 40);
  });

  test('workspace Cargo.toml → members, workspace deps, workspace.package', async () => {
    const r = await pinCard(KEY, 'ws/Cargo.toml');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /package: \(none — workspace root\)/);
    assert.match(r.card, /workspace: 3 members — crates\/core, crates\/cli, tools\/\* · excludes 1/);
    assert.match(r.card, /workspace\.dependencies: 2 — serde, thiserror/);
    assert.match(r.card, /workspace\.package: v1\.2\.0 · edition 2021/);
  });

  test('Cargo.toml without explicit targets reports cargo auto-discovery from disk', async () => {
    const r = await pinCard(KEY, 'auto/Cargo.toml');
    assert.match(r.card, /package: tiny v0\.1\.0/);
    assert.match(r.card, /targets: bin src\/main\.rs/);
    assert.match(r.card, /dependencies: 0/);
  });

  test('package.json → name/type/engines/entry, first 15 scripts + truncation, dep counts, workspaces', async () => {
    const r = await pinCard(KEY, 'package.json');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /^manifest: package\.json \(Node · npm\)/);
    assert.match(r.card, /package: @lab\/dash v2\.0\.0 · type module · private/);
    assert.match(r.card, /engines: node >=20/);
    assert.match(r.card, /entry: main src\/index\.js · bin dash/);
    assert.match(r.card, /scripts: 20/);
    assert.match(r.card, /  start → node server\.js/);
    assert.match(r.card, /  test → node --test test\/\*\.test\.mjs/);
    assert.equal((r.card.match(/^ {2}\S+ → /gm) || []).length, 15, 'exactly 15 script rows');
    assert.match(r.card, /… \(\+5 more scripts\)/);
    assert.match(r.card, /dependencies: 2 — express, ws/);
    assert.match(r.card, /devDependencies: 1 — typescript/);
    assert.match(r.card, /workspaces: 1 — packages\/\*/);
    assert.ok(lineCount(r.card) <= 40);
  });

  test('a malformed package.json still yields a card (never an exception)', async () => {
    const r = await pinCard(KEY, 'broken/package.json');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /not valid JSON/);
  });

  test('go.mod → module, go version, toolchain, direct/indirect require split, replace count', async () => {
    const r = await pinCard(KEY, 'go/go.mod');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /^manifest: go\.mod \(Go · modules\)/);
    assert.match(r.card, /module: github\.com\/lab\/sim · go 1\.22 · toolchain go1\.22\.3/);
    assert.match(r.card, /require: 4 \(3 direct, 1 indirect\) — github\.com\/spf13\/cobra v1\.8\.0, golang\.org\/x\/sync v0\.7\.0, gonum\.org\/v1\/gonum v0\.15\.0/);
    assert.doesNotMatch(r.card, /mousetrap/, 'indirect modules are counted, not listed');
    assert.match(r.card, /replace: 1 · exclude: 0/);
  });

  test('CMakeLists.txt → project/version/languages/min cmake, standard, targets, subdirs, packages, tests', async () => {
    const r = await pinCard(KEY, 'cm/CMakeLists.txt');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /^manifest: CMakeLists\.txt \(C\/C\+\+ · CMake\)/);
    assert.match(r.card, /project: SimEngine v0\.4\.2 · languages C CXX · cmake ≥ 3\.16/);
    assert.match(r.card, /standard: C\+\+17/);
    assert.match(r.card, /executables: 2 — sim, sim_tests/);
    assert.match(r.card, /libraries: 2 — simcore \(STATIC\), simplugins \(SHARED\)/);
    assert.match(r.card, /subdirectories: 1 — third_party\/fmt/);
    assert.match(r.card, /find_package: 2 — Threads, Eigen3/);
    assert.match(r.card, /tests: enable_testing\(\) · add_test × 1/);
  });

  test('Makefile → targets (no pattern/variable rules), default goal, .PHONY with continuation, variables', async () => {
    const r = await pinCard(KEY, 'mk/Makefile');
    assert.equal(r.kind, 'manifest');
    assert.match(r.card, /^manifest: Makefile \(make\)/);
    assert.match(r.card, /targets: 7 — all, sim, paper, paper\.pdf, test, check, clean/);
    assert.match(r.card, /default goal: all/);
    assert.match(r.card, /\.PHONY: all, clean, test, paper/);
    assert.match(r.card, /variables: 3 — CC, CFLAGS, OBJS/);
    assert.doesNotMatch(r.card, /%\.o|\$\(OBJS\)/, 'pattern and variable-named rules are not targets');
  });

  test('a huge manifest is capped at 40 lines and long lists at 15 names', async () => {
    const r = await pinCard(KEY, 'big/Cargo.toml');
    assert.ok(lineCount(r.card) <= 40, `got ${lineCount(r.card)} lines`);
    assert.match(r.card, /dependencies: 40 — dep0, dep1, .*dep14 … \(\+25 more\)/);
    assert.match(r.card, /bin b0, .*b9 … \(\+50 more\)/);
  });

  test('manifest cards are served through the same cache as data cards (mtime keyed)', async () => {
    const a = await pinCard(KEY, 'auto/Cargo.toml');
    fs.writeFileSync(path.join(root, 'auto/Cargo.toml'), '[package]\nname = "renamed"\nversion = "0.2.0"\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'auto/Cargo.toml'), future, future);
    const b = await pinCard(KEY, 'auto/Cargo.toml');
    assert.match(a.card, /tiny v0\.1\.0/);
    assert.match(b.card, /renamed v0\.2\.0/);
  });
});

// ---------------------------------------------------------------------------
// Folder maps skip build outputs — and the ignore rule itself
// ---------------------------------------------------------------------------
describe('folder pins and build directories', () => {
  const KEY = '__pins_ignore_test__';
  let root;
  const mk = (rel, file = 'x') => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, file), 'x');
  };

  before(() => {
    root = fs.realpathSync(mkTmp('cp-pins-ignore-'));
    PROJECTS[KEY] = { name: 'pins-ignore-test', root };
    mk('proj/src', 'main.rs');
    mk('proj/target/debug/deps', 'libfoo.rlib');
    mk('proj/node_modules/left-pad', 'index.js');
    mk('proj/dist', 'bundle.js');
    mk('proj/bin', 'run.sh');
    mk('goproj', 'main.go');
    fs.writeFileSync(path.join(root, 'goproj', 'go.mod'), 'module x\n\ngo 1.22\n');
    mk('goproj/vendor/github.com/x', 'x.go');
    mk('texproj/vendor', 'mathtools.sty'); // no go.mod beside it → a real source dir
  });

  after(() => { delete PROJECTS[KEY]; rmTmp(root); });

  test('the default ignore set carries the wave-1 build dirs and keeps the classics', () => {
    for (const d of ['node_modules', '.git', 'target', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.gradle']) {
      assert.ok(DEFAULT_IGNORE_DIRS.includes(d), d);
      assert.ok(ARTIFACT_GLOBS.ignoreDirs.includes(d), `${d} (effective)`);
    }
    assert.ok(!DEFAULT_IGNORE_DIRS.includes('bin'), 'bin/ is a real source dir (go cmd layout, scripts) — never ignored');
    assert.ok(!DEFAULT_IGNORE_DIRS.includes('vendor'), 'vendor/ is only ignored beside a go.mod');
  });

  test('isIgnoredDir: plain names, and vendor/ only when a go.mod is its sibling', () => {
    assert.equal(isIgnoredDir('target', path.join(root, 'proj')), true);
    assert.equal(isIgnoredDir('src', path.join(root, 'proj')), false);
    assert.equal(isIgnoredDir('bin', path.join(root, 'proj')), false);
    assert.equal(isIgnoredDir('vendor', path.join(root, 'goproj')), true, 'go.mod sibling');
    assert.equal(isIgnoredDir('vendor', path.join(root, 'texproj')), false, 'no go.mod → visible');
    assert.equal(isIgnoredDir('vendor', undefined), false, 'no parent to check → not ignored');
  });

  test('the folder map marks target/ and node_modules/ (ignored) and lists src/', async () => {
    const r = await pinCard(KEY, 'proj/');
    assert.equal(r.kind, 'folder');
    assert.match(r.card, /^target\/ \(ignored\)$/m);
    assert.match(r.card, /^node_modules\/ \(ignored\)$/m);
    assert.match(r.card, /^dist\/ \(ignored\)$/m);
    assert.match(r.card, /^src\/ \(1 entries\)$/m);
    assert.match(r.card, /^  main\.rs \(1 B\)$/m);
    assert.match(r.card, /^bin\/ \(1 entries\)$/m, 'bin/ is walked like any source dir');
    assert.doesNotMatch(r.card, /libfoo\.rlib|left-pad|bundle\.js/, 'ignored dirs are never descended');
  });

  test('vendor/ is (ignored) beside a go.mod but walked in a project without one', async () => {
    const go = await pinCard(KEY, 'goproj/');
    assert.match(go.card, /^vendor\/ \(ignored\)$/m);
    assert.doesNotMatch(go.card, /x\.go/);
    const tex = await pinCard(KEY, 'texproj/');
    assert.match(tex.card, /^vendor\/ \(1 entries\)$/m);
    assert.match(tex.card, /mathtools\.sty/);
  });
});

// ---------------------------------------------------------------------------
// One list, two consumers: the server's pinKind and the browser's pinKindOf
// both read public/pinkinds.js. Guard that neither side grows a private copy.
// ---------------------------------------------------------------------------
describe('server/client pin-kind lists agree', () => {
  test('lib/pins.js re-exports the shared lists by identity', () => {
    assert.equal(DATA_EXTS, pinkinds.DATA_EXTS);
    assert.equal(MANIFEST_NAMES, pinkinds.MANIFEST_NAMES);
  });

  test('public/util.js classifies every name the same way as lib/pins.js', async () => {
    globalThis.window ??= /** @type {any} */ ({}); // util.js sets one test seam on window at load
    const util = await import('../public/util.js');
    assert.equal(util.DATA_EXTS_C, pinkinds.DATA_EXTS, 'DATA_EXTS_C is the shared array, not a copy');
    const names = [
      ...DATA_EXTS.map((e) => `d/f.${e}`), 'F.CSV', 'a.py', 'b.tex', 'noext', 'dir/', 'x.csv/',
      ...Object.keys(MANIFEST_NAMES), ...Object.keys(MANIFEST_NAMES).map((n) => `sub/${n}`),
      'package-lock.json', 'Cargo.lock', 'pyproject.toml',
    ];
    for (const n of names) {
      const server = pinKind(n);
      const client = util.pinKindOf(n);
      if (server === 'manifest') {
        // the client keeps manifests as editable code tabs; the card is the session's
        assert.equal(client, 'code', n);
        assert.equal(util.isManifestFile(n), true, n);
      } else {
        assert.equal(client, server, n);
        assert.equal(util.isManifestFile(n), false, n);
      }
      assert.equal(util.isDataFile(n), server === 'data', `isDataFile ${n}`);
    }
    assert.equal(typeof util.PIN_ICON.manifest, 'string');
    assert.ok(util.PIN_ICON.manifest && util.PIN_ICON.manifest !== util.PIN_ICON.data);
  });
});
