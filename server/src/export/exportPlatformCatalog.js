/**
 * 导出目标平台目录：名称 + 稳定内部 id + 处理模板键（与 platform_enrich_map 一致）。
 * 首次启动写入 app_settings；前端不再本地维护平台列表。
 */
import { db } from '../db.js';

function getAppSetting(key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(String(key || ''));
  return r?.value != null ? String(r.value) : null;
}

function setAppSetting(key, value) {
  const k = String(key || '').trim();
  if (!k) throw new Error('app_settings key 不能为空');
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(k, String(value ?? ''));
}

function getPlatformEnrichMap() {
  const raw = getAppSetting('platform_enrich_map');
  if (raw == null || raw === '') return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const kk = String(k).trim();
      if (!kk) continue;
      out[kk] = String(v ?? '').trim().toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}

/** 稳定 UUID（v4 形态），便于文档与插件配置引用 */
export const EXPORT_PLATFORMS_SEED = [
  { id: '00000000-0000-4000-8000-000000000001', name: '亚马逊（Amazon）', enrichKey: 'amazon' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Temu', enrichKey: 'temu' },
  { id: '00000000-0000-4000-8000-000000000003', name: '虾皮（Shopee）', enrichKey: 'shopee' },
  { id: '00000000-0000-4000-8000-000000000004', name: 'Lazada', enrichKey: 'lazada' },
  { id: '00000000-0000-4000-8000-000000000005', name: 'TikTok Shop', enrichKey: 'tiktok' },
  { id: '00000000-0000-4000-8000-000000000006', name: '通用（generic）', enrichKey: 'generic' },
];

const CATALOG_KEY = 'export_platform_catalog';

/**
 * @param {unknown} raw
 * @returns {{ id: string, name: string, enrichKey?: string }[]}
 */
function normalizeCatalogArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (x);
    const id = String(o.id || '').trim();
    const name = String(o.name || '').trim();
    if (!id || !name) continue;
    const ek =
      o.enrichKey != null && String(o.enrichKey).trim() !== ''
        ? String(o.enrichKey).trim().toLowerCase()
        : undefined;
    if (ek && !/^[a-z0-9_-]+$/.test(ek)) continue;
    out.push(ek ? { id, name, enrichKey: ek } : { id, name });
  }
  return out;
}

/**
 * @returns {{ id: string, name: string, enrichKey?: string }[]}
 */
export function getExportPlatformCatalog() {
  const raw = getAppSetting(CATALOG_KEY);
  if (raw == null || String(raw).trim() === '') return [];
  try {
    const parsed = JSON.parse(String(raw));
    return normalizeCatalogArray(parsed);
  } catch {
    return [];
  }
}

function mergeMapFromCatalog(catalog) {
  const prev = getPlatformEnrichMap();
  const next = { ...prev };
  for (const p of catalog) {
    const k = String(p.enrichKey || '').trim().toLowerCase();
    if (k && /^[a-z0-9_-]+$/.test(k)) next[p.id] = k;
  }
  setAppSetting('platform_enrich_map', JSON.stringify(next));
}

/**
 * 若尚无目录：写入种子并合并 platform_enrich_map。
 * 已有非空目录时不覆盖；若键存在但 JSON 损坏得到空数组则重置为种子。
 */
export function ensureExportPlatformCatalogAndMap() {
  const raw = getAppSetting(CATALOG_KEY);
  if (raw != null && String(raw).trim() !== '') {
    const cur = getExportPlatformCatalog();
    if (cur.length === 0) {
      setAppSetting(CATALOG_KEY, JSON.stringify(EXPORT_PLATFORMS_SEED));
      mergeMapFromCatalog(EXPORT_PLATFORMS_SEED);
    }
    return;
  }
  setAppSetting(CATALOG_KEY, JSON.stringify(EXPORT_PLATFORMS_SEED));
  mergeMapFromCatalog(EXPORT_PLATFORMS_SEED);
}
