import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathToken, looksLikeInlineMath } from '../public/mathMarkdown.js';

for (const body of ['x_t', '2 + 2 = 4', 'β = 0.96', String.raw`\frac{a}{b}`, String.raw`\text{net income} = x`]) {
  test(`accept notation: ${body}`, () => assert.equal(looksLikeInlineMath(body), true));
}
for (const body of ['4,814. Thus ', '3,383**, but one month reaches **', 'cost = high', 'price + tax', 'x is y', 'HOME', 'profit/loss', 'gross_income', '5/month', 'x\ny', String.raw`\text{unclosed`]) {
  test(`reject prose/near-match: ${body}`, () => assert.equal(looksLikeInlineMath(body), false));
}
test('a closing dollar cannot introduce another amount', () => {
  for (const source of ['$5$10', '$5-$10', '$5/$10', '$x$word', '$x$$']) assert.equal(mathToken(source), undefined, source);
});
test('unclosed input stays literal; a completed equation becomes math', () => {
  const source = '$x_t = 2$';
  for (let i = 0; i < source.length; i++) assert.equal(mathToken(source.slice(0, i)), undefined);
  assert.equal(mathToken(source).body, 'x_t = 2');
});
test('delimiter runs and embedded dollars stay literal', () => {
  for (const source of ['$$$', '$$$$', '$$', '$']) assert.equal(mathToken(source), undefined);
  assert.equal(mathToken('$x$', 'USD'), undefined);
  assert.equal(mathToken('$x$', '\\'), undefined);
});
