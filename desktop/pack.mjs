// pack.mjs — packs the shell into dist/Central Planner.app (npm run pack).
//
// Signing is a deliberate explicit post-step (`codesign --force --deep --sign -`)
// rather than packager's osxSign: @electron/osx-sign throws "No identity found"
// on a keychain without a Developer ID, which would make packing machine-
// dependent — plain ad-hoc codesign is deterministic on any Mac. The re-sign is
// mandatory, not cosmetic: packager rewrites Info.plist and renames the
// executable, invalidating Electron's upstream ad-hoc seal, so without it the
// day-2 `codesign --verify --deep --strict` gate fails.

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function pack(iconPath) {
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
  });
  return path.join(outDirs[0], `${APP_NAME}.app`);
}

// Flatten packager's <out>/<name>-darwin-<arch>/ layout to dist/<name>.app.
function flatten(appInTmp) {
  const target = path.join(DIST, `${APP_NAME}.app`);
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
  if (process.platform !== 'darwin') {
    console.error('pack: darwin only — the Phase-1 blueprint targets macOS');
    process.exit(1);
  }
  const icon = ensureIcon();
  const appPath = flatten(await pack(icon));
  adhocSign(appPath);
  verify(appPath);
  console.log(`pack: ${appPath}`);
  console.log('pack: ad-hoc signed; codesign --verify --deep --strict passed');
  console.log(icon ? `pack: icon ${path.basename(icon)}` : 'pack: default Electron icon (no icon.icns)');
}

await main();
