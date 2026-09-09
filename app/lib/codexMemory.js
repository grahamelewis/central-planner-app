// Private, ephemeral checkpoint worker. Codex owns the user's ChatGPT auth;
// never extract OAuth tokens or send them to the Platform Responses API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { codexBin, getCodexClient } from './codexAppServer.js';

const ownError = Symbol('memory error');
const error = (message, code, diagnostics, deterministic = false, status = 502) => Object.assign(new Error(message), {
  [ownError]: true, status, code, deterministic, pauseWorthy: deterministic, diagnostics: { ...diagnostics, code },
});
const events = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error', 'warning']);
const tools = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call', 'computer_use', 'tool_call']);
const items = new Set(['agent_message', 'reasoning', 'error', 'warning', 'todo_list', ...tools]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeVersion = value => typeof value === 'string' ? value.trim().match(/^(?:codex(?:_cli_rs|-cli)?[ /])?(\d{1,4}\.\d{1,4}\.\d{1,4})$/)?.[1] ?? null : null;
const readVersion = () => new Promise(resolve => execFile(codexBin(), ['--version'], {
  timeout: 3000, maxBuffer: 4096, cwd: os.tmpdir(),
}, (err, stdout) => resolve(err ? null : safeVersion(stdout))));

// Account/catalog requests do not generate model output. The scheduler calls
// this before reserving budget; dispatch repeats it to close the readiness gap.
export async function preflightCodexMemory(body, { client, env = process.env, getVersion } = {}) {
  const models = [];
  const diagnostics = { stage: 'preflight', version: null };
  try {
    if (env.CP_NO_BILLED === '1') throw error('Billed memory calls are disabled in this environment.', 'memory-disabled', diagnostics, true, 403);
    const readClient = client ?? getCodexClient();
    const versionGetter = getVersion ?? (client ? async () => null : readVersion);
    try { diagnostics.version = safeVersion(await versionGetter()); } catch { /* version is diagnostic only */ }
    const { account } = await readClient.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw error('Task memory requires your ChatGPT Codex subscription. API-key billing is not allowed.', 'memory-auth-required', diagnostics, true, 409);
    let cursor = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await readClient.request('model/list', { cursor, includeHidden: false, limit: 100 });
      if (!object(page) || !Array.isArray(page.data) || page.data.some(m => !object(m))) {
        throw error('Codex returned an invalid model catalog.', 'memory-protocol-malformed', diagnostics, true);
      }
      models.push(...page.data); cursor = page.nextCursor;
      if (!cursor) break;
    }
    const model = models.find(m => !m.hidden && (m.model || m.id) === body.model);
    if (!model && cursor) throw error('Codex model readiness could not be confirmed.', 'memory-readiness-failed', diagnostics);
    if (!model || !Array.isArray(model.supportedReasoningEfforts) || !model.supportedReasoningEfforts.some(e => e?.reasoningEffort === body.reasoning?.effort)) {
      throw error('The selected memory model or effort is not available to your Codex account. Choose another in Settings.', 'memory-model-unavailable', diagnostics, true, 409);
    }
    return { ready: true, model: body.model, diagnostics };
  } catch (err) {
    throw Object.assign(err?.[ownError] ? err : error('Codex memory readiness could not be checked. Check Codex sign-in and availability.', 'memory-readiness-failed', diagnostics), { dispatched: false });
  }
}

export async function requestCodexMemory(body, { client, spawnFn = spawn,
  env = process.env, timeoutMs = 90000, onUsage, getVersion } = {}) {
  const readiness = await preflightCodexMemory(body, { client, env, getVersion });
  const diagnostics = { stage: 'setup', version: readiness.diagnostics.version, warningCount: 0 };
  let dir, spawned = false;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-memory-codex-'));
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
      let completed = false, usageComplete = false, settled = false, exited = false;
      const accountingResponse = () => ({
        usage: usage ? { ...usage,
          input_tokens_details: { cached_tokens: usage.cached_input_tokens ?? null, cache_write_tokens: usage.cache_write_input_tokens ?? null },
          output_tokens_details: { reasoning_tokens: usage.reasoning_output_tokens ?? null },
        } : null,
        usageCompleteness: usage ? usageComplete ? 'complete' : 'partial' : 'unknown',
        usageScope: 'whole-query', costUsd: null,
      });
      const rejectAccounted = err => reject(Object.assign(err, { accountingResponse: accountingResponse(),
        diagnostics: { ...err.diagnostics, exitCode: diagnostics.exitCode ?? null }, dispatched: err.dispatched ?? spawned }));
      const checkpointUsage = () => { if (settled) return; try { onUsage?.(accountingResponse()); } catch { /* terminal path retries observed usage */ } };
      const stop = () => {
        if (exited) return;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child?.kill('SIGTERM'); } catch { /* gone */ } }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch { /* gone */ } }
        }, 1000);
        killTimer.unref?.();
      };
      const fail = (message, code, deterministic = false) => {
        if (!failure) { failure = error(message, code, diagnostics, deterministic); stop(); }
        else if (deterministic && !failure.deterministic) failure = error(message, code, diagnostics, true);
      };
      const line = raw => {
        let event;
        diagnostics.stage = 'stream';
        diagnostics.eventType = 'unknown'; delete diagnostics.itemType;
        try { event = JSON.parse(raw); } catch { fail('Codex memory returned an invalid event; checkpoint retained.', 'memory-protocol-malformed', true); return; }
        if (!object(event) || typeof event.type !== 'string') {
          fail('Codex memory returned an invalid event; checkpoint retained.', 'memory-protocol-malformed', true); return;
        }
        diagnostics.eventType = events.has(event.type) ? event.type : 'unknown';
        if (!events.has(event.type)) {
          fail('Codex memory returned an unsupported event; checkpoint retained.', 'memory-protocol-unsupported', true); return;
        }
        if (['turn.completed', 'turn.failed'].includes(event.type) && event.usage && !usageComplete) {
          const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
          const input = count(event.usage.input_tokens), output = count(event.usage.output_tokens);
          if (input !== null || output !== null) {
            const previousUsage = usage;
            usage = { input_tokens: input, output_tokens: output,
              cached_input_tokens: count(event.usage.cached_input_tokens),
              cache_write_input_tokens: count(event.usage.cache_write_input_tokens),
              reasoning_output_tokens: count(event.usage.reasoning_output_tokens) };
            usageComplete = event.type === 'turn.completed' && input !== null && output !== null;
            if (!usageComplete && previousUsage) {
              for (const key of Object.keys(usage)) if (previousUsage[key] !== null) {
                usage[key] = usage[key] === null ? previousUsage[key] : Math.max(previousUsage[key], usage[key]);
              }
            }
            if (usage.input_tokens === null || (usage.cached_input_tokens || 0) + (usage.cache_write_input_tokens || 0) > usage.input_tokens) {
              usage.cached_input_tokens = null; usage.cache_write_input_tokens = null; usageComplete = false;
            }
            if (usage.output_tokens === null || (usage.reasoning_output_tokens || 0) > usage.output_tokens) {
              usage.reasoning_output_tokens = null; usageComplete = false;
            }
            checkpointUsage();
          }
        }
        if (event.type === 'turn.failed' || event.type === 'error') fail('Codex memory failed; no API fallback. Check Codex sign-in and usage limits.', 'memory-provider-failure');
        const item = event.item;
        if (event.type.startsWith('item.') || item !== undefined) {
          diagnostics.itemType = items.has(item?.type) ? item.type : 'unknown';
          if (!object(item) || typeof item.type !== 'string' || !event.type.startsWith('item.')) {
            fail('Codex memory returned an invalid item; checkpoint retained.', 'memory-protocol-malformed', true); return;
          }
          if (tools.has(item.type)) {
            fail('Codex memory attempted a tool operation; checkpoint rejected.', 'memory-tool-forbidden', true); return;
          }
          if (!['agent_message', 'reasoning', 'error', 'warning'].includes(item.type)) {
            fail('Codex memory returned an unsupported item; checkpoint retained.', 'memory-protocol-unsupported', true); return;
          }
          // Diagnostic items are not evidence of execution or terminal success.
          // Retain only categorical metadata, never arbitrary diagnostic text.
          if (item.type === 'error' || item.type === 'warning') {
            diagnostics.warningCount = Math.min(10000, diagnostics.warningCount + 1);
            diagnostics.warningEventType = event.type; diagnostics.warningItemType = item.type;
          }
        }
        if (event.type === 'warning') {
          diagnostics.warningCount = Math.min(10000, diagnostics.warningCount + 1);
          diagnostics.warningEventType = 'warning'; delete diagnostics.warningItemType;
        }
        if (event.type === 'item.completed' && item?.type === 'agent_message') {
          if (typeof item.text !== 'string') { fail('Codex memory returned invalid message text.', 'memory-protocol-malformed', true); return; }
          finalText = item.text;
        }
        if (event.type === 'turn.completed') completed = true;
      };
      diagnostics.stage = 'startup';
      try { child = spawnFn(codexBin(), args, { cwd: dir, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { rejectAccounted(Object.assign(error('Could not start the Codex memory worker. Update Codex and check its sign-in.', 'memory-worker-start-failed', diagnostics, true), { dispatched: false })); return; }
      spawned = true;
      child.once('spawn', checkpointUsage);
      timer = setTimeout(() => { diagnostics.stage = 'timeout'; fail('Codex memory timed out; previous checkpoint retained.', 'memory-timeout'); }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > 2 * 1024 * 1024) { fail('Codex memory exceeded its response size limit.', 'memory-output-limit', true); return; }
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { const next = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (next.trim()) line(next); }
      });
      // Drain but never persist arbitrary stderr, which may contain credentials.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => fail('Codex memory input was interrupted.', 'memory-input-interrupted'));
      child.on('error', err => {
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
        const notDispatched = ['ENOENT', 'EACCES'].includes(err?.code);
        rejectAccounted(Object.assign(error('Could not start the Codex memory worker. Update Codex and check its sign-in.', 'memory-worker-start-failed', diagnostics, notDispatched), { dispatched: !notDispatched }));
      });
      child.on('close', code => {
        exited = true;
        if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
        if (buffer.trim()) line(buffer);
        diagnostics.exitCode = Number.isInteger(code) ? code : null;
        if (failure) { rejectAccounted(failure); return; }
        diagnostics.stage = 'close';
        if (code !== 0 || !completed || !finalText.trim() || !usage) { rejectAccounted(error('Codex memory did not complete; no API fallback or automatic job retry.', 'memory-incomplete', diagnostics)); return; }
        diagnostics.stage = 'completed';
        if (diagnostics.warningCount) {
          diagnostics.eventType = diagnostics.warningEventType;
          if (diagnostics.warningItemType) diagnostics.itemType = diagnostics.warningItemType;
          else delete diagnostics.itemType;
        }
        resolve({ status: Number(usage.output_tokens) > body.max_output_tokens ? 'incomplete' : 'completed', ...accountingResponse(),
          diagnostics: { ...diagnostics },
          output: [{ type: 'message', content: [{ type: 'output_text', text: finalText }] }] });
      });
      child.stdin.end(`${body.instructions}\n\nReturn only the checkpoint JSON. Do not use tools or read local files.\n\n${body.input}`);
    });
  } catch (err) {
    if (!spawned) throw Object.assign(err?.[ownError] ? err : error('Codex memory setup failed.', 'memory-worker-setup-failed', diagnostics, true), { dispatched: false });
    throw err;
  } finally {
    // Local cleanup must not erase already-reported provider usage.
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch { console.warn('[memory] Could not remove the temporary Codex schema directory.'); }
  }
}
