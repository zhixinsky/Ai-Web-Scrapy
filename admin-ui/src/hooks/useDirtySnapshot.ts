import { useCallback, useEffect, useRef } from 'react';

/**
 * 通用“脏检查”：
 * - 当 key 改变时重置基准
 * - ready=true 且基准为空时，自动记录一次基准快照
 */
export function useDirtySnapshot({
  key,
  ready,
  getSnapshot,
}: {
  key: string | number;
  ready: boolean;
  getSnapshot: () => string;
}) {
  const baselineRef = useRef<{ key: string; snapshot: string } | null>(null);

  useEffect(() => {
    baselineRef.current = null;
  }, [key]);

  useEffect(() => {
    if (!ready) return;
    const k = String(key);
    const cur = baselineRef.current;
    if (cur && cur.key === k) return;
    try {
      baselineRef.current = { key: k, snapshot: getSnapshot() };
    } catch {
      // ignore
    }
  }, [key, ready, getSnapshot]);

  const isDirty = useCallback(() => {
    const k = String(key);
    const base = baselineRef.current;
    if (!base || base.key !== k) return false;
    try {
      return base.snapshot !== getSnapshot();
    } catch {
      return true;
    }
  }, [getSnapshot, key]);

  const markClean = useCallback(() => {
    const k = String(key);
    try {
      baselineRef.current = { key: k, snapshot: getSnapshot() };
    } catch {
      baselineRef.current = { key: k, snapshot: '' };
    }
  }, [getSnapshot, key]);

  return { isDirty, markClean };
}

