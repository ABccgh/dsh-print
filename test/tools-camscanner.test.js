/**
 * `print_camscanner_docs` / `print_camscanner_doc` 的行为测试。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createCamscannerTools } from '../lib/tools/camscanner.js';
import { fakeHelper, findTool, makeDeps, tempDir, writeFile } from './support.js';

/**
 * 造假库：文档 1 两页全高清，文档 2 缺第 2 页。
 * @returns {{ load: Function, docs: object[], files: string[] }} 假库。
 */
function fakeLibrary() {
  const dir = tempDir();
  const page1 = writeFile(path.join(dir, 'p1.jpg'), 'jpg');
  const page2 = writeFile(path.join(dir, 'p2.jpg'), 'jpg');
  const docs = [
    {
      index: 1,
      docId: 'doc-1',
      title: '身份证 测试',
      directory: '证件卡包',
      pages: 2,
      updatedAt: 1793280246473,
      images: [
        { pageNum: 1, path: page1, quality: 'full', note: '' },
        { pageNum: 2, path: page2, quality: 'full', note: '' },
      ],
    },
    {
      index: 2,
      docId: 'doc-2',
      title: '缺页文档',
      directory: '',
      pages: 2,
      updatedAt: 1793280246474,
      images: [
        { pageNum: 1, path: page1, quality: 'preview', note: '仅预览图' },
        { pageNum: 2, path: '', quality: 'missing', note: '页图未落盘' },
      ],
    },
  ];
  return { load: async () => ({ dbPath: 'C:\\db\\camscanner.db', account: '测试账号', docs }), docs, files: [page1, page2] };
}

/**
 * 造工具。
 * @param {object} [overrides] - 依赖覆盖。
 * @returns {{ docsTool: object, docTool: object, deps: object }} 工具。
 */
function build(overrides = {}) {
  const library = overrides.library ?? fakeLibrary();
  const deps = makeDeps({
    camscanner: { load: library.load },
    helper: overrides.helper ?? fakeHelper(),
  });
  const tools = createCamscannerTools(deps);
  return { docsTool: findTool(tools, 'print_camscanner_docs'), docTool: findTool(tools, 'print_camscanner_doc'), deps };
}

test('print_camscanner_docs 列出文档与页图质量', async () => {
  const { docsTool } = build();
  const result = await docsTool.execute({});
  assert.match(result.text, /CamScanner 本地库/);
  assert.match(result.text, /身份证 测试/);
  assert.match(result.text, /2 页全高清/);
  assert.match(result.text, /缺页图/);
});

test('print_camscanner_doc 默认只出计划', async () => {
  const { docTool, deps } = build();
  const result = await docTool.execute({ doc: '1' });
  assert.match(result.text, /从 CamScanner 打印/);
  assert.match(result.text, /全高清/);
  assert.match(result.text, /confirm=true/);
  assert.equal(deps.helper.calls.some((call) => call.action === 'print-images'), false);
});

test('print_camscanner_doc 按页选择并自动横向', async () => {
  const { docTool, deps } = build();
  const result = await docTool.execute({ doc: 'doc-1', confirm: true });
  assert.match(result.text, /已提交 CamScanner 文档打印/);
  const call = deps.helper.calls.find((item) => item.action === 'print-images');
  assert.equal(call.payload.images.length, 2);
  assert.equal(call.payload.orientation, 'landscape');
  assert.match(call.payload.documentName, /CamScanner/);
});

test('print_camscanner_doc 缺页时报 E_CAMSCANNER_PAGE，选完整页则通过', async () => {
  const { docTool } = build();
  await assert.rejects(docTool.execute({ doc: 2 }), (error) => {
    assert.equal(error.code, 'E_CAMSCANNER_PAGE');
    assert.match(error.message, /第 2 页/);
    return true;
  });
  const partial = await docTool.execute({ doc: 2, pages: '1' });
  assert.match(partial.text, /仅预览/);
});

test('print_camscanner_doc 支持按标题找文档，找不到时报错', async () => {
  const { docTool } = build();
  const byTitle = await docTool.execute({ doc: '身份证' });
  assert.match(byTitle.text, /身份证 测试/);
  await assert.rejects(docTool.execute({ doc: '不存在的文档' }), (error) => {
    assert.equal(error.code, 'E_CAMSCANNER_DB');
    return true;
  });
});

test('print_camscanner_doc 的 preview 返回预览路径', async () => {
  const helper = fakeHelper({
    preview: { files: [{ page: 1, path: 'C:\\tmp\\preview.png', width: 800, height: 600 }] },
  });
  const { docTool, deps } = build({ helper });
  const result = await docTool.execute({ doc: 1, preview: true });
  assert.match(result.text, /preview\.png/);
  const call = deps.helper.calls.find((item) => item.action === 'preview');
  assert.ok(call);
});

test('print_camscanner_docs 在关闭接入时拒绝', async () => {
  const deps = makeDeps({ config: { camscanner: { enabled: false } } });
  const tool = findTool(createCamscannerTools(deps), 'print_camscanner_docs');
  await assert.rejects(tool.execute({}), (error) => {
    assert.equal(error.code, 'E_CAMSCANNER_DB');
    return true;
  });
});
