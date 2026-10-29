/**
 * Office 转换后端：自动探测、命令构造、产物校验。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { convertToPdf, defaultKitPaths, describeOffice, detectOffice, guessNodePath } from '../lib/office.js';
import { tempDir, writeFile } from './support.js';

/**
 * 假 spawn：写一个假的 PDF 产物，然后以指定退出码结束。
 * @param {{ code?: number, write?: (args: string[]) => void, stderr?: string }} options - 选项。
 * @returns {Function} spawn 替身。
 */
function fakeOfficeSpawn({ code = 0, write, stderr = '' } = {}) {
  const calls = [];
  function spawnImpl(command, args) {
    calls.push({ command, args });
    const listeners = new Map();
    const child = {
      stdout: { on: (event, handler) => add(listeners, 'stdout', handler) },
      stderr: { on: (event, handler) => add(listeners, 'stderr', handler) },
      on: (event, handler) => add(listeners, `child:${event}`, handler),
      kill() {},
    };
    setTimeout(() => {
      if (write) write(args);
      for (const handler of listeners.get('stdout') ?? []) handler(Buffer.from('{"ok":true}'));
      for (const handler of listeners.get('stderr') ?? []) handler(Buffer.from(stderr));
      for (const handler of listeners.get('child:close') ?? []) handler(code);
    }, 0);
    return child;
  }
  spawnImpl.calls = calls;
  return spawnImpl;
}

/**
 * 事件登记。
 * @param {Map<string, Function[]>} listeners - 表。
 * @param {string} key - 键。
 * @param {Function} handler - 处理器。
 * @returns {void}
 */
function add(listeners, key, handler) {
  const list = listeners.get(key) ?? [];
  list.push(handler);
  listeners.set(key, list);
}

/**
 * 从参数里取 `--output` 的值。
 * @param {string[]} args - 参数。
 * @returns {string} 输出路径。
 */
function outputOf(args) {
  const index = args.indexOf('--output');
  return index >= 0 ? args[index + 1] : '';
}

test('guessNodePath 优先环境变量与 DSH 运行时', () => {
  const guessed = guessNodePath({
    exists: (file) => file.includes('dsh-runtimes'),
    readdir: () => ['dsh-primary-runtime'],
  });
  assert.match(guessed, /dsh-primary-runtime[\\/]dependencies[\\/]node[\\/]bin[\\/]node\.exe/);
});

test('guessNodePath 找不到时返回空串', () => {
  assert.equal(guessNodePath({ exists: () => false, readdir: () => [] }), '');
});

test('detectOffice 优先系统 soffice', () => {
  const office = detectOffice({
    sofficePath: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    exists: () => true,
    kitRoot: 'C:\\kit',
  });
  assert.equal(office.backend, 'soffice');
  assert.equal(office.executable, 'C:\\Program Files\\LibreOffice\\program\\soffice.exe');
});

test('detectOffice 回退到 LibreOffice Kit', () => {
  const office = detectOffice({
    kitRoot: 'C:\\kit',
    nodePath: 'C:\\node.exe',
    exists: (file) => file === 'C:\\kit' || file.includes('cli.js') || file === 'C:\\node.exe',
  });
  assert.equal(office.backend, 'kit');
  assert.match(office.cliPath, /libreoffice-kit.*cli\.js/);
  assert.equal(office.nodePath, 'C:\\node.exe');
});

test('detectOffice 两者都没有时返回 null', () => {
  assert.equal(detectOffice({ exists: () => false }), null);
});

test('describeOffice 给出可读文本', () => {
  assert.match(describeOffice(null), /未安装/);
  assert.match(describeOffice({ backend: 'soffice', executable: 'C:\\soffice.exe' }), /系统 LibreOffice/);
  assert.match(describeOffice({ backend: 'kit', cliPath: 'C:\\cli.js', nodePath: 'C:\\node.exe' }), /LibreOffice Kit/);
});

test('defaultKitPaths 指向 office-kit 安装目录', () => {
  const paths = defaultKitPaths({ exists: () => false, nodePath: 'C:\\node.exe', root: 'C:\\root' });
  assert.match(paths.cliPath, /C:\\root[\\/]node_modules[\\/]@deepseek-ai[\\/]libreoffice-kit[\\/]lib[\\/]cli\.js/);
  assert.equal(paths.nodePath, 'C:\\node.exe');
});

test('convertToPdf 走 Kit 后端：node cli convert --input --output', async () => {
  const dir = tempDir();
  const input = writeFile(path.join(dir, 'in.docx'), 'fake');
  const spawnImpl = fakeOfficeSpawn({
    write: (args) => {
      const output = outputOf(args);
      writeFile(output, '%PDF-1.4 fake');
    },
  });
  const result = await convertToPdf({
    input,
    office: { backend: 'kit', cliPath: 'C:\\kit\\cli.js', nodePath: 'C:\\node.exe' },
    timeoutMs: 5000,
    spawnImpl,
    workRoot: dir,
  });
  assert.equal(spawnImpl.calls.length, 1);
  assert.equal(spawnImpl.calls[0].command, 'C:\\node.exe');
  assert.deepEqual(spawnImpl.calls[0].args.slice(0, 4), ['C:\\kit\\cli.js', 'convert', '--input', input]);
  assert.ok(fs.existsSync(result.pdfPath));
  result.dispose();
  assert.equal(fs.existsSync(path.dirname(result.pdfPath)), false, 'dispose 应删掉临时目录');
});

test('convertToPdf 走 soffice 后端', async () => {
  const dir = tempDir();
  const input = writeFile(path.join(dir, 'in.xlsx'), 'fake');
  const spawnImpl = fakeOfficeSpawn({
    write: (args) => {
      const outDir = args[args.indexOf('--outdir') + 1];
      writeFile(path.join(outDir, 'in.pdf'), '%PDF-1.7 fake');
    },
  });
  const result = await convertToPdf({
    input,
    office: { backend: 'soffice', executable: 'C:\\soffice.exe' },
    timeoutMs: 5000,
    spawnImpl,
    workRoot: dir,
  });
  assert.equal(spawnImpl.calls[0].command, 'C:\\soffice.exe');
  assert.ok(spawnImpl.calls[0].args.includes('--headless'));
  assert.ok(fs.existsSync(result.pdfPath));
  result.dispose();
});

test('convertToPdf 对坏产物报 E_OFFICE_CONVERT', async () => {
  const dir = tempDir();
  const input = writeFile(path.join(dir, 'in.docx'), 'fake');
  const spawnImpl = fakeOfficeSpawn({ write: (args) => writeFile(outputOf(args), 'NOTPDF') });
  await assert.rejects(convertToPdf({
    input,
    office: { backend: 'kit', cliPath: 'C:\\kit\\cli.js', nodePath: 'C:\\node.exe' },
    timeoutMs: 5000,
    spawnImpl,
    workRoot: dir,
  }), (error) => {
    assert.equal(error.code, 'E_OFFICE_CONVERT');
    return true;
  });
});

test('convertToPdf 对失败退出码报 E_OFFICE_CONVERT', async () => {
  const dir = tempDir();
  const input = writeFile(path.join(dir, 'in.docx'), 'fake');
  await assert.rejects(convertToPdf({
    input,
    office: { backend: 'kit', cliPath: 'C:\\kit\\cli.js', nodePath: 'C:\\node.exe' },
    timeoutMs: 5000,
    spawnImpl: fakeOfficeSpawn({ code: 3, stderr: 'boom' }),
    workRoot: dir,
  }), (error) => {
    assert.equal(error.code, 'E_OFFICE_CONVERT');
    assert.match(error.message, /boom/);
    return true;
  });
});

test('convertToPdf 没有后端时报 E_OFFICE_MISSING', async () => {
  await assert.rejects(convertToPdf({ input: 'x.docx', office: null }), (error) => {
    assert.equal(error.code, 'E_OFFICE_MISSING');
    return true;
  });
});
