import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RuleSummary } from '../api';
import { toastError } from '../utils/toast';
import {
  tableActionCopyClass,
  tableActionDeleteClass,
  tableActionEditClass,
  tableActionRowWrapClass,
} from '../ui/tableActionClasses';

/** 在已有名称集合中，生成「原名-副本1」「原名-副本2」… 第一个未被占用的名称 */
function nextDuplicateRuleName(sourceName: string, existingNames: Set<string>): string {
  for (let k = 1; k < 10000; k++) {
    const candidate = `${sourceName}-副本${k}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${sourceName}-副本${Date.now()}`;
}

export default function RulesPage() {
  const [rows, setRows] = useState<RuleSummary[]>([]);
  const [err, setErr] = useState('');
  const [copyingId, setCopyingId] = useState<number | null>(null);

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);

  useEffect(() => {
    api
      .adminRules()
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'));
  }, []);

  async function remove(id: number) {
    if (!confirm('确定删除该规则？')) return;
    try {
      await api.deleteRule(id);
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function copyRule(row: RuleSummary) {
    setErr('');
    setCopyingId(row.id);
    try {
      const [list, detail] = await Promise.all([api.adminRules(), api.adminRule(row.id)]);
      const names = new Set(list.map((r) => r.name));
      const newName = nextDuplicateRuleName(row.name, names);
      await api.createRule({
        name: newName,
        platform: detail.platform,
        description: detail.description,
        config: detail.config,
      });
      setRows(await api.adminRules());
    } catch (e) {
      setErr(e instanceof Error ? e.message : '复制失败');
    } finally {
      setCopyingId(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">采集规则配置</h1>
        </div>
        <Link
          to="/rules/new"
          className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-4 py-2 text-sm font-medium text-teal-900 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-100 hover:shadow-md"
        >
          新增规则
        </Link>
      </div>

      {/* errors are shown as toasts (top-right) */}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">规则名称</th>
              <th className="px-4 py-3 font-medium">所属平台</th>
              <th className="px-4 py-3 font-medium">规则说明</th>
              <th className="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium text-slate-800">{row.name}</td>
                <td className="px-4 py-3">{row.platform}</td>
                <td className="max-w-md truncate px-4 py-3 text-slate-600" title={row.description}>
                  {row.description}
                </td>
                <td className="px-4 py-3 text-center">
                  <div className={tableActionRowWrapClass}>
                    <Link to={`/rules/${row.id}`} className={tableActionEditClass}>
                      编辑
                    </Link>
                    <button
                      type="button"
                      className={tableActionCopyClass}
                      disabled={copyingId === row.id}
                      onClick={() => copyRule(row)}
                    >
                      {copyingId === row.id ? '复制中…' : '复制规则'}
                    </button>
                    <button
                      type="button"
                      className={tableActionDeleteClass}
                      onClick={() => remove(row.id)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  暂无规则，请点击「新增规则」
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
