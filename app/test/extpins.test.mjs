// lib/extpins.js — external context pins → additionalDirectories. The security
// invariant is the point: ONLY explicitly-pinned paths outside the root grant
// access; internal pins, non-existent paths, and unpinned outside paths never
// do. Imports the module directly (no SDK), so it runs billing-safe.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExternalPin, externalDirsFor, externalPinLines, isPathGranted } from '../lib/extpins.js';
import { PROJECTS } from '../lib/config.js';

let root, projRoot, outside, outsideFile, outsideDir;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'extpin-test-')));
  projRoot = path.join(root, 'proj');
  outside = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(projRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(projRoot, 'sub', 'in.jl'), '# in root\n');
  fs.mkdirSync(path.join(outside, 'lit'), { recursive: true });
  outsideFile = path.join(outside, 'paper.tex');   // an external FILE
  outsideDir = path.join(outside, 'lit');           // an external FOLDER
  fs.writeFileSync(outsideFile, '\\documentclass{article}\n');
  fs.writeFileSync(path.join(outsideDir, 'notes.md'), '# notes\n');
  PROJECTS.ext = { name: 'ext', root: projRoot, color: '#fff', texWatch: null };
});
after(() => {
  delete PROJECTS.ext;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe('isExternalPin', () => {
  test('an absolute path OUTSIDE the root that exists → external', () => {
    assert.equal(isExternalPin('ext', outsideFile), true);
    assert.equal(isExternalPin('ext', outsideDir + '/'), true); // folder pin w/ trailing slash
  });
  test('a project-relative pin → NOT external', () => {
    assert.equal(isExternalPin('ext', 'sub/in.jl'), false);
  });
  test('an absolute path INSIDE the root → NOT external (still internal)', () => {
    assert.equal(isExternalPin('ext', path.join(projRoot, 'sub', 'in.jl')), false);
  });
  test('an outside path that does NOT exist → NOT external (never granted)', () => {
    assert.equal(isExternalPin('ext', path.join(outside, 'ghost.txt')), false);
  });
  test('junk / unknown project → false, never throws', () => {
    assert.equal(isExternalPin('ext', ''), false);
    assert.equal(isExternalPin('ext', null), false);
    assert.equal(isExternalPin('nope', outsideFile), false);
  });
});

describe('externalDirsFor — the allowlist', () => {
  test('a file pin grants its PARENT dir; a folder pin grants the folder', () => {
    const dirs = externalDirsFor('ext', [outsideFile, outsideDir + '/']);
    assert.equal(dirs.length, 2);
    assert.ok(dirs.includes(fs.realpathSync(outside)), 'file → parent dir');
    assert.ok(dirs.includes(fs.realpathSync(outsideDir)), 'folder → itself');
  });
  test('internal pins contribute NOTHING (the invariant)', () => {
    assert.deepEqual(externalDirsFor('ext', ['sub/in.jl', path.join(projRoot, 'sub', 'in.jl')]), []);
  });
  test('non-existent outside paths contribute nothing', () => {
    assert.deepEqual(externalDirsFor('ext', [path.join(outside, 'ghost.txt')]), []);
  });
  test('two file pins in the same dir dedupe to one grant', () => {
    fs.writeFileSync(path.join(outside, 'paper2.tex'), 'x\n');
    const dirs = externalDirsFor('ext', [outsideFile, path.join(outside, 'paper2.tex')]);
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0], fs.realpathSync(outside));
  });
  test('empty / missing files → []', () => {
    assert.deepEqual(externalDirsFor('ext', []), []);
    assert.deepEqual(externalDirsFor('ext', undefined), []);
  });
});

describe('externalPinLines', () => {
  test('lists only the external pins as pointers', () => {
    const lines = externalPinLines('ext', ['sub/in.jl', outsideFile, outsideDir + '/']);
    assert.deepEqual(lines, [`- ${outsideFile}`, `- ${outsideDir}/`]);
  });
});

describe('isPathGranted — the browse/read allowlist', () => {
  const files = () => [outsideDir + '/']; // one external FOLDER pin granted
  test('a file INSIDE a granted folder → allowed', () => {
    assert.equal(isPathGranted('ext', files(), path.join(outsideDir, 'notes.md')), true);
  });
  test('the granted folder itself → allowed', () => {
    assert.equal(isPathGranted('ext', files(), outsideDir), true);
  });
  test('a sibling OUTSIDE the granted folder → denied', () => {
    assert.equal(isPathGranted('ext', files(), outsideFile), false); // outside/paper.tex, not in outside/lit
  });
  test('a file-pin grant covers its parent dir (dir-scoped), incl. siblings', () => {
    // pinning outside/paper.tex grants outside/ — so outside/notes-sibling is reachable
    fs.writeFileSync(path.join(outside, 'sibling.txt'), 'x\n');
    assert.equal(isPathGranted('ext', [outsideFile], path.join(outside, 'sibling.txt')), true);
  });
  test('nothing granted / junk → denied, never throws', () => {
    assert.equal(isPathGranted('ext', [], outsideFile), false);
    assert.equal(isPathGranted('ext', files(), '/etc/passwd'), false);
    assert.equal(isPathGranted('ext', files(), ''), false);
    assert.equal(isPathGranted('ext', files(), null), false);
  });
});
