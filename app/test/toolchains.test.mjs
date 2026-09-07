// lib/toolchains.js — discovery + install hints + project needs, with every
// probe injected through createToolchains() so nothing here depends on the
// machine's PATH (go/cmake/ninja are absent on the dev Mac, present on some
// CI images — the answers must not change). Nothing spawns, nothing bills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-toolchains-')));
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({
  alpha: { name: 'alpha', root: path.join(root, 'proj'), color: '#aabbcc', texWatch: null },
});
process.env.CP_NTFY_TOPIC = '';

const { createToolchains, HINTS, TOOLCHAIN_IDS, MARKERS, SKIP_DIRS, _test } = await import('../lib/toolchains.js');
const { RUNTIMES } = await import('../lib/runtimes.js');

const ALL_BINS = [...new Set(TOOLCHAIN_IDS.flatMap((id) => (RUNTIMES[id].toolchain || []).map((t) => t.bin)))];

/**
 * A fake toolchains service. `present` = bins "on PATH"; `versions` = the
 * `--version` first lines; `duckdb` = the module probe's answer (null → never
 * answers); `tsx` = the path `which('tsx')` returns.
 */
function fake({ present = ALL_BINS, versions = {}, duckdb = { found: true, version: '1.4.3' }, tsx = null, platform = 'darwin' } = {}) {
  const calls = { status: [], refresh: 0, which: [], module: 0 };
  let clock = 1_000_000;
  const status = (opts = {}) => {
    calls.status.push(opts);
    const out = {};
    for (const id of TOOLCHAIN_IDS) {
      const bins = {};
      const missing = [];
      for (const t of RUNTIMES[id].toolchain || []) {
        const found = present.includes(t.bin);
        bins[t.bin] = { path: found ? `/fake/bin/${t.bin}` : null, version: found ? (versions[t.bin] || `${t.bin} 1.2.3`) : null, optional: !!t.optional };
        if (!found && !t.optional) missing.push(t.bin);
      }
      out[id] = { ok: missing.length === 0, missing, bins, versions: {} };
    }
    return out;
  };
  const svc = createToolchains({
    status,
    refresh: async () => { calls.refresh++; },
    which: (b) => { calls.which.push(b); return b === 'tsx' ? tsx : null; },
    probeModule: (py, mod, cb) => { calls.module++; if (duckdb) cb(duckdb); },
    platform,
    now: () => clock,
    appDir: path.join(root, 'no-such-app'),
  });
  return { ...svc, calls, tick: (ms) => { clock += ms; } };
}

let n = 0;
/** a fresh project tree: files = { 'rel/path': 'content' } → its root */
function tree(files) {
  const dir = path.join(root, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test('describeToolchains: one entry per runtime with the contract shape', () => {
  const svc = fake();
  const d = svc.describeToolchains();
  assert.deepEqual(Object.keys(d), TOOLCHAIN_IDS);
  for (const id of TOOLCHAIN_IDS) {
    const t = d[id];
    assert.equal(t.id, id);
    assert.equal(t.label, RUNTIMES[id].label);
    assert.ok(Array.isArray(t.required) && Array.isArray(t.optional), `${id} has required/optional arrays`);
    for (const r of [...t.required, ...t.optional]) {
      for (const f of ['bin', 'found', 'path', 'version', 'short']) assert.ok(f in r, `${id}.${r.bin} row has '${f}'`);
    }
    assert.equal(typeof t.ok, 'boolean');
    assert.ok(Array.isArray(t.missing));
    assert.ok('hint' in t);
    assert.equal(t.ok, true, `${id} ok when everything is present`);
    assert.equal(t.hint, null, `${id} has no hint when complete`);
  }
  // required vs optional follows the registry's `optional` flags
  assert.deepEqual(d.c.required.map((r) => r.bin), ['cc', 'c++', 'make']);
  assert.deepEqual(d.c.optional.map((r) => r.bin), ['cmake', 'ninja']);
  assert.deepEqual(d.rust.required.map((r) => r.bin), ['cargo', 'rustc']);
  assert.equal(d.rust.required[0].path, '/fake/bin/cargo');
  assert.equal(d.rust.required[0].version, 'cargo 1.2.3');
  assert.equal(d.rust.required[0].short, '1.2.3');
});

test('a missing required binary flips ok and carries a macOS + Linux hint', () => {
  const svc = fake({ present: ALL_BINS.filter((b) => b !== 'go') });
  const d = svc.describeToolchains();
  assert.equal(d.go.ok, false);
  assert.deepEqual(d.go.missing, ['go']);
  assert.equal(d.go.required[0].found, false);
  assert.equal(d.go.required[0].path, null);
  assert.match(d.go.hint, /^brew install go · Linux: /);
  assert.match(d.go.hint, /apt install golang-go/);
  assert.equal(d.rust.ok, true, 'other runtimes unaffected');
});

test('every runtime binary (and the duckdb module) has an install hint', () => {
  for (const bin of ALL_BINS) {
    assert.ok(HINTS[bin], `hint for ${bin}`);
    assert.ok(HINTS[bin].darwin && HINTS[bin].linux, `${bin} has both platforms`);
  }
  assert.ok(HINTS['duckdb (python module)']);
  // the documented suggestions
  assert.match(HINTS.go.darwin, /brew install go/);
  assert.match(HINTS.cargo.darwin, /rustup/);
  assert.match(HINTS.cc.darwin, /xcode-select --install/);
  assert.match(HINTS['cmake+ninja'].darwin, /brew install cmake ninja/);
  assert.match(HINTS.node.darwin, /brew install node|nvm/);
  assert.match(HINTS['duckdb (python module)'].darwin, /pip install duckdb/);
  // one hint per runtime when NOTHING is installed
  const svc = fake({ present: [] });
  for (const [id, t] of Object.entries(svc.describeToolchains())) {
    assert.equal(t.ok, false, `${id} not ok`);
    assert.ok(typeof t.hint === 'string' && t.hint.length > 8, `${id} has a hint`);
  }
});

test('optional cmake + ninja missing: still ok, one combined brew line', () => {
  const svc = fake({ present: ALL_BINS.filter((b) => b !== 'cmake' && b !== 'ninja') });
  const d = svc.describeToolchains();
  assert.equal(d.c.ok, true);
  assert.deepEqual(d.c.missing, []);
  assert.deepEqual(d.c.missingOptional, ['cmake', 'ninja']);
  assert.equal(d.c.hint, 'brew install cmake ninja · Linux: sudo apt install cmake ninja-build');
  assert.equal(d.cpp.hint, d.c.hint);
  const only = fake({ present: ALL_BINS.filter((b) => b !== 'ninja') }).describeToolchains();
  assert.equal(only.c.hint, 'brew install ninja · Linux: sudo apt install ninja-build');
});

test('on Linux the host hint comes first and macOS is the alternative', () => {
  const svc = fake({ present: ALL_BINS.filter((b) => b !== 'go'), platform: 'linux' });
  assert.match(svc.describeToolchains().go.hint, /^sudo apt install golang-go .* · macOS: brew install go$/);
});

test('sql checks the duckdb python MODULE, not a CLI', () => {
  const yes = fake().describeToolchains().sql;
  const mod = yes.required.find((r) => r.bin === 'duckdb (python module)');
  assert.ok(mod, 'module row present');
  assert.equal(mod.kind, 'module');
  assert.equal(mod.found, true);
  assert.equal(mod.short, '1.4.3');
  assert.equal(yes.ok, true);

  const no = fake({ duckdb: { found: false } }).describeToolchains().sql;
  assert.equal(no.ok, false);
  assert.deepEqual(no.missing, ['duckdb (python module)']);
  assert.match(no.hint, /pip install duckdb/);

  // no python at all: the module is not probed (nothing to probe with)
  const nopy = fake({ present: ALL_BINS.filter((b) => b !== 'python3') });
  const s = nopy.describeToolchains().sql;
  assert.equal(nopy.calls.module, 0);
  assert.equal(s.ok, false);
  assert.ok(s.missing.includes('python3'));
});

test('an unanswered module probe is pending, not missing', () => {
  const svc = fake({ duckdb: null });
  const s = svc.describeToolchains().sql;
  const mod = s.required.find((r) => r.kind === 'module');
  assert.equal(mod.pending, true);
  assert.equal(mod.found, false);
  assert.equal(s.ok, true, 'not counted as missing before the probe answers');
  assert.deepEqual(s.missing, []);
});

test('refresh fences stale module callbacks and does not restart fresh runtime probes', async () => {
  const callbacks = [];
  const statusCalls = [];
  const svc = createToolchains({
    status: (options = {}) => {
      statusCalls.push(options);
      return { sql: { bins: { python3: { path: '/fixture/python3', version: '3.12' } } } };
    },
    refresh: async () => {}, which: () => null,
    probeModule: (_python, _module, callback) => callbacks.push(callback),
    appDir: path.join(root, 'absent'),
  });
  svc.describeToolchains();
  const refresh = svc.refreshToolchains();
  await Promise.resolve();
  assert.equal(callbacks.length, 2, 'a fresh probe starts even while the obsolete probe is pending');
  callbacks[1]({ found: true, version: '1.5.0' });
  callbacks[0]({ found: false });
  const detail = await refresh;
  assert.equal(detail.sql.ok, true);
  assert.equal(detail.sql.versions['duckdb (python module)'], '1.5.0');
  assert.ok(statusCalls.every(options => !options.refresh), 'assembled result must not discard freshly awaited runtime probes');
});

test('node: the .ts decision follows the probed version (type stripping ≥ 22.18) and tsx', () => {
  const old = fake({ versions: { node: 'v22.17.1' } }).describeToolchains().node;
  assert.deepEqual(old.ts, { strip: false, tsx: null, via: null });
  const oldTsx = fake({ versions: { node: 'v22.17.1' }, tsx: '/fake/bin/tsx' }).describeToolchains().node;
  assert.deepEqual(oldTsx.ts, { strip: false, tsx: '/fake/bin/tsx', via: 'tsx' });
  const strip = fake({ versions: { node: 'v22.18.0' } }).describeToolchains().node;
  assert.deepEqual(strip.ts, { strip: true, tsx: null, via: null });
  const v23 = fake({ versions: { node: 'v23.6.0' }, tsx: '/x/tsx' }).describeToolchains().node;
  assert.equal(v23.ts.strip, true);
  assert.equal(v23.ts.via, 'tsx', 'full TS executor wins over limited native stripping');
  const cur = fake({ versions: { node: 'v25.6.1' } }).describeToolchains().node;
  assert.equal(cur.ts.strip, true);
  assert.equal(cur.versions.node, '25.6.1');
});

test('toolchainsSummary: ok flags + short versions + hint, no paths', () => {
  const svc = fake({ present: ALL_BINS.filter((b) => b !== 'go'), versions: { cargo: 'cargo 1.94.1 (abc 2026-01-01)' } });
  const s = svc.toolchainsSummary();
  assert.deepEqual(Object.keys(s), TOOLCHAIN_IDS);
  assert.equal(JSON.stringify(s).includes('/fake/bin'), false, 'no paths anywhere');
  assert.ok(!('required' in s.rust));
  assert.equal(s.rust.versions.cargo, '1.94.1');
  assert.equal(s.go.ok, false);
  assert.deepEqual(s.go.missing, ['go']);
  assert.match(s.go.hint, /brew install go/);
  assert.deepEqual(s.node.ts, { strip: false, via: null, tsx: false });
});

test('projectNeeds: markers at depth ≤ 2, build/deps dirs ignored, C vs C++ by sources', () => {
  const svc = fake();
  const dir = tree({
    'Cargo.toml': '[package]\nname="x"',
    'src/main.rs': 'fn main(){}',
    'svc/go.mod': 'module x',
    'web/app/package.json': '{}',            // depth 2 file → seen
    'deep/a/b/package.json': '{}',           // depth 3 → not scanned
    'node_modules/dep/Cargo.toml': '',       // ignored dir
    'target/debug/go.mod': '',               // ignored dir
    '.git/Project.toml': '',                 // dotdir → ignored
    'paper/main.tex': '\\documentclass{article}',
    'notebooks/Project.toml': '',
    'requirements.txt': 'duckdb',
    'renv.lock': '{}',
    'queries/q.sql': 'select 1',
  });
  const needs = svc.projectNeeds(dir);
  assert.deepEqual([...needs.runtimes].sort(), ['go', 'julia', 'node', 'python', 'r', 'rust', 'sql', 'tex']);
  assert.equal(needs.markers.rust, 'Cargo.toml');
  assert.equal(needs.markers.go, 'svc/go.mod');
  assert.equal(needs.markers.node, 'web/app/package.json');
  assert.equal(needs.markers.tex, 'paper/main.tex');
  assert.equal(needs.markers.sql, 'queries/q.sql');
  assert.ok(!needs.runtimes.includes('c') && !needs.runtimes.includes('cpp'));

  const cpp = svc.projectNeeds(tree({ 'CMakeLists.txt': '', 'src/main.cpp': '' }));
  assert.deepEqual(cpp.runtimes, ['cpp']);
  assert.equal(cpp.markers.cpp, 'CMakeLists.txt');
  const c = svc.projectNeeds(tree({ Makefile: 'all:', 'main.c': '' }));
  assert.deepEqual(c.runtimes, ['c']);
  assert.equal(c.markers.c, 'Makefile');
  const mixed = svc.projectNeeds(tree({ Makefile: '', 'a.c': '', 'b.cpp': '' }));
  assert.deepEqual(mixed.runtimes, ['c'], 'C sources present → c (the toolchain is the same)');
  const bare = svc.projectNeeds(tree({ 'GNUmakefile': '' }));
  assert.deepEqual(bare.runtimes, ['c']);

  assert.deepEqual(svc.projectNeeds(tree({ 'README.md': '' })), { runtimes: [], markers: {} });
  assert.deepEqual(svc.projectNeeds(path.join(root, 'nope')), { runtimes: [], markers: {} }, 'a missing root is empty, never throws');
  assert.ok(MARKERS.some((m) => m.name === 'Cargo.toml') && SKIP_DIRS.has('node_modules'));
});

test('missingFor / projectToolchains = needed − ok', () => {
  const svc = fake({ present: ALL_BINS.filter((b) => b !== 'go' && b !== 'latexmk') });
  const dir = tree({ 'Cargo.toml': '', 'go.mod': '', 'paper.tex': '', 'package.json': '{}' });
  assert.deepEqual(svc.missingFor(dir), ['go', 'tex']);
  const pt = svc.projectToolchains(dir);
  assert.deepEqual(pt.runtimes, ['rust', 'go', 'node', 'tex']);
  assert.deepEqual(pt.missing, ['go', 'tex']);
  assert.equal(pt.markers.go, 'go.mod');
  assert.deepEqual(fake().missingFor(dir), [], 'nothing missing when everything is installed');
  assert.deepEqual(svc.missingFor(tree({ 'x.txt': '' })), [], 'a project that needs nothing misses nothing');
});

test('caching: 60 s, then re-probes; refresh re-probes at once (status + project scans)', async () => {
  const svc = fake();
  svc.describeToolchains();
  svc.describeToolchains();
  svc.toolchainsSummary();
  assert.equal(svc.calls.status.length, 1, 'one status probe within the window');
  svc.tick(59_000);
  svc.describeToolchains();
  assert.equal(svc.calls.status.length, 1);
  svc.tick(2_000);
  svc.describeToolchains();
  assert.equal(svc.calls.status.length, 2, 'expired → probed again');
  assert.equal(svc.calls.status[1].refresh, false);

  // project scans are cached too: a marker added after the first scan waits
  const dir = tree({ 'package.json': '{}' });
  assert.deepEqual(svc.projectNeeds(dir).runtimes, ['node']);
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
  assert.deepEqual(svc.projectNeeds(dir).runtimes, ['node'], 'cached');
  assert.deepEqual(svc.projectNeeds(dir, { refresh: true }).runtimes, ['rust', 'node'], 'explicit rescan (alphabetical: Cargo.toml first)');

  fs.writeFileSync(path.join(dir, 'go.mod'), '');
  const before = svc.calls.status.length;
  const d = await svc.refreshToolchains();
  assert.equal(svc.calls.refresh, 1, 'runtimes.refreshToolchains awaited');
  assert.ok(svc.calls.status.length > before);
  assert.ok(svc.calls.status.slice(before).every((c) => !c.refresh), 'fresh runtime probes are not invalidated again while rebuilding metadata');
  assert.deepEqual(Object.keys(d), TOOLCHAIN_IDS);
  assert.deepEqual(svc.projectNeeds(dir).runtimes, ['rust', 'go', 'node'], 'refresh drops the project cache');
});

test('a pending version fills in on the next call without a new PATH probe', () => {
  // status() answers version:null first (the async --version has not landed)
  let answered = false;
  const calls = [];
  const svc = createToolchains({
    status: (o = {}) => {
      calls.push(o);
      const out = {};
      for (const id of TOOLCHAIN_IDS) {
        const bins = {};
        for (const t of RUNTIMES[id].toolchain || []) bins[t.bin] = { path: `/fake/${t.bin}`, version: answered ? `${t.bin} 9.9.9` : null, optional: !!t.optional };
        out[id] = { ok: true, missing: [], bins, versions: {} };
      }
      return out;
    },
    refresh: async () => {},
    which: () => null,
    probeModule: (py, mod, cb) => cb({ found: true, version: '1' }),
    now: () => 5,
    appDir: root,
  });
  assert.equal(svc.describeToolchains().rust.required[0].version, null);
  answered = true;
  assert.equal(svc.describeToolchains().rust.required[0].short, '9.9.9', 'refilled from the cached status');
  assert.ok(calls.every((c) => !c.refresh), 'never forced a re-probe');
  svc.describeToolchains();
  const cnt = calls.length;
  svc.describeToolchains();
  assert.equal(calls.length, cnt, 'complete → served from cache');
});

test('_test helpers: shortVersion and the default instance exist', () => {
  assert.equal(_test.shortVersion('cargo 1.94.1 (abc)'), '1.94.1');
  assert.equal(_test.shortVersion('go version go1.23.4 darwin/arm64'), '1.23.4');
  assert.equal(_test.shortVersion('v25.6.1'), '25.6.1');
  assert.equal(_test.shortVersion(null), null);
  assert.equal(typeof _test.DEFAULT.describeToolchains, 'function');
});
