/**
 * 一次性 PowerShell 5.1 helper 调用。
 *
 * 打印/渲染动作都是“跑一次就退”的短任务，所以这里不做常驻 helper：
 * 每次调用写一个 payload JSON 临时文件，用 `-EncodedCommand` 只传 helper 路径与 payload 路径
 * （避免命令行长度上限和中文/引号转义问题），启动 `powershell.exe -Sta` 跑完解析单行 JSON。
 *
 * 调用串行化：同一时间只允许一个 helper 进程，避免多个 `PrintDocument` 会话互相踩。
 *
 * @module @local/print/helper-session
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { printError } from './errors.js';

/** PowerShell 5.1 的固定启动参数。 */
const POWERSHELL_FLAGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Sta',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
];

/**
 * 转义 PowerShell 单引号字符串里的单引号。
 * @param {string} value - 原始值。
 * @returns {string} 转义值。
 */
function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * 造 `-EncodedCommand` 需要的 base64（UTF-16LE）。
 * @param {{ helperPath: string, action: string, payloadFile: string }} options - 选项。
 * @returns {string} base64。
 */
export function buildEncodedCommand({ helperPath, action, payloadFile }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `. ${quotePowerShell(helperPath)}`,
    `Invoke-DshPrintAction -Action ${quotePowerShell(action)} -PayloadFile ${quotePowerShell(payloadFile)}`,
  ].join('\n');
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 解析 helper 的 stdout：取最后一行以 `{"ok"` 开头的 JSON。
 * @param {string} stdout - 原始输出。
 * @returns {Record<string, any>} 解析结果。
 * @throws {Error} 找不到合法 JSON 时。
 */
export function parseHelperOutput(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim().replace(/^\uFEFF/, '');
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed;
    } catch {
      // 继续找上一行。
    }
  }
  throw new Error('helper 没有返回可解析的 JSON 结果');
}

/**
 * 把 helper 的失败结果转成插件错误。
 * @param {Record<string, any>} result - helper 结果。
 * @returns {never} 总是抛出。
 */
function throwHelperError(result) {
  const error = result && typeof result === 'object' ? result.error : undefined;
  const code = typeof error?.code === 'string' ? error.code : 'E_HELPER';
  const message = typeof error?.message === 'string' ? error.message : 'helper 执行失败';
  throw printError(code, message, error?.detail);
}

/**
 * 创建 helper 会话。
 * @param {{ powershellPath: string, helperPath: string, logger?: { warn?: Function, info?: Function },
 *   spawnImpl?: Function, tmpDir?: string }} options - 选项。
 * @returns {{ invoke: (action: string, payload?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<Record<string, any>> }} 会话。
 */
export function createHelperSession({ powershellPath, helperPath, logger, spawnImpl = spawn, tmpDir } = {}) {
  const workDir = tmpDir || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-print', 'tmp');
  let queue = Promise.resolve();

  /**
   * 真正调一次 helper（内部用，已被串行化包裹）。
   * @param {string} action - 动作名。
   * @param {Record<string, unknown>} payload - 参数。
   * @param {number} timeoutMs - 超时。
   * @returns {Promise<Record<string, any>>} helper 的 `data`。
   */
  async function invokeOnce(action, payload, timeoutMs) {
    fs.mkdirSync(workDir, { recursive: true });
    const payloadFile = path.join(workDir, `payload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(payload ?? {}), 'utf8');
    const encoded = buildEncodedCommand({ helperPath, action, payloadFile });

    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let child;
        try {
          child = spawnImpl(powershellPath, [...POWERSHELL_FLAGS, encoded], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          reject(printError('E_HELPER', `无法启动 PowerShell：${error instanceof Error ? error.message : String(error)}`));
          return;
        }

        const chunks = [];
        const errorChunks = [];
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          reject(printError('E_TIMEOUT', `helper 动作 ${action} 超过 ${timeoutMs}ms 未完成，已终止。`));
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        child.stderr?.on('data', (chunk) => errorChunks.push(Buffer.from(chunk)));
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(printError('E_HELPER', `helper 启动失败：${error.message}`));
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdout = Buffer.concat(chunks).toString('utf8');
          const stderr = Buffer.concat(errorChunks).toString('utf8');
          try {
            const parsed = parseHelperOutput(stdout);
            resolve(parsed);
          } catch (error) {
            const tail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
            reject(printError(
              'E_HELPER',
              `helper 退出码 ${code}，输出无法解析：${error.message}${tail ? `；stderr: ${tail}` : ''}`,
            ));
          }
        });
      });

      if (!result.ok) throwHelperError(result);
      return result.data ?? {};
    } finally {
      try {
        fs.rmSync(payloadFile, { force: true });
      } catch {
        // 清理失败不影响结果。
      }
    }
  }

  /**
   * 串行执行 helper 动作。
   * @param {string} action - 动作名。
   * @param {Record<string, unknown>} [payload] - 参数。
   * @param {{ timeoutMs?: number }} [options] - 选项。
   * @returns {Promise<Record<string, any>>} 结果。
   */
  function invoke(action, payload = {}, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 120000;
    const run = queue.then(() => invokeOnce(action, payload, timeoutMs));
    // 队列本身吞掉失败，避免一次失败卡死后续调用。
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { invoke, workDir, helperPath, powershellPath };
}

/**
 * 供测试：造一个假的 spawn，按脚本回放 stdout/stderr 与退出码。
 * @param {Array<{ stdout?: string, stderr?: string, code?: number, delayMs?: number }>} script - 回放脚本。
 * @returns {Function} `spawn` 替身。
 */
export function createFakeSpawn(script) {
  const calls = [];
  let index = 0;
  function fakeSpawn(command, args) {
    const step = script[index] ?? { code: 1, stderr: 'no more script' };
    index += 1;
    calls.push({ command, args, step });
    const listeners = new Map();
    const child = {
      stdout: { on: (event, handler) => register(listeners, 'stdout', event, handler) },
      stderr: { on: (event, handler) => register(listeners, 'stderr', event, handler) },
      on: (event, handler) => register(listeners, 'child', event, handler),
      kill: () => {},
    };
    setTimeout(() => {
      for (const handler of listeners.get('stdout') ?? []) handler(Buffer.from(step.stdout ?? ''));
      for (const handler of listeners.get('stderr') ?? []) handler(Buffer.from(step.stderr ?? ''));
      for (const handler of listeners.get('close') ?? []) handler(step.code ?? 0);
    }, step.delayMs ?? 0);
    return child;
  }
  fakeSpawn.calls = calls;
  return fakeSpawn;
}

/**
 * 事件登记小工具（fake spawn 用）。
 * @param {Map<string, Function[]>} listeners - 监听表。
 * @param {'stdout' | 'stderr' | 'child'} group - 组。
 * @param {string} event - 事件。
 * @param {Function} handler - 处理器。
 * @returns {object} 链式可用的 child 桩。
 */
function register(listeners, group, event, handler) {
  const key = group === 'child' ? event : group;
  const list = listeners.get(key) ?? [];
  list.push(handler);
  listeners.set(key, list);
  return { on: () => undefined };
}
