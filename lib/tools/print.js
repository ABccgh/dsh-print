/**
 * `print_file` / `print_test_page`：打印主流程。
 *
 * 流程固定为“先计划、后执行”：解析文件 → 探测页数/尺寸 → 解析目标打印机 →
 * 出计划（默认）→ 带 `confirm=true` 才逐个交给 helper 打印。
 *
 * 打 PDF 是“PDF → WinRT 逐页位图 → PrintDocument”；打图片是“System.Drawing 直接排版”；
 * 打文本是“按行分页排版”；打 Office 文件先经 LibreOffice 转 PDF 再走 PDF 链路。
 *
 * @module @local/print/tools/print
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { printError } from '../errors.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT,
  assertFileExists,
  classifyFile,
  describePrinter,
  formatBytes,
  formatPageSpec,
  parsePageSelection,
  planUnlessConfirmed,
  resolveInputPath,
  resolveTargetPrinter,
  runTool,
  text,
} from './shared.js';
/** 单次允许的最大份数。 */
const MAX_COPIES = 99;

/**
 * 把 `files` 参数收成数组。
 * @param {unknown} value - 原始值。
 * @returns {string[]} 路径数组。
 */
function toFileList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') return value.split(/[\r\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
  throw printError('E_BAD_ARGS', 'files 必须是文件路径数组（或逗号分隔的字符串）。');
}

/**
 * 规范份数。
 * @param {unknown} value - 原始值。
 * @returns {number} 1..99。
 */
function normalizeCopies(value) {
  const parsed = Number.isFinite(value) ? Math.trunc(Number(value)) : 1;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_COPIES);
}

/**
 * 规范纸型/方向/颜色/双面。
 * @param {Record<string, any>} args - 工具参数。
 * @returns {{ paper: string, orientation: string, color: boolean, duplex: string }} 打印选项。
 */
function normalizePrintOptions(args) {
  const paper = typeof args.paper === 'string' && args.paper.trim() !== '' ? args.paper.trim() : 'A4';
  const orientation = ['auto', 'portrait', 'landscape'].includes(args.orientation) ? args.orientation : 'auto';
  const duplex = ['simplex', 'short', 'long'].includes(args.duplex) ? args.duplex : 'simplex';
  return { paper, orientation, color: args.color !== false, duplex };
}

/**
 * 解析文件列表为打印条目（校验存在与格式）。
 * @param {string[]} files - 原始路径。
 * @param {string} cwd - 基准目录。
 * @returns {Array<{ path: string, name: string, kind: string, size: number }>} 条目。
 */
function collectEntries(files, cwd) {
  const entries = [];
  for (const raw of files) {
    const resolved = resolveInputPath(raw, cwd);
    assertFileExists(resolved);
    const kind = classifyFile(resolved);
    if (kind === 'unknown') {
      throw printError(
        'E_UNSUPPORTED_FORMAT',
        `不支持打印这个格式：${resolved}。支持 PDF、PNG/JPG/JPEG/BMP/TIF/GIF、TXT/MD，以及 docx/xlsx/pptx 等 Office 文件（需 LibreOffice）。`,
      );
    }
    entries.push({ path: resolved, name: path.basename(resolved), kind, size: fs.statSync(resolved).size });
  }
  return entries;
}

/**
 * 用 helper 批量探测 PDF 页数与图片尺寸。
 * @param {object} deps - 依赖。
 * @param {object[]} entries - 条目。
 * @returns {Promise<{ pdfs: Map<string, object>, images: Map<string, object> }>} 探测结果。
 */
async function inspectEntries(deps, entries) {
  const pdfs = entries.filter((entry) => entry.kind === 'pdf').map((entry) => entry.path);
  const images = entries.filter((entry) => entry.kind === 'image').map((entry) => entry.path);
  const result = { pdfs: new Map(), images: new Map() };
  if (pdfs.length === 0 && images.length === 0) return result;
  const data = await deps.helper.invoke('inspect', { pdfs, images }, { timeoutMs: deps.config.timeoutMs });
  for (const item of Array.isArray(data.pdfs) ? data.pdfs : []) result.pdfs.set(item.path, item);
  for (const item of Array.isArray(data.images) ? data.images : []) result.images.set(item.path, item);
  return result;
}

/**
 * 估算文本页数（约 50 行/页）。
 * @param {string} file - 文件。
 * @returns {{ lines: number, pages: number } | null} 估算；读不了返回 null。
 */
function estimateTextPages(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/).length;
    return { lines, pages: Math.max(1, Math.ceil(lines / 50)) };
  } catch {
    return null;
  }
}

/**
 * 解析并校验页面范围。
 * @param {object} entry - 条目。
 * @param {Record<string, any>} args - 参数。
 * @param {object} inspection - 探测结果。
 * @returns {{ pages: number[] | null, total: number | null }} 选择结果；Office 文件为 null。
 */
function resolveSelection(entry, args, inspection) {
  const spec = typeof args.pages === 'string' && args.pages.trim() !== '' ? args.pages.trim() : 'all';
  if (entry.kind === 'pdf') {
    const info = inspection.pdfs.get(entry.path);
    const total = Number.isFinite(info?.pages) ? Number(info.pages) : 0;
    return { pages: parsePageSelection(spec, total), total };
  }
  if (entry.kind === 'image') {
    return { pages: parsePageSelection(spec, 1), total: 1 };
  }
  if (entry.kind === 'text' || entry.kind === 'office') {
    if (spec !== 'all') {
      throw printError('E_BAD_ARGS', `${entry.name} 暂不支持按页码打印（只有 PDF/图片支持 pages），请用 all。`);
    }
    return { pages: null, total: null };
  }
  return { pages: null, total: null };
}

/**
 * 解析自动横竖：图片（或整份 PDF）全是横向时用横向纸。
 * @param {string} requested - auto/portrait/landscape。
 * @param {object[]} entries - 条目。
 * @param {object} inspection - 探测结果。
 * @returns {string} portrait/landscape。
 */
function resolveOrientation(requested, entries, inspection) {
  if (requested === 'portrait' || requested === 'landscape') return requested;
  const widths = [];
  for (const entry of entries) {
    if (entry.kind === 'image') {
      const info = inspection.images.get(entry.path);
      if (info) widths.push({ width: info.width, height: info.height });
    }
    if (entry.kind === 'pdf') {
      const info = inspection.pdfs.get(entry.path);
      if (Array.isArray(info?.sizes)) widths.push(...info.sizes);
    }
  }
  if (widths.length > 0 && widths.every((item) => Number(item.width) > Number(item.height))) return 'landscape';
  return 'portrait';
}

/**
 * 渲染预览图（只处理第一个文件，最多 2 页）。
 * @param {object} deps - 依赖。
 * @param {object} entry - 条目。
 * @param {Record<string, any>} args - 参数。
 * @returns {Promise<object[]>} 预览文件列表。
 */
async function renderPreview(deps, entry, args) {
  const outDir = path.join(os.tmpdir(), 'dsh-print', 'preview', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const common = { outDir, maxPages: 2 };
  if (entry.kind === 'pdf') {
    const data = await deps.helper.invoke('preview', { ...common, pdf: entry.path, pages: args.pages ?? 'all' }, { timeoutMs: deps.config.timeoutMs });
    return Array.isArray(data.files) ? data.files : [];
  }
  if (entry.kind === 'image') {
    const data = await deps.helper.invoke('preview', { ...common, images: [entry.path] }, { timeoutMs: deps.config.timeoutMs });
    return Array.isArray(data.files) ? data.files : [];
  }
  if (entry.kind === 'office') {
    const availableOffice = deps.office.detect();
    if (!availableOffice) throw printError('E_OFFICE_MISSING', '没有找到 LibreOffice / LibreOffice Kit，无法预览 Office 文件。');
    const conversion = await deps.office.convert(entry.path);
    try {
      const data = await deps.helper.invoke('preview', { ...common, pdf: conversion.pdfPath, pages: 'all' }, { timeoutMs: deps.config.timeoutMs });
      return Array.isArray(data.files) ? data.files : [];
    } finally {
      conversion.dispose();
    }
  }
  return [];
}

/**
 * 渲染页码选择的短文本。
 * @param {number[]} pages - 1 起的页码。
 * @returns {string} 如 `第 1-2 页`、`第 1、3、5 页`。
 */
function describePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return '全部页';
  if (pages.length === 1) return `第 ${pages[0]} 页`;
  const contiguous = pages.every((page, index) => index === 0 || page === pages[index - 1] + 1);
  if (contiguous) return `第 ${pages[0]}-${pages[pages.length - 1]} 页`;
  return `第 ${pages.join('、')} 页`;
}

/**
 * 构造打印计划文本。
 * @param {object} input - 上下文。
 * @returns {string} 计划文本。
 */
function buildPlanText({ entries, inspection, printer, options, copies, selection, previewFiles }) {
  const lines = ['打印计划（尚未打印）'];
  lines.push(
    `目标打印机：${printer.name}｜${options.paper}｜${options.orientation === 'landscape' ? '横向' : '纵向'}`
    + `｜${options.color ? '彩色' : '黑白'}｜${options.duplex === 'simplex' ? '单面' : `双面(${options.duplex})`}｜每份 ${copies} 份`,
  );
  lines.push(`文件（${entries.length}）：`);
  let knownPages = 0;
  let hasUnknown = false;
  entries.forEach((entry, index) => {
    const number = `${index + 1}. ${entry.name}`;
    if (entry.kind === 'pdf') {
      const total = Number(inspection.pdfs.get(entry.path)?.pages ?? 0);
      const pages = selection[index].pages ?? [];
      knownPages += pages.length * copies;
      lines.push(`  ${number} —— PDF，共 ${total} 页，打印 ${describePages(pages)} × ${copies} 份 = ${pages.length * copies} 页（${formatBytes(entry.size)}）`);
    } else if (entry.kind === 'image') {
      const info = inspection.images.get(entry.path);
      knownPages += copies;
      lines.push(`  ${number} —— 图片 ${info ? `${info.width}×${info.height}` : ''}，${copies} 份 = ${copies} 页（${formatBytes(entry.size)}）`);
    } else if (entry.kind === 'text') {
      const estimate = estimateTextPages(entry.path);
      if (estimate) knownPages += estimate.pages * copies;
      lines.push(`  ${number} —— 文本${estimate ? `约 ${estimate.lines} 行 / ${estimate.pages} 页` : ''}，${copies} 份（${formatBytes(entry.size)}）`);
    } else if (entry.kind === 'office') {
      hasUnknown = true;
      lines.push(`  ${number} —— ${path.extname(entry.path).slice(1).toUpperCase()}，确认后先用 LibreOffice 转 PDF 再打印（页数待定，${formatBytes(entry.size)}）`);
    }
  });
  lines.push(`合计：约 ${knownPages} 页${hasUnknown ? ' + Office 文件转换后的页数' : ''}`);
  if (previewFiles.length > 0) {
    lines.push('预览（可先用 read_image 看排版）：');
    for (const file of previewFiles) lines.push(`  · ${file.path}（${file.width}×${file.height}）`);
  }
  return lines.join('\n');
}

/**
 * 真正打印一个条目。
 * @param {object} deps - 依赖。
 * @param {object} entry - 条目。
 * @param {{ printer: string, options: Record<string, any>, copies: number, pages: number[] | null }} context - 打印上下文。
 * @returns {Promise<{ pages: number, documentName: string }>} 结果。
 */
async function printEntry(deps, entry, context) {
  const { printer, options, copies, pages } = context;
  const timeoutMs = deps.config.timeoutMs;
  const common = {
    printer,
    copies,
    paper: options.paper,
    orientation: options.orientation,
    color: options.color,
    duplex: options.duplex,
  };
  const documentName = `${entry.name} [dsh-print]`;
  if (entry.kind === 'pdf') {
    const pageSpec = pages === null ? 'all' : formatPageSpec(pages);
    const data = await deps.helper.invoke('print-pdf', { ...common, pdf: entry.path, pages: pageSpec, documentName }, { timeoutMs });
    return { pages: Number(data.pages) || 0, documentName };
  }
  if (entry.kind === 'image') {
    const data = await deps.helper.invoke('print-images', { ...common, images: [entry.path], documentName }, { timeoutMs });
    return { pages: Number(data.pages) || 0, documentName };
  }
  if (entry.kind === 'text') {
    const data = await deps.helper.invoke('print-text', { ...common, textFile: entry.path, documentName }, { timeoutMs });
    return { pages: Number(data.pages) || 0, documentName };
  }
  if (entry.kind === 'office') {
    const availableOffice = deps.office.detect();
    if (!availableOffice) throw printError('E_OFFICE_MISSING', '没有找到 LibreOffice / LibreOffice Kit，无法打印 Office 文件。');
    const conversion = await deps.office.convert(entry.path);
    try {
      const data = await deps.helper.invoke(
        'print-pdf',
        { ...common, pdf: conversion.pdfPath, pages: 'all', documentName: `${entry.name}（转 PDF）[dsh-print]` },
        { timeoutMs },
      );
      return { pages: Number(data.pages) || 0, documentName };
    } finally {
      conversion.dispose();
    }
  }
  throw printError('E_UNSUPPORTED_FORMAT', `不支持打印：${entry.path}`);
}

/**
 * 注册打印工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createPrintTools(deps) {
  return [
    defineTool({
      name: 'print_file',
      description:
        '打印本地文件到指定打印机：支持 PDF（逐页渲染）、PNG/JPG/JPEG/BMP/TIF/GIF 图片、TXT/MD 文本，以及 docx/xlsx/pptx 等 Office 文件（先用 LibreOffice 转 PDF）。'
        + '默认只返回打印计划（目标打印机、页数、份数、纸型），带 confirm=true 才真正打印；preview=true 可先渲染前两页 PNG 供核对。',
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要打印的文件路径（绝对路径或相对工作区），支持多个文件。',
        },
        printer: { type: 'string', description: '打印机名称；不传则用配置的默认打印机或系统默认。' },
        copies: { type: 'integer', description: '每份文件的份数，默认 1（上限 99）。', default: 1 },
        pages: { type: 'string', description: '页面范围，如 1-3,5；默认 all。仅 PDF/图片支持。', default: 'all' },
        paper: { type: 'string', description: '纸型，默认 A4（需打印机支持）。', default: 'A4' },
        orientation: {
          type: 'string',
          enum: ['auto', 'portrait', 'landscape'],
          description: '纸张方向；auto=按内容自动（全横向内容用横向纸）。',
          default: 'auto',
        },
        color: { type: 'boolean', description: '彩色打印，默认 true。', default: true },
        duplex: {
          type: 'string',
          enum: ['simplex', 'short', 'long'],
          description: '单面/双面（驱动支持才生效），默认 simplex。',
          default: 'simplex',
        },
        preview: { type: 'boolean', description: '先渲染第一个文件的前两页 PNG 用于核对（不打印）。', default: false },
        confirm: { type: 'boolean', description: '确认执行；默认 false 只返回计划。', default: false },
      },
      output: TEXT_OUTPUT,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_file', args, async () => {
          const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : process.cwd();
          const entries = collectEntries(toFileList(args.files), cwd);
          if (entries.length > deps.config.maxFiles) {
            throw printError('E_LIMIT', `单次最多打印 ${deps.config.maxFiles} 个文件，收到 ${entries.length} 个。`);
          }
          const copies = normalizeCopies(args.copies);
          const options = normalizePrintOptions(args);
          const inspection = await inspectEntries(deps, entries);
          const selection = entries.map((entry) => resolveSelection(entry, args, inspection));
          const knownPages = entries.reduce((total, entry, index) => {
            const selected = selection[index].pages;
            return total + (selected === null ? 0 : selected.length * copies);
          }, 0);
          if (knownPages > deps.config.maxPages) {
            throw printError('E_LIMIT', `本次要打印约 ${knownPages} 页，超过单次上限 ${deps.config.maxPages} 页。`);
          }
          if (entries.some((entry) => entry.kind === 'office') && !deps.office.detect()) {
            throw printError('E_OFFICE_MISSING', '有 Office 文件要打印，但没有找到 LibreOffice / LibreOffice Kit。请先安装 Office 转换引擎（见插件 README 的「安装 LibreOffice」一节），或先把文件另存为 PDF。');
          }
          options.orientation = resolveOrientation(options.orientation, entries, inspection);
          const printer = await resolveTargetPrinter(deps, args.printer);
          const previewFiles = args.preview === true ? await renderPreview(deps, entries[0], args) : [];
          const plan = buildPlanText({ entries, inspection, printer, options, copies, selection, previewFiles });
          const planned = planUnlessConfirmed(deps, 'print_file', args, plan);
          if (planned) return planned;

          const printed = [];
          try {
            for (let index = 0; index < entries.length; index += 1) {
              const entry = entries[index];
              const result = await printEntry(deps, entry, {
                printer: printer.name,
                options,
                copies,
                pages: entry.kind === 'office' ? null : selection[index].pages,
              });
              printed.push({ name: entry.name, pages: result.pages });
            }
          } catch (error) {
            const done = printed.map((item) => `${item.name}（${item.pages} 页）`).join('、');
            const message = error instanceof Error ? error.message : String(error);
            throw printError(
              'E_SPOOL',
              `${done ? `已完成：${done}；` : ''}后续文件打印失败：${message}`,
              { printed },
            );
          }
          const totalPages = printed.reduce((sum, item) => sum + item.pages, 0);
          const lines = [`已提交打印：${printed.length} 个文件，共 ${totalPages} 页，目标打印机 ${printer.name}。`];
          for (const item of printed) lines.push(`  · ${item.name} —— ${item.pages} 页`);
          lines.push('用 print_jobs 可以查看队列状态。');
          return text(lines.join('\n'));
        });
      },
    }),
    defineTool({
      name: 'print_test_page',
      description: '打印一张 A4 测试页（标题、时间、打印机名、边框与对齐线），用来验证打印机和打印链路是否正常。默认只返回计划，confirm=true 才真正打印。',
      parameters: {
        printer: { type: 'string', description: '打印机名称；不传则用默认打印机。' },
        copies: { type: 'integer', description: '份数，默认 1。', default: 1 },
        confirm: { type: 'boolean', description: '确认执行；默认 false 只返回计划。', default: false },
      },
      output: TEXT_OUTPUT,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_test_page', args, async () => {
          const copies = normalizeCopies(args.copies);
          const printer = await resolveTargetPrinter(deps, args.printer);
          const plan = [
            '测试页计划（尚未打印）',
            `目标打印机：${describePrinter({ name: printer.name, portName: printer.portName })}`,
            `内容：A4 测试页 × ${copies} 份（标题、时间、打印机名、边框与对齐线）`,
          ].join('\n');
          const planned = planUnlessConfirmed(deps, 'print_test_page', args, plan);
          if (planned) return planned;
          const data = await deps.helper.invoke(
            'test-page',
            { printer: printer.name, copies, paper: 'A4', documentName: 'dsh-print 测试页' },
            { timeoutMs: deps.config.timeoutMs },
          );
          return text(`已提交测试页：${printer.name} × ${data.pages ?? copies} 页。去打印机旁看一眼即可。`);
        });
      },
    }),
  ];
}
