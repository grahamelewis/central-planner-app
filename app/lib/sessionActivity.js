// Display-only, provider-neutral turn activity. Never retain commands, paths,
// tool results, or model reasoning in the published state.
export function toolActivityLabel(name, input = {}) {
  if (['Read', 'read_file'].includes(name)) return 'Reading files';
  if (['Grep', 'Glob', 'search_files'].includes(name)) return 'Searching files';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange', 'apply_patch'].includes(name)) return 'Editing files';
  if (['WebSearch', 'web_search'].includes(name)) return 'Searching web';
  if (['WebFetch', 'web_fetch'].includes(name)) return 'Reading a web page';
  if (['Task', 'Agent', 'collabAgentToolCall'].includes(name)) return 'Working with agents';
  if (['Bash', 'commandExecution', 'exec_command'].includes(name)) {
    const command = typeof input?.command === 'string' ? input.command.trim() : '';
    // Deliberately narrow: do not infer activity from a description, shell
    // compound, quoted program, or a filename which merely contains "test".
    if (!/[\n\r;&|`<>]/.test(command) && !command.includes('$(')
      && /^(?:(?:npm|pnpm) (?:test|run test)|yarn test|node --test|pytest|cargo test|go test)(?:\s|$)/.test(command)) {
      return 'Running tests';
    }
    return 'Running command';
  }
  return 'Using a tool';
}

/** A bounded map preserves concurrent tool lifetimes without streaming noise.
 * The newest known active tool is displayed; completing it reveals the next.
 * Lost/missing tool results cannot survive clear() at the end of the turn. */
export function createActivityTracker(publish, maxTools = 128) {
  const active = new Map();
  let phase = 'Working';
  let label = phase;
  let closed = false;
  const push = () => {
    const next = active.size ? [...active.values()].at(-1) : phase;
    if (next === label) return;
    label = next;
    publish({ label });
  };
  return {
    start(id, name, input) {
      if (closed || !id || active.has(id)) return;
      phase = 'Working';
      if (active.size >= maxTools) active.delete(active.keys().next().value);
      active.set(id, toolActivityLabel(name, input));
      push();
    },
    end(id) {
      if (closed || !active.delete(id)) return;
      push();
    },
    phase(writing = false) {
      if (closed) return;
      phase = writing ? 'Writing response' : 'Working';
      push();
    },
    clear() {
      if (closed) return;
      closed = true;
      active.clear();
      publish(null);
    },
  };
}
