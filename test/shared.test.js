/**
 * 工具共用逻辑：页面范围、格式判定、路径解析、打印机解析、确认闸门。
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyFile,
  formatPageSpec,
  isPromptPrinter,
  parsePageSelection,
  planUnlessConfirmed,
  resolveInputPath,
  resolveTargetPrinter,
  text,
} from '../lib/tools/shared.js';
import { fakeHelper, makeDeps } from './support.js';

test('parsePageSelection 支持 all / 区间 / 单页 / 去重排序', () => {
  assert.deepEqual(parsePageSelection('all', 4), [1, 2, 3, 4]);
  assert.deepEqual(parsePageSelection('', 2), [1, 2]);
  assert.deepEqual(parsePageSelection('1-3,5', 5), [1, 2, 3, 5]);
  assert.deepEqual(parsePageSelection('3', 5), [3]);
  assert.deepEqual(parsePageSelection('5,1,3-4,1', 5), [1, 3, 4, 5]);
  assert.deepEqual(parsePageSelection('1，3', 5), [1, 3]);
});

test('parsePageSelection 拒绝越界与坏写法', () => {
  assert.throws(() => parsePageSelection('0', 3), /超出 1\.\.3/);
  assert.throws(() => parsePageSelection('2-9', 3), /超出 1\.\.3/);
  assert.throws(() => parsePageSelection('3-2', 3), /超出/);
  assert.throws(() => parsePageSelection('1;2', 3), /写法不对/);
  assert.throws(() => parsePageSelection('all', 0), /页数不合法/);
});

test('classifyFile 按扩展名归类且大小写无关', () => {
  assert.equal(classifyFile('a.PDF'), 'pdf');
  assert.equal(classifyFile('a.JpEg'), 'image');
  assert.equal(classifyFile('a.docx'), 'office');
  assert.equal(classifyFile('a.md'), 'text');
  assert.equal(classifyFile('a.xyz'), 'unknown');
});

test('resolveInputPath 支持 ~ 与相对路径', () => {
  assert.equal(resolveInputPath('~'), os.homedir());
  assert.equal(resolveInputPath('~/x.txt'), path.join(os.homedir(), 'x.txt'));
  assert.equal(resolveInputPath('x.txt', 'C:\\work'), path.resolve('C:\\work', 'x.txt'));
  assert.throws(() => resolveInputPath('   '), /不能为空/);
});

test('isPromptPrinter 识别 PDF/XPS 虚拟打印机', () => {
  assert.equal(isPromptPrinter({ name: 'Microsoft Print to PDF', portName: 'PORTPROMPT:' }), true);
  assert.equal(isPromptPrinter({ name: '随便', portName: 'PORTPROMPT:' }), true);
  assert.equal(isPromptPrinter({ name: 'Microsoft XPS Document Writer', portName: 'PORTPROMPT:' }), true);
  assert.equal(isPromptPrinter({ name: 'HP DeskJet 2600 series', portName: 'USB001' }), false);
});

test('resolveTargetPrinter 用默认打印机并拒绝不存在的打印机', async () => {
  const deps = makeDeps({ helper: fakeHelper() });
  const printer = await resolveTargetPrinter(deps, undefined);
  assert.equal(printer.name, 'HP Test');
  await assert.rejects(resolveTargetPrinter(deps, 'No Such Printer'), (error) => {
    assert.equal(error.code, 'E_PRINTER_NOT_FOUND');
    assert.match(error.message, /HP Test/);
    return true;
  });
});

test('resolveTargetPrinter 默认拒绝需要弹框的打印机，配置放开后才允许', async () => {
  const strict = makeDeps({ helper: fakeHelper() });
  await assert.rejects(resolveTargetPrinter(strict, 'Microsoft Print to PDF'), (error) => {
    assert.equal(error.code, 'E_PRINTER_PROMPT');
    return true;
  });
  const permissive = makeDeps({ config: { allowPromptPrinters: true }, helper: fakeHelper() });
  const printer = await resolveTargetPrinter(permissive, 'Microsoft Print to PDF');
  assert.equal(printer.name, 'Microsoft Print to PDF');
});

test('resolveTargetPrinter 在没有任何打印机时报错', async () => {
  const helper = fakeHelper({
    info: { printers: [], defaultPrinter: '' },
  });
  const deps = makeDeps({ helper });
  await assert.rejects(resolveTargetPrinter(deps, undefined), (error) => {
    assert.equal(error.code, 'E_PRINTER_NOT_FOUND');
    return true;
  });
});

test('planUnlessConfirmed：确认前只出计划，dryRun 永远只出计划', () => {
  const deps = makeDeps();
  const pending = planUnlessConfirmed(deps, 'print_file', { confirm: false }, '计划正文');
  assert.match(pending.text, /只是计划/);
  assert.match(pending.text, /confirm=true/);

  const confirmed = planUnlessConfirmed(deps, 'print_file', { confirm: true }, '计划正文');
  assert.equal(confirmed, undefined);

  const dryDeps = makeDeps({ config: { dryRun: true } });
  const dry = planUnlessConfirmed(dryDeps, 'print_file', { confirm: true }, '计划正文');
  assert.match(dry.text, /dry-run/);

  const optionalDeps = makeDeps({ config: { confirmRequired: false } });
  assert.equal(planUnlessConfirmed(optionalDeps, 'print_file', {}, '计划正文'), undefined);
});

test('formatPageSpec 压缩连续页并保留跳页', () => {
  assert.equal(formatPageSpec([1, 2, 3]), '1-3');
  assert.equal(formatPageSpec([2]), '2');
  assert.equal(formatPageSpec([1, 3, 4, 5, 9]), '1,3-5,9');
  assert.equal(formatPageSpec([]), 'all');
});

test('text 输出形状固定', () => {
  assert.deepEqual(text(42), { text: '42' });
});
