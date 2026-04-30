/**
 * 与浏览器插件 side_panel 相同的规则结构，保证采集流程一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuleConfig } from '../api';
import { cstDateCompact, nowCstIsoLike } from '../utils/timeCst';
import {
  tableActionCopyClass,
  tableActionDeleteClass,
  tableActionEditClass,
  tableActionExportClass,
  tableActionRowWrapClass,
} from '../ui/tableActionClasses';

type RuleRow = {
  type: string;
  field: string;
  xpath: string;
  specialXpath: string;
};

function normalizeImportedRule(r: Record<string, unknown>): RuleRow {
  let type = String(r.type || 'field');
  if (r.is_variant || type === 'variant') type = 'list';
  if (type === 'image') {
    type = r.click_list || r.list_xpath ? 'gallery_image' : 'main_image';
  }
  let specialXpath = '';
  if (type === 'main_image' && r.color_list_xpath) specialXpath = String(r.color_list_xpath);
  else if (type === 'gallery_image' && r.thumbnail_list_xpath)
    specialXpath = String(r.thumbnail_list_xpath);
  else if (type === 'detail' && r.value_xpath) specialXpath = String(r.value_xpath);
  else if (r.list_xpath) specialXpath = String(r.list_xpath);
  return {
    type,
    // 用 ?? 避免仅依赖 ||：空串应保留；缺失键用 ''
    field: r.field == null ? '' : String(r.field),
    xpath: r.xpath == null ? '' : String(r.xpath),
    specialXpath,
  };
}

function rowsToEngineRules(rows: RuleRow[]) {
  const rules: Record<string, unknown>[] = [];
  rows.forEach((row) => {
    const { type, field, xpath, specialXpath } = row;
    const isVariant = type === 'list';
    // 注意：列名不要用 `field || defaultField` 写回配置。空串是 falsy，会立刻被改成「字段_n」，
    // 父组件 onChange 回灌后输入框无法退格清空。空列名由插件/engine 在采集时按槽位回落为 字段_${index+1}。
    const rule: Record<string, unknown> = {
      type: type || 'field',
      field,
      is_variant: isVariant,
      parent_xpath: '',
      xpath,
    };
    if (isVariant) rule.variant_name = field;
    if (type === 'main_image' && specialXpath) rule.color_list_xpath = specialXpath;
    if (type === 'gallery_image' && specialXpath) rule.thumbnail_list_xpath = specialXpath;
    if (type === 'detail' && specialXpath) rule.value_xpath = specialXpath;
    rules.push(rule);
  });
  return rules;
}

export default function RulesTableEditor({
  value,
  onChange,
}: {
  value: RuleConfig;
  onChange: (c: RuleConfig) => void;
}) {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [preClickListText, setPreClickListText] = useState('');
  const preClickRef = useRef<HTMLTextAreaElement | null>(null);

  const autoResizePreClick = useCallback(() => {
    const el = preClickRef.current;
    if (!el) return;
    // 自适应高度：先归零，再按 scrollHeight 拉伸；保留最小高度（约 3 行）
    el.style.height = '0px';
    // 最小高度约 1 行（含 padding）
    el.style.height = `${Math.max(el.scrollHeight, 40)}px`;
  }, []);

  useEffect(() => {
    const list = (value.rules || []) as Record<string, unknown>[];
    const editingFieldName =
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.hasAttribute('data-rules-field-name');
    // 列名受控输入：父级 config 回灌时若仍 setRows，会与「刚删成空串」的本地状态打架，表现为最后一个字删不掉。
    if (!list.length) {
      setRows([
        { type: 'field', field: '', xpath: '', specialXpath: '' },
      ]);
    } else if (!editingFieldName) {
      setRows(list.map((r) => normalizeImportedRule(r)));
    }
    const arr = Array.isArray(value.pre_click_xpaths)
      ? value.pre_click_xpaths.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const legacy = String(value.pre_click_xpath || '').trim();
    const merged = [...arr];
    if (legacy && !merged.includes(legacy)) merged.push(legacy);
    // 避免“受控 textarea + 父层 onChange 立即回灌”导致回车时光标跳到行尾：
    // 当用户正在输入（textarea 聚焦）时，不用 props 覆盖本地输入。
    if (typeof document !== 'undefined' && document.activeElement === preClickRef.current) {
      return;
    }
    setPreClickListText(merged.join('\n'));
  }, [value]);

  useEffect(() => {
    autoResizePreClick();
  }, [preClickListText, autoResizePreClick]);

  function parsePreClicks(text: string): string[] {
    return String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const emit = useCallback(
    (nextRows: RuleRow[], preText: string) => {
      const list = parsePreClicks(preText);
      onChange({
        version: value.version || '1.0',
        rules: rowsToEngineRules(nextRows),
        pre_click_xpath: list[0] || '',
        pre_click_xpaths: list,
      });
    },
    [onChange, value.version]
  );

  function updateRow(i: number, patch: Partial<RuleRow>) {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    setRows(next);
    emit(next, preClickListText);
  }

  function addRow() {
    const next = [...rows, { type: 'field', field: '', xpath: '', specialXpath: '' }];
    setRows(next);
    emit(next, preClickListText);
  }

  function removeRow(i: number) {
    let next: RuleRow[];
    if (rows.length <= 1) {
      next = [{ type: 'field', field: '', xpath: '', specialXpath: '' }];
    } else {
      next = rows.filter((_, j) => j !== i);
    }
    setRows(next);
    emit(next, preClickListText);
  }

  function onPreChange(v: string) {
    setPreClickListText(v);
    emit(rows, v);
  }

  function importFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const importData = JSON.parse(String(reader.result));
        if (!importData.rules || !Array.isArray(importData.rules)) {
          alert('导入失败：缺少 rules 字段');
          return;
        }
        const next = importData.rules.map((r: Record<string, unknown>) =>
          normalizeImportedRule(r)
        );
        setRows(next.length ? next : [{ type: 'field', field: '', xpath: '', specialXpath: '' }]);
        const legacyPre = String(importData.pre_click_xpath || '').trim();
        const arrPre = Array.isArray(importData.pre_click_xpaths)
          ? importData.pre_click_xpaths.map((x: unknown) => String(x || '').trim()).filter(Boolean)
          : [];
        const merged = [...arrPre];
        if (legacyPre && !merged.includes(legacyPre)) merged.push(legacyPre);
        const text = merged.join('\n');
        setPreClickListText(text);
        emit(next.length ? next : [{ type: 'field', field: '', xpath: '', specialXpath: '' }], text);
      } catch {
        alert('解析 JSON 失败');
      }
    };
    reader.readAsText(file);
  }

  function exportJson() {
    const rules = rowsToEngineRules(rows);
    const preList = parsePreClicks(preClickListText);
    const exportData = {
      version: '1.0',
      exportTime: nowCstIsoLike(),
      rules,
      pre_click_xpath: preList[0] || '',
      pre_click_xpaths: preList,
    };
    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `采集规则_${cstDateCompact()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">页面预处理（可选）</label>
        <textarea
          ref={preClickRef}
          className="w-full resize-none overflow-hidden rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
          value={preClickListText}
          onChange={(e) => onPreChange(e.target.value)}
          onInput={autoResizePreClick}
          rows={3}
          placeholder={'每行一条 XPath，按顺序执行点击。\n例如：\n//button[contains(., "展开")]\n//button[contains(., "加载更多")]'}
        />
        <p className="mt-1 text-xs text-slate-500">
          插件在采集字段 XPath 之前：先整页滚动，再按顺序点击上述 XPath（可多条）。字段仍只由下方各规则 XPath 决定。
        </p>
      </div>

      <div className={tableActionRowWrapClass}>
        <label className={`${tableActionExportClass} cursor-pointer px-3 py-2 text-sm`}>
          导入规则 JSON
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
        </label>
        <button
          type="button"
          onClick={exportJson}
          className={`${tableActionCopyClass} px-3 py-2 text-sm`}
        >
          导出规则 JSON
        </button>
        <button
          type="button"
          onClick={addRow}
          className={`${tableActionEditClass} px-3 py-2 text-sm`}
        >
          + 新增字段
        </button>
      </div>

      <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              <th className="border-b border-slate-200 px-2 py-2 text-left">类型</th>
              <th className="border-b border-slate-200 px-2 py-2 text-left">列名</th>
              <th className="border-b border-slate-200 px-2 py-2 text-left">字段 XPath</th>
              <th className="border-b border-slate-200 px-2 py-2 text-left">特殊配置</th>
              <th className="border-b border-slate-200 px-2 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const showSpecial =
                row.type === 'main_image' ||
                row.type === 'gallery_image' ||
                row.type === 'detail';
              const ph =
                row.type === 'main_image'
                  ? '颜色列表点击XPath'
                  : row.type === 'gallery_image'
                    ? '缩略图列表XPath'
                    : row.type === 'detail'
                      ? '规格值XPath（可选）'
                      : '';
              return (
                <tr key={i} className="border-b border-slate-100">
                  <td className="p-1 align-top">
                    <select
                      className="w-full rounded border border-slate-200 px-1 py-1"
                      value={row.type}
                      onChange={(e) => updateRow(i, { type: e.target.value })}
                    >
                      <option value="field">字段</option>
                      <option value="list">列表</option>
                      <option value="description">描述</option>
                      <option value="detail">详情</option>
                      <option value="main_image">主图</option>
                      <option value="gallery_image">副图</option>
                      <option value="table">表格</option>
                    </select>
                  </td>
                  <td className="p-1 align-top">
                    <input
                      type="text"
                      data-rules-field-name
                      autoComplete="off"
                      className="w-full rounded border border-slate-200 px-1 py-1"
                      value={row.field}
                      onChange={(e) => updateRow(i, { field: e.target.value })}
                      placeholder="列名"
                    />
                  </td>
                  <td className="p-1 align-top">
                    <input
                      className="w-full rounded border border-slate-200 px-1 py-1"
                      value={row.xpath}
                      onChange={(e) => updateRow(i, { xpath: e.target.value })}
                      placeholder="内容路径"
                    />
                  </td>
                  <td className="p-1 align-top">
                    {showSpecial ? (
                      <input
                        className="w-full rounded border border-slate-200 px-1 py-1"
                        value={row.specialXpath}
                        onChange={(e) => updateRow(i, { specialXpath: e.target.value })}
                        placeholder={ph}
                      />
                    ) : (
                      <span className="block py-1 text-center text-slate-300">-</span>
                    )}
                  </td>
                  <td className="p-1 text-center align-top">
                    <button
                      type="button"
                      className={tableActionDeleteClass}
                      onClick={() => removeRow(i)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
