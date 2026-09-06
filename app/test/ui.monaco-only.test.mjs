import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, CHROME } from './uiHarness.mjs';
const opts = { skip: !fs.existsSync(CHROME) };
let ui;
before(async () => {
  if (opts.skip) return;
  ui = await startUI({ monacoProxy: true, seed: ({projRoots}) => {
    fs.writeFileSync(path.join(projRoots.alpha,'notes.tex'),'\\section{First}\nOriginal text.\n');
  } });
  await ui.sb.fetchJson('POST','/api/tasks',{project:'alpha',title:'Monaco only',context:{files:['notes.tex']}});
});
after(async () => { await ui?.stop(); });

async function pageFor(t, preference = null, touch = false) {
  ui.sb.vendor.clear();
  const context = await ui.browser.newContext({viewport:{width:1400,height:1000},hasTouch:touch});
  t.after(() => context.close());
  const page = await context.newPage(); await armPage(page);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  if (preference) await page.addInitScript(v=>localStorage.setItem('editor:impl',v),preference);
  await page.goto(ui.sb.vendor.base+'/#settings',{waitUntil:'domcontentloaded'});
  await page.locator('#themeSeg').waitFor();
  return {page,errors};
}
const ready = page => page.waitForFunction(()=>window.__mp?.state()==='READY' && window.__mp.activeFkey()==='alpha::notes.tex');

for (const preference of [null,'legacy','monaco']) test(`Monaco only: Settings has no choice; saved ${preference} cannot select Legacy`,opts,async t=>{
  const {page,errors}=await pageFor(t,preference);
  assert.equal(await page.locator('#editorSeg, #edImplRetry').count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('editor:impl')),null);
  assert.equal(await page.evaluate(()=>window.__mp.state()),'IDLE');
  assert.equal(ui.sb.vendor.hits().length,0,'Settings must not load the editor');
  await page.click('#navProjects .tab[data-v="alpha"]'); await ready(page);
  assert.equal(await page.locator('textarea#codeEditor').count(),0);
  await page.evaluate(()=>{window.__mp.focus();window.__mp.setPosition(2,1);});
  await page.keyboard.type('Saved draft ');
  await page.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
  await page.waitForFunction(()=>!window.__mp.isDirty('alpha::notes.tex'));
  assert.match(fs.readFileSync(path.join(ui.sb.projRoots.alpha,'notes.tex'),'utf8'),/Saved draft/);
  assert.deepEqual(errors,[]);
});

test('touch desktop UI attempts Monaco instead of selecting a retired editor',opts,async t=>{
  const {page,errors}=await pageFor(t,'legacy',true);
  await page.click('#navProjects .tab[data-v="alpha"]'); await ready(page);
  assert.equal(await page.locator('textarea#codeEditor').count(),0);
  assert.deepEqual(errors,[]);
});

test('failed boot offers read-only text, copy and retry; dirty text survives without page reload',opts,async t=>{
  const {page,errors}=await pageFor(t);
  await page.click('#navProjects .tab[data-v="alpha"]'); await ready(page);
  await page.evaluate(()=>{window.__mp.focus();window.__mp.setPosition(2,1);});
  await page.keyboard.type('UNSAVED SURVIVOR ');
  const text=await page.evaluate(()=>window.__mp.text('alpha::notes.tex'));
  await page.evaluate(()=>{window.__mpInitThrow=true;window.__mp.reboot();return window.__mp.ensure();});
  await page.locator('.mpFailure').waitFor();
  assert.equal(await page.locator('.mpFailure pre').textContent(),text);
  assert.equal(await page.locator('textarea#codeEditor').count(),0);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('blocked');}}}));
  await page.getByRole('button',{name:'Copy text',exact:true}).click();
  await page.getByText('Clipboard unavailable. Select and copy the read-only text above.').waitFor();
  assert.equal(await page.evaluate(()=>window.__mp.store().drafts['alpha::notes.tex']),text);
  await page.evaluate(()=>{delete window.__mpInitThrow;});
  await page.getByRole('button',{name:'Retry editor',exact:true}).click(); await ready(page);
  assert.equal(await page.evaluate(()=>window.__mp.text('alpha::notes.tex')),text);
  assert.equal(await page.evaluate(()=>window.__mp.isDirty('alpha::notes.tex')),true);
  assert.equal(await page.locator('.mpFailure').count(),0);
  await page.click('#texOutlineBtn');
  await page.locator('#texOutlineMenu .pmItem[data-ln]').first().click();
  assert.equal(await page.evaluate(()=>window.__mp.getPosition()?.line),1);
  assert.deepEqual(errors,[]);
});
