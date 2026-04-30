import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { absCollectionImagesRoot } from './images/collectionImagePaths.js';
import { collectionUsesOss, getOssConfig, newOssClient, ossKeyForCollectionImage } from './oss.js';

/**
 * 读取采集记录已落盘的主图/副图/详情图等（与 GET /api/collections/:id/image/... 一致：OSS 优先，否则本地）。
 * @param {{ collectionId: number; role: string; filename: string; imagesStorage: unknown }} opts
 * @returns {Promise<Buffer>}
 */
export async function readCollectionImageBuffer(opts) {
  const id = Number(opts.collectionId);
  const role = String(opts.role || '').trim();
  let filename = path.basename(decodeURIComponent(String(opts.filename || '')));
  if (!Number.isFinite(id) || id <= 0 || !filename) {
    throw new Error('参数无效');
  }
  if (!['main', 'gallery', 'detail', 'main_nobg', 'gallery_nobg'].includes(role)) {
    throw new Error('路径无效');
  }

  const dataDir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : process.cwd();
  const rootDir = path.join(absCollectionImagesRoot(dataDir, id), role);
  const abs = path.join(rootDir, filename);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedAbs = path.resolve(abs);
  const rel = path.relative(resolvedRoot, resolvedAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('非法路径');
  }

  const oc = getOssConfig();
  const tryOss = collectionUsesOss(opts.imagesStorage) && oc.enabled;
  if (tryOss) {
    try {
      const client = newOssClient();
      const key = ossKeyForCollectionImage(id, role, filename);
      const result = await client.get(key);
      const raw = result?.content;
      return Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
    } catch {
      /* 回退本地 */
    }
  }

  if (!fs.existsSync(resolvedAbs)) {
    throw new Error('文件不存在');
  }
  return fsp.readFile(resolvedAbs);
}
