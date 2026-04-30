import { useEffect, useState } from 'react';

import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type RuleConfig } from '../api';

import RulesTableEditor from '../components/RulesTableEditor';
import { toastError } from '../utils/toast';
import { tableActionEditClass } from '../ui/tableActionClasses';



export default function RuleEditPage() {

  const { id } = useParams();

  const navigate = useNavigate();

  const isNew = !id || id === 'new';



  const [name, setName] = useState('');

  const [platform, setPlatform] = useState('');

  const [description, setDescription] = useState('');

  const [config, setConfig] = useState<RuleConfig>({

    version: '1.0',

    rules: [],

    pre_click_xpath: '',
    pre_click_xpaths: [],

  });

  const [loading, setLoading] = useState(!isNew);

  const [saving, setSaving] = useState(false);

  const [err, setErr] = useState('');

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);



  useEffect(() => {

    if (isNew) return;

    const numId = Number(id);

    if (!numId) return;

    setLoading(true);

    api

      .adminRule(numId)

      .then((r) => {

        setName(r.name);

        setPlatform(r.platform);

        setDescription(r.description);

        setConfig(r.config || { rules: [], pre_click_xpath: '', pre_click_xpaths: [] });

      })

      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'))

      .finally(() => setLoading(false));

  }, [id, isNew]);



  async function save() {

    setErr('');

    if (!name.trim()) {

      setErr('请填写规则名称');

      return;

    }

    setSaving(true);

    try {

      if (isNew) {

        const res = await api.createRule({

          name: name.trim(),

          platform: platform.trim(),

          description: description.trim(),

          config,

        });

        navigate(`/rules/${res.id}`, { replace: true });

      } else {

        await api.updateRule(Number(id), {

          name: name.trim(),

          platform: platform.trim(),

          description: description.trim(),

          config,

        });

      }

    } catch (e) {

      setErr(e instanceof Error ? e.message : '保存失败');

    } finally {

      setSaving(false);

    }

  }



  if (loading) {

    return <div className="text-slate-500">加载中…</div>;

  }



  return (

    <div className="min-h-0 flex-1 overflow-y-auto">

      <div className="mb-6">

        <Link
          to="/rules"
          className="inline-flex items-center rounded-full border border-teal-200 bg-white/80 px-3 py-1.5 text-sm font-medium text-teal-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-teal-50 hover:shadow-md"
        >

          ← 返回列表

        </Link>

        <h1 className="mt-2 text-lg font-semibold text-slate-800">

          {isNew ? '新增采集规则' : '编辑采集规则'}

        </h1>

      </div>



      {/* errors are shown as toasts (top-right) */}



      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">

        <div className="grid gap-4 sm:grid-cols-2">

          <div>

            <label className="mb-1 block text-sm font-medium">规则名称 *</label>

            <input

              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"

              value={name}

              onChange={(e) => setName(e.target.value)}

            />

          </div>

          <div>

            <label className="mb-1 block text-sm font-medium">所属平台</label>

            <input

              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"

              value={platform}

              onChange={(e) => setPlatform(e.target.value)}

              placeholder="速卖通 / aliexpress，或 1688 / 阿里巴巴 / alibaba1688（留空=速卖通）"

            />

            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">

              决定插件与后台使用的<strong className="font-medium text-slate-600">采集与隐形加工管线</strong>

              。速卖通：填「速卖通」或「aliexpress」，留空同速卖通；1688/阿里巴巴：填「1688」「阿里巴巴」或「alibaba1688」。XPath 仅采集源数据，平台键用于后续加工与路由。

            </p>

          </div>

        </div>

        <div>

          <label className="mb-1 block text-sm font-medium">规则说明</label>

          <textarea

            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"

            rows={2}

            value={description}

            onChange={(e) => setDescription(e.target.value)}

          />

        </div>



        <RulesTableEditor value={config} onChange={setConfig} />



        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">

          <Link

            to="/rules"

            className="inline-flex items-center rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"

          >

            取消

          </Link>

          <button

            type="button"

            disabled={saving}

            onClick={save}

            className={`${tableActionEditClass} px-4 py-2 text-sm text-teal-800 border-teal-200 hover:border-teal-300 hover:bg-teal-50 disabled:opacity-60`}

          >

            {saving ? '保存中…' : '保存'}

          </button>

        </div>

      </div>

    </div>

  );

}

