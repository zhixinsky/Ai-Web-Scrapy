/**
 * 主图 / 副图 图片 URL 标准化（不调用 AI）：从首个 http(s) 起截取，在第一个有效图片后缀处截断，去掉 _.webp、_b.jpg 等尾缀。
 */

const IMG_EXTS = ['.jpeg', '.jpg', '.png', '.webp'];

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeOneImageUrl(raw) {
  const s = String(raw ?? '');
  const m = /https?:\/\//i.exec(s);
  if (!m) return s.trim();

  let url = s.slice(m.index);
  const sp = url.search(/\s/);
  if (sp !== -1) url = url.slice(0, sp);

  const lower = url.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const ext of IMG_EXTS) {
    const i = lower.indexOf(ext);
    if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestLen = ext.length;
    }
  }
  if (bestIdx === -1) {
    let cut = url.length;
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    if (q !== -1) cut = Math.min(cut, q);
    if (h !== -1) cut = Math.min(cut, h);
    return url.slice(0, cut);
  }
  return url.slice(0, bestIdx + bestLen);
}

function isMainImageFieldKey(k) {
  const key = String(k || '');
  if (!key.includes('主图')) return false;
  if (key.includes('副图')) return false;
  return true;
}

function isGalleryImageFieldKey(k) {
  const key = String(k || '');
  return key.startsWith('副图') || key.includes('副图');
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function normalizeRowImageUrls(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (!isMainImageFieldKey(k) && !isGalleryImageFieldKey(k)) continue;
    if (typeof v === 'string') {
      out[k] = normalizeOneImageUrl(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === 'string' ? normalizeOneImageUrl(x) : x));
    }
  }
  return out;
}

/**
 * 平台数据：主图 / 副图 URL 写入规范地址；sku_axes.mains 与颜色一一对应
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
export function normalizeCollectionImageUrls(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (Array.isArray(data.rows)) {
    data.rows = data.rows.map((r) =>
      r && typeof r === 'object' && !Array.isArray(r) ? normalizeRowImageUrls(r) : r
    );
  }
  const ax = data.sku_axes;
  if (ax && typeof ax === 'object' && !Array.isArray(ax) && Array.isArray(ax.mains)) {
    ax.mains = ax.mains.map((x) => (typeof x === 'string' ? normalizeOneImageUrl(x) : x));
  }
  return data;
}

/** @deprecated 使用 normalizeCollectionImageUrls */
export function normalizeCollectionMainImageUrls(data) {
  return normalizeCollectionImageUrls(data);
}
