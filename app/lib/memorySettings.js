// Independent, opt-in settings for the checkpoint-only memory worker.
// Prices are planning ceilings, not a billing API. Refresh when models change.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';
import { getAuthStatus } from './auth.js';

// Two ways to reach a writer model. `claude-sdk` runs one tool-less turn through
// the Agent SDK, so it bills to the same Claude login/subscription the task
// sessions use (dollar figures are then the SDK's own estimate, counted against
// the plan's usage windows rather than an invoice). `openai-api` is a direct,
// separately billed API call with OPENAI_API_KEY.
export const MEMORY_CONNECTIONS = [
  { id: 'claude-sdk', label: 'Claude · this login / subscription', credential: 'Claude login (same as task sessions)' },
  { id: 'openai-api', label: 'OpenAI API · separately billed', credential: 'OPENAI_API_KEY on the server' },
];
export const MEMORY_MODELS = [
  { id: 'claude-sonnet-5', connection: 'claude-sdk', label: 'Claude Sonnet 5', input: 2, output: 10, cacheWrite: 1.25, efforts: ['low', 'medium', 'high'] },
  { id: 'claude-haiku-4-5', connection: 'claude-sdk', label: 'Claude Haiku 4.5', input: 1, output: 5, cacheWrite: 1.25, efforts: ['none'] },
  { id: 'claude-opus-5', connection: 'claude-sdk', label: 'Claude Opus 5', input: 5, output: 25, cacheWrite: 1.25, efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5.6-luna', connection: 'openai-api', label: 'GPT-5.6 Luna', input: 0.20, output: 1.20, cacheWrite: 1.25, efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5.6-terra', connection: 'openai-api', label: 'GPT-5.6 Terra', input: 2, output: 12, cacheWrite: 1.25, efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5-nano', connection: 'openai-api', label: 'GPT-5 Nano', input: 0.05, output: 0.40, cacheWrite: 1, efforts: ['low', 'medium'] },
];
// OpenAI/Luna is the initial low-cost choice; Claude remains explicitly
// selectable. The worker stays opt-in regardless of available credentials.
export const MEMORY_DEFAULTS = Object.freeze({
  enabled: false, connection: 'openai-api', model: 'gpt-5.6-luna', reasoningEffort: 'low',
  dailyBudgetUsd: 0, maxJobUsd: 0.10, maxInputTokens: 24000, maxOutputTokens: 4000,
  briefMaxChars: 6000,
});
export function memoryError(message, status = 400) { return Object.assign(new Error(message), { status }); }

/** Mirrors providers.js: an API key that works, or a completed login. */
export function claudeLoginConnected() {
  const auth = getAuthStatus();
  return auth.method === 'apikey' ? !auth.needed : auth.loggedIn === true;
}

export function createMemorySettings(root = ROOT, env = process.env, { claudeConnected = claudeLoginConnected } = {}) {
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
    const connection = MEMORY_CONNECTIONS.find(c => c.id === s.connection);
    const model = MEMORY_MODELS.find(m => m.id === s.model);
    if (typeof s.enabled !== 'boolean' || !connection || !model || model.connection !== connection.id || !model.efforts.includes(s.reasoningEffort)) {
      throw memoryError('invalid memory connection, model, effort, or enabled value');
    }
    for (const [key, min, max, integer] of [
      ['dailyBudgetUsd', 0, 100, false], ['maxJobUsd', 0.001, 5, false],
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
    return { 'claude-sdk': claude, 'openai-api': !!env.OPENAI_API_KEY?.trim() };
  }
  function get() { return validate(config().memory || {}); }
  function publicSettings() {
    const s = get(), creds = credentials();
    return { ...s, models: MEMORY_MODELS,
      connections: MEMORY_CONNECTIONS.map(c => ({ ...c, credentialConfigured: creds[c.id] })),
      credentialConfigured: creds[s.connection],
      billingBlocked: env.CP_NO_BILLED === '1', pricesAsOf: '2026-09-04' };
  }
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw memoryError('memory settings patch must be an object');
    const cfg = config();
    const next = validate({ ...validate(cfg.memory || {}), ...patch });
    if (next.enabled) {
      const creds = credentials();
      if (!creds[next.connection]) {
        throw memoryError(next.connection === 'openai-api'
          ? 'Set OPENAI_API_KEY on the server before enabling memory on the OpenAI connection.'
          : 'Sign in to Claude (Settings → AI services) before enabling memory on the Claude connection.');
      }
      if (next.dailyBudgetUsd <= 0) throw memoryError('Set a positive daily budget before enabling memory.');
    }
    cfg.memory = next;
    writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
    return publicSettings();
  }
  return { get, update, publicSettings };
}
export const memorySettings = createMemorySettings();
