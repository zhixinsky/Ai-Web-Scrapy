/**
 * 平台数据：将通用数据中的尺码字段标准化为美码全称 + 降两档（不调用 AI）。
 * 不写 尺码简码 / 标准尺码 / 简码 / *简码（简码列留给业务后续使用）。
 * 仅应在 genericToAmazonPlatformData → normalizeCollectionDataSizes 中应用，使 generic_data 保留原始尺码文案。
 * 支持 string；插件若将多行体重表采成 string[]，会先按行 join 再标准化。
 */

const NOISE_WORDS =
  /\b(us|uk|eu|size|sizes|码|号|men'?s|women'?s|women|men|kids?|kid|unisex|adult|junior|regular|fit)\b/gi;

/** 由小到大；降两档即索引减 2（下限为 0） */
export const US_SIZE_ORDER = [
  'XX-Small',
  'X-Small',
  'Small',
  'Medium',
  'Large',
  'X-Large',
  'XX-Large',
  '3X-Large',
  '4X-Large',
  '5X-Large',
  '6X-Large',
  '7X-Large',
  '8X-Large',
];

/** 全称 → 简码（与 US_SIZE_ORDER 一致） */
export const US_SIZE_FULL_TO_SHORT = {
  'XX-Small': 'XXS',
  'X-Small': 'XS',
  Small: 'S',
  Medium: 'M',
  Large: 'L',
  'X-Large': 'XL',
  'XX-Large': 'XXL',
  '3X-Large': '3XL',
  '4X-Large': '4XL',
  '5X-Large': '5XL',
  '6X-Large': '6XL',
  '7X-Large': '7XL',
  '8X-Large': '8XL',
};

/**
 * 紧凑串中的子串 → 美码全称（未降档）。按字符串长度从长到短匹配，避免 xl 误吞 xxl。
 * @type {{ s: string; name: string }[]}
 */
const SIZE_SCAN_PATTERNS = (() => {
  const pairs = [];
  for (let n = 8; n >= 3; n--) {
    const name = `${n}X-Large`;
    pairs.push({ s: `${n}xlarge`, name });
    pairs.push({ s: `${n}xl`, name });
  }
  pairs.push({ s: 'xxxxlarge', name: '4X-Large' });
  pairs.push({ s: 'xxxxl', name: '4X-Large' });
  pairs.push({ s: 'xxxlarge', name: '3X-Large' });
  pairs.push({ s: 'xxxl', name: '3X-Large' });
  pairs.push({ s: 'xxlarge', name: 'XX-Large' });
  pairs.push({ s: 'xxl', name: 'XX-Large' });
  pairs.push({ s: '2xlarge', name: 'XX-Large' });
  pairs.push({ s: '2xl', name: 'XX-Large' });
  pairs.push({ s: '2x', name: 'XX-Large' });
  pairs.push({ s: 'xlarge', name: 'X-Large' });
  pairs.push({ s: 'xl', name: 'X-Large' });
  pairs.push({ s: '1xlarge', name: 'X-Large' });
  pairs.push({ s: '1xl', name: 'X-Large' });
  pairs.push({ s: '1x', name: 'X-Large' });
  pairs.push({ s: 'large', name: 'Large' });
  pairs.push({ s: 'medium', name: 'Medium' });
  pairs.push({ s: 'small', name: 'Small' });
  pairs.push({ s: 'l', name: 'Large' });
  pairs.push({ s: 'm', name: 'Medium' });
  pairs.push({ s: 's', name: 'Small' });
  pairs.push({ s: 'xxsmall', name: 'XX-Small' });
  pairs.push({ s: 'xxs', name: 'XX-Small' });
  pairs.push({ s: 'xsmall', name: 'X-Small' });
  pairs.push({ s: 'xs', name: 'X-Small' });
  pairs.sort((a, b) => b.s.length - a.s.length);
  return pairs;
})();

/**
 * @param {string} s
 */
function stripNoise(s) {
  return String(s || '')
    .replace(NOISE_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} s
 */
function compact(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_/、，,.:：;；|]+/g, '');
}

/**
 * 从左到右贪心最长匹配，提取所有可识别尺码片段（用于多尺码取最大）
 * @param {string} tc compact 后的小写无分隔串
 * @returns {string[]} 美码全称列表
 */
function greedyExtractCanonicalNames(tc) {
  const out = [];
  if (!tc) return out;
  let i = 0;
  while (i < tc.length) {
    let best = null;
    for (const p of SIZE_SCAN_PATTERNS) {
      if (tc.startsWith(p.s, i) && (!best || p.s.length > best.s.length)) best = p;
    }
    if (best) {
      out.push(best.name);
      i += best.s.length;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * @param {string[]} names
 * @returns {string | null}
 */
function pickMaxCanonical(names) {
  let bestIdx = -1;
  let best = null;
  for (const n of names) {
    const idx = US_SIZE_ORDER.indexOf(n);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = n;
    }
  }
  return best;
}

/**
 * 从一行文案中解析出「最大」美码全称（未降档）；无法识别则返回 null
 * @param {string} raw
 * @returns {string | null}
 */
export function parseToBestCanonicalUsSize(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return null;

  const stripped = stripNoise(original);
  if (!stripped) return null;

  /** 行首独立尺码 token + 体重等后缀：只取首 token */
  const prefix = /^([a-z0-9]+)\b(\s+[\s\S]+)$/i.exec(stripped);
  if (prefix) {
    const rest = String(prefix[2] ?? '');
    if (/\d/.test(rest) && /\b(kg|lb|公斤|千克|磅|cm|m)\b/i.test(rest)) {
      const tc0 = compact(String(prefix[1] ?? ''));
      if (tc0) {
        const fromOne = greedyExtractCanonicalNames(tc0);
        const pick0 = pickMaxCanonical(fromOne);
        if (pick0) return pick0;
      }
    }
  }

  const parts = stripped.split(/[/,，|]+/).map((x) => x.trim()).filter(Boolean);
  const canon = [];
  for (const p of parts) {
    const tc = compact(p);
    if (!tc) continue;
    const g = greedyExtractCanonicalNames(tc);
    const mx = pickMaxCanonical(g);
    if (mx) canon.push(mx);
  }
  if (canon.length === 0) {
    const tc = compact(stripped);
    if (!tc) return null;
    const g = greedyExtractCanonicalNames(tc);
    return pickMaxCanonical(g);
  }
  return pickMaxCanonical(canon);
}

/**
 * 原始 token / 行 → 美码全称（未降档）；兼容旧 normalizeUsSizeToken 语义
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUsSizeToken(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return original;
  const hit = parseToBestCanonicalUsSize(original);
  return hit ?? original;
}

/**
 * 美码全称降两档（向更小一档方向移动两次）
 * @param {string} fullName
 * @returns {string}
 */
export function downgradeUsSizeTwoSteps(fullName) {
  const idx = US_SIZE_ORDER.indexOf(fullName);
  if (idx === -1) return fullName;
  return US_SIZE_ORDER[Math.max(0, idx - 2)];
}

/**
 * 全称 → 简码；未知全称则原样返回
 * @param {string} fullName
 * @returns {string}
 */
export function usSizeFullToShort(fullName) {
  return US_SIZE_FULL_TO_SHORT[fullName] ?? fullName;
}

/**
 * 单个 token / 行：解析最大美码 → 降两档 → 全称 + 简码
 * @param {string} raw
 * @returns {{ full: string; short: string }}
 */
export function processUsSizeToken(raw) {
  const best = parseToBestCanonicalUsSize(String(raw).trim());
  if (!best) {
    const t = String(raw ?? '').trim();
    return { full: t, short: t };
  }
  const full = downgradeUsSizeTwoSteps(best);
  const short = usSizeFullToShort(full);
  return { full, short };
}

/**
 * @param {string} line
 * @returns {{ full: string; short: string }}
 */
function processLineWithSeparators(line) {
  const trimmed = line.trim();
  if (!trimmed) return { full: '', short: '' };

  const best = parseToBestCanonicalUsSize(trimmed);
  if (!best) return { full: trimmed, short: trimmed };

  const full = downgradeUsSizeTwoSteps(best);
  const short = usSizeFullToShort(full);
  return { full, short };
}

/**
 * 插件可能把多行尺码表采成 string[]，需与换行字符串一样参与标准化。
 * @param {unknown} v
 * @returns {string | null}
 */
function coerceSizeFieldToMultilineString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join('\n');
  }
  return null;
}

/**
 * 整段字段：多行、逗号等，产出全称串 + 简码串
 * @param {string} value
 * @returns {{ full: string; short: string }}
 */
export function processSizeFieldString(value) {
  if (typeof value !== 'string') return { full: String(value), short: String(value) };
  const s = value;
  if (!s.trim()) return { full: s, short: s };

  if (s.includes('\n')) {
    const fullLines = [];
    const shortLines = [];
    for (const line of s.split(/\r?\n/)) {
      if (!line.trim()) {
        fullLines.push(line);
        shortLines.push(line);
        continue;
      }
      const { full, short } = processLineWithSeparators(line);
      fullLines.push(full);
      shortLines.push(short);
    }
    return { full: fullLines.join('\n'), short: shortLines.join('\n') };
  }
  return processLineWithSeparators(s);
}

function isSizeLikeKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return false;
  /** 派生列：由主尺码字段写入；若再当「尺码」解析会把 XS 当成 X-Small 再降档 */
  if (k.endsWith('简码')) return false;
  if (k === '标准尺码' || k === '简码') return false;
  if (k === '尺码' || k === '尺寸') return true;
  if (/^size$/i.test(k)) return true;
  if (k.includes('尺码') || k.includes('尺寸')) return true;
  if (/\bsize\b/i.test(k)) return true;
  return false;
}

/**
 * 是否存在「尺码类」字段仍为 string[]（插件多行表）；用于仅在此时做服务端二次加工，避免对已标准化字符串重复降档。
 * @param {Record<string, unknown>} data
 */
export function collectionDataHasSizeFieldArrays(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Array.isArray(data.rows)) return false;
  for (const r of data.rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const [k, v] of Object.entries(r)) {
      if (!isSizeLikeKey(k)) continue;
      if (Array.isArray(v)) return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function normalizeRowSizeFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const [key, v] of Object.entries(out)) {
    if (!isSizeLikeKey(key)) continue;
    const asStr = coerceSizeFieldToMultilineString(v);
    if (asStr == null) continue;
    const { full } = processSizeFieldString(asStr);
    out[key] = full;
    if (key !== '尺码' && key !== '尺寸') {
      if (out['尺码'] == null || String(out['尺码']).trim() === '') {
        out['尺码'] = full;
      }
    }
  }
  return out;
}

/**
 * @param {unknown[]} rows
 */
export function normalizeCollectionRowsSizes(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) =>
    r && typeof r === 'object' && !Array.isArray(r) ? normalizeRowSizeFields(r) : r
  );
}

/**
 * @param {Record<string, unknown>} axes
 */
export function normalizeSkuAxesPayload(axes) {
  if (!axes || typeof axes !== 'object' || Array.isArray(axes)) return axes;
  const out = { ...axes };
  if (Array.isArray(out.sizes)) {
    const fulls = [];
    for (const x of out.sizes) {
      if (typeof x !== 'string') {
        fulls.push(x);
        continue;
      }
      const { full } = processUsSizeToken(String(x).trim());
      fulls.push(full);
    }
    out.sizes = fulls;
    if ('sizes_short' in out) delete out.sizes_short;
  }
  return out;
}

/**
 * 完整 data 对象：rows + sku_axes（就地修改并返回同一引用，便于上层 clone 后调用）
 * @param {Record<string, unknown>} data
 */
export function normalizeCollectionDataSizes(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (Array.isArray(data.rows)) {
    data.rows = normalizeCollectionRowsSizes(data.rows);
  }
  if (data.sku_axes && typeof data.sku_axes === 'object' && !Array.isArray(data.sku_axes)) {
    data.sku_axes = normalizeSkuAxesPayload(data.sku_axes);
  }
  return data;
}
