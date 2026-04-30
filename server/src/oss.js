import OSS from 'ali-oss';

function env(key, fallback = '') {
  return String(process.env[key] ?? fallback).trim();
}

export function getOssEnabled() {
  return env('OSS_ENABLED', '0').toLowerCase() === '1' || env('OSS_ENABLED', '').toLowerCase() === 'true';
}

/**
 * 插件上报 imagesStorage：'local' | 'oss'；缺省或非法为 null（按服务端 OSS_ENABLED 与旧数据一致）
 * @param {unknown} raw
 * @returns {'local' | 'oss' | null}
 */
export function normalizeImagesStorageInput(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'local' || s === 'oss') return s;
  return null;
}

/**
 * 本条采集是否把图片写入 OSS（读/写/zip 共用）。
 * - 'local'：始终本地
 * - 'oss'：始终走 OSS（须服务端已配置 OSS）
 * - null/''：旧数据或未传，与全局 OSS_ENABLED 一致
 * @param {unknown} imagesStorage DB images_storage 列
 */
export function collectionUsesOss(imagesStorage) {
  const s = String(imagesStorage ?? '').trim().toLowerCase();
  if (s === 'local') return false;
  if (s === 'oss') return true;
  return getOssEnabled();
}

/** 插件选择 OSS 时校验服务端已启用并配全 OSS */
export function assertImagesStorageOssAllowed() {
  assertOssConfigured();
}

export function getOssConfig() {
  const enabled = getOssEnabled();
  const region = env('OSS_REGION');
  const bucket = env('OSS_BUCKET');
  const endpoint = env('OSS_ENDPOINT');
  const accessKeyId = env('OSS_ACCESS_KEY_ID');
  const accessKeySecret = env('OSS_ACCESS_KEY_SECRET');
  const roleArn = env('OSS_STS_ROLE_ARN');
  const publicOrigin = env('OSS_PUBLIC_ORIGIN'); // https://img.example.com (绑定域名)
  const prefix = env('OSS_PREFIX', ''); // 可选：如 ai-web-scraper

  return {
    enabled,
    region,
    bucket,
    endpoint,
    accessKeyId,
    accessKeySecret,
    roleArn,
    publicOrigin: publicOrigin.replace(/\/$/, ''),
    prefix: prefix.replace(/^\/+|\/+$/g, ''),
  };
}

export function assertOssConfigured() {
  const c = getOssConfig();
  if (!c.enabled) throw new Error('OSS 未启用：请配置 OSS_ENABLED=1');
  if (!c.region) throw new Error('缺少 OSS_REGION');
  if (!c.bucket) throw new Error('缺少 OSS_BUCKET');
  if (!c.endpoint) throw new Error('缺少 OSS_ENDPOINT');
  if (!c.accessKeyId) throw new Error('缺少 OSS_ACCESS_KEY_ID');
  if (!c.accessKeySecret) throw new Error('缺少 OSS_ACCESS_KEY_SECRET');
  return c;
}

export function newOssClient() {
  const c = assertOssConfigured();
  return new OSS({
    region: c.region,
    endpoint: c.endpoint,
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    authorizationV4: true,
    bucket: c.bucket,
  });
}

export function ossKeyForCollectionImage(collectionId, role, filename) {
  const c = getOssConfig();
  const cid = String(Number(collectionId) || '').trim();
  const r = String(role || '').trim();
  const fn = String(filename || '').trim().replace(/^\/+/, '');
  const base = ['images', cid, r, fn].filter((x) => x !== '').join('/');
  return c.prefix ? `${c.prefix}/${base}` : base;
}

export function buildOssPublicUrl(collectionId, role, filename) {
  const c = getOssConfig();
  if (!c.publicOrigin) return '';
  const key = ossKeyForCollectionImage(collectionId, role, filename);
  // 公开读：直接拼接绑定域名 + object key
  return `${c.publicOrigin}/${encodeURI(key).replace(/%2F/g, '/')}`;
}

/**
 * 该采集记录在 Bucket 内的目录前缀（与 ossKeyForCollectionImage 一致），末尾为 `/`
 * @param {number|string} collectionId
 */
export function ossPrefixForCollectionFolder(collectionId) {
  const c = getOssConfig();
  const cid = String(Number(collectionId) || '').trim();
  if (!cid) return '';
  const base = `images/${cid}/`;
  const p = c.prefix ? `${c.prefix}/${base}` : base;
  return p.replace(/^\/+/, '').replace(/\/+/g, '/');
}

/**
 * 删除该采集 id 下 OSS 全部对象（main / gallery / nobg 等）。未启用 OSS 时 no-op。
 * @param {number|string} collectionId
 * @param {{ skip?: boolean }} [options] skip=true 时不请求 OSS（例如 images_storage 为 local）
 * @returns {{ deleted: number }}
 */
export async function deleteOssObjectsForCollection(collectionId, options = {}) {
  if (options.skip) return { deleted: 0 };
  if (!getOssConfig().enabled) return { deleted: 0 };
  let client;
  try {
    client = newOssClient();
  } catch {
    return { deleted: 0 };
  }
  const prefix = ossPrefixForCollectionFolder(collectionId);
  if (!prefix) return { deleted: 0 };
  let total = 0;
  /** @type {string | null | undefined} */
  let continuationToken;
  const maxKeys = 500;
  for (;;) {
    const q = { prefix, 'max-keys': maxKeys };
    if (continuationToken) q['continuation-token'] = continuationToken;
    const result = await client.listV2(q);
    const names = (result.objects || []).map((o) => o.name).filter(Boolean);
    if (names.length) {
      await client.deleteMulti(names);
      total += names.length;
    }
    if (!result.isTruncated) break;
    continuationToken = result.nextContinuationToken || null;
    if (!continuationToken) break;
  }
  return { deleted: total };
}

