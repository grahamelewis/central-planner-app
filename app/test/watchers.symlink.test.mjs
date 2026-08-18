// Regression: the per-project artifact watcher must NOT follow symlinks.
// An alias/symlink inside one project's root (e.g. pointing at another
// project's folder) used to make that project's watcher walk *through* it and
// index the other project's files as its own artifacts — so they "followed"
// the user into the wrong project's artifact pane. Both the initial scan and
// native-event path must reject every symlink component.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      // alpha's own artifact, and beta's artifact which must stay out of alpha
      fs.writeFileSync(path.join(projRoots.alpha, 'own.html'), '<h1>alpha</h1>');
      fs.writeFileSync(path.join(projRoots.beta, 'secret.html'), '<h1>beta secret</h1>');
      // the alias: a directory symlink inside alpha pointing at beta's folder
      fs.symlinkSync(projRoots.beta, path.join(projRoots.alpha, 'linkdir'), 'dir');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('the artifact watcher does not index files through a symlink into another project', async () => {
  // Wait for alpha's watcher to finish its initial scan. Once it logs ready,
  // the snapshot reflects the complete bounded scan and a leak is visible.
  await sb.poll('/api/state', () => /artifact watcher ready: alpha/.test(sb.logs()));

  const { body } = await sb.fetchJson('GET', '/api/state');
  const arts = body.artifacts || [];
  const alphaRels = arts.filter(a => a.project === 'alpha').map(a => a.rel);

  // the regression: beta's file must NOT appear under alpha via the symlink
  assert.ok(
    !alphaRels.some(r => r === 'linkdir/secret.html' || r.startsWith('linkdir/')),
    `alpha must not index files through the symlink; got alpha rels: ${JSON.stringify(alphaRels)}`,
  );
  // sanity: alpha still sees its own real artifact...
  assert.ok(alphaRels.includes('own.html'), 'alpha indexes its own files');
  // ...and beta's file is correctly attributed to beta, not lost
  assert.ok(
    arts.some(a => a.project === 'beta' && a.rel === 'secret.html'),
    'beta still indexes its own files',
  );
});

test('native change events also stay on the real side of a project symlink', async () => {
  fs.writeFileSync(path.join(sb.projRoots.beta, 'late-secret.html'), '<h1>late beta secret</h1>');
  await sb.poll('/api/state', (s) => (
    (s.artifacts || []).some((a) => a.project === 'beta' && a.rel === 'late-secret.html')
  ));
  // Give a second (incorrect) event routed through alpha's alias time to land.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const { body } = await sb.fetchJson('GET', '/api/state');
  assert.ok(
    !(body.artifacts || []).some((a) => a.project === 'alpha' && a.rel.includes('late-secret.html')),
    'a live target change is never attributed through alpha/linkdir',
  );
});
