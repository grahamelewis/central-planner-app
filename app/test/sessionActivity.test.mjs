import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createActivityTracker, toolActivityLabel } from '../lib/sessionActivity.js';

test('factual labels never expose input or guess unknown tools', () => {
  for (const [name, label] of [
    ['Read', 'Reading files'], ['Grep', 'Searching files'], ['Glob', 'Searching files'],
    ['Edit', 'Editing files'], ['fileChange', 'Editing files'], ['WebSearch', 'Searching web'],
    ['WebFetch', 'Reading a web page'], ['Agent', 'Working with agents'],
    ['collabAgentToolCall', 'Working with agents'], ['mcpToolCall', 'Using a tool'],
    ['secret/customTool', 'Using a tool'],
  ]) assert.equal(toolActivityLabel(name, { file_path: '/secret', description: 'Running tests' }), label);
});

test('test commands must be unequivocal; arbitrary shell and descriptions stay generic', () => {
  for (const command of ['npm test', 'npm run test', 'pnpm test -- --runInBand', 'node --test test/unit.mjs', 'pytest -q', 'cargo test', 'go test ./...']) {
    assert.equal(toolActivityLabel('Bash', { command }), 'Running tests', command);
  }
  for (const command of ['echo npm test', 'cat tests.txt', 'npm run test:maybe', 'npm test; deploy', 'npm test && echo done', 'npm test\nrelease', 'npm test $(deploy)', 'npm test > secrets', 'python script.py']) {
    assert.equal(toolActivityLabel('commandExecution', { command, description: 'Running tests' }), 'Running command', command);
  }
  assert.equal(toolActivityLabel('Bash'), 'Running command');
  assert.equal(toolActivityLabel('Bash', null), 'Running command');
});

test('concurrent tools retain exact lifetimes and publish only label changes', () => {
  const events = [];
  const tracker = createActivityTracker((activity) => events.push(activity));
  tracker.phase(false);
  tracker.start('a', 'Read');
  tracker.start('b', 'Read');
  tracker.start('b', 'Edit'); // duplicate item, not a new operation
  assert.deepEqual(events, [{ label: 'Reading files' }]);
  tracker.start('c', 'Edit');
  tracker.end('b'); // out-of-order completion doesn't replace the newest tool
  tracker.end('unknown');
  tracker.end('c');
  tracker.end('a');
  assert.deepEqual(events, [
    { label: 'Reading files' }, { label: 'Editing files' },
    { label: 'Reading files' }, { label: 'Working' },
  ]);
});

test('text phase is factual, reasoning remains Working, and tools take priority', () => {
  const events = [];
  const tracker = createActivityTracker((activity) => events.push(activity));
  tracker.phase(true);
  tracker.phase(true); // many text deltas cause only one broadcast
  tracker.phase(false);
  tracker.start('a', 'Bash', { command: 'npm test' });
  tracker.phase(true);
  tracker.end('a');
  assert.deepEqual(events.map((x) => x.label), [
    'Writing response', 'Working', 'Running tests', 'Writing response',
  ]);
});

test('clear is terminal, idempotent, and releases unresolved tool activity', () => {
  const events = [];
  const tracker = createActivityTracker((activity) => events.push(activity));
  tracker.start('a', 'Read');
  tracker.clear();
  tracker.clear();
  tracker.start('late', 'Edit');
  tracker.phase(true);
  tracker.end('a');
  assert.deepEqual(events, [{ label: 'Reading files' }, null]);
});

test('over-capacity tool events stay bounded and eventually settle', () => {
  const events = [];
  const tracker = createActivityTracker((activity) => events.push(activity), 2);
  tracker.start('a', 'Read');
  tracker.start('b', 'Edit');
  tracker.start('c', 'Bash');
  tracker.end('c');
  tracker.end('b');
  tracker.end('a');
  assert.equal(events.at(-1).label, 'Working');
});

test('provider adapters publish current-turn timestamps and clear both lifetimes', () => {
  const source = fs.readFileSync(new URL('../lib/sessions.js', import.meta.url), 'utf8');
  assert.equal((source.match(/entry\.turnStartedAt = ts;/g) || []).length, 2);
  assert.equal((source.match(/activity\.clear\(\);/g) || []).length, 2);
  assert.equal((source.match(/status: 'running', turnStartedAt: ts/g) || []).length, 2);
  assert.match(source, /if \(!msg\.parent_tool_use_id\) activity\.start\(block\.id, block\.name, block\.input\)/);
  assert.match(source, /if \(!msg\.parent_tool_use_id\) activity\.end\(block\.tool_use_id\)/);
  assert.match(source, /activity\.end\(item\.id\)/);
  assert.match(source, /turnStartedAt: status === 'running' \? turnStartedAt \|\| null : null/);
});
