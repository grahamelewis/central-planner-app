#!/usr/bin/env node
// test/latex-corpus/gen-goldens.mjs — DELIBERATE regeneration of the frozen
// legacy goldens (monaco-blueprint §13 A13 / §14 amendment).
//
//   cd app && node test/latex-corpus/gen-goldens.mjs
//
// The goldens under test/latex-corpus/goldens/ freeze the normalized
// token+zone output of the CURRENT hl.js over every corpus file. They are the
// legacy oracle for Phase 3's texZones/Monarch work — live hl.js is never the
// only oracle. latex-corpus.test.mjs fails whenever live hl.js output drifts
// from these fixtures, which makes any hl.js behavior change a deliberate,
// reviewed act: rerun this script and commit the golden diff WITH the change.
// Never run it to "fix" a red test you don't understand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldenFor } from './normalize.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'goldens');

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

let wrote = 0;
for (const f of manifest.files) {
  const text = fs.readFileSync(path.join(DIR, f.name), 'utf8');
  const golden = goldenFor(text, f.ext, f.golden);
  const dest = path.join(OUT, `${f.name}.json`);
  fs.writeFileSync(dest, JSON.stringify(golden, null, 1) + '\n');
  const size = fs.statSync(dest).size;
  console.log(`  ${f.name.padEnd(18)} ${f.golden.padEnd(6)} → goldens/${f.name}.json (${size} bytes)`);
  wrote++;
}
console.log(`\n${wrote} goldens written. These are FROZEN fixtures: commit the diff`);
console.log('only alongside a deliberate, reviewed hl.js/corpus change.');
