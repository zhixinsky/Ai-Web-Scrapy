import { useEffect, useState } from 'react';
import { api, type ServerExportTypeRow, type UserInfo } from '../api';
import { destPlatformLabel, type StoredExportPlatform } from '../utils/exportProfiles';
import { toastError } from '../utils/toast';

function ExportTypesTable({
  platforms,
  types,
  loading,
  err,
}: {
  platforms: StoredExportPlatform[];
  types: ServerExportTypeRow[];
  loading: boolean;
  err: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-800">导出规则</h2>

      {/* errors are shown as toasts (top-right) */}
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-100">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-center text-xs font-medium text-slate-600">
              <th className="px-3 py-2 align-middle">类型名称</th>
              <th className="px-3 py-2 align-middle max-w-[14rem]">类型 id</th>
              <th className="px-3 py-2 align-middle">目标平台</th>
              <th
                className="px-3 py-2 align-middle w-28"
                title="列映射配置中的有效条数（field → 模板列）"
              >
                映射条数
              </th>
              <th className="px-3 py-2 align-middle w-28">内置表头</th>
              <th
                className="px-3 py-2 align-middle w-28"
                title="当前导出类型对应空表模板中，英文表头行占用的总列数（与 data 目录下表头 txt 一致）"
              >
                模板列数
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center align-middle text-sm text-slate-500">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && types.length === 0 && !err && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center align-middle text-sm text-slate-500">
                  未配置任何导出类型。
                </td>
              </tr>
            )}
            {!loading &&
              types.map((t) => (
                <tr key={t.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-3 py-2 text-center align-middle font-medium text-slate-800">{t.name}</td>
                  <td
                    className="max-w-[14rem] px-3 py-2 text-center align-middle font-mono text-[11px] text-slate-500"
                    title={t.id}
                  >
                    <span className="line-clamp-2 break-all">{t.id}</span>
                  </td>
                  <td className="max-w-[14rem] px-3 py-2 text-center align-middle">
                    <div className="text-sm font-medium text-slate-800">
                      {destPlatformLabel(t.destPlatformId, platforms)}
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[10px] text-slate-400" title="与采集 exportDestPlatformId 同源">
                      {t.destPlatformId || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center align-middle tabular-nums text-slate-700">{t.columnCount}</td>
                  <td className="px-3 py-2 text-center align-middle text-slate-700">{t.hasBuiltinHeaderRow ? '是' : '否'}</td>
                  <td className="px-3 py-2 text-center align-middle tabular-nums text-slate-700">{t.headerColumnCount}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DataExportPage({ user: _user }: { user: UserInfo }) {
  const [platforms, setPlatforms] = useState<StoredExportPlatform[]>([]);
  const [types, setTypes] = useState<ServerExportTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!err) return;
    toastError(err, '加载失败');
  }, [err]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([api.exportPlatforms(), api.exportTypes()])
      .then(([pl, ty]) => {
        if (cancelled) return;
        setPlatforms(Array.isArray(pl.platforms) ? pl.platforms : []);
        setTypes(Array.isArray(ty.types) ? ty.types : []);
        setErr('');
      })
      .catch((e) => {
        if (cancelled) return;
        setPlatforms([]);
        setTypes([]);
        setErr(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">导出规则查看</h1>
        {loading ? (
          <p className="mt-1 text-xs text-slate-400">正在加载导出类型与平台…</p>
        ) : null}
      </div>

      <ExportTypesTable platforms={platforms} types={types} loading={loading} err={err} />
    </div>
  );
}
