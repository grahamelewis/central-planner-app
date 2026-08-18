import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };
let ui, page, wsPush;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ page, wsPush } = ui);
  await page.goto(ui.sb.base);
  await page.waitForSelector('#tailnetBtn');
});
after(async () => { if (ui) await ui.stop(); });

test('top-bar chip distinguishes unavailable, saved/disconnected, and live', opts, async () => {
  await page.waitForFunction(() => document.querySelector('#tailnetLabel')?.textContent === 'No Tailscale');

  await wsPush('tailnet:status', {
    state: 'disconnected', available: true, connected: false, configured: true,
    url: 'https://host.example.ts.net', error: 'Tailscale is not connected',
  });
  await sleep(50);
  assert.equal(await page.textContent('#tailnetLabel'), 'Tailnet saved');
  assert.match(await page.getAttribute('#tailnetBtn', 'title'), /not connected/);

  await wsPush('tailnet:status', {
    state: 'live', available: true, connected: true, configured: true,
    url: 'https://host.example.ts.net', error: '',
  });
  await sleep(50);
  assert.equal(await page.textContent('#tailnetLabel'), 'Tailnet live');
  assert.ok((await page.getAttribute('#tailnetBtn', 'class')).includes('live'));
});

test('local off→live toggle confirms and uses the enable API', opts, async () => {
  await wsPush('tailnet:status', {
    state: 'off', available: true, connected: true, configured: false, error: '',
  });
  await page.route('**/api/tailnet/enable', (route) => route.fulfill({ json: {
    state: 'live', available: true, connected: true, configured: true,
    url: 'https://host.example.ts.net', error: '',
  } }));
  page.once('dialog', (d) => d.accept());
  await page.click('#tailnetBtn');
  await page.waitForFunction(() => document.querySelector('#tailnetLabel')?.textContent === 'Tailnet live');

  await wsPush('tailnet:status', {
    state: 'disconnected', available: true, connected: false, configured: true,
    url: 'https://host.example.ts.net', error: 'Tailscale is not connected',
  });
  await sleep(50);
  page.once('dialog', (d) => d.accept());
  const enableRequest = page.waitForRequest((req) =>
    req.method() === 'POST' && req.url().endsWith('/api/tailnet/enable'));
  await page.click('#tailnetBtn');
  await enableRequest;
  await page.waitForFunction(() => document.querySelector('#tailnetLabel')?.textContent === 'Tailnet live');
});
