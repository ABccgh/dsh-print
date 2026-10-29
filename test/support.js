/**
 * 测试共用工具：临时目录、假 helper、假依赖。
 *
 * @module @local/print/test/support
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { createDeps } from '../lib/index.js';

/**
 * 本进程创建的临时目录；进程退出时统一删除，避免把 `%TEMP%` 堆满。
 * @type {Set<string>}
 */
const createdTempDirs = new Set();
let cleanupHooked = false;

/**
 * 建一个临时目录（进程退出时自动清理）。
 * @param {string} [prefix] - 前缀。
 * @returns {string} 目录。
 */
export function tempDir(prefix = 'dsh-print-test') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  createdTempDirs.add(directory);
  if (!cleanupHooked) {
    cleanupHooked = true;
    process.on('exit', () => {
      for (const item of createdTempDirs) {
        try {
          fs.rmSync(item, { recursive: true, force: true });
        } catch {
          // 清理失败无所谓。
        }
      }
    });
  }
  return directory;
}

/**
 * 写一个文件（自动建目录）。
 * @param {string} file - 路径。
 * @param {string | Buffer} content - 内容。
 * @returns {string} 路径。
 */
export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * 假 helper：记录调用并回放预设结果。
 * @param {Record<string, any>} overrides - 按动作覆盖的返回值或函数。
 * @returns {{ calls: object[], invoke: Function }} 假 helper。
 */
export function fakeHelper(overrides = {}) {
  const calls = [];
  const helper = {
    calls,
    async invoke(action, payload = {}, options = {}) {
      calls.push({ action, payload, options });
      const handler = overrides[action];
      if (typeof handler === 'function') return handler(payload, options);
      if (handler !== undefined) return handler;
      switch (action) {
        case 'info':
          return {
            psVersion: '5.1',
            winrtOk: true,
            drawingOk: true,
            elevated: true,
            printers: [
              { name: 'HP Test', portName: 'USB001', driverName: 'IPP', printerStatus: 'Normal', isDefault: true },
              { name: 'Microsoft Print to PDF', portName: 'PORTPROMPT:', driverName: 'PDF', printerStatus: 'Normal', isDefault: false },
            ],
            defaultPrinter: 'HP Test',
            printJobs: 0,
            paperSizes: ['A4'],
          };
        case 'inspect':
          return {
            pdfs: (payload.pdfs ?? []).map((file) => ({ path: file, pages: 3, sizes: [{ width: 793, height: 1122 }, { width: 793, height: 1122 }, { width: 793, height: 1122 }] })),
            images: (payload.images ?? []).map((file) => ({ path: file, width: 1200, height: 800 })),
          };
        case 'jobs':
          return { printer: payload.printer ?? '', jobs: [] };
        case 'cancel':
          return { removed: 1 };
        case 'print-pdf':
          return { pages: 2, documentName: 'doc' };
        case 'print-images':
          return { pages: 1, documentName: 'img' };
        case 'print-text':
          return { pages: 1, documentName: 'txt' };
        case 'test-page':
          return { pages: 1, documentName: 'test' };
        case 'preview':
          return { files: [] };
        default:
          return {};
      }
    },
  };
  return helper;
}

/**
 * 造依赖（默认全部是假的，不碰真实打印机/数据库）。
 * @param {{ config?: Record<string, unknown>, helper?: object, office?: object,
 *   camscanner?: object, exists?: Function, statSync?: Function, paths?: object }} [overrides] - 覆盖项。
 * @returns {object} 依赖。
 */
export function makeDeps(overrides = {}) {
  const config = normalizeConfig(overrides.config ?? {});
  return createDeps(config, {
    paths: overrides.paths ?? {
      pluginRoot: '.',
      powershellPath: 'powershell.exe',
      helperPath: 'print-helper.ps1',
      auditFile: path.join(os.tmpdir(), 'dsh-print-test-audit.jsonl'),
    },
    helper: overrides.helper ?? fakeHelper(),
    audit: { write() {} },
    office: overrides.office ?? {
      detect: () => '',
      convert: async () => {
        throw new Error('office unavailable');
      },
    },
    camscanner: overrides.camscanner ?? {
      load: async () => ({ dbPath: 'db', account: 'tester', docs: [] }),
    },
    exists: overrides.exists ?? (() => true),
    statSync: overrides.statSync ?? (() => ({ size: 1024, mtime: new Date('2026-10-29T00:00:00Z') })),
  });
}

/**
 * 从工具定义里取一个工具。
 * @param {object[]} definitions - 工具定义。
 * @param {string} name - 工具名。
 * @returns {object} 工具。
 */
export function findTool(definitions, name) {
  const tool = definitions.find((definition) => definition.name === name);
  if (!tool) throw new Error(`找不到工具 ${name}`);
  return tool;
}
