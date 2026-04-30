import { buildGenericPlatformData } from './genericAdapter.js';

/**
 * Temu 平台适配器（占位骨架）：
 * 先在通用平台数据基础上加入 temu 命名空间，后续再逐步做字段规范化/映射。
 * @param {object} genericParsed
 */
export function buildTemuPlatformData(genericParsed) {
  const base = buildGenericPlatformData(genericParsed, { enrichKey: 'temu' });
  return {
    ...base,
    temu: {
      ...(base.temu && typeof base.temu === 'object' && !Array.isArray(base.temu) ? base.temu : {}),
      // 预留：后续可放 temu 专属字段，如类目/属性/物流模板等
    },
  };
}

