// Private, ephemeral checkpoint worker. Codex owns the user's ChatGPT auth;
// never extract OAuth tokens or send them to the Platform Responses API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexBin, getCodexClient } from './codexAppServer.js';

const error = (message, status = 409) => Object.assign(new Error(message), { status });
export async function requestCodexMemory(body, { client = getCodexClient(), spawnFn = spawn,
  env = process.env, timeoutMs = 90000 } = {}) {
  if (env.CP_NO_BILLED === '1') throw error('Billed memory calls are disabled in this environment.', 403);
  const { account } = await client.request('account/read', { refreshToken: false });
  if (account?.type !== 'chatgpt') throw error('Task memory requires your ChatGPT Codex subscription. API-key billing is not allowed.');
  const models = [];
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await client.request('model/list', { cursor, includeHidden: false, limit: 100 });
    models.push(...(page.data || [])); cursor = page.nextCursor;
    if (!cursor) break;
  }
  const model = models.find(m => !m.hidden && (m.model || m.id) === body.model);
  if (!model || !model.supportedReasoningEfforts?.some(e => e.reasoningEffort === body.reasoning.effort)) {
    throw error('The selected memory model or effort is not available to your Codex account. Choose another in Settings.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-memory-codex-'));
  try {
    const schema = path.join(dir, 'checkpoint.schema.json');
    fs.writeFileSync(schema, JSON.stringify(body.text.format.schema), { mode: 0o600 });
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--cd', dir, '--model', body.model, '--json', '--color', 'never', '--output-schema', schema];
    const config = {
      forced_login_method: 'chatgpt', model_provider: 'openai', model_reasoning_effort: body.reasoning.effort,
      web_search: 'disabled', project_doc_max_bytes: 0, notify: [],
      'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false,
      'features.plugins': false, 'features.hooks': false, 'features.memories': false,
      'features.browser_use': false, 'features.computer_use': false, 'features.image_generation': false,
      'features.code_mode_host': false, 'features.sleep_tool': false,
    };
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    args.push('-'); // private transcript goes over stdin, never process argv
    const childEnv = { ...env };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete childEnv[key];
    return await new Promise((resolve, reject) => {
      let child, timer, killTimer, buffer = '', total = 0, finalText = '', usage = null, failure = null;
      let completed = false, settled = false, exited = false;
      const stop = () => {
        if (exited) return;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child?.kill('SIGTERM'); } catch { /* gone */ } }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch { /* gone */ } }
        }, 1000);
        killTimer.unref?.();
      };
      const fail = message => { if (!failure) { failure = error(message, 502); stop(); } };
      const line = raw => {
        let event;
        try { event = JSON.parse(raw); } catch { fail('Codex memory returned an invalid event; checkpoint retained.'); return; }
        if (event.type === 'turn.failed' || event.type === 'error') fail('Codex memory failed; no API fallback. Check Codex sign-in and usage limits.');
        const item = event.item;
        if (item && !['agent_message', 'reasoning'].includes(item.type)) {
          // A memory job has no reason to execute tools. Reject unexpected
          // execution, even if a future CLI adds a tool not covered above.
          fail('Codex memory attempted a tool operation; checkpoint rejected.');
        }
        if (event.type === 'item.completed' && item?.type === 'agent_message') finalText = item.text || '';
        if (event.type === 'turn.completed') { completed = true; usage = event.usage; }
      };
      try { child = spawnFn(codexBin(), args, { cwd: dir, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(error('Could not start the Codex memory worker. Update Codex and check its sign-in.', 502)); return; }
      timer = setTimeout(() => fail('Codex memory timed out; previous checkpoint retained.'), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) { fail('Codex memory exceeded its response size limit.'); return; }
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { const next = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (next.trim()) line(next); }
      });
      // Drain but never persist arbitrary stderr, which may contain credentials.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => fail('Codex memory input was interrupted.'));
      child.on('error', () => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
        reject(error('Could not start the Codex memory worker. Update Codex and check its sign-in.', 502));
      });
      child.on('close', code => {
        exited = true;
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
        if (buffer.trim()) line(buffer);
        if (failure) { reject(failure); return; }
        if (code !== 0 || !completed || !finalText || !usage) { reject(error('Codex memory did not complete; no API fallback or automatic job retry.', 502)); return; }
        resolve({ status: Number(usage.output_tokens) > body.max_output_tokens ? 'incomplete' : 'completed', usage: { ...usage, input_tokens_details: { cached_tokens: usage.cached_input_tokens || 0 } },
          costUsd: 0, output: [{ type: 'message', content: [{ type: 'output_text', text: finalText }] }] });
      });
      child.stdin.end(`${body.instructions}\n\nReturn only the checkpoint JSON. Do not use tools or read local files.\n\n${body.input}`);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
