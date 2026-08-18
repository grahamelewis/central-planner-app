// test/latex-corpus/monarchNormalize.mjs — reduce Monarch tokenizer output to
// the SAME normalized token+zone schema the frozen legacy goldens use
// (normalize.mjs): lines of { t: [[cls, text], …], z: [[startCol, endCol], …] }.
//
// The Monarch grammar cannot express the mzone wash (token backgrounds are
// dead in the standalone theme service — blueprint §6), so `z` comes from
// texZones.scanMathZones — the same shared module that seeds the grammar's
// math states (invariant I7). Tokens are split at zone boundaries and merged
// with normalize.mjs's exact rule (adjacent runs merge only when class AND
// zone membership agree), so run boundaries line up with the legacy fixtures.
//
// CR handling: Monaco's tokenize() splits lines on /\r\n|\r|\n/, while the
// legacy tokenizer splits on '\n' only (CR bytes stay inside their logical
// line). The caller therefore replaces every \r with U+2028 BEFORE tokenizing
// (Monaco does not split on U+2028; JS `.` excludes it exactly as it excludes
// \r, so `%.*`-style rules behave identically) and this module maps the
// sentinel back to \r when reconstructing token texts.
import { scanMathZones } from '../../public/latex/texZones.js';

/** Monarch token class → legacy hl.js class (goldens vocabulary). */
export const MONARCH_TO_LEGACY = {
  '': '',
  white: '',
  source: '',
  keyword: 'kw',
  'keyword.symbol.math': 'ms',
  'variable.math': 'mv',
  'operator.math': 'mo',
  'delimiter.math': 'md',
  comment: 'cm',
  number: 'nm',
  punctuation: 'pt',
  'tag.env': 'cl',
  string: 'st',
  warn: 'wn',
};

export const CR_SENTINEL = '\u2028';

/** Feed a raw corpus text to the browser side: \r → U+2028. */
export function toMonacoText(text) {
  return String(text).replace(/\r/g, CR_SENTINEL);
}

/**
 * Build golden-schema lines from Monarch tokenization.
 * @param {string} rawText the ORIGINAL corpus bytes (with real \r)
 * @param {[number, string][][]} monacoLines per line: [offset, type] pairs,
 *   from monaco.editor.tokenize(toMonacoText(rawText), 'latex')
 * @returns {{ t: [string, string][], z: [number, number][] }[]}
 */
export function monarchGoldenLines(rawText, monacoLines) {
  const sent = toMonacoText(rawText);
  const srcLines = sent.split('\n');
  if (monacoLines.length !== srcLines.length) {
    throw new Error(`monaco line count ${monacoLines.length} != source ${srcLines.length}`);
  }
  const zonesPerLine = scanMathZones(String(rawText));

  return srcLines.map((line, li) => {
    const toks = monacoLines[li];
    const zones = zonesPerLine[li];

    // 1. reconstruct [cls, text] fragments, restoring \r
    const frags = [];
    for (let i = 0; i < toks.length; i++) {
      const [offset, type] = toks[i];
      const end = i + 1 < toks.length ? toks[i + 1][0] : line.length;
      if (end <= offset) continue;
      const cls = MONARCH_TO_LEGACY[type];
      if (cls === undefined) throw new Error(`unmapped monarch token type "${type}" at line ${li + 1}`);
      frags.push({ start: offset, end, cls });
    }
    // monaco emits no token for an empty line; also cover any leading gap
    let covered = 0;
    for (const f of frags) {
      if (f.start > covered) throw new Error(`token gap at line ${li + 1} col ${covered}`);
      covered = f.end;
    }
    if (covered < line.length) throw new Error(`tokens stop at ${covered} < ${line.length} on line ${li + 1}`);

    // 2. split fragments at zone boundaries and tag membership
    const cuts = new Set();
    for (const [s, e] of zones) { cuts.add(s); cuts.add(e); }
    const inZone = (pos) => zones.some(([s, e]) => pos >= s && pos < e);
    const pieces = [];
    for (const f of frags) {
      let s = f.start;
      const inner = [...cuts].filter((c) => c > f.start && c < f.end).sort((a, b) => a - b);
      for (const c of [...inner, f.end]) {
        pieces.push({ cls: f.cls, text: line.slice(s, c).replace(/\u2028/g, '\r'), z: inZone(s) });
        s = c;
      }
    }

    // 3. merge with the legacy rule: same class AND same zone membership
    const t = [];
    for (const p of pieces) {
      if (!p.text) continue;
      const last = t.length ? t[t.length - 1] : null;
      if (last && last[0] === p.cls && last[2] === p.z) last[1] += p.text;
      else t.push([p.cls, p.text, p.z]);
    }
    return { t: t.map(([cls, text]) => [cls, text]), z: zones };
  });
}
