// External pins are EDITABLE in the dashboard editor (the reported gap: an
// external README.md rendered read-only — only the session could edit it),
// and external .md gets the rendered ▤ preview with live draft tracking.
// Saves go through the real sandbox server (PUT /api/extfile — not billed).
// Tests share one staged project and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, CHROME, testBothImpls, edDriver, wsPushTo } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, extFile, taskId;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({});
  ({ sb, page } = ui);
  const extDir = path.join(sb.root, 'welfare-notes');
  fs.mkdirSync(extDir, { recursive: true });
  extFile = path.join(extDir, 'README.md');
  fs.writeFileSync(extFile, '# Partial insurance\n\nThe **median cost** falls.\n');
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Reproduction', description: 'x', category: 'calibration', oversight: 'coop',
  });
  taskId = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t.id}`, {
    status: 'waiting',
    context: { files: [extFile] }, // external pin — grants its folder
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(600);
  // open the external pin from the sidebar (the ↗ row)
  await page.click('#v-alpha .side [data-extfk]');
  await sleep(800);
});

after(async () => { if (ui) await ui.stop(); });

test('an external .md opens EDITABLE — not the old read-only view', opts, async () => {
  const s = await page.evaluate(() => ({
    editor: !!document.querySelector('#v-alpha #codeEditor'),
    readOnlyPre: !!document.querySelector('#v-alpha pre.extView'),
    foot: document.querySelector('#v-alpha #saveState')?.title || '',
    preview: !!document.querySelector('#mdPreviewBtn'),
  }));
  assert.ok(s.editor, 'a real editor mounts for the external file');
  assert.ok(!s.readOnlyPre, 'no read-only fallback view');
  assert.match(s.foot, /external — editable/, 'the save chip\'s tooltip says so');
  assert.ok(s.preview, 'external markdown offers ▤ preview');
});

test('⌘S writes the external file to disk through the pin grant', opts, async () => {
  await page.click('#codeEditor');
  await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    ed.setSelectionRange(ed.value.length, ed.value.length);
    ed.focus();
  });
  await page.keyboard.type('\nEDITED FROM THE DASHBOARD\n');
  await sleep(200);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await sleep(700);
  assert.match(fs.readFileSync(extFile, 'utf8'), /EDITED FROM THE DASHBOARD/,
    'the external file changed on disk');
  const foot = await page.evaluate(() => ({
    title: document.querySelector('#v-alpha #saveState')?.title || '',
    txt: document.querySelector('#v-alpha #saveState')?.textContent.trim() || '',
  }));
  assert.match(foot.title, /external — editable/, 'still flagged external');
  assert.match(foot.txt, /saved/, 'saved state settles back to clean');
  assert.ok(!/unsaved/.test(foot.txt), 'chip shows saved, not unsaved');
});

test('▤ preview renders the external markdown and live-tracks the draft', opts, async () => {
  await page.click('#mdPreviewBtn');
  await sleep(800);
  const p1 = await page.evaluate((f) => {
    const pane = document.querySelector(`#v-alpha .mdPane[data-vk="${f}"]`);
    return pane && {
      visible: !pane.classList.contains('vhid'),
      h1: pane.querySelector('h1')?.textContent,
      bolded: !!pane.querySelector('strong'),
      saved: pane.querySelector('.mdBody').textContent.includes('EDITED FROM THE DASHBOARD'),
    };
  }, extFile);
  assert.ok(p1, 'rendered pane mounts for the external md');
  assert.ok(p1.visible);
  assert.equal(p1.h1, 'Partial insurance');
  assert.ok(p1.bolded);
  assert.ok(p1.saved, 'the pane shows the saved edit');
  // now type — the pane tracks the unsaved draft
  await page.click('#codeEditor');
  await page.evaluate(() => {
    const ed = document.querySelector('#codeEditor');
    ed.setSelectionRange(0, 0);
    ed.focus();
  });
  await page.keyboard.type('LIVE EXTERNAL DRAFT\n\n');
  await sleep(600);
  const p2 = await page.evaluate((f) => document
    .querySelector(`#v-alpha .mdPane[data-vk="${f}"] .mdBody`).textContent.includes('LIVE EXTERNAL DRAFT'), extFile);
  assert.ok(p2, 'the rendered pane follows the external draft as you type');
});

/* ── Phase 3 S2.6 (P4, monaco-s2 §1/§2): the external-pin KEEP contracts
   under BOTH editor implementations, against the REAL sandbox routes (the
   complement to ui.monaco-save §H's stubbed /api/extfile rows):
     · opens EDITABLE + ⌘S writes through the pin grant (PUT /api/extfile);
     · extfile file:changed → the clean editor reloads the disk bytes (under
       monaco via the M4 applyExternal/reconciliation plane — the plan's
       named remaining row);
     · the REFUSAL rows: a real 409 (disk moved under the draft) destroys
       nothing on cancel — the M5 overlay under monaco, the native confirm
       under legacy — and a real 403 (grant revoked) leaves draft, disk and
       chip untouched with the server's own error toasted.
   Contract verbatim; only waits/reads move (edDriver). Declared last — the
   shared-page tests above are order-dependent; each pass reseeds the ext
   file on disk and restores the grant in its finally. */
testBothImpls('P4 dual: external pin edits + ⌘S through the grant; file:changed reloads; 409-cancel and 403 destroy nothing', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const ed = edDriver(impl);
  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
  const extFk = () => `alpha::${extFile}`;
  const EXT0 = '# Partial insurance\n\ndual-pass baseline.\n';
  const EXT2 = '# Partial insurance\n\nSESSION REWROTE THIS OUTSIDE.\n';
  fs.writeFileSync(extFile, EXT0);
  const chip = () => page.evaluate(() => ({
    cls: document.querySelector('#v-alpha #saveState')?.className || '',
    txt: document.querySelector('#v-alpha #saveState')?.textContent.trim() || '',
    title: document.querySelector('#v-alpha #saveState')?.title || '',
  }));
  try {
    // ── open the pin: a real editor, flagged external — editable ──
    await page.waitForSelector('#v-alpha .side [data-extfk]', { timeout: 15000 });
    await page.click('#v-alpha .side [data-extfk]');
    await ed.wait(page, extFk());
    assert.ok(!(await page.$('#v-alpha pre.extView')), 'no read-only fallback view');
    assert.match((await chip()).title, /external — editable/, 'the chip tooltip says so');
    assert.equal(await ed.text(page, extFk()), EXT0, 'the disk bytes loaded');

    // ── ⌘S writes the external file to disk through the pin grant ──
    await ed.caretEnd(page);
    const mark = `\nDUAL ${impl.toUpperCase()} EDIT\n`;
    await page.keyboard.type(mark);
    await page.waitForFunction(() =>
      /dirty/.test(document.querySelector('#v-alpha #saveState')?.className || ''), null, { timeout: 5000 });
    await page.keyboard.press(`${MOD}+s`);
    await page.waitForFunction(() => {
      const c = document.querySelector('#v-alpha #saveState')?.className || '';
      return /saveChip/.test(c) && !/dirty/.test(c);
    }, null, { timeout: 10000 });
    assert.match(fs.readFileSync(extFile, 'utf8'), /DUAL \w+ EDIT/, 'the external file changed on disk');
    assert.match((await chip()).title, /external — editable/, 'still flagged external after the save');

    // ── extfile file:changed: the CLEAN editor reloads the new disk bytes
    //    (rel = the absolute path, the app-wide external-rel convention) ──
    fs.writeFileSync(extFile, EXT2);
    await wsPushTo(page, 'file:changed', { project: 'alpha', rel: extFile });
    await page.waitForFunction(() => {
      const c = document.querySelector('#v-alpha #saveState')?.className || '';
      return /saveChip/.test(c) && !/dirty/.test(c);
    }, null, { timeout: 5000 });
    // poll the buffer read (impl-specific) until the reload lands
    for (let i = 0; i < 30 && (await ed.text(page, extFk())) !== EXT2; i++) await sleep(200);
    assert.equal(await ed.text(page, extFk()), EXT2,
      'the clean external editor reloaded the session\'s disk bytes in place');

    // ── 409 refusal: disk moves under a live draft; cancel is a no-op ──
    await ed.caretEnd(page);
    await page.keyboard.type('MINE409 ');
    await page.waitForFunction(() =>
      /dirty/.test(document.querySelector('#v-alpha #saveState')?.className || ''), null, { timeout: 5000 });
    await sleep(400); // clear the server's 250ms mtime grace
    fs.writeFileSync(extFile, EXT2 + 'INTERLOPER LINE\n'); // no file:changed push — a race the 409 net must catch
    if (impl === 'monaco') {
      await page.keyboard.press(`${MOD}+s`);
      await page.waitForSelector('#confirmBack', { timeout: 8000 }); // the M5 ladder, not the native confirm
      await page.click('#confirmBack .cbCancel');
    } else {
      page.once('dialog', (d) => d.dismiss()); // the legacy native confirm — cancel
      await page.keyboard.press(`${MOD}+s`);
    }
    await sleep(400);
    assert.ok((await ed.text(page, extFk())).includes('MINE409'), '409 + cancel: the draft survives');
    assert.match(fs.readFileSync(extFile, 'utf8'), /INTERLOPER LINE/, '409 + cancel: disk untouched');
    assert.match((await chip()).cls, /dirty|stale/, 'the chip still owns the unsaved state');

    // ── 403 refusal: the grant is revoked behind the open editor ──
    await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, { context: { files: [] } });
    // the cancel click stole focus; ⌘S under monaco is an editor addCommand,
    // so hand focus back before the keystroke (legacy: document-level keydown)
    if (impl === 'monaco') await page.evaluate(() => window.__mp.focus());
    else await page.evaluate(() => document.querySelector('#codeEditor').focus());
    await page.keyboard.press(`${MOD}+s`);
    await page.waitForFunction(() => /not a granted external path/
      .test(document.getElementById('toast')?.textContent || ''), null, { timeout: 8000 });
    assert.ok((await ed.text(page, extFk())).includes('MINE409'), '403: the draft survives');
    assert.match(fs.readFileSync(extFile, 'utf8'), /INTERLOPER LINE/, '403: disk untouched');
    assert.match((await chip()).cls, /dirty|stale/, '403: the chip never lies clean');
  } finally {
    // restore the grant + a clean disk state for the sibling pass
    await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, { context: { files: [extFile] } });
    fs.writeFileSync(extFile, EXT0);
  }
});
