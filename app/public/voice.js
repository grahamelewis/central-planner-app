// voice.js — browser-native voice layer, split verbatim out of app.js
// (phase 2): STT push-to-talk/lock/countdown, TTS queue + karaoke highlight,
// stream/status hooks, mic UI sync, Settings section, global Space/Esc gestures.

import { esc, toast } from './util.js';
import { state, ui, tailBufs, findTask, curTask } from './store.js';
import { parseConsole, relativizePaths } from './console.js';
import { MIC_SVG, SPK_SVG } from './session.js';
import { renderSettings } from './views.js';

/* ───────────────────────── voice (browser-native) ─────────────────────────
   Speech in: SpeechRecognition push-to-talk → transcript → the ordinary
   composer + send path (nothing new server-side — the voice→message arrow is
   recognizer → text → POST /message). Speech out: speechSynthesis reads the
   console's answer prose, sentence by sentence, with a best-effort karaoke
   highlight. Tool lines, thinking, code, tables and math are never read.
   All state is client-side: prefs in localStorage, per-task voice chip. */

const SR_CTOR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Electron ships the SR constructor but no speech backend — ctor presence alone is not a valid mic check
export const MIC_OK = SR_CTOR && !/Electron/.test(navigator.userAgent);
const TTS = ('speechSynthesis' in window) ? window.speechSynthesis : null;

const VOICE_DEFAULTS = { voice: '', rate: 1, speak: 'final', autoSend: 3, bargeIn: true };
function voicePrefs() {
  try { return { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.voicePrefs || '{}') }; }
  catch { return { ...VOICE_DEFAULTS }; }
}
function setVoicePref(key, val) {
  const p = voicePrefs();
  p[key] = val;
  localStorage.voicePrefs = JSON.stringify(p);
}
/* Voice replies are ALWAYS ON (2026-08-07 session-bar simplification): the
   per-task chip and the Settings default are gone. taskVoiceOn keeps its
   call-site signature; TTS availability still gates actual speech. */
/**
 * @overload
 * @param {string} [taskKey] pre-simplification call-site compatibility — ignored
 * @returns {boolean}
 */
export function taskVoiceOn() { return true; }

const voiceSt = {
  status: 'idle',   // idle | listening | counting
  k: null,          // `${project}/${id}` the mic belongs to
  rec: null, base: '', lock: false, spaceHeld: false, downAt: 0,
  timer: null, deadline: 0, setting: false,
  sp: { k: null, q: [], done: 0, total: 0, paused: false }, // speech-out queue
  sentAt: {},       // k → spoken-sentence cursor for the current turn (narrate)
  narrTimers: {},   // k → throttle timer for narrate scans
  hl: [],           // active karaoke highlight spans
};

const voiceComposerFor = (key) => document.querySelector(`#v-${CSS.escape(key)} #composerInput`);

function voiceSetComposer(key, text) {
  const input = voiceComposerFor(key);
  if (!input) return;
  voiceSt.setting = true;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true })); // drafts + autosize
  voiceSt.setting = false;
}

/* ── speech in ── */

function voiceStartListening(key, taskId) {
  if (!SR_CTOR || voiceSt.status === 'listening') return;
  if (voiceSt.sp.q.length && voicePrefs().bargeIn) voiceStopSpeaking(); // barge-in ducks playback
  voiceCancelCountdown();
  const input = voiceComposerFor(key);
  if (!input) return;
  let rec;
  try { rec = new SR_CTOR(); } catch { return; }
  voiceSt.status = 'listening';
  voiceSt.k = `${key}/${taskId}`;
  voiceSt.lock = false;
  voiceSt.base = input.value ? input.value.replace(/\s*$/, ' ') : '';
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    voiceSetComposer(key, voiceSt.base + text);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast(location.protocol === 'http:' && !/^(localhost|127\.)/.test(location.hostname)
        ? 'mic blocked — voice needs HTTPS; use your tailscale serve URL (see deploy/REMOTE.md)'
        : 'mic blocked — allow microphone access for this site');
      voiceStopListening(false);
    } // 'no-speech'/'aborted' are routine — onend handles the restart
  };
  rec.onend = () => {
    // the recognizer self-stops on silence; keep it hot while held/locked
    if (voiceSt.status === 'listening' && voiceSt.rec === rec) {
      try { rec.start(); } catch { /* already restarting */ }
    }
  };
  voiceSt.rec = rec;
  try { rec.start(); } catch { voiceSt.status = 'idle'; voiceSt.rec = null; return; }
  voiceSyncUi();
}

function voiceStopListening(finish) {
  if (voiceSt.status !== 'listening') return;
  const k = voiceSt.k;
  const [key] = (k || '').split('/');
  voiceSt.status = 'idle';
  const rec = voiceSt.rec;
  voiceSt.rec = null;
  if (rec) { rec.onend = null; try { rec.stop(); } catch { /* already stopped */ } }
  const input = voiceComposerFor(key);
  const text = input ? input.value : '';
  if (!finish) {
    voiceSetComposer(key, voiceSt.base.replace(/\s+$/, '')); // discard — restore what was there
  } else if (text.trim() && text.trim() !== voiceSt.base.trim()) {
    voiceStartCountdown(k);
  }
  voiceSyncUi();
}

function voiceStartCountdown(k) {
  const delay = Number(voicePrefs().autoSend) || 0;
  voiceSt.k = k;
  if (delay <= 0) { voiceFireSend(); return; }
  voiceSt.status = 'counting';
  voiceSt.deadline = Date.now() + delay * 1000;
  clearInterval(voiceSt.timer);
  voiceSt.timer = setInterval(() => {
    if (Date.now() >= voiceSt.deadline) voiceFireSend();
    else voiceSyncUi();
  }, 250);
  voiceSyncUi();
}

function voiceCancelCountdown() {
  if (voiceSt.status !== 'counting') return;
  clearInterval(voiceSt.timer);
  voiceSt.timer = null;
  voiceSt.status = 'idle';
  voiceSyncUi();
}

function voiceFireSend() {
  clearInterval(voiceSt.timer);
  voiceSt.timer = null;
  voiceSt.status = 'idle';
  const [key] = (voiceSt.k || '').split('/');
  voiceSyncUi();
  document.querySelector(`#v-${CSS.escape(key)} #sendBtn`)?.click();
}

/* mic button gestures: quick tap locks hands-free, hold is push-to-talk */
function voiceMicDown(key, taskId) {
  if (voiceSt.sp.q.length) { // speaking → mic press ducks (and starts listening if barge-in)
    const barge = voicePrefs().bargeIn;
    voiceStopSpeaking();
    if (!barge) return;
  }
  if (voiceSt.status === 'listening') { voiceStopListening(true); return; } // locked → finish
  voiceSt.downAt = Date.now();
  voiceStartListening(key, taskId);
}
function voiceMicUp() {
  if (voiceSt.status !== 'listening') return;
  if (Date.now() - voiceSt.downAt < 300) { voiceSt.lock = true; voiceSyncUi(); } // tap → lock open
  else voiceStopListening(true);
}

/* ── speech out ── */

/* the speakable prose of the current turn: parseConsole's 'ans'/'ques'
   segments after the last 'you' marker — tool spew, thinking and meta never
   qualify. Same buffer the console renders, so no server help needed. */
function voiceSpeakableText(k) {
  const [project, taskId] = k.split('/');
  const raw = tailBufs[k] || '';
  if (!raw) return '';
  const segs = parseConsole(relativizePaths(raw, project, taskId));
  let lastYou = -1;
  segs.forEach((s, i) => { if (s.type === 'you') lastYou = i; });
  const parts = [];
  for (let i = lastYou + 1; i < segs.length; i++) {
    if (segs[i].type === 'ans' || segs[i].type === 'ques') parts.push(segs[i].text);
  }
  return parts.join('\n\n');
}

/* markdown → something a voice can say: code/tables/math become short spoken
   asides, formatting characters vanish */
function voiceStrip(text) {
  return String(text)
    .replace(/```[\s\S]*?(```|$)/g, ' — a code block — ')
    .replace(/^\s*\|.*\|\s*$/gm, ' — a table row — ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' — an equation — ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' — an equation — ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(?: — a table row — \s*)+/g, ' — a table — ')
    .trim();
}

function voiceSentences(text) {
  const out = [];
  for (const line of voiceStrip(text).split(/\n+/)) {
    const m = line.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
    for (const s of m || []) { if (s.trim()) out.push(s.trim()); }
  }
  return out;
}

function voicePickVoice() {
  if (!TTS) return null;
  const want = voicePrefs().voice;
  const voices = TTS.getVoices() || [];
  return voices.find(v => v.name === want) || null; // null → browser default
}

function voiceEnqueue(k, sentences) {
  if (!TTS || !sentences.length) return;
  const sp = voiceSt.sp;
  if (sp.q.length && sp.k !== k) return; // one task speaks at a time
  const wasIdle = !sp.q.length;
  sp.k = k;
  sp.q.push(...sentences);
  sp.total += sentences.length;
  if (wasIdle) { sp.done = 0; sp.total = sentences.length; sp.paused = false; voiceSpeakNext(); }
  else voiceSyncSpeakPill();
}

function voiceSpeakNext() {
  const sp = voiceSt.sp;
  if (!sp.q.length) { voiceStopSpeaking(); return; }
  const sentence = sp.q[0];
  const u = new SpeechSynthesisUtterance(sentence);
  const v = voicePickVoice();
  if (v) u.voice = v;
  u.rate = Number(voicePrefs().rate) || 1;
  u.onend = u.onerror = () => {
    sp.q.shift();
    sp.done++;
    voiceSpeakNext();
  };
  voiceHighlight(sp.k, sentence);
  voiceSyncSpeakPill();
  voiceSyncUi();
  TTS.speak(u);
}

function voiceStopSpeaking() {
  const sp = voiceSt.sp;
  sp.q = []; sp.done = 0; sp.total = 0; sp.paused = false;
  if (TTS) { try { TTS.cancel(); } catch { /* noop */ } }
  voiceClearHighlight();
  voiceSyncSpeakPill();
  voiceSyncUi();
}

/* karaoke highlight: find the sentence in the console's rendered markdown and
   wrap the covered text nodes. Best-effort — a miss (KaTeX, re-render, exotic
   markup) just means no wash for that sentence; audio is unaffected. */
function voiceClearHighlight() {
  for (const span of voiceSt.hl) {
    const p = span.parentNode;
    if (!p) continue;
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
    p.normalize();
  }
  voiceSt.hl = [];
}

function voiceHighlight(k, sentence, isRetry) {
  voiceClearHighlight();
  const box = document.querySelector(`#consoleBox[data-key="${CSS.escape(k)}"]`);
  if (!box) return;
  // the reveal pump may still be catching up to the sentence — try once more
  const retryLater = () => {
    if (!isRetry) setTimeout(() => {
      if (!voiceSt.hl.length && voiceSt.sp.q[0] === sentence) voiceHighlight(k, sentence, true);
    }, 600);
  };
  const target = sentence.replace(/\s+—[^—]+—\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (target.length < 8) return;
  const words = target.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let re;
  try { re = new RegExp(words.join('[\\s\\u00a0]+')); } catch { return; }
  const els = [...box.querySelectorAll('.cseg.cs-ans .csMd, .cseg.cs-ques .csMd')];
  for (let i = els.length - 1; i >= 0; i--) {
    const walker = document.createTreeWalker(els[i], NodeFilter.SHOW_TEXT);
    const nodes = [];
    let flat = '';
    while (walker.nextNode()) {
      nodes.push({ n: walker.currentNode, start: flat.length });
      flat += walker.currentNode.nodeValue;
    }
    const m = flat.match(re);
    if (!m) continue;
    const s0 = m.index, s1 = m.index + m[0].length;
    for (const { n, start } of nodes) {
      const a = Math.max(s0, start), b = Math.min(s1, start + n.nodeValue.length);
      if (a >= b) continue;
      const r = document.createRange();
      r.setStart(n, a - start);
      r.setEnd(n, b - start);
      const span = document.createElement('span');
      span.className = 'speakNow';
      try { r.surroundContents(span); voiceSt.hl.push(span); } catch { /* skip this node */ }
    }
    if (voiceSt.hl.length && box._follow !== false) {
      const br = box.getBoundingClientRect(), sr = voiceSt.hl[0].getBoundingClientRect();
      box._prog = (box._prog || 0) + 1;
      box.scrollTop += sr.top - br.top - br.height * 0.6;
    }
    if (!voiceSt.hl.length) retryLater();
    return;
  }
  retryLater(); // sentence not on screen yet (reveal pump lag) — one more look
}

function voiceSyncSpeakPill() {
  const sp = voiceSt.sp;
  document.querySelectorAll('.speakPill').forEach(p => p.remove());
  if (!sp.q.length || !sp.k) return;
  const box = document.querySelector(`#consoleBox[data-key="${CSS.escape(sp.k)}"]`);
  if (!box) return; // console not on screen — audio still plays
  const pill = document.createElement('div');
  pill.className = 'speakPill';
  pill.innerHTML = `
    <span class="vwave purple"><i></i><i></i><i></i><i></i><i></i></span>
    <span class="lbl">speaking</span>
    <span class="pos">sentence ${sp.done + 1} of ${sp.total}</span>
    <span class="ctl" data-vp="pause" title="${sp.paused ? 'resume' : 'pause'}">${sp.paused ? '▶' : '⏸'}</span>
    <span class="ctl x" data-vp="stop" title="stop speaking">✕</span>`;
  pill.querySelector('[data-vp="pause"]').addEventListener('click', () => {
    if (!TTS) return;
    sp.paused = !sp.paused;
    try { sp.paused ? TTS.pause() : TTS.resume(); } catch { /* noop */ }
    voiceSyncSpeakPill();
  });
  pill.querySelector('[data-vp="stop"]').addEventListener('click', voiceStopSpeaking);
  box.appendChild(pill);
}

/* ── stream + status hooks (called from handleEvent) ── */

/* narrate-progress: as answer prose streams in, speak each sentence the moment
   it completes — throttled, and only ever the 'ans' segments */
/**
 * Narrate-progress: speak each completed sentence mid-turn (600ms throttle).
 * @param {string} project
 * @param {string} id task id
 * @returns {void}
 */
export function voiceOnStream(project, id) {
  if (!TTS || voicePrefs().speak !== 'narrate') return;
  const k = `${project}/${id}`;
  if (!taskVoiceOn(k)) return;
  if (voiceSt.narrTimers[k]) return;
  voiceSt.narrTimers[k] = setTimeout(() => {
    delete voiceSt.narrTimers[k];
    const sentences = voiceSentences(voiceSpeakableText(k));
    if (!sentences.length) return;
    const t = findTask(project, id);
    const running = !!(t && t.status === 'running');
    // while streaming, hold back the (possibly unfinished) last sentence
    const ready = running ? sentences.slice(0, -1) : sentences;
    const cursor = voiceSt.sentAt[k] || 0;
    if (ready.length > cursor) {
      voiceSt.sentAt[k] = ready.length;
      voiceEnqueue(k, ready.slice(cursor));
    }
  }, 600);
}

/**
 * Turn-end hook (running→stopped): queue the turn's speakable prose.
 * Called AFTER the re-render so karaoke lands on the settled console.
 * @param {string} project
 * @param {string} id task id
 * @param {string | undefined} status
 * @param {string | null} prev status before the event
 * @returns {void}
 */
export function voiceOnStatus(project, id, status, prev) {
  const k = `${project}/${id}`;
  if (status === 'running' && prev !== 'running') voiceSt.sentAt[k] = 0; // new turn
  if (prev !== 'running' || !status || status === 'running') return;
  if (!TTS || !taskVoiceOn(k)) return;
  const sentences = voiceSentences(voiceSpeakableText(k));
  const cursor = voicePrefs().speak === 'narrate' ? (voiceSt.sentAt[k] || 0) : 0;
  voiceSt.sentAt[k] = sentences.length;
  voiceEnqueue(k, sentences.slice(cursor));
}

/* ── UI sync + wiring ── */

/* re-applies mic/countdown/hint state onto whatever the last render produced —
   renders are frequent and rebuild the composer, so state lives here, not in
   the DOM */
/**
 * Sync mic button + Send-countdown chrome to the current voice state.
 * @returns {void}
 */
export function voiceSyncUi() {
  const key = ui.view;
  const root = document.getElementById('v-' + key);
  if (!root || !state.projects[key]) return;
  const mic = root.querySelector('#micBtn');
  const composer = root.querySelector('.chat .composer');
  const hint = root.querySelector('#voiceHint');
  const send = root.querySelector('#sendBtn');
  const mine = voiceSt.k && voiceSt.k.startsWith(key + '/');
  const speaking = !!voiceSt.sp.q.length && voiceSt.sp.k && voiceSt.sp.k.startsWith(key + '/');
  if (mic) {
    mic.classList.toggle('listening', voiceSt.status === 'listening' && mine);
    mic.classList.toggle('speaking', speaking && voiceSt.status !== 'listening');
    mic.innerHTML = speaking && voiceSt.status !== 'listening' ? SPK_SVG : MIC_SVG;
    mic.title = speaking ? 'The agent reply is playing — press to stop playback and talk'
      : voiceSt.status === 'listening' ? (voiceSt.lock ? 'listening — click to finish' : 'listening — release to finish')
        : 'hold to talk — or hold Space anywhere';
  }
  if (composer) composer.classList.toggle('vListening', voiceSt.status === 'listening' && mine);
  if (send) {
    if (voiceSt.status === 'counting' && mine) {
      const left = Math.max(1, Math.ceil((voiceSt.deadline - Date.now()) / 1000));
      send.classList.add('counting');
      send.innerHTML = `<span class="vring"></span>Send · ${left}`;
    } else if (send.classList.contains('counting')) {
      send.classList.remove('counting');
      send.textContent = 'Send';
    }
  }
  if (hint) {
    if (voiceSt.status === 'listening' && mine) {
      hint.style.display = 'flex';
      hint.className = 'voiceHint listening';
      hint.innerHTML = `<span class="vwave"><i></i><i></i><i></i></span>
        ${voiceSt.lock
    ? 'listening (hands-free) — click the mic to finish · <span class="kbd">Esc</span> discards'
    : 'listening — release to finish · <span class="kbd">Esc</span> discards · tap the mic to lock hands-free'}`;
    } else if (voiceSt.status === 'counting' && mine) {
      hint.style.display = 'flex';
      hint.className = 'voiceHint counting';
      hint.innerHTML = `auto-sending — <span class="kbd">⏎</span> sends now ·
        <span class="kbd">Esc</span> or edit the text to cancel`;
    } else {
      hint.style.display = 'none';
    }
  }
}

/* per-render wiring, called from wireChat with the freshly-built composer */
/**
 * Wire the composer's mic (hold = push-to-talk, tap = hands-free lock).
 * @param {Element} root the project view root
 * @param {string} key project key
 * @param {Task | null} task
 * @returns {void}
 */
export function wireVoice(root, key, task) {
  const mic = root.querySelector('#micBtn');
  if (mic) {
    mic.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { mic.setPointerCapture(e.pointerId); } catch { /* noop */ }
      voiceMicDown(key, task.id);
    });
    mic.addEventListener('pointerup', (e) => { e.preventDefault(); voiceMicUp(); });
    mic.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); });
  }
  const input = root.querySelector('#composerInput');
  if (input) {
    const cancelIfCounting = () => {
      if (!voiceSt.setting && voiceSt.status === 'counting') voiceCancelCountdown();
    };
    input.addEventListener('input', cancelIfCounting);
    input.addEventListener('focus', cancelIfCounting);
    // ⏎ during the countdown = "send now" (doSend already ran) — stop the timer
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && voiceSt.status === 'counting') voiceCancelCountdown();
    });
  }
  // a manual Send click during the countdown must not leave the timer armed
  root.querySelector('#sendBtn')?.addEventListener('click', () => {
    if (voiceSt.status === 'counting') voiceCancelCountdown();
  });
  voiceSyncUi();
}

/* settings › voice — section html + wiring, consumed by renderSettings */
/**
 * Settings › Voice section markup.
 * @returns {string} html
 */
export function voiceSecHtml() {
  if (!SR_CTOR && !TTS) {
    return `<div class="setSec"><h3>Voice</h3>
      <div class="setRow"><div class="setLbl">Not available<small>this browser exposes neither speech
        recognition nor speech synthesis — Chrome, Edge and Safari all work</small></div></div></div>`;
  }
  const p = voicePrefs();
  const seg = (id, opts, cur) => `<div class="segCtl" id="${id}">${opts.map(([v, label]) =>
    `<div class="segOpt ${String(cur) === String(v) ? 'on' : ''}" data-v="${esc(String(v))}">${esc(label)}</div>`).join('')}</div>`;
  const voices = TTS ? (TTS.getVoices() || []) : [];
  const langPrefix = (navigator.language || 'en').slice(0, 2);
  const local = voices.filter(v => (v.lang || '').startsWith(langPrefix));
  const list = (local.length ? local : voices).slice(0, 40);
  return `<div class="setSec">
    <h3>Voice</h3>
    ${TTS ? `<div class="setRow">
      <div class="setLbl">Voice<small>picked from this device's installed voices — the OS "enhanced" voices sound noticeably better (one-time system download)</small></div>
      <div><select class="vSelect" id="vVoice">
        <option value="">browser default</option>
        ${list.map(v => `<option value="${esc(v.name)}" ${v.name === p.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
      </select><button class="vPrevBtn" id="vPrev" title="speak a sample line">▶</button></div>
    </div>
    <div class="setRow">
      <div class="setLbl">Speech rate<small>how fast agent replies are read</small></div>
      ${seg('vRate', [['0.9', '0.9×'], ['1', '1×'], ['1.2', '1.2×'], ['1.5', '1.5×']], p.rate)}
    </div>
    <div class="setRow">
      <div class="setLbl">What gets spoken<small>final answers reads the result when a turn ends; narrate progress also reads interim updates between tool calls. Code, tables and math are summarized, never read.</small></div>
      ${seg('vSpeak', [['final', 'final answers'], ['narrate', 'narrate progress']], p.speak)}
    </div>` : ''}
    ${SR_CTOR ? `<div class="setRow">
      <div class="setLbl">Auto-send pause<small>the beat between releasing the mic and the message sending — a mistranscription costs a real billed turn</small></div>
      ${seg('vDelay', [['0', '0s'], ['3', '3s'], ['5', '5s']], p.autoSend)}
    </div>` : ''}
    <div class="setRow">
      <div class="setLbl">Barge-in<small>pressing the mic (or Space) while a reply plays stops playback and starts listening — it never interrupts the running turn</small></div>
      ${seg('vBarge', [['off', 'off'], ['on', 'on']], p.bargeIn ? 'on' : 'off')}
    </div>
    <div class="setNote"><b>Cost & privacy.</b> Voice is free — no external API, no key, nothing new in
      the ledger; the only spend a voice message causes is the ordinary agent turn it sends. Replies are
      synthesized on this device. Caveat: Chrome routes speech <i>recognition</i> audio through Google's
      speech service (Safari can do it on-device). Remote devices need the HTTPS tailscale serve URL —
      the mic doesn't exist on insecure origins.</div>
  </div>`;
}

/**
 * Wire Settings › Voice controls (persists localStorage.voicePrefs).
 * @param {Element} host the settings view root
 * @returns {void}
 */
export function voiceSecWire(host) {
  const wireSeg = (id, fn) => host.querySelectorAll(`#${id} .segOpt`).forEach(el =>
    el.addEventListener('click', () => { fn(el.dataset.v); renderSettings(); }));
  wireSeg('vRate', v => setVoicePref('rate', Number(v)));
  wireSeg('vSpeak', v => setVoicePref('speak', v));
  wireSeg('vDelay', v => setVoicePref('autoSend', Number(v)));
  wireSeg('vBarge', v => setVoicePref('bargeIn', v === 'on'));
  host.querySelector('#vVoice')?.addEventListener('change', (e) => setVoicePref('voice', e.target.value));
  host.querySelector('#vPrev')?.addEventListener('click', () => {
    if (!TTS) return;
    try { TTS.cancel(); } catch { /* noop */ }
    const u = new SpeechSynthesisUtterance('Ready — this is how agent replies will sound.');
    const v = voicePickVoice();
    if (v) u.voice = v;
    u.rate = Number(voicePrefs().rate) || 1;
    TTS.speak(u);
  });
  // voices arrive async on first load in some browsers — refresh the picker once
  if (TTS && !(TTS.getVoices() || []).length) {
    TTS.addEventListener?.('voiceschanged',
      () => { if (ui.view === 'settings') renderSettings(); }, { once: true });
  }
}

/* global gestures — wired once: hold Space (outside inputs) is push-to-talk,
   Esc cancels listening / countdown / speaking */
if (SR_CTOR || TTS) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (voiceSt.status === 'listening') { voiceStopListening(false); return; }
      if (voiceSt.status === 'counting') { voiceCancelCountdown(); return; }
      if (voiceSt.sp.q.length) voiceStopSpeaking();
      return;
    }
    if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    // I3 triple guard, leg (b) — blueprint §2 "EditContext posture" (P18,
    // C2-MF2): a Space born anywhere inside the Monaco editor NEVER starts
    // the mic. Under the EDITCONTEXT PIN the input surface is a real
    // <textarea>, so the tag predicate above already bails today — this
    // closest-bail is the leg that stays load-bearing if the surface ever
    // flips to EditContext (a DIV, where every tag test above reads dead
    // air). Leg (c) is the real-CDP-keystroke case in ui.voice.test.mjs
    // ('Space while Monaco focused never mics'). The keyup handler below
    // needs no twin: spaceHeld only arms via a keydown that passed these
    // bails, so a stray Space-up can never stop a mic it didn't start.
    if (e.target.closest && e.target.closest('.monaco-editor')) return;
    const key = ui.view;
    if (!state.projects[key]) return;
    const t = curTask(key);
    if (!t || !document.querySelector(`#v-${CSS.escape(key)} #micBtn`)) return;
    e.preventDefault();
    if (voiceSt.sp.q.length) { // speaking → Space ducks playback (and listens if barge-in)
      const barge = voicePrefs().bargeIn;
      voiceStopSpeaking();
      if (!barge) return;
    }
    if (voiceSt.status !== 'listening') {
      voiceSt.spaceHeld = true;
      voiceStartListening(key, t.id);
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !voiceSt.spaceHeld) return;
    voiceSt.spaceHeld = false;
    if (voiceSt.status === 'listening') voiceStopListening(true);
  });
}
