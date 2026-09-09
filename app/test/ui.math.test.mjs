import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, CHROME } from './uiHarness.mjs';
import { mathCases } from './mathCases.mjs';

const opts = { skip: fs.existsSync(CHROME) ? false : 'Google Chrome not installed' };
let ui;
before(async () => {
  if (opts.skip) return;
  ui = await startUI();
  await ui.page.goto(ui.sb.base);
  // Missing CDN libraries must fail, not silently exercise the plain fallback.
  await ui.page.waitForFunction(() => window.marked && window.DOMPurify && window.katex?.render, null, { timeout: 15000 });
});
after(async () => { if (ui) await ui.stop(); });

for (const chat of [true, false]) {
  for (const c of mathCases) {
    test(`${chat ? 'console' : 'document'}: ${c.name}`, opts, async () => {
      const out = await ui.page.evaluate(async ({ source, chat }) => {
        const { md, katexEl } = await import('/console.js');
        const el = document.createElement('div');
        el.innerHTML = md(source, { chat });
        const before = el.textContent.trim();
        const tokens = [...el.querySelectorAll('.cpMath')].map(n => n.getAttribute('data-tex'));
        katexEl(el, { '\\ah': '\\hat{a}', '\\E': '\\mathbb{E}' });
        const html = el.innerHTML;
        katexEl(el); // repeated calls must not nest or reinterpret math/currency
        // DOM textContent omits <br> and paragraph boundaries. Measure those
        // separately so a visually correct Markdown line break isn't a failure.
        const readable = el.cloneNode(true);
        readable.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
        return {
          tokens, before, text: el.textContent.trim(),
          readable: readable.textContent.trim(), paragraphs: el.querySelectorAll('p').length,
          math: [...el.querySelectorAll('annotation')].map(n => n.textContent),
          bold: [...el.querySelectorAll('strong')].map(n => n.textContent),
          code: [...el.querySelectorAll('code')].map(n => n.textContent),
          stable: html === el.innerHTML,
          errors: el.querySelectorAll('.katex-error, [style*="color:#cc0000"]').length,
        };
      }, { source: c.source, chat });
      assert.deepEqual(out.tokens, c.math, 'only intended Markdown spans are math');
      assert.deepEqual(out.math, c.math, 'KaTeX must not discover extra math');
      assert.equal(out.errors, 0);
      assert.ok(out.stable, 'typesetting is idempotent');
      if (c.text != null) {
        if (c.breaks) {
          assert.equal(out.readable.replace(/\n+/g, '\n'), c.text.replace(/\n+/g, '\n'));
          if (c.text.includes('\n\n')) assert.equal(out.paragraphs, 2);
        } else assert.equal(out.text, c.text);
      }
      if (c.bold) assert.deepEqual(out.bold, c.bold);
      if (c.code) assert.deepEqual(out.code, c.code);
      if (!c.math.length) assert.equal(out.text, out.before, 'typesetting never changes prose');
    });
  }
}

test('all prefixes of ordinary currency/prose preserve the no-math invariant', opts, async () => {
  const failures = await ui.page.evaluate(async sources => {
    const { md, katexEl } = await import('/console.js');
    const failures = [];
    for (const source of sources) for (let i = 0; i <= source.length; i++) {
      const el = document.createElement('div');
      el.innerHTML = md(source.slice(0, i), { chat: true });
      katexEl(el);
      if (el.querySelector('.katex')) failures.push(source.slice(0, i));
    }
    return failures;
  // An unfinished backtick span is literal prose under Markdown, not code yet.
  // The console deliberately uses raw text for its live tail; code expectations
  // above apply once a completed Markdown segment is typeset.
  }, mathCases.filter(c => !c.math.length && !c.source.includes('`') && !c.source.includes('&#')).map(c => c.source));
  assert.deepEqual(failures, []);
});

test('document raw code/attributes and sanitization remain intact', opts, async () => {
  const out = await ui.page.evaluate(async () => {
    const { md, katexEl } = await import('/console.js');
    const el = document.createElement('div');
    el.innerHTML = md('<code>$x$</code> <span title="$y$">$5 and $10</span> <img src=x onerror="alert(1)"> <script>alert(1)</script>');
    katexEl(el);
    return { math: el.querySelectorAll('.katex').length, code: el.querySelector('code').textContent, title: el.querySelector('span').title, unsafe: !!el.querySelector('script, [onerror]') };
  });
  assert.deepEqual(out, { math: 0, code: '$x$', title: '$y$', unsafe: false });
});

test('live console stays raw at every prefix, then formats only the equation at completion', opts, async () => {
  const out = await ui.page.evaluate(async () => {
    const { updateConsole } = await import('/console.js');
    const { state, tailBufs } = await import('/store.js');
    const key = 'alpha/math-regression';
    const task = { id: 'math-regression', status: 'running', context: { files: [] } };
    state.tasks.alpha.push(task);
    const box = document.createElement('div');
    const source = 'Pay **$5** and **$10**. Code: `$x + y$`. Equation: $x_t = 2$.';
    const failures = [];
    try {
      for (let i = 1; i <= source.length; i++) {
        tailBufs[key] = '\n— answer —\n' + source.slice(0, i);
        updateConsole(box, key);
        const raw = box.querySelector('.csRaw');
        if (!raw || raw.textContent !== source.slice(0, i) || box.querySelector('.katex')) failures.push(i);
      }
      task.status = 'waiting';
      updateConsole(box, key);
      return { failures, math: [...box.querySelectorAll('annotation')].map(n => n.textContent),
        bold: [...box.querySelectorAll('strong')].map(n => n.textContent), code: box.querySelector('code')?.textContent };
    } finally {
      delete tailBufs[key];
      state.tasks.alpha = state.tasks.alpha.filter(t => t !== task);
    }
  });
  assert.deepEqual(out, { failures: [], math: ['x_t = 2'], bold: ['$5', '$10'], code: '$x + y$' });
});

test('missing libraries leave readable literal text, without a second dollar scan', opts, async () => {
  const out = await ui.page.evaluate(async () => {
    const { md, katexEl } = await import('/console.js');
    const saved = window.marked;
    try {
      window.marked = undefined;
      const el = document.createElement('div');
      el.innerHTML = md('Pay $5 and $10. Equation $x_t$; <script>bad()</script>.');
      katexEl(el);
      return { text: el.textContent, math: el.querySelectorAll('.katex').length, script: !!el.querySelector('script') };
    } finally { window.marked = saved; }
  });
  assert.deepEqual(out, { text: 'Pay $5 and $10. Equation $x_t$; <script>bad()</script>.', math: 0, script: false });
});
