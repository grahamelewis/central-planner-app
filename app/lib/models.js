// Superseded Claude model IDs → their current successor. A task (or a saved
// default) pinned to an older Fable keeps running on the newest one from its
// next turn, so "Fable" in the picker always means the latest release.
export const MODEL_ALIASES = Object.freeze({ 'claude-fable-5': 'claude-fable-5-1' });
export const canonicalModel = (m) => (typeof m === 'string' && MODEL_ALIASES[m]) || m;
