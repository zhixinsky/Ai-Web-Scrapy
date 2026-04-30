import { useCallback } from 'react';

import { serializeDataForSave } from '../utils/serializeCollectionDataForSave';
import {
  COLOR_EXPORT_CHECKED_KEY,
  GALLERY_EXPORT_CHECKED_KEY,
  SIZE_EXPORT_CHECKED_KEY,
  normalizeColorExportChecked,
  normalizeGalleryChecked,
  normalizeSizeExportChecked,
} from '../utils/collectionDetailEditor/exportChecked';
import { sharedRowIndex } from '../utils/collectionDetailEditor/rows';

export function useCollectionSavePayload({
  rows,
  originalData,
  galleryLen,
  galleryChecked,
  skuAxes,
  colorTokensLength,
  colorExportChecked,
  sizeTokensLength,
  sizeExportChecked,
}: {
  rows: Record<string, unknown>[];
  originalData: Record<string, unknown>;
  galleryLen: number;
  galleryChecked: boolean[];
  skuAxes: Record<string, unknown> | null;
  colorTokensLength: number;
  colorExportChecked: boolean[];
  sizeTokensLength: number;
  sizeExportChecked: boolean[];
}) {
  const buildSavePayload = useCallback(() => {
    const sIdx = sharedRowIndex(rows);
    const rowsForSave = [...rows];

    if (galleryLen > 0) {
      const toSave =
        galleryChecked.length === galleryLen
          ? galleryChecked
          : normalizeGalleryChecked(originalData, galleryLen);
      const base = (rowsForSave[sIdx] && typeof rowsForSave[sIdx] === 'object'
        ? (rowsForSave[sIdx] as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      rowsForSave[sIdx] = { ...base, [GALLERY_EXPORT_CHECKED_KEY]: toSave };
    } else if (rowsForSave[sIdx] && typeof rowsForSave[sIdx] === 'object') {
      const base = rowsForSave[sIdx] as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(base, GALLERY_EXPORT_CHECKED_KEY)) {
        const next = { ...base };
        delete next[GALLERY_EXPORT_CHECKED_KEY];
        rowsForSave[sIdx] = next;
      }
    }

    const payload = serializeDataForSave(rowsForSave, originalData) as Record<string, unknown>;
    if (skuAxes && typeof skuAxes === 'object' && !Array.isArray(skuAxes)) {
      payload.sku_axes = skuAxes;
    }
    // gallery_export_checked 已写入父行（shared row），导出端从父行读取；根对象不再写入，避免错位。
    delete payload[GALLERY_EXPORT_CHECKED_KEY];

    if (colorTokensLength > 0) {
      const toSaveColors =
        colorExportChecked.length === colorTokensLength
          ? colorExportChecked
          : normalizeColorExportChecked(originalData, colorTokensLength);
      payload[COLOR_EXPORT_CHECKED_KEY] = toSaveColors;
    } else {
      delete payload[COLOR_EXPORT_CHECKED_KEY];
    }

    if (sizeTokensLength > 0) {
      const toSaveSizes =
        sizeExportChecked.length === sizeTokensLength
          ? sizeExportChecked
          : normalizeSizeExportChecked(originalData, sizeTokensLength);
      payload[SIZE_EXPORT_CHECKED_KEY] = toSaveSizes;
    } else {
      delete payload[SIZE_EXPORT_CHECKED_KEY];
    }

    return payload;
  }, [
    rows,
    originalData,
    galleryLen,
    galleryChecked,
    skuAxes,
    colorTokensLength,
    colorExportChecked,
    sizeTokensLength,
    sizeExportChecked,
  ]);

  return { buildSavePayload };
}

