import { SectionCard } from '../SectionCard';
import { Thumbnail } from '../images/Thumbnail';
import { LocalServerImageThumb } from '../images/LocalServerImageThumb';

export function GallerySection({
  galleryLen,
  checked,
  onToggleChecked,
  galleryUrls,
  hasLocalAt,
  localFilenameAt,
  useNobgAt,
  nobgFilenameAt,
  collectionId,
  imageRev,
  registerGalleryBlob,
  openGalleryLightbox,
}: {
  galleryLen: number;
  checked: boolean[];
  onToggleChecked: (index: number) => void;
  galleryUrls: string[];
  hasLocalAt: (index: number) => boolean;
  localFilenameAt: (index: number) => string;
  useNobgAt: (index: number) => boolean;
  nobgFilenameAt: (index: number) => string;
  collectionId: number;
  imageRev: number;
  registerGalleryBlob: (index: number, blobUrl: string) => void;
  openGalleryLightbox: (index: number) => void;
}) {
  return (
    <SectionCard title={`副图（共 ${galleryLen} 张，已选 ${checked.filter(Boolean).length} 张）`}>
      {galleryLen ? (
        <>
          <p className="mb-2 text-[11px] text-slate-500">
            勾选将参与后续导出表格中的副图列（默认全选）；导出筛选逻辑稍后接入。
          </p>
          <div className="flex flex-wrap gap-4">
            {new Array(galleryLen).fill(0).map((_, i) => {
              const u = galleryUrls[i] || '';
              const hasLocal = hasLocalAt(i);
              return (
                <div
                  key={`${i}-${String(localFilenameAt(i) || u).slice(-24)}`}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-slate-100 bg-white/80 p-2"
                >
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-teal-600"
                      checked={Boolean(checked[i])}
                      onChange={() => onToggleChecked(i)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span>副图{i + 1}</span>
                  </label>
                  {hasLocal ? (
                    <LocalServerImageThumb
                      collectionId={collectionId}
                      folder={useNobgAt(i) ? 'gallery_nobg' : 'gallery'}
                      filename={useNobgAt(i) ? nobgFilenameAt(i) : localFilenameAt(i)}
                      rev={imageRev}
                      slotIndex={i}
                      registerBlob={registerGalleryBlob}
                      onOpen={() => openGalleryLightbox(i)}
                    />
                  ) : (
                    <Thumbnail url={u} onOpen={() => openGalleryLightbox(i)} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-400">暂无副图</p>
      )}
    </SectionCard>
  );
}

