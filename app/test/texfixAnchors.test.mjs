// test/texfixAnchors.test.mjs — S0 unit gate for the texfix anchoring engine
// (latex/texfixAnchors.js, blueprint §2 texfix row / P6 / C1-MF4):
//   · tracks an edit ABOVE the match (range shifts, anchor stays)
//   · edit INSIDE the match → stale + one re-find + the 5.2s grace → 'stale'
//   · undo restoring the text → re-anchor, grace canceled
//   · the SYNCHRONOUS apply-time guard refuses on any mismatch — the
//     wrong-text-replacement race is structurally impossible
//   · ambiguity (2 matches) flagged, first match keeps indexOf parity
// Ranges are opaque host tokens (DI): a fake offset-based document stands in
// for the S2 Monaco model+decorations host. Timers are injected and fired by
// hand. Node-only, zero app imports, no billed surface.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTexfixAnchors, STALE_GRACE_MS, REVALIDATE_DEBOUNCE_MS,
} from '../public/latex/texfixAnchors.js';

/* ── fake host: offset ranges + decoration-style tracking ── */

class FakeDoc {
  constructor(text) {
    this.text = text;
    this.tracked = new Map(); // handle → {start, end} | null (invalidated)
    this.nextHandle = 1;
  }
  edit(start, end, insert) {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
    const delta = insert.length - (end - start);
    for (const [h, r] of this.tracked) {
      if (!r) continue;
      if (r.end <= start) continue; // fully above the edit (in offset order)
      if (r.start >= end) { this.tracked.set(h, { start: r.start + delta, end: r.end + delta }); continue; }
      // overlapping edit: the tracked span absorbs the delta (sticky-decoration-ish)
      this.tracked.set(h, { start: r.start, end: Math.max(r.start, r.end + delta) });
    }
  }
  findMatches(t, limit) {
    const out = [];
    let from = 0;
    while (out.length < limit) {
      const i = this.text.indexOf(t, from);
      if (i < 0) break;
      out.push({ start: i, end: i + t.length });
      from = i + 1;
    }
    return out;
  }
  getValueInRange(r) { return this.text.slice(r.start, r.end); }
  track(r) { const h = this.nextHandle++; this.tracked.set(h, { ...r }); return h; }
  rangeOf(h) { return this.tracked.get(h) ?? null; }
  untrack(h) { this.tracked.delete(h); }
  applyEdit(r, text) { this.edit(r.start, r.end, text); }
}

/* ── fake timers ── */

function fakeTimers() {
  let seq = 0;
  const pending = new Map(); // id → {fn, ms}
  return {
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => pending.delete(id),
    fire(pred = () => true) {
      for (const [id, t] of [...pending]) {
        if (!pred(t)) continue;
        pending.delete(id);
        t.fn();
      }
    },
    pending,
  };
}

const TEXT = 'Intro line.\n\\alpha + \\betta = 1\nMiddle prose.\nThe end.\n';
const SUG = { id: 's1', find: '\\betta', replace: '\\beta' };

let doc, timers, events, engine;
const wire = (text = TEXT) => {
  doc = new FakeDoc(text);
  timers = fakeTimers();
  events = [];
  engine = createTexfixAnchors(doc, {
    onStale: (id) => events.push(['stale', id]),
    onReanchor: (id) => events.push(['reanchor', id]),
    onResolve: (id, reason) => events.push(['resolve', id, reason]),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
};
beforeEach(() => wire());

describe('arm', () => {
  test('locates once, tracks, exposes the range', () => {
    const r = engine.arm(SUG);
    assert.deepEqual(r, { ok: true, ambiguous: false });
    const st = engine.state('s1');
    assert.equal(st.status, 'anchored');
    assert.equal(doc.getValueInRange(st.range), '\\betta');
  });

  test('two occurrences → ambiguous flag, FIRST match anchored (indexOf parity)', () => {
    wire(TEXT + 'again \\betta here\n');
    const r = engine.arm(SUG);
    assert.deepEqual(r, { ok: true, ambiguous: true });
    assert.equal(engine.state('s1').range.start, TEXT.indexOf('\\betta'));
  });

  test('miss → stale immediately, grace armed at 5.2s', () => {
    const r = engine.arm({ id: 'x', find: 'not present', replace: 'y' });
    assert.deepEqual(r, { ok: false, reason: 'not-found' });
    assert.deepEqual(events, [['stale', 'x']]);
    assert.equal([...timers.pending.values()][0].ms, STALE_GRACE_MS);
    timers.fire();
    assert.deepEqual(events.at(-1), ['resolve', 'x', 'stale']);
    assert.equal(engine.state('x'), null);
  });
});

describe('revalidation', () => {
  test('tracks an edit ABOVE: range shifts, anchor stays, no callbacks', () => {
    engine.arm(SUG);
    const before = engine.state('s1').range.start;
    doc.edit(0, 0, '% a new first line\n');
    engine.revalidateNow();
    const st = engine.state('s1');
    assert.equal(st.status, 'anchored');
    assert.equal(st.range.start, before + '% a new first line\n'.length);
    assert.deepEqual(events, []);
  });

  test('edit INSIDE → stale + grace → resolve(stale) after 5.2s', () => {
    engine.arm(SUG);
    const at = doc.text.indexOf('\\betta');
    doc.edit(at + 2, at + 3, 'X'); // \beXta — corrupt the match
    engine.revalidateNow();
    assert.deepEqual(events, [['stale', 's1']]);
    assert.equal(engine.state('s1').status, 'stale');
    timers.fire();
    assert.deepEqual(events.at(-1), ['resolve', 's1', 'stale']);
  });

  test('undo inside the grace → re-anchor, grace canceled', () => {
    engine.arm(SUG);
    const at = doc.text.indexOf('\\betta');
    doc.edit(at + 2, at + 3, 'X');
    engine.revalidateNow();
    assert.equal(engine.state('s1').status, 'stale');
    doc.edit(at + 2, at + 3, 'e'); // undo: restore \betta
    engine.revalidateNow();
    assert.deepEqual(events.at(-1), ['reanchor', 's1']);
    assert.equal(engine.state('s1').status, 'anchored');
    timers.fire(); // nothing left to fire — grace was canceled
    assert.ok(!events.some((e) => e[0] === 'resolve'), 'no stale resolution after re-anchor');
  });

  test('a corrupted anchor whose text re-appears ELSEWHERE re-finds it on the spot', () => {
    wire(TEXT);
    engine.arm(SUG);
    const at = doc.text.indexOf('\\betta');
    doc.edit(at, at + 6, '\\gamma'); // destroy the original…
    doc.edit(doc.text.length, doc.text.length, 'tail \\betta\n'); // …text exists later
    engine.revalidateNow();
    // one stale ping, then the immediate re-find re-anchors at the new spot
    assert.deepEqual(events, [['stale', 's1'], ['reanchor', 's1']]);
    assert.equal(engine.state('s1').status, 'anchored');
    assert.equal(doc.getValueInRange(engine.state('s1').range), '\\betta');
  });

  test('revalidate() debounces at ~120ms', () => {
    engine.arm(SUG);
    engine.revalidate();
    engine.revalidate();
    const debounces = [...timers.pending.values()].filter((t) => t.ms === REVALIDATE_DEBOUNCE_MS);
    assert.equal(debounces.length, 1, 'coalesced to one pending pass');
    const at = doc.text.indexOf('\\betta');
    doc.edit(at + 2, at + 3, 'X');
    timers.fire((t) => t.ms === REVALIDATE_DEBOUNCE_MS);
    assert.deepEqual(events, [['stale', 's1']]);
  });
});

describe('the synchronous apply-time guard (C1-MF4)', () => {
  test('clean apply: replaces exactly the anchored text, resolves applied', () => {
    engine.arm(SUG);
    assert.deepEqual(engine.apply('s1'), { ok: true });
    assert.ok(doc.text.includes('\\alpha + \\beta = 1'));
    assert.ok(!doc.text.includes('\\betta'));
    assert.deepEqual(events, [['resolve', 's1', 'applied']]);
    assert.equal(engine.state('s1'), null);
  });

  test('REFUSES when the range text has drifted — nothing is edited', () => {
    engine.arm(SUG);
    const at = doc.text.indexOf('\\betta');
    doc.edit(at + 2, at + 3, 'X'); // corrupt WITHOUT any revalidate pass
    const snapshot = doc.text;
    const r = engine.apply('s1');
    assert.equal(r.ok, false);
    assert.equal(doc.text, snapshot, 'guard refused: the document is untouched');
    assert.ok(!events.some((e) => e[0] === 'resolve' && e[2] === 'applied'));
  });

  test('mismatch with the text intact elsewhere: one sync re-find, re-anchor, still refuse', () => {
    wire(TEXT + 'later \\betta again\n');
    engine.arm(SUG);
    const at = doc.text.indexOf('\\betta');
    doc.edit(at, at + 6, '\\gamma'); // the anchored copy dies; the later one remains
    const r = engine.apply('s1');
    assert.deepEqual(r, { ok: false, reason: 'moved' });
    // …but the re-anchor makes an immediate retry safe:
    assert.equal(engine.state('s1').status, 'anchored');
    assert.deepEqual(engine.apply('s1'), { ok: true });
    assert.ok(doc.text.includes('later \\beta again'));
  });

  test('unknown id refuses', () => {
    assert.deepEqual(engine.apply('nope'), { ok: false, reason: 'unknown' });
  });
});

describe('lifecycle', () => {
  test('external resolve cleans up without an onResolve echo', () => {
    engine.arm(SUG);
    engine.resolve('s1', 'dismissed');
    assert.equal(engine.state('s1'), null);
    assert.deepEqual(events, []);
  });

  test('re-arm replaces the previous anchor silently', () => {
    engine.arm(SUG);
    engine.arm(SUG);
    assert.deepEqual(engine.ids(), ['s1']);
    assert.equal(doc.tracked.size, 1, 'old handle untracked');
  });

  test('dispose clears every timer and anchor', () => {
    engine.arm(SUG);
    engine.arm({ id: 's2', find: 'missing', replace: 'x' }); // grace running
    engine.revalidate(); // debounce running
    engine.dispose();
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(engine.ids(), []);
  });
});
