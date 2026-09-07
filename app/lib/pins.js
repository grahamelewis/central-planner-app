// lib/pins.js — kind-aware pinned context.
// Pins come in four kinds: code/text (read on demand by the session), data
// (we inject a generated "data card": schema, sample rows, scale — never the
// content), manifests (Cargo.toml / package.json / go.mod / CMakeLists.txt /
// Makefile → a compact "manifest card": name, version, deps, scripts/targets,
// parsed here in node without shelling out), and folders (an annotated tree
// map). Cards are cached by mtime. The name/extension lists that decide the
// kind live in public/pinkinds.js, shared verbatim with the browser.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isIgnoredDir } from './config.js';
import { containedPath } from './paths.js';
import { DATA_EXTS as SHARED_DATA_EXTS, MANIFEST_NAMES, manifestOf } from '../public/pinkinds.js';

const pexecFile = promisify(execFile);
const logErr = (...a) => console.error('[pins]', ...a);

export const DATA_EXTS = SHARED_DATA_EXTS;
export { MANIFEST_NAMES };

const CARD_CACHE = new Map(); // abs → { stamp, card }

/** @returns {'folder' | 'manifest' | 'data' | 'code'} */
export function pinKind(fileish) {
  const f = String(fileish || '');
  if (f.endsWith('/')) return 'folder';
  if (manifestOf(f)) return 'manifest';
  const ext = f.split('.').pop().toLowerCase();
  return DATA_EXTS.includes(ext) ? 'data' : 'code';
}

function human(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
  return bytes + ' B';
}

// ---------------------------------------------------------------------------
// Data cards
// ---------------------------------------------------------------------------

// crude type inference for the csv sample
function inferType(values) {
  let num = 0, int = 0, date = 0, filled = 0;
  for (const v of values) {
    if (v === '' || v == null) continue;
    filled++;
    if (/^-?\d+$/.test(v)) { int++; num++; }
    else if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(v)) num++;
    else if (/^\d{4}-\d{2}-\d{2}/.test(v)) date++;
  }
  if (!filled) return 'empty';
  if (num === filled) return int === filled ? 'int' : 'float';
  if (date === filled) return 'date';
  return 'str';
}

// quote-aware record scanner: respects newlines INSIDE quoted fields
function scanCsvRecords(text, delim, maxRecords) {
  const records = [];
  let field = '', record = [], inQ = false, sawQuotedNl = false;
  for (let i = 0; i < text.length && records.length < maxRecords; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQ = false;
      } else {
        if (ch === '\n') sawQuotedNl = true;
        field += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      record.push(field); field = '';
    } else if (ch === '\n') {
      record.push(field.replace(/\r$/, ''));
      if (record.some(f => f !== '')) records.push(record);
      record = []; field = '';
    } else {
      field += ch;
    }
  }
  return { records, sawQuotedNl };
}

const stripCtl = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·');

async function csvCard(abs, st) {
  const ext = abs.split('.').pop().toLowerCase();
  const delim = ext === 'tsv' ? '\t' : ',';
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(256 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let text = buf.toString('utf8', 0, n);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  const { records, sawQuotedNl } = scanCsvRecords(text, delim, 7);
  const header = (records[0] || ['']).map(stripCtl);
  const sample = records.slice(1, 7).map(r => r.map(stripCtl));

  // row count: exact line count via wc; flag as approximate when quoted
  // newlines exist (records ≠ lines then) or the file lacks a trailing newline
  let rows = null;
  let rowsNote = '';
  try {
    const { stdout } = await pexecFile('wc', ['-l', abs], { timeout: 30000 });
    rows = Math.max(0, parseInt(stdout.trim(), 10) - 1);
    if (sawQuotedNl) rowsNote = ' (approx — quoted multi-line fields present)';
    else if (n > 0 && buf[n - 1] !== 0x0a && n === st.size) rows += 1; // no trailing newline
  } catch { /* unknown */ }

  const types = header.map((_, i) => inferType(sample.map(r => (r[i] ?? '').trim())));
  const colLines = header.map((h, i) => `  ${h || `(col ${i + 1})`}: ${types[i]}`);
  const sampleLines = sample.slice(0, 5).map(r => '  ' + r.map(v => {
    const one = v.replace(/\n/g, '⏎');
    return one.length > 24 ? one.slice(0, 21) + '…' : one;
  }).join(' | '));

  return [
    `format: ${ext} · size: ${human(st.size)}${rows != null ? ` · rows: ${rows.toLocaleString()}${rowsNote}` : ''} · cols: ${header.length}`,
    `columns (type inferred from sample):`,
    ...colLines.slice(0, 60),
    header.length > 60 ? `  … ${header.length - 60} more columns` : null,
    `sample rows:`,
    `  ${header.map(h => h.length > 24 ? h.slice(0, 21) + '…' : h).join(' | ')}`,
    ...sampleLines,
  ].filter(Boolean).join('\n');
}

// binary formats → python (pandas/pyarrow); degrades to a stub when missing
const PY_CARD = `
import sys, os, json
p = sys.argv[1]; ext = p.rsplit('.', 1)[-1].lower()
def emit(rows, cols, dtypes, sample):
    print(f"rows: {rows if rows is not None else '?'} | cols: {cols}")
    print("columns:")
    for c, t in list(dtypes)[:60]:
        print(f"  {c}: {t}")
    if len(dtypes) > 60: print(f"  ... {len(dtypes)-60} more columns")
    print("sample rows:")
    print(sample)
if ext == 'parquet':
    try:
        import pyarrow.parquet as pq
        f = pq.ParquetFile(p); md = f.metadata
        import pandas as pd
        df = next(f.iter_batches(batch_size=5)).to_pandas()
        emit(md.num_rows, md.num_columns, [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
        sys.exit(0)
    except ImportError: pass
import pandas as pd
if ext == 'dta':
    rdr = pd.read_stata(p, chunksize=5); df = next(rdr)
    emit(None, len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
elif ext in ('xlsx', 'xls'):
    df = pd.read_excel(p, nrows=5)
    emit(None, len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
elif ext == 'feather':
    df = pd.read_feather(p)
    emit(len(df), len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
else:
    print("(no python reader for ." + ext + ")")
`;

async function binaryCard(abs, st) {
  const ext = abs.split('.').pop().toLowerCase();
  if (ext === 'rds' || ext === 'rdata') {
    // R serialized — describing it needs R; keep it a stub with instructions
    return `format: ${ext} · size: ${human(st.size)}\n(R serialized object — inspect via: Rscript -e 'str(readRDS("${abs}"), max.level=2)')`;
  }
  try {
    const { stdout } = await pexecFile('python3', ['-c', PY_CARD, abs], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return `format: ${ext} · size: ${human(st.size)}\n${stdout.trim().slice(0, 4000)}`;
  } catch (err) {
    return `format: ${ext} · size: ${human(st.size)}\n(schema unavailable: ${String(err.message || err).split('\n')[0].slice(0, 160)} — inspect via bash)`;
  }
}

// ---------------------------------------------------------------------------
// Manifest cards — Cargo.toml · package.json · go.mod · CMakeLists.txt · Makefile
// Node-only parsing (never cargo/npm/go/cmake), bounded input, ≤ 40 lines out.
// Every value is untrusted text from the file: control chars stripped, clipped.
// ---------------------------------------------------------------------------

const MANIFEST_MAX_LINES = 40;
const LIST_MAX = 15;
const MANIFEST_READ_BYTES = 256 * 1024;

const clip = (s, n) => {
  const one = stripCtl(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
// "a, b, c … (+N more)" — the first LIST_MAX names of a list
function nameList(names, max = LIST_MAX) {
  const shown = names.slice(0, max).map((n) => clip(n, 60));
  const more = names.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` … (+${more} more)` : '');
}
function capLines(lines) {
  const out = lines.filter((l) => l != null && l !== '');
  if (out.length <= MANIFEST_MAX_LINES) return out;
  return [...out.slice(0, MANIFEST_MAX_LINES - 1), `… (+${out.length - MANIFEST_MAX_LINES + 1} more lines)`];
}

// -- TOML-lite (enough for Cargo.toml: sections, [[tables]], key = value with
//    multi-line arrays/inline tables; values are kept as raw strings) --------
function bracketDepth(s) {
  const t = String(s).replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '').replace(/#.*$/, '');
  let d = 0;
  for (const ch of t) { if (ch === '[' || ch === '{') d++; else if (ch === ']' || ch === '}') d--; }
  return d;
}
function parseTomlLite(text) {
  const sections = Object.create(null); // untrusted TOML names are never prototype lookups
  const tables = Object.create(null);
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(line))) {
      cur = Object.create(null);
      (tables[m[1].replace(/["']/g, '')] ||= []).push(cur);
      continue;
    }
    if ((m = /^\[\s*([^\]]+?)\s*\]/.exec(line))) {
      cur = (sections[m[1].replace(/["']/g, '')] ||= Object.create(null));
      continue;
    }
    m = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? m[2] ?? m[3];
    let val = m[4];
    let depth = bracketDepth(val);
    while (depth > 0 && i + 1 < lines.length) { i++; val += '\n' + lines[i]; depth += bracketDepth(lines[i]); }
    (cur ||= (sections[''] ||= Object.create(null)))[key] = val.trim();
  }
  return { sections, tables };
}
const tomlStr = (v) => {
  if (v == null) return null;
  const m = /^"((?:\\.|[^"\\])*)"|^'([^']*)'/.exec(String(v));
  if (m) return m[1] ?? m[2];
  return /\bworkspace\s*=\s*true/.test(v) ? '(workspace)' : null;
};
const tomlStrArray = (v) => {
  const out = [];
  if (v == null) return out;
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let m;
  const body = String(v).replace(/#.*$/gm, '');
  while ((m = re.exec(body))) out.push(m[1] ?? m[2]);
  return out;
};
// dependency names for [dependencies] / [dev-dependencies] / [build-dependencies],
// covering the table form [dependencies.serde], the target form
// [target.'cfg(unix)'.dependencies] and (workspace=true) [workspace.dependencies]
function cargoDepNames(sections, kind, workspace = false) {
  const names = new Set();
  for (const [sec, kv] of Object.entries(sections)) {
    const parts = sec.split('.');
    const i = parts.indexOf(kind);
    if (i < 0 || (parts[0] === 'workspace') !== workspace) continue;
    if (i === parts.length - 1) Object.keys(kv).forEach((k) => names.add(k));
    else if (i === parts.length - 2) names.add(parts[i + 1]);
  }
  return [...names];
}

function cargoCard(text, dir) {
  const { sections, tables } = parseTomlLite(text);
  const pkg = sections.package;
  const ws = sections.workspace;
  const lines = [];
  if (pkg) {
    const name = tomlStr(pkg.name) || '?';
    const ver = tomlStr(pkg.version);
    const ed = tomlStr(pkg.edition);
    const rv = tomlStr(pkg['rust-version']);
    lines.push(`package: ${clip(name, 60)}${ver ? ` v${clip(ver, 30)}` : ''}${ed ? ` · edition ${clip(ed, 20)}` : ''}${rv ? ` · rust ≥ ${clip(rv, 20)}` : ''}`);
    const desc = tomlStr(pkg.description);
    if (desc && desc !== '(workspace)') lines.push(`description: ${clip(desc, 100)}`);
  } else {
    lines.push(ws ? 'package: (none — workspace root)' : 'package: (no [package] section)');
  }
  const deps = cargoDepNames(sections, 'dependencies');
  const dev = cargoDepNames(sections, 'dev-dependencies');
  const build = cargoDepNames(sections, 'build-dependencies');
  lines.push(`dependencies: ${deps.length}${deps.length ? ' — ' + nameList(deps) : ''}`);
  lines.push(`dev-dependencies: ${dev.length}${dev.length ? ' — ' + nameList(dev) : ''}`);
  if (build.length) lines.push(`build-dependencies: ${build.length} — ${nameList(build)}`);
  // targets: explicit [lib]/[[bin]] first, then cargo's auto-discovery
  const targets = [];
  const lib = sections.lib;
  if (lib) targets.push(`lib ${clip(tomlStr(lib.name) || tomlStr(lib.path) || 'src/lib.rs', 40)}`);
  else if (dir && fs.existsSync(path.join(dir, 'src', 'lib.rs'))) targets.push('lib src/lib.rs');
  const bins = (tables.bin || []).map((t) => tomlStr(t.name) || tomlStr(t.path) || '?');
  if (bins.length) targets.push(`bin ${nameList(bins, 10)}`);
  else if (dir && fs.existsSync(path.join(dir, 'src', 'main.rs'))) targets.push('bin src/main.rs');
  for (const k of ['example', 'test', 'bench']) if (tables[k]) targets.push(`${tables[k].length} ${k}${tables[k].length > 1 ? 's' : ''}`);
  if (targets.length) lines.push(`targets: ${targets.join(' · ')}`);
  const feats = sections.features ? Object.keys(sections.features) : [];
  if (feats.length) lines.push(`features: ${feats.length} — ${nameList(feats)}`);
  if (ws) {
    const members = tomlStrArray(ws.members);
    const excl = tomlStrArray(ws.exclude);
    lines.push(`workspace: ${members.length} member${members.length === 1 ? '' : 's'}${members.length ? ' — ' + nameList(members) : ''}${excl.length ? ` · excludes ${excl.length}` : ''}`);
    const wsDeps = cargoDepNames(sections, 'dependencies', true);
    if (wsDeps.length) lines.push(`workspace.dependencies: ${wsDeps.length} — ${nameList(wsDeps)}`);
    const wsPkg = sections['workspace.package'];
    if (wsPkg) {
      const wv = tomlStr(wsPkg.version);
      const we = tomlStr(wsPkg.edition);
      if (wv || we) lines.push(`workspace.package: ${[wv && `v${clip(wv, 30)}`, we && `edition ${clip(we, 20)}`].filter(Boolean).join(' · ')}`);
    }
  }
  return lines;
}

function npmCard(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch (err) { return [`(package.json is not valid JSON: ${clip(err.message, 100)})`]; }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return ['(package.json is not an object)'];
  const lines = [];
  const bits = [`${clip(pkg.name || '(unnamed)', 60)}${pkg.version ? ` v${clip(pkg.version, 30)}` : ''}`];
  if (pkg.type) bits.push(`type ${clip(pkg.type, 20)}`);
  if (pkg.private === true) bits.push('private');
  lines.push(`package: ${bits.join(' · ')}`);
  if (pkg.description) lines.push(`description: ${clip(pkg.description, 100)}`);
  if (pkg.engines && typeof pkg.engines === 'object') {
    lines.push(`engines: ${Object.entries(pkg.engines).map(([k, v]) => `${clip(k, 20)} ${clip(v, 30)}`).join(' · ')}`);
  }
  const entry = [];
  if (typeof pkg.main === 'string') entry.push(`main ${clip(pkg.main, 60)}`);
  if (typeof pkg.bin === 'string') entry.push(`bin ${clip(pkg.bin, 60)}`);
  else if (pkg.bin && typeof pkg.bin === 'object') entry.push(`bin ${nameList(Object.keys(pkg.bin), 5)}`);
  if (entry.length) lines.push(`entry: ${entry.join(' · ')}`);
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? Object.entries(pkg.scripts) : [];
  lines.push(`scripts: ${scripts.length}`);
  for (const [k, v] of scripts.slice(0, LIST_MAX)) lines.push(`  ${clip(k, 40)} → ${clip(v, 90)}`);
  if (scripts.length > LIST_MAX) lines.push(`  … (+${scripts.length - LIST_MAX} more scripts)`);
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const names = (pkg[key] && typeof pkg[key] === 'object') ? Object.keys(pkg[key]) : [];
    if (names.length || key === 'dependencies' || key === 'devDependencies') {
      lines.push(`${key}: ${names.length}${names.length ? ' — ' + nameList(names) : ''}`);
    }
  }
  const wsp = Array.isArray(pkg.workspaces) ? pkg.workspaces
    : (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) ? pkg.workspaces.packages : [];
  if (wsp.length) lines.push(`workspaces: ${wsp.length} — ${nameList(wsp.map(String))}`);
  return lines;
}

function goModCard(text) {
  let module = null, goVer = null, toolchain = null;
  const direct = [], indirect = [];
  let replaces = 0, excludes = 0;
  let block = null; // 'require' | 'replace' | 'exclude' | 'retract' while inside ( … )
  for (const raw of text.split(/\r?\n/)) {
    const isIndirect = /\/\/\s*indirect\b/.test(raw);
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block) {
      if (line === ')') { block = null; continue; }
      if (block === 'require') {
        const m = /^(\S+)\s+(\S+)/.exec(line);
        if (m) (isIndirect ? indirect : direct).push(`${m[1]} ${m[2]}`);
      } else if (block === 'replace') replaces++;
      else if (block === 'exclude') excludes++;
      continue;
    }
    let m;
    if ((m = /^module\s+(\S+)/.exec(line))) module = m[1].replace(/^"|"$/g, '');
    else if ((m = /^go\s+(\S+)/.exec(line))) goVer = m[1];
    else if ((m = /^toolchain\s+(\S+)/.exec(line))) toolchain = m[1];
    else if ((m = /^(require|replace|exclude|retract)\s*\($/.exec(line))) block = m[1];
    else if ((m = /^require\s+(\S+)\s+(\S+)/.exec(line))) (isIndirect ? indirect : direct).push(`${m[1]} ${m[2]}`);
    else if (/^replace\s+/.test(line)) replaces++;
    else if (/^exclude\s+/.test(line)) excludes++;
  }
  const head = [`module: ${clip(module || '(none)', 80)}`];
  if (goVer) head.push(`go ${clip(goVer, 20)}`);
  if (toolchain) head.push(`toolchain ${clip(toolchain, 30)}`);
  const lines = [head.join(' · ')];
  const total = direct.length + indirect.length;
  lines.push(`require: ${total}${indirect.length ? ` (${direct.length} direct, ${indirect.length} indirect)` : ''}${direct.length ? ' — ' + nameList(direct) : ''}`);
  if (!direct.length && indirect.length) lines.push(`  (all indirect) ${nameList(indirect, 5)}`);
  if (replaces || excludes) lines.push(`replace: ${replaces} · exclude: ${excludes}`);
  return lines;
}

function cmakeCard(text) {
  // strip # comments (line-wise; a # inside a string is rare in a CMakeLists)
  const src = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  const one = (re) => { const m = re.exec(src); return m ? m[1] : null; };
  const all = (re) => { const out = []; let m; while ((m = re.exec(src))) out.push(m); return out; };
  const lines = [];
  const proj = one(/\bproject\s*\(\s*([^)]*)\)/i);
  const minv = one(/\bcmake_minimum_required\s*\(\s*VERSION\s+([^\s)]+)/i);
  if (proj) {
    const toks = proj.trim().split(/\s+/);
    const name = toks[0] || '?';
    const vi = toks.findIndex((t) => /^VERSION$/i.test(t));
    const li = toks.findIndex((t) => /^LANGUAGES$/i.test(t));
    const langs = li >= 0 ? toks.slice(li + 1).filter((t) => !/^(VERSION|DESCRIPTION|HOMEPAGE_URL)$/i.test(t)).join(' ') : '';
    const bits = [`${clip(name, 60)}${vi >= 0 && toks[vi + 1] ? ` v${clip(toks[vi + 1], 30)}` : ''}`];
    if (langs) bits.push(`languages ${clip(langs, 40)}`);
    if (minv) bits.push(`cmake ≥ ${clip(minv, 20)}`);
    lines.push(`project: ${bits.join(' · ')}`);
  } else {
    lines.push(`project: (no project() call)${minv ? ` · cmake ≥ ${clip(minv, 20)}` : ''}`);
  }
  const std = [];
  const cxx = one(/\bset\s*\(\s*CMAKE_CXX_STANDARD\s+(\d+)/i);
  const cstd = one(/\bset\s*\(\s*CMAKE_C_STANDARD\s+(\d+)/i);
  if (cxx) std.push(`C++${cxx}`);
  if (cstd) std.push(`C${cstd}`);
  if (std.length) lines.push(`standard: ${std.join(' · ')}`);
  const exes = all(/\badd_executable\s*\(\s*([^\s)]+)/gi).map((m) => m[1]);
  const libs = all(/\badd_library\s*\(\s*([^\s)]+)(?:\s+(STATIC|SHARED|MODULE|INTERFACE|OBJECT))?/gi)
    .map((m) => m[2] ? `${m[1]} (${m[2].toUpperCase()})` : m[1]);
  lines.push(`executables: ${exes.length}${exes.length ? ' — ' + nameList(exes) : ''}`);
  lines.push(`libraries: ${libs.length}${libs.length ? ' — ' + nameList(libs) : ''}`);
  const subs = all(/\badd_subdirectory\s*\(\s*([^\s)]+)/gi).map((m) => m[1]);
  if (subs.length) lines.push(`subdirectories: ${subs.length} — ${nameList(subs)}`);
  const pkgs = all(/\bfind_package\s*\(\s*([^\s)]+)/gi).map((m) => m[1]);
  if (pkgs.length) lines.push(`find_package: ${pkgs.length} — ${nameList(pkgs)}`);
  const fetch = all(/\bFetchContent_Declare\s*\(\s*([^\s)]+)/gi).map((m) => m[1]);
  if (fetch.length) lines.push(`FetchContent: ${fetch.length} — ${nameList(fetch)}`);
  const tests = all(/\badd_test\s*\(/gi).length;
  if (/\benable_testing\s*\(/i.test(src) || tests) lines.push(`tests: ${/\benable_testing\s*\(/i.test(src) ? 'enable_testing()' : ''}${tests ? `${/\benable_testing\s*\(/i.test(src) ? ' · ' : ''}add_test × ${tests}` : ''}`);
  return lines;
}

function makefileCard(text) {
  // join backslash continuations, then walk logical lines
  const logical = text.replace(/\\\r?\n[ \t]*/g, ' ').split(/\r?\n/);
  const targets = [];
  const phony = [];
  const vars = [];
  const seen = new Set();
  for (const raw of logical) {
    if (!raw || raw.startsWith('\t') || /^\s*#/.test(raw)) continue; // recipes, comments
    const line = raw.replace(/#.*$/, '').trimEnd();
    let m;
    if ((m = /^\.PHONY\s*:\s*(.*)$/.exec(line))) { phony.push(...m[1].split(/\s+/).filter(Boolean)); continue; }
    if (/^(ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|define|endef|export|unexport|override|vpath)\b/.test(line)) continue;
    if ((m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\?|\+|:|::)?=/.exec(line))) { if (!seen.has('=' + m[1])) { seen.add('=' + m[1]); vars.push(m[1]); } continue; }
    if ((m = /^([^\s:=#][^:=#]*?)\s*::?(?![:=])/.exec(line))) {
      for (const t of m[1].split(/\s+/)) {
        if (!t || t.startsWith('.') || t.includes('%') || t.includes('$') || t.includes('(') || seen.has(t)) continue;
        seen.add(t);
        targets.push(t);
      }
    }
  }
  const lines = [];
  lines.push(`targets: ${targets.length}${targets.length ? ' — ' + nameList(targets) : ''}`);
  if (targets.length) lines.push(`default goal: ${clip(targets[0], 60)}`);
  if (phony.length) lines.push(`.PHONY: ${nameList([...new Set(phony)])}`);
  if (vars.length) lines.push(`variables: ${vars.length} — ${nameList(vars, 10)}`);
  return lines;
}

function manifestCard(abs, st) {
  const meta = manifestOf(abs);
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(MANIFEST_READ_BYTES);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let text = buf.toString('utf8', 0, n);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const truncated = st.size > n;
  const dir = path.dirname(abs);
  let body;
  try {
    body = meta.format === 'cargo' ? cargoCard(text, dir)
      : meta.format === 'npm' ? npmCard(text)
        : meta.format === 'gomod' ? goModCard(text)
          : meta.format === 'cmake' ? cmakeCard(text)
            : makefileCard(text);
  } catch (err) {
    body = [`(could not summarise: ${clip(err.message, 120)})`];
  }
  return capLines([
    `manifest: ${path.basename(abs)} (${meta.label}) · size: ${human(st.size)}${truncated ? ' · summary from the first 256 KB' : ''} · summary only — read the file for details`,
    ...body,
  ]).join('\n');
}

// ---------------------------------------------------------------------------
// Folder maps
// ---------------------------------------------------------------------------

function folderTree(abs) {
  const lines = [];
  let entries = 0;
  const MAX_ENTRIES = 120, MAX_DEPTH = 3, MAX_PER_DIR = 25;
  const walk = (dir, depth, indent) => {
    if (depth > MAX_DEPTH || entries >= MAX_ENTRIES) return;
    let kids;
    try {
      kids = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && !e.name.includes('\r'))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    } catch { return; }
    const shown = kids.slice(0, MAX_PER_DIR);
    for (const e of shown) {
      if (entries >= MAX_ENTRIES) { lines.push(`${indent}… (cap reached)`); return; }
      entries++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // build outputs & dependency dirs (target/, node_modules/, dist/, a
        // go.mod's vendor/…) are named but never descended — same rule as the
        // artifact watcher, so a `cargo build` never bloats the map
        if (isIgnoredDir(e.name, dir)) { lines.push(`${indent}${e.name}/ (ignored)`); continue; }
        let count = 0;
        try { count = fs.readdirSync(p).length; } catch { /* */ }
        lines.push(`${indent}${e.name}/ (${count} entries)`);
        walk(p, depth + 1, indent + '  ');
      } else {
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* */ }
        lines.push(`${indent}${e.name} (${human(size)})`);
      }
    }
    if (kids.length > MAX_PER_DIR) lines.push(`${indent}… ${kids.length - MAX_PER_DIR} more`);
  };
  walk(abs, 0, '');
  return lines.join('\n') || '(empty)';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate the injectable card for a data, manifest or folder pin. */
export async function pinCard(project, fileish) {
  try {
    const rel = String(fileish).replace(/\/+$/, '');
    const contained = containedPath(project, rel);
    if (!contained) return { error: `not found or outside the project: ${fileish}` };
    const { abs } = contained;
    const st = fs.statSync(abs);
    // kind from the disk, not the pin string: callers (the dashboard included)
    // strip the trailing slash folder pins are stored with, and a suffix-only
    // check then misreads every folder pin as 'code' and refuses the card
    const kind = st.isDirectory() ? 'folder' : pinKind(fileish);
    if (kind === 'code') return { error: 'code pins have no card — the session reads them' };

    // cache key: folders by 60s TTL (dir mtime is unreliable), files by mtime
    const stamp = kind === 'folder' ? Math.floor(Date.now() / 60000) : st.mtimeMs;
    const hit = CARD_CACHE.get(abs);
    if (hit && hit.stamp === stamp) return { kind, card: hit.card };

    let card;
    if (kind === 'folder') {
      if (!st.isDirectory()) return { error: `${fileish} is not a directory` };
      card = `folder map of ${rel}/:\n${folderTree(abs)}`;
    } else if (kind === 'manifest') {
      if (!st.isFile()) return { error: `${fileish} is not a file` };
      card = manifestCard(abs, st);
    } else {
      if (!st.isFile()) return { error: `${fileish} is not a file` };
      const ext = abs.split('.').pop().toLowerCase();
      card = (ext === 'csv' || ext === 'tsv')
        ? await csvCard(abs, st)
        : await binaryCard(abs, st);
    }
    CARD_CACHE.set(abs, { stamp, card });
    if (CARD_CACHE.size > 200) CARD_CACHE.delete(CARD_CACHE.keys().next().value);
    return { kind, card };
  } catch (err) {
    logErr('pinCard failed:', err.message);
    return { error: err.message };
  }
}
