// Regression: generated-image trees must not consume one persistent descriptor
// per file. The watcher uses one native recursive subscription per project,
// while preserving live artifact events and leaving child-process spawn healthy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      const bulk = path.join(projRoots.alpha, 'output', 'plots');
      fs.mkdirSync(bulk, { recursive: true });
      for (let i = 0; i < 2500; i++) {
        fs.writeFileSync(path.join(bulk, `figure-${String(i).padStart(4, '0')}.png`), 'x');
      }
      fs.writeFileSync(path.join(projRoots.alpha, 'spawn-check.sh'), 'printf "watcher-spawn-ok\\n"\n');
    },
  });
});

after(async () => { if (sb) await sb.stop(); });

test('large generated trees keep one native watcher per project and child spawn remains healthy', async () => {
  await sb.poll('/api/state', () => (
    /artifact watcher ready: alpha \(native recursive;/.test(sb.logs())
    && /artifact watcher ready: beta \(native recursive;/.test(sb.logs())
  ));
  assert.match(sb.logs(), /2 subscriptions total/, 'subscriptions scale with projects, not files');
  assert.doesNotMatch(sb.logs(), /spawn EBADF|filesystem watch resources exhausted/);

  const started = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'spawn-check.sh' });
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  const done = await sb.poll('/api/state', (s) => s.runs?.alpha?.state === 'done');
  assert.match(done.runs.alpha.tail, /watcher-spawn-ok/);
});

test('artifacts created inside the large output tree still arrive live', async () => {
  const rel = path.join('output', 'plots', 'late-report.html');
  fs.writeFileSync(path.join(sb.projRoots.alpha, rel), '<h1>late</h1>');
  const state = await sb.poll('/api/state', (s) => (
    (s.artifacts || []).some((a) => a.project === 'alpha' && a.rel === rel)
  ));
  assert.ok(state.artifacts.some((a) => a.project === 'alpha' && a.rel === rel));
});

// Build directories: a `cargo build` (target/), a bundler (dist/), a go.mod's
// vendor/ — none of it may become an artifact, live or on rescan, while a
// sibling report written afterwards must arrive. Ordering is the oracle: the
// build files are written FIRST, so by the time the later sibling has been
// indexed, any event for them would already have landed.
test('writes under target/ dist/ and a go.mod vendor/ produce no artifact events; a sibling report does', async () => {
  const alpha = sb.projRoots.alpha;
  const noise = [
    path.join('target', 'debug', 'build-report.html'),
    path.join('target', 'doc', 'crate', 'index.html'),
    path.join('target', 'release', 'manual.pdf'),
    path.join('dist', 'index.html'),
    path.join('gomod', 'vendor', 'github.com', 'x', 'doc.html'),
  ];
  fs.mkdirSync(path.join(alpha, 'gomod'), { recursive: true });
  fs.writeFileSync(path.join(alpha, 'gomod', 'go.mod'), 'module x\n\ngo 1.22\n');
  for (const rel of noise) {
    fs.mkdirSync(path.dirname(path.join(alpha, rel)), { recursive: true });
    fs.writeFileSync(path.join(alpha, rel), '<h1>noise</h1>');
  }
  // a vendor/ WITHOUT a go.mod beside it is a real source dir and stays visible
  const plainVendor = path.join('texproj', 'vendor', 'notes.html');
  fs.mkdirSync(path.dirname(path.join(alpha, plainVendor)), { recursive: true });
  fs.writeFileSync(path.join(alpha, plainVendor), '<h1>vendored notes</h1>');
  const sibling = 'report.html';
  fs.writeFileSync(path.join(alpha, sibling), '<h1>report</h1>');

  const state = await sb.poll('/api/state', (s) => (
    (s.artifacts || []).some((a) => a.project === 'alpha' && a.rel === sibling)
    && (s.artifacts || []).some((a) => a.project === 'alpha' && a.rel === plainVendor)
  ));
  const rels = state.artifacts.filter((a) => a.project === 'alpha').map((a) => a.rel);
  for (const rel of noise) assert.ok(!rels.includes(rel), `${rel} must not be indexed; got ${JSON.stringify(rels)}`);
  assert.ok(!rels.some((r) => /^(target|dist)\//.test(r)), 'nothing under target/ or dist/');
  assert.ok(rels.includes(sibling));
  assert.ok(rels.includes(plainVendor));
});
