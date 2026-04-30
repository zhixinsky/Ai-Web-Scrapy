import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AccountCredits } from '../api';

type Props = {
  open: boolean;
  /** blob: 或同源 URL，与缩略图一致 */
  imageUrl: string;
  originalFilename: string;
  title: string;
  /** 最近一次成功应用结果所使用的通道（由外层注入） */
  lastProviderLabel?: string;
  /** 可选：AI 消除通道选择（不传则不显示下拉框） */
  provider?: 'tencent' | 'volc' | 'dashscope' | 'stability';
  onProviderChange?: (provider: 'tencent' | 'volc' | 'dashscope' | 'stability') => void;
  onClose: () => void;
  /** 上传与服务端原图同尺寸的 PNG 掩码（黑=保留，白=擦除） */
  onConfirm: (maskPng: File, provider?: 'tencent' | 'volc' | 'dashscope' | 'stability') => Promise<void>;
  canUndo?: boolean;
  onUndo?: () => Promise<void>;
};

function maskHasEraseRegion(imageData: ImageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (r > 8 || g > 8 || b > 8) return true;
  }
  return false;
}

/**
 * AI 消除：在预览上涂抹要擦除的区域（水印、文字等），导出与像素尺寸一致的 PNG 掩码供 DashScope image-erase-completion 使用。
 */
export function ImageAiEraseModal({
  open,
  imageUrl,
  originalFilename,
  title,
  lastProviderLabel,
  provider,
  onProviderChange,
  onClose,
  onConfirm,
  canUndo,
  onUndo,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [brush, setBrush] = useState(28);
  const [zoom, setZoom] = useState(1);
  const [spaceDown, setSpaceDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [err, setErr] = useState('');
  const [credits, setCredits] = useState<AccountCredits | null>(null);
  /** 本次会话内已成功应用至少一次，用于提示可继续涂抹（数秒后自动隐藏） */
  const [appliedOnce, setAppliedOnce] = useState(false);
  const appliedTipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef(false);
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const clearAppliedTipTimer = useCallback(() => {
    if (appliedTipHideTimerRef.current != null) {
      clearTimeout(appliedTipHideTimerRef.current);
      appliedTipHideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearAppliedTipTimer();
  }, [clearAppliedTipTimer]);

  useEffect(() => {
    if (!open) {
      clearAppliedTipTimer();
      setAppliedOnce(false);
      setCredits(null);
      setZoom(1);
      setSpaceDown(false);
    }
  }, [open, clearAppliedTipTimer]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      // PS 风格快捷键： [ / ] 调整笔刷大小（部分键盘布局会显示为「 / 」）
      if (e.code === 'BracketLeft' || e.key === '[' || e.key === '「') {
        e.preventDefault();
        setBrush((b) => Math.max(8, Math.min(120, b - (e.shiftKey ? 10 : 4))));
        return;
      }
      if (e.code === 'BracketRight' || e.key === ']' || e.key === '」') {
        e.preventDefault();
        setBrush((b) => Math.max(8, Math.min(120, b + (e.shiftKey ? 10 : 4))));
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      setSpaceDown(false);
    };
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown as any);
      window.removeEventListener('keyup', onKeyUp as any);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setErr('');
    setNaturalSize(null);
    api
      .accountOverview()
      .then((r) => {
        const c = r?.credits;
        if (!c) {
          setCredits(null);
          return;
        }
        setCredits({
          nobgCredits: Number(c.nobgCredits ?? 0),
          aiEraseCredits: Number(c.aiEraseCredits ?? 0),
          imageGenCredits: Number(c.imageGenCredits ?? 0),
        });
      })
      .catch(() => setCredits(null));
  }, [open, imageUrl]);

  const initCanvases = useCallback(
    (w: number, h: number) => {
      const mask = maskCanvasRef.current;
      const view = viewCanvasRef.current;
      if (!mask || !view) return;
      mask.width = w;
      mask.height = h;
      view.width = w;
      view.height = h;
      const mctx = mask.getContext('2d');
      const vctx = view.getContext('2d');
      if (!mctx || !vctx) return;
      mctx.fillStyle = '#000000';
      mctx.fillRect(0, 0, w, h);
      vctx.clearRect(0, 0, w, h);
    },
    []
  );

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setErr('');
    setNaturalSize({ w, h });
    requestAnimationFrame(() => initCanvases(w, h));
  }, [initCanvases]);

  useEffect(() => {
    if (!open || !imageUrl) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) onImgLoad();
  }, [open, imageUrl, onImgLoad]);

  const paintStroke = useCallback(
    (x: number, y: number, move: boolean) => {
      const mask = maskCanvasRef.current;
      const view = viewCanvasRef.current;
      if (!mask || !view || !naturalSize) return;
      const mctx = mask.getContext('2d');
      const vctx = view.getContext('2d');
      if (!mctx || !vctx) return;
      mctx.lineCap = 'round';
      mctx.lineJoin = 'round';
      mctx.strokeStyle = '#ffffff';
      mctx.lineWidth = brush;
      vctx.lineCap = 'round';
      vctx.lineJoin = 'round';
      vctx.strokeStyle = 'rgba(255, 60, 60, 0.55)';
      vctx.lineWidth = brush;

      if (move && last.current) {
        mctx.beginPath();
        mctx.moveTo(last.current.x, last.current.y);
        mctx.lineTo(x, y);
        mctx.stroke();
        vctx.beginPath();
        vctx.moveTo(last.current.x, last.current.y);
        vctx.lineTo(x, y);
        vctx.stroke();
      } else {
        mctx.beginPath();
        mctx.arc(x, y, brush / 2, 0, Math.PI * 2);
        mctx.fill();
        vctx.beginPath();
        vctx.arc(x, y, brush / 2, 0, Math.PI * 2);
        vctx.fillStyle = 'rgba(255, 60, 60, 0.55)';
        vctx.fill();
      }
      last.current = { x, y };
    },
    [brush, naturalSize]
  );

  const eventToLocal = useCallback((ev: React.PointerEvent) => {
    const mask = maskCanvasRef.current;
    if (!mask || !naturalSize) return null;
    const rect = mask.getBoundingClientRect();
    const sx = mask.width / rect.width;
    const sy = mask.height / rect.height;
    const x = (ev.clientX - rect.left) * sx;
    const y = (ev.clientY - rect.top) * sy;
    if (x < 0 || y < 0 || x > mask.width || y > mask.height) return null;
    return { x, y };
  }, [naturalSize]);

  const onPointerDown = (ev: React.PointerEvent) => {
    if (!naturalSize || busy) return;
    if (spaceDown) {
      const wrap = wrapRef.current;
      if (!wrap) return;
      ev.preventDefault();
      ev.currentTarget.setPointerCapture(ev.pointerId);
      panning.current = true;
      panStart.current = { x: ev.clientX, y: ev.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
      drawing.current = false;
      last.current = null;
      return;
    }
    // 只允许左键涂抹；右键用于“复位缩放”等快捷操作
    if (ev.button !== 0) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const p = eventToLocal(ev);
    if (!p) return;
    drawing.current = true;
    last.current = null;
    paintStroke(p.x, p.y, false);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (!naturalSize || busy) return;
    if (panning.current && panStart.current) {
      const wrap = wrapRef.current;
      if (!wrap) return;
      ev.preventDefault();
      const dx = ev.clientX - panStart.current.x;
      const dy = ev.clientY - panStart.current.y;
      wrap.scrollLeft = panStart.current.left - dx;
      wrap.scrollTop = panStart.current.top - dy;
      return;
    }
    // 非左键不画（避免右键拖动时误画）
    if ((ev.buttons & 1) !== 1) return;
    if (!drawing.current) return;
    const p = eventToLocal(ev);
    if (!p) return;
    paintStroke(p.x, p.y, true);
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    drawing.current = false;
    last.current = null;
    panning.current = false;
    panStart.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };

  const clearMask = () => {
    if (!naturalSize) return;
    initCanvases(naturalSize.w, naturalSize.h);
  };

  const clampZoom = useCallback((v: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(4, Math.round(n * 100) / 100));
  }, []);

  const bumpZoom = useCallback(
    (delta: number) => {
      setZoom((z) => clampZoom(z + delta));
    },
    [clampZoom]
  );

  const onImageWheel = useCallback(
    (ev: React.WheelEvent) => {
      // 在图片区域使用滚轮缩放；避免把滚动事件冒泡到外层滚动容器
      ev.preventDefault();
      ev.stopPropagation();
      const dir = ev.deltaY < 0 ? 1 : -1;
      const step = ev.shiftKey ? 0.25 : 0.1;
      bumpZoom(dir * step);
    },
    [bumpZoom]
  );

  async function handleConfirm() {
    const mask = maskCanvasRef.current;
    if (!mask || !naturalSize) {
      setErr('画布未就绪');
      return;
    }
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    const data = mctx.getImageData(0, 0, mask.width, mask.height);
    if (!maskHasEraseRegion(data)) {
      setErr('请先用笔刷涂抹要消除的区域（水印、文字等）');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        mask.toBlob(
          (b) => {
            if (!b) reject(new Error('导出掩码失败'));
            else resolve(b);
          },
          'image/png',
          1
        );
      });
      const base = String(originalFilename || 'mask').replace(/\.[^.]+$/, '') || 'mask';
      const file = new File([blob], `${base}-mask.png`, { type: 'image/png' });
      await onConfirm(file, provider);
      api
        .accountOverview()
        .then((r) => {
          const c = r?.credits;
          if (!c) return;
          setCredits({
            nobgCredits: Number(c.nobgCredits ?? 0),
            aiEraseCredits: Number(c.aiEraseCredits ?? 0),
            imageGenCredits: Number(c.imageGenCredits ?? 0),
          });
        })
        .catch(() => {});
      clearAppliedTipTimer();
      setAppliedOnce(true);
      appliedTipHideTimerRef.current = window.setTimeout(() => {
        appliedTipHideTimerRef.current = null;
        setAppliedOnce(false);
      }, 4000);
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
      clearMask();
      clearAppliedTipTimer();
      setAppliedOnce(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setUndoBusy(false);
    }
  }

  if (!open) return null;

  const fmt = (n: number | null | undefined) =>
    n == null || !Number.isFinite(Number(n)) ? '—' : Number(n) >= 999999 ? '不限' : `${n} 次`;

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[230] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="app-modal-panel flex h-[min(94vh,880px)] max-h-[min(94vh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-[1.75rem]"
        role="dialog"
        aria-modal
        aria-labelledby="image-ai-erase-title"
      >
        <div className="shrink-0 border-b border-slate-100 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="image-ai-erase-title" className="text-sm font-semibold text-slate-800">
              {title}
            </h2>
            {provider && onProviderChange ? (
              <label className="flex items-center gap-2 rounded-full bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700">
                <span className="text-slate-500">通道</span>
                <select
                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-teal-300"
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value as any)}
                  disabled={busy || undoBusy}
                  title="选择 AI 消除通道；切换图片仍会沿用本次选择"
                >
                  <option value="tencent">腾讯云</option>
                  <option value="volc">火山引擎</option>
                  <option value="dashscope">阿里百炼</option>
                  <option value="stability">Stability</option>
                </select>
              </label>
            ) : null}
            <div className="flex max-w-full flex-col items-end gap-0.5 text-right text-[11px] font-medium text-amber-950">
              <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5">
                AI 消除 剩余 {fmt(credits?.aiEraseCredits)}
              </span>
              <span className="inline-flex rounded-full bg-amber-100/80 px-2 py-0.5 text-amber-900/90">
                去背景 剩余 {fmt(credits?.nobgCredits)}
              </span>
              <span className="inline-flex rounded-full bg-amber-100/80 px-2 py-0.5 text-amber-900/90">
                图片生成 剩余 {fmt(credits?.imageGenCredits)}
              </span>
            </div>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            在图上涂抹要消除的区域（半透明红色），提交后替换当前槽位并保持弹窗打开；如效果不好，可撤销回打开弹窗前的图片。
          </p>
        </div>

        <div
          ref={wrapRef}
          className="app-dark-stage min-h-0 flex-1 overflow-auto p-3 [scrollbar-gutter:stable]"
        >
          <div
            className="relative mx-auto inline-block min-w-0"
            style={{
              width: `${zoom * 100}%`,
              maxWidth: 'none',
            }}
            onWheel={onImageWheel}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setZoom(1);
              // 让用户快速回到“默认视图”
              requestAnimationFrame(() => {
                const w = wrapRef.current;
                if (w) {
                  w.scrollLeft = 0;
                  w.scrollTop = 0;
                }
              });
            }}
            title="在图片上滚动可缩放（按住 Shift 更快）"
          >
            <img
              key={imageUrl}
              ref={imgRef}
              src={imageUrl}
              alt=""
              onLoad={onImgLoad}
              className="block h-auto max-h-none w-full select-none"
              draggable={false}
            />
            {naturalSize ? (
              <>
                <canvas
                  ref={maskCanvasRef}
                  className="pointer-events-none absolute left-0 top-0 h-full w-full opacity-0"
                  aria-hidden
                />
                <canvas
                  ref={viewCanvasRef}
                  className={
                    spaceDown
                      ? 'absolute left-0 top-0 h-full w-full cursor-grab touch-none'
                      : 'absolute left-0 top-0 h-full w-full cursor-crosshair touch-none'
                  }
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={onPointerUp}
                />
              </>
            ) : null}
          </div>
          {!naturalSize && !err ? (
            <p className="mt-2 text-center text-xs text-slate-400">加载图片中…</p>
          ) : null}
          {!naturalSize && err ? <p className="mt-2 text-center text-xs text-red-400">{err}</p> : null}
        </div>

        <div className="shrink-0 space-y-2 border-t border-white/70 bg-white/35 px-3 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <span>笔刷</span>
              <input
                type="range"
                min={8}
                max={120}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                className="w-36"
              />
              <span className="tabular-nums text-slate-500">{brush}px</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <span>缩放</span>
              <button
                type="button"
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => bumpZoom(-0.25)}
                title="缩小"
              >
                -
              </button>
              <input
                type="range"
                min={1}
                max={4}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(clampZoom(Number(e.target.value)))}
                className="w-36"
              />
              <button
                type="button"
                className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => bumpZoom(0.25)}
                title="放大"
              >
                +
              </button>
              <button
                type="button"
                className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setZoom(1)}
                title="重置为 100%"
              >
                1×
              </button>
              <span className="tabular-nums text-slate-500">{Math.round(zoom * 100)}%</span>
            </label>
            <button type="button" className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={clearMask}>
              清除涂抹
            </button>
          </div>
        </div>

        <div className="shrink-0 border-t border-white/70 bg-white/35 px-4 py-3">
          {err && naturalSize ? <p className="mb-2 text-xs text-red-600">{err}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 pr-2">
              {appliedOnce ? (
                <p className="text-xs leading-snug text-emerald-600">
                  已应用本次结果，预览已更新。可继续涂抹后再次提交。
                  {lastProviderLabel ? (
                    <span className="ml-2 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                      本次通道：{lastProviderLabel}
                    </span>
                  ) : null}
                </p>
              ) : null}
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
                {busy ? '处理中…' : '提交 AI 消除'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
