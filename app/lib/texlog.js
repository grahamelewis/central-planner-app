// lib/texlog.js — parse a LaTeX .log (pdflatex, -file-line-error) into a
// structured problems list for the editor UI. Pure functions, no fs.
//
// TeX wraps log lines at max_print_line (79 by default) which can split a
// `file:line: message` across physical lines — unwrap those first. The
// latexmk spawns also set max_print_line in the environment, so unwrapping
// is a fallback for packages that reset it.

const MAX_PROBLEMS = 100;

/** Join hard-wrapped log lines: a physical line of exactly `width` chars is a
 *  continuation of the next one. */
export function unwrapLog(text, width = 79) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    cur += line;
    if (line.length !== width) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ./chapters/intro.tex:12: Undefined control sequence.
const FILE_LINE_ERR = /^(.+?\.(?:tex|sty|cls|bib|def|cfg|clo|ltx)):(\d+):\s*(.*)$/;
// ! LaTeX Error: Environment itemize undefined.   (no -file-line-error context)
const BANG_ERR = /^!\s?(.*)$/;
// l.42 \badmacro
const L_LINE = /^l\.(\d+)\b/;
// LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 10.
// Package hyperref Warning: ... on input line 7.
const WARN = /^(?:LaTeX|Class \S+|Package \S+)\s+Warning:\s*(.*)$/;
const ON_LINE = /on input line (\d+)\.?\s*$/;
// Overfull \hbox (13.5pt too wide) in paragraph at lines 12--14
const BADBOX = /^(Overfull|Underfull) \\([hv])box \(([^)]*)\) (?:in paragraph at lines (\d+)--(\d+)|detected at line (\d+)|has occurred)/;

/**
 * Parse a .log → [{ file, line, kind: 'error'|'warning'|'badbox', message }].
 * `file` is as TeX wrote it (usually relative to the compile cwd) or null;
 * `line` is a number or null. Callers resolve paths against the tex dir.
 */
export function parseLatexLog(text) {
  const lines = unwrapLog(text);
  const problems = [];
  const seen = new Set();
  const push = (p) => {
    if (problems.length >= MAX_PROBLEMS) return;
    const k = `${p.kind}|${p.file || ''}|${p.line || 0}|${p.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    problems.push(p);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let m = line.match(FILE_LINE_ERR);
    if (m) {
      // a message ending in '.' is complete; otherwise pull the (rare)
      // continuation lines — but never swallow a different problem's line
      let message = m[3].trim();
      for (let j = i + 1; !/\.$/.test(message) && j < Math.min(i + 4, lines.length); j++) {
        const cont = lines[j].trim();
        if (!cont || L_LINE.test(cont) || FILE_LINE_ERR.test(lines[j])
          || WARN.test(lines[j]) || BADBOX.test(lines[j]) || BANG_ERR.test(lines[j])
          || /^</.test(cont) || /^\[/.test(cont)) break;
        message += ' ' + cont;
        i = j;
      }
      push({ file: m[1], line: Number(m[2]), kind: 'error', message: message.slice(0, 300) });
      continue;
    }

    m = line.match(BANG_ERR);
    if (m && m[1] && !/^ =/.test(m[1])) {
      // un-attributed error (e.g. from a \write or missing -file-line-error
      // context): grab the l.N line that follows for a line number
      let ln = null;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = lines[j].match(L_LINE);
        if (lm) { ln = Number(lm[1]); break; }
      }
      push({ file: null, line: ln, kind: 'error', message: m[1].trim().slice(0, 300) });
      continue;
    }

    m = line.match(WARN);
    if (m) {
      let message = m[1].trim();
      // warnings wrap onto indented continuation lines ending in a period
      let j = i + 1;
      while (!ON_LINE.test(message) && !/\.$/.test(message)
        && j < Math.min(i + 4, lines.length) && /^\s{2,}\S/.test(lines[j])) {
        message += ' ' + lines[j].trim();
        i = j;
        j++;
      }
      const lm = message.match(ON_LINE);
      push({ file: null, line: lm ? Number(lm[1]) : null, kind: 'warning', message: message.slice(0, 300) });
      continue;
    }

    m = line.match(BADBOX);
    if (m) {
      const ln = m[4] ? Number(m[4]) : m[6] ? Number(m[6]) : null;
      push({
        file: null, line: ln, kind: 'badbox',
        message: `${m[1]} \\${m[2]}box (${m[3]})${m[4] ? ` at lines ${m[4]}–${m[5]}` : ''}`.slice(0, 300),
      });
    }
  }
  return problems;
}

/** Counts for status chips: { errors, warnings, badboxes }. */
export function problemCounts(problems) {
  const c = { errors: 0, warnings: 0, badboxes: 0 };
  for (const p of problems || []) {
    if (p.kind === 'error') c.errors++;
    else if (p.kind === 'warning') c.warnings++;
    else c.badboxes++;
  }
  return c;
}

/** latexmk announces each rule run ("Run number 2 of rule 'pdflatex'") —
 *  the staged build bar and verdict chips feed on these boundaries.
 *  Returns { n, rule } (rule trimmed to its first word: "bibtex refs" → "bibtex"). */
export function passFromLine(line) {
  const m = /^Run number (\d+) of rule '([^']+)'/.exec(line);
  if (!m) return null;
  return { n: Number(m[1]), rule: m[2].split(/\s/)[0] };
}
