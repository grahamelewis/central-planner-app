#!/usr/bin/env node
// Explicit opt-in CLI. A normal test/build never installs packages or activates
// a release; installation and activation are separate operations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, verifyRelease } from '../lib/release.js';

const args = process.argv.slice(2);
const command = args.shift();
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const flag = name => {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
};
try {
  if (command === 'build') {
    const sourceRoot = option('--source') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const destination = option('--out');
    const installDependencies = flag('--install');
    if (!destination || args.length) throw new Error('Usage: release.mjs build --out <fresh-directory> [--source <repository>] [--install]');
    const result = await buildRelease({ sourceRoot, destination, installDependencies });
    console.log(JSON.stringify({ root: result.root, files: result.metadata.files.length, dependenciesInstalled: result.metadata.dependenciesInstalled }));
  } else if (command === 'verify') {
    const requireDependencies = flag('--require-dependencies');
    if (args.length !== 1) throw new Error('Usage: release.mjs verify <release-directory> [--require-dependencies]');
    const result = verifyRelease({ root: args[0], requireDependencies });
    console.log(JSON.stringify({ verified: true, files: result.files.length, dependenciesInstalled: result.dependenciesInstalled }));
  } else throw new Error('Expected build or verify command');
} catch (error) {
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
}
