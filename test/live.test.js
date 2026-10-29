/**
 * 真机 live 测试：默认跳过，设 `DSH_PRINT_LIVE=1` 才跑。
 *
 * 只做“不消耗纸”的检查：helper 信息、打印机枚举、spool 文件写入（PrintToFile）。
 * 真纸打印留给人来验收。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig, resolvePaths } from '../lib/config.js';
import { createHelperSession } from '../lib/helper-session.js';
import { tempDir } from './support.js';

const enabled = process.env.DSH_PRINT_LIVE === '1';

/**
 * 造一个连真 helper 的会话。
 * @returns {object} 会话。
 */
function liveSession() {
  const config = normalizeConfig({});
  const paths = resolvePaths(config);
  return createHelperSession({ powershellPath: paths.powershellPath, helperPath: paths.helperPath });
}

test('live: helper 信息与打印机枚举', { skip: !enabled }, async () => {
  const session = liveSession();
  const info = await session.invoke('info', {}, { timeoutMs: 60000 });
  assert.equal(typeof info.psVersion, 'string');
  assert.equal(info.winrtOk, true);
  assert.ok(Array.isArray(info.printers));
  assert.ok(info.printers.length > 0, '本机应至少有一台打印机');
  assert.equal(typeof info.defaultPrinter, 'string');
});

test('live: 测试页写 spool 文件（不碰纸）', { skip: !enabled }, async () => {
  const session = liveSession();
  const info = await session.invoke('info', {}, { timeoutMs: 60000 });
  const printer = info.defaultPrinter || info.printers[0].name;
  const spoolFile = path.join(tempDir('dsh-print-live'), 'test-page.prn');
  const data = await session.invoke(
    'test-page',
    { printer, copies: 1, paper: 'A4', spoolFile, documentName: 'dsh-print live smoke' },
    { timeoutMs: 120000 },
  );
  assert.equal(data.pages, 1);
  assert.ok(fs.existsSync(spoolFile));
  assert.ok(fs.statSync(spoolFile).size > 1000, 'spool 文件应包含渲染后的页面数据');
});
