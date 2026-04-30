import { useCallback, useEffect, useRef, useState } from 'react';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';

type Props = {
  open: boolean;
  /** blob: 或同源 URL */
  imageUrl: string;
  originalFilename: string;
  title: string;
  onClose: () => void;
  onConfirm: (file: File) => Promise<void>;
  canUndo?: boolean;
  onUndo?: () => Promise<void>;
};

function extFromFilename(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'jpg';
}

type AspectPreset = 'free' | '1' | '4/3' | '3/4' | '16/9';

function presetToRatio(p: AspectPreset): number {
  if (p === 'free') return Number.NaN;
  if (p === '1') return 1;
  if (p === '4/3') return 4 / 3;
  if (p === '3/4') return 3 / 4;
  return 16 / 9;
}

/**
 * 图片裁剪：直接挂载 Cropper.js 1.x（避免 react-cropper 在 React 18 下初始化时机导致画布空白）
 */
export function ImageCropModal({ open, imageUrl, originalFilename, title, onClose, onConfirm, canUndo, onUndo }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<InstanceType<typeof Cropper> | null>(null);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('free');
  const [busy, setBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [err, setErr] = useState('');
  const [appliedOnce, setAppliedOnce] = useState(false);

  const getCropper = useCallback(() => cropperRef.current, []);

  const applyAspectPreset = useCallback(
    (p: AspectPreset) => {
      setAspectPreset(p);
      const c = cropperRef.current;
      if (!c) return;
      const r = presetToRatio(p);
      if (Number.isNaN(r)) {
        c.setAspectRatio(NaN);
      } else {
        c.setAspectRatio(r);
      }
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    setAspectPreset('free');
    setErr('');
  }, [open, imageUrl]);

  useEffect(() => {
    if (open) setAppliedOnce(false);
  }, [open]);

  useEffect(() => {
    if (!open || !imageUrl) return;
    const img = imgRef.current;
    if (!img) return;

    let cancelled = false;

    const destroy = () => {
      try {
        cropperRef.current?.destroy();
      } catch {
        /* ignore */
      }
      cropperRef.current = null;
    };

    const init = () => {
      if (cancelled || !imgRef.current) return;
      destroy();
      const c = new Cropper(imgRef.current, {
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 0.88,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: true,
        background: true,
        modal: true,
        movable: true,
        rotatable: true,
        scalable: true,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        wheelZoomRatio: 0.12,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: true,
        checkOrientation: true,
        /** blob: URL 下避免误判跨域导致画布无法绘制 */
        checkCrossOrigin: false,
        minCropBoxWidth: 8,
        minCropBoxHeight: 8,
      });
      cropperRef.current = c;
    };

    if (img.complete && img.naturalWidth > 0) {
      init();
    } else {
      img.addEventListener('load', init, { once: true });
    }

    return () => {
      cancelled = true;
      img.removeEventListener('load', init);
      destroy();
    };
  }, [open, imageUrl]);

  async function handleConfirm() {
    const cropper = cropperRef.current;
    if (!cropper) {
      setErr('裁剪器未就绪，请稍候再试');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const canvas = cropper.getCroppedCanvas({
        maxWidth: 4096,
        maxHeight: 4096,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
      });
      if (!canvas) {
        setErr('无法生成裁剪区域（请调整选区）');
        return;
      }
      const ext = extFromFilename(originalFilename);
      const mime =
        ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const quality = mime === 'image/jpeg' ? 0.92 : undefined;
      const base = String(originalFilename || 'image').replace(/\.[^.]+$/, '') || 'cropped';
      const outExt = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';

      const file = await new Promise<File>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('导出失败'));
              return;
            }
            resolve(new File([blob], `${base}.${outExt}`, { type: blob.type || mime }));
          },
          mime,
          quality
        );
      });

      await onConfirm(file);
      setAppliedOnce(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '裁剪失败');
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
      setAppliedOnce(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setUndoBusy(false);
    }
  }

  const btnTool =
    'rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50';
  const btnAspect = (p: AspectPreset, label: string) => (
    <button
      key={p}
      type="button"
      className={`rounded border px-2 py-1 text-xs font-medium ${
        aspectPreset === p
          ? 'border-teal-600 bg-teal-50 text-teal-900'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
      onClick={() => applyAspectPreset(p)}
    >
      {label}
    </button>
  );

  if (!open) return null;

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[220] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="app-modal-panel flex max-h-[min(92vh,800px)] w-full max-w-2xl flex-col overflow-hidden rounded-[1.75rem]"
        role="dialog"
        aria-modal
        aria-labelledby="image-crop-modal-title"
      >
        <div className="shrink-0 border-b border-slate-100 px-4 py-3">
          <h2 id="image-crop-modal-title" className="text-sm font-semibold text-slate-800">
            {title}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            拖动图片、滚轮缩放；拖动裁剪框边角调整范围。双击可在「移动画布 / 裁剪」模式间切换。
          </p>
          <p className="mt-1 text-xs text-slate-500">
            确认后弹窗保持打开；如效果不好，可点击「撤销本次处理」退回打开弹窗前的图片。
          </p>
        </div>

        {/* 固定高度，避免父级高度为 0 导致 Cropper 画布空白 */}
        <div
          className="app-dark-stage relative w-full overflow-hidden"
          style={{ height: 'min(52vh, 440px)', minHeight: 240 }}
        >
          <img
            key={imageUrl}
            ref={imgRef}
            src={imageUrl}
            alt=""
            className="block max-h-none max-w-none"
          />
        </div>

        <div className="shrink-0 space-y-2 border-t border-white/70 bg-white/35 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">比例</span>
            {btnAspect('free', '自由')}
            {btnAspect('1', '1:1')}
            {btnAspect('4/3', '4:3')}
            {btnAspect('3/4', '3:4')}
            {btnAspect('16/9', '16:9')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btnTool}
              onClick={() => getCropper()?.rotate(90)}
              title="顺时针旋转 90°"
            >
              旋转 90°
            </button>
            <button
              type="button"
              className={btnTool}
              onClick={() => {
                const c = getCropper();
                if (!c) return;
                const d = c.getData();
                c.scaleX(d.scaleX === -1 ? 1 : -1);
              }}
              title="水平翻转"
            >
              水平翻转
            </button>
            <button
              type="button"
              className={btnTool}
              onClick={() => {
                const c = getCropper();
                if (!c) return;
                const d = c.getData();
                c.scaleY(d.scaleY === -1 ? 1 : -1);
              }}
              title="垂直翻转"
            >
              垂直翻转
            </button>
            <button
              type="button"
              className={btnTool}
              onClick={() => {
                getCropper()?.reset();
                setAspectPreset('free');
              }}
              title="重置视图与选区"
            >
              重置
            </button>
          </div>
        </div>

        <div className="shrink-0 border-t border-white/70 bg-white/35 px-4 py-3">
          {err ? <p className="mb-2 text-xs text-red-600">{err}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {appliedOnce ? (
                <p className="text-xs text-emerald-600">已应用裁剪结果，弹窗已保持打开。</p>
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
              disabled={busy || undoBusy}
              className="rounded-lg border border-teal-600 bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleConfirm()}
            >
              {busy ? '处理中…' : '确认裁剪并替换'}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
