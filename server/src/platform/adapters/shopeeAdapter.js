import { buildGenericPlatformData } from './genericAdapter.js';

/**
 * Shopee 平台适配器（占位骨架）。
 * @param {object} genericParsed
 */
export function buildShopeePlatformData(genericParsed) {
  const base = buildGenericPlatformData(genericParsed, { enrichKey: 'shopee' });
  return {
    ...base,
    shopee: {
      ...(base.shopee && typeof base.shopee === 'object' && !Array.isArray(base.shopee) ? base.shopee : {}),
      // 预留：站点、类目、属性、变体模型等
    },
  };
}

