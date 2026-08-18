// test/decisions.test.mjs — the decisions ledger + standing note (packet-
// honesty release, 2026-08-07) and its injection into the per-turn appendix
// and the turn-1 context packet.
//
// Three layers, all billing-safe:
//   1. lib/decisions.js imported directly against a temp CP_ROOT (its only
//      heavy dep is events.js, whose broadcast no-ops before initWss).
//   2. sessions.js privates (oversightAppendix, buildContextPacket) run via
//      the loadPrivateFns/extractFunction pattern — the REAL source text with
//      injected deps, never importing the Agent SDK.
//   3. The REST routes + snapshot key through the sandboxed server harness.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp, loadPrivateFns, extractFunction, APP_DIR } from './helpers.mjs';

// env BEFORE the dynamic import — config.js reads it at module load
const TMP_ROOT = mkTmp('cp-decisions-');
process.env.CP_ROOT = TMP_ROOT;
process.env.CP_PROJECTS_JSON = JSON.stringify({
  alpha: { name: 'alpha', root: path.join(TMP_ROOT, 'proj-alpha'), color: '#aabbcc', texWatch: null },
  beta: { name: 'beta', root: path.join(TMP_ROOT, 'proj-beta'), color: '#aabbcc', texWatch: null },
});
const dec = await import('../lib/decisions.js');

after(() => rmTmp(TMP_ROOT));

const DAY = 86_400_000;

describe('decisions store', () => {
  test('unknown project throws; absent file reads empty', () => {
    assert.throws(() => dec.getDecisions('nope'), /unknown project/);
    assert.deepEqual(dec.getDecisions('alpha'), { standing: '', entries: [] });
  });

  test('addDecision persists atomically, defaults bad scope to all, rejects empty text', () => {
    const e = dec.addDecision('alpha', { text: '  No em-dashes in prose.  ', scope: 'prose', source: 'task-011 #14' });
    assert.equal(e.text, 'No em-dashes in prose.');
    assert.equal(e.scope, 'prose');
    assert.equal(e.status, 'active');
    const weird = dec.addDecision('alpha', { text: 'Rule two', scope: 'poetry' });
    assert.equal(weird.scope, 'all');
    assert.throws(() => dec.addDecision('alpha', { text: '   ' }), /text required/);
    // on disk, valid JSON, no tmp file left behind
    const file = path.join(TMP_ROOT, 'decisions', 'alpha.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.entries.length, 2);
    assert.ok(!fs.existsSync(`${file}.tmp`));
  });

  test('retireDecision keeps the entry as an audit trail; unknown id throws', () => {
    const e = dec.addDecision('beta', { text: 'Temporary rule' });
    const r = dec.retireDecision('beta', e.id);
    assert.equal(r.status, 'retired');
    assert.ok(r.retired);
    const { entries } = dec.getDecisions('beta');
    assert.equal(entries.length, 1); // never hard-deleted
    assert.throws(() => dec.retireDecision('beta', 'd-nope'), /not found/);
  });

  test('setStanding round-trips and trims', () => {
    dec.setStanding('beta', '  Drafts, not edits.  ');
    assert.equal(dec.getDecisions('beta').standing, 'Drafts, not edits.');
  });

  test('corrupt ledger file reads as empty instead of throwing', () => {
    const file = path.join(TMP_ROOT, 'decisions', 'beta.json');
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(dec.getDecisions('beta'), { standing: '', entries: [] });
  });

  test('active cap enforced at 100', () => {
    for (let i = dec.getDecisions('alpha').entries.filter((e) => e.status === 'active').length; i < 100; i++) {
      dec.addDecision('alpha', { text: `Filler rule ${i}` });
    }
    assert.throws(() => dec.addDecision('alpha', { text: 'One too many' }), /cap reached/);
    // retire one → adding works again
    const active = dec.getDecisions('alpha').entries.find((e) => e.status === 'active');
    dec.retireDecision('alpha', active.id);
    assert.ok(dec.addDecision('alpha', { text: 'Fits now' }).id);
  });
});

describe('formatters', () => {
  test('empty ledger formats to empty string; projectAppendix stays concat-safe', () => {
    assert.equal(dec.formatDecisionsAppendix({ standing: '', entries: [] }), '');
    assert.equal(dec.formatDecisionsAppendix(), '');
    assert.equal(dec.projectAppendix('beta') === '' || dec.projectAppendix('beta').startsWith('\n\n'), true);
  });

  test('standing note and active entries render; retired entries do not', () => {
    const out = dec.formatDecisionsAppendix({
      standing: 'Drafts, not edits.',
      entries: [
        { id: 'a', text: 'No em-dashes.', scope: 'prose', status: 'active' },
        { id: 'b', text: 'Old rule.', scope: 'all', status: 'retired' },
      ],
    });
    assert.match(out, /Standing note from the user/);
    assert.match(out, /Drafts, not edits\./);
    assert.match(out, /Project decisions .*OVERRIDE defaults/);
    assert.match(out, /- \[prose\] No em-dashes\./);
    assert.ok(!out.includes('Old rule.'));
  });

  test('over budget: OLDEST entries drop first and the omission is stated', () => {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      entries.push({ id: `e${i}`, text: `Rule number ${i} ${'x'.repeat(90)}`, scope: 'all', status: 'active' });
    }
    const out = dec.formatDecisionsAppendix({ standing: '', entries });
    assert.ok(!out.includes('Rule number 0 '), 'oldest rule should be dropped');
    assert.ok(out.includes('Rule number 39 '), 'newest rule must survive');
    assert.match(out, /older decisions? omitted/);
  });

  test('staleAbstractNote: fresh or unknown is silent, 21+ days annotates', () => {
    const now = Date.now();
    assert.equal(dec.staleAbstractNote(null, now), '');
    assert.equal(dec.staleAbstractNote(now - 5 * DAY, now), '');
    assert.equal(dec.staleAbstractNote(now + DAY, now), ''); // clock skew → silent
    const note = dec.staleAbstractNote(now - 30 * DAY, now);
    assert.match(note, /last edited 30 days ago/);
    assert.match(note, /trust those/);
  });
});

// ---------------------------------------------------------------------------
// sessions.js privates — real source, injected deps
// ---------------------------------------------------------------------------
const SESSIONS = path.join(APP_DIR, 'lib', 'sessions.js');

describe('oversightAppendix (real source)', () => {
  const { oversightAppendix } = loadPrivateFns(SESSIONS,
    ['oversightAppendix', 'providerOf', 'OVERSIGHT_APPENDIX', 'COOP_FIRST_TURN_APPENDIX', 'AGENT_TEAM_APPENDIX'],
    { DEFAULT_PROVIDER: 'claude', projectAppendix: dec.projectAppendix });

  test('coop turn 2+ carries the drafts-not-edits protocol every turn', () => {
    const out = oversightAppendix({ oversight: 'coop', session: { sdkSessionId: 'x' }, project: 'beta' });
    assert.match(out, /COOPERATIVE mode/);
    assert.match(out, /Never edit documents or code unless the user has explicitly asked/);
    assert.match(out, /share drafts and proposals IN CHAT/);
  });

  test('coop first turn keeps the align-first steer', () => {
    const out = oversightAppendix({ oversight: 'coop', session: null, project: 'beta' });
    assert.match(out, /FIRST exchange/);
    assert.match(out, /align on the plan first/);
  });

  test('project decisions ride the appendix for both providers; agent-team text is Claude-only', () => {
    fs.rmSync(path.join(TMP_ROOT, 'decisions', 'beta.json'), { force: true });
    dec.addDecision('beta', { text: 'Say rescaling, never deflation.', scope: 'all' });
    const claude = oversightAppendix({ oversight: 'auto', session: null, project: 'beta' });
    assert.match(claude, /AUTOPILOT mode/);
    assert.match(claude, /Say rescaling, never deflation\./);
    assert.match(claude, /Agent teams:/);
    const codex = oversightAppendix({ oversight: 'auto', session: null, provider: 'codex', project: 'beta' });
    assert.match(codex, /Say rescaling, never deflation\./);
    assert.ok(!codex.includes('Agent teams:'));
  });

  test('a broken ledger never breaks the appendix', () => {
    const out = oversightAppendix({ oversight: 'auto', session: null, project: 'not-a-project' });
    assert.match(out, /AUTOPILOT mode/); // projectAppendix swallowed the throw
  });
});

describe('buildContextPacket (real source)', () => {
  // async fn: extractFunction drops the `async` keyword (it slices from
  // `function`), so re-prefix it before evaluation.
  const packetSrc = 'async ' + extractFunction(SESSIONS, 'buildContextPacket');
  function makePacketFn(overrides = {}) {
    const deps = {
      getCategories: () => ({ calibration: { primer: 'Calibration primer text.' } }),
      getAbstractInfo: () => ({ text: 'Abstract body.', mtimeMs: Date.now() - 30 * DAY }),
      getTask: () => null,
      listTasks: () => [],
      transcriptFor: () => [],
      keyOf: (p, id) => `${p}/${id}`,
      isExternalPin: () => false,
      pinKind: () => 'code',
      pinCard: async () => ({ card: '' }),
      externalPinLines: () => [],
      logErr: () => {},
      PROTOCOL_FOOTER: '--- Protocol ---\nFOOTER',
      staleAbstractNote: dec.staleAbstractNote,
      ...overrides,
    };
    const names = Object.keys(deps);
    const factory = new Function(...names, `${packetSrc}\nreturn buildContextPacket;`);
    return factory(...names.map((k) => deps[k]));
  }

  test('a stale abstract is annotated in the packet', async () => {
    const build = makePacketFn();
    const packet = await build('alpha', { id: 't1', title: 'T', category: 'calibration', context: {} });
    assert.match(packet, /## Living abstract \(alpha\)/);
    assert.match(packet, /last edited 30 days ago and may be stale/);
    assert.match(packet, /--- Protocol ---/);
  });

  test('a fresh abstract carries no staleness note', async () => {
    const build = makePacketFn({ getAbstractInfo: () => ({ text: 'Abstract body.', mtimeMs: Date.now() - DAY }) });
    const packet = await build('alpha', { id: 't1', title: 'T', context: {} });
    assert.match(packet, /Abstract body\./);
    assert.ok(!packet.includes('may be stale'));
  });
});

// ---------------------------------------------------------------------------
// REST routes + snapshot, against the sandboxed server
// ---------------------------------------------------------------------------
describe('decisions API', () => {
  let sb;
  before(async () => {
    const { startSandbox } = await import('./serverHarness.mjs');
    sb = await startSandbox();
  });
  after(async () => { if (sb) await sb.stop(); });

  test('empty ledger, add, snapshot, standing, retire — full round trip', async () => {
    const empty = await sb.fetchJson('GET', '/api/decisions/alpha');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { standing: '', entries: [] });

    const posted = await sb.fetchJson('POST', '/api/decisions/alpha', {
      text: 'No em-dashes in drafted prose.', scope: 'prose', source: 'test',
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.scope, 'prose');

    const snap = await sb.fetchJson('GET', '/api/state');
    assert.equal(snap.body.decisions.alpha.entries.length, 1);

    const standing = await sb.fetchJson('PATCH', '/api/decisions/alpha', { standing: 'Drafts, not edits.' });
    assert.equal(standing.status, 200);
    assert.equal(standing.body.standing, 'Drafts, not edits.');

    const retired = await sb.fetchJson('DELETE', `/api/decisions/alpha/${posted.body.id}`);
    assert.equal(retired.status, 200);
    assert.equal(retired.body.status, 'retired');

    const final = await sb.fetchJson('GET', '/api/decisions/alpha');
    assert.equal(final.body.entries[0].status, 'retired');
    assert.equal(final.body.standing, 'Drafts, not edits.');
  });

  test('guards: unknown project 4xx, empty text 4xx, unknown id 4xx', async () => {
    const bad = await sb.fetchJson('GET', '/api/decisions/nope');
    assert.ok(bad.status >= 400 && bad.status < 500);
    const noText = await sb.fetchJson('POST', '/api/decisions/alpha', { scope: 'prose' });
    assert.ok(noText.status >= 400 && noText.status < 500);
    const noId = await sb.fetchJson('DELETE', '/api/decisions/alpha/d-missing');
    assert.ok(noId.status >= 400 && noId.status < 500);
  });
});
