import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { manifestOf } from '../public/pinkinds.js';

test('manifest recognition ignores inherited Object property names', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    assert.equal(manifestOf(`/fixture/${name}`), null, name);
  }
});

test('Cargo section/table/key names cannot write through Object.prototype', () => {
  const source = fs.readFileSync(new URL('../lib/pins.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function bracketDepth('), source.indexOf('const tomlStr ='));
  const result = vm.runInNewContext(`${code}
    parseTomlLite('[__proto__]\\nreviewPollution = "yes"\\n');
    parseTomlLite('[[constructor]]\\nname = "safe"\\n');
    ({ polluted: ({}).reviewPollution, constructor: typeof ({}).constructor });`);
  assert.equal(result.polluted, undefined);
  assert.equal(result.constructor, 'function');
});

function runtimeVM() {
  const source = fs.readFileSync(new URL('../lib/runtimes.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  let installed = false;
  const callbacks = [];
  const processStub = { platform: 'linux', env: { PATH: '/old' }, versions: { node: '25.6.1' } };
  const context = vm.createContext({ path, ROOT: '/unused', APP_DIR: '/dashboard', process: processStub,
    fs: { constants: { X_OK: 1 }, statSync(p) {
      if (installed && /\/(old|new)\/go$/.test(p)) return { isFile: () => true };
      throw Error('missing');
    }, accessSync() {} },
    execFile(bin, _args, _options, callback) { callbacks.push({ bin, callback }); },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  return { evaluate: code => vm.runInContext(code, context), callbacks,
    install: value => { installed = value; }, processStub };
}

test('explicit toolchain refresh invalidates cached missing and installed paths', () => {
  const f = runtimeVM();
  assert.equal(f.evaluate('toolchainStatus().go.ok'), false);
  f.install(true);
  assert.equal(f.evaluate('toolchainStatus({refresh:true}).go.ok'), true);
  f.install(false);
  assert.equal(f.evaluate('toolchainStatus({refresh:true}).go.ok'), false);
});

test('late version probes from a prior refresh cannot replace fresh versions', () => {
  const f = runtimeVM();
  f.install(true);
  f.evaluate('toolchainStatus()');
  f.processStub.env.PATH = '/new';
  f.evaluate('toolchainStatus({refresh:true})');
  assert.deepEqual(f.callbacks.map(row => row.bin), ['/old/go', '/new/go']);
  f.callbacks[1].callback(null, 'go version go1.26.0', '');
  f.callbacks[0].callback(null, 'go version go1.20.0', '');
  assert.equal(f.evaluate('toolchainStatus().go.versions.go'), 'go version go1.26.0');
});
