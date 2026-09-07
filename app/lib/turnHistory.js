// Provider history restoration is distinct from stopping execution. Neither
// branch operation reverses files, external actions, usage, or detached jobs.
import { turnError } from './turnRecall.js';

export async function captureCodexBoundary(threadId, client) {
  const rows = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.request('thread/turns/list', {
      threadId, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page?.data)) throw turnError(409, 'Codex cannot verify paginated history on this installation');
    for (const row of page.data) {
      if (!row?.id || row.status === 'inProgress' || !Array.isArray(row.items)) {
        throw turnError(409, 'Codex history contains an unverified or active turn');
      }
      rows.push({ id: row.id, status: row.status, items: row.items });
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw turnError(409, 'Codex history pagination did not advance');
    cursors.add(cursor);
    if (rows.length > 5000) throw turnError(409, 'Codex history is too large to verify safely for Stop & Edit');
  } while (cursor);
  return rows;
}

export async function readClaudeEntries(sessionId, dir, importer) {
  const entries = [];
  await importer(sessionId, {
    append: async (_key, rows) => { entries.push(...rows); }, load: async () => null,
  }, { dir, includeSubagents: false });
  return entries;
}

const chainRows = entries => entries.filter(row => row?.uuid && !row.isSidechain
  && ['user', 'assistant', 'system', 'attachment'].includes(row.type)
  && Object.prototype.hasOwnProperty.call(row, 'parentUuid'));

export async function captureClaudeBoundary(sessionId, dir, readMessages, importEntries) {
  if (!sessionId) return { sessionId: null, empty: true };
  const messages = await readMessages(sessionId, { dir, includeSystemMessages: true });
  const last = messages.at(-1);
  // The SDK reader omits non-message chain attachments. Conservatively accept
  // only a normal final assistant text boundary, not a tool-result/end-turn
  // tool or compaction boundary whose retained tail needs a richer reader.
  if (!last?.uuid || last.type !== 'assistant' || !Array.isArray(last.message?.content)
      || !last.message.content.length || last.message.content.some(b => b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking')) {
    throw turnError(409, 'this Claude session has no verified final-message boundary for Stop & Edit');
  }
  let chain;
  if (importEntries) {
    chain = chainRows(await readClaudeEntries(sessionId, dir, importEntries));
    if (!chain.length || chain.at(-1).uuid !== last.uuid) {
      throw turnError(409, 'Claude history has additional chain entries after its final message; the exchange was kept');
    }
  }
  return { sessionId, uuid: last.uuid, messages, ...(chain ? { chainIds: chain.map(row => row.uuid) } : {}) };
}

function messageShape(rows) { return rows.map(r => ({ type: r.type, message: r.message })); }

export async function restoreTurnHistory(turn, { codex, forkClaude, readClaude, importClaude, dir }) {
  const p = turn.providerState;
  if (!p.dispatched) return { unchanged: true };
  if (turn.provider === 'codex') {
    if (!p.threadId || !p.turnId) throw turnError(409, 'Codex did not provide a verified turn boundary; the exchange was kept');
    if (!p.codexBoundary) throw turnError(409, p.boundaryError || 'Codex history boundary is unavailable; the exchange was kept');
    // Installed app-server schema: beforeTurnId excludes that turn and all
    // later turns. A fork preserves the original provider history as audit.
    const result = await codex.request('thread/fork', {
      threadId: p.threadId, beforeTurnId: p.turnId, ephemeral: false,
      historyMode: 'paginated', deferGoalContinuation: true,
    });
    const threadId = result?.thread?.id;
    if (!threadId || threadId === p.threadId) throw turnError(502, 'Codex did not confirm a separate restored thread; the exchange was kept');
    const retained = await captureCodexBoundary(threadId, codex);
    if (retained.some(row => row.id === p.turnId) || JSON.stringify(retained) !== JSON.stringify(p.codexBoundary)) {
      throw turnError(502, 'Codex fork did not preserve exactly the prior history; the exchange was kept');
    }
    return { provider: 'codex', threadId, restoredFrom: p.threadId };
  }
  const boundary = p.claudeBoundary;
  if (!boundary) throw turnError(409, p.boundaryError || 'Claude history boundary is unavailable; the exchange was kept');
  if (boundary.empty) return { provider: 'claude', sdkSessionId: null, restoredFrom: p.sessionId || null };
  const forked = await forkClaude(boundary.sessionId, { dir, upToMessageId: boundary.uuid });
  if (!forked?.sessionId || forked.sessionId === boundary.sessionId) {
    throw turnError(502, 'Claude did not confirm a separate restored session; the exchange was kept');
  }
  // SDK forks remap UUIDs. Verify actual retained message content, not IDs.
  const actual = await readClaude(forked.sessionId, { dir, includeSystemMessages: true });
  if (JSON.stringify(messageShape(actual)) !== JSON.stringify(messageShape(boundary.messages))) {
    throw turnError(502, 'Claude restored history did not match the saved boundary; the exchange was kept');
  }
  if (boundary.chainIds) {
    if (!importClaude) throw turnError(502, 'Claude full-chain verifier is unavailable; the exchange was kept');
    const restoredChain = chainRows(await readClaudeEntries(forked.sessionId, dir, importClaude));
    if (JSON.stringify(restoredChain.map(row => row.forkedFrom?.messageUuid)) !== JSON.stringify(boundary.chainIds)) {
      throw turnError(502, 'Claude fork did not preserve the full retained chain; the exchange was kept');
    }
  }
  return { provider: 'claude', sdkSessionId: forked.sessionId, restoredFrom: boundary.sessionId };
}
