import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import {
  absoluteApiUrl,
  API_BASE,
  api,
  collectionEventsUrl,
  collectionImageApiPath,
  getToken,
  ossPublicUrlForCollectionImage,
  type AccountCredits,
  type CollectionUserMark,
  type UserInfo,
} from '../api';
import { AuthenticatedImageThumb } from '../components/AuthenticatedImageThumb';
import { CustomSelect } from '../components/CustomSelect';
import { ImageCropModal } from '../components/ImageCropModal';
import { ImageAiEraseModal } from '../components/ImageAiEraseModal';
import { ImageRepairModal } from '../components/ImageRepairModal';
import { formatCstDisplay } from '../utils/timeCst';
import { ossKeyForCollectionImage, putObjectWithSts } from '../utils/ossUpload';
import { pushToast, toastError, toastSuccess } from '../utils/toast';

const USER_MARK_OPTIONS: readonly { value: CollectionUserMark; label: string; dotClass: string }[] = [
  { value: 'export', label: '导出', dotClass: 'bg-emerald-500' },
  { value: 'pending', label: '待定', dotClass: 'bg-amber-500' },
  { value: 'discard', label: '丢弃', dotClass: 'bg-red-500' },
];

function markBorderClass(mark: string | null | undefined): string {
  const m = String(mark || '').trim().toLowerCase();
  if (m === 'export') return 'border-emerald-200 hover:border-emerald-300';
  if (m === 'pending') return 'border-amber-200 hover:border-amber-300';
  if (m === 'discard') return 'border-red-200 hover:border-red-300';
  return 'border-slate-200 hover:border-slate-300';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const DRAG_DETAIL_MIME = 'application/x-ai-web-scraper-detail-image+json';
const DRAG_SLOT_MIME = 'application/x-ai-web-scraper-slot-image+json';
const DRAG_SLOT_TEXT_PREFIX = 'slot-image:';

function safeFilename(s: string) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 管理端为 HTTPS、OSS 公网为 HTTP 时，若把 http:// 直链填进 img.src，浏览器常升级为 https 请求，
 * 而绑定域名未配证书时预览失败；F12 里会看到请求变成 https。此时应走同源带 Token 的 API 拉图（blob）。
 * 复制仍用 http 公网地址即可。
 */
function preferApiFetchOverHttpDirectThumb(publicUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  const u = String(publicUrl || '').trim();
  if (!u.startsWith('http://')) return false;
  return window.location.protocol === 'https:';
}

type ImagesInlineLightboxState = {
  collectionId: number;
  role: 'main' | 'gallery';
  slotIndex: number;
};

type DetailLightboxState = { urls: string[]; index: number } | null;

// 复用缓存：避免每次打开编辑大图都重新 fetch baseline 导致按钮闪烁
const imagesLightboxBaselineCache: Map<string, File> = new Map();

function DetailPreviewLightbox({
  state,
  onClose,
}: {
  state: DetailLightboxState;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const clampZoom = useCallback((v: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(4, Math.round(n * 100) / 100));
  }, []);

  useEffect(() => {
    if (state) {
      const n = state.urls.length;
      setIdx(n ? Math.min(Math.max(0, state.index), n - 1) : 0);
      setZoom(1);
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (state.urls.length <= 1) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(state.urls.length - 1, i + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  if (!state || !state.urls.length) return null;
  const src = state.urls[idx];
  if (!src) return null;

  const canNav = state.urls.length > 1;
  const canPrev = idx > 0;
  const canNext = idx < state.urls.length - 1;

  return (
    <div className="app-modal-backdrop fixed inset-0 z-[240] flex items-center justify-center p-6" role="dialog" aria-modal aria-label="详情图预览">
      <div className="absolute left-4 top-4 z-[250] flex flex-wrap items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 shadow-sm backdrop-blur">
        <span className="text-slate-500">缩放</span>
        <button
          type="button"
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          onClick={() => setZoom((z) => clampZoom(z - 0.25))}
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
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          onClick={() => setZoom((z) => clampZoom(z + 0.25))}
          title="放大"
        >
          +
        </button>
        <button
          type="button"
          className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          onClick={() => setZoom(1)}
          title="重置为 100%"
        >
          1×
        </button>
        <span className="tabular-nums text-slate-500">{Math.round(zoom * 100)}%</span>
      </div>

      <button
        type="button"
        className="absolute right-4 top-4 z-[250] rounded-lg border border-white/70 bg-white/65 px-3 py-1.5 text-sm text-slate-700 shadow-sm backdrop-blur hover:bg-white/80"
        onClick={() => onClose()}
      >
        关闭 (Esc)
      </button>

      {canNav ? (
        <button
          type="button"
          aria-label="上一张"
          disabled={!canPrev}
          className={`absolute left-3 top-1/2 z-[250] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:left-6 ${
            canPrev ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
          }`}
          onClick={() => {
            if (!canPrev) return;
            setIdx((i) => Math.max(0, i - 1));
          }}
        >
          ‹
        </button>
      ) : null}
      {canNav ? (
        <button
          type="button"
          aria-label="下一张"
          disabled={!canNext}
          className={`absolute right-3 top-1/2 z-[250] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:right-6 ${
            canNext ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
          }`}
          onClick={() => {
            if (!canNext) return;
            setIdx((i) => Math.min(state.urls.length - 1, i + 1));
          }}
        >
          ›
        </button>
      ) : null}

      <div className="max-h-[90vh] max-w-[min(100%,calc(100%-8rem))] overflow-auto rounded-lg bg-white/90 [scrollbar-gutter:stable]">
        <div
          className="relative mx-auto inline-block min-w-0"
          style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          onWheel={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const dir = e.deltaY < 0 ? 1 : -1;
            const step = e.shiftKey ? 0.25 : 0.1;
            setZoom((z) => clampZoom(z + dir * step));
          }}
          title="在图片上滚动可缩放（Shift 更快）"
        >
          <img src={src} alt="详情图预览" className="block h-auto w-full select-none" draggable={false} referrerPolicy="no-referrer" />
        </div>
      </div>

      {canNav ? (
        <div
          className="pointer-events-none absolute bottom-6 left-1/2 z-[250] -translate-x-1/2 rounded-full border border-white/70 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700 shadow-sm backdrop-blur"
          aria-hidden
        >
          {idx + 1} / {state.urls.length}
        </div>
      ) : null}
    </div>
  );
}

type ImageListItem = {
  role: 'main' | 'gallery';
  storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg' | 'detail';
  filename: string;
  index: number;
  publicUrl?: string;
};

type ImagesPageRow = {
  collectionId: number;
  imagesStatus?: string;
  images: ImageListItem[];
  userMark?: CollectionUserMark | null;
  aiPostStatus?: 'pending' | 'done' | 'skipped' | 'failed' | null;
};

type InlineMode = 'view' | 'crop' | 'erase' | 'repair';

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

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

function clampInt(v: number, min: number, max: number) {
  const n = Math.floor(Number(v) || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function formatCreditRemaining(n: number | null | undefined) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  if (Number(n) >= 999999) return '不限';
  return String(n);
}

function ImagesInlineLightbox({
  state,
  data,
  blobRegisterRef,
  thumbRev,
  setThumbRev,
  onClose,
  fetchCollectionImageBlob,
  replaceImageForStorageRole,
  load,
  credits,
  refreshCredits,
}: {
  state: ImagesInlineLightboxState;
  data: { rows: ImagesPageRow[] } | null;
  blobRegisterRef: React.MutableRefObject<Map<string, string[]>>;
  thumbRev: Record<string, number>;
  setThumbRev: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onClose: () => void;
  fetchCollectionImageBlob: (collectionId: number, role: any, filename: string, rev?: number) => Promise<Blob>;
  replaceImageForStorageRole: (
    collectionId: number,
    storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg',
    index: number,
    file: File,
    key: string
  ) => Promise<void>;
  load: () => Promise<void>;
  credits: AccountCredits | null;
  refreshCredits: () => void;
}) {
  const [mode, setMode] = useState<InlineMode>('view');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  // 图片生成：仅千问 qwen-image-edit，不需要掩码涂抹
  const AI_ERASE_PROVIDER_LS_KEY = 'images.aiErase.provider';
  const [aiEraseProvider, setAiEraseProvider] = useState<'tencent' | 'volc' | 'dashscope' | 'stability'>(() => {
    const v = String(localStorage.getItem(AI_ERASE_PROVIDER_LS_KEY) || '').trim().toLowerCase();
    if (v === 'tencent' || v === 'volc' || v === 'dashscope' || v === 'stability') return v as any;
    return 'dashscope';
  });

  useEffect(() => {
    try {
      localStorage.setItem(AI_ERASE_PROVIDER_LS_KEY, aiEraseProvider);
    } catch {
      /* ignore */
    }
  }, [aiEraseProvider]);

  // baseline file for undo (per-open-session)
  const [baselineFile, setBaselineFile] = useState<File | null>(null);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const baselineKeyRef = useRef<string>('');

  const [zoom, setZoom] = useState(1);
  const [brush, setBrush] = useState(28);
  const [spaceDown, setSpaceDown] = useState(false);

  const cropImgRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<InstanceType<typeof Cropper> | null>(null);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('free');

  const eraseWrapRef = useRef<HTMLDivElement>(null);
  const eraseImgRef = useRef<HTMLImageElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef(false);
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const repairImgRef = useRef<HTMLImageElement>(null);
  const repairCanvasRef = useRef<HTMLCanvasElement>(null);
  const [repairNaturalSize, setRepairNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const repairStartRef = useRef<{ x: number; y: number } | null>(null);
  const repairDraggingRef = useRef(false);
  const [repairRect, setRepairRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  );

  const row = useMemo(
    () => data?.rows.find((r) => r.collectionId === state.collectionId) ?? null,
    [data, state.collectionId]
  );
  const list = useMemo(() => (row?.images || []).filter((x) => x.role === state.role), [row, state.role]);
  const regKey = `${state.collectionId}-${state.role}`;
  const ordered = [...(blobRegisterRef.current.get(regKey) ?? [])];
  while (ordered.length < list.length) ordered.push('');
  const available = ordered.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
  const curPos = available.indexOf(state.slotIndex);
  const canNav = available.length > 1 && curPos >= 0;
  const canPrev = canNav && curPos > 0;
  const canNext = canNav && curPos < available.length - 1;
  const currentImg = list[state.slotIndex] || null;
  const src = ordered[state.slotIndex] || '';
  const slotKey = currentImg && row ? `${row.collectionId}-${currentImg.role}-${currentImg.index}` : '';
  const colorDimmed =
    state.role === 'main' &&
    Boolean(currentImg) &&
    Array.isArray(row?.colorExportChecked) &&
    row!.colorExportChecked?.[Number(currentImg!.index)] === false;

  // 编辑模式下强制使用同源 blob URL（避免 OSS 直链导致 canvas tainted，无法 toBlob）
  const [editObjectUrl, setEditObjectUrl] = useState<string>('');
  useEffect(() => {
    if (mode === 'view') {
      setEditObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
      return;
    }
    if (!row || !currentImg || !slotKey) return;
    let cancelled = false;
    (async () => {
      try {
        const rev = thumbRev[slotKey] ?? 0;
        const blob = await fetchCollectionImageBlob(row.collectionId, currentImg.storageRole, currentImg.filename, rev);
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        setEditObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return u;
        });
      } catch {
        // fallback: still allow viewing; editing may fail if src is cross-origin
        if (!cancelled) setEditObjectUrl('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentImg, fetchCollectionImageBlob, mode, row, slotKey, thumbRev]);

  const editorSrc = editObjectUrl || src;

  const actionDisabledReason =
    !row
      ? '未找到该采集记录'
      : row.imagesStatus !== 'done'
        ? '图片未下载完成，无法操作'
        : row.images.length === 0
          ? '无本地图片文件，无法操作'
          : !currentImg
            ? '图片槽位不存在'
            : colorDimmed
              ? '该主图对应的颜色已在采集编辑中取消勾选：仅允许预览，不允许编辑'
              : '';
  const actionDisabled = Boolean(actionDisabledReason);

  // 如果从可编辑图片切换到了被置灰的主图：强制回到“预览”，并关闭生成面板
  useEffect(() => {
    if (!colorDimmed) return;
    setMode('view');
    setGenOpen(false);
  }, [colorDimmed]);

  const requestNavTo = useCallback(
    (slotIndex: number) => {
      if (!Number.isFinite(slotIndex) || slotIndex < 0) return;
      window.dispatchEvent(
        new CustomEvent('images-lightbox-nav', {
          detail: { collectionId: state.collectionId, role: state.role, slotIndex },
        })
      );
    },
    [state.collectionId, state.role]
  );

  // keyboard: esc close, arrows nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!canNav) return;
      e.preventDefault();
      const nextSlot =
        e.key === 'ArrowLeft' ? available[curPos - 1] : e.key === 'ArrowRight' ? available[curPos + 1] : null;
      if (nextSlot == null) return;
      requestNavTo(nextSlot);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, canNav, curPos, onClose, requestNavTo]);

  // space down for panning in erase mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'erase') return;
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
  }, [mode]);

  // reset transient tool state per image change (keep mode)
  useEffect(() => {
    setErr('');
    setBusy(false);
    setZoom(1);
    setSpaceDown(false);
    setAspectPreset('free');
    setNaturalSize(null);
    setRepairNaturalSize(null);
    setRepairRect(null);
    drawing.current = false;
    last.current = null;
    panning.current = false;
    panStart.current = null;
    // destroy cropper
    try {
      cropperRef.current?.destroy();
    } catch {
      /* ignore */
    }
    cropperRef.current = null;
  }, [state.collectionId, state.role, state.slotIndex]);

  const applyAspectPreset = useCallback((p: AspectPreset) => {
    setAspectPreset(p);
    const c = cropperRef.current;
    if (!c) return;
    const r = presetToRatio(p);
    c.setAspectRatio(Number.isNaN(r) ? NaN : r);
  }, []);

  // fetch baseline file for undo once per slot
  useEffect(() => {
    if (!currentImg || !row || !slotKey) return;
    baselineKeyRef.current = slotKey;
    setBaselineLoading(false);

    const cached = imagesLightboxBaselineCache.get(slotKey);
    if (cached) {
      setBaselineFile(cached);
      return;
    }

    setBaselineFile(null);
    setBaselineLoading(true);
    (async () => {
      try {
        const rev = thumbRev[slotKey] ?? 0;
        const blob = await fetchCollectionImageBlob(row.collectionId, currentImg.storageRole, currentImg.filename, rev);
        const f = new File([blob], currentImg.filename || 'image', { type: blob.type || 'application/octet-stream' });
        imagesLightboxBaselineCache.set(slotKey, f);
        setBaselineFile(f);
      } catch {
        // ignore baseline failures; just disable undo
        setBaselineFile(null);
      } finally {
        setBaselineLoading(false);
      }
    })();
  }, [currentImg, fetchCollectionImageBlob, row, slotKey, thumbRev]);

  // init cropper when enter crop mode
  useEffect(() => {
    if (mode !== 'crop') return;
    // 等编辑用 blob URL 就绪后再初始化，避免跨域 src 导致交互异常/导出失败
    if (!editorSrc) return;
    const img = cropImgRef.current;
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
      if (cancelled || !cropImgRef.current) return;
      destroy();
      const c = new Cropper(cropImgRef.current, {
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
        checkCrossOrigin: false,
        minCropBoxWidth: 8,
        minCropBoxHeight: 8,
      });
      cropperRef.current = c;
    };
    if (img.complete && img.naturalWidth > 0) init();
    else img.addEventListener('load', init, { once: true });
    return () => {
      cancelled = true;
      img.removeEventListener('load', init);
      destroy();
    };
  }, [mode, editorSrc]);

  // init erase canvases when enter erase mode and image loads
  const initEraseCanvases = useCallback((w: number, h: number) => {
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
  }, []);

  const onEraseImgLoad = useCallback(() => {
    const img = eraseImgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setErr('');
    setNaturalSize({ w, h });
    requestAnimationFrame(() => initEraseCanvases(w, h));
  }, [initEraseCanvases]);

  useEffect(() => {
    if (mode !== 'erase') return;
    const img = eraseImgRef.current;
    if (img && img.complete && img.naturalWidth > 0) onEraseImgLoad();
  }, [mode, src, onEraseImgLoad]);

  const eraseEventToLocal = useCallback(
    (ev: React.PointerEvent) => {
      const mask = maskCanvasRef.current;
      if (!mask || !naturalSize) return null;
      const rect = mask.getBoundingClientRect();
      const sx = mask.width / rect.width;
      const sy = mask.height / rect.height;
      const x = (ev.clientX - rect.left) * sx;
      const y = (ev.clientY - rect.top) * sy;
      if (x < 0 || y < 0 || x > mask.width || y > mask.height) return null;
      return { x, y };
    },
    [naturalSize]
  );

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

  const onErasePointerDown = (ev: React.PointerEvent) => {
    if (mode !== 'erase' || !naturalSize || busy) return;
    if (spaceDown) {
      const wrap = eraseWrapRef.current;
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
    const p = eraseEventToLocal(ev);
    if (!p) return;
    drawing.current = true;
    last.current = null;
    paintStroke(p.x, p.y, false);
  };

  const onErasePointerMove = (ev: React.PointerEvent) => {
    if (mode !== 'erase' || !naturalSize || busy) return;
    if (panning.current && panStart.current) {
      const wrap = eraseWrapRef.current;
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
    const p = eraseEventToLocal(ev);
    if (!p) return;
    paintStroke(p.x, p.y, true);
  };

  const onErasePointerUp = (ev: React.PointerEvent) => {
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

  const clampZoom = useCallback((v: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(4, Math.round(n * 100) / 100));
  }, []);

  const onEraseWheel = useCallback(
    (ev: React.WheelEvent) => {
      if (mode !== 'erase') return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = eraseWrapRef.current;
      const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
      const cursorX = wrap && wrapRect ? ev.clientX - wrapRect.left : 0;
      const cursorY = wrap && wrapRect ? ev.clientY - wrapRect.top : 0;
      const dir = ev.deltaY < 0 ? 1 : -1;
      const step = ev.shiftKey ? 0.25 : 0.1;
      setZoom((z) => {
        const next = clampZoom(z + dir * step);
        if (!wrap || !wrapRect) return next;
        // 以鼠标位置为中心缩放：调整 scroll，使指针下的内容保持相对位置
        const ratio = next / (z || 1);
        if (!Number.isFinite(ratio) || ratio <= 0) return next;
        const contentX = wrap.scrollLeft + cursorX;
        const contentY = wrap.scrollTop + cursorY;
        // 在下一帧应用（等待布局根据 zoom 更新）
        requestAnimationFrame(() => {
          try {
            wrap.scrollLeft = contentX * ratio - cursorX;
            wrap.scrollTop = contentY * ratio - cursorY;
          } catch {
            /* ignore */
          }
        });
        return next;
      });
    },
    [clampZoom, mode]
  );

  // repair init / draw
  const drawRepair = useCallback(
    (r: { left: number; top: number; width: number; height: number } | null) => {
      const c = repairCanvasRef.current;
      const ns = repairNaturalSize;
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
    [repairNaturalSize]
  );

  const onRepairImgLoad = useCallback(() => {
    const img = repairImgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    setRepairNaturalSize({ w, h });
  }, []);

  useEffect(() => {
    if (mode !== 'repair') return;
    if (!repairNaturalSize) return;
    const c = repairCanvasRef.current;
    if (!c) return;
    c.width = repairNaturalSize.w;
    c.height = repairNaturalSize.h;
    drawRepair(repairRect);
  }, [drawRepair, mode, repairNaturalSize, repairRect]);

  useEffect(() => {
    if (mode !== 'repair') return;
    const img = repairImgRef.current;
    if (img && img.complete && img.naturalWidth > 0) onRepairImgLoad();
  }, [mode, src, onRepairImgLoad]);

  const repairEventToLocal = useCallback(
    (ev: React.PointerEvent) => {
      const c = repairCanvasRef.current;
      const ns = repairNaturalSize;
      if (!c || !ns) return null;
      const b = c.getBoundingClientRect();
      const sx = c.width / b.width;
      const sy = c.height / b.height;
      const x = (ev.clientX - b.left) * sx;
      const y = (ev.clientY - b.top) * sy;
      if (x < 0 || y < 0 || x > c.width || y > c.height) return null;
      return { x, y };
    },
    [repairNaturalSize]
  );

  const onRepairPointerDown = (ev: React.PointerEvent) => {
    if (mode !== 'repair' || !repairNaturalSize || busy) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const p = repairEventToLocal(ev);
    if (!p) return;
    repairDraggingRef.current = true;
    repairStartRef.current = { x: p.x, y: p.y };
    setRepairRect(null);
    drawRepair(null);
  };

  const onRepairPointerMove = (ev: React.PointerEvent) => {
    if (mode !== 'repair' || !repairNaturalSize || busy) return;
    if (!repairDraggingRef.current || !repairStartRef.current) return;
    const p = repairEventToLocal(ev);
    if (!p) return;
    const x0 = repairStartRef.current.x;
    const y0 = repairStartRef.current.y;
    const left = Math.min(x0, p.x);
    const top = Math.min(y0, p.y);
    const width = Math.abs(p.x - x0);
    const height = Math.abs(p.y - y0);
    const r = {
      left: clampInt(left, 0, repairNaturalSize.w),
      top: clampInt(top, 0, repairNaturalSize.h),
      width: clampInt(width, 1, repairNaturalSize.w),
      height: clampInt(height, 1, repairNaturalSize.h),
    };
    setRepairRect(r);
    drawRepair(r);
  };

  const onRepairPointerUp = (ev: React.PointerEvent) => {
    repairDraggingRef.current = false;
    repairStartRef.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };

  async function undoToBaseline() {
    if (!baselineFile || !row || !currentImg || !slotKey) return;
    setBusy(true);
    setErr('');
    try {
      await replaceImageForStorageRole(row.collectionId, currentImg.storageRole as any, currentImg.index, baselineFile, slotKey);
      setThumbRev((r) => ({ ...r, [slotKey]: (r[slotKey] ?? 0) + 1 }));
      await load();
      toastSuccess('已撤销到进入编辑前的图片', '撤销完成');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyCrop() {
    const cropper = cropperRef.current;
    if (!cropper || !row || !currentImg || !slotKey) {
      setErr('裁剪器未就绪');
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
      const ext = extFromFilename(currentImg.filename);
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const quality = mime === 'image/jpeg' ? 0.92 : undefined;
      const base = String(currentImg.filename || 'image').replace(/\.[^.]+$/, '') || 'cropped';
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
      await replaceImageForStorageRole(row.collectionId, currentImg.storageRole as any, currentImg.index, file, slotKey);
      setThumbRev((r) => ({ ...r, [slotKey]: (r[slotKey] ?? 0) + 1 }));
      await load();
      toastSuccess('裁剪完成', '操作完成');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '裁剪失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyErase() {
    const mask = maskCanvasRef.current;
    if (!mask || !naturalSize || !row || !currentImg || !slotKey) {
      setErr('画布未就绪');
      return;
    }
    const mctx = mask.getContext('2d');
    if (!mctx) return;
    const data = mctx.getImageData(0, 0, mask.width, mask.height);
    if (!maskHasEraseRegion(data)) {
      setErr('请先用笔刷涂抹要消除的区域');
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
      const base = String(currentImg.filename || 'mask').replace(/\.[^.]+$/, '') || 'mask';
      const maskFile = new File([blob], `${base}-mask.png`, { type: 'image/png' });
      const { filename: outFilename } = await api.aiEraseCollectionImage(row.collectionId, {
        storageRole: currentImg.storageRole as any,
        index: currentImg.index,
        mask: maskFile,
        provider: aiEraseProvider,
      });
      const nextRev = (thumbRev[slotKey] ?? 0) + 1;
      const outBlob = await fetchCollectionImageBlob(row.collectionId, currentImg.storageRole, outFilename, nextRev);
      const newUrl = URL.createObjectURL(outBlob);
      // update blob register so preview refreshes immediately
      const a = blobRegisterRef.current.get(regKey);
      if (a && state.slotIndex >= 0 && state.slotIndex < a.length) a[state.slotIndex] = newUrl;
      setThumbRev((r) => ({ ...r, [slotKey]: nextRev }));
      await load();
      toastSuccess('AI 消除完成', '操作完成');
      refreshCredits();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  async function applyRepair() {
    if (!repairNaturalSize || !repairRect || !row || !currentImg || !slotKey) {
      setErr('请在图片上拖拽框选要修复的矩形区域');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const { filename: outFilename } = await api.repairCollectionImage(row.collectionId, {
        storageRole: currentImg.storageRole as any,
        index: currentImg.index,
        rectangle: [repairRect],
      });
      const nextRev = (thumbRev[slotKey] ?? 0) + 1;
      const outBlob = await fetchCollectionImageBlob(row.collectionId, currentImg.storageRole, outFilename, nextRev);
      const newUrl = URL.createObjectURL(outBlob);
      const a = blobRegisterRef.current.get(regKey);
      if (a && state.slotIndex >= 0 && state.slotIndex < a.length) a[state.slotIndex] = newUrl;
      setThumbRev((r) => ({ ...r, [slotKey]: nextRev }));
      await load();
      toastSuccess('图像修复完成', '操作完成');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  function b64ToBlob(b64: string, contentType = 'image/png') {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
  }

  async function applyGenerate() {
    if (!row || !currentImg || !slotKey) return;
    const p = genPrompt.trim();
    if (!p) {
      setErr('请输入提示词');
      return;
    }
    setGenBusy(true);
    setErr('');
    try {
      const r = await api.generateImage({
        prompt: p,
        collectionId: row.collectionId,
        storageRole: String(currentImg.storageRole),
        index: Number(currentImg.index),
        filename: String(currentImg.filename || ''),
      });
      const ct = String(r.contentType || 'image/png') || 'image/png';
      const blob = b64ToBlob(String(r.b64 || ''), ct);
      const stem = String(currentImg.filename || 'generated').replace(/\.[^.]+$/, '') || 'generated';
      const file = new File([blob], `${stem}-gen.png`, { type: ct });
      await replaceImageForStorageRole(row.collectionId, currentImg.storageRole as any, currentImg.index, file, slotKey);
      const nextRev = (thumbRev[slotKey] ?? 0) + 1;
      setThumbRev((rr) => ({ ...rr, [slotKey]: nextRev }));
      await load();
      toastSuccess('图片生成完成', '操作完成');
      setGenOpen(false);
      refreshCredits();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '图片生成失败');
    } finally {
      setGenBusy(false);
    }
  }

  const toolBtn =
    'rounded-lg border border-white/70 bg-white/65 px-3 py-1.5 text-sm text-slate-700 shadow-sm backdrop-blur hover:bg-white/80 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:outline-none';
  const segBtn = (m: InlineMode, label: string, disabled?: boolean, title?: string) => (
    <button
      type="button"
      className={`rounded-lg border px-3 py-1.5 text-sm shadow-sm backdrop-blur focus:outline-none focus-visible:outline-none ${
        mode === m ? 'border-teal-500 bg-teal-50/90 text-teal-900' : 'border-white/70 bg-white/65 text-slate-700 hover:bg-white/80'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        setErr('');
        setMode(m);
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[240] flex items-center justify-center p-6"
      role="dialog"
      aria-modal
      aria-label="图片预览"
    >
      <div
        className="absolute left-4 top-4 z-[250] w-[136px] max-w-[min(calc(100vw-10rem),136px)] rounded-xl border border-white/70 bg-white/80 px-2 py-2 text-[11px] leading-relaxed text-slate-700 shadow-sm backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        role="status"
      >
        <div className="grid grid-cols-[48px_1fr] items-center gap-x-1.5">
          <span className="text-slate-600">AI 消除</span>
          <span className="justify-self-end text-right font-semibold tabular-nums text-slate-900">
            {formatCreditRemaining(credits?.aiEraseCredits)}
          </span>
        </div>
        <div className="mt-0.5 grid grid-cols-[48px_1fr] items-center gap-x-1.5">
          <span className="text-slate-600">去背景</span>
          <span className="justify-self-end text-right font-semibold tabular-nums text-slate-900">
            {formatCreditRemaining(credits?.nobgCredits)}
          </span>
        </div>
        <div className="mt-0.5 grid grid-cols-[48px_1fr] items-center gap-x-1.5">
          <span className="text-slate-600">图片生成</span>
          <span className="justify-self-end text-right font-semibold tabular-nums text-slate-900">
            {formatCreditRemaining(credits?.imageGenCredits)}
          </span>
        </div>
      </div>

      <div className="absolute left-1/2 top-4 z-[250] flex -translate-x-1/2 flex-wrap items-center justify-center gap-2">
        {segBtn('view', '预览')}
        {segBtn('crop', '裁剪', actionDisabled, actionDisabledReason || '在大图上直接裁剪')}
        {segBtn('erase', 'AI 消除', actionDisabled, actionDisabledReason || '在大图上直接涂抹消除')}
        {segBtn('repair', '图像修复', actionDisabled, actionDisabledReason || '在大图上直接框选修复')}
        <button
          type="button"
          className={toolBtn}
          disabled={actionDisabled || busy || genBusy}
          onClick={(e) => {
            e.stopPropagation();
            setErr('');
            setGenOpen((v) => !v);
          }}
          title="输入提示词生成图片并替换当前槽位"
        >
          图片生成
        </button>
        <button
          type="button"
          className={toolBtn}
          disabled={actionDisabled || busy || baselineLoading || !baselineFile}
          onClick={(e) => {
            e.stopPropagation();
            void undoToBaseline();
          }}
          title={
            baselineLoading
              ? '正在准备撤销基线…'
              : baselineFile
                ? '撤销回进入编辑前的图片'
                : '撤销不可用'
          }
          style={{ visibility: baselineLoading || baselineFile ? 'visible' : 'hidden' }}
        >
          撤销
        </button>
      </div>

      {mode === 'erase' ? (
        <div
          className="absolute left-1/2 top-[3.5rem] z-[250] -translate-x-1/2 rounded-full border border-white/70 bg-white/80 px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm backdrop-blur"
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <label className="flex items-center gap-2">
            <span className="text-slate-500">AI消除通道</span>
            <select
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-teal-300"
              value={aiEraseProvider}
              onChange={(e) => setAiEraseProvider(e.target.value as any)}
              disabled={busy}
              title="选择 AI 消除通道；切换下一张仍会沿用"
            >
              <option value="tencent">腾讯云</option>
              <option value="volc">火山引擎</option>
              <option value="dashscope">阿里百炼</option>
              <option value="stability">Stability</option>
            </select>
          </label>
        </div>
      ) : null}

      {genOpen ? (
        <div className="absolute left-1/2 top-16 z-[250] w-[min(92vw,720px)] -translate-x-1/2 rounded-2xl border border-white/70 bg-white/80 p-3 shadow-lg backdrop-blur">
          <div className="flex flex-col gap-2">
            <textarea
              className="w-full resize-none rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-sm text-slate-800 outline-none focus:border-teal-300"
              rows={3}
              placeholder="输入提示词，例如：生成一张白底产品图，居中摆放..."
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              disabled={genBusy}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                onClick={() => setGenOpen(false)}
                disabled={genBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg border border-teal-600 bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                onClick={() => void applyGenerate()}
                disabled={genBusy}
              >
                {genBusy ? '生成中…' : '生成并替换'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="absolute right-4 top-4 z-[250] rounded-lg border border-white/70 bg-white/65 px-3 py-1.5 text-sm text-slate-700 shadow-sm backdrop-blur hover:bg-white/80"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        关闭 (Esc)
      </button>

      {canNav ? (
        <>
          <button
            type="button"
            aria-label="上一张"
            disabled={!canPrev}
            className={`absolute left-3 top-1/2 z-[250] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:left-6 ${
              canPrev ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (!canPrev) return;
              const prev = available[curPos - 1];
              if (prev != null) requestNavTo(prev);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="下一张"
            disabled={!canNext}
            className={`absolute right-3 top-1/2 z-[250] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:right-6 ${
              canNext ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (!canNext) return;
              const next = available[curPos + 1];
              if (next != null) requestNavTo(next);
            }}
          >
            ›
          </button>
        </>
      ) : null}

      <div
        className="max-h-[90vh] max-w-[min(100%,calc(100%-8rem))]"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        {mode === 'view' ? (
          <img
            src={src}
            alt="预览"
            className="max-h-[90vh] max-w-full rounded-lg object-contain shadow-2xl"
            referrerPolicy="no-referrer"
          />
        ) : null}

        {mode === 'crop' ? (
          <div className="app-dark-stage relative w-[min(92vw,980px)] overflow-hidden rounded-lg shadow-2xl" style={{ height: 'min(84vh, 760px)', minHeight: 240 }}>
            <img
              key={editorSrc || src}
              ref={cropImgRef}
              src={editorSrc || src}
              alt=""
              className="block max-h-none max-w-none"
            />
            {!editorSrc ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-200">
                正在准备可编辑图片…
              </div>
            ) : null}
            <div className="absolute bottom-3 left-1/2 z-[260] flex -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-2 text-xs text-slate-700 backdrop-blur">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500">比例</span>
                {(
                  [
                    ['free', '自由'],
                    ['1', '1:1'],
                    ['4/3', '4:3'],
                    ['3/4', '3:4'],
                    ['16/9', '16:9'],
                  ] as const
                ).map(([p, label]) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy || !editorSrc}
                    className={`rounded border px-2 py-1 text-[11px] font-semibold disabled:opacity-50 ${
                      aspectPreset === p
                        ? 'border-teal-600 bg-teal-50 text-teal-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                    onClick={() => applyAspectPreset(p)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="rounded border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={busy || !editorSrc}
                onClick={() => {
                  try {
                    cropperRef.current?.reset();
                  } catch {
                    /* ignore */
                  }
                  setAspectPreset('free');
                  try {
                    cropperRef.current?.setAspectRatio(NaN);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                重置
              </button>
              <button
                type="button"
                className="rounded border border-teal-600 bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                disabled={busy || !editorSrc}
                onClick={() => void applyCrop()}
              >
                {busy ? '处理中…' : '应用裁剪'}
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'erase' ? (
          <div
            ref={eraseWrapRef}
            className="mx-auto min-h-0 w-full max-w-[min(100%,calc(100%-8rem))] overflow-auto rounded-lg bg-white/90 [scrollbar-gutter:stable]"
            style={{ maxHeight: '90vh' }}
          >
            <div
              className="relative mx-auto inline-block min-w-0"
              style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
              onWheel={onEraseWheel}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setZoom(1);
                requestAnimationFrame(() => {
                  const w = eraseWrapRef.current;
                  if (w) {
                    w.scrollLeft = 0;
                    w.scrollTop = 0;
                  }
                });
              }}
              title="在图片上滚动可缩放（Shift 更快）；按住空格拖动画面"
            >
              <img
                key={editorSrc}
                ref={eraseImgRef}
                src={editorSrc}
                alt=""
                onLoad={onEraseImgLoad}
                className="block h-auto max-h-none w-full select-none"
                draggable={false}
              />
              {naturalSize ? (
                <>
                  <canvas ref={maskCanvasRef} className="pointer-events-none absolute left-0 top-0 h-full w-full opacity-0" aria-hidden />
                  <canvas
                    ref={viewCanvasRef}
                    className={
                      spaceDown
                        ? 'absolute left-0 top-0 h-full w-full cursor-grab touch-none'
                        : 'absolute left-0 top-0 h-full w-full cursor-crosshair touch-none'
                    }
                    onPointerDown={onErasePointerDown}
                    onPointerMove={onErasePointerMove}
                    onPointerUp={onErasePointerUp}
                    onPointerLeave={onErasePointerUp}
                  />
                </>
              ) : null}
            </div>

            <div className="sticky bottom-3 left-0 right-0 mt-3 flex justify-center">
              <div className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-full border border-white/60 bg-transparent px-3 py-2 text-xs text-slate-700 backdrop-blur">
                <label className="flex items-center gap-2">
                  <span>笔刷</span>
                  <input
                    type="range"
                    min={8}
                    max={120}
                    value={brush}
                    onChange={(e) => setBrush(Number(e.target.value))}
                    className="w-36"
                    disabled={busy}
                  />
                  <span className="tabular-nums text-slate-500">{brush}px</span>
                </label>
                <label className="flex items-center gap-2">
                  <span>缩放</span>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={0.05}
                    value={zoom}
                    onChange={(e) => setZoom(clampZoom(Number(e.target.value)))}
                    className="w-36"
                    disabled={busy}
                  />
                  <span className="tabular-nums text-slate-500">{Math.round(zoom * 100)}%</span>
                </label>
                <button
                  type="button"
                  className="rounded border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={busy || !naturalSize}
                  onClick={() => {
                    if (!naturalSize) return;
                    initEraseCanvases(naturalSize.w, naturalSize.h);
                  }}
                >
                  清除涂抹
                </button>
                <button
                  type="button"
                  className="rounded border border-teal-600 bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  disabled={busy || !naturalSize}
                  onClick={() => void applyErase()}
                >
                  {busy ? '处理中…' : '提交 AI 消除'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {mode === 'repair' ? (
          <div className="mx-auto min-h-0 overflow-auto rounded-lg bg-white/90 [scrollbar-gutter:stable]" style={{ maxHeight: '90vh' }}>
            <div className="relative mx-auto inline-block max-w-full min-w-0">
              <img
                key={editorSrc}
                ref={repairImgRef}
                src={editorSrc}
                alt=""
                onLoad={onRepairImgLoad}
                className="block h-auto max-h-none w-auto max-w-full select-none"
                draggable={false}
              />
              <canvas
                ref={repairCanvasRef}
                className={
                  repairNaturalSize
                    ? 'absolute left-0 top-0 h-full w-full cursor-crosshair touch-none'
                    : 'pointer-events-none absolute left-0 top-0 h-full w-full opacity-0'
                }
                onPointerDown={onRepairPointerDown}
                onPointerMove={onRepairPointerMove}
                onPointerUp={onRepairPointerUp}
                onPointerLeave={onRepairPointerUp}
                aria-hidden={!repairNaturalSize}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 rounded-full border border-white/60 bg-transparent px-3 py-2 text-xs text-slate-700 backdrop-blur">
              <button
                type="button"
                className="rounded border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setRepairRect(null);
                  drawRepair(null);
                }}
              >
                清除选区
              </button>
              <button
                type="button"
                className="rounded border border-teal-600 bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                disabled={busy || !repairRect}
                onClick={() => void applyRepair()}
              >
                {busy ? '处理中…' : '提交图像修复'}
              </button>
            </div>
          </div>
        ) : null}

        {err ? (
          <p className="mt-3 text-center text-xs text-red-200">
            {err}
          </p>
        ) : null}
      </div>

      {canNav ? (
        <div
          className="pointer-events-none absolute bottom-6 left-1/2 z-[250] -translate-x-1/2 rounded-full border border-white/70 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700 shadow-sm backdrop-blur"
          aria-hidden
        >
          {curPos + 1} / {available.length}
        </div>
      ) : null}
    </div>
  );
}

async function getFilesFromDataTransfer(dt: DataTransfer): Promise<{ file: File; rel: string }[]> {
  const items = Array.from(dt.items || []);
  const fromFiles = Array.from(dt.files || []).map((f) => ({
    file: f,
    rel: (f as any).webkitRelativePath || f.name,
  }));

  const hasEntryApi = items.some((it) => typeof (it as any).webkitGetAsEntry === 'function');
  if (!hasEntryApi) {
    return fromFiles;
  }

  let hasDirectory = false;
  for (const it of items) {
    try {
      const entry = (it as any).webkitGetAsEntry?.();
      if (entry && entry.isDirectory) {
        hasDirectory = true;
        break;
      }
    } catch {
      /* ignore */
    }
  }

  // 非文件夹、多选文件拖拽：Chromium 等环境下 items.webkitGetAsEntry 往往只解析到 1 项，dt.files 才是完整列表
  if (!hasDirectory && fromFiles.length > 1) {
    return fromFiles;
  }

  const out: { file: File; rel: string }[] = [];

  async function walkEntry(entry: any, base: string) {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        entry.file((file: File) => {
          out.push({ file, rel: base ? `${base}/${file.name}` : file.name });
          resolve();
        });
      });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const entries: any[] = await new Promise((resolve) => reader.readEntries(resolve));
        if (!entries || entries.length === 0) break;
        for (const e of entries) {
          await walkEntry(e, base ? `${base}/${e.name}` : e.name);
        }
      }
    }
  }

  for (const it of items) {
    let entry: any;
    try {
      entry = (it as any).webkitGetAsEntry?.();
    } catch {
      entry = null;
    }
    if (!entry && it.kind === 'file') {
      const f = it.getAsFile();
      if (f) {
        out.push({ file: f, rel: (f as any).webkitRelativePath || f.name });
      }
      continue;
    }
    if (!entry) continue;
    // 单个文件拖入时不要用 entry.name 作为 base，否则 rel 会变成「文件名/文件名」
    const base = entry.isFile ? '' : entry.name || '';
    await walkEntry(entry, base);
  }

  // 目录拖拽或单文件：用 dt.files 补齐（按 name+size+lastModified 去重，避免 entry 解析遗漏）
  const dedupeKey = (x: { file: File; rel: string }) =>
    `${x.file.name}\t${x.file.size}\t${x.file.lastModified}`;
  const seen = new Set(out.map(dedupeKey));
  for (const x of fromFiles) {
    if (!seen.has(dedupeKey(x))) {
      out.push(x);
      seen.add(dedupeKey(x));
    }
  }
  return out;
}

function isFileDrag(dt: DataTransfer | null) {
  return Boolean(dt?.types?.includes('Files'));
}

function isDetailImageDrag(dt: DataTransfer | null) {
  return Boolean(dt?.types?.includes(DRAG_DETAIL_MIME));
}

function isSlotImageDrag(dt: DataTransfer | null) {
  if (!dt) return false;
  if (dt.types?.includes(DRAG_SLOT_MIME)) return true;
  // 兼容：部分环境不会在 types 中暴露自定义 mime，fallback 到 text/plain
  if (!dt.types?.includes('text/plain')) return false;
  // 部分浏览器在 dragover 阶段读取 getData 会返回空；此时用 effectAllowed 做弱判定，
  // 仅用于“允许 drop 进入”（去掉禁止符号）。真正替换仍以 drop 时解析成功为准。
  try {
    const t = String(dt.getData('text/plain') || '');
    if (t.startsWith(DRAG_SLOT_TEXT_PREFIX)) return true;
  } catch {
    /* ignore */
  }
  const eff = String((dt as any).effectAllowed || '').toLowerCase();
  const hasCopy = eff.includes('copy') || eff === 'all' || eff === 'uninitialized';
  const notFiles = !dt.types?.includes('Files');
  const notDetail = !dt.types?.includes(DRAG_DETAIL_MIME);
  return hasCopy && notFiles && notDetail;
}

function nobgFolderToRole(folder: string | undefined): 'main_nobg' | 'gallery_nobg' | null {
  if (!folder) return null;
  if (folder === 'main-nobg' || folder === 'main_nobg') return 'main_nobg';
  if (folder === 'gallery-nobg' || folder === 'gallery_nobg') return 'gallery_nobg';
  return null;
}

function parseZipLikeImageRelPath(rel: string, collectionId: number) {
  const parts = String(rel || '').split(/[/\\]+/).filter(Boolean);
  const filename = parts[parts.length - 1];
  if (!filename) return null;

  // 含记录 ID 的路径：
  // 1) zip：img/{id}/main-nobg|gallery-nobg/filename
  // 2) 本地：images/{id}/main-nobg|gallery-nobg/filename
  const idStr = String(collectionId);
  const idx = parts.lastIndexOf(idStr);
  if (idx !== -1) {
    const folder = parts[idx + 1];
    const role = nobgFolderToRole(folder);
    if (role) return { role, filename };
  }

  // 无记录 ID：任意前缀下的 main-nobg|gallery-nobg/filename，例如 main-nobg/xxx.jpg
  if (parts.length >= 2) {
    const folder = parts[parts.length - 2];
    const role = nobgFolderToRole(folder);
    if (role) return { role, filename };
  }

  return null;
}

/** 路径无法解析时，仅用文件名在 main_nobg / gallery_nobg 中查找；唯一则命中一处，两处同名时由调用方同时替换主图与副图槽位 */
function matchNobgUploadByFilename(
  rel: string,
  slotByRoleAndFilename: Map<string, { role: 'main_nobg' | 'gallery_nobg'; index: number }>
):
  | { kind: 'ok'; role: 'main_nobg' | 'gallery_nobg'; filename: string }
  | { kind: 'ambiguous'; filename: string }
  | null {
  const parts = String(rel || '').split(/[/\\]+/).filter(Boolean);
  const filename = parts[parts.length - 1];
  if (!filename) return null;
  const hits: ('main_nobg' | 'gallery_nobg')[] = [];
  for (const role of ['main_nobg', 'gallery_nobg'] as const) {
    if (slotByRoleAndFilename.has(`${role}\t${filename}`)) hits.push(role);
  }
  if (hits.length === 1) return { kind: 'ok', role: hits[0], filename };
  if (hits.length > 1) return { kind: 'ambiguous', filename };
  return null;
}

/** 突出显示采集记录 ID（可选带 #，与上传说明、标题行一致） */
function UploadFolderIdHighlight({ id, withHash }: { id: number; withHash?: boolean }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center rounded-full border border-orange-400 bg-orange-50 px-2 py-0.5 font-mono text-sm font-bold tabular-nums text-orange-800"
      title={`采集记录 ID：${id}`}
    >
      {withHash ? '#' : ''}
      {id}
    </span>
  );
}

function IconThumbMenuCrop({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M16 8V4h-4M4 16v-4h4M16 16v-4h-4" />
    </svg>
  );
}

function IconThumbMenuDownload({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
      />
    </svg>
  );
}

function IconThumbMenuRemoveBg({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423L16.5 15.75l.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
      />
    </svg>
  );
}

function IconThumbMenuLink({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.19 8.688a4.5 4.5 0 0 1 0 6.364l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622-1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
      />
    </svg>
  );
}

function IconThumbMenuRepair({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.42 6.12a5.25 5.25 0 1 0 6.46 6.46L21 9.46l-2.12-2.12-1.06 1.06-2.12-2.12 1.06-1.06L14.54 3l-3.12 3.12Zm-7.3 14.18 6.4-6.4"
      />
    </svg>
  );
}

/** 右键菜单「AI消除」图标（橡皮擦 / 涂抹示意） */
function IconThumbMenuAiErase({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
      />
    </svg>
  );
}

export default function ImagesPage({ user }: { user: UserInfo }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const didInitFromUrlRef = useRef(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.imagesList>> | null>(null);
  const [page, setPage] = useState(1);
  const [userIdFilter, setUserIdFilter] = useState<number | ''>('');
  const [users, setUsers] = useState<{ id: number; username: string }[]>([]);
  const [err, setErr] = useState('');
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [thumbRev, setThumbRev] = useState<Record<string, number>>({});
  const [groupUploadingId, setGroupUploadingId] = useState<number | null>(null);
  const [groupDownloadingId, setGroupDownloadingId] = useState<number | null>(null);
  const [retryingDownloadId, setRetryingDownloadId] = useState<number | null>(null);
  const [markSavingId, setMarkSavingId] = useState<number | null>(null);
  /** 并发去背景：用 Set 记录进行中任务；单字符串会在「先完成」的 finally 里误清掉后发起的任务状态 */
  const [nobgInFlight, setNobgInFlight] = useState<Set<string>>(() => new Set());
  const folderPickRef = useRef<HTMLInputElement>(null);
  const filesPickRef = useRef<HTMLInputElement>(null);
  const pendingFolderUploadRef = useRef<number | null>(null);
  const pendingFilesUploadRef = useRef<number | null>(null);
  const [lightbox, setLightbox] = useState<ImagesInlineLightboxState | null>(null);
  const [lightboxCredits, setLightboxCredits] = useState<AccountCredits | null>(null);
  const [detailLightbox, setDetailLightbox] = useState<DetailLightboxState>(null);
  const blobRegisterRef = useRef<Map<string, string[]>>(new Map());
  const [dragOverCollectionId, setDragOverCollectionId] = useState<number | null>(null);
  const [dragOverThumbKey, setDragOverThumbKey] = useState<string | null>(null);
  // 记录主图/副图槽位拖拽源，避免不同浏览器对 dataTransfer 的限制导致 dragover/drop 不可用
  const slotDragPayloadRef = useRef<{
    collectionId: number;
    role: 'main' | 'gallery';
    index: number;
    storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
    filename: string;
  } | null>(null);
  const [cropModal, setCropModal] = useState<{
    collectionId: number;
    storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
    role: 'main' | 'gallery';
    index: number;
    key: string;
    imageObjectUrl: string;
    filename: string;
    label: string;
    originalFile: File;
    canUndo: boolean;
  } | null>(null);
  const [cropLoadingKey, setCropLoadingKey] = useState<string | null>(null);
  const [aiEraseModal, setAiEraseModal] = useState<{
    collectionId: number;
    storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
    role: 'main' | 'gallery';
    index: number;
    key: string;
    imageObjectUrl: string;
    filename: string;
    label: string;
    originalFile: File;
    canUndo: boolean;
    lastProviderLabel?: string;
    provider?: 'tencent' | 'volc' | 'dashscope' | 'stability';
  } | null>(null);
  const [aiEraseLoadingKey, setAiEraseLoadingKey] = useState<string | null>(null);
  const AI_ERASE_PROVIDER_LS_KEY = 'images.aiErase.provider';
  const [aiEraseProvider, setAiEraseProvider] = useState<'tencent' | 'volc' | 'dashscope' | 'stability'>(() => {
    const v = String(localStorage.getItem(AI_ERASE_PROVIDER_LS_KEY) || '').trim().toLowerCase();
    if (v === 'tencent' || v === 'volc' || v === 'dashscope' || v === 'stability') return v as any;
    return 'dashscope';
  });

  useEffect(() => {
    try {
      localStorage.setItem(AI_ERASE_PROVIDER_LS_KEY, aiEraseProvider);
    } catch {
      /* ignore */
    }
  }, [aiEraseProvider]);
  const [repairModal, setRepairModal] = useState<{
    collectionId: number;
    storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
    role: 'main' | 'gallery';
    index: number;
    key: string;
    imageObjectUrl: string;
    filename: string;
    label: string;
    originalFile: File;
    canUndo: boolean;
  } | null>(null);
  const [repairLoadingKey, setRepairLoadingKey] = useState<string | null>(null);
  /** 主图/副图缩略图操作菜单（卡片区域右键打开） */
  const [thumbMenu, setThumbMenu] = useState<{
    anchorRect: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    collectionId: number;
    storageRole: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg';
    filename: string;
    role: 'main' | 'gallery';
    index: number;
    /** UI 槽位序号（与 openMainLightbox/openGalleryLightbox 入参一致） */
    slotIndex: number;
    key: string;
    copyPublicUrl: string;
    sectionLabel: string;
    imagesStatus: string | undefined;
    imagesLength: number;
  } | null>(null);
  const thumbMenuRef = useRef<HTMLDivElement>(null);
  const [thumbMenuPos, setThumbMenuPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);

  useEffect(() => {
    if (!lightbox) {
      setLightboxCredits(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api.accountOverview();
        if (cancelled || !r.credits) return;
        setLightboxCredits({
          nobgCredits: Number(r.credits.nobgCredits ?? 0),
          aiEraseCredits: Number(r.credits.aiEraseCredits ?? 0),
          imageGenCredits: Number(r.credits.imageGenCredits ?? 0),
        });
      } catch {
        if (!cancelled) setLightboxCredits(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lightbox]);

  const refreshLightboxCredits = useCallback(() => {
    api
      .accountOverview()
      .then((r) => {
        if (!r.credits) return;
        setLightboxCredits({
          nobgCredits: Number(r.credits.nobgCredits ?? 0),
          aiEraseCredits: Number(r.credits.aiEraseCredits ?? 0),
          imageGenCredits: Number(r.credits.imageGenCredits ?? 0),
        });
      })
      .catch(() => {});
  }, []);

  // 刷新/分享链接时保留筛选：从 URL 读取初始 page/userId
  useEffect(() => {
    if (didInitFromUrlRef.current) return;
    didInitFromUrlRef.current = true;

    const sp0 = searchParams;
    let sp = sp0;

    // 侧边栏切换模块时通常只跳裸路径（不带 ?），导致筛选回默认；
    // 若当前 URL 没带任何筛选参数，则从 sessionStorage 恢复上一次的查询参数，并立刻用于初始化 state。
    try {
      const hasAny = Boolean(sp0.get('page') || sp0.get('userId'));
      if (!hasAny && typeof sessionStorage !== 'undefined') {
        const raw = sessionStorage.getItem('admin:images:lastSearch') || '';
        if (raw.trim()) {
          sp = new URLSearchParams(raw);
          setSearchParams(sp, { replace: true });
        }
      }
    } catch {
      /* ignore */
    }

    const pageRaw = sp.get('page');
    const userIdRaw = sp.get('userId');
    const p = Number(pageRaw || '');
    if (Number.isFinite(p) && p >= 1) setPage(Math.floor(p));

    if (user.role === 'admin') {
      const uid = Number(userIdRaw || '');
      if (Number.isFinite(uid) && uid > 0) setUserIdFilter(Math.floor(uid));
    }
  }, [searchParams, user.role]);

  // 筛选变化时同步 URL（刷新不丢）
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('page', String(page));
    if (user.role === 'admin' && userIdFilter !== '') next.set('userId', String(userIdFilter));
    setSearchParams(next, { replace: true });

    // 同步写入 sessionStorage：用于“切换模块 → 返回本页”恢复筛选
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('admin:images:lastSearch', next.toString());
      }
    } catch {
      /* ignore */
    }
  }, [page, user.role, userIdFilter, setSearchParams]);

  const openMainLightbox = useCallback(
    (collectionId: number, slotIndex: number) => {
      const regKey = `${collectionId}-main`;
      const ordered = [...(blobRegisterRef.current.get(regKey) ?? [])];
      if (!ordered[slotIndex]) return;
      setLightbox({ collectionId, role: 'main', slotIndex });
    },
    [data]
  );

  const openGalleryLightbox = useCallback(
    (collectionId: number, slotIndex: number) => {
      const regKey = `${collectionId}-gallery`;
      const ordered = [...(blobRegisterRef.current.get(regKey) ?? [])];
      if (!ordered[slotIndex]) return;
      setLightbox({ collectionId, role: 'gallery', slotIndex });
    },
    [data]
  );

  useEffect(() => {
    const onNav = (e: Event) => {
      const ev = e as CustomEvent<any>;
      const d = ev.detail;
      if (!d || typeof d !== 'object') return;
      if (typeof d.collectionId !== 'number') return;
      if (d.role !== 'main' && d.role !== 'gallery') return;
      if (typeof d.slotIndex !== 'number') return;
      setLightbox({ collectionId: d.collectionId, role: d.role, slotIndex: d.slotIndex });
    };
    window.addEventListener('images-lightbox-nav', onNav as any);
    return () => window.removeEventListener('images-lightbox-nav', onNav as any);
  }, []);

  const openDetailLightbox = useCallback(
    (collectionId: number, slotIndex: number) => {
      const row = data?.rows.find((r) => r.collectionId === collectionId);
      const dets = row?.images.filter((x) => x.role === 'detail') ?? [];
      const regKey = `${collectionId}-detail`;
      const ordered = [...(blobRegisterRef.current.get(regKey) ?? [])];
      while (ordered.length < dets.length) ordered.push('');
      if (!ordered[slotIndex]) return;
      const urls = ordered.filter(Boolean);
      let pos = -1;
      let c = 0;
      for (let j = 0; j < ordered.length; j++) {
        if (!ordered[j]) continue;
        if (j === slotIndex) {
          pos = c;
          break;
        }
        c++;
      }
      if (pos < 0) return;
      setDetailLightbox({ urls, index: pos });
    },
    [data]
  );

  const load = useCallback(async () => {
    setErr('');
    const q = new URLSearchParams({ page: String(page), limit: '15' });
    if (user.role === 'admin' && userIdFilter !== '') q.set('userId', String(userIdFilter));
    try {
      const res = await api.imagesList(q.toString());
      setData(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    }
  }, [page, user.role, userIdFilter]);

  const setRowUserMark = useCallback(
    async (collectionId: number, value: string) => {
      setMarkSavingId(collectionId);
      setErr('');
      try {
        const mark: CollectionUserMark | null = value === '' ? null : (value as CollectionUserMark);
        await api.setCollectionMark(collectionId, mark);
        // 乐观更新，避免闪烁；SSE / 刷新也会再对齐一次
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            rows: prev.rows.map((r) =>
              r.collectionId === collectionId ? { ...r, userMark: mark } : r
            ),
          };
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '保存标记失败');
      } finally {
        setMarkSavingId(null);
      }
    },
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const url = collectionEventsUrl();
    if (!url) return;

    let closed = false;
    let debounceTimer: number | null = null;
    const refreshSoon = () => {
      if (closed) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 250);
    };

    const es = new EventSource(url);
    es.addEventListener('collections-changed', refreshSoon);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshSoon);

    return () => {
      closed = true;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      es.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshSoon);
    };
  }, [load]);

  useEffect(() => {
    if (user.role !== 'admin') return;
    api
      .adminUsers()
      .then((list) => setUsers(list.map((u) => ({ id: u.id, username: u.username }))))
      .catch(() => {});
  }, [user.role]);

  useEffect(() => {
    const onDragEnd = () => {
      setDragOverCollectionId(null);
      setDragOverThumbKey(null);
      slotDragPayloadRef.current = null;
    };
    document.addEventListener('dragend', onDragEnd);
    return () => document.removeEventListener('dragend', onDragEnd);
  }, []);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const handleGroupUpload = useCallback(
    async (
      collectionId: number,
      picked: { file: File; rel: string }[],
      imagesStorage: 'local' | 'oss' | null | undefined
    ) => {
      if (!data) return;
      const row = data.rows.find((r) => r.collectionId === collectionId);
      if (!row) return;
      const images = row.images || [];

      if (row.imagesNobgStatus !== 'done') {
        setErr('该记录尚未完成去背景：请先点击「去背景」完成后，再下载/上传 main-nobg 与 gallery-nobg。');
        return;
      }

      const slotByRoleAndFilename = new Map<
        string,
        { role: 'main_nobg' | 'gallery_nobg'; index: number }
      >();
      for (const img of images) {
        if (img.role !== 'main' && img.role !== 'gallery') continue;
        const fn = String(img.filename || '').trim();
        if (!fn) continue;
        // 依赖后端 imagesList 在 nobgDone 时把 storageRole 指向 main_nobg/gallery_nobg，并用对应的 filename
        if (img.storageRole === 'main_nobg') {
          slotByRoleAndFilename.set(`main_nobg\t${fn}`, { role: 'main_nobg', index: img.index });
        } else if (img.storageRole === 'gallery_nobg') {
          slotByRoleAndFilename.set(`gallery_nobg\t${fn}`, { role: 'gallery_nobg', index: img.index });
        }
      }

      const jobByKey = new Map<
        string,
        {
          role: 'main_nobg' | 'gallery_nobg';
          index: number;
          file: File;
          key: string;
          filename: string;
        }
      >();

      function enqueueSlot(
        role: 'main_nobg' | 'gallery_nobg',
        filename: string,
        file: File
      ) {
        const slot = slotByRoleAndFilename.get(`${role}\t${filename}`);
        if (!slot) return;
        // 与列表缩略图 key 一致：main/gallery + index（勿用 main_nobg，否则 thumbRev 不命中、替换后仍显示旧图）
        const displayRole = slot.role === 'main_nobg' ? 'main' : 'gallery';
        const key = `${collectionId}-${displayRole}-${slot.index}`;
        jobByKey.set(key, { role: slot.role, index: slot.index, file, key, filename });
      }

      for (const it of picked) {
        let role: 'main_nobg' | 'gallery_nobg' | null = null;
        let filename: string | null = null;

        const fromPath = parseZipLikeImageRelPath(it.rel, collectionId);
        if (fromPath) {
          role = fromPath.role;
          filename = fromPath.filename;
        } else {
          const byName = matchNobgUploadByFilename(it.rel, slotByRoleAndFilename);
          if (byName?.kind === 'ambiguous') {
            const fn = byName.filename;
            // 仅文件名、无文件夹信息时：主图与副图去背景槽位同名则两份都替换为同一上传文件
            enqueueSlot('main_nobg', fn, it.file);
            enqueueSlot('gallery_nobg', fn, it.file);
            continue;
          }
          if (byName?.kind === 'ok') {
            role = byName.role;
            filename = byName.filename;
          }
        }

        if (!role || !filename) continue;
        enqueueSlot(role, filename, it.file);
      }

      const jobs = [...jobByKey.values()];

      if (jobs.length === 0) {
        setErr(
          '未识别到可替换的图片：可拖入/选择该记录的 ID 文件夹（含 main-nobg、gallery-nobg），或直接拖入/选择与清单一致的单个/多个图片文件。'
        );
        return;
      }

      setGroupUploadingId(collectionId);
      try {
        if (imagesStorage === 'oss') {
          try {
            const sts = await api.ossSts(collectionId);
            for (const j of jobs) {
              const key = ossKeyForCollectionImage(sts.prefix, collectionId, j.role, j.filename);
              await putObjectWithSts(sts, key, j.file, { contentType: j.file.type });
              await api.replaceCollectionImageNobgOss(collectionId, {
                role: j.role,
                index: j.index,
                filename: j.filename,
              });
              setThumbRev((r) => ({ ...r, [j.key]: (r[j.key] ?? 0) + 1 }));
            }
          } catch (ex) {
            // STS 未配置/AssumeRole 失败等场景：回退到服务端上传（服务端会按 images_storage 写入本地或 OSS）
            for (const j of jobs) {
              await api.replaceCollectionImageNobg(collectionId, {
                role: j.role,
                index: j.index,
                file: j.file,
              });
              setThumbRev((r) => ({ ...r, [j.key]: (r[j.key] ?? 0) + 1 }));
            }
          }
        } else {
          // 本地存储：走服务端上传替换（不使用 OSS 直传）
          for (const j of jobs) {
            await api.replaceCollectionImageNobg(collectionId, {
              role: j.role,
              index: j.index,
              file: j.file,
            });
            setThumbRev((r) => ({ ...r, [j.key]: (r[j.key] ?? 0) + 1 }));
          }
        }
        await load();
        setErr('');
        toastSuccess(`成功上传 ${jobs.length} 张图片`, '上传完成');
        window.dispatchEvent(
          new CustomEvent('collection-images-updated', { detail: { collectionId } })
        );
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : '批量上传失败');
      } finally {
        setGroupUploadingId(null);
      }
    },
    [data, load]
  );

  const fetchCollectionImageBlob = useCallback(
    async (
      collectionId: number,
      role: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg',
      filename: string,
      /** 与 thumbRev 一致，同路径覆盖后避免走 HTTP 缓存拿到旧图 */
      rev?: number
    ) => {
      let path = collectionImageApiPath(collectionId, role, filename);
      if (rev != null && rev > 0) {
        path += `${path.includes('?') ? '&' : '?'}v=${rev}`;
      }
      const token = getToken();
      const r = await fetch(`${API_BASE}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(r.statusText || '读取图片失败');
      return await r.blob();
    },
    []
  );

  const downloadCollectionImage = useCallback(
    async (
      collectionId: number,
      role: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg',
      filename: string,
      key: string
    ) => {
      setDownloadingKey(key);
      setErr('');
      try {
        const rev = thumbRev[key] ?? 0;
        const blob = await fetchCollectionImageBlob(collectionId, role, filename, rev);
        downloadBlob(blob, safeFilename(filename) || 'image');
      } catch (e) {
        setErr(e instanceof Error ? e.message : '下载失败');
      } finally {
        setDownloadingKey(null);
      }
    },
    [fetchCollectionImageBlob, thumbRev]
  );

  function ExternalThumb({ url, onOpen }: { url: string; onOpen: () => void }) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="group shrink-0 rounded-lg border border-slate-200 bg-white p-1 shadow-sm transition hover:border-teal-300 hover:shadow"
        title={url}
      >
        <div className="relative h-16 w-16 overflow-hidden rounded-md bg-slate-100">
          <img
            src={url}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).style.opacity = '0.35';
            }}
          />
        </div>
      </button>
    );
  }

  const handleThumbReplace = useCallback(
    async (collectionId: number, role: 'main' | 'gallery', index: number, file: File, key: string) => {
      setErr('');
      try {
        await api.replaceCollectionImage(collectionId, { role, index, file });
        setThumbRev((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
        await load();
        toastSuccess('已替换 1 张图片', '替换完成');
        window.dispatchEvent(
          new CustomEvent('collection-images-updated', { detail: { collectionId } })
        );
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : '替换失败');
      }
    },
    [load]
  );

  const replaceImageForStorageRole = useCallback(
    async (
      collectionId: number,
      storageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg',
      index: number,
      file: File,
      key: string
    ) => {
      if (storageRole === 'main' || storageRole === 'gallery') {
        await api.replaceCollectionImage(collectionId, { role: storageRole, index, file });
      } else {
        await api.replaceCollectionImageNobg(collectionId, { role: storageRole, index, file });
      }
      setThumbRev((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
      await load();
      window.dispatchEvent(
        new CustomEvent('collection-images-updated', { detail: { collectionId } })
      );
    },
    [load]
  );

  const closeCropModal = useCallback(() => {
    setCropModal((prev) => {
      if (prev?.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
      return null;
    });
  }, []);

  const openCropModal = useCallback(
    async (
      collectionId: number,
      storageRole: Parameters<typeof fetchCollectionImageBlob>[1],
      filename: string,
      role: 'main' | 'gallery',
      index: number,
      key: string,
      label: string
    ) => {
      if (storageRole === 'detail') return;
      setCropLoadingKey(key);
      setErr('');
      try {
        const rev = thumbRev[key] ?? 0;
        const blob = await fetchCollectionImageBlob(collectionId, storageRole, filename, rev);
        const originalFile = new File([blob], filename || 'image', {
          type: blob.type || 'application/octet-stream',
        });
        const imageObjectUrl = URL.createObjectURL(blob);
        setCropModal({
          collectionId,
          storageRole: storageRole as 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg',
          role,
          index,
          key,
          imageObjectUrl,
          filename,
          label,
          originalFile,
          canUndo: false,
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '加载图片失败');
      } finally {
        setCropLoadingKey(null);
      }
    },
    [fetchCollectionImageBlob, thumbRev]
  );

  const closeAiEraseModal = useCallback(() => {
    setAiEraseModal((prev) => {
      if (prev?.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
      return null;
    });
  }, []);

  const closeRepairModal = useCallback(() => {
    setRepairModal((prev) => {
      if (prev?.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
      return null;
    });
  }, []);

  const openAiEraseModal = useCallback(
    async (
      collectionId: number,
      storageRole: Parameters<typeof fetchCollectionImageBlob>[1],
      filename: string,
      role: 'main' | 'gallery',
      index: number,
      key: string,
      label: string
    ) => {
      if (storageRole === 'detail') return;
      setAiEraseLoadingKey(key);
      setErr('');
      try {
        const rev = thumbRev[key] ?? 0;
        const blob = await fetchCollectionImageBlob(collectionId, storageRole, filename, rev);
        const originalFile = new File([blob], filename || 'image', {
          type: blob.type || 'application/octet-stream',
        });
        const imageObjectUrl = URL.createObjectURL(blob);
        setAiEraseModal({
          collectionId,
          storageRole: storageRole as 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg',
          role,
          index,
          key,
          imageObjectUrl,
          filename,
          label,
          originalFile,
          canUndo: false,
          provider: aiEraseProvider,
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '加载图片失败');
      } finally {
        setAiEraseLoadingKey(null);
      }
    },
    [fetchCollectionImageBlob, thumbRev, aiEraseProvider]
  );

  const openRepairModal = useCallback(
    async (
      collectionId: number,
      storageRole: Parameters<typeof fetchCollectionImageBlob>[1],
      filename: string,
      role: 'main' | 'gallery',
      index: number,
      key: string,
      label: string
    ) => {
      if (storageRole === 'detail') return;
      if (storageRole !== 'main' && storageRole !== 'gallery' && storageRole !== 'main_nobg' && storageRole !== 'gallery_nobg') {
        return;
      }
      setRepairLoadingKey(key);
      setErr('');
      try {
        const rev = thumbRev[key] ?? 0;
        const blob = await fetchCollectionImageBlob(collectionId, storageRole, filename, rev);
        const originalFile = new File([blob], filename || 'image', {
          type: blob.type || 'application/octet-stream',
        });
        const imageObjectUrl = URL.createObjectURL(blob);
        setRepairModal({
          collectionId,
          storageRole,
          role,
          index,
          key,
          imageObjectUrl,
          filename,
          label,
          originalFile,
          canUndo: false,
        });
      } catch (e) {
        setErr(e instanceof Error ? e.message : '加载图片失败');
      } finally {
        setRepairLoadingKey(null);
      }
    },
    [fetchCollectionImageBlob, thumbRev]
  );

  useLayoutEffect(() => {
    if (!thumbMenu) {
      setThumbMenuPos(null);
      return;
    }
    const el = thumbMenuRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;

    // Prefer showing beside the selected thumb. Clamp into viewport.
    const a = thumbMenu.anchorRect;
    let left = a.right + margin;
    if (left + w > window.innerWidth - margin) left = a.left - margin - w;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - w));

    let top = a.top;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - h));
    setThumbMenuPos({
      left,
      top,
    });
  }, [thumbMenu]);

  useEffect(() => {
    if (!thumbMenu) return;
    const onDown = (e: MouseEvent) => {
      if (thumbMenuRef.current && !thumbMenuRef.current.contains(e.target as Node)) {
        setThumbMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThumbMenu(null);
    };
    const onScroll = () => setThumbMenu(null);
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [thumbMenu]);

  const handleDropReplace = useCallback(
    async (opts: {
      targetCollectionId: number;
      targetRole: 'main' | 'gallery';
      targetIndex: number;
      targetStorageRole: 'main' | 'gallery' | 'main_nobg' | 'gallery_nobg';
      targetFilename: string;
      targetKey: string;
      dt: DataTransfer | null;
    }) => {
      const dt = opts.dt;
      if (!dt) return;

      // 主图/副图互拖：仅允许跨分区（main <-> gallery），行为为“替换目标”，不互换；且不允许各自内部排序
      let slotRaw = '';
      try {
        slotRaw = dt.getData(DRAG_SLOT_MIME) || '';
      } catch {
        slotRaw = '';
      }
      if (!slotRaw) {
        try {
          const t = String(dt.getData('text/plain') || '');
          if (t.startsWith(DRAG_SLOT_TEXT_PREFIX)) slotRaw = t.slice(DRAG_SLOT_TEXT_PREFIX.length);
        } catch {
          /* ignore */
        }
      }
      if (!slotRaw && slotDragPayloadRef.current) {
        slotRaw = JSON.stringify(slotDragPayloadRef.current);
      }
      if (slotRaw) {
        let payload: unknown = null;
        try {
          payload = JSON.parse(slotRaw);
        } catch {
          payload = null;
        }
        if (
          payload &&
          typeof payload === 'object' &&
          'collectionId' in payload &&
          'role' in payload &&
          'index' in payload &&
          'storageRole' in payload &&
          'filename' in payload
        ) {
          const p = payload as {
            collectionId: unknown;
            role: unknown;
            index: unknown;
            storageRole: unknown;
            filename: unknown;
          };
          const sourceCollectionId = Number(p.collectionId);
          const sourceRole = String(p.role || '').trim() as 'main' | 'gallery';
          const sourceIndex = Number(p.index);
          const sourceStorageRole = String(p.storageRole || '').trim() as
            | 'main'
            | 'gallery'
            | 'main_nobg'
            | 'gallery_nobg';
          const sourceFilename = String(p.filename || '').trim();
          if (
            Number.isInteger(sourceCollectionId) &&
            sourceCollectionId > 0 &&
            (sourceRole === 'main' || sourceRole === 'gallery') &&
            Number.isInteger(sourceIndex) &&
            sourceIndex >= 0 &&
            (sourceStorageRole === 'main' ||
              sourceStorageRole === 'gallery' ||
              sourceStorageRole === 'main_nobg' ||
              sourceStorageRole === 'gallery_nobg') &&
            sourceFilename
          ) {
            // 必须同一采集记录内互换
            if (sourceCollectionId !== opts.targetCollectionId) return;
            // 禁止同分区内部拖动排序
            if (sourceRole === opts.targetRole) return;

            const targetKey = opts.targetKey;

            setErr('');
            try {
              const sourceKey = `${sourceCollectionId}-${sourceRole}-${sourceIndex}`;
              const sourceRev = thumbRev[sourceKey] ?? 0;
              const sourceBlob = await fetchCollectionImageBlob(
                sourceCollectionId,
                sourceStorageRole,
                sourceFilename,
                sourceRev
              );
              const sourceFile = new File([sourceBlob], sourceFilename || 'source-image', {
                type: sourceBlob.type || 'application/octet-stream',
              });

              // 替换目标槽位：源槽位保持不变（符合“拖动替换”直觉）
              await replaceImageForStorageRole(
                opts.targetCollectionId,
                opts.targetStorageRole,
                opts.targetIndex,
                sourceFile,
                targetKey
              );

              toastSuccess('已替换目标槽位图片', '替换完成');
              return;
            } catch (e) {
              setErr(e instanceof Error ? e.message : '替换失败');
              return;
            }
          }
        }
      }

      const localFile = dt.files?.[0];
      if (localFile) {
        await handleThumbReplace(
          opts.targetCollectionId,
          opts.targetRole,
          opts.targetIndex,
          localFile,
          opts.targetKey
        );
        return;
      }

      const raw = dt.getData(DRAG_DETAIL_MIME);
      if (!raw) return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('collectionId' in payload) ||
        !('filename' in payload)
      ) {
        return;
      }
      const p = payload as { collectionId: unknown; filename: unknown };
      const sourceCollectionId = Number(p.collectionId);
      const sourceFilename = String(p.filename || '').trim();
      if (!Number.isFinite(sourceCollectionId) || sourceCollectionId <= 0) return;
      if (!sourceFilename) return;

      const blob = await fetchCollectionImageBlob(sourceCollectionId, 'detail', sourceFilename);
      const file = new File([blob], sourceFilename || 'detail-image', {
        type: blob.type || 'application/octet-stream',
      });

      await handleThumbReplace(
        opts.targetCollectionId,
        opts.targetRole,
        opts.targetIndex,
        file,
        opts.targetKey
      );
    },
    [fetchCollectionImageBlob, handleThumbReplace, replaceImageForStorageRole, thumbRev]
  );

  const handleGalleryAppendDrop = useCallback(
    async (opts: { collectionId: number; dt: DataTransfer | null; remaining: number }) => {
      const dt = opts.dt;
      if (!dt) return;
      if (opts.remaining <= 0) return;

      setErr('');
      try {
        // 本地文件拖入：支持多文件，按剩余槽位截断
        const files = Array.from(dt.files || []).filter(Boolean);
        if (files.length) {
          const take = files.slice(0, Math.max(0, opts.remaining));
          for (const f of take) {
            await api.appendCollectionGalleryImage(opts.collectionId, { file: f });
          }
          await load();
          toastSuccess(`成功新增 ${take.length} 张副图`, '新增完成');
          window.dispatchEvent(
            new CustomEvent('collection-images-updated', { detail: { collectionId: opts.collectionId } })
          );
          return;
        }

        // 详情图拖入：单张
        const raw = dt.getData(DRAG_DETAIL_MIME);
        if (!raw) return;
        let payload: unknown = null;
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = null;
        }
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('collectionId' in payload) ||
          !('filename' in payload)
        ) {
          return;
        }
        const p = payload as { collectionId: unknown; filename: unknown };
        const sourceCollectionId = Number(p.collectionId);
        const sourceFilename = String(p.filename || '').trim();
        if (!Number.isFinite(sourceCollectionId) || sourceCollectionId <= 0) return;
        if (!sourceFilename) return;

        const blob = await fetchCollectionImageBlob(sourceCollectionId, 'detail', sourceFilename);
        const file = new File([blob], sourceFilename || 'detail-image', {
          type: blob.type || 'application/octet-stream',
        });

        await api.appendCollectionGalleryImage(opts.collectionId, { file });
        await load();
        toastSuccess('成功新增 1 张副图', '新增完成');
        window.dispatchEvent(
          new CustomEvent('collection-images-updated', { detail: { collectionId: opts.collectionId } })
        );
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : '新增副图失败');
      }
    },
    [fetchCollectionImageBlob, load]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <DetailPreviewLightbox state={detailLightbox} onClose={() => setDetailLightbox(null)} />
      {lightbox ? (
        <ImagesInlineLightbox
          state={lightbox}
          data={data as any}
          blobRegisterRef={blobRegisterRef}
          thumbRev={thumbRev}
          setThumbRev={setThumbRev}
          onClose={() => setLightbox(null)}
          fetchCollectionImageBlob={fetchCollectionImageBlob as any}
          replaceImageForStorageRole={replaceImageForStorageRole as any}
          load={load}
          credits={lightboxCredits}
          refreshCredits={refreshLightboxCredits}
        />
      ) : null}
      {cropModal ? (
        <ImageCropModal
          open
          imageUrl={cropModal.imageObjectUrl}
          originalFilename={cropModal.filename}
          title={`裁剪 · 采集 #${cropModal.collectionId} · ${cropModal.label}`}
          onClose={closeCropModal}
          canUndo={cropModal.canUndo}
          onUndo={async () => {
            const m = cropModal;
            if (!m) return;
            await replaceImageForStorageRole(m.collectionId, m.storageRole, m.index, m.originalFile, m.key);
            const newUrl = URL.createObjectURL(m.originalFile);
            setCropModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return {
                ...prev,
                filename: m.originalFile.name || prev.filename,
                imageObjectUrl: newUrl,
                canUndo: false,
              };
            });
            toastSuccess('已撤销本次裁剪', '撤销完成');
          }}
          onConfirm={async (file) => {
            const m = cropModal;
            if (!m) return;
            await replaceImageForStorageRole(m.collectionId, m.storageRole, m.index, file, m.key);
            const newUrl = URL.createObjectURL(file);
            setCropModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return {
                ...prev,
                filename: file.name || prev.filename,
                imageObjectUrl: newUrl,
                canUndo: true,
              };
            });
            toastSuccess('裁剪完成', '操作完成');
          }}
        />
      ) : null}
      {aiEraseModal ? (
        <ImageAiEraseModal
          open
          imageUrl={aiEraseModal.imageObjectUrl}
          originalFilename={aiEraseModal.filename}
          title={`AI 消除 · 采集 #${aiEraseModal.collectionId} · ${aiEraseModal.label}`}
          onClose={closeAiEraseModal}
          lastProviderLabel={aiEraseModal.lastProviderLabel}
          provider={aiEraseModal.provider || aiEraseProvider}
          onProviderChange={(p) => {
            setAiEraseProvider(p);
            setAiEraseModal((prev) => (prev ? { ...prev, provider: p } : prev));
          }}
          canUndo={aiEraseModal.canUndo}
          onUndo={async () => {
            const m = aiEraseModal;
            if (!m) return;
            await replaceImageForStorageRole(m.collectionId, m.storageRole, m.index, m.originalFile, m.key);
            const newUrl = URL.createObjectURL(m.originalFile);
            setAiEraseModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return {
                ...prev,
                filename: m.originalFile.name || prev.filename,
                imageObjectUrl: newUrl,
                canUndo: false,
                lastProviderLabel: undefined,
              };
            });
            toastSuccess('已撤销本次 AI 消除', '撤销完成');
          }}
          onConfirm={async (maskPng) => {
            setErr('');
            const m = aiEraseModal;
            if (!m) return;
            const { filename: outFilename, provider } = await api.aiEraseCollectionImage(m.collectionId, {
              storageRole: m.storageRole,
              index: m.index,
              mask: maskPng,
              provider: m.provider || aiEraseProvider,
            });
            const nextRev = (thumbRev[m.key] ?? 0) + 1;
            const blob = await fetchCollectionImageBlob(m.collectionId, m.storageRole, outFilename, nextRev);
            const newUrl = URL.createObjectURL(blob);
            const providerLabel =
              provider === 'dashscope'
                ? '百炼'
                : provider === 'volc'
                  ? '火山'
                  : provider === 'tencent'
                    ? '腾讯'
                    : provider === 'stability'
                      ? 'Stability'
                      : '';
            setAiEraseModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return {
                ...prev,
                filename: outFilename,
                imageObjectUrl: newUrl,
                canUndo: true,
                lastProviderLabel: providerLabel || undefined,
              };
            });
            setThumbRev((r) => ({
              ...r,
              [m.key]: nextRev,
            }));
            await load();
            toastSuccess('AI 消除完成', '操作完成');
            window.dispatchEvent(
              new CustomEvent('collection-images-updated', {
                detail: { collectionId: m.collectionId },
              })
            );
          }}
        />
      ) : null}
      {repairModal ? (
        <ImageRepairModal
          open
          imageUrl={repairModal.imageObjectUrl}
          originalFilename={repairModal.filename}
          title={`图像修复 · 采集 #${repairModal.collectionId} · ${repairModal.label}`}
          onClose={closeRepairModal}
          canUndo={repairModal.canUndo}
          onUndo={async () => {
            const m = repairModal;
            if (!m) return;
            await replaceImageForStorageRole(m.collectionId, m.storageRole, m.index, m.originalFile, m.key);
            const newUrl = URL.createObjectURL(m.originalFile);
            setRepairModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return {
                ...prev,
                filename: m.originalFile.name || prev.filename,
                imageObjectUrl: newUrl,
                canUndo: false,
              };
            });
            toastSuccess('已撤销本次图像修复', '撤销完成');
          }}
          onConfirm={async (rectangle) => {
            setErr('');
            const m = repairModal;
            if (!m) return;
            const { filename: outFilename } = await api.repairCollectionImage(m.collectionId, {
              storageRole: m.storageRole,
              index: m.index,
              rectangle,
            });
            const nextRev = (thumbRev[m.key] ?? 0) + 1;
            const blob = await fetchCollectionImageBlob(m.collectionId, m.storageRole, outFilename, nextRev);
            const newUrl = URL.createObjectURL(blob);
            setRepairModal((prev) => {
              if (!prev) {
                URL.revokeObjectURL(newUrl);
                return prev;
              }
              if (prev.imageObjectUrl) URL.revokeObjectURL(prev.imageObjectUrl);
              return { ...prev, filename: outFilename, imageObjectUrl: newUrl, canUndo: true };
            });
            setThumbRev((r) => ({
              ...r,
              [m.key]: nextRev,
            }));
            await load();
            toastSuccess('图像修复完成', '操作完成');
            window.dispatchEvent(
              new CustomEvent('collection-images-updated', {
                detail: { collectionId: m.collectionId },
              })
            );
          }}
        />
      ) : null}
      {thumbMenu
        ? createPortal(
            <div
              ref={thumbMenuRef}
              role="menu"
              aria-label="图片操作"
              className="app-context-menu fixed z-[250] inline-flex w-max max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl p-1.5"
              style={{
                left: thumbMenuPos?.left ?? thumbMenu.anchorRect.right + 8,
                top: thumbMenuPos?.top ?? thumbMenu.anchorRect.top,
              }}
            >
          <button
            type="button"
            role="menuitem"
            className="app-context-item flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              const m = thumbMenu;
              setThumbMenu(null);
              if (m.role === 'main') openMainLightbox(m.collectionId, m.slotIndex);
              else openGalleryLightbox(m.collectionId, m.slotIndex);
            }}
          >
            <IconThumbMenuCrop className="h-4 w-4 shrink-0 text-slate-500" />
            <span>编辑</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={downloadingKey === thumbMenu.key}
            className="app-context-item flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              const k = thumbMenu.key;
              const cid = thumbMenu.collectionId;
              const sr = thumbMenu.storageRole;
              const fn = thumbMenu.filename;
              setThumbMenu(null);
              void downloadCollectionImage(cid, sr, fn, k);
            }}
          >
            <IconThumbMenuDownload className="h-4 w-4 shrink-0 text-slate-500" />
            <span>{downloadingKey === thumbMenu.key ? '下载中…' : '下载'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              thumbMenu.imagesStatus !== 'done' ||
              thumbMenu.imagesLength === 0 ||
              nobgInFlight.has(`${thumbMenu.collectionId}:${thumbMenu.role}:${thumbMenu.index}`)
            }
            className="app-context-item flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              thumbMenu.imagesStatus !== 'done'
                ? '图片未下载完成，无法去背景'
                : thumbMenu.imagesLength === 0
                  ? '无本地图片文件，无法去背景'
                  : '对当前图片槽位执行去背景'
            }
            onClick={async () => {
              const nk = `${thumbMenu.collectionId}:${thumbMenu.role}:${thumbMenu.index}`;
              const cid = thumbMenu.collectionId;
              const r = thumbMenu.role;
              const idx = thumbMenu.index;
              setThumbMenu(null);
              setNobgInFlight((prev) => new Set(prev).add(nk));
              setErr('');
              try {
                await api.removeCollectionBackgroundOne(cid, { role: r, index: idx });
                await load();
              } catch (ex) {
                setErr(ex instanceof Error ? ex.message : '去背景触发失败');
              } finally {
                setNobgInFlight((prev) => {
                  const next = new Set(prev);
                  next.delete(nk);
                  return next;
                });
              }
            }}
          >
            <IconThumbMenuRemoveBg className="h-4 w-4 shrink-0 text-slate-500" />
            <span>
              {nobgInFlight.has(`${thumbMenu.collectionId}:${thumbMenu.role}:${thumbMenu.index}`)
                ? '去背景中…'
                : '去背景'}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="app-context-item flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700"
            onClick={() => {
              void navigator.clipboard
                .writeText(thumbMenu.copyPublicUrl)
                .then(() => toastSuccess('图片地址已复制到剪贴板', '复制成功'))
                .catch(() => setErr('复制失败'));
              setThumbMenu(null);
            }}
          >
            <IconThumbMenuLink className="h-4 w-4 shrink-0 text-slate-500" />
            <span>复制地址</span>
          </button>
            </div>,
            document.body
          )
        : null}
      <input
        ref={folderPickRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        aria-hidden
        // @ts-expect-error webkitdirectory is non-standard but supported in Chromium
        webkitdirectory="true"
        multiple
        onChange={async (e) => {
          const id = pendingFolderUploadRef.current;
          pendingFolderUploadRef.current = null;
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!id || files.length === 0) return;
          const picked = files.map((f) => ({ file: f, rel: (f as any).webkitRelativePath || f.name }));
          await handleGroupUpload(id, picked, data?.rows.find((r) => r.collectionId === id)?.imagesStorage);
        }}
      />
      <input
        ref={filesPickRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        aria-hidden
        multiple
        onChange={async (e) => {
          const id = pendingFilesUploadRef.current;
          pendingFilesUploadRef.current = null;
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!id || files.length === 0) return;
          const picked = files.map((f) => ({ file: f, rel: (f as any).webkitRelativePath || f.name }));
          await handleGroupUpload(id, picked, data?.rows.find((r) => r.collectionId === id)?.imagesStorage);
        }}
      />
      <div className="shrink-0 space-y-2">
        <h1 className="text-lg font-semibold text-slate-800">图片资源管理</h1>

      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {user.role === 'admin' && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <span className="text-slate-500">用户</span>
            <CustomSelect
              value={userIdFilter === '' ? '' : String(userIdFilter)}
              onChange={(v) => {
                setPage(1);
                setUserIdFilter(v === '' ? '' : Number(v));
              }}
              options={[
                { value: '', label: '全部' },
                ...users.map((u) => ({ value: String(u.id), label: u.username })),
              ]}
              className="min-w-[8rem]"
              buttonClassName="flex h-9 w-full min-w-[8rem] items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => load()}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          刷新
        </button>
        <Link
          to="/collections"
          className="text-sm font-medium text-teal-700 underline decoration-teal-200 underline-offset-2 hover:decoration-teal-600"
        >
          前往采集数据管理
        </Link>
      </div>

      {/* errors are shown as toasts (top-right) */}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!data ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : data.rows.length === 0 ? (
          <p className="text-sm text-slate-500">暂无采集记录。</p>
        ) : (
          <div className="flex flex-col gap-6">
            {data.rows.map((row) => {
              const mains = row.images.filter(
                (i): i is (typeof row.images)[number] & { role: 'main' } => i.role === 'main'
              );
              const gals = row.images.filter(
                (i): i is (typeof row.images)[number] & { role: 'gallery' } => i.role === 'gallery'
              );
              const dets = row.images.filter(
                (i): i is (typeof row.images)[number] & { role: 'detail' } => i.role === 'detail'
              );
              const canDropGroup =
                row.imagesNobgStatus === 'done' && row.images.length > 0;
              const isDragTarget = dragOverCollectionId === row.collectionId && canDropGroup;
              return (
              <article
                key={row.collectionId}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-[box-shadow,border-color,background-color]"
              >
                <header className="mb-3 flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-slate-800">{row.title}</h2>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-slate-500">
                      <UploadFolderIdHighlight id={row.collectionId} withHash />
                      <span className="text-slate-400">·</span>
                      <span>{row.platform || '—'}</span>
                      <span className="text-slate-400">·</span>
                      <span>{formatCstDisplay(row.collectedAt)}</span>
                      {row.username ? (
                        <>
                          <span className="text-slate-400">·</span>
                          <span>{row.username}</span>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    <div
                      className="flex items-center gap-2 rounded-full border border-white/80 bg-white/60 px-2 py-1 shadow-sm ring-1 ring-teal-900/5 backdrop-blur"
                      title={`采集 #${row.collectionId}，与「编辑采集」窗口标记一致`}
                    >
                      <span className="rounded-full bg-teal-50/85 px-2 py-1 text-[11px] font-semibold leading-none tracking-wide text-teal-800 ring-1 ring-teal-100">
                        标记
                      </span>
                      <CustomSelect
                        value={row.userMark ?? ''}
                        onChange={(v) => void setRowUserMark(row.collectionId, v)}
                        options={[
                          { value: '', label: '未标记', dotClass: 'bg-slate-200' },
                          ...USER_MARK_OPTIONS.map((o) => ({
                            value: o.value,
                            label: o.label,
                            dotClass: o.dotClass,
                          })),
                        ]}
                        disabled={
                          markSavingId === row.collectionId ||
                          row.aiPostStatus === 'pending'
                        }
                        aria-label={`标记（采集 ${row.collectionId}）`}
                        className="!w-[7rem] max-w-[7rem] shrink-0 min-w-0"
                        buttonClassName={`flex h-8 w-full cursor-pointer items-center justify-center gap-1 rounded-full border bg-white/80 px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${markBorderClass(
                          row.userMark
                        )}`}
                      />
                    </div>
                    <StatusPill status={row.imagesStatus} error={row.imagesError} />
                    <NobgStatusPill status={row.imagesNobgStatus ?? null} />
                    <button
                      type="button"
                      disabled={retryingDownloadId === row.collectionId}
                      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      title="重新从商品数据中的主图/副图链接下载（单次拉取有超时；失败或卡住时点此重试）"
                      onClick={async () => {
                        setRetryingDownloadId(row.collectionId);
                        setErr('');
                        try {
                          await api.retryCollectionImagesDownload(row.collectionId);
                          await load();
                        } catch (ex) {
                          setErr(ex instanceof Error ? ex.message : '再次下载失败');
                        } finally {
                          setRetryingDownloadId(null);
                        }
                      }}
                    >
                      {retryingDownloadId === row.collectionId ? '下载中…' : '再次下载'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        groupDownloadingId === row.collectionId ||
                        row.imagesStatus !== 'done' ||
                        row.images.length === 0 ||
                        row.imagesNobgStatus !== 'done'
                      }
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      title="下载该采集记录的整组去背景图片（zip 结构与勾选导出含图片一致）"
                      onClick={async () => {
                        setGroupDownloadingId(row.collectionId);
                        setErr('');
                        try {
                          const blob = await api.downloadCollectionImagesZip(row.collectionId, {
                            nobg: true,
                          });
                          const name = safeFilename(
                            `采集_${row.collectionId}_图片_${formatCstDisplay(row.collectedAt).replace(/[:]/g, '-')}.zip`
                          );
                          downloadBlob(blob, name || `collection_${row.collectionId}.zip`);
                        } catch (ex) {
                          setErr(ex instanceof Error ? ex.message : '下载失败');
                        } finally {
                          setGroupDownloadingId(null);
                        }
                      }}
                    >
                      {groupDownloadingId === row.collectionId ? '打包中…' : '下载整组'}
                    </button>
                    <button
                      type="button"
                      disabled={
                        row.imagesStatus !== 'done' ||
                        row.images.length === 0 ||
                        row.imagesNobgStatus === 'done' ||
                        nobgInFlight.has(String(row.collectionId))
                      }
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      title={
                        row.imagesStatus !== 'done'
                          ? '图片未下载完成，无法去背景'
                          : row.images.length === 0
                            ? '无本地图片文件，无法去背景'
                            : row.imagesNobgStatus === 'done'
                              ? '已去背景'
                              : '对已下载图片执行去背景（可用于手动补跑）'
                      }
                      onClick={async () => {
                        const rk = String(row.collectionId);
                        setNobgInFlight((prev) => new Set(prev).add(rk));
                        setErr('');
                        try {
                          await api.removeCollectionBackground(row.collectionId);
                          await load();
                        } catch (ex) {
                          setErr(ex instanceof Error ? ex.message : '去背景触发失败');
                        } finally {
                          setNobgInFlight((prev) => {
                            const next = new Set(prev);
                            next.delete(rk);
                            return next;
                          });
                        }
                      }}
                    >
                      {nobgInFlight.has(String(row.collectionId)) ? '去背景中…' : '去背景'}
                    </button>
                  </div>
                </header>

                {row.images.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    {row.imagesStatus === 'done'
                      ? '无本地下载文件（清单为空）。'
                      : '图片尚未下载完成，请稍后在采集管理中查看状态。若因网络等原因失败，服务端约 30 秒后会自动重试（有次数上限）；单张图拉取有超时以免队列卡死。也可点上方「再次下载」手动重试。'}
                  </p>
                ) : (
                  <div className="space-y-5">
                    <div
                      className={
                        isDragTarget
                          ? 'rounded-xl border-2 border-dashed border-teal-400 bg-teal-50/60 p-3 text-sm text-slate-700 shadow-sm ring-2 ring-teal-300/60 ring-offset-2 transition-[border-color,background-color,box-shadow]'
                          : 'rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-700 transition-[border-color,background-color,box-shadow]'
                      }
                      onDragEnter={(e) => {
                        if (!isFileDrag(e.dataTransfer)) return;
                        e.preventDefault();
                        if (canDropGroup) setDragOverCollectionId(row.collectionId);
                      }}
                      onDragLeave={(e) => {
                        if (!isFileDrag(e.dataTransfer)) return;
                        const next = e.relatedTarget as Node | null;
                        if (!next || !e.currentTarget.contains(next)) {
                          setDragOverCollectionId((id) => (id === row.collectionId ? null : id));
                        }
                      }}
                      onDragOverCapture={(e) => {
                        if (!isFileDrag(e.dataTransfer)) return;
                        e.preventDefault();
                        if (canDropGroup) {
                          e.dataTransfer.dropEffect = 'copy';
                        } else {
                          e.dataTransfer.dropEffect = 'none';
                        }
                      }}
                      onDropCapture={async (e) => {
                        if (!isFileDrag(e.dataTransfer)) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverCollectionId(null);
                        if (groupUploadingId != null) return;
                        if (row.imagesNobgStatus !== 'done') {
                          setErr(
                            '该记录尚未完成去背景：请先点击「去背景」完成后，再下载/上传 main-nobg 与 gallery-nobg。'
                          );
                          return;
                        }
                        if (row.images.length === 0) return;
                        const picked = await getFilesFromDataTransfer(e.dataTransfer);
                        await handleGroupUpload(row.collectionId, picked, row.imagesStorage);
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-700">拖拽 / 选择上传（替换去背景图）</p>
                          <p className="mt-1 text-xs text-slate-500">
                            文件夹上传：请使用文件夹名为{' '}
                            <UploadFolderIdHighlight id={row.collectionId} />
                            的目录。路径示例{' '}
                            <span className="inline align-middle rounded bg-slate-100 px-1 py-px font-mono text-[11px] text-slate-800">
                              images/{row.collectionId}
                            </span>
                            。也可拖入/选择
                            <strong className="font-medium text-slate-600">单个/多个图片文件</strong>
                            ，<strong className="font-medium text-slate-600">对此组同名文件</strong>
                            匹配替换。
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            disabled={groupUploadingId === row.collectionId}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => {
                              pendingFilesUploadRef.current = row.collectionId;
                              filesPickRef.current?.click();
                            }}
                          >
                            {groupUploadingId === row.collectionId ? '上传中…' : '选择文件'}
                          </button>
                          <button
                            type="button"
                            disabled={groupUploadingId === row.collectionId}
                            title={`选择名为「${row.collectionId}」的文件夹上传`}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => {
                              pendingFolderUploadRef.current = row.collectionId;
                              folderPickRef.current?.click();
                            }}
                          >
                            {groupUploadingId === row.collectionId ? '上传中…' : '选择文件夹'}
                          </button>
                        </div>
                      </div>
                    </div>
                    {(
                      [
                        { sectionTitle: '主图', list: mains },
                        { sectionTitle: '副图', list: gals },
                      ] as const
                    ).map(({ sectionTitle, list }) => {
                      if (list.length === 0) return null;
                      const regKey = `${row.collectionId}-${sectionTitle === '主图' ? 'main' : 'gallery'}`;
                      const prev = blobRegisterRef.current.get(regKey);
                      if (!prev || prev.length !== list.length) {
                        blobRegisterRef.current.set(regKey, new Array(list.length).fill(''));
                      }
                      return (
                        <div key={sectionTitle}>
                          <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-600">
                            {sectionTitle}
                          </h3>
                          <ul className="flex flex-wrap gap-3">
                            {list.map((img, i) => {
                              const abs = absoluteApiUrl(
                                collectionImageApiPath(
                                  row.collectionId,
                                  img.storageRole,
                                  img.filename
                                )
                              );
                              /** 优先接口 publicUrl；无则 VITE。HTTPS 管理站 + http OSS 直链时缩略图不走直链（见 preferApiFetchOverHttpDirectThumb），避免浏览器把请求升级为 https */
                              const clientOssUrl = ossPublicUrlForCollectionImage(
                                row.collectionId,
                                img.storageRole,
                                img.filename
                              );
                              const serverPublicUrl =
                                typeof img.publicUrl === 'string' && img.publicUrl.trim()
                                  ? img.publicUrl.trim()
                                  : '';
                              const previewPublicUrl = serverPublicUrl || clientOssUrl;
                              const copyPublicUrl = previewPublicUrl || abs;
                              const thumbDirectUrl =
                                previewPublicUrl &&
                                !preferApiFetchOverHttpDirectThumb(previewPublicUrl)
                                  ? previewPublicUrl
                                  : undefined;
                              const key = `${row.collectionId}-${img.role}-${img.index}`;
                              const colorDimmed =
                                img.role === 'main' &&
                                Array.isArray(row.colorExportChecked) &&
                                row.colorExportChecked?.[img.index] === false;
                              const openThumbMenuAt = (anchorEl: HTMLElement) => {
                                const r = anchorEl.getBoundingClientRect();
                                setThumbMenu({
                                  anchorRect: {
                                    left: r.left,
                                    top: r.top,
                                    right: r.right,
                                    bottom: r.bottom,
                                    width: r.width,
                                    height: r.height,
                                  },
                                  collectionId: row.collectionId,
                                  storageRole: img.storageRole,
                                  filename: img.filename,
                                  role: img.role,
                                  index: img.index,
                                  slotIndex: i,
                                  key,
                                  copyPublicUrl,
                                  sectionLabel: `${sectionTitle} #${i + 1}`,
                                  imagesStatus: row.imagesStatus,
                                  imagesLength: row.images.length,
                                });
                              };

                              return (
                                <li
                                  key={key}
                                  className={
                                    dragOverThumbKey === key
                                      ? 'flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2 ring-2 ring-teal-300/70 ring-offset-2'
                                      : 'flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2'
                                  }
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    if (colorDimmed) {
                                      setErr('该主图对应的颜色已在采集编辑中取消勾选：此处仅灰显展示，不允许替换/编辑等操作。');
                                      return;
                                    }
                                    openThumbMenuAt(e.currentTarget as HTMLElement);
                                  }}
                                  onDragEnter={(e) => {
                                    // 主/副图跨区拖拽：同区内部应显示禁止符号（不 preventDefault）
                                    if (slotDragPayloadRef.current && slotDragPayloadRef.current.role === img.role) {
                                      return;
                                    }
                                    if (
                                      !isFileDrag(e.dataTransfer) &&
                                      !isDetailImageDrag(e.dataTransfer) &&
                                      !isSlotImageDrag(e.dataTransfer)
                                    )
                                      return;
                                    if (colorDimmed) return;
                                    e.preventDefault();
                                    setDragOverThumbKey(key);
                                  }}
                                  onDragLeave={(e) => {
                                    if (slotDragPayloadRef.current && slotDragPayloadRef.current.role === img.role) {
                                      return;
                                    }
                                    if (
                                      !isFileDrag(e.dataTransfer) &&
                                      !isDetailImageDrag(e.dataTransfer) &&
                                      !isSlotImageDrag(e.dataTransfer)
                                    )
                                      return;
                                    if (colorDimmed) return;
                                    const next = e.relatedTarget as Node | null;
                                    if (!next || !e.currentTarget.contains(next)) {
                                      setDragOverThumbKey((k) => (k === key ? null : k));
                                    }
                                  }}
                                  onDragOverCapture={(e) => {
                                    // 同区内部拖动：不允许 drop，保留浏览器“禁止”提示
                                    if (slotDragPayloadRef.current && slotDragPayloadRef.current.role === img.role) {
                                      return;
                                    }
                                    if (
                                      !isFileDrag(e.dataTransfer) &&
                                      !isDetailImageDrag(e.dataTransfer) &&
                                      !isSlotImageDrag(e.dataTransfer) &&
                                      !slotDragPayloadRef.current
                                    )
                                      return;
                                    if (colorDimmed) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect =
                                      slotDragPayloadRef.current || isSlotImageDrag(e.dataTransfer) ? 'copy' : 'copy';
                                  }}
                                  onDropCapture={async (e) => {
                                    if (colorDimmed) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setDragOverThumbKey(null);
                                      setErr('该主图已灰显禁用：不允许拖拽替换。');
                                      return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverThumbKey(null);
                                        await handleDropReplace({
                                          targetCollectionId: row.collectionId,
                                          targetRole: img.role,
                                          targetIndex: img.index,
                                          targetStorageRole: img.storageRole as any,
                                          targetFilename: img.filename,
                                          targetKey: key,
                                          dt: e.dataTransfer,
                                        });
                                  }}
                                >
                                  <div
                                    className="shrink-0"
                                    draggable={!colorDimmed}
                                    title={
                                      colorDimmed
                                        ? '该主图已灰显禁用'
                                        : sectionTitle === '主图'
                                          ? '可拖到副图槽位替换（主图内部不支持排序）'
                                          : '可拖到主图槽位替换（副图内部不支持排序）'
                                    }
                                    onDragStart={(e) => {
                                      if (colorDimmed) return;
                                      e.dataTransfer.effectAllowed = 'copy';
                                      // 兼容性：部分浏览器/环境需要至少一个 text/plain 才会保留拖拽数据
                                      try {
                                        e.dataTransfer.setData(
                                          'text/plain',
                                          `${DRAG_SLOT_TEXT_PREFIX}${JSON.stringify({
                                            collectionId: row.collectionId,
                                            role: img.role,
                                            index: img.index,
                                            storageRole: img.storageRole,
                                            filename: img.filename,
                                          })}`
                                        );
                                      } catch {
                                        /* ignore */
                                      }
                                      e.dataTransfer.setData(
                                        DRAG_SLOT_MIME,
                                        JSON.stringify({
                                          collectionId: row.collectionId,
                                          role: img.role,
                                          index: img.index,
                                          storageRole: img.storageRole,
                                          filename: img.filename,
                                        })
                                      );
                                      slotDragPayloadRef.current = {
                                        collectionId: row.collectionId,
                                        role: img.role,
                                        index: img.index,
                                        storageRole: img.storageRole as any,
                                        filename: img.filename,
                                      };
                                    }}
                                  >
                                    <AuthenticatedImageThumb
                                      collectionId={row.collectionId}
                                      role={img.storageRole}
                                      filename={img.filename}
                                      url={thumbDirectUrl}
                                      sizeClass="h-16 w-16"
                                      className={colorDimmed ? 'pointer-events-none opacity-45 grayscale' : ''}
                                      rev={thumbRev[key] ?? 0}
                                      slotIndex={i}
                                      registerBlob={(index, url) => {
                                        const a = blobRegisterRef.current.get(regKey);
                                        if (a && index >= 0 && index < a.length) a[index] = url;
                                      }}
                                      onOpen={
                                        colorDimmed
                                          ? undefined
                                          : () =>
                                              sectionTitle === '主图'
                                                ? openMainLightbox(row.collectionId, i)
                                                : openGalleryLightbox(row.collectionId, i)
                                      }
                                    />
                                  </div>
                                </li>
                              );
                            })}
                            {sectionTitle === '副图' && list.length < 8 ? (
                              <li
                                key={`${row.collectionId}-gallery-add`}
                                className={
                                  dragOverThumbKey === `${row.collectionId}-gallery-add`
                                    ? 'flex items-center gap-2 rounded-lg border border-dashed border-teal-400 bg-teal-50/60 p-2 ring-2 ring-teal-300/70 ring-offset-2'
                                    : 'flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-white/70 p-2'
                                }
                                onDragEnter={(e) => {
                                  if (!isFileDrag(e.dataTransfer) && !isDetailImageDrag(e.dataTransfer)) return;
                                  e.preventDefault();
                                  setDragOverThumbKey(`${row.collectionId}-gallery-add`);
                                }}
                                onDragLeave={(e) => {
                                  if (!isFileDrag(e.dataTransfer) && !isDetailImageDrag(e.dataTransfer)) return;
                                  const next = e.relatedTarget as Node | null;
                                  if (!next || !e.currentTarget.contains(next)) {
                                    setDragOverThumbKey((k) =>
                                      k === `${row.collectionId}-gallery-add` ? null : k
                                    );
                                  }
                                }}
                                onDragOverCapture={(e) => {
                                  if (!isFileDrag(e.dataTransfer) && !isDetailImageDrag(e.dataTransfer)) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = 'copy';
                                }}
                                onDropCapture={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDragOverThumbKey(null);
                                  const remaining = Math.max(0, 8 - list.length);
                                  await handleGalleryAppendDrop({
                                    collectionId: row.collectionId,
                                    dt: e.dataTransfer,
                                    remaining,
                                  });
                                }}
                                title={`新增副图（最多 8 张，当前 ${list.length} 张）`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className="flex h-16 w-16 items-center justify-center rounded-md bg-slate-50 text-slate-400">
                                    <span className="select-none text-4xl leading-none">+</span>
                                  </div>
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold text-slate-700">新增副图</div>
                                    <div className="mt-0.5 text-[11px] text-slate-500">
                                      还可添加 {Math.max(0, 8 - list.length)} 张
                                    </div>
                                  </div>
                                </div>
                              </li>
                            ) : null}
                          </ul>
                        </div>
                      );
                    })}

                    {dets.length ? (
                      <details className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2">
                        <summary className="cursor-pointer select-none text-xs font-semibold tracking-wide text-slate-600">
                          详情图（已下载，仅展示，共 {dets.length} 张）
                        </summary>
                        <div className="mt-3">
                          {(() => {
                            const regKey = `${row.collectionId}-detail`;
                            const prev = blobRegisterRef.current.get(regKey);
                            if (!prev || prev.length !== dets.length) {
                              blobRegisterRef.current.set(regKey, new Array(dets.length).fill(''));
                            }
                            return (
                              <ul className="flex flex-wrap gap-3">
                                {dets.map((img, i) => {
                                  const clientOssUrl = ossPublicUrlForCollectionImage(
                                    row.collectionId,
                                    img.storageRole,
                                    img.filename
                                  );
                                  const serverPublicUrl =
                                    typeof img.publicUrl === 'string' && img.publicUrl.trim()
                                      ? img.publicUrl.trim()
                                      : '';
                                  const previewPublicUrl = serverPublicUrl || clientOssUrl;
                                  const thumbDirectUrl =
                                    previewPublicUrl && !preferApiFetchOverHttpDirectThumb(previewPublicUrl)
                                      ? previewPublicUrl
                                      : undefined;
                                  const key = `${row.collectionId}-${img.role}-${img.index}`;
                                  return (
                                    <li
                                      key={key}
                                      className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2"
                                    >
                                      <div
                                        draggable
                                        title="拖拽到主图/副图槽位以替换（文件名保持槽位不变，格式跟随详情图）"
                                        className="cursor-grab active:cursor-grabbing"
                                        onDragStart={(e) => {
                                          e.dataTransfer.effectAllowed = 'copy';
                                          e.dataTransfer.setData(
                                            DRAG_DETAIL_MIME,
                                            JSON.stringify({
                                              collectionId: row.collectionId,
                                              filename: img.filename,
                                            })
                                          );
                                        }}
                                      >
                                        <AuthenticatedImageThumb
                                          collectionId={row.collectionId}
                                          role={img.storageRole}
                                          filename={img.filename}
                                          url={thumbDirectUrl}
                                          sizeClass="h-16 w-16"
                                          rev={thumbRev[key] ?? 0}
                                          slotIndex={i}
                                          registerBlob={(index, url) => {
                                            const a = blobRegisterRef.current.get(regKey);
                                            if (a && index >= 0 && index < a.length) a[index] = url;
                                          }}
                                          onOpen={() => openDetailLightbox(row.collectionId, i)}
                                        />
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            );
                          })()}
                        </div>
                      </details>
                    ) : Array.isArray(row.detailImages) && row.detailImages.filter(Boolean).length ? (
                      <details className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2">
                        <summary className="cursor-pointer select-none text-xs font-semibold tracking-wide text-slate-600">
                          详情图（仅展示，共 {row.detailImages.filter(Boolean).length} 张）
                        </summary>
                        <div className="mt-3 flex flex-wrap gap-3">
                          {row.detailImages
                            .map((x) => String(x ?? '').trim())
                            .filter(Boolean)
                            .map((u, i, arr) => (
                              <ExternalThumb
                                key={`${i}-${u.slice(-24)}`}
                                url={u}
                                onOpen={() => setLightbox({ urls: arr, index: i })}
                              />
                            ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                )}
              </article>
              );
            })}
          </div>
        )}
      </div>

      {data && data.total > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-sm text-slate-600">
          <span>
            第 {data.page} / {totalPages} 页 · 共 {data.total} 条采集
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status, error }: { status: string; error: string | null }) {
  if (status === 'done') {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
        已下载
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        className="max-w-[14rem] truncate rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800"
        title={error || ''}
      >
        下载失败
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
      处理中
    </span>
  );
}

function NobgStatusPill({ status }: { status: string | null | undefined }) {
  const s = String(status || '');
  if (s === 'done') {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
        已去背景
      </span>
    );
  }
  if (s === 'failed') {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
        去背景失败
      </span>
    );
  }
  if (s === 'pending') {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
        去背景中
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      未去背景
    </span>
  );
}
