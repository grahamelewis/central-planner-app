// Trusted stream/transcript metadata, never markers parsed from model text.
// Offsets are RAW buffer coordinates; formatting and path shortening happen later.
const buffers = new Map();
const ownerOf = o => ({ turnId: o?.turnId || null, requestId: o?.requestId || null });
const same = (a, b) => a.turnId && b.turnId ? a.turnId === b.turnId
  : !a.turnId && !b.turnId && a.requestId === b.requestId;

export function resetConsoleOwnership(key) { buffers.delete(key); }

export function bindConsoleTurn(key, requestId, turnId) {
  if (!requestId || !turnId) return;
  for (const span of buffers.get(key)?.spans || []) {
    if (span.requestId === requestId && !span.turnId) span.turnId = turnId;
  }
}

export function appendConsoleText(key, old, chunk, owner = {}, limit = 200000) {
  let record = buffers.get(key);
  if (!record || record.raw !== old) record = { raw: old, spans: old ? [{ start: 0, ...ownerOf(null) }] : [] };
  buffers.set(key, record);
  bindConsoleTurn(key, owner.requestId, owner.turnId);
  const next = ownerOf(owner);
  if (chunk && (!record.spans.length || !same(record.spans.at(-1), next))) {
    record.spans.push({ start: old.length, ...next });
  }
  record.raw = old + chunk;
  if (record.raw.length > limit) {
    let cut = record.raw.length - limit;
    const nl = record.raw.indexOf('\n', cut);
    if (nl > cut) cut = nl + 1;
    const active = [...record.spans].reverse().find(s => s.start <= cut);
    record.spans = [{ ...ownerOf(active), start: 0 },
      ...record.spans.filter(s => s.start > cut).map(s => ({ ...s, start: s.start - cut }))];
    record.raw = record.raw.slice(cut);
  }
  return record.raw;
}

// Preserve trusted boundaries across a local tail correction or rejected echo.
export function reviseConsoleText(key, old, next) {
  const record = buffers.get(key);
  if (!record || record.raw !== old) { resetConsoleOwnership(key); return next; }
  let first = 0, suffix = 0;
  while (first < Math.min(old.length, next.length) && old[first] === next[first]) first++;
  while (suffix < old.length - first && suffix < next.length - first
    && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const end = old.length - suffix, delta = next.length - old.length;
  record.spans = record.spans.filter(s => s.start <= first || s.start >= end)
    .map(s => ({ ...s, start: s.start >= end && s.start > first ? s.start + delta : s.start }))
    .filter(s => s.start < next.length);
  record.raw = next;
  return next;
}

export function consoleSlices(key, raw, upto = raw.length) {
  const record = buffers.get(key);
  if (!record || record.raw !== raw) return [{ text: raw.slice(0, upto), turnId: null }];
  const slices = [];
  for (let i = 0; i < record.spans.length; i++) {
    const span = record.spans[i];
    if (span.start >= upto) break;
    const text = raw.slice(span.start, Math.min(upto, record.spans[i + 1]?.start ?? raw.length));
    const last = slices.at(-1);
    if (last && last.turnId === span.turnId) last.text += text;
    else slices.push({ text, turnId: span.turnId });
  }
  return slices;
}
