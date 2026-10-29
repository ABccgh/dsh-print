/**
 * `print_file` / `print_test_page` 的行为测试（全部用假 helper，不碰打印机）。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createPrintTools } from '../lib/tools/print.js';
import { createJobTools } from '../lib/tools/jobs.js';
import { fakeHelper, findTool, makeDeps, tempDir, writeFile } from './support.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 造一组测试文件。
 * @returns {{ dir: string, pdf: string, png: string, txt: string, docx: string, xyz: string }} 路径。
 */
function fixtureFiles() {
  const dir = tempDir();
  return {
    dir,
    pdf: writeFile(path.join(dir, 'doc.pdf'), '%PDF-1.4 fake'),
    png: writeFile(path.join(dir, 'photo.png'), PNG_1X1),
    txt: writeFile(path.join(dir, 'note.txt'), '第一行\n第二行\n'),
    docx: writeFile(path.join(dir, 'letter.docx'), 'fake docx'),
    xyz: writeFile(path.join(dir, 'x.xyz'), 'x'),
  };
}

/**
 * 造打印工具集。
 * @param {object} [overrides] - 依赖覆盖。
 * @returns {{ printFile: object, testPage: object, deps: object }} 工具。
 */
function build(overrides = {}) {
  const deps = makeDeps(overrides);
  const tools = createPrintTools(deps);
  return {
    printFile: findTool(tools, 'print_file'),
    testPage: findTool(tools, 'print_test_page'),
    deps,
  };
}

test('print_file 默认只出计划，不改打印队列', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build();
  const result = await printFile.execute({ files: [files.pdf] });
  assert.match(result.text, /打印计划/);
  assert.match(result.text, /共 3 页/);
  assert.match(result.text, /confirm=true/);
  assert.equal(deps.helper.calls.some((call) => call.action === 'print-pdf'), false);
});

test('print_file 确认后按页范围打印 PDF', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build();
  const result = await printFile.execute({ files: [files.pdf], confirm: true });
  assert.match(result.text, /已提交打印/);
  const call = deps.helper.calls.find((item) => item.action === 'print-pdf');
  assert.ok(call);
  assert.equal(call.payload.pdf, files.pdf);
  assert.equal(call.payload.pages, '1-3');
  assert.equal(call.payload.printer, 'HP Test');
  assert.equal(call.payload.copies, 1);
});

test('print_file 支持页面范围与份数', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build();
  const plan = await printFile.execute({ files: [files.pdf], pages: '2', copies: 2 });
  assert.match(plan.text, /第 2 页 × 2 份 = 2 页/);
  await printFile.execute({ files: [files.pdf], pages: '2', copies: 2, confirm: true });
  const call = deps.helper.calls.find((item) => item.action === 'print-pdf');
  assert.equal(call.payload.pages, '2');
  assert.equal(call.payload.copies, 2);
});

test('print_file 对横向图片自动用横向纸', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build();
  const plan = await printFile.execute({ files: [files.png] });
  assert.match(plan.text, /横向/);
  await printFile.execute({ files: [files.png], confirm: true });
  const call = deps.helper.calls.find((item) => item.action === 'print-images');
  assert.equal(call.payload.orientation, 'landscape');
  assert.deepEqual(call.payload.images, [files.png]);
});

test('print_file 打印文本走 print-text', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build();
  const plan = await printFile.execute({ files: [files.txt] });
  assert.match(plan.text, /文本/);
  await printFile.execute({ files: [files.txt], confirm: true });
  const call = deps.helper.calls.find((item) => item.action === 'print-text');
  assert.equal(call.payload.textFile, files.txt);
});

test('print_file 对未知格式给 E_UNSUPPORTED_FORMAT', async () => {
  const files = fixtureFiles();
  const { printFile } = build();
  await assert.rejects(printFile.execute({ files: [files.xyz] }), (error) => {
    assert.equal(error.code, 'E_UNSUPPORTED_FORMAT');
    return true;
  });
});

test('print_file 对不存在的文件给 E_FILE_NOT_FOUND', async () => {
  const { printFile } = build();
  await assert.rejects(printFile.execute({ files: ['C:\\no\\such\\file.pdf'] }), (error) => {
    assert.equal(error.code, 'E_FILE_NOT_FOUND');
    return true;
  });
});

test('print_file 超过 maxFiles 时拒绝', async () => {
  const files = fixtureFiles();
  const { printFile } = build({ config: { maxFiles: 1 } });
  await assert.rejects(printFile.execute({ files: [files.pdf, files.png] }), (error) => {
    assert.equal(error.code, 'E_LIMIT');
    return true;
  });
});

test('print_file 超过 maxPages 时拒绝', async () => {
  const files = fixtureFiles();
  const { printFile } = build({ config: { maxPages: 2 } });
  await assert.rejects(printFile.execute({ files: [files.pdf] }), (error) => {
    assert.equal(error.code, 'E_LIMIT');
    return true;
  });
});

test('print_file 目标打印机需要弹框时拒绝', async () => {
  const files = fixtureFiles();
  const { printFile } = build();
  await assert.rejects(printFile.execute({ files: [files.pdf], printer: 'Microsoft Print to PDF' }), (error) => {
    assert.equal(error.code, 'E_PRINTER_PROMPT');
    return true;
  });
});

test('print_file 在 dryRun 下确认也不打印', async () => {
  const files = fixtureFiles();
  const { printFile, deps } = build({ config: { dryRun: true } });
  const result = await printFile.execute({ files: [files.pdf], confirm: true });
  assert.match(result.text, /dry-run/);
  assert.equal(deps.helper.calls.some((call) => call.action === 'print-pdf'), false);
});

test('print_file 对 Office 文件：没 LibreOffice 时报 E_OFFICE_MISSING', async () => {
  const files = fixtureFiles();
  const { printFile } = build();
  await assert.rejects(printFile.execute({ files: [files.docx] }), (error) => {
    assert.equal(error.code, 'E_OFFICE_MISSING');
    return true;
  });
});

test('print_file 对 Office 文件：先转 PDF 再打印', async () => {
  const files = fixtureFiles();
  const converted = writeFile(path.join(files.dir, 'converted.pdf'), '%PDF-1.4 fake');
  const conversions = [];
  const { printFile, deps } = build({
    office: {
      detect: () => ({ backend: 'soffice', executable: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' }),
      convert: async (input) => {
        conversions.push(input);
        return { pdfPath: converted, dispose() {} };
      },
    },
  });
  const plan = await printFile.execute({ files: [files.docx] });
  assert.match(plan.text, /Office|DOCX/i);
  await printFile.execute({ files: [files.docx], confirm: true });
  assert.deepEqual(conversions, [files.docx]);
  const call = deps.helper.calls.find((item) => item.action === 'print-pdf');
  assert.equal(call.payload.pdf, converted);
});

test('print_file 支持 preview 出预览图路径', async () => {
  const files = fixtureFiles();
  const helper = fakeHelper({
    preview: { files: [{ page: 1, path: 'C:\\tmp\\p1.png', width: 1200, height: 1697 }] },
  });
  const { printFile, deps } = build({ helper });
  const result = await printFile.execute({ files: [files.pdf], preview: true });
  assert.match(result.text, /预览/);
  assert.match(result.text, /p1\.png/);
  const call = deps.helper.calls.find((item) => item.action === 'preview');
  assert.ok(call);
  assert.equal(call.payload.pdf, files.pdf);
});

test('print_test_page 先计划后打印', async () => {
  const { testPage, deps } = build();
  const plan = await testPage.execute({});
  assert.match(plan.text, /测试页计划/);
  assert.equal(deps.helper.calls.some((call) => call.action === 'test-page'), false);
  const done = await testPage.execute({ confirm: true, copies: 2 });
  assert.match(done.text, /已提交测试页/);
  const call = deps.helper.calls.find((item) => item.action === 'test-page');
  assert.equal(call.payload.copies, 2);
  assert.equal(call.payload.printer, 'HP Test');
});

test('print_jobs 渲染队列任务', async () => {
  const helper = fakeHelper({
    jobs: {
      printer: 'HP Test',
      jobs: [{ id: 7, document: 'doc.pdf [dsh-print]', status: 'Printing', pages: 1, totalPages: 3, position: 2 }],
    },
  });
  const deps = makeDeps({ helper });
  const tool = findTool(createJobTools(deps), 'print_jobs');
  const result = await tool.execute({});
  assert.match(result.text, /#7/);
  assert.match(result.text, /1\/3 页/);
  assert.match(result.text, /队列位 #2/);
});

test('print_cancel 先计划、确认后取消', async () => {
  const helper = fakeHelper({
    jobs: { printer: 'HP Test', jobs: [{ id: 9, document: 'x', status: 'Error', pages: 0, totalPages: 2, position: 1 }] },
  });
  const deps = makeDeps({ helper });
  const tool = findTool(createJobTools(deps), 'print_cancel');
  const plan = await tool.execute({ printer: 'HP Test', jobId: 9 });
  assert.match(plan.text, /将取消 1 个任务/);
  assert.equal(helper.calls.some((call) => call.action === 'cancel'), false);
  const done = await tool.execute({ printer: 'HP Test', jobId: 9, confirm: true });
  assert.match(done.text, /已取消 1 个打印任务/);
  const call = helper.calls.find((item) => item.action === 'cancel');
  assert.deepEqual(call.payload, { printer: 'HP Test', jobId: 9 });
});

test('print_cancel 缺 jobId 时报参数错误', async () => {
  const { deps } = build();
  const tool = findTool(createJobTools(deps), 'print_cancel');
  await assert.rejects(tool.execute({ printer: 'HP Test' }), (error) => {
    assert.equal(error.code, 'E_BAD_ARGS');
    return true;
  });
});
