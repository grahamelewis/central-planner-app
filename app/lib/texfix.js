// lib/texfix.js — "Claude fix" for a failing LaTeX build, as SUGGESTIONS.
// One tightly sandboxed READ-ONLY Sonnet 5 session (Read/Grep/Glob — it can
// edit nothing) studies the failing build and returns structured suggestions:
// exact find→replace snippets anchored to the file content AS DISPATCHED.
// The editor highlights each one in place and the user approves them into
// their own draft — Claude never writes to disk, so concurrent typing can
// never be clobbered and there is nothing to merge.
//
// BILLED — POST /api/texfix/:project must never be hit by smoke tests (the
// ui harness intercepts it in the browser, same as /launch and /message).
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PROJECTS } from './config.js';
import { broadcast } from './events.js';
import { logTokens } from './ledger.js';
import { getPdfWatches } from './watchers.js';
import { getRuns } from './runner.js';

// Sonnet 5: LaTeX repairs are mechanical (read the log, anchor a minimal
// find→replace) — Sonnet does them as well as Opus at a fraction of the cost
// and latency. Bump to 'claude-opus-5' (same $5/$25 pricing as 4.8) if a
// document ever genuinely stumps it.
const MODEL = 'claude-sonnet-5';
const MAX_TURNS = 20;
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_INLINE = 120 * 1024;
const MAX_SUGGESTIONS = 10;

const log = (...a) => console.log('[texfix]', ...a);
const logErr = (...a) => console.error('[texfix]', ...a);

// project → { state:'running'|'done'|'error', startedAt, ms, model, taskId,
//             tex, suggestions:[{id,file,find,replace,why,status}], note,
//             error, costUsd }
const fixes = new Map();

export function getTexfix() {
  const out = {};
  for (const [k, v] of fixes.entries()) out[k] = { ...v };
  return out;
}

function broadcastFix(project) {
  try {
    broadcast('texfix:status', { project, fix: { ...fixes.get(project) } });
  } catch (err) {
    logErr('broadcast failed:', err.message);
  }
}

/** The failing build to repair: the live watch first, else the last .tex run. */
function failingContext(project) {
  const w = getPdfWatches()[project];
  if (w && w.tex && (w.state === 'error' || (w.counts && w.counts.errors > 0))) {
    return { tex: w.tex, problems: w.problems || [] };
  }
  const r = getRuns()[project];
  if (r && /\.tex$/i.test(r.rel || '') && r.state === 'error' && r.counts && r.counts.errors > 0) {
    return { tex: path.resolve(path.resolve(PROJECTS[project].root), r.rel), problems: r.problems || [] };
  }
  return null;
}

function buildPrompt(root, texAbs, problems, content) {
  const rel = path.relative(root, texAbs);
  const lines = (problems || []).slice(0, 30).map((p) =>
    `${p.file || rel}${p.line ? ':' + p.line : ''}: [${p.kind}] ${p.message}`);
  return [
    'A LaTeX document in this project fails to compile. Propose the smallest',
    'fixes — you cannot edit anything; the author approves each suggestion.',
    '',
    `Main file: ${rel}`,
    'Compiler output (latexmk / pdflatex, -file-line-error):',
    ...(lines.length ? lines : ['(log unavailable — find the defect by reading the source)']),
    '',
    'STRICT RULES:',
    '- Suggest ONLY what is needed to make the document compile — errors, not',
    '  warnings. Never reword, restructure, or "improve" anything.',
    '- Never alter substantive content: prose, math, numbers, labels, citation',
    '  keys, or document structure.',
    '- Each suggestion must be a minimal, surgical replacement.',
    '',
    'ANSWER FORMAT — reply with ONLY a JSON array, no prose, no code fences:',
    '[{"file": "<project-relative path>",',
    '  "find": "<text copied VERBATIM from that file, long enough to be unique>",',
    '  "replace": "<the corrected text>",',
    '  "why": "<one short clause, ≤80 chars>"}]',
    'The "find" string must appear EXACTLY (byte-for-byte) in the file content',
    'shown below (or in the file you Read). If an error lives in another file',
    '(\\input/\\include), Read that file first and anchor "find" to its text.',
    `At most ${MAX_SUGGESTIONS} suggestions. If nothing needs fixing, reply [].`,
    '',
    `Current content of ${rel}:`,
    '```latex',
    content,
    '```',
  ].join('\n');
}

/** Pull the JSON array out of the reply (tolerates stray fences/prose). */
export function parseSuggestions(text, { root, baseContent, mainRel }) {
  let raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr.slice(0, MAX_SUGGESTIONS)) {
    if (!s || typeof s.find !== 'string' || !s.find.trim() || typeof s.replace !== 'string') continue;
    if (s.find === s.replace) continue;
    const file = typeof s.file === 'string' && s.file.trim() ? s.file.trim() : mainRel;
    // containment: suggestions may only point inside the project — lexical
    // check first, then realpath so an in-root symlink can't anchor a
    // suggestion to content outside the root (same discipline as lib/paths.js)
    const abs = path.resolve(root, file);
    if (path.relative(root, abs).startsWith('..')) continue;
    try {
      const realAbs = fs.realpathSync(abs);
      const realRoot = fs.realpathSync(root);
      if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) continue;
    } catch { /* file may not exist — the anchor check below settles it */ }
    // anchor check: verbatim in the dispatched main content, or in the file
    // on disk (for \input files Claude Read on its own)
    let anchored = file === mainRel && baseContent.includes(s.find);
    if (!anchored) {
      try { anchored = fs.readFileSync(abs, 'utf8').includes(s.find); } catch { anchored = false; }
    }
    if (!anchored) continue;
    out.push({
      id: `s${out.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
      file: path.relative(root, abs),
      find: s.find,
      replace: s.replace,
      why: String(s.why || '').slice(0, 120),
      status: 'open',
    });
  }
  return out;
}

/** Kick off a fix search. Returns {ok} or {error, status}. Suggestions come
 *  back via texfix:status broadcasts; nothing is ever written to disk. */
export function startTexfix(project, taskId) {
  const cfg = PROJECTS[project];
  if (!cfg) return { error: `unknown project: ${project}`, status: 404 };
  const cur = fixes.get(project);
  if (cur && cur.state === 'running') {
    return { error: 'a Claude fix is already running in this project', status: 409 };
  }
  const ctx = failingContext(project);
  if (!ctx) return { error: 'no failing LaTeX build in this project', status: 400 };
  // defense-in-depth for the test sandbox: the harness sets CP_NO_BILLED so a
  // test that slips past route interception still cannot dispatch a billed call
  if (process.env.CP_NO_BILLED) {
    return { error: 'billed Claude calls are disabled in this environment', status: 403 };
  }

  const root = path.resolve(cfg.root);
  const mainRel = path.relative(root, ctx.tex);
  let baseContent = '';
  try {
    baseContent = fs.readFileSync(ctx.tex, 'utf8');
    if (baseContent.length > MAX_INLINE) baseContent = baseContent.slice(0, MAX_INLINE);
  } catch { /* prompt says log-only */ }

  const fix = {
    state: 'running',
    startedAt: new Date().toISOString(),
    model: MODEL,
    taskId: taskId || null,
    tex: mainRel,
    suggestions: [],
  };
  fixes.set(project, fix);
  broadcastFix(project);
  log(`${project}: searching ${mainRel} (${(ctx.problems || []).length} problems, task ${taskId || '—'})`);

  const t0 = Date.now();
  (async () => {
    let finalText = '';
    let resultSubtype = null;
    let timedOut = false;
    let usageIn = 0;
    let usageOut = 0;
    let costUsd = 0;
    try {
      const q = query({
        prompt: buildPrompt(root, ctx.tex, ctx.problems, baseContent),
        options: {
          cwd: root,
          model: MODEL,
          maxTurns: MAX_TURNS,
          permissionMode: 'default',
          // read-only allowlist — Claude can study, never touch
          allowedTools: ['Read', 'Grep', 'Glob'],
          disallowedTools: ['Edit', 'MultiEdit', 'Write', 'Bash', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Task'],
        },
      });
      const timer = setTimeout(() => {
        timedOut = true;
        q.interrupt().catch((err) => logErr(`${project}: interrupt failed:`, err?.message || err));
      }, TIMEOUT_MS);
      try {
        for await (const msg of q) {
          if (msg?.type === 'result') {
            resultSubtype = msg.subtype || 'success';
            finalText = msg.result || '';
            usageIn = msg.usage?.input_tokens || 0;
            usageOut = msg.usage?.output_tokens || 0;
            costUsd = Number(msg.total_cost_usd) || 0;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      try { logTokens(project, taskId || 'texfix', usageIn, usageOut, costUsd, MODEL); } catch (err) {
        logErr('logTokens failed:', err.message);
      }
      if (timedOut || (resultSubtype && resultSubtype !== 'success')) {
        // an interrupted/errored session is NOT a quiet "no suggestions" —
        // surface why (timeout, max turns, execution error) so the user can retry
        const why = timedOut ? `timed out after ${TIMEOUT_MS / 60000} minutes`
          : `session ended early (${resultSubtype.replace(/^error_/, '').replace(/_/g, ' ')})`;
        fixes.set(project, { ...fix, state: 'error', ms: Date.now() - t0, costUsd, error: why });
        logErr(`${project}: ${why}`);
        broadcastFix(project);
        return;
      }
      const suggestions = parseSuggestions(finalText, { root, baseContent, mainRel });
      fixes.set(project, {
        ...fix,
        state: 'done',
        ms: Date.now() - t0,
        costUsd,
        suggestions,
        note: suggestions.length ? '' : finalText.trim().slice(0, 300),
      });
      log(`${project}: ${suggestions.length} suggestion(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s, $${costUsd.toFixed(4)}`);
    } catch (err) {
      logErr(`${project}: failed —`, err.message);
      fixes.set(project, { ...fix, state: 'error', ms: Date.now() - t0, error: err.message });
    }
    broadcastFix(project);
  })();

  return { ok: true };
}

/** Approve/dismiss bookkeeping (the actual text change happens in the
 *  editor, in the user's draft). */
/** Retire a finished fix record — the success card auto-dismisses a few
 *  seconds after the applied fix builds clean, and this makes that stick
 *  (server-side, so re-renders/reloads/other clients don't resurrect it). */
export function dismissFix(project) {
  const fix = fixes.get(project);
  if (!fix) return { ok: true }; // already gone — dismissal is idempotent
  if (fix.state === 'running') return { error: 'a fix session is still running', status: 409 };
  fixes.delete(project);
  broadcastFix(project); // broadcasts fix:{} — clears the card on every client
  return { ok: true };
}

export function resolveSuggestion(project, id, status) {
  const fix = fixes.get(project);
  if (!fix || !Array.isArray(fix.suggestions)) {
    return { error: 'no fix suggestions for this project', status: 404 };
  }
  const s = fix.suggestions.find((x) => x.id === id);
  if (!s) return { error: `unknown suggestion: ${id}`, status: 404 };
  if (!['accepted', 'dismissed', 'stale'].includes(status)) {
    return { error: 'status must be accepted | dismissed | stale', status: 400 };
  }
  s.status = status;
  broadcastFix(project);
  return { ok: true };
}
