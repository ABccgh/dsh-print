/**
 * `print_camscanner_docs` / `print_camscanner_doc`：读取 CamScanner（全能扫描王）本地库并打印扫描件。
 *
 * 只读接入：文档元数据来自 `camscanner.db`，页图来自 `bigdata`/`previews`。
 * 缺页不会静默跳过——打印前就把缺哪几页告诉调用方。
 *
 * @module @local/print/tools/camscanner
 */

import path from 'node:path';

import { IMAGE_QUALITY, countQualities } from '../camscanner.js';
import { printError } from '../errors.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT,
  parsePageSelection,
  planUnlessConfirmed,
  resolveTargetPrinter,
  runTool,
  text,
} from './shared.js';

/**
 * 时间戳渲染。
 *
 * CamScanner 的 `modify_time` 是**秒**（10 位），但历史上也可能出现毫秒值；
 * 小于 1e12 的一律按秒补成毫秒。
 * @param {number | null} value - epoch 秒或毫秒。
 * @returns {string} 文本。
 */
function formatTimestamp(value) {
  if (!Number.isFinite(value)) return '未知时间';
  const milliseconds = value < 1e12 ? value * 1000 : value;
  const date = new Date(milliseconds);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 页图质量摘要。
 * @param {{ full: number, preview: number, missing: number }} counts - 计数。
 * @returns {string} 文本。
 */
function qualityText(counts) {
  const parts = [];
  if (counts.full > 0) parts.push(`${counts.full} 页全高清`);
  if (counts.preview > 0) parts.push(`${counts.preview} 页仅预览`);
  if (counts.missing > 0) parts.push(`${counts.missing} 页缺页图`);
  return parts.join('，') || '无可用页图';
}

/**
 * 按序号 / 文档 ID / 标题找到文档。
 * @param {object[]} docs - 文档列表。
 * @param {unknown} raw - 用户输入。
 * @returns {object} 文档。
 */
function resolveDoc(docs, raw) {
  const value = String(raw ?? '').trim();
  if (value === '') throw printError('E_BAD_ARGS', 'doc 必须是序号（1 起）、文档 ID 或标题。');
  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10);
    if (index >= 1 && index <= docs.length) return docs[index - 1];
  }
  const byId = docs.find((doc) => doc.docId === value);
  if (byId) return byId;
  const exact = docs.filter((doc) => doc.title === value);
  if (exact.length === 1) return exact[0];
  const partial = docs.filter((doc) => doc.title.includes(value));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw printError(
      'E_BAD_ARGS',
      `标题「${value}」匹配到多个文档：${partial.map((doc) => `${doc.index}. ${doc.title}`).join('；')}。请改用序号或完整标题。`,
    );
  }
  throw printError('E_CAMSCANNER_DB', `找不到文档「${value}」。先用 print_camscanner_docs 看列表。`);
}

/**
 * 预览目录。
 * @returns {string} 目录。
 */
function previewDirectory() {
  return path.join(process.env.TEMP || process.env.LOCALAPPDATA || '.', 'dsh-print', 'preview', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/**
 * 注册 CamScanner 工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createCamscannerTools(deps) {
  return [
    defineTool({
      name: 'print_camscanner_docs',
      description:
        '列出全能扫描王（CamScanner）本地库里的扫描件：标题、页数、每页是全高清图还是 1000px 预览图、更新时间。只读；数据库位置可用配置 camscanner.dbPath 覆盖。',
      parameters: {
        limit: { type: 'integer', description: '最多列出多少个文档，默认 20。', default: 20 },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_camscanner_docs', args, async () => {
          if (!deps.config.camscanner.enabled) throw printError('E_CAMSCANNER_DB', 'CamScanner 接入已在配置里关闭（camscanner.enabled=false）。');
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 20;
          const library = await deps.camscanner.load(limit);
          const lines = [
            `CamScanner 本地库：${library.dbPath}`,
            `账号：${library.account || '未知'}，文档 ${library.docs.length} 个`,
          ];
          if (library.docs.length === 0) {
            lines.push('（库里还没有文档。用全能扫描王导入或扫描一份后再试。）');
            return text(lines.join('\n'));
          }
          for (const doc of library.docs) {
            const counts = countQualities(doc);
            const directory = doc.directory ? `（${doc.directory}）` : '';
            lines.push(`  ${doc.index}. ${doc.title}${directory} —— ${doc.pages} 页（${qualityText(counts)}），更新 ${formatTimestamp(doc.updatedAt)}`);
          }
          lines.push('');
          lines.push('打印其中一份：print_camscanner_doc(doc=序号或标题)。缺页图的文档需要先在 App 里打开一次。');
          return text(lines.join('\n'));
        });
      },
    }),
    defineTool({
      name: 'print_camscanner_doc',
      description:
        '打印全能扫描王（CamScanner）本地库中的一份扫描件：按页码选页、按质量取全高清图（缺失的页会明确报错），可选份数/纸型/方向/预览。'
        + '默认只返回计划，confirm=true 才真正打印。',
      parameters: {
        doc: { type: 'string', required: true, description: '文档序号（print_camscanner_docs 里的 1 起序号）、文档 ID 或标题。' },
        printer: { type: 'string', description: '打印机名称；不传则用默认打印机。' },
        copies: { type: 'integer', description: '份数，默认 1。', default: 1 },
        pages: { type: 'string', description: '页面范围，如 1-2；默认 all。', default: 'all' },
        paper: { type: 'string', description: '纸型，默认 A4。', default: 'A4' },
        orientation: {
          type: 'string',
          enum: ['auto', 'portrait', 'landscape'],
          description: '纸张方向；auto=按页图宽高自动。',
          default: 'auto',
        },
        color: { type: 'boolean', description: '彩色打印，默认 true。', default: true },
        duplex: {
          type: 'string',
          enum: ['simplex', 'short', 'long'],
          description: '单面/双面，默认 simplex。',
          default: 'simplex',
        },
        preview: { type: 'boolean', description: '先渲染前两页 PNG 供核对（不打印）。', default: false },
        confirm: { type: 'boolean', description: '确认执行；默认 false 只返回计划。', default: false },
      },
      output: TEXT_OUTPUT,
      async execute(rawArgs) {
        const args = rawArgs ?? {};
        return runTool(deps, 'print_camscanner_doc', args, async () => {
          if (!deps.config.camscanner.enabled) throw printError('E_CAMSCANNER_DB', 'CamScanner 接入已在配置里关闭（camscanner.enabled=false）。');
          const library = await deps.camscanner.load(200);
          const doc = resolveDoc(library.docs, args.doc);
          const spec = typeof args.pages === 'string' && args.pages.trim() !== '' ? args.pages.trim() : 'all';
          const selection = parsePageSelection(spec, doc.images.length);
          const selected = selection.map((page) => doc.images[page - 1]);
          const missing = selected.filter((image) => image.quality === IMAGE_QUALITY.missing);
          if (missing.length > 0) {
            throw printError(
              'E_CAMSCANNER_PAGE',
              `文档「${doc.title}」有页面图片缺失（第 ${missing.map((image) => image.pageNum).join('、')} 页）。`
              + '请先在全能扫描王里打开这份文档一次（让 App 生成页图），或改用 print_camscanner_docs 换一份。',
            );
          }

          const imagePaths = selected.map((image) => image.path);
          const inspected = await deps.helper.invoke('inspect', { images: imagePaths }, { timeoutMs: deps.config.requestTimeoutMs });
          const dimensions = new Map((inspected.images ?? []).map((item) => [item.path, item]));
          const sizes = imagePaths.map((file) => dimensions.get(file)).filter(Boolean);
          const requestedOrientation = ['portrait', 'landscape'].includes(args.orientation) ? args.orientation : 'auto';
          const orientation = requestedOrientation === 'auto'
            ? (sizes.length > 0 && sizes.every((item) => item.width > item.height) ? 'landscape' : 'portrait')
            : requestedOrientation;
          const paper = typeof args.paper === 'string' && args.paper.trim() !== '' ? args.paper.trim() : 'A4';
          const copies = Number.isFinite(args.copies) ? Math.max(1, Math.min(99, Math.trunc(args.copies))) : 1;
          const duplex = ['simplex', 'short', 'long'].includes(args.duplex) ? args.duplex : 'simplex';
          const color = args.color !== false;
          const printer = await resolveTargetPrinter(deps, args.printer);

          const counts = countQualities({ images: selected });
          const lines = ['从 CamScanner 打印（尚未打印）'];
          lines.push(`文档：${doc.title}${doc.directory ? `（${doc.directory}）` : ''}`);
          lines.push(`选择：${selection.length === doc.images.length ? `全部 ${selection.length} 页` : `第 ${selection.join('、')} 页`}，共 ${selection.length} 页 × ${copies} 份 = ${selection.length * copies} 页`);
          lines.push(`页图：${qualityText(counts)}`);
          if (sizes.length > 0) {
            const unique = [...new Set(sizes.map((item) => `${item.width}×${item.height}`))];
            lines.push(`尺寸：${unique.join('、')}`);
          }
          if (counts.preview > 0) {
            lines.push('质量提示：有页面只有 1000px 预览图（约 120 DPI），打印会偏糊；在全能扫描王里打开该文档一次可生成全高清页图。');
          }
          lines.push(
            `目标打印机：${printer.name}｜${paper}｜${orientation === 'landscape' ? '横向' : '纵向'}`
            + `｜${color ? '彩色' : '黑白'}｜${duplex === 'simplex' ? '单面' : `双面(${duplex})`}`,
          );
          if (args.preview === true) {
            const preview = await deps.helper.invoke(
              'preview',
              { images: imagePaths, outDir: previewDirectory(), maxPages: 2 },
              { timeoutMs: deps.config.timeoutMs },
            );
            const files = Array.isArray(preview.files) ? preview.files : [];
            if (files.length > 0) {
              lines.push('预览（可先用 read_image 看）：');
              for (const file of files) lines.push(`  · ${file.path}（${file.width}×${file.height}）`);
            }
          }
          const plan = lines.join('\n');
          const planned = planUnlessConfirmed(deps, 'print_camscanner_doc', args, plan);
          if (planned) return planned;

          const data = await deps.helper.invoke(
            'print-images',
            {
              printer: printer.name,
              images: imagePaths,
              copies,
              paper,
              orientation,
              color,
              duplex,
              documentName: `${doc.title} [CamScanner]`,
            },
            { timeoutMs: deps.config.timeoutMs },
          );
          return text(`已提交 CamScanner 文档打印：${doc.title}，${data.pages ?? selection.length * copies} 页 → ${printer.name}。`);
        });
      },
    }),
  ];
}
