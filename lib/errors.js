/**
 * 打印插件的错误类型与错误码。
 *
 * 所有对外错误都带一个稳定的 `code`（`E_*`），工具层只把 `code + message` 交给模型，
 * 让模型知道“该怎么修”，而不是拿一段 PowerShell 堆栈。
 *
 * @module @local/print/errors
 */

/** 错误码 → 一句中文说明（打印在 `describeError` 里）。 */
const CODE_HINTS = new Map([
  ['E_BAD_ARGS', '参数不合法'],
  ['E_FILE_NOT_FOUND', '文件不存在'],
  ['E_UNSUPPORTED_FORMAT', '不支持的文件格式'],
  ['E_PRINTER_NOT_FOUND', '打印机不存在'],
  ['E_PRINTER_PROMPT', '目标打印机需要交互式对话框'],
  ['E_PDF_ENCRYPTED', 'PDF 已加密，无法渲染'],
  ['E_PDF_RENDER', 'PDF 页面渲染失败'],
  ['E_IMAGE_BROKEN', '图片无法解码'],
  ['E_OFFICE_MISSING', '没有可用的 LibreOffice'],
  ['E_OFFICE_CONVERT', 'Office 文件转换 PDF 失败'],
  ['E_CAMSCANNER_DB', 'CamScanner 本地库不可用'],
  ['E_CAMSCANNER_PAGE', 'CamScanner 文档有页面图片缺失'],
  ['E_HELPER', '打印 helper 执行失败'],
  ['E_TIMEOUT', '打印/渲染超时'],
  ['E_SPOOL', '打印任务提交失败'],
  ['E_LIMIT', '超过单次调用上限'],
  ['E_CONFIRM_REQUIRED', '需要确认后才能执行'],
  ['E_DRYRUN', 'dryRun 已开启，只允许出计划'],
  ['E_INTERNAL', '内部错误'],
]);

/**
 * 带错误码的插件错误。
 */
export class PrintError extends Error {
  /**
   * @param {string} code - 错误码（`E_*`）。
   * @param {string} message - 面向模型的说明。
   * @param {Record<string, unknown>} [detail] - 可选结构化细节。
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'PrintError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * 造一个插件错误。
 * @param {string} code - 错误码。
 * @param {string} message - 说明。
 * @param {Record<string, unknown>} [detail] - 细节。
 * @returns {PrintError} 错误。
 */
export function printError(code, message, detail) {
  return new PrintError(code, message, detail);
}

/**
 * 把任意异常收成 `PrintError`。
 * @param {unknown} error - 原始异常。
 * @param {string} [fallbackCode] - 未知异常时的错误码。
 * @returns {PrintError} 归一后的错误。
 */
export function normalizeError(error, fallbackCode = 'E_INTERNAL') {
  if (error instanceof PrintError) return error;
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code.startsWith('E_')) {
    return new PrintError(error.code, String(error.message ?? error.code), error.detail);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PrintError(fallbackCode, message);
}

/**
 * 错误的一行文本表示。
 * @param {unknown} error - 异常。
 * @returns {string} 文本。
 */
export function describeError(error) {
  const normalized = normalizeError(error);
  const hint = CODE_HINTS.get(normalized.code) ?? '未知错误';
  return `${normalized.code}（${hint}）：${normalized.message}`;
}

/**
 * 错误码的默认说明（测试与文档用）。
 * @param {string} code - 错误码。
 * @returns {string | undefined} 说明。
 */
export function codeHint(code) {
  return CODE_HINTS.get(code);
}
