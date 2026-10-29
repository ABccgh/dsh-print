/**
 * 工具层共用：文本输出、参数解析、路径解析、页面范围、审计包装。
 *
 * @module @local/print/tools/shared
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeError, printError } from '../errors.js';

/** 所有 `print_*` 工具的输出形状：一段给模型读的紧凑文本。 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text) }],
};

/**
 * 包一个文本结果。
 * @param {unknown} value - 文本。
 * @returns {{ text: string }} 工具返回值。
 */
export function text(value) {
  return { text: String(value) };
}

/**
 * 人类可读字节数。
 * @param {number} bytes - 字节数。
 * @returns {string} 文本。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 把用户给的路径解析成绝对路径（支持 `~`、相对工作区）。
 * @param {string} input - 原始路径。
 * @param {string} [cwd] - 基准目录。
 * @returns {string} 绝对路径。
 */
export function resolveInputPath(input, cwd = process.cwd()) {
  if (typeof input !== 'string' || input.trim() === '') throw printError('E_BAD_ARGS', '文件路径不能为空。');
  let value = input.trim();
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * 检查文件存在且是普通文件。
 * @param {string} file - 绝对路径。
 * @returns {void} 不存在时抛错。
 */
export function assertFileExists(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw printError('E_FILE_NOT_FOUND', `文件不存在：${file}`);
  }
  if (!stat.isFile()) throw printError('E_FILE_NOT_FOUND', `不是普通文件：${file}`);
}

/** 支持的文件类型 → 扩展名。 */
export const FORMAT_GROUPS = Object.freeze({
  pdf: ['.pdf'],
  image: ['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.gif'],
  text: ['.txt', '.md', '.markdown', '.log'],
  office: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf'],
});

/**
 * 按扩展名判定文件类型。
 * @param {string} file - 路径。
 * @returns {'pdf' | 'image' | 'text' | 'office' | 'unknown'} 类型。
 */
export function classifyFile(file) {
  const extension = path.extname(file).toLowerCase();
  for (const [kind, extensions] of Object.entries(FORMAT_GROUPS)) {
    if (extensions.includes(extension)) return /** @type {any} */ (kind);
  }
  return 'unknown';
}

/**
 * 解析页面范围。
 * @param {string | undefined} spec - `all` 或 `1-3,5`。
 * @param {number} totalPages - 总页数。
 * @returns {number[]} 1 起的页码（升序、去重）。
 */
export function parsePageSelection(spec, totalPages) {
  if (!Number.isInteger(totalPages) || totalPages < 1) throw printError('E_BAD_ARGS', `页数不合法：${totalPages}`);
  if (spec === undefined || spec === null || spec === '' || String(spec).trim().toLowerCase() === 'all') {
    return Array.from({ length: totalPages }, (_value, index) => index + 1);
  }
  const pages = new Set();
  for (const rawPart of String(spec).replaceAll('，', ',').split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw printError('E_BAD_ARGS', `页面范围写法不对：${part}（应形如 1-3,5）`);
    const start = Number.parseInt(match[1], 10);
    const end = match[2] === undefined ? start : Number.parseInt(match[2], 10);
    if (start < 1 || end < start || end > totalPages) {
      throw printError('E_BAD_ARGS', `页面范围 ${part} 超出 1..${totalPages}`);
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  if (pages.size === 0) throw printError('E_BAD_ARGS', '页面范围为空。');
  return [...pages].sort((left, right) => left - right);
}

/**
 * 判断打印机是不是“会弹对话框选输出文件”的虚拟打印机。
 * @param {{ name?: string, portName?: string }} printer - 打印机信息。
 * @returns {boolean} 是否需交互。
 */
export function isPromptPrinter(printer) {
  const name = String(printer?.name ?? '');
  const port = String(printer?.portName ?? '');
  if (/PORTPROMPT/i.test(port)) return true;
  return /print\s*to\s*pdf|microsoft\s*xps|onenote|adobe\s*pdf|foxit\s*pdf|wps\s*pdf|pdf\s*writer/i.test(name);
}

/**
 * 把页码数组压成 `1-3,5` 形式（helper 与日志都用它）。
 * @param {number[]} pages - 1 起的页码（升序）。
 * @returns {string} 页面范围文本。
 */
export function formatPageSpec(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return 'all';
  const parts = [];
  let start = pages[0];
  let previous = pages[0];
  for (let index = 1; index < pages.length; index += 1) {
    const page = pages[index];
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(',');
}

/**
 * 写一条审计记录（写失败不影响主流程）。
 * @param {object} deps - 依赖。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {{ ok?: boolean, ms?: number, code?: string, extra?: Record<string, unknown> }} [outcome] - 结果。
 * @returns {void}
 */
export function auditEntry(deps, tool, args, outcome = {}) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    args,
    ok: outcome.ok !== false,
    ms: Number.isFinite(outcome.ms) ? outcome.ms : 0,
  };
  if (deps.config.dryRun) entry.dryRun = true;
  if (typeof outcome.code === 'string') entry.code = outcome.code;
  if (outcome.extra && typeof outcome.extra === 'object') entry.extra = outcome.extra;
  deps.audit.write(entry);
}

/**
 * 工具统一外壳：执行 → 审计；失败时归一错误并记审计。
 * @param {object} deps - 依赖。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {() => Promise<{ text: string }>} action - 实际动作。
 * @returns {Promise<{ text: string }>} 工具返回值。
 */
export async function runTool(deps, tool, args, action) {
  const started = Date.now();
  try {
    const value = await action();
    auditEntry(deps, tool, args, { ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    const normalized = normalizeError(error);
    auditEntry(deps, tool, args, { ok: false, code: normalized.code, ms: Date.now() - started });
    throw normalized;
  }
}

/**
 * 确定性提示：没有确认、或 dryRun 开启时，返回计划文本。
 * @param {object} deps - 依赖。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {string} plan - 计划文本。
 * @returns {{ text: string } | undefined} 计划结果；已确认且非 dryRun 时返回 undefined。
 */
export function planUnlessConfirmed(deps, tool, args, plan) {
  const confirmRequired = deps.config.confirmRequired !== false;
  if (deps.config.dryRun) {
    return text(`[dry-run] 不会打印任何东西。\n${plan}\n\n把配置 dryRun 设为 false 后重试。`);
  }
  if (confirmRequired && args.confirm !== true) {
    return text(`${plan}\n\n—— 以上只是计划，尚未打印。确认后带 confirm=true 再调用一次。`);
  }
  return undefined;
}

/**
 * 渲染一行打印机的摘要。
 * @param {{ name: string, driverName?: string, portName?: string, printerStatus?: string, isDefault?: boolean, jobCount?: number }} printer - 打印机。
 * @returns {string} 文本。
 */
export function describePrinter(printer) {
  const parts = [printer.isDefault ? '★ 默认' : '', printer.printerStatus ? `状态 ${printer.printerStatus}` : ''];
  if (Number.isFinite(printer.jobCount) && printer.jobCount > 0) parts.push(`队列 ${printer.jobCount}`);
  if (printer.portName) parts.push(printer.portName);
  if (printer.driverName) parts.push(printer.driverName);
  return `${printer.name}${parts.filter(Boolean).length > 0 ? `（${parts.filter(Boolean).join('，')}）` : ''}`;
}

/**
 * 找目标打印机并做可用性检查。
 * @param {object} deps - 依赖。
 * @param {string | undefined} requested - 用户指定或空。
 * @returns {Promise<{ name: string, portName: string }>} 目标打印机。
 */
export async function resolveTargetPrinter(deps, requested) {
  const info = await deps.helper.invoke('info', {}, { timeoutMs: deps.config.requestTimeoutMs });
  const printers = Array.isArray(info.printers) ? info.printers : [];
  const wanted = requested && String(requested).trim() !== ''
    ? String(requested).trim()
    : (deps.config.defaultPrinter && String(deps.config.defaultPrinter).trim() !== ''
      ? String(deps.config.defaultPrinter).trim()
      : String(info.defaultPrinter ?? ''));
  if (wanted === '') throw printError('E_PRINTER_NOT_FOUND', '没有默认打印机，也没有指定 printer。');
  const found = printers.find((printer) => String(printer.name).toLowerCase() === wanted.toLowerCase());
  if (!found) {
    const available = printers.map((printer) => printer.name).join('、') || '（无）';
    throw printError('E_PRINTER_NOT_FOUND', `打印机「${wanted}」不存在。可用：${available}`);
  }
  if (isPromptPrinter(found) && deps.config.allowPromptPrinters !== true) {
    throw printError(
      'E_PRINTER_PROMPT',
      `打印机「${found.name}」需要弹框选择输出文件（PORTPROMPT），无法静默打印。`
      + '请换成实体打印机；确实要打时在配置里把 allowPromptPrinters 设为 true 再试。',
    );
  }
  return { name: found.name, portName: found.portName ?? '' };
}
