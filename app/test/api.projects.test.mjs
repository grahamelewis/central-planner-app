// Project registry over REST — the Manage Projects tab's create/rename/status
// designation feature (lib/projectStore.js + POST /api/projects + PATCH
// /api/projects/:key). Covers the status field & its defaults, create success /
// path-validation / key-slug-uniqueness, name & status patches with an immutable
// key, and config.json persistence that preserves sibling blocks
// (user/notifications/port/etc.). The second half covers pinned projects
// (pinOrder / PUT /api/projects/pins / snapshot.pinned) — see the "pins"
// banner below. Never launches or messages (no billed calls).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startSandbox } from './serverHarness.mjs';

let sb;
// Seed config.json with sibling blocks BEFORE boot so we can prove persist()
// rewrites only `projects` and leaves user/notifications/port/etc. untouched.
// (CP_PROJECTS_JSON still drives the live PROJECTS, so the stale on-disk
// `projects` here is expected to be overwritten, not merged.)
const PRESERVE = {
  port: 9999,
  weeklyHourTarget: 12,
  user: { name: 'Test Person' },
  notifications: { ntfyTopic: 'keep-me-secret', ntfyDetail: true },
  projects: { staleFromDisk: { name: 'should be replaced by live PROJECTS' } },
};
before(async () => {
  sb = await startSandbox({
    seed: async ({ root }) => {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(PRESERVE, null, 2) + '\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

const readConfig = () => JSON.parse(fs.readFileSync(path.join(sb.root, 'config.json'), 'utf8'));

test('GET /api/state exposes a status field (default active) and no trial field', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  for (const key of ['alpha', 'beta']) {
    const p = body.projects[key];
    assert.ok(p, `${key} present in state`);
    assert.equal(p.status, 'active', `${key} defaults to active`);
    assert.ok(!('trial' in p), `${key} no longer emits a trial field`);
  }
});

test('POST /api/projects creates a project, returns 201 + {key, project}, slug key', async () => {
  const root = os.tmpdir(); // a definitely-existing directory
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'New Proj', root, color: '#abcdef', status: 'active',
  });
  assert.equal(status, 201);
  assert.equal(body.key, 'new_proj', 'key is a slug of the name');
  assert.equal(body.project.name, 'New Proj');
  assert.equal(body.project.color, '#abcdef');
  assert.equal(body.project.status, 'active');
  assert.equal(body.project.root, path.resolve(root));

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok('new_proj' in state.projects, 'new project shows up in /api/state');
  assert.equal(state.projects.new_proj.status, 'active');
});

test('POST /api/projects with a nonexistent root path is rejected 400', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Ghost', root: '/no/such/path/anywhere',
  });
  assert.equal(status, 400);
  assert.match(body.error, /path does not exist/i);
});

test('POST /api/projects defaults status to active and color to a sensible fallback', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Defaulty', root: os.tmpdir(),
  });
  assert.equal(status, 201);
  assert.equal(body.project.status, 'active', 'status defaults to active');
  assert.match(body.project.color, /^#[0-9a-fA-F]{3,8}$/, 'a default color is applied');
});

test('a duplicate name mints a distinct, suffixed key (no clobber)', async () => {
  const { body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'New Proj', root: os.tmpdir(),
  });
  assert.notEqual(body.key, 'new_proj', 'second "New Proj" gets a unique key');
  assert.match(body.key, /^new_proj_\d+$/, 'suffix disambiguates the slug');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok('new_proj' in state.projects, 'original survives');
  assert.ok(body.key in state.projects, 'duplicate survives under its own key');
});

test('frontend view names are reserved — "Settings" never mints the key `settings`', async () => {
  // 'ov'/'cats'/'manage'/'about'/'settings' are view keys in the frontend
  // router; a project minted under one of them would shadow that view
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Settings', root: os.tmpdir(),
  });
  assert.equal(status, 201);
  assert.match(body.key, /^settings_\d+$/, 'reserved slug gets a suffix');
});

test('POST /api/projects with no name is rejected 400', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', { root: os.tmpdir() });
  assert.equal(status, 400);
  assert.match(body.error, /name is required/i);
});

test('PATCH renames the display name while the key stays immutable', async () => {
  const { status, body } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { name: 'Renamed' });
  assert.equal(status, 200);
  assert.equal(body.key, 'new_proj', 'returned key is unchanged');
  assert.equal(body.project.name, 'Renamed');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.equal(state.projects.new_proj.name, 'Renamed');
  assert.ok('new_proj' in state.projects, 'key survived the rename');
});

test('PATCH updates status to a valid designation', async () => {
  const { status, body } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'inactive' });
  assert.equal(status, 200);
  assert.equal(body.project.status, 'inactive');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.equal(state.projects.new_proj.status, 'inactive');

  // and back to trial — the nav trial tag is driven by this exact value
  const { body: trialed } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'trial' });
  assert.equal(trialed.project.status, 'trial');
});

test('PATCH error paths: invalid status 400, unknown key 404, empty name 400', async () => {
  const badStatus = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'bogus' });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.body.error, /invalid status/i);

  const unknown = await sb.fetchJson('PATCH', '/api/projects/does_not_exist', { name: 'x' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /unknown project/i);

  const emptyName = await sb.fetchJson('PATCH', '/api/projects/new_proj', { name: '   ' });
  assert.equal(emptyName.status, 400);
  assert.match(emptyName.body.error, /name cannot be empty/i);
});

test('config.json persists the new project AND preserves sibling top-level blocks', async () => {
  const cfg = readConfig();
  // sibling blocks the writer must never touch
  assert.equal(cfg.port, PRESERVE.port, 'port preserved');
  assert.equal(cfg.weeklyHourTarget, PRESERVE.weeklyHourTarget, 'weeklyHourTarget preserved');
  assert.deepEqual(cfg.user, PRESERVE.user, 'user block preserved');
  assert.deepEqual(cfg.notifications, PRESERVE.notifications, 'notifications block preserved');

  // the projects block reflects the live registry (seeded + created)
  assert.ok('new_proj' in cfg.projects, 'created project written to disk');
  assert.equal(cfg.projects.new_proj.status, 'trial', 'last patched status is on disk');
  assert.ok('alpha' in cfg.projects && 'beta' in cfg.projects, 'seeded projects written too');
  // the stale on-disk `projects` block is replaced by the live PROJECTS object
  assert.ok(!('staleFromDisk' in cfg.projects), 'stale disk-only project was overwritten');
});

// ───────────────────────────── pins (top bar) ─────────────────────────────
// State entering here (key order): alpha, beta, new_proj (trial), defaulty,
// new_proj_2, settings_2 — six visible, none has ever carried pinOrder, so
// the bar is DERIVED (first 7 visible in key order) and nothing is on disk.
const state = async () => (await sb.fetchJson('GET', '/api/state')).body;
const visibleKeys = (s) => Object.keys(s.projects).filter((k) => s.projects[k].status !== 'inactive');
const create = (name, extra = {}) => sb.fetchJson('POST', '/api/projects', { name, root: os.tmpdir(), ...extra });
const diskPins = () => Object.fromEntries(Object.entries(readConfig().projects)
  .map(([k, p]) => [k, 'pinOrder' in p ? p.pinOrder : 'absent']));

test('POST in derived mode: inactive is never pinned, the 7th visible lands on slot 7, the 8th on none — nothing written', async () => {
  const hidden = await create('Hidden', { status: 'inactive' });
  assert.equal(hidden.status, 201);
  assert.equal(hidden.body.key, 'hidden');
  assert.equal(hidden.body.pinOrder, null, 'inactive project is not pinned');

  const seven = await create('Seven');
  assert.equal(seven.body.pinOrder, 7, 'seventh visible project takes the last derived slot');

  const eight = await create('Eight');
  assert.equal(eight.body.pinOrder, null, 'no free slot → unpinned');

  for (const [k, v] of Object.entries(diskPins())) assert.equal(v, 'absent', `${k}: derivation never writes pinOrder`);
});

test('snapshot.pinned is derived from a status-only config: first 7 visible in key order; pinOrder mirrors it', async () => {
  const s = await state();
  const expected = visibleKeys(s).slice(0, 7);
  assert.deepEqual(s.pinned, expected);
  assert.equal(s.pinned.length, 7);
  assert.ok(!s.pinned.includes('hidden'), 'inactive never on the bar');
  assert.ok(!s.pinned.includes('eight'), 'the 8th visible project is off the bar');
  expected.forEach((k, i) => assert.equal(s.projects[k].pinOrder, i + 1, `${k} reports its derived slot`));
  assert.equal(s.projects.eight.pinOrder, null);
  assert.equal(s.projects.hidden.pinOrder, null);
});

test('the first explicit pin materialises the derived set, so the bar does not jump', async () => {
  const before = (await state()).pinned; // [alpha, beta, new_proj, defaulty, new_proj_2, settings_2, seven]
  const { status, body } = await sb.fetchJson('PATCH', '/api/projects/beta', { pinOrder: 1 });
  assert.equal(status, 200);
  assert.equal(body.pinOrder, 1);
  assert.equal(body.project.pinOrder, 1, 'the stored field is on the project too');

  const s = await state();
  assert.deepEqual(s.pinned, ['beta', ...before.filter((k) => k !== 'beta')], 'beta moved to slot 1, the rest kept their relative order');
  assert.deepEqual(new Set(s.pinned), new Set(before), 'same seven on the bar');

  const disk = diskPins();
  s.pinned.forEach((k, i) => assert.equal(disk[k], i + 1, `${k} slot ${i + 1} written`));
  assert.equal(disk.eight, null, 'the visible unpinned project carries an explicit null');
  assert.equal(disk.hidden, 'absent', 'inactive projects never carry the field');
});

test('pinOrder persists through PATCH and survives a rename / recolor', async () => {
  const renamed = await sb.fetchJson('PATCH', '/api/projects/beta', { name: 'Beta Renamed', color: '#123456' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.project.name, 'Beta Renamed');
  assert.equal(renamed.body.pinOrder, 1);
  const s = await state();
  assert.equal(s.projects.beta.pinOrder, 1);
  assert.equal(s.pinned[0], 'beta');
  assert.equal(diskPins().beta, 1, 'still slot 1 on disk');
});

test('PATCH pinOrder on an inactive key → 400; out-of-range or non-integer values → 400; a refused PATCH mutates nothing', async () => {
  const inactive = await sb.fetchJson('PATCH', '/api/projects/hidden', { pinOrder: 3 });
  assert.equal(inactive.status, 400);
  assert.match(inactive.body.error, /inactive/i);

  for (const bad of [0, 8, '2', 1.5, true]) {
    const r = await sb.fetchJson('PATCH', '/api/projects/beta', { pinOrder: bad });
    assert.equal(r.status, 400, `pinOrder ${JSON.stringify(bad)} refused`);
    assert.match(r.body.error, /invalid pinOrder/i);
  }

  // status and pin in one PATCH: the pin is checked against the NEW status,
  // and the refusal leaves the status untouched (no half-applied write)
  const combo = await sb.fetchJson('PATCH', '/api/projects/beta', { status: 'inactive', pinOrder: 2 });
  assert.equal(combo.status, 400);
  assert.match(combo.body.error, /inactive/i);
  const s = await state();
  assert.equal(s.projects.beta.status, 'active', 'status not applied by the refused PATCH');
  assert.equal(s.projects.beta.pinOrder, 1);
});

test('the 8th pin → 400 with the seven untouched', async () => {
  const before = await state();
  const r = await sb.fetchJson('PATCH', '/api/projects/eight', { pinOrder: 1 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /7 of 7 pinned/);
  const after = await state();
  assert.deepEqual(after.pinned, before.pinned, 'bar unchanged');
  assert.equal(after.projects.eight.pinOrder, null);
  assert.equal(diskPins().eight, null, 'nothing written');
});

test('status → inactive clears pinOrder in the same write; later slots close up; reactivating does not re-pin', async () => {
  const before = (await state()).pinned; // new_proj sits at slot 3
  assert.equal(before[2], 'new_proj');
  const r = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'inactive' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pinOrder, null);
  assert.ok(!('pinOrder' in r.body.project), 'the field is removed from the project');

  const s = await state();
  assert.deepEqual(s.pinned, before.filter((k) => k !== 'new_proj'));
  assert.equal(s.pinned.length, 6);
  assert.equal(s.projects.seven.pinOrder, 6, 'slot 7 closed up to 6');
  const disk = diskPins();
  assert.equal(disk.new_proj, 'absent');
  assert.equal(disk.seven, 6, 'renumbered on disk in the same write');

  const back = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'trial' });
  assert.equal(back.status, 200);
  assert.equal(back.body.pinOrder, null, 'coming back does not re-pin');
  assert.equal((await state()).pinned.length, 6);
});

test('POST takes the next free slot once the bar is explicit; none when full', async () => {
  const nine = await create('Nine');
  assert.equal(nine.status, 201);
  assert.equal(nine.body.pinOrder, 7);
  assert.equal(nine.body.project.pinOrder, 7);
  const s = await state();
  assert.equal(s.pinned[6], 'nine');
  assert.equal(diskPins().nine, 7);

  const ten = await create('Ten');
  assert.equal(ten.body.pinOrder, null, 'bar full → unpinned');
  assert.equal(diskPins().ten, 'absent', 'never pinned → no field');

  // an explicit slot on create is honoured (and refused like a PATCH when full)
  const full = await create('Eleven', { pinOrder: 1 });
  assert.equal(full.status, 400);
  assert.match(full.body.error, /7 of 7 pinned/);
  assert.ok(!('eleven' in (await state()).projects), 'refused create mints nothing');
  const unpinned = await create('Twelve', { pinOrder: null });
  assert.equal(unpinned.status, 201);
  assert.equal(unpinned.body.pinOrder, null);
});

test('PUT /api/projects/pins rejects 8 keys / an inactive key / an unknown key / duplicates / a non-array — bar untouched', async () => {
  const before = await state();
  const eightKeys = visibleKeys(before).slice(0, 8);
  assert.equal(eightKeys.length, 8);
  const cases = [
    [{ keys: eightKeys }, /at most 7/i],
    [{ keys: ['hidden'] }, /inactive/i],
    [{ keys: ['alpha', 'nope'] }, /unknown project 'nope'/i],
    [{ keys: ['alpha', 'alpha'] }, /duplicate key 'alpha'/i],
    [{ keys: 'alpha' }, /array/i],
    [{}, /array/i],
  ];
  for (const [body, re] of cases) {
    const r = await sb.fetchJson('PUT', '/api/projects/pins', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.deepEqual((await state()).pinned, before.pinned, 'no refusal moved anything');
});

test('a valid PUT rewrites slots 1..n and clears the rest in ONE broadcast', async (t) => {
  const ws = new WebSocket(sb.base.replace('http', 'ws') + '/ws');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  t.after(() => ws.close());
  // the hub greets a new client with a state frame — wait for it, then count
  await new Promise((res) => ws.once('message', res));
  const frames = [];
  ws.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'state') frames.push(m.payload); } catch { /* ignore */ } });

  const { status, body } = await sb.fetchJson('PUT', '/api/projects/pins', { keys: ['eight', 'alpha', 'beta'] });
  assert.equal(status, 200);
  assert.deepEqual(body.pinned, ['eight', 'alpha', 'beta']);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(frames.length, 1, 'exactly one state broadcast for the whole reorder');
  assert.deepEqual(frames[0].pinned, ['eight', 'alpha', 'beta']);

  const s = await state();
  assert.deepEqual(s.pinned, ['eight', 'alpha', 'beta']);
  assert.equal(s.projects.eight.pinOrder, 1);
  assert.equal(s.projects.alpha.pinOrder, 2);
  assert.equal(s.projects.beta.pinOrder, 3);
  const disk = diskPins();
  assert.equal(disk.eight, 1); assert.equal(disk.alpha, 2); assert.equal(disk.beta, 3);
  for (const k of ['defaulty', 'new_proj_2', 'settings_2', 'seven', 'nine', 'ten', 'new_proj', 'twelve']) {
    assert.equal(disk[k], null, `${k} explicitly unpinned`);
    assert.equal(s.projects[k].pinOrder, null);
  }
  assert.equal(disk.hidden, 'absent', 'inactive projects never carry the field');
});

test('PATCH pinOrder:n inserts at slot n and shifts later slots down; past the end appends', async () => {
  const mid = await sb.fetchJson('PATCH', '/api/projects/seven', { pinOrder: 2 });
  assert.equal(mid.status, 200);
  assert.equal(mid.body.pinOrder, 2);
  assert.deepEqual((await state()).pinned, ['eight', 'seven', 'alpha', 'beta']);

  const end = await sb.fetchJson('PATCH', '/api/projects/seven', { pinOrder: 7 });
  assert.equal(end.body.pinOrder, 4, 'a slot past the end lands on the last slot');
  assert.deepEqual((await state()).pinned, ['eight', 'alpha', 'beta', 'seven']);
  assert.equal(diskPins().seven, 4, 'contiguous 1..n on disk');
});

test('unpinning the last pinned project leaves the bar EMPTY — no fallback to the derived seven', async () => {
  const one = await sb.fetchJson('PUT', '/api/projects/pins', { keys: ['alpha'] });
  assert.deepEqual(one.body.pinned, ['alpha']);
  const r = await sb.fetchJson('PATCH', '/api/projects/alpha', { pinOrder: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.pinOrder, null);
  const s = await state();
  assert.deepEqual(s.pinned, []);
  assert.equal(diskPins().alpha, null, 'the explicit null is what keeps the bar from re-deriving');
  for (const p of Object.values(s.projects)) assert.equal(p.pinOrder, null);

  const none = await sb.fetchJson('PUT', '/api/projects/pins', { keys: [] });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.pinned, []);
});

test('concurrency: at 6 pinned, two simultaneous PATCH pins → exactly one 200 and one 400 (cap), slots contiguous 1..7', async () => {
  const six = await sb.fetchJson('PUT', '/api/projects/pins', { keys: ['alpha', 'beta', 'defaulty', 'new_proj_2', 'settings_2', 'seven'] });
  assert.equal(six.status, 200);
  assert.equal(six.body.pinned.length, 6);
  // both ask for the "append" slot the client sends (PIN_CAP) from the same stale count
  const [a, b] = await Promise.all([
    sb.fetchJson('PATCH', '/api/projects/eight', { pinOrder: 7 }),
    sb.fetchJson('PATCH', '/api/projects/nine', { pinOrder: 7 }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400], `one wins, one is refused (got ${a.status}/${b.status})`);
  const loser = a.status === 400 ? a : b;
  const winner = a.status === 200 ? a : b;
  assert.match(loser.body.error, /7 of 7 pinned/);
  assert.equal(winner.body.pinOrder, 7, 'the winner landed on the last slot');
  const s = await state();
  assert.equal(s.pinned.length, 7);
  assert.equal(new Set(s.pinned).size, 7, 'no duplicate');
  const disk = diskPins();
  const slots = s.pinned.map((k) => disk[k]);
  assert.deepEqual(slots, [1, 2, 3, 4, 5, 6, 7], 'contiguous on disk');
  assert.equal(disk[s.pinned.includes('eight') ? 'nine' : 'eight'], null, 'the loser is still unpinned');
});

test('a "//" comment string inside projects (config.example.json ships one) is never a project: not in pinned, pin writes still succeed, PATCH on it → 404', async () => {
  const sb2 = await startSandbox({ extraProjects: { '//': 'Keys are permanent identifiers — pick a short slug.' } });
  try {
    const s0 = (await sb2.fetchJson('GET', '/api/state')).body;
    assert.deepEqual(s0.pinned, ['alpha', 'beta'], 'the comment never holds a slot (derived mode)');
    assert.equal(s0.projects.alpha.pinOrder, 1);
    // the first explicit pin write walks every entry — it must skip the string instead of throwing
    const r = await sb2.fetchJson('PATCH', '/api/projects/beta', { pinOrder: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await sb2.fetchJson('GET', '/api/state')).body.pinned, ['beta', 'alpha']);
    const put = await sb2.fetchJson('PUT', '/api/projects/pins', { keys: ['alpha'] });
    assert.equal(put.status, 200);
    const bad = await sb2.fetchJson('PUT', '/api/projects/pins', { keys: ['//'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /unknown project/);
    const patch = await sb2.fetchJson('PATCH', '/api/projects/%2F%2F', { name: 'x' });
    assert.equal(patch.status, 404, 'not a project');
    const cfg = JSON.parse(fs.readFileSync(path.join(sb2.root, 'config.json'), 'utf8'));
    assert.equal(typeof cfg.projects['//'], 'string', 'the comment survives the write untouched');
    assert.equal(cfg.projects.alpha.pinOrder, 1);
    assert.equal(cfg.projects.beta.pinOrder, null);
  } finally {
    await sb2.stop();
  }
});
