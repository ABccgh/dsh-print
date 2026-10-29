/**
 * `print_status`：只读诊断。
 *
 * helper 挂了也要返回可读现场（PowerShell 路径、配置、审计文件），
 * 这样模型能自己判断是“没装 LibreOffice”还是“helper 起不来”。
 *
 * @module @local/print/tools/status
 */

import { resolveLibraryDb } from '../camscanner.js';
import { PLUGIN_VERSION } from '../config.js';
import { describeError } from '../errors.js';
import { describeOffice } from '../office.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, describePrinter, formatBytes, isPromptPrinter, text } from './shared.js';

/**
 * 审计文件的一行描述。
 * @param {{ exists: (file: string) => boolean }} deps - 依赖。
 * @param {string} file - 路径。
 * @returns {string} 文本。
 */
function describeAudit(deps, file) {
  try {
    if (!deps.exists(file)) return `${file}（尚未创建）`;
    const stat = deps.statSync(file);
    return `${file}（${formatBytes(stat.size)}，更新于 ${stat.mtime.toISOString()}）`;
  } catch {
    return `${file}（无法读取）`;
  }
}

/**
 * 注册 `print_status`。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createStatusTools(deps) {
  return [
    defineTool({
      name: 'print_status',
      description:
        '查看本机打印环境：系统打印机与默认打印机、打印队列、PowerShell 打印 helper 是否可用、LibreOffice 是否就绪、CamScanner 本地库是否可读，以及插件配置（确认开关/dryRun/审计）。只读，不打印任何东西。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        const lines = [`打印插件 ${PLUGIN_VERSION}`];
        let info = null;
        let helperError = null;
        try {
          info = await deps.helper.invoke('info', {}, { timeoutMs: deps.config.requestTimeoutMs });
        } catch (error) {
          helperError = error;
        }

        if (info) {
          lines.push(
            `helper：Windows PowerShell ${info.psVersion ?? '?'}，WinRT ${info.winrtOk ? '可用' : '不可用'}，`
            + `GDI ${info.drawingOk ? '可用' : '不可用'}，${info.elevated ? '已提升' : '普通权限'}`,
          );
          const printers = Array.isArray(info.printers) ? info.printers : [];
          lines.push(`默认打印机：${info.defaultPrinter || '（无）'}`);
          if (printers.length === 0) {
            lines.push('打印机：没有检测到任何打印机。');
          } else {
            lines.push(`打印机（${printers.length}）：`);
            for (const printer of printers) {
              const marks = [];
              if (printer.name === info.defaultPrinter) marks.push('默认');
              if (isPromptPrinter(printer)) marks.push('需弹框/虚拟');
              lines.push(`  · ${describePrinter(printer)}${marks.length > 0 ? ` — ${marks.join('，')}` : ''}`);
            }
          }
          lines.push(`打印队列：${Number.isFinite(info.printJobs) ? info.printJobs : '?'} 个任务`);
          if (Array.isArray(info.paperSizes) && info.paperSizes.length > 0) {
            lines.push(`默认打印机纸张：${info.paperSizes.slice(0, 12).join('、')}${info.paperSizes.length > 12 ? '…' : ''}`);
          }
          if (info.winrtError) lines.push(`WinRT 错误：${info.winrtError}`);
        } else {
          lines.push(`helper：不可用 —— ${describeError(helperError)}`);
          lines.push(`PowerShell 路径：${deps.paths.powershellPath}`);
          lines.push(`helper 脚本：${deps.paths.helperPath}`);
        }

        const availableOffice = deps.office.detect();
        lines.push(`Office 转换：${describeOffice(availableOffice)}`);

        const dbPath = resolveLibraryDb({ dbPath: deps.config.camscanner.dbPath, exists: deps.exists });
        if (!deps.config.camscanner.enabled) {
          lines.push('CamScanner：已在配置里关闭');
        } else if (!deps.exists(dbPath)) {
          lines.push(`CamScanner：找不到本地库（${dbPath}）`);
        } else {
          let docCount = '?';
          try {
            const library = await deps.camscanner.load(100);
            docCount = library.docs.length;
            lines.push(`CamScanner：${dbPath}（账号 ${library.account || '?'}，${docCount} 个文档）`);
          } catch (error) {
            lines.push(`CamScanner：库存在但读取失败 —— ${describeError(error)}`);
          }
        }

        lines.push(
          `配置：confirmRequired=${deps.config.confirmRequired}，dryRun=${deps.config.dryRun}，`
          + `allowPromptPrinters=${deps.config.allowPromptPrinters}，maxFiles=${deps.config.maxFiles}，maxPages=${deps.config.maxPages}`,
        );
        lines.push(`审计：${deps.config.auditEnabled ? describeAudit(deps, deps.paths.auditFile) : '已关闭'}`);
        lines.push('提示：直接说「打印 xxx.pdf」即可；默认先出计划，确认后才真正打印。');
        return text(lines.join('\n'));
      },
    }),
  ];
}
