import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServer, normalizeCodexUsage } from '../lib/codexAppServer.js';

function fakeProcess(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.setEncoding('utf8');
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (line) onMessage(JSON.parse(line), child);
    }
  });
  child.kill = () => true;
  return child;
}

test('Codex app-server client performs the official initialize/initialized handshake', async () => {
  const sent = [];
  const client = new CodexAppServer({
    bin: '/fake/codex',
    spawnFn: () => fakeProcess((message, child) => {
      sent.push(message);
      if (message.method === 'initialize') {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\n'));
      } else if (message.method === 'model/list') {
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: 'gpt-test' }] } }) + '\n'));
      }
    }),
  });
  await client.start();
  const models = await client.request('model/list', { limit: 1 });
  assert.equal(models.data[0].id, 'gpt-test');
  assert.equal(sent[0].method, 'initialize');
  assert.deepEqual(sent[0].params.clientInfo, { name: 'central-planner', title: 'Central Planner', version: '0.1.0' });
  assert.equal(sent[1].method, 'initialized');
  assert.equal(Object.hasOwn(sent[0], 'jsonrpc'), false, 'Codex JSONL deliberately omits jsonrpc');
  client.stop();
});

test('normalizeCodexUsage preserves real primary/secondary windows and reset times', () => {
  const usage = normalizeCodexUsage({
    rateLimitsByLimitId: {
      codex: {
        limitName: 'ChatGPT Codex',
        primary: { usedPercent: 61.6, windowDurationMins: 300, resetsAt: 1785862800 },
        secondary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1786294800 },
      },
    },
  }, Date.UTC(2026, 7, 4));
  assert.equal(usage.provider, 'codex');
  assert.equal(usage.source, 'plan');
  assert.deepEqual(usage.limits.map(x => [x.name, x.pct, x.real]), [
    ['5h session', 62, true],
    ['weekly limit', 24, true],
  ]);
  assert.ok(usage.limits.every(x => x.resetAt && !Number.isNaN(Date.parse(x.resetAt))));
});

test('normalizeCodexUsage handles a single legacy rateLimits bucket and clamps percentages', () => {
  const usage = normalizeCodexUsage({
    rateLimits: { limitId: 'legacy', primary: { usedPercent: 101.2, windowDurationMins: 60, resetsAt: 1 } },
  });
  assert.equal(usage.limits.length, 1);
  assert.equal(usage.limits[0].pct, 100);
  assert.equal(normalizeCodexUsage({ rateLimits: {} }), null);
});

test('normalizeCodexUsage labels a weekly Spark primary as a scoped limit, not a session', () => {
  const usage = normalizeCodexUsage({
    rateLimitsByLimitId: {
      spark: {
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786294800 },
      },
      codex: {
        limitName: 'ChatGPT Codex',
        primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1786208400 },
      },
    },
  });
  assert.deepEqual(usage.limits.map(x => [x.name, x.sub, x.scopeModel]), [
    ['weekly limit', 'Codex', null],
    ['weekly limit', 'Codex Spark', 'spark'],
  ]);
  assert.equal(usage.limits[1].fullSub, 'GPT-5.3-Codex-Spark');
});
