// lib/categoryStore.js — WRITES to ROOT/categories.json (taskStore keeps the
// reads). Categories are { group, name, icon, primer, defaults } keyed by the
// id tasks carry in task.category; groups are just labels on categories.
//
// Semantics (deliberate, see the Manage Categories editor):
// - RENAME propagates: the key changes AND every task ever tagged with it —
//   past and present, across all projects — is retagged (taskStore.retagCategory).
// - DELETE never touches tasks: old tasks keep their label (it renders as a
//   plain string everywhere); only the pickers lose the option.
// - Deleting a GROUP deletes its member categories (same task semantics);
//   the caller is expected to confirm with the user first.
// - Unknown fields on a category (legacy defaults like artifact_dir) are
//   PRESERVED on every edit — the editor just doesn't surface them.
import fs from 'fs';
import path from 'path';
import { ROOT } from './config.js';
import { writeFileAtomic } from './paths.js';
import { getCategories, retagCategory } from './taskStore.js';

const CATEGORIES_FILE = path.join(ROOT, 'categories.json');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Load for WRITING. If the user has no categories.json yet, getCategories()
// is serving categories.example.json — materialize that as the starting
// point, so a fresh clone's first edit doesn't vanish.
function loadCats() {
  if (fs.existsSync(CATEGORIES_FILE)) {
    // corrupt file must THROW (surface to the user), never be clobbered
    const parsed = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(500, 'categories.json is not a JSON object — fix it by hand');
    }
    return parsed;
  }
  return JSON.parse(JSON.stringify(getCategories() || {}));
}

function saveCats(cats) {
  writeFileAtomic(CATEGORIES_FILE, JSON.stringify(cats, null, 2) + '\n');
}

// Category keys and group labels: human-readable strings (spaces are fine —
// existing keys have them), just not empty/absurd/control-charactered.
function cleanLabel(s, what) {
  const v = String(s ?? '').trim();
  if (!v) throw httpError(400, `${what} must be a non-empty string`);
  if (v.length > 60) throw httpError(400, `${what} is too long (max 60 chars)`);
  if (/[\u0000-\u001f]/.test(v)) throw httpError(400, `${what} contains control characters`);
  // categories are plain-object keys — a prototype-polluting name would be
  // silently swallowed by the setter (created/renamed to nowhere)
  if (['__proto__', 'constructor', 'prototype'].includes(v)) {
    throw httpError(400, `${what} '${v}' is reserved`);
  }
  return v;
}

function requireCat(cats, key) {
  if (!Object.prototype.hasOwnProperty.call(cats, key)) {
    throw httpError(404, `unknown category '${key}'`);
  }
  const c = cats[key];
  return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
}

// normalized patch application shared by create/update
function applyFields(cat, { icon, group, primer, webSearch }) {
  if (icon !== undefined) cat.icon = String(icon).trim().slice(0, 4);
  if (group !== undefined) cat.group = cleanLabel(group, 'group');
  if (primer !== undefined) cat.primer = String(primer);
  if (webSearch !== undefined) {
    // merge — legacy defaults keys (artifact, careful_mode, …) are kept as-is
    cat.defaults = { ...(cat.defaults && typeof cat.defaults === 'object' ? cat.defaults : {}), web_search: !!webSearch };
  }
  return cat;
}

export function createCategory({ key, icon, group, primer, webSearch }) {
  const k = cleanLabel(key, 'category name');
  const cats = loadCats();
  if (Object.prototype.hasOwnProperty.call(cats, k)) {
    throw httpError(409, `a category named '${k}' already exists`);
  }
  const cat = applyFields({ name: k, defaults: { web_search: false } }, {
    icon: icon !== undefined ? icon : '◆',
    group: group !== undefined ? group : 'Other',
    primer: primer !== undefined ? primer : '',
    webSearch,
  });
  cats[k] = cat;
  saveCats(cats);
  return { key: k, category: cat, categories: cats };
}

export function updateCategory(key, patch) {
  const cats = loadCats();
  const cat = requireCat(cats, key);
  applyFields(cat, patch || {});
  cats[key] = cat;
  saveCats(cats);
  return { key, category: cat, categories: cats };
}

/** Rename = identity change: the key AND the display name become `to`, and
    every task ever tagged `from` is retagged — past and present, all
    projects. Returns how many tasks moved. */
export function renameCategory(from, to) {
  const cats = loadCats();
  requireCat(cats, from);
  const t = cleanLabel(to, 'category name');
  if (t === from) return { key: from, retagged: 0, categories: cats };
  if (Object.prototype.hasOwnProperty.call(cats, t)) {
    throw httpError(409, `a category named '${t}' already exists`);
  }
  // rebuild in place so the key keeps its position (group order derives from
  // first-appearance order in the file)
  const next = {};
  for (const [k, v] of Object.entries(cats)) {
    if (k === from) next[t] = { ...(v && typeof v === 'object' ? v : {}), name: t };
    else next[k] = v;
  }
  // retag FIRST: if it dies midway, the old key still exists and the same
  // rename can simply be re-run to finish (dangling labels render fine in
  // the meantime). Committing categories.json first made a partial retag
  // unrecoverable — the source key was already gone.
  const retagged = retagCategory(from, t);
  saveCats(next);
  return { key: t, retagged, categories: next };
}

/** Delete a category. Tasks are deliberately untouched — the past keeps its
    labels; only the pickers lose the option. */
export function deleteCategory(key) {
  const cats = loadCats();
  requireCat(cats, key);
  delete cats[key];
  saveCats(cats);
  return { ok: true, categories: cats };
}

/** Rename a group: rewrite the label on every member category. Tasks carry
    category keys, not groups, so nothing else moves. */
export function renameGroup(from, to) {
  const f = cleanLabel(from, 'group');
  const t = cleanLabel(to, 'group');
  const cats = loadCats();
  const members = Object.values(cats).filter((c) => c && typeof c === 'object' && c.group === f);
  if (!members.length) throw httpError(404, `unknown group '${f}'`);
  if (t !== f) members.forEach((c) => { c.group = t; });
  saveCats(cats);
  return { moved: members.length, categories: cats };
}

/** Delete a group AND its member categories (confirmed by the caller's UI).
    Tasks keep their labels, exactly like a single-category delete. */
export function deleteGroup(name) {
  const g = cleanLabel(name, 'group');
  const cats = loadCats();
  const removed = Object.entries(cats)
    .filter(([, c]) => c && typeof c === 'object' && c.group === g)
    .map(([k]) => k);
  if (!removed.length) throw httpError(404, `unknown group '${g}'`);
  for (const k of removed) delete cats[k];
  saveCats(cats);
  return { removed, categories: cats };
}
