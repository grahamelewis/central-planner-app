// Inspection-only memory UI. Deliberately separate from the session composer.
import { api } from './net.js';
import { esc, enc, toast, confirmBox } from './util.js';

const dollars = value => `$${Number(value || 0).toFixed(4)}`;
const memoryTokens = (value, completeness) => value == null ? 'unknown'
  : `${Number(value).toLocaleString()}${completeness === 'complete' ? '' : ' recorded'}`;

/** @param {Element} host */
export async function mountMemorySettings(host) {
  const box = host.querySelector('#memorySettings');
  if (!box) return;
  const s = await api('GET', '/api/memory/settings');
  if (!box.isConnected) return;
  if (!s) { box.textContent = 'Memory settings could not be loaded. Reopen Settings to retry.'; return; }
  box.innerHTML = `<h3>Task memory <span class="memoryBadge">Checkpoint-only pilot</span></h3>
    <p class="memoryNote">A separate background model prepares inspectable checkpoints after completed turns. It never replaces a conversation or injects memory into its prompt. OpenAI uses your ChatGPT / Codex subscription, not an API key. It shares your Codex usage allowance with normal tasks; no API-billing fallback. Claude keeps its existing SDK login.</p>
    <form id="memorySettingsForm" class="memoryForm">
      <label>Connection<select name="connection">${s.connections.map(c => `<option value="${esc(c.id)}"${c.id === s.connection ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <label>Memory model<select name="model"></select></label>
      <label>Reasoning effort<select name="reasoningEffort"></select></label>
      <label data-subscription-limit>Maximum memory jobs per UTC day<input name="dailyJobLimit" type="number" min="1" max="100" step="1" value="${s.dailyJobLimit}" required></label>
      <label data-claude-limit>Daily estimated usage budget (USD, UTC day)<input name="dailyBudgetUsd" type="number" min="0" max="100" step="0.01" value="${s.dailyBudgetUsd}" required></label>
      <label data-claude-limit>Maximum estimated usage per request (USD)<input name="maxJobUsd" type="number" min="0.001" max="5" step="0.001" value="${s.maxJobUsd}" required></label>
      <label>Input token ceiling<input name="maxInputTokens" type="number" min="12000" max="64000" step="1" value="${s.maxInputTokens}" required></label>
      <label>Output token acceptance limit<input name="maxOutputTokens" type="number" min="1000" max="12000" step="1" value="${s.maxOutputTokens}" required></label>
      <label>Checkpoint character limit<input name="briefMaxChars" type="number" min="1000" max="10000" step="1" value="${s.briefMaxChars}" required></label>
      <p class="memoryNote" id="memoryModelCost"></p>
      <label class="memoryEnable"><input name="enabled" type="checkbox"${s.enabled ? ' checked' : ''}> Enable automatic checkpoint updates (uses your plan)</label>
      <div class="memoryActions"><button class="gbtn" type="submit">Save memory settings</button><span role="status">${s.enabled ? 'Enabled' : 'Disabled'} · ${s.jobsToday || 0} subscription jobs reserved today</span></div>
    </form>
    <p class="memoryNote" id="memoryCredential"></p>
    <p class="memoryNote">${s.billingBlocked ? 'Paid calls are blocked in this test environment.' : ''}</p>
    <p class="memoryNote">Subscription jobs reserve one daily slot before dispatch; failed or uncertain attempts keep that slot, including across restarts. This is a local usage guard, not a guarantee about remaining plan credits. Claude retains its estimated-dollar guard. No API fallback.</p>
    <p class="memoryNote">Input limits bound the supplied checkpoint and transcript payload; Codex adds its own runtime instructions. Codex runs in an isolated temporary folder with read-only permissions, no user config, and execution features disabled. Its output limit is checked after completion, not a provider-enforced generation cap. A 90-second timeout bounds each worker. Changes apply to the next job; an in-flight request may still finish after disabling.</p>`;
  const form = /** @type {HTMLFormElement} */ (box.querySelector('form'));
  const connectionSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('connection'));
  const modelSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('model'));
  const effortSelect = /** @type {HTMLSelectElement} */ (form.elements.namedItem('reasoningEffort'));
  const credentialNote = {
    'claude-sdk': ok => ok ? 'Claude login is connected; the writer bills to the same plan as task sessions (model access is checked when a request runs).'
      : 'Claude is not signed in. Connect Claude under AI services above before enabling memory on this connection.',
    'codex-subscription': ok => ok ? 'ChatGPT / Codex subscription connected. Account and model access are checked again before every memory job.'
      : 'Connect Codex with ChatGPT under AI services above. An API key does not enable this connection.',
  };
  const updateModels = () => {
    const connection = s.connections.find(c => c.id === connectionSelect.value) || s.connections[0];
    const models = s.models.filter(m => m.connection === connection.id);
    const keep = models.some(m => m.id === modelSelect.value) ? modelSelect.value : (models.some(m => m.id === s.model) ? s.model : models[0].id);
    modelSelect.innerHTML = models.map(m => `<option value="${esc(m.id)}"${m.id === keep ? ' selected' : ''}${m.available === false ? ' disabled' : ''}>${esc(m.label)}</option>`).join('');
    box.querySelector('#memoryCredential').textContent = credentialNote[connection.id](connection.credentialConfigured);
    form.querySelectorAll('[data-claude-limit]').forEach(el => { el.hidden = connection.id !== 'claude-sdk'; });
    form.querySelector('[data-subscription-limit]').hidden = connection.id !== 'codex-subscription';
  };
  const updateCost = () => {
    const model = s.models.find(m => m.id === modelSelect.value);
    if (!model || model.connection === 'codex-subscription') {
      form.querySelector('#memoryModelCost').textContent = 'Uses your Codex subscription allowance; no separately billed OpenAI API request. Available models come from your connected Codex account.';
      return;
    }
    const input = Number(/** @type {HTMLInputElement} */ (form.elements.namedItem('maxInputTokens')).value);
    const output = Number(/** @type {HTMLInputElement} */ (form.elements.namedItem('maxOutputTokens')).value);
    const ceiling = (input * model.input * model.cacheWrite + output * model.output) / 1e6;
    form.querySelector('#memoryModelCost').textContent = `Rates per 1M tokens: $${model.input} input / $${model.output} output. At both configured token ceilings, reserve up to ${dollars(ceiling)} per request including cache-write premium. Requests above your per-request or remaining daily budget are blocked.`;
  };
  const updateEfforts = () => {
    const current = effortSelect.value || s.reasoningEffort;
    const model = s.models.find(m => m.id === modelSelect.value) || { efforts: [s.reasoningEffort] };
    effortSelect.innerHTML = model.efforts.map(e => `<option value="${e}">${e === 'none' ? 'none (no extended thinking)' : e}</option>`).join('');
    effortSelect.value = model.efforts.includes(current) ? current : (model.efforts.includes('low') ? 'low' : model.efforts[0]);
    updateCost();
  };
  updateModels(); updateEfforts();
  connectionSelect.addEventListener('change', () => { updateModels(); updateEfforts(); });
  modelSelect.addEventListener('change', updateEfforts);
  for (const field of ['maxInputTokens', 'maxOutputTokens']) (/** @type {HTMLInputElement} */ (form.elements.namedItem(field))).addEventListener('input', updateCost);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const patch = { connection: String(data.get('connection')), model: modelSelect.value,
      reasoningEffort: String(data.get('reasoningEffort')), enabled: data.has('enabled') };
    for (const field of ['dailyJobLimit', 'dailyBudgetUsd', 'maxJobUsd', 'maxInputTokens', 'maxOutputTokens', 'briefMaxChars']) patch[field] = Number(data.get(field));
    if (patch.enabled && !s.enabled) {
      const where = patch.connection === 'claude-sdk'
        ? 'Task transcript excerpts will be sent to Claude on your own login and counted against your plan, like task turns.'
        : 'Task transcript excerpts will be sent through your ChatGPT-signed-in Codex account and consume its subscription allowance. API-key billing is blocked.';
      const yes = await confirmBox(`Enable background task-memory calls?<br><small>${where} This pilot only saves checkpoints; it does not reset conversations.</small>`, 'Enable memory');
      if (!yes) return;
    }
    const button = /** @type {HTMLButtonElement} */ (form.querySelector('[type=submit]'));
    button.disabled = true;
    const result = await api('PATCH', '/api/memory/settings', patch);
    if (result) { toast('memory settings saved'); await mountMemorySettings(host); }
    else button.disabled = false;
  });
}

/** Open a read-only task memory panel; a single bounded job can be requested explicitly. */
export async function openTaskMemory(project, id, title) {
  document.querySelector('#taskMemoryDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'taskMemoryDialog';
  dialog.className = 'memoryDialog';
  dialog.setAttribute('aria-labelledby', 'taskMemoryTitle');
  dialog.innerHTML = `<header><div><h2 id="taskMemoryTitle">Task memory</h2><p>${esc(title || id)}</p></div><button class="gbtn" id="memoryClose" aria-label="Close task memory">Close</button></header>
    <div id="memoryPanel" role="status">Loading checkpoint…</div>`;
  document.body.appendChild(dialog);
  const panel = dialog.querySelector('#memoryPanel');
  let timer;
  let revision = null;
  let busy = false;
  const close = () => { clearTimeout(timer); dialog.remove(); };
  dialog.addEventListener('close', close, { once: true });
  dialog.querySelector('#memoryClose').addEventListener('click', () => dialog.close());
  dialog.showModal();
  const url = `/api/tasks/${enc(project)}/${enc(id)}/memory`;
  async function refresh() {
    if (busy || !dialog.isConnected) return;
    clearTimeout(timer); busy = true;
    const data = await api('GET', url);
    busy = false;
    if (!dialog.isConnected) return;
    if (!data) { panel.innerHTML = '<p>Memory could not be loaded. Close and reopen this panel to retry.</p>'; return; }
    const selected = data.revisions.find(r => r.revision === revision) || data.current;
    const inProgress = ['running', 'queued'].includes(data.status);
    const incompleteJobs = data.totals.incompleteJobs ?? data.jobs.filter(j => j.status !== 'blocked' && !j.notDispatched
      && (!j.usage || j.usage.completeness !== 'complete')).length;
    const accountingComplete = incompleteJobs ? 'partial' : 'complete';
    const labels = { findings: 'Findings & rejected approaches', constraints: 'Constraints & user decisions', uncertainties: 'Uncertainties', nextSteps: 'Next steps' };
    panel.innerHTML = `<div class="memoryNotice"><b>Inspection only.</b> This checkpoint is not being read by the working agent. Validation checks structure and source IDs, not factual accuracy.</div>
      <div class="memoryActions"><span class="memoryBadge">${esc(data.status)}</span><button class="gbtn" id="memoryRefresh">Refresh</button>
      <button class="gbtn" id="memoryUpdate"${inProgress || !data.settings.enabled || data.settings.billingBlocked || !data.pending ? ' disabled' : ''}>Update checkpoint</button></div>
      <p class="memoryNote">${!data.settings.enabled ? 'Enable Task memory in Settings to create checkpoints.' : data.settings.billingBlocked ? 'Paid calls are blocked in this test environment.' : data.pending ? 'New or changed material remains. Each job reads a bounded chunk; large backlogs may need several updates.' : 'Checkpoint covers the available transcript.'} Conversations remain unchanged.</p>
      <div class="memoryStats"><div><b>${memoryTokens(data.totals.inputTokens, accountingComplete)}</b><span>reported input tokens</span></div><div><b>${memoryTokens(data.totals.outputTokens, accountingComplete)}</b><span>reported output tokens</span></div><div><b>${dollars(data.totals.estimatedCostUsd)}</b><span>known estimated subtotal; subscription / unknown costs excluded</span></div><div><b>${data.jobs.length}</b><span>recorded jobs</span></div></div>
      ${incompleteJobs ? `<p class="memoryNote">Accounting is incomplete or historically unverified for ${incompleteJobs} job${incompleteJobs === 1 ? '' : 's'}. Recorded totals are not a complete expenditure benchmark.</p>` : ''}
      ${selected ? `<label class="memoryVersion">Checkpoint version<select id="memoryVersion">${data.revisions.map(r => `<option value="${r.revision}"${selected.revision === r.revision ? ' selected' : ''}>v${r.revision} · ${esc(new Date(r.createdAt).toLocaleString())}</option>`).join('')}</select></label>
        <p class="memoryNote">${esc(selected.model)} · ${esc(selected.reasoningEffort)} effort · ${selected.coverage.cursor.index} complete transcript entries${selected.coverage.cursor.offset ? ` + ${selected.coverage.cursor.offset} characters of the next entry` : ''}</p>
        <div class="memorySections">${Object.entries(labels).map(([key, label]) => `<section><h3>${label}</h3>${selected.content[key].length ? `<ul>${selected.content[key].map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : '<p class="memoryNote">None recorded.</p>'}</section>`).join('')}
        <section><h3>Evidence references</h3>${selected.content.evidence.length ? `<ul>${selected.content.evidence.map(e => `<li><button class="gbtn memorySource" data-source="${esc(e.source)}">${esc(e.source)}</button> — ${esc(e.claim)}</li>`).join('')}</ul><div id="memoryEvidence" aria-live="polite"></div>` : '<p class="memoryNote">None recorded.</p>'}</section></div>` : '<div class="memoryEmpty"><h3>No checkpoint yet</h3><p>After setup, completed task turns will queue a background update. Existing tasks can use “Update checkpoint” while idle.</p></div>'}
      <details class="memoryJobs"${data.jobs[0]?.error ? ' open' : ''}><summary>Recent update jobs (${data.jobs.length})</summary>${data.jobs.map(j => `<article><b>${esc(j.status)}</b> · ${esc(new Date(j.startedAt).toLocaleString())}${j.configuration ? ` · ${esc(j.configuration.model)}` : ''}<p>${j.notDispatched ? 'Not dispatched · ' : `${memoryTokens(j.usage?.inputTokens, j.usage?.completeness)} in / ${memoryTokens(j.usage?.outputTokens, j.usage?.completeness)} out · ${esc(j.usage?.completeness || 'legacy-unverified')} accounting · `}${j.durationMs != null ? `${(j.durationMs / 1000).toFixed(1)}s · ` : ''}${j.configuration?.connection === 'codex-subscription' ? '1 subscription job reserved' : dollars(j.reservedUsd) + ' reserved'}</p>${j.ledgerWarning ? `<p class="memoryError">${esc(j.ledgerWarning)}</p>` : ''}${j.error ? `<p class="memoryError">${esc(j.error)}</p>` : j.status === 'interrupted' ? '<p>Server stopped during this request. Its reservation is retained; it will not retry automatically.</p>' : ''}</article>`).join('') || '<p>No updates have run.</p>'}</details>`;
    panel.querySelector('#memoryRefresh').addEventListener('click', refresh);
    panel.querySelectorAll('.memorySource').forEach(button => button.addEventListener('click', async () => {
      const source = /** @type {HTMLElement} */ (button).dataset.source;
      const target = panel.querySelector('#memoryEvidence');
      const show = async (offset = 0) => {
        const result = await api('GET', `${url}/evidence/${selected.revision}/${enc(source)}?offset=${offset}`);
        if (!result || !target.isConnected) return;
        target.innerHTML = `<p class="memoryNote">${esc(result.source)} · ${esc(result.role)} · characters ${result.offset + 1}–${result.offset + result.text.length} of ${result.totalChars}</p><pre></pre>${result.nextOffset != null ? '<button class="gbtn" id="memoryEvidenceNext">Next excerpt</button>' : ''}`;
        target.querySelector('pre').textContent = result.text;
        target.querySelector('#memoryEvidenceNext')?.addEventListener('click', () => show(result.nextOffset));
      };
      await show();
    }));
    panel.querySelector('#memoryVersion')?.addEventListener('change', event => {
      revision = Number(/** @type {HTMLSelectElement} */ (event.target).value); refresh();
    });
    panel.querySelector('#memoryUpdate').addEventListener('click', async event => {
      const button = /** @type {HTMLButtonElement} */ (event.target);
      button.disabled = true;
      const result = await api('POST', `${url}/update`, {});
      if (result) toast(result.queued ? 'checkpoint update queued' : 'checkpoint update already queued');
      refresh();
    });
    if (inProgress) timer = setTimeout(refresh, 1500);
  }
  await refresh();
}
