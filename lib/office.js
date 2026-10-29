/**
 * Office 文档 → PDF 转换。
 *
 * 支持两种后端，自动挑一个能用的：
 *
 * 1. **LibreOffice Kit**（推荐，本机实际安装的就是它）：DSH 官方的 `@deepseek-ai/libreoffice-kit`，
 *    预编译 LibreOffice + `dsoffice` CLI。CLI 是 Node 脚本，所以还需要一个 Node 运行时
 *    （默认用 DSH 运行时自带的 node.exe）。
 * 2. **系统 LibreOffice**：`soffice.exe --headless --convert-to pdf`。
 *
 * 每次转换用独立的临时 profile / 临时目录，转换完删掉。
 *
 * @module @local/print/office
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { printError } from './errors.js';

/** 常见 LibreOffice 安装位置。 */
const SOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

/** Kit 的默认安装根目录。 */
export const DEFAULT_KIT_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'dsh-print',
  'office-kit',
);

/**
 * 猜一个可用的 Node 运行时。
 *
 * 顺序：`DSH_NODE_PATH` 环境变量 → `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe`
 * → `C:\Program Files\nodejs\node.exe`。
 * @param {{ exists?: (file: string) => boolean, readdir?: (dir: string) => string[] }} [overrides] - 测试接缝。
 * @returns {string} 路径；找不到返回空串。
 */
export function guessNodePath(overrides = {}) {
  const exists = overrides.exists ?? fs.existsSync;
  const readdir = overrides.readdir ?? ((directory) => fs.readdirSync(directory));
  if (typeof process.env.DSH_NODE_PATH === 'string' && exists(process.env.DSH_NODE_PATH)) {
    return process.env.DSH_NODE_PATH;
  }
  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const name of readdir(runtimes)) {
      const candidate = path.join(runtimes, name, 'dependencies', 'node', 'bin', 'node.exe');
      if (exists(candidate)) return candidate;
    }
  } catch {
    // 没有 DSH 运行时目录，继续找系统 Node。
  }
  const system = 'C:\\Program Files\\nodejs\\node.exe';
  return exists(system) ? system : '';
}

/**
 * Kit 的默认路径。
 * @param {{ exists?: Function, nodePath?: string, root?: string }} [overrides] - 测试接缝。
 * @returns {{ cliPath: string, nodePath: string, root: string }} 路径。
 */
export function defaultKitPaths(overrides = {}) {
  const root = overrides.root || DEFAULT_KIT_ROOT;
  return {
    root,
    cliPath: path.join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'),
    nodePath: overrides.nodePath || guessNodePath({ exists: overrides.exists }),
  };
}

/**
 * 探测可用的 Office 转换后端。
 * @param {{ sofficePath?: string, kitCliPath?: string, nodePath?: string,
 *   exists?: (file: string) => boolean, kitRoot?: string }} [options] - 选项。
 * @returns {{ backend: 'kit', cliPath: string, nodePath: string }
 *   | { backend: 'soffice', executable: string } | null} 后端描述；没有可用后端时为 null。
 */
export function detectOffice({
  sofficePath = '',
  kitCliPath = '',
  nodePath = '',
  exists = fs.existsSync,
  kitRoot = '',
} = {}) {
  if (typeof sofficePath === 'string' && sofficePath !== '' && exists(sofficePath)) {
    return { backend: 'soffice', executable: sofficePath };
  }
  const defaults = defaultKitPaths({ exists, nodePath, root: kitRoot });
  const cli = kitCliPath || defaults.cliPath;
  const runtime = nodePath || defaults.nodePath;
  if (exists(cli) && runtime !== '' && exists(runtime)) {
    return { backend: 'kit', cliPath: cli, nodePath: runtime };
  }
  return null;
}

/**
 * 一行描述后端。
 * @param {{ backend: string, executable?: string, cliPath?: string, nodePath?: string } | null} office - 后端。
 * @returns {string} 文本。
 */
export function describeOffice(office) {
  if (!office) return '未安装（docx/xlsx/pptx 无法打印；PDF/图片不受影响）';
  if (office.backend === 'soffice') return `系统 LibreOffice（${office.executable}）`;
  return `LibreOffice Kit（${office.cliPath}，Node ${office.nodePath}）`;
}

/**
 * 打印临时目录根。
 * @returns {string} 路径。
 */
export function officeWorkRoot() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-print', 'tmp');
}

/**
 * 把本地路径转成 LibreOffice 能接受的 `file:///` URI。
 * @param {string} directory - 目录。
 * @returns {string} URI。
 */
function toFileUri(directory) {
  return `file:///${directory.replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

/**
 * 跑一次子进程并等结束，带超时。
 * @param {{ command: string, args: string[], timeoutMs: number, spawnImpl?: Function }} options - 选项。
 * @returns {Promise<string>} stderr 尾巴（出错时用）。
 */
function runProcess({ command, args, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(printError('E_OFFICE_CONVERT', `无法启动转换器：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const stderr = [];
    const stdout = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 忽略。
      }
      reject(printError('E_TIMEOUT', `Office 转换超过 ${timeoutMs}ms，已终止。`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(printError('E_OFFICE_CONVERT', `转换器启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).slice(-3).join(' | ');
        const out = Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/).slice(-2).join(' | ');
        reject(printError('E_OFFICE_CONVERT', `转换器退出码 ${code}${tail ? `：${tail}` : ''}${out ? `（stdout: ${out}）` : ''}`));
        return;
      }
      resolve(Buffer.concat(stderr).toString('utf8'));
    });
  });
}

/**
 * 校验产物是 PDF。
 * @param {string} pdfPath - 文件。
 * @returns {void} 不合法时抛错。
 */
function assertPdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) throw printError('E_OFFICE_CONVERT', `没有生成预期的 PDF：${pdfPath}`);
  const head = fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw printError('E_OFFICE_CONVERT', `转换产物不是合法 PDF（文件头 ${JSON.stringify(head)}）：${pdfPath}`);
}

/**
 * 把 Office 文档转成 PDF。
 * @param {{ input: string, office: object, timeoutMs?: number, spawnImpl?: Function,
 *   workRoot?: string }} options - 选项。
 * @returns {Promise<{ pdfPath: string, workDir: string, dispose: () => void }>} 转换结果。
 */
export async function convertToPdf({ input, office, timeoutMs = 120000, spawnImpl = spawn, workRoot } = {}) {
  if (!office) {
    throw printError('E_OFFICE_MISSING', '没有可用的 LibreOffice（或 LibreOffice Kit），无法把 Office 文件转成 PDF。');
  }
  const source = path.resolve(input);
  if (!fs.existsSync(source)) throw printError('E_FILE_NOT_FOUND', `文件不存在：${source}`);

  const root = workRoot || officeWorkRoot();
  const workDir = path.join(root, `office-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(workDir, { recursive: true });
  const dispose = () => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 清理失败无所谓。
    }
  };

  try {
    if (office.backend === 'kit') {
      const output = path.join(workDir, `${path.basename(source, path.extname(source))}.pdf`);
      await runProcess({
        command: office.nodePath,
        args: [office.cliPath, 'convert', '--input', source, '--output', output, '--timeout-ms', String(timeoutMs)],
        timeoutMs,
        spawnImpl,
      });
      assertPdf(output);
      return { pdfPath: output, workDir, dispose };
    }
    if (office.backend === 'soffice') {
      const profileDir = path.join(workDir, 'profile');
      fs.mkdirSync(profileDir, { recursive: true });
      const outputDir = path.join(workDir, 'out');
      fs.mkdirSync(outputDir, { recursive: true });
      await runProcess({
        command: office.executable,
        args: [
          '--headless',
          '--norestore',
          '--convert-to',
          'pdf',
          '--outdir',
          outputDir,
          `-env:UserInstallation=${toFileUri(profileDir)}`,
          source,
        ],
        timeoutMs,
        spawnImpl,
      });
      const pdfPath = path.join(outputDir, `${path.basename(source, path.extname(source))}.pdf`);
      assertPdf(pdfPath);
      return { pdfPath, workDir, dispose };
    }
  } catch (error) {
    dispose();
    throw error;
  }
  dispose();
  throw printError('E_OFFICE_MISSING', `未知的 Office 后端：${office.backend}`);
}
