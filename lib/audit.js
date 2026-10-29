/**
 * 审计日志：每次工具调用写一行 JSONL。
 *
 * 审计是“打印了什么”的唯一事后凭证，所以写失败只记日志，不影响打印流程。
 *
 * @module @local/print/audit
 */

import fs from 'node:fs';
import path from 'node:path';

/** 单条记录里最多保留的文件名个数。 */
const MAX_FILES_IN_AUDIT = 20;

/**
 * 参数里只挑对复盘有用的字段，避免把整段计划文本写进日志。
 * @param {string} tool - 工具名。
 * @param {Record<string, unknown>} args - 工具参数。
 * @returns {Record<string, unknown>} 摘要。
 */
export function summarizeArguments(tool, args) {
  const summary = { tool };
  const source = args && typeof args === 'object' ? args : {};
  if (Array.isArray(source.files)) summary.files = source.files.slice(0, MAX_FILES_IN_AUDIT);
  for (const key of ['printer', 'copies', 'pages', 'paper', 'orientation', 'color', 'duplex', 'doc', 'confirm', 'preview']) {
    if (source[key] !== undefined) summary[key] = source[key];
  }
  if (Array.isArray(source.images)) summary.images = source.images.length;
  return summary;
}

/**
 * 造一个审计写入器。
 * @param {{ file: string, enabled?: boolean, logger?: { warn?: Function } }} options - 选项。
 * @returns {{ write: (entry: Record<string, unknown>) => void, file: string, enabled: boolean }} 写入器。
 */
export function createAuditLog({ file, enabled = true, logger } = {}) {
  let directoryReady = false;
  /**
   * 写一条记录。
   * @param {Record<string, unknown>} entry - 记录。
   * @returns {void}
   */
  function write(entry) {
    if (!enabled || typeof file !== 'string' || file === '') return;
    try {
      if (!directoryReady) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        directoryReady = true;
      }
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      try {
        logger?.warn?.(`[print] 审计写入失败：${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // 日志也不可用时静默。
      }
    }
  }
  return { write, file, enabled };
}
