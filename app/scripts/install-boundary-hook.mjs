#!/usr/bin/env node
// Explicit opt-in only: never a prepare/postinstall hook. Production npm ci
// must not configure Git or install developer tooling.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRE_COMMIT = '#!/bin/sh\nset -eu\nrepo_root=$(git rev-parse --show-toplevel)\ncd "$repo_root"\nexec node app/scripts/check-boundary.mjs\n';

export function installBoundaryHook({ cwd = process.cwd() } = {}) {
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const root = git(['rev-parse', '--show-toplevel']);
  let configured = '';
  try { configured = git(['config', '--get', 'core.hooksPath']); }
  catch (error) { if (error.status !== 1) throw error; }
  if (configured && configured !== '.githooks') throw new Error('Existing core.hooksPath is configured; refusing to replace another hook setup');
  const common = git(['rev-parse', '--git-common-dir']);
  const defaults = path.resolve(cwd, common, 'hooks');
  if (fs.existsSync(defaults)) {
    const active = fs.readdirSync(defaults).filter(name => !name.endsWith('.sample') && !name.startsWith('.'));
    if (active.length) throw new Error('Existing non-sample Git hooks found; refusing to bypass them');
  }
  const directory = path.join(root, '.githooks');
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw new Error('Versioned hook directory must be ordinary');
  if (fs.readdirSync(directory).some(name => name !== 'pre-commit')) throw new Error('Unexpected versioned hooks; refusing to enable them');
  const hook = path.join(directory, 'pre-commit');
  const stat = fs.lstatSync(hook);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(hook, 'utf8') !== PRE_COMMIT) throw new Error('Versioned pre-commit hook is missing or changed');
  const guard = fs.lstatSync(path.join(root, 'app/scripts/check-boundary.mjs'));
  if (!guard.isFile() || guard.isSymbolicLink()) throw new Error('Repository boundary guard is missing or changed');
  fs.chmodSync(hook, 0o755);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  return { root, hooksPath: '.githooks' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = installBoundaryHook();
    console.log(`Boundary pre-commit hook enabled in ${result.root}. CI remains the backstop.`);
  } catch (error) {
    console.error(`Hook installation refused: ${error.message}`);
    process.exitCode = 1;
  }
}
