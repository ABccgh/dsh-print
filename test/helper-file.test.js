/**
 * helper 脚本的静态约束：必须是 UTF-8 with BOM。
 *
 * Windows PowerShell 5.1 会按 ANSI 读取没有 BOM 的 .ps1；中文注释/字符串会被解成乱码，
 * 甚至让解析器把多字节字符拆坏（本项目踩过一次）。这个测试守住回归。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PLUGIN_ROOT } from '../lib/config.js';

const HELPER = path.join(PLUGIN_ROOT, 'lib', 'helper', 'print-helper.ps1');

test('helper 脚本存在且以 UTF-8 BOM 开头', () => {
  const bytes = fs.readFileSync(HELPER);
  assert.ok(bytes.length > 1000, 'helper 脚本不应为空');
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'print-helper.ps1 必须以 UTF-8 BOM 保存，否则 Windows PowerShell 5.1 会乱码');
});

test('helper 暴露入口与关键实现片段', () => {
  const content = fs.readFileSync(HELPER, 'utf8');
  assert.match(content, /function Invoke-DshPrintAction/);
  assert.match(content, /Windows\.Data\.Pdf\.PdfDocument/);
  assert.match(content, /System\.Drawing\.Printing\.PrintDocument/);
  assert.match(content, /function Invoke-PrintPipeline/);
  assert.match(content, /function ConvertTo-PageIndexes/);
  assert.match(content, /E_PDF_ENCRYPTED/);
});
