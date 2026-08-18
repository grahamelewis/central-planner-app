// lib/synctex.js — thin wrappers around the TeX Live `synctex` CLI for
// source↔PDF navigation. Requires the .synctex.gz produced by compiling with
// -synctex=1 (both latexmk spawns pass it). spawn with an args array, never a
// shell string; 5s timeout; absent binary → a clear error, never a crash.
import path from 'path';
import { spawn } from 'child_process';

function run(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('synctex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ error: err.message });
      return;
    }
    let out = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      done({ error: 'synctex timed out' });
    }, 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => { /* version banner noise */ });
    child.on('error', (err) => done({
      error: err.code === 'ENOENT' ? 'synctex not found on the server PATH (install TeX Live)' : err.message,
    }));
    child.on('exit', () => done({ out }));
  });
}

const num = (block, key) => {
  const m = block.match(new RegExp(`^${key}:(-?[\\d.]+)`, 'm'));
  return m ? Number(m[1]) : null;
};

/** Source → PDF. line/col in `tex` (abs path) → { page, x, y, h, v, W, H }
 *  in PDF units (points, origin top-left as synctex reports). */
export async function synctexView({ tex, line, col, pdf }) {
  // pdflatex records inputs as it saw them (often ./relative); try the abs
  // path first, then the ./basename form for older synctex files
  for (const input of [tex, `./${path.basename(tex)}`]) {
    const r = await run(['view', '-i', `${line}:${col || 1}:${input}`, '-o', pdf]);
    if (r.error) return r;
    const block = r.out.slice(r.out.indexOf('SyncTeX result begin'));
    const page = num(block, 'Page');
    if (page != null) {
      return {
        page,
        x: num(block, 'x'), y: num(block, 'y'),
        h: num(block, 'h'), v: num(block, 'v'),
        W: num(block, 'W'), H: num(block, 'H'),
      };
    }
  }
  return { error: 'no synctex match for that line (rebuild with -synctex=1?)' };
}

/** PDF → source. page/x/y (PDF points) → { file, line, column }.
 *  `file` comes back as synctex recorded it — caller resolves + contains it. */
export async function synctexEdit({ pdf, page, x, y }) {
  const r = await run(['edit', '-o', `${page}:${x}:${y}:${pdf}`]);
  if (r.error) return r;
  const block = r.out.slice(r.out.indexOf('SyncTeX result begin'));
  const fm = block.match(/^Input:(.*)$/m);
  const line = num(block, 'Line');
  if (!fm || line == null) return { error: 'no source location at that point' };
  return { file: fm[1].trim(), line, column: num(block, 'Column') ?? 0 };
}
