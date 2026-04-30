/**
 * 采集入库清洗逻辑 - 兼容版
 * 专门处理 Key|Key 和 Value|Value 结构的原始数据
 */

const DROP_KEYS_EN = new Set([
  'brand name', 'brand', 'origin', 'place of origin', 'country of origin',
  'product origin', 'made in', 'madein', 'cn', 'size', 'sizes', 'country',
  'platforms', 'main downstream platforms', 'color', 'in stock', 'stock type',
  'suitable for', 'error range', 'item no', 'article number', 'platforms'
]);

const DROP_KEY_SUBSTRINGS_CN = [
  '品牌', '尺码', '跨境', '质检', '货源', '货号', '颜色', '平台', '年份', '季节',
  '淘货', '销售', '地区', '库存', '授权', '专供', '设计货源', '报告', '误差',
  '上市', '质检', '吊牌', '领标', '衣长'
];

/**
 * 内部判断：该字段是否属于黑名单
 */
function shouldDrop(keyRaw) {
  const k = String(keyRaw || '').trim().toLowerCase();
  if (!k) return true;
  if (DROP_KEYS_EN.has(k)) return true;
  if (k.startsWith('size') || k.startsWith('brand')) return true;
  for (const sub of DROP_KEY_SUBSTRINGS_CN) {
    if (k.includes(sub)) return true;
  }
  return false;
}

/**
 * 核心逻辑：将 Key串 和 Value串 清洗并合并
 */
function sanitizeAndJoin(keysStr, valuesStr) {
  if (!keysStr || !valuesStr) return "";
  const keys = String(keysStr).split('|').map(s => s.trim());
  const values = String(valuesStr).split('|').map(s => s.trim());
  const keptPairs = [];

  for (let i = 0; i < keys.length; i++) {
    const rawK = keys[i];
    const rawV = values[i] || '';
    if (!shouldDrop(rawK)) {
      // 详情输出格式：保留冒号后一个空格（键: 值），英文可读性更好
      keptPairs.push(`${rawK}: ${rawV}`);
    }
  }
  return keptPairs.join('<br>');
}

// 兼容旧测试/旧调用命名：输出为 <br> 拼接字符串
export function sanitizeBrDetailString(keysStr, valuesStr) {
  return sanitizeAndJoin(keysStr, valuesStr);
}

// --- 以下是 collectionPipeline.js 依赖的导出函数 ---

/**
 * 清洗单行数据
 */
export function sanitizeRowDetailFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };

  // 针对你原始数据的两个核心字段进行处理
  const keyField = "详情";
  const valueField = "详情_value_xpath";

  if (out[keyField] && out[valueField]) {
    // 执行清洗并将结果覆盖到“详情”字段，供后续翻译使用
    out[keyField] = sanitizeAndJoin(out[keyField], out[valueField]);
    // 处理完后删除原始 xpath 字段，防止干扰
    delete out[valueField];
  }
  return out;
}

/**
 * 清洗多行数据（对应报错中的导出）
 */
export function sanitizeRowsDetailFields(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => sanitizeRowDetailFields(r));
}

/**
 * 移除噪声独立列（保留原本逻辑名）
 */
export function stripNoiseKeysFromRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  // 移除可能独立存在的干扰字段
  const NOISE_EXACT = ['搜索关键页', '搜索关键字', '主要下游平台'];
  for (const k of NOISE_EXACT) {
    if (out[k]) delete out[k];
  }
  return out;
}

/**
 * 移除多行噪声独立列（对应报错中的导出）
 */
export function stripNoiseKeysFromRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => stripNoiseKeysFromRow(r));
}

/**
 * 总入口函数
 */
export function sanitizeCollectionDataPayload(data) {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data.rows)) {
    let cleanRows = stripNoiseKeysFromRows(data.rows);
    cleanRows = sanitizeRowsDetailFields(cleanRows);
    return { ...data, rows: cleanRows };
  }
  return sanitizeRowDetailFields(stripNoiseKeysFromRow(data));
}