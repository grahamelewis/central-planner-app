// Independent, opt-in settings for the checkpoint-only memory worker.
// Prices are planning ceilings, not a billing API. Refresh when models change.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';
import { getAuthStatus } from './auth.js';
import { getCodexStatus } from './codexAppServer.js';

// OpenAI memory uses the user's ChatGPT Codex login, never Platform API keys.
// Claude keeps its existing SDK connection. Legacy API settings migrate OFF.
export const MEMORY_CONNECTIONS = [
  { id: 'claude-sdk', label: 'Claude · this login / subscription', credential: 'Claude login (same as task sessions)' },
  { id: 'codex-subscription', label: 'OpenAI · my ChatGPT / Codex subscription', credential: 'ChatGPT sign-in under AI services → Codex' },
];
export const MEMORY_MODELS = [
  { id: 'claude-sonnet-5', connection: 'claude-sdk', label: 'Claude Sonnet 5', input: 2, output: 10, cacheWrite: 1.25, efforts: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-4-5', connection: 'claude-sdk', label: 'Claude Haiku 4.5', input: 1, output: 5, cacheWrite: 1.25, efforts: ['none'] },
  { id: 'claude-opus-5', connection: 'claude-sdk', label: 'Claude Opus 5', input: 5, output: 25, cacheWrite: 1.25, efforts: ['low', 'medium', 'high'] },
  // Saved-model compatibility only; the picker uses Codex's live catalog.
  { id: 'gpt-5.6-luna', connection: 'codex-subscription', label: 'GPT-5.6 Luna', efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5.6-terra', connection: 'codex-subscription', label: 'GPT-5.6 Terra', efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5-nano', connection: 'codex-subscription', label: 'GPT-5 Nano', efforts: ['low', 'medium'] },
];
// OpenAI/Luna is the initial low-cost choice; Claude remains explicitly
// selectable. The worker stays opt-in regardless of available credentials.
export const MEMORY_DEFAULTS = Object.freeze({
  enabled: false, connection: 'codex-subscription', model: 'gpt-5.6-luna', reasoningEffort: 'low',
  dailyJobLimit: 12,
  dailyBudgetUsd: 0, maxJobUsd: 0.10, maxInputTokens: 24000, maxOutputTokens: 4000,
  briefMaxChars: 6000,
});
export function memoryError(message, status = 400) { return Object.assign(new Error(message), { status }); }

/** Mirrors providers.js: an API key that works, or a completed login. */
export function claudeLoginConnected() {
  const auth = getAuthStatus();
  return auth.method === 'apikey' ? !auth.needed : auth.loggedIn === true;
}

export function createMemorySettings(root = ROOT, env = process.env, { claudeConnected = claudeLoginConnected, codexStatus = getCodexStatus } = {}) {
  const file = path.join(root, 'config.json');
  function config() {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('invalid config');
      return c;
    } catch (e) { if (e.code === 'ENOENT') return {}; throw memoryError('Cannot read config.json; memory settings were not changed.', 409); }
  }
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw memoryError('memory settings must be an object');
    for (const key of Object.keys(value)) if (!(key in MEMORY_DEFAULTS)) throw memoryError(`unknown memory setting: ${key}`);
    const s = { ...MEMORY_DEFAULTS, ...value };
    if (s.connection === 'openai-api') { s.connection = 'codex-subscription'; s.enabled = false; }
    const connection = MEMORY_CONNECTIONS.find(c => c.id === s.connection);
    let model = [...models(), ...MEMORY_MODELS].find(m => m.id === s.model && m.connection === s.connection);
    // A saved account-specific model may disappear while offline. Keep its
    // configuration readable/disableable, but never dispatch it without the
    // live account/model check in requestCodexMemory.
    const saved = config().memory;
    if (!model && s.connection === 'codex-subscription' && saved?.model === s.model && saved?.reasoningEffort === s.reasoningEffort) {
      model = { id: s.model, connection: s.connection, efforts: [s.reasoningEffort] };
    }
    if (typeof s.enabled !== 'boolean' || !connection || !model || model.connection !== connection.id || !model.efforts.includes(s.reasoningEffort)) {
      throw memoryError('invalid memory connection, model, effort, or enabled value');
    }
    for (const [key, min, max, integer] of [
      ['dailyBudgetUsd', 0, 100, false], ['maxJobUsd', 0.001, 5, false],
      ['dailyJobLimit', 1, 100, true],
      ['maxInputTokens', 12000, 64000, true], ['maxOutputTokens', 1000, 12000, true], ['briefMaxChars', 1000, 10000, true],
    ]) {
      if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < min || s[key] > max || (integer && !Number.isInteger(s[key]))) {
        throw memoryError(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
      }
    }
    return s;
  }
  function credentials() {
    let claude = false;
    try { claude = claudeConnected() === true; } catch { claude = false; }
    const codex = codexStatus();
    return { 'claude-sdk': claude, 'codex-subscription': codex.connected === true && codex.account?.type === 'chatgpt' };
  }
  function models() {
    const codex = codexStatus();
    const rows = codex.connected && codex.account?.type === 'chatgpt' ? codex.models || [] : [];
    return [...MEMORY_MODELS.filter(m => m.connection === 'claude-sdk'), ...rows.map(m => ({
      id: m.id, label: m.label || m.id, connection: 'codex-subscription', available: true,
      efforts: (m.supportedReasoningEfforts || []).map(e => e.id),
    })).filter(m => m.id && m.efforts.length)];
  }
  function get() { return validate(config().memory || {}); }
  function publicSettings() {
    const s = get(), creds = credentials();
    const list = models();
    if (!list.some(m => m.id === s.model && m.connection === s.connection)) {
      list.push({ id: s.model, label: `${s.model} (not available — connect Codex / choose a model)`, connection: s.connection,
        efforts: [s.reasoningEffort], available: false });
    }
    // Always include a non-runnable OpenAI placeholder when Claude is selected
    // and the Codex account/catalog is unavailable.
    if (!list.some(m => m.connection === 'codex-subscription')) list.push({
      id: MEMORY_DEFAULTS.model, label: 'Connect Codex with ChatGPT to load models', connection: 'codex-subscription', efforts: ['low'], available: false,
    });
    return { ...s, models: list,
      connections: MEMORY_CONNECTIONS.map(c => ({ ...c, credentialConfigured: creds[c.id] })),
      credentialConfigured: creds[s.connection],
      billingBlocked: env.CP_NO_BILLED === '1', pricesAsOf: '2026-09-04' };
  }
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw memoryError('memory settings patch must be an object');
    const cfg = config();
    if (patch.connection === 'openai-api') throw memoryError('OpenAI API memory was removed. Choose the Codex subscription connection.');
    const next = validate({ ...validate(cfg.memory || {}), ...patch });
    if (next.enabled) {
      const creds = credentials();
      if (!creds[next.connection]) {
        throw memoryError(next.connection === 'codex-subscription'
          ? 'Sign in to Codex with ChatGPT under AI services. API-key login cannot be used for Task memory.'
          : 'Sign in to Claude (Settings → AI services) before enabling memory on the Claude connection.');
      }
      if (next.connection === 'codex-subscription' && !models().some(m => m.id === next.model && m.connection === next.connection && m.efforts.includes(next.reasoningEffort))) {
        throw memoryError('Choose a memory model and effort available to your Codex account.');
      }
      if (next.connection === 'claude-sdk' && next.dailyBudgetUsd <= 0) throw memoryError('Set a positive daily budget before enabling memory.');
    }
    cfg.memory = next;
    writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
    return publicSettings();
  }
  return { get, update, publicSettings, models };
}
export const memorySettings = createMemorySettings();
