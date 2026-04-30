/**
 * 与 server/src/images/downloader.js 中 extractImageUrlsFromRows 一致：
 * 从多条 SKU 行收集主图/副图 URL 后按首次出现顺序去重，与下载 manifest 槽位一致。
 */
function uniqStrings(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    const v = String(s || '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function extractImageUrlsFromRowsLikeServer(rows: Record<string, unknown>[]): {
  main: string[];
  gallery: string[];
} {
  const main: string[] = [];
  const gallery: string[] = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    for (const [k, v] of Object.entries(r)) {
      const key = String(k || '');
      if (!key) continue;
      const isMain = key.includes('主图');
      const isGallery = key.startsWith('副图') || key.includes('副图');
      if (!isMain && !isGallery) continue;

      const pushVal = (val: unknown) => {
        if (typeof val === 'string' && val.trim()) {
          const t = val.trim();
          if (isMain) main.push(t);
          else gallery.push(t);
        }
      };

      if (Array.isArray(v)) v.forEach(pushVal);
      else pushVal(v);
    }
  }
  return { main: uniqStrings(main), gallery: uniqStrings(gallery) };
}
