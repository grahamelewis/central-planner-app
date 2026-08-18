// test/latex-corpus.test.mjs — the A13 corpus gate (monaco-blueprint §13 A13,
// binding per §14). Three duties:
//   1. The manifest gate: FAIL on zero corpus files or any missing A13
//      category (the category list is embedded here so the manifest cannot
//      quietly shed one).
//   2. Category fidelity: each claimed category is demonstrably present in
//      the bytes/goldens (CRLF really is CRLF, the long file really has 20k+
//      logical lines, verbatim really swallows $, …).
//   3. The freeze: normalized token+zone output of the LIVE hl.js must equal
//      the committed goldens. Any hl.js behavior change goes red here and can
//      only be resolved by deliberately rerunning gen-goldens.mjs and
//      committing the golden diff with the change — live hl.js is never the
//      only oracle.
// No server, no browser, no billed surface: hl.js is imported directly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldenFor, logicalLines } from './latex-corpus/normalize.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'latex-corpus');
const GOLDENS = path.join(DIR, 'goldens');

// §13 A13's category list, verbatim. Do not trim: the corpus gate exists to
// fail loudly when coverage regresses.
const A13_CATEGORIES = [
  'inline-math', 'display-math', 'multiline-math',
  'nested-environments', 'malformed-environments',
  'comments', 'verbatim', 'unicode',
  'eol-lf', 'eol-crlf', 'eol-mixed', 'no-final-newline', 'bom',
  'bibtex', 'long-20k',
  'ext-tex', 'ext-sty', 'ext-cls', 'ext-bib',
];

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const byCategory = (cat) => manifest.files.filter((f) => f.categories.includes(cat));

// Recomputed goldens are needed by both the fidelity and freeze suites;
// compute each file once.
const goldenCache = new Map();
const recompute = (f) => {
  if (!goldenCache.has(f.name)) goldenCache.set(f.name, goldenFor(read(f.name), f.ext, f.golden));
  return goldenCache.get(f.name);
};
const fullLines = (f) => {
  const g = recompute(f);
  assert.equal(g.mode, 'full', `${f.name}: expected a full golden`);
  return g.lines;
};

describe('latex-corpus manifest gate (A13)', () => {
  test('manifest lists at least one corpus file', () => {
    assert.ok(Array.isArray(manifest.files), 'manifest.files must be an array');
    assert.ok(manifest.files.length > 0, 'corpus gate: ZERO files in the manifest');
  });

  test('every corpus file exists, is non-empty, and matches its declared ext', () => {
    const seen = new Set();
    for (const f of manifest.files) {
      assert.ok(!seen.has(f.name), `duplicate manifest entry: ${f.name}`);
      seen.add(f.name);
      const p = path.join(DIR, f.name);
      assert.ok(fs.existsSync(p), `missing corpus file: ${f.name}`);
      assert.ok(fs.statSync(p).size > 0, `empty corpus file: ${f.name}`);
      assert.ok(f.name.toLowerCase().endsWith('.' + f.ext), `${f.name}: declared ext "${f.ext}" does not match the filename`);
      assert.ok(Array.isArray(f.categories) && f.categories.length > 0, `${f.name}: no categories`);
      assert.ok(['full', 'digest'].includes(f.golden), `${f.name}: bad golden mode "${f.golden}"`);
    }
  });

  test('every A13 category is covered by at least one file', () => {
    const missing = A13_CATEGORIES.filter((cat) => byCategory(cat).length === 0);
    assert.deepEqual(missing, [], `corpus gate: categories with NO covering file: ${missing.join(', ')}`);
  });

  test('manifest.requiredCategories has not shed any A13 category', () => {
    const dropped = A13_CATEGORIES.filter((cat) => !manifest.requiredCategories.includes(cat));
    assert.deepEqual(dropped, [], `manifest dropped required categories: ${dropped.join(', ')}`);
    // and everything the manifest itself requires must be covered too
    const uncovered = manifest.requiredCategories.filter((cat) => byCategory(cat).length === 0);
    assert.deepEqual(uncovered, [], `requiredCategories without a covering file: ${uncovered.join(', ')}`);
  });

  test('extension categories match real file extensions', () => {
    for (const ext of ['tex', 'sty', 'cls', 'bib']) {
      const tagged = byCategory('ext-' + ext);
      assert.ok(tagged.length > 0, `no .${ext} file in the corpus`);
      for (const f of tagged) assert.equal(f.ext, ext, `${f.name} tagged ext-${ext} but declares ext "${f.ext}"`);
    }
  });
});

describe('latex-corpus category fidelity', () => {
  test('eol-lf files are pure LF', () => {
    for (const f of byCategory('eol-lf')) {
      const t = read(f.name);
      assert.ok(t.includes('\n'), `${f.name}: no newlines at all`);
      assert.ok(!t.includes('\r'), `${f.name}: claims eol-lf but contains CR bytes`);
    }
  });

  test('eol-crlf files are pure CRLF', () => {
    for (const f of byCategory('eol-crlf')) {
      const t = read(f.name);
      assert.ok(t.includes('\r\n'), `${f.name}: no CRLF sequences`);
      assert.ok(!/(?<!\r)\n/.test(t), `${f.name}: claims eol-crlf but has a bare LF`);
      assert.ok(!/\r(?!\n)/.test(t), `${f.name}: claims eol-crlf but has a bare CR`);
    }
  });

  test('eol-mixed files really mix CRLF, bare LF, and a bare CR', () => {
    for (const f of byCategory('eol-mixed')) {
      const t = read(f.name);
      assert.ok(t.includes('\r\n'), `${f.name}: no CRLF`);
      assert.ok(/(?<!\r)\n/.test(t), `${f.name}: no bare LF`);
      assert.ok(/\r(?!\n)/.test(t), `${f.name}: no bare CR (the adversarial lone \\r)`);
    }
  });

  test('no-final-newline files end without any EOL byte', () => {
    for (const f of byCategory('no-final-newline')) {
      assert.ok(!/[\r\n]$/.test(read(f.name)), `${f.name}: ends with a newline`);
    }
  });

  test('bom files start with U+FEFF', () => {
    for (const f of byCategory('bom')) {
      assert.equal(read(f.name).charCodeAt(0), 0xfeff, `${f.name}: no BOM at byte zero`);
    }
  });

  test('long-20k files have more than 20,000 logical lines', () => {
    for (const f of byCategory('long-20k')) {
      const n = logicalLines(read(f.name));
      assert.ok(n > 20000, `${f.name}: only ${n} logical lines`);
    }
  });

  test('unicode files contain non-ASCII codepoints', () => {
    for (const f of byCategory('unicode')) {
      // strip a BOM first so it can never satisfy the check by itself
      assert.ok(/[^\x00-\x7F]/.test(read(f.name).replace(/^\uFEFF/, '')), `${f.name}: pure ASCII`);
    }
  });

  test('bibtex files contain real entry syntax', () => {
    for (const f of byCategory('bibtex')) {
      assert.ok(/@[A-Za-z]+\s*\{/.test(read(f.name)), `${f.name}: no @entry{ syntax`);
    }
  });

  test('malformed-environments files have unbalanced begin/end counts', () => {
    for (const f of byCategory('malformed-environments')) {
      const t = read(f.name);
      const begins = (t.match(/\\begin\{/g) || []).length;
      const ends = (t.match(/\\end\{/g) || []).length;
      assert.notEqual(begins, ends, `${f.name}: \\begin{/\\end{ counts balance (${begins}) — not malformed`);
    }
  });

  test('nested-environments files open and close several distinct environments', () => {
    for (const f of byCategory('nested-environments')) {
      const t = read(f.name);
      const paired = ['figure', 'minipage', 'tabular', 'itemize', 'enumerate', 'equation']
        .filter((e) => t.includes(`\\begin{${e}}`) && t.includes(`\\end{${e}}`));
      assert.ok(paired.length >= 4, `${f.name}: only ${paired.length} fully-paired nested envs`);
    }
  });

  test('inline-math goldens show a zone that does not span its whole line', () => {
    for (const f of byCategory('inline-math').filter((x) => x.golden === 'full')) {
      const hit = fullLines(f).some((ln) => {
        const len = ln.t.reduce((n, tok) => n + tok[1].length, 0);
        return ln.z.some(([s, e]) => s > 0 || e < len);
      });
      assert.ok(hit, `${f.name}: no inline (partial-line) math zone found`);
    }
  });

  test('display-math goldens show a fully-washed line', () => {
    for (const f of byCategory('display-math').filter((x) => x.golden === 'full')) {
      const hit = fullLines(f).some((ln) => {
        const len = ln.t.reduce((n, tok) => n + tok[1].length, 0);
        return len > 0 && ln.z.length === 1 && ln.z[0][0] === 0 && ln.z[0][1] === len;
      });
      assert.ok(hit, `${f.name}: no edge-to-edge display zone found`);
    }
  });

  test('multiline-math goldens carry a zone onto a delimiter-free line', () => {
    for (const f of byCategory('multiline-math').filter((x) => x.golden === 'full')) {
      const src = read(f.name).split('\n');
      const hit = fullLines(f).some((ln, i) =>
        ln.z.length > 0 && !/[$]|\\\[|\\\]|\\begin/.test(src[i]));
      assert.ok(hit, `${f.name}: no carried math zone on a delimiter-free line`);
    }
  });

  test('verbatim goldens hold a literal $ inside verbatim text', () => {
    for (const f of byCategory('verbatim').filter((x) => x.golden === 'full')) {
      const hit = fullLines(f).some((ln) =>
        ln.z.length === 0 && ln.t.some(([cls, txt]) => cls === 'st' && txt.includes('$')));
      assert.ok(hit, `${f.name}: no zone-free literal $ inside verbatim`);
    }
  });

  test('comments goldens contain comment tokens', () => {
    for (const f of byCategory('comments')) {
      if (f.golden === 'full') {
        const hit = fullLines(f).some((ln) => ln.t.some(([cls]) => cls === 'cm'));
        assert.ok(hit, `${f.name}: no cm token in golden`);
      } else {
        assert.ok((recompute(f).stats.classCounts.cm || 0) > 0, `${f.name}: digest shows zero cm tokens`);
      }
    }
  });

  test('digest-mode math coverage is substantial (long-20k)', () => {
    for (const f of byCategory('long-20k')) {
      const g = recompute(f);
      assert.equal(g.mode, 'digest', `${f.name}: expected digest golden`);
      assert.ok(g.stats.zoneCount > 1000, `${f.name}: only ${g.stats.zoneCount} math zones`);
      assert.ok(g.stats.lineCount > 20000, `${f.name}: only ${g.stats.lineCount} tokenized lines`);
    }
  });
});

describe('latex-corpus frozen legacy goldens (hl.js is not the only oracle)', () => {
  test('a committed golden exists for every corpus file', () => {
    for (const f of manifest.files) {
      assert.ok(fs.existsSync(path.join(GOLDENS, `${f.name}.json`)),
        `missing golden for ${f.name} — run: node test/latex-corpus/gen-goldens.mjs (deliberately) and commit it`);
    }
  });

  test('no orphan goldens', () => {
    const expected = new Set(manifest.files.map((f) => `${f.name}.json`));
    for (const g of fs.readdirSync(GOLDENS)) {
      assert.ok(expected.has(g), `orphan golden with no corpus file: goldens/${g}`);
    }
  });

  for (const f of manifest.files) {
    test(`golden frozen: ${f.name} (${f.golden})`, () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(GOLDENS, `${f.name}.json`), 'utf8'));
      assert.deepStrictEqual(recompute(f), fixture,
        `${f.name}: live hl.js output drifted from the frozen golden. If (and only if) `
        + 'this change to hl.js/the corpus is deliberate and reviewed, regenerate via '
        + '"node test/latex-corpus/gen-goldens.mjs" and commit the golden diff with it.');
    });
  }
});
