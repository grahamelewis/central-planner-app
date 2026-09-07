// lib/jobProbe.js — the footprint/thread probe's parsers, against text
// captured from `top -l 1` on macOS and /proc files on Linux. No process is
// spawned here; probe() itself is exercised end-to-end by jobs.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTopOutput, parseProcStatus, parseSmapsRollup, parseSizeSuffix, parseLinuxProbe, probe,
} from '../lib/jobProbe.js';

// captured: top -l 1 -stats pid,mem,th,state -pid 99065 -pid 1 (macOS 15, arm64)
const TOP_TEXT = `Processes: 876 total, 5 running, 1 stuck, 870 sleeping, 4260 threads
2026/09/06 18:17:18
Load Avg: 3.37, 3.15, 2.78
CPU usage: 16.80% user, 13.39% sys, 69.80% idle
SharedLibs: 1238M resident, 210M data, 152M linkedit.
MemRegions: 326830 total, 6954M resident, 540M private, 3628M shared.
PhysMem: 31G used (2739M wired, 2840M compressor), 85M unused.
VM: 377T vsize, 6144M framework vsize, 0(0) swapins, 0(0) swapouts.
Networks: packets: 38381067/92G in, 28155315/78G out.
Disks: 51877679/844G read, 26309240/394G written.

PID    MEM   #TH STATE
99065  1680K 1   sleeping
1      26M   4   sleeping
99157  848K  1/1 running
86764  1.02G 17/2 running
`;

test('parseSizeSuffix: K/M/G at 1024 steps, bare bytes, top delta markers', () => {
  assert.equal(parseSizeSuffix('848K'), 848 * 1024);
  assert.equal(parseSizeSuffix('26M'), 26 * 1024 * 1024);
  assert.equal(parseSizeSuffix('1.02G'), Math.round(1.02 * 1024 ** 3));
  assert.equal(parseSizeSuffix('4096'), 4096);
  assert.equal(parseSizeSuffix('12M+'), 12 * 1024 * 1024);
  assert.equal(parseSizeSuffix('N/A'), null);
});

test('parseTopOutput: rows keyed by the PID header, mem in bytes, th "n/m" → n', () => {
  const m = parseTopOutput(TOP_TEXT);
  assert.equal(m.size, 4);
  assert.deepEqual(m.get(99065), { footprint: 1680 * 1024, threads: 1, state: 'sleeping' });
  assert.deepEqual(m.get(1), { footprint: 26 * 1024 * 1024, threads: 4, state: 'sleeping' });
  assert.deepEqual(m.get(99157), { footprint: 848 * 1024, threads: 1, state: 'running' });
  assert.equal(m.get(86764).footprint, Math.round(1.02 * 1024 ** 3));
  assert.equal(m.get(86764).threads, 17, 'threads = the total before the slash');
  // header block lines (PhysMem, Load Avg…) never become rows
  assert.equal(m.has(31), false);
  assert.equal(parseTopOutput('').size, 0);
});

test('parseTopOutput: column order follows -stats, not fixed positions', () => {
  const m = parseTopOutput('PID  STATE    #TH MEM\n42   sleeping 3   512K\n');
  assert.deepEqual(m.get(42), { footprint: 512 * 1024, threads: 3, state: 'sleeping' });
});

test('parseProcStatus: Threads, VmRSS (kB → bytes), State letter', () => {
  const text = `Name:\tpython3
Umask:\t0022
State:\tR (running)
Tgid:\t12345
Pid:\t12345
VmPeak:\t  123456 kB
VmSize:\t  100000 kB
VmHWM:\t   80000 kB
VmRSS:\t   65432 kB
RssAnon:\t   40000 kB
Threads:\t17
SigQ:\t0/63000
`;
  assert.deepEqual(parseProcStatus(text), { state: 'R', vmRss: 65432 * 1024, threads: 17 });
  assert.deepEqual(parseProcStatus(''), {});
});

test('parseSmapsRollup: Pss in bytes; null without a Pss line', () => {
  const text = `00400000-7ffd0a9f8000 ---p 00000000 00:00 0                              [rollup]
Rss:               65432 kB
Pss:               41234 kB
Pss_Anon:          30000 kB
Shared_Clean:      20000 kB
Private_Dirty:     30000 kB
`;
  assert.equal(parseSmapsRollup(text), 41234 * 1024);
  assert.equal(parseSmapsRollup('Rss: 10 kB\n'), null);
});

test('Linux probe labels RSS fallback separately from PSS footprint', () => {
  const status = 'State:\tS (sleeping)\nThreads:\t3\nVmRSS:\t10000 kB\n';
  assert.deepEqual(parseLinuxProbe(status, 'Pss: 2000 kB\n'), {
    state: 'S', threads: 3, footprint: 2000 * 1024,
  });
  assert.deepEqual(parseLinuxProbe(status, null), { state: 'S', threads: 3, rss: 10000 * 1024 });
  assert.deepEqual(parseLinuxProbe(null, null), {});
});

test('probe: empty input → empty map; unsupported platform → null; never throws', async () => {
  assert.equal((await probe([])).size, 0);
  assert.equal(await probe([1], { platform: 'win32' }), null);
  assert.equal(await probe(['x', -3, 0], { platform: 'darwin' }) instanceof Map, true, 'garbage pids are dropped, not passed to top');
});

test('probe: the live host answers for this process (darwin/linux) with a footprint',
  { skip: process.platform === 'darwin' || process.platform === 'linux' ? false : 'no probe on this platform' },
  async () => {
    const m = await probe([process.pid], { timeoutMs: 5000 });
    assert.ok(m instanceof Map, 'probe returned a map');
    const me = m.get(process.pid);
    assert.ok(me && me.footprint > 1024 * 1024, `own footprint is a real number (${JSON.stringify(me)})`);
    assert.ok(me.threads >= 1, 'thread count present');
  });
