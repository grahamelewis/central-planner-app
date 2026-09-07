// test/ui.monaco-langs.test.mjs — wave 1 language support in the editor
// (docs/language-support/RUNTIMES.md, editor row):
//   A. one file per language is opened through the REAL tab path and we
//      assert (1) the model's language id is the one langFor maps the
//      extension to (rust / go / javascript / typescript / c / cpp, plus the
//      ride-alongs: Cargo.toml → ini, Makefile → shell, package.json → json,
//      *.yml → yaml), (2) the lazily-loaded grammar actually colours the
//      first line — at least one rendered token carries a non-default class
//      (Monaco's default foreground is mtk1; a plaintext line is ONE mtk1
//      span), (3) no page errors and no degraded language chunks;
//   B. the rest of the extension table (the variants of the same languages
//      and the labelled-plaintext files: go.mod / go.sum / CMakeLists.txt /
//      *.cmake) is pinned through the __mp.setFile seam, which runs the same
//      createFor → langFor path without needing a tab (the strip caps at 12).
// Billing-safe: armPage() intercepts billed routes; the suite touches GET
// routes and the unbilled /api/tasks POST only. Skips when Chrome is absent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, armPage, CHROME } from './uiHarness.mjs';

const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

/* [rel, expected Monaco id, text] — the FIRST line of every fixture carries
   a keyword / directive / table / key / comment, so a grammar that loaded
   shows a non-mtk1 span there. 12 entries: the workbench shows at most 12
   context tabs. */
const FILES = [
  ['hello.rs', 'rust', 'fn main() {\n    println!("hello");\n}\n'],
  ['main.go', 'go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n'],
  ['index.ts', 'typescript', 'const greeting: string = "hi";\nexport function hello(): string { return greeting; }\n'],
  ['app.tsx', 'typescript', 'import React from "react";\nexport const App = () => <div>{"hi"}</div>;\n'],
  ['util.js', 'javascript', 'export function add(a, b) { return a + b; }\n'],
  ['main.c', 'c', '#include <stdio.h>\nint main(void) { printf("hi\\n"); return 0; }\n'],
  ['main.cpp', 'cpp', '#include <iostream>\nint main() { std::cout << "hi"; return 0; }\n'],
  ['header.hpp', 'cpp', '#ifndef HEADER_HPP\n#define HEADER_HPP\nint add(int a, int b);\n#endif\n'],
  ['Cargo.toml', 'ini', '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n'],
  ['Makefile', 'shell', '# build the demo\nCC ?= cc\nall: hello\n\t$(CC) -o hello main.c\n'],
  ['package.json', 'json', '{"name": "hello", "version": "1.0.0",\n  "scripts": {"start": "node util.js"}\n}\n'],
  ['config.yml', 'yaml', '# service config\nname: hello\n'],
];

/* B — the rest of langFor's wave-1 table, [ext as the workbench sends it
   (basename(rel).split('.').pop().toLowerCase()), expected id]. Dotless names arrive
   whole: Makefile → 'makefile', GNUmakefile → 'gnumakefile'. */
const EXT_TABLE = [
  ['mjs', 'javascript'], ['cjs', 'javascript'], ['jsx', 'javascript'],
  ['mts', 'typescript'], ['cts', 'typescript'],
  ['h', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['c++', 'cpp'], ['hxx', 'cpp'], ['hh', 'cpp'],
  ['toml', 'ini'], ['yaml', 'yaml'],
  ['makefile', 'shell'], ['gnumakefile', 'shell'], ['mk', 'shell'],
  ['mod', 'plaintext'], ['sum', 'plaintext'], ['cmake', 'plaintext'], ['txt', 'plaintext'],
  // the pre-existing map, untouched
  ['jl', 'julia'], ['py', 'python'], ['r', 'r'], ['sh', 'shell'], ['sql', 'sql'], ['md', 'markdown'],
  ['tex', 'latex'], ['bib', 'bibtex'], ['m', 'plaintext'], ['rmd', 'markdown'],
];

let ui, sb, taskId;
before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      for (const [rel, , text] of FILES) fs.writeFileSync(path.join(projRoots.alpha, rel), text);
      for (const rel of ['build/Makefile', 'tools/GNUmakefile']) {
        const file = path.join(projRoots.alpha, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '# nested build script\nall:\n\techo hello\n');
      }
    },
  });
  ({ sb } = ui);
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'monaco langs', category: 'calibration', oversight: 'manual',
    context: { files: FILES.map(([rel]) => rel) },
  });
  taskId = task.id;
});
after(async () => { if (ui) await ui.stop(); });

/** Boot READY + the kept editor live on `fkey` inside the visible dock. */
const waitEditor = (page, fkey, timeout = 25000) => page.waitForFunction((fk) => (
  window.__mp && window.__mp.state() === 'READY' && window.__mp.activeFkey() === fk
  && !!document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor')
), fkey, { timeout, polling: 100 });

/* The rendered first line's token classes, once (a) the line on screen IS
   the fixture's first line (a tab switch repaints a frame later) and (b)
   the lazily-loaded grammar has produced a non-default token. Resolves with
   the class list; times out → the grammar never coloured the line. */
const firstLineClasses = (page, firstLine, timeout = 20000) => page.waitForFunction((want) => {
  const ed = document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor');
  if (!ed) return false;
  const lines = [...ed.querySelectorAll('.view-lines .view-line')];
  if (!lines.length) return false;
  lines.sort((a, b) => parseFloat(a.style.top || '0') - parseFloat(b.style.top || '0'));
  // Monaco renders spaces as U+00A0 — normalise before comparing
  const shown = lines[0].textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (shown !== want.replace(/\s+/g, ' ').trim()) return false;
  const cls = [...lines[0].querySelectorAll('span[class*="mtk"]')].map((s) => s.className);
  return cls.some((c) => /\bmtk(?!1\b)\d+\b/.test(c)) ? cls : false;
}, firstLine, { timeout, polling: 100 }).then((h) => h.jsonValue());

async function langsPage() {
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  const warns = [];
  page.on('console', (m) => { if (/\[monaco\] language chunk failed/.test(m.text())) warns.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem('editor:impl', 'monaco'));
  await page.goto(`${sb.base}/#alpha`, { waitUntil: 'domcontentloaded' });
  await waitEditor(page, `alpha::${FILES[0][0]}`);
  return { context, page, errors, warns };
}

test('A: every seeded file opens with its Monaco language id and a coloured first-line token; no page errors', opts, async () => {
  const { context, page, errors, warns } = await langsPage();
  try {
    const shipped = {};
    for (let fi = 0; fi < FILES.length; fi++) {
      const [rel, wantId, text] = FILES[fi];
      const fkey = `alpha::${rel}`;
      await page.click(`.ctab.cd[data-fi="${fi}"]`);
      await waitEditor(page, fkey);
      const gotId = await page.evaluate((fk) => window.__mp.language(fk), fkey);
      assert.equal(gotId, wantId, `${rel}: Monaco language id`);
      shipped[rel] = gotId;
      const firstLine = text.split('\n')[0];
      let cls;
      try {
        cls = await firstLineClasses(page, firstLine);
      } catch (e) {
        assert.fail(`${rel} (${wantId}): first line "${firstLine}" never got a non-default token — ${e.message}`);
      }
      assert.ok(cls.some((c) => /\bmtk(?!1\b)\d+\b/.test(c)), `${rel}: a coloured token on line 1 (${cls.join(' ')})`);
    }
    // the ride-alongs the table promises, pinned by name
    assert.equal(shipped['Cargo.toml'], 'ini');
    assert.equal(shipped['Makefile'], 'shell');
    assert.equal(shipped['package.json'], 'json');
    assert.equal(shipped['header.hpp'], 'cpp');
    assert.equal(shipped['app.tsx'], 'typescript');
    const degraded = await page.evaluate(() => window.__mp.degraded());
    assert.deepEqual(degraded.langs, [], 'no language chunk failed to load');
    assert.deepEqual(warns, [], 'no chunk-failure warnings');
    assert.deepEqual(errors, [], 'no page errors while opening the wave-1 files');
  } finally {
    await context.close();
  }
});

test('B: the rest of the extension table maps through createFor → langFor (seam-created models)', opts, async () => {
  const { context, page, errors } = await langsPage();
  try {
    const got = await page.evaluate((table) => {
      const out = {};
      let i = 0;
      for (const [ext] of table) {
        const fk = `alpha::__lang${i++}.${ext}`;
        window.__mp.setFile(fk, 'x = 1\n', { mtimeMs: 5000 + i, ext });
        out[ext] = window.__mp.language(fk);
      }
      return out;
    }, EXT_TABLE);
    for (const [ext, want] of EXT_TABLE) assert.equal(got[ext], want, `langFor(${ext})`);
    // a labelled-plaintext file really renders as one default-class span
    await page.evaluate(() => window.__mp.setFile('alpha::go.mod', 'module example.com/hello\n\ngo 1.22\n', { mtimeMs: 9000, ext: 'mod' }));
    await waitEditor(page, 'alpha::go.mod');
    const plain = await page.waitForFunction(() => {
      const ed = document.querySelector('#v-alpha .wb > .mdock.on .monaco-editor');
      const lines = [...(ed ? ed.querySelectorAll('.view-lines .view-line') : [])];
      lines.sort((a, b) => parseFloat(a.style.top || '0') - parseFloat(b.style.top || '0'));
      if (!lines.length || !/module example\.com\/hello/.test(lines[0].textContent.replace(/\u00a0/g, ' '))) return false;
      return [...lines[0].querySelectorAll('span[class*="mtk"]')].map((s) => s.className);
    }, null, { timeout: 15000, polling: 100 }).then((h) => h.jsonValue());
    assert.ok(plain.length >= 1 && plain.every((c) => /\bmtk1\b/.test(c)), `go.mod: plaintext renders default tokens only (${plain.join(' ')})`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await context.close();
  }
});

/* C — the TypeScript/JavaScript language services have no node_modules or
   tsconfig to resolve against here, so a bare import would squiggle "Cannot
   find module" on every file (semantic diagnostics). monacoPane mutes
   semantic validation and keeps syntax validation: a syntax slip is still an
   Error marker (which also proves the TS worker is alive and validating
   models), an unresolvable import is not. */
test('C: a .ts with `import x from \'nope\'` shows no Error marker; a syntax slip still does (semantic muted, syntax kept)', opts, async () => {
  const { context, page, errors } = await langsPage();
  try {
    const markersOf = (page, needle) => page.evaluate((n) => {
      const w = /** @type {any} */ (window);
      return w.monaco.editor.getModelMarkers({}).filter((m) => m.resource.toString().includes(n))
        .map((m) => ({ owner: m.owner, severity: m.severity, message: m.message, line: m.startLineNumber }));
    }, needle);
    // 1. the worker is alive: a syntax error gets an Error marker (severity 8)
    await page.evaluate(() => window.__mp.setFile('alpha::bad.ts', 'const = ;\n', { mtimeMs: 9200, ext: 'ts' }));
    await waitEditor(page, 'alpha::bad.ts');
    assert.equal(await page.evaluate(() => window.__mp.language('alpha::bad.ts')), 'typescript');
    await page.waitForFunction(() => window.monaco.editor.getModelMarkers({}).some((m) => m.resource.toString().includes('bad.ts') && m.severity === 8),
      null, { timeout: 30000, polling: 100 });
    const bad = await markersOf(page, 'bad.ts');
    assert.ok(bad.some((m) => m.severity === 8 && m.owner === 'typescript'), `bad.ts: a typescript Error marker (${JSON.stringify(bad)})`);
    // 2. the import file: validated by the same worker, yet no Error. The
    //    unused `x` is a *suggestion* diagnostic (Hint), which proves the
    //    model was validated at all when it arrives; either way, wait a full
    //    validation window past the worker's proof of life.
    await page.evaluate(() => window.__mp.setFile('alpha::nope.ts', "import x from 'nope';\nconsole.log('ready');\n", { mtimeMs: 9300, ext: 'ts' }));
    await waitEditor(page, 'alpha::nope.ts');
    assert.equal(await page.evaluate(() => window.__mp.language('alpha::nope.ts')), 'typescript');
    await page.waitForFunction(() => window.monaco.editor.getModelMarkers({}).some((m) => m.resource.toString().includes('nope.ts')),
      null, { timeout: 4000, polling: 100 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1500)); // one more debounce window — a late semantic pass would land by now
    const nope = await markersOf(page, 'nope.ts');
    assert.deepEqual(nope.filter((m) => m.severity === 8), [], `nope.ts: no Error markers (${JSON.stringify(nope)})`);
    assert.ok(!nope.some((m) => /Cannot find module/.test(m.message)), `no "Cannot find module" (${JSON.stringify(nope)})`);
    // 3. the same for JavaScript: a bare require/import in a .js file
    await page.evaluate(() => window.__mp.setFile('alpha::nope.mjs', "import y from 'nowhere';\nconsole.log('ready');\n", { mtimeMs: 9400, ext: 'mjs' }));
    await waitEditor(page, 'alpha::nope.mjs');
    await new Promise((r) => setTimeout(r, 1500));
    const js = await markersOf(page, 'nope.mjs');
    assert.deepEqual(js.filter((m) => m.severity === 8), [], `nope.mjs: no Error markers (${JSON.stringify(js)})`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await context.close();
  }
});

test('D: nested dotless Makefiles use the same grammar through the real pinned-tab path', opts, async () => {
  const nested = ['build/Makefile', 'tools/GNUmakefile'];
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${taskId}`, { context: { files: nested } });
  const context = await ui.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await armPage(page);
  try {
    await page.goto(`${sb.base}/#alpha`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < nested.length; i++) {
      await page.click(`.ctab.cd[data-fi="${i}"]`);
      const fk = `alpha::${nested[i]}`;
      await waitEditor(page, fk);
      assert.equal(await page.evaluate(k => window.__mp.language(k), fk), 'shell');
      assert.ok((await firstLineClasses(page, '# nested build script')).some(c => /\bmtk(?!1\b)\d+\b/.test(c)));
    }
  } finally { await context.close(); }
});
