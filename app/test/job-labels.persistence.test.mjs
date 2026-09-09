// Independently exercise backend detection/title metadata through terminal
// history and a NEW process. No interpreter or billed provider is launched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-job-title-history-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const project = path.join(root, 'project'); fs.mkdirSync(project);
process.env.CP_ROOT = root;
process.env.CP_PROJECTS_JSON = JSON.stringify({ alpha: { root: project } });
const lib = await import('../lib/jobs.js');
lib._test.setPolling(false);
let now = Date.parse('2026-09-09T12:00:00.000Z'); lib._test.setClock(() => now);
after(() => { lib._test.setPolling(false); lib._test.setClock(null); });

test('inline, real-file and generated titles persist with their type and immutable owner', () => {
  const marker = (dir, file, body) => { fs.mkdirSync(path.join(project, dir), { recursive: true }); fs.writeFileSync(path.join(project, dir, file), body); };
  marker('js', 'package.json', JSON.stringify({ name: '@scope/pkg' }));
  marker('rust', 'Cargo.toml', '[package]\nname="crate"\nversion="0.1.0"\n');
  marker('go', 'go.mod', 'module example.org/pkg\n');
  marker('cpp', 'CMakeLists.txt', 'project(sample LANGUAGES CXX)\n');
  const cases = [
    ['julia -e "println(1/2)"', '', null, 'inline', 'inline Julia'],
    ['julia -e "println(1/2)"', 'Fit φ/Φ at /tmp/data', null, 'label', 'Fit φ/Φ at /tmp/data'],
    ['python -c "print(1/2)"', 'Read https://example.org/a/b', null, 'label', 'Read https://example.org/a/b'],
    ['Rscript -e "print(1/2)"', '<img src=x onerror=bad()> / run', null, 'label', '<img src=x onerror=bad()> / run'],
    ['node -e "console.log(1/2)"', 'Compare x/y', null, 'label', 'Compare x/y'],
    ['julia nested/model.jl', '', 'nested/model.jl', 'file', 'nested/model.jl'],
    ['Rscript nested/model.R', '', 'nested/model.R', 'file', 'nested/model.R'],
    ['python nested/model.py', '', 'nested/model.py', 'file', 'nested/model.py'],
    ['node nested/model.js', '', 'nested/model.js', 'file', 'nested/model.js'],
    ['cd js && npm run bench/solve', '', null, 'label', 'pkg (npm run bench/solve)'],
    ['cd rust && cargo test', '', null, 'label', 'crate (cargo test)'],
    ['cd go && go test ./...', '', null, 'label', null],
    ['cd cpp && make build/foo', '', null, 'label', 'cpp (make build/foo)'],
  ];
  const expected = [];
  for (const [index, [command, label, file, kind, title]] of cases.entries()) {
    const owner = { project: 'alpha', taskId: 'task', taskCreated: '2026-09-09T10:00:00Z', appTurnId: 'turn-one' };
    const job = lib.sessionJobStart('alpha', 'task', `tool-${index}`, command, { ...owner, label });
    assert.ok(job, command);
    assert.equal(job.file, file, command);
    assert.equal(job.titleKind, kind, command);
    if (title) assert.equal(job.displayTitle, title, command);
    assert.equal(lib._test.publicJob(job).command, command);
    assert.ok(job.jobRunId); assert.equal(job.appTurnId, owner.appTurnId);
    job.visible = true; now += 1200;
    lib.sessionJobEnd(`tool-${index}`, owner);
    const entry = lib.getJobHistory('alpha').at(-1);
    for (const key of ['file', 'displayTitle', 'titleKind', 'jobRunId', 'createdAt', 'taskCreated', 'appTurnId', 'key', 'command']) assert.equal(entry[key], job[key], `${command}: ${key}`);
    assert.equal(entry.state, 'done'); assert.equal(entry.ms, 1200);
    expected.push({ displayTitle: entry.displayTitle, titleKind: entry.titleKind, file: entry.file, jobRunId: entry.jobRunId });
  }
  const url = new URL('../lib/jobs.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {getJobHistory}=await import(${JSON.stringify(url)});console.log(JSON.stringify(getJobHistory('alpha').map(({displayTitle,titleKind,file,jobRunId})=>({displayTitle,titleKind,file,jobRunId}))));`],
    { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), expected);
});
