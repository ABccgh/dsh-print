/**
 * Cordis 装配：apply 必须往工具表注册 7 个工具，且不能返回值。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, createDeps, createToolDefinitions } from '../lib/index.js';

/**
 * 造一个记录注册动作的假 Cordis 上下文。
 * @returns {{ ctx: object, registered: object[], effects: Function[] }} 上下文与记录。
 */
function fakeContext() {
  const registered = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      effects.push(callback);
      return callback();
    },
  };
  return { ctx, registered, effects };
}

test('apply 注册 7 个 print_* 工具', async () => {
  const { ctx, registered } = fakeContext();
  const result = await apply(ctx, {});
  assert.equal(result, undefined, 'apply 不能返回值（Cordis 会把返回值当 effect）');
  assert.equal(registered.length, 7);
  assert.deepEqual(registered.map((definition) => definition.name), [
    'print_status',
    'print_file',
    'print_test_page',
    'print_jobs',
    'print_cancel',
    'print_camscanner_docs',
    'print_camscanner_doc',
  ]);
  for (const definition of registered) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
  }
});

test('createToolDefinitions 与 apply 注册的工具一致', () => {
  const deps = createDeps({
    powershellPath: '',
    helperPath: '',
    timeoutMs: 1000,
    requestTimeoutMs: 1000,
    defaultPrinter: '',
    confirmRequired: true,
    dryRun: false,
    maxFiles: 1,
    maxPages: 1,
    allowPromptPrinters: false,
    auditEnabled: false,
    auditFile: '',
    camscanner: { enabled: true, dbPath: '' },
    office: { enabled: true, sofficePath: '', kitCliPath: '', nodePath: '', timeoutMs: 1000 },
  }, {
    paths: { pluginRoot: '.', powershellPath: 'powershell.exe', helperPath: 'h.ps1', auditFile: 'a.jsonl' },
    helper: { invoke: async () => ({}) },
    office: { detect: () => null, convert: async () => { throw new Error('no'); } },
    camscanner: { load: async () => ({ dbPath: '', account: '', docs: [] }) },
    exists: () => false,
    statSync: () => ({ size: 0, mtime: new Date() }),
  });
  const definitions = createToolDefinitions(deps);
  assert.equal(definitions.length, 7);
  assert.equal(new Set(definitions.map((definition) => definition.name)).size, 7);
});
