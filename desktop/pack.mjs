// pack.mjs — packs the shell into dist/Central Planner.app (npm run pack).
//
// Signing is a deliberate explicit post-step (`codesign --force --deep --sign -`)
// rather than packager's osxSign: @electron/osx-sign throws "No identity found"
// on a keychain without a Developer ID, which would make packing machine-
// dependent — plain ad-hoc codesign is deterministic on any Mac. The re-sign is
// mandatory, not cosmetic: packager rewrites Info.plist and renames the
// executable, invalidating Electron's upstream ad-hoc seal, so without it the
// day-2 `codesign --verify --deep --strict` gate fails.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationDataRoot } from './serverlink.js';

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(DESKTOP, 'dist');
// Packager writes here first; same volume as dist/ so renameSync never crosses devices.
const PACK_TMP = path.join(DIST, '.pack');
const APP_NAME = 'Central Planner';
const BUNDLE_ID = 'com.centralplanner.desktop';

// Inverse allowlist: ONLY these enter Contents/Resources/app. node_modules,
// test/, dist/, BLUEPRINT*, this script, icon sources, contract docs — and any
// stray file that doesn't exist yet — stay out by construction.
const SHIP = new Set(['/package.json', '/main.js', '/serverlink.js', '/connecting.html']);

// A production fallback must point at the installation, not its source tree:
// losing the persisted desktop preference must not revive development code.
export function resolvePackOptions(args, { desktopRoot = DESKTOP } = {}) {
  let stage = false, serverRoot = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stage' && !stage) { stage = true; continue; }
    if (arg === '--server-root' && serverRoot === null && args[i + 1] && !args[i + 1].startsWith('--')) {
      serverRoot = args[++i]; continue;
    }
    throw new Error('Usage: node pack.mjs [--stage] [--server-root /absolute/installation]');
  }
  if (serverRoot === null) return { stage, serverRoot: path.resolve(desktopRoot, '..') };
  if (!path.isAbsolute(serverRoot)) throw new Error('--server-root must be an absolute production installation path');
  const ordinary = (file, directory = false) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Invalid production installation path: ${file}`);
  };
  ordinary(serverRoot, true);
  serverRoot = fs.realpathSync(serverRoot);
  if (!installationDataRoot(serverRoot)) throw new Error('--server-root must identify a configured production installation, not a source checkout');
  ordinary(path.join(serverRoot, 'app'), true);
  ordinary(path.join(serverRoot, 'app', 'server.js'));
  ordinary(path.join(serverRoot, 'app', 'package.json'));
  const active = JSON.parse(fs.readFileSync(path.join(serverRoot, 'deployment.json'), 'utf8')).active;
  for (const rel of ['releases', `releases/${active}`, `releases/${active}/app`]) ordinary(path.join(serverRoot, rel), true);
  for (const rel of [`releases/${active}/release.json`, `releases/${active}/app/server.js`, `releases/${active}/app/package.json`]) ordinary(path.join(serverRoot, rel));
  return { stage, serverRoot };
}

// icon_<pt>x<pt>[@2x].png entries for the .iconset: [points, scale].
const ICONSET = [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1],
  [128, 2], [256, 1], [256, 2], [512, 1], [512, 2],
];

// argv arrays only — the app name contains a space, so no shell strings anywhere.
function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Build icon.icns (and the §3 dev icon.png) from icon.svg via
// qlmanage → sips → iconutil. Never throws: any failure degrades to the
// existing icns or, failing that, Electron's default icon — a broken icon
// toolchain must not block a pack.
function ensureIcon() {
  const svg = path.join(DESKTOP, 'icon.svg');
  const icns = path.join(DESKTOP, 'icon.icns');
  if (!fs.existsSync(svg)) {
    console.log(fs.existsSync(icns)
      ? 'icon: icon.svg missing — using existing icon.icns'
      : 'icon: icon.svg missing — packing without custom icon');
    return fs.existsSync(icns) ? icns : null;
  }
  if (fs.existsSync(icns) && fs.statSync(icns).mtimeMs >= fs.statSync(svg).mtimeMs) {
    console.log('icon: icon.icns up to date');
    return icns;
  }
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-icon-'));
    run('qlmanage', ['-t', '-s', '1024', '-o', tmp, svg]);
    // qlmanage can exit 0 without producing output — the stat is the real check.
    const rendered = path.join(tmp, 'icon.svg.png');
    fs.statSync(rendered);
    const iconset = path.join(tmp, 'cp.iconset');
    fs.mkdirSync(iconset);
    for (const [pt, scale] of ICONSET) {
      const px = pt * scale;
      const dest = path.join(iconset, `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`);
      if (px === 1024) fs.copyFileSync(rendered, dest);
      else run('sips', ['-z', String(px), String(px), rendered, '--out', dest]);
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
    fs.copyFileSync(rendered, path.join(DESKTOP, 'icon.png')); // dev icon (§3)
    console.log('icon: regenerated icon.icns + icon.png from icon.svg');
    return icns;
  } catch (err) {
    const first = String(err && err.message || err).split('\n')[0];
    console.log(`icon: ${first} — packing without custom icon`);
    return fs.existsSync(icns) ? icns : null;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pack(iconPath, repoRoot) {
  // Unit tests and option validation need no Electron download or real pack.
  const { packager } = await import('@electron/packager');
  const outDirs = await packager({
    dir: DESKTOP,
    out: PACK_TMP,
    name: APP_NAME,
    appBundleId: BUNDLE_ID,
    platform: 'darwin',
    arch: process.arch,
    overwrite: true,
    prune: true,
    asar: false, // this packager version defaults asar ON; §3 ships a plain Resources/app dir
    derefSymlinks: true,
    icon: iconPath ?? undefined,
    ignore: (p) => p !== '' && !SHIP.has(p),
    // The packaged shell lives under Contents/Resources/app, so dirname
    // arithmetic can never find the external server checkout. Seed a validated,
    // user-repairable hint instead; main.js persists it in userData on first use.
    afterCopy: [({ buildPath }) => {
      fs.writeFileSync(path.join(buildPath, 'repo-location.json'), JSON.stringify({ repoRoot }, null, 2));
    }],
  });
  return path.join(outDirs[0], `${APP_NAME}.app`);
}

// Flatten packager's <out>/<name>-darwin-<arch>/ layout to dist/<name>.app.
function flatten(appInTmp, stage) {
  const destination = stage ? fs.mkdtempSync(path.join(DIST, 'update-')) : DIST;
  const target = path.join(destination, `${APP_NAME}.app`);
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`pack: cannot replace ${target} (${err.code || err.message}) — quit the running ${APP_NAME}.app and re-run`);
    process.exit(1);
  }
  fs.renameSync(appInTmp, target);
  fs.rmSync(PACK_TMP, { recursive: true, force: true });
  return target;
}

function adhocSign(appPath) {
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
}

function verify(appPath) {
  try {
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
  } catch (err) {
    console.error(`pack: codesign verify failed\n${err.stderr || err.message}`);
    process.exit(1);
  }
}

async function main() {
  const options = resolvePackOptions(process.argv.slice(2));
  if (process.platform !== 'darwin') {
    console.error('pack: darwin only — the Phase-1 blueprint targets macOS');
    process.exit(1);
  }
  const icon = ensureIcon();
  const appPath = flatten(await pack(icon, options.serverRoot), options.stage);
  adhocSign(appPath);
  verify(appPath);
  console.log(`pack: ${appPath}`);
  console.log(`pack: server fallback ${options.serverRoot}`);
  console.log('pack: ad-hoc signed; codesign --verify --deep --strict passed');
  console.log(icon ? `pack: icon ${path.basename(icon)}` : 'pack: default Electron icon (no icon.icns)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
