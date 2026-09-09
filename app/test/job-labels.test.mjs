import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractFunction } from './helpers.mjs';

const source = new URL('../public/jobs.js', import.meta.url);
const src = fs.readFileSync(source, 'utf8');
const identity = src.match(/export const sameJobRun = [\s\S]*?;/)[0].replace(/^export /, '');
const bodies = ['jobTitle', 'shouldAcceptJobSnapshot'].map(name => extractFunction(source, name)).join('\n');
const { jobTitle, sameJobRun, shouldAcceptJobSnapshot } = new Function(`${identity}\n${bodies}\nreturn {jobTitle,sameJobRun,shouldAcceptJobSnapshot};`)();

test('the exact legacy /Users/gra excerpt is an inline program, never a basename', () => {
  const file = '/bin/zsh -lc \'JULIA_DEPOT_PATH="$PWD/.julia_depot:/Users/gra';
  assert.equal(file.length, 60);
  assert.deepEqual(jobTitle({ lang: 'julia', inline: true, file }), {
    name: 'inline Julia', tooltip: `Recorded inline label/command excerpt: ${file}`,
  });
});

test('inline labels retain slash arithmetic, URLs, paths, and Unicode', () => {
  for (const lang of ['julia', 'r', 'python', 'node', 'shell', 'sql']) {
    for (const displayTitle of ['Fit φ/Φ at pe=0.5', 'Inspect https://example.org/a/b', 'Read /tmp/research/data', 'Compare costs / benefits']) {
      assert.equal(jobTitle({ lang, inline: true, titleKind: 'label', displayTitle }).name, displayTitle);
    }
  }
});

test('explicit real files shorten across every supported language and retain full tooltips', () => {
  for (const [lang, ext] of [['julia','jl'],['r','R'],['python','py'],['node','js'],['node','ts'],['rust','rs'],['go','go'],['c','c'],['cpp','cpp'],['shell','sh'],['sql','sql'],['notebook','ipynb']]) {
    const file = `nested/research files/model.${ext}`;
    const actual = jobTitle({ lang, titleKind: 'file', displayTitle: file, file });
    assert.equal(actual.name, `model.${ext}`);
    assert.equal(actual.tooltip, file);
  }
  assert.equal(jobTitle({ titleKind: 'file', file: 'some/tests/' }).name, 'tests/');
});

test('generated launcher labels are not paths, including legacy launcher records', () => {
  for (const displayTitle of ['package (npm run bench/solve)', 'crate (cargo test)', 'pkg (go test)', 'src (make build/foo)', 'src (cmake --build)']) {
    assert.equal(jobTitle({ titleKind: 'label', displayTitle, file: null }).name, displayTitle);
    assert.equal(jobTitle({ file: displayTitle, inline: false }).name, displayTitle);
  }
});

test('a command-only legacy record is not split into a false file', () => {
  const command = 'cd /Users/person/project && julia -e "println(1/2)"';
  assert.deepEqual(jobTitle({ command }), { name: command, tooltip: command });
  assert.equal(jobTitle({ inline: true, lang: 'python', command }).name, 'inline Python');
  assert.equal(jobTitle({ inline: true, lang: 'python', command }).tooltip, command);
});

test('immutable run identity takes precedence over mutable legacy start timestamps', () => {
  const a = { key: 'run:alpha', jobRunId: 'invocation-a', startedAt: '2026-09-09T12:00:00Z' };
  assert.equal(sameJobRun(a, { ...a, startedAt: '2026-09-09T12:01:00Z' }), true);
  assert.equal(sameJobRun(a, { ...a, jobRunId: 'invocation-b' }), false);
  assert.equal(sameJobRun(a, { ...a, key: 'run:beta' }), false);
  const old = { key: a.key, startedAt: a.startedAt };
  assert.equal(sameJobRun(old, { ...old }), true);
  assert.equal(sameJobRun(old, { ...old, startedAt: 'other' }), false);
  assert.equal(sameJobRun({ key: 'x' }, { key: 'x' }), false);
});

test('settled invocations reject running replays, but genuine replacement runs pass', () => {
  for (const state of ['done', 'error', 'stopped']) {
    const old = { key: 'run:alpha', jobRunId: 'a', startedAt: 't0', state };
    assert.equal(shouldAcceptJobSnapshot(old, { ...old, state: 'running' }), false);
    assert.equal(shouldAcceptJobSnapshot(old, { ...old, state: 'running', startedAt: 't1' }), false);
    assert.equal(shouldAcceptJobSnapshot(old, { ...old, state: 'running', jobRunId: 'b' }), true);
    assert.equal(shouldAcceptJobSnapshot(old, { ...old }), true);
    assert.equal(shouldAcceptJobSnapshot({ ...old, jobRunId: undefined }, { ...old, jobRunId: undefined, state: 'running' }), false);
  }
});

test('late snapshots cannot replace a newer invocation in a reused project-run slot', () => {
  const current = { key: 'run:alpha', jobRunId: 'b', createdAt: '2026-09-09T12:01:00Z', state: 'running' };
  for (const state of ['running', 'done', 'error', 'stopped']) {
    assert.equal(shouldAcceptJobSnapshot(current, { ...current, jobRunId: 'a', createdAt: '2026-09-09T12:00:00Z', state }), false);
    assert.equal(shouldAcceptJobSnapshot(current, { ...current, jobRunId: 'c', createdAt: '2026-09-09T12:02:00Z', state }), true);
  }
  // Ties/missing metadata are not evidence of age. Do not invent ordering.
  assert.equal(shouldAcceptJobSnapshot(current, { ...current, jobRunId: 'c' }), true);
  assert.equal(shouldAcceptJobSnapshot(current, { ...current, jobRunId: 'c', createdAt: undefined }), true);
  assert.equal(shouldAcceptJobSnapshot(current, { ...current, key: 'run:beta', jobRunId: 'a', createdAt: '2026-09-09T12:00:00Z' }), true);
});
