/**
 * 配置归一与路径解析。
 *
 * 约定与 `dsh-input` 一致：**不导出 Cordis `Config`**，由本模块的 `normalizeConfig`
 * 兜底；这样 patch 里漏字段、传字符串、传 `''` 都不会让插件激活失败。
 *
 * @module @local/print/config
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件版本（状态行与 README 用）。 */
export const PLUGIN_VERSION = '0.1.0';

/** 插件根目录（仓库或安装副本）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 字符串字段：只接受字符串，其余给默认值。
 * @param {unknown} value - 原始值。
 * @param {string} fallback - 默认值。
 * @returns {string} 字符串。
 */
function toStringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 布尔字段：只接受布尔值。
 * @param {unknown} value - 原始值。
 * @param {boolean} fallback - 默认值。
 * @returns {boolean} 布尔。
 */
function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 整数字段：接受整数/数字串，夹到 `min..max`；无法解析时用默认值。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
function toInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * CamScanner 子配置。
 * @param {unknown} raw - 原始值。
 * @returns {{ enabled: boolean, dbPath: string }} 归一结果。
 */
function normalizeCamscanner(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: toBoolean(value.enabled, true),
    dbPath: toStringOr(value.dbPath, ''),
  };
}

/**
 * Office 子配置。
 * @param {unknown} raw - 原始值。
 * @returns {{ enabled: boolean, sofficePath: string, kitCliPath: string, nodePath: string, timeoutMs: number }} 归一结果。
 */
function normalizeOffice(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: toBoolean(value.enabled, true),
    sofficePath: toStringOr(value.sofficePath, ''),
    kitCliPath: toStringOr(value.kitCliPath, ''),
    nodePath: toStringOr(value.nodePath, ''),
    timeoutMs: toInteger(value.timeoutMs, 120000, 10000, 900000),
  };
}

/**
 * 归一整个插件配置。
 * @param {unknown} raw - loader 传进来的配置。
 * @returns {Record<string, unknown>} 生效配置。
 */
export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    powershellPath: toStringOr(value.powershellPath, ''),
    helperPath: toStringOr(value.helperPath, ''),
    timeoutMs: toInteger(value.timeoutMs, 180000, 10000, 1800000),
    requestTimeoutMs: toInteger(value.requestTimeoutMs, 15000, 1000, 120000),
    defaultPrinter: toStringOr(value.defaultPrinter, ''),
    confirmRequired: toBoolean(value.confirmRequired, true),
    dryRun: toBoolean(value.dryRun, false),
    maxFiles: toInteger(value.maxFiles, 20, 1, 100),
    maxPages: toInteger(value.maxPages, 300, 1, 5000),
    allowPromptPrinters: toBoolean(value.allowPromptPrinters, false),
    auditEnabled: toBoolean(value.auditEnabled, true),
    auditFile: toStringOr(value.auditFile, ''),
    camscanner: normalizeCamscanner(value.camscanner),
    office: normalizeOffice(value.office),
  };
}

/**
 * 默认审计文件：`%LOCALAPPDATA%\dsh-print\audit.jsonl`。
 * @returns {string} 路径。
 */
export function defaultAuditFile() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-print', 'audit.jsonl');
}

/**
 * 默认 CamScanner 库：`%APPDATA%\CamScanner\Camscanner\camscanner.db`。
 * @returns {string} 路径。
 */
export function defaultCamscannerDbPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'CamScanner', 'Camscanner', 'camscanner.db');
}

/**
 * 找 Windows PowerShell 5.1。
 *
 * 必须是 5.1（powershell.exe），**不是** pwsh 7：`Windows.Data.Pdf` 这类 WinRT 类型
 * 只在 Windows PowerShell 的 .NET Framework 投影下可靠加载（已在本机实测）。
 * @param {{ exists?: (file: string) => boolean }} [overrides] - 测试接缝。
 * @returns {string} 可执行文件路径（找不到时退回裸名 `powershell.exe`）。
 */
export function defaultPowershellPath(overrides = {}) {
  const exists = overrides.exists ?? fs.existsSync;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(candidate) ? candidate : 'powershell.exe';
}

/**
 * 解析运行期路径。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @param {{ exists?: (file: string) => boolean }} [overrides] - 测试接缝。
 * @returns {{ pluginRoot: string, powershellPath: string, helperPath: string, auditFile: string }} 路径。
 */
export function resolvePaths(config, overrides = {}) {
  const exists = overrides.exists ?? fs.existsSync;
  return {
    pluginRoot: PLUGIN_ROOT,
    powershellPath: config.powershellPath || defaultPowershellPath({ exists }),
    helperPath: config.helperPath || path.join(PLUGIN_ROOT, 'lib', 'helper', 'print-helper.ps1'),
    auditFile: config.auditFile || defaultAuditFile(),
  };
}
