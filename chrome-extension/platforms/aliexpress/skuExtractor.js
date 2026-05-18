(function () {
  if (window.__aliExpressSkuExtractorLoaded) return;
  window.__aliExpressSkuExtractorLoaded = true;

  /** 主详情：query；变价/局部：adjust。同命名空间下还有其它 mtop.aliexpress.pdp.pc.* 分片，URL/Body 里只要带此前缀一律抓包（再靠 normalize + 最佳分评选有效 PDP）。 */
  const API_PRIMARY = 'mtop.aliexpress.pdp.pc.query';
  const API_SNIPPETS = ['mtop.aliexpress.pdp.pc.query', 'mtop.aliexpress.pdp.pc.adjust'];
  const API_SNIPPET_RE = /mtop\.aliexpress\.pdp\.pc\./i;
  const BRIDGE_ID = '__ai_sku_json_bridge__';
  const KEYWORDS = [
    'skuId',
    'skuAttr',
    'skuPropertyList',
    'skuPriceList',
    'productSKUPropertyList',
    'skuImagesMap',
    'allSkuQuantityView',
    'salePrice',
    'activityAmount',
    'inventory',
    'quantity',
  ];

  function str(v) {
    return String(v == null ? '' : v).trim();
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function obj(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  function scalar(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return str(v);
    if (Array.isArray(v)) return scalar(v.find((x) => x != null && x !== ''));
    if (typeof v === 'object') {
      return str(
        v.value ??
          v.text ??
          v.name ??
          v.displayName ??
          v.propertyValueName ??
          v.formattedPrice ??
          v.amount ??
          v.minAmount ??
          v.maxAmount ??
          ''
      );
    }
    return '';
  }

  function normalizeImageUrl(raw) {
    const s = scalar(raw);
    if (!s || /^data:/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    return s;
  }

  function imageList(raw) {
    const out = [];
    const add = (v) => {
      if (Array.isArray(v)) {
        v.forEach(add);
        return;
      }
      const img = normalizeImageUrl(
        typeof v === 'object' && v
          ? v.url || v.src || v.imageUrl || v.imagePath || v.picUrl || v.pic || v.img || v.summImagePath
          : v
      );
      if (img && !out.includes(img)) out.push(img);
    };
    add(raw);
    return out;
  }

  function resolveFetchUrl(input) {
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) return str(input.url);
    } catch {
      // ignore
    }
    return str(input && (input.url != null ? input.url : input));
  }

  function bodySnippet(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return str(body.toString());
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      try {
        return Array.from(body.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('&')
          .slice(0, 32000);
      } catch {
        return '';
      }
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return '';
    try {
      return JSON.stringify(body).slice(0, 48000);
    } catch {
      return '';
    }
  }

  function containsApi(url, initOrBody) {
    const u = str(url).toLowerCase();
    if (API_SNIPPET_RE.test(u) || API_SNIPPETS.some((s) => u.includes(s))) return true;
    const extra =
      initOrBody && typeof initOrBody === 'object' && !Array.isArray(initOrBody) && 'body' in initOrBody
        ? initOrBody.body
        : initOrBody;
    const b = str(bodySnippet(extra)).toLowerCase();
    return !!(b && (API_SNIPPET_RE.test(b) || API_SNIPPETS.some((s) => b.includes(s))));
  }

  /** JSONP：去掉 callback( … ) 外壳，取中间 JSON（与 mtopjsonp1({...}) 形式兼容）。 */
  function stripJsonpWrapper(textRaw) {
    const text = str(textRaw).replace(/^\uFEFF/, '').trim();
    if (!text) return '';
    const first = text.indexOf('(');
    const last = text.lastIndexOf(')');
    if (first < 0 || last <= first) return text;
    return text.slice(first + 1, last).trim().replace(/;+\s*$/g, '');
  }

  function parseJsonp(textRaw) {
    const text = str(textRaw).replace(/^\uFEFF/, '').trim();
    if (!text) return { ok: false, error: 'empty response', jsonp: false };
    try {
      return { ok: true, jsonp: false, data: JSON.parse(text) };
    } catch {
      // continue
    }
    const inner = stripJsonpWrapper(text);
    if (!inner || inner === text) return { ok: false, error: 'not json/jsonp', jsonp: false };
    try {
      return { ok: true, jsonp: true, data: JSON.parse(inner) };
    } catch (e) {
      return { ok: false, jsonp: true, error: e && e.message ? e.message : 'JSONP parse failed' };
    }
  }

  function looksLikePdpPcQueryPayload(data) {
    const root = obj(data) || {};
    const api = str(root.api).toLowerCase();
    if (api && (API_SNIPPET_RE.test(api) || api.includes('mtop.aliexpress.pdp.pc.'))) return true;
    const dataObj = obj(root.data) || {};
    const result = obj(dataObj.result) || obj(root.result) || {};
    if (!result || typeof result !== 'object') return false;
    const keys = Object.keys(result).map((k) => k.toUpperCase());
    if (keys.some((k) => k.includes('SKU') || k.includes('PRICE') || k.includes('QUANTITY') || k.includes('HEADER_IMAGE')))
      return true;
    let flat = '';
    try {
      flat = JSON.stringify(result).toLowerCase();
    } catch {
      return false;
    }
    return KEYWORDS.some((k) => flat.includes(String(k).toLowerCase()));
  }

  /**
   * mtop 业务失败（令牌空、反爬验证等）：data/result 里往往没有 SKU，normalize 只会得到空 skuList，
   * 仍会参与 pickBest 与历史，盖住后面真正的 adjust/query 成功包。此类响应不做 normalized。
   * @see acs 域名示例 https://acs.aliexpress.us/h5/mtop.aliexpress.pdp.pc.query/1.0/ …
   */
  function isMtopPdpHardFailure(parsedRoot) {
    const root = obj(parsedRoot) || {};
    const ret = arr(root.ret);
    if (!ret.length) return false;
    const retStr = ret.map((x) => str(x)).join('\u0001').toUpperCase();
    if (!retStr.includes('FAIL_')) return false;
    const data = obj(root.data) || {};
    const result = obj(data.result) || obj(root.result) || {};
    const keys = Object.keys(result);
    if (!keys.length) return true;
    let flat = '';
    try {
      flat = JSON.stringify(result).toLowerCase();
    } catch {
      return true;
    }
    const hasSku =
      flat.includes('skupaths') ||
      flat.includes('skuproperties') ||
      flat.includes('skupropertylist') ||
      flat.includes('skuidstrpriceinfomap') ||
      flat.includes('skuimagesmap') ||
      flat.includes('skupricelist');
    return !hasSku;
  }

  function findByKeyContains(root, needles, maxDepth) {
    const out = [];
    const lowerNeedles = arr(needles).map((x) => str(x).toLowerCase()).filter(Boolean);
    const seen = new WeakSet();
    function walk(node, path, depth) {
      if (!node || typeof node !== 'object' || depth > maxDepth) return;
      if (seen.has(node)) return;
      seen.add(node);
      const entries = Array.isArray(node)
        ? node.slice(0, 200).map((v, i) => [String(i), v])
        : Object.entries(node);
      for (const [k, v] of entries) {
        const p = path ? (Array.isArray(node) ? `${path}[${k}]` : `${path}.${k}`) : k;
        const lk = str(k).toLowerCase();
        if (lowerNeedles.some((n) => lk.includes(n))) out.push({ key: k, path: p, value: v });
        walk(v, p, depth + 1);
      }
    }
    walk(root, '', 0);
    return out;
  }

  function firstHit(root, keys) {
    const hits = findByKeyContains(root, keys, 12);
    return hits.length ? hits[0].value : undefined;
  }

  function collectSkuProperties(root) {
    const result = obj(root && root.data && root.data.result) || obj(root && root.result) || obj(root) || {};
    const direct = [
      result.SKU && (result.SKU.skuPropertyList || result.SKU.productSKUPropertyList || result.SKU.skuProperties),
      result.SKU_PC && (result.SKU_PC.skuPropertyList || result.SKU_PC.productSKUPropertyList || result.SKU_PC.skuProperties),
      Array.isArray(result.skuProperties) && result.skuProperties.length ? result.skuProperties : null,
      firstHit(result, ['skuPropertyList']),
      firstHit(result, ['productSKUPropertyList']),
      firstHit(result, ['skuProperties']),
    ].find((x) => Array.isArray(x) && x.length);

    const props = [];
    for (const p of arr(direct)) {
      if (!p || typeof p !== 'object') continue;
      const id = scalar(p.skuPropertyId || p.propertyId || p.id);
      const name = scalar(p.skuPropertyName || p.propertyName || p.name || p.title);
      const valuesRaw = p.skuPropertyValues || p.propertyValues || p.values || p.valueList;
      const values = arr(valuesRaw)
        .map((v) => {
          const valueId = scalar(v && (v.propertyValueIdLong || v.propertyValueId || v.valueId || v.id));
          const valueName = scalar(v && (v.propertyValueName || v.propertyValueDisplayName || v.displayName || v.name || v.value));
          const image = normalizeImageUrl(
            v &&
              (v.skuPropertyImagePath ||
                v.skuPropertyImageSummPath ||
                v.skuPropertyImage ||
                v.imageUrl ||
                v.image ||
                v.img ||
                v.pic)
          );
          return valueId || valueName || image ? { id: valueId, name: valueName, image } : null;
        })
        .filter(Boolean);
      if (id || name || values.length) props.push({ id, name, values, raw: p });
    }
    return props;
  }

  function propertyMaps(props) {
    const byPair = new Map();
    const byValue = new Map();
    for (const prop of arr(props)) {
      for (const value of arr(prop.values)) {
        if (prop.id && value.id) byPair.set(`${prop.id}:${value.id}`, { prop, value });
        if (value.id && !byValue.has(value.id)) byValue.set(value.id, { prop, value });
      }
    }
    return { byPair, byValue };
  }

  function getSkuImagesMap(result) {
    const direct = result && result.HEADER_IMAGE_PC && result.HEADER_IMAGE_PC.skuImagesMap;
    return obj(direct) || obj(firstHit(result, ['skuImagesMap'])) || {};
  }

  function getQuantityMap(result) {
    const direct = result && result.QUANTITY_PC && result.QUANTITY_PC.allSkuQuantityView;
    return obj(direct) || obj(firstHit(result, ['allSkuQuantityView'])) || {};
  }

  function collectPriceItems(result) {
    const out = [];
    const push = (row) => {
      if (row && typeof row === 'object' && (row.skuId || row.skuIdStr)) out.push(row);
    };
    const pricePc = result && result.PRICE;
    if (pricePc && typeof pricePc === 'object') {
      for (const mapKey of ['skuIdStrPriceInfoMap', 'skuPriceInfoMap']) {
        const m = obj(pricePc[mapKey]);
        if (!m) continue;
        for (const [skuId, info] of Object.entries(m)) {
          const sid = str(skuId);
          if (!sid || !info || typeof info !== 'object') continue;
          push({ skuId: sid, skuIdStr: sid, ...info });
        }
      }
    }
    const sources = [
      result && result.SKU && result.SKU.skuPriceList,
      result && result.SKU_PC && result.SKU_PC.skuPriceList,
      firstHit(result, ['skuPriceList']),
    ];
    const add = (v) => {
      if (!v) return;
      if (Array.isArray(v)) {
        v.forEach(add);
        return;
      }
      if (typeof v !== 'object') return;
      if (v.skuId || v.skuAttr || v.salePrice || v.activityAmount || v.price || v.skuVal || v.salePriceString) out.push(v);
      for (const child of Object.values(v).slice(0, 300)) {
        if (
          child &&
          typeof child === 'object' &&
          (child.skuId || child.skuAttr || child.salePrice || child.activityAmount || child.price || child.salePriceString)
        ) {
          out.push(child);
        }
      }
    };
    sources.forEach(add);
    return out;
  }

  function parseAttr(rawAttr, maps) {
    const attrs = {};
    const attrIds = [];
    const raw = scalar(rawAttr);
    if (!raw) return { attrs, attrIds };
    for (const part of raw.split(/[;,]/).map((x) => str(x)).filter(Boolean)) {
      attrIds.push(part);
      const pair = maps.byPair.get(part);
      if (pair) {
        attrs[pair.prop.name || pair.prop.id || ''] = pair.value.name || pair.value.id || '';
        continue;
      }
      const bits = part.split(':').map(str);
      const valueHit = maps.byValue.get(bits[bits.length - 1]);
      if (valueHit) attrs[valueHit.prop.name || valueHit.prop.id || ''] = valueHit.value.name || valueHit.value.id || '';
    }
    return { attrs, attrIds };
  }

  function priceText(v) {
    return scalar(
      v &&
        (v.salePriceString ||
          v.formattedPrice ||
          v.displayPrice ||
          v.price ||
          v.amount ||
          v.minAmount ||
          v.maxAmount ||
          v.value ||
          v)
    );
  }

  function productIdFromPageUrl() {
    try {
      const href = str(location.href);
      const m = href.match(/\/item\/(\d{6,})\.html/i) || href.match(/[?&]item_id=(\d{6,})/i);
      return m ? str(m[1]) : '';
    } catch {
      return '';
    }
  }

  function normalizeMtopResponse(parsed, meta) {
    const root = obj(parsed) || {};
    const data = obj(root.data) || {};
    const result = obj(data.result) || obj(root.result) || {};
    const skuBlock = (function resolveSkuBlock(r) {
      const res = obj(r) || {};
      const tryBlock = (b) => {
        const o = obj(b);
        return o && Array.isArray(o.skuPaths) && o.skuPaths.length ? o : null;
      };
      const hits = [tryBlock(res.SKU), tryBlock(res.SKU_PC), tryBlock(res.PC_SKU), tryBlock(res.SKU_MODULE)].filter(Boolean);
      if (hits.length) return hits[0];
      for (const k of Object.keys(res)) {
        const hit = tryBlock(res[k]);
        if (hit) return hit;
      }
      return obj(res.SKU) || obj(res.SKU_PC) || {};
    })(result);
    const skuPaths = arr(skuBlock.skuPaths);
    const pathBySkuId = new Map();
    for (const p of skuPaths) {
      if (!p || typeof p !== 'object') continue;
      const sid = scalar(p.skuId || p.skuIdStr);
      if (sid) pathBySkuId.set(sid, p);
    }
    const header = obj(result.HEADER_IMAGE_PC) || {};
    const skuImagesMap = getSkuImagesMap(result);
    const quantityMap = getQuantityMap(result);
    const skuProperties = collectSkuProperties(root);
    const maps = propertyMaps(skuProperties);
    const priceItems = collectPriceItems(result);
    const skuIds = new Set([
      ...Object.keys(skuImagesMap || {}),
      ...Object.keys(quantityMap || {}),
      ...priceItems.map((x) => scalar(x.skuId || x.skuIdStr || x.id)).filter(Boolean),
      ...skuPaths.map((x) => scalar(x && (x.skuId || x.skuIdStr))).filter(Boolean),
    ]);

    const mainImages = [
      ...imageList(header.imagePathList),
      ...imageList(header.imgList),
      ...imageList(header.images),
      ...imageList(firstHit(result, ['imagePathList'])),
      ...imageList(firstHit(result, ['imgList'])),
    ].filter((x, i, a) => x && a.indexOf(x) === i);

    const priceBySku = new Map();
    const attrBySku = new Map();
    for (const item of priceItems) {
      const skuId = scalar(item.skuId || item.skuIdStr || item.id);
      if (skuId) {
        skuIds.add(skuId);
        priceBySku.set(skuId, item);
      }
      if (skuId && (item.skuAttr || item.path || item.skuAttrPath)) attrBySku.set(skuId, item.skuAttr || item.path || item.skuAttrPath);
    }
    for (const [sid, p] of pathBySkuId) {
      if (p && (p.skuAttr || p.path)) attrBySku.set(sid, attrBySku.get(sid) || p.skuAttr || p.path);
    }

    const skuList = Array.from(skuIds).map((skuId) => {
      const priceRaw = priceBySku.get(skuId) || {};
      const qtyRaw = quantityMap[skuId] || {};
      const pathRow = pathBySkuId.get(skuId) || {};
      const attrParsed = parseAttr(
        attrBySku.get(skuId) || priceRaw.skuAttr || priceRaw.path || priceRaw.skuAttrPath || pathRow.skuAttr || pathRow.path,
        maps
      );
      const orig = priceRaw.originalPrice && typeof priceRaw.originalPrice === 'object' ? priceRaw.originalPrice : null;
      const listPrice = orig
        ? scalar(orig.formatedAmount || orig.formattedAmount || orig.value || orig)
        : priceText(priceRaw.price || priceRaw.originalPrice || priceRaw.skuPrice || priceRaw);
      return {
        skuId,
        attrs: attrParsed.attrs,
        attrIds: attrParsed.attrIds,
        price: listPrice,
        salePrice: priceText(
          priceRaw.salePrice || priceRaw.salePriceString || priceRaw.activityAmount || priceRaw.discountPrice || priceRaw.promotionPrice
        ),
        stock: scalar(
          qtyRaw.currentCount ??
            qtyRaw.maxBuyCount ??
            qtyRaw.inventory ??
            qtyRaw.quantity ??
            pathRow.skuStock ??
            priceRaw.inventory ??
            priceRaw.quantity
        ),
        image: imageList(skuImagesMap[skuId])[0] || '',
        raw: { price: priceRaw, quantity: qtyRaw, path: pathRow },
      };
    });

    const title = scalar(
      result.TITLE && (result.TITLE.title || result.TITLE.subject) ||
        result.PRODUCT_TITLE ||
        firstHit(result, ['title']) ||
        ''
    );

    const priceProductId = result.PRICE && (result.PRICE.productId != null ? result.PRICE.productId : '');
    const productId =
      scalar(
        data.productId ||
          result.productId ||
          result.itemId ||
          priceProductId ||
          firstHit(root, ['productId']) ||
          firstHit(root, ['itemId'])
      ) || productIdFromPageUrl();

    return {
      platform: 'aliexpress',
      productId,
      title,
      mainImages,
      skuProperties: skuProperties.map((p) => ({ name: p.name, values: p.values })),
      skuList,
      rawSource: {
        api: str(root.api) || API_PRIMARY,
        url: meta && meta.url ? meta.url : '',
        capturedAt: meta && meta.capturedAt ? meta.capturedAt : new Date().toISOString(),
      },
      _debug: {
        hitApi: true,
        api: str(root.api),
        jsonpParsed: true,
        skuIdCount: skuList.length,
        hasSkuImagesMap: Object.keys(skuImagesMap).length > 0,
        hasSkuPriceList: priceItems.length > 0,
        hasSkuPropertyList: skuProperties.length > 0,
        hasSkuPaths: skuPaths.length > 0,
      },
    };
  }

  /** 同源顶层：mtop 常在 iframe 发请求，隔离脚本只读顶层 document 的桥接。 */
  function aeTopWindow() {
    try {
      if (window.top && window.top !== window) {
        void window.top.document;
        return window.top;
      }
    } catch {
      // cross-origin top
    }
    return window;
  }

  function bridgeHostDocument() {
    try {
      const tw = aeTopWindow();
      if (tw && tw.document) return tw.document;
    } catch {
      // ignore
    }
    return document;
  }

  function mergeBridge(patch) {
    try {
      let current = {};
      const hostDoc = bridgeHostDocument();
      const el = hostDoc.getElementById(BRIDGE_ID) || hostDoc.createElement('script');
      if (!el.id) {
        el.id = BRIDGE_ID;
        el.type = 'application/json';
        (hostDoc.documentElement || hostDoc.head || hostDoc.body || hostDoc).appendChild(el);
      }
      try {
        current = el.textContent ? JSON.parse(el.textContent) : {};
      } catch {
        current = {};
      }
      el.textContent = JSON.stringify({ ...current, ...patch });
      el.setAttribute('data-ai-sku-json-bridge', '1');
    } catch {
      // ignore bridge failures
    }
  }

  function logAeSku(stage, detail) {
    try {
      console.info(`[AE SKU][${stage}]`, detail);
    } catch {
      // ignore
    }
  }

  function truncateForBridge(text, maxLen) {
    const s = str(text);
    const n = Math.max(4000, Number(maxLen) || 450000);
    if (s.length <= n) return s;
    return s.slice(0, n) + '\n…[truncated]';
  }

  /**
   * 同一页会并发/连续请求多次 mtop（如 pdp.pc.query 不同 dataType 分片），最后一次往往是局部 JSON，
   * 若总用「最后一次」会覆盖掉含 SKU.skuPaths 的完整 PDP。按得分保留「最好」的一份写入桥接。
   */
  function scoreAeMtopNormalized(n) {
    if (!n || typeof n !== 'object' || n.platform !== 'aliexpress') return -1;
    const sl = Array.isArray(n.skuList) ? n.skuList.length : 0;
    const sp = Array.isArray(n.skuProperties) ? n.skuProperties.length : 0;
    const d = n._debug && typeof n._debug === 'object' ? n._debug : {};
    let score = sl * 2000 + sp * 80;
    if (d.hasSkuPaths) score += 800000;
    if (d.hasSkuPropertyList) score += 400000;
    if (d.hasSkuImagesMap) score += 15000;
    if (d.hasSkuPriceList) score += 15000;
    return score;
  }

  function pickBestAeMtopNormalized(responses) {
    let best = null;
    let bestScore = -1;
    for (const x of arr(responses)) {
      const n = x && x.normalized && typeof x.normalized === 'object' ? x.normalized : null;
      const s = scoreAeMtopNormalized(n);
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    return best;
  }

  function storeCapture(entry) {
    const tw = aeTopWindow();
    const list = Array.isArray(tw.__AI_AE_MTOP_RESPONSES__) ? tw.__AI_AE_MTOP_RESPONSES__ : [];
    const full = {
      type: entry.type,
      url: entry.url,
      text: entry.text,
      capturedAt: entry.capturedAt,
      jsonpParsed: entry.jsonpParsed,
      parseError: entry.parseError || '',
      normalized: entry.normalized || null,
    };
    list.push(full);
    tw.__AI_AE_MTOP_RESPONSES__ = list.slice(-20);
    const best = pickBestAeMtopNormalized(tw.__AI_AE_MTOP_RESPONSES__) || entry.normalized || null;
    tw.__AI_AE_MTOP_SKU_DATA__ = best;
    const forBridge = tw.__AI_AE_MTOP_RESPONSES__.map((x) => ({
      type: x.type,
      url: x.url,
      capturedAt: x.capturedAt,
      jsonpParsed: x.jsonpParsed,
      parseError: x.parseError || '',
      text: truncateForBridge(x.text, 450000),
      normalized: x.normalized || null,
    }));
    mergeBridge({
      __jsonCapturedResponses: forBridge,
      __aliExpressMtopSkuData: best,
    });
    const d = entry.normalized && entry.normalized._debug;
    logAeSku('capture', {
      hitMtopPdpQuery: true,
      transport: entry.type,
      jsonpParseOk: !!entry.jsonpParsed,
      parseError: entry.parseError || '',
      normalizeOk: !!entry.normalized,
      skuIdCount: d ? d.skuIdCount : 0,
      hasSkuImagesMap: d ? d.hasSkuImagesMap : false,
      hasSkuPriceList: d ? d.hasSkuPriceList : false,
      hasSkuPropertyList: d ? d.hasSkuPropertyList : false,
      bridgeBestSkuCount: best && Array.isArray(best.skuList) ? best.skuList.length : 0,
    });
  }

  function handleResponse(url, text, type, extra) {
    if (!containsApi(url, extra)) return;
    logAeSku('network', { hitMtopPdpQuery: true, transport: type, url: str(url).slice(0, 500) });
    const capturedAt = new Date().toISOString();
    const parsed = parseJsonp(text);
    let normalized = null;
    let normalizeError = '';
    if (parsed.ok) {
      if (isMtopPdpHardFailure(parsed.data)) {
        const r = obj(parsed.data) && arr(parsed.data.ret);
        logAeSku('mtop-business-fail', {
          url: str(url).slice(0, 280),
          ret: r.slice(0, 3),
          note: '无 SKU 数据，跳过 normalize（避免盖住后续成功 adjust/query）',
        });
        normalizeError = 'mtop business failure (empty PDP)';
      } else {
        if (!looksLikePdpPcQueryPayload(parsed.data)) {
          logAeSku('payload-warn', { note: 'shape may not be PDP PC query', api: obj(parsed.data) && parsed.data.api });
        }
        try {
          normalized = normalizeMtopResponse(parsed.data, { url, capturedAt });
        } catch (e) {
          normalizeError = e && e.message ? e.message : String(e);
          normalized = null;
        }
      }
    }
    if (!parsed.ok) {
      logAeSku('jsonp', { ok: false, error: parsed.error || 'parse failed', jsonp: !!parsed.jsonp });
    } else {
      logAeSku('jsonp', { ok: true, jsonp: !!parsed.jsonp });
    }
    storeCapture({
      type,
      url,
      text,
      capturedAt,
      jsonpParsed: !!parsed.ok,
      parseError: parsed.ok ? normalizeError : parsed.error || 'parse failed',
      normalized,
    });
  }

  function installNetworkCapture() {
    if (window.__AI_AE_MTOP_CAPTURE_INSTALLED__) return;
    window.__AI_AE_MTOP_CAPTURE_INSTALLED__ = true;
    if (!String(location.host || '').toLowerCase().includes('aliexpress')) return;

    const rawFetch = window.fetch;
    if (typeof rawFetch === 'function') {
      window.fetch = function (...args) {
        const url = resolveFetchUrl(args[0]);
        const init = args[1];
        return rawFetch.apply(this, args).then((res) => {
          try {
            if (containsApi(url, init)) {
              res
                .clone()
                .text()
                .then((text) => handleResponse(url, text, 'fetch', init))
                .catch((e) => logAeSku('fetch-read-error', str(e && e.message)));
            }
          } catch {
            // ignore
          }
          return res;
        });
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const rawOpen = XHR.prototype.open;
      const rawSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__aiAeMtopUrl = str(url);
        } catch {
          // ignore
        }
        return rawOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          this.__aiAeMtopBody = body;
        } catch {
          // ignore
        }
        try {
          this.addEventListener('load', function () {
            const url = str(this.__aiAeMtopUrl || this.responseURL || '');
            const extra = { body: this.__aiAeMtopBody };
            if (!containsApi(url, extra)) return;
            if (this.responseType && this.responseType !== 'text' && this.responseType !== '') return;
            handleResponse(url, str(this.responseText), 'xhr', extra);
          });
        } catch {
          // ignore
        }
        return rawSend.apply(this, arguments);
      };
    }
  }

  window.__aliExpressSkuExtractor = {
    API_NAME: API_PRIMARY,
    API_SNIPPETS,
    KEYWORDS,
    containsApi,
    parseJsonp,
    stripJsonpWrapper,
    normalizeMtopResponse,
    findByKeyContains,
    looksLikePdpPcQueryPayload,
    resolveFetchUrl,
    installNetworkCapture,
  };

  installNetworkCapture();
})();
