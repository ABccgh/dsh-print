/**
 * helper 调用协议：EncodedCommand 构造、输出解析、假 spawn 的成功/失败/超时。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildEncodedCommand, createFakeSpawn, createHelperSession, parseHelperOutput } from '../lib/helper-session.js';
import { tempDir, writeFile } from './support.js';

/**
 * 解出 EncodedCommand 里的脚本。
 * @param {string} encoded - base64。
 * @returns {string} 脚本。
 */
function decode(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

test('buildEncodedCommand 只传 helper 路径、动作与 payload 文件', () => {
  const encoded = buildEncodedCommand({
    helperPath: "C:\\it's here\\print-helper.ps1",
    action: 'print-pdf',
    payloadFile: 'C:\\tmp\\p.json',
  });
  const script = decode(encoded);
  assert.match(script, /Invoke-DshPrintAction -Action 'print-pdf' -PayloadFile 'C:\\tmp\\p\.json'/);
  assert.match(script, /\. 'C:\\it''s here\\print-helper\.ps1'/);
  assert.match(script, /\[Console\]::OutputEncoding/);
});

test('parseHelperOutput 取最后一行 JSON 并忽略噪声', () => {
  const stdout = [
    'CLIXML 之类的行',
    '{"ok":false,"error":{"code":"E_TIMEOUT","message":"旧结果"}}',
    '{"ok":true,"data":{"pages":2}}',
    '',
  ].join('\r\n');
  assert.deepEqual(parseHelperOutput(stdout), { ok: true, data: { pages: 2 } });
});

test('parseHelperOutput 无 JSON 时抛错', () => {
  assert.throws(() => parseHelperOutput('随便什么输出'), /没有返回可解析的 JSON/);
});

test('helper 成功时返回 data', async () => {
  const tmpDir = tempDir();
  const spawnImpl = createFakeSpawn([{ stdout: '{"ok":true,"data":{"printers":[]}}\r\n', code: 0 }]);
  const session = createHelperSession({
    powershellPath: 'powershell.exe',
    helperPath: 'helper.ps1',
    spawnImpl,
    tmpDir,
  });
  const data = await session.invoke('info', {}, { timeoutMs: 1000 });
  assert.deepEqual(data, { printers: [] });
  const call = spawnImpl.calls[0];
  assert.equal(call.command, 'powershell.exe');
  assert.ok(call.args.includes('-Sta'));
  assert.ok(call.args.includes('-EncodedCommand'));
  const payloadFiles = fs.readdirSync(tmpDir).filter((name) => name.startsWith('payload-'));
  assert.deepEqual(payloadFiles, [], 'payload 临时文件应被清理');
});

test('helper 失败时抛带错误码的插件错误', async () => {
  const session = createHelperSession({
    powershellPath: 'powershell.exe',
    helperPath: 'helper.ps1',
    spawnImpl: createFakeSpawn([{ stdout: '{"ok":false,"error":{"code":"E_PRINTER_NOT_FOUND","message":"打印机不存在"}}', code: 0 }]),
    tmpDir: tempDir(),
  });
  await assert.rejects(session.invoke('info'), (error) => {
    assert.equal(error.code, 'E_PRINTER_NOT_FOUND');
    assert.equal(error.message, '打印机不存在');
    return true;
  });
});

test('helper 输出不可解析时带 stderr 片段抛错', async () => {
  const session = createHelperSession({
    powershellPath: 'powershell.exe',
    helperPath: 'helper.ps1',
    spawnImpl: createFakeSpawn([{ stdout: '不是 JSON', stderr: 'blah\r\nboom', code: 1 }]),
    tmpDir: tempDir(),
  });
  await assert.rejects(session.invoke('info'), (error) => {
    assert.equal(error.code, 'E_HELPER');
    assert.match(error.message, /boom/);
    return true;
  });
});

test('helper 超时被终止并报 E_TIMEOUT', async () => {
  const session = createHelperSession({
    powershellPath: 'powershell.exe',
    helperPath: 'helper.ps1',
    spawnImpl: createFakeSpawn([{ stdout: '{"ok":true,"data":{}}', delayMs: 200 }]),
    tmpDir: tempDir(),
  });
  await assert.rejects(session.invoke('info', {}, { timeoutMs: 20 }), (error) => {
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
});

test('并发调用被串行化', async () => {
  const order = [];
  const spawnImpl = createFakeSpawn([
    { stdout: '{"ok":true,"data":{"n":1}}', delayMs: 20 },
    { stdout: '{"ok":true,"data":{"n":2}}', delayMs: 5 },
  ]);
  const wrapped = (command, args) => {
    order.push(Date.now());
    return spawnImpl(command, args);
  };
  const session = createHelperSession({ powershellPath: 'powershell.exe', helperPath: 'helper.ps1', spawnImpl: wrapped, tmpDir: tempDir() });
  const [first, second] = await Promise.all([session.invoke('info'), session.invoke('info')]);
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(second, { n: 2 });
  assert.equal(spawnImpl.calls.length, 2);
  assert.equal(order.length, 2);
});

test('payload 文件写入的是 UTF-8 JSON', async () => {
  const tmpDir = tempDir();
  const seen = [];
  const spawnImpl = createFakeSpawn([{ stdout: '{"ok":true,"data":{}}' }]);
  const wrapped = (command, args) => {
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    const payloadMatch = /-PayloadFile '(.+?)'/.exec(decode(encoded));
    if (payloadMatch) seen.push(fs.readFileSync(payloadMatch[1], 'utf8'));
    return spawnImpl(command, args);
  };
  const session = createHelperSession({ powershellPath: 'powershell.exe', helperPath: 'helper.ps1', spawnImpl: wrapped, tmpDir });
  await session.invoke('inspect', { pdfs: ['C:\\中文 路径\\a.pdf'] });
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]), { pdfs: ['C:\\中文 路径\\a.pdf'] });
});

test('写出一个 1x1 PNG 便于其它测试复用', () => {
  const file = writeFile(path.join(tempDir(), 'dot.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  assert.ok(fs.statSync(file).size > 0);
});
