// lib/decisions.js — the per-project DECISIONS LEDGER + standing note.
//
// Born 2026-08-07 from the packet-honesty audit (docs/private/memory-daemon-
// options.html): corrections Graham makes in one task were captured (handoffs)
// but never ROUTED — the 'deflation' ban reached exactly one downstream task
// while siblings kept violating it the same day. This ledger is project-wide
// and rides the SYSTEM-PROMPT APPENDIX of every turn (both providers, ongoing
// sessions included), so an accepted rule reaches everything immediately.
//
// Storage: ROOT/decisions/<project>.json (gitignored like tasks/ledger —
// recreated on first write, a fresh clone boots clean):
//   { standing: "", entries: [{ id, text, scope, source, created, status }] }
// scope: 'prose' | 'code' | 'math' | 'all'. Entries are RETIRED, never hard-
// deleted — an audit trail is the poisoning defense's other half. The future
// memory distiller PROPOSES entries; only user approval calls addDecision.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, PROJECTS } from './config.js';
import { broadcast } from './events.js';

const DIR = path.join(ROOT, 'decisions');
const VALID_SCOPES = new Set(['prose', 'code', 'math', 'all']);
const MAX_ACTIVE = 100;          // hard cap on active entries per project
const APPENDIX_CHAR_BUDGET = 2400; // ceiling on injected block (token honesty)
const STALE_ABSTRACT_DAYS = 21;

const logErr = (...a) => console.error('[decisions]', ...a);

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function assertProject(project) {
  if (!project || !PROJECTS[project]) throw new Error(`unknown project '${project}'`);
}

function fileFor(project) {
  return path.join(DIR, `${project}.json`);
}

function writeAtomic(project, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(project);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function emit(project) {
  try {
    broadcast('decisions:update', { project, decisions: getDecisions(project) });
  } catch (err) {
    logErr('broadcast failed:', err.message);
  }
}

export function getDecisions(project) {
  assertProject(project);
  try {
    const d = JSON.parse(fs.readFileSync(fileFor(project), 'utf8'));
    return {
      standing: typeof d.standing === 'string' ? d.standing : '',
      entries: Array.isArray(d.entries) ? d.entries.filter((e) => e && e.id && e.text) : [],
    };
  } catch {
    return { standing: '', entries: [] }; // absent/corrupt → empty, never throw
  }
}

export function addDecision(project, { text, scope, source } = {}) {
  assertProject(project);
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('decision text required');
  const d = getDecisions(project);
  const active = d.entries.filter((e) => e.status === 'active');
  if (active.length >= MAX_ACTIVE) {
    throw httpError(400, `decision cap reached (${MAX_ACTIVE} active) — retire stale entries first`);
  }
  const entry = {
    id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    scope: VALID_SCOPES.has(scope) ? scope : 'all',
    source: String(source ?? '').trim(),
    created: new Date().toISOString(),
    status: 'active',
  };
  d.entries.push(entry);
  writeAtomic(project, d);
  emit(project);
  return entry;
}

export function retireDecision(project, id) {
  assertProject(project);
  const d = getDecisions(project);
  const entry = d.entries.find((e) => e.id === id);
  if (!entry) throw httpError(404, `decision '${id}' not found in ${project}`);
  if (entry.status !== 'retired') {
    entry.status = 'retired';
    entry.retired = new Date().toISOString();
    writeAtomic(project, d);
    emit(project);
  }
  return entry;
}

export function setStanding(project, text) {
  assertProject(project);
  const d = getDecisions(project);
  d.standing = String(text ?? '').trim();
  writeAtomic(project, d);
  emit(project);
  return { standing: d.standing };
}

export function allDecisions() {
  const out = {};
  for (const key of Object.keys(PROJECTS)) out[key] = getDecisions(key);
  return out;
}

// ---------------------------------------------------------------------------
// Pure formatters (unit-tested directly; sessions.js calls these)
// ---------------------------------------------------------------------------

/**
 * The injectable block for one project's {standing, entries}. '' when there is
 * nothing to say. Over APPENDIX_CHAR_BUDGET the NEWEST rules win (a fresh
 * correction must never be the one silently dropped) and the omission is
 * stated out loud — silent truncation would read as "packet covers everything".
 */
export function formatDecisionsAppendix({ standing, entries } = {}) {
  const parts = [];
  const note = String(standing ?? '').trim();
  if (note) {
    parts.push('--- Standing note from the user (applies to every task in this project) ---\n' + note);
  }
  const active = (entries || []).filter((e) => e && e.status === 'active' && e.text);
  if (active.length) {
    const lines = active.map((e) => `- [${VALID_SCOPES.has(e.scope) ? e.scope : 'all'}] ${e.text}`);
    let kept = lines;
    let omitted = 0;
    while (kept.length > 1 && kept.join('\n').length > APPENDIX_CHAR_BUDGET) {
      kept = kept.slice(1); // entries are chronological — drop the OLDEST first
      omitted++;
    }
    const body = kept.join('\n')
      + (omitted ? `\n(${omitted} older decision${omitted === 1 ? '' : 's'} omitted — over budget; retire stale entries)` : '');
    parts.push('--- Project decisions (standing rules from the user — they OVERRIDE defaults; violating one is an error) ---\n' + body);
  }
  return parts.join('\n\n');
}

/** Appendix block for a project, ready to concatenate ('' or '\n\n'-prefixed). */
export function projectAppendix(project) {
  try {
    const block = formatDecisionsAppendix(getDecisions(project));
    return block ? `\n\n${block}` : '';
  } catch (err) {
    logErr(`projectAppendix(${project}) failed:`, err.message);
    return ''; // a broken ledger must never fail a billed turn
  }
}

/**
 * Staleness annotation for the living abstract ('' when fresh or unknown).
 * The abstracts audit (2026-08-07) found all five untouched since setup day
 * while packets presented them as current — sessions deserve the honesty.
 */
export function staleAbstractNote(mtimeMs, nowMs) {
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs) || nowMs <= mtimeMs) return '';
  const days = Math.floor((nowMs - mtimeMs) / 86_400_000);
  if (days < STALE_ABSTRACT_DAYS) return '';
  return `\n\n(Note: this abstract was last edited ${days} days ago and may be stale. `
    + 'Where it conflicts with recent handoffs or the project decisions above, trust those.)';
}
