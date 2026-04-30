import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { normalizeOneImageUrl } from '../imageUrlNormalize.js';
import { absCollectionImagesRoot } from './collectionImagePaths.js';
import { getOssConfig, newOssClient, ossKeyForCollectionImage } from '../oss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeExtFromUrl(u) {
  try {
    const url = new URL(u);
    const p = url.pathname || '';
    const m = p.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/);
    if (m) return '.' + m[1];
  } catch {
    // ignore
  }
  return '.jpg';
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const v = String(s || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function extractImageUrlsFromRows(rows) {
  const main = [];
  const gallery = [];
  const detail = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const [k, v] of Object.entries(r)) {
      const key = String(k || '');
      if (!key) continue;
      const isMain = key.includes('主图');
      const isGallery = key.startsWith('副图') || key.includes('副图');
      const isDetail = key === '详情图' || key.startsWith('详情图');
      if (!isMain && !isGallery && !isDetail) continue;

      const pushVal = (val) => {
        if (typeof val === 'string' && val.trim()) {
          (isMain ? main : isGallery ? gallery : detail).push(normalizeOneImageUrl(val.trim()));
        }
      };

      if (Array.isArray(v)) v.forEach(pushVal);
      else pushVal(v);
    }
  }
  return { main: uniq(main), gallery: uniq(gallery), detail: uniq(detail) };
}

function extFromContentType(ct) {
  const s = String(ct || '').toLowerCase();
  if (s.includes('png')) return '.png';
  if (s.includes('webp')) return '.webp';
  if (s.includes('gif')) return '.gif';
  if (s.includes('jpeg')) return '.jpeg';
  if (s.includes('jpg')) return '.jpg';
  return '';
}

/** 单张图拉取超时（毫秒），避免远端挂死占满整队列；可通过环境变量覆盖 */
const IMAGE_DOWNLOAD_FETCH_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.IMAGE_DOWNLOAD_FETCH_TIMEOUT_MS) || 90_000
);

function buildImageFetchHeaders(url) {
  // 部分站点/CDN 会对“无 UA / 无 Referer”的请求返回 403/404；
  // 这里提供一个尽量通用、低侵入的浏览器型 header 组合，用于失败后的兜底重试。
  const u = String(url || '');
  const host = (() => {
    try {
      return new URL(u).hostname;
    } catch {
      return '';
    }
  })();

  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // 模拟常见浏览器 UA（不要用太怪的 UA，避免触发风控）
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };

  // Alibaba 系图片域名经常期望存在 Referer（有时没有也能 200，但失败时带上可提高成功率）
  if (host.endsWith('.alicdn.com') || host.includes('1688') || host.includes('taobao')) {
    headers.Referer = 'https://detail.1688.com/';
  }

  return headers;
}

async function downloadOne(url, outDir, fallbackExt) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), IMAGE_DOWNLOAD_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: ac.signal });
  } catch (e) {
    const name = e?.name === 'AbortError' ? '超时' : String(e?.message || e);
    throw new Error(
      `下载失败 ${name}（>${IMAGE_DOWNLOAD_FETCH_TIMEOUT_MS}ms 或网络错误）: ${String(url).slice(0, 120)}`
    );
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) {
    // 对少数链接：直接抓取会 403/404，但带浏览器头可成功；仅在这些状态下做一次兜底重试。
    if (res.status === 403 || res.status === 404) {
      const ac2 = new AbortController();
      const tid2 = setTimeout(() => ac2.abort(), IMAGE_DOWNLOAD_FETCH_TIMEOUT_MS);
      try {
        const headers = buildImageFetchHeaders(url);
        const res2 = await fetch(url, {
          redirect: 'follow',
          signal: ac2.signal,
          headers,
        });
        if (res2.ok) res = res2;
        else {
          throw new Error(
            `下载失败 ${res2.status} ${res2.statusText}: ${String(url).slice(0, 200)}`
          );
        }
      } catch (e) {
        const msg = String(e?.message || e);
        throw new Error(`下载失败（重试仍失败）: ${msg}`);
      } finally {
        clearTimeout(tid2);
      }
    } else {
      throw new Error(`下载失败 ${res.status} ${res.statusText}: ${String(url).slice(0, 200)}`);
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const ext = extFromContentType(res.headers.get('content-type')) || fallbackExt || '.jpg';
  const filename = `${hash}${ext}`;
  return { filename, buf };
}

function isNotFoundError(e) {
  const msg = String(e?.message || e || '');
  return msg.includes(' 404 ') || msg.includes('404 Not Found');
}

/**
 * 将图片按采集记录分目录下载到：
 * - {dataDir}/images/<id>/main/
 * - {dataDir}/images/<id>/gallery/
 * - {dataDir}/images/<id>/detail/
 * @returns {{ mainCount:number, galleryCount:number, detailCount:number, mainFiles:string[], galleryFiles:string[], detailFiles:string[] }}
 */
export async function downloadCollectionImages({
  collectionId,
  dataDir,
  mainUrls,
  galleryUrls,
  detailUrls = [],
  /** 本条采集是否写 OSS（已由服务端结合 images_storage 与 OSS_ENABLED 算出） */
  useOss: useOssOverride,
}) {
  const oc = getOssConfig();
  const useOss = Boolean(useOssOverride) && oc.enabled;
  const client = useOss ? newOssClient() : null;
  const base = absCollectionImagesRoot(dataDir, collectionId);
  const mainDir = path.join(base, 'main');
  const galleryDir = path.join(base, 'gallery');
  const detailDir = path.join(base, 'detail');
  if (!useOss) {
    const fs = await import('fs/promises');
    await fs.mkdir(mainDir, { recursive: true });
    await fs.mkdir(galleryDir, { recursive: true });
    await fs.mkdir(detailDir, { recursive: true });
  }

  let mainCount = 0;
  let galleryCount = 0;
  let detailCount = 0;
  const mainFiles = [];
  const galleryFiles = [];
  const detailFiles = [];

  for (let i = 0; i < mainUrls.length; i++) {
    const u = mainUrls[i];
    const ext = safeExtFromUrl(u);
    let filename, buf;
    try {
      ({ filename, buf } = await downloadOne(u, mainDir, ext));
    } catch (e) {
      throw new Error(`[主图 ${i + 1}/${mainUrls.length}] ${String(e?.message || e)}`);
    }
    if (useOss) {
      const key = ossKeyForCollectionImage(collectionId, 'main', filename);
      await client.put(key, buf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
        client.put(key, buf)
      );
    } else {
      const fs = await import('fs/promises');
      const outPath = path.join(mainDir, filename);
      try {
        await fs.access(outPath);
      } catch {
        await fs.writeFile(outPath, buf);
      }
    }
    mainFiles.push(filename);
    mainCount++;
  }

  for (let i = 0; i < galleryUrls.length; i++) {
    const u = galleryUrls[i];
    const ext = safeExtFromUrl(u);
    let filename, buf;
    try {
      ({ filename, buf } = await downloadOne(u, galleryDir, ext));
    } catch (e) {
      throw new Error(`[副图 ${i + 1}/${galleryUrls.length}] ${String(e?.message || e)}`);
    }
    if (useOss) {
      const key = ossKeyForCollectionImage(collectionId, 'gallery', filename);
      await client.put(key, buf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
        client.put(key, buf)
      );
    } else {
      const fs = await import('fs/promises');
      const outPath = path.join(galleryDir, filename);
      try {
        await fs.access(outPath);
      } catch {
        await fs.writeFile(outPath, buf);
      }
    }
    galleryFiles.push(filename);
    galleryCount++;
  }

  for (let i = 0; i < detailUrls.length; i++) {
    const u = detailUrls[i];
    const ext = safeExtFromUrl(u);
    let filename, buf;
    try {
      ({ filename, buf } = await downloadOne(u, detailDir, ext));
    } catch (e) {
      // 详情图常见“反爬干扰/隐藏占位”导致链接本身就是 404。
      // 不应因为个别详情图不可用而导致整条采集失败。
      if (isNotFoundError(e)) {
        console.warn(
          `[images] detail image not found, skipped: ${String(u).slice(0, 200)} (index ${
            i + 1
          }/${detailUrls.length})`
        );
        continue;
      }
      throw new Error(`[详情图 ${i + 1}/${detailUrls.length}] ${String(e?.message || e)}`);
    }
    if (useOss) {
      const key = ossKeyForCollectionImage(collectionId, 'detail', filename);
      await client.put(key, buf, { headers: { 'Content-Type': 'image/jpeg' } }).catch(() =>
        client.put(key, buf)
      );
    } else {
      const fs = await import('fs/promises');
      const outPath = path.join(detailDir, filename);
      try {
        await fs.access(outPath);
      } catch {
        await fs.writeFile(outPath, buf);
      }
    }
    detailFiles.push(filename);
    detailCount++;
  }

  return { mainCount, galleryCount, detailCount, mainFiles, galleryFiles, detailFiles };
}

