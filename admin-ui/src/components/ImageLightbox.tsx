import { useEffect, useState } from 'react';

export type ImageLightboxState = { urls: string[]; index: number } | null;

export function ImageLightbox({
  state,
  onClose,
}: {
  state: ImageLightboxState;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (state) {
      const n = state.urls.length;
      setIdx(n ? Math.min(Math.max(0, state.index), n - 1) : 0);
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
    <div
      className="app-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-6"
      role="dialog"
      aria-modal
      aria-label="图片预览"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 z-[110] rounded-lg border border-white/70 bg-white/65 px-3 py-1.5 text-sm text-slate-700 shadow-sm backdrop-blur hover:bg-white/80"
        onClick={onClose}
      >
        关闭 (Esc)
      </button>
      {canNav ? (
        <button
          type="button"
          aria-label="上一张"
          disabled={!canPrev}
          className={`absolute left-3 top-1/2 z-[110] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:left-6 ${
            canPrev ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
          }`}
          onClick={(e) => {
            e.stopPropagation();
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
          className={`absolute right-3 top-1/2 z-[110] -translate-y-1/2 rounded-full border border-white/70 p-3 text-2xl leading-none text-slate-700 shadow-lg backdrop-blur-sm transition md:right-6 ${
            canNext ? 'bg-white/70 hover:bg-white/85' : 'cursor-not-allowed bg-white/35 opacity-35'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (!canNext) return;
            setIdx((i) => Math.min(state.urls.length - 1, i + 1));
          }}
        >
          ›
        </button>
      ) : null}
      <div
        className="max-h-[90vh] max-w-[min(100%,calc(100%-8rem))]"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <img
          src={src}
          alt="预览"
          className="max-h-[90vh] max-w-full rounded-lg object-contain shadow-2xl"
          referrerPolicy="no-referrer"
        />
      </div>
      {canNav ? (
        <div
          className="pointer-events-none absolute bottom-6 left-1/2 z-[110] -translate-x-1/2 rounded-full border border-white/70 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700 shadow-sm backdrop-blur"
          aria-hidden
        >
          {idx + 1} / {state.urls.length}
        </div>
      ) : null}
    </div>
  );
}
