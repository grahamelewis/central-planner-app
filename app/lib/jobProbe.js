// lib/jobProbe.js — the second, targeted probe behind a job card's memory line.
//
// `ps rss` overstates a tree's footprint (shared library pages count once per
// process: a julia master + 2 workers reads 1.1G when 759M is physical), so
// the card prefers a footprint figure and labels the number `rss` only when
// this probe has nothing better. One call per tick-pair, only for pinned
// trees, never for the whole table:
//   macOS  — `top -l 1 -stats pid,mem,th,state -pid a -pid b …` (≈300 ms: top
//            samples the whole table even with -pid, hence every other tick).
//            `mem` is top's "physical memory footprint" with K/M/G suffixes;
//            `th` is "n/m" (threads total / running) → n.
//   Linux  — /proc/<pid>/smaps_rollup `Pss:` (kB, kernel ≥ 4.14) → footprint,
//            /proc/<pid>/status `Threads:` (+ `VmRSS:` fallback when
//            smaps_rollup is unreadable — other uid, hardened kernels).
//   else   — null: the sampler keeps rss.
// The parsers are exported on their own so tests never spawn anything.

import fs from 'fs';
import { execFile } from 'child_process';

const UNIT = { '': 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** "848K" / "26M" / "1.02G" / "12345" (+ top's +/- delta markers) → bytes. */
export function parseSizeSuffix(s) {
  const m = String(s || '').trim().match(/^([\d.]+)\s*([KMGTB]?)(?:i?B)?[+-]?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = UNIT[m[2].toUpperCase()];
  return mult == null ? null : Math.round(n * mult);
}

/**
 * Parse `top -l 1 -stats pid,mem,th,state` output. The header block (load,
 * PhysMem, …) precedes a `PID MEM #TH STATE` line; rows follow. Column order
 * follows the -stats list, so the parser keys on the header line rather than
 * fixed positions. → Map<pid, {footprint, threads, state}>.
 */
export function parseTopOutput(text) {
  const out = new Map();
  const lines = String(text || '').split('\n');
  let cols = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (!cols) {
      if (/^\s*PID\b/.test(line)) cols = line.trim().split(/\s+/).map((c) => c.toUpperCase());
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < cols.length) continue;
    const pid = Number(parts[cols.indexOf('PID')]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const rec = {};
    const iMem = cols.indexOf('MEM');
    if (iMem !== -1) {
      const b = parseSizeSuffix(parts[iMem]);
      if (b != null) rec.footprint = b;
    }
    const iTh = cols.indexOf('#TH');
    if (iTh !== -1) {
      const th = parts[iTh].match(/^(\d+)(?:\/\d+)?$/);
      if (th) rec.threads = Number(th[1]);
    }
    const iSt = cols.indexOf('STATE');
    if (iSt !== -1) rec.state = parts[iSt];
    out.set(pid, rec);
  }
  return out;
}

/** /proc/<pid>/status → {threads, vmRss (bytes), state} (any subset). */
export function parseProcStatus(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = line.match(/^Threads:\s*(\d+)/))) out.threads = Number(m[1]);
    else if ((m = line.match(/^VmRSS:\s*(\d+)\s*kB/))) out.vmRss = Number(m[1]) * 1024;
    else if ((m = line.match(/^State:\s*([A-Za-z])/))) out.state = m[1];
  }
  return out;
}

/** /proc/<pid>/smaps_rollup → Pss in bytes, or null when the file has none. */
export function parseSmapsRollup(text) {
  const m = String(text || '').match(/^Pss:\s*(\d+)\s*kB/m);
  return m ? Number(m[1]) * 1024 : null;
}

function probeDarwin(pids, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-l', '1', '-stats', 'pid,mem,th,state'];
    for (const pid of pids) args.push('-pid', String(pid));
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = execFile('top', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return finish(null); // slow (> timeout, killed) or absent → keep rss
          try { finish(parseTopOutput(stdout)); } catch { finish(null); }
        });
      child.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/** Preserve RSS provenance when PSS is unavailable; never mix it into PSS. */
export function parseLinuxProbe(statusText, smapsText) {
  const status = parseProcStatus(statusText);
  const rec = {};
  if (status.threads != null) rec.threads = status.threads;
  if (status.state) rec.state = status.state;
  const pss = parseSmapsRollup(smapsText);
  if (pss != null) rec.footprint = pss;
  else if (status.vmRss != null) rec.rss = status.vmRss;
  return rec;
}

function probeLinux(pids) {
  const out = new Map();
  for (const pid of pids) {
    let status = null;
    try { status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { /* gone or hidden */ }
    let smaps = null;
    try { smaps = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'); } catch { /* unreadable → labelled RSS */ }
    const rec = parseLinuxProbe(status, smaps);
    if (Object.keys(rec).length) out.set(pid, rec);
  }
  return Promise.resolve(out);
}

/**
 * Probe the given pids → Map<pid, {footprint?, rss?, threads?, state?}> or null
 * when the host has no probe (or it failed / timed out). Never throws. Missing
 * rows may be exited, unreadable, or beyond the bounded macOS probe's PID cap;
 * the caller must not treat a partial map as a complete tree measurement.
 */
export async function probe(pids, { timeoutMs = 1500, platform = process.platform } = {}) {
  try {
    const list = [...new Set((pids || []).map(Number).filter((p) => Number.isInteger(p) && p > 0))];
    if (!list.length) return new Map();
    if (platform === 'darwin') return await probeDarwin(list.slice(0, 64), timeoutMs);
    if (platform === 'linux') return await probeLinux(list);
    return null;
  } catch {
    return null;
  }
}

/** Which footprint definition this host reports (for the card's hover). */
export function probeKind(platform = process.platform) {
  if (platform === 'darwin') return 'footprint';
  if (platform === 'linux') return 'footprint'; // PSS — additive across a tree like macOS's footprint
  return null;
}
