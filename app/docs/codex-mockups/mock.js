/* Interactive scaffolding shared by the Codex/provider HTML mockups. */
(() => {
  'use strict';

  const pages = [
    ['01-dual-service.html', '01 both'],
    ['02-model-picker.html', '02 chooser'],
    ['03-claude-only.html', '03 Claude only'],
    ['04-codex-only.html', '04 Codex only'],
    ['05-no-services.html', '05 neither'],
    ['06-provider-reconnect.html', '06 reconnect'],
    ['07-new-task.html', '07 new task'],
    ['08-settings.html', '08 settings'],
    ['09-usage-meter.html', '09 usage'],
  ];

  const catalog = {
    claude: [
      { id: 'claude-fable-5', label: 'Fable 5', note: 'Highest-capability Claude model' },
      { id: 'claude-opus-5', label: 'Opus 5', note: 'Deep reasoning for demanding work' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Fast, capable everyday default' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Quick and economical' },
    ],
    codex: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', note: 'Strongest agentic coding model' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Balanced speed and capability' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Low-latency coding tasks' },
    ],
  };

  const provider = {
    claude: { name: 'Claude', mark: 'A', cls: 'claude', cli: 'claude auth login' },
    codex: { name: 'Codex', mark: 'C', cls: 'codex', cli: 'codex login' },
  };

  const cfg = window.MOCKUP || {};
  const state = {
    current: { ...(cfg.current || { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' }) },
    pickerOpen: !!cfg.pickerOpen,
    usageOpen: !!cfg.usageOpen,
    theme: cfg.theme || new URLSearchParams(location.search).get('theme') || 'dark',
    pending: null,
    newTaskProvider: cfg.current?.provider || 'codex',
    newTaskModel: cfg.current?.model || 'gpt-5.6-sol',
  };
  document.documentElement.dataset.theme = state.theme;

  const modelById = id => Object.values(catalog).flat().find(m => m.id === id);
  const serviceState = key => cfg.services?.[key] || 'missing';
  const connected = key => serviceState(key) === 'connected';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function mockNav() {
    const here = location.pathname.split('/').pop();
    return `<div class="mockNav"><a href="index.html">index</a>${pages.map(([href, label]) =>
      `<a class="${href === here ? 'on' : ''}" href="${href}">${label}</a>`).join('')}
      <span class="themeCtl" aria-label="Preview theme"><button data-preview-theme="dark" class="${state.theme === 'dark' ? 'on' : ''}">● Dark</button><button data-preview-theme="light" class="${state.theme === 'light' ? 'on' : ''}">○ Bright</button></span></div>`;
  }

  function providerMark(key, extra = '') {
    const p = provider[key];
    return `<span class="providerMark ${p.cls} ${extra}">${p.mark}</span>`;
  }

  function dashNav({ settings = false } = {}) {
    return `<nav class="dashNav">
      <span class="brand">Alex <em>/ planner</em></span>
      <div class="tab navOverview">⌂ Overview</div>
      <div class="tab ${settings ? '' : 'on'}"><span class="dot ${settings ? '' : 'run'}"></span>ShockPersistence</div>
      <div class="tab navSecondary"><span class="dot"></span>TaxNotches</div>
      <div class="tab navSecondary"><span class="dot"></span>Referee-QJE</div>
      <div class="right">
        <button class="addBtn">＋ ADD TASK</button>
        <div class="tab navOptional">git</div>
        <div class="tab navOptional ${settings ? 'on' : ''}">${settings ? '⚙ Settings' : '⧉ Calendar'}</div>
        <span class="usageChip">AR</span>
      </div>
    </nav>`;
  }

  function sidePane() {
    return `<aside class="side">
      <div class="abstract">Idiosyncratic shock persistence and the wealth distribution in an Aiyagari economy.
        <span class="bet">Bet: the tighter grid moves the Gini.</span></div>
      <div class="sideHead">Pinned files</div>
      <div class="sideRow">estimation.jl <span class="lang">JL</span></div>
      <div class="sideRow">calibrate.jl <span class="lang">JL</span></div>
      <div class="sideRow">shock_grid.jl <span class="lang">JL</span></div>
      <div class="sideRow">paper.tex <span class="lang">TEX</span></div>
      <div class="sideRow">results.md <span class="lang">MD</span></div>
      <div class="sideHead" style="margin-top:11px">Recent activity</div>
      <div class="sideRow">✎ estimation.jl</div>
      <div class="sideRow">▶ smm_tight_grid</div>
    </aside>`;
  }

  function taskPane() {
    const p = state.current.provider;
    const agent = provider[p]?.name || 'Agent';
    return `<section class="mainPane">
      <div class="taskTabs">
        <div class="taskTab on"><span class="tdot run"></span>Re-estimate SMM · tighter grid</div>
        <div class="taskTab"><span class="tdot queue"></span>Referee reply pass</div>
        <div class="taskTab plus">＋</div>
      </div>
      <div class="mainBody"><div class="console">
        <div class="consoleTabs"><div class="consoleTab">estimation.jl</div><div class="consoleTab">shock_grid.jl</div><div class="consoleTab on">≋ console</div></div>
        <div class="consoleBody">
          <div class="turn you"><div class="speaker you">YOU</div><p>Re-run the SMM estimation with the tighter shock grid and tell me whether the wealth Gini moves.</p></div>
          <div class="turn"><div class="speaker ${p}">${agent}</div><p>Starting from the checked-in calibration. I’ll rebuild the grid at 251 nodes, rerun the moment match, and compare the stationary distribution with last week’s baseline.</p>
            <div class="tool"><b>⏺ Bash</b> julia --project scripts/run_smm.jl --grid tight</div>
            <div class="diff"><div>iter 14/40 · J = 3.02e-4</div><div class="add">+ wealth_gini = 0.7821 · running…</div></div>
          </div>
        </div>
      </div></div>
    </section>`;
  }

  function modelMenu() {
    const visibleProviders = ['claude', 'codex'].filter(connected);
    const missingProviders = ['claude', 'codex'].filter(k => !connected(k));
    const groups = visibleProviders.map(key => {
      const rows = catalog[key].map(m => `<button class="modelChoice ${state.current.model === m.id ? 'selected' : ''}"
        data-provider="${key}" data-model="${m.id}"><strong>${esc(m.label)}</strong><span class="check">${state.current.model === m.id ? '✓' : ''}</span><small>${esc(m.note)}</small></button>`).join('');
      const reasoning = key === 'codex' && state.current.provider === 'codex' ? `<div class="reasoningRow">
        <label>Reasoning effort <span>applies next turn</span></label>
        <div class="effortOpts">${['low','medium','high','xhigh'].map(e => `<button class="effortOpt ${state.current.effort === e ? 'on' : ''}" data-effort="${e}">${e}</button>`).join('')}</div>
      </div>` : '';
      return `<section class="providerGroup"><div class="providerGroupHead">${providerMark(key)} ${provider[key].name}<span class="status">connected</span></div>${rows}${reasoning}</section>`;
    }).join('');
    const foot = missingProviders.map(key => `<div class="connectFoot" data-connect="${key}">${providerMark(key, 'muted')} <span>Also use ${provider[key].name}</span><b>Connect…</b></div>`).join('');
    return `<div class="modelMenu" ${state.pickerOpen ? '' : 'hidden'}>
      <div class="menuHead"><span>Agent &amp; model</span><small>for this task</small></div>${groups}${foot}
    </div>`;
  }

  function engineControl() {
    const p = provider[state.current.provider] || provider.claude;
    const m = modelById(state.current.model) || { label: state.current.model };
    return `<span class="engineWrap">
      <button class="engineBtn ${state.pickerOpen ? 'open' : ''}" id="engineBtn">${providerMark(state.current.provider)}<span>${esc(m.label)}</span><span class="chev">▾</span></button>
      ${modelMenu()}
    </span>${state.current.provider === 'codex' ? `<button class="effortChip" id="effortChip">effort · ${esc(state.current.effort || 'high')} ▾</button>` : ''}`;
  }

  function normalChat() {
    const p = state.current.provider;
    const name = provider[p].name;
    return `<div class="chatLog">
      <div class="bubble you"><div class="who">YOU</div><div class="bubbleText">Re-run the SMM estimation with the tighter shock grid and tell me whether the wealth Gini moves.</div></div>
      <div class="bubble agent"><div class="who ${p}">${name} · ${esc(modelById(state.current.model)?.label || '')}</div><div class="bubbleText">I’ll compare the new stationary distribution with the checked-in baseline and keep the intermediate moments in <code>results.md</code>.</div></div>
      <div class="runHint"><span class="live"></span>${name} is working — follow along in the <b>≋ console</b> tab</div>
    </div>
    <div class="composer"><textarea placeholder="Message agent — Enter sends"></textarea><button class="sendBtn">Send</button></div>
    <div class="sessionBar">${engineControl()}<span class="softChip">🛡 co-op ▾</span><span class="softChip">web off</span><span class="tokens"><b>41.2k tok</b> · 6 turns</span></div>`;
  }

  function noServicesChat() {
    return `<div class="chatLog"><div class="queueCard">
      <h3>Connect an agent to launch this task</h3>
      <p>The dashboard works with either service on its own. Connect one now; you can add the other later from Settings.</p>
      <div class="serviceChoices">
        <div class="serviceChoice" data-connect="claude"><h4>${providerMark('claude')} Claude</h4><p>Use your Claude Code login and Claude model catalog.</p><span class="serviceAction">Connect Claude →</span></div>
        <div class="serviceChoice" data-connect="codex"><h4>${providerMark('codex')} Codex</h4><p>Use your Codex login and Codex model catalog.</p><span class="serviceAction">Connect Codex →</span></div>
      </div>
      <div class="privacyNote">Credentials stay with each provider’s own login flow; the dashboard stores connection status, not passwords.</div>
    </div></div>
    <div class="sessionBar"><span class="softChip">🛡 co-op ▾</span><span class="softChip">web off</span></div>`;
  }

  function unavailableChat() {
    const current = state.current.provider;
    const alternate = current === 'codex' ? 'claude' : 'codex';
    return `<div class="chatLog">
      <div class="bubble you"><div class="who">YOU</div><div class="bubbleText">Now update the robustness table with those estimates.</div></div>
      <div class="authCard">
        <div class="authTop">${providerMark(current)} Your ${provider[current].name} login has expired</div>
        <p>This task’s ${provider[current].name} thread and transcript are untouched. Reconnect to continue it, or explicitly start a new ${provider[alternate].name} thread for this task.</p>
        <div class="authActions"><button class="btn primary" data-connect="${current}">Reconnect ${provider[current].name}</button><button class="btn" data-switch="${alternate}">Switch to ${provider[alternate].name}…</button></div>
        <div class="privacyNote">Terminal alternative: <code>${provider[current].cli}</code>, then retry.</div>
      </div>
    </div>
    <div class="composer"><textarea disabled placeholder="Reconnect Codex to continue this thread"></textarea><button class="sendBtn" disabled>Send</button></div>
    <div class="sessionBar">${engineControl()}<span class="softChip">🛡 co-op ▾</span><span class="tokens"><b>41.2k tok</b> · 6 turns</span></div>`;
  }

  function queuedChat() {
    return `<div class="chatLog"><div class="queueCard">
      <h3>Re-estimate SMM · tighter grid</h3><p>Rebuild the process on 251 nodes and compare the stationary wealth distribution with the baseline.</p>
      <div class="queueMeta"><span class="qchip on">✓ living abstract</span><span class="qchip on">✓ category primer</span><span class="qchip">estimation.jl</span><span class="qchip">shock_grid.jl</span></div>
      <div class="launchRow"><button class="launchBtn">▶ Launch session</button>${engineControl()}<span class="softChip">🛡 co-op ▾</span></div>
    </div></div>`;
  }

  function sessionPane() {
    let body = normalChat();
    if (cfg.mode === 'none') body = noServicesChat();
    if (cfg.mode === 'unavailable') body = unavailableChat();
    if (cfg.mode === 'queued') body = queuedChat();
    return `<section class="sessionZone"><div class="mobilePaneTabs"><span>Files</span><span>Console</span><span class="on">Session</span><span>Output</span></div><div class="session"><div class="sessionTabs"><div class="sessionTab on"><span class="tdot run"></span>⌘ session</div><div class="sessionTab">▶ output</div></div>${body}</div></section>`;
  }

  function providerDialog() {
    if (!state.pending) return '<div class="dialogShade" hidden></div>';
    const from = state.current.provider;
    const to = state.pending.provider;
    return `<div class="dialogShade"><div class="dialog">
      <div class="boundary">↗ provider boundary</div>
      <h3>Start a new ${provider[to].name} thread?</h3>
      <p>${provider[to].name} cannot resume the private thread owned by ${provider[from].name}. The dashboard will keep the existing transcript visible, then begin a fresh provider thread with the task context and a short handoff summary.</p>
      <div class="threadMap"><div class="threadCard">Existing thread<b>${provider[from].name} · kept</b></div><div class="threadArrow">→</div><div class="threadCard">New thread<b>${provider[to].name} · ${esc(modelById(state.pending.model)?.label)}</b></div></div>
      <div class="dialogActions"><button class="btn" id="cancelSwitch">Cancel</button><button class="btn ${to === 'claude' ? 'claudePrimary' : 'primary'}" id="confirmSwitch">Start ${provider[to].name} thread</button></div>
    </div></div>`;
  }

  const usageSamples = {
    claude: {
      primary: { key: '5h', name: 'Session window', sub: 'rolling 5 hours', pct: 62, reset: '1h 47m' },
      secondary: { key: 'wk', name: 'Weekly limit', sub: 'all Claude models', pct: 27, reset: '4d 06h' },
    },
    codex: {
      primary: { key: '5h', name: 'Session window', sub: 'duration supplied by Codex', pct: 23, reset: '2h 11m' },
      secondary: { key: 'wk', name: 'Weekly limit', sub: 'duration supplied by Codex', pct: 41, reset: '3d 18h' },
    },
  };

  function usageProviders() {
    return ['claude', 'codex'].filter(key => serviceState(key) === 'connected' || serviceState(key) === 'expired');
  }

  function usageMeterHtml(key) {
    const sample = usageSamples[key].primary;
    const active = state.current.provider === key ? 'active' : '';
    const stale = serviceState(key) === 'expired' ? 'stale' : '';
    const level = sample.pct >= 90 ? 'hot' : sample.pct >= 70 ? 'warn' : '';
    return `<div class="usageMeter ${key} ${active} ${stale} ${level}">
      <span class="usageMark ${key}">${provider[key].mark}</span><span class="usageWindow">${sample.key}</span>
      <span class="usageTrack"><i style="width:${sample.pct}%"></i></span><b class="usagePct">${sample.pct}%</b>
      <span class="usageReset">${stale ? 'stale' : `↻ ${sample.reset}`}</span>
    </div>`;
  }

  function usageProviderDetail(key) {
    const stale = serviceState(key) === 'expired';
    const rows = [usageSamples[key].primary, usageSamples[key].secondary].map(w => `<div class="usageRow ${w.pct >= 90 ? 'hot' : w.pct >= 70 ? 'warn' : ''}">
      <span class="usageName">${w.name}<small>${w.sub}</small></span>
      <span class="usageTrack"><i style="width:${w.pct}%"></i></span><b>${w.pct}%</b><span>↻ ${w.reset}</span>
    </div>`).join('');
    return `<section class="usageProvider ${key}"><div class="usageProviderHead"><span class="usageMark ${key}">${provider[key].mark}</span>${provider[key].name}<small class="${stale ? 'stale' : ''}">${stale ? 'last reading · reconnect to refresh' : 'live'}</small></div>${rows}</section>`;
  }

  function usageStatusBar() {
    const keys = usageProviders();
    const right = keys.length ? `<div class="usageDock" data-usage tabindex="0" role="button" aria-expanded="${state.usageOpen}">
      ${keys.map(usageMeterHtml).join('')}
      <div class="usagePop" ${state.usageOpen ? '' : 'hidden'}>
        <div class="usagePopHead"><span>AI usage</span><em>used percentage · click to ${state.usageOpen ? 'close' : 'pin'}</em></div>
        ${keys.map(usageProviderDetail).join('')}
        <div class="usageFoot">Codex values come from <b>account/rateLimits/read</b> and update events; labels and reset countdowns derive from the returned window duration and timestamp. Claude retains the dashboard’s existing plan reading.</div>
      </div>
    </div>` : '<span class="usageEmpty">no AI service connected</span>';
    return `<div class="statusBar"><div class="statusLeft"><span class="running">● 1 running</span><span>wk <b>9h</b> · <b class="tok">188k tok</b></span></div>${right}</div>`;
  }

  function pinsHtml() {
    return (cfg.pins || []).map(pin => `<span class="pin" style="${esc(pin.style)}">${esc(pin.n)}</span>`).join('');
  }

  function workbench() {
    return `${dashNav()}<div class="workbench">${sidePane()}<div class="divider"></div>${taskPane()}<div class="divider"></div>${sessionPane()}</div>${usageStatusBar()}${providerDialog()}${pinsHtml()}<div class="toast" id="toast"></div>`;
  }

  function newTaskModal() {
    const p = state.newTaskProvider;
    const models = catalog[p];
    return `<div class="modalLayer"><div class="taskModal">
      <h2>New task <small>becomes a launchable agent session</small></h2>
      <div class="formGrid">
        <div class="field full"><label>Title</label><input class="input" value="Rebuild permutation placebo with new clusters"></div>
        <div class="field"><label>Project</label><input class="input" value="ShockPersistence"></div>
        <div class="field"><label>Category</label><input class="input" value="Estimation"></div>
        <div class="field full"><label>Agent <small>only connected services appear</small></label>
          <div class="engineCards">
            <div class="engineCard claude ${p === 'claude' ? 'on' : ''}" data-new-provider="claude"><h4>${providerMark('claude')} Claude</h4><p>Use Claude Code for this task.</p>${p === 'claude' ? '<span class="check">✓</span>' : ''}</div>
            <div class="engineCard ${p === 'codex' ? 'on' : ''}" data-new-provider="codex"><h4>${providerMark('codex')} Codex</h4><p>Use Codex for this task.</p>${p === 'codex' ? '<span class="check">✓</span>' : ''}</div>
          </div>
        </div>
        <div class="field full"><label>Model <small>defaults to your preferred model; change per task</small></label>
          <div class="modelSelect">${models.map(m => `<button class="modelPill ${p === 'claude' ? 'claude' : ''} ${state.newTaskModel === m.id ? 'on' : ''}" data-new-model="${m.id}">${esc(m.label)}</button>`).join('')}</div>
        </div>
        ${p === 'codex' ? `<div class="field"><label>Reasoning effort</label><div class="modelSelect">${['low','medium','high','xhigh'].map(e => `<button class="modelPill ${state.current.effort === e ? 'on' : ''}" data-effort="${e}">${e}</button>`).join('')}</div></div>` : ''}
        <div class="field ${p === 'claude' ? 'full' : ''}"><label>Oversight</label><input class="input" value="Cooperative — ask when needed"></div>
        <div class="field full"><label>Context notes</label><input class="input" value="Done = placebo distribution rebuilt and figure regenerated."></div>
      </div>
      <div class="modalFoot"><button class="btn primary" id="saveMock">Save task</button><button class="btn">Cancel</button><span class="where">→ tasks/agrisk.json · provider: ${p} · model: ${esc(state.newTaskModel)}</span></div>
    </div></div>`;
  }

  function newTaskView() {
    return `${workbench()}${newTaskModal()}`;
  }

  function settingsView() {
    const defaultModel = modelById(state.current.model);
    return `${dashNav({ settings: true })}<div class="settingsBody"><div class="settingsFrame">
      <h1>Settings</h1>
      <section class="setSec"><h3>AI services</h3><p class="setIntro">Connect either service or both. Each owns its login, model catalog, usage, and resumable threads.</p>
        <div class="serviceGrid">
          <div class="serviceCard"><div class="serviceTitle">${providerMark('claude')} Claude <span class="statusBadge">connected</span></div><div class="serviceMeta"><b>Claude Code login</b><br>Models refreshed 4 minutes ago · account ending in …27</div><div class="serviceBtns"><button data-action="refresh">Refresh models</button><button data-action="disconnect">Disconnect</button></div></div>
          <div class="serviceCard"><div class="serviceTitle">${providerMark('codex')} Codex <span class="statusBadge">connected</span></div><div class="serviceMeta"><b>Codex login</b><br>Models refreshed just now · ChatGPT workspace</div><div class="serviceBtns"><button data-action="refresh">Refresh models</button><button data-action="disconnect">Disconnect</button></div></div>
        </div>
        <div class="setRow"><div class="setLabel">Default agent &amp; model<small>Used for new tasks. Existing tasks keep their own choice.</small></div><div class="defaultCtl">${engineControl()}</div></div>
      </section>
      <section class="setSec"><h3>Provider-specific behavior</h3><div class="capList">
        <div class="capRow"><b>Reasoning effort</b><span>Shown only for Codex models; it does not leave an irrelevant blank control on Claude tasks.</span></div>
        <div class="capRow"><b>Thread ownership</b><span>A task can retain histories from both providers, but only one provider thread is active at a time.</span></div>
        <div class="capRow"><b>Usage</b><span>Always visible in the bottom bar. Connected providers keep separate percentages; click them for every quota window and reset time.</span></div>
        <div class="capRow"><b>Model catalog</b><span>Refreshed from each service. The labels in these mockups are examples, not a permanent hard-coded list.</span></div>
      </div></section>
    </div></div>${usageStatusBar()}${providerDialog()}${pinsHtml()}<div class="toast" id="toast"></div>`;
  }

  function render() {
    const host = document.getElementById('mockApp');
    if (!host) return;
    if (cfg.view === 'settings') host.innerHTML = settingsView();
    else if (cfg.view === 'newTask') host.innerHTML = newTaskView();
    else host.innerHTML = workbench();
    wire();
  }

  function showToast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => el.classList.remove('show'), 1900);
  }

  function chooseModel(key, model) {
    if (key !== state.current.provider && cfg.hasThread !== false) {
      state.pending = { provider: key, model };
      state.pickerOpen = false;
      render();
      return;
    }
    state.current.provider = key;
    state.current.model = model;
    state.pickerOpen = false;
    render();
    showToast(`Next turn uses ${modelById(model)?.label || model}`);
  }

  function wire() {
    document.querySelectorAll('[data-preview-theme]').forEach(el => el.addEventListener('click', () => {
      state.theme = el.dataset.previewTheme;
      document.documentElement.dataset.theme = state.theme;
      document.querySelectorAll('[data-preview-theme]').forEach(btn => btn.classList.toggle('on', btn.dataset.previewTheme === state.theme));
    }));
    document.querySelectorAll('[data-usage]').forEach(el => el.addEventListener('click', () => {
      state.usageOpen = !state.usageOpen;
      render();
    }));
    document.querySelectorAll('.usagePop').forEach(el => el.addEventListener('click', event => event.stopPropagation()));
    document.querySelectorAll('#engineBtn').forEach(el => el.addEventListener('click', event => {
      event.stopPropagation();
      state.pickerOpen = !state.pickerOpen;
      render();
    }));
    document.querySelectorAll('.modelChoice').forEach(el => el.addEventListener('click', () => chooseModel(el.dataset.provider, el.dataset.model)));
    document.querySelectorAll('[data-effort]').forEach(el => el.addEventListener('click', event => {
      event.stopPropagation();
      state.current.effort = el.dataset.effort;
      render();
      showToast(`Codex reasoning effort: ${el.dataset.effort}`);
    }));
    document.querySelectorAll('[data-connect]').forEach(el => el.addEventListener('click', () => showToast(`${provider[el.dataset.connect].name} sign-in would open here`)));
    document.querySelectorAll('[data-switch]').forEach(el => el.addEventListener('click', () => {
      const key = el.dataset.switch;
      state.pending = { provider: key, model: catalog[key][1].id };
      render();
    }));
    document.querySelector('#cancelSwitch')?.addEventListener('click', () => { state.pending = null; render(); });
    document.querySelector('#confirmSwitch')?.addEventListener('click', () => {
      const next = state.pending;
      state.pending = null;
      state.current.provider = next.provider;
      state.current.model = next.model;
      render();
      showToast(`New ${provider[next.provider].name} thread started; prior transcript kept`);
    });
    document.querySelectorAll('[data-new-provider]').forEach(el => el.addEventListener('click', () => {
      state.newTaskProvider = el.dataset.newProvider;
      state.newTaskModel = catalog[state.newTaskProvider][1].id;
      render();
    }));
    document.querySelectorAll('[data-new-model]').forEach(el => el.addEventListener('click', () => {
      state.newTaskModel = el.dataset.newModel;
      render();
    }));
    document.querySelector('#saveMock')?.addEventListener('click', () => showToast('Task would save with explicit provider + model'));
    document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => showToast(`${el.dataset.action === 'refresh' ? 'Model catalog refreshed' : 'A confirmation would appear before disconnecting'}`)));
    document.querySelector('#effortChip')?.addEventListener('click', () => {
      state.pickerOpen = true;
      render();
    });
  }

  const navSlot = document.getElementById('mockNavSlot');
  if (navSlot) navSlot.outerHTML = mockNav();
  render();
})();
