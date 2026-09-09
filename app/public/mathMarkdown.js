// Math is a Markdown token, not a second interpretation of arbitrary DOM text.
// In particular, code, escaped dollars and link destinations belong to Markdown.

function escaped(src, at) {
  let n = 0;
  while (at > 0 && src[--at] === '\\') n++;
  return n % 2 === 1;
}

// Single dollars are ambiguous. Accept notation, not arbitrary English that
// KaTeX would happily render as a sequence of italic variables. Multi-letter
// identifiers/words should use \(...\) or explicit \text/\mathrm commands.
export function looksLikeInlineMath(body) {
  if (!body || /^\s|\s$|[+\-*/=<>]$/.test(body) || /[\n\r`$]/.test(body)) return false;
  let rest = body;
  // Text-bearing TeX commands explicitly opt in to prose inside an equation;
  // scan balanced braces, including nested commands.
  let out = '';
  for (let i = 0; i < rest.length;) {
    const text = /^\\(?:text|textrm|textbf|textit|textnormal|operatorname|mathrm|mathbf|mathit|mathsf|mathtt)\*?\s*\{/.exec(rest.slice(i));
    if (text) {
      let depth = 1, j = i + text[0].length;
      for (; j < rest.length && depth; j++) {
        if (escaped(rest, j)) continue;
        if (rest[j] === '{') depth++;
        if (rest[j] === '}') depth--;
      }
      if (depth) return false;
      out += '0'; i = j;
    } else { out += rest[i++]; }
  }
  rest = out.replace(/\\[a-zA-Z]+|\\[ ,;!:{}_%#|]/g, '0');
  // Each unadorned word must be a variable or an ordinary math operator.
  const words = rest.match(/[\p{L}]+/gu) || [];
  if (words.some(w => !/^(?:\p{L}|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|exp|lim|min|max|sup|inf|det|Pr)$/u.test(w))) return false;
  // Markdown, shell interpolation, URLs, and English punctuation are not
  // evidence of math. Explicit delimiters remain available for unusual TeX.
  if (/[^\p{L}\p{N}\s+\-−*/=<>≤≥≠≈≡±∓×÷∈∉⊂⊆∪∩∞∑∏√∂∇^_{}()[\]|.,!:'′]/u.test(rest)) return false;
  return /[\p{L}\p{N}]/u.test(rest);
}

/** Read a math token at the start of src; a failed candidate stays literal. */
export function mathToken(src, previous = '') {
  let left, right, display;
  if (src.startsWith('\\(')) { left = '\\('; right = '\\)'; display = false; }
  else if (src.startsWith('\\[')) { left = '\\['; right = '\\]'; display = true; }
  else if (src.startsWith('$$') && src[2] !== '$') { left = right = '$$'; display = true; }
  else if (src[0] === '$' && src[1] !== '$') { left = right = '$'; display = false; }
  else return;
  if (left[0] === '$' && /[\p{L}\p{N}_$\\]$/u.test(previous)) return;
  for (let end = left.length; end < src.length; end++) {
    if (left === '$' && /[\n\r]/.test(src[end])) return;
    if (!src.startsWith(right, end) || escaped(src, end)) continue;
    const body = src.slice(left.length, end);
    if (!body.trim()) return;
    if (left === '$') {
      // A closing dollar cannot also introduce the next price or shell name.
      if (/[\p{L}\p{N}_$]/u.test(src[end + 1] || '') || !looksLikeInlineMath(body)) return;
    }
    if (left === '$$' && src[end + 2] === '$') return;
    return { type: 'dashboardMath', raw: src.slice(0, end + right.length), body, display };
  }
}

export function mathExtensions(esc) {
  const renderer = token => `<span class="cpMath" data-display="${token.display ? 'block' : 'inline'}" data-tex="${esc(token.body)}">${esc(token.raw)}</span>`;
  return [
    {
      name: 'dashboardMath', level: 'inline',
      start: src => src.search(/\$|\\[([]/),
      tokenizer(src, tokens) {
        if (this.lexer.state.inRawBlock) return;
        return mathToken(src, tokens.at(-1)?.raw || '');
      },
      renderer,
    },
    {
      name: 'dashboardMathBlock', level: 'block',
      tokenizer(src) {
        if (!/^(?:\$\$|\\\[)/.test(src)) return;
        const token = mathToken(src);
        if (!token || !/^ *(?:\n|$)/.test(src.slice(token.raw.length))) return;
        return { ...token, type: 'dashboardMathBlock' };
      },
      renderer: token => renderer(token) + '\n',
    },
  ];
}
