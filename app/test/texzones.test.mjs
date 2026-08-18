// test/texzones.test.mjs — S0 gate for the shared math-zone scanner
// (blueprint §5/§6, invariant I7): texZones.scanMathZones must reproduce the
// legacy hl.js `.mzone` wash ranges EXACTLY, pinned by the frozen A13 goldens
// (test/latex-corpus/goldens/) — never by live hl.js alone. The same module
// seeds the Monarch grammar's math states (latex.monarch.test.mjs), so this
// file is the anti-drift lock between tokenizer and wash.
// Node-only: no server, no browser, no billed surface.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanMathZones, scanLineZones, TEX_ZONE_INITIAL,
  TEX_MATH_ENV, TEX_VERB_ENV, TEX_SYM,
} from '../public/latex/texZones.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'latex-corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const golden = (name) => JSON.parse(fs.readFileSync(path.join(DIR, 'goldens', `${name}.json`), 'utf8'));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

describe('texZones vs the frozen legacy goldens (I7)', () => {
  for (const f of manifest.files.filter((x) => x.golden === 'full')) {
    test(`wash ranges match golden: ${f.name}`, () => {
      const zones = scanMathZones(read(f.name));
      const want = golden(f.name).lines.map((l) => l.z);
      assert.deepStrictEqual(zones, want,
        `${f.name}: scanMathZones drifted from the frozen legacy .mzone ranges`);
    });
  }

  test('digest corpus (long-20k): zone count and line count match the frozen stats', () => {
    for (const f of manifest.files.filter((x) => x.golden === 'digest')) {
      const zones = scanMathZones(read(f.name));
      const g = golden(f.name);
      assert.equal(zones.length, g.stats.lineCount, `${f.name}: line count drifted`);
      assert.equal(zones.reduce((n, z) => n + z.length, 0), g.stats.zoneCount,
        `${f.name}: zone count drifted`);
    }
  });
});

describe('texZones behavior spec (legacy texLine parity)', () => {
  const zonesOf = (text) => scanMathZones(text);

  test('unclosed inline $ washes to EOL but dies at the line break', () => {
    const z = zonesOf('a $x + y\nplain line');
    assert.deepEqual(z[0], [[2, 8]]);
    assert.deepEqual(z[1], []); // did not carry
  });

  test('display $$ and \\[ carry across lines; closing delimiter stays inside the wash', () => {
    const z = zonesOf('$$\nx = 1\n$$\ntext\n\\[\ny\n\\]');
    assert.deepEqual(z[0], [[0, 2]]);
    assert.deepEqual(z[1], [[0, 5]]);
    assert.deepEqual(z[2], [[0, 2]]); // closing $$ inside the zone
    assert.deepEqual(z[3], []);
    assert.deepEqual(z[4], [[0, 2]]);
    assert.deepEqual(z[6], [[0, 2]]); // closing \] inside the zone
  });

  test('a single $ closes $$ display math (legacy quirk, frozen)', () => {
    const z = zonesOf('$$x$ rest');
    assert.deepEqual(z[0], [[0, 4]]); // zone ends at the lone $
  });

  test('math env: \\begin/\\end sit OUTSIDE the wash; leading indent stays outside', () => {
    const z = zonesOf('\\begin{align}\n  x &= 1\n\\end{align}');
    assert.deepEqual(z[0], []); // nothing washed after \begin{align} on its line
    assert.deepEqual(z[1], [[2, 8]]); // indent excluded
    assert.deepEqual(z[2], []); // \end line not washed
  });

  test('whitespace-only and empty lines inside a math env produce no zone', () => {
    const z = zonesOf('\\begin{equation}\n\n   \nx\n\\end{equation}');
    assert.deepEqual(z[1], []);
    assert.deepEqual(z[2], []);
    assert.deepEqual(z[3], [[0, 1]]);
  });

  test('verbatim bodies never open zones; math resumes after \\end{verbatim}', () => {
    const z = zonesOf('\\begin{verbatim}\nraw $not math$\n\\end{verbatim} $yes$');
    assert.deepEqual(z[1], []);
    assert.deepEqual(z[2], [[15, 20]]); // the $yes$ after the closing \end
  });

  test('\\verb argument is literal — its $ does not toggle math', () => {
    const z = zonesOf('\\verb|$| still text $m$');
    assert.deepEqual(z[0], [[20, 23]]);
  });

  test('escaped \\$ never opens or closes a zone', () => {
    assert.deepEqual(zonesOf('cost \\$100 here')[0], []);
    const z = zonesOf('$a \\$ b$')[0];
    assert.deepEqual(z, [[0, 8]]); // \$ inside stays inside; real $ closes
  });

  test('nested math envs are inert; only the matching \\end pops (no nesting count)', () => {
    const z = zonesOf('\\begin{equation}\n\\begin{aligned}\nx\n\\end{aligned}\n\\end{equation}\nplain');
    assert.deepEqual(z[1], [[0, 15]]); // inner \begin is washed content
    assert.deepEqual(z[5], []);
  });

  test('CR bytes ride inside logical lines (hl.js split-\\n semantics)', () => {
    const z = zonesOf('a $x\r more$\r\nnext');
    // the logical line is 'a $x\r more$\r': the mid-line CR is washed content;
    // the trailing CR falls after the closing $ flush, outside the zone
    assert.deepEqual(z[0], [[2, 11]]);
  });

  test('scanLineZones carry-state objects are interned (=== comparable)', () => {
    const a = scanLineZones('\\begin{align} x', TEX_ZONE_INITIAL);
    const b = scanLineZones('\\begin{align} y', TEX_ZONE_INITIAL);
    assert.ok(a.exit && a.exit === b.exit, 'same env must yield the identical state object');
    const c = scanLineZones('still math', a.exit);
    assert.equal(c.exit, a.exit, 'carry keeps the interned state');
    const done = scanLineZones('\\end{align}', a.exit);
    assert.equal(done.exit, null);
  });

  test('vocabulary exports stay hl.js-shaped (grammar seeds)', () => {
    assert.ok(TEX_MATH_ENV.test('align') && TEX_MATH_ENV.test('align*') && TEX_MATH_ENV.test('pmatrix'));
    assert.ok(!TEX_MATH_ENV.test('figure') && !TEX_MATH_ENV.test('alignx'));
    assert.ok(TEX_VERB_ENV.test('verbatim') && TEX_VERB_ENV.test('Verbatim*') && TEX_VERB_ENV.test('minted'));
    assert.ok(!TEX_VERB_ENV.test('verb'));
    assert.ok(TEX_SYM.has('alpha') && TEX_SYM.has('leq') && !TEX_SYM.has('frac'));
  });
});
