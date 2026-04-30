import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Rect = { left: number; top: number; width: number; height: number };

type Props = {
  open: boolean;
  /** blob: 或同源 URL，与缩略图一致 */
  imageUrl: string;
  originalFilename: string;
  title: string;
  onClose: () => void;
  /** 以原图像素坐标提交矩形（可多个；当前 UI 默认 1 个） */
  onConfirm: (rectangle: Rect[]) => Promise<void>;
  canUndo?: boolean;
  onUndo?: () => Promise<void>;
};

function clampInt(v: number, min: number, max: number) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * 图像修复：框选规则矩形区域（用于去除瑕疵/遮罩等），提交给服务端调用百度 inpainting。
 */
export function ImageRepairModal({
  open,
  imageUrl,
  originalFilename,
  title,
  onClose,
  onConfirm,
  canUndo,
  onUndo,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [err, setErr] = useState('');
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);

  const [rect, setRect] = useState<Rect | null>(null);

  const rectList = useMemo(() => (rect ? [rect] : []), [rect]);

  const draw = useCallback(
    (r: Rect | null) => {
      const c = canvasRef.current;
      const ns = naturalSize;
      if (!c || !ns) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      if (!r) return;
      ctx.strokeStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.lineWidth = Math.max(2, Math.round(Math.max(ns.w, ns.h) / 800));
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width, r.height);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.18)';
      ctx.fillRect(r.left, r.top, r.width, r.height);
    },
    [naturalSize]
  );

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    setNaturalSize({ w, h });
  }, [draw, rect]);

  useEffect(() => {
    if (!open) return;
    if (!naturalSize) return;
    const c = canvasRef.current;
    if (!c) return;
    c.width = naturalSize.w;
    c.height = naturalSize.h;
    draw(rect);
  }, [open, naturalSize, draw, rect]);

  useEffect(() => {
    if (!open) {
      setErr('');
      setNaturalSize(null);
      setBusy(false);
      setUndoBusy(false);
      startRef.current = null;
      draggingRef.current = false;
      setRect(null);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !imageUrl) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) onImgLoad();
  }, [open, imageUrl, onImgLoad]);

  const eventToLocal = useCallback((ev: React.PointerEvent) => {
    const c = canvasRef.current;
    const ns = naturalSize;
    if (!c || !ns) return null;
    const b = c.getBoundingClientRect();
    const sx = c.width / b.width;
    const sy = c.height / b.height;
    const x = (ev.clientX - b.left) * sx;
    const y = (ev.clientY - b.top) * sy;
    if (x < 0 || y < 0 || x > c.width || y > c.height) return null;
    return { x, y };
  }, [naturalSize]);

  const onPointerDown = (ev: React.PointerEvent) => {
    if (!naturalSize || busy) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const p = eventToLocal(ev);
    if (!p) return;
    draggingRef.current = true;
    startRef.current = { x: p.x, y: p.y };
    setRect(null);
    draw(null);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (!naturalSize || busy) return;
    if (!draggingRef.current || !startRef.current) return;
    const p = eventToLocal(ev);
    if (!p) return;
    const x0 = startRef.current.x;
    const y0 = startRef.current.y;
    const left = Math.min(x0, p.x);
    const top = Math.min(y0, p.y);
    const width = Math.abs(p.x - x0);
    const height = Math.abs(p.y - y0);
    const r: Rect = {
      left: clampInt(left, 0, naturalSize.w),
      top: clampInt(top, 0, naturalSize.h),
      width: clampInt(width, 1, naturalSize.w),
      height: clampInt(height, 1, naturalSize.h),
    };
    setRect(r);
    draw(r);
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    draggingRef.current = false;
    startRef.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };

  async function handleConfirm() {
    if (!naturalSize) return;
    if (!rectList.length) {
      setErr('请在图片上拖拽框选要修复的矩形区域');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await onConfirm(rectList);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!onUndo) return;
    setUndoBusy(true);
    setErr('');
    try {
      await onUndo();
      setRect(null);
      draw(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setUndoBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="app-modal-backdrop fixed inset-0 z-[230] flex items-center justify-center p-4" role="presentation">
      <div
        className="app-modal-panel flex h-[min(94vh,880px)] max-h-[min(94vh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-[1.75rem]"
        role="dialog"
        aria-modal
        aria-labelledby="image-repair-title"
      >
        <div className="shrink-0 border-b border-slate-100 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="image-repair-title" className="text-sm font-semibold text-slate-800">
              {title}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            在图上拖拽框选要修复的矩形区域（可用于去除瑕疵/遮挡等）。提交后将替换当前槽位图片。
          </p>
        </div>

        <div className="app-dark-stage min-h-0 flex-1 overflow-auto p-3 [scrollbar-gutter:stable]">
          <div className="relative mx-auto inline-block max-w-full min-w-0">
            <img
              key={imageUrl}
              ref={imgRef}
              src={imageUrl}
              alt=""
              onLoad={onImgLoad}
              className="block h-auto max-h-none w-auto max-w-full select-none"
              draggable={false}
            />
            <canvas
              ref={canvasRef}
              className={
                naturalSize
                  ? 'absolute left-0 top-0 h-full w-full cursor-crosshair touch-none'
                  : 'pointer-events-none absolute left-0 top-0 h-full w-full opacity-0'
              }
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              aria-hidden={!naturalSize}
            />
          </div>
          {!naturalSize && !err ? <p className="mt-2 text-center text-xs text-slate-400">加载图片中…</p> : null}
          {!naturalSize && err ? <p className="mt-2 text-center text-xs text-red-400">{err}</p> : null}
        </div>

        <div className="shrink-0 border-t border-white/70 bg-white/35 px-4 py-3">
          {err && naturalSize ? <p className="mb-2 text-xs text-red-600">{err}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 pr-2">
              {rect ? (
                <p className="text-xs text-slate-600">
                  选区：left {rect.left}, top {rect.top}, width {rect.width}, height {rect.height}
                </p>
              ) : (
                <p className="text-xs text-slate-500">未选择区域</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy || undoBusy || !canUndo}
                className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleUndo()}
              >
                {undoBusy ? '撤销中…' : '撤销本次处理'}
              </button>
              <button
                type="button"
                disabled={busy || undoBusy}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || undoBusy || !naturalSize}
                className="rounded-lg border border-teal-600 bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleConfirm()}
              >
                {busy ? '处理中…' : '提交图像修复'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

