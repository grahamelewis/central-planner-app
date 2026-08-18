// The Δ tab redesign — seeing how Claude edits things:
//   · the file list: verb · name · edit count · ±lines · ⟲, grouped by folder
//   · click a file → the full inline unified diff (removed struck red, added
//     washed green, line numbers, long unchanged runs folded, expandable)
//   · the edit N/M ◀ ▶ stepper jumps between hunks
//   · the console strip's live "✎ N files changed … → Δ" line
//   · ⟲ rewind still round-trips (and its entry carries the new counts)
// Drives the real frontend in headless Chrome; skips without Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, task;
let extDir, extFile; // a granted external folder pin, outside the project root
const ENTRY = 'snp-delta-0';
const EXT_ENTRY = 'snp-delta-ext';
const EXT_BEFORE = 'a\nb\nc\n';
const EXT_AFTER = 'a\nX\nc\n';

// setup.jl: two edit hunks with a long unchanged stretch before, between-ish
// and after — exercises folds, line numbers, and the stepper
const FILLER = Array.from({ length: 8 }, (_, i) => `# filler ${i + 1}`).join('\n');
const TAIL = Array.from({ length: 9 }, (_, i) => `# tail ${i + 1}`).join('\n');
const SETUP_BEFORE = `using Pkg\nimport X\n${FILLER}\nfunction setup(p)\n    x = read(p)\n    grid = make(p)\n    return grid\nend\n${TAIL}\n`;
const SETUP_AFTER = `using Pkg\nimport X\n${FILLER}\nfunction setup(p)\n    x = load(p)\n    normalize!(x)\n    grid = make(p)\n    return (grid, x)\nend\n${TAIL}\n`;
const EQ_BEFORE = 'r = 0.04\n';
const EQ_AFTER = 'r = 0.04\nw = wage(r)\n';

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ root, projRoots }) => {
      // disk holds the AFTER states (what the "session" left behind)
      fs.mkdirSync(path.join(projRoots.alpha, 'model'), { recursive: true });
      fs.writeFileSync(path.join(projRoots.alpha, 'model', 'setup.jl'), SETUP_AFTER);
      fs.writeFileSync(path.join(projRoots.alpha, 'model', 'equilibrium.jl'), EQ_AFTER);
      fs.writeFileSync(path.join(projRoots.alpha, 'calib.jl'), 'c = 1\n'.repeat(3));
      // an external folder pin: inside the sandbox root, OUTSIDE the project
      extDir = path.join(root, 'extlib');
      extFile = path.join(extDir, 'shared.jl');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(extFile, EXT_AFTER);
      const snapDir = path.join(root, 'snapshots', 'alpha');
      fs.mkdirSync(path.join(snapDir, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(snapDir, 'journal.json'), JSON.stringify([{
        id: ENTRY,
        task: 'alp-001',
        ts: new Date().toISOString(),
        files: [
          { rel: 'model/setup.jl', status: 'modified', edits: 3, adds: 3, dels: 2 },
          { rel: 'model/equilibrium.jl', status: 'modified', edits: 1, adds: 1, dels: 0 },
          { rel: 'calib.jl', status: 'created', edits: 1, adds: 3, dels: 0 },
        ],
      }, {
        id: EXT_ENTRY,
        task: 'alp-001',
        ts: new Date(Date.now() - 60000).toISOString(),
        files: [
          { rel: extFile, status: 'modified', edits: 2, adds: 1, dels: 1, external: true },
        ],
      }], null, 2));
      const blob = (eid, i, side, txt) =>
        fs.writeFileSync(path.join(snapDir, 'blobs', `${eid}.${i}.${side}`), txt);
      blob(ENTRY, 0, 'before', SETUP_BEFORE); blob(ENTRY, 0, 'after', SETUP_AFTER);
      blob(ENTRY, 1, 'before', EQ_BEFORE); blob(ENTRY, 1, 'after', EQ_AFTER);
      blob(ENTRY, 2, 'after', 'c = 1\n'.repeat(3)); // created → no before blob
      blob(EXT_ENTRY, 0, 'before', EXT_BEFORE); blob(EXT_ENTRY, 0, 'after', EXT_AFTER);
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Refactor setup', description: 'Make it smooth.',
    // the external folder pin grants extDir — Δ tracking + rewind are gated on it
    category: 'calibration', oversight: 'coop', context: { files: [extDir + '/'] },
  });
  id = created.id;
  assert.equal(id, 'alp-001', 'journal fixture is keyed to the first task id');
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, { status: 'waiting' });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600); // ensureSnaps fetch lands + re-render
});
after(async () => { if (ui) await ui.stop(); });

const openDelta = async () => {
  await page.evaluate(() => {
    document.querySelector('#v-alpha .ctab[data-fi="snaps"]').click();
  });
  await sleep(250);
};

test('the Δ tab badge counts file changes and the list is grouped with counts', opts, async () => {
  const badge = await page.evaluate(() =>
    document.querySelector('#v-alpha .ctab[data-fi="snaps"]')?.textContent.trim() || '');
  assert.match(badge, /Δ\s*4/, 'badge = files changed across change-sets');
  await openDelta();

  const s = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('#v-alpha .dgrp')].map(e => e.textContent.trim()),
    rows: [...document.querySelectorAll('#v-alpha .dfrow')].map(e => ({
      name: e.querySelector('.nm')?.textContent,
      chip: e.querySelector('.cnt')?.textContent,
      delta: e.querySelector('.delt')?.textContent.trim(),
      verb: e.querySelector('.verb')?.textContent,
      ext: e.classList.contains('extPin'),
      hasRewind: !!e.querySelector('.snapRevertBtn'),
    })),
    headDelta: document.querySelector('#v-alpha .snapHead .delt')?.textContent.trim(),
  }));
  assert.deepEqual(s.groups, ['./', 'model/', 'extlib/'],
    'files grouped by folder; the external pin group shows its folder name, not /Users/…');
  const byName = Object.fromEntries(s.rows.map(r => [r.name, r]));
  assert.equal(byName['setup.jl'].chip, '3 edits');
  assert.equal(byName['setup.jl'].verb, '✎');
  assert.match(byName['setup.jl'].delta, /\+3\s*−2/);
  assert.equal(byName['equilibrium.jl'].chip, '1 edit');
  assert.equal(byName['calib.jl'].chip, 'new');
  assert.equal(byName['calib.jl'].verb, '✚');
  assert.ok(s.rows.every(r => r.hasRewind), 'every row keeps its ⟲');
  assert.match(s.headDelta, /\+7\s*−2/, 'the change-set header totals the ±');
  // the file edited OUTSIDE the project root — this used to be invisible
  assert.equal(byName['shared.jl'].ext, true, 'external row carries the extPin class');
  assert.equal(byName['shared.jl'].verb, '↗', 'external row is marked ↗');
  assert.equal(byName['shared.jl'].chip, '2 edits');
  assert.match(byName['shared.jl'].delta, /\+1\s*−1/);
});

test('an external file drills into its diff with the ↗ treatment', opts, async () => {
  await page.evaluate((rel) => {
    [...document.querySelectorAll('#v-alpha .dfrow')].find(r => r.dataset.rel === rel).click();
  }, extFile);
  await sleep(400);
  const s = await page.evaluate(() => ({
    rel: document.querySelector('#v-alpha .sdvHead .sdvRel')?.textContent,
    relExt: !!document.querySelector('#v-alpha .sdvHead .sdvRel.extPin'),
    verb: document.querySelector('#v-alpha .sdvHead .verb')?.textContent,
    del: [...document.querySelectorAll('#v-alpha .udl.delln .t')].map(e => e.textContent),
    add: [...document.querySelectorAll('#v-alpha .udl.addln .t')].map(e => e.textContent),
  }));
  assert.equal(s.rel, 'extlib/shared.jl', 'header shows the folder-relative label, not the abs path');
  assert.ok(s.relExt, 'amber external mark on the header');
  assert.equal(s.verb, '↗');
  assert.deepEqual(s.del, ['b'], 'removed line struck');
  assert.deepEqual(s.add, ['X'], 'added line washed');
  await page.evaluate(() => { document.querySelector('#v-alpha .sdvBack').click(); });
  await sleep(200);
});

test('clicking a file opens the full inline unified diff', opts, async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .dfrow')]
      .find(r => r.dataset.rel === 'model/setup.jl').click();
  });
  await sleep(400); // renderWB + blob fetch + re-render

  const s = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#v-alpha .udiff .udl')];
    const cell = (r) => ({
      cls: r.className.replace('udl', '').trim(),
      g: r.querySelector('.g')?.textContent,
      t: r.querySelector('.t')?.textContent,
    });
    return {
      head: document.querySelector('#v-alpha .sdvHead')?.textContent || '',
      rows: rows.map(cell),
      folds: rows.filter(r => r.classList.contains('fold')).map(r => r.querySelector('.t').textContent),
      stepper: document.querySelector('#v-alpha .sdvStepper')?.textContent.replace(/\s+/g, ' ').trim() || '',
      delStruck: getComputedStyle(document.querySelector('#v-alpha .udl.delln .t')).textDecorationLine,
    };
  });
  assert.match(s.head, /model\/setup\.jl/, 'header names the file');
  assert.match(s.head, /3 edits/);
  assert.ok(s.folds.some(t => /1–\d+ unchanged/.test(t)), 'the long top run is folded');
  const del = s.rows.find(r => r.cls.includes('delln') && /read\(p\)/.test(r.t));
  const add = s.rows.find(r => r.cls.includes('addln') && /load\(p\)/.test(r.t));
  assert.ok(del && add, 'removed and added lines render in place');
  assert.equal(del.g, add.g, 'a replaced line shows old − and new + at the same number');
  assert.ok(s.rows.some(r => r.cls.includes('addln') && /normalize!/.test(r.t)), 'the inserted line is green');
  assert.ok(s.rows.some(r => r.cls.includes('ctx') && /grid = make/.test(r.t)), 'untouched code shows between edits');
  assert.equal(s.delStruck, 'line-through', 'removed lines are struck out');
  assert.match(s.stepper, /edit 1 \/ 2/, 'two hunks, stepper ready');
});

test('a fold expands in place without losing the scroll position', opts, async () => {
  const beforeN = await page.evaluate(() => document.querySelectorAll('#v-alpha .udiff .udl').length);
  await page.evaluate(() => { document.querySelector('#v-alpha .udl.fold').click(); });
  await sleep(150);
  const s = await page.evaluate(() => ({
    n: document.querySelectorAll('#v-alpha .udiff .udl').length,
    foldsLeft: document.querySelectorAll('#v-alpha .udl.fold').length,
    firstLine: document.querySelector('#v-alpha .udiff .udl .t')?.textContent,
  }));
  assert.ok(s.n > beforeN, `hidden lines appeared (${beforeN} → ${s.n})`);
  assert.equal(s.foldsLeft, 1, 'only the tail fold remains');
  assert.equal(s.firstLine, 'using Pkg', 'the file now starts from line 1');
});

test('the ◀ ▶ stepper walks the edit hunks', opts, async () => {
  const step = async (d) => {
    await page.evaluate((x) => {
      [...document.querySelectorAll('#v-alpha .sdvStep')].find(b => b.dataset.d === x).click();
    }, String(d));
    await sleep(120);
  };
  await step(1); // first press lands ON edit 1
  let s = await page.evaluate(() => ({
    no: document.querySelector('#sdvHunkNo')?.textContent,
    flashed: !!document.querySelector('#v-alpha .udl.hcur'),
  }));
  assert.equal(s.no, '1');
  assert.ok(s.flashed, 'the landed-on hunk flashes');
  await step(1);
  s = await page.evaluate(() => ({ no: document.querySelector('#sdvHunkNo')?.textContent }));
  assert.equal(s.no, '2');
  await step(1); // wraps
  s = await page.evaluate(() => ({ no: document.querySelector('#sdvHunkNo')?.textContent }));
  assert.equal(s.no, '1');
});

test('← Δ list returns to the file list', opts, async () => {
  await page.evaluate(() => { document.querySelector('#v-alpha .sdvBack').click(); });
  await sleep(200);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#v-alpha .dfrow').length), 4);
});

test('a running turn shows the live ✎ line in the console strip; → Δ jumps here', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
  await sleep(200);
  await wsPush('session:edits', {
    project: 'alpha', id,
    edits: { files: 3, created: 1, modified: 2, deleted: 0, adds: 38, dels: 9 },
  });
  await sleep(300);

  const line = await page.evaluate(() =>
    document.querySelector('#v-alpha #consoleBox .csEditLine')?.textContent.replace(/\s+/g, ' ') || '');
  assert.match(line, /✎ 3 files changed/, 'live aggregate rides the console strip');
  assert.match(line, /1 new/);
  assert.match(line, /2 edited/);
  assert.match(line, /\+38 −9/);
  assert.match(line, /Δ →/); // the jump is a right-pinned button now ("Δ →")

  await page.evaluate(() => { document.querySelector('#v-alpha .csToDelta').click(); });
  await sleep(250);
  const s = await page.evaluate(() => ({
    deltaOn: !!document.querySelector('#v-alpha .ctab[data-fi="snaps"].on'),
    liveNote: document.querySelector('#v-alpha .snapLiveNote')?.textContent || '',
  }));
  assert.ok(s.deltaOn, '→ Δ lands on the Δ tab');
  assert.match(s.liveNote, /turn in progress — 3 files changed so far/);

  // turn ends → the live bits retire
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(250);
  assert.equal(await page.evaluate(() => !!document.querySelector('#v-alpha .snapLiveNote')), false);
});

test('⟲ rewind restores the file and records an invertible entry with counts', opts, async () => {
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => {
    [...document.querySelectorAll('#v-alpha .dfrow')]
      .find(r => r.dataset.rel === 'model/equilibrium.jl')
      .querySelector('.snapRevertBtn').click();
  });
  await sleep(600); // revert round-trip

  const onDisk = fs.readFileSync(path.join(sb.projRoots.alpha, 'model', 'equilibrium.jl'), 'utf8');
  assert.equal(onDisk, EQ_BEFORE, 'the file is back to its before-state');

  // the harness stubs the WebSocket, so the server's real snapshot:new never
  // reaches the page — fetch the recorded entry and push it like live would
  const { body: after2 } = await sb.fetchJson('GET', '/api/snapshots/alpha?task=alp-001');
  assert.equal(after2.entries.length, 3, 'the server recorded the rewind change-set');
  await wsPush('snapshot:new', { project: 'alpha', entry: after2.entries[0] });
  await sleep(250);

  const s = await page.evaluate(() => ({
    entries: document.querySelectorAll('#v-alpha .snapEntry').length,
    kinds: [...document.querySelectorAll('#v-alpha .snapKind')].map(e => e.textContent.trim()),
    firstChip: document.querySelector('#v-alpha .snapEntry .dfrow .cnt')?.textContent,
    firstDelta: document.querySelector('#v-alpha .snapEntry .dfrow .delt')?.textContent.trim(),
  }));
  assert.equal(s.entries, 3, 'the rewind is its own change-set');
  assert.equal(s.kinds[0], '⟲ rewind');
  assert.equal(s.firstChip, '1 edit');
  assert.match(s.firstDelta, /−1/, 'the rewind entry carries real ± counts too');
});

test('⟲ rewind works on a granted external file too', opts, async () => {
  page.once('dialog', (d) => d.accept());
  await page.evaluate((rel) => {
    [...document.querySelectorAll('#v-alpha .dfrow')]
      .find(r => r.dataset.rel === rel)
      .querySelector('.snapRevertBtn').click();
  }, extFile);
  await sleep(600);
  assert.equal(fs.readFileSync(extFile, 'utf8'), EXT_BEFORE,
    'the external file is restored to its before-state');
  const { body } = await sb.fetchJson('GET', '/api/snapshots/alpha?task=alp-001');
  assert.equal(body.entries.length, 4, 'the external rewind is recorded');
  assert.equal(body.entries[0].revertOf, EXT_ENTRY);
  assert.equal(body.entries[0].files[0].external, true, 'the revert entry keeps the external mark');
  assert.equal(body.entries[0].files[0].rel, extFile);
});
