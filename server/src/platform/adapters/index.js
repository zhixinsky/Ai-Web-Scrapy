import { genericToAmazonPlatformData } from '../genericToPlatform.js';
import { buildGenericPlatformData } from './genericAdapter.js';
import { buildTemuPlatformData } from './temuAdapter.js';
import { buildShopeePlatformData } from './shopeeAdapter.js';

/**
 * 平台适配器注册表：按 enrichKey 分发“通用数据 → 平台数据”的结构化转化。
 *
 * 设计目标：
 * - amazon 保持现有完整逻辑不变
 * - 其它平台先返回“通用结构 + 命名空间”，保证前端编辑器可用
 * - 后续逐步把各平台字段规范化沉到对应 adapter
 */
export const PLATFORM_ADAPTERS = {
  amazon: (genericParsed) => genericToAmazonPlatformData(genericParsed),
  generic: (genericParsed) => buildGenericPlatformData(genericParsed, { enrichKey: 'generic' }),
  temu: (genericParsed) => buildTemuPlatformData(genericParsed),
  shopee: (genericParsed) => buildShopeePlatformData(genericParsed),
  lazada: (genericParsed) => buildGenericPlatformData(genericParsed, { enrichKey: 'lazada' }),
  tiktok: (genericParsed) => buildGenericPlatformData(genericParsed, { enrichKey: 'tiktok' }),
};

/**
 * @param {string} enrichKey
 * @param {object} genericParsed
 */
export function buildPlatformDataByEnrichKey(enrichKey, genericParsed) {
  const k = String(enrichKey || '').trim().toLowerCase() || 'generic';
  const fn = PLATFORM_ADAPTERS[k] || PLATFORM_ADAPTERS.generic;
  return fn(genericParsed);
}

