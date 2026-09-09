// A production release is an explicit file inventory, never a filtered copy of
// the working tree. This module has only Node dependencies so staging itself
// cannot start the server, probe providers, or touch dashboard state.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MANIFEST_FILE = 'release-manifest.json';
export const METADATA_FILE = 'release.json';
const REQUIRED = ['LICENSE', 'categories.example.json', 'config.example.json',
  'app/package.json', 'app/package-lock.json', 'app/server.js',
  'app/public/index.html', 'app/public/m/index.html'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Invalid release path: ${JSON.stringify(value)}`);
  }
  return value;
}

// Additional hard stops protect state and development output even if somebody
// accidentally adds them while updating the reviewed manifest.
function forbidden(file) {
  const parts = file.split('/');
  return parts.some(p => p.startsWith('.') || /^(?:node_modules|test|tests|fixtures|harnesses|experiments|research|mockups|screenshots|renders|test-results|playwright-report|coverage|docs)$/.test(p) || p.endsWith('-mockups'))
    || /(?:\.test\.[^.]+|\.d\.ts|\.log|\.tmp|\.bak)$/.test(file)
    || /^(?:tasks|ledger|snapshots|transcripts|memory|abstracts|decisions|plan|runs)\//.test(file)
    || ['config.json', 'profile.json', 'categories.json', 'jobhist.json', METADATA_FILE, MANIFEST_FILE].includes(file);
}

export function readReleaseManifest(sourceRoot) {
  const root = existingDirectory(sourceRoot);
  const bytes = readRegular(root, MANIFEST_FILE);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Invalid release manifest schema');
  }
  const files = manifest.files.map(relativeFile);
  if (new Set(files).size !== files.length) throw new Error('Duplicate release manifest path');
  for (const file of files) if (forbidden(file)) throw new Error(`Development/private file forbidden in release: ${file}`);
  for (const file of REQUIRED) if (!files.includes(file)) throw new Error(`Required release file missing from manifest: ${file}`);
  return { manifest: { schemaVersion: 1, files: [...files].sort() }, bytes };
}

function existingDirectory(value) {
  if (typeof value !== 'string' || !value) throw new Error('An explicit directory is required');
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a regular directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function readRegular(root, relative) {
  let cursor = root;
  const parts = relativeFile(relative).split('/');
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Release source must be a regular file without symlinks: ${relative}`);
    }
  }
  const fd = fs.openSync(cursor, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function resolveFreshDestination(source, destination, protectedRoots) {
  if (typeof destination !== 'string' || !destination) throw new Error('An explicit fresh destination is required');
  const requested = path.resolve(destination);
  // Requiring an existing parent avoids creating broad or unintended trees.
  const parent = existingDirectory(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (inside(source, target) || inside(target, source)) throw new Error('Release destination must not overlap the source tree');
  for (const value of protectedRoots) {
    const protectedRoot = existingDirectory(value);
    if (inside(protectedRoot, target) || inside(target, protectedRoot)) throw new Error('Release destination overlaps a protected data root');
  }
  if (fs.existsSync(target)) throw new Error('Release destination already exists; refusing overwrite');
  // mkdir below is deliberately not recursive and also rejects dangling links.
  return target;
}

function checkReferences(root, files) {
  const present = new Set(files);
  const requireFile = (from, ref, web = false) => {
    if (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref)) return;
    const clean = ref.split(/[?#]/)[0];
    if (!clean) return;
    if (!web && !clean.startsWith('.')) return; // npm or Node built-in
    const target = web && clean.startsWith('/')
      ? path.posix.join('app/public', clean.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
    if (!present.has(target)) throw new Error(`Missing release dependency: ${from} -> ${ref}`);
  };
  for (const file of files) {
    if (/\.(?:js|mjs)$/.test(file)) {
      const source = readRegular(root, file).toString('utf8');
      // Literal static imports, re-exports and dynamic imports. Computed imports
      // and route-generated URLs still require smoke tests of the staged build.
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"\n]+)['"]/g)) {
        requireFile(file, match[1]);
      }
    } else if (/\.html$/.test(file)) {
      const source = readRegular(root, file).toString('utf8');
      for (const match of source.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi)) {
        requireFile(file, match[1], true);
      }
    } else if (/\.webmanifest$/.test(file)) {
      const data = JSON.parse(readRegular(root, file).toString('utf8'));
      for (const icon of data.icons || []) requireFile(file, icon.src, true);
    }
  }
}

function inventory(root, files) {
  return [...files].sort().map(file => {
    const bytes = readRegular(root, file);
    return { path: file, size: bytes.length, sha256: hash(bytes) };
  });
}

function walkPayload(root, allowedDirectories, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in release payload: ${rel}`);
    if (rel === 'app/node_modules') {
      if (!entry.isDirectory()) throw new Error('node_modules must be a directory');
      continue;
    }
    if (entry.isDirectory()) {
      if (!allowedDirectories.has(rel)) throw new Error(`Unapproved release directory: ${rel}`);
      result.push(...walkPayload(root, allowedDirectories, rel));
    }
    else if (entry.isFile()) result.push(rel);
    else throw new Error(`Non-regular release entry: ${rel}`);
  }
  return result.sort();
}

function verifyDependencies(root) {
  const modules = path.join(root, 'app/node_modules');
  if (!fs.existsSync(modules) || fs.lstatSync(modules).isSymbolicLink()) throw new Error('Production dependencies are not installed');
  const pkg = JSON.parse(readRegular(root, 'app/package.json').toString('utf8'));
  const lock = JSON.parse(readRegular(root, 'app/package-lock.json').toString('utf8'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    const file = `app/node_modules/${name}/package.json`;
    const installed = JSON.parse(readRegular(root, file).toString('utf8'));
    const expected = lock.packages?.[`node_modules/${name}`];
    if (installed.name !== name || (expected?.version && installed.version !== expected.version)) {
      throw new Error(`Production dependency does not match lockfile: ${name}`);
    }
  }
  // npm's lockfile knows whether a package is development-only; checking merely
  // devDependencies by name would incorrectly reject legitimate shared/transitive
  // runtime dependencies. Omitted dev-only packages must not appear in the stage.
  for (const [file, info] of Object.entries(lock.packages || {})) {
    if (!file || info.dev !== true || !file.startsWith('node_modules/')) continue;
    relativeFile(file);
    if (fs.existsSync(path.join(root, 'app', file))) throw new Error(`Development-only dependency present: ${file}`);
  }
  // These dynamically served assets are not discoverable through JS imports.
  for (const file of ['app/node_modules/pdfjs-dist/build/pdf.mjs',
    'app/node_modules/pdfjs-dist/build/pdf.worker.mjs', 'app/node_modules/monaco-editor/min/vs/loader.js']) {
    readRegular(root, file);
  }
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(modules, fs.realpathSync(full))) throw new Error('Dependency symlink escapes node_modules');
      } else if (entry.isDirectory()) walk(full);
      else if (!entry.isFile()) throw new Error('Non-regular dependency entry');
    }
  };
  walk(modules);
}

/** Verify a completed stage without importing or running its application. */
export function verifyRelease({ root, requireDependencies = false } = {}) {
  root = existingDirectory(root);
  const { manifest } = readReleaseManifest(root);
  const metadata = JSON.parse(readRegular(root, METADATA_FILE).toString('utf8'));
  if (metadata.schemaVersion !== 1 || typeof metadata.dependenciesInstalled !== 'boolean' || !Array.isArray(metadata.files)
      || (metadata.sourceRevision !== null && (typeof metadata.sourceRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(metadata.sourceRevision)))) {
    throw new Error('Invalid release metadata');
  }
  const expected = [...manifest.files, MANIFEST_FILE].sort();
  const allowedDirectories = new Set();
  for (const file of expected) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) allowedDirectories.add(parts.slice(0, i).join('/'));
  }
  const payload = walkPayload(root, allowedDirectories).filter(file => file !== METADATA_FILE);
  if (JSON.stringify(payload) !== JSON.stringify(expected)) throw new Error('Release contains missing or unapproved files');
  const actual = inventory(root, expected);
  if (JSON.stringify(actual) !== JSON.stringify(metadata.files)) throw new Error('Release integrity check failed');
  checkReferences(root, manifest.files);
  if (requireDependencies && !metadata.dependenciesInstalled) throw new Error('Release is not production-ready: dependencies were not installed');
  if (metadata.dependenciesInstalled || requireDependencies) verifyDependencies(root);
  else if (fs.existsSync(path.join(root, 'app/node_modules'))) throw new Error('Unexpected node_modules in an uninstalled release');
  return metadata;
}

/** Stage into a NEW sibling/external directory. Failure never changes the source
 * or removes the stage: an incomplete directory has no valid release metadata. */
export async function buildRelease({ sourceRoot, destination, installDependencies = false,
  installer, protectedRoots = [], sourceRevision = null } = {}) {
  if (sourceRevision !== null && (typeof sourceRevision !== 'string' || !/^[a-f0-9]{40,64}$/.test(sourceRevision))) {
    throw new Error('Invalid source revision');
  }
  const source = existingDirectory(sourceRoot);
  const target = resolveFreshDestination(source, destination, protectedRoots);
  const { manifest, bytes: manifestBytes } = readReleaseManifest(source);
  // Validate everything before creating the destination or invoking npm.
  const files = manifest.files.map(file => ({ file, bytes: readRegular(source, file) }));
  checkReferences(source, manifest.files);
  fs.mkdirSync(target);
  for (const { file, bytes } of files) {
    const out = path.join(target, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes, { flag: 'wx', mode: 0o644 });
  }
  fs.writeFileSync(path.join(target, MANIFEST_FILE), manifestBytes, { flag: 'wx' });
  const originalInventory = inventory(target, [...manifest.files, MANIFEST_FILE]);
  if (installDependencies) {
    const request = { command: 'npm', args: ['ci', '--omit=dev', '--no-audit', '--no-fund'], cwd: path.join(target, 'app') };
    if (installer) await installer(request);
    else await execFileAsync(request.command, request.args, { cwd: request.cwd, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    verifyDependencies(target);
  }
  if (JSON.stringify(originalInventory) !== JSON.stringify(inventory(target, [...manifest.files, MANIFEST_FILE]))) {
    throw new Error('Dependency installation changed reviewed release files');
  }
  const metadata = { schemaVersion: 1, sourceRevision, dependenciesInstalled: Boolean(installDependencies),
    files: originalInventory };
  fs.writeFileSync(path.join(target, METADATA_FILE), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  verifyRelease({ root: target, requireDependencies: installDependencies });
  return { root: target, manifest, metadata };
}
