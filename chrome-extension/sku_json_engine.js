(function () {
  if (window.__skuJsonDetectEngineLoaded) return;
  window.__skuJsonDetectEngineLoaded = true;
  const SKU_JSON_DEBUG = false;
  function debugLog(...args) {
    if (SKU_JSON_DEBUG) console.log(...args);
  }

  function str(v) {
    return String(v == null ? '' : v).trim();
  }
  function parseJsonStringIfNeeded(v) {
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (!s || !/^[\[{]/.test(s)) return v;
    try { return JSON.parse(s); } catch (_) { return v; }
  }
  function decodeSkuPart(v) {
    return str(v)
      .replace(/&gt;/gi, '>')
      .replace(/&lt;/gi, '<')
      .replace(/&amp;/gi, '&')
      .replace(/&#62;/g, '>')
      .replace(/&#60;/g, '<');
  }
  function arr(v) {
    return Array.isArray(v) ? v : [];
  }
  function normalizeRule(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const ad = r.arrayDetectRules && typeof r.arrayDetectRules === 'object' ? r.arrayDetectRules : {};
    return {
      id: r.id,
      name: str(r.name || '未命名规则'),
      platform: str(r.platform || 'universal'),
      matchHost: arr(r.matchHost).map(str).filter(Boolean),
      enabled: r.enabled !== false,
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
      windowPaths: arr(r.windowPaths).map(str).filter(Boolean),
      scriptKeywords: arr(r.scriptKeywords).map(str).filter(Boolean),
      arrayDetectRules: {
        requiredAnyKeys: arr(ad.requiredAnyKeys).map(str).filter(Boolean),
        optionalKeys: arr(ad.optionalKeys).map(str).filter(Boolean),
        minItemCount: Math.max(1, Number(ad.minItemCount || 1)),
        maxDepth: Math.max(1, Math.min(16, Number(ad.maxDepth || 6))),
      },
      fieldMapping:
        r.fieldMapping && typeof r.fieldMapping === 'object' && !Array.isArray(r.fieldMapping)
          ? r.fieldMapping
          : {},
    };
  }
  function hostMatches(hostRaw, rule) {
    const host = str(hostRaw).toLowerCase();
    return arr(rule.matchHost).some((p0) => {
      const p = str(p0).toLowerCase();
      return p === '*' || host === p || host.endsWith('.' + p) || host.includes(p);
    });
  }
  function getSkuJsonBridgeRoot() {
    try {
      const el = document.getElementById('__ai_sku_json_bridge__');
      if (!el) return null;
      const raw = str(el.textContent || el.getAttribute('data-json') || '');
      if (!raw) return null;
      const parsed = parseJsonStringIfNeeded(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  function walkPath(root, parts) {
    let cur = root;
    for (const part of parts) {
      if (cur == null) return undefined;
      cur = cur[part];
    }
    return cur;
  }
  function matchRules(rules, host, platform) {
    const p = str(platform).toLowerCase();
    return arr(rules)
      .map(normalizeRule)
      .filter((r) => r.enabled && hostMatches(host, r))
      .sort((a, b) => {
        const ap = p && str(a.platform).toLowerCase().includes(p) ? 0 : 1;
        const bp = p && str(b.platform).toLowerCase().includes(p) ? 0 : 1;
        return ap - bp || a.priority - b.priority || a.name.localeCompare(b.name);
      });
  }
  function safeWindowPath(path) {
    const p = str(path).replace(/^window\./, '');
    if (!p || /[^a-zA-Z0-9_$.[\]'"]/i.test(p)) return undefined;
    const parts = p
      .replace(/\[(?:'([^']+)'|"([^"]+)"|([^\]]+))\]/g, '.$1$2$3')
      .split('.')
      .map(str)
      .filter(Boolean);
    const direct = walkPath(window, parts);
    if (direct !== undefined) return direct;
    const bridge = getSkuJsonBridgeRoot();
    if (bridge) {
      const bridged = walkPath(bridge, parts);
      if (bridged !== undefined) return bridged;
    }
    return undefined;
  }
  function keySet(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return new Set();
    return new Set(Object.keys(obj).map((k) => k.toLowerCase()));
  }
  function hasAnyKey(obj, keys) {
    const ks = keySet(obj);
    return arr(keys).some((k) => ks.has(str(k).toLowerCase()));
  }
  function scoreItem(obj, rule) {
    let score = 0;
    const rd = rule.arrayDetectRules || {};
    if (hasAnyKey(obj, rd.requiredAnyKeys)) score += 5;
    for (const k of arr(rd.optionalKeys)) {
      if (hasAnyKey(obj, [k])) score += 1;
    }
    return score;
  }
  function isSkuLikeArray(value, rule) {
    if (!Array.isArray(value)) return false;
    const min = Math.max(1, Number(rule.arrayDetectRules?.minItemCount || 1));
    if (value.length < min) return false;
    return value.some((x) => x && typeof x === 'object' && !Array.isArray(x) && scoreItem(x, rule) >= 5);
  }
  function findSkuArrays(root, rule) {
    const found = [];
    const maxDepth = Math.max(1, Number(rule.arrayDetectRules?.maxDepth || 6));
    const seen = new WeakSet();
    function walk(node, path, depth) {
      if (!node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (isSkuLikeArray(node, rule)) {
          found.push({ path, value: node, score: node.reduce((sum, x) => sum + scoreItem(x, rule), 0) });
        }
        if (depth >= maxDepth) return;
        node.slice(0, 30).forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1));
        return;
      }
      if (depth >= maxDepth) return;
      for (const k of Object.keys(node)) {
        walk(node[k], path ? path + '.' + k : k, depth + 1);
      }
    }
    walk(root, '', 0);
    return found.sort((a, b) => b.score - a.score || b.value.length - a.value.length);
  }
  function directValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    const entries = Object.entries(obj);
    for (const alias of arr(keys)) {
      const hit = entries.find(([k]) => k.toLowerCase() === str(alias).toLowerCase());
      if (hit) return hit[1];
    }
    return undefined;
  }
  function findValue(obj, keys, maxDepth) {
    const d = directValue(obj, keys);
    if (d !== undefined) return d;
    const seen = new WeakSet();
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > maxDepth) return undefined;
      if (seen.has(node)) return undefined;
      seen.add(node);
      const v = directValue(node, keys);
      if (v !== undefined) return v;
      const vals = Array.isArray(node) ? node.slice(0, 20) : Object.values(node);
      for (const child of vals) {
        const got = walk(child, depth + 1);
        if (got !== undefined) return got;
      }
      return undefined;
    }
    return walk(obj, 0);
  }
  function scalar(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return str(v);
    if (Array.isArray(v)) {
      return v
        .map((x) => {
          if (x == null) return '';
          if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return str(x);
          if (typeof x === 'object') return str(x.value || x.propertyValue || x.text || x.label || x.name || x.propName);
          return '';
        })
        .filter(Boolean)
        .join(' / ');
    }
    if (typeof v === 'object') return str(v.value || v.propertyValue || v.text || v.label || v.name || v.url || v.src);
    return '';
  }
  function imageScalar(v) {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return imageScalar(v.find(Boolean));
    if (v && typeof v === 'object') return str(v.url || v.src || v.imageUrl || v.picUrl || v.pic || v.image || v.fullPathImageURI || v.size310x310ImageURI || v.imageURI);
    return '';
  }
  function normalize1688ImageUrl(raw) {
    const s = str(raw);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    return 'https://cbu01.alicdn.com/' + s.replace(/^\/+/, '');
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
  
  function parse1688SkuModelItems(root) {
    const skuModel = get1688SkuModel(root);
  
    if (!skuModel || !skuModel.skuInfoMap || typeof skuModel.skuInfoMap !== 'object') {
      return null;
    }
  
    const colorImageMap = new Map();
  
    // =========================
    // 从 skuProps 提取颜色主图
    // =========================
    const props = arr(skuModel.skuProps);
  
    const colorProp = props.find((p) => {
      const name = decodeSkuPart(
        p?.prop ||
        p?.name ||
        p?.propertyName ||
        p?.title ||
        p?.label ||
        p?.propName
      );
  
      return (
        String(name).includes('颜色') ||
        String(name).toLowerCase().includes('color')
      );
    });
  
    if (colorProp) {
      const values = arr(
        colorProp.value ||
        colorProp.values ||
        colorProp.items ||
        colorProp.list
      );
  
      for (const v of values) {
        const colorName = decodeSkuPart(
          v?.name ||
          v?.value ||
          v?.text ||
          v?.label
        );
  
        const imageUrl = normalize1688ImageUrl(
          imageScalar(
            v?.imageUrl ||
            v?.imageURL ||
            v?.imgUrl ||
            v?.img ||
            v?.picUrl ||
            v?.pic ||
            v?.picture ||
            v?.fullPathImageURI ||
            v?.size310x310ImageURI ||
            v?.imageURI
          )
        );
  
        if (colorName && imageUrl) {
          colorImageMap.set(colorName, imageUrl);
        }
      }
    }
  
    debugLog('[1688] colorImageMap:', colorImageMap);
  
    const fallbackImages = fallback1688MainImages(root);
  
    const out = [];
  
    for (const [key, item] of Object.entries(skuModel.skuInfoMap)) {
  
      if (!item || typeof item !== 'object') continue;
  
      // 解析 specAttrs
      const rawSpec = decodeSkuPart(item.specAttrs || key);
  
      const parts = rawSpec
        .split('>')
        .map((x) => decodeSkuPart(x))
        .filter(Boolean);
  
      const color = parts[0] || '';
      const size = parts[1] || '';
  
      // 主图优先颜色图
      let mainImage =
        colorImageMap.get(color) ||
        fallbackImages[0] ||
        '';
  
      mainImage = normalize1688ImageUrl(mainImage);
  
      out.push({
        index: out.length,
        skuId: scalar(item.skuId),
        color,
        size,
        stock: scalar(item.canBookCount),
        price: scalar(item.price || item.discountPrice),
        mainImage,
        raw: item,
      });
    }
  
    debugLog('[1688] parsed sku items:', out);
  
    return out.length ? out : null;
  }

  function valueNameFrom1688SkuPropValue(v) {
    if (!v || typeof v !== 'object') return decodeSkuPart(v);
    return decodeSkuPart(v.name || v.value || v.text || v.label || v.propertyValue || v.valueName || v.propValue || v.skuValueName);
  }
  function build1688AxisValueSets(skuModel) {
    const props = arr(skuModel?.skuProps);
    const colorNames = new Set();
    const sizeNames = new Set();
    props.forEach((p, ix) => {
      const propName = decodeSkuPart(
        p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
      );
      const names = arr(p?.value || p?.values || p?.items || p?.list).map(valueNameFrom1688SkuPropValue).filter(Boolean);
      const isColor = propName === '颜色' || propName.toLowerCase() === 'color' || ix === 0;
      const isSize = propName === '尺码' || propName === '尺寸' || propName.toLowerCase() === 'size' || ix === 1;
      if (isColor) names.forEach((x) => colorNames.add(x));
      if (isSize) names.forEach((x) => sizeNames.add(x));
    });
    return { colorNames, sizeNames };
  }
  function build1688LegacyProductMeta(root) {
    const skuModel = get1688SkuModel(root);
    if (!skuModel) return null;
    const props = arr(skuModel.skuProps);
    const propNameOf = (p) =>
      decodeSkuPart(
        p?.prop || p?.propName || p?.name || p?.propertyName || p?.title || p?.label || p?.attributeName || p?.skuPropertyName
      );
    const colorProp = props.find((p) => {
      const name = propNameOf(p);
      return String(name || '').includes('颜色') || String(name || '').toLowerCase().includes('color');
    });
    try {
      debugLog('[1688 SKU] colorProp:', colorProp);
    } catch {
      // ignore
    }
    const sizeProp = props.find((p) => {
      const name = propNameOf(p);
      return String(name || '').includes('尺码') || String(name || '').includes('尺寸') || String(name || '').toLowerCase().includes('size');
    });
    const colors = [];
    const mains = [];
    const colorValues = arr(colorProp?.value || colorProp?.values || colorProp?.items || colorProp?.list);
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
    const sizes = arr(sizeProp?.value || sizeProp?.values || sizeProp?.items || sizeProp?.list)
      .map(valueNameFrom1688SkuPropValue)
      .filter(Boolean);
    try {
      debugLog('[1688 SKU] colors:', colors);
      debugLog('[1688 SKU] mainImages:', mains);
      debugLog('[1688 SKU] sizes:', sizes);
    } catch {
      // ignore
    }
    return { colors, sizes, mains };
  }
  function split1688SpecParts(raw, skuModel) {
    const parts = decodeSkuPart(raw).split('>').map((x) => decodeSkuPart(x)).filter(Boolean);
    if (parts.length <= 1) return { color: parts[0] || '', size: parts[1] || '' };
    const axes = build1688AxisValueSets(skuModel);
    const color = parts.find((p) => axes.colorNames.has(p)) || parts[0] || '';
    const size = parts.find((p) => axes.sizeNames.has(p) && p !== color) || parts.find((p) => p !== color) || parts[1] || '';
    return { color, size };
  }
  function normalizeGenericImageUrl(raw) {
    const s = str(raw);
    if (!s) return '';
    if (/^data:/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('/')) {
      try {
        return new URL(s, location.origin).toString();
      } catch {
        return s;
      }
    }
    // some sites provide domain paths without scheme
    if (/^[a-z0-9.-]+\.[a-z]{2,}\/+/i.test(s)) return 'https://' + s;
    return s;
  }

  // -------- AliExpress SKU 结构解析（SKU.skuPaths + skuProperties） --------
  function looksLikeAliExpressHost() {
    const h = str(location.host).toLowerCase();
    // 速卖通存在多 TLD（aliexpress.us / ru / fr ...），子串匹配最稳
    return h.includes('aliexpress');
  }
  function isAliExpressSkuCarrier(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj.skuProperties) && obj.skuProperties.length) return true;
    if (Array.isArray(obj.skuPaths) && obj.skuPaths.length) return true;
    if (obj.SKU && typeof obj.SKU === 'object' && Array.isArray(obj.SKU.skuPaths) && obj.SKU.skuPaths.length) return true;
    return false;
  }
  function findAliExpressSkuRoot(root) {
    const direct = parseJsonStringIfNeeded(root);
    if (!direct || typeof direct !== 'object') return null;
    const seen = new WeakSet();
    let propsHit = null;
    let pathsHit = null;

    function noteProps(value, path) {
      if (!propsHit && Array.isArray(value) && value.length) {
        propsHit = { value, path };
        try {
          debugLog('[AE SKU] found skuProperties path:', path);
          debugLog('[AE SKU FOUND]', path);
        } catch {}
      }
    }
    function notePaths(value, path) {
      if (!pathsHit && Array.isArray(value) && value.length) {
        pathsHit = { value, path };
        try {
          debugLog('[AE SKU] found skuPaths path:', path);
          debugLog('[AE SKU FOUND]', path);
        } catch {}
      }
    }
    function walk(cur, depth, path) {
      const node = parseJsonStringIfNeeded(cur);
      if (!node || typeof node !== 'object' || depth > 15) return null;
      if (seen.has(node)) return null;
      seen.add(node);

      noteProps(node.skuProperties, path ? path + '.skuProperties' : 'skuProperties');
      if (node.SKU && typeof node.SKU === 'object') {
        noteProps(node.SKU.skuProperties, path ? path + '.SKU.skuProperties' : 'SKU.skuProperties');
        notePaths(node.SKU.skuPaths, path ? path + '.SKU.skuPaths' : 'SKU.skuPaths');
      }
      notePaths(node.skuPaths, path ? path + '.skuPaths' : 'skuPaths');

      const nodeProps = Array.isArray(node.skuProperties)
        ? node.skuProperties
        : Array.isArray(node.SKU?.skuProperties)
          ? node.SKU.skuProperties
          : null;
      const nodePaths = Array.isArray(node.SKU?.skuPaths)
        ? node.SKU.skuPaths
        : Array.isArray(node.skuPaths)
          ? node.skuPaths
          : null;
      if (nodeProps && nodeProps.length && nodePaths && nodePaths.length) {
        return {
          node,
          skuProperties: nodeProps,
          skuPaths: nodePaths,
          skuPropertiesPath: Array.isArray(node.skuProperties)
            ? (path ? path + '.skuProperties' : 'skuProperties')
            : (path ? path + '.SKU.skuProperties' : 'SKU.skuProperties'),
          skuPathsPath: Array.isArray(node.SKU?.skuPaths)
            ? (path ? path + '.SKU.skuPaths' : 'SKU.skuPaths')
            : (path ? path + '.skuPaths' : 'skuPaths'),
        };
      }

      const entries = Array.isArray(node)
        ? node.slice(0, 120).map((v, i) => [String(i), v])
        : Object.entries(node);
      for (const [k, child] of entries) {
        const childPath = path ? (Array.isArray(node) ? `${path}[${k}]` : `${path}.${k}`) : (Array.isArray(node) ? `[${k}]` : k);
        const got = walk(child, depth + 1, childPath);
        if (got) return got;
      }
      return null;
    }

    const sameRoot = walk(direct, 0, '');
    if (sameRoot) return sameRoot;
    if (propsHit && pathsHit) {
      return {
        node: { skuProperties: propsHit.value, SKU: { skuPaths: pathsHit.value } },
        skuProperties: propsHit.value,
        skuPaths: pathsHit.value,
        skuPropertiesPath: propsHit.path,
        skuPathsPath: pathsHit.path,
      };
    }
    return null;
  }
  function parseAliExpressSku(root) {
    const parsedRoot = typeof root === 'string' ? (extractAliExpressJsonFromText(root) || parseJsonStringIfNeeded(root)) : root;
    const found = findAliExpressSkuRoot(parsedRoot);
    if (!found) return null;
    const skuPaths = arr(found.skuPaths);
    const skuProperties = arr(found.skuProperties);
    if (!skuPaths.length || !skuProperties.length) return null;
    try {
      debugLog('[AE SKU] skuProperties count:', skuProperties.length);
      debugLog('[AE SKU] skuPaths count:', skuPaths.length);
    } catch {
      // ignore
    }

    // 一、建立属性映射 propMap：`${skuPropertyId}:${propertyValueIdLong}` -> { type,value,image }
    /** @type {Record<string, { type:string; value:string; image:string }>} */
    const propMap = {};
    for (const prop of skuProperties) {
      if (!prop || typeof prop !== 'object') continue;
      const skuPropertyId = scalar(prop.skuPropertyId || prop.propertyId || prop.id);
      const skuPropertyName = scalar(prop.skuPropertyName || prop.propertyName || prop.name);
      const type = skuPropertyName || scalar(prop.type || prop.skuPropertyType) || '';
      const values = arr(prop.skuPropertyValues || prop.values || prop.propertyValues);
      for (const v of values) {
        if (!v || typeof v !== 'object') continue;
        const propertyValueIdLong = scalar(
          v.propertyValueIdLong || v.propertyValueId || v.propertyValueIdLongStr || v.valueId || v.id
        );
        if (!skuPropertyId || !propertyValueIdLong) continue;
        const displayName = scalar(
          v.propertyValueName ||
            v.propertyValueDisplayName ||
            v.propertyValueDefinitionName ||
            v.displayName ||
            v.name ||
            v.value
        );
        const image = normalizeGenericImageUrl(
          imageScalar(v.skuPropertyImagePath || v.skuPropertyImageSummPath || v.skuPropertyImage || v.imageUrl || v.image || v.img || v.pic)
        );
        const key = `${skuPropertyId}:${propertyValueIdLong}`;
        propMap[key] = { type, value: displayName, image };
      }
    }

    // 二、遍历 skuPaths：解析 path -> 从 propMap 映射 颜色/尺码/主图
    const out = [];
    for (const p0 of skuPaths) {
      const p = p0 && typeof p0 === 'object' ? p0 : {};
      const skuId = scalar(p.skuId || p.skuIdStr || p.sku_id || p.id);
      const stock = scalar(p.skuStock || p.stock || p.inventory || p.quantity);
      const price = scalar(p.price || p.discountPrice || p.skuPrice || p.salePrice);
      const rawPath = scalar(p.path || p.skuAttr || p.skuAttrPath || p.skuAttrValueIds);
      if (!rawPath) continue;
      const pairs = rawPath
        .split(';')
        .map((x) => {
          const s = str(x).trim();
          const h = s.indexOf('#');
          return h >= 0 ? s.slice(0, h).trim() : s;
        })
        .filter(Boolean);

      let color = '';
      let size = '';
      let mainImage = '';
      for (const pair of pairs) {
        const hit = propMap[pair];
        if (!hit) continue;
        const t = str(hit.type).toLowerCase();
        const val = str(hit.value);
        const img = str(hit.image);
        if (!color && (t.includes('color') || String(hit.type).includes('颜色'))) {
          color = val;
          if (img) mainImage = img;
          continue;
        }
        if (!size && (t.includes('size') || String(hit.type).includes('尺码') || String(hit.type).includes('尺寸'))) {
          size = val;
          continue;
        }
      }
      // 兜底：没有明确 type 时，按出现顺序兜底第一个=颜色，第二个=尺码
      if (!color && pairs[0] && propMap[pairs[0]]) {
        color = str(propMap[pairs[0]].value);
        if (!mainImage) mainImage = str(propMap[pairs[0]].image);
      }
      if (!size && pairs[1] && propMap[pairs[1]]) size = str(propMap[pairs[1]].value);

      out.push({
        index: out.length,
        skuId,
        color,
        size,
        stock,
        price,
        mainImage: normalizeGenericImageUrl(mainImage),
        raw: p0,
      });
    }
    const useful = out.filter((x) => x.color || x.size || x.mainImage);
    try {
      const axes = axesFromItems(useful);
      debugLog('[AE SKU] parsed colors:', axes?.colors || []);
      debugLog('[AE SKU] parsed sizes:', axes?.sizes || []);
      debugLog('[AE SKU] parsed mains:', axes?.mains || []);
    } catch {
      // ignore
    }
    return useful.length ? useful : null;
  }
  function parseAliExpressMtopSkuData(root) {
    const data = typeof root === 'string' ? parseJsonStringIfNeeded(root) : root;
    if (!data || typeof data !== 'object' || data.platform !== 'aliexpress' || !Array.isArray(data.skuList)) return null;
    const props = arr(data.skuProperties);
    const firstProp = props[0] || {};
    const secondProp = props[1] || {};
    const valueImageByName = new Map();
    for (const prop of props) {
      for (const v of arr(prop.values)) {
        const name = str(v?.name);
        const img = normalizeGenericImageUrl(v?.image);
        if (name && img && !valueImageByName.has(name)) valueImageByName.set(name, img);
      }
    }
    const items = arr(data.skuList)
      .map((sku, index) => {
        if (!sku || typeof sku !== 'object') return null;
        const attrs = sku.attrs && typeof sku.attrs === 'object' && !Array.isArray(sku.attrs) ? sku.attrs : {};
        const firstName = str(firstProp.name);
        const secondName = str(secondProp.name);
        const attrKeys = Object.keys(attrs);
        const color =
          (firstName ? str(attrs[firstName]) : '') ||
          str(attrs.Color || attrs.color || attrs['颜色'] || attrs[attrKeys[0]]);
        const size =
          (secondName ? str(attrs[secondName]) : '') ||
          str(attrs.Size || attrs.size || attrs['尺码'] || attrs['尺寸'] || attrs[attrKeys.find((k) => str(attrs[k]) !== color)]);
        const img = normalizeGenericImageUrl(sku.image || valueImageByName.get(color) || '');
        return {
          index,
          skuId: scalar(sku.skuId),
          color,
          size,
          stock: scalar(sku.stock),
          price: scalar(sku.salePrice || sku.price),
          mainImage: img,
          raw: sku.raw || sku,
        };
      })
      .filter(Boolean);
    const useful = items.filter((x) => x.skuId || x.color || x.size || x.mainImage || x.price || x.stock);
    try {
      const dbg = data._debug || {};
      debugLog('[AE SKU] mtop api hit:', data.rawSource?.api || '');
      debugLog('[AE SKU] JSONP parsed:', dbg.jsonpParsed !== false);
      debugLog('[AE SKU] extracted skuId count:', useful.filter((x) => x.skuId).length);
      debugLog('[AE SKU] has skuImagesMap:', !!dbg.hasSkuImagesMap);
      debugLog('[AE SKU] has skuPriceList:', !!dbg.hasSkuPriceList);
      debugLog('[AE SKU] has skuPropertyList:', !!dbg.hasSkuPropertyList);
    } catch {
      // ignore
    }
    return useful.length ? useful : null;
  }
  function standardize(items, rule) {
    const fm = rule.fieldMapping || {};
    return arr(items)
      .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
      .map((item, idx) => ({
        index: idx,
        skuId: scalar(findValue(item, fm.skuId || [], 3)),
        color: scalar(findValue(item, fm.color || [], 3)),
        size: scalar(findValue(item, fm.size || [], 3)),
        stock: scalar(findValue(item, fm.stock || [], 3)),
        price: scalar(findValue(item, fm.price || [], 3)),
        mainImage: normalizeGenericImageUrl(imageScalar(findValue(item, fm.mainImage || [], 3))),
      }));
  }
  function colorImageMapFromRoot(root) {
    const skuModel = get1688SkuModel(root);
    const map = new Map();
    if (!skuModel) return map;
    const props = arr(skuModel.skuProps);
    const colorProps = props.filter((p) => {
      const name = decodeSkuPart(
        p?.prop || p?.name || p?.propertyName || p?.title || p?.label || p?.propName || p?.attributeName || p?.skuPropertyName
      );
      return String(name || '').includes('颜色') || String(name || '').toLowerCase().includes('color');
    });
    function addValues(values) {
      for (const v of arr(values)) {
        if (!v || typeof v !== 'object') continue;
        const name = decodeSkuPart(v.name || v.value || v.text || v.label || v.propertyValue || v.valueName || v.propValue || v.skuValueName);
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
      for (const img of arr(dataJson.images)) push(imageUrlFrom1688ImageObj(img));
      const gallery = dataJson.gallery?.fields || dataJson.gallery || {};
      for (const img of arr(gallery.offerImgList)) push(imageUrlFrom1688ImageObj(img));
      push(imageUrlFrom1688ImageObj(gallery.mainImage || dataJson.mainImage));
    }
    return out;
  }
  function normalizeSpecPairItems(items, root) {
    const colorImageMap = colorImageMapFromRoot(root);
    return arr(items).map((item) => {
      const normalizedMainImage = normalizeGenericImageUrl(item?.mainImage);
      const colorRaw = decodeSkuPart(item?.color);
      const sizeRaw = decodeSkuPart(item?.size);
      const pair = colorRaw && colorRaw === sizeRaw && colorRaw.includes('>') ? colorRaw : '';
      if (!pair) return { ...item, mainImage: normalizedMainImage };
      const parts = pair.split('>').map((x) => decodeSkuPart(x)).filter(Boolean);
      const color = parts[0] || '';
      const size = parts[1] || '';
      return {
        ...item,
        color,
        size,
        mainImage:
          normalizedMainImage ||
          colorImageMap.get(color) ||
          fallback1688MainImages(root)[0] ||
          '',
      };
    });
  }
  function rowsFromItems(items) {
    return [
      { 父子关系: 'parent' },
      ...items.map((x, i) => ({
        父子关系: 'child',
        平台SKU: x.skuId || '',
        颜色: x.color || '',
        尺码: x.size || '',
        库存: x.stock || '',
        价格: '',
        主图: x.mainImage || '',
        __color_ix: i,
      })),
    ];
  }
  function axesFromItems(items) {
    const colors = [];
    const sizes = [];
    const mains = [];
    const byColor = new Map();
    for (const item of items) {
      const c = str(item.color);
      if (c && !byColor.has(c)) {
        byColor.set(c, colors.length);
        colors.push(c);
        mains.push(str(item.mainImage));
      } else if (c) {
        const ix = byColor.get(c);
        if (ix != null && !mains[ix] && item.mainImage) mains[ix] = str(item.mainImage);
      }
      const s = str(item.size);
      if (s && !sizes.includes(s)) sizes.push(s);
    }
    return colors.length || sizes.length ? { colors, sizes, mains } : null;
  }
  function extractBalancedAt(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : open === '[' ? ']' : '';
    if (!close) return null;
    let depth = 0, inStr = false, quote = '', esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true; quote = ch; continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }
  function tryJsonParseCandidate(raw) {
    const s = str(raw);
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  function pushJsonCandidate(out, path, jsonText) {
    const parsed = tryJsonParseCandidate(jsonText);
    if (parsed && typeof parsed === 'object') out.push({ path, value: parsed });
  }
  function parseJsonp(textRaw) {
    const text = str(textRaw);
    if (!text) return null;
    const direct = tryJsonParseCandidate(text);
    if (direct && typeof direct === 'object') return direct;
    const first = text.indexOf('(');
    const last = text.lastIndexOf(')');
    if (first < 0 || last <= first) return null;
    return tryJsonParseCandidate(text.slice(first + 1, last));
  }
  function extractAliExpressJsonFromText(textRaw) {
    const text = str(textRaw);
    if (!text || !text.includes('skuProperties')) return null;
    const jsonp = parseJsonp(text);
    if (jsonp && typeof jsonp === 'object') {
      if (isAliExpressSkuCarrier(jsonp) || findAliExpressSkuRoot(jsonp)) return jsonp;
    }
    const anchors = [];
    for (const kw of ['skuProperties', 'skuPaths']) {
      let pos = text.indexOf(kw);
      while (pos !== -1 && anchors.length < 20) {
        anchors.push({ kw, pos });
        pos = text.indexOf(kw, pos + kw.length);
      }
    }
    const tried = new Set();
    for (const anchor of anchors) {
      let cursor = anchor.pos;
      let attempts = 0;
      while (cursor >= 0 && attempts < 100) {
        const start = text.lastIndexOf('{', cursor);
        if (start < 0) break;
        cursor = start - 1;
        attempts += 1;
        if (tried.has(start)) continue;
        tried.add(start);
        const jsonText = extractBalancedAt(text, start);
        if (!jsonText) continue;
        const parsed = tryJsonParseCandidate(jsonText);
        if (parsed && typeof parsed === 'object' && isAliExpressSkuCarrier(parsed)) return parsed;
        const found = parsed && typeof parsed === 'object' ? findAliExpressSkuRoot(parsed) : null;
        if (found) return parsed;
      }
    }
    return null;
  }
  function aliExpressLegacyRowsFromItems(items) {
    const colors = [];
    const sizes = [];
    const mains = [];
    const colorToImage = new Map();
    for (const item of arr(items)) {
      const color = str(item?.color);
      const size = str(item?.size);
      const img = str(item?.mainImage);
      if (color && !colors.includes(color)) colors.push(color);
      if (size && !sizes.includes(size)) sizes.push(size);
      if (color && img && !colorToImage.has(color)) colorToImage.set(color, img);
    }
    for (const color of colors) {
      const img = str(colorToImage.get(color) || '');
      if (img && !mains.includes(img)) mains.push(img);
    }
    const row = {
      标题: '',
      颜色: colors,
      尺码: sizes,
      主图: mains,
      副图: [],
      描述: [],
      详情: '',
      详情图: [],
      价格: '',
    };
    try {
      debugLog('[AE SKU] final rows[0].主图:', row.主图);
    } catch {
      // ignore
    }
    return [row];
  }
  function extractJsonNearKeywords(text, keywordPairs) {
    const t = str(text);
    if (!t) return [];
    const out = [];
    const lower = t.toLowerCase();
    const pairs = Array.isArray(keywordPairs) && keywordPairs.length ? keywordPairs : [['skuproperties', 'skupaths']];
    for (const pair of pairs) {
      const a = str(pair?.[0]).toLowerCase();
      const b = str(pair?.[1]).toLowerCase();
      if (!a || !b) continue;
      const hasA = lower.includes(a);
      const hasB = lower.includes(b);
      if (!hasA || !hasB) continue;
      // 从关键词附近向前找最近的 '{' 或 '['，截取完整对象/数组
      const hit = lower.indexOf(a);
      const from = Math.max(0, hit - 80_000);
      const region = t.slice(from, Math.min(t.length, hit + 80_000));
      const regionLower = region.toLowerCase();
      const anchor = regionLower.indexOf(a);
      const absAnchor = from + Math.max(0, anchor);
      // 向前找 '{' 或 '['
      const backWindowStart = Math.max(0, absAnchor - 120_000);
      const back = t.slice(backWindowStart, absAnchor + 1);
      let bracePos = -1;
      for (let i = back.length - 1; i >= 0; i--) {
        const ch = back[i];
        if (ch === '{' || ch === '[') {
          bracePos = backWindowStart + i;
          break;
        }
      }
      if (bracePos >= 0) {
        const jsonText = extractBalancedAt(t, bracePos);
        if (jsonText) pushJsonCandidate(out, `script@kw${bracePos}`, jsonText);
      }
    }
    return out;
  }
  function candidatesFromScript(textRaw, keywords) {
    const text = str(textRaw);
    if (!text) return [];
    const kws = arr(keywords).map(str).filter(Boolean);
    const textLower = text.toLowerCase();
    const kwsLower = kws.map((k) => String(k).toLowerCase());
    // 关键词过滤：用大小写不敏感匹配（AliExpress 常见 SKU / selectedSkuId 等大小写混用）
    if (kwsLower.length && !kwsLower.some((k) => textLower.includes(k))) return [];
    const out = [];
    // 不要依赖 JSON.parse 整段脚本（通常包含 JS 语法）；只把“可直接 parse 的 JSON”当作额外兜底
    try { out.push({ path: 'script', value: JSON.parse(text) }); } catch (_) {}

    // 支持从常见包裹结构中提取对象/数组：
    // - window.__xxx = {...}
    // - var x = {...}
    // - mtopjsonp123({...})
    // - callback([...])
    // 注意：这里只做“提取并 JSON.parse”的尝试，失败就跳过。
    const wrapperStarts = [];
    try {
      const re = /(?:=|\()\s*([\[{])/g;
      let m;
      while ((m = re.exec(text)) && wrapperStarts.length < 80) {
        // m.index points to start of match; group[1] is "{" or "["
        const idx = m.index + m[0].length - 1;
        if (idx >= 0) wrapperStarts.push(idx);
      }
    } catch {
      // ignore
    }
    for (const start of wrapperStarts) {
      const s = extractBalancedAt(text, start);
      if (!s) continue;
      pushJsonCandidate(out, 'script@wrap' + start, s);
    }

    // AliExpress/大 JSON：若脚本文本同时包含 skuProperties + skuPaths，直接从关键词附近抽取最近 JSON 对象
    try {
      const extra = extractJsonNearKeywords(text, [['skuProperties', 'skuPaths']]);
      for (const c of extra) out.push(c);
    } catch {
      // ignore
    }

    const starts = new Set();
    for (const kw of kwsLower.length ? kwsLower : ['sku']) {
      let pos = textLower.indexOf(kw);
      while (pos !== -1 && starts.size < 80) {
        // 关键词附近截取更大的窗口（速卖通脚本对象较大，2500 可能截不全）
        const from = Math.max(0, pos - 9000);
        const chunk = text.slice(from, pos + 9000);
        const local = [];
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === '{' || chunk[i] === '[') local.push(from + i);
        // 多取一些起点，避免对象开头离关键词较远
        local.slice(-24).forEach((x) => starts.add(x));
        pos = textLower.indexOf(kw, pos + kw.length);
      }
    }
    for (const start of starts) {
      const s = extractBalancedAt(text, start);
      if (!s) continue;
      pushJsonCandidate(out, 'script@' + start, s);
    }
    return out;
  }
  function sourcePriority(source) {
    const p = str(source?.path).toLowerCase();
    if (p.includes('.normalized') || p.includes('__aliexpressmtopskudata')) return -2;
    if (p.includes('datajson') && !p.endsWith('skumodel') && !p.includes('skumodel.')) return 0;
    if (p === 'window.context' || p.endsWith('.context') || p.includes('window.context')) return 1;
    if (p.includes('skumodel')) return 3;
    return 2;
  }
  function sortSources(sources) {
    return arr(sources)
      .map((source, ix) => ({ source, ix }))
      .sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source) || a.ix - b.ix)
      .map((x) => x.source);
  }
  function looksLike1688Host() {
    const h = str(location.host).toLowerCase();
    return h.includes('1688.com') || h.includes('alibaba.com') || h.includes('cbu');
  }
  function best1688RootFromWindow() {
    // 优先从 bridge/windowPaths 取含 skuProps 的 dataJson；在某些页面脚本片段只含 skuMapOriginal（无图）
    const paths = [
      'window.context.result.data.Root.fields.dataJson',
      'window.context',
      'window.context.result.data.Root.fields.dataJson.skuModel',
      'window.__INITIAL_STATE__',
      'window.runParams',
    ];
    for (const p of paths) {
      const v = safeWindowPath(p);
      if (v && typeof v === 'object') return v;
      const parsed = parseJsonStringIfNeeded(v);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    return null;
  }
  function parse1688ColorFromItem(item) {
    const raw =
      item && typeof item === 'object'
        ? item.color || item.sku || item.spec || item.specAttrs || item.attributes || ''
        : '';
    const decoded = decodeSkuPart(raw);
    if (!decoded) return '';
    const parts = String(decoded).split('>').map((x) => decodeSkuPart(x)).filter(Boolean);
    return parts[0] || String(decoded).trim();
  }
  function enrich1688MainImagesIfMissing(items) {
    if (!looksLike1688Host()) return items;
    const list = arr(items);
    if (!list.length) return items;
    if (list.every((x) => str(x?.mainImage))) return items;
    const root = best1688RootFromWindow();
    if (!root) return items;
    const colorMap = colorImageMapFromRoot(root);
    const fallback = fallback1688MainImages(root);
    const fallbackFirst = fallback && fallback.length ? str(fallback[0]) : '';
    return list.map((it) => {
      const existing = str(it?.mainImage);
      if (existing) return it;
      const color = parse1688ColorFromItem(it);
      const fromColor = color ? str(colorMap.get(color) || '') : '';
      const next = normalize1688ImageUrl(fromColor || fallbackFirst || '');
      return next ? { ...it, mainImage: next } : it;
    });
  }
  function buildAliExpressDetectResult(rule, source, items, attempts) {
    const axes = axesFromItems(items) || { colors: [], sizes: [], mains: [] };
    const rows = aliExpressLegacyRowsFromItems(items);
    attempts.push({
      rule: rule.name,
      source: source.source,
      path: source.path,
      strategy: 'aliexpress-skuPaths',
      rawCount: items.length,
    });
    return {
      ok: true,
      ruleName: rule.name,
      ruleId: rule.id,
      source: source.source,
      path: source.path,
      rawCount: items.length,
      rows,
      sku_axes: axes,
      legacyProductRows: true,
      preview: items.slice(0, 10),
      attempts,
    };
  }
  function aliExpressBridgeSources() {
    const out = [];
    const bridge = getSkuJsonBridgeRoot();
    if (bridge && typeof bridge === 'object') {
      out.push({ source: 'bridge', path: '__ai_sku_json_bridge__', value: bridge });
      if (bridge.__aliExpressMtopSkuData && typeof bridge.__aliExpressMtopSkuData === 'object') {
        out.push({
          source: 'mtop',
          path: '__ai_sku_json_bridge__.__aliExpressMtopSkuData',
          url: bridge.__aliExpressMtopSkuData.rawSource?.url || '',
          value: bridge.__aliExpressMtopSkuData,
        });
      }
      const responses = arr(bridge.__jsonCapturedResponses || bridge.__JSON_CAPTURED_RESPONSES__);
      responses.slice(-80).forEach((x, i) => {
        if (!x || typeof x !== 'object') return;
        const norm = x.normalized;
        if (norm && typeof norm === 'object' && norm.platform === 'aliexpress') {
          out.push({
            source: 'mtop-normalized',
            path: `__jsonCapturedResponses[${i}].normalized`,
            url: x.url || '',
            value: norm,
          });
        }
        out.push({
          source: x.type || 'response',
          path: x.url ? `__JSON_CAPTURED_RESPONSES__[${i}]:${x.url}` : `__JSON_CAPTURED_RESPONSES__[${i}]`,
          url: x.url || '',
          value: x.text || '',
        });
      });
      const caches = arr(bridge.__aeTextCache || bridge.aeTextCache);
      caches.slice(0, 20).forEach((x, i) => {
        if (typeof x === 'string') {
          out.push({ source: 'xhr-cache', path: `bridge.__aeTextCache[${i}]`, value: x });
        } else if (x && typeof x === 'object') {
          out.push({
            source: 'xhr-cache',
            path: x.url ? `bridge.__aeTextCache[${i}]:${x.url}` : `bridge.__aeTextCache[${i}]`,
            value: x.text || x.body || '',
          });
        }
      });
      const netSnaps = arr(bridge.__networkSkuSnapshots);
      netSnaps.slice(-35).forEach((snap, i) => {
        if (!snap || typeof snap !== 'object') return;
        const u = str(snap.url || '');
        arr(snap.hits).forEach((h, j) => {
          if (!h || typeof h !== 'object') return;
          const preview = h.preview;
          if (typeof preview === 'string' && preview.trim()) {
            out.push({
              source: 'net-hook',
              path: `__networkSkuSnapshots[${i}].hits[${j}]`,
              url: u,
              value: preview,
            });
          }
        });
      });
    }
    return out;
  }
  /** 通用网络 Hook 快照（不依赖 URL 含 mtop），优先参与 AE JSON 检测 */
  function aliExpressNetHookOnlySources() {
    const out = [];
    const bridge = getSkuJsonBridgeRoot();
    if (!bridge || typeof bridge !== 'object') return out;
    const netSnaps = arr(bridge.__networkSkuSnapshots);
    netSnaps.slice(-35).forEach((snap, i) => {
      if (!snap || typeof snap !== 'object') return;
      const u = str(snap.url || '');
      arr(snap.hits).forEach((h, j) => {
        if (!h || typeof h !== 'object') return;
        const preview = h.preview;
        if (typeof preview === 'string' && preview.trim()) {
          out.push({
            source: 'net-hook',
            path: `__networkSkuSnapshots[${i}].hits[${j}]`,
            url: u,
            value: preview,
          });
        }
      });
    });
    return out;
  }
  function isAliExpressPdpResponseUrl(url) {
    const u = str(url).toLowerCase();
    return !!u && (
      u.includes('mtop.aliexpress') ||
      u.includes('mtop.aliexpress.pdp.pc.') ||
      (u.includes('aliexpress') && u.includes('pdp.pc.')) ||
      u.includes('aliexpress.pdp')
    );
  }
  function aliExpressCapturedResponseSources() {
    const out = [];
    try {
      const direct = arr(window.__JSON_CAPTURED_RESPONSES__);
      direct.slice(-80).forEach((x, i) => {
        if (!x || typeof x !== 'object' || !isAliExpressPdpResponseUrl(x.url)) return;
        out.push({
          source: x.type || 'response',
          path: x.url ? `window.__JSON_CAPTURED_RESPONSES__[${i}]:${x.url}` : `window.__JSON_CAPTURED_RESPONSES__[${i}]`,
          url: x.url || '',
          value: x.text || '',
        });
      });
    } catch {
      // ignore
    }
    for (const source of aliExpressBridgeSources()) {
      if ((source.source === 'fetch' || source.source === 'xhr' || source.source === 'response') && isAliExpressPdpResponseUrl(source.url || source.path)) {
        out.push(source);
      }
    }
    return out;
  }
  function aliExpressResourceUrlSources() {
    try {
      return arr(performance.getEntriesByType('resource'))
        .map((x) => str(x?.name))
        .filter((u) => /(mtop|pdp|detail|item)/i.test(u))
        .slice(0, 80)
        .map((u, i) => ({ source: 'resource-url', path: `performance.resource[${i}]`, value: u }));
    } catch {
      return [];
    }
  }
  function debugAliExpressDetectStart(rules, platform) {
    try {
      const html = document.documentElement ? String(document.documentElement.innerHTML || '') : '';
      debugLog('[AE DEBUG] host:', location.host);
      debugLog('[AE DEBUG] platform:', platform);
      debugLog('[AE DEBUG] matched SKU JSON rules count:', rules.length);
      rules.forEach((rule, i) => {
        debugLog('[AE DEBUG] rule:', i, {
          name: rule.name,
          matchHost: rule.matchHost,
          windowPaths: rule.windowPaths,
          scriptKeywords: rule.scriptKeywords,
        });
      });
      debugLog('[AE SKU] html has skuProperties:', html.includes('skuProperties'));
      debugLog('[AE SKU] html has skuPaths:', html.includes('skuPaths'));
      debugLog('[AE SKU] html has SKU:', html.includes('"SKU"') || html.includes('SKU'));
      debugLog('[AE SKU] html has skuPropertyImagePath:', html.includes('skuPropertyImagePath'));
    } catch {
      // ignore
    }
  }
  function detect(rulesRaw, platform) {
    const rules = matchRules(rulesRaw, location.host, platform);
    const attempts = [];
    const isAeHost = looksLikeAliExpressHost();
    if (isAeHost) debugAliExpressDetectStart(rules, platform);
    const activeRules = isAeHost && !rules.length
      ? [normalizeRule({ name: 'AliExpress SKU auto', matchHost: ['aliexpress'], windowPaths: [], scriptKeywords: [] })]
      : rules;
    for (const rule of activeRules) {
      const sources = [];
      for (const p of rule.windowPaths) {
        const value = safeWindowPath(p);
        if (value && (typeof value === 'object' || typeof value === 'string')) sources.push({ source: 'window', path: p, value });
      }
      if (isAeHost) {
        const responseSources = [...aliExpressNetHookOnlySources(), ...aliExpressCapturedResponseSources()];
        for (const source of responseSources) {
          if (source.value) sources.push(source);
        }
      try {
        debugLog('[AE SKU] captured responses count:', responseSources.length);
        responseSources.forEach((source) => {
          debugLog('[AE SKU] matched mtop url:', source.url || source.path || '');
        });
        } catch {
          // ignore
        }
      }
      let pending1688 = null;
      for (const source of sortSources(sources)) {
        if (looksLikeAliExpressHost()) {
          try {
            const v = source?.value;
            const path = String(source?.path || '');
            debugLog('[AE DETECT] source.path:', path);
            if (v && typeof v === 'object') debugLog('[AE DETECT] source.value keys:', Object.keys(v || {}));
            const text = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
            const s = String(text || '');
            debugLog('[AE DETECT] has "SKU":', s.includes('SKU'));
            debugLog('[AE DETECT] has "skuPaths":', s.includes('skuPaths'));
            debugLog('[AE DETECT] has "skuProperties":', s.includes('skuProperties'));
            debugLog('[AE DETECT] has "skuPropertyImagePath":', s.includes('skuPropertyImagePath'));
          } catch {
            // ignore
          }
        }
        if (looksLikeAliExpressHost()) {
          const aliMtop = parseAliExpressMtopSkuData(source.value);
          if (aliMtop && aliMtop.length) {
            attempts.push({
              rule: rule.name,
              source: source.source,
              path: source.path,
              strategy: 'aliexpress-mtop-pdp-query',
              rawCount: aliMtop.length,
              apiHit: true,
              jsonpParsed: true,
              hasSkuImagesMap: !!source.value?._debug?.hasSkuImagesMap,
              hasSkuPriceList: !!source.value?._debug?.hasSkuPriceList,
              hasSkuPropertyList: !!source.value?._debug?.hasSkuPropertyList,
            });
            const got = buildAliExpressDetectResult(rule, source, aliMtop, attempts);
            got.strategy = 'aliexpress-mtop-pdp-query';
            got.aliexpressSkuData = source.value;
            return got;
          }
          const ali = parseAliExpressSku(source.value);
          if (ali && ali.length) {
            return buildAliExpressDetectResult(rule, source, ali, attempts);
          }
          attempts.push({
            rule: rule.name,
            source: source.source,
            path: source.path,
            strategy: 'aliexpress-skuPaths',
            note: 'not matched in this source',
          });
          continue;
        }
        const items1688 = parse1688SkuModelItems(source.value);
        if (items1688 && items1688.length) {
          const legacyMeta = build1688LegacyProductMeta(source.value);
          const legacyImageMap = new Map();
          if (legacyMeta && Array.isArray(legacyMeta.colors) && Array.isArray(legacyMeta.mains)) {
            legacyMeta.colors.forEach((c, i) => {
              if (c && legacyMeta.mains[i]) legacyImageMap.set(c, legacyMeta.mains[i]);
            });
          }
          items1688.forEach((item) => {
            if (!item.mainImage && legacyImageMap.has(item.color)) {
              item.mainImage = legacyImageMap.get(item.color);
            }
          });
          const skuAxes = legacyMeta
            ? { colors: legacyMeta.colors, sizes: legacyMeta.sizes, mains: legacyMeta.mains }
            : axesFromItems(items1688);
          attempts.push({
            rule: rule.name,
            source: source.source,
            path: source.path,
            strategy: '1688-skuModel',
            rawCount: items1688.length,
          });
          const out = {
            ok: true,
            ruleName: rule.name,
            ruleId: rule.id,
            source: source.source,
            path: source.path + '.skuModel',
            rawCount: items1688.length,
            rows: rowsFromItems(items1688),
            sku_axes: skuAxes,
            legacyProductMeta: legacyMeta,
            preview: items1688.slice(0, 10),
            attempts,
          };
          return out;
        }
        const arrays = findSkuArrays(source.value, rule);
        attempts.push({ rule: rule.name, source: source.source, path: source.path, arrayHits: arrays.length });
        if (!arrays.length) continue;
        const best = arrays[0];
        const items = enrich1688MainImagesIfMissing(
          normalizeSpecPairItems(standardize(best.value, rule), source.value)
        );
        if (!items.length) continue;
        return {
          ok: true,
          ruleName: rule.name,
          ruleId: rule.id,
          source: source.source,
          path: [source.path, best.path].filter(Boolean).join('.'),
          rawCount: best.value.length,
          rows: rowsFromItems(items),
          sku_axes: axesFromItems(items),
          preview: items.slice(0, 10),
          attempts,
        };
      }
      if (isAeHost) {
        continue;
      }
      const scriptSources = [];
      for (const s of Array.from(document.scripts || [])) {
        const text = s.textContent || '';
        for (const c of candidatesFromScript(text, rule.scriptKeywords)) {
          scriptSources.push({ source: 'script', path: c.path, value: c.value });
        }
        if (isAeHost) {
          const aeJson = extractAliExpressJsonFromText(text);
          if (aeJson) scriptSources.push({ source: 'script', path: 'script@ae-balanced', value: aeJson });
        }
      }
      // AliExpress：不依赖 windowPaths/规则关键词，额外用固定关键词再扫一轮脚本（便于调试与覆盖多版本页面）
      if (looksLikeAliExpressHost()) {
        const aeKws = [
          'SKU',
          'skuPaths',
          'skuProperties',
          'selectedSkuId',
          'skuStock',
          'skuPropertyImagePath',
          'propertyValueDisplayName',
        ];
        let aeCandCount = 0;
        for (const s of Array.from(document.scripts || [])) {
          const text = s.textContent || '';
          const cands = candidatesFromScript(text, aeKws);
          aeCandCount += Array.isArray(cands) ? cands.length : 0;
          for (const c of cands) {
            scriptSources.push({ source: 'script', path: c.path + '#ae', value: c.value });
          }
          if (extractAliExpressJsonFromText(text)) aeCandCount += 1;
        }
        const html = document.documentElement ? String(document.documentElement.innerHTML || '') : '';
        const htmlJson = extractAliExpressJsonFromText(html);
        if (htmlJson) {
          aeCandCount += 1;
          scriptSources.push({ source: 'html', path: 'document.documentElement.innerHTML', value: htmlJson });
        }
        for (const source of aliExpressBridgeSources()) {
          if (source.value) {
            if ((source.source === 'fetch' || source.source === 'xhr' || source.source === 'response') && !isAliExpressPdpResponseUrl(source.url || source.path)) continue;
            const v = typeof source.value === 'string' ? extractAliExpressJsonFromText(source.value) || source.value : source.value;
            scriptSources.push({ ...source, value: v });
          }
        }
        for (const source of aliExpressCapturedResponseSources()) {
          if (!source.value) continue;
          const v = typeof source.value === 'string' ? parseJsonp(source.value) || extractAliExpressJsonFromText(source.value) || source.value : source.value;
          scriptSources.push({ ...source, value: v });
        }
        const resourceSources = aliExpressResourceUrlSources();
        for (const source of resourceSources) {
          attempts.push({ rule: rule.name, source: source.source, path: source.path, url: source.value, strategy: 'aliexpress-resource-url' });
        }
        try {
          debugLog('[AE SKU] script candidates count:', aeCandCount);
          debugLog('[AE SKU] resource url candidates count:', resourceSources.length);
        } catch {
          // ignore
        }
      }
      for (const source of sortSources(scriptSources)) {
        if (looksLikeAliExpressHost()) {
          try {
            const v = source?.value;
            const path = String(source?.path || '');
            debugLog('[AE DETECT] source.path:', path);
            if (v && typeof v === 'object') debugLog('[AE DETECT] source.value keys:', Object.keys(v || {}));
            const text = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
            const s = String(text || '');
            debugLog('[AE DETECT] has "SKU":', s.includes('SKU'));
            debugLog('[AE DETECT] has "skuPaths":', s.includes('skuPaths'));
            debugLog('[AE DETECT] has "skuProperties":', s.includes('skuProperties'));
            debugLog('[AE DETECT] has "skuPropertyImagePath":', s.includes('skuPropertyImagePath'));
          } catch {
            // ignore
          }
        }
        if (looksLikeAliExpressHost()) {
          const aliMtop = parseAliExpressMtopSkuData(source.value);
          if (aliMtop && aliMtop.length) {
            attempts.push({
              rule: rule.name,
              source: source.source,
              path: source.path,
              strategy: 'aliexpress-mtop-pdp-query',
              rawCount: aliMtop.length,
              apiHit: true,
              jsonpParsed: true,
              hasSkuImagesMap: !!source.value?._debug?.hasSkuImagesMap,
              hasSkuPriceList: !!source.value?._debug?.hasSkuPriceList,
              hasSkuPropertyList: !!source.value?._debug?.hasSkuPropertyList,
            });
            const got = buildAliExpressDetectResult(rule, source, aliMtop, attempts);
            got.strategy = 'aliexpress-mtop-pdp-query';
            got.aliexpressSkuData = source.value;
            return got;
          }
          const ali = parseAliExpressSku(source.value);
          if (ali && ali.length) {
            return buildAliExpressDetectResult(rule, source, ali, attempts);
          }
          attempts.push({
            rule: rule.name,
            source: source.source,
            path: source.path,
            strategy: 'aliexpress-skuPaths',
            note: 'not matched in this source',
          });
          continue;
        }
        const items1688 = parse1688SkuModelItems(source.value);
        if (items1688 && items1688.length) {
          const legacyMeta = build1688LegacyProductMeta(source.value);
          const legacyImageMap = new Map();
          if (legacyMeta && Array.isArray(legacyMeta.colors) && Array.isArray(legacyMeta.mains)) {
            legacyMeta.colors.forEach((c, i) => {
              if (c && legacyMeta.mains[i]) legacyImageMap.set(c, legacyMeta.mains[i]);
            });
          }
          items1688.forEach((item) => {
            if (!item.mainImage && legacyImageMap.has(item.color)) {
              item.mainImage = legacyImageMap.get(item.color);
            }
          });
          const skuAxes = legacyMeta
            ? { colors: legacyMeta.colors, sizes: legacyMeta.sizes, mains: legacyMeta.mains }
            : axesFromItems(items1688);
          attempts.push({
            rule: rule.name,
            source: source.source,
            path: source.path,
            strategy: '1688-skuModel',
            rawCount: items1688.length,
          });
          const out = {
            ok: true,
            ruleName: rule.name,
            ruleId: rule.id,
            source: source.source,
            path: source.path + '.skuModel',
            rawCount: items1688.length,
            rows: rowsFromItems(items1688),
            sku_axes: skuAxes,
            legacyProductMeta: legacyMeta,
            preview: items1688.slice(0, 10),
            attempts,
          };
          return out;
        }
        const arrays = findSkuArrays(source.value, rule);
        attempts.push({ rule: rule.name, source: source.source, path: source.path, arrayHits: arrays.length });
        if (!arrays.length) continue;
        const best = arrays[0];
        const items = enrich1688MainImagesIfMissing(
          normalizeSpecPairItems(standardize(best.value, rule), source.value)
        );
        if (!items.length) continue;
        return {
          ok: true,
          ruleName: rule.name,
          ruleId: rule.id,
          source: source.source,
          path: [source.path, best.path].filter(Boolean).join('.'),
          rawCount: best.value.length,
          rows: rowsFromItems(items),
          sku_axes: axesFromItems(items),
          preview: items.slice(0, 10),
          attempts,
        };
      }
      if (pending1688) return pending1688;
    }
    // AliExpress：不要继续 fallback 到“通用数组识别”之外的其它随机结构（避免误命中）
    // 这里直接明确失败原因，方便在智能采集里打印 attempts。
    return {
      ok: false,
      error: isAeHost
        ? 'AliExpress SKU 未识别到 skuPaths/skuProperties'
        : 'JSON 采集未识别到 SKU 数据',
      attempts,
      matchedRules: activeRules.map((r) => r.name),
    };
  }
  window.__skuJsonDetect = { detect };
})();
