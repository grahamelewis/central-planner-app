// Real installed SDK, isolated on-disk synthetic transcript; never query().
// JSONL fields/chain and CLAUDE_CONFIG_DIR/project override are read from the
// installed SDK reader/fork implementation, not copied from user sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('review: real Claude SDK forks an exact retained tool chain without withdrawn exchange', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sdk-recall-review-')));
  const config = path.join(root, 'claude-fixture');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const sdkUrl = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  const historyUrl = new URL('../lib/turnHistory.js', import.meta.url).href;
  const childSource = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { randomUUID } from 'node:crypto';
    globalThis.fetch = () => { throw new Error('Network/model calls forbidden in SDK fork review'); };
    const { getSessionMessages, forkSession, importSessionToStore } = await import(${JSON.stringify(sdkUrl)});
    const { captureClaudeBoundary, restoreTurnHistory } = await import(${JSON.stringify(historyUrl)});
    const dir = process.cwd();
    const config = process.env.CLAUDE_CONFIG_DIR;
    assert.equal(path.dirname(config), path.dirname(dir), 'isolated sibling fixture paths only');
    const projectDir = path.join(config, 'projects', 'recall-review');
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const rows = [];
    function add(type, message, extra = {}) {
      const row = { type, message, uuid: randomUUID(), parentUuid: rows.at(-1)?.uuid || null,
        sessionId, cwd: dir, isSidechain: false, timestamp: new Date().toISOString(), ...extra };
      rows.push(row);
      return row;
    }
    add('user', { role: 'user', content: 'Read the fixture and explain it.' });
    const tool = add('assistant', { role: 'assistant', id: 'msg-tool',
      content: [{ type: 'tool_use', id: 'tool-review', name: 'Read', input: { file_path: 'fixture.txt' } }] });
    add('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-review', content: 'Exact retained tool result' }] });
    const attachment = add('attachment', undefined, { attachment: {
      type: 'deferred_tools_record', nameOnlyAnnouncements: [tool.uuid],
    } });
    add('assistant', { role: 'assistant', id: 'msg-final', content: [{ type: 'text', text: 'Verified earlier answer.' }] });
    const sourcePath = path.join(projectDir, sessionId + '.jsonl');
    const serialize = () => rows.map(row => JSON.stringify(row)).join('\\n') + '\\n';
    fs.writeFileSync(sourcePath, serialize());
    const boundary = await captureClaudeBoundary(sessionId, dir, getSessionMessages, importSessionToStore);
    assert.equal(boundary.messages.length, 4, 'real reader follows the tool chain while omitting attachment');
    assert.equal(boundary.chainIds.length, 5, 'raw SDK importer keeps the attachment too');
    add('attachment', undefined, { attachment: {
      type: 'deferred_tools_record', nameOnlyAnnouncements: [tool.uuid],
    } });
    fs.writeFileSync(sourcePath, serialize());
    await assert.rejects(captureClaudeBoundary(sessionId, dir, getSessionMessages, importSessionToStore),
      /additional chain entries/, 'hidden post-final attachment must not be silently lost');
    rows.pop();
    add('user', { role: 'user', content: 'WITHDRAWN PROMPT' });
    add('assistant', { role: 'assistant', id: 'msg-withdrawn', content: [{ type: 'text', text: 'WITHDRAWN OUTPUT' }] });
    fs.writeFileSync(sourcePath, serialize());
    const original = fs.readFileSync(sourcePath, 'utf8');
    const restored = await restoreTurnHistory({ provider: 'claude', providerState: {
      dispatched: true, sessionId, claudeBoundary: boundary,
    } }, { forkClaude: forkSession, readClaude: getSessionMessages, importClaude: importSessionToStore, dir });
    assert.notEqual(restored.sdkSessionId, sessionId);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original, 'original provider audit is unchanged');
    const forkPath = path.join(projectDir, restored.sdkSessionId + '.jsonl');
    const forkText = fs.readFileSync(forkPath, 'utf8');
    assert.doesNotMatch(forkText, /WITHDRAWN/);
    const forkRows = forkText.trim().split('\\n').map(line => JSON.parse(line));
    const retained = forkRows.filter(row => ['user', 'assistant', 'attachment'].includes(row.type));
    assert.equal(retained.length, 5);
    assert.equal(retained[0].parentUuid, null);
    for (let index = 0; index < retained.length; index++) {
      const row = retained[index];
      assert.equal(row.sessionId, restored.sdkSessionId);
      assert.notEqual(row.uuid, rows[index].uuid);
      if (index) assert.equal(row.parentUuid, retained[index - 1].uuid);
    }
    const keptAttachment = retained.find(row => row.forkedFrom?.messageUuid === attachment.uuid);
    assert.deepEqual(keptAttachment.attachment.nameOnlyAnnouncements, [retained[1].uuid],
      'SDK remaps chain attachment references, not just user/assistant IDs');
    const messages = await getSessionMessages(restored.sdkSessionId, { dir, includeSystemMessages: true });
    assert.deepEqual(messages.map(row => ({ type: row.type, message: row.message })),
      boundary.messages.map(row => ({ type: row.type, message: row.message })));
    console.log('real SDK fixture prefix and raw attachment chain verified');
  `;
  const env = { ...process.env, CP_NO_BILLED: '1', CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PROJECT_DIR_NAME: 'recall-review' };
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_OPTIONS']) delete env[key];
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childSource],
      { cwd: project, env, timeout: 10000, maxBuffer: 100000 }).catch(err => {
        throw new Error(err.stderr || err.message);
      });
    assert.match(stdout, /raw attachment chain verified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
