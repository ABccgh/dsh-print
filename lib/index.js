/**
 * `@local/print` 的 Cordis 插件入口。
 *
 * 注册 7 个工具：状态、文件打印、测试页、队列查看/取消、CamScanner 文档列表/打印。
 *
 * 注意三件事：
 * 1. **不 import 任何 `@deepseek-ai/*`**：插件是 `link:` 安装的 profile bundle，代码在 DSH 安装
 *    作用域之外，这类 import 会以 `ERR_MODULE_NOT_FOUND` 让插件加载失败。
 * 2. **`apply` 不返回值**：Cordis 会把返回值当 effect 收集，返回数组会让插件激活失败。
 * 3. 所有注册都包在 `ctx.effect` 里，取得 disposer，HMR/卸载时才能干净回收。
 *
 * @module @local/print
 */

import fs from 'node:fs';

import { createAuditLog } from './audit.js';
import { loadCamscannerLibrary } from './camscanner.js';
import { normalizeConfig, resolvePaths } from './config.js';
import { createHelperSession } from './helper-session.js';
import { convertToPdf, describeOffice, detectOffice } from './office.js';
import { createCamscannerTools } from './tools/camscanner.js';
import { createJobTools } from './tools/jobs.js';
import { createPrintTools } from './tools/print.js';
import { createStatusTools } from './tools/status.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'print';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 组装运行时依赖。
 *
 * `overrides` 是测试接缝：注入假的 helper / office / camscanner / audit 就能在不碰真实
 * 打印机、不读真实数据库的情况下覆盖工具逻辑。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @param {{ helper?: object, audit?: { write: Function }, paths?: object,
 *   office?: { detect: Function, convert: Function },
 *   camscanner?: { load: Function }, exists?: Function, statSync?: Function,
 *   logger?: object }} [overrides] - 测试接缝。
 * @returns {object} 依赖对象。
 */
export function createDeps(config, overrides = {}) {
  const paths = overrides.paths ?? resolvePaths(config);
  const logger = overrides.logger;
  const exists = overrides.exists ?? fs.existsSync;
  const statSync = overrides.statSync ?? fs.statSync;
  const audit = overrides.audit ?? createAuditLog({ file: paths.auditFile, enabled: config.auditEnabled, logger });
  const helper = overrides.helper ?? createHelperSession({
    powershellPath: paths.powershellPath,
    helperPath: paths.helperPath,
    logger,
  });
  const detect = () => (overrides.office?.detect
    ? overrides.office.detect()
    : detectOffice({
      sofficePath: config.office.sofficePath,
      kitCliPath: config.office.kitCliPath,
      nodePath: config.office.nodePath,
    }));
  const office = {
    detect,
    convert: overrides.office?.convert ?? ((input) => convertToPdf({ input, office: detect(), timeoutMs: config.office.timeoutMs })),
  };
  const camscanner = {
    load: overrides.camscanner?.load ?? ((limit) => loadCamscannerLibrary({ dbPath: config.camscanner.dbPath, limit, exists })),
  };
  return { config, paths, audit, helper, office, camscanner, exists, statSync, logger };
}

/**
 * 造全部工具定义（顺序即工具表顺序，status 在最前）。
 * @param {ReturnType<typeof createDeps>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createToolDefinitions(deps) {
  return [
    ...createStatusTools(deps),
    ...createPrintTools(deps),
    ...createJobTools(deps),
    ...createCamscannerTools(deps),
  ];
}

/**
 * 装配插件。
 * @param {any} ctx - Cordis 上下文（硬依赖 `tools`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @param {{ helper?: object, audit?: object, paths?: object, office?: object,
 *   camscanner?: object, exists?: Function, statSync?: Function, logger?: object }} [overrides] - 测试接缝。
 * @returns {Promise<void>} 无。**不要返回任何值**。
 */
export async function apply(ctx, config, overrides = {}) {
  const effective = normalizeConfig(config);
  const deps = createDeps(effective, { ...overrides, logger: overrides.logger ?? ctx.logger });
  const definitions = createToolDefinitions(deps);
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();

  for (const definition of definitions) effect(() => ctx.tools.register(definition));

  try {
    ctx.logger?.info?.(
      `[print] 就绪：${definitions.length} 个工具（${definitions.map((definition) => definition.name).join(', ')}）；`
      + `helper ${deps.paths.helperPath}；PowerShell ${deps.paths.powershellPath}；`
      + `Office 转换 ${describeOffice(deps.office.detect())}；confirmRequired=${effective.confirmRequired}，dryRun=${effective.dryRun}。`,
    );
  } catch {
    // 日志不可用无所谓。
  }
}
