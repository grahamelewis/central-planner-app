// Production installations contain immutable releases, not a development Git
// checkout. Activation changes one pointer; neither install nor rollback writes
// to the separately configured data root. Failed stages are retained for review.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildRelease, verifyRelease } from './release.js';

const OWNER = '.central-planner-installation.json';
const ID = /^release-[0-9a-f-]{36}$/;
const inside = (a, b) => a === b || a.startsWith(b + path.sep);

function canonical(file) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  return path.join(canonical(path.dirname(resolved)), path.basename(resolved));
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function ordinary(file, directory = false) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) throw new Error(`Not an ordinary ${directory ? 'directory' : 'file'}: ${file}`);
}
function owner(root) {
  ordinary(root, true); ordinary(path.join(root, OWNER));
  const record = json(path.join(root, OWNER));
  if (record.version !== 1 || record.installationRoot !== canonical(root)
    || typeof record.sourceRoot !== 'string' || !path.isAbsolute(record.sourceRoot)
    || typeof record.dataRoot !== 'string' || !path.isAbsolute(record.dataRoot)) throw new Error('Invalid installation ownership record');
  ordinary(record.dataRoot, true);
  if (canonical(record.dataRoot) !== record.dataRoot) throw new Error('Installation data root was redirected');
  return record;
}
export function readDeployment(installationRoot) {
  const root = canonical(installationRoot), record = owner(root);
  const file = path.join(root, 'deployment.json'); ordinary(file);
  const config = json(file);
  if (config.version !== 1 || config.sourceRoot !== record.sourceRoot || config.dataRoot !== record.dataRoot
    || !ID.test(config.active) || (config.previous !== null && !ID.test(config.previous))
    || (config.sourceRevision !== null && !/^[0-9a-f]{40,64}$/.test(config.sourceRevision))) throw new Error('Invalid deployment pointer');
  const releases = path.join(root, 'releases'); ordinary(releases, true);
  const releaseRoot = path.join(releases, config.active); ordinary(releaseRoot, true);
  return { ...config, installationRoot: root, releaseRoot };
}

// Stable, tiny entry point understood by the existing desktop locator. It is
// deliberately not a copy of the dashboard and never searches development dirs.
const LAUNCHER = `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function regular(file, dir = false) { const s = fs.lstatSync(file); if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile())) throw new Error('Invalid installation path'); }
regular(path.join(root, 'deployment.json')); regular(path.join(root, '${OWNER}'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'deployment.json'), 'utf8'));
const ownership = JSON.parse(fs.readFileSync(path.join(root, '${OWNER}'), 'utf8'));
if (cfg.version !== 1 || ownership.version !== 1 || ownership.installationRoot !== fs.realpathSync(root) || cfg.dataRoot !== ownership.dataRoot || cfg.sourceRoot !== ownership.sourceRoot || !/^release-[0-9a-f-]{36}$/.test(cfg.active) || !path.isAbsolute(cfg.dataRoot || '')) throw new Error('Invalid production deployment');
regular(cfg.dataRoot, true);
if (fs.realpathSync(cfg.dataRoot) !== cfg.dataRoot) throw new Error('Installation data root was redirected');
const releaseRoot = path.join(root, 'releases', cfg.active);
for (const p of ['releases', 'releases/' + cfg.active, 'releases/' + cfg.active + '/app', 'releases/' + cfg.active + '/app/lib']) regular(path.join(root, p), true);
regular(path.join(releaseRoot, 'release.json')); regular(path.join(releaseRoot, 'app/package.json'));
const verifier = path.join(releaseRoot, 'app/lib/release.js'); regular(verifier);
const meta = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'release.json'), 'utf8'));
for (const rel of ['app/lib/release.js', 'app/package.json']) {
  const expected = meta.files?.find(f => f.path === rel)?.sha256;
  if (!expected || createHash('sha256').update(fs.readFileSync(path.join(releaseRoot, rel))).digest('hex') !== expected) throw new Error('Release bootstrap integrity failed');
}
const { verifyRelease } = await import(pathToFileURL(verifier).href);
verifyRelease({ root: releaseRoot, requireDependencies: true });
process.env.CP_ROOT = cfg.dataRoot;
process.env.CP_INSTALLATION_ROOT = root;
await import(pathToFileURL(path.join(releaseRoot, 'app/server.js')).href);
`;
function bootstrap(root) {
  const app = path.join(root, 'app');
  if (!fs.existsSync(app)) fs.mkdirSync(app);
  ordinary(app, true);
  const files = { 'server.js': LAUNCHER, 'package.json': JSON.stringify({ name: 'central-planner-installation', private: true, type: 'module', scripts: { start: 'node server.js' } }, null, 2) + '\n' };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(app, name);
    if (fs.existsSync(file)) {
      ordinary(file);
      if (fs.readFileSync(file, 'utf8') !== content) throw new Error(`Installation launcher was changed: ${name}`);
    } else fs.writeFileSync(file, content, { flag: 'wx' });
  }
}
function locked(root, action) {
  const lock = path.join(root, '.deployment.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  return Promise.resolve().then(action).finally(() => { fs.closeSync(fd); fs.unlinkSync(lock); });
}

export function assertCleanSource(sourceRoot) {
  const run = args => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (canonical(run(['rev-parse', '--show-toplevel'])) !== canonical(sourceRoot)) throw new Error('Source must be the repository root');
  if (run(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Commit reviewed source changes before deploying; source checkout must be clean');
  return run(['rev-parse', 'HEAD']);
}

export async function deployRelease({ sourceRoot, installationRoot, dataRoot, installer, sourceRevision = null, requireClean = true }) {
  if (![sourceRoot, installationRoot, dataRoot].every(v => typeof v === 'string' && path.isAbsolute(v))) throw new Error('Source, installation, and data roots must be explicit absolute paths');
  const source = canonical(sourceRoot), root = canonical(installationRoot), data = canonical(dataRoot);
  ordinary(source, true); ordinary(data, true);
  if (root === path.parse(root).root || [source, data].some(p => inside(root, p) || inside(p, root))) throw new Error('Installation must be separate from source and data roots');
  const revision = requireClean ? assertCleanSource(source) : sourceRevision;
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, OWNER), JSON.stringify({ version: 1, installationRoot: root, sourceRoot: source, dataRoot: data }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const record = owner(root);
  if (record.sourceRoot !== source || record.dataRoot !== data) throw new Error('Installation source/data roots cannot be changed by an update');
  return locked(root, async () => {
    const current = fs.existsSync(path.join(root, 'deployment.json')) ? readDeployment(root) : null;
    bootstrap(root);
    const releases = path.join(root, 'releases');
    if (!fs.existsSync(releases)) fs.mkdirSync(releases);
    ordinary(releases, true);
    const active = `release-${randomUUID()}`, destination = path.join(releases, active);
    await buildRelease({ sourceRoot: source, destination, installDependencies: true, installer, sourceRevision: revision, protectedRoots: [data] });
    verifyRelease({ root: destination, requireDependencies: true });
    // Refuse source edits during a real build/install; the active pointer stays.
    if (requireClean && assertCleanSource(source) !== revision) throw new Error('Source changed while staging release');
    const next = { version: 1, sourceRoot: source, dataRoot: data, active, previous: current?.active || null,
      sourceRevision: revision, activatedAt: new Date().toISOString() };
    atomic(path.join(root, 'deployment.json'), next);
    return { ...next, installationRoot: root, releaseRoot: destination, needsRestart: true };
  });
}

export async function rollbackRelease(installationRoot) {
  const root = canonical(installationRoot); owner(root);
  return locked(root, async () => {
    const current = readDeployment(root);
    if (!current.previous) throw new Error('No previous release is available');
    const target = path.join(root, 'releases', current.previous); ordinary(target, true);
    const metadata = verifyRelease({ root: target, requireDependencies: true });
    const next = { version: 1, sourceRoot: current.sourceRoot, dataRoot: current.dataRoot,
      active: current.previous, previous: current.active, sourceRevision: metadata.sourceRevision || null, activatedAt: new Date().toISOString() };
    atomic(path.join(root, 'deployment.json'), next);
    return { ...next, needsRestart: true };
  });
}
