// Server-owned turn identities and cancellation. No provider or filesystem IO.
import { randomUUID } from 'node:crypto';

export function turnError(status, message) { return Object.assign(new Error(message), { status }); }

export function publicTurn(turn) {
  if (!turn) return null;
  return { turnId: turn.turnId, requestId: turn.requestId, startedAt: turn.startedAt,
    recallUntil: turn.recallUntil, phase: turn.phase };
}

export function createTurnRecall({ now = Date.now, id = randomUUID, windowMs = 5000, settleTimeoutMs = 30000 } = {}) {
  const active = new Map();
  function begin(key, { requestId = null, prompt = '', provider, recallable = false } = {}) {
    if (active.has(key)) throw turnError(409, 'a turn is already running or being recalled');
    const started = now();
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const turn = { turnId: id(), requestId, prompt, provider, startedAt: new Date(started).toISOString(),
      recallUntil: recallable ? new Date(started + windowMs).toISOString() : null,
      phase: 'preparing', cancelRequested: false, settled: false, recalling: false,
      done, resolve, handle: null, interruptPromise: null, providerState: {} };
    active.set(key, turn);
    return turn;
  }
  function dispatchInterrupt(turn) {
    if (!turn.handle || turn.interruptPromise) return turn.interruptPromise || Promise.resolve();
    turn.interruptError = null;
    turn.interruptPromise = Promise.resolve().then(() => turn.handle.interrupt());
    // A cancellation latched during prep may dispatch without a waiting caller.
    const pending = turn.interruptPromise;
    pending.catch(err => {
      turn.interruptError = err;
      if (turn.interruptPromise === pending) turn.interruptPromise = null;
    });
    return turn.interruptPromise;
  }
  function attach(key, handle, expected = active.get(key)) {
    const turn = active.get(key);
    if (!turn || turn !== expected) throw turnError(409, 'turn no longer active');
    turn.handle = handle;
    if (!turn.recalling) turn.phase = 'running';
    if (turn.cancelRequested) return dispatchInterrupt(turn);
    return Promise.resolve();
  }
  function cancel(key) {
    const turn = active.get(key);
    if (!turn) return Promise.resolve();
    turn.cancelRequested = true;
    return dispatchInterrupt(turn);
  }
  function settle(key, turn = active.get(key)) {
    if (!turn || active.get(key) !== turn) return;
    turn.settled = true;
    if (!turn.recalling) turn.phase = 'settled';
    turn.resolve();
  }
  function finish(key, turn = active.get(key)) {
    if (active.get(key) === turn) active.delete(key);
  }
  async function wait(turn, cancellation = Promise.resolve()) {
    let timer;
    try {
      await Promise.race([Promise.all([turn.done, cancellation]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(turnError(504, 'the agent has not stopped yet; the exchange was kept')), settleTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function recall(key, ids, restore, commit, onAccepted = () => {}) {
    const turn = active.get(key);
    if (!turn || (!ids?.turnId && !ids?.requestId)
      || (ids.turnId && ids.turnId !== turn.turnId)
      || (ids.requestId && ids.requestId !== turn.requestId)) {
      throw turnError(409, 'that submitted turn is no longer active');
    }
    if (turn.recallPromise) return turn.recallPromise;
    // A failed local commit after successful provider restoration is retryable;
    // the task stays locked so divergent histories cannot start another turn.
    if (!turn.restored && (turn.settled || !turn.recallUntil || now() >= Date.parse(turn.recallUntil))) {
      throw turnError(409, 'Stop & Edit is available only during the first five seconds of an active message');
    }
    turn.recalling = true;
    turn.phase = 'recalling';
    turn.recallPromise = Promise.resolve().then(async () => {
      try {
        onAccepted(turn);
        if (!turn.restored) {
          await wait(turn, cancel(key).then(() => turn.done).then(() => {
            if (turn.interruptError) throw turn.interruptError;
            return turn.interruptPromise;
          }));
          turn.restoration = await restore(turn);
          turn.restored = true;
        }
        const result = await commit(turn);
        turn.phase = 'recalled';
        finish(key, turn);
        return result;
      } catch (err) {
        turn.recallPromise = null;
        if (turn.restored) {
          turn.phase = 'recall-recovery';
          // Keep recalling/active lock until the durable commit can be retried.
        } else {
          turn.recalling = false;
          turn.phase = turn.settled ? 'settled' : 'running';
          if (turn.settled) finish(key, turn);
        }
        throw err;
      }
    });
    return turn.recallPromise;
  }
  function recover(key, saved) {
    const turn = begin(key, { requestId: saved.requestId, prompt: saved.prompt, provider: saved.provider });
    Object.assign(turn, saved, { recalling: true, restored: true, settled: true, phase: 'recall-recovery' });
    turn.resolve();
    return turn;
  }
  return { begin, attach, cancel, settle, finish, wait, recall, recover, get: key => active.get(key),
    state: key => publicTurn(active.get(key)) };
}
