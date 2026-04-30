import { dataToRows, expandFieldToLines, fieldLinesDisplay, sharedRowIndex } from './rows';

/** 与 downloader 去重后的副图列表顺序一致；导出时将按勾选筛选副图列 */
export const GALLERY_EXPORT_CHECKED_KEY = 'gallery_export_checked';

/** 与 server/src/export/collectionExportRows.js 中 COLOR_EXPORT_CHECKED_KEY 一致 */
export const COLOR_EXPORT_CHECKED_KEY = 'color_export_checked';

/** 与 server/src/export/collectionExportRows.js 中 SIZE_EXPORT_CHECKED_KEY 一致 */
export const SIZE_EXPORT_CHECKED_KEY = 'size_export_checked';

export function normalizeColorExportChecked(
  data: Record<string, unknown> | undefined,
  colorCount: number
): boolean[] {
  if (colorCount <= 0) return [];
  const raw =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)[COLOR_EXPORT_CHECKED_KEY]
      : undefined;
  if (Array.isArray(raw) && raw.length === colorCount) {
    return raw.map(
      (x) => x !== false && x !== 0 && x !== '0' && String(x).toLowerCase() !== 'false'
    );
  }
  return Array.from({ length: colorCount }, () => true);
}

export function normalizeSizeExportChecked(
  data: Record<string, unknown> | undefined,
  sizeCount: number
): boolean[] {
  if (sizeCount <= 0) return [];
  const raw =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)[SIZE_EXPORT_CHECKED_KEY]
      : undefined;
  if (Array.isArray(raw) && raw.length === sizeCount) {
    return raw.map(
      (x) => x !== false && x !== 0 && x !== '0' && String(x).toLowerCase() !== 'false'
    );
  }
  return Array.from({ length: sizeCount }, () => true);
}

export function normalizeGalleryChecked(
  data: Record<string, unknown> | undefined,
  urlCount: number
): boolean[] {
  if (urlCount <= 0) return [];
  // 导出端从“父行（parent/shared row）”读取该字段；兼容旧数据：也允许从根对象读取。
  let raw: unknown = undefined;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    try {
      const rows = dataToRows(data);
      const sIdx = sharedRowIndex(rows);
      raw =
        rows[sIdx] && typeof rows[sIdx] === 'object'
          ? (rows[sIdx] as any)[GALLERY_EXPORT_CHECKED_KEY]
          : undefined;
    } catch {
      raw = undefined;
    }
    if (raw === undefined) raw = (data as Record<string, unknown>)[GALLERY_EXPORT_CHECKED_KEY];
  }
  if (Array.isArray(raw) && raw.length === urlCount) {
    return raw.map((x) => Boolean(x));
  }
  return Array.from({ length: urlCount }, () => true);
}

export function colorTokensFromDataPayload(data: Record<string, unknown>, fieldKeys: readonly string[]): string[] {
  const ax = (data as { sku_axes?: { colors?: unknown[] } }).sku_axes;
  if (
    ax &&
    typeof ax === 'object' &&
    !Array.isArray(ax) &&
    Array.isArray(ax.colors) &&
    ax.colors.length
  ) {
    return ax.colors.map((x) => String(x ?? '').trim()).filter((t) => t !== '');
  }
  const r = dataToRows(data);
  const text = fieldLinesDisplay(r, fieldKeys);
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((x) => x !== '');
}

export function sizeTokensFromDataPayload(data: Record<string, unknown>, fieldKeys: readonly string[]): string[] {
  const ax = (data as { sku_axes?: { sizes?: unknown[] } }).sku_axes;
  if (
    ax &&
    typeof ax === 'object' &&
    !Array.isArray(ax) &&
    Array.isArray(ax.sizes) &&
    ax.sizes.length
  ) {
    return ax.sizes.map((x) => String(x ?? '').trim()).filter((t) => t !== '');
  }
  const r = dataToRows(data);
  const text = fieldLinesDisplay(r, fieldKeys);
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((x) => x !== '');
}

export function readDetailImageUrlsFromSharedRow(sharedRow: Record<string, unknown>): string[] {
  return expandFieldToLines((sharedRow as any)['详情图']);
}

