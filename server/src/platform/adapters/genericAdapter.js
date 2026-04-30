import { normalizeCollectionImageUrls } from '../../imageUrlNormalize.js';

/**
 * 通用（非 amazon）平台数据适配器：
 * - 保持结构尽量接近 genericParsed，避免前端编辑器崩
 * - 仅做多平台通用的 URL 规范化
 * - 写入 platform_meta 便于追溯
 * @param {object} genericParsed
 * @param {{ enrichKey?: string }} [opts]
 */
export function buildGenericPlatformData(genericParsed, opts = {}) {
  if (!genericParsed || typeof genericParsed !== 'object' || Array.isArray(genericParsed)) return {};
  const copy = JSON.parse(JSON.stringify(genericParsed));
  normalizeCollectionImageUrls(copy);
  const ek = String(opts.enrichKey || 'generic').trim().toLowerCase() || 'generic';
  copy.platform_meta = {
    ...(copy.platform_meta && typeof copy.platform_meta === 'object' && !Array.isArray(copy.platform_meta)
      ? copy.platform_meta
      : {}),
    enrichKey: ek,
    generatedAt: new Date().toISOString(),
  };
  return copy;
}

