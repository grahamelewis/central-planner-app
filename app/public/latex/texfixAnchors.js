// latex/texfixAnchors.js — the texfix suggestion anchoring engine (Phase 3
// S0, blueprint §2 texfix row / P6; a REWRITE of the wireWB renderSugs/sugAt
// closures, not an extraction — seams doc delta #4).
//
// Pure and dependency-injected: ranges are OPAQUE host tokens, so the engine
// runs against a fake document in unit tests (test/texfixAnchors.test.mjs) and
// against a real Monaco model at S2, where the host wraps
//   findMatches(find, false, false, true, null, false, 2)  (literal, limit 2 —
//   the second hit only detects ambiguity; first-match keeps indexOf parity)
// and tracks ranges as decorations with stickiness NeverGrowsWhenTypingAtEdges.
//
// Lifecycle per suggestion id:
//   arm        locate once → anchored (ambiguous flagged) | miss → stale+grace
//   revalidate (debounced ~120ms off onDidChangeModelContent) anchored ranges
//              whose text drifted go stale (one immediate re-find first);
//              stale ones re-find each pass — undo restoring the text
//              re-anchors and cancels the grace timer
//   grace      5.2s after going stale → resolve('stale') via onResolve
//   apply      SYNCHRONOUS guard (§14 / C1-MF4): assert range text === find
//              immediately before the edit; on mismatch do ONE synchronous
//              re-find, then re-anchor (caller may retry — now safe) or mark
//              stale — either way THIS apply is refused. The wrong-text
//              replacement race is structurally impossible.
//
// Timers/clock are injectable for tests; defaults are the global ones.

'use strict';

export const STALE_GRACE_MS = 5200;
export const REVALIDATE_DEBOUNCE_MS = 120;

/**
 * @typedef {{ id: string | number, find: string, replace: string }} SugSpec
 * @typedef {{
 *   findMatches(text: string, limit: number): any[],
 *   getValueInRange(range: any): string,
 *   track(range: any): any,
 *   rangeOf(handle: any): any | null,
 *   untrack(handle: any): void,
 *   applyEdit(range: any, text: string): void,
 * }} AnchorHost
 * @typedef {{
 *   onStale?: (id: SugSpec['id']) => void,
 *   onReanchor?: (id: SugSpec['id']) => void,
 *   onResolve?: (id: SugSpec['id'], reason: string) => void,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 *   graceMs?: number,
 *   debounceMs?: number,
 * }} AnchorOpts
 */

/**
 * @param {AnchorHost} host
 * @param {AnchorOpts} [opts]
 */
export function createTexfixAnchors(host, opts = {}) {
  const graceMs = opts.graceMs ?? STALE_GRACE_MS;
  const debounceMs = opts.debounceMs ?? REVALIDATE_DEBOUNCE_MS;
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));

  /** @type {Map<SugSpec['id'], { sug: SugSpec, handle: any, status: 'anchored' | 'stale', ambiguous: boolean, graceTimer: any }>} */
  const anchors = new Map();
  let debounceTimer = null;

  /** @param {ReturnType<typeof anchors.get>} a */
  const dropHandle = (a) => {
    if (a && a.handle != null) { host.untrack(a.handle); a.handle = null; }
  };
  /** @param {NonNullable<ReturnType<typeof anchors.get>>} a */
  const cancelGrace = (a) => {
    if (a.graceTimer != null) { clearTimer(a.graceTimer); a.graceTimer = null; }
  };

  /** Terminal cleanup; `notify` fires onResolve (engine-initiated ends only). */
  const finish = (/** @type {SugSpec['id']} */ id, /** @type {string} */ reason, notify = true) => {
    const a = anchors.get(id);
    if (!a) return;
    cancelGrace(a);
    dropHandle(a);
    anchors.delete(id);
    if (notify) opts.onResolve?.(id, reason);
  };

  /** One re-find; on a hit re-anchor (cancels any grace). @returns {boolean} */
  const refind = (/** @type {NonNullable<ReturnType<typeof anchors.get>>} */ a) => {
    const hits = host.findMatches(a.sug.find, 2);
    if (!hits.length) return false;
    dropHandle(a);
    a.handle = host.track(hits[0]);
    a.ambiguous = hits.length > 1;
    const wasStale = a.status === 'stale';
    a.status = 'anchored';
    cancelGrace(a);
    if (wasStale) opts.onReanchor?.(a.sug.id);
    return true;
  };

  /** @param {NonNullable<ReturnType<typeof anchors.get>>} a */
  const goStale = (a) => {
    if (a.status === 'stale') return;
    a.status = 'stale';
    dropHandle(a);
    opts.onStale?.(a.sug.id);
    // one immediate re-find (§2: "mark-stale visuals + one re-find")…
    if (refind(a)) return;
    // …then the grace: undo has this long to bring the text back
    a.graceTimer = setTimer(() => { a.graceTimer = null; finish(a.sug.id, 'stale'); }, graceMs);
  };

  /** Is this anchor's tracked range still byte-exact? */
  const intact = (/** @type {NonNullable<ReturnType<typeof anchors.get>>} */ a) => {
    if (a.handle == null) return false;
    const r = host.rangeOf(a.handle);
    return r != null && host.getValueInRange(r) === a.sug.find;
  };

  function revalidateNow() {
    for (const a of anchors.values()) {
      if (a.status === 'anchored') {
        if (!intact(a)) goStale(a);
      } else if (!refind(a) && a.graceTimer == null) {
        // stale, still missing, and no grace running (arm-miss path) → start it
        a.graceTimer = setTimer(() => { a.graceTimer = null; finish(a.sug.id, 'stale'); }, graceMs);
      }
    }
  }

  return {
    /**
     * Locate a suggestion once and start tracking it.
     * @param {SugSpec} sug
     * @returns {{ ok: true, ambiguous: boolean } | { ok: false, reason: 'not-found' }}
     */
    arm(sug) {
      finish(sug.id, 'rearmed', false); // re-arm replaces silently
      /** @type {NonNullable<ReturnType<typeof anchors.get>>} */
      const a = { sug, handle: null, status: 'anchored', ambiguous: false, graceTimer: null };
      anchors.set(sug.id, a);
      const hits = host.findMatches(sug.find, 2);
      if (!hits.length) {
        a.status = 'stale';
        opts.onStale?.(sug.id);
        a.graceTimer = setTimer(() => { a.graceTimer = null; finish(sug.id, 'stale'); }, graceMs);
        return { ok: false, reason: 'not-found' };
      }
      a.handle = host.track(hits[0]);
      a.ambiguous = hits.length > 1;
      return { ok: true, ambiguous: a.ambiguous };
    },

    /** Debounced revalidation — call from every content change. */
    revalidate() {
      if (debounceTimer != null) clearTimer(debounceTimer);
      debounceTimer = setTimer(() => { debounceTimer = null; revalidateNow(); }, debounceMs);
    },

    /** Immediate revalidation (tests; flush points). */
    revalidateNow,

    /**
     * Apply a suggestion under the synchronous guard. Refuses unless the
     * tracked range STILL holds exactly `find` at call time.
     * @param {SugSpec['id']} id
     * @returns {{ ok: true } | { ok: false, reason: 'unknown' | 'moved' | 'stale' }}
     */
    apply(id) {
      const a = anchors.get(id);
      if (!a) return { ok: false, reason: 'unknown' };
      if (a.status === 'anchored' && intact(a)) {
        const r = host.rangeOf(a.handle);
        host.applyEdit(r, a.sug.replace);
        finish(id, 'applied');
        return { ok: true };
      }
      // guard tripped: one synchronous re-find, re-anchor or stale — refuse
      if (refind(a)) return { ok: false, reason: 'moved' };
      goStale(a);
      return { ok: false, reason: 'stale' };
    },

    /** External resolution (dismissed / superseded / applied elsewhere). */
    resolve(/** @type {SugSpec['id']} */ id, /** @type {string} */ reason) {
      finish(id, reason || 'resolved', false);
    },

    /** @param {SugSpec['id']} id */
    state(id) {
      const a = anchors.get(id);
      if (!a) return null;
      return {
        status: a.status,
        ambiguous: a.ambiguous,
        range: a.handle != null ? host.rangeOf(a.handle) : null,
      };
    },

    ids() { return [...anchors.keys()]; },

    dispose() {
      if (debounceTimer != null) { clearTimer(debounceTimer); debounceTimer = null; }
      for (const id of [...anchors.keys()]) finish(id, 'disposed', false);
    },
  };
}
