/**
 * 配置归一与路径解析的单元测试。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAuditFile, defaultCamscannerDbPath, defaultPowershellPath, normalizeConfig, resolvePaths } from '../lib/config.js';

test('normalizeConfig 用保守默认值', () => {
  const config = normalizeConfig({});
  assert.equal(config.confirmRequired, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.maxFiles, 20);
  assert.equal(config.maxPages, 300);
  assert.equal(config.timeoutMs, 180000);
  assert.equal(config.allowPromptPrinters, false);
  assert.equal(config.auditEnabled, true);
  assert.equal(config.camscanner.enabled, true);
  assert.equal(config.office.enabled, true);
  assert.equal(config.office.timeoutMs, 120000);
  assert.equal(config.defaultPrinter, '');
});

test('normalizeConfig 忽略不可信的字符串布尔与钳制整数', () => {
  const config = normalizeConfig({
    confirmRequired: 'false',
    dryRun: 'true',
    maxFiles: 9999,
    maxPages: 0,
    timeoutMs: '5000',
    camscanner: { enabled: 'no', dbPath: 42 },
    office: { sofficePath: null, timeoutMs: 1 },
  });
  assert.equal(config.confirmRequired, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.maxFiles, 100);
  assert.equal(config.maxPages, 1);
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.camscanner.enabled, true);
  assert.equal(config.camscanner.dbPath, '');
  assert.equal(config.office.sofficePath, '');
  assert.equal(config.office.timeoutMs, 10000);
});

test('normalizeConfig 接受合法覆盖', () => {
  const config = normalizeConfig({
    defaultPrinter: 'HP Desk',
    confirmRequired: false,
    dryRun: true,
    maxFiles: 3,
    auditFile: 'C:\\tmp\\audit.jsonl',
    camscanner: { enabled: false, dbPath: 'C:\\db.sqlite' },
    office: { sofficePath: 'C:\\soffice.exe', timeoutMs: 30000 },
  });
  assert.equal(config.defaultPrinter, 'HP Desk');
  assert.equal(config.confirmRequired, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.maxFiles, 3);
  assert.equal(config.auditFile, 'C:\\tmp\\audit.jsonl');
  assert.equal(config.camscanner.enabled, false);
  assert.equal(config.camscanner.dbPath, 'C:\\db.sqlite');
  assert.equal(config.office.sofficePath, 'C:\\soffice.exe');
  assert.equal(config.office.timeoutMs, 30000);
});

test('resolvePaths 用自动探测补空缺', () => {
  const config = normalizeConfig({});
  const paths = resolvePaths(config, { exists: () => true });
  assert.match(paths.powershellPath, /WindowsPowerShell/i);
  assert.match(paths.helperPath, /print-helper\.ps1$/);
  assert.match(paths.auditFile, /dsh-print/);
  assert.ok(paths.pluginRoot.length > 0);
});

test('resolvePaths 尊重显式配置', () => {
  const config = normalizeConfig({
    powershellPath: 'C:\\ps.exe',
    helperPath: 'D:\\helper.ps1',
    auditFile: 'E:\\audit.jsonl',
  });
  const paths = resolvePaths(config, { exists: () => false });
  assert.equal(paths.powershellPath, 'C:\\ps.exe');
  assert.equal(paths.helperPath, 'D:\\helper.ps1');
  assert.equal(paths.auditFile, 'E:\\audit.jsonl');
});

test('defaultPowershellPath 找不到时退回裸名', () => {
  assert.equal(defaultPowershellPath({ exists: () => false }), 'powershell.exe');
});

test('默认审计文件与 CamScanner 库路径', () => {
  assert.match(defaultAuditFile(), /dsh-print[\\/]audit\.jsonl$/);
  assert.match(defaultCamscannerDbPath(), /CamScanner[\\/]Camscanner[\\/]camscanner\.db$/);
});
