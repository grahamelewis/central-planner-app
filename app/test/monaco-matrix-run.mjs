#!/usr/bin/env node
// test/monaco-matrix-run.mjs — the A14 evidence-matrix RUNNER (Phase 3 S2.EXIT).
//
// Executes every suite file cited in test/monaco-matrix.md and records the
// result as test/monaco-matrix-run.json — the RECORDED RUN the standing
// verifier (monaco-matrix.test.mjs) consumes. CONTRACT "Ladder & exit gates"
// (A14): matrix verification consumes a recorded test-run artifact — commit
// SHA, editor-implementation mode, per-test pass/fail, per-mode skips, and
// dated manual-evidence entries; proving a cited test title exists is
// reference-checking, not verification.
//
// BILLING-SAFE BY CONSTRUCTION: this script shells out ONLY to
// `node --test --test-reporter=tap <file>` on validated *.test.mjs paths
// inside test/ — it never opens a socket, never touches a route, and the
// suites it runs carry their own two billing layers (browser-side route
// interception + the sandbox server's CP_NO_BILLED=1 hard block).
//
// SERIAL: one `node --test` child at a time (one suite file each), so peak
// headless-Chrome count matches a single suite — never the parallel wall.
//
// Usage: cd app && node test/monaco-matrix-run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(TEST_DIR);
export const MATRIX_PATH = path.join(TEST_DIR, 'monaco-matrix.md');
export const RUN_PATH = path.join(TEST_DIR, 'monaco-matrix-run.json');

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.test\.mjs$/;

/* ── matrix parsing (shared with the verifier) ─────────────────────────── */

/**
 * Parse monaco-matrix.md into rows. Format (anchored at column 0):
 *   `## <id> — <name>` opens a row (P\d+ | E\d+ | G\d+ | MX);
 *   `- [monaco|unit] \`file\` :: \`title\`` cites a recorded test;
 *   `- [manual] S2b-GATED (YYYY-MM-DD): note` is a dated manual placeholder.
 * The indented format-spec bullets in the header never match (anchoring).
 * @returns {{ rows: Map<string, { id: string, name: string,
 *             citations: { mode: string, file: string, title: string, line: number }[],
 *             manual: { date: string, note: string, line: number }[] }>,
 *             problems: string[] }}
 */
export function parseMatrix(text) {
  const rows = new Map();
  const problems = [];
  let cur = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const head = /^## (P\d+|E\d+|G\d+|MX) — (.+)$/.exec(ln);
    if (head) {
      if (rows.has(head[1])) problems.push(`line ${i + 1}: duplicate row heading ${head[1]}`);
      cur = { id: head[1], name: head[2].trim(), citations: [], manual: [] };
      rows.set(cur.id, cur);
      continue;
    }
    if (/^## /.test(ln)) { cur = null; continue; } // any other heading closes the row
    const cite = /^- \[(monaco|unit)\] `([^`]+)` :: `(.+)`\s*$/.exec(ln);
    if (cite) {
      if (!cur) { problems.push(`line ${i + 1}: citation outside any row: ${ln}`); continue; }
      if (!FILE_RE.test(cite[2])) problems.push(`line ${i + 1}: bad file name in citation: ${cite[2]}`);
      cur.citations.push({ mode: cite[1], file: cite[2], title: cite[3], line: i + 1 });
      continue;
    }
    const man = /^- \[manual\] S2b-GATED \((\d{4}-\d{2}-\d{2})\): (.+)$/.exec(ln);
    if (man) {
      if (!cur) { problems.push(`line ${i + 1}: manual row outside any row`); continue; }
      cur.manual.push({ date: man[1], note: man[2].trim(), line: i + 1 });
      continue;
    }
    if (/^- \[/.test(ln)) problems.push(`line ${i + 1}: malformed evidence bullet: ${ln}`);
  }
  return { rows, problems };
}

/* ── TAP parsing ───────────────────────────────────────────────────────── */

/** TAP escapes `\` and `#` in test names; undo exactly those two. */
const unescapeTap = (s) => s.replace(/\\([\\#])/g, '$1');

/**
 * Parse `node --test --test-reporter=tap` output into flat test points.
 * Points at every nesting depth are recorded; the YAML diagnostic block that
 * follows each point (`type: 'test' | 'suite'`) classifies leaf vs suite.
 * @returns {{ title: string, status: 'pass'|'fail'|'skip'|'todo',
 *             type: 'test'|'suite', skipReason?: string }[]}
 */
export function parseTap(out) {
  const points = [];
  let pending = null; // last point, still awaiting its YAML `type:`
  for (const raw of out.split('\n')) {
    const m = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(raw);
    if (m) {
      let rest = m[3];
      let status = m[2] === 'ok' ? 'pass' : 'fail';
      let skipReason;
      // directive: a RAW ` # ` can only be a directive (name-# is escaped \#)
      const d = / # (SKIP|TODO)\b\s*(.*)$/.exec(rest);
      if (d) {
        rest = rest.slice(0, d.index);
        if (m[2] === 'ok') { status = d[1] === 'SKIP' ? 'skip' : 'todo'; skipReason = d[2] || undefined; }
      }
      pending = { title: unescapeTap(rest.trim()), status, type: 'test' };
      if (skipReason) pending.skipReason = skipReason;
      points.push(pending);
      continue;
    }
    if (pending) {
      const ty = /^\s*type: '(test|suite)'$/.exec(raw);
      if (ty) { pending.type = ty[1]; pending = null; continue; }
      if (/^\s*\.\.\.$/.test(raw)) { pending = null; continue; } // YAML block closed without a type
    }
  }
  return points;
}

/** Implementation mode from the testMonaco title suffix. */
export function modeOfTitle(title) {
  if (title.endsWith(' [impl=monaco]')) return 'monaco';
  return 'untagged';
}

/* ── the run ───────────────────────────────────────────────────────────── */

function git(args) {
  return execFileSync('git', args, { cwd: APP_ROOT, encoding: 'utf8' }).trim();
}

function main() {
  const t0 = Date.now();
  const { rows, problems } = parseMatrix(fs.readFileSync(MATRIX_PATH, 'utf8'));
  if (problems.length) {
    console.error('monaco-matrix.md parse problems:\n  ' + problems.join('\n  '));
    process.exit(2);
  }

  // The cited suite files — validated, deduped, matrix order. The verifier
  // itself is never citable (no recursion by construction).
  const files = [];
  for (const row of rows.values()) {
    for (const c of row.citations) {
      if (c.file === 'monaco-matrix.test.mjs') {
        console.error(`refusing self-citation at matrix line ${c.line}`);
        process.exit(2);
      }
      if (!files.includes(c.file)) files.push(c.file);
    }
  }
  for (const f of files) {
    if (!FILE_RE.test(f) || !fs.existsSync(path.join(TEST_DIR, f))) {
      console.error(`cited suite file missing or invalid: ${f}`);
      process.exit(2);
    }
  }

  let sha = null;
  let dirty = null;
  try {
    sha = git(['rev-parse', 'HEAD']);
    dirty = git(['status', '--porcelain']).length > 0;
  } catch (err) {
    console.error(`WARNING: git unavailable (${err.message}) — recording sha:null (the verifier will refuse to trust this run)`);
  }

  const perTest = [];
  const fileRecords = [];
  const runErrors = [];
  console.log(`A14 matrix run — ${files.length} cited suite files, serial, node --test tap\n`);
  for (const f of files) {
    const ft0 = Date.now();
    const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join('test', f)], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 600_000,
      env: process.env,
    });
    const dur = Date.now() - ft0;
    const points = parseTap(res.stdout || '');
    const leaves = points.filter((p) => p.type === 'test');
    if (res.error || leaves.length === 0) {
      const why = res.error ? String(res.error.message || res.error) : 'no test points parsed';
      runErrors.push({ file: f, error: why, stderr: (res.stderr || '').slice(-2000) });
      perTest.push({ file: f, title: `<suite failed to run: ${why}>`, status: 'fail', mode: 'untagged', type: 'test' });
      fileRecords.push({ file: f, durationMs: dur, pass: 0, fail: 1, skip: 0 });
      console.log(`  ✗ ${f} — RUN ERROR (${why}) in ${(dur / 1000).toFixed(1)}s`);
      continue;
    }
    let pass = 0; let fail = 0; let skip = 0;
    for (const p of leaves) {
      const mode = modeOfTitle(p.title);
      const rec = { file: f, title: p.title, status: p.status, mode, type: p.type };
      if (p.skipReason) rec.skipReason = p.skipReason;
      perTest.push(rec);
      if (p.status === 'pass') pass++;
      else if (p.status === 'skip' || p.status === 'todo') skip++;
      else fail++;
    }
    // suite-level points are recorded too (harmless for matching, useful audit)
    for (const p of points.filter((q) => q.type === 'suite')) {
      perTest.push({ file: f, title: p.title, status: p.status, mode: modeOfTitle(p.title), type: 'suite' });
    }
    fileRecords.push({ file: f, durationMs: dur, pass, fail, skip });
    const mark = fail ? '✗' : '✓';
    console.log(`  ${mark} ${f} — ${pass} pass, ${fail} fail, ${skip} skip in ${(dur / 1000).toFixed(1)}s`);
  }

  const leaves = perTest.filter((p) => p.type === 'test');
  const modes = {};
  for (const m of ['monaco', 'untagged']) modes[m] = { pass: 0, fail: 0, skip: 0 };
  for (const p of leaves) {
    const bucket = modes[p.mode];
    bucket[p.status === 'pass' ? 'pass' : (p.status === 'skip' || p.status === 'todo') ? 'skip' : 'fail']++;
  }
  const perModeSkips = leaves
    .filter((p) => p.status === 'skip' || p.status === 'todo')
    .map((p) => ({ file: p.file, title: p.title, mode: p.mode, reason: p.skipReason || null }));

  const manualEvidence = [];
  for (const row of rows.values()) {
    for (const man of row.manual) {
      manualEvidence.push({ row: row.id, date: man.date, note: man.note, status: 's2b-gated' });
    }
  }

  const record = {
    artifact: 'A14 monaco evidence-matrix recorded run (CONTRACT Phase 3, Ladder & exit gates)',
    matrix: 'monaco-matrix.md',
    sha,
    dirty,
    date: new Date().toISOString(),
    node: process.version,
    durationMs: Date.now() - t0,
    files: fileRecords,
    modes,
    perTest,
    perModeSkips,
    manualEvidence,
    runErrors,
  };
  fs.writeFileSync(RUN_PATH, JSON.stringify(record, null, 1) + '\n');

  const totFail = fileRecords.reduce((a, r) => a + r.fail, 0);
  const totPass = fileRecords.reduce((a, r) => a + r.pass, 0);
  const totSkip = fileRecords.reduce((a, r) => a + r.skip, 0);
  console.log(`\nrecorded ${RUN_PATH}`);
  console.log(`sha ${sha}${dirty ? ' (DIRTY tree)' : ''} — ${totPass} pass / ${totFail} fail / ${totSkip} skip across ${files.length} files in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`modes: monaco ${modes.monaco.pass}✓/${modes.monaco.fail}✗/${modes.monaco.skip}−  untagged ${modes.untagged.pass}✓/${modes.untagged.fail}✗/${modes.untagged.skip}−`);
  console.log(`manual (S2b-gated) placeholders recorded: ${manualEvidence.length}`);
  process.exit(totFail ? 1 : 0);
}

// Run only when invoked directly — the verifier imports the parsers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
