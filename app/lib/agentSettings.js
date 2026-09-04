// Persisted defaults for new agent-backed tasks.
//
// This deliberately owns only config.json's `agents` block. Like
// projectStore.js, every write re-reads the file first so unrelated user
// settings are never replaced by a stale in-memory copy.
import fs from 'fs';
import path from 'path';
import { ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';
import { canonicalModel } from './models.js';

const CONFIG_FILE = path.join(ROOT, 'config.json');
const FALLBACK = Object.freeze({
  provider: 'claude',
  model: 'claude-opus-5',
  reasoningEffort: 'high',
});
const PROVIDERS = new Set(['claude', 'codex']);

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalize(raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const provider = PROVIDERS.has(a.defaultProvider) ? a.defaultProvider : FALLBACK.provider;
  const model = typeof a.defaultModel === 'string' && a.defaultModel.trim()
    ? canonicalModel(a.defaultModel.trim())
    : (provider === 'claude' ? FALLBACK.model : null);
  const reasoningEffort = typeof a.defaultReasoningEffort === 'string' && a.defaultReasoningEffort.trim()
    ? a.defaultReasoningEffort.trim()
    : FALLBACK.reasoningEffort;
  return { provider, model, reasoningEffort };
}

let current = normalize(readConfig().agents);

export function getAgentDefaults() {
  return { ...current };
}

export function updateAgentDefaults(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const e = new Error('agent defaults patch must be an object'); e.status = 400; throw e;
  }
  const next = { ...current };
  let providerChanged = false;
  if (patch.provider !== undefined) {
    if (!PROVIDERS.has(patch.provider)) {
      const e = new Error("provider must be 'claude' or 'codex'"); e.status = 400; throw e;
    }
    providerChanged = patch.provider !== next.provider;
    next.provider = patch.provider;
  }
  if (patch.model !== undefined) {
    if (patch.model !== null && (typeof patch.model !== 'string' || !patch.model.trim())) {
      const e = new Error('model must be a non-empty string or null'); e.status = 400; throw e;
    }
    next.model = patch.model === null ? null : patch.model.trim();
  } else if (providerChanged) {
    next.model = next.provider === 'claude' ? FALLBACK.model : null;
  }
  if (patch.reasoningEffort !== undefined) {
    if (typeof patch.reasoningEffort !== 'string' || !patch.reasoningEffort.trim()) {
      const e = new Error('reasoningEffort must be a non-empty string'); e.status = 400; throw e;
    }
    next.reasoningEffort = patch.reasoningEffort.trim();
  }
  if (next.provider === 'claude' && !next.model) next.model = FALLBACK.model;

  const cfg = readConfig();
  cfg.agents = {
    ...(cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {}),
    defaultProvider: next.provider,
    defaultModel: next.model,
    defaultReasoningEffort: next.reasoningEffort,
  };
  writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  current = next;
  return getAgentDefaults();
}

export const _test = { normalize, FALLBACK };
