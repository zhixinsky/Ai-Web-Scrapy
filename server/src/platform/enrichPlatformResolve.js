/**
 * 将采集/导出所选的「平台内部 id」（UUID，export_dest_platform_id）解析为二次处理统一使用的平台键（如 amazon）。
 * 该键贯穿整条 MiMo 链：标题、五点描述、颜色/sku_axes、详情段翻译、搜索关键字（见 collectionAuto.js）。
 * 主图/副图无 MiMo，仅为 URL 标准化与下载/去背景，随 generic→平台数据 流程执行。
 * 配置存于 app_settings：platform_enrich_map、default_export_platform_id。
 */
import { db } from '../db.js';

export function getAppSetting(key) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(String(key || ''));
  return r?.value != null ? String(r.value) : null;
}

export function setAppSetting(key, value) {
  const k = String(key || '').trim();
  if (!k) throw new Error('app_settings key 不能为空');
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(k, String(value ?? ''));
}

export function getPlatformEnrichMap() {
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

function fallbackEnvKey() {
  return String(process.env.MIMO_ENRICH_PLATFORM ?? 'amazon')
    .trim()
    .toLowerCase() || 'amazon';
}

/**
 * @param {{ export_dest_platform_id?: string | null }} row
 * @returns {string} 传给 getPlatformTitleSystemPrompt 的键
 */
export function resolveEnrichPlatformKeyFromCollectionRow(row) {
  const map = getPlatformEnrichMap();
  const defaultId = String(getAppSetting('default_export_platform_id') || '').trim();
  const rowId = row && row.export_dest_platform_id != null ? String(row.export_dest_platform_id).trim() : '';
  const chosenId = rowId || defaultId;
  if (chosenId && Object.prototype.hasOwnProperty.call(map, chosenId)) {
    const k = String(map[chosenId] || '').trim().toLowerCase();
    if (k) return k;
  }
  return fallbackEnvKey();
}
