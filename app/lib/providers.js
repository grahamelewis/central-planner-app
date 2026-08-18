// Provider-facing snapshot assembled for the browser. Claude keeps its proven
// SDK/auth path; Codex is backed by codex app-server.
import { getAuthStatus } from './auth.js';
import { getCodexStatus } from './codexAppServer.js';

export const CLAUDE_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', description: 'Highest-capability Claude model' },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Deep reasoning for demanding work', isDefault: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Fast, capable everyday default' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Quick and economical' },
];

export function getProvidersSnapshot() {
  const auth = getAuthStatus();
  const claudeConnected = auth.method === 'apikey'
    ? !auth.needed
    : auth.loggedIn === true;
  return {
    claude: {
      id: 'claude', name: 'Claude', available: auth.available,
      connected: claudeConnected, auth, models: CLAUDE_MODELS,
      usage: null, // Claude usage remains at ledger.usage for back-compat.
    },
    codex: { id: 'codex', name: 'Codex', ...getCodexStatus() },
  };
}
