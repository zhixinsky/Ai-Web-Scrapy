import { ossPublicUrlForCollectionImage } from '../../../api';
import { AuthenticatedImageThumb } from '../../AuthenticatedImageThumb';

function preferApiFetchOverHttpDirectThumb(publicUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  const u = String(publicUrl || '').trim();
  if (!u.startsWith('http://')) return false;
  return window.location.protocol === 'https:';
}

/** 展示服务器已下载图片（OSS 或本地；走鉴权 fetch 或 OSS 公开域名，与图片资源管理一致） */
export function LocalServerImageThumb({
  collectionId,
  folder,
  filename,
  publicUrl,
  onOpen,
  slotIndex,
  registerBlob,
  dimmed,
  rev = 0,
}: {
  collectionId: number;
  folder: 'main' | 'main_nobg' | 'gallery' | 'gallery_nobg' | 'detail';
  filename: string;
  /** 传入后将直接使用该 URL（右键复制为真实地址，而非 blob:） */
  publicUrl?: string;
  onOpen: () => void;
  slotIndex: number;
  registerBlob: (index: number, blobUrl: string) => void;
  /** 与颜色导出勾选联动：未勾选的颜色对应主图置灰提示 */
  dimmed?: boolean;
  /** 递增后强制重新拉取（如替换图片后同路径覆盖） */
  rev?: number;
}) {
  const ossUrl = ossPublicUrlForCollectionImage(collectionId, folder, filename);
  const resolved = String(publicUrl || '').trim() || String(ossUrl || '').trim();
  const thumbDirectUrl = resolved && !preferApiFetchOverHttpDirectThumb(resolved) ? resolved : undefined;
  return (
    <AuthenticatedImageThumb
      collectionId={collectionId}
      role={folder}
      filename={filename}
      url={thumbDirectUrl}
      rev={rev}
      slotIndex={slotIndex}
      registerBlob={registerBlob}
      onOpen={onOpen}
      sizeClass="h-24 w-24"
      className={dimmed ? 'opacity-45 grayscale' : ''}
    />
  );
}

