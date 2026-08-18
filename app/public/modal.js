// modal.js — the add-task modal, split verbatim out of app.js (phase 2):
// form/stashedForm state, open/close/stash semantics, renderModal, JSON
// preview, saveTask.

import { enc, esc, toast } from './util.js';
import {
  state, ui, projKeys, tasksOf, agentName, providerState, providerModels,
  perOf, REASONING_EFFORTS,
} from './store.js';
import { api } from './net.js';
import { catGroup, catGroups, groupColor } from './views.js';
// PERMANENT: routing lives with the entry module.
import { go } from './app.js';

/* ───────────────────────── add-task modal ───────────────────────── */

/** @type {{ title: string, description: string, category: string, project: string,
 *   upstream: string[], downstream: string[], oversight: string, provider: string,
 *   model: string, reasoningEffort: string, include_abstract: boolean,
 *   include_last_session: boolean, include_sibling_tasks: boolean,
 *   include_category_primer: boolean, web_sources: string, files: string,
 *   notes: string, [k: string]: any } | null}
 *  sanctioned live binding — all assignments stay in this module; app.js's
 *  init IIFE reads it and property-writes form.category (CONTRACT phase-2). */
export let form = null;          // add-task modal form state
let stashedForm = null;   // …preserved across an accidental dismissal, so a
                          // stray Escape or backdrop click can't destroy a
                          // half-written task (restored by the next openModal)

/** Does an add-task form hold anything the user would be sad to lose? */
function formHasContent(f) {
  return !!(f && (f.title.trim() || f.description.trim() || f.notes.trim() || f.files.trim()));
}

/**
 * Open the Add-task modal (restoring a stashed draft when one exists).
 * @param {string} [presetProject] preselect this project
 * @returns {void}
 */
export function openModal(presetProject) {
  if (!projKeys().length) { toast('no projects loaded yet'); return; }
  // an accidental dismissal stashes the draft instead of destroying it
  if (formHasContent(stashedForm)) {
    form = stashedForm;
    stashedForm = null;
    if (presetProject && state.projects[presetProject]) form.project = presetProject;
    renderModal();
    document.getElementById('modalBack').classList.add('show');
    const rt = document.getElementById('mTitle');
    if (rt) { rt.focus(); rt.setSelectionRange(rt.value.length, rt.value.length); }
    toast('restored your unsaved task');
    return;
  }
  const configured = state.agentDefaults?.provider === 'codex' ? 'codex' : 'claude';
  const initialProvider = providerState(configured).connected
    ? configured : (['claude', 'codex'].find(p => providerState(p).connected) || configured);
  const initialModels = providerModels(initialProvider);
  form = {
    title: '', description: '',
    category: Object.keys(state.categories || {})[0] || '',
    project: (presetProject && state.projects[presetProject]) ? presetProject
      : (state.projects[ui.view] ? ui.view : projKeys()[0]),
    upstream: [],
    downstream: [],
    oversight: 'coop', // safe default: interactive, not unattended autopilot
    provider: initialProvider,
    model: initialProvider === state.agentDefaults?.provider
      ? (state.agentDefaults?.model || initialModels.find(m => m.isDefault)?.id || initialModels[0]?.id || '')
      : (initialModels.find(m => m.isDefault)?.id || initialModels[0]?.id || ''),
    reasoningEffort: state.agentDefaults?.reasoningEffort || 'high',

    include_abstract: true, include_last_session: true,
    include_sibling_tasks: true, include_category_primer: true,
    web_sources: '',
    files: '', notes: '',
  };
  renderModal();
  document.getElementById('modalBack').classList.add('show');
  const t = document.getElementById('mTitle');
  if (t) t.focus();
}

/**
 * Close the add-task modal.
 *
 * `discard` separates the two ways out. Cancel and a successful save are
 * deliberate — the draft goes. Escape and a backdrop click are easy to hit by
 * accident, so those stash the draft and the next open restores it; losing a
 * half-written task to a stray keystroke is not a reasonable outcome.
 */
/**
 * Close the modal — stashes the draft unless discard.
 * @param {{ discard?: boolean }} [opts]
 * @returns {void}
 */
export function closeModal({ discard = false } = {}) {
  document.getElementById('modalBack')?.classList.remove('show');
  stashedForm = discard ? null : (formHasContent(form) ? form : null);
  form = null;
}

function buildTaskFields() {
  const f = form;
  return {
    project: f.project,
    title: f.title,
    description: f.description,
    category: f.category,
    upstream: f.upstream.slice(),
    oversight: f.oversight,
    provider: f.provider,
    model: f.model || null,
    reasoningEffort: f.reasoningEffort,
    status: f.oversight === 'manual' ? 'manual' : 'queued',
    context: {
      include_abstract: f.include_abstract,
      include_last_session: f.include_last_session,
      include_sibling_tasks: f.include_sibling_tasks,
      include_category_primer: f.include_category_primer,
      web_search: {
        enabled: true, // always on — the toggle is gone (2026-08-07)
        sources: f.web_sources.split(',').map(s => s.trim()).filter(Boolean),
      },
      files: f.files.split(',').map(s => s.trim()).filter(Boolean),
      notes: f.notes,
    },
  };
}

function jsonPreviewHtml(obj) {
  const j = JSON.stringify(obj, null, 2) || '';
  let out = '', last = 0, m;
  const re = /"(?:[^"\\]|\\.)*"(\s*:)?/g;
  while ((m = re.exec(j))) {
    out += esc(j.slice(last, m.index));
    if (m[1]) {
      const keyPart = m[0].slice(0, m[0].length - m[1].length);
      out += `<span class="k">${esc(keyPart)}</span>${esc(m[1])}`;
    } else {
      out += `<span class="s">${esc(m[0])}</span>`;
    }
    last = m.index + m[0].length;
  }
  out += esc(j.slice(last));
  return out;
}

function updateJson() {
  if (!form) return;
  const el = document.getElementById('mJson');
  if (el) el.innerHTML = jsonPreviewHtml(buildTaskFields());
  const jf = document.getElementById('jhFile');
  if (jf) jf.textContent = `tasks/${form.project}.json`;
}

/**
 * Render the Add-task form + live JSON preview from `form`.
 * @returns {void}
 */
export function renderModal() {
  const f = form;
  if (!f) return;
  const host = document.getElementById('modalForm');
  // lineage lives WITHIN a category GROUP: any task in the partition can chain
  // (e.g. a cleaning task after a collection one — both Empirics).
  // Archived tasks stay linkable — their handoffs are exactly what a follow-up
  // task wants injected — they just sort after the active ones, marked ▣
  const kin = tasksOf(f.project).filter(t => catGroup(t.category) === catGroup(f.category))
    .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  const groupName = catGroup(f.category);
  const lineageChips = (list, sel, dataAttr) => list.map(t =>
    `<span class="qchip ${sel.includes(t.id) ? 'on' : ''}" ${dataAttr}="${esc(t.id)}">⛓ ${t.archived ? '▣ ' : ''}${esc(state.categories?.[t.category]?.icon || '')} ${esc(t.title)} (${esc(t.id)} · ${t.archived ? 'archived' : esc(t.status)})</span>`).join('');

  host.innerHTML = `
    <h2>New task <span class="anno">becomes a launchable session</span></h2>

    <div class="fld"><div class="flbl">Title</div>
      <input type="text" id="mTitle" placeholder="e.g. Rebuild permutation placebo with new clusters" value="${esc(f.title)}"></div>

    <div class="fld"><div class="flbl">Description — what does done look like?</div>
      <textarea rows="4" id="mDesc" placeholder="Done = …">${esc(f.description)}</textarea></div>

    <div class="fld"><div class="flbl">Category <span class="anno" style="margin-left:8px">primes the session</span></div>
      <div id="mCat">${catGroups().map(([g, entries]) => {
        const [fg] = groupColor(g);
        return `<div class="catPickRow">
          <span class="cgLbl" style="color:${fg}">${esc(g)}</span>
          <div class="pillRow">${entries.map(([k, c]) =>
            `<span class="pillOpt ${f.category === k ? 'on' : ''}" data-c="${esc(k)}">${esc(c.icon || '')} ${esc(c.name || k)}</span>`).join('')}</div>
        </div>`;
      }).join('') || '<span class="sideNote" style="padding:0;">no categories defined</span>'}</div></div>

    <div class="fld"><div class="flbl">Project</div>
      <div class="pillRow" id="mProj">${projKeys().map(k =>
        `<span class="pillOpt ${f.project === k ? 'on' : ''}" data-p="${esc(k)}">${esc(state.projects[k]?.name || k)}</span>`).join('')}</div></div>

    <div class="fld"><div class="flbl">Lineage — within ${esc(groupName)} <span class="anno" style="margin-left:8px">handoffs flow downstream</span></div>
      ${kin.length ? `
        <div class="linRow"><span class="linLbl">↑ parents</span>
          <div class="qchips" id="mUp">${lineageChips(kin, f.upstream, 'data-u')}</div></div>
        <div class="linRow"><span class="linLbl">↓ children</span>
          <div class="qchips" id="mDown">${lineageChips(kin, f.downstream, 'data-d')}</div></div>
        <div class="linHint">parents ran first — their handoffs feed this task; children run later and receive this task's handoff.</div>`
      : `<span class="sideNote" style="padding:0;">no other ${esc(groupName)} tasks in this project yet — lineage chains live within a category group</span>`}</div>

    <div class="fld"><div class="flbl">Oversight — how much rope does the agent get?</div>
      <div class="ovsGrid" id="mOvs">
        ${[['auto', 'AUTO', 'Autopilot', 'Runs to completion unattended. Pings you when done or stuck.'],
           ['propose', 'PROP', 'Propose first', 'Reads context, drafts a plan, then waits. Nothing executes until you sign off.'],
           ['coop', 'COOP', 'Cooperative', 'You and the agent at the whiteboard — short turns, live back-and-forth.'],
           ['manual', 'MAN', 'Manual', 'No agent — a tracked todo. Coauthor emails stay yours.']]
          .map(([o, b, t2, d]) => `<div class="ovsCard ${f.oversight === o ? 'on' : ''}" data-o="${o}">
            <div class="ot"><span class="ovs ${o}">${b}</span> ${t2}</div><div class="od">${d}</div></div>`).join('')}
      </div></div>

    <div class="fld agentPicker"><div class="flbl">AI service and model <span class="anno" style="margin-left:8px">no silent fallback between services</span></div>
      <div class="providerPick" id="mProvider">${['claude', 'codex'].map(provider => {
        const ps = providerState(provider);
        return `<div class="providerChoice ${provider} ${f.provider === provider ? 'on' : ''} ${ps.connected ? '' : 'offline'}" data-ap="${provider}">
          <span class="providerIcon">${provider === 'codex' ? '⌘' : '✦'}</span><span><b>${agentName(provider)}</b><small>${ps.connected ? 'connected' : ps.available === false ? 'CLI unavailable' : 'not connected'}</small></span>
        </div>`;
      }).join('')}</div>
      <div class="modelPick" id="mModels">${(providerModels(f.provider).length ? providerModels(f.provider) : [{ id: '', label: f.provider === 'codex' ? 'Codex default' : 'No models loaded' }]).map(m =>
        `<span class="pillOpt ${f.model === m.id ? 'on' : ''}" data-am="${esc(m.id)}">${esc(m.label || m.id)}</span>`).join('')}</div>
      ${f.provider === 'codex' ? `<div class="effortPick"><span>Reasoning effort</span>${REASONING_EFFORTS.map(r => `<span class="pillOpt ${f.reasoningEffort === r.id ? 'on' : ''}" data-ae="${r.id}">${r.label}</span>`).join('')}</div>` : ''}
      ${providerState(f.provider).connected ? '' : `<div class="agentOfflineNote">${agentName(f.provider)} is not connected. You can save this task, but must connect it in Settings before launch.</div>`}
    </div>

    <div class="fld"><div class="flbl">Context packet <span class="anno" style="margin-left:8px">assembled &amp; injected at launch</span></div>
      <div class="ctxBox">
        <div class="qchips">
          ${[['include_abstract', '✓ living abstract'],
             ['include_last_session', '✓ last session summary'],
             ['include_sibling_tasks', '✓ sibling tasks'],
             ['include_category_primer', '✓ category primer']]
            .map(([kk, lb]) => `<span class="qchip ${f[kk] ? 'on' : ''}" data-t="${kk}">${lb}</span>`).join('')}
        </div>
        <input type="text" id="mSources" style="margin-top:8px;"
          placeholder="web sources, comma-separated (arxiv, nber, ssrn…) — search is always on" value="${esc(f.web_sources)}">
        <div style="display:flex;gap:8px;margin-top:8px;align-items:stretch;">
          <input type="text" id="mFiles" style="flex:1;"
            placeholder="pinned files, comma-separated (relative to project root)" value="${esc(f.files)}">
          <button type="button" id="mFilesPick" class="pickBtn" title="choose a file from the ${esc(state.projects[f.project]?.name || f.project)} folder">⌖ browse…</button>
        </div>
        <textarea rows="3" style="margin-top:10px;" id="mNotes" placeholder="Background notes for ${agentName(f.provider)}…">${esc(f.notes)}</textarea>
      </div></div>

    <div class="foot">
      <button class="save" id="mSave">Save task</button>
      <span class="cancel" id="mCancel">cancel</span>
      <span class="where" id="mWhere">→ tasks/${esc(f.project)}.json</span>
    </div>`;

  host.querySelector('#mTitle').addEventListener('input', e => { f.title = e.target.value; updateJson(); });
  host.querySelector('#mDesc').addEventListener('input', e => { f.description = e.target.value; updateJson(); });
  host.querySelector('#mFiles').addEventListener('input', e => { f.files = e.target.value; updateJson(); });
  const fp = host.querySelector('#mFilesPick');
  if (fp) fp.addEventListener('click', async () => {
    // same native macOS chooser as the workbench ＋ — only when browsing at
    // the server machine (remotely the dialog would open on its screen)
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
      toast('the file dialog opens on the server machine — type the path here instead');
      return;
    }
    fp.textContent = '…';
    const r = await api('POST', '/api/pickfile', { project: f.project });
    fp.textContent = '⌖ browse…';
    if (r && r.rel) {
      const cur = f.files.split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes(r.rel)) cur.push(r.rel);
      f.files = cur.join(', ');
      renderModal(); // re-renders the field and the JSON preview
    }
  });
  host.querySelector('#mNotes').addEventListener('input', e => { f.notes = e.target.value; updateJson(); });
  const ms = host.querySelector('#mSources');
  if (ms) ms.addEventListener('input', e => { f.web_sources = e.target.value; updateJson(); });

  host.querySelectorAll('#mCat .pillOpt').forEach(el => el.addEventListener('click', () => {
    if (f.category !== el.dataset.c) {
      // lineage candidates only change when the GROUP does — switching between
      // sibling categories (e.g. collection → cleaning) keeps the links
      if (catGroup(el.dataset.c) !== catGroup(f.category)) { f.upstream = []; f.downstream = []; }
      f.category = el.dataset.c;
    }
    renderModal();
  }));
  host.querySelectorAll('#mProj .pillOpt').forEach(el => el.addEventListener('click', () => {
    if (f.project !== el.dataset.p) { f.project = el.dataset.p; f.upstream = []; f.downstream = []; }
    renderModal();
  }));
  const toggleLineage = (id, list, other) => {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else {
      list.push(id);
      const j = other.indexOf(id); // a task can't be both before and after
      if (j >= 0) other.splice(j, 1);
    }
    renderModal();
  };
  host.querySelectorAll('#mUp .qchip[data-u]').forEach(el => el.addEventListener('click', () =>
    toggleLineage(el.dataset.u, f.upstream, f.downstream)));
  host.querySelectorAll('#mDown .qchip[data-d]').forEach(el => el.addEventListener('click', () =>
    toggleLineage(el.dataset.d, f.downstream, f.upstream)));
  host.querySelectorAll('#mOvs .ovsCard').forEach(el => el.addEventListener('click', () => {
    f.oversight = el.dataset.o; renderModal();
  }));
  host.querySelectorAll('[data-ap]').forEach(el => el.addEventListener('click', () => {
    f.provider = el.dataset.ap;
    const models = providerModels(f.provider);
    f.model = models.find(m => m.isDefault)?.id || models[0]?.id || '';
    renderModal();
  }));
  host.querySelectorAll('[data-am]').forEach(el => el.addEventListener('click', () => {
    f.model = el.dataset.am || ''; renderModal();
  }));
  host.querySelectorAll('[data-ae]').forEach(el => el.addEventListener('click', () => {
    f.reasoningEffort = el.dataset.ae; renderModal();
  }));
  host.querySelectorAll('.ctxBox .qchip[data-t]').forEach(el => el.addEventListener('click', () => {
    f[el.dataset.t] = !f[el.dataset.t]; renderModal();
  }));
  host.querySelector('#mSave').addEventListener('click', saveTask);
  // wrapped, not passed by reference: the listener would hand closeModal the
  // click Event as its options object, and cancel would silently stash
  host.querySelector('#mCancel').addEventListener('click', () => closeModal({ discard: true }));

  updateJson();
}

async function saveTask() {
  if (!form) return;
  if (!form.title.trim()) { toast('Title required'); return; }
  const fields = buildTaskFields();
  const downstream = form.downstream.slice(); // survive closeModal()
  const task = await api('POST', '/api/tasks', fields);
  if (!task) return;   // failed save keeps the modal open, draft intact
  closeModal({ discard: true });
  toast(`saved ${task.id || ''} → tasks/${fields.project}.json`);
  // "comes after" links live on the downstream tasks: add us to their upstream
  if (task.id) {
    for (const did of downstream) {
      const dt = tasksOf(fields.project).find(t => t.id === did);
      const ups = Array.isArray(dt?.upstream) ? dt.upstream.slice() : [];
      if (!ups.includes(task.id)) {
        ups.push(task.id);
        await api('PATCH', `/api/tasks/${enc(fields.project)}/${enc(did)}`, { upstream: ups });
      }
    }
  }
  if (task.id) perOf(fields.project).taskId = task.id;
  go(fields.project);
}
