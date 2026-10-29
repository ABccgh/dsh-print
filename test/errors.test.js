/**
 * 错误类型与描述。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PrintError, codeHint, describeError, normalizeError, printError } from '../lib/errors.js';

test('printError 保留错误码与细节', () => {
  const error = printError('E_LIMIT', '页数太多', { pages: 999 });
  assert.ok(error instanceof PrintError);
  assert.equal(error.code, 'E_LIMIT');
  assert.equal(error.message, '页数太多');
  assert.deepEqual(error.detail, { pages: 999 });
});

test('normalizeError 原样返回插件错误', () => {
  const original = printError('E_SPOOL', '失败');
  assert.equal(normalizeError(original), original);
});

test('normalizeError 包装普通异常', () => {
  const normalized = normalizeError(new Error('boom'));
  assert.equal(normalized.code, 'E_INTERNAL');
  assert.equal(normalized.message, 'boom');
});

test('normalizeError 保留外来的 E_ 错误码', () => {
  const normalized = normalizeError({ code: 'E_PDF_RENDER', message: '坏页' });
  assert.equal(normalized.code, 'E_PDF_RENDER');
  assert.equal(normalized.message, '坏页');
});

test('describeError 带错误码与中文提示', () => {
  const text = describeError(printError('E_PRINTER_NOT_FOUND', '没有打印机'));
  assert.match(text, /E_PRINTER_NOT_FOUND/);
  assert.match(text, /打印机不存在/);
  assert.match(text, /没有打印机/);
});

test('codeHint 暴露默认说明', () => {
  assert.equal(codeHint('E_TIMEOUT'), '打印/渲染超时');
  assert.equal(codeHint('E_NOT_A_REAL_CODE'), undefined);
});
