// test/latex-corpus/normalize.mjs — shared normalization for the A13 legacy
// goldens (monaco-blueprint §13 A13 / §14). Runs the CURRENT hl.js tokenizer
// (hlText — DOM-free) over a corpus file and reduces its HTML to a stable
// token+zone structure:
//
//   { ext, lines: [ { t: [[cls, text], ...], z: [[startCol, endCol], ...] } ] }
//
//   - lines follow hlText's own split('\n') semantics (CR bytes stay inside
//     their logical line, exactly as the legacy tokenizer sees them);
//   - t: token runs; adjacent tokens with the same class AND the same
//     math-zone membership are merged (normalization), so future tokenizers
//     that chunk differently can still be compared run-for-run;
//   - z: per-line column ranges covered by the .mzone math wash — the ranges
//     texZones.scanMathZones() must reproduce (invariant I7);
//   - round-trip is asserted: concatenated token text must equal the source
//     line byte-for-byte, or normalization throws.
//
// Both gen-goldens.mjs (the deliberate regenerator) and latex-corpus.test.mjs
// (the freeze gate) import from here so there is exactly one normalization.
import { createHash } from 'node:crypto';
import { hlText } from '../../public/hl.js';

const UNESC = { amp: '&', lt: '<', gt: '>', quot: '"' };
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, n) => UNESC[n]);

/** Count logical lines with universal-newline semantics (LF, CRLF, bare CR). */
export function logicalLines(text) {
  return String(text).split(/\r\n|\r|\n/).length;
}

/* Parse one line of hlText output. The HTML grammar is tiny and regular:
   escaped text, <span class="X">escaped</span>, and one nesting level of
   <span class="mzone"> wrapping a run of those two. Escaping guarantees no
   raw '<' inside text, so indexOf-based scanning is exact. */
function parseLine(html) {
  const toks = []; // merged [cls, text] runs
  const zones = []; // [startCol, endCol] mzone ranges
  let col = 0;

  const put = (cls, text, inZone) => {
    if (!text) return;
    const last = toks.length ? toks[toks.length - 1] : null;
    if (last && last[0] === cls && last[3] === inZone) last[1] += text;
    else toks.push([cls, text, 0, inZone]);
    col += text.length;
  };

  let i = 0;
  const readSimple = (inZone) => {
    // at '<span class="', not mzone
    const q = html.indexOf('"', i + 13);
    const cls = html.slice(i + 13, q);
    const end = html.indexOf('</span>', q + 2);
    if (end < 0) throw new Error('unterminated <span> in hlText output');
    put(cls, unesc(html.slice(q + 2, end)), inZone);
    i = end + 7;
  };
  const readText = (inZone, stopAt) => {
    let j = html.indexOf('<', i);
    if (j < 0) j = html.length;
    if (stopAt != null && j > stopAt) j = stopAt;
    put('', unesc(html.slice(i, j)), inZone);
    i = j;
  };

  while (i < html.length) {
    if (html.startsWith('<span class="mzone">', i)) {
      i += 20;
      const zStart = col;
      while (!html.startsWith('</span>', i)) {
        if (i >= html.length) throw new Error('unterminated mzone span');
        if (html.startsWith('<span class="', i)) readSimple(true);
        else readText(true);
      }
      zones.push([zStart, col]);
      i += 7;
    } else if (html.startsWith('<span class="', i)) {
      readSimple(false);
    } else {
      readText(false);
    }
  }
  return { t: toks.map(([cls, text]) => [cls, text]), z: zones };
}

/** Normalize a whole file through the live hl.js. Throws on any structural
 *  surprise (unknown ext, line-count drift, round-trip mismatch). */
export function normalizeFile(text, ext) {
  text = String(text);
  const html = hlText(text, ext);
  if (html == null) throw new Error(`hl.js has no highlighter for ext "${ext}"`);
  const srcLines = text.split('\n');
  const htmlLines = html.split('\n');
  if (htmlLines.length !== srcLines.length + 1 || htmlLines[htmlLines.length - 1] !== '') {
    throw new Error(`hlText line structure drifted: ${htmlLines.length - 1} html lines for ${srcLines.length} source lines`);
  }
  const lines = [];
  for (let n = 0; n < srcLines.length; n++) {
    const rec = parseLine(htmlLines[n]);
    const joined = rec.t.map((tok) => tok[1]).join('');
    if (joined !== srcLines[n]) {
      throw new Error(`round-trip mismatch at line ${n + 1}: ${JSON.stringify(joined.slice(0, 80))} !== ${JSON.stringify(srcLines[n].slice(0, 80))}`);
    }
    lines.push(rec);
  }
  return { ext, lines };
}

/** Build the golden record for a corpus file.
 *  mode 'full'   → the complete normalized structure (reviewable fixture);
 *  mode 'digest' → sha256 of the canonical structure + summary stats (for the
 *                  20k+ line file, whose full JSON would be megabytes). */
export function goldenFor(text, ext, mode) {
  const norm = normalizeFile(text, ext);
  if (mode === 'full') return { mode: 'full', ext, lines: norm.lines };
  if (mode !== 'digest') throw new Error(`unknown golden mode "${mode}"`);
  const canonical = JSON.stringify(norm.lines);
  const classCounts = {};
  let tokenCount = 0;
  let zoneCount = 0;
  for (const line of norm.lines) {
    tokenCount += line.t.length;
    zoneCount += line.z.length;
    for (const [cls] of line.t) {
      const key = cls === '' ? 'plain' : cls;
      classCounts[key] = (classCounts[key] || 0) + 1;
    }
  }
  const sorted = {};
  for (const k of Object.keys(classCounts).sort()) sorted[k] = classCounts[k];
  return {
    mode: 'digest',
    ext,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    stats: {
      lineCount: norm.lines.length,
      tokenCount,
      zoneCount,
      charCount: String(text).length,
      classCounts: sorted,
    },
  };
}
