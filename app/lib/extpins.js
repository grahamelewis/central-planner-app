// lib/extpins.js — EXTERNAL context pins: files/folders the user explicitly
// pinned that live OUTSIDE the project root. Their containing directory is
// granted to the session via query()'s `additionalDirectories`, so Claude can
// read AND edit them — true cross-folder work.
//
// SECURITY MODEL: `additionalDirectories` is an allowlist. We add ONLY the
// directories of explicitly-pinned external paths. Anything outside the project
// root that the user did NOT pin stays unreachable by the session's tools —
// exactly "if a folder isn't pinned and is outside the root, Claude can't edit
// it." Paths are realpath'd (symlink-safe) and must exist on disk.
//
// Imports no SDK → directly unit-testable.
import fs from 'fs';
import path from 'path';
import { PROJECTS } from './config.js';
import { containedPath } from './paths.js';

// A pin is EXTERNAL when it's an absolute path that resolves OUTSIDE the project
// root (containedPath rejects it) and exists on disk. Internal pins are stored
// project-relative; an absolute path that IS inside the root is still internal.
export function isExternalPin(project, pin) {
  const cfg = PROJECTS[project];
  if (!cfg || typeof pin !== 'string' || !pin || pin.includes('\0')) return false;
  const raw = pin.replace(/\/+$/, ''); // drop the folder-pin trailing slash
  if (!path.isAbsolute(raw)) return false;      // relative → internal
  if (containedPath(project, raw)) return false; // absolute but inside root → internal
  try { fs.statSync(raw); return true; } catch { return false; } // must exist
}

// The directories to grant, one per external pin: a folder pin grants the
// folder itself; a file pin grants its PARENT directory (additionalDirectories
// is directory-scoped — a single file cannot be granted more narrowly). Deduped
// and realpath'd. Returns [] when there are no external pins (the common case,
// so the option is simply omitted and the session is unchanged).
export function externalDirsFor(project, files) {
  const dirs = new Set();
  for (const pin of Array.isArray(files) ? files : []) {
    if (!isExternalPin(project, pin)) continue;
    const raw = pin.replace(/\/+$/, '');
    let real;
    try { real = fs.realpathSync(raw); } catch { continue; }
    let st;
    try { st = fs.statSync(real); } catch { continue; }
    dirs.add(st.isDirectory() ? real : path.dirname(real));
  }
  return [...dirs];
}

// External pins as human-readable pointers for the context packet, so Claude
// knows the paths exist and are accessible.
export function externalPinLines(project, files) {
  const out = [];
  for (const pin of Array.isArray(files) ? files : []) {
    if (isExternalPin(project, pin)) out.push(`- ${pin}`);
  }
  return out;
}

// Is `abs` reachable through this task's external pins? True when its realpath
// lies within one of the granted directories (externalDirsFor). This is the
// SAME allowlist used for the session's additionalDirectories, so the dashboard
// browser can never read a path the session itself couldn't — nothing outside a
// pinned external dir is listable/readable. Guards the /api/extls + /api/extfile
// routes.
export function isPathGranted(project, files, abs) {
  if (typeof abs !== 'string' || !abs || abs.includes('\0')) return false;
  const dirs = externalDirsFor(project, files);
  if (!dirs.length) return false;
  // realpath the nearest EXISTING ancestor, so a not-yet-created leaf inside a
  // granted dir still counts (e.g. a file the session is about to Write, which
  // the change-history needs to track). Granted dirs always exist, so any path
  // under one resolves to it (or deeper); a path outside resolves elsewhere.
  let p = abs.replace(/\/+$/, '');
  let real = null;
  for (;;) {
    try { real = fs.realpathSync(p); break; } catch { /* missing — walk up */ }
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  if (real === null) return false;
  for (const dir of dirs) {
    if (real === dir || real.startsWith(dir + path.sep)) return true;
  }
  return false;
}
