// Voice layer (browser-native speech in/out) — frontend-only feature.
// Drives the real frontend in headless Chrome; skips cleanly without Chrome.
//
// Guards:
//   · the composer grows a 🎙 button and the sessbar a voice chip — and
//     nothing else moves
//   · the voice chip is per-task and persists (localStorage, like drafts)
//   · a turn ending speaks the answer: the speaking pill appears in the
//     ≋ console and the karaoke highlight wraps answer prose (never tool spew)
//   · Settings gains a Voice section whose segments persist prefs
//   · I3 leg (c) (blueprint §2 "EditContext posture", §9 ui.voice row):
//     Space while Monaco is focused NEVER mics — genuine CDP keystrokes,
//     with a Space-outside positive control so the case can't go vacuous
//
// speechSynthesis exists in headless Chrome but produces no audio and may
// never fire utterance events — the assertions stop at the DOM the voice
// module builds synchronously (pill, highlight), never at audio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, sleep, chunked, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, task, support;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'β = 0.96\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate model', description: 'Fit β.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await sleep(500);
  support = await page.evaluate(() => ({
    sr: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    tts: 'speechSynthesis' in window,
  }));
});
after(async () => { if (ui) await ui.stop(); });

const stream = async (text, n = 30, everyMs = 25) => {
  for (const chunk of chunked(text, n)) {
    await wsPush('session:stream', { project: 'alpha', id, chunk });
    await sleep(everyMs);
  }
  await sleep(350); // reveal pump catches up
};

test('the composer grows a mic button; the sessbar sheds its toggles', opts, async () => {
  if (support.sr) {
    assert.ok(await page.$('#v-alpha #micBtn'), 'mic button renders when SpeechRecognition exists');
    assert.ok(await page.$('#v-alpha #voiceHint'), 'hint line placeholder present (hidden at rest)');
    assert.equal(await page.$eval('#v-alpha #voiceHint', el => el.style.display), 'none');
  }
  // 2026-08-07 session-bar simplification: web + voice are ALWAYS ON, so no
  // toggle chips render — and oversight/category no longer display under the
  // composer (oversight keeps its tab chip; categories live on in packets).
  assert.equal(await page.$('#v-alpha [data-voicetoggle]'), null, 'voice chip is gone (always on)');
  assert.equal(await page.$('#v-alpha [data-webtoggle]'), null, 'web toggle is gone (always on)');
  // the 🛡 picker's own "by oversight" label stays — strip it before asserting
  // the removed "oversight <LABEL>" display is gone
  const bar = await page.$eval('#v-alpha .sessbar', el => el.textContent);
  assert.ok(!/oversight/.test(bar.replace(/by oversight/g, '')), 'the oversight label row is gone from the sessbar');
  assert.ok(!/category/.test(bar), 'category no longer displays in the sessbar');
});

test('a turn ending speaks the answer with ZERO setup: pill + karaoke in the console', opts, async (t) => {
  if (!support.tts) return t.skip('no speechSynthesis in this Chrome');
  // no chip was clicked, no pref was set — speaking with no setup IS the
  // always-on assertion
  // jump to the console via a real send (message route is stubbed by the harness)
  await page.fill('#composerInput', 'Re-run with the tighter grid.');
  await page.press('#composerInput', 'Enter');
  await sleep(250);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await stream('⟐ model · auto\n\n∴ thinking…\nCompare both grids.\n\n'
    + '[tool: Bash] julia run_smm.jl\n[result] converged\n\n— answer —\n'
    + 'The estimation finished cleanly. The wealth Gini rises to 0.81 under the tighter grid.\n');
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(800); // highlight has a one-shot 600ms retry for reveal lag
  const st = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const pill = box && box.querySelector('.speakPill');
    const hl = box ? [...box.querySelectorAll('.speakNow')] : [];
    return {
      pill: !!pill,
      pillText: pill ? pill.textContent : '',
      hlText: hl.map(s => s.textContent).join(''),
      hlInTool: hl.some(s => s.closest('.cs-tool, .cs-res, .cs-think')),
    };
  });
  assert.ok(st.pill, 'speaking pill floats in the console');
  assert.match(st.pillText, /speaking/, 'pill labels itself');
  assert.match(st.pillText, /sentence 1 of \d+/, 'pill tracks position');
  assert.ok(st.hlText.includes('estimation finished'), 'first answer sentence carries the karaoke wash');
  assert.equal(st.hlInTool, false, 'highlight never lands in tool/thinking segments');
  // stop control clears pill + highlight
  await page.click('#v-alpha .speakPill [data-vp="stop"]');
  await sleep(150);
  assert.equal(await page.$('#v-alpha .speakPill'), null, '✕ removes the pill');
  assert.equal(await page.$('#v-alpha .speakNow'), null, '…and the highlight');
});

/* ── I3 triple guard, leg (c) — blueprint §2 "EditContext posture" (P18,
   C2-MF2); the §9 test-migration row: "Grows 'Space while Monaco focused
   never mics' (CDP-driven, S1)".
   The __mp seam bypasses the input path, so everything here is genuine CDP
   keystrokes (page.keyboard) — seam calls stay reads/staging only.
   SpeechRecognition is replaced pre-boot by a counting stub because
   voiceStartListening constructs and start()s the recognizer SYNCHRONOUSLY
   on activation — the ctor/start counters ARE the PTT state machine's
   activation record (headless Chrome's real recognizer would async-error
   with 'not-allowed' and race the assertions), and the stub also makes
   MIC_OK deterministic so the composer's #micBtn always renders here. */

const FK_JL = 'alpha::model.jl'; // the task's context file — Monaco opens it as tab 0

async function monacoVoicePage(init) {
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await context.newPage();
  await armPage(p);
  await p.addInitScript((init2) => {
    localStorage.setItem('editor:impl', 'monaco');
    if (init2) for (const [k, v] of Object.entries(init2)) window[k] = v;
    window.__sr = { news: 0, starts: 0, stops: 0 };
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      constructor() { window.__sr.news++; }
      start() { window.__sr.starts++; }
      stop() { window.__sr.stops++; }
      abort() { window.__sr.stops++; }
    };
  }, init || null);
  await p.goto(`${sb.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction((fk) => (
    window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
    && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
  ), FK_JL, { timeout: 25000, polling: 100 });
  return { context, p };
}

/** The full Space case on one input surface (mirrors ui.monaco-core's imeCase). */
async function pttCase(init, expectSurface) {
  const { context, p } = await monacoVoicePage(init);
  try {
    assert.equal(await p.evaluate(() => window.__mp.editContext()), expectSurface,
      `surface under test is ${expectSurface ? 'EditContext' : 'textarea'}`);
    // focus the editor via a REAL click — the bail must see a genuine event
    // target from inside the editor DOM; then park the caret deterministically
    await p.click('#v-alpha .wb > .mdock.on .monaco-editor .view-lines');
    await p.waitForFunction(() => window.__mp.hasTextFocus(), null, { timeout: 5000 });
    await p.evaluate(() => window.__mp.setPosition(2, 1));
    const SENT = 'grid search over four beta values ';
    await p.keyboard.type(SENT);
    const typed = await p.evaluate((fk) => ({
      sr: { ...window.__sr },
      text: window.__mp.text(fk),
      listening: !!document.querySelector('#v-alpha .composer.vListening')
        || !!document.querySelector('#v-alpha #micBtn.listening'),
      focus: window.__mp.hasTextFocus(),
    }), FK_JL);
    assert.deepEqual(typed.sr, { news: 0, starts: 0, stops: 0 },
      'the PTT machine NEVER activated — zero recognizer constructions/starts');
    assert.equal(typed.listening, false, 'no listening chrome ever painted');
    // every Space landed: a hijacking preventDefault would eat the char, so
    // the contiguous sentence doubles as the differential probe
    assert.ok(typed.text.includes(SENT),
      `all ${SENT.split(' ').length - 1} spaces landed in the buffer: ${JSON.stringify(typed.text.slice(0, 60))}`);
    assert.equal(typed.focus, true, 'focus never left the editor');

    // positive control — without it the bail case is vacuous: click an inert
    // element OUTSIDE any editor; Space must still be push-to-talk exactly
    // as before (keydown starts the mic, release finishes)
    await p.click('#navWeek');
    await p.keyboard.down('Space');
    await p.waitForFunction(() => window.__sr.starts === 1, null, { timeout: 5000 });
    const on = await p.evaluate(() => ({
      news: window.__sr.news,
      vListening: !!document.querySelector('#v-alpha .composer.vListening'),
      mic: (document.querySelector('#v-alpha #micBtn') || { className: '' }).className,
    }));
    assert.equal(on.news, 1, 'exactly one recognizer constructed');
    assert.equal(on.vListening, true, 'composer shows the listening state');
    assert.match(on.mic, /listening/, 'mic button lit');
    await p.keyboard.up('Space');
    await p.waitForFunction(() => window.__sr.stops >= 1, null, { timeout: 5000 });
    assert.equal(await p.evaluate(() =>
      !!document.querySelector('#v-alpha .composer.vListening')), false,
    'release ends listening — PTT outside the editor is byte-identical');
  } finally {
    await context.close();
  }
}

test('Space while Monaco focused never mics; Space outside still starts PTT (I3 leg c, pinned textarea surface)', opts, async () => {
  // the shipped default (EDITCONTEXT PIN): the tag predicate AND the
  // closest-bail both cover the hidden .inputarea textarea
  await pttCase(null, false);
});

test('I3 leg (b) is load-bearing under EditContext: Space inside the editor still never mics', opts, async () => {
  // __mpEditContext:true flips the input surface to a DIV — every tag-based
  // predicate in the Space handler reads dead air and ONLY the
  // closest('.monaco-editor') bail stands between typing and the mic. This
  // is the differential proof the pin alone cannot give.
  await pttCase({ __mpEditContext: true }, true);
});

test('Settings gains a Voice section and its segments persist prefs', opts, async () => {
  await page.click('#profileBtn');
  await sleep(150);
  await page.click('#profileMenu >> text=Settings');
  await page.waitForSelector('#settingsFrame .setSec', { timeout: 5000 });
  const heads = await page.$$eval('#settingsFrame .setSec h3', els => els.map(e => e.textContent));
  assert.ok(heads.includes('Voice'), 'Voice section renders in Settings');
  if (support.tts) {
    assert.equal(await page.$('#vRepl'), null, 'the on/off default is gone — voice replies are always on');
    await page.click('#vRate .segOpt[data-v="1.2"]');
    await sleep(150);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.voicePrefs || '{}'));
    assert.equal(prefs.rate, 1.2, 'speech-rate pref still persists');
    assert.match(await page.$eval('#vRate .segOpt.on', el => el.dataset.v), /1\.2/);
  }
});
