// Extract the real broadcast wrapper without initializing providers or data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';
import { publicTurn } from '../lib/turnRecall.js';

test('review: session permission request IDs survive turn metadata decoration', () => {
  const sent = [];
  const turn = { turnId: 'application-turn', requestId: 'composer-request', phase: 'running' };
  const { broadcast } = loadPrivateFns(path.join(APP_DIR, 'lib/sessions.js'), ['broadcast'], {
    keyOf: (project, id) => `${project}/${id}`,
    turnLifecycle: { get: () => turn }, publicTurn,
    broadcastEvent: (type, payload) => sent.push({ type, payload }),
  });
  for (const type of ['session:permission', 'session:permission:resolved']) {
    broadcast(type, { project: 'alpha', id: 'task', requestId: 'provider-permission-42' });
    assert.equal(sent.at(-1).payload.requestId, 'provider-permission-42', `${type} must preserve approval identity`);
  }
});

test('review: delayed event cannot acquire a replacement submission identity', () => {
  const sent = [];
  const replacement = { turnId: 'replacement-turn', requestId: 'replacement-request', phase: 'running' };
  const { broadcast } = loadPrivateFns(path.join(APP_DIR, 'lib/sessions.js'), ['broadcast'], {
    keyOf: (project, id) => `${project}/${id}`,
    turnLifecycle: { get: () => replacement }, publicTurn,
    broadcastEvent: (type, payload) => sent.push({ type, payload }),
  });
  broadcast('session:stream', { project: 'alpha', id: 'task', turnId: 'old-turn', requestId: 'old-request', chunk: 'late output' });
  if (sent.length) {
    assert.equal(sent[0].payload.turnId, 'old-turn');
    assert.equal(sent[0].payload.requestId, 'old-request');
    assert.notEqual(sent[0].payload.activeTurn?.turnId, 'replacement-turn');
  }
});
