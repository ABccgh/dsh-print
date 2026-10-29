/**
 * CamScanner 本地库解析：页图优先级、路径兜底、缺页与错误码。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { countQualities, loadCamscannerLibrary, resolvePageImage } from '../lib/camscanner.js';
import { tempDir, writeFile } from './support.js';

/**
 * 造一份最小可读的 camscanner.db。
 * @param {string} root - 根目录。
 * @returns {Promise<{ dbPath: string, big: string, preview: string }>} 路径。
 */
async function createFixtureDb(root) {
  const accountId = '123456';
  const big = writeFile(path.join(root, accountId, 'bigdata', 'page-big.jpg'), 'big');
  const preview = writeFile(path.join(root, accountId, 'previews', '1000', 'page-preview.jpg'), 'preview');
  const dbPath = path.join(root, 'camscanner.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table sync_accounts (id integer primary key, account_name text, sync_account_id text);
    create table dirs (sync_id text, title text);
    create table documents (sync_id text, title text, pages_num integer, modify_time integer, parent_dir_sync_id text);
    create table pages (doc_id text, page_num integer, big_data text, previews_data text);
  `);
  db.prepare('insert into sync_accounts values (1, ?, ?)').run('测试账号', accountId);
  db.prepare('insert into dirs values (?, ?)').run('dir-1', '证件卡包');
  db.prepare('insert into documents values (?, ?, ?, ?, ?)').run('doc-1', '测试文档', 2, 1793280246473, 'dir-1');
  db.prepare('insert into pages values (?, ?, ?, ?)').run('doc-1', 1, big, '');
  // 记录的是根目录 previews 路径，实际文件在 previews/1000/ 下：必须靠 basename 兜底。
  db.prepare('insert into pages values (?, ?, ?, ?)').run('doc-1', 2, '', path.join('C:\\fake', 'previews', 'page-preview.jpg'));
  db.close();
  return { dbPath, big, preview };
}

test('resolvePageImage 优先 big_data，其次 previews_data', () => {
  const root = tempDir();
  const big = writeFile(path.join(root, 'bigdata', 'a.jpg'), 'big');
  const preview = writeFile(path.join(root, 'previews', 'a-preview.jpg'), 'preview');
  const imageDirs = [path.join(root, 'bigdata'), path.join(root, 'previews'), path.join(root, 'previews', '1000')];

  const full = resolvePageImage({ page_num: 1, big_data: big, previews_data: preview }, imageDirs);
  assert.equal(full.quality, 'full');
  assert.equal(full.path, big);

  const onlyPreview = resolvePageImage({ page_num: 2, big_data: '', previews_data: preview }, imageDirs);
  assert.equal(onlyPreview.quality, 'preview');
  assert.equal(onlyPreview.path, preview);
  assert.match(onlyPreview.note, /预览/);

  const missing = resolvePageImage({ page_num: 3, big_data: '', previews_data: '' }, imageDirs);
  assert.equal(missing.quality, 'missing');
  assert.equal(missing.path, '');
});

test('resolvePageImage 用 basename 兜底 previews/1000 目录', () => {
  const root = tempDir();
  const actual = writeFile(path.join(root, 'previews', '1000', 'x.jpg'), 'preview');
  const imageDirs = [path.join(root, 'bigdata'), path.join(root, 'previews'), path.join(root, 'previews', '1000')];
  const resolved = resolvePageImage(
    { page_num: 1, big_data: '', previews_data: 'D:\\elsewhere\\previews\\x.jpg' },
    imageDirs,
  );
  assert.equal(resolved.quality, 'preview');
  assert.equal(resolved.path, actual);
});

test('loadCamscannerLibrary 读出文档、目录与页图质量', async () => {
  const root = tempDir();
  const { dbPath, big, preview } = await createFixtureDb(root);
  const library = await loadCamscannerLibrary({ dbPath, exists: fs.existsSync });
  assert.equal(library.account, '测试账号');
  assert.equal(library.docs.length, 1);
  const doc = library.docs[0];
  assert.equal(doc.title, '测试文档');
  assert.equal(doc.directory, '证件卡包');
  assert.equal(doc.pages, 2);
  assert.equal(doc.images.length, 2);
  assert.equal(doc.images[0].path, big);
  assert.equal(doc.images[0].quality, 'full');
  assert.equal(doc.images[1].path, preview);
  assert.equal(doc.images[1].quality, 'preview');
  assert.deepEqual(countQualities(doc), { full: 1, preview: 1, missing: 0 });
});

test('loadCamscannerLibrary 对不存在的库给 E_CAMSCANNER_DB', async () => {
  await assert.rejects(loadCamscannerLibrary({ dbPath: 'C:\\no\\such\\camscanner.db', exists: () => false }), (error) => {
    assert.equal(error.code, 'E_CAMSCANNER_DB');
    assert.match(error.message, /找不到 CamScanner 本地库/);
    return true;
  });
});

test('loadCamscannerLibrary 对坏库给可读错误', async () => {
  const root = tempDir();
  const dbPath = writeFile(path.join(root, 'bad.db'), 'not a sqlite database');
  await assert.rejects(loadCamscannerLibrary({ dbPath, exists: fs.existsSync }), (error) => {
    assert.equal(error.code, 'E_CAMSCANNER_DB');
    return true;
  });
});
