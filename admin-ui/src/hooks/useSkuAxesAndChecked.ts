import { useCallback } from 'react';

import { sharedRowIndex, variantIndices } from '../utils/collectionDetailEditor/rows';

export function useSkuAxesAndChecked({
  setRows,
  setSkuAxes,
  setSizeExportChecked,
  setColorExportChecked,
}: {
  setRows: React.Dispatch<React.SetStateAction<Record<string, unknown>[]>>;
  setSkuAxes: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>;
  setSizeExportChecked: React.Dispatch<React.SetStateAction<boolean[]>>;
  setColorExportChecked: React.Dispatch<React.SetStateAction<boolean[]>>;
}) {
  const commitSizeLines = useCallback(
    (text: string) => {
      const linesFiltered = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((x) => x !== '');
      setRows((prev) => {
        const sIdx = sharedRowIndex(prev);
        const vIdxs = variantIndices(prev, sIdx);
        const next = [...prev];
        const lines = text.split(/\r?\n/).map((l) => l.trim());
        if (vIdxs.length === 1) {
          next[sIdx] = { ...next[sIdx], 尺码: lines.join('\n') };
          return next;
        }
        // 多 SKU：只记在汇总行，避免按笛卡尔行逐行写回
        next[sIdx] = { ...next[sIdx], 尺码: lines.join('\n') };
        return next;
      });
      setSkuAxes((prev) => {
        if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return prev;
        return { ...prev, sizes: linesFiltered };
      });
      const n = linesFiltered.length;
      setSizeExportChecked((prev) => {
        if (n === 0) return [];
        if (prev.length === n) return prev;
        if (prev.length > n) return prev.slice(0, n);
        return [...prev, ...Array(n - prev.length).fill(true)];
      });
    },
    [setRows, setSkuAxes, setSizeExportChecked]
  );

  const commitColorLines = useCallback(
    (text: string) => {
      const linesFiltered = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((x) => x !== '');
      setRows((prev) => {
        const sIdx = sharedRowIndex(prev);
        const vIdxs = variantIndices(prev, sIdx);
        const next = [...prev];
        const lines = text.split(/\r?\n/).map((l) => l.trim());
        if (vIdxs.length === 1) {
          next[sIdx] = { ...next[sIdx], 颜色: lines.join('\n') };
          return next;
        }
        next[sIdx] = { ...next[sIdx], 颜色: lines.join('\n') };
        return next;
      });
      setSkuAxes((prev) => {
        if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return prev;
        return { ...prev, colors: linesFiltered };
      });
      const n = linesFiltered.length;
      setColorExportChecked((prev) => {
        if (n === 0) return [];
        if (prev.length === n) return prev;
        if (prev.length > n) return prev.slice(0, n);
        return [...prev, ...Array(n - prev.length).fill(true)];
      });
    },
    [setRows, setSkuAxes, setColorExportChecked]
  );

  return { commitSizeLines, commitColorLines };
}

