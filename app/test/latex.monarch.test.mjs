// test/latex.monarch.test.mjs — S0 golden gate for the Monarch 'latex' grammar
// (latex/texLang.js, blueprint §6): the grammar runs inside REAL Monaco 0.56
// (the shipped /vendor/monaco AMD dist, headless Chrome, sandbox server — the
// uiHarness express.static pattern) over the full A13 corpus, and its output —
// normalized to the goldens' token+zone schema via monarchNormalize.mjs — must
// equal the frozen legacy fixtures run-for-run, incl. the long-20k sha256
// digest. hl.js-equivalent semantics also get direct, readable assertions:
// math-zone carry across lines, verbatim raw $, unclosed-inline-$ EOL death,
// \verb delimiters, env-name classing.
//
// A18 (binding): Monaco's DEFAULT maxTokenizationLineLength (20k) plaintexts
// the corpus's enormous single-paragraph line — probed here at 19,999 /
// 20,000 / 24,000 chars. For the corpus run the cap is raised through the
// public editor-options path so the grammar itself is validated over the full
// line; the product-facing cap policy is an S0.5/S1 decision and this probe is
// its test scaffold.
//
// bibtex is a NEW language (madoko-seeded): legacy ran .bib through the tex
// tokenizer, so refs.bib is deliberately NOT golden-compared — it gets sanity
// assertions (entry keyword, cite key, field names, values) instead.
//
// Billing safety: GET-only static assets from the CP_NO_BILLED sandbox; no
// app page is even loaded (a bare 404 document hosts the AMD loader).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startSandbox } from './serverHarness.mjs';
import { CHROME } from './uiHarness.mjs';
import { monarchGoldenLines, toMonacoText } from './latex-corpus/monarchNormalize.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'latex-corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const golden = (name) => JSON.parse(fs.readFileSync(path.join(DIR, 'goldens', `${name}.json`), 'utf8'));
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };

let sb, browser, page;

/** Tokenize in the page → per line [offset, type] pairs. */
const tok = (text, lang) => page.evaluate(
  ([t, l]) => window.__tok(t, l), [text, lang]);
/** Golden-schema lines for a corpus file under the 'latex' language. */
const latexLines = async (raw) => monarchGoldenLines(raw, await tok(toMonacoText(raw), 'latex'));

before(async () => {
  if (opts.skip) return;
  sb = await startSandbox({});
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await (await browser.newContext()).newPage();
  // a same-origin document with no app code (express's 404 page won't do: it
  // ships a default-src 'none' CSP that blocks the loader script)
  await page.route('**/__monarch-test-blank', (r) => r.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>monarch S0</title>',
  }));
  await page.goto(`${sb.base}/__monarch-test-blank`);
  await page.addScriptTag({ url: `${sb.base}/vendor/monaco/vs/loader.js` });
  const bootErr = await page.evaluate(async () => {
    try {
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      await new Promise((res, rej) => window.require(['vs/editor/editor.main'], res, rej));
      const L = await import('/latex/texLang.js');
      monaco.languages.register({ id: L.latexLanguageId });
      monaco.languages.setMonarchTokensProvider(L.latexLanguageId, L.latexMonarch());
      monaco.languages.register({ id: L.bibtexLanguageId });
      monaco.languages.setMonarchTokensProvider(L.bibtexLanguageId, L.bibtexMonarch());
      window.__tok = (text, lang) =>
        monaco.editor.tokenize(text, lang).map((line) => line.map((t) => [t.offset, t.type]));
      return null;
    } catch (e) { return String(e && e.message || e); }
  });
  assert.equal(bootErr, null, `monaco boot/registration failed: ${bootErr}`);
});
after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (sb) await sb.stop();
});

/* ── A18: the default tokenization cap, probed before it is raised ── */

test('A18 probe: default cap plaintexts lines at ≥20,000 chars (19,999 still tokenizes)', opts, async () => {
  const probe = await page.evaluate(() => {
    const mk = (n) => '\\alpha ' + 'x'.repeat(n - 8) + '$';
    const out = {};
    for (const n of [19999, 20000, 24000]) {
      const toks = window.__tok(mk(n), 'latex')[0];
      out[n] = { count: toks.length, first: toks[0] ? toks[0][1] : null };
    }
    return out;
  });
  assert.equal(probe[19999].first, 'keyword', '19,999 chars: fully tokenized');
  assert.ok(probe[19999].count > 1);
  for (const n of [20000, 24000]) {
    assert.deepEqual(probe[n], { count: 1, first: '' },
      `${n} chars: one plaintext token under the default cap (A18 — policy decided at S0.5/S1)`);
  }
});

test('raise the cap for the corpus run (public editor-options path)', opts, async () => {
  await page.evaluate(() => {
    // applyConfigurationValues: any registered editor.* key in the options bag
    // updates the global configuration service the Monarch tokenizer watches
    const ed = monaco.editor.create(document.createElement('div'), { maxTokenizationLineLength: 100000 });
    ed.dispose();
  });
  const toks = await page.evaluate(() => window.__tok('\\alpha ' + 'x'.repeat(23992) + '$', 'latex')[0]);
  assert.ok(toks.length > 1, 'a 24k line tokenizes once the cap is raised');
});

/* ── the golden gate: Monarch output == frozen legacy fixtures ── */

for (const f of manifest.files.filter((x) => x.ext !== 'bib' && x.golden === 'full')) {
  test(`monarch matches the frozen golden: ${f.name}`, opts, async () => {
    const lines = await latexLines(read(f.name));
    const want = golden(f.name).lines;
    assert.equal(lines.length, want.length, `${f.name}: line count`);
    for (let i = 0; i < want.length; i++) {
      assert.deepStrictEqual({ t: lines[i].t, z: lines[i].z }, { t: want[i].t, z: want[i].z },
        `${f.name}:${i + 1}: Monarch tokens/zones drifted from the legacy golden`);
    }
  });
}

test('monarch matches the frozen digest golden: long-20k.tex', opts, async () => {
  const f = manifest.files.find((x) => x.golden === 'digest');
  const g = golden(f.name);
  const lines = await latexLines(read(f.name));
  const canonical = JSON.stringify(lines);
  assert.equal(lines.length, g.stats.lineCount);
  assert.equal(
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
    g.sha256,
    `${f.name}: sha256 over the normalized token+zone structure drifted from the frozen digest`);
});

/* ── §6 semantic assertions — small, readable failure surfaces ── */

test('math-zone carry: an env carries across lines; \\end pops; text resumes', opts, async () => {
  const lines = await latexLines('\\begin{align}\nx &= 1\n\\end{align}\nplain x');
  assert.deepEqual(lines[1].t, [['mv', 'x'], ['', ' '], ['mo', '&='], ['', ' '], ['nm', '1']]);
  assert.deepEqual(lines[1].z, [[0, 6]]);
  assert.deepEqual(lines[3].t, [['', 'plain x']]); // back to text — x is not mv
});

test('unclosed inline $ dies at EOL — the next line tokenizes as text', opts, async () => {
  const lines = await latexLines('a $x + unclosed\nnext line words');
  assert.deepEqual(lines[0].z, [[2, 15]]);
  assert.deepEqual(lines[1].t, [['', 'next line words']]);
  assert.deepEqual(lines[1].z, []);
});

test('verbatim: raw $ stays literal; body is string-classed; math resumes after', opts, async () => {
  const lines = await latexLines('\\begin{verbatim}\nraw $x$ here\n\\end{verbatim}\n$m$');
  assert.deepEqual(lines[1].t, [['st', 'raw $x$ here']]);
  assert.deepEqual(lines[1].z, []);
  assert.deepEqual(lines[3].t, [['md', '$'], ['mv', 'm'], ['md', '$']]);
});

test('\\verb delimiters: closed, star form, and unclosed-to-EOL', opts, async () => {
  const closed = await latexLines('\\verb|x = $y$| then $m$');
  assert.deepEqual(closed[0].t.slice(0, 2), [['kw', '\\verb'], ['st', '|x = $y$|']]);
  const star = await latexLines('\\verb*|spaced $ arg| tail');
  assert.deepEqual(star[0].t.slice(0, 2), [['kw', '\\verb*'], ['st', '|spaced $ arg|']]);
  const open = await latexLines('\\verb|runs to end $ no math');
  assert.deepEqual(open[0].t, [['kw', '\\verb'], ['st', '|runs to end $ no math']]);
});

test('env-name classing: \\begin/\\end composites split kw/pt/cl/pt', opts, async () => {
  const lines = await latexLines('\\begin {spaced} body');
  assert.deepEqual(lines[0].t.slice(0, 4),
    [['kw', '\\begin'], ['pt', ' {'], ['cl', 'spaced'], ['pt', '}']]);
});

/* ── bibtex: a new language, sanity-gated (not legacy parity) ── */

test('bibtex grammar: refs.bib tokenizes with entry/field/value classes', opts, async () => {
  const raw = read('refs.bib');
  const lines = await tok(toMonacoText(raw), 'bibtex');
  const src = toMonacoText(raw).split('\n');
  assert.equal(lines.length, src.length);
  const typesSeen = new Set();
  const textOf = (li, ti) => {
    const toks = lines[li];
    const end = ti + 1 < toks.length ? toks[ti + 1][0] : src[li].length;
    return src[li].slice(toks[ti][0], end);
  };
  const byType = {};
  for (let li = 0; li < lines.length; li++) {
    for (let ti = 0; ti < lines[li].length; ti++) {
      const ty = lines[li][ti][1];
      typesSeen.add(ty);
      (byType[ty] = byType[ty] || []).push(textOf(li, ti));
    }
  }
  assert.ok(byType.keyword.includes('@article'), '@article is a keyword');
  assert.ok(byType['tag.entry-key'].some((k) => k.startsWith('rivera2024heterogeneous')), 'cite key classed');
  for (const field of ['author', 'title', 'journal', 'year']) {
    assert.ok(byType['attribute.name'].some((t) => t.trim().toLowerCase() === field), `field name ${field}`);
  }
  assert.ok(byType.string.some((t) => t.includes('Rivera')), 'brace values are strings');
  assert.ok(byType.operator.some((t) => t.trim() === '='), '= is an operator');
});
