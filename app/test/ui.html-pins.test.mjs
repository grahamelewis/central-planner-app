// HTML pins open source + rendered output, without coupling later tab clicks.
// Run against both editors and the real sandbox artifact/save routes. The UI
// harness stubs WebSockets, so forward the actual artifact record after saving.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, CHROME, testBothImpls, edDriver, wsPushTo } from './uiHarness.mjs';

let ui, external;
const html = (title) => `<!doctype html><link rel="stylesheet" href="report.css"><h1>${title}</h1>`;
before(async () => {
  if (!fs.existsSync(CHROME)) return;
  ui = await startUI({ seed: ({ root, projRoots }) => {
    external = path.join(root, 'external.html');
    fs.writeFileSync(external, html('External'));
    fs.writeFileSync(path.join(projRoots.alpha, 'main.txt'), 'Other source\n');
    fs.writeFileSync(path.join(projRoots.alpha, 'report.css'), 'h1 { color: rgb(12, 34, 56); }');
    for (let i = 1; i < 12; i++) fs.writeFileSync(path.join(projRoots.alpha, `source-${i}.txt`), 'Source\n');
    for (const impl of ['legacy', 'monaco']) {
      fs.writeFileSync(path.join(projRoots.alpha, `${impl}.HTML`), html('Existing pin'));
      fs.writeFileSync(path.join(projRoots.alpha, `report-${impl}.htm`), html('New pin'));
      fs.writeFileSync(path.join(projRoots.alpha, `overflow-${impl}.html`), html('Overflow pin'));
    }
  } });
  await ui.sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'HTML pins', category: 'calibration', oversight: 'manual',
    context: { files: ['main.txt', 'legacy.HTML', 'monaco.HTML', external] },
  });
});
after(async () => { if (ui) await ui.stop(); });

testBothImpls('HTML pins: dual open, independent panes, reopening, saved preview and external guard', {
  ui: () => ui,
}, async ({ impl, page, errors }) => {
  const ed = edDriver(impl);
  const oldRel = `${impl}.HTML`;
  const rel = `report-${impl}.htm`;
  const frame = (r) => page.frameLocator(`iframe.artFrame[data-vk="${r}"]`);
  const activePreview = () => page.locator('.ptab.vw.on').getAttribute('data-vk');
  const pinRow = (r) => page.locator('.side .scRow[data-fi]').filter({ hasText: r });
  const selectPin = async (r) => {
    await pinRow(r).click();
    await ed.wait(page, `alpha::${r}`);
    assert.equal(await activePreview(), r);
    await frame(r).locator('h1').waitFor();
  };
  await ed.wait(page, 'alpha::main.txt');

  // Remove artifact discovery entirely: pinned HTML must supply its own tab.
  await page.evaluate(async () => {
    const { state } = await import('/store.js');
    state.artifacts = [];
    const { renderWB } = await import('/workbench.js');
    renderWB('alpha');
  });
  await selectPin(oldRel);
  assert.equal(await frame(oldRel).locator('h1').textContent(), 'Existing pin');
  assert.equal(await frame(oldRel).locator('h1').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)', 'relative CSS still resolves');
  assert.equal(await page.locator(`iframe[data-vk="${oldRel}"]`).getAttribute('sandbox'), 'allow-scripts');

  // Exercise the local pin-menu flow, stubbing only the native OS dialog so
  // no file picker opens on the developer's machine.
  await page.route('**/api/pickfile', r => r.fulfill({ json: { rel } }));
  await page.click('#pinAddBtn');
  const persisted = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/tasks/alpha/'));
  await page.locator('#pinMenu [data-pk="file"]').click();
  assert.equal((await persisted).status(), 200);
  await ed.wait(page, `alpha::${rel}`);
  assert.equal(await activePreview(), rel);
  assert.equal(await frame(rel).locator('h1').textContent(), 'New pin');
  assert.match(await ed.text(page, `alpha::${rel}`), /<h1>New pin<\/h1>/);

  // Switching either kind of tab must leave the other pane alone.
  await page.locator(`.ptab.vw[data-vk="${oldRel}"]`).click();
  await ed.wait(page, `alpha::${rel}`);
  await page.locator('.ctab[data-fi="0"]').click();
  await ed.wait(page, 'alpha::main.txt');
  assert.equal(await activePreview(), oldRel);
  await page.locator('.ctab[data-fi]').filter({ hasText: rel }).click();
  await ed.wait(page, `alpha::${rel}`);
  assert.equal(await activePreview(), oldRel, 'source-tab clicks do not steal the viewer');
  await selectPin(rel);

  // Closing both tabs and clicking the pin reopens both, without duplicates.
  await page.locator(`.ptab.vw[data-vk="${rel}"] .tabX`).click();
  await page.locator('.ctab[data-fi]').filter({ hasText: rel }).locator('.tabX').click();
  await selectPin(rel);
  assert.equal(await page.locator(`.ptab.vw[data-vk="${rel}"]`).count(), 1);
  assert.equal(await page.locator('.ctab[data-fi]').filter({ hasText: rel }).count(), 1);

  // Unsaved typing stays in the source. A successful save + artifact event
  // refreshes the existing sandboxed iframe, including the .htm extension.
  await ed.caretEnd(page);
  await page.keyboard.type('<p>Saved addition</p>');
  assert.equal(await frame(rel).locator('p').count(), 0, 'no unsaved live HTML execution');
  const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes(`/artifact/alpha/${rel}`));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  assert.equal((await saved).status(), 200);
  const diskPath = path.join(ui.sb.projRoots.alpha, rel);
  assert.match(fs.readFileSync(diskPath, 'utf8'), /Saved addition/);
  const stamp = fs.statSync(diskPath).mtime.toISOString();
  const state = await ui.sb.poll('/api/state', s => s.artifacts.some(a => a.rel === rel && a.mtime === stamp));
  const artifact = state.artifacts.find(a => a.rel === rel);
  assert.equal(artifact.kind, 'html');
  await wsPushTo(page, 'artifact:new', { artifact });
  await frame(rel).locator('p').waitFor();
  assert.equal(await frame(rel).locator('p').textContent(), 'Saved addition');
  assert.equal(await page.locator(`.ptab.vw[data-vk="${rel}"]`).count(), 1, 'artifact and pin deduplicate');

  // Task-granted external files retain their plain-text access boundary.
  await page.locator('.side .extFile').filter({ hasText: 'external.html' }).click();
  await ed.wait(page, `alpha::${external}`);
  assert.equal(await activePreview(), rel, 'external HTML never takes over the renderer');
  assert.equal(await page.locator('.ptab.vw').filter({ hasText: 'external.html' }).count(), 0);
  // implPage's storage-seeding init script also runs inside child frames;
  // opaque-origin HTML correctly rejects that harness-only localStorage use.
  const harnessStorageError = "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";
  assert.deepEqual(errors.filter(e => e !== harnessStorageError), []);
});

testBothImpls('HTML pin beyond twelve source tabs still opens both panes', {
  ui: () => ui,
}, async ({ impl, page }) => {
  const { body: state } = await ui.sb.fetchJson('GET', '/api/state');
  const task = state.tasks.alpha[0];
  await ui.sb.fetchJson('PATCH', `/api/tasks/alpha/${task.id}`, {
    context: { ...task.context, files: ['main.txt', ...Array.from({ length: 11 }, (_, i) => `source-${i + 1}.txt`)] },
  });
  await page.reload();
  const ed = edDriver(impl);
  await ed.wait(page, 'alpha::main.txt');
  const rel = `overflow-${impl}.html`;
  await page.route('**/api/pickfile', r => r.fulfill({ json: { rel } }));
  await page.click('#pinAddBtn');
  const persisted = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/tasks/alpha/'));
  await page.locator('#pinMenu [data-pk="file"]').click();
  assert.equal((await persisted).status(), 200);
  await ed.wait(page, `alpha::${rel}`);
  assert.equal(await page.locator('.ptab.vw.on').getAttribute('data-vk'), rel);
  assert.equal(await page.locator('.ctab.xtab.on').getAttribute('data-fi'), `x:${rel}`);
  assert.equal(await page.frameLocator(`iframe[data-vk="${rel}"]`).locator('h1').textContent(), 'Overflow pin');
});
