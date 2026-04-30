import { nowCstIsoLike } from './timeCst';

/** 历史内置 id 的展示名（仅用于旧数据或已删平台 id 的回退显示） */
const LEGACY_DEST_PLATFORM_LABELS: Record<string, string> = {
  amazon: '亚马逊（Amazon）',
  temu: 'Temu',
  shopee: '虾皮（Shopee）',
  lazada: 'Lazada',
  tiktok: 'TikTok Shop',
  other: '其他 / 通用',
};

/** 可选：与服务端 app_settings.platform_enrich_map 对齐；同一键驱动标题/描述/颜色/详情/搜索词等整链二次处理 */
export const PLATFORM_ENRICH_KEY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '未绑定' },
  { value: 'amazon', label: '亚马逊（amazon）' },
  { value: 'temu', label: 'Temu（temu）' },
  { value: 'shopee', label: '虾皮（shopee）' },
  { value: 'lazada', label: 'Lazada（lazada）' },
  { value: 'tiktok', label: 'TikTok Shop（tiktok）' },
  { value: 'generic', label: '通用（generic）' },
];

/** 导出目标平台（与 GET /api/export/platforms 一致；由服务端维护） */
export type StoredExportPlatform = {
  id: string;
  name: string;
  enrichKey?: string;
};

export type StoredExportType = {
  id: string;
  name: string;
  format: 'csv' | 'xlsx';
  /** 亚马逊 Listing 平铺；通用为采集字段扁表 */
  mode: 'amazon' | 'generic';
  /** 目标销售平台 id（来自管理员创建的平台；与平台数据一一绑定） */
  destPlatform: string;
  /** 已弃用：导出模板改由服务端生成，保留字段仅为兼容旧版 localStorage 解析 */
  templateWorkbookBase64?: string;
  templateOriginalName?: string;
};

/** v2：允许空列表持久化；v1 在「删光」后会误回退默认种子，故升级 key */
const STORAGE_KEY = 'admin_export_types_v2';
const LEGACY_STORAGE_KEY = 'admin_export_types_v1';

function safeFilenamePart(s: string, max = 64): string {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseExportTypesArray(parsed: unknown): StoredExportType[] {
  if (!Array.isArray(parsed)) return [];
  const out: StoredExportType[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = String(o.id || '').trim();
    const name = String(o.name || '').trim();
    const format = o.format === 'csv' ? 'csv' : o.format === 'xlsx' ? 'xlsx' : null;
    const mode = o.mode === 'amazon' || o.mode === 'generic' ? o.mode : null;
    if (!id || !name || !format || !mode) continue;
    const rawDest = String(o.destPlatform || '').trim();
    const destPlatform =
      rawDest || (mode === 'amazon' ? 'amazon' : 'other');
    const templateWorkbookBase64 =
      typeof o.templateWorkbookBase64 === 'string' && o.templateWorkbookBase64.trim() !== ''
        ? o.templateWorkbookBase64.trim()
        : undefined;
    const templateOriginalName =
      typeof o.templateOriginalName === 'string' && o.templateOriginalName.trim() !== ''
        ? o.templateOriginalName.trim()
        : undefined;
    let effFormat = format;
    if (templateWorkbookBase64 && effFormat === 'csv') effFormat = 'xlsx';
    out.push({
      id,
      name,
      format: effFormat,
      mode,
      destPlatform,
      ...(templateWorkbookBase64
        ? { templateWorkbookBase64, templateOriginalName }
        : templateOriginalName
          ? { templateOriginalName }
          : {}),
    });
  }
  return out;
}

/**
 * 读取导出类型（与采集页导出弹窗选项 1:1：一条配置 = 一个可选项）。
 * 无数据时返回空数组，不再注入默认种子，避免「删光后刷新又出现」。
 */
export function loadExportTypes(): StoredExportType[] {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null || raw === '') {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy != null && legacy !== '') {
        try {
          const parsed = JSON.parse(legacy) as unknown;
          const migrated = parseExportTypesArray(parsed);
          saveExportTypes(migrated);
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          return migrated;
        } catch {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return parseExportTypesArray(parsed);
  } catch {
    return [];
  }
}

export function saveExportTypes(types: StoredExportType[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(types));
    return true;
  } catch {
    return false;
  }
}

export function destPlatformLabel(id: string, platforms?: StoredExportPlatform[]): string {
  const p = platforms?.find((x) => x.id === id);
  if (p) return p.name;
  return LEGACY_DEST_PLATFORM_LABELS[id] || id || '未命名平台';
}

/** 下拉：当前平台列表 + 若仍引用已删 id，则补一条便于改选 */
export function exportDestPlatformsForSelect(
  platforms: StoredExportPlatform[],
  currentDestId: string
): StoredExportPlatform[] {
  const list = [...platforms];
  if (currentDestId && !list.some((p) => p.id === currentDestId)) {
    list.unshift({
      id: currentDestId,
      name: `${destPlatformLabel(currentDestId, platforms)}（已删除，请改选）`,
    });
  }
  return list;
}

/**
 * 请求参数 target：amazon 走亚马逊平铺（用已入库的亚马逊平台数据）；其余走通用扁表（服务端从 generic_data 二次加工后导出）
 */
export function resolveApiTarget(mode: 'amazon' | 'generic', destPlatformId: string): string {
  if (mode === 'amazon') return 'amazon';
  const d = String(destPlatformId || '').trim();
  return d && d !== 'amazon' ? d : 'generic';
}

export function buildExportDownloadFilename(
  destPlatformId: string,
  typeName: string,
  format: 'csv' | 'xlsx',
  includeImages: boolean,
  mode: 'amazon' | 'generic',
  platforms?: StoredExportPlatform[]
): string {
  const iso = nowCstIsoLike();
  const stamp =
    iso.slice(0, 10) +
    '_' +
    iso.slice(11, 19).replace(/:/g, '-') +
    '_000';
  const dest = safeFilenamePart(destPlatformLabel(destPlatformId, platforms), 32);
  const tname = safeFilenamePart(typeName, 48);
  const base = `${dest}_${tname}_${stamp}`;
  if (includeImages && mode === 'amazon')
    return `${base}_含去背景图.zip`;
  if (includeImages) return `${base}_含图片.zip`;
  if (mode === 'amazon')
    return format === 'xlsx' ? `${base}.xlsx` : `${base}.csv`;
  return format === 'xlsx' ? `${base}.xlsx` : `${base}.csv`;
}
