import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ServerExportTypeRow } from '../api';
import {
  type StoredExportPlatform,
  buildExportDownloadFilename,
  destPlatformLabel,
  resolveApiTarget,
} from '../utils/exportProfiles';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function withDraftSuffixIfNeeded(filename: string, mappingMode?: string): string {
  const mode = String(mappingMode || '').toLowerCase();
  if (mode !== 'draft') return filename;
  const base = String(filename || '');
  if (!base) return base;
  if (base.endsWith('.zip')) return base.replace(/\.zip$/i, '_draftmap.zip');
  if (base.endsWith('.xlsx')) return base.replace(/\.xlsx$/i, '_draftmap.xlsx');
  if (base.endsWith('.csv')) return base.replace(/\.csv$/i, '_draftmap.csv');
  return `${base}_draftmap`;
}

/**
 * 服务端平台展示名常为「亚马逊（Amazon）」；下拉再外包一层「」会变成两个右括号。
 * 只取第一个全角/半角「（」前的主称呼用于「类型名（平台）」。
 */
function exportDropdownPlatformSegment(fullLabel: string): string {
  const s = String(fullLabel || '').trim();
  const i = s.indexOf('（');
  if (i > 0) return s.slice(0, i).trim();
  const j = s.indexOf('(');
  if (j > 0) return s.slice(0, j).trim();
  return s;
}

/** 弹窗内与 StoredExportType 对齐的轻量形状（来自 GET /api/export/types） */
type ModalExportOption = {
  id: string;
  name: string;
  mode: 'amazon' | 'generic';
  destPlatform: string;
};

function rowsToOptions(rows: ServerExportTypeRow[]): ModalExportOption[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    destPlatform: String(r.destPlatformId || '').trim(),
  }));
}

type Props = {
  open: boolean;
  onClose: () => void;
  ids: number[];
  userIdForApi?: number;
  /** 打开弹窗时是否默认勾选「导出含图片」；单行/批量导出均默认 false，在弹窗内自行勾选 */
  defaultIncludeImages?: boolean;
  onAfterDownload: () => void | Promise<void>;
};

export default function CollectionExportModal({
  open,
  onClose,
  ids,
  userIdForApi,
  defaultIncludeImages = false,
  onAfterDownload,
}: Props) {
  const hidePublicTemplates = (() => {
    try {
      return localStorage.getItem('admin-export-mapping:hide-public-export-templates') === '1';
    } catch {
      return false;
    }
  })();
  const [types, setTypes] = useState<ModalExportOption[]>([]);
  const [platforms, setPlatforms] = useState<StoredExportPlatform[]>([]);
  const [typeId, setTypeId] = useState<string>('');
  const [includeImages, setIncludeImages] = useState(defaultIncludeImages);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setIncludeImages(defaultIncludeImages);
    setErr('');
    let cancelled = false;
    void Promise.all([api.exportTypes({ hidePublic: hidePublicTemplates }), api.exportPlatforms()])
      .then(([tr, pr]) => {
        if (cancelled) return;
        const list = rowsToOptions(Array.isArray(tr.types) ? tr.types : []);
        setTypes(list);
        setPlatforms(Array.isArray(pr.platforms) ? pr.platforms : []);
        setTypeId((prev) => {
          if (prev && list.some((t) => t.id === prev)) return prev;
          return list[0]?.id ?? '';
        });
      })
      .catch(() => {
        if (cancelled) return;
        setTypes([]);
        setPlatforms([]);
        setTypeId('');
      });
    return () => {
      cancelled = true;
    };
  }, [open, defaultIncludeImages]);

  const selectedType = types.find((t) => t.id === typeId);
  const lockedDestPlatform = String(selectedType?.destPlatform ?? '').trim();

  if (!open) return null;

  async function resolveColumnMapDraft(exportTypeId: string): Promise<unknown | null> {
    const id = String(exportTypeId || '').trim();
    if (!id) return null;
    try {
      const r = await api.getExportColumnMapDraft(id);
      if (r.draft != null && typeof r.draft === 'object' && !Array.isArray(r.draft)) {
        return r.draft;
      }
    } catch {
      // 未登录或网络失败时退回本机
    }
    try {
      const raw = localStorage.getItem(`admin-export-column-map:v1:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return parsed ?? null;
    } catch {
      return null;
    }
  }

  async function onDownload() {
    if (ids.length === 0) {
      setErr('没有可导出的记录');
      return;
    }
    if (!selectedType) {
      setErr('服务端未返回可用导出类型，请检查 builtinExportTemplates.js 是否已配置内置导出类型');
      return;
    }
    if (!lockedDestPlatform) {
      setErr('该导出类型未解析到目标平台 id，请检查服务端 builtinExportTemplates.js 中 EXPORT_TYPE_LIST_META 与平台目录 enrichKey 是否一致。');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const target = resolveApiTarget(selectedType.mode, lockedDestPlatform);
      const effFormat = 'xlsx' as const;
      const columnMapDraft = await resolveColumnMapDraft(selectedType.id);
      const resp = await api.exportCollectionsPost('xlsx', {
        ids: [...ids],
        userId: userIdForApi,
        includeImages,
        target,
        exportTypeId: selectedType.id,
        ...(columnMapDraft ? { columnMapDraft } : {}),
      });
      const name = buildExportDownloadFilename(
        lockedDestPlatform,
        selectedType.name,
        effFormat,
        includeImages,
        selectedType.mode,
        platforms
      );
      downloadBlob(resp.blob, withDraftSuffixIfNeeded(name, resp.mappingMode));
      await onAfterDownload();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[200] flex items-center justify-center p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xl"
        role="dialog"
        aria-modal
        aria-labelledby="export-modal-title"
      >
        <h2 id="export-modal-title" className="text-base font-semibold text-slate-800">
          导出数据
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          导出类型由服务端注册；选项与 <code className="rounded bg-slate-100 px-1 text-[11px]">GET /api/export/types</code>{' '}
          一致。
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">导出类型</label>
            <select
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              disabled={busy || types.length === 0}
            >
              {types.length === 0 ? (
                <option value="">暂无类型（请检查服务端是否已配置导出映射）</option>
              ) : (
                types.map((t) => {
                  const platFull = destPlatformLabel(t.destPlatform ?? '', platforms);
                  const platShort = exportDropdownPlatformSegment(platFull) || platFull || '未绑定';
                  return (
                    <option key={t.id} value={t.id}>
                      {t.name}（{platShort}）
                    </option>
                  );
                })
              )}
            </select>
          </div>
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-teal-600"
              checked={includeImages}
              onChange={(e) => setIncludeImages(e.target.checked)}
              disabled={busy}
            />
            导出含图片（zip 包）
          </label>
        </div>

        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

        <p className="mt-2 text-xs text-slate-400">
          将导出 {ids.length} 条记录（可多平台混在同一文件中）
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={() => !busy && onClose()}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-lg bg-gradient-to-r from-teal-600 to-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:from-teal-700 hover:to-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void onDownload()}
            disabled={busy || !selectedType || ids.length === 0 || !lockedDestPlatform}
          >
            {busy ? '下载中…' : '下载'}
          </button>
        </div>
      </div>
    </div>
  );
}
