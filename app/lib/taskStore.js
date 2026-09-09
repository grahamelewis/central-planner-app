// Owns ROOT/tasks/<project>.json (JSON array of tasks), ROOT/categories.json,
// and read-only access to ROOT/abstracts/<project>.md. Synchronous fs.
import fs from 'fs';
import path from 'path';
import { ROOT, APP_DIR, PROJECTS } from './config.js';
import { broadcast } from './events.js';
import { writeFileAtomic } from './paths.js';
import { getAgentDefaults } from './agentSettings.js';
import { canonicalModel, coerceEffort } from './models.js';
export { MODEL_ALIASES, canonicalModel } from './models.js';

// Every task carries an explicit model; legacy tasks with model:null fall back
// to this at launch (sessions.js). Frontier-only policy — no "SDK default".
export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_PROVIDER = 'claude';

const TASKS_DIR = path.join(ROOT, 'tasks');
const ABSTRACTS_DIR = path.join(ROOT, 'abstracts');
const CATEGORIES_FILE = path.join(ROOT, 'categories.json');
const CATEGORIES_EXAMPLE = path.join(ROOT, 'categories.example.json');

function assertProject(project) {
  if (typeof project !== 'string' || !Object.prototype.hasOwnProperty.call(PROJECTS, project)) {
    throw new Error(`unknown project '${project}'`);
  }
}

function taskFile(project) {
  return path.join(TASKS_DIR, `${project}.json`);
}

function readTasksFile(project) {
  const file = taskFile(project);
  if (!fs.existsSync(file)) return []; // genuinely new project — empty is correct
  // A read/parse failure must THROW, not return []: a later write would
  // otherwise replace the whole task file with the empty list.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON array — refusing to touch it`);
  }
  // Provider fields were added after the original Claude-only task schema.
  // Normalize in memory (and let the next ordinary write persist it) rather
  // than rewriting every user's task files merely because the server booted.
  return parsed.map(normalizeTask);
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
  const out = { ...task };
  out.provider = out.provider === 'codex' ? 'codex' : DEFAULT_PROVIDER;
  if (out.provider === 'claude') out.model = canonicalModel(out.model) || DEFAULT_MODEL;
  out.reasoningEffort = coerceEffort(out.provider, out.reasoningEffort);
  // `session` remains the active provider's compatibility alias. The history
  // map retains earlier provider-owned threads when the user crosses the
  // explicit provider boundary and starts a fresh one.
  if (!out.providerSessions || typeof out.providerSessions !== 'object' || Array.isArray(out.providerSessions)) {
    out.providerSessions = {};
    if (out.session) out.providerSessions[out.provider] = [out.session];
  }
  return out;
}

function writeTasksFile(project, tasks) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  writeFileAtomic(taskFile(project), JSON.stringify(tasks, null, 2) + '\n');
}

export function listTasks(project) {
  assertProject(project);
  return readTasksFile(project);
}

export function allTasks() {
  // Display path: one corrupt project file shouldn't blank the whole app.
  // (Write paths still go through readTasksFile directly and refuse to write.)
  const out = {};
  for (const key of Object.keys(PROJECTS)) {
    try {
      out[key] = readTasksFile(key);
    } catch (err) {
      console.error(`[core] tasks/${key}.json unreadable:`, err.message);
      out[key] = [];
    }
  }
  return out;
}

export function getTask(project, id) {
  assertProject(project);
  const tasks = readTasksFile(project);
  return tasks.find((t) => t && t.id === id) || null;
}

function nextId(project, tasks) {
  const prefix = project.slice(0, 3);
  let max = 0;
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
    const m = t.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export function createTask(project, fields) {
  assertProject(project);
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) fields = {};
  const tasks = readTasksFile(project);

  const agentDefaults = getAgentDefaults();
  const requestedProvider = fields.provider === 'codex' ? 'codex'
    : fields.provider === 'claude' ? 'claude' : agentDefaults.provider;
  const defaultModel = requestedProvider === agentDefaults.provider
    ? agentDefaults.model
    : (requestedProvider === 'claude' ? DEFAULT_MODEL : null);
  const defaults = {
    title: '',
    description: '',
    category: null,
    upstream: [],
    oversight: 'coop',
    status: 'queued',
    question: null,
    provider: requestedProvider,
    model: defaultModel,
    reasoningEffort: agentDefaults.reasoningEffort || 'high',
    permMode: null, // null → derived from oversight; else 'default'|'acceptEdits'|'auto'|'bypassPermissions'
    context: {
      include_abstract: true,
      include_last_session: true,
      include_sibling_tasks: true,
      include_category_primer: true,
      web_search: { enabled: false, sources: [] },
      files: [],
      notes: '',
    },
    session: null,
    providerSessions: {},
    handoff: null,
    due: null,
    log: [],
  };

  const task = { ...defaults, ...fields };
  task.provider = task.provider === 'codex' ? 'codex' : DEFAULT_PROVIDER;
  if (task.provider === 'claude') task.model = canonicalModel(task.model) || DEFAULT_MODEL;
  task.reasoningEffort = coerceEffort(task.provider, task.reasoningEffort);
  if (!task.providerSessions || typeof task.providerSessions !== 'object' || Array.isArray(task.providerSessions)) {
    task.providerSessions = {};
  }
  // Never let caller override the assigned identity fields.
  task.id = nextId(project, tasks);
  task.project = project;
  task.created = new Date().toISOString();
  if (fields.context && typeof fields.context === 'object' && !Array.isArray(fields.context)) {
    task.context = { ...defaults.context, ...fields.context };
    if (fields.context.web_search && typeof fields.context.web_search === 'object') {
      task.context.web_search = { ...defaults.context.web_search, ...fields.context.web_search };
    }
  } else {
    // a null/garbage context in the payload must not shadow the defaults
    task.context = { ...defaults.context };
  }
  if (!Array.isArray(task.upstream)) task.upstream = [];
  if (!Array.isArray(task.log)) task.log = [];

  tasks.push(task);
  writeTasksFile(project, tasks);
  broadcast('task:update', { project, task });
  return task;
}

export function updateTask(project, id, patch) {
  assertProject(project);
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  const tasks = readTasksFile(project);
  const idx = tasks.findIndex((t) => t && t.id === id);
  if (idx === -1) throw new Error(`task '${id}' not found in project '${project}'`);

  const { logNote, ...rest } = patch;
  // Protect identity fields from shallow merge.
  delete rest.id;
  delete rest.project;

  const task = { ...tasks[idx], ...rest };
  task.provider = task.provider === 'codex' ? 'codex' : DEFAULT_PROVIDER;
  if (task.provider === 'claude') task.model = canonicalModel(task.model) || DEFAULT_MODEL;
  task.reasoningEffort = coerceEffort(task.provider, task.reasoningEffort);
  if (!task.providerSessions || typeof task.providerSessions !== 'object' || Array.isArray(task.providerSessions)) {
    task.providerSessions = {};
  }
  if (logNote) {
    if (!Array.isArray(task.log)) task.log = [];
    task.log = [...task.log, { ts: new Date().toISOString(), note: String(logNote) }];
  }
  tasks[idx] = task;
  writeTasksFile(project, tasks);
  broadcast('task:update', { project, task });
  return task;
}

export function deleteTask(project, id) {
  assertProject(project);
  const tasks = readTasksFile(project);
  const idx = tasks.findIndex((t) => t && t.id === id);
  if (idx === -1) throw new Error(`task '${id}' not found in project '${project}'`);
  const [removed] = tasks.splice(idx, 1);
  writeTasksFile(project, tasks);
  broadcast('task:delete', { project, id });
  return removed;
}

/** Category rename support: rewrite task.category from → to across EVERY
    project — past and present tasks alike (renames propagate; deletes never
    call this). No per-task broadcast: the caller re-broadcasts a full state
    snapshot once. A corrupt project file is skipped (logged), same as the
    allTasks() display path — its tasks simply keep the old label. */
export function retagCategory(from, to) {
  let count = 0;
  for (const key of Object.keys(PROJECTS)) {
    let tasks;
    try {
      tasks = readTasksFile(key);
    } catch (err) {
      console.error(`[core] retag skipped tasks/${key}.json:`, err.message);
      continue;
    }
    let touched = false;
    for (const t of tasks) {
      if (t && t.category === from) {
        t.category = to;
        touched = true;
        count++;
      }
    }
    if (touched) writeTasksFile(key, tasks);
  }
  return count;
}

export function getCategories() {
  // the user's categories.json wins; a fresh clone (no categories.json yet)
  // falls back to the shipped categories.example.json so the Add Task picker
  // isn't empty out of the box. A malformed user file surfaces (not masked).
  for (const file of [...new Set([CATEGORIES_FILE, CATEGORIES_EXAMPLE, path.resolve(APP_DIR, '..', 'categories.example.json')])]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // missing — try the next source
      console.error(`[core] failed reading ${path.basename(file)}:`, err.message);
      return {};
    }
  }
  return {};
}

export function getAbstract(project) {
  assertProject(project);
  try {
    const file = path.join(ABSTRACTS_DIR, `${project}.md`);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[core] failed reading abstract for ${project}:`, err.message);
    return '';
  }
}

// Abstract + its mtime, for staleness annotation in the context packet.
// mtimeMs is null when the file is absent or unreadable.
export function getAbstractInfo(project) {
  assertProject(project);
  try {
    const file = path.join(ABSTRACTS_DIR, `${project}.md`);
    if (!fs.existsSync(file)) return { text: '', mtimeMs: null };
    return { text: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
  } catch (err) {
    console.error(`[core] failed reading abstract for ${project}:`, err.message);
    return { text: '', mtimeMs: null };
  }
}
