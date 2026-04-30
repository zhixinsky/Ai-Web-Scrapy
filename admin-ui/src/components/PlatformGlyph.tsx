import type { ReactNode } from 'react';

function PlatformImage({ src, alt }: { src: string; alt: string }) {
  return (
    <span
      className="inline-flex h-8 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white px-2 shadow-sm ring-1 ring-slate-100"
      aria-hidden
    >
      <img src={src} alt={alt} className="h-6 w-full object-contain" loading="lazy" />
    </span>
  );
}

function normalizePlatformName(name: string) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function platformImageSrcForName(name: string): string | null {
  const lower = normalizePlatformName(name);
  if (!lower) return null;

  if (
    lower.includes('1688') ||
    lower.includes('阿里巴巴') ||
    lower.includes('alibaba') ||
    lower.includes('alibaba1688')
  ) {
    return '/alibaba.png';
  }
  if (lower.includes('速卖') || lower.includes('aliexpress') || lower.includes('ali express')) {
    return '/aliexpress.png';
  }
  if (lower.includes('亚马逊') || lower.includes('amazon')) {
    return '/amazon.png';
  }
  if (lower.includes('temu')) {
    return '/temu.png';
  }
  if (
    lower.includes('虾皮') ||
    lower.includes('shopee') ||
    lower.includes('shopify') ||
    lower.includes('shoppe')
  ) {
    return '/shopify.png';
  }
  if (lower.includes('lazada')) {
    return '/lazada.png';
  }
  if (lower.includes('tiktok') || lower.includes('tik tok') || lower.includes('tiktok shop')) {
    return '/tiktok.png';
  }
  if (lower.includes('ozon')) {
    return '/ozon.png';
  }

  return null;
}

/** 采集平台展示用图标（只显示已配置的 public 平台图片） */
export function PlatformGlyph({ name, className }: { name: string; className?: string }) {
  const el = platformGlyphForName(name);
  if (!el) return null;
  return (
    <span className={['inline-flex items-center justify-center', className].filter(Boolean).join(' ')}>{el}</span>
  );
}

/** 供 CustomSelect 等传入 `icon` 字段 */
export function platformGlyphForName(name: string): ReactNode {
  const s = String(name || '').trim();
  if (!s) return null;
  const src = platformImageSrcForName(s);
  if (src) return <PlatformImage src={src} alt={s} />;
  return null;
}

/** 「全部平台」筛选用 */
export function allPlatformsGlyph(): ReactNode {
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 shadow-sm ring-1 ring-slate-100"
      aria-hidden
    >
      <svg
        className="h-3.5 w-3.5 text-slate-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75a2.25 2.25 0 012.25-2.25h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25v-2.25zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z"
        />
      </svg>
    </span>
  );
}
