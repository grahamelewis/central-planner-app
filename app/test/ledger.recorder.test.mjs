// Exercise the REAL recorder in isolated Node processes, including import-time
// config, cold cache, append durability, restart and effective snapshot reads.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ledger-recorder-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const moduleURL = new URL('../lib/ledger.js', import.meta.url).href;
let serial = 0;
function sandbox() {
  const dir = path.join(root, String(++serial));
  fs.mkdirSync(dir);
  return dir;
}
function run(dir, body) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
     const { logTokens, logTokenBatch, logTime, tokenEntries, weekSummary, dailyActivity, usageWindows } = await import(${JSON.stringify(moduleURL)});
     ${body}`], { encoding: 'utf8', env: { ...process.env, CP_ROOT: dir,
      CP_PROJECTS_JSON: JSON.stringify({ alpha: {}, beta: {} }) } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}
function seed(dir, rows, ending = '\n') {
  fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger/ledger.jsonl'), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + ending);
}
const details = `{usageId:'u1',provider:'codex',action:'session',threadId:'th1',turnId:'tu1',completeness:'partial',costSource:'subscription'}`;

test('first cold append is counted once in memory, on disk, and after restart', () => {
  const dir = sandbox();
  run(dir, `assert.equal(logTokens('alpha','t',100,20,null,'gpt-test',${details}),true);
    assert.equal(weekSummary().totals.tokens,120); assert.equal(tokenEntries().length,1);`);
  run(dir, `assert.equal(weekSummary().totals.tokens,120); assert.equal(tokenEntries().length,1);`);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger/ledger.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('warm and cold duplicate snapshots are no-ops; real revisions replace, not add', () => {
  const dir = sandbox();
  run(dir, `const d=${details}; logTokens('alpha','t',100,20,null,'gpt-test',d);
    assert.equal(logTokens('alpha','t',100,20,null,'gpt-test',d),false);
    assert.equal(logTokens('alpha','t',180,40,null,'gpt-test',{...d,completeness:'complete'}),true);
    assert.equal(weekSummary().totals.tokens,220); assert.equal(tokenEntries().length,1);`);
  run(dir, `const d={...${details},completeness:'complete'};
    assert.equal(logTokens('alpha','t',180,40,null,'gpt-test',d),false);
    assert.equal(weekSummary().totals.tokens,220); assert.equal(tokenEntries()[0].revision,2);`);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger/ledger.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('authoritative result can revise a provisional overcount downward', () => {
  const dir = sandbox();
  run(dir, `const d=${details}; logTokens('alpha','t',100,20,null,'gpt-test',d);
    logTokens('alpha','t',80,15,null,'gpt-test',{...d,completeness:'complete'});
    assert.equal(weekSummary().totals.tokens,95);`);
});

test('revisions preserve original date and cannot move accounting identity', () => {
  const dir = sandbox();
  const original = '2020-01-01T00:00:00.000Z';
  seed(dir, [{ ts: original, type: 'tokens', project: 'alpha', taskId: 't', in: 100, out: 20,
    costUsd: null, model: 'gpt-test', usageId: 'u1', provider: 'codex', action: 'session',
    threadId: 'th1', turnId: 'tu1', completeness: 'partial', costSource: 'subscription', costEstimated: false }]);
  run(dir, `const d=${details}; logTokens('alpha','t',200,40,null,'gpt-test',d);
    assert.equal(tokenEntries()[0].ts,${JSON.stringify(original)});
    assert.equal(weekSummary().totals.tokens,0);
    assert.throws(()=>logTokens('beta','t',200,40,null,'gpt-test',d),/scope/);
    assert.throws(()=>logTokens('alpha','other',200,40,null,'gpt-test',d),/scope/);
    for(const key of ['provider','action','threadId','turnId','appTurnId','taskCreated'])
      assert.throws(()=>logTokens('alpha','t',200,40,null,'gpt-test',{...d,[key]:'other'}),/scope/);`);
});

test('unknown IDs can become known once and rerouted model attribution can change', () => {
  const dir = sandbox();
  run(dir, `const d={usageId:'u',provider:'codex',action:'session',completeness:'partial'};
    logTokens('alpha','t',10,1,null,'gpt-one',d);
    logTokens('alpha','t',20,2,null,null,{...d,threadId:'th',turnId:'tu'});
    assert.equal(tokenEntries()[0].model,null);
    assert.equal(tokenEntries()[0].threadId,'th');
    assert.throws(()=>logTokens('alpha','t',30,3,null,null,{...d,threadId:'other',turnId:'tu'}),/scope/);`);
});

test('invalid, unsafe or inconsistent counts never write a row', () => {
  const dir = sandbox();
  run(dir, `for(const bad of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'100',null,undefined]) {
      assert.throws(()=>logTokens('alpha','t',bad,0,null,'gpt-test'));
      assert.throws(()=>logTokens('alpha','t',0,bad,null,'gpt-test'));
    }
    assert.throws(()=>logTokens('alpha','t',100,20,null,'gpt-test',{cachedInputTokens:101}));
    assert.throws(()=>logTokens('alpha','t',100,20,null,'gpt-test',{uncachedInputTokens:60,cachedInputTokens:40,cacheWriteInputTokens:1}));
    assert.throws(()=>logTokens('alpha','t',100,20,null,'gpt-test',{reasoningOutputTokens:21}));
    for(const bad of [-1,NaN,Infinity,'0']) assert.throws(()=>logTokens('alpha','t',1,1,bad,'gpt-test'));
    assert.equal(tokenEntries().length,0);`);
});

test('unknown usage is explicit, not free or known zero; global helper included', () => {
  const dir = sandbox();
  run(dir, `logTokens(null,null,null,null,null,'gpt-test',{usageId:'profile',provider:'codex',action:'profile',completeness:'unknown',costSource:'subscription'});
    assert.equal(tokenEntries()[0].in,null); assert.equal(tokenEntries()[0].costUsd,null);
    const s=weekSummary(); assert.equal(s.totals.tokens,0);
    assert.equal(s.totals.costCoverage.unknownUsageEntries,1);
    assert.equal(s.perProject.__global__.costCoverage.entries,1);`);
});

test('cache/reasoning breakdown, cost source and provider filtering survive restart', () => {
  const dir = sandbox();
  run(dir, `logTokens('alpha','t',100,20,0,'gpt-test',{...${details},uncachedInputTokens:40,cachedInputTokens:50,cacheWriteInputTokens:10,reasoningOutputTokens:7});
    logTokens('alpha','c',200,30,0.05,'claude-test',{usageId:'c',provider:'claude',action:'memory',completeness:'complete',costSource:'provider-estimate'});`);
  run(dir, `const [c]=tokenEntries({provider:'codex',project:'alpha',taskId:'t'});
    assert.equal(c.cachedInputTokens,50);assert.equal(c.uncachedInputTokens,40);assert.equal(c.cacheWriteInputTokens,10);assert.equal(c.reasoningOutputTokens,7);
    assert.equal(c.costUsd,null); const s=weekSummary();assert.equal(s.totals.tokens,350);
    assert.equal(s.totals.costCoverage.unknownCostTokens,120);assert.equal(s.totals.costCoverage.estimatedUsd,0.05);
    assert.equal(s.byProvider.codex.tokensIn,100);assert.equal(s.byProvider.claude.tokensIn,200);
    assert.equal(usageWindows().limits.find(l=>l.key==='wk').spent,230);`);
});

test('broken trailing JSON does not swallow the next durable observation', () => {
  const dir = sandbox();
  seed(dir, ['{"ts":"torn'], '');
  run(dir, `logTokens('alpha','t',10,2,null,'gpt-test',${details}); assert.equal(tokenEntries().length,1);`);
  run(dir, `assert.equal(tokenEntries().length,1);assert.equal(weekSummary().totals.tokens,12);`);
});

test('ledger write and initial read failures throw; no success is reported', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'ledger'), 'not a directory');
  run(dir, `assert.throws(()=>logTokens('alpha','t',10,2,null,'gpt-test',${details}));`);
  const dir2 = sandbox();
  fs.mkdirSync(path.join(dir2, 'ledger/ledger.jsonl'), { recursive: true });
  run(dir2, `assert.throws(()=>tokenEntries());assert.throws(()=>logTokens('alpha','t',10,2,null,'gpt-test',${details}));`);
});

test('time entries do not cold-double-count, and callers cannot mutate effective rows', () => {
  const dir = sandbox();
  run(dir, `logTime('alpha',60);assert.equal(weekSummary().totals.seconds,60);
    logTokens('alpha','t',10,2,null,'gpt-test',${details});const e=tokenEntries()[0];e.in=999;
    assert.equal(tokenEntries()[0].in,10);`);
});

test('legacy zero costs and unknown provider attribution remain explicitly uncertain', () => {
  const dir = sandbox();
  seed(dir, [{ ts: new Date().toISOString(), type: 'tokens', project: 'alpha', taskId: 't', in: 100, out: 20, costUsd: 0 }]);
  run(dir, `const s=weekSummary(); assert.equal(s.totals.tokens,120);
    assert.equal(s.totals.costCoverage.unknownCostTokens,120);assert.equal(s.totals.costCoverage.legacyTokens,120);
    assert.equal(s.usage.unknownProviderTokens,120);assert.equal(s.usage.limits.find(l=>l.key==='wk').spent,0);`);
});

test('multi-model batch atomically replaces provisional rows with final rows and replays once', () => {
  const dir = sandbox();
  run(dir, `const d=${details};logTokens('alpha','t',100,20,null,'gpt-test',d);
    const records=[{project:'alpha',taskId:'t',tokensIn:0,tokensOut:0,costUsd:null,model:'gpt-test',details:{...d,completeness:'complete'}},
      {project:'alpha',taskId:'t',tokensIn:80,tokensOut:15,costUsd:0.01,model:'claude-a',details:{usageId:'a',provider:'claude',action:'session',completeness:'complete',costSource:'provider-estimate'}},
      {project:'alpha',taskId:'t',tokensIn:40,tokensOut:10,costUsd:0.02,model:'claude-b',details:{usageId:'b',provider:'claude',action:'session',completeness:'complete',costSource:'provider-estimate'}}];
    assert.equal(logTokenBatch(records),true);assert.equal(logTokenBatch(records),false);
    assert.equal(weekSummary().totals.tokens,145);assert.equal(tokenEntries().length,3);`);
  run(dir, `assert.equal(weekSummary().totals.tokens,145);assert.equal(tokenEntries().length,3);`);
  const lines = fs.readFileSync(path.join(dir, 'ledger/ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).type, 'token-batch');
  assert.equal(JSON.parse(lines[1]).version, 2);
  assert.equal(JSON.parse(lines[1]).entries.length, 3);
});

test('batch validation rejects all before writing, including duplicate ids and scope collisions', () => {
  const dir = sandbox();
  run(dir, `logTokens('alpha','t',10,2,null,'gpt-test',${details});
    const r={project:'alpha',taskId:'t',tokensIn:50,tokensOut:10,costUsd:null,model:'gpt-test',details:${details}};
    assert.throws(()=>logTokenBatch([r,{...r,details:{...r.details,usageId:'u2'},tokensIn:-1}]));
    assert.throws(()=>logTokenBatch([r,r]),/unique/);
    assert.throws(()=>logTokenBatch([{...r,details:{...r.details,usageId:'u2'}},{...r,project:'beta'}]),/scope/);
    assert.equal(weekSummary().totals.tokens,12);assert.equal(tokenEntries().length,1);`);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger/ledger.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('crash-truncated or invalid batch applies no member on restart', () => {
  const dir = sandbox();
  const row = { ts: new Date().toISOString(), type: 'tokens', project: 'alpha', taskId: 't', in: 10, out: 2,
    costUsd: null, model: 'gpt-test', usageId: 'u1', provider: 'codex', completeness: 'partial' };
  const goodReplacement = { ...row, in: 500 };
  seed(dir, [row, { type: 'token-batch', version: 2, entries: [goodReplacement, { ...row, usageId: 'u2', in: -5 }] },
    `{"type":"token-batch","version":2,"entries":[${JSON.stringify(goodReplacement)},`], '');
  run(dir, `assert.equal(weekSummary().totals.tokens,12);assert.equal(tokenEntries().length,1);`);
});

test('superseded model placeholders do not claim unknown cost or incomplete coverage', () => {
  const dir = sandbox();
  run(dir, `const d={usageId:'placeholder',provider:'claude',action:'session',completeness:'unknown'};
    logTokens('alpha','t',null,null,null,null,d);
    logTokenBatch([{project:'alpha',taskId:'t',tokensIn:0,tokensOut:0,costUsd:null,model:null,details:{...d,completeness:'complete',superseded:true}},
      {project:'alpha',taskId:'t',tokensIn:100,tokensOut:20,costUsd:0.5,model:'claude-a',details:{usageId:'final',provider:'claude',action:'session',completeness:'complete',costSource:'provider-estimate'}}]);
    const c=weekSummary().totals.costCoverage;assert.equal(c.entries,1);assert.equal(c.unknownCostEntries,0);assert.equal(c.unknownUsageEntries,0);
    assert.throws(()=>logTokens('alpha','t',1,0,null,null,{...d,superseded:true}));`);
  run(dir, `assert.equal(weekSummary().totals.costCoverage.unknownCostEntries,0);assert.equal(tokenEntries().length,2);`);
});

test('nullable identity filters match omitted metadata and tombstones do not anchor quota windows', () => {
  const dir = sandbox();
  run(dir, `logTokens('alpha','t',0,0,null,'claude-test',{usageId:'zero',provider:'claude',action:'session',superseded:true,completeness:'complete'});
    assert.equal(tokenEntries({taskCreated:null}).length,1);
    assert.equal(tokenEntries({taskCreated:'other'}).length,0);
    assert.equal(usageWindows().limits[0].resetAt,null);`);
});
