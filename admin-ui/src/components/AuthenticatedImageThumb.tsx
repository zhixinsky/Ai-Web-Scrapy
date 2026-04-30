import { useEffect, useRef, useState } from 'react';
import { API_BASE, collectionImageApiPath, getToken } from '../api';

/** 需登录的图片接口：用 fetch + Blob 展示；OSS 直链用 no-referrer 避免防盗链拒绝带管理端 Referer 的 img 请求 */
export function AuthenticatedImageThumb({
  collectionId,
  role,
  filename,
  url,
  className = '',
  sizeClass = 'h-20 w-20',
  /** 递增后强制重新拉取（如替换图片后同路径覆盖） */
  rev = 0,
  /** 与 slotIndex 成对：缩略图 Blob 就绪时写入父级列表，供大图左右切换 */
  slotIndex,
  registerBlob,
  /** 传入后在缩略图加载完成后可点击（Blob 由父级通过 registerBlob 持有） */
  onOpen,
}: {
  collectionId: number;
  role: 'main' | 'gallery' | 'detail' | 'main_nobg' | 'gallery_nobg';
  filename: string;
  /** 公开读直链（如 OSS 绑定域名）；传入后不再走带 Token 的 fetch */
  url?: string;
  className?: string;
  sizeClass?: string;
  rev?: number;
  slotIndex?: number;
  registerBlob?: (index: number, blobUrl: string) => void;
  onOpen?: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [preferDirect, setPreferDirect] = useState(true);
  const blobRef = useRef<string | null>(null);
  const directRef = useRef<string | null>(null);

  useEffect(() => {
    directRef.current = url ? String(url || '').trim() : null;
    setPreferDirect(true);
  }, [url]);

  useEffect(() => {
    if (directRef.current && preferDirect) {
      const u = String(url || '').trim();
      setSrc(u ? (rev ? `${u}${u.includes('?') ? '&' : '?'}v=${rev}` : u) : null);
      return;
    }
    let cancelled = false;
    (async () => {
      const token = getToken();
      const path = collectionImageApiPath(collectionId, role, filename);
      const r = await fetch(`${API_BASE}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!r.ok || cancelled) return;
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      blobRef.current = blobUrl;
      if (!cancelled) setSrc(blobUrl);
    })();
    return () => {
      cancelled = true;
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current);
        blobRef.current = null;
      }
    };
  }, [collectionId, role, filename, rev, preferDirect, url]);

  useEffect(() => {
    if (src && registerBlob && slotIndex !== undefined) registerBlob(slotIndex, src);
  }, [src, slotIndex, registerBlob]);

  if (!src) {
    return (
      <div
        className={`${sizeClass} shrink-0 animate-pulse rounded-lg bg-slate-200 ${className}`}
        aria-hidden
      />
    );
  }

  const frameClass = `${sizeClass} shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 ${className}`;

  if (onOpen) {
    return (
      <button
        type="button"
        className={`${frameClass} app-image-thumb-button block cursor-pointer p-0 text-left ring-offset-2 transition hover:border-teal-300 hover:shadow focus:outline-none focus:ring-2 focus:ring-teal-400`}
        title="点击查看大图"
        onClick={() => onOpen()}
      >
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => {
            if (directRef.current && preferDirect) setPreferDirect(false);
          }}
        />
      </button>
    );
  }

  return (
    <div className={frameClass}>
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => {
          if (directRef.current && preferDirect) setPreferDirect(false);
        }}
      />
    </div>
  );
}
