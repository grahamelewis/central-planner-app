// /api/state contract — the frontend's entire data dependency. If this shape
// drifts, the dashboard renders blank cells with no console error to find.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      // a pre-existing artifact the native watcher scan must index on startup
      fs.writeFileSync(path.join(projRoots.alpha, 'report.html'), '<html><body>hi</body></html>');
      // toolchain markers: alpha is a rust + go project (node's package.json
      // sits in a dir the scan ignores; the deep one is below depth 2)
      fs.writeFileSync(path.join(projRoots.alpha, 'Cargo.toml'), '[package]\nname = "alpha"\n');
      fs.mkdirSync(path.join(projRoots.alpha, 'svc'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'svc', 'go.mod'), 'module alpha/svc\n');
      fs.mkdirSync(path.join(projRoots.alpha, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'node_modules', 'dep', 'package.json'), '{}');
      fs.mkdirSync(path.join(projRoots.alpha, 'a', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'a', 'b', 'c', 'package.json'), '{}');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('snapshot has every key the frontend reads, with the right shapes', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  for (const key of ['projects', 'categories', 'abstracts', 'tasks', 'artifacts', 'pdf', 'ledger', 'sessions', 'runs', 'tailnet', 'toolchains']) {
    assert.ok(key in body, `snapshot is missing '${key}'`);
  }
  assert.deepEqual(Object.keys(body.projects).sort(), ['alpha', 'beta']);
  for (const p of Object.values(body.projects)) {
    for (const f of ['name', 'root', 'color', 'texWatch', 'status']) assert.ok(f in p, `project missing '${f}'`);
  }
  assert.deepEqual(body.tasks, { alpha: [], beta: [] });
  assert.equal(body.abstracts.alpha, '# Alpha abstract\n');
  assert.equal(body.abstracts.beta, '');
  assert.ok(body.categories.calibration);
  assert.ok(Array.isArray(body.artifacts));
  assert.ok(Array.isArray(body.sessions));
  assert.deepEqual(body.sessions, []);
  assert.deepEqual(body.runs, {});
  assert.deepEqual(body.pdf, {});
  assert.equal(body.tailnet.state, 'unavailable');
});

test('ledger summary starts at zero with the configured target and a Monday start', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  const led = body.ledger;
  assert.equal(led.hourTarget, 35);
  assert.deepEqual(led.totals, { seconds: 0, tokens: 0, costUsd: 0 });
  assert.deepEqual(led.perProject.alpha, { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  const since = new Date(led.since);
  assert.ok(!Number.isNaN(since.getTime()), 'ledger.since parses as a date');
  assert.equal(since.getDay(), 1, 'week starts on Monday');
  assert.ok(since.getTime() <= Date.now(), 'week start is not in the future');
});

test('startup artifact indexing finds pre-existing html files', async () => {
  const body = await sb.poll('/api/state', (s) => s.artifacts && s.artifacts.length >= 1);
  const art = body.artifacts.find((a) => a.rel === 'report.html');
  assert.ok(art, 'report.html was indexed');
  assert.equal(art.project, 'alpha');
  assert.equal(art.kind, 'html');
  assert.equal(art.name, 'report.html');
  assert.ok(art.mtime, 'artifact carries an mtime');
});

test('a new artifact written while running gets indexed', async () => {
  fs.writeFileSync(path.join(sb.projRoots.beta, 'figure.html'), '<html>fig</html>');
  const body = await sb.poll('/api/state', (s) => (s.artifacts || []).some((a) => a.rel === 'figure.html'));
  const art = body.artifacts.find((a) => a.rel === 'figure.html');
  assert.equal(art.project, 'beta');
});

test('a deleted artifact is removed from the live index', async () => {
  fs.unlinkSync(path.join(sb.projRoots.beta, 'figure.html'));
  const body = await sb.poll('/api/state', (s) => (
    !(s.artifacts || []).some((a) => a.project === 'beta' && a.rel === 'figure.html')
  ));
  assert.ok(!body.artifacts.some((a) => a.project === 'beta' && a.rel === 'figure.html'));
});

test('unknown /api routes 404 with a JSON error', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/definitely-not-a-route');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});

test('snapshot kaimon field: enabled but unavailable under the harness pin', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  assert.ok('kaimon' in body, 'snapshot is missing kaimon');
  assert.equal(body.kaimon.enabled, true, 'default is enabled');
  // the harness pins CP_KAIMON_BIN to a nonexistent path — deterministic on
  // dev machines that have the real binary AND on CI that does not
  assert.equal(body.kaimon.available, false);
  assert.equal(body.kaimon.daemon, null, 'no daemon in the sandbox, ever');
  assert.equal(typeof body.kaimon.julia, 'object');
  assert.equal(body.kaimon.install.state, 'idle');
});

test('POST /api/kaimon/install refuses in the sandbox (CP_NO_BILLED)', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/kaimon/install');
  assert.equal(status, 403);
  assert.match(body.error, /disabled/);
});

// Toolchains (lib/toolchains.js): the snapshot carries a per-runtime summary
// (no paths) and per-project needs; the detail lives on /api/toolchains.
// Presence itself is machine-dependent (go is absent on the dev Mac) — the
// assertions are about shape and internal consistency, never about a bin.
const TC_IDS = ['rust', 'go', 'node', 'c', 'cpp', 'julia', 'python', 'r', 'sql', 'tex'];

test('snapshot.toolchains: a summary per runtime — ok, missing, versions, hint, no paths', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  const tc = body.toolchains;
  assert.deepEqual(Object.keys(tc), TC_IDS);
  for (const id of TC_IDS) {
    const t = tc[id];
    assert.equal(t.id, id);
    assert.equal(typeof t.label, 'string');
    assert.equal(typeof t.ok, 'boolean');
    assert.ok(Array.isArray(t.missing) && Array.isArray(t.missingOptional));
    assert.equal(typeof t.versions, 'object');
    assert.ok(t.hint === null || typeof t.hint === 'string');
    assert.equal(t.ok, t.missing.length === 0, `${id}.ok mirrors missing`);
    if (!t.ok) assert.ok(t.hint, `${id} missing → hint`);
    assert.ok(!('required' in t) && !('optional' in t), `${id} summary carries no rows/paths`);
  }
  // node runs this server, so node/npm are present and the .ts decision is made
  assert.equal(tc.node.ok, true);
  assert.equal(typeof tc.node.ts.strip, 'boolean');
  assert.ok(['node', 'tsx', null].includes(tc.node.ts.via));
  assert.equal(JSON.stringify(tc).includes(process.execPath), false, 'no paths in the snapshot');
});

test('snapshot.projects[*].toolchains: the markers found (depth ≤ 2, deps ignored) and what is missing', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  const alpha = body.projects.alpha.toolchains;
  assert.deepEqual(alpha.runtimes, ['rust', 'go']);
  assert.deepEqual(alpha.markers, { rust: 'Cargo.toml', go: 'svc/go.mod' });
  assert.ok(Array.isArray(alpha.missing));
  for (const id of alpha.missing) {
    assert.ok(alpha.runtimes.includes(id), 'missing ⊆ needed');
    assert.equal(body.toolchains[id].ok, false, `missing ${id} is not ok in the summary`);
  }
  for (const id of alpha.runtimes) {
    if (body.toolchains[id].ok) assert.ok(!alpha.missing.includes(id));
    else assert.ok(alpha.missing.includes(id), `needed-but-absent ${id} is reported`);
  }
  assert.deepEqual(body.projects.beta.toolchains, { runtimes: [], markers: {}, missing: [] });
});

test('GET /api/toolchains: the detail with rows and paths; POST refresh re-probes', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/toolchains');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), TC_IDS);
  const node = body.node;
  assert.ok(Array.isArray(node.required) && Array.isArray(node.optional));
  const row = node.required.find((r) => r.bin === 'node');
  assert.ok(row, 'a row per registry binary');
  for (const f of ['bin', 'found', 'path', 'version', 'short']) assert.ok(f in row, `row has '${f}'`);
  assert.equal(row.found, true);
  assert.ok(row.path && row.path.includes('/'), 'the detail carries the path');
  assert.deepEqual(body.c.optional.map((r) => r.bin), ['cmake', 'ninja']);
  const mod = body.sql.required.find((r) => r.kind === 'module');
  assert.equal(mod.bin, 'duckdb (python module)');

  const r = await sb.fetchJson('POST', '/api/toolchains/refresh');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), TC_IDS);
  assert.equal(r.body.node.required.find((x) => x.bin === 'node').found, true);
  assert.ok(r.body.node.versions.node, 'versions have landed after an awaited refresh');
});
