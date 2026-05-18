import { useEffect, useMemo, useState } from 'react';
import {
  api,
  APP_MODULE_IDS,
  type AccountCredits,
  type ExportDestPlatform,
  type MyExportTemplateSummary,
  type PlanCatalogItem,
  type RuleSummary,
  type UserInfo,
} from '../api';
import { toastError } from '../utils/toast';
import { CustomSelect } from '../components/CustomSelect';
import { platformImageSrcForName } from '../components/PlatformGlyph';

function platformIconOnly(name: string) {
  const src = platformImageSrcForName(name);
  if (!src) return null;
  return <img src={src} alt={name} className="h-6 w-20 object-contain" loading="lazy" />;
}

const MODULE_LABELS: Record<string, string> = {
  collections: '采集数据管理',
  images: '图片资源管理',
  rules: '采集规则配置',
  'export-mapping': '导出映射配置',
};

function fmtModule(id: string): string {
  return MODULE_LABELS[id] || id;
}

function CreditsPill({ credits }: { credits: AccountCredits }) {
  const isUnlimited =
    credits.nobgCredits >= 999999 ||
    credits.aiEraseCredits >= 999999 ||
    (credits.imageGenCredits ?? 0) >= 999999;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
        去背景剩余：<span className="font-semibold text-slate-900">{isUnlimited ? '不限' : credits.nobgCredits}</span>
      </span>
      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
        AI消除剩余：<span className="font-semibold text-slate-900">{isUnlimited ? '不限' : credits.aiEraseCredits}</span>
      </span>
      <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">
        图片生成剩余：
        <span className="font-semibold text-slate-900">{isUnlimited ? '不限' : credits.imageGenCredits ?? 0}</span>
      </span>
    </div>
  );
}

function TemplatesList({ templates, me }: { templates: MyExportTemplateSummary[]; me: UserInfo }) {
  if (!templates.length) {
    return <p className="text-sm text-slate-500">暂无你创建的采集映射模板。</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-4 py-3 font-medium">模板名称</th>
            <th className="px-4 py-3 font-medium">公开</th>
            <th className="px-4 py-3 font-medium">更新时间</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} className="border-t border-slate-100">
              <td className="px-4 py-3 font-medium text-slate-800">{t.name || '未命名模板'}</td>
              <td className="px-4 py-3 text-slate-700">{Number(t.isPublic) === 1 ? '是' : '否'}</td>
              <td className="px-4 py-3 text-slate-500">{t.updatedAt || t.createdAt || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs text-slate-500">
        以上仅展示你创建的模板；编辑/公开/删除请到「导出映射配置」页面操作。
      </div>
    </div>
  );
}

function RulesList({ rules }: { rules: RuleSummary[] }) {
  if (!rules.length) return <p className="text-sm text-slate-500">暂无授权的采集规则。</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-4 py-3 font-medium">规则</th>
            <th className="px-4 py-3 font-medium">平台</th>
            <th className="px-4 py-3 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-4 py-3 font-medium text-slate-800">{r.name}</td>
              <td className="px-4 py-3 text-slate-700">{r.platform || '—'}</td>
              <td className="px-4 py-3 text-xs text-slate-600">{r.description || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AccountPage() {
  const [me, setMe] = useState<UserInfo | null>(null);
  const [credits, setCredits] = useState<AccountCredits>({ nobgCredits: 0, aiEraseCredits: 0, imageGenCredits: 0 });
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [templates, setTemplates] = useState<MyExportTemplateSummary[]>([]);
  const [planCatalog, setPlanCatalog] = useState<PlanCatalogItem[]>([]);
  const [err, setErr] = useState('');

  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwNew2, setPwNew2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState('');

  const [exportPlatforms, setExportPlatforms] = useState<ExportDestPlatform[]>([]);
  const [defaultExportPlatformId, setDefaultExportPlatformId] = useState<string>('');
  const [defaultExportBusy, setDefaultExportBusy] = useState(false);
  const [defaultExportMsg, setDefaultExportMsg] = useState('');
  const [collectionAutoNobg, setCollectionAutoNobg] = useState(true);
  const [collectionAutoNobgBusy, setCollectionAutoNobgBusy] = useState(false);

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);

  useEffect(() => {
    let cancelled = false;
    setErr('');
    api
      .accountOverview()
      .then((r) => {
        if (cancelled) return;
        setMe(r.user);
        setDefaultExportPlatformId(String(r.user?.defaultExportPlatformId || '').trim());
        setCollectionAutoNobg(r.user?.collectionAutoNobg !== false);
        setCredits(
          r.credits || { nobgCredits: 0, aiEraseCredits: 0, imageGenCredits: 0 }
        );
        setRules(Array.isArray(r.authorizedRules) ? r.authorizedRules : []);
        setTemplates(Array.isArray(r.myExportTemplates) ? r.myExportTemplates : []);
        setPlanCatalog(Array.isArray(r.planCatalog) ? r.planCatalog : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDefaultExportMsg('');
    api
      .exportPlatforms()
      .then((r) => {
        if (cancelled) return;
        setExportPlatforms(Array.isArray(r.platforms) ? r.platforms : []);
      })
      .catch(() => {
        // 个人中心不强依赖导出模块；无权限或接口错误时不阻断页面
        if (cancelled) return;
        setExportPlatforms([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const moduleText = useMemo(() => {
    if (!me) return '';
    if (me.role === 'admin') return '全部';
    const list = Array.isArray(me.allowedModules) ? me.allowedModules : [];
    if (!list.length) return '未授权';
    return APP_MODULE_IDS.filter((id) => list.includes(id)).map(fmtModule).join('、') || list.map(fmtModule).join('、');
  }, [me]);

  const planText = useMemo(() => {
    if (me?.role === 'admin') return '管理员';
    const pid = String(me?.planId || '').trim();
    if (!pid) return '—';
    const p = planCatalog.find((x) => String(x.id) === pid);
    return p ? p.name : pid;
  }, [me?.planId, planCatalog]);

  async function changePassword() {
    setPwMsg('');
    setErr('');
    const oldPassword = pwOld;
    const newPassword = pwNew;
    if (!oldPassword || !newPassword) {
      setPwMsg('请填写旧密码与新密码');
      return;
    }
    if (newPassword !== pwNew2) {
      setPwMsg('两次输入的新密码不一致');
      return;
    }
    setPwBusy(true);
    try {
      await api.changeMyPassword({ oldPassword, newPassword });
      setPwOld('');
      setPwNew('');
      setPwNew2('');
      setPwMsg('密码已更新');
    } catch (e) {
      setPwMsg(e instanceof Error ? e.message : '修改失败');
    } finally {
      setPwBusy(false);
    }
  }

  async function saveCollectionAutoNobg(next: boolean) {
    setCollectionAutoNobgBusy(true);
    setErr('');
    try {
      const r = await api.setMyCollectionAutoNobg(next);
      const on = r.collectionAutoNobg !== false;
      setCollectionAutoNobg(on);
      setMe((m) => (m ? { ...m, collectionAutoNobg: on } : m));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setCollectionAutoNobgBusy(false);
    }
  }

  async function saveDefaultExportPlatform() {
    setDefaultExportMsg('');
    setErr('');
    setDefaultExportBusy(true);
    try {
      const r = await api.setMyDefaultExportPlatform({ defaultExportPlatformId });
      const next = String(r.defaultExportPlatformId || '').trim();
      setDefaultExportPlatformId(next);
      setMe((m) => (m ? { ...m, defaultExportPlatformId: next } : m));
      setDefaultExportMsg('已保存');
    } catch (e) {
      setDefaultExportMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setDefaultExportBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">个人信息</h1>
          <p className="mt-1 text-xs text-slate-500">查看个人信息、修改密码、查看授权模块/规则与我的采集映射模板。</p>
        </div>
      </div>

      {/* errors are shown as toasts (top-right) */}

      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">剩余次数</h2>
          <CreditsPill credits={credits} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          按每张图片 1 次扣减（去背景、AI 消除、图片生成分别计数）；次数不足时将禁止对应操作。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">账户信息</h2>
          <div className="mt-3 space-y-2 text-sm text-slate-700">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">用户名</span>
              <span className="font-medium">{me?.username || '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">角色</span>
              <span className="font-medium">{me?.role === 'admin' ? '管理员' : '普通用户'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">会员套餐</span>
              <span className="font-medium">{planText}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">授权结束</span>
              <span className="font-medium">{me?.validTo || '—'}</span>
            </div>
            <div className="pt-1 text-xs text-slate-500">
              已授权模块：<span className="text-slate-700">{moduleText || '—'}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">采集自动化</h2>
          <p className="mt-2 text-xs text-slate-500">
            采集数据上报到服务器后，如插件未指定 <span className="font-medium">exportDestPlatformId</span>，将使用这里的默认导出平台，
            并按该平台触发 AI 富化流程（标题/描述/颜色/详情翻译/关键字等）。
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-800">采集后自动去背景</div>
              <p className="mt-1 text-xs text-slate-500">
                开启后，主图与副图下载完成将自动排队去背景（需服务端配置 Pixian 且账号次数充足）。关闭则只保留原图，可在「图片资源」中手动处理。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={collectionAutoNobg}
              disabled={collectionAutoNobgBusy}
              onClick={() => void saveCollectionAutoNobg(!collectionAutoNobg)}
              className={`relative h-8 w-14 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:opacity-50 ${
                collectionAutoNobg ? 'bg-teal-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`absolute top-1 left-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                  collectionAutoNobg ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
              <span className="sr-only">{collectionAutoNobg ? '已开启' : '已关闭'}</span>
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-600">默认导出平台</label>
            <CustomSelect
              value={defaultExportPlatformId}
              onChange={(v) => setDefaultExportPlatformId(String(v || ''))}
              options={[
                { value: '', label: '未设置', icon: null, iconOnly: true },
                ...exportPlatforms.map((p) => ({
                  value: p.id,
                  label: p.name,
                  icon: platformIconOnly(p.name),
                  iconOnly: true,
                })),
              ]}
              disabled={defaultExportBusy || exportPlatforms.length === 0}
              aria-label="默认导出平台"
              className="min-w-0"
              buttonClassName="flex h-10 w-[7.25rem] items-center justify-center rounded-full border border-slate-200 bg-white px-2 py-2 text-sm text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 disabled:opacity-50"
            />
            <button
              type="button"
              disabled={defaultExportBusy}
              onClick={() => void saveDefaultExportPlatform()}
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50"
            >
              {defaultExportBusy ? '保存中…' : '保存'}
            </button>
            <div
              className={`text-xs ${
                defaultExportMsg.includes('已') ? 'text-emerald-600' : defaultExportMsg ? 'text-rose-600' : 'text-slate-500'
              }`}
            >
              {exportPlatforms.length === 0 ? '（未加载到平台目录：可能无导出模块权限或未配置平台）' : defaultExportMsg}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">修改密码</h2>
          <div className="mt-3 space-y-3">
            <input
              type="password"
              value={pwOld}
              onChange={(e) => setPwOld(e.target.value)}
              placeholder="旧密码"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <input
              type="password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              placeholder="新密码（至少 6 位）"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <input
              type="password"
              value={pwNew2}
              onChange={(e) => setPwNew2(e.target.value)}
              placeholder="再次输入新密码"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={pwBusy}
                onClick={() => void changePassword()}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {pwBusy ? '保存中…' : '保存'}
              </button>
              <div className={`text-xs ${pwMsg.includes('已') ? 'text-emerald-600' : 'text-slate-500'}`}>{pwMsg}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6">
        <div>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">授权的采集规则</h2>
          <RulesList rules={rules} />
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">我创建的采集映射模板</h2>
          {me ? <TemplatesList templates={templates} me={me} /> : <p className="text-sm text-slate-500">加载中…</p>}
        </div>
      </div>
    </div>
  );
}
