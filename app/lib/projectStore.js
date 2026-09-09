// lib/projectStore.js — runtime mutations of the project registry.
//
// Projects load from config.json once at boot into the shared, mutable PROJECTS
// object (lib/config.js). The Manage Projects tab edits them live: we mutate
// PROJECTS IN PLACE (same object reference — importers and the in-process tests
// rely on it), then persist by rewriting ONLY the `projects` block of
// config.json, leaving user/notifications/port/weeklyHourTarget/artifactGlobs
// untouched. The route layer broadcasts a fresh snapshot so every client live-
// updates. The project KEY is the on-disk identity (tasks/<key>.json, ledger,
// snapshots/<key>/, transcripts/<key>/) and is IMMUTABLE — only the display
// name, color, status and pin slot are editable; create mints a fresh key.
//
// Pins decide ONLY which projects sit on the top bar and in what order (≤ 7
// slots, ⌘1..⌘7). Per-project `pinOrder` is the only storage: an integer 1..7
// when pinned, `null` when explicitly unpinned, ABSENT when the user has never
// touched pins. While NO project carries the field the bar is DERIVED at read
// time — the first 7 non-inactive projects in config key order, i.e. exactly
// the pre-pins nav — and nothing is written. The first explicit pin/unpin
// materialises that derived set (so the bar does not jump), after which every
// write keeps slots contiguous 1..n. `null` (rather than deleting the field)
// is what lets "unpin the last project" leave the bar empty instead of
// falling back to the derived seven.
import fs from 'fs';
import path from 'path';
import { ROOT, PROJECTS } from './config.js';
import { writeFileAtomic } from './paths.js';

const CONFIG_FILE = path.join(ROOT, 'config.json');
export const STATUSES = ['active', 'trial', 'inactive'];
/** Top-bar slots (⌘1..⌘7). */
export const PIN_MAX = 7;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** Designation, with back-compat for the old boolean `trial: true`. */
export function projectStatus(p) {
  if (p && STATUSES.includes(p.status)) return p.status;
  return (p && p.trial) ? 'trial' : 'active';
}

/** A real project entry: a plain object with a string root. config.json's
 *  `projects` block may also carry a `"//": "comment"` string (the shipped
 *  example does) — that must never count as a project, let alone a pin. */
function isProject(p) { return !!p && typeof p === 'object' && !Array.isArray(p) && typeof p.root === 'string'; }

/** Not inactive — eligible for the bar and therefore for a pin. */
function isVisible(p) { return isProject(p) && projectStatus(p) !== 'inactive'; }

/** The stored slot as an integer 1..PIN_MAX, else null (absent, null, or garbage). */
function storedPin(p) {
  const n = p && p.pinOrder;
  return (Number.isInteger(n) && n >= 1 && n <= PIN_MAX) ? n : null;
}

/** True once any project carries the field (a slot or an explicit null) — the
 *  bar is then explicit; before that it is derived from key order. */
function pinsExplicit() {
  return Object.values(PROJECTS).some(p => p && (p.pinOrder === null || storedPin(p) !== null));
}

/**
 * Keys on the bar, in slot order (≤ PIN_MAX). Explicit mode: visible keys with
 * a slot, sorted (ties keep key order). Derived mode (no project has ever been
 * pinned or unpinned): the first PIN_MAX visible keys in config order. Pure —
 * never writes.
 */
export function pinnedKeys() {
  const visible = Object.entries(PROJECTS).filter(([, p]) => isVisible(p));
  if (!pinsExplicit()) return visible.slice(0, PIN_MAX).map(([k]) => k);
  return visible
    .filter(([, p]) => storedPin(p) !== null)
    .sort((a, b) => storedPin(a[1]) - storedPin(b[1]))
    .slice(0, PIN_MAX)
    .map(([k]) => k);
}

/** The slot a project occupies on the bar (derived or explicit), or null. Wire value of `pinOrder`. */
export function projectPinOrder(key) {
  const i = pinnedKeys().indexOf(key);
  return i >= 0 ? i + 1 : null;
}

// Write the whole bar: `order` gets 1..n, every other VISIBLE project gets an
// explicit null (this is what materialises a derived bar), inactive projects
// lose the field. Slots stay contiguous. In-memory only — callers persist().
function writePins(order) {
  for (const [key, p] of Object.entries(PROJECTS)) {
    if (!isProject(p)) continue; // a "//" comment string — never written to
    const i = order.indexOf(key);
    if (i >= 0) p.pinOrder = i + 1;
    else if (isVisible(p)) p.pinOrder = null;
    else delete p.pinOrder;
  }
}

// Validate a requested pin (integer 1..PIN_MAX or null) — 400 otherwise.
function validPin(n) {
  if (n === null || (Number.isInteger(n) && n >= 1 && n <= PIN_MAX)) return n;
  throw httpError(400, `invalid pinOrder '${n}' (use an integer 1..${PIN_MAX}, or null to unpin)`);
}

// The other pinned keys, in order — the derived set counts, so the cap holds
// across the whole registry (and two quick PATCHes can never exceed PIN_MAX:
// routes are synchronous).
function othersPinned(key) { return pinnedKeys().filter(k => k !== key); }

// The two pin refusals, checked against the designation the project WILL
// have (`visible`) — callers run this before mutating anything, so a refused
// PATCH leaves both memory and disk exactly as they were.
function assertPinnable(key, n, visible) {
  if (n === null) return;
  if (!visible) throw httpError(400, `cannot pin an inactive project ('${key}' — set it active or trial first)`);
  if (othersPinned(key).length >= PIN_MAX) throw httpError(400, `${PIN_MAX} of ${PIN_MAX} pinned — unpin a project to make room`);
}

// Put `key` at slot n among the OTHER pinned keys (insert — later slots shift
// down; n past the end appends), or unpin it (n === null); then renumber 1..n.
function applyPin(key, n) {
  assertPinnable(key, n, isVisible(PROJECTS[key]));
  const order = othersPinned(key);
  if (n !== null) order.splice(Math.min(n, order.length + 1) - 1, 0, key);
  writePins(order);
}

function validColor(c, fallback) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : fallback;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// Re-read config.json fresh (never clobber fields we don't own), set projects,
// write atomically. A missing file (env-driven test setups) → write a new one
// with just projects; CP_PROJECTS_JSON still wins on the next boot anyway.
function persist() {
  let cfg = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch { /* missing or malformed — start fresh, preserving nothing we can't read */ }
  cfg.projects = PROJECTS;
  writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Create a project. Mints a unique key from the name; validates the root dir.
 * Pinning: `pinOrder` omitted → the next free slot if one exists (in derived
 * mode that is automatic — the new key is appended, so nothing is written);
 * an explicit slot or null is applied like a PATCH. Inactive → never pinned.
 * The result's `pinOrder` is the slot it landed on, or null.
 */
export function createProject({ name, root, color, status, pinOrder } = {}) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'project name is required');
  root = String(root || '').trim();
  if (!root) throw httpError(400, 'project root path is required');
  if (!path.isAbsolute(root)) throw httpError(400, 'project root must be an absolute path');
  let st;
  try { st = fs.statSync(root); } catch { throw httpError(400, `root path does not exist: ${root}`); }
  if (!st.isDirectory()) throw httpError(400, `root path is not a directory: ${root}`);
  const designation = STATUSES.includes(status) ? status : 'active';
  if (pinOrder !== undefined) validPin(pinOrder); // refuse before minting a key (the slot checks run after)

  const base = slugify(name) || 'project';
  // frontend view names — a project keyed 'settings' would shadow that view
  const RESERVED = new Set(['ov', 'cats', 'manage', 'about', 'settings', 'new', 'git', 'catman']);
  let key = RESERVED.has(base) ? `${base}_2` : base;
  for (let n = 2; Object.prototype.hasOwnProperty.call(PROJECTS, key); n++) key = `${base}_${n}`;

  PROJECTS[key] = {
    name,
    root: path.resolve(root),
    color: validColor(color, '#7ea2f5'),
    texWatch: null,
    status: designation,
  };
  if (pinOrder !== undefined) {
    try { applyPin(key, pinOrder); } catch (err) { delete PROJECTS[key]; throw err; }
  } else if (pinsExplicit() && designation !== 'inactive') {
    const order = pinnedKeys();
    if (order.length < PIN_MAX) writePins([...order, key]); // next free slot
  }
  persist();
  return { key, project: PROJECTS[key], pinOrder: projectPinOrder(key) };
}

/**
 * Update a project's display name / color / status / pin slot. The key is
 * immutable. `pinOrder`: integer 1..PIN_MAX places the project at that slot
 * (later slots shift down), null unpins it; 400 when the project is inactive
 * or PIN_MAX other projects already hold a slot. `status: 'inactive'` clears
 * the pin in the same write. The result's `pinOrder` is the effective slot.
 */
export function updateProject(key, { name, color, status, pinOrder } = {}) {
  const p = PROJECTS[key];
  if (!isProject(p)) throw httpError(404, `unknown project '${key}'`);
  // validate everything before mutating anything (a 400 must leave no trace)
  if (status !== undefined && !STATUSES.includes(status)) {
    throw httpError(400, `invalid status '${status}' (use ${STATUSES.join('/')})`);
  }
  if (pinOrder !== undefined) {
    validPin(pinOrder);
    assertPinnable(key, pinOrder, (status !== undefined ? status : projectStatus(p)) !== 'inactive');
  }
  if (name !== undefined) {
    const nm = String(name).trim();
    if (!nm) throw httpError(400, 'name cannot be empty');
    p.name = nm;
  }
  if (color !== undefined) {
    const c = validColor(color, null);
    if (c) p.color = c;
  }
  if (status !== undefined) {
    p.status = status;
    delete p.trial; // converge onto the status model
  }
  if (pinOrder !== undefined) {
    // an explicit pin/unpin (checked against the post-status designation)
    applyPin(key, pinOrder);
  } else if (status === 'inactive' && 'pinOrder' in p) {
    // hidden from the bar → unpinned in the same write; later slots close up.
    // The field's presence means the bar is explicit, so pinnedKeys() is the
    // stored order (read before the delete — never a derived set).
    const order = pinnedKeys().filter(k => k !== key);
    delete p.pinOrder;
    writePins(order);
  }
  persist();
  return { key, project: p, pinOrder: projectPinOrder(key) };
}

/**
 * Atomic reorder (PUT /api/projects/pins): `keys` become slots 1..n, every
 * other project is unpinned, one write. 400 unless keys is an array of ≤
 * PIN_MAX unique, known, non-inactive keys (an empty array clears the bar).
 */
export function setPinOrder(keys) {
  if (!Array.isArray(keys)) throw httpError(400, 'keys must be an array of project keys');
  if (keys.length > PIN_MAX) throw httpError(400, `at most ${PIN_MAX} projects can be pinned (got ${keys.length})`);
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !isProject(PROJECTS[key])) throw httpError(400, `unknown project '${key}'`);
    if (seen.has(key)) throw httpError(400, `duplicate key '${key}'`);
    seen.add(key);
    if (!isVisible(PROJECTS[key])) throw httpError(400, `cannot pin an inactive project ('${key}' — set it active or trial first)`);
  }
  writePins(keys);
  persist();
  return { pinned: pinnedKeys() };
}
