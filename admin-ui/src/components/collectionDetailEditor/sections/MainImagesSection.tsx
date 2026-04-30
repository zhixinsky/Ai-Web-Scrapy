import { AutosizeTextarea } from '../AutosizeTextarea';
import { SectionCard } from '../SectionCard';
import { LocalServerImageThumb } from '../images/LocalServerImageThumb';

export function MainImagesSection({
  showLocalMain,
  localMainFiles,
  nobgDone,
  mainNobgList,
  colorTokensLength,
  colorExportCheckedDisplay,
  collectionId,
  imageRev,
  registerMainBlob,
  openMainLightbox,
  imagesStatus,
  imagesError,
  unified,
  rows,
  updateRow,
  mainImageFieldEntries,
  mainImageUrl,
  variantIdxs,
}: {
  showLocalMain: boolean;
  localMainFiles: string[];
  nobgDone: boolean;
  mainNobgList?: string[] | null;
  colorTokensLength: number;
  colorExportCheckedDisplay: boolean[];
  collectionId: number;
  imageRev: number;
  registerMainBlob: (index: number, blobUrl: string) => void;
  openMainLightbox: (index: number) => void;
  imagesStatus: string | null | undefined;
  imagesError: string | null | undefined;
  unified: boolean;
  rows: Record<string, unknown>[];
  updateRow: (index: number, patch: Record<string, unknown>) => void;
  mainImageFieldEntries: (row: Record<string, unknown>) => { key: string }[];
  mainImageUrl: (row: Record<string, unknown>) => string;
  variantIdxs: number[];
}) {
  return (
    <SectionCard title="主图">
      {showLocalMain ? (
        <>
          <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 scroll-smooth">
            {localMainFiles.map((fn, i) => {
              const useNobg = Boolean(nobgDone && mainNobgList?.[i]);
              const folder = useNobg ? 'main_nobg' : 'main';
              const file = useNobg ? String(mainNobgList![i]) : fn;
              const colorDimmed =
                colorTokensLength > 0 &&
                i < colorExportCheckedDisplay.length &&
                colorExportCheckedDisplay[i] === false;
              return (
                <LocalServerImageThumb
                  key={`${i}-${file}`}
                  collectionId={collectionId}
                  folder={folder}
                  filename={file}
                  rev={imageRev}
                  slotIndex={i}
                  registerBlob={registerMainBlob}
                  onOpen={() => openMainLightbox(i)}
                  dimmed={colorDimmed}
                />
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            共 {localMainFiles.length} 张
            {nobgDone && (mainNobgList?.length ?? 0) > 0
              ? '（已去背景预览；与颜色的对应在数据中，张数与颜色数一致时由采集与下载顺序对齐）'
              : '（已下载主图；去背景完成后此处显示透明底预览；与颜色的对应在数据中，张数与颜色数一致时由采集与下载顺序对齐）'}
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {String(imagesStatus || '') === 'pending'
              ? '主图正在下载到服务器…'
              : String(imagesStatus || '') === 'failed'
                ? `主图下载失败：${imagesError || '未知错误'}`
                : String(imagesStatus || '') === 'done' && !(localMainFiles.length)
                  ? '暂无已下载的主图文件。'
                  : `状态：${imagesStatus ?? '—'}`}
          </p>
          {unified ? (
            <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <summary className="cursor-pointer select-none text-slate-600">
                编辑主图链接（下载完成后上方将显示本地预览）
              </summary>
              <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                {Array.isArray((rows[0] || {})['主图']) ? (
                  <div>
                    <label className="text-xs font-medium text-slate-500" htmlFor="main-arr">
                      主图 URL（每行一个）
                    </label>
                    <AutosizeTextarea
                      id="main-arr"
                      minHeightPx={40}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs"
                      value={((rows[0] as any)['主图'] as unknown[]).map((x) => String(x ?? '').trim()).join('\n')}
                      onChange={(e) => {
                        const lines = e.target.value
                          .split(/\r?\n/)
                          .map((x) => x.trim())
                          .filter(Boolean);
                        updateRow(0, { 主图: lines });
                      }}
                      placeholder="https://"
                    />
                  </div>
                ) : (
                  mainImageFieldEntries(rows[0] || {}).map(({ key }) => (
                    <div key={key}>
                      <label className="text-xs font-medium text-slate-500" htmlFor={`main-${key}`}>
                        {key} URL
                      </label>
                      <input
                        id={`main-${key}`}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-800"
                        value={String((rows[0] || {})[key] ?? '')}
                        onChange={(e) => updateRow(0, { [key]: e.target.value })}
                        placeholder="https://"
                      />
                    </div>
                  ))
                )}
              </div>
            </details>
          ) : (
            <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <summary className="cursor-pointer select-none text-slate-600">编辑各 SKU 主图链接</summary>
              <div className="mt-2 space-y-4">
                {variantIdxs.map((idx, n) => {
                  const row = rows[idx] || {};
                  return (
                    <div
                      key={idx}
                      className="space-y-2 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0"
                    >
                      <div className="text-xs font-medium text-slate-600">SKU {n + 1}</div>
                      <div>
                        <label className="text-xs font-medium text-slate-500" htmlFor={`main-url-${idx}`}>
                          主图 URL
                        </label>
                        <input
                          id={`main-url-${idx}`}
                          className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 font-mono text-xs"
                          value={mainImageUrl(row)}
                          onChange={(e) => updateRow(idx, { 主图: e.target.value })}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </>
      )}
    </SectionCard>
  );
}

