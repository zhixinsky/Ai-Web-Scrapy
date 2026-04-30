/**
 * 通用数据「详情」+「详情_value_xpath」→ 亚马逊风格单行详情（Key:Value<br>…），不调用 AI。
 * 分隔：优先 |（与插件逐格 join 对齐）；否则按空白分词（与「空格分隔」约定一致）。
 */

/** 属性名过滤：不区分大小写（英文）；中文为整段匹配 */
const DROP_EN_EXACT = new Set([
  'brand name',
  'size',
  'cn',
  'brand name / 品牌',
  'size / 尺码',
]);

const DROP_CN_EXACT = new Set([
  '品牌',
  '尺码',
  '货源类别',
  '淘货类别',
  '上市年份/季节',
  '主要销售地区',
  '是否跨境出口专供货源',
  '有无质检报告',
  '原创设计货源',
  '货号',
  '面料支数',
]);

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function splitDetailTokenList(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.includes('|')) {
    return s
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return s.split(/\s+/).filter(Boolean);
}

/**
 * 插件可能上报 string（| 或空格分隔）或 string[]（与另一列一一对应）。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDetailNameOrValueList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return splitDetailTokenList(raw);
  }
  return [];
}

/**
 * @param {string} nameRaw
 */
export function shouldDropAmazonDetailAttributeName(nameRaw) {
  const k = String(nameRaw || '').trim();
  if (!k) return true;
  if (DROP_CN_EXACT.has(k)) return true;
  const low = k.toLowerCase().replace(/\s+/g, ' ');
  if (DROP_EN_EXACT.has(low)) return true;
  return false;
}

/**
 * @param {string | unknown[]} namesStr
 * @param {string | unknown[]} valuesStr
 * @returns {string} 单行，无换行；每段以 <br> 结尾（含最后一条）
 */
export function buildAmazonDetailFromNameValueLists(namesStr, valuesStr) {
  const names = normalizeDetailNameOrValueList(namesStr);
  const values = normalizeDetailNameOrValueList(valuesStr);
  const n = Math.min(names.length, values.length);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const name = names[i];
    const val = values[i];
    if (shouldDropAmazonDetailAttributeName(name)) continue;
    parts.push(`${name}:${val}<br>`);
  }
  return parts.join('');
}

/**
 * 平台数据：将「详情」+「详情_value_xpath」合并为亚马逊格式「详情」，并移除 value 列。
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function mergeAmazonDetailNameValueRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const nameKey = '详情';
  const valueKey = '详情_value_xpath';
  if (!(nameKey in row) || !(valueKey in row)) return row;
  const names = normalizeDetailNameOrValueList(row[nameKey]);
  const vals = normalizeDetailNameOrValueList(row[valueKey]);
  const out = { ...row };
  out[nameKey] = buildAmazonDetailFromNameValueLists(names, vals);
  delete out[valueKey];
  return out;
}

/**
 * @param {unknown[]} rows
 */
export function mergeAmazonDetailNameValueRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) =>
    r && typeof r === 'object' && !Array.isArray(r) ? mergeAmazonDetailNameValueRow(r) : r
  );
}
