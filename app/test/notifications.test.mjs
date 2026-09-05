import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './helpers.mjs';
import { startSandbox } from './serverHarness.mjs';

test('ntfy turn-end mute keeps approval pushes and never sends muted text', async () => {
  const sent = [];
  // Execute this small module with injected constants and a fake transport.
  // The shared brace-based extractor cannot parse destructured parameters.
  const code = fs.readFileSync(path.join(APP_DIR, 'lib/notify.js'), 'utf8')
    .replace(/^import .*;$/m, '').replace('export function notify', 'function notify');
  const notify = new Function('NTFY_TOPIC', 'NTFY_CLICK_BASE', 'NTFY_DETAIL', 'NOTIFY_TURN_END', 'fetch', `${code}\nreturn notify;`)(
    'test-only', '', false, false, async (_url, options) => sent.push(JSON.parse(options.body)));
  notify('turn ended', 'private', { turnEnd: true });
  assert.equal(sent.length, 0);
  notify('approval needed', 'private', { tags: 'hourglass' });
  assert.equal(sent.length, 1); assert.equal(sent[0].title, 'approval needed');
  assert.equal(sent[0].message, 'open Central Planner for details');
  const source = fs.readFileSync(path.join(APP_DIR, 'lib/sessions.js'), 'utf8');
  assert.equal((source.match(/turnEnd: true/g) || []).length, 8, 'both providers mark all four turn-end paths');
});

test('server snapshot shares the configured turn-end preference with the desktop', async () => {
  const sb = await startSandbox({ seed: ({ root }) => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ notifications: { turnEnd: false } })) });
  try {
    const { body, status } = await sb.fetchJson('GET', '/api/state');
    assert.equal(status, 200); assert.deepEqual(body.notifications, { turnEnd: false });
  } finally { await sb.stop(); }
});
