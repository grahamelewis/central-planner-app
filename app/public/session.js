// session.js — the session pane, split verbatim out of app.js (phase 2):
// launch/manual/handoff/auth/kaimon cards, sessionBody + composer html, the
// themed dropdown portal, model/perm/effort selectors + task PATCH setters,
// sendMsg.

import { enc, esc, OVS_LABEL, fmtTok, tokenTooltip, toast, confirmBox } from './util.js';
import {
  state, ui, tailBufs, transcripts, pendingPerms, composerDrafts, queuedMsgs,
  tasksOf, taskProvider, agentName, providerState, providerModels,
  providerExplicitlyBlocked, perOf, DEFAULT_MODEL, effortsFor, coerceEffort,
} from './store.js';
import { api } from './net.js';
import { pumps, pumpConsole, seedTailBuf } from './console.js';
import { appendConsoleText, bindConsoleTurn, reviseConsoleText } from './consoleOwnership.js';
import { texFixCardHtml } from './texrun.js';
import { MIC_OK } from './voice.js';
import { renderWB, focusOn } from './workbench.js';
import {
  beginSubmission, acknowledgeSubmission, stopControlHtml, savedDraftsHtml,
  pausedQueues, recallPending, persistRecallState, transcriptRevision,
  trackSubmissionDelivery,
} from './undoSend.js';

/* themed dropdown (replaces the native <select>): a pill trigger + a themed
   menu wired in wireWB. dropItem[data-val] → setTaskModel/setTaskPerm. */
/**
 * Themed dropdown markup (portaled open-state lives in openDropdown).
 * @param {string} kind data-drop discriminator
 * @param {string} cls button class
 * @param {string} head menu heading
 * @param {*} cur current option id
 * @param {{ id?: *, label?: string, hint?: string }[]} opts
 * @param {string} title tooltip
 * @returns {string} html
 */
export function dropHtml(kind, cls, head, cur, opts, title) {
  // a cur outside opts (e.g. a task pinned to a retired model) shows verbatim
  const label = (opts.find(o => (o.id ?? '') === cur) || { label: cur || opts[0].label }).label;
  return `<div class="drop" data-drop="${kind}" title="${esc(title)}">
    <span class="dropBtn ${cls}" tabindex="0">${esc(label)} <span class="cv">▾</span></span>
    <div class="dropMenu"><div class="dropHead">${esc(head)}</div>
      ${opts.map(o => { const sel = (o.id ?? '') === cur;
        return `<div class="dropItem${sel ? ' sel' : ''}" data-val="${esc(o.id ?? '')}"><span class="ck">${sel ? '✓' : ''}</span>${esc(o.label)}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</div>`;
      }).join('')}
    </div></div>`;
}

/* The open menu is PORTALED to a top-level fixed layer so it escapes the session
   pane's overflow:hidden (which was clipping it when the pane is short) — the
   same trick a native <select> uses. It flips up/down to fit and scrolls if the
   viewport is tight, so every option is always reachable. */
let _openDrop = null; // { drop, menu }
/**
 * @returns {Element} the fixed top-level layer dropdown menus portal into
 */
export function dropPortal() {
  let el = document.getElementById('dropPortal');
  if (!el) { el = document.createElement('div'); el.id = 'dropPortal'; document.body.appendChild(el); }
  return el;
}
/**
 * Close any open dropdown/side menu.
 * @returns {void}
 */
export function closeDrops() {
  if (!_openDrop) return;
  const { drop, menu } = _openDrop;
  _openDrop = null;
  drop.classList.remove('open');
  menu.removeAttribute('style'); // back to the base .dropMenu CSS (hidden in .drop)
  drop.appendChild(menu);        // restore into its trigger (or its detached remains)
}
/**
 * Open a .drop's menu in the portal (flips up/down to fit the viewport).
 * @param {Element} drop the .drop root
 * @returns {void}
 */
export function openDropdown(drop) {
  closeDrops();
  const btn = drop.querySelector('.dropBtn');
  const menu = drop.querySelector('.dropMenu');
  if (!btn || !menu) return;
  dropPortal().appendChild(menu);
  const r = btn.getBoundingClientRect();
  const gap = 6, pad = 8;
  menu.style.position = 'fixed';
  menu.style.display = 'block';
  menu.style.bottom = 'auto';
  menu.style.zIndex = '200';
  menu.style.left = `${r.left}px`;
  menu.style.minWidth = `${Math.max(r.width, 150)}px`;
  menu.style.maxHeight = 'none';
  const mh = menu.offsetHeight;                 // natural height, unconstrained
  const above = r.top - pad;
  const below = window.innerHeight - r.bottom - pad;
  if (mh <= above || above >= below) {          // flip UP (more room, or fits)
    const h = Math.min(mh, above);
    menu.style.maxHeight = `${h}px`;
    menu.style.top = `${r.top - gap - h}px`;
  } else {                                       // flip DOWN
    const h = Math.min(mh, below);
    menu.style.maxHeight = `${h}px`;
    menu.style.top = `${r.bottom + gap}px`;
  }
  menu.style.overflowY = 'auto';
  const mw = menu.offsetWidth;                   // keep it on-screen horizontally
  if (r.left + mw > window.innerWidth - pad) menu.style.left = `${Math.max(pad, window.innerWidth - pad - mw)}px`;
  drop.classList.add('open');
  _openDrop = { drop, menu };
}

/* The sidebar's ＋ menus (pin a file, add lineage) used to be right-anchored
   absolute boxes inside their .sh header — but the sidebar is the LEFTMOST
   column, so a menu wider than it (linMenu's headers saturate its 300px cap
   with any linkable task at all) grew leftward straight through x=0, and that
   overflow is unreachable: LTR gives no leftward scroll region and the root
   clips x (CONTRACT "Viewport sturdiness"). Same cure as the model dropdowns:
   portal to the body as a FIXED box, right edge on the trigger but clamped
   on-screen, height capped to the room below. */
/**
 * Portal a sidebar ＋ menu to the body as a FIXED box clamped on-screen
 * (a right-anchored menu in the leftmost column escapes into overflow).
 * @param {*} menu the menu element
 * @param {*} trigger the button anchoring it
 * @returns {void}
 */
export function placeSideMenu(menu, trigger) {
  document.body.appendChild(menu);
  const r = trigger.getBoundingClientRect(), gap = 4, pad = 8;
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  menu.style.zIndex = '200';
  menu.style.top = `${r.bottom + gap}px`;
  const mw = menu.offsetWidth;
  menu.style.left = `${Math.min(Math.max(pad, r.right - mw), window.innerWidth - pad - mw)}px`;
  const below = window.innerHeight - r.bottom - gap - pad;
  if (menu.offsetHeight > below) {
    menu.style.maxHeight = `${Math.max(120, below)}px`;
    menu.style.overflowY = 'auto';
  }
  // any scroll outside the menu would drift a fixed box away from its trigger
  // — close instead, exactly like the model dropdowns; the listener also
  // self-unregisters once the menu is gone by any other exit path
  const onScroll = (e) => {
    if (menu.isConnected && menu.contains(e.target)) return; // its own scrollbar
    window.removeEventListener('scroll', onScroll, true);
    menu.remove();
  };
  window.addEventListener('scroll', onScroll, true);
}

/**
 * The sessbar's engine · model dropdown for a task.
 * @param {Task} task
 * @returns {string} html
 */
export function providerModelSelHtml(task) {
  const currentProvider = taskProvider(task);
  const currentModels = providerModels(currentProvider);
  const fallbackModel = currentProvider === 'claude' ? DEFAULT_MODEL : (currentModels.find(m => m.isDefault)?.id || currentModels[0]?.id || 'Codex default');
  const currentModel = task.model || fallbackModel;
  const currentLabel = currentModels.find(m => m.id === currentModel)?.label || currentModel;
  const groups = ['claude', 'codex'].map((provider) => {
    const p = providerState(provider);
    const models = providerModels(provider);
    const suffix = p.connected ? 'connected' : p.checking ? 'checking…' : 'not connected';
    const rows = models.length
      ? models.map((m) => {
        const selected = provider === currentProvider && m.id === currentModel;
        return `<div class="dropItem providerModel${selected ? ' sel' : ''}" data-provider="${provider}" data-val="${esc(m.id)}">
          <span class="ck">${selected ? '✓' : ''}</span><span>${esc(m.label || m.id)}</span>
          ${m.isDefault ? '<span class="hint">default</span>' : ''}</div>`;
      }).join('')
      : `<div class="dropEmpty">${provider === 'codex' ? 'Connect Codex to load its model catalog' : 'No models reported'}</div>`;
    return `<div class="dropHead providerHead ${provider}"><span>${agentName(provider)}</span><em>${esc(suffix)}</em></div>${rows}`;
  }).join('');
  return `<div class="drop providerDrop" data-drop="model" title="provider and model for the next turn">
    <span class="dropBtn model ${currentProvider}" tabindex="0"><i class="providerGlyph">${currentProvider === 'codex' ? '⌘' : '✦'}</i>${agentName(currentProvider)} · ${esc(currentLabel)} <span class="cv">▾</span></span>
    <div class="dropMenu providerMenu">${groups}</div></div>`;
}

/**
 * @param {Task} task
 * @returns {string} html
 */
export function modelSelHtml(task) { return providerModelSelHtml(task); }

/* one effort control for both providers — same pill, same menu; only the
   ladder differs (Codex may also report a per-model subset) */
export function reasoningSelHtml(task) {
  const provider = taskProvider(task);
  const model = providerModels(provider).find(m => m.id === task.model);
  const supported = provider === 'codex' && Array.isArray(model?.supportedReasoningEfforts) && model.supportedReasoningEfforts.length
    ? model.supportedReasoningEfforts.map(r => ({ id: r.id || r.reasoningEffort, label: r.id || r.reasoningEffort })).filter(r => r.id)
    : effortsFor(provider);
  const current = task.reasoningEffort || model?.defaultReasoningEffort || 'high';
  return dropHtml('effort', 'effort', 'Reasoning effort', current, supported,
    `${agentName(provider)} reasoning effort — applies from the next turn`);
}

/* permission prompting, decoupled from oversight: the oversight appendix
   (e.g. cooperative back-and-forth) is injected every turn regardless */
/** @type {{ id: string | null, label: string }[]} */
export const PERM_MODES = [
  { id: null, label: '🛡 by oversight' },
  { id: 'default', label: '🛡 ask first' },
  { id: 'acceptEdits', label: '🛡 auto-edits' },
  { id: 'auto', label: '🛡 auto (classifier)' },
  { id: 'bypassPermissions', label: '🛡 full auto' },
];

/**
 * The 🛡 permission-override dropdown.
 * @param {Task} task
 * @returns {string} html
 */
export function permSelHtml(task) {
  if (task.oversight === 'propose') {
    // plan mode is what makes propose propose — no override offered (locked pill)
    return `<div class="drop dropDisabled" data-drop="perm" title="propose tasks always run in plan mode — the permission override is disabled so plans can't silently execute">
      <span class="dropBtn perm">🛡 plan (locked)</span></div>`;
  }
  return dropHtml('perm', 'perm', 'Permission', task.permMode || '', PERM_MODES,
    'permission prompting — oversight behavior (coop/auto) is unaffected; applies from the next turn');
}

/**
 * PATCH the task's 🛡 permission override.
 * @param {string} key project key
 * @param {Task} task
 * @param {string | null} permMode
 * @returns {Promise<void>}
 */
export async function setTaskPerm(key, task, permMode) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  local.permMode = permMode;
  renderWB(key);
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { permMode });
  toast(permMode === 'bypassPermissions' ? 'next turn runs fully unattended — rewind is your safety net'
    : permMode === 'auto' ? 'next turn: a classifier approves routine calls, only dangerous ones ask'
    : permMode === 'acceptEdits' ? 'next turn auto-accepts file edits (bash still asks)'
    : permMode === 'default' ? 'next turn asks before tool use'
    : 'next turn uses the oversight default');
}

/**
 * Switch a task's provider (+model) — confirmed when thread history exists.
 * @param {string} key project key
 * @param {Task} task
 * @param {string} provider
 * @param {string | null} [modelId]
 * @returns {Promise<void>}
 */
export async function setTaskEngine(key, task, provider, modelId) {
  const currentProvider = taskProvider(task);
  const crossing = provider !== currentProvider;
  let confirmedBoundary = false;
  if (crossing && (task.session || transcripts[`${key}/${task.id}`]?.entries?.length)) {
    confirmedBoundary = await confirmBox(
      `Switch this task from <b>${agentName(currentProvider)}</b> to <b>${agentName(provider)}</b>?<br><small>The shared dashboard transcript stays visible, but the next turn starts a fresh ${agentName(provider)}-owned thread. There is no silent fallback between services.</small>`,
      `Switch to ${agentName(provider)}`);
    if (!confirmedBoundary) return;
  }
  const patch = { provider, model: modelId || null };
  // keep the effort where both ladders share it; otherwise the nearest rung
  if (crossing) patch.reasoningEffort = coerceEffort(provider, task.reasoningEffort);
  // Selecting the other provider is itself the explicit user action. The
  // extra dialog appears when known history makes the consequence material;
  // always send the server-side boundary acknowledgement so a transcript not
  // yet fetched into this browser cannot turn the selection into a dead-end.
  if (crossing) patch.startNewProviderThread = true;
  const saved = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, patch);
  if (!saved) return;
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  Object.assign(local, saved);
  renderWB(key);
  const label = providerModels(provider).find(m => m.id === modelId)?.label || modelId || 'default model';
  toast(crossing
    ? `${agentName(provider)} selected · ${label} — the next turn starts a fresh provider thread`
    : `next turn runs on ${label}`);
}

/**
 * PATCH the task's model (applies from the next turn).
 * @param {string} key project key
 * @param {Task} task
 * @param {string} modelId
 * @returns {Promise<void>}
 */
export async function setTaskModel(key, task, modelId) {
  return setTaskEngine(key, task, taskProvider(task), modelId);
}

/**
 * PATCH the task's reasoning effort (either provider).
 * @param {string} key project key
 * @param {Task} task
 * @param {string} effort
 * @returns {Promise<void>}
 */
export async function setTaskReasoning(key, task, effort) {
  const saved = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { reasoningEffort: effort });
  if (!saved) return;
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  Object.assign(local, saved);
  renderWB(key);
  toast(`next ${agentName(taskProvider(task))} turn uses ${effort} reasoning effort`);
}

/**
 * The done task's handoff record card.
 * @param {Task} t
 * @returns {string} html
 */
export function handoffCard(t) {
  const h = t.handoff || {};
  const arts = Array.isArray(h.artifacts) ? h.artifacts : [];
  const nums = Array.isArray(h.numbers) ? h.numbers : [];
  const decs = Array.isArray(h.decisions) ? h.decisions : [];
  return `<div class="handoff">
    <div class="hh">✓ complete — handoff record <span>stored in the task json · injected downstream</span></div>
    <div class="hsum">${esc(h.summary || '')}</div>
    ${arts.length ? `<div class="hsec">Files that matter</div>` + arts.map(a => {
      const [f, n] = Array.isArray(a) ? a : [a, ''];
      return `<div class="hfile"><code>${esc(f)}</code><span>${esc(n || '')}</span></div>`;
    }).join('') : ''}
    ${nums.length ? `<div class="hsec">Key numbers</div><div class="hnums">` + nums.map(p => {
      const [k2, v] = Array.isArray(p) ? p : [p, ''];
      return `<span class="qchip on">${esc(k2)}: <b>${esc(v)}</b></span>`;
    }).join('') + `</div>` : ''}
    ${decs.length ? `<div class="hsec">Decisions that matter later</div>` + decs.map(d => `<div class="hdec">· ${esc(d)}</div>`).join('') : ''}
    ${h.next ? `<div class="hsec">Note to downstream tasks</div><div class="hnext">${esc(h.next)}</div>` : ''}
  </div>`;
}

/**
 * The queued task's launch card (context chips + Launch).
 * @param {string} key project key
 * @param {Task} task
 * @returns {string} html
 */
export function launchCard(key, task) {
  const ctx = task.context || {};
  const provider = taskProvider(task);
  const agent = agentName(provider);
  const chips = [];
  if (ctx.include_abstract) chips.push('✓ living abstract');
  if (ctx.include_last_session) chips.push('✓ last session');
  if (ctx.include_sibling_tasks) chips.push('✓ sibling tasks');
  if (ctx.include_category_primer) chips.push('✓ category primer');
  (Array.isArray(task.upstream) ? task.upstream : []).forEach(id => chips.push('⛓ handoff: ' + id));
  (Array.isArray(ctx.files) ? ctx.files : []).forEach(f => chips.push(String(f)));
  return `<div class="taskHero">${texFixCardHtml(key)}<div class="queueCard">
    ${authCardHtml(key, task)}
    <div class="qt">${esc(task.title)}</div>
    <div class="qdesc">${esc(task.description || '')}</div>
    <div class="qmeta"><span class="ovs ${esc(task.oversight)}">${OVS_LABEL[task.oversight] || ''}</span>
      <span class="qchip" style="font-size:9.5px;padding:2px 9px;">${esc(task.category || '')}</span>
      queued — session not yet started</div>
    <div class="qsec">Context packet — assembled at launch</div>
    <div class="qchips">
      ${ctx.web_search?.sources?.length ? `<span class="qchip on">🌐 sources — ${esc(ctx.web_search.sources.join(' · '))}</span>` : ''}
      ${chips.map(c =>
      `<span class="qchip ${/^[✓⛓]/u.test(c) ? 'on' : ''}">${esc(c)}</span>`).join('')}</div>
    ${ctx.notes ? `<div class="qsec">Your notes to ${agent}</div><div class="qnotes">${esc(ctx.notes)}</div>` : ''}
    <div class="qlaunch">
      <button id="launchBtn" ${providerExplicitlyBlocked(provider) ? 'disabled title="connect this service before launching"' : ''}>▶ Launch ${agent}</button>
      <span class="alt">${modelSelHtml(task)} ${reasoningSelHtml(task)} ${permSelHtml(task)} · oversight ${OVS_LABEL[task.oversight] || '?'}</span>
    </div>
  </div></div>`;
}

/**
 * The manual task's no-session card.
 * @param {string} key project key
 * @param {Task} task
 * @returns {string} html
 */
export function manualCard(key, task) {
  return `<div class="taskHero">${texFixCardHtml(key)}<div class="queueCard">
    <div class="qt">${esc(task.title)}</div>
    <div class="qdesc">${esc(task.description || '')}</div>
    <div class="qmeta"><span class="ovs manual">MAN</span> manual — no agent attached${task.due ? ` · due ${esc(task.due)}` : ''}</div>
    ${task.context?.notes ? `<div class="qnotes" style="margin-top:14px;">${esc(task.context.notes)}</div>` : ''}
    <div class="qlaunch">
      <button id="markDoneBtn" style="background:var(--glass);color:var(--ink);border:1px solid var(--ov2a);">✓ Mark done</button>
    </div>
  </div></div>`;
}

// One-time enable card for the warm Julia REPL: shown in Julia projects when
// Kaimon isn't installed. One click installs it; after that the daemon is
// fully dashboard-managed (nothing else to configure, ever).
/**
 * The one-click Kaimon enable/install card (empty string when silent).
 * @param {string} key project key
 * @returns {string} html
 */
export function kaimonCardHtml(key) {
  /** @type {KaimonState} */
  const ka = state.kaimon || {};
  if (!ka.enabled || !ka.julia?.[key]) return '';
  const inst = ka.install || {};
  if (inst.state === 'running') {
    const last = (inst.tail || '').trim().split('\n').pop() || 'downloading…';
    return `<div class="runHint"><span class="live"></span>installing Kaimon (a few minutes of download + precompile)
      <span style="color:var(--dim);font-size:10px;font-family:var(--mono,monospace);">${esc(last.slice(-80))}</span></div>`;
  }
  if (ka.available) return ''; // installed → the feature is silent + automatic
  if (localStorage.kaimonDismissed) return '';
  if (inst.state === 'error') {
    return `<div class="runHint" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);">
      Kaimon install failed — ${esc(inst.error || 'unknown error')}
      <button id="kaimonInstallBtn" style="background:var(--green);color:var(--on-accent);border:none;border-radius:8px;padding:4px 12px;font-weight:800;font-size:11px;cursor:pointer;margin-left:6px;">retry</button></div>`;
  }
  return `<div class="runHint">🔥 Julia project — enable the warm REPL? Sessions keep packages and state
    loaded across turns instead of re-spawning julia (one-time install of
    <a href="https://github.com/kahliburke/Kaimon.jl" target="_blank" rel="noreferrer" style="color:var(--green);">Kaimon.jl</a>; needs Julia ≥ 1.12)
    <button id="kaimonInstallBtn" style="background:var(--green);color:var(--on-accent);border:none;border-radius:8px;padding:4px 12px;font-weight:800;font-size:11px;cursor:pointer;margin-left:6px;">Enable</button>
    <span class="ctl" id="kaimonDismissBtn" title="hide this — durable opt-out: set &quot;kaimon&quot;: false in config.json">×</span></div>`;
}

/* ── the missing-toolchain notice ──
   The projects snapshot says which runtimes a project's markers imply
   (Cargo.toml → rust, go.mod → go, package.json → node, CMakeLists/Makefile →
   c/cpp, …) and which of those the server cannot run; state.toolchains has
   the install hint. Dismissable per project until the missing set changes. */
/**
 * One line per missing toolchain this project needs (empty string when none).
 * @param {string} key project key
 * @returns {string} html
 */
export function toolchainNoticeHtml(key) {
  const needs = state.projects?.[key]?.toolchains;
  const missing = needs?.missing || [];
  if (!missing.length) return '';
  const sig = missing.join(',');
  try { if (localStorage.getItem(`tcDismissed:${key}`) === sig) return ''; } catch { /* storage off */ }
  const lines = missing.map((id) => {
    /** @type {ToolchainInfo | null} */
    const t = state.toolchains?.[id] || null;
    const label = t?.label || id;
    const marker = needs.markers?.[id];
    const what = marker ? `a ${marker.split('/').pop()}` : `${label} files`;
    const bins = (t?.missing?.length ? t.missing : [id]).join(' / ');
    return `This project has ${what} but ${bins} is not installed${t?.hint ? ` — install with ${t.hint}` : ''}`;
  });
  return `<div class="runHint" id="tcNotice" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);">🧰 <span>${lines.map(esc).join('<br>')}</span>
    <span class="ctl" id="tcDismissBtn" data-key="${esc(key)}" data-sig="${esc(sig)}" title="hide this until the set of missing toolchains changes — Settings › Toolchains lists them all">×</span></div>`;
}
if (typeof document !== 'undefined') {
  // the card is rendered by sessionBody and wired here by delegation so no
  // other module has to know about it
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? /** @type {HTMLElement | null} */ (e.target.closest('#tcDismissBtn')) : null;
    if (!btn) return;
    try { localStorage.setItem(`tcDismissed:${btn.dataset.key}`, btn.dataset.sig || ''); } catch { /* storage off */ }
    renderWB(btn.dataset.key);
  });
}

/* ── the Claude sign-in card ──
   Shown wherever a next turn could run, whenever the server knows Claude is
   unreachable for auth reasons (state.auth.needed — set by a failed turn, the
   boot check, or a client-connect check). Sign in runs the CLI's own browser
   flow server-side; auth:status broadcasts drive the card's states and clear
   it everywhere once you're back in. */
/**
 * The amber Claude sign-in card (empty string when signed in).
 * @param {string} key project key
 * @param {Task} [task]
 * @returns {string} html
 */
export function authCardHtml(key, task) {
  const provider = taskProvider(task);
  if (provider === 'codex') return codexAuthCardHtml(key, task);
  /** @type {AuthState} */
  const a = state.auth || {};
  if (!a.needed) return '';
  if (task && (task.status === 'done' || task.archived || task.oversight === 'manual')) return '';
  const apikey = a.method === 'apikey';
  const canRetry = !!(task && task.session);
  // only the browser sign-in replaces the buttons — an ambient status check
  // just adds a quiet line, so the buttons never flicker away under it
  const body = a.loggingIn
    ? `<div class="acWait"><span class="acSpin"></span><span>opening the browser sign-in… the card clears once you’re back in</span></div>`
    : `<div class="acRow">
        ${apikey ? '' : '<button class="acSign" id="authSignBtn">Sign in</button>'}
        ${canRetry ? '<button class="acRetry" id="authRetryBtn">↻ Retry turn</button>' : ''}
      </div>`
      + (a.checking ? `<div class="acWait sub"><span class="acSpin"></span><span>checking sign-in status…</span></div>` : '');
  return `<div class="authCard">
    <div class="acH">${apikey ? 'The server’s Claude API key was rejected' : 'Your Claude login has expired'}</div>
    <div class="acP">${apikey
    ? 'Claude couldn’t be reached with the ANTHROPIC_API_KEY this server was started with. Update the key in the server environment and restart, then retry.'
    : 'Claude couldn’t be reached, so turns come back empty. Sign in again to continue — your conversation and task are untouched.'}</div>
    ${body}
    ${a.loginError && !a.loggingIn ? `<div class="acErr">${esc(a.loginError)}</div>` : ''}
    ${apikey ? '' : `<div class="acFall">Prefer the terminal? Run <code>claude auth login</code>, then ${canRetry ? 'hit Retry' : 'relaunch'}.</div>`}
  </div>`;
}

/**
 * The Codex sign-in/connect card (empty string when connected).
 * @param {string} key project key
 * @param {Task} [task]
 * @returns {string} html
 */
export function codexAuthCardHtml(key, task) {
  const c = providerState('codex');
  if (c.connected || (!c.lastChecked && !c.error && !c.loginError)) return '';
  if (task && (task.status === 'done' || task.archived || task.oversight === 'manual')) return '';
  const canRetry = !!(task && task.session?.provider === 'codex');
  const unavailable = c.available === false;
  const body = c.loggingIn
    ? `<div class="acWait"><span class="acSpin"></span><span>finish signing in in the browser… this card clears automatically</span></div>`
    : `<div class="acRow">
        ${unavailable ? '' : '<button class="acSign codex" id="codexSignBtn">Connect Codex</button>'}
        <button class="acRetry" id="codexCheckBtn">↻ Check again</button>
        ${canRetry ? '<button class="acRetry" id="codexRetryBtn">Retry turn</button>' : ''}
      </div>`;
  return `<div class="authCard codexCard">
    <div class="acH">${unavailable ? 'Codex CLI is not installed' : c.loginError ? 'Codex sign-in did not complete' : 'Connect Codex to continue'}</div>
    <div class="acP">${unavailable
    ? 'This dashboard talks to the local Codex CLI. Install it on the server machine, then check again; this task and transcript are untouched.'
    : 'Codex uses its own ChatGPT sign-in and usage limits. Connecting Claude does not connect Codex, and the dashboard will never silently send this turn to another service.'}</div>
    ${body}
    ${(c.loginError || c.error) && !unavailable ? `<div class="acErr">${esc(c.loginError || c.error)}</div>` : ''}
    <div class="acFall">Terminal fallback: run <code>codex login</code>, then click Check again.</div>
  </div>`;
}

/* flat line-art voice glyphs (currentColor → they take the state color: grey at
   rest, --green listening, --purple speaking). Replaces the 🎙/🔊 emoji, which
   were the only color stickers in an otherwise monochrome, SVG-glyph UI. */
export const MIC_SVG = '<svg class="micSvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>';
export const SPK_SVG = '<svg class="micSvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 6a9 9 0 0 1 0 12"/></svg>';

/**
 * The session pane's full body for a task (cards / transcript host +
 * sessbar + composer).
 * @param {string} key project key
 * @param {Task | null} task
 * @returns {string} html
 */
export function sessionBody(key, task) {
  const st = task.status;
  const provider = taskProvider(task);
  const agent = agentName(provider);
  // a missing toolchain is worth knowing before launch, not only after
  if (st === 'queued') return toolchainNoticeHtml(key) + launchCard(key, task);
  if (st === 'manual') return manualCard(key, task);

  // the entry pane: things that need YOU (questions, approvals, handoffs) plus
  // the composer — the conversation itself streams into the ≋ console tab
  const k = `${key}/${task.id}`;
  const parts = [];
  // signed-out beats everything — no turn can run until this clears
  const authCard = authCardHtml(key, task);
  if (authCard) parts.push(authCard);
  const fixCard = texFixCardHtml(key);
  if (fixCard) parts.push(fixCard);
  const kaCard = kaimonCardHtml(key);
  if (kaCard && st !== 'done' && !task.archived) parts.push(kaCard);
  const tcCard = toolchainNoticeHtml(key);
  if (tcCard && st !== 'done' && !task.archived) parts.push(tcCard);
  // NOTE: a handoff on a still-waiting task renders NOTHING here on purpose —
  // sessions cannot propose completion; the record only surfaces once the
  // user's ✓ complete flow closes the task (the done card below).
  if (st === 'done' && task.handoff) {
    parts.push(handoffCard(task));
  }
  if (st === 'running') {
    parts.push(perOf(key).interrupting === task.id
      ? `<div class="runHint" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);"><span class="live" style="background:var(--yellow)"></span>interrupting — finishing the current step…</div>`
      // in focus mode the console streams right here — no pointer needed
      : focusOn() ? '' : `<div class="runHint"><span class="live"></span>${agent} is working — follow along in the <b>≋ console</b> tab</div>`);
  }
  // NOTE: live job cards and Claude's QUESTION blocks deliberately do NOT
  // render in the session pane — both live only in the ≋ console (csJobs /
  // the pink cs-ques segment). Showing the same thing in both panes was
  // redundant; the pane keeps just the composer and needs-YOU action cards.
  const perms = pendingPerms[k];
  if (perms && perms.length && !focusOn()) { // focus: the approval cards are visible in the hosted console
    parts.push(`<div class="runHint" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);">
      <span class="live" style="background:var(--yellow)"></span>
      ${perms.length} approval${perms.length > 1 ? 's' : ''} pending — review in the <b>≋ console</b> tab</div>`);
  }
  // no empty-state hint: the composer is the whole point of the pane, and it's
  // bigger now — the conversation stream lives in the ≋ console tab
  const s = task.session;
  // 2026-08-07 session-bar simplification: the web and voice toggles are GONE
  // (both always on now), and oversight/category no longer display here —
  // oversight still shows in the tab chip, categories live on in packets.
  // warm-REPL chip: the shared daemon is up and this is a Julia project —
  // this task's turns get the mcp__kaimon__ tools
  const warmChip = (state.kaimon?.daemon?.state === 'ready' && state.kaimon?.julia?.[key])
    ? `<span title="warm Julia REPL connected — sessions keep packages and state loaded across turns" style="color:var(--green);">◉ warm REPL</span>`
    : '';
  const sessbar = `<div class="sessbar">
    <span>${modelSelHtml(task)}</span>
    ${reasoningSelHtml(task) ? `<span>${reasoningSelHtml(task)}</span>` : ''}
    <span>${permSelHtml(task)}</span>
    ${warmChip}
    ${s
    ? `<span title="${esc(tokenTooltip(s, 'Saved task session counter'))}. Active work may not yet be included."><b>${fmtTok((s.tokensIn || 0) + (s.tokensOut || 0))} tok processed${s.usageHasIncomplete || ['partial', 'unknown'].includes(s.usageCompleteness) ? ' · partial' : ''}</b> · ${s.turns || 0} turn${s.turns === 1 ? '' : 's'}</span>`
    : '<span>no session yet</span>'}</div>`;
  // messages typed mid-turn wait here, visibly — each × returns to the composer
  const qd = queuedMsgs[k] || [];
  const queuedBar = qd.length
    ? `<div class="queuedBar">${qd.map((q, i) =>
      `<div class="queuedMsg"><span class="qTag">⏳ queued</span><span class="qTxt">${esc(q)}</span>
        <button class="qx" data-unqueue="${i}" title="don't send — back to the composer">×</button></div>`).join('')}
      <div class="qNote">${pausedQueues.has(k) ? 'Paused — return messages to the composer when ready' : 'sends when this turn ends'}</div></div>`
    : '';
  const composerPlaceholder = st === 'running' ? 'Queue a message…' : `Message ${agent}…`;
  const composerTitle = `${st === 'running' ? 'Enter queues for when the turn ends' : 'Enter sends'}, ⇧Enter for a new line`;
  const foot = st === 'done'
    ? `<div class="closedbar">task complete · handoff recorded ✓</div>`
    : `${queuedBar}${savedDraftsHtml(key, task.id)}<div class="composer">
        <textarea id="composerInput" rows="1"
          placeholder="${esc(composerPlaceholder)}" title="${esc(composerTitle)}"
          aria-label="${st === 'running' ? `Queue a message for ${agent}` : `Message ${agent}`}">${esc(composerDrafts[k] || '')}</textarea>
        ${MIC_OK ? `<button class="micBtn" id="micBtn" title="hold to talk — or hold Space anywhere">${MIC_SVG}</button>` : ''}
        ${stopControlHtml(key, task)}
        <button class="send" id="sendBtn"${recallPending(key, task.id) ? ' disabled' : ''}>Send</button>
      </div><div class="voiceHint" id="voiceHint" style="display:none"></div>${sessbar}`;
  // focus mode: the ≋ console mounts HERE, above the composer — watch the
  // stream and talk to the session in one pane while the editor keeps the
  // left. Same #consoleBox contract as the center tab (which focus removes,
  // so the id stays unique); every painter finds it by id/data-key.
  const consoleHost = focusOn()
    ? `<div class="consoleBox" id="consoleBox" data-key="${esc(seedTailBuf(key, task))}"></div>` : '';
  return `<div class="chat"><div class="log${consoleHost ? ' logFocus' : ''}" id="chatLog">${parts.join('')}${consoleHost}</div>${foot}</div>`;
}

/**
 * Send a user message to the task's session (queues while a turn runs;
 * launches queued tasks; POST /api/tasks/:p/:id/message).
 * @param {string} project
 * @param {string} id task id
 * @param {string} text
 * @param {{ explicit?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function sendMsg(project, id, text, { explicit = false } = {}) {
  const k = `${project}/${id}`;
  transcriptRevision[k] = (transcriptRevision[k] || 0) + 1;
  const submission = explicit ? beginSubmission(project, id, text) : null;
  // the echoes below are OPTIMISTIC — if the server refuses the message they
  // are rolled back, else the ▸ you marker strands mid-stream and everything
  // the still-running turn emits after it renders inside the you-bubble
  const requestId = submission?.requestId || crypto.randomUUID();
  const entry = { role: 'user', text, ts: new Date().toISOString(), requestId, turnId: null };
  (transcripts[k] ?? (transcripts[k] = { entries: [], fetched: true })).entries.push(entry);
  // a live console buffer gets the message inline (same marker format the
  // transcript seed uses) — without this, a mid-conversation console never
  // shows what you just sent, and the next turn's output appears unprompted
  const splice = `\n▸ you ─────────\n${text}\n`;
  const echoed = !!tailBufs[k];
  if (echoed) {
    tailBufs[k] = appendConsoleText(k, tailBufs[k], splice, entry);
    if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
  }
  if (ui.view === project) renderWB(project);
  const delivery = api('POST', `/api/tasks/${enc(project)}/${enc(id)}/message`, {
    text, requestId,
  });
  if (submission) trackSubmissionDelivery(project, id, submission, delivery);
  const response = await delivery;
  // Recall can win while /message is still in flight. Its canonical history
  // and restored draft must never be overwritten by this older response.
  if (submission?.restored) return;
  const recalling = submission && ['recalling', 'recall-recovery'].includes(submission.phase);
  if (submission && (response || !recalling)) acknowledgeSubmission(project, id, submission, response);
  if (response) {
    entry.turnId = response.turnId || null;
    bindConsoleTurn(k, requestId, entry.turnId);
    persistRecallState(); return;
  }
  // refused (a turn raced in, task deleted…) — undo both echoes and keep the
  // text: it lands back in the composer, never silently lost
  const entries = transcripts[k]?.entries;
  const ei = entries ? entries.lastIndexOf(entry) : -1; // identity — a refreshTranscript swap just misses
  if (ei >= 0) entries.splice(ei, 1);
  if (echoed && tailBufs[k]) {
    const cut = tailBufs[k].lastIndexOf(splice);
    if (cut >= 0) tailBufs[k] = reviseConsoleText(k, tailBufs[k], tailBufs[k].slice(0, cut) + tailBufs[k].slice(cut + splice.length));
    if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
  }
  if (!recalling && !submission?.draftRecovered) composerDrafts[k] = composerDrafts[k] ? `${text}\n\n${composerDrafts[k]}` : text;
  persistRecallState();
  toast(recalling ? 'delivery unconfirmed — original prompt retained while restoration finishes'
    : 'message not delivered — kept in the composer');
  if (ui.view === project) renderWB(project);
}
