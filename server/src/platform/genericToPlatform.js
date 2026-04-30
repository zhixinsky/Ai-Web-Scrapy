import { mergeAmazonDetailNameValueRows } from '../amazonDetailFromNameValueLists.js';
import { normalizeCollectionImageUrls } from '../imageUrlNormalize.js';
import { normalizeCollectionDataSizes } from '../sizeUsStandardize.js';
import { buildPlatformDataByEnrichKey } from './adapters/index.js';

function rowsFromDataLike(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return [];
  if (Array.isArray(d.rows)) return d.rows;
  if (!('rows' in d)) return [d];
  return [];
}

function sharedRowFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const p = rows.find((r) => r && typeof r === 'object' && !Array.isArray(r) && r['父子关系'] === 'parent');
  if (p && typeof p === 'object' && !Array.isArray(p)) return p;
  const first = rows[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) return first;
  return null;
}

/**
 * 解析采集到的价格文本，返回人民币数值（取区间的最小值）。
 * 支持：¥69、69元、69-79、69~79、"69 / 79" 等常见写法。
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseRmbPrice(raw) {
  if (raw == null) return null;
  const s = Array.isArray(raw)
    ? raw.map((x) => String(x ?? '').trim()).filter(Boolean).join(' / ')
    : String(raw ?? '').trim();
  if (!s) return null;
  const cleaned = s
    .replace(/[￥¥]/g, '')
    .replace(/rmb/gi, '')
    .replace(/cny/gi, '')
    .replace(/元/g, '')
    .replace(/人民币/g, '')
    .replace(/,/g, '')
    .trim();
  if (!cleaned) return null;
  const nums = cleaned.match(/\d+(?:\.\d+)?/g) || [];
  if (nums.length === 0) return null;
  const values = nums.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  const min = Math.min(...values);
  if (!Number.isFinite(min)) return null;
  return min;
}

/**
 * 按分段规则把 RMB → USD（用于亚马逊平台数据 list_price）。
 * 输出：两位小数，且最后一位为 9（例如 46.79）。
 * @param {number} rmb
 * @returns {string} 形如 "46.79"；超出范围返回 "error"
 */
export function convertRmbToAmazonListPriceUsd(rmb) {
  const v = Number(rmb);
  if (!Number.isFinite(v) || v < 0) return 'error';
  if (v > 500) return 'error';

  /** [minRmb, maxRmb] 区间对应最低 USD */
  const bands = [
    { min: 0, max: 50, floor: 45 },
    { min: 50, max: 60, floor: 50 },
    { min: 60, max: 70, floor: 55 },
    { min: 70, max: 80, floor: 60 },
    { min: 80, max: 90, floor: 70 },
    { min: 90, max: 100, floor: 75 },
    { min: 100, max: 150, floor: 80 },
    { min: 150, max: 200, floor: 90 },
    { min: 200, max: 300, floor: 120 },
    { min: 300, max: 400, floor: 140 },
    { min: 400, max: 500, floor: 150 },
  ];

  let idx = bands.findIndex((b) => v >= b.min && (v < b.max || (v === 500 && b.max === 500)));
  if (idx < 0) idx = bands.length - 1;
  const b = bands[idx];
  const next = bands[idx + 1] || null;

  // 同一档位内按实际 RMB 做线性插值，保证“不同实际价格 → 不同美元价”
  const tDen = Math.max(1e-9, b.max - b.min);
  const t = Math.max(0, Math.min(1, (v - b.min) / tDen));
  const upper =
    next
      ? Math.max(b.floor, next.floor - 0.01) // 不越过下一档最低价
      : b.floor + 9.99; // 最后一档给一点上浮空间
  const target = b.floor + (upper - b.floor) * t;

  // 格式：>=target，2 位小数，且最后一位为 9
  const ceil2 = Math.ceil(target * 100) / 100;
  const dollars = Math.floor(ceil2);
  let cents = Math.round((ceil2 - dollars) * 100);
  if (cents < 0) cents = 0;
  if (cents > 99) cents = 99;
  let centsEnding9 = cents - (cents % 10) + 9;
  if (centsEnding9 < cents) centsEnding9 += 10;
  let out = dollars + centsEnding9 / 100;
  if (centsEnding9 >= 100) out = dollars + 1 + (centsEnding9 - 100) / 100;

  // 安全兜底：仍需满足 floor 与 target（浮点误差场景）
  if (out + 1e-9 < b.floor) out = b.floor;
  if (out + 1e-9 < target) {
    const bumped = Math.ceil(target * 100) / 100;
    const d2 = Math.floor(bumped);
    let c2 = Math.round((bumped - d2) * 100);
    let c2e = c2 - (c2 % 10) + 9;
    if (c2e < c2) c2e += 10;
    out = c2e >= 100 ? d2 + 1 + (c2e - 100) / 100 : d2 + c2e / 100;
  }

  return out.toFixed(2);
}

/**
 * 通用数据 → **默认亚马逊**平台数据（采集入库后立即写入 platform_data_json / data_json）。
 * 含：美码尺码、主图/副图 URL 规范（非 AI，与 export_dest_platform_id 无提示词分支）、
 * 详情+详情_value_xpath→亚马逊 Key:Value<br>、sku_axes 等；不含 MiMo。
 * MiMo 各阶段在入库 worker 中先于/后于本函数，且统一按 export_dest_platform_id 解析的平台键选提示词。
 * @param {object} genericParsed 已 parse 的通用数据对象（含 rows、sku_axes 等）
 * @returns {object} 亚马逊平台侧数据结构
 */
export function genericToAmazonPlatformData(genericParsed) {
  if (!genericParsed || typeof genericParsed !== 'object' || Array.isArray(genericParsed)) {
    return {};
  }
  const copy = JSON.parse(JSON.stringify(genericParsed));
  normalizeCollectionDataSizes(copy);
  normalizeCollectionImageUrls(copy);
  if (Array.isArray(copy.rows)) {
    copy.rows = mergeAmazonDetailNameValueRows(copy.rows);
  }

  // 价格：从通用数据里的「价格/Price」推导平台侧 list_price（USD）
  try {
    const rows = rowsFromDataLike(copy);
    const shared = sharedRowFromRows(rows);
    if (shared && typeof shared === 'object' && !Array.isArray(shared)) {
      const cur = String(shared.list_price ?? '').trim();
      if (!cur) {
        const raw = shared['价格'] ?? shared['Price'];
        const rmb = parseRmbPrice(raw);
        if (rmb != null) {
          const usd = convertRmbToAmazonListPriceUsd(rmb);
          if (usd) shared.list_price = usd;
        }
      }
    }
  } catch {
    // ignore
  }
  return copy;
}

/**
 * 非亚马逊导出：在导出时对 **通用数据** 做二次加工（不写回 DB）。
 * 不做美码尺码标准化、不做亚马逊详情分列合并，仅做图片 URL 规范化等与多平台共用的处理。
 * @param {object} genericParsed
 * @returns {object}
 */
export function genericToExportSecondaryPlatformData(genericParsed) {
  if (!genericParsed || typeof genericParsed !== 'object' || Array.isArray(genericParsed)) {
    return {};
  }
  // 兼容旧逻辑：非 amazon 导出/二次加工默认走 generic adapter
  return buildPlatformDataByEnrichKey('generic', genericParsed);
}

/** @deprecated 请使用 genericToAmazonPlatformData（语义：默认亚马逊平台数据） */
export function genericToPlatformData(genericParsed) {
  return genericToAmazonPlatformData(genericParsed);
}

/**
 * 通用数据 → 平台数据（按 enrichKey 分发）。
 * @param {object} genericParsed
 * @param {string} enrichKey
 */
export function genericToPlatformDataByEnrichKey(genericParsed, enrichKey) {
  return buildPlatformDataByEnrichKey(enrichKey, genericParsed);
}

/**
 * 管理员保存「平台数据」时：再次应用美码尺码与图片 URL 规范化。
 * 不做「详情+详情_value_xpath」合并，避免覆盖用户已编辑的详情正文。
 * @param {object} platformParsed
 * @returns {object}
 */
export function applyPlatformDataOnSave(platformParsed) {
  if (!platformParsed || typeof platformParsed !== 'object' || Array.isArray(platformParsed)) {
    return platformParsed;
  }
  const copy = JSON.parse(JSON.stringify(platformParsed));
  normalizeCollectionDataSizes(copy);
  normalizeCollectionImageUrls(copy);
  return copy;
}
