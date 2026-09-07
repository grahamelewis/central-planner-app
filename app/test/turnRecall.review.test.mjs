// Independent lifecycle review: no SDK, model calls, server, or real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRecall } from '../lib/turnRecall.js';

const KEY = 'alpha/task';
function fixture(extra = {}) {
  let time = 10000, serial = 0;
  const recall = createTurnRecall({ now: () => time, id: () => `turn-${++serial}`, ...extra });
  const begin = (requestId = 'request-1') => recall.begin(KEY, {
    requestId, prompt: '  Exact prompt\nwith trailing space ', provider: 'codex', recallable: true,
  });
  return { recall, begin, advance: ms => { time += ms; } };
}
const ids = turn => ({ turnId: turn.turnId, requestId: turn.requestId });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('review: five-second boundary is exclusive and completion closes it early', () => {
  for (const elapsed of [5000, 5001]) {
    const { recall, begin, advance } = fixture();
    const turn = begin();
    advance(elapsed);
    assert.throws(() => recall.recall(KEY, ids(turn), () => {}, () => {}), { status: 409 });
    assert.equal(turn.cancelRequested, false);
  }
  const { recall, begin, advance } = fixture();
  const turn = begin();
  advance(100);
  recall.settle(KEY, turn);
  assert.throws(() => recall.recall(KEY, ids(turn), () => {}, () => {}), { status: 409 });
  assert.equal(turn.cancelRequested, false);
});

test('review: both identifiers must match; stale recall cannot touch replacement', async () => {
  const { recall, begin } = fixture();
  const old = begin();
  for (const request of [{}, { turnId: old.turnId, requestId: 'wrong' }, { requestId: old.requestId, turnId: 'wrong' }]) {
    assert.throws(() => recall.recall(KEY, request, () => {}, () => {}), { status: 409 });
  }
  recall.settle(KEY, old);
  recall.finish(KEY, old);
  const replacement = begin('replacement');
  let interruptions = 0;
  await recall.attach(KEY, { interrupt: async () => { interruptions++; } });
  assert.throws(() => recall.recall(KEY, ids(old), () => {}, () => {}), { status: 409 });
  recall.settle(KEY, old);
  recall.finish(KEY, old);
  assert.throws(() => recall.attach(KEY, { interrupt: async () => { interruptions++; } }, old), { status: 409 });
  assert.equal(recall.get(KEY), replacement, 'old cleanup must not release replacement');
  assert.equal(replacement.settled, false);
  assert.equal(interruptions, 0);
});

test('review: early recall latches until provider attaches; duplicate recall is single-flight', async () => {
  const { recall, begin, advance } = fixture();
  const turn = begin();
  advance(4999);
  let interruptions = 0, restores = 0, commits = 0;
  const restore = async stopped => {
    assert.equal(stopped.settled, true);
    restores++;
    return { threadId: 'restored-thread' };
  };
  const commit = async stopped => {
    commits++;
    assert.equal(stopped.prompt, '  Exact prompt\nwith trailing space ');
    return { recalled: true };
  };
  const first = recall.recall(KEY, { requestId: turn.requestId }, restore, commit);
  const second = recall.recall(KEY, ids(turn), restore, commit);
  assert.equal(second, first);
  assert.throws(() => begin('replacement'), { status: 409 });
  await recall.attach(KEY, { interrupt: async () => { interruptions++; recall.settle(KEY, turn); } });
  assert.deepEqual(await first, { recalled: true });
  assert.equal(interruptions, 1);
  assert.equal(restores, 1);
  assert.equal(commits, 1);
  assert.equal(recall.get(KEY), undefined);
});

test('review: provider restoration failure never commits local history', async () => {
  const { recall, begin } = fixture();
  const turn = begin();
  let commits = 0;
  await recall.attach(KEY, { interrupt: async () => recall.settle(KEY, turn) });
  await assert.rejects(recall.recall(KEY, ids(turn), async () => {
    throw new Error('fork denied');
  }, async () => { commits++; }), /fork denied/);
  assert.equal(commits, 0);
  assert.equal(turn.restored, undefined);
  assert.notEqual(turn.phase, 'recalled');
  assert.equal(recall.get(KEY), undefined, 'settled unchanged provider history can resume honestly');
});

test('review: failed durable commit retains lock; retry does not fork again after deadline', async () => {
  const { recall, begin, advance } = fixture();
  const turn = begin();
  let forks = 0;
  await recall.attach(KEY, { interrupt: async () => recall.settle(KEY, turn) });
  await assert.rejects(recall.recall(KEY, ids(turn), async () => {
    forks++;
    return { threadId: 'restored-thread' };
  }, async () => { throw new Error('disk unavailable'); }), /disk unavailable/);
  assert.equal(turn.phase, 'recall-recovery');
  assert.throws(() => begin('replacement'), { status: 409 });
  advance(60000);
  await recall.recall(KEY, ids(turn), async () => { forks++; }, async current => {
    assert.deepEqual(current.restoration, { threadId: 'restored-thread' });
  });
  assert.equal(forks, 1);
  assert.equal(recall.get(KEY), undefined);
});

test('review: restoration keeps replacement locked until commit completes', async () => {
  const { recall, begin } = fixture();
  const turn = begin();
  const committing = deferred();
  const entered = deferred();
  await recall.attach(KEY, { interrupt: async () => recall.settle(KEY, turn) });
  const operation = recall.recall(KEY, ids(turn), async () => ({}), async () => {
    entered.resolve();
    await committing.promise;
  });
  await entered.promise;
  assert.throws(() => begin('replacement'), { status: 409 });
  committing.resolve();
  await operation;
  assert.equal(begin('replacement').requestId, 'replacement');
});

test('review: an unresponsive interrupt is bounded, keeps exchange, and never restores', async () => {
  const { recall, begin } = fixture({ settleTimeoutMs: 15 });
  const turn = begin();
  let restores = 0, commits = 0;
  await recall.attach(KEY, { interrupt: () => new Promise(() => {}) });
  const operation = recall.recall(KEY, ids(turn), async () => { restores++; }, async () => { commits++; });
  let deadline;
  const outcome = await Promise.race([
    operation.then(() => 'unexpected success', err => err),
    new Promise(resolve => { deadline = setTimeout(() => resolve('test deadline exceeded'), 150); }),
  ]);
  clearTimeout(deadline);
  assert.equal(outcome?.status, 504, `provider interrupt did not time out: ${String(outcome)}`);
  assert.equal(restores, 0);
  assert.equal(commits, 0);
  assert.notEqual(turn.phase, 'recalled');
  assert.throws(() => begin('replacement'), { status: 409 }, 'still-live provider must keep its slot');
});

test('review: synchronous acceptance failure can retry without a cached rejected promise', async () => {
  const { recall, begin } = fixture();
  const turn = begin();
  await recall.attach(KEY, { interrupt: async () => recall.settle(KEY, turn) });
  await assert.rejects(recall.recall(KEY, ids(turn), async () => ({}), async () => ({}), () => {
    throw new Error('intent persistence failed');
  }), /intent persistence failed/);
  let committed = false;
  await recall.recall(KEY, ids(turn), async () => ({}), async () => { committed = true; });
  assert.equal(committed, true);
  assert.equal(recall.get(KEY), undefined);
});

test('review: rejected provider interruption can be retried and does not deadlock Stop', async () => {
  const { recall, begin } = fixture();
  const turn = begin();
  let interruptions = 0;
  await recall.attach(KEY, { interrupt: async () => {
    interruptions++;
    if (interruptions === 1) throw new Error('transient transport failure');
    recall.settle(KEY, turn);
  } });
  await assert.rejects(recall.recall(KEY, ids(turn), async () => ({}), async () => ({})), /transient transport/);
  await recall.recall(KEY, ids(turn), async () => ({}), async () => ({}));
  assert.equal(interruptions, 2);
  assert.equal(turn.phase, 'recalled');
});

test('review: latched prep interrupt failure is not mistaken for a successful cancellation', async () => {
  const { recall, begin } = fixture();
  const turn = begin();
  let restores = 0, commits = 0;
  const operation = recall.recall(KEY, ids(turn), async () => { restores++; }, async () => { commits++; });
  // Allow recall to enter its wait before the late provider attachment.
  await Promise.resolve();
  const failure = assert.rejects(operation, /latched interruption failed/);
  await assert.rejects(recall.attach(KEY, { interrupt: async () => {
    throw new Error('latched interruption failed');
  } }), /latched interruption failed/);
  recall.settle(KEY, turn); // natural completion can arrive after failure
  await failure;
  assert.equal(restores, 0);
  assert.equal(commits, 0);
  assert.notEqual(turn.phase, 'recalled');
});

test('review: durable restored receipt recovers a locked task without dispatching or forking', async () => {
  const { recall, begin } = fixture();
  const receipt = { turnId: 'before-restart-turn', requestId: 'before-restart-request',
    provider: 'claude', prompt: 'Exact recovered prompt', startedAt: '1970-01-01T00:00:00Z',
    recallUntil: '1970-01-01T00:00:05Z', restoration: { provider: 'claude', sdkSessionId: 'restored-session' } };
  recall.recover(KEY, receipt);
  assert.throws(() => begin('replacement'), { status: 409 });
  assert.equal(recall.state(KEY).phase, 'recall-recovery');
  let forks = 0;
  await recall.recall(KEY, ids(receipt), async () => { forks++; }, async turn => {
    assert.deepEqual(turn.restoration, receipt.restoration);
    assert.equal(turn.prompt, receipt.prompt);
  });
  assert.equal(forks, 0);
  assert.equal(recall.state(KEY), null);
});
