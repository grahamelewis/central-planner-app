#!/usr/bin/env node
// Repository boundary, not the runtime manifest: regression tests, fixtures and
// safety harnesses belong in development Git but never in the runtime artifact.
// Inspect the Git INDEX, not the working tree: .gitignore cannot protect a file
// already tracked, and a local rename/deletion must not hide its staged version.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { pattern: /(?:^|\/)(?:\.local|\.artifacts|research|experiments|renders)\//,
    reason: 'local research or generated output' },
  { pattern: /(?:^|\/)(?:node_modules|\.codex)\//,
    reason: 'installed dependency or private agent state' },
  { pattern: /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|\.npmrc)$|\.(?:pem|key|p12)$/i,
    reason: 'local environment or credential material' },
  { pattern: /^\.claude\/(?!commands\/)/,
    reason: 'private local agent settings' },
  { pattern: /^(?:tasks|ledger|snapshots|transcripts|memory|abstracts|decisions|categories|runs|plan|\.cache)\//,
    reason: 'private dashboard runtime state' },
  { pattern: /^(?:config\.json|profile\.json|categories\.json|jobhist\.json|\.kaimon-daemon\.json)$|^desktop\/dist\//,
    reason: 'private runtime configuration or packaged build' },
  { pattern: /(?:^|\/)(?:mockups|[^/]+-mockups)(?:\/|$)/i,
    reason: 'exploratory mockups' },
  { pattern: /^app\/docs\/[\s\S]*\.html$/i,
    reason: 'exploratory HTML; maintained docs use Markdown' },
  { pattern: /^app\/docs\/(?:language-support|token-efficiency-review)(?:\/|$)/,
    reason: 'local research report' },
  { pattern: /^desktop\/(?:BLUEPRINT\.html|BLUEPRINT_AUDIT\.txt|logo-concepts\.html)$/i,
    reason: 'desktop design exploration' },
  { pattern: /(?:^|\/)(?:screenshots|test-results|playwright-report|coverage)(?:\/|$)/i,
    reason: 'generated screenshots or test output' },
  { pattern: /\.log$/i, reason: 'runtime or tool log' },
];

export function violationsFor(paths) {
  return [...new Set(paths)].sort().flatMap(file => {
    const rule = RULES.find(({ pattern }) => pattern.test(file));
    return rule ? [{ file, reason: rule.reason }] : [];
  });
}

export function inspectIndex(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const files = execFileSync('git', ['ls-files', '--cached', '--full-name', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
  return { root, files, violations: violationsFor(files) };
}

function main() {
  try {
    const { files, violations } = inspectIndex();
    if (violations.length) {
      console.error('Repository boundary FAILED: these indexed files must remain local:');
      for (const { file, reason } of violations) console.error(`  ${JSON.stringify(file)} — ${reason}`);
      console.error('Preserve local copies, then review removal from Git tracking. Do not delete research.');
      console.error('Tests, safety harnesses and fixtures stay in Git; the runtime manifest excludes them.');
      process.exitCode = 1;
    } else console.log(`Repository boundary passed (${files.length} indexed paths checked).`);
  } catch (error) {
    console.error(`Cannot inspect Git index: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
