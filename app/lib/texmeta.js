// lib/texmeta.js — scan a project's .tex/.bib sources for the things the
// editor completes: \label targets, BibTeX keys, environments in use, and
// user-defined commands. Bounded walk (same ignore dirs / depth as the
// artifact watchers, ≤200 files, ≤2MB each) with a short mtime-keyed cache so
// keystroke-driven fetches never rescan an unchanged project.
import fs from 'fs';
import path from 'path';
import { PROJECTS, ARTIFACT_GLOBS } from './config.js';

const ignoreDirSet = new Set(ARTIFACT_GLOBS.ignoreDirs || []);
const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const TTL_MS = 3000;

const cache = new Map(); // project → { at, sig, meta }

function listTexFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > (ARTIFACT_GLOBS.maxDepth || 6) || out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirSet.has(e.name)) continue;
        walk(abs, depth + 1);
      } else if (e.isFile() && /\.(tex|sty|cls|bib)$/i.test(e.name)) {
        try {
          const st = fs.statSync(abs);
          if (st.size <= MAX_BYTES) out.push({ abs, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

const LABEL = /\\label\s*\{([^}]+)\}/g;
const ENV = /\\begin\s*\{([A-Za-z*]+)\}/g;
const NEWCMD = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?|\\def\s*\\([A-Za-z@]+)/g;
const BIBKEY = /^\s*@(\w+)\s*[({]\s*([^,\s]+)\s*,/gm;
const BIBTITLE = /title\s*=\s*[{"]((?:[^{}"]|\{[^{}]*\})*)[}"]/i;

function scanProject(root) {
  const files = listTexFiles(root);
  const sig = files.map((f) => `${f.abs}:${f.mtimeMs}`).join('|');
  return { files, sig };
}

/** → { labels: [{label, file, line}], cites: [{key, type, title, file}],
 *      envs: [names], commands: [names] } — file paths relative to root. */
export function texMeta(project) {
  const cfg = PROJECTS[project];
  if (!cfg) throw new Error(`unknown project: ${project}`);
  const root = path.resolve(cfg.root);

  const hit = cache.get(project);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.meta;

  const { files, sig } = scanProject(root);
  if (hit && hit.sig === sig) {
    hit.at = Date.now();
    return hit.meta;
  }

  const labels = [];
  const cites = [];
  const envs = new Set();
  const commands = new Set();

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const rel = path.relative(root, f.abs);

    if (/\.bib$/i.test(f.abs)) {
      let m;
      BIBKEY.lastIndex = 0;
      while ((m = BIBKEY.exec(text))) {
        if (/^(comment|preamble|string)$/i.test(m[1])) continue;
        // title: look inside this entry only (up to the next @ or EOF)
        const tail = text.slice(BIBKEY.lastIndex, text.indexOf('\n@', BIBKEY.lastIndex) + 1 || undefined);
        const tm = tail.match(BIBTITLE);
        cites.push({
          key: m[2], type: m[1].toLowerCase(),
          title: tm ? tm[1].replace(/[{}]/g, '').slice(0, 120) : '',
          file: rel,
        });
        if (cites.length >= 2000) break;
      }
      continue;
    }

    // .tex/.sty/.cls — labels with line numbers, environments, commands
    const nl = text.split('\n');
    for (let i = 0; i < nl.length; i++) {
      const line = nl[i];
      if (!line.includes('\\')) continue;
      let m;
      LABEL.lastIndex = 0;
      while ((m = LABEL.exec(line))) {
        if (labels.length < 2000) labels.push({ label: m[1], file: rel, line: i + 1 });
      }
      ENV.lastIndex = 0;
      while ((m = ENV.exec(line))) envs.add(m[1]);
      NEWCMD.lastIndex = 0;
      while ((m = NEWCMD.exec(line))) commands.add(m[1] || m[2]);
    }
  }

  const meta = {
    labels,
    cites,
    envs: [...envs].sort(),
    commands: [...commands].sort(),
  };
  cache.set(project, { at: Date.now(), sig, meta });
  return meta;
}
