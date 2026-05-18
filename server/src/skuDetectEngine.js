import { DEFAULT_SKU_DETECT_RULES } from './skuDetectDefaults.js';

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function cleanString(v) {
  return String(v ?? '').trim();
}

function parseMaybeJson(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function parseJsonStringIfNeeded(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || !/^[\[{]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function decodeSkuPart(v) {
  return cleanString(v)
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/&#62;/g, '>')
    .replace(/&#60;/g, '<');
}

export function normalizeSkuDetectRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const cfg = parseMaybeJson(r.config_json ?? r.config, {});
  const source = { ...cfg, ...r };
  const arrayDetectRules = source.arrayDetectRules || {};
  return {
    id: source.id,
    name: cleanString(source.name || '未命名规则'),
    platform: cleanString(source.platform || 'universal'),
    matchHost: asArray(source.matchHost ?? source.match_host_json).map(cleanString).filter(Boolean),
    enabled: source.enabled === false || source.enabled === 0 ? false : true,
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100,
    windowPaths: asArray(source.windowPaths).map(cleanString).filter(Boolean),
    scriptKeywords: asArray(source.scriptKeywords).map(cleanString).filter(Boolean),
    arrayDetectRules: {
      requiredAnyKeys: asArray(arrayDetectRules.requiredAnyKeys).map(cleanString).filter(Boolean),
      optionalKeys: asArray(arrayDetectRules.optionalKeys).map(cleanString).filter(Boolean),
      minItemCount: Math.max(1, Number(arrayDetectRules.minItemCount || 1)),
      maxDepth: Math.max(1, Math.min(16, Number(arrayDetectRules.maxDepth || 6))),
    },
    fieldMapping:
      source.fieldMapping && typeof source.fieldMapping === 'object' && !Array.isArray(source.fieldMapping)
        ? Object.fromEntries(
            Object.entries(source.fieldMapping).map(([k, v]) => [k, asArray(v).map(cleanString).filter(Boolean)])
          )
        : {},
  };
}

export function defaultSkuDetectRules() {
  return DEFAULT_SKU_DETECT_RULES.map((x) => normalizeSkuDetectRule(x));
}

export function hostMatchesRule(hostRaw, rule) {
  const host = cleanString(hostRaw).toLowerCase();
  if (!host) return false;
  const pats = asArray(rule.matchHost).map((x) => cleanString(x).toLowerCase()).filter(Boolean);
  if (!pats.length) return false;
  return pats.some((p) => p === '*' || host === p || host.endsWith(`.${p}`) || host.includes(p));
}

export function matchSkuDetectRules(rulesRaw, hostRaw, platformRaw = '') {
  const rules = asArray(rulesRaw).map(normalizeSkuDetectRule).filter((r) => r.enabled && hostMatchesRule(hostRaw, r));
  const platform = cleanString(platformRaw).toLowerCase();
  return rules
    .sort((a, b) => {
      const ap = platform && cleanString(a.platform).toLowerCase().includes(platform) ? 0 : 1;
      const bp = platform && cleanString(b.platform).toLowerCase().includes(platform) ? 0 : 1;
      return ap - bp || a.priority - b.priority || String(a.name).localeCompare(String(b.name));
    });
}

function keySet(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return new Set();
  return new Set(Object.keys(obj).map((k) => k.toLowerCase()));
}

function hasAnyKey(obj, keys) {
  const ks = keySet(obj);
  return asArray(keys).some((k) => ks.has(cleanString(k).toLowerCase()));
}

function scoreItem(obj, rule) {
  const rd = rule.arrayDetectRules || {};
  let score = 0;
  if (hasAnyKey(obj, rd.requiredAnyKeys)) score += 5;
  for (const k of asArray(rd.optionalKeys)) {
    if (hasAnyKey(obj, [k])) score += 1;
  }
  return score;
}

function isSkuLikeArray(arr, rule) {
  if (!Array.isArray(arr)) return false;
  const min = Math.max(1, Number(rule.arrayDetectRules?.minItemCount || 1));
  if (arr.length < min) return false;
  const objs = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (!objs.length) return false;
  return objs.some((x) => scoreItem(x, rule) >= 5);
}

export function findSkuArrays(root, rule) {
  const maxDepth = Math.max(1, Number(rule.arrayDetectRules?.maxDepth || 6));
  const found = [];
  const seen = new WeakSet();
  function walk(node, path, depth) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (isSkuLikeArray(node, rule)) {
        const score = node.reduce((sum, x) => sum + scoreItem(x, rule), 0);
        found.push({ path, value: node, score });
      }
      if (depth >= maxDepth) return;
      node.slice(0, 30).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }
    if (depth >= maxDepth) return;
    for (const [k, v] of Object.entries(node)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  }
  walk(root, '', 0);
  return found.sort((a, b) => b.score - a.score || b.value.length - a.value.length);
}

function directValueByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const entries = Object.entries(obj);
  for (const alias of keys) {
    const a = cleanString(alias).toLowerCase();
    const hit = entries.find(([k]) => k.toLowerCase() === a);
    if (hit) return hit[1];
  }
  return undefined;
}

function findValueByKeys(obj, keys, maxDepth = 3) {
  const direct = directValueByKeys(obj, keys);
  if (direct !== undefined) return direct;
  const seen = new WeakSet();
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > maxDepth) return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    const v = directValueByKeys(node, keys);
    if (v !== undefined) return v;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) {
        const got = walk(item, depth + 1);
        if (got !== undefined) return got;
      }
    } else {
      for (const child of Object.values(node)) {
        const got = walk(child, depth + 1);
        if (got !== undefined) return got;
      }
    }
    return undefined;
  }
  return walk(obj, 0);
}

function scalar(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return cleanString(v);
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => {
        if (x == null) return '';
        if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return cleanString(x);
        if (typeof x === 'object') {
          const name = cleanString(x.name || x.propName || x.propertyName || x.key || x.title);
          const value = cleanString(x.value || x.propertyValue || x.text || x.label);
          return value || name;
        }
        return '';
      })
      .filter(Boolean);
    return parts.join(' / ');
  }
  if (typeof v === 'object') {
    return cleanString(v.value || v.propertyValue || v.text || v.label || v.name || v.url || v.src);
  }
  return '';
}

function imageScalar(v) {
  if (typeof v === 'string') return cleanString(v);
  if (Array.isArray(v)) return imageScalar(v.find(Boolean));
  if (v && typeof v === 'object') {
    return cleanString(v.url || v.src || v.imageUrl || v.picUrl || v.pic || v.image || v.fullPathImageURI || v.size310x310ImageURI || v.imageURI);
  }
  return '';
}

function normalize1688ImageUrl(raw) {
  const s = cleanString(raw);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  return `https://cbu01.alicdn.com/${s.replace(/^\/+/, '')}`;
}

function get1688SkuModel(root) {
  const direct = parseJsonStringIfNeeded(root);
  if (!direct || typeof direct !== 'object') return null;
  if (direct && typeof direct === 'object' && direct.skuProps && direct.skuInfoMap) return direct;
  if (direct && typeof direct === 'object' && direct.skuModel) {
    const skuModel = parseJsonStringIfNeeded(direct.skuModel);
    if (skuModel && typeof skuModel === 'object' && skuModel.skuProps && skuModel.skuInfoMap) return skuModel;
  }
  const fields = direct?.result?.data?.Root?.fields;
  if (fields && typeof fields === 'object') {
    const dataJson = parseJsonStringIfNeeded(fields.dataJson);
    if (dataJson && typeof dataJson === 'object') {
      const skuModel = parseJsonStringIfNeeded(dataJson.skuModel);
      if (skuModel && typeof skuModel === 'object' && skuModel.skuProps && skuModel.skuInfoMap) return skuModel;
    }
  }
  return find1688SkuModelDeep(direct);
}

function find1688SkuModelDeep(root) {
  const seen = new WeakSet();
  function walk(node, depth) {
    const parsed = parseJsonStringIfNeeded(node);
    if (!parsed || typeof parsed !== 'object' || depth > 8) return null;
    if (seen.has(parsed)) return null;
    seen.add(parsed);
    if (parsed.skuProps && parsed.skuInfoMap) return parsed;
    if (parsed.skuModel) {
      const skuModel = parseJsonStringIfNeeded(parsed.skuModel);
      if (skuModel && typeof skuModel === 'object' && skuModel.skuProps && skuModel.skuInfoMap) return skuModel;
    }
    const vals = Array.isArray(parsed) ? parsed.slice(0, 50) : Object.values(parsed);
    for (const child of vals) {
      const got = walk(child, depth + 1);
      if (got) return got;
    }
    return null;
  }
  return walk(root, 0);
}

function build1688ColorImageMap(skuModel) {
  const map = new Map();
  const props = asArray(skuModel?.skuProps);
  const colorProps = props.filter((p) => {
      const name = decodeSkuPart(
        p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
      );
      return String(name || '').includes('颜色') || String(name || '').toLowerCase().includes('color');
    });
  function addValues(values) {
    for (const v of asArray(values)) {
      if (!v || typeof v !== 'object') continue;
      const name = decodeSkuPart(
        v.name || v.value || v.text || v.label || v.propertyValue || v.valueName || v.propValue || v.skuValueName
      );
      const img = normalize1688ImageUrl(
        imageScalar(
          v.imageUrl ||
            v.imageURL ||
            v.imgUrl ||
            v.img ||
            v.picUrl ||
            v.picURL ||
            v.pic ||
            v.picture ||
            v.originalImageUrl ||
            v.fullPathImageURI ||
            v.size310x310ImageURI ||
            v.imageURI
        )
      );
      if (name && img && !map.has(name)) map.set(name, img);
    }
  }
  for (const prop of colorProps) addValues(prop?.value || prop?.values || prop?.items || prop?.list);
  return map;
}

function valueNameFrom1688SkuPropValue(v) {
  if (!v || typeof v !== 'object') return decodeSkuPart(v);
  return decodeSkuPart(v.name || v.value || v.text || v.label || v.propertyValue || v.valueName || v.propValue || v.skuValueName);
}

function build1688AxisValueSets(skuModel) {
  const props = asArray(skuModel?.skuProps);
  const colorNames = new Set();
  const sizeNames = new Set();
  props.forEach((p, ix) => {
    const propName = decodeSkuPart(
      p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
    );
    const names = asArray(p?.value || p?.values || p?.items || p?.list).map(valueNameFrom1688SkuPropValue).filter(Boolean);
    const isColor = propName === '颜色' || propName.toLowerCase() === 'color' || ix === 0;
    const isSize = propName === '尺码' || propName === '尺寸' || propName.toLowerCase() === 'size' || ix === 1;
    if (isColor) names.forEach((x) => colorNames.add(x));
    if (isSize) names.forEach((x) => sizeNames.add(x));
  });
  return { colorNames, sizeNames };
}

export function build1688LegacyProductMeta(root) {
  const skuModel = get1688SkuModel(root);
  if (!skuModel) return null;
  const props = asArray(skuModel.skuProps);
  const colorProp = props.find((p) => {
    const name = decodeSkuPart(
      p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
    );
    return String(name || '').includes('颜色') || String(name || '').toLowerCase().includes('color');
  });
  const sizeProp = props.find((p) => {
    const name = decodeSkuPart(
      p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
    );
    return String(name || '').includes('尺码') || String(name || '').includes('尺寸') || String(name || '').toLowerCase().includes('size');
  });
  const colorValues = asArray(colorProp?.value || colorProp?.values || colorProp?.items || colorProp?.list);
  const sizeValues = asArray(sizeProp?.value || sizeProp?.values || sizeProp?.items || sizeProp?.list);
  const colors = [];
  const mains = [];
  for (const v of colorValues) {
    const name = valueNameFrom1688SkuPropValue(v);
    if (!name) continue;
    colors.push(name);
    mains.push(
      normalize1688ImageUrl(
        imageScalar(
          v?.imageUrl ||
            v?.imageURL ||
            v?.imgUrl ||
            v?.img ||
            v?.picUrl ||
            v?.picURL ||
            v?.pic ||
            v?.picture ||
            v?.originalImageUrl ||
            v?.fullPathImageURI ||
            v?.size310x310ImageURI ||
            v?.imageURI
        )
      )
    );
  }
  const sizes = sizeValues.map(valueNameFrom1688SkuPropValue).filter(Boolean);
  const firstSku = Object.values(skuModel.skuInfoMap || {}).find((x) => x && typeof x === 'object') || {};
  const price = scalar(skuModel.skuPriceScale || firstSku.price || '');
  return { colors, sizes, mains, price };
}

function split1688SpecParts(raw, skuModel) {
  const parts = decodeSkuPart(raw).split('>').map((x) => decodeSkuPart(x)).filter(Boolean);
  if (parts.length <= 1) return { color: parts[0] || '', size: parts[1] || '' };
  const { colorNames, sizeNames } = build1688AxisValueSets(skuModel);
  let color = parts.find((p) => colorNames.has(p)) || parts[0] || '';
  let size = parts.find((p) => sizeNames.has(p) && p !== color) || parts.find((p) => p !== color) || parts[1] || '';
  return { color, size };
}

function extract1688DataJson(root) {
  const direct = parseJsonStringIfNeeded(root);
  if (!direct || typeof direct !== 'object') return null;
  if (direct.images || direct.gallery || direct.mainImage || direct.skuModel) return direct;
  const fields = direct?.result?.data?.Root?.fields;
  if (fields && typeof fields === 'object') {
    const dataJson = parseJsonStringIfNeeded(fields.dataJson);
    if (dataJson && typeof dataJson === 'object') return dataJson;
  }
  const seen = new WeakSet();
  function walk(node, depth) {
    const parsed = parseJsonStringIfNeeded(node);
    if (!parsed || typeof parsed !== 'object' || depth > 8) return null;
    if (seen.has(parsed)) return null;
    seen.add(parsed);
    if (parsed.images || parsed.gallery || parsed.mainImage || parsed.skuModel) return parsed;
    const vals = Array.isArray(parsed) ? parsed.slice(0, 50) : Object.values(parsed);
    for (const child of vals) {
      const got = walk(child, depth + 1);
      if (got) return got;
    }
    return null;
  }
  return walk(direct, 0);
}

function imageUrlFrom1688ImageObj(obj) {
  if (!obj || typeof obj !== 'object') return normalize1688ImageUrl(obj);
  return normalize1688ImageUrl(obj.fullPathImageURI || obj.size310x310ImageURI || obj.imageURI || obj.url || obj.src);
}

function fallback1688MainImages(root) {
  const dataJson = extract1688DataJson(root);
  const out = [];
  const push = (u) => {
    const s = normalize1688ImageUrl(u);
    if (s && !out.includes(s)) out.push(s);
  };
  if (dataJson && typeof dataJson === 'object') {
    for (const img of asArray(dataJson.images)) push(imageUrlFrom1688ImageObj(img));
    const gallery = dataJson.gallery?.fields || dataJson.gallery || {};
    for (const img of asArray(gallery.offerImgList)) push(imageUrlFrom1688ImageObj(img));
    push(imageUrlFrom1688ImageObj(gallery.mainImage || dataJson.mainImage));
  }
  return out;
}

export function parse1688SkuModelItems(root) {
  const skuModel = get1688SkuModel(root);
  if (!skuModel || !skuModel.skuInfoMap || typeof skuModel.skuInfoMap !== 'object') return null;
  const colorImageMap = build1688ColorImageMap(skuModel);
  const out = [];
  for (const [key, itemRaw] of Object.entries(skuModel.skuInfoMap)) {
    if (!itemRaw || typeof itemRaw !== 'object') continue;
    const item = itemRaw;
    const { color, size } = split1688SpecParts(item.specAttrs || key, skuModel);
    out.push({
      index: out.length,
      skuId: scalar(item.skuId),
      color,
      size,
      price: scalar(item.price || item.discountPrice),
      stock: scalar(item.canBookCount),
      mainImage: colorImageMap.get(color) || '',
      raw: item,
    });
  }
  return out.length ? out : null;
}

export function standardizeSkuItems(items, rule) {
  const fm = rule.fieldMapping || {};
  return asArray(items)
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((item, idx) => {
      const skuId = scalar(findValueByKeys(item, fm.skuId || []));
      const color = scalar(findValueByKeys(item, fm.color || []));
      const size = scalar(findValueByKeys(item, fm.size || []));
      const stock = scalar(findValueByKeys(item, fm.stock || []));
      const price = scalar(findValueByKeys(item, fm.price || []));
      const mainImage = imageScalar(findValueByKeys(item, fm.mainImage || []));
      return {
        index: idx,
        skuId,
        color,
        size,
        stock,
        price,
        mainImage,
        raw: item,
      };
    });
}

function normalizeSpecPairItems(items, root) {
  const skuModel = get1688SkuModel(root);
  const colorImageMap = skuModel ? build1688ColorImageMap(skuModel) : new Map();
  return asArray(items).map((item) => {
    const colorRaw = decodeSkuPart(item?.color);
    const sizeRaw = decodeSkuPart(item?.size);
    const pair = colorRaw && colorRaw === sizeRaw && colorRaw.includes('>') ? colorRaw : '';
    if (!pair) return item;
    const parts = pair.split('>').map((x) => decodeSkuPart(x)).filter(Boolean);
    const color = parts[0] || '';
    const size = parts[1] || '';
    return {
      ...item,
      color,
      size,
      mainImage: item.mainImage || colorImageMap.get(color) || fallback1688MainImages(root)[0] || '',
    };
  });
}

export function skuRowsFromStandardItems(items) {
  const children = items.map((x, i) => ({
    父子关系: 'child',
    平台SKU: x.skuId || '',
    颜色: x.color || '',
    尺码: x.size || '',
    库存: x.stock || '',
    价格: x.price || '',
    主图: x.mainImage || '',
    __color_ix: i,
  }));
  return [{ 父子关系: 'parent' }, ...children];
}

export function skuAxesFromStandardItems(items) {
  const colors = [];
  const sizes = [];
  const mains = [];
  const colorIndex = new Map();
  for (const item of items) {
    const c = cleanString(item.color);
    if (c && !colorIndex.has(c)) {
      colorIndex.set(c, colors.length);
      colors.push(c);
      mains.push(cleanString(item.mainImage));
    } else if (c) {
      const ix = colorIndex.get(c);
      if (ix != null && !mains[ix] && item.mainImage) mains[ix] = cleanString(item.mainImage);
    }
    const s = cleanString(item.size);
    if (s && !sizes.includes(s)) sizes.push(s);
  }
  return colors.length || sizes.length ? { colors, sizes, mains } : null;
}

function extractBalancedAt(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    if (ch === close) depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function jsonCandidatesFromScript(textRaw, keywordsRaw) {
  const text = cleanString(textRaw);
  if (!text) return [];
  const keywords = asArray(keywordsRaw).map(cleanString).filter(Boolean);
  if (keywords.length && !keywords.some((k) => text.includes(k))) return [];
  const out = [];
  try {
    out.push({ path: 'script', value: JSON.parse(text) });
  } catch {
    // continue
  }
  const starts = new Set();
  for (const kw of keywords.length ? keywords : ['sku']) {
    let pos = text.indexOf(kw);
    while (pos !== -1 && starts.size < 80) {
      const from = Math.max(0, pos - 2500);
      const chunk = text.slice(from, pos + 2500);
      const localStarts = [];
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '{' || chunk[i] === '[') localStarts.push(from + i);
      }
      localStarts.slice(-8).forEach((x) => starts.add(x));
      pos = text.indexOf(kw, pos + kw.length);
    }
  }
  for (const start of starts) {
    const s = extractBalancedAt(text, start);
    if (!s || s.length < 2) continue;
    try {
      out.push({ path: `script@${start}`, value: JSON.parse(s) });
    } catch {
      // ignore non-JSON JS object snippets
    }
  }
  return out;
}

function missStats(items) {
  const fields = ['skuId', 'color', 'size', 'stock', 'price', 'mainImage'];
  return Object.fromEntries(fields.map((f) => [f, items.filter((x) => !cleanString(x[f])).length]));
}

function sourcePriorityForSkuDetect(source) {
  const p = cleanString(source?.path).toLowerCase();
  if (p.includes('datajson') && !p.endsWith('skumodel') && !p.includes('skumodel.')) return 0;
  if (p === 'window.context' || p.endsWith('.context') || p.includes('window.context')) return 1;
  if (p.includes('skumodel')) return 3;
  return 2;
}

function sortSkuDetectSources(sources) {
  return asArray(sources)
    .map((source, ix) => ({ source, ix }))
    .sort((a, b) => sourcePriorityForSkuDetect(a.source) - sourcePriorityForSkuDetect(b.source) || a.ix - b.ix)
    .map((x) => x.source);
}

export function detectSkuFromSources({ rules, host, platform, windowValues = [], scriptTexts = [], jsonValues = [] }) {
  const candidates = matchSkuDetectRules(rules, host, platform);
  const attempts = [];
  for (const rule of candidates) {
    const sources = [];
    for (const v of asArray(jsonValues)) {
      sources.push({ source: v.source || 'json', path: v.path || 'input', value: v.value ?? v });
    }
    for (const v of asArray(windowValues)) {
      sources.push({ source: 'window', path: v.path || 'window', value: v.value });
    }
    for (const text of asArray(scriptTexts)) {
      for (const c of jsonCandidatesFromScript(text, rule.scriptKeywords)) {
        sources.push({ source: 'script', path: c.path, value: c.value });
      }
    }
    let pending1688 = null;
    for (const source of sortSkuDetectSources(sources)) {
      const items1688 = parse1688SkuModelItems(source.value);
      if (items1688 && items1688.length) {
        const legacyMeta = build1688LegacyProductMeta(source.value);
        attempts.push({
          rule: rule.name,
          source: source.source,
          path: source.path,
          strategy: '1688-skuModel',
          rawCount: items1688.length,
        });
        const out = {
          ok: true,
          rule,
          source: source.source,
          path: `${source.path}.skuModel`,
          rawCount: items1688.length,
          items: items1688,
          rows: skuRowsFromStandardItems(items1688),
          sku_axes: legacyMeta
            ? { colors: legacyMeta.colors, sizes: legacyMeta.sizes, mains: legacyMeta.mains }
            : skuAxesFromStandardItems(items1688),
          legacyProductMeta: legacyMeta,
          missing: missStats(items1688),
          attempts,
        };
        if (items1688.some((x) => cleanString(x.mainImage))) return out;
        if (!pending1688) pending1688 = out;
        continue;
      }
      const arrays = findSkuArrays(source.value, rule);
      attempts.push({ rule: rule.name, source: source.source, path: source.path, arrayHits: arrays.length });
      if (!arrays.length) continue;
      const best = arrays[0];
      const items = normalizeSpecPairItems(standardizeSkuItems(best.value, rule), source.value);
      if (!items.length) continue;
      return {
        ok: true,
        rule,
        source: source.source,
        path: [source.path, best.path].filter(Boolean).join('.'),
        rawCount: best.value.length,
        items,
        rows: skuRowsFromStandardItems(items),
        sku_axes: skuAxesFromStandardItems(items),
        missing: missStats(items),
        attempts,
      };
    }
    if (pending1688) return pending1688;
  }
  return { ok: false, error: '未识别到 SKU 数组', attempts, matchedRules: candidates.map((r) => r.name) };
}
