import { SectionCard } from '../SectionCard';
import { Thumbnail } from '../images/Thumbnail';
import { LocalServerImageThumb } from '../images/LocalServerImageThumb';

export function DetailImagesSection({
  detailLen,
  showLocalDetail,
  detailLocalFiles,
  detailImageUrls,
  detailPublicUrls,
  collectionId,
  imageRev,
  registerDetailBlob,
  openDetailImagesLightbox,
}: {
  detailLen: number;
  showLocalDetail: boolean;
  detailLocalFiles: string[];
  detailImageUrls: string[];
  detailPublicUrls: string[];
  collectionId: number;
  imageRev: number;
  registerDetailBlob: (index: number, blobUrl: string) => void;
  openDetailImagesLightbox: (index: number) => void;
}) {
  if (!detailLen) return null;
  return (
    <SectionCard title={`详情图（仅展示，共 ${detailLen} 张）`}>
      <details className="rounded-lg border border-slate-200 bg-white/60 px-3 py-2">
        <summary className="cursor-pointer select-none text-xs font-semibold tracking-wide text-slate-600">
          点击展开查看详情图
        </summary>
        <div className="mt-3 flex flex-wrap gap-4">
          {showLocalDetail
            ? detailLocalFiles.map((fn, i) => {
                const filename = String(fn || '').trim();
                if (!filename) return null;
                return (
                  <LocalServerImageThumb
                    key={`${i}-${filename}`}
                    collectionId={collectionId}
                    folder="detail"
                    filename={filename}
                    publicUrl={detailPublicUrls[i]}
                    rev={imageRev}
                    slotIndex={i}
                    registerBlob={registerDetailBlob}
                    onOpen={() => openDetailImagesLightbox(i)}
                  />
                );
              })
            : detailImageUrls.map((u, i) => {
                const url = String(u || '').trim();
                if (!url) return null;
                return (
                  <Thumbnail
                    key={`${i}-${url.slice(-24)}`}
                    url={url}
                    onOpen={() => openDetailImagesLightbox(i)}
                  />
                );
              })}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">详情图不参与导出，仅用于查看。</p>
      </details>
    </SectionCard>
  );
}

