# Console and Markdown math recognition

The renderer previously paired ordinary currency dollars, hid the intervening
prose from Markdown, then let KaTeX typeset it as an equation. That removed
spaces, italicized words, and swallowed bold markers. The same pre-pass could
also merge separate code spans containing dollars.

Math now participates in Markdown tokenization. Markdown owns code, escapes,
links and HTML; approved math tokens own their TeX contents. DOMPurify sanitizes
the result, then KaTeX renders only those tokens, with `trust: false`. There is
no second scan of ordinary DOM text for dollar signs. Both console and Markdown
preview use this pipeline. Raw HTML viewers and the source transcript are unchanged.

## Contract

| Source | Result |
| --- | --- |
| `$4,814. Thus $20,000` | Currency and prose, with spaces intact |
| `**$3,383**, then **$231,564**` | Two separate bold amounts |
| `$5-$10`, `$5/$10`, `$5 + $10` | Literal currency |
| `\$x\$` | Literal `$x$` |
| Code spans/fences containing `$x$` | Code, never math |
| `$HOME$`, `$cost = high$`, `$log files$` | Literal, not italic math |
| `$x_t$`, `$2 + 2 = 4$`, `$\frac{a}{b}$` | Inline math |
| `$x = \text{net income}$` | Math with explicitly designated prose |
| `\(GDP = income\)` | Explicit inline math |
| `$$…$$`, `\[…\]` | Explicit display math, including multiline blocks |

Single-dollar candidates must close on the same line, have no inner edge
whitespace or unfinished trailing arithmetic operator, and not touch a word or
another dollar at their outer boundaries. A closing dollar cannot introduce the
next price. Bare words must be single-letter variables or supported math
operators (`log`, `sin`, `min`, etc.); TeX commands and balanced text-bearing
commands are allowed. Currency, shell names, ordinary sentences and Markdown
syntax are not evidence of math.

This is deliberately conservative, not a natural-language intent detector.
`$x$`, `$5$`, and `$log$` are inherently ambiguous but conventional math; escape
the dollars or use code if they are literal. Conversely, bare multi-letter
symbols such as `$GDP$` or `$xy$` stay literal: write `\(GDP\)`, `\(xy\)`, or
use explicit TeX commands. Double dollars and backslash delimiters explicitly
request math; put shell examples containing `$$` in code. Nothing is classified
as math solely because an ordinary sentence contains a number, operator or
math-related word.

## Regression coverage

`test/mathCases.mjs` is the shared inventory of 97 cases (69 literal/prose and
28 math cases). `ui.math.test.mjs` runs
each case through both real browser Markdown engines, DOMPurify and KaTeX,
checking the exact equation sources and preservation of prose, bold and code.
It also checks all prefixes of ordinary currency/prose, the actual console's
raw-stream → completed-answer transition, idempotence, HTML sanitization, and
the missing-library fallback. `mathMarkdown.test.mjs` checks tokenizer rules
without requiring a browser.

Run from `app/`:

```sh
node --test --test-concurrency=2 test/mathMarkdown.test.mjs test/ui.math.test.mjs test/ui.fence.test.mjs test/ui.mdview.test.mjs test/ui.console.test.mjs
npm run typecheck
```

The existing fence suite now waits for the streamed fences to appear instead
of assuming the reveal pump completes in 600 ms; its assertions are unchanged.
Two console scroll-position assertions failed intermittently in earlier runs,
including a comparison serving the committed pre-fix renderer (800 vs 0 and
860 vs 0). They are not skipped or changed by this fix. The final targeted run
on September 7, 2026 passed all 252 tests with no skips; typecheck and
`git diff --check` also passed. That clean rerun does not establish that the
pre-existing scroll-test timing issue is resolved.
