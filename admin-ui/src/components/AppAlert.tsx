import { type ReactNode } from 'react';

type Tone = 'error' | 'warning' | 'info' | 'success';

function Icon({ tone }: { tone: Tone }) {
  const common = 'h-4 w-4';
  const stroke =
    tone === 'error'
      ? 'text-rose-700'
      : tone === 'warning'
        ? 'text-amber-800'
        : tone === 'success'
          ? 'text-emerald-700'
          : 'text-sky-700';

  if (tone === 'success') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={`${common} ${stroke}`} aria-hidden>
        <path
          d="M16.25 5.75 8.5 13.5 3.75 8.75"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (tone === 'info') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={`${common} ${stroke}`} aria-hidden>
        <path
          d="M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path d="M10 9v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M10 6.5h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  if (tone === 'warning') {
    return (
      <svg viewBox="0 0 20 20" fill="none" className={`${common} ${stroke}`} aria-hidden>
        <path
          d="M10 2.75 18 17H2l8-14.25Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M10 7.5v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M10 14h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  // error
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${common} ${stroke}`} aria-hidden>
      <path
        d="M10 2.75 18 17H2l8-14.25Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M10 7.5v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M10 14h.01" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function AppAlert({
  tone = 'error',
  title,
  children,
  onClose,
  className = '',
  compact = false,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  onClose?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const box =
    tone === 'error'
      ? 'border-rose-200/80 bg-[radial-gradient(circle_at_18%_10%,rgba(244,63,94,0.14),transparent_46%),linear-gradient(180deg,rgba(255,241,242,0.92),rgba(255,255,255,0.86))] text-rose-950 ring-rose-200/55'
      : tone === 'warning'
        ? 'border-amber-200/80 bg-[radial-gradient(circle_at_18%_10%,rgba(245,158,11,0.14),transparent_46%),linear-gradient(180deg,rgba(255,251,235,0.92),rgba(255,255,255,0.86))] text-amber-950 ring-amber-200/55'
        : tone === 'success'
          ? 'border-emerald-200/80 bg-[radial-gradient(circle_at_18%_10%,rgba(16,185,129,0.14),transparent_46%),linear-gradient(180deg,rgba(236,253,245,0.92),rgba(255,255,255,0.86))] text-emerald-950 ring-emerald-200/55'
          : 'border-sky-200/80 bg-[radial-gradient(circle_at_18%_10%,rgba(56,189,248,0.16),transparent_46%),linear-gradient(180deg,rgba(240,249,255,0.92),rgba(255,255,255,0.86))] text-sky-950 ring-sky-200/55';

  const accent =
    tone === 'error'
      ? 'bg-gradient-to-b from-rose-500/55 via-rose-400/18 to-transparent'
      : tone === 'warning'
        ? 'bg-gradient-to-b from-amber-500/55 via-amber-400/18 to-transparent'
        : tone === 'success'
          ? 'bg-gradient-to-b from-emerald-500/55 via-emerald-400/18 to-transparent'
          : 'bg-gradient-to-b from-sky-500/55 via-sky-400/18 to-transparent';

  const iconBg =
    tone === 'error'
      ? 'bg-rose-100/80 ring-rose-200/70'
      : tone === 'warning'
        ? 'bg-amber-100/80 ring-amber-200/70'
        : tone === 'success'
          ? 'bg-emerald-100/80 ring-emerald-200/70'
          : 'bg-sky-100/80 ring-sky-200/70';

  const live = tone === 'error' ? 'assertive' : 'polite';

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={live}
      className={`app-page-enter relative flex items-start gap-3 overflow-hidden rounded-2xl border p-3 shadow-sm ring-1 backdrop-blur ${box} ${className}`}
    >
      <div className={`pointer-events-none absolute inset-y-0 left-0 w-1.5 ${accent}`} aria-hidden />
      <div
        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ${iconBg}`}
        aria-hidden
      >
        <Icon tone={tone} />
      </div>
      <div className={compact ? 'min-w-0 text-xs leading-relaxed' : 'min-w-0 text-sm leading-relaxed'}>
        {title ? <div className="font-semibold">{title}</div> : null}
        <div className={title ? 'mt-0.5 text-slate-700/90' : 'text-slate-700/90'}>{children}</div>
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-xl text-slate-500 transition hover:bg-black/5 hover:text-slate-700"
          aria-label="关闭提示"
          title="关闭"
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path
              d="M6 6l8 8M14 6l-8 8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
