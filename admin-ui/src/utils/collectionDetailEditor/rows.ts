export const SIZE_FIELD_KEYS = ['尺码', '尺寸'] as const;
export const COLOR_FIELD_KEYS = ['颜色', 'Color', 'colour'] as const;

export function dataToRows(data: Record<string, unknown>): Record<string, unknown>[] {
  const r = (data as any).rows;
  if (Array.isArray(r)) {
    return JSON.parse(JSON.stringify(r)) as Record<string, unknown>[];
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && !('rows' in data)) {
    return [JSON.parse(JSON.stringify(data)) as Record<string, unknown>];
  }
  return [];
}

/** 从插件通用数据（genericData）各行读取「价格」/ Price，有则返回展示文案，无则空串 */
export function readGenericPluginPrice(generic: Record<string, unknown> | undefined): string {
  if (!generic || typeof generic !== 'object' || Array.isArray(generic)) return '';
  const list = dataToRows(generic);
  for (const row of list) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const v = (row as any)['价格'] ?? (row as any)['Price'];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const joined = v.map((x) => String(x ?? '').trim()).filter(Boolean).join(' / ');
      if (joined) return joined;
    }
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

export function sharedRowIndex(rows: Record<string, unknown>[]): number {
  const p = rows.findIndex((r) => (r as any)['父子关系'] === 'parent');
  if (p >= 0) return p;
  return 0;
}

export function variantIndices(rows: Record<string, unknown>[], _sharedIdx: number): number[] {
  const ch = rows.map((_, i) => i).filter((i) => (rows[i] as any)['父子关系'] === 'child');
  if (ch.length) return ch;
  if (!rows.length) return [];
  return rows.map((_, i) => i);
}

/** 将采集值拆成多行：数组每项一行；字符串先按换行，再按 , ， / | 拆成多行 */
export function expandFieldToLines(val: unknown): string[] {
  if (val == null) return [];
  if (Array.isArray(val)) {
    return val.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return [];
    if (s.includes('\n')) return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (/[,，\/|]/.test(s)) {
      return s.split(/[,，\/|]+/).map((x) => x.trim()).filter(Boolean);
    }
    return [s];
  }
  return [String(val).trim()].filter(Boolean);
}

function getFieldFromRow(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) return (row as any)[k];
  }
  return undefined;
}

/**
 * 尺码/颜色展示：
 * - 单行数据：按采集格式拆成多行（换行、逗号、斜杠等）。
 * - 多 SKU：从各子行收集值后去重并保持出现顺序。
 * - 若汇总行已保存过多行文本，优先用汇总行。
 */
export function fieldLinesDisplay(rows: Record<string, unknown>[], keys: readonly string[]): string {
  if (!rows.length) return '';
  const sIdx = sharedRowIndex(rows);
  const parent = rows[sIdx];
  const vIdxs = variantIndices(rows, sIdx);

  if (vIdxs.length === 1) {
    return expandFieldToLines(getFieldFromRow(parent, keys)).join('\n');
  }

  const parentVal = getFieldFromRow(parent, keys);
  if (parentVal != null && String(parentVal).trim() !== '') {
    const fromParent = expandFieldToLines(parentVal);
    if (fromParent.length) return fromParent.join('\n');
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const idx of vIdxs) {
    const r = rows[idx];
    const parts = expandFieldToLines(getFieldFromRow(r, keys));
    for (const p of parts) {
      const k = p.trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      ordered.push(k);
    }
  }
  return ordered.join('\n');
}

export function readDescriptions(row: Record<string, unknown>): { key: string; lines: string[] }[] {
  const blocks: { key: string; lines: string[] }[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (!k.includes('描述') || k.includes('详情')) continue;
    if (Array.isArray(v)) {
      blocks.push({ key: k, lines: v.map((x) => String(x ?? '')) });
    } else if (typeof v === 'string') {
      blocks.push({ key: k, lines: v ? [v] : [''] });
    }
  }
  if (!blocks.length && (row as any)['描述'] != null) {
    const v = (row as any)['描述'];
    if (Array.isArray(v)) blocks.push({ key: '描述', lines: v.map(String) });
    else if (typeof v === 'string') blocks.push({ key: '描述', lines: [v] });
  }
  return blocks;
}

export function readDetails(row: Record<string, unknown>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (!k.includes('详情')) continue;
    // 「详情图」是图片 URL 列表：单独用卡片展示，不放进“详情”文本卡片
    if (k === '详情图' || k.startsWith('详情图')) continue;
    if (typeof v === 'string') {
      out.push({ key: k, value: v });
    } else if (Array.isArray(v)) {
      out.push({
        key: k,
        value: v
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .join('<br>'),
      });
    }
  }
  return out;
}

export function getTitle(rows: Record<string, unknown>[]): string {
  for (const r of rows) {
    const t = (r as any)['标题'] ?? (r as any)['商品标题'];
    if (typeof t === 'string') return t;
  }
  return '';
}

export function mainImageUrls(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const v = (row as any)['主图'];
  if (typeof v === 'string' && v.trim()) out.push(v.trim());
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = String(x ?? '').trim();
      if (s) out.push(s);
    }
  }
  const keys = Object.keys(row)
    .filter((k) => /^主图\d+$/.test(k))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  for (const k of keys) {
    const s = String((row as any)[k] ?? '').trim();
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

export function mainImageUrl(row: Record<string, unknown>): string {
  const all = mainImageUrls(row);
  return all[0] || '';
}

/** 可编辑的主图字段键（不含数组型「主图」，数组单独用多行文本） */
export function mainImageFieldEntries(row: Record<string, unknown>): { key: string }[] {
  if (Array.isArray((row as any)['主图'])) {
    return [];
  }
  const out: { key: string }[] = [];
  if (Object.prototype.hasOwnProperty.call(row, '主图')) {
    out.push({ key: '主图' });
  }
  const nums = Object.keys(row)
    .filter((k) => /^主图\d+$/.test(k))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  for (const k of nums) {
    if (!out.some((o) => o.key === k)) out.push({ key: k });
  }
  if (!out.length) out.push({ key: '主图' });
  return out;
}

