// Superseded Claude model IDs → their current successor. A task (or a saved
// default) pinned to an older Fable keeps running on the newest one from its
// next turn, so "Fable" in the picker always means the latest release.
export const MODEL_ALIASES = Object.freeze({ 'claude-fable-5': 'claude-fable-5-1' });
export const canonicalModel = (m) => (typeof m === 'string' && MODEL_ALIASES[m]) || m;

// Reasoning-effort levels per provider. Codex's ladder is minimal→xhigh; the
// Agent SDK's `effort` option takes low→max. The two share the middle rungs
// so a task keeps its setting across a provider switch wherever possible.
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const DEFAULT_EFFORT = 'high';
export const effortsFor = (provider) => (provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS);
/** Nearest level the provider accepts (minimal↔low, max↔xhigh); unknown → high. */
export function coerceEffort(provider, effort) {
  const ladder = effortsFor(provider);
  if (ladder.includes(effort)) return effort;
  if (effort === 'minimal') return 'low';
  if (effort === 'max') return 'xhigh';
  return DEFAULT_EFFORT;
}
