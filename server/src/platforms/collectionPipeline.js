/**
 * 采集入库：按「所属平台」路由到不同隐形加工管线（与插件 engine 侧约定同一套平台键）。
 * 当前：速卖通（aliexpress）为默认，加工逻辑预留。
 */

import { sanitizeRowsDetailFields, stripNoiseKeysFromRows } from '../sanitizeDetailFields.js';

export const PLATFORM_ALIEXPRESS = 'aliexpress';
export const PLATFORM_ALIBABA1688 = 'alibaba1688';

/** 与插件 resolvePlatformKey 对齐，用于服务端加工路由 */
export function resolveCollectionPlatformKey(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return PLATFORM_ALIEXPRESS;
  if (s === PLATFORM_ALIEXPRESS || s === 'ae' || s === 'smt') return PLATFORM_ALIEXPRESS;
  if (s.includes('速卖')) return PLATFORM_ALIEXPRESS;
  if (
    s === PLATFORM_ALIBABA1688 ||
    s === '1688' ||
    s === 'cbu' ||
    s.includes('1688') ||
    s.includes('阿里巴巴') ||
    s.includes('阿里') ||
    (s.includes('alibaba') && !s.includes('aliexpress'))
  ) {
    return PLATFORM_ALIBABA1688;
  }
  return String(raw || '').trim();
}

function applyServerHiddenPipeline(platformKey, rows) {
  if (platformKey === PLATFORM_ALIEXPRESS || platformKey === PLATFORM_ALIBABA1688) {
    return rows;
  }
  return rows;
}

/** 上报入库前对 rows 做平台相关加工 */
export function processCollectionRows(platformRaw, rows) {
  const key = resolveCollectionPlatformKey(platformRaw);
  const r = Array.isArray(rows) ? rows : [];
  const piped = applyServerHiddenPipeline(key, r);
  return sanitizeRowsDetailFields(stripNoiseKeysFromRows(piped));
}
