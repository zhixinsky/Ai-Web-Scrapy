import { useEffect, useMemo, useRef, useState } from 'react';

import { CustomSelect, type CustomSelectOption } from '../components/CustomSelect';
import { platformGlyphForName } from '../components/PlatformGlyph';
import { api, type ExportDestPlatform, type ExportGenericPresetRow, type ExportPreviewResponse, type UserInfo } from '../api';
import { pushToast, toastError, toastSuccess } from '../utils/toast';
import { stableStringify } from '../utils/stableStringify';

type ColumnMappingEntry = {
  excelHeader: string;
  /** 0-based column index in header row (handles duplicate header labels) */
  col?: number;
  // legacy v1
  field?: string;
  source?: ColumnValueSource;
};

/** 常量 / 表达式：在亚马逊扁平行（含 parent/child）时控制写入父行、子行或二者 */
type ConstExprApplyTo = 'both' | 'parent' | 'child';

type ColumnValueSource =
  | { type: 'field'; key: string }
  | { type: 'const'; value: string; applyTo?: ConstExprApplyTo }
  | { type: 'expr'; expr: string; applyTo?: ConstExprApplyTo };

type ExportMappingDraft = {
  version: 2;
  exportTypeId: string;
  sheetName?: string;
  headerRow: number;
  dataStartRow: number;
  headers: string[];
  columns: ColumnMappingEntry[];
};

/** 通用数据预设行（列名手填；来源/配置与主映射一致） */
type GenericPresetRow = {
  id: string;
  excelHeader: string;
  source: ColumnValueSource;
};

const STORAGE_KEY_PREFIX = 'admin-export-column-map:v1:';
/** 记住「选择模板」上次选中的导出类型，刷新后恢复 */
const LAST_SELECTED_EXPORT_TYPE_KEY = 'admin-export-mapping:last-export-type-id';
const HIDE_PUBLIC_TEMPLATES_KEY = 'admin-export-mapping:hide-public-export-templates';

function normalizeHeaderBlob(s: string): string {
  return String(s || '').replace(/^\uFEFF/, '').trim();
}

function storageKey(userId: number, exportTypeId: string) {
  return `${STORAGE_KEY_PREFIX}user:${userId}:${exportTypeId}`;
}

function lastSelectedKey(userId: number) {
  return `${LAST_SELECTED_EXPORT_TYPE_KEY}:user:${userId}`;
}

function readLastSelectedExportTypeId(userId: number): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    const raw = localStorage.getItem(lastSelectedKey(userId));
    const id = String(raw || '').trim();
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return '';
    return id;
  } catch {
    return '';
  }
}

function parseHeaderText(raw: string): string[] {
  const lines = String(raw || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 去重但保持顺序（模板偶尔重复列名；此处仍保留重复，以便逐列映射）
  return lines;
}

function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildCoatBuiltinMap(): Record<string, string> {
  /** 参考服务端 `server/src/export/builtinExportTemplates/coatAmazon.js` 的 buildCoatAmazonBuiltinColumns */
  const m: Record<string, string> = {
    feed_product_type: '商品类型',
    brand_name: 'brand_name',
    item_sku: '卖家SKU',
    update_delete: '更新删除',
    item_name: '标题',
    external_product_id: 'external_product_id',
    external_product_id_type: 'external_product_id_type',
    product_description: 'product_description',
    item_type: 'item_type',
    model: 'model',
    model_name: 'model_name',
    closure_type: 'closure_type',
    part_number: 'part_number',
    manufacturer: 'manufacturer',
    care_instructions: 'care_instructions',
    target_gender: 'target_gender',
    age_range_description: 'age_range_description',
    apparel_size_system: 'apparel_size_system',
    apparel_size_class: 'apparel_size_class',
    apparel_size: '服装尺码数值',
    size_map: '服装尺码数值',
    apparel_body_type: 'apparel_body_type',
    apparel_height_type: 'apparel_height_type',
    main_image_url: '主图',
    parent_child: '父子关系',
    parent_sku: '父SKU',
    generic_keywords: '搜索关键词',
    style_name: 'style_name',
    item_type_name: 'item_type_name',
    material_type1: 'material_type1',
    material_type2: 'material_type2',
    lifestyle: 'lifestyle',
    fit_type: 'fit_type',
    department_name: 'department_name',
    lifecycle_supply_type: 'lifecycle_supply_type',
    sleeve_type: 'sleeve_type',
    fabric_wash: 'fabric_wash',
    item_length_unit_of_measure: 'item_length_unit_of_measure',
    item_length_description: 'item_length_description',
    package_height: 'package_height',
    package_width: 'package_width',
    package_length: 'package_length',
    package_length_unit_of_measure: 'package_length_unit_of_measure',
    package_weight: 'package_weight',
    package_weight_unit_of_measure: 'package_weight_unit_of_measure',
    package_height_unit_of_measure: 'package_height_unit_of_measure',
    package_width_unit_of_measure: 'package_width_unit_of_measure',
    fabric_type: 'fabric_type',
    import_designation: 'import_designation',
    cpsia_cautionary_statement: 'cpsia_cautionary_statement',
    item_weight_unit_of_measure: 'item_weight_unit_of_measure',
    item_weight: 'item_weight',
    country_of_origin: 'country_of_origin',
    batteries_required: 'batteries_required',
    condition_type: 'condition_type',
    number_of_items: 'number_of_items',
    merchant_shipping_group_name: 'merchant_shipping_group_name',
    'fulfillment_availability#1.fulfillment_channel_code':
      'fulfillment_availability#1.fulfillment_channel_code',
    'fulfillment_availability#1.quantity': 'fulfillment_availability#1.quantity',
    'fulfillment_availability#1.lead_time_to_ship_max_days':
      'fulfillment_availability#1.lead_time_to_ship_max_days',
    list_price: 'list_price',
    'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax':
      'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax',
    'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax':
      'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax',
    'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax':
      'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax',
    color_map: '色表',
    color_name: '颜色',
    size_name: '服装尺寸',
    relationship_type: 'relationship_type',
    variation_theme: 'variation_theme',
  };

  for (let k = 1; k <= 8; k++) m[`other_image_url${k}`] = `副图${k}`;
  for (let b = 1; b <= 5; b++) m[`bullet_point${b}`] = `商品特性${b}`;
  return m;
}

/** 参考 `server/src/export/builtinExportTemplates/shirtAmazon.js` 的 buildShirtAmazonBuiltinColumns */
function buildShirtBuiltinMap(): Record<string, string> {
  const m: Record<string, string> = {
    feed_product_type: '商品类型',
    brand_name: 'brand_name',
    item_sku: '卖家SKU',
    update_delete: '更新删除',
    item_name: '标题',
    external_product_id: 'external_product_id',
    external_product_id_type: 'external_product_id_type',
    product_description: 'product_description',
    item_type: 'item_type',
    model: 'model',
    model_name: 'model_name',
    closure_type: 'closure_type',
    part_number: 'part_number',
    manufacturer: 'manufacturer',
    care_instructions: 'care_instructions',
    shirt_size: '服装尺码数值',
    main_image_url: '主图',
    parent_child: '父子关系',
    parent_sku: '父SKU',
  };
  for (let k = 1; k <= 8; k++) m[`other_image_url${k}`] = `副图${k}`;
  for (let b = 1; b <= 5; b++) m[`bullet_point${b}`] = `商品特性${b}`;
  m.generic_keywords = '搜索关键词';
  m.list_price = 'list_price';
  m['purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax'] =
    'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax';
  m['purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax'] =
    'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax';
  m['purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax'] =
    'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax';
  m.color_map = '色表';
  m.color_name = '颜色';
  m.relationship_type = 'relationship_type';
  m.variation_theme = 'variation_theme';
  return m;
}

const FIELD_KEY_ALIASES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const legacy of [buildCoatBuiltinMap(), buildShirtBuiltinMap()]) {
    for (const [field, header] of Object.entries(legacy)) {
      const h = String(header || '').trim();
      const f = String(field || '').trim();
      if (!h || !f) continue;
      if (h !== f) out[h] = f;
    }
  }
  return out;
})();

function normalizeFieldKey(rawKey: string): string {
  const k = String(rawKey || '').trim();
  if (!k) return '';
  return String(FIELD_KEY_ALIASES[k] || k).trim();
}

function isChildOnlyFieldKey(rawKey: string): boolean {
  const key = normalizeFieldKey(rawKey);
  return key === 'model' || key === 'model_name' || key === 'part_number';
}

/**
 * 导出映射「字段」来源：仅允许下列英文 key（与运营约定一致）；其余模板列请用「常量 / 表达式」。
 * 顺序即下拉展示顺序。
 */
const AMAZON_EXPORT_FIELD_PICKER_KEYS: readonly string[] = [
  'item_sku',
  'item_name',
  'product_description',
  'model',
  'model_name',
  'part_number',
  'apparel_size',
  'main_image_url',
  'other_image_url1',
  'other_image_url2',
  'other_image_url3',
  'other_image_url4',
  'other_image_url5',
  'other_image_url6',
  'other_image_url7',
  'other_image_url8',
  'parent_child',
  'parent_sku',
  'bullet_point1',
  'bullet_point2',
  'bullet_point3',
  'bullet_point4',
  'bullet_point5',
  'generic_keywords',
  'color_name',
  'list_price',
  'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax',
  'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax',
  'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax',
];

// 右侧“字段下拉”显示用中文别名（不改变实际写入的 key）
const KEY_LABELS_FOR_RIGHT_SELECT: Record<string, string> = {
  style_name: '娱乐类型',
  age_range_description: '年龄范围描述',
  apparel_body_type: '服装尺码体型分类',
  apparel_height_type: '服装尺码身高分类',
  apparel_size_class: '服装尺码类别',
  apparel_size_system: '服装尺码体系',
  brand_name: '品牌',
  care_instructions: '商品护理说明',
  closure_type: '服装门襟类型',
  department_name: '部门名称',
  external_product_id: '商品编码',
  external_product_id_type: '商品编码类型',
  fit_type: '贴合类型',
  item_type: '产品类型关键字',
  item_type_name: '服装类型',
  lifestyle: '生活方式',
  list_price: '市场价',
  manufacturer: '制造商',
  material_type1: '外壳材料',
  material_type2: '外壳材料',
  model: '型号',
  model_name: '型号名称',
  part_number: '制造商零件编号',
  product_description: '关于此艺术品',
  'purchasable_offer[marketplace_id=A1AM78C64UM0Y8]#1.our_price#1.schedule#1.value_with_tax': '您的价格 MXN (MX)',
  'purchasable_offer[marketplace_id=A2EUQ1WTGCTBG2]#1.our_price#1.schedule#1.value_with_tax': '您的价格 CAD (CA)',
  'purchasable_offer[marketplace_id=ATVPDKIKX0DER]#1.our_price#1.schedule#1.value_with_tax': '您的价格 USD (US)',
  relationship_type: '关系类型',
  target_gender: '适用性别',
  variation_theme: '商品变体主题',
  apparel_size: '服装尺码数值',
  batteries_required: '此商品是否使用电池或商品本身是电池？',
  bullet_point1: '商品特性1',
  bullet_point2: '商品特性2',
  bullet_point3: '商品特性3',
  bullet_point4: '商品特性4',
  bullet_point5: '商品特性5',
  color_map: '色表',
  color_name: '颜色',
  condition_type: '状况',
  country_of_origin: '原产国',
  cpsia_cautionary_statement: '强制性警示声明',
  fabric_type: '面料类型',
  fabric_wash: '水洗方式',
  feed_product_type: '商品类型',
  'fulfillment_availability#1.fulfillment_channel_code': '物流渠道代码',
  'fulfillment_availability#1.quantity': '数量 (US, CA, MX)',
  'fulfillment_availability#1.lead_time_to_ship_max_days': '处理时间 (US, CA, MX)',
  generic_keywords: '搜索关键词',
  import_designation: '进口标识',
  item_length_description: '商品长度',
  item_length_unit_of_measure: '商品长度计量单位',
  item_name: '商品名称',
  item_sku: '卖家SKU',
  item_weight: '商品重量',
  item_weight_unit_of_measure: '商品重量计量单位',
  lifecycle_supply_type: '生命周期供应类型',
  main_image_url: '主图片 URL',
  merchant_shipping_group_name: '配送模板',
  number_of_items: '物品数量',
  other_image_url1: '其他图片 URL1',
  other_image_url2: '其他图片 URL2',
  other_image_url3: '其他图片 URL3',
  other_image_url4: '其他图片 URL4',
  other_image_url5: '其他图片 URL5',
  other_image_url6: '其他图片 URL6',
  other_image_url7: '其他图片 URL7',
  other_image_url8: '其他图片 URL8',
  package_height: '包装高度',
  package_height_unit_of_measure: '包装高度计量单位',
  package_width: '包装宽度',
  package_width_unit_of_measure: '包装宽度计量单位',
  package_length: '包装长度',
  package_length_unit_of_measure: '包装长度计量单位',
  package_weight: '包装重量',
  package_weight_unit_of_measure: '包装重量计量单位',
  parent_child: '父子关系',
  size_map: '尺寸名称',
  parent_sku: '父SKU',
  size_name: '商品尺寸',
  shirt_size: '衬衫尺码',
  sleeve_type: '袖型',
  update_delete: '更新删除',
};

/** 从 coat / shirt 内置映射反查：英文 field key → 中文（懒构建） */
let reverseCoatFieldLabelCache: Record<string, string> | null = null;
function getReverseCoatFieldLabels(): Record<string, string> {
  if (reverseCoatFieldLabelCache) return reverseCoatFieldLabelCache;
  const out: Record<string, string> = {};
  for (const legacy of [buildCoatBuiltinMap(), buildShirtBuiltinMap()]) {
    for (const [, rawV] of Object.entries(legacy)) {
      const nk = normalizeFieldKey(String(rawV));
      if (!nk) continue;
      const rv = String(rawV).trim();
      if (/[\u4e00-\u9fff]/.test(rv) && !out[nk]) out[nk] = rv;
    }
  }
  reverseCoatFieldLabelCache = out;
  return out;
}

/** 优先用手动表，其次从 coat 内置映射里反查中文列名（与 buildCoatBuiltinMap 一致） */
function getKeyLabelForDisplay(key: string): string {
  const k = String(key || '').trim();
  if (!k) return '';
  const manual = String(KEY_LABELS_FOR_RIGHT_SELECT[k] || '').trim();
  if (manual) return manual;
  return getReverseCoatFieldLabels()[k] || '';
}

function truncateDisplay(s: string, max: number): string {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function newGenericPresetRowId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="app-modal-backdrop fixed inset-0 z-[320] flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal
        aria-labelledby="confirm-modal-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl"
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id="confirm-modal-title" className="text-sm font-semibold text-slate-800">
            {title}
          </h2>
        </div>
        <div className="px-4 py-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{message}</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
          {String(cancelText || '').trim() ? (
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
              onClick={onCancel}
              disabled={busy}
            >
              {cancelText}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameModal({
  open,
  title,
  initialValue,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (nextName: string) => void;
}) {
  const [v, setV] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setV(String(initialValue || '').trim());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, initialValue, onCancel]);
  useEffect(() => {
    if (!open) return;
    // 让弹窗出现后自动聚焦输入框
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[320] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal
        aria-labelledby="rename-modal-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl"
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id="rename-modal-title" className="text-sm font-semibold text-slate-800">
            {title}
          </h2>
        </div>
        <div className="px-4 py-4">
          <label className="block text-xs font-medium text-slate-600">新名称</label>
          <input
            ref={inputRef}
            className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-teal-400"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder="请输入模板名称"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm(String(v || '').trim());
            }}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">回车提交，Esc 取消。</p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            onClick={() => onConfirm(String(v || '').trim())}
            disabled={busy}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

/** 居中弹窗：搜索并选择字段 key */
function FieldKeyModal({
  open,
  excelHeader,
  value,
  onPick,
  onClose,
  options,
  disabled,
}: {
  open: boolean;
  excelHeader: string;
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
  options: string[];
  disabled: boolean;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    if (open) setQ('');
  }, [open, excelHeader]);

  const filtered = useMemo(() => {
    const base = options.slice(0, 400);
    const needle = q.trim().toLowerCase();
    if (!needle) return base.slice(0, 200);
    return base
      .filter((k) => {
        const kk = String(k).toLowerCase();
        const lab = getKeyLabelForDisplay(k).toLowerCase();
        return kk.includes(needle) || lab.includes(needle);
      })
      .slice(0, 200);
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pick = (k: string) => {
    if (disabled) return;
    const nk = normalizeFieldKey(k);
    onPick(nk);
    onClose();
  };

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[300] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal
        aria-labelledby="field-key-modal-title"
        className="flex max-h-[min(32rem,88vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 id="field-key-modal-title" className="text-sm font-semibold text-slate-800">
            选择字段
          </h2>
          <p className="mt-0.5 break-all font-mono text-[11px] leading-relaxed text-slate-500">{excelHeader}</p>
          <input
            className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-teal-400"
            placeholder="搜索中文名或英文 key…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            disabled={disabled}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          {filtered.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-slate-500">无匹配项</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {filtered.map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={disabled}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm transition hover:border-teal-300 hover:bg-teal-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => pick(k)}
                  title={k}
                >
                  <div className="truncate font-medium text-slate-800">{getKeyLabelForDisplay(k) || k}</div>
                  {getKeyLabelForDisplay(k) ? (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{k}</div>
                  ) : (
                    <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">（无中文别名）</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
          {value ? (
            <span className="text-[11px] text-slate-400">当前：{getKeyLabelForDisplay(value) || value}</span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * excel 列名与内置表一致时：excelHeader → 程序字段（英文 key）
 */
function mappingFromLegacyMap(legacy: Record<string, string>, headers: string[]): Record<string, ColumnValueSource> {
  const next: Record<string, ColumnValueSource> = {};
  for (const h of headers) {
    const v = legacy[h];
    if (v == null || String(v).trim() === '') continue;
    const nk = normalizeFieldKey(String(v));
    if (nk) next[h] = { type: 'field', key: nk };
  }
  return next;
}

/**
 * coat（单商城）等 Volt 风格列名：在列名与 coat 不完全一致时按 pattern 补映射（不覆盖已有）
 */
function fillCoatSingleMallVoltPatterns(
  headers: string[],
  out: Record<string, ColumnValueSource>
) {
  for (const h of headers) {
    if (out[h]) continue;
    let m: RegExpMatchArray | null = null;
    const s = String(h);
    if (
      /main_product_image_locator/i.test(s) ||
      /main_image_url/i.test(s) ||
      /main_image/i.test(s)
    ) {
      out[h] = { type: 'field', key: normalizeFieldKey('主图') };
      continue;
    }
    m = s.match(/other_(?:product|offer)_image_locator_(\d+)/i);
    if (m) {
      out[h] = { type: 'field', key: normalizeFieldKey(`副图${m[1]}`) };
      continue;
    }
    m = s.match(/bullet_point.*?#(\d+)\.value$/i) || s.match(/bullet_point(\d+)$/i);
    if (m) {
      out[h] = { type: 'field', key: normalizeFieldKey(`商品特性${m[1]}`) };
      continue;
    }
    if (/generic_keyword/i.test(s) || /generic_keywords/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('搜索关键词') };
      continue;
    }
    if (/item_name/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('标题') };
      continue;
    }
    if (/brand/i.test(s) && !/brand_registry/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('brand_name') };
      continue;
    }
    if (/product_description/i.test(s) || /description/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('product_description') };
      continue;
    }
    if (/list_price/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('list_price') };
      continue;
    }
    if (/variation_theme/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('variation_theme') };
      continue;
    }
    if (/parentage_level/i.test(s) || /parent_child/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('父子关系') };
      continue;
    }
    if (/parent_sku/i.test(s) || /parent_sku_relationship/i.test(s) || /parent_sku$/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('父SKU') };
      continue;
    }
    if (/item_sku/i.test(s) || /contribution_sku/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('卖家SKU') };
      continue;
    }
    if (/color.*?value/i.test(s) || /color_name/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('颜色') };
      continue;
    }
    if (/color_map/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('色表') };
      continue;
    }
    if (/size_name/i.test(s) || /apparel_size/i.test(s) || /shirt_size/i.test(s)) {
      out[h] = { type: 'field', key: normalizeFieldKey('服装尺寸') };
      continue;
    }
    if (s === '::record_action' || /record_action/i.test(s) || /update_delete/i.test(s)) {
      out[h] = { type: 'const', value: 'Update' };
    }
  }
}

function buildAutoMappingForBuiltinTemplate(
  templateId: 'coat' | 'shirt' | 'coat_a',
  headers: string[]
): Record<string, ColumnValueSource> {
  if (templateId === 'coat') {
    return mappingFromLegacyMap(buildCoatBuiltinMap(), headers);
  }
  if (templateId === 'shirt') {
    return mappingFromLegacyMap(buildShirtBuiltinMap(), headers);
  }
  const base = mappingFromLegacyMap(buildCoatBuiltinMap(), headers);
  fillCoatSingleMallVoltPatterns(headers, base);
  return base;
}

function normalizeApplyToDraft(v: unknown): ConstExprApplyTo | undefined {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'parent' || s === 'child' || s === 'both') return s;
  return undefined;
}

function getConstExprApplyTo(s: ColumnValueSource | undefined): ConstExprApplyTo {
  if (!s || (s.type !== 'const' && s.type !== 'expr')) return 'both';
  return s.applyTo ?? 'both';
}

function applyToShortLabel(at: ConstExprApplyTo): string {
  if (at === 'parent') return '仅父行';
  if (at === 'child') return '仅子行';
  return '父行与子行';
}

/** 先选填充范围，再填内容 */
function ConstExprEditorModal({
  open,
  excelHeader,
  source,
  onSave,
  onClose,
  disabled,
}: {
  open: boolean;
  excelHeader: string;
  source: ColumnValueSource | undefined;
  onSave: (next: ColumnValueSource) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  // 用 source 初始化，避免弹窗首次打开出现 “both → child” 闪烁
  const [applyTo, setApplyTo] = useState<ConstExprApplyTo>(() => getConstExprApplyTo(source));
  const [value, setValue] = useState(() => (source?.type === 'const' ? String(source.value ?? '') : ''));
  const [expr, setExpr] = useState(() => (source?.type === 'expr' ? String(source.expr ?? '') : ''));

  const mode = source?.type === 'expr' ? 'expr' : 'const';

  useEffect(() => {
    if (!open || !source) return;
    if (source.type === 'const') {
      setApplyTo(getConstExprApplyTo(source));
      setValue(source.value);
    } else if (source.type === 'expr') {
      setApplyTo(getConstExprApplyTo(source));
      setExpr(source.expr);
    }
  }, [open, source, excelHeader]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || (source?.type !== 'const' && source?.type !== 'expr')) return null;

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[300] flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal
        aria-labelledby="const-expr-modal-title"
        className="w-full max-w-md rounded-2xl border border-slate-200/90 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="const-expr-modal-title" className="text-sm font-semibold text-slate-800">
          {mode === 'const' ? '配置常量' : '配置表达式'}
        </h2>
        <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-slate-500">{excelHeader}</p>

        <div className="mt-5">
          <p className="text-xs font-medium text-slate-700">1. 填充范围</p>
          <p className="mt-1 text-[11px] text-slate-500">亚马逊扁平行含父行、子行时生效；无父/子区分时仍写入每一行。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                { v: 'both' as const, label: '父行与子行' },
                { v: 'parent' as const, label: '仅父行' },
                { v: 'child' as const, label: '仅子行' },
              ] as const
            ).map(({ v, label }) => (
              <button
                key={v}
                type="button"
                disabled={disabled}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
                  applyTo === v
                    ? 'bg-teal-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                onClick={() => setApplyTo(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <label htmlFor="const-expr-modal-content" className="text-xs font-medium text-slate-700">
            2. {mode === 'const' ? '固定值' : '表达式'}
          </label>
          {mode === 'const' ? (
            <input
              id="const-expr-modal-content"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm outline-none ring-0 focus:border-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="写入单元格的固定文本"
              disabled={disabled}
            />
          ) : (
            <textarea
              id="const-expr-modal-content"
              className="mt-2 min-h-[7rem] w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-xs leading-relaxed outline-none ring-0 focus:border-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder="例：{{item_name}}、{{default(brand_name,'Generic')}}"
              disabled={disabled}
              spellCheck={false}
            />
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={disabled}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (disabled) return;
              if (mode === 'const') {
                onSave({ type: 'const', value, applyTo });
              } else {
                onSave({ type: 'expr', expr, applyTo });
              }
              onClose();
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

function normalizeSourceFromLegacy(e: ColumnMappingEntry): ColumnValueSource | null {
  if (e?.source && typeof e.source === 'object') {
    const t = (e.source as any).type;
    if (t === 'field') {
      const k = String((e.source as any).key ?? '').trim();
      const nk = normalizeFieldKey(k);
      return nk ? { type: 'field', key: nk } : null;
    }
    if (t === 'const') {
      const at = normalizeApplyToDraft((e.source as any).applyTo);
      return { type: 'const', value: String((e.source as any).value ?? ''), ...(at ? { applyTo: at } : {}) };
    }
    if (t === 'expr') {
      const expr = String((e.source as any).expr ?? '').trim();
      if (!expr) return null;
      const at = normalizeApplyToDraft((e.source as any).applyTo);
      return { type: 'expr', expr, ...(at ? { applyTo: at } : {}) };
    }
  }
  const f = String(e?.field ?? '').trim();
  const nf = normalizeFieldKey(f);
  return nf ? { type: 'field', key: nf } : null;
}

function getByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur: any = obj;
  const parts = String(path || '')
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([^\[\]]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    const k = m[1];
    if (cur == null) return undefined;
    cur = cur[k];
    if (m[2] != null) {
      const idx = Number(m[2]);
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    }
  }
  return cur;
}

function evalExpr(exprRaw: string, ctx: Record<string, unknown> | null): string {
  const expr = String(exprRaw || '').trim();
  if (!expr || !ctx) return '';
  // 极简表达式：支持 {{path}}、{{default(path,'x')}}、{{join(path, ',')}}、{{slice(path,0,8)}}（slice 返回 join 后的字符串）
  const body = expr.replace(/^\{\{|\}\}$/g, '').trim();
  const mDefault = body.match(/^default\((.+?),\s*'([^']*)'\)$/);
  if (mDefault) {
    const v = getByPath(ctx, mDefault[1].trim());
    const s = v == null || String(v).trim() === '' ? mDefault[2] : String(v);
    return s;
  }
  const mJoin = body.match(/^join\((.+?),\s*'([^']*)'\)$/);
  if (mJoin) {
    const v = getByPath(ctx, mJoin[1].trim());
    if (Array.isArray(v)) return v.map((x) => String(x ?? '')).join(mJoin[2]);
    return String(v ?? '');
  }
  const mSlice = body.match(/^slice\((.+?),\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (mSlice) {
    const v = getByPath(ctx, mSlice[1].trim());
    const a = Number(mSlice[2]);
    const b = Number(mSlice[3]);
    if (Array.isArray(v)) return v.slice(a, b).map((x) => String(x ?? '')).join(' ');
    const s = String(v ?? '');
    return s.slice(a, b);
  }
  const v = getByPath(ctx, body);
  return v == null ? '' : String(v);
}

function toastInfo(message: string, title = '提示', timeoutMs = 2600) {
  pushToast({ tone: 'info', title, message, timeoutMs });
}

function toastWarning(message: string, title = '注意', timeoutMs = 3600) {
  pushToast({ tone: 'warning', title, message, timeoutMs });
}

export default function ExportMappingPage({ user }: { user: UserInfo }) {
  const [exportTypeId, setExportTypeId] = useState<string>(() => readLastSelectedExportTypeId(user.id));
  const [sheetName, setSheetName] = useState<string>('模板');
  const [headerRow, setHeaderRow] = useState<number>(1);
  const [dataStartRow, setDataStartRow] = useState<number>(2);
  const [headerText, setHeaderText] = useState<string>('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importPendingFile, setImportPendingFile] = useState<File | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmBusy, setDeleteConfirmBusy] = useState(false);
  const [deletePendingTemplate, setDeletePendingTemplate] = useState<{
    id: string;
    name: string;
    uidLabel: string;
  } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameTemplateId, setRenameTemplateId] = useState<string>('');
  const [renameInitial, setRenameInitial] = useState<string>('');
  const [previewCollectionId, setPreviewCollectionId] = useState<number>(0);
  const [preview, setPreview] = useState<ExportPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [selectedHeaderKey, setSelectedHeaderKey] = useState<string>('');
  const [headerTemplateValue, setHeaderTemplateValue] = useState<string>('');
  const isCustomHeaderTemplate = String(headerTemplateValue).startsWith('custom:');
  const [customTemplates, setCustomTemplates] = useState<
    Array<{
      id: string;
      name: string;
      exportTypeId: string;
      destPlatformId: string;
      originalFilename: string;
      sheetName: string;
      headerRow: number;
      dataStartRow: number;
      createdByUserId?: number | null;
      isPublic?: number;
    }>
  >([]);
  const [uploadTemplateOpen, setUploadTemplateOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadDestPlatformId, setUploadDestPlatformId] = useState('');
  const [uploadIsPublic, setUploadIsPublic] = useState(false);
  const [exportPlatforms, setExportPlatforms] = useState<ExportDestPlatform[]>([]);
  const [uploadSheetName, setUploadSheetName] = useState('模板');
  const [uploadHeaderRow, setUploadHeaderRow] = useState<number>(1);
  const [uploadDataStartRow, setUploadDataStartRow] = useState<number>(2);
  const uploadFileRef = useRef<HTMLInputElement | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [templateMetaSaveBusy, setTemplateMetaSaveBusy] = useState(false);
  /** 初始“草稿内容”快照：用于判断是否有改动（每个 exportTypeId 一份） */
  const initialDraftSnapshotRef = useRef<Record<string, string>>({});
  /** 初始快照是否已就绪（需等待服务端/本机草稿加载并应用完成） */
  const snapshotReadyRef = useRef<Record<string, boolean>>({});
  const [hidePublicTemplates, setHidePublicTemplates] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDE_PUBLIC_TEMPLATES_KEY) === '1';
    } catch {
      return false;
    }
  });
  /** 当前打开「选择字段」弹窗的 excelHeader；常量/表达式用 constExprEditorFor */
  const [fieldPickerFor, setFieldPickerFor] = useState<string | null>(null);
  const [constExprEditorFor, setConstExprEditorFor] = useState<string | null>(null);
  const [genericDataModalOpen, setGenericDataModalOpen] = useState(false);
  const [genericPresetRows, setGenericPresetRows] = useState<GenericPresetRow[]>([]);
  const [genericFieldPickerForId, setGenericFieldPickerForId] = useState<string | null>(null);
  const [genericConstExprForId, setGenericConstExprForId] = useState<string | null>(null);
  const [genericPresetLoadBusy, setGenericPresetLoadBusy] = useState(false);
  const [genericPresetSaveBusy, setGenericPresetSaveBusy] = useState(false);
  const genericPresetLoadedRef = useRef(false);
  const genericApplyRunIdRef = useRef<string>('');
  const genericApplySummaryRef = useRef<{
    runId: string;
    filledRows: number;
    filledColumns: number;
    matchedRows: number;
    skippedColumns: number;
  } | null>(null);
  const genericImportFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!err) return;
    toastError(err);
    setErr('');
  }, [err]);

  useEffect(() => {
    setFieldPickerFor(null);
    setConstExprEditorFor(null);
  }, [exportTypeId]);

  useEffect(() => {
    if (fieldPickerFor) setGenericFieldPickerForId(null);
  }, [fieldPickerFor]);
  useEffect(() => {
    if (genericFieldPickerForId) setFieldPickerFor(null);
  }, [genericFieldPickerForId]);
  useEffect(() => {
    if (constExprEditorFor) setGenericConstExprForId(null);
  }, [constExprEditorFor]);
  useEffect(() => {
    if (genericConstExprForId) setConstExprEditorFor(null);
  }, [genericConstExprForId]);

  useEffect(() => {
    if (!genericDataModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGenericDataModalOpen(false);
        setGenericFieldPickerForId(null);
        setGenericConstExprForId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [genericDataModalOpen]);

  async function loadGenericPresetsOnce(opts?: { silent?: boolean; force?: boolean }) {
    if (!opts?.force && genericPresetLoadedRef.current === true) return;
    let rowsOut: GenericPresetRow[] = [];
    setGenericPresetLoadBusy(true);
    try {
      const r = await api.getExportGenericPresets();
      const rowsIn = Array.isArray(r.rows) ? r.rows : [];
      const out: GenericPresetRow[] = [];
      for (const entry of rowsIn) {
        if (!entry || typeof entry !== 'object') continue;
        const excelHeader = String((entry as any).excelHeader || '').trim();
        if (!excelHeader) continue;
        const srcAny = (entry as any).source;
        if (!srcAny || typeof srcAny !== 'object' || Array.isArray(srcAny)) continue;
        const t = String((srcAny as any).type || '').trim();
        if (t === 'field') {
          const key = String((srcAny as any).key || '').trim();
          if (!key) continue;
          out.push({ id: newGenericPresetRowId(), excelHeader, source: { type: 'field', key } });
        } else if (t === 'const') {
          const value = (srcAny as any).value == null ? '' : String((srcAny as any).value);
          const applyToRaw = String((srcAny as any).applyTo || '').trim();
          const applyTo =
            applyToRaw === 'parent' || applyToRaw === 'child' || applyToRaw === 'both' ? applyToRaw : undefined;
          out.push({
            id: newGenericPresetRowId(),
            excelHeader,
            source: { type: 'const', value, ...(applyTo ? { applyTo } : {}) },
          });
        } else if (t === 'expr') {
          const expr = String((srcAny as any).expr || '').trim();
          if (!expr) continue;
          const applyToRaw = String((srcAny as any).applyTo || '').trim();
          const applyTo =
            applyToRaw === 'parent' || applyToRaw === 'child' || applyToRaw === 'both' ? applyToRaw : undefined;
          out.push({
            id: newGenericPresetRowId(),
            excelHeader,
            source: { type: 'expr', expr, ...(applyTo ? { applyTo } : {}) },
          });
        }
      }
      rowsOut = out;
      setGenericPresetRows(out);
      genericPresetLoadedRef.current = true;
    } catch (e) {
      if (!opts?.silent) toastError(e instanceof Error ? e.message : '加载失败', '通用数据', 3200);
    } finally {
      setGenericPresetLoadBusy(false);
    }
    return rowsOut;
  }

  useEffect(() => {
    if (!genericDataModalOpen) return;
    // 每次打开弹窗都以服务器为准（用户级通用数据，与当前模板无关）
    void loadGenericPresetsOnce({ force: true, silent: false });
  }, [genericDataModalOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
        if (cancelled) return;
        setCustomTemplates(Array.isArray(r.templates) ? r.templates : []);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hidePublicTemplates]);

  // 定时刷新模板列表：当他人取消公开时，自动从下拉移除，并清空当前选中模板的表头/映射
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
        if (cancelled) return;
        const list = Array.isArray(r.templates) ? r.templates : [];
        setCustomTemplates(list);
        const curId =
          String(headerTemplateValue || '').startsWith('custom:')
            ? String(headerTemplateValue).slice('custom:'.length).trim()
            : '';
        if (curId && !list.some((t) => t.id === curId)) {
          setHeaderTemplateValue('');
          setExportTypeId('');
          setHeaderText('');
          setSheetName('模板');
          setHeaderRow(1);
          setDataStartRow(2);
          setMap({});
          setSelectedHeaderKey('');
          setPreview(null);
          toastWarning('当前模板已取消公开或无权访问，已自动清空表头与映射。', '模板不可用');
        }
      } catch {
        // ignore
      }
    };
    const t = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [headerTemplateValue, hidePublicTemplates]);

  // 初次进入：若有模板但尚未选择，则按 localStorage 的 exportTypeId 或列表第一个自动选中
  useEffect(() => {
    if (!customTemplates.length) return;
    if (String(headerTemplateValue || '').startsWith('custom:')) return;
    const want = String(exportTypeId || '').trim();
    const hit = want ? customTemplates.find((t) => String(t.exportTypeId).trim() === want) : null;
    if (hit?.id) {
      void applyCustomTemplate(hit.id);
      return;
    }
    void applyCustomTemplate(customTemplates[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customTemplates]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.exportPlatforms();
        if (cancelled) return;
        setExportPlatforms(Array.isArray(r.platforms) ? r.platforms : []);
      } catch {
        setExportPlatforms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(lastSelectedKey(user.id), exportTypeId);
    } catch {
      /* ignore */
    }
  }, [exportTypeId, user.id]);

  const headers = useMemo(() => parseHeaderText(headerText), [headerText]);

  const headerTemplateSelectOptions = useMemo(() => {
    const base: CustomSelectOption[] = [];
    if (customTemplates.length) {
      for (const t of customTemplates) {
        const uid = (t as any)?.createdByUserId;
        const uidLabelBase = uid == null || String(uid).trim() === '' ? '未知' : String(uid).trim();
        const uidLabel = `ID_${uidLabelBase}`;
        const isMine = uid != null && Number(uid) === Number(user.id);
        const isPublic = Number((t as any)?.isPublic) === 1;
        base.push({
          value: `custom:${t.id}`,
          label: `${String(t.name || '').trim() || '未命名模板'}（${uidLabel}）`,
          ...(!isMine && isPublic
            ? {
                leftBadgeLabel: '共享',
                leftBadgeClassName: 'border-amber-200 bg-amber-50 text-amber-800',
              }
            : {}),
          ...(isMine
            ? {
                renameLabel: '重命名',
                onRename: () => {
                  const cur = String(t.name || '').trim() || '未命名模板';
                  setRenameTemplateId(String(t.id));
                  setRenameInitial(cur);
                  setRenameOpen(true);
                },
                toggleLabel: '公开',
                toggleChecked: isPublic,
                onToggle: (nextChecked: boolean) => {
                  void (async () => {
                    setErr('');
                    try {
                      const r = await api.patchAdminExportTemplateVisibility(t.id, { isPublic: nextChecked ? 1 : 0 });
                      setCustomTemplates((prev) =>
                        prev.map((x) => (x.id === t.id ? { ...x, isPublic: r.isPublic } : x))
                      );
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : '更新失败');
                    }
                  })();
                },
              }
            : {}),
           ...(isMine
             ? {
                 onDelete: () => {
                  setDeletePendingTemplate({
                    id: String(t.id),
                    name: String(t.name || '').trim() || '未命名模板',
                    uidLabel,
                  });
                  setDeleteConfirmOpen(true);
                 },
                 deleteLabel: '删除',
               }
             : {}),
          ...(!isMine && isPublic
            ? {
                copyLabel: '复制',
                onCopy: () => {
                  void (async () => {
                    setErr('');
                    try {
                      const r = await api.adminCopyExportTemplate(t.id);
                      const newId = r?.template?.id;
                      const list = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
                      setCustomTemplates(Array.isArray(list.templates) ? list.templates : []);
                      if (newId) await applyCustomTemplate(newId);
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : '复制失败');
                    }
                  })();
                },
              }
            : {}),
        });
      }
    }
    return base;
  }, [customTemplates]);

  const selectedTemplateId = isCustomHeaderTemplate ? String(headerTemplateValue).slice('custom:'.length).trim() : '';
  const selectedTemplate = selectedTemplateId ? customTemplates.find((t) => t.id === selectedTemplateId) : null;
  const isSharedTemplate =
    !!selectedTemplate &&
    Number(selectedTemplate.isPublic) === 1 &&
    selectedTemplate.createdByUserId != null &&
    Number(selectedTemplate.createdByUserId) !== Number(user.id);
  const templateMetaDirty =
    !!selectedTemplate &&
    !isSharedTemplate &&
    (String(sheetName || '').trim() !== String(selectedTemplate.sheetName || '').trim() ||
      Math.max(1, Number(headerRow) || 1) !== Math.max(1, Number(selectedTemplate.headerRow) || 1) ||
      Math.max(1, Number(dataStartRow) || 1) !== Math.max(1, Number(selectedTemplate.dataStartRow) || 1));

  async function applyCustomTemplate(templateId: string) {
    setErr('');
    // 切换模板时先清空旧映射，避免短暂“串模板”
    setMap({});
    setSelectedHeaderKey('');
    setPreview(null);
    try {
      const r = await api.adminExportTemplate(templateId);
      const t = r.template;
      setHeaderTemplateValue(`custom:${t.id}`);
      setExportTypeId(String(t.exportTypeId || '').trim() || exportTypeId);
      setSheetName(String(t.sheetName || '').trim() || sheetName);
      setHeaderRow(Math.max(1, Number(t.headerRow) || 1));
      setDataStartRow(Math.max(1, Number(t.dataStartRow) || 1));
      if (Array.isArray(t.headers) && t.headers.length) {
        setHeaderText(t.headers.map((x) => String(x ?? '').trim()).join('\n'));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载模板失败');
    }
  }

  function applyHeaderTemplate(v: string) {
    const s = String(v || '');
    if (!s.startsWith('custom:')) return;
    const id = s.slice('custom:'.length).trim();
    if (id) void applyCustomTemplate(id);
  }

  async function onSaveTemplateMeta() {
    if (!selectedTemplateId || isSharedTemplate || templateMetaSaveBusy) return;
    setErr('');
    const nextSheetName = String(sheetName || '').trim();
    const nextHeaderRow = Math.floor(Number(headerRow));
    const nextDataStartRow = Math.floor(Number(dataStartRow));
    if (!nextSheetName) {
      setErr('sheetName 不能为空');
      return;
    }
    if (!Number.isFinite(nextHeaderRow) || nextHeaderRow < 1) {
      setErr('表头行必须是 >=1 的数字');
      return;
    }
    if (!Number.isFinite(nextDataStartRow) || nextDataStartRow < 1) {
      setErr('数据起始行必须是 >=1 的数字');
      return;
    }
    if (nextDataStartRow <= nextHeaderRow) {
      setErr('数据起始行必须大于表头行');
      return;
    }
    if (!templateMetaDirty) {
      toastInfo('未检测到模板参数变化', '无需保存', 1800);
      return;
    }
    setTemplateMetaSaveBusy(true);
    try {
      const r = await api.updateAdminExportTemplateMeta(selectedTemplateId, {
        sheetName: nextSheetName,
        headerRow: nextHeaderRow,
        dataStartRow: nextDataStartRow,
      });
      const t = r.template;
      setSheetName(t.sheetName);
      setHeaderRow(t.headerRow);
      setDataStartRow(t.dataStartRow);
      setHeaderText((Array.isArray(t.headers) ? t.headers : []).map((x) => String(x ?? '').trim()).join('\n'));
      setCustomTemplates((prev) =>
        prev.map((x) =>
          x.id === selectedTemplateId
            ? {
                ...x,
                sheetName: t.sheetName,
                headerRow: t.headerRow,
                dataStartRow: t.dataStartRow,
              }
            : x
        )
      );
      toastSuccess('模板参数已保存，表头已重新解析', '保存成功');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存模板参数失败');
    } finally {
      setTemplateMetaSaveBusy(false);
    }
  }

  async function submitUploadTemplate() {
    setUploadErr('');
    if (uploadBusy) return;
    const f = uploadFileRef.current?.files?.[0];
    if (!f) {
      setUploadErr('请先选择要上传的空模板文件（.xlsx/.xlsm）');
      return;
    }
    const name = String(uploadName || '').trim();
    if (!name) {
      setUploadErr('请输入空模板名称');
      return;
    }
    const destPlatformId = String(uploadDestPlatformId || '').trim();
    if (!destPlatformId) {
      setUploadErr('请选择要绑定的平台');
      return;
    }
    const sheet = String(uploadSheetName || '').trim();
    if (!sheet) {
      setUploadErr('请输入子表名称（sheetName）');
      return;
    }
    const hr = Math.floor(Number(uploadHeaderRow));
    const ds = Math.floor(Number(uploadDataStartRow));
    if (!Number.isFinite(hr) || hr < 1) {
      setUploadErr('表头行必须是 >=1 的数字');
      return;
    }
    if (!Number.isFinite(ds) || ds < 1) {
      setUploadErr('数据填充起始行必须是 >=1 的数字');
      return;
    }
    if (ds <= hr) {
      setUploadErr('数据填充起始行必须大于表头行');
      return;
    }
    setUploadBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      form.append('name', name);
      form.append('destPlatformId', destPlatformId);
      form.append('sheetName', sheet);
      form.append('headerRow', String(hr));
      form.append('dataStartRow', String(ds));
      form.append('isPublic', uploadIsPublic ? '1' : '0');
      const r = await api.adminCreateExportTemplate(form);
      if (r?.template?.id) {
        try {
          const list = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
          setCustomTemplates(Array.isArray(list.templates) ? list.templates : []);
        } catch {
          // ignore
        }
        setUploadTemplateOpen(false);
        if (uploadFileRef.current) uploadFileRef.current.value = '';
        await applyCustomTemplate(r.template.id);
      }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploadBusy(false);
    }
  }

  /** key = header column index (0-based) as string */
  const [map, setMap] = useState<Record<string, ColumnValueSource>>({});

  const headerItems = useMemo(
    () =>
      headers.map((h, i) => ({
        h,
        i,
        key: String(i),
      })),
    [headers]
  );

  // 首次载入 / 切换 exportTypeId：优先服务端草稿，其次 localStorage
  useEffect(() => {
    setErr('');
    // exportTypeId 切换时先清空旧映射，避免视觉上“沿用上一个模板”
    setMap({});
    setSelectedHeaderKey('');
    snapshotReadyRef.current[String(exportTypeId || '').trim()] = false;
    let cancelled = false;

    function applyDraftPayload(o: Partial<ExportMappingDraft>, expectedExportTypeId: string): void {
      if (o.exportTypeId !== expectedExportTypeId) {
        setMap({});
        return;
      }
      if (typeof o.sheetName === 'string' && o.sheetName.trim()) setSheetName(o.sheetName.trim());
      if (typeof o.headerRow === 'number' && Number.isFinite(o.headerRow) && o.headerRow >= 1) setHeaderRow(o.headerRow);
      if (typeof o.dataStartRow === 'number' && Number.isFinite(o.dataStartRow) && o.dataStartRow >= 1)
        setDataStartRow(o.dataStartRow);
      if (Array.isArray(o.headers) && o.headers.length) {
        const joined = o.headers.join('\n');
        // 避免草稿里 headers 全空/无效导致表头被清空，整表「没有匹配项」、预览与配置全空白
        if (parseHeaderText(joined).length > 0) {
          setHeaderText(joined);
        }
      }
      const effectiveHeaders =
        Array.isArray(o.headers) && o.headers.length
          ? parseHeaderText(o.headers.join('\n'))
          : parseHeaderText(headerText);
      const next: Record<string, ColumnValueSource> = {};
      const used = new Set<number>();
      if (Array.isArray(o.columns)) {
        for (const c of o.columns) {
          const eh = String((c as any)?.excelHeader ?? '').trim();
          if (!eh) continue;
          const src = normalizeSourceFromLegacy(c as any);
          if (!src) continue;
          const colNum = Number((c as any)?.col);
          let idx = -1;
          if (Number.isFinite(colNum) && colNum >= 0) {
            idx = Math.floor(colNum);
          } else {
            // legacy：仅按表头文案匹配；对重复表头按顺序分配到尚未使用的列
            idx = effectiveHeaders.findIndex((hh, ii) => !used.has(ii) && String(hh).trim() === eh);
          }
          if (idx < 0) continue;
          used.add(idx);
          next[String(idx)] = src;
        }
      }
      setMap(next);

      // 草稿已应用：以“应用后的内容”作为初始快照（避免异步加载导致首次保存误判为有改动）
      try {
        const columns: ColumnMappingEntry[] = [];
        for (let i = 0; i < effectiveHeaders.length; i++) {
          const h = effectiveHeaders[i];
          const s = next[String(i)];
          if (!s) continue;
          if (s.type === 'field' && !String(s.key || '').trim()) continue;
          if (s.type === 'expr' && !String(s.expr || '').trim()) continue;
          columns.push({ excelHeader: h, col: i, source: s });
        }
        const snapDraft: ExportMappingDraft = {
          version: 2,
          exportTypeId: expectedExportTypeId,
          sheetName: (typeof o.sheetName === 'string' && o.sheetName.trim()) ? o.sheetName.trim() : (sheetName.trim() || undefined),
          headerRow: typeof o.headerRow === 'number' && Number.isFinite(o.headerRow) && o.headerRow >= 1 ? o.headerRow : Math.max(1, Number(headerRow) || 1),
          dataStartRow: typeof o.dataStartRow === 'number' && Number.isFinite(o.dataStartRow) && o.dataStartRow >= 1 ? o.dataStartRow : Math.max(1, Number(dataStartRow) || 1),
          headers: effectiveHeaders,
          columns,
        };
        initialDraftSnapshotRef.current[expectedExportTypeId] = stableStringify(snapDraft);
        snapshotReadyRef.current[expectedExportTypeId] = true;
      } catch {
        // ignore
      }
    }

    void (async () => {
      let applied = false;
      try {
        const server = await api.getExportColumnMapDraft(exportTypeId);
        if (cancelled) return;
        const d = server.draft;
        if (d && typeof d === 'object' && !Array.isArray(d)) {
          applyDraftPayload(d as Partial<ExportMappingDraft>, exportTypeId);
          applied = true;
          return;
        }
      } catch {
        // 网络失败：继续读本地
      }
      if (cancelled) return;
      try {
              const raw = localStorage.getItem(storageKey(user.id, exportTypeId));
        if (!raw) {
          if (!applied) {
            setMap({});
            // 无草稿：当前空状态即为基准
            initialDraftSnapshotRef.current[exportTypeId] = stableStringify({
              version: 2,
              exportTypeId,
              sheetName: sheetName.trim() || undefined,
              headerRow: Math.max(1, Number(headerRow) || 1),
              dataStartRow: Math.max(1, Number(dataStartRow) || 1),
              headers,
              columns: [],
            } satisfies ExportMappingDraft);
            snapshotReadyRef.current[exportTypeId] = true;
          }
          return;
        }
        const parsed = safeJsonParse(raw);
        if (!parsed || typeof parsed !== 'object') {
          if (!applied) {
            setMap({});
            snapshotReadyRef.current[exportTypeId] = true;
          }
          return;
        }
        applyDraftPayload(parsed as Partial<ExportMappingDraft>, exportTypeId);
        applied = true;
      } catch {
        if (!applied) {
          setMap({});
          snapshotReadyRef.current[exportTypeId] = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [exportTypeId]);

  const filtered = useMemo(() => {
    const raw = q.trim();
    if (!raw) return headerItems;
    const needle = raw.toLowerCase();
    /** 表头可能含多空格/换行，复制粘贴后与搜索词略不一致时仍能命中 */
    const norm = (s: string) =>
      String(s ?? '')
        .toLowerCase()
        .replace(/[\s\u00a0]+/g, ' ')
        .trim();
    const needleNorm = norm(raw);
    return headerItems.filter(({ h, key }) => {
      if (h.toLowerCase().includes(needle)) return true;
      if (needleNorm.length > 0 && norm(h).includes(needleNorm)) return true;
      const s = map[key];
      if (!s) return false;
      if (s.type === 'field') {
        const key = s.key.toLowerCase();
        const cn = getKeyLabelForDisplay(s.key).toLowerCase();
        return key.includes(needle) || cn.includes(needle);
      }
      if (s.type === 'const') return s.value.toLowerCase().includes(needle);
      if (s.type === 'expr') return s.expr.toLowerCase().includes(needle);
      return false;
    });
  }, [headerItems, q, map]);

  /** 「字段」下拉：固定白名单（与运营约定），不随预览变化；其余列请用「常量 / 表达式」 */
  const rightSelectOptions = useMemo(() => [...AMAZON_EXPORT_FIELD_PICKER_KEYS], []);

  /** 打开「选择字段」时若当前 key 已被排除，仍保留在列表中以便查看或改选 */
  const fieldPickerOptions = useMemo(() => {
    const cur =
      fieldPickerFor && map[fieldPickerFor]?.type === 'field'
        ? normalizeFieldKey(String(map[fieldPickerFor].key || ''))
        : '';
    let out = [...rightSelectOptions];
    if (cur && !out.includes(cur)) out.push(cur);
    out.sort((a, b) => String(a).localeCompare(String(b)));
    return out;
  }, [rightSelectOptions, fieldPickerFor, map]);

  const genericFieldPickerOptions = useMemo(() => {
    const row =
      genericFieldPickerForId != null ? genericPresetRows.find((r) => r.id === genericFieldPickerForId) : null;
    const cur =
      row && row.source.type === 'field' ? normalizeFieldKey(String(row.source.key || '').trim()) : '';
    let out = [...rightSelectOptions];
    if (cur && !out.includes(cur)) out.push(cur);
    out.sort((a, b) => String(a).localeCompare(String(b)));
    return out;
  }, [rightSelectOptions, genericFieldPickerForId, genericPresetRows]);

  const genericPickerExcelHeader = useMemo(() => {
    if (!genericFieldPickerForId) return '';
    const row = genericPresetRows.find((r) => r.id === genericFieldPickerForId);
    const h = String(row?.excelHeader || '').trim();
    return h || '（未填写列名）';
  }, [genericFieldPickerForId, genericPresetRows]);

  const genericFieldPickerKeyValue = useMemo(() => {
    if (!genericFieldPickerForId) return '';
    const row = genericPresetRows.find((r) => r.id === genericFieldPickerForId);
    return row && row.source.type === 'field' ? String(row.source.key || '') : '';
  }, [genericFieldPickerForId, genericPresetRows]);

  const genericConstExprEditorBundle = useMemo(() => {
    if (!genericConstExprForId) return null;
    const gRow = genericPresetRows.find((r) => r.id === genericConstExprForId);
    const gSrc = gRow?.source;
    if (!gRow || (gSrc?.type !== 'const' && gSrc?.type !== 'expr')) return null;
    return { row: gRow, source: gSrc };
  }, [genericConstExprForId, genericPresetRows]);

  const mappedCount = useMemo(
    () =>
      headerItems.filter(({ key }) => {
        const s = map[key];
        if (!s) return false;
        if (s.type === 'field') return Boolean(String(s.key || '').trim());
        if (s.type === 'const') return true;
        if (s.type === 'expr') return Boolean(String(s.expr || '').trim());
        return false;
      }).length,
    [headerItems, map]
  );

  function setSourceForHeader(headerKey: string, source: ColumnValueSource | null) {
    if (isSharedTemplate) return;
    setMap((prev) => {
      const next = { ...prev };
      if (!source) {
        delete next[headerKey];
      } else {
        if (source.type === 'field') {
          const nk = normalizeFieldKey(source.key);
          next[headerKey] = nk ? { type: 'field', key: nk } : source;
        } else {
          next[headerKey] = source;
        }
      }
      return next;
    });
  }

  function applySourceTypeForHeader(headerKey: string, t: ColumnValueSource['type']) {
    if (isSharedTemplate) return;
    setGenericFieldPickerForId(null);
    setGenericConstExprForId(null);
    if (t === 'field') {
      setConstExprEditorFor(null);
      setSourceForHeader(headerKey, { type: 'field', key: '' });
      setFieldPickerFor(headerKey);
    } else if (t === 'const') {
      setFieldPickerFor(null);
      setSourceForHeader(headerKey, { type: 'const', value: '', applyTo: 'child' });
      setConstExprEditorFor(headerKey);
    } else {
      setFieldPickerFor(null);
      setSourceForHeader(headerKey, { type: 'expr', expr: '{{}}', applyTo: 'both' });
      setConstExprEditorFor(headerKey);
    }
  }

  function updateGenericPresetRow(id: string, patch: Partial<Pick<GenericPresetRow, 'excelHeader' | 'source'>>) {
    if (isSharedTemplate) return;
    setGenericPresetRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function setGenericRowSource(id: string, source: ColumnValueSource | null) {
    if (isSharedTemplate) return;
    setGenericPresetRows((rows) =>
      rows.map((r) => {
        if (r.id !== id) return r;
        if (!source) return { ...r, source: { type: 'const', value: '', applyTo: 'child' } };
        if (source.type === 'field') {
          const nk = normalizeFieldKey(source.key);
          return { ...r, source: nk ? { type: 'field', key: nk } : source };
        }
        return { ...r, source };
      })
    );
  }

  function applyGenericSourceType(rowId: string, t: ColumnValueSource['type']) {
    if (isSharedTemplate) return;
    setGenericConstExprForId(null);
    setGenericFieldPickerForId(null);
    if (t === 'field') {
      setGenericRowSource(rowId, { type: 'field', key: '' });
      setGenericFieldPickerForId(rowId);
    } else if (t === 'const') {
      setGenericRowSource(rowId, { type: 'const', value: '', applyTo: 'child' });
      setGenericConstExprForId(rowId);
    } else {
      setGenericRowSource(rowId, { type: 'expr', expr: '{{}}', applyTo: 'both' });
      setGenericConstExprForId(rowId);
    }
  }

  function addGenericPresetRow() {
    if (isSharedTemplate) return;
    setGenericPresetRows((rows) => [
      ...rows,
      { id: newGenericPresetRowId(), excelHeader: '', source: { type: 'const', value: '', applyTo: 'child' } },
    ]);
  }

  function removeGenericPresetRow(id: string) {
    if (isSharedTemplate) return;
    setGenericFieldPickerForId((cur) => (cur === id ? null : cur));
    setGenericConstExprForId((cur) => (cur === id ? null : cur));
    setGenericPresetRows((rows) => rows.filter((r) => r.id !== id));
  }

  function duplicateGenericPresetRow(id: string) {
    if (isSharedTemplate) return;
    setGenericPresetRows((rows) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) return rows;
      const base = rows[idx];
      let nextSource: ColumnValueSource = base.source;
      if (base.source.type === 'field') {
        const k = String(base.source.key || '').trim();
        const m = k.match(/^(.*?)(\d+)$/);
        if (m) {
          const prefix = m[1];
          const n = Number(m[2]);
          if (Number.isFinite(n)) nextSource = { type: 'field', key: `${prefix}${n + 1}` };
        }
      }
      const copied: GenericPresetRow = {
        id: newGenericPresetRowId(),
        excelHeader: base.excelHeader,
        source: nextSource,
      };
      const out = rows.slice();
      out.splice(idx + 1, 0, copied);
      return out;
    });
  }

  function closeGenericDataModal() {
    setGenericDataModalOpen(false);
    setGenericFieldPickerForId(null);
    setGenericConstExprForId(null);
  }

  async function onSaveGenericPresetsToServer() {
    if (isSharedTemplate) return;
    setGenericPresetSaveBusy(true);
    try {
      const rows: ExportGenericPresetRow[] = [];
      for (const r of genericPresetRows) {
        const excelHeader = String(r.excelHeader || '').trim();
        if (!excelHeader) continue;
        const s = r.source;
        if (!s) continue;
        if (s.type === 'field') {
          const key = String(s.key || '').trim();
          if (!key) continue;
          rows.push({ excelHeader, source: { type: 'field', key } });
          continue;
        }
        if (s.type === 'const') {
          rows.push({
            excelHeader,
            source: {
              type: 'const',
              value: s.value == null ? '' : String(s.value),
              ...(s.applyTo ? { applyTo: s.applyTo } : {}),
            },
          });
          continue;
        }
        if (s.type === 'expr') {
          const expr = String(s.expr || '').trim();
          if (!expr) continue;
          rows.push({
            excelHeader,
            source: { type: 'expr', expr, ...(s.applyTo ? { applyTo: s.applyTo } : {}) },
          });
          continue;
        }
      }
      const r = await api.putExportGenericPresets({ rows });
      toastSuccess(`已保存（${r.count} 行）`, '通用数据');
      // 保存后立刻回读一次，确保“载入”看到的是服务端真实落库结果
      genericPresetLoadedRef.current = false;
      await loadGenericPresetsOnce({ force: true, silent: true });
    } catch (e) {
      toastError(e instanceof Error ? e.message : '保存失败', '通用数据', 3200);
    } finally {
      setGenericPresetSaveBusy(false);
    }
  }

  function onExportGenericPresetJson() {
    const rows = genericPresetRows
      .map((r) => {
        const excelHeader = String(r.excelHeader || '').trim();
        if (!excelHeader) return null;
        return { excelHeader, source: r.source };
      })
      .filter(Boolean);
    downloadText(
      `export_generic_presets_user.json`,
      JSON.stringify({ version: 2, scope: 'user', rows }, null, 2)
    );
    toastSuccess('已导出', '通用数据', 1600);
  }

  function onImportGenericPresetJsonFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = safeJsonParse(text);
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as any) : null;
      const rowsIn = obj && Array.isArray(obj.rows) ? obj.rows : null;
      if (!rowsIn) {
        toastError('导入失败：JSON 格式不正确（缺少 rows）', '通用数据', 3200);
        return;
      }
      const out: GenericPresetRow[] = [];
      for (const entry of rowsIn) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const excelHeader = String((entry as any).excelHeader || '').trim();
        if (!excelHeader) continue;
        const srcAny = (entry as any).source;
        if (!srcAny || typeof srcAny !== 'object' || Array.isArray(srcAny)) continue;
        const t = String((srcAny as any).type || '').trim();
        if (t === 'field') {
          const key = String((srcAny as any).key || '').trim();
          if (!key) continue;
          out.push({ id: newGenericPresetRowId(), excelHeader, source: { type: 'field', key } });
        } else if (t === 'const') {
          const value = (srcAny as any).value == null ? '' : String((srcAny as any).value);
          const applyToRaw = String((srcAny as any).applyTo || '').trim();
          const applyTo =
            applyToRaw === 'parent' || applyToRaw === 'child' || applyToRaw === 'both' ? applyToRaw : undefined;
          out.push({
            id: newGenericPresetRowId(),
            excelHeader,
            source: { type: 'const', value, ...(applyTo ? { applyTo } : {}) },
          });
        } else if (t === 'expr') {
          const expr = String((srcAny as any).expr || '').trim();
          if (!expr) continue;
          const applyToRaw = String((srcAny as any).applyTo || '').trim();
          const applyTo =
            applyToRaw === 'parent' || applyToRaw === 'child' || applyToRaw === 'both' ? applyToRaw : undefined;
          out.push({
            id: newGenericPresetRowId(),
            excelHeader,
            source: { type: 'expr', expr, ...(applyTo ? { applyTo } : {}) },
          });
        }
      }
      setGenericPresetRows(out);
      genericPresetLoadedRef.current = true;
      toastSuccess(`已导入（${out.length} 行）`, '通用数据', 2400);
    };
    reader.onerror = () => toastError('读取文件失败', '通用数据', 3200);
    reader.readAsText(file);
  }

  function buildDraft(): ExportMappingDraft {
    const columns: ColumnMappingEntry[] = [];
    for (const { h, i, key } of headerItems) {
      const s = map[key];
      if (!s) continue;
      if (s.type === 'field' && !String(s.key || '').trim()) continue;
      if (s.type === 'expr' && !String(s.expr || '').trim()) continue;
      columns.push({ excelHeader: h, col: i, source: s });
    }
    return {
      version: 2,
      exportTypeId,
      sheetName: sheetName.trim() || undefined,
      headerRow: Math.max(1, Number(headerRow) || 1),
      dataStartRow: Math.max(1, Number(dataStartRow) || 1),
      headers,
      columns,
    };
  }

  async function onSave() {
    if (isSharedTemplate) return;
    setErr('');
    const id = String(exportTypeId || '').trim();
    if (!id) {
      setErr('请先选择正确的导出模板');
      return;
    }
    // 未完成草稿加载/应用前，不允许触发真实保存（避免“首次进入就误保存”）
    if (snapshotReadyRef.current[id] !== true) {
      pushToast({ tone: 'info', title: '无需保存', message: '未检测到数据变化', timeoutMs: 1800 });
      return;
    }
    let draft: ExportMappingDraft;
    let curSnapshot = '';
    try {
      draft = buildDraft();
      curSnapshot = stableStringify(draft);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败：草稿生成异常');
      return;
    }
    const baseSnapshot = initialDraftSnapshotRef.current[id];
    // 快照丢失时：以当前为基准，不发请求
    if (!baseSnapshot) {
      initialDraftSnapshotRef.current[id] = curSnapshot;
      snapshotReadyRef.current[id] = true;
      pushToast({ tone: 'info', title: '无需保存', message: '未检测到数据变化', timeoutMs: 1800 });
      return;
    }
    if (baseSnapshot === curSnapshot) {
      pushToast({ tone: 'info', title: '无需保存', message: '未检测到数据变化', timeoutMs: 1800 });
      return;
    }

    setSaveBusy(true);
    try {
      await api.putExportColumnMapDraft({ exportTypeId, draft });
      localStorage.setItem(storageKey(user.id, exportTypeId), JSON.stringify(draft));
      toastSuccess('已保存到服务器', '保存成功');
      // 保存成功后更新快照：避免连续点保存重复提交
      initialDraftSnapshotRef.current[id] = curSnapshot;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败';
      try {
        localStorage.setItem(storageKey(user.id, exportTypeId), JSON.stringify(draft));
        toastWarning(`${msg}（已仅保存到本机浏览器）`, '保存到本机');
      } catch {
        setErr(msg);
      }
    } finally {
      setSaveBusy(false);
    }
  }

  function onExportJson() {
    setErr('');
    const draft = buildDraft();
    downloadText(`export_column_map_${exportTypeId}.json`, JSON.stringify(draft, null, 2));
  }

  function onEditGenericData() {
    setFieldPickerFor(null);
    setConstExprEditorFor(null);
    setGenericFieldPickerForId(null);
    setGenericConstExprForId(null);
    setGenericDataModalOpen(true);
  }

  async function onApplyGenericData() {
    if (isSharedTemplate) return;
    if (!exportTypeId) {
      toastWarning('请先选择模板', '通用数据', 2400);
      return;
    }
    if (!headers.length) {
      toastWarning('模板列名为空', '通用数据', 2400);
      return;
    }
    // 若用户未打开弹窗，也应能直接填充：这里确保先从服务器拉一次（用户级，与模板无关）
    let loadedRows: GenericPresetRow[] | undefined;
    if (genericPresetLoadedRef.current !== true) {
      loadedRows = await loadGenericPresetsOnce({ silent: false });
    }
    const rowsToApply = (loadedRows && loadedRows.length ? loadedRows : genericPresetRows) || [];
    if (!rowsToApply.length) {
      toastWarning('暂无通用数据', '通用数据', 2200);
      return;
    }

    const normalizeHeader = (s: string) =>
      String(s ?? '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .toLowerCase();

    const targetsByNorm = new Map<string, string[]>();
    for (const { h, key } of headerItems) {
      const nh = normalizeHeader(h);
      if (!nh) continue;
      const prev = targetsByNorm.get(nh);
      if (prev) prev.push(key);
      else targetsByNorm.set(nh, [key]);
    }

    // 通用数据按“同名列”分组，按出现顺序依次消费（支持同名列多条且 source 不同）。
    const presetsByNorm = new Map<string, GenericPresetRow[]>();
    for (const r of rowsToApply) {
      const nh = normalizeHeader(r.excelHeader);
      if (!nh) continue;
      const arr = presetsByNorm.get(nh);
      if (arr) arr.push(r);
      else presetsByNorm.set(nh, [r]);
    }
    const runId = `gapply_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
    genericApplyRunIdRef.current = runId;
    genericApplySummaryRef.current = null;

    setMap((prev) => {
      // StrictMode(dev) 下 updater 可能被调用两次；这里必须是纯函数，不能依赖 updater 外的可变 cursor/计数。
      const presetCursorByNorm = new Map<string, number>();
      let matchedPresetRows = 0;
      let filledColumns = 0;
      let skippedColumns = 0;
      const filledFromPresetRowIds = new Set<string>();

      const next = { ...prev };
      // 遍历模板列出现顺序：对每个列名，从对应的 presets 列表里取“下一条”填入
      for (const [nh, keys] of targetsByNorm.entries()) {
        if (!keys || keys.length === 0) continue;
        const presetList = presetsByNorm.get(nh);
        if (!presetList || presetList.length === 0) continue;
        // 规则：若通用数据对某个列名只配置了 1 条，则无论模板里出现多少次，只填充“第一次出现”的那一列。
        // 避免用户多次点击“填充通用数据”时把其它同名列也逐步填上。
        if (presetList.length === 1) {
          const firstKey = keys[0];
          if (!firstKey) continue;
          if (next[firstKey]) {
            skippedColumns++;
            continue;
          }
          const presetRow = presetList[0];
          matchedPresetRows++;
          const src = presetRow.source;
          const normalizedSrc: ColumnValueSource =
            src.type === 'field'
              ? { type: 'field', key: normalizeFieldKey(src.key) }
              : src.type === 'expr'
                ? { type: 'expr', expr: src.expr, ...(src.applyTo ? { applyTo: src.applyTo } : {}) }
                : { type: 'const', value: src.value, ...(src.applyTo ? { applyTo: src.applyTo } : {}) };
          if (normalizedSrc.type === 'field' && !String(normalizedSrc.key || '').trim()) {
            skippedColumns++;
            continue;
          }
          if (normalizedSrc.type === 'expr' && !String(normalizedSrc.expr || '').trim()) {
            skippedColumns++;
            continue;
          }
          next[firstKey] = normalizedSrc;
          filledColumns++;
          filledFromPresetRowIds.add(presetRow.id);
          continue;
        }
        for (const key of keys) {
          const cur = next[key];
          if (cur) {
            skippedColumns++;
            continue;
          }

          const curIdx = presetCursorByNorm.get(nh) ?? 0;
          if (curIdx >= presetList.length) {
            // 通用数据条数不够：不填充多出来的重复列
            continue;
          }
          const presetRow = presetList[curIdx];
          presetCursorByNorm.set(nh, curIdx + 1);

          matchedPresetRows++;
          const src = presetRow.source;
          const normalizedSrc: ColumnValueSource =
            src.type === 'field'
              ? { type: 'field', key: normalizeFieldKey(src.key) }
              : src.type === 'expr'
                ? { type: 'expr', expr: src.expr, ...(src.applyTo ? { applyTo: src.applyTo } : {}) }
                : { type: 'const', value: src.value, ...(src.applyTo ? { applyTo: src.applyTo } : {}) };

          if (normalizedSrc.type === 'field' && !String(normalizedSrc.key || '').trim()) {
            skippedColumns++;
            continue;
          }
          if (normalizedSrc.type === 'expr' && !String(normalizedSrc.expr || '').trim()) {
            skippedColumns++;
            continue;
          }
          next[key] = normalizedSrc;
          filledColumns++;
          filledFromPresetRowIds.add(presetRow.id);
        }
      }
      genericApplySummaryRef.current = {
        runId,
        filledRows: filledFromPresetRowIds.size,
        filledColumns,
        matchedRows: matchedPresetRows,
        skippedColumns,
      };
      return next;
    });

    // updater 可能异步执行；这里轮询等待 summaryRef 就绪，再发 toast（避免首次无提示）。
    const emitToastWhenReady = (tryN: number) => {
      if (genericApplyRunIdRef.current !== runId) return;
      const s = genericApplySummaryRef.current;
      if (s && s.runId === runId) {
        if (s.filledColumns > 0) {
          toastSuccess(`已填充 ${s.filledRows} 行`, '通用数据', 2400);
          return;
        }
        if (s.matchedRows > 0 && s.skippedColumns > 0) {
          pushToast({
            tone: 'info',
            title: '通用数据',
            message: '匹配到列名，但均已配置，未覆盖',
            timeoutMs: 2400,
          });
          return;
        }
        toastWarning('未匹配到任何列名', '通用数据', 2400);
        return;
      }
      if (tryN >= 10) return;
      window.setTimeout(() => emitToastWhenReady(tryN + 1), 20);
    };
    window.setTimeout(() => emitToastWhenReady(0), 0);
  }

  function onImportJsonFileConfirmed(file: File) {
    setErr('');
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== 'object') {
        setErr('导入失败：不是有效 JSON');
        return;
      }
      const o = parsed as Partial<ExportMappingDraft>;
      // 生产环境仅使用“用户上传模板”的表头：导入 JSON 只覆盖 columns 映射，不切换模板/表头
      const effectiveHeaders = headers;
      const next: Record<string, ColumnValueSource> = {};
      const used = new Set<number>();
      if (Array.isArray(o.columns)) {
        for (const c of o.columns) {
          const eh = String((c as any)?.excelHeader ?? '').trim();
          if (!eh) continue;
          const src = normalizeSourceFromLegacy(c as any);
          if (!src) continue;
          const colNum = Number((c as any)?.col);
          let idx = -1;
          if (Number.isFinite(colNum) && colNum >= 0) {
            idx = Math.floor(colNum);
          } else {
            idx = effectiveHeaders.findIndex((hh, ii) => !used.has(ii) && String(hh).trim() === eh);
          }
          if (idx < 0) continue;
          used.add(idx);
          next[String(idx)] = src;
        }
      }
      setMap(next);
      toastInfo('已导入并覆盖当前模板映射（未保存到服务器）。', '已导入');
    };
    reader.onerror = () => setErr('读取文件失败');
    reader.readAsText(file);
  }

  async function onLoadPreview() {
    setErr('');
    setPreview(null);
    const cid = Number(previewCollectionId);
    if (!Number.isFinite(cid) || cid <= 0) {
      toastWarning('无效ID', '预览', 2200);
      return;
    }
    setPreviewBusy(true);
    try {
      const r = await api.exportPreview({ collectionId: cid, exportTypeId });
      setPreview(r);
      if (r.parentRow == null && r.childRow == null) {
        toastWarning('无数据', '预览', 2200);
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : '预览失败', '预览', 3200);
    } finally {
      setPreviewBusy(false);
    }
  }

  function renderValueForSource(source: ColumnValueSource | undefined, row: Record<string, unknown> | null): string {
    if (!source) return '';
    if (source.type === 'field') {
      const v = row ? (row as any)[source.key] : '';
      return v == null ? '' : String(v);
    }
    if (source.type === 'const') return String(source.value ?? '');
    if (source.type === 'expr') return evalExpr(source.expr, row);
    return '';
  }

  /** 预览列：常量/表达式按 applyTo 仅在父或子样例行显示有值 */
  function renderPreviewForRow(
    source: ColumnValueSource | undefined,
    row: Record<string, unknown> | null,
    rowKind: 'parent' | 'child'
  ): string {
    if (!source) return '';
    if (source.type === 'field') {
      if (rowKind === 'parent' && isChildOnlyFieldKey(source.key)) return '';
      return renderValueForSource(source, row);
    }
    const at = getConstExprApplyTo(source);
    if (at === 'parent' && rowKind === 'child') return '';
    if (at === 'child' && rowKind === 'parent') return '';
    return renderValueForSource(source, row);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">导出映射配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          映射草稿由管理员保存到服务器；加载时优先读服务器，其次本机浏览器缓存。导出时若请求未带草稿，服务端会按{' '}
          <code className="rounded bg-slate-100 px-1 text-[11px]">exportTypeId</code> 自动套用已保存草稿。
          「字段」下拉里为固定白名单（SKU、标题、描述、图片、价格等）；模板中其余列请选「常量」或「表达式」自行填写。
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 overflow-x-auto leading-relaxed sm:gap-3">
          <span className="shrink-0 text-xs font-medium leading-relaxed text-slate-600">选择模板</span>
          <CustomSelect
            value={headerTemplateValue}
            onChange={(v) => applyHeaderTemplate(String(v))}
            options={headerTemplateSelectOptions}
            className="!w-[min(30rem,100%)] min-w-0 max-w-[30rem] shrink-0"
            buttonClassName="flex h-10 w-full min-w-0 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 shadow-none outline-none ring-0 transition hover:border-slate-300 focus:border-teal-400 focus:outline-none"
            title="选择用户上传模板后同步 exportTypeId / 表头行 / 数据起始行"
          />
          <label className="inline-flex h-9 shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-teal-600"
              checked={hidePublicTemplates}
              onChange={(e) => {
                const next = e.target.checked;
                setHidePublicTemplates(next);
                // 立刻生效：若当前选中的是「共享模板」且用户选择隐藏，则马上清空映射区，不等待列表刷新/定时 tick
                if (next) {
                  const curId = String(headerTemplateValue || '').startsWith('custom:')
                    ? String(headerTemplateValue).slice('custom:'.length).trim()
                    : '';
                  const curTpl = curId ? customTemplates.find((t) => t.id === curId) : null;
                  const isMine = curTpl?.createdByUserId != null && Number(curTpl.createdByUserId) === Number(user.id);
                  const isShared = !!curTpl && !isMine && Number(curTpl.isPublic) === 1;
                  if (isShared) {
                    setHeaderTemplateValue('');
                    setExportTypeId('');
                    setHeaderText('');
                    setSheetName('模板');
                    setHeaderRow(1);
                   setDataStartRow(2);
                   setMap({});
                   setSelectedHeaderKey('');
                   setPreview(null);
                    toastInfo('已隐藏共享模板：当前选中的共享模板已移除，已清空表头与映射。', '已隐藏共享模板');
                  }
                }
                try {
                  localStorage.setItem(HIDE_PUBLIC_TEMPLATES_KEY, next ? '1' : '0');
                } catch {
                  /* ignore */
                }
              }}
            />
            不显示共享模板
          </label>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center rounded-lg bg-sky-600 px-3 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setUploadSheetName(sheetName || '模板');
              setUploadHeaderRow(headerRow);
              setUploadDataStartRow(dataStartRow);
              setUploadName('');
              setUploadDestPlatformId('');
              setUploadIsPublic(false);
              setUploadErr('');
              setUploadTemplateOpen(true);
            }}
            title="上传空模板表格（服务器解析表头行列名）"
          >
            上传空模板
          </button>
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              setMap({});
              toastInfo('已清空映射（仅本页内存）。若要导出不填任何内容，请点击「保存到服务器」。', '已清空');
            }}
            title="清空当前编辑区映射（不影响服务器/本机已保存草稿，除非你再点保存）"
            disabled={isSharedTemplate}
          >
            清空映射
          </button>
          <div
            className="mx-2 h-9 w-px shrink-0 self-center bg-slate-200 sm:mx-3"
            aria-hidden
            role="presentation"
          />
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="shrink-0 text-xs font-medium text-slate-600">预览采集数据</span>
            <input
              className="h-10 w-28 min-w-[7rem] shrink-0 rounded-lg border border-slate-200 bg-white px-3 font-mono text-xs text-slate-800"
              value={previewCollectionId || ''}
              onChange={(e) => setPreviewCollectionId(Number(e.target.value))}
              placeholder="填入采集ID"
              inputMode="numeric"
            />
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              onClick={() => void onLoadPreview()}
              disabled={previewBusy}
            >
              {previewBusy ? '加载中…' : '加载预览'}
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-6 md:gap-x-4 md:gap-y-4">
          <div className="md:col-span-2">
            <label className="mb-2 block text-xs font-medium leading-relaxed text-slate-600">
              导出类型ID
            </label>
            <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-xs leading-relaxed text-slate-800">
              {exportTypeId}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium leading-relaxed text-slate-600">sheetName</label>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 disabled:bg-slate-50 disabled:text-slate-500"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              disabled={isSharedTemplate || !selectedTemplate}
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium leading-relaxed text-slate-600">表头行</label>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 disabled:bg-slate-50 disabled:text-slate-500"
              value={headerRow}
              onChange={(e) => setHeaderRow(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              disabled={isSharedTemplate || !selectedTemplate}
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium leading-relaxed text-slate-600">数据起始行</label>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 disabled:bg-slate-50 disabled:text-slate-500"
              value={dataStartRow}
              onChange={(e) => setDataStartRow(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              disabled={isSharedTemplate || !selectedTemplate}
              inputMode="numeric"
            />
          </div>
          <div className="flex items-end md:max-w-24">
            <button
              type="button"
              className="h-[42px] w-20 rounded-lg bg-teal-600 px-3 text-sm font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void onSaveTemplateMeta()}
              disabled={!templateMetaDirty || templateMetaSaveBusy || isSharedTemplate}
            >
              {templateMetaSaveBusy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        {isSharedTemplate ? (
          <p className="mt-2 text-xs font-medium text-amber-700">
            当前选择的是其它用户公开的共享模板：映射关系只读。如需编辑请先点击该模板右侧「复制」创建你的私有模板。
          </p>
        ) : null}

        {/* errors are shown as toasts (top-right) */}
      </div>

      <div className="min-h-0">
          <div className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-4">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <div className="w-full sm:w-[32rem]">
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    搜索（当前显示 <span className="font-medium text-slate-800">{filtered.length}</span> 列）
                  </label>
                  <input
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="例如：主图、item_sku、bullet、价格…"
                  />
                </div>
                <button
                  type="button"
                  className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                  onClick={() => void onSave()}
                  disabled={saveBusy || isSharedTemplate}
                >
                  {saveBusy ? '保存中…' : '保存到服务器'}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  onClick={onExportJson}
                  disabled={isSharedTemplate}
                >
                  导出 JSON
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => fileRef.current?.click()}
                  disabled={isSharedTemplate}
                >
                  导入 JSON
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    if (isSharedTemplate) {
                      e.currentTarget.value = '';
                      return;
                    }
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (!exportTypeId) {
                      setErr('请先选择正确的导出模板后再导入');
                      e.currentTarget.value = '';
                      return;
                    }
                    setImportPendingFile(f);
                    setImportConfirmOpen(true);
                    e.currentTarget.value = '';
                  }}
                />

                <div
                  className="mx-2 h-10 w-px shrink-0 self-end bg-slate-200"
                  aria-hidden
                  role="presentation"
                />
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={onEditGenericData}
                  disabled={isSharedTemplate}
                >
                  编辑通用数据
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2 text-sm text-teal-800 hover:bg-teal-100/70 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={onApplyGenericData}
                  disabled={isSharedTemplate}
                >
                  填充通用数据
                </button>

                <div className="ml-auto text-xs text-slate-500">
                  已映射 <span className="font-medium text-slate-800">{mappedCount}</span> / {headers.length}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[82rem] table-fixed border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-50/90 backdrop-blur">
                  <tr className="border-b border-slate-100 text-xs font-medium text-slate-600">
                    <th className="w-10 px-3 py-2 text-left">#</th>
                    <th className="w-[22rem] min-w-0 px-3 py-2 text-center">模板列名（excelHeader）</th>
                    <th className="w-[7rem] min-w-0 px-2 py-2 text-center">来源</th>
                    <th className="w-[22rem] min-w-0 px-3 py-2 text-center">配置</th>
                    <th className="w-[14rem] min-w-0 px-3 py-2 text-center">父行预览</th>
                    <th className="w-[14rem] min-w-0 px-3 py-2 text-center">子行预览</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(({ h, i, key }) => {
                    const src = map[key];
                    const st = src?.type || 'const';
                    const parentPreview = preview ? renderPreviewForRow(src, preview.parentRow, 'parent') : '';
                    const childPreview = preview ? renderPreviewForRow(src, preview.childRow, 'child') : '';
                    return (
                      <tr
                        key={key}
                        className={`border-b border-slate-50 last:border-0 ${
                          selectedHeaderKey === key ? 'bg-teal-50/60' : ''
                        }`}
                        onClick={() => setSelectedHeaderKey(key)}
                      >
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{i + 1}</td>
                        <td className="w-[22rem] min-w-0 max-w-[22rem] px-3 py-2 text-center align-middle">
                          <div
                            className="max-h-[min(24rem,50vh)] overflow-y-auto break-all text-center font-mono text-[11px] leading-relaxed text-slate-700 whitespace-pre-wrap select-text"
                            title={h.length > 200 ? h : undefined}
                          >
                            {h}
                          </div>
                        </td>
                        <td className="w-[7rem] min-w-0 max-w-[7rem] px-2 py-2 text-center align-middle" onClick={(e) => e.stopPropagation()}>
                          <CustomSelect
                            value={st}
                            onChange={(v) => applySourceTypeForHeader(key, v as ColumnValueSource['type'])}
                            options={[
                              { value: 'const', label: '常量' },
                              { value: 'field', label: '字段' },
                              { value: 'expr', label: '表达式' },
                            ]}
                            className="w-full min-w-0"
                            buttonClassName="flex h-10 w-full min-w-0 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 shadow-none outline-none ring-0 transition hover:border-slate-300 focus:border-teal-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </td>
                        <td className="w-[22rem] min-w-0 max-w-[22rem] px-3 py-2 text-center align-middle" onClick={(e) => e.stopPropagation()}>
                          {st === 'field' ? (
                            <button
                              type="button"
                              className="group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-orange-300/90 bg-white px-2 text-left text-sm transition hover:border-orange-400/90 hover:bg-orange-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                              onClick={() => setFieldPickerFor(key)}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {src && src.type === 'field' && String(src.key || '').trim() ? (
                                  <>
                                    <span className="font-medium text-slate-800">{getKeyLabelForDisplay(src.key) || src.key}</span>
                                    {getKeyLabelForDisplay(src.key) ? (
                                      <span className="text-slate-500">（{src.key}）</span>
                                    ) : null}
                                  </>
                                ) : (
                                  <span className="text-slate-400">点击选择字段…</span>
                                )}
                              </span>
                              <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                选择
                              </span>
                            </button>
                          ) : st === 'const' ? (
                            <button
                              type="button"
                              className={`group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                src && src.type === 'const' && String(src.value).trim()
                                  ? 'border-emerald-300/90 bg-emerald-50/40 hover:border-emerald-400/90 hover:bg-emerald-50/60'
                                  : 'border-slate-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/50'
                              }`}
                              onClick={() => {
                                const cur = map[key];
                                if (!cur || cur.type !== 'const') {
                                  setSourceForHeader(key, { type: 'const', value: '', applyTo: 'child' });
                                }
                                setConstExprEditorFor(key);
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800">
                                常量 ·{' '}
                                {src && src.type === 'const' ? applyToShortLabel(getConstExprApplyTo(src)) : '父行与子行'} ·{' '}
                                {src && src.type === 'const' && String(src.value).trim() ? (
                                  <span className="rounded bg-emerald-200/80 px-1.5 py-0.5 font-semibold text-emerald-900">
                                    {truncateDisplay(src.value, 48)}
                                  </span>
                                ) : (
                                  '点击配置'
                                )}
                              </span>
                              <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                编辑
                              </span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={`group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                src && src.type === 'expr' && String(src.expr || '').trim()
                                  ? 'border-indigo-300/90 bg-indigo-50/40 hover:border-indigo-400/90 hover:bg-indigo-50/60'
                                  : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/50'
                              }`}
                              onClick={() => {
                                const cur = map[key];
                                if (!cur || cur.type !== 'expr') {
                                  setSourceForHeader(key, { type: 'expr', expr: '{{}}', applyTo: 'both' });
                                }
                                setConstExprEditorFor(key);
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800">
                                表达式 ·{' '}
                                {src && src.type === 'expr' ? applyToShortLabel(getConstExprApplyTo(src)) : '父行与子行'} ·{' '}
                                {src && src.type === 'expr' && String(src.expr || '').trim() ? (
                                  <span className="rounded bg-indigo-200/80 px-1.5 py-0.5 font-semibold text-indigo-900">
                                    {truncateDisplay(src.expr, 48)}
                                  </span>
                                ) : (
                                  '点击配置'
                                )}
                              </span>
                              <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                编辑
                              </span>
                            </button>
                          )}
                        </td>
                        <td className="w-[14rem] min-w-0 max-w-[14rem] px-3 py-2 text-center align-middle">
                          <div className="max-h-[min(24rem,50vh)] overflow-y-auto break-all text-center font-mono text-[11px] text-slate-600">
                            {parentPreview}
                          </div>
                        </td>
                        <td className="w-[14rem] min-w-0 max-w-[14rem] px-3 py-2 text-center align-middle">
                          <div className="max-h-[min(24rem,50vh)] overflow-y-auto break-all text-center font-mono text-[11px] text-slate-600">
                            {childPreview}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-500">
                        没有匹配项
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      {genericDataModalOpen ? (
        <div
          className="app-modal-backdrop fixed inset-0 z-[280] flex items-center justify-center p-4"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal
            aria-labelledby="generic-data-modal-title"
            className="flex max-h-[min(44rem,92vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="generic-data-modal-title" className="text-sm font-semibold text-slate-800">
                    编辑通用数据
                  </h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    模板列名请手填（与 Excel 表头一致）；来源与配置与主映射表相同。保存后对本账号下所有导出模板生效。
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    onClick={onExportGenericPresetJson}
                    disabled={genericPresetLoadBusy || genericPresetSaveBusy}
                  >
                    导出
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => genericImportFileRef.current?.click()}
                    disabled={isSharedTemplate || genericPresetLoadBusy || genericPresetSaveBusy}
                  >
                    导入
                  </button>
                  <input
                    ref={genericImportFileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      if (isSharedTemplate) {
                        e.currentTarget.value = '';
                        return;
                      }
                      const f = e.target.files?.[0];
                      if (!f) return;
                      onImportGenericPresetJsonFile(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <table className="w-full min-w-[48rem] table-fixed border-collapse text-sm">
                <thead className="bg-slate-50/90">
                  <tr className="border-b border-slate-100 text-xs font-medium text-slate-600">
                    <th className="min-w-0 px-3 py-2 text-center">模板列名（excelHeader）</th>
                    <th className="w-[7rem] min-w-0 px-2 py-2 text-center">来源</th>
                    <th className="w-[22rem] min-w-0 px-3 py-2 text-center">配置</th>
                    <th className="w-[7.5rem] shrink-0 px-2 py-2 text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {genericPresetRows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-sm text-slate-500">
                        暂无行，请点击下方「添加一行」录入通用数据。
                      </td>
                    </tr>
                  ) : (
                    genericPresetRows.map((row) => {
                      const src = row.source;
                      const st = src.type;
                      return (
                        <tr key={row.id} className="border-b border-slate-50 last:border-0">
                          <td className="min-w-0 px-3 py-2 align-middle">
                            <input
                              type="text"
                              className="h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-center font-mono text-[11px] text-slate-800 outline-none focus:border-teal-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
                              value={row.excelHeader}
                              onChange={(e) => updateGenericPresetRow(row.id, { excelHeader: e.target.value })}
                              placeholder="填写与模板一致的列名"
                              disabled={isSharedTemplate}
                            />
                          </td>
                          <td className="w-[7rem] min-w-0 max-w-[7rem] px-2 py-2 text-center align-middle">
                            <CustomSelect
                              value={st}
                              onChange={(v) => applyGenericSourceType(row.id, v as ColumnValueSource['type'])}
                              options={[
                                { value: 'const', label: '常量' },
                                { value: 'field', label: '字段' },
                                { value: 'expr', label: '表达式' },
                              ]}
                              className="w-full min-w-0"
                              buttonClassName="flex h-10 w-full min-w-0 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 shadow-none outline-none ring-0 transition hover:border-slate-300 focus:border-teal-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isSharedTemplate}
                            />
                          </td>
                          <td className="w-[22rem] min-w-0 max-w-[22rem] px-3 py-2 text-center align-middle">
                            {st === 'field' ? (
                              <button
                                type="button"
                                className="group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-orange-300/90 bg-white px-2 text-left text-sm transition hover:border-orange-400/90 hover:bg-orange-50/40 disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => setGenericFieldPickerForId(row.id)}
                                disabled={isSharedTemplate}
                              >
                                <span className="min-w-0 flex-1 truncate">
                                  {src.type === 'field' && String(src.key || '').trim() ? (
                                    <>
                                      <span className="font-medium text-slate-800">
                                        {getKeyLabelForDisplay(src.key) || src.key}
                                      </span>
                                      {getKeyLabelForDisplay(src.key) ? (
                                        <span className="text-slate-500">（{src.key}）</span>
                                      ) : null}
                                    </>
                                  ) : (
                                    <span className="text-slate-400">点击选择字段…</span>
                                  )}
                                </span>
                                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                  选择
                                </span>
                              </button>
                            ) : st === 'const' ? (
                              <button
                                type="button"
                                className={`group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                  src.type === 'const' && String(src.value).trim()
                                    ? 'border-emerald-300/90 bg-emerald-50/40 hover:border-emerald-400/90 hover:bg-emerald-50/60'
                                    : 'border-slate-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/50'
                                }`}
                                onClick={() => {
                                  if (src.type !== 'const') {
                                    setGenericRowSource(row.id, { type: 'const', value: '', applyTo: 'child' });
                                  }
                                  setGenericConstExprForId(row.id);
                                }}
                                disabled={isSharedTemplate}
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800">
                                  常量 ·{' '}
                                  {src.type === 'const' ? applyToShortLabel(getConstExprApplyTo(src)) : '父行与子行'} ·{' '}
                                  {src.type === 'const' && String(src.value).trim() ? (
                                    <span className="rounded bg-emerald-200/80 px-1.5 py-0.5 font-semibold text-emerald-900">
                                      {truncateDisplay(src.value, 48)}
                                    </span>
                                  ) : (
                                    '点击配置'
                                  )}
                                </span>
                                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                  编辑
                                </span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={`group flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                  src.type === 'expr' && String(src.expr || '').trim()
                                    ? 'border-indigo-300/90 bg-indigo-50/40 hover:border-indigo-400/90 hover:bg-indigo-50/60'
                                    : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/50'
                                }`}
                                onClick={() => {
                                  if (src.type !== 'expr') {
                                    setGenericRowSource(row.id, { type: 'expr', expr: '{{}}', applyTo: 'both' });
                                  }
                                  setGenericConstExprForId(row.id);
                                }}
                                disabled={isSharedTemplate}
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800">
                                  表达式 ·{' '}
                                  {src.type === 'expr' ? applyToShortLabel(getConstExprApplyTo(src)) : '父行与子行'} ·{' '}
                                  {src.type === 'expr' && String(src.expr || '').trim() ? (
                                    <span className="rounded bg-indigo-200/80 px-1.5 py-0.5 font-semibold text-indigo-900">
                                      {truncateDisplay(src.expr, 48)}
                                    </span>
                                  ) : (
                                    '点击配置'
                                  )}
                                </span>
                                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium leading-none text-slate-600 group-hover:bg-teal-100 group-hover:text-teal-800">
                                  编辑
                                </span>
                              </button>
                            )}
                          </td>
                          <td className="w-[7.5rem] shrink-0 px-2 py-2 text-center align-middle">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                className="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                                onClick={() => duplicateGenericPresetRow(row.id)}
                                disabled={isSharedTemplate}
                                title="复制此行（字段 key 末尾数字自动 +1）"
                              >
                                复制
                              </button>
                              <button
                                type="button"
                                className="rounded-lg border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100/70 disabled:opacity-50"
                                onClick={() => removeGenericPresetRow(row.id)}
                                disabled={isSharedTemplate}
                                title="删除此行"
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <div className="text-[11px] text-slate-500">{genericPresetLoadBusy ? '加载中…' : ' '}</div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                  onClick={addGenericPresetRow}
                  disabled={isSharedTemplate || genericPresetLoadBusy || genericPresetSaveBusy}
                  title="添加一行通用数据"
                >
                  添加一行
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                  onClick={() => void onSaveGenericPresetsToServer()}
                  disabled={isSharedTemplate || genericPresetLoadBusy || genericPresetSaveBusy}
                >
                  {genericPresetSaveBusy ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  onClick={() => closeGenericDataModal()}
                  disabled={genericPresetSaveBusy}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {uploadTemplateOpen ? (
        <div
          className="app-modal-backdrop fixed inset-0 z-[310] flex items-center justify-center p-4"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal
            aria-labelledby="upload-template-modal-title"
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 id="upload-template-modal-title" className="text-sm font-semibold text-slate-800">
                上传空模板
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                上传后服务器会解析指定 sheet 的表头行，生成列名列表供后续映射使用。
              </p>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
                <div className="min-w-0">
                  <label className="mb-1 block text-xs font-medium text-slate-600">空模板名称</label>
                  <input
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-teal-400"
                    value={uploadName}
                    onChange={(e) => setUploadName(e.target.value)}
                    placeholder="例如：男士夹克-US商城 或 多商城"
                    disabled={uploadBusy}
                  />
                </div>

                <div className="min-w-0">
                  <label className="mb-1 block text-xs font-medium text-slate-600">绑定平台</label>
                  <CustomSelect
                    value={uploadDestPlatformId}
                    onChange={(v) => setUploadDestPlatformId(String(v))}
                    options={(exportPlatforms || []).map((p) => ({
                      value: p.id,
                      label: p.name,
                      icon: platformGlyphForName(p.name),
                      iconOnly: true,
                    }))}
                    className="w-full"
                    buttonClassName="flex h-10 w-32 items-center justify-center rounded-full border border-slate-200 bg-white px-2 text-sm text-slate-800 shadow-none outline-none ring-0 transition hover:border-slate-300 focus:border-teal-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
              </div>
              <p className="-mt-2 text-[11px] leading-relaxed text-slate-500">
                上传后将自动生成新的导出类型ID，并归属到该平台目录下。
              </p>

              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-700">可见性</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                    勾选：公开（所有用户可见）。不勾选，仅自己可见。
                  </div>
                </div>
                <label className="shrink-0 inline-flex select-none items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-emerald-600"
                    checked={uploadIsPublic}
                    onChange={(e) => setUploadIsPublic(e.target.checked)}
                    disabled={uploadBusy}
                  />
                  <span className="text-xs font-medium">公开</span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">子表名称（sheetName）</label>
                  <input
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-teal-400"
                    value={uploadSheetName}
                    onChange={(e) => setUploadSheetName(e.target.value)}
                    placeholder="模板"
                    disabled={uploadBusy}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">表头行（headerRow）</label>
                  <input
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm text-slate-800 outline-none focus:border-teal-400"
                    value={uploadHeaderRow || ''}
                    onChange={(e) => setUploadHeaderRow(Number(e.target.value))}
                    inputMode="numeric"
                    placeholder="3"
                    disabled={uploadBusy}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">数据起始行（dataStartRow）</label>
                  <input
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm text-slate-800 outline-none focus:border-teal-400"
                    value={uploadDataStartRow || ''}
                    onChange={(e) => setUploadDataStartRow(Number(e.target.value))}
                    inputMode="numeric"
                    placeholder="4"
                    disabled={uploadBusy}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">文件（.xlsx/.xlsm）</label>
                  <input
                    ref={uploadFileRef}
                    type="file"
                    accept=".xlsx,.xlsm"
                    className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                    disabled={uploadBusy}
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div
                  className={`min-h-[1.25rem] min-w-0 flex-1 truncate text-sm ${
                    uploadErr ? 'text-red-600' : 'text-transparent'
                  }`}
                  title={uploadErr || undefined}
                >
                  {uploadErr || '占位'}
                </div>
                <div className="shrink-0 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
                    onClick={() => setUploadTemplateOpen(false)}
                    disabled={uploadBusy}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    onClick={() => void submitUploadTemplate()}
                    disabled={uploadBusy}
                  >
                    {uploadBusy ? '上传中…' : '上传并解析'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmModal
        open={importConfirmOpen}
        title="确认导入映射"
        message={`请确认已选择正确的导出模板。

导入将覆盖当前模板的映射配置（本页内存）。如需生效请再点击「保存到服务器」。`}
        confirmText="继续导入"
        cancelText="取消"
        busy={false}
        onCancel={() => {
          setImportConfirmOpen(false);
          setImportPendingFile(null);
        }}
        onConfirm={() => {
          const f = importPendingFile;
          setImportConfirmOpen(false);
          setImportPendingFile(null);
          if (f) onImportJsonFileConfirmed(f);
        }}
      />

      <ConfirmModal
        open={deleteConfirmOpen}
        title="确认删除模板"
        message={
          deletePendingTemplate
            ? `确定删除模板「${deletePendingTemplate.name}（${deletePendingTemplate.uidLabel}）」？删除后不可恢复。`
            : '确定删除该模板？删除后不可恢复。'
        }
        confirmText="确认删除"
        cancelText="取消"
        busy={deleteConfirmBusy}
        onCancel={() => {
          if (deleteConfirmBusy) return;
          setDeleteConfirmOpen(false);
          setDeletePendingTemplate(null);
        }}
        onConfirm={() => {
          const pending = deletePendingTemplate;
          if (!pending?.id) return;
          if (deleteConfirmBusy) return;
          void (async () => {
            setDeleteConfirmBusy(true);
            setErr('');
            try {
              await api.deleteAdminExportTemplate(pending.id);
              const list = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
              const nextList = Array.isArray(list.templates) ? list.templates : [];
              setCustomTemplates(nextList);
              toastSuccess('模板已删除', '删除成功');

              // 若删除的是当前选中项：自动切到剩余第一个，否则保持当前 selection
              const curId = String(headerTemplateValue || '').startsWith('custom:')
                ? String(headerTemplateValue).slice('custom:'.length).trim()
                : '';
              if (curId && curId === pending.id) {
                setHeaderTemplateValue('');
                setExportTypeId('');
                setHeaderText('');
                setSheetName('模板');
                setHeaderRow(1);
                setDataStartRow(2);
                setMap({});
                setSelectedHeaderKey('');
                if (nextList.length) {
                  await applyCustomTemplate(nextList[0].id);
                } else {
                  toastWarning('模板已删除：当前没有可用模板，请先上传空模板', '模板已删除');
                }
              }
            } catch (e) {
              setErr(e instanceof Error ? e.message : '删除失败');
            } finally {
              setDeleteConfirmBusy(false);
              setDeleteConfirmOpen(false);
              setDeletePendingTemplate(null);
            }
          })();
        }}
      />

      <RenameModal
        open={renameOpen}
        title="重命名模板"
        initialValue={renameInitial}
        busy={renameBusy}
        onCancel={() => {
          if (renameBusy) return;
          setRenameOpen(false);
          setRenameTemplateId('');
          setRenameInitial('');
        }}
        onConfirm={(nextName) => {
          const nn = String(nextName || '').trim();
          const cur = String(renameInitial || '').trim();
          if (!nn) {
            setErr('模板名称不能为空');
            return;
          }
          if (!renameTemplateId) return;
          if (nn === cur) {
            setRenameOpen(false);
            setRenameTemplateId('');
            setRenameInitial('');
            return;
          }
          void (async () => {
            setRenameBusy(true);
            setErr('');
            try {
              await api.renameAdminExportTemplate(renameTemplateId, { name: nn });
              const list = await api.adminExportTemplates({ hidePublic: hidePublicTemplates });
              setCustomTemplates(Array.isArray(list.templates) ? list.templates : []);
              setRenameOpen(false);
              setRenameTemplateId('');
              setRenameInitial('');
            } catch (e) {
              setErr(e instanceof Error ? e.message : '重命名失败');
            } finally {
              setRenameBusy(false);
            }
          })();
        }}
      />

      <FieldKeyModal
        open={fieldPickerFor != null}
        excelHeader={
          fieldPickerFor != null && Number.isFinite(Number(fieldPickerFor))
            ? headers[Math.max(0, Math.min(headers.length - 1, Number(fieldPickerFor)))] ?? ''
            : ''
        }
        value={fieldPickerFor && map[fieldPickerFor]?.type === 'field' ? map[fieldPickerFor].key : ''}
        onPick={(key) => {
          if (isSharedTemplate) return;
          if (fieldPickerFor) setSourceForHeader(fieldPickerFor, { type: 'field', key });
        }}
        onClose={() => setFieldPickerFor(null)}
        options={fieldPickerOptions}
        disabled={isSharedTemplate}
      />

      {constExprEditorFor && map[constExprEditorFor] && (map[constExprEditorFor].type === 'const' || map[constExprEditorFor].type === 'expr') ? (
        <ConstExprEditorModal
          open
          excelHeader={
            constExprEditorFor != null && Number.isFinite(Number(constExprEditorFor))
              ? headers[Math.max(0, Math.min(headers.length - 1, Number(constExprEditorFor)))] ?? ''
              : ''
          }
          source={map[constExprEditorFor]}
          onSave={(next) => {
            if (isSharedTemplate) return;
            if (constExprEditorFor) setSourceForHeader(constExprEditorFor, next);
          }}
          onClose={() => setConstExprEditorFor(null)}
          disabled={isSharedTemplate}
        />
      ) : null}

      <FieldKeyModal
        open={genericFieldPickerForId != null}
        excelHeader={genericPickerExcelHeader}
        value={genericFieldPickerKeyValue}
        onPick={(key) => {
          if (isSharedTemplate) return;
          if (genericFieldPickerForId) setGenericRowSource(genericFieldPickerForId, { type: 'field', key });
        }}
        onClose={() => setGenericFieldPickerForId(null)}
        options={genericFieldPickerOptions}
        disabled={isSharedTemplate}
      />

      {genericConstExprEditorBundle ? (
        <ConstExprEditorModal
          open
          excelHeader={
            String(genericConstExprEditorBundle.row.excelHeader || '').trim() || '（未填写列名）'
          }
          source={genericConstExprEditorBundle.source}
          onSave={(next) => {
            if (isSharedTemplate) return;
            if (genericConstExprForId) setGenericRowSource(genericConstExprForId, next);
          }}
          onClose={() => setGenericConstExprForId(null)}
          disabled={isSharedTemplate}
        />
      ) : null}
    </div>
  );
}
