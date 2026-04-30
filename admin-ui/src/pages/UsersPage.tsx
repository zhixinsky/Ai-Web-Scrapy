import { useEffect, useState } from 'react';
import { api, APP_MODULE_IDS, type AdminUser, type RuleSummary } from '../api';
import { toastError } from '../utils/toast';
import {
  tableActionDeleteClass,
  tableActionEditClass,
  tableActionRowWrapClass,
} from '../ui/tableActionClasses';

const MODULE_LABELS: Record<string, string> = {
  collections: '采集数据管理',
  images: '图片资源管理',
  rules: '采集规则配置',
  'export-mapping': '导出映射配置',
};

const PLAN_DEFAULT_CREDITS: Record<
  string,
  { nobgCredits: number; aiEraseCredits: number; imageGenCredits: number }
> = {
  trial: { nobgCredits: 20, aiEraseCredits: 5, imageGenCredits: 3 },
  lite: { nobgCredits: 100, aiEraseCredits: 50, imageGenCredits: 20 },
  pro: { nobgCredits: 500, aiEraseCredits: 200, imageGenCredits: 120 },
  studio: { nobgCredits: 3000, aiEraseCredits: 1000, imageGenCredits: 500 },
};

function formatModulesCell(u: AdminUser): string {
  if (u.role === 'admin') return '全部';
  const list = u.allowedModules || [];
  if (!list.length) return '未授权';
  return list.map((id) => MODULE_LABELS[id] || id).join('、');
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({
    username: '',
    password: '',
    role: 'user' as 'user' | 'admin',
    validFrom: '',
    validTo: '',
    ruleIds: [] as number[],
    allowedModules: [] as string[],
    nobgCredits: 0,
    aiEraseCredits: 0,
    imageGenCredits: 0,
    planId: 'trial',
  });

  function load() {
    Promise.all([api.adminUsers(), api.adminRules()])
      .then(([u, r]) => {
        setUsers(u);
        setRules(r);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'));
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);

  function openCreate() {
    setErr('');
    setForm({
      username: '',
      password: '',
      role: 'user',
      validFrom: '',
      validTo: '',
      ruleIds: [],
      allowedModules: ['collections', 'images'],
      nobgCredits: 0,
      aiEraseCredits: 0,
      imageGenCredits: 0,
      planId: 'trial',
    });
    setEditId(null);
    setModal('create');
  }

  async function openEdit(u: AdminUser) {
    setErr('');
    try {
      const full = await api.adminUser(u.id);
      setForm({
        username: full.username,
        password: '',
        role: full.role,
        validFrom: full.validFrom || '',
        validTo: full.validTo || '',
        ruleIds: full.ruleIds || [],
        allowedModules: full.role === 'admin' ? [...APP_MODULE_IDS] : [...(full.allowedModules || [])],
        nobgCredits: Number(full.nobgCredits ?? 0),
        aiEraseCredits: Number(full.aiEraseCredits ?? 0),
        imageGenCredits: Number(full.imageGenCredits ?? 0),
        planId: String((full as any).planId || 'trial'),
      });
      setEditId(u.id);
      setModal('edit');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载用户失败');
    }
  }

  function toggleRule(id: number) {
    setForm((f) => ({
      ...f,
      ruleIds: f.ruleIds.includes(id)
        ? f.ruleIds.filter((x) => x !== id)
        : [...f.ruleIds, id],
    }));
  }

  function toggleModule(mod: string) {
    setForm((f) => ({
      ...f,
      allowedModules: f.allowedModules.includes(mod)
        ? f.allowedModules.filter((x) => x !== mod)
        : [...f.allowedModules, mod],
    }));
  }

  async function save() {
    setErr('');
    try {
      if (modal === 'create') {
        if (!form.username.trim() || !form.password) {
          setErr('请填写用户名与初始密码');
          return;
        }
        await api.createUser({
          username: form.username.trim(),
          password: form.password,
          role: form.role,
          validFrom: form.validFrom || null,
          validTo: form.validTo || null,
          ruleIds: form.ruleIds,
          nobgCredits: Number(form.nobgCredits || 0),
          aiEraseCredits: Number(form.aiEraseCredits || 0),
          imageGenCredits: Number(form.imageGenCredits || 0),
          planId: form.planId,
          ...(form.role === 'user' ? { allowedModules: form.allowedModules } : {}),
        });
      } else if (modal === 'edit' && editId != null) {
        await api.updateUser(editId, {
          password: form.password || undefined,
          role: form.role,
          validFrom: form.validFrom || null,
          validTo: form.validTo || null,
          ruleIds: form.ruleIds,
          nobgCredits: Number(form.nobgCredits || 0),
          aiEraseCredits: Number(form.aiEraseCredits || 0),
          imageGenCredits: Number(form.imageGenCredits || 0),
          planId: form.planId,
          ...(form.role === 'user' ? { allowedModules: form.allowedModules } : {}),
        });
      }
      setModal(null);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    }
  }

  async function remove(u: AdminUser) {
    if (!confirm(`确定删除用户「${u.username}」？`)) return;
    try {
      await api.deleteUser(u.id);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">用户权限管理</h1>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-teal-600/20 transition hover:from-teal-500 hover:to-emerald-500"
        >
          新建用户
        </button>
      </div>

      {/* errors are shown as toasts (top-right) */}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">用户名</th>
              <th className="px-4 py-3 font-medium">角色</th>
              <th className="px-4 py-3 font-medium">功能模块</th>
              <th className="px-4 py-3 font-medium">会员套餐</th>
              <th className="px-4 py-3 font-medium">去背景次数</th>
              <th className="px-4 py-3 font-medium">AI消除次数</th>
              <th className="px-4 py-3 font-medium">图片生成次数</th>
              <th className="px-4 py-3 font-medium">授权开始</th>
              <th className="px-4 py-3 font-medium">授权结束</th>
              <th className="px-4 py-3 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3">{u.role === 'admin' ? '管理员' : '普通用户'}</td>
                <td className="max-w-[14rem] px-4 py-3 text-xs leading-snug text-slate-600">
                  {formatModulesCell(u)}
                </td>
                <td className="px-4 py-3 text-xs text-slate-700">
                  {u.role === 'admin' ? '—' : String((u as any).planId || 'trial')}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">{u.role === 'admin' ? '—' : u.nobgCredits}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">{u.role === 'admin' ? '—' : u.aiEraseCredits}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">
                  {u.role === 'admin' ? '—' : u.imageGenCredits ?? 0}
                </td>
                <td className="px-4 py-3">{u.validFrom || '—'}</td>
                <td className="px-4 py-3">{u.validTo || '—'}</td>
                <td className="px-4 py-3 text-center">
                  <div className={tableActionRowWrapClass}>
                    <button type="button" className={tableActionEditClass} onClick={() => openEdit(u)}>
                      编辑
                    </button>
                    {u.username !== 'admin' && (
                      <button type="button" className={tableActionDeleteClass} onClick={() => remove(u)}>
                        删除
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold">
              {modal === 'create' ? '新建用户' : '编辑用户'}
            </h2>
            {/* errors are shown as toasts (top-right) */}
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium">用户名</label>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  disabled={modal === 'edit'}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {modal === 'create' ? '初始密码 *' : '新密码（留空不改）'}
                </label>
                <input
                  type="password"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">角色</label>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={form.role}
                  onChange={(e) => {
                    const v = e.target.value as 'user' | 'admin';
                    setForm((f) => ({
                      ...f,
                      role: v,
                      allowedModules:
                        v === 'admin' ? [...APP_MODULE_IDS] : f.allowedModules.length ? f.allowedModules : ['collections', 'images'],
                    }));
                  }}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </div>
              {form.role === 'user' ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-sm font-medium">会员套餐</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={form.planId}
                      onChange={(e) => {
                        const pid = String(e.target.value || 'trial');
                        const d = PLAN_DEFAULT_CREDITS[pid] || PLAN_DEFAULT_CREDITS.trial;
                        setForm((f) => ({
                          ...f,
                          planId: pid,
                          nobgCredits: d.nobgCredits,
                          aiEraseCredits: d.aiEraseCredits,
                          imageGenCredits: d.imageGenCredits,
                        }));
                      }}
                    >
                      <option value="trial">体验版（免费）</option>
                      <option value="lite">轻享版（入门）</option>
                      <option value="pro">专业版（主推）</option>
                      <option value="studio">工作室版（高端）</option>
                    </select>
                    <p className="mt-1 text-xs text-slate-500">
                      选择套餐会在保存时同步设置当月配额（并重置剩余次数）。
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label className="mb-1 block text-sm font-medium">去背景次数</label>
                        <input
                          type="number"
                          min={0}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          value={String(form.nobgCredits)}
                          onChange={(e) => setForm((f) => ({ ...f, nobgCredits: Number(e.target.value || 0) }))}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium">AI消除次数</label>
                        <input
                          type="number"
                          min={0}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          value={String(form.aiEraseCredits)}
                          onChange={(e) => setForm((f) => ({ ...f, aiEraseCredits: Number(e.target.value || 0) }))}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium">图片生成次数</label>
                        <input
                          type="number"
                          min={0}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          value={String(form.imageGenCredits)}
                          onChange={(e) => setForm((f) => ({ ...f, imageGenCredits: Number(e.target.value || 0) }))}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              {form.role === 'user' ? (
                <div>
                  <label className="mb-2 block text-sm font-medium">功能模块（须勾选方可使用）</label>
                  <div className="space-y-2 rounded-lg border border-slate-100 p-3">
                    {APP_MODULE_IDS.map((mid) => (
                      <label key={mid} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={form.allowedModules.includes(mid)}
                          onChange={() => toggleModule(mid)}
                        />
                        <span>{MODULE_LABELS[mid] || mid}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  管理员拥有全部功能模块；用户管理入口仅管理员可见。
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">授权开始（日期）</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.validFrom}
                    onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">授权结束（日期）</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    value={form.validTo}
                    onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium">可使用的采集规则</label>
                <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-slate-100 p-3">
                  {rules.length === 0 && (
                    <p className="text-xs text-slate-400">请先在「采集规则配置」中创建规则</p>
                  )}
                  {rules.map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.ruleIds.includes(r.id)}
                        onChange={() => toggleRule(r.id)}
                      />
                      <span>
                        {r.name} <span className="text-slate-400">({r.platform})</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm"
                onClick={() => {
                  setModal(null);
                  setErr('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={save}
                className="rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-teal-600/20"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
