// lib/texdeps.js — project-contained source inputs for one LaTeX root.
//
// The recorder (.fls) is the best account of what TeX actually consumed on
// the last build. A small source scan supplements it before the first build
// and catches newly-added \input/\include edges. Only editable TeX sources
// inside the project are returned; generated files and TeX Live inputs never
// become candidates for the dashboard's save-before-compile transaction.
import fs from 'fs';
import path from 'path';
import { containedPath } from './paths.js';

const SOURCE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx']);
const MAX_FILES = 500;
const MAX_BYTES = 2 * 1024 * 1024;

function sourceFile(project, fileish) {
  const c = containedPath(project, fileish);
  if (!c || !SOURCE_EXTS.has(path.extname(c.abs).toLowerCase())) return null;
  try {
    const st = fs.statSync(c.abs);
    return st.isFile() && st.size <= MAX_BYTES ? c : null;
  } catch { return null; }
}

function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

function localRef(project, raw, fromDir, compileDir, defaultExt) {
  let ref = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!ref || /[\\{}#$]/.test(ref)) return null; // dynamic TeX expression
  if (!path.extname(ref) && defaultExt) ref += defaultExt;
  const bases = path.isAbsolute(ref) ? [''] : [...new Set([fromDir, compileDir])];
  for (const base of bases) {
    const c = sourceFile(project, path.isAbsolute(ref) ? ref : path.resolve(base, ref));
    if (c) return c;
  }
  return null;
}

function scanSourceGraph(project, root) {
  const out = new Map();
  const queue = [root];
  const compileDir = path.dirname(root.abs);
  const add = (c) => {
    if (!c || out.has(c.abs) || out.size >= MAX_FILES) return;
    out.set(c.abs, c);
    queue.push(c);
  };
  out.set(root.abs, root);

  while (queue.length && out.size < MAX_FILES) {
    const cur = queue.shift();
    let text;
    try { text = fs.readFileSync(cur.abs, 'utf8').split('\n').map(stripComment).join('\n'); }
    catch { continue; }
    const fromDir = path.dirname(cur.abs);
    const collect = (re, ext, split = false) => {
      let m;
      while ((m = re.exec(text))) {
        const refs = split ? m[1].split(',') : [m[1]];
        for (const ref of refs) add(localRef(project, ref, fromDir, compileDir, ext));
      }
    };
    collect(/\\(?:input|include|subfile)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g, '.tex');
    collect(/\\input\s+([^\s%{}]+)/g, '.tex');
    collect(/\\bibliography\s*\{([^}]+)\}/g, '.bib', true);
    collect(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g, '.bib');
    collect(/\\usepackage\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g, '.sty', true);
    collect(/\\documentclass\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g, '.cls');
  }
  return out;
}

function recorderInputs(project, root) {
  const out = new Map();
  const fls = root.abs.replace(/\.tex$/i, '.fls');
  let lines;
  try { lines = fs.readFileSync(fls, 'utf8').split(/\r?\n/); } catch { return out; }
  let cwd = path.dirname(root.abs);
  for (const line of lines) {
    if (line.startsWith('PWD ')) {
      const c = containedPath(project, line.slice(4).trim());
      if (c) cwd = c.abs;
      continue;
    }
    if (!line.startsWith('INPUT ') || out.size >= MAX_FILES) continue;
    const raw = line.slice(6).trim();
    const c = sourceFile(project, path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
    if (c) out.set(c.abs, c);
  }
  return out;
}

/** Return project-relative editable inputs for an existing .tex root. */
export function texDependencies(project, tex) {
  const root = sourceFile(project, tex);
  if (!root || !/\.tex$/i.test(root.abs)) {
    const e = new Error('tex must be an existing .tex file inside the project');
    e.status = 400;
    throw e;
  }
  const files = recorderInputs(project, root);
  for (const [abs, c] of scanSourceGraph(project, root)) files.set(abs, c);
  files.set(root.abs, root);
  return {
    root: root.rel,
    files: [...files.values()].map((c) => c.rel).sort((a, b) => a.localeCompare(b)),
  };
}
