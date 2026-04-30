import { extractImageUrlsFromRows } from '../images/downloader.js';

/** 与 admin-ui CollectionDetailEditor 一致：按颜色下标控制是否参与导出（默认全参与） */
export const COLOR_EXPORT_CHECKED_KEY = 'color_export_checked';

/** 与 admin-ui CollectionDetailEditor 一致：按尺码下标控制是否参与颜色×尺码笛卡尔展开（默认全参与） */
export const SIZE_EXPORT_CHECKED_KEY = 'size_export_checked';

/**
 * @param {object | null | undefined} parsed
 * @param {number} colorCount
 * @returns {boolean[]} 长度与颜色数一致；缺省或长度不符时视为全 true
 */
export function readColorExportIncluded(parsed, colorCount) {
  const n = Number(colorCount);
  if (!Number.isFinite(n) || n < 1) return [];
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[COLOR_EXPORT_CHECKED_KEY] : undefined;
  if (!Array.isArray(raw) || raw.length !== n) {
    return Array.from({ length: n }, () => true);
  }
  return raw.map((x) => x !== false && x !== 0 && x !== '0' && String(x).toLowerCase() !== 'false');
}

/**
 * @param {object | null | undefined} parsed
 * @param {number} sizeCount
 * @returns {boolean[]} 长度与尺码数一致；缺省或长度不符时视为全 true
 */
export function readSizeExportIncluded(parsed, sizeCount) {
  const n = Number(sizeCount);
  if (!Number.isFinite(n) || n < 1) return [];
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed[SIZE_EXPORT_CHECKED_KEY] : undefined;
  if (!Array.isArray(raw) || raw.length !== n) {
    return Array.from({ length: n }, () => true);
  }
  return raw.map((x) => x !== false && x !== 0 && x !== '0' && String(x).toLowerCase() !== 'false');
}

/** 与插件 CSV 一致：数组字段展开为 字段1、字段2；副图最多 16 列 */
export function expandSkuRow(obj) {
  const row = { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length) {
      const isGallery = k.includes('副图') || k.startsWith('副图');
      const max = isGallery ? Math.min(v.length, 16) : v.length;
      for (let i = 0; i < max; i++) {
        row[`${k}${i + 1}`] = v[i];
      }
      delete row[k];
    }
  }
  return row;
}

/** 解析 data_json：新格式 { rows: [] }；旧格式为单条 SKU 对象 */
export function skuRowsFromStoredData(parsed) {
  if (parsed && Array.isArray(parsed.rows)) {
    return parsed.rows.map((r) =>
      expandSkuRow(r && typeof r === 'object' && !Array.isArray(r) ? { ...r } : {})
    );
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('rows' in parsed)) {
    return [expandSkuRow({ ...parsed })];
  }
  return [];
}

export function rawRowsFromStoredData(parsed) {
  if (parsed && Array.isArray(parsed.rows)) {
    return parsed.rows;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('rows' in parsed)) {
    return [parsed];
  }
  return [];
}

/**
 * 按换行拆成轴列表（无换行且非空则单元素）。
 * @param {unknown} v
 * @returns {string[]}
 */
function splitAxisList(v) {
  const s = String(v ?? '').replace(/\r\n/g, '\n');
  if (!s.trim()) return [];
  const parts = s.split('\n').map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [];
}

/** 颜色/尺码轴：支持 string[] 与多行 string（插件常见两种形态） */
function axisTokens(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return splitAxisList(v);
}

/**
 * 从行上读取主图 URL 列表（数组按色序；单字符串视为仅一张）。
 * @param {Record<string, unknown>} row
 * @returns {string[]}
 */
function mainImageUrlListFromRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
  const v = row['主图'];
  if (Array.isArray(v)) {
    return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  const s = String(v ?? '').trim();
  return s ? [s] : [];
}

/**
 * 导出用：只要 sku_axes.colors / sizes 非空即做笛卡尔展开；mains 强制对齐 colors.length。
 * 兼容 mains 条数等于尺码数、缺失、或与颜色数不一致等常见上报误差。
 * @param {object} parsed
 * @returns {{ colors: string[], sizes: string[], mains: string[] } | null}
 */
function coerceSkuAxesForExport(parsed) {
  const ax = parsed && parsed.sku_axes;
  if (!ax || typeof ax !== 'object' || Array.isArray(ax)) return null;
  if (!Array.isArray(ax.colors) || !Array.isArray(ax.sizes)) return null;
  const colors = ax.colors.map((c) => String(c ?? '').trim()).filter(Boolean);
  const sizes = ax.sizes.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!colors.length || !sizes.length) return null;

  const raw = rawRowsFromStoredData(parsed);
  const { main: mainFromRows } = extractImageUrlsFromRows(raw);

  let mains = Array.isArray(ax.mains) ? ax.mains.map((m) => String(m ?? '').trim()) : [];
  const nC = colors.length;
  const nS = sizes.length;

  if (mains.length === nC) {
    // 已与颜色数一致
  } else if (mains.length === nS && nS !== nC) {
    mains = colors.map((_, ci) =>
      String(
        mainFromRows[ci] ?? mainFromRows[0] ?? mains[Math.min(ci, Math.max(0, mains.length - 1))] ?? ''
      ).trim()
    );
  } else if (mains.length > nC) {
    mains = mains.slice(0, nC);
  } else {
    mains = colors.map((_, i) => {
      const u = String(ax.mains?.[i] ?? '').trim();
      if (u) return u;
      return String(mainFromRows[i] ?? mainFromRows[0] ?? '').trim();
    });
  }

  mains = mains.map((m, i) => m || String(mainFromRows[i] ?? mainFromRows[0] ?? '').trim());

  return { colors, sizes, mains };
}

/**
 * 父行上「颜色 / 尺码」是否应按多值做笛卡尔展开。
 * @param {Record<string, unknown>} base
 */
function shouldExpandMultilineColorSize(base) {
  const cv = base['颜色'] ?? base['Color'];
  const sv = base['尺码'] ?? base['尺寸'] ?? base['Size'];
  const colors = axisTokens(cv);
  const sizes = axisTokens(sv);
  const cMulti =
    (typeof cv === 'string' && cv.includes('\n')) || colors.length > 1;
  const sMulti =
    (typeof sv === 'string' && sv.includes('\n')) || sizes.length > 1;
  return cMulti || sMulti;
}

/**
 * 无 sku_axes 时：从「父行或首行」上颜色/尺码多值做颜色×尺码笛卡尔积（每组合一行）。
 * 兼容仅一条 rows[0]、无 `父子关系` 的扁平平台数据（如 AliExpress 单卡多色多码）。
 * @param {object} parsed
 * @returns {Record<string, unknown>[] | null} 不适用时返回 null
 */
function expandRowsFromMultilineColorSize(parsed) {
  const raw = rawRowsFromStoredData(parsed);
  if (!raw.length) return null;
  const baseRow = raw.find((r) => r && r['父子关系'] === 'parent') || raw[0];
  if (!baseRow || typeof baseRow !== 'object') return null;
  const base = { ...baseRow };
  if (!shouldExpandMultilineColorSize(base)) return null;

  const colorTokens = axisTokens(base['颜色'] ?? base['Color']);
  const sizeTokens = axisTokens(base['尺码'] ?? base['尺寸'] ?? base['Size']);
  const colors = colorTokens.length ? colorTokens : [''];
  const sizes = sizeTokens.length ? sizeTokens : [''];

  const children = raw.filter((r) => r && r['父子关系'] === 'child');
  delete base['父子关系'];
  /** 按颜色下标取主图：不能把主图数组直接进 expandSkuRow，否则会被拆成主图1/2…导致子行缺少「主图」字段、导出全回落到首张。 */
  const mainByColor = mainImageUrlListFromRow(baseRow);
  const baseForChild = { ...base };
  if (Array.isArray(baseForChild['主图'])) {
    delete baseForChild['主图'];
  }
    const out = [];
    const colorIncluded = readColorExportIncluded(parsed, colors.length);
    const sizeIncluded = readSizeExportIncluded(parsed, sizes.length);
    /** 与亚马逊扁表常见展示一致：先按颜色分块，块内再遍历尺码 */
    for (let ci = 0; ci < colors.length; ci++) {
      if (!colorIncluded[ci]) continue;
      const color = String(colors[ci] ?? '').trim();
      const mainForColor = String(mainByColor[ci] ?? mainByColor[0] ?? '').trim();
      for (let si = 0; si < sizes.length; si++) {
      if (!sizeIncluded[si]) continue;
      const size = String(sizes[si] ?? '').trim();
      const match = children.find(
        (c) =>
          String(c['颜色'] ?? '').trim() === color &&
          String(c['尺码'] ?? c['尺寸'] ?? '').trim() === size
      );
      if (match) {
        out.push(expandSkuRow({ ...match }));
      } else {
        out.push(
          expandSkuRow({
            ...baseForChild,
            颜色: color,
            尺码: size,
            ...(mainForColor ? { 主图: mainForColor } : {}),
          })
        );
      }
    }
  }
  return out.length ? out : null;
}

/**
 * 导出专用：**仅依据平台数据** `parsed`（含 `rows` 与可选 `sku_axes`）。
 * - 有 `sku_axes.colors` 与 `sizes`：颜色×尺码笛卡尔展开；`mains` 与颜色数不一致时按父行主图 URL 顺序补齐（常见误把 mains 写成与尺码条数一致）。
 * - 否则若首行或 parent 上「颜色/尺码」为多值（数组/换行）：颜色×尺码笛卡尔展开。
 * - 否则按 `rows` 展平。
 * @param {object} parsed 已解析的平台数据 JSON
 */
export function getExportRowsForDataJson(parsed) {
  const axes = coerceSkuAxesForExport(parsed);
  if (axes) {
    const { colors, sizes, mains } = axes;
    const raw = rawRowsFromStoredData(parsed);
    const baseRow = raw.find((r) => r && r['父子关系'] === 'parent') || raw[0];
    const children = raw.filter((r) => r && r['父子关系'] === 'child');
    const base =
      baseRow && typeof baseRow === 'object' && !Array.isArray(baseRow) ? { ...baseRow } : {};
    delete base['父子关系'];
    const out = [];
    const colorIncluded = readColorExportIncluded(parsed, colors.length);
    const sizeIncluded = readSizeExportIncluded(parsed, sizes.length);
    /** 先颜色后尺码：与 mains[颜色下标] 及亚马逊模板按色块排列一致 */
    for (let ci = 0; ci < colors.length; ci++) {
      if (!colorIncluded[ci]) continue;
      const color = String(colors[ci] ?? '').trim();
      const mainUrl = String(mains[ci] ?? '').trim();
      for (let si = 0; si < sizes.length; si++) {
        if (!sizeIncluded[si]) continue;
        const size = String(sizes[si] ?? '').trim();
        const match = children.find(
          (c) =>
            String(c['颜色'] ?? '').trim() === color &&
            String(c['尺码'] ?? c['尺寸'] ?? '').trim() === size
        );
        if (match) {
          out.push(expandSkuRow({ ...match }));
        } else {
          out.push(
            expandSkuRow({
              ...base,
              颜色: color,
              尺码: size,
              主图: mainUrl,
            })
          );
        }
      }
    }
    return out;
  }

  const fromLines = expandRowsFromMultilineColorSize(parsed);
  if (fromLines != null) return fromLines;

  return skuRowsFromStoredData(parsed);
}
