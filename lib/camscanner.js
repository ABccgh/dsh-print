/**
 * CamScanner（全能扫描王）本地库的只读接入。
 *
 * 数据来源：`%APPDATA%\CamScanner\Camscanner\camscanner.db`（SQLite）里的
 * `documents` / `pages` 两张表，页图落在 `Camscanner\<账号>\{bigdata,previews,previews\1000}`。
 * 这里**只读**：打开数据库用 `readOnly: true`，不写回、不动 App 目录。
 *
 * @module @local/print/camscanner
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultCamscannerDbPath } from './config.js';
import { printError } from './errors.js';

/** 单页图片质量：full=原始增强图，preview=1000px 预览图，missing=未落盘。 */
export const IMAGE_QUALITY = Object.freeze({
  full: 'full',
  preview: 'preview',
  missing: 'missing',
});

/**
 * 探测 CamScanner 库路径。
 * @param {{ dbPath?: string, exists?: (file: string) => boolean }} [options] - 选项。
 * @returns {string} 路径（可能不存在）。
 */
export function resolveLibraryDb({ dbPath = '', exists = fs.existsSync } = {}) {
  if (typeof dbPath === 'string' && dbPath !== '') return dbPath;
  const discovered = defaultCamscannerDbPath();
  return exists(discovered) ? discovered : discovered;
}

/**
 * 文件是否存在且非空。
 * @param {string} file - 路径。
 * @returns {boolean} 是否可用。
 */
function isUsableFile(file) {
  if (typeof file !== 'string' || file === '') return false;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * 解析一页的图片：big_data（原图）优先，其次 previews_data，最后按 basename 在常见目录兜底。
 *
 * DB 里记录的 preview 路径有时是 `previews\<name>.jpg`，实际文件却落在 `previews\1000\<name>.jpg`，
 * 所以必须做 basename 兜底，不能只信记录路径。
 * @param {{ page_num: number, big_data?: string, previews_data?: string }} page - pages 行。
 * @param {string[]} imageDirs - 候选目录（bigdata/previews/previews\1000/originals）。
 * @returns {{ pageNum: number, path: string, quality: string, note: string }} 解析结果。
 */
export function resolvePageImage(page, imageDirs) {
  const pageNum = Number(page.page_num) || 0;
  if (isUsableFile(page.big_data)) {
    return { pageNum, path: page.big_data, quality: IMAGE_QUALITY.full, note: '' };
  }
  if (isUsableFile(page.previews_data)) {
    return { pageNum, path: page.previews_data, quality: IMAGE_QUALITY.preview, note: '仅预览图' };
  }
  const names = new Set();
  for (const raw of [page.big_data, page.previews_data]) {
    if (typeof raw === 'string' && raw !== '') names.add(path.basename(raw));
  }
  for (const name of names) {
    for (const directory of imageDirs) {
      const candidate = path.join(directory, name);
      if (!isUsableFile(candidate)) continue;
      const quality = directory.includes('bigdata') ? IMAGE_QUALITY.full : IMAGE_QUALITY.preview;
      return { pageNum, path: candidate, quality, note: quality === IMAGE_QUALITY.preview ? '仅预览图' : '' };
    }
  }
  return { pageNum, path: '', quality: IMAGE_QUALITY.missing, note: '页图未落盘' };
}

/**
 * 读本地库。数据库不存在、Node 不支持 `node:sqlite`、表结构对不上时都抛带错误码的插件错误。
 * @param {{ dbPath: string, limit?: number, exists?: (file: string) => boolean }} options - 选项。
 * @returns {Promise<{ dbPath: string, account: string, root: string, docs: object[] }>} 文档列表。
 */
export async function loadCamscannerLibrary({ dbPath, limit = 20, exists = fs.existsSync } = {}) {
  const resolved = resolveLibraryDb({ dbPath, exists });
  if (!exists(resolved)) {
    throw printError(
      'E_CAMSCANNER_DB',
      `找不到 CamScanner 本地库：${resolved}。请先打开全能扫描王并登录/同步一次，或用配置 camscanner.dbPath 指定路径。`,
    );
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw printError('E_CAMSCANNER_DB', '当前 Node 运行时不提供 node:sqlite，无法读取 CamScanner 本地库（PDF/图片打印不受影响）。');
  }
  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    throw printError('E_CAMSCANNER_DB', `打开 CamScanner 库失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const account = db.prepare('select sync_account_id, account_name from sync_accounts order by id limit 1').get();
    const rows = db.prepare(
      'select sync_id, title, pages_num, modify_time, parent_dir_sync_id from documents order by modify_time desc limit ?',
    ).all(limit);
    const dirTitles = new Map(db.prepare('select sync_id, title from dirs').all().map((row) => [row.sync_id, row.title]));
    const pageStatement = db.prepare('select page_num, big_data, previews_data from pages where doc_id = ? order by page_num');
    const root = path.dirname(resolved);
    const accountId = account?.sync_account_id ?? '';
    const imageDirs = [
      path.join(root, accountId, 'bigdata'),
      path.join(root, accountId, 'previews'),
      path.join(root, accountId, 'previews', '1000'),
      path.join(root, accountId, 'originals'),
    ];

    const docs = rows.map((row, index) => {
      const pages = pageStatement.all(row.sync_id).map((page) => resolvePageImage(page, imageDirs));
      return {
        index: index + 1,
        docId: row.sync_id,
        title: row.title || '未命名文档',
        directory: dirTitles.get(row.parent_dir_sync_id) || '',
        pages: Number.isFinite(row.pages_num) ? row.pages_num : pages.length,
        updatedAt: Number.isFinite(row.modify_time) ? row.modify_time : null,
        images: pages,
      };
    });
    return { dbPath: resolved, account: account?.account_name ?? '', root, docs };
  } catch (error) {
    throw printError('E_CAMSCANNER_DB', `读取 CamScanner 库失败（可能 App 升级改了表结构）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      db.close();
    } catch {
      // 关闭失败无所谓。
    }
  }
}

/**
 * 统计一份文档的页图质量。
 * @param {{ images: Array<{ quality: string }> }} doc - 文档。
 * @returns {{ full: number, preview: number, missing: number }} 计数。
 */
export function countQualities(doc) {
  const counts = { full: 0, preview: 0, missing: 0 };
  for (const image of doc.images) {
    if (image.quality === IMAGE_QUALITY.full) counts.full += 1;
    else if (image.quality === IMAGE_QUALITY.preview) counts.preview += 1;
    else counts.missing += 1;
  }
  return counts;
}
