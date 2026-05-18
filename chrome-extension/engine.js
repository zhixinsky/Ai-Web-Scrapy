/**
 * 内容脚本：采集前执行「页面预处理」——整页滚动 + 可选 pre_click_xpath 点击（与采集规则配置一致）；
 * 主图：若规则含 color_list_xpath（后台「特殊 XPath」），则对该列节点逐个点击，随机等待 500–1000ms 后再用字段 XPath 取主图 src，结果为 URL 数组。
 * 其它字段取值仍仅按各规则 XPath 读取，无变体笛卡尔积、无图区切换等业务加工。
 */
(function () {
  if (window.__amzScraperEngineLoaded) return;
  window.__amzScraperEngineLoaded = true;
  const SCRAPER_DEBUG = false;
  function debugLog(...args) {
    if (SCRAPER_DEBUG) console.log(...args);
  }

  let abortRequested = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 从桥接里统计 AE mtop SKU 条数：含 __aliExpressMtopSkuData 与各条抓包 normalized（避免主字段空但 responses 里有货）。 */
  function countAeSkuListFromBridgeJson(j) {
    if (!j || typeof j !== 'object') return 0;
    let n = 0;
    const m = j.__aliExpressMtopSkuData;
    if (m && typeof m === 'object' && Array.isArray(m.skuList)) n = m.skuList.length;
    const responses = Array.isArray(j.__jsonCapturedResponses) ? j.__jsonCapturedResponses : [];
    for (const x of responses) {
      const norm = x && x.normalized;
      if (norm && typeof norm === 'object' && Array.isArray(norm.skuList)) {
        const ln = norm.skuList.length;
        if (ln > n) n = ln;
      }
    }
    return n;
  }

  /** 轮询 DOM bridge：等 MAIN 世界 syncBridge / mtop 抓包写入 __aliExpressMtopSkuData 后再做 JSON 检测。 */
  async function waitForAliExpressMtopBridge(dbg, maxMs = 10000, stepMs = 180) {
    const end = Date.now() + maxMs;
    let lastLen = -1;
    while (Date.now() < end) {
      if (abortRequested) return;
      try {
        const el = document.getElementById('__ai_sku_json_bridge__');
        if (el && el.textContent) {
          const j = JSON.parse(el.textContent);
          const m = j && j.__aliExpressMtopSkuData;
          const n = countAeSkuListFromBridgeJson(j);
          lastLen = n;
          const mOk = m && typeof m === 'object' && m.platform === 'aliexpress';
          const respHasAe = Array.isArray(j.__jsonCapturedResponses)
            ? j.__jsonCapturedResponses.some((x) => x && x.normalized && x.normalized.platform === 'aliexpress')
            : false;
          if (n > 0 && (mOk || respHasAe)) {
            if (typeof dbg === 'function') dbg(`速卖通：桥接已就绪（mtop skuList=${n}）`);
            return;
          }
        }
      } catch {
        // ignore
      }
      await sleep(stepMs);
    }
    if (typeof dbg === 'function') dbg(`速卖通：等待 mtop 桥接结束（最后 skuList 条数=${lastLen}），继续 JSON 检测`);
  }

  function randomIntInclusive(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  /** 随机等待 [min, max] 毫秒，期间可响应停止采集 */
  async function interruptibleRandomSleepMs(min, max) {
    const ms = randomIntInclusive(min, max);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (abortRequested) throw new Error('用户已请求停止');
      await sleep(Math.min(200, Math.max(0, end - Date.now())));
    }
  }

  function xpathAll(xpath, contextNode) {
    const doc = contextNode.ownerDocument || document;
    const result = doc.evaluate(
      xpath,
      contextNode,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }
    return nodes;
  }

  function xpathFirst(xpath, contextNode) {
    const nodes = xpathAll(xpath, contextNode);
    return nodes[0] || null;
  }

  function parseCssExpr(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/^(css|shadowcss)\s*:\s*([\s\S]+)$/i);
    if (!m) return null;
    return String(m[2] || '').trim();
  }

  function cssAll(selector, contextNode) {
    const root = contextNode && contextNode.nodeType ? contextNode : document;
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (e) {
      console.warn('[cssAll] invalid selector', selector, e);
      return [];
    }
  }

  /**
   * Shadow(open) + CSS：支持 `host >>> inner >>> target` 语法。
   * - `>>>` 表示进入上一段匹配元素的 shadowRoot（open）。
   * - 最后一段返回 querySelectorAll 结果（元素数组）。
   */
  function shadowCssAllInRoot(rootDoc, expr) {
    const parts = String(expr || '')
      .split('>>>')
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (!parts.length) return [];
    let root = rootDoc;
    for (let i = 0; i < parts.length; i++) {
      const sel = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        return cssAll(sel, root);
      }
      const host = (root && root.querySelector ? root.querySelector(sel) : null) || null;
      if (!host) return [];
      const sr = host.shadowRoot;
      if (!sr) return [];
      root = sr;
    }
    return [];
  }

  function deepQueryAllAcrossOpenShadows(rootDoc, selector) {
    /** @type {Element[]} */
    const out = [];
    out.push(...cssAll(selector, rootDoc));
    const srs = collectOpenShadowRootsFrom(rootDoc, 5000);
    for (const sr of srs) {
      out.push(...cssAll(selector, sr));
    }
    return out;
  }

  function collectOpenShadowRootsFrom(rootNode, limit = 3000) {
    /** @type {(Document|ShadowRoot|Element)[]} */
    const q = [rootNode];
    /** @type {ShadowRoot[]} */
    const roots = [];
    let seen = 0;
    while (q.length && seen < limit) {
      seen += 1;
      const n = q.shift();
      if (!n) continue;
      const elList =
        n.nodeType === Node.DOCUMENT_NODE || n.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ? Array.from(n.querySelectorAll ? n.querySelectorAll('*') : [])
          : n.nodeType === Node.ELEMENT_NODE
            ? [n]
            : [];
      for (const el of elList) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
        const sr = el.shadowRoot;
        if (sr) {
          roots.push(sr);
          q.push(sr);
        }
      }
    }
    return roots;
  }

  function listAccessibleDocumentsWithStats() {
    /** @type {Document[]} */
    const docs = [document];
    let iframeTotal = 0;
    let iframeAccessible = 0;

    // 注意：iframe 可能出现在 open shadowRoot 内；需要把 shadowRoot 也扫描一遍
    const scanRoots = [document, ...collectOpenShadowRootsFrom(document)];
    for (const root of scanRoots) {
      const iframes = Array.from(root.querySelectorAll ? root.querySelectorAll('iframe') : []);
      for (const f of iframes) {
        iframeTotal += 1;
        try {
          const d = f.contentDocument;
          if (d) {
            iframeAccessible += 1;
            docs.push(d);
            // 递归：iframe 内也可能含 open shadow / 子 iframe
            for (const sr of collectOpenShadowRootsFrom(d, 1200)) {
              // no-op: just to warm traversal in deeper levels for later scans if needed
              void sr;
            }
          }
        } catch {
          // cross-origin iframe, ignore
        }
      }
    }

    return { docs, iframeTotal, iframeAccessible };
  }

  function shadowCssAll(expr) {
    // 优先当前 document，若页面把详情放在同源 iframe 内，再尝试 iframe document
    const { docs } = listAccessibleDocumentsWithStats();
    for (const d of docs) {
      const els = shadowCssAllInRoot(d, expr);
      if (els && els.length) return els;
    }
    // 兜底：host 选择器写不稳时，深度遍历 open shadowRoot 搜索末段 selector
    const parts = String(expr || '')
      .split('>>>')
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const tailSel = parts[parts.length - 1];
      for (const d of docs) {
        const deep = deepQueryAllAcrossOpenShadows(d, tailSel);
        if (deep && deep.length) return deep;
      }
    }
    // 全部 0：仍返回最后一次结果（空数组）
    return [];
  }

  function shadowCssExplainZero(expr) {
    const parts = String(expr || '')
      .split('>>>')
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (parts.length < 2) return `css 规则无 >>>，仅在 document 内 querySelectorAll`;
    const hostSel = parts[0];
    const tailSel = parts[parts.length - 1];
    const { docs, iframeTotal, iframeAccessible } = listAccessibleDocumentsWithStats();
    let hostHits = 0;
    let shadowHits = 0;
    let tailHits = 0;
    let deepTailHits = 0;
    for (const d of docs) {
      let host = null;
      try {
        host = d.querySelector(hostSel);
      } catch {
        continue;
      }
      if (host) {
        hostHits += 1;
        if (host.shadowRoot) {
          shadowHits += 1;
          try {
            tailHits += host.shadowRoot.querySelectorAll(tailSel).length;
          } catch {
            // ignore
          }
        }
      }
      try {
        deepTailHits += deepQueryAllAcrossOpenShadows(d, tailSel).length;
      } catch {
        // ignore
      }
    }
    return `host(${hostSel}) 命中=${hostHits}，shadowRoot 可用=${shadowHits}，末段(${tailSel}) 命中=${tailHits}，deep末段命中=${deepTailHits}，iframe=${iframeAccessible}/${iframeTotal}`;
  }

  async function waitForShadowCssAll(expr, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3500;
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 200;
    const end = Date.now() + Math.max(0, timeoutMs);
    let last = [];
    while (Date.now() < end) {
      checkAbort();
      last = shadowCssAll(expr);
      if (Array.isArray(last) && last.length) return last;
      await sleep(intervalMs);
    }
    return Array.isArray(last) ? last : [];
  }

  function extractFromElements(elements, isImage) {
    if (!Array.isArray(elements) || elements.length === 0) return [];
    if (isImage) {
      function isHiddenByStyleOrAttr(el) {
        try {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
          // attribute-level hidden
          if (el.hasAttribute('hidden')) return true;
          const ariaHidden = String(el.getAttribute('aria-hidden') || '').toLowerCase();
          if (ariaHidden === 'true') return true;

          // walk up: if any ancestor is display:none / visibility:hidden, treat as hidden
          // stop at ShadowRoot/Document boundary
          let cur = el;
          let guard = 0;
          while (cur && guard < 40) {
            guard += 1;
            if (cur.nodeType !== Node.ELEMENT_NODE) break;
            const st = window.getComputedStyle(cur);
            if (!st) break;
            if (st.display === 'none') return true;
            if (st.visibility === 'hidden' || st.visibility === 'collapse') return true;
            // opacity:0 常用于占位/蜜罐；这里也过滤掉
            if (Number(st.opacity) === 0) return true;
            cur = cur.parentElement;
          }
          return false;
        } catch {
          return false;
        }
      }

      const urls = [];
      for (const node of elements) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'IMG') {
          // 避免 `>>>` 扫到 open shadowRoot 内的隐藏/蜜罐 img（display:none 等）
          if (isHiddenByStyleOrAttr(node)) continue;
          const u =
            String(node.currentSrc || '').trim() ||
            String(node.getAttribute('src') || '').trim() ||
            String(node.getAttribute('data-src') || '').trim() ||
            String(node.getAttribute('data-lazy-src') || '').trim() ||
            String(node.getAttribute('data-original') || '').trim();
          if (u) urls.push(u);
          continue;
        }
        const url =
          node.getAttribute('src') ||
          node.getAttribute('data-src') ||
          node.getAttribute('data-lazy-src') ||
          node.getAttribute('data-original');
        if (url) {
          urls.push(String(url).trim());
          continue;
        }
        const bg =
          (node.style && node.style.backgroundImage) ||
          node.getAttribute('style') ||
          '';
        if (bg && /url\s*\(/i.test(bg)) {
          const mm = String(bg).match(/url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/i);
          const u = mm ? String(mm[1] || '').trim() : '';
          if (u) urls.push(u);
        }
      }
      return urls;
    }
    const texts = [];
    for (const node of elements) {
      if (!node) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        const s = String(node.nodeValue ?? '').trim();
        if (s) texts.push(s);
        continue;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const s = String(node.innerText || node.textContent || '').trim();
        if (s) texts.push(s);
      }
    }
    return texts;
  }

  async function extractCssTextOrAttr(expr, isImage) {
    try {
      const els = await waitForShadowCssAll(expr, { timeoutMs: 4500, intervalMs: 200 });
      return extractFromElements(els, isImage);
    } catch (e) {
      console.error('[extractCssTextOrAttr]', expr, e);
      return [];
    }
  }

  async function scrollPage() {
    const distance = 800;
    const delay = (ms) => new Promise((res) => setTimeout(res, ms));
    let totalHeight = 0;
    let scrollHeight =
      document.body.scrollHeight || document.documentElement.scrollHeight;
    while (totalHeight < scrollHeight) {
      window.scrollBy(0, distance);
      totalHeight += distance;
      await delay(300);
      scrollHeight =
        document.body.scrollHeight || document.documentElement.scrollHeight;
      if (abortRequested) return;
    }
  }

  /**
   * 与采集规则「页面预处理」一致：先滚动到底，再按顺序可选点击预处理 XPath（如展开/加载更多）。
   * 兼容：
   * - 旧字段：pre_click_xpath: string
   * - 新字段：pre_click_xpaths: string[]
   */
  async function preparePage(preClickXpathOrList, options = {}) {
    const scrollToBottom = options.scrollToBottom !== false;
    if (scrollToBottom) {
      await scrollPage();
      await interruptibleRandomSleepMs(300, 2000);
    } else {
      await interruptibleRandomSleepMs(100, 400);
    }
    const listRaw = Array.isArray(preClickXpathOrList)
      ? preClickXpathOrList
      : preClickXpathOrList
        ? [preClickXpathOrList]
        : [];
    const list = listRaw.map((x) => String(x || '').trim()).filter(Boolean);
    for (const xp of list) {
      checkAbort();
      const btn = xpathFirst(xp, document);
      if (btn && btn.nodeType === Node.ELEMENT_NODE) {
        try {
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          await sleep(200);
          btn.click();
          await interruptibleRandomSleepMs(200, 1000);
        } catch (e) {
          console.warn('[preparePage] 预点击失败', e);
        }
      }
    }
  }

  /**
   * 文本：返回各节点文本数组；图片：返回 URL 数组（含 @src、background-image 等原始解析）
   */
  function extractTextOrAttr(doc, xpath, isImage) {
    try {
      if (isImage) {
        const els = xpathAll(xpath, doc);
        const urls = [];
        for (const node of els) {
          if (node.nodeType === Node.ATTRIBUTE_NODE) {
            const url = String(node.value || '').trim();
            if (url) urls.push(url);
            continue;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const url =
            node.getAttribute('src') ||
            node.getAttribute('data-src') ||
            node.getAttribute('data-lazy-src') ||
            node.getAttribute('data-original');
          if (url) {
            urls.push(url);
            continue;
          }
          const bg =
            (node.style && node.style.backgroundImage) ||
            node.getAttribute('style') ||
            '';
          if (bg && /url\s*\(/i.test(bg)) {
            const m = String(bg).match(/url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/i);
            const u = m ? String(m[1] || '').trim() : '';
            if (u) urls.push(u);
          }
        }
        return urls;
      }
      if (xpath.includes('text()')) {
        const res = doc.evaluate(
          xpath,
          doc,
          null,
          XPathResult.ORDERED_NODE_ITERATOR_TYPE,
          null
        );
        const vals = [];
        let n;
        while ((n = res.iterateNext())) {
          const s = String(n.nodeValue ?? n.textContent ?? '').trim();
          if (s) vals.push(s);
        }
        return vals;
      }
      const elements = xpathAll(xpath, doc);
      const texts = [];
      for (const elem of elements) {
        let text = '';
        if (elem.nodeType === Node.TEXT_NODE) {
          text = elem.nodeValue || '';
        } else if (elem.nodeType === Node.ELEMENT_NODE) {
          text = elem.innerText || elem.textContent || '';
        }
        text = String(text).trim();
        if (text) texts.push(text);
      }
      return texts;
    } catch (e) {
      console.error('[extractTextOrAttr]', xpath, e);
      return [];
    }
  }

  function checkAbort() {
    if (abortRequested) throw new Error('用户已请求停止');
  }

  /**
   * 普通字段 XPath 多节点命中时拼接。若文本完全相同（页内两处重复展示同一价等），只保留一条，避免出现「$4.16 $4.16」。
   */
  function joinScalarFieldVals(vals) {
    const arr = (Array.isArray(vals) ? vals : []).map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!arr.length) return '';
    const uniq = [...new Set(arr)];
    return uniq.length === 1 ? uniq[0] : uniq.join(' ');
  }

  /** 规则是否为「颜色」变体列表（字段名或 variant_name 为 颜色） */
  function isColorVariantRule(r) {
    const f = String(r.field || '').trim();
    const vn = String(r.variant_name || '').trim();
    return f === '颜色' || vn === '颜色';
  }

  /**
   * 列表项：默认可视文本；若为缩略图（img）则用 alt，其次 title。
   * @param {Node} node
   */
  function extractListItemText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.nodeValue || '').trim();
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'IMG') {
        const alt = String(node.getAttribute('alt') || '').trim();
        const title = String(node.getAttribute('title') || '').trim();
        if (alt) return alt;
        if (title) return title;
        return '';
      }
      return String(node.innerText || node.textContent || '').trim();
    }
    return '';
  }

  /**
   * 颜色列表：采集为空时依次填 color-1、color-2…（仅替换 trim 后仍为空的项）
   * @param {string[]} texts
   */
  function fillEmptyColorPlaceholders(texts) {
    let emptySeq = 0;
    return texts.map((raw) => {
      const s = String(raw ?? '').trim();
      if (s) return s;
      emptySeq += 1;
      return `color-${emptySeq}`;
    });
  }

  /**
   * 颜色列表：相同文案出现时从第二项起依次加后缀 -1、-2、-3…（首项保持原文）
   * @param {string[]} texts
   */
  function dedupeColorListSuffixes(texts) {
    const counts = new Map();
    const out = [];
    for (const raw of texts) {
      const s = String(raw ?? '').trim();
      if (!s) {
        out.push(s);
        continue;
      }
      const n = counts.get(s) || 0;
      counts.set(s, n + 1);
      if (n === 0) {
        out.push(s);
      } else {
        out.push(`${s}-${n}`);
      }
    }
    return out;
  }

  /**
   * 速卖通：首屏 query 常无完整 skuPaths，切换颜色会拉 pdp.pc.adjust。
   * 在 JSON 检测前自动点「color_list」首项或颜色列表 XPath 首项，等价于用户手动点一次颜色。
   */
  async function aeTryPrimeAdjustRequest(rules, dbg) {
    const log = typeof dbg === 'function' ? dbg : () => {};
    const list = Array.isArray(rules) ? rules : [];
    try {
      const hints = ['#nav-skus', '[data-pl="sku"]', '[class*="sku-item"]', '[class*="pdp-sku"]'];
      for (const sel of hints) {
        const n = document.querySelector(sel);
        if (n && n.nodeType === Node.ELEMENT_NODE) {
          n.scrollIntoView({ block: 'center', behavior: 'instant' });
          await sleep(220);
          break;
        }
      }
    } catch {
      // ignore
    }
    let colorListXpath = '';
    for (const r of list) {
      if (String(r.type || '').trim() === 'main_image' && String(r.color_list_xpath || '').trim()) {
        colorListXpath = String(r.color_list_xpath).trim();
        break;
      }
    }
    if (!colorListXpath) {
      for (const r of list) {
        if (String(r.color_list_xpath || '').trim()) {
          colorListXpath = String(r.color_list_xpath).trim();
          break;
        }
      }
    }
    if (colorListXpath) {
      const clickNodes = xpathAll(colorListXpath, document);
      const first = clickNodes.find((n) => n && n.nodeType === Node.ELEMENT_NODE);
      if (!first) {
        log('速卖通：color_list_xpath 未命中节点，无法自动触发 adjust');
        return;
      }
      try {
        log('速卖通：为拉取完整 SKU JSON，将点击 color_list 首项（等同手动选色）');
        first.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(120);
        first.click();
        log('速卖通：已点击 color_list 首项，等待 adjust 约 0.8–1.5s');
        await interruptibleRandomSleepMs(800, 1500);
      } catch (e) {
        log(`速卖通：color_list 首击失败（${e && e.message ? e.message : String(e)}）`);
      }
      return;
    }
    for (const r of list) {
      if (!isColorVariantRule(r)) continue;
      if (!(r.is_variant || String(r.type || '').trim() === 'list')) continue;
      const xp = String(r.xpath || '').trim();
      if (!xp) continue;
      const nodes = xpathAll(xp, document);
      const el = nodes.find((n) => n && n.nodeType === Node.ELEMENT_NODE);
      if (!el) continue;
      try {
        log(`速卖通：为拉取完整 SKU JSON，将点击颜色列表首项（规则字段「${String(r.field || '').trim() || '颜色'}」）`);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(120);
        el.click();
        log('速卖通：已点击颜色列表首项，等待 adjust 约 0.8–1.5s');
        await interruptibleRandomSleepMs(800, 1500);
      } catch (e) {
        log(`速卖通：颜色列表首击失败（${e && e.message ? e.message : String(e)}）`);
      }
      return;
    }
    log(
      '速卖通：规则中未配置 color_list_xpath（主图）或「颜色」变体列表 XPath，无法自动触发 adjust；手动点一次颜色后再采集即可'
    );
  }

  /**
   * 单页单条：先 preparePage，再按规则 XPath 顺序写入同一行对象（无变体笛卡尔积等）。
   */
  async function scrapePlainRules(rules, _pageUrl, preClickXpath, dbg, preClickXpaths, scrollToBottom = true) {
    const doc = document;
    const log = typeof dbg === 'function' ? dbg : () => {};
    const list = Array.isArray(rules) ? rules : [];
    const row = {};

    const preList = Array.isArray(preClickXpaths)
      ? preClickXpaths.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const legacy = String(preClickXpath || '').trim();
    if (legacy && !preList.includes(legacy)) preList.push(legacy);
    log(
      `准备页面：${scrollToBottom !== false ? '已启用滚底' : '已跳过滚底'}，预处理步数=${preList.length}`
    );
    await preparePage(preList, { scrollToBottom: scrollToBottom !== false });
    log(`规则数=${list.length}（按 XPath/ShadowCSS 取值）`);

    for (let idx = 0; idx < list.length; idx++) {
      checkAbort();
      const r = list[idx];
      const xpath = String(r.xpath || '').trim();
      if (!xpath) continue;
      const cssExpr = parseCssExpr(xpath);

      const field = String(r.field || `字段_${idx + 1}`).trim() || `字段_${idx + 1}`;
      const type = String(r.type || 'field');
      const isVariant = Boolean(r.is_variant);
      const isList = isVariant || type === 'list';
      const isDesc = type === 'description';
      const isDetail = type === 'detail';
      const isMainImg = type === 'main_image';
      const isGalImg = type === 'gallery_image';

      if (isGalImg) {
        const urls = cssExpr ? await extractCssTextOrAttr(cssExpr, true) : extractTextOrAttr(doc, xpath, true);
        log(`「${field}」图 URL 命中 ${urls.length}`);
        if (cssExpr && urls.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
        row[field] = urls;
        continue;
      }

      if (isMainImg) {
        const colorListXpath = String(r.color_list_xpath || '').trim();
        if (colorListXpath) {
          const clickNodes = xpathAll(colorListXpath, doc);
          if (clickNodes.length > 0) {
            const collected = [];
            for (let ci = 0; ci < clickNodes.length; ci++) {
              checkAbort();
              const node = clickNodes[ci];
              try {
                if (node.nodeType === Node.ELEMENT_NODE) {
                  node.scrollIntoView({ block: 'center', behavior: 'instant' });
                  await sleep(80);
                  node.click();
                }
              } catch (e) {
                console.warn('[main_image] color_list 点击失败', e);
              }
              await interruptibleRandomSleepMs(500, 1000);
              const imgs = cssExpr ? await extractCssTextOrAttr(cssExpr, true) : extractTextOrAttr(doc, xpath, true);
              collected.push(imgs[0] != null ? imgs[0] : '');
            }
            row[field] = collected;
            log(`「${field}」主图：特殊 XPath 逐点 ${clickNodes.length} 次后采集字段 XPath`);
            continue;
          }
        }
        const urls = cssExpr ? await extractCssTextOrAttr(cssExpr, true) : extractTextOrAttr(doc, xpath, true);
        log(`「${field}」图 URL 命中 ${urls.length}`);
        if (cssExpr && urls.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
        row[field] = urls[0] != null ? urls[0] : '';
        continue;
      }

      if (isDesc) {
        const vals = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
        row[field] = vals;
        log(`「${field}」描述 命中 ${vals.length}`);
        if (cssExpr && vals.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
        continue;
      }

      if (isDetail) {
        const vals = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
        row[field] = vals.join('|');
        const vx = String(r.value_xpath || '').trim();
        if (vx) {
          const vvCss = parseCssExpr(vx);
          const vv = vvCss ? await extractCssTextOrAttr(vvCss, false) : extractTextOrAttr(doc, vx, false);
          row[`${field}_value_xpath`] = vv.join('|');
        }
        log(`「${field}」详情`);
        if (cssExpr && vals.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
        continue;
      }

      if (isList) {
        const nodes = cssExpr ? shadowCssAll(cssExpr) : xpathAll(xpath, doc);
        const texts = [];
        for (const el of nodes) {
          checkAbort();
          texts.push(extractListItemText(el));
        }
        const colorRule = isColorVariantRule(r);
        row[field] = colorRule
          ? dedupeColorListSuffixes(fillEmptyColorPlaceholders(texts))
          : texts;
        log(
          `「${field}」列表 节点 ${texts.length}${colorRule ? '（颜色：img→alt，空→color-n，重复加后缀）' : ''}`
        );
        continue;
      }

      // field / table / 其它：文本拼接为一条字符串
      const vals = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
      row[field] = joinScalarFieldVals(vals);
      log(`「${field}」字段 命中 ${vals.length}`);
      if (cssExpr && vals.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
    }

    checkAbort();
    return [row];
  }

  /** JSON SKU 成功后补采商品基础信息：跳过变体列表与主图点击，避免 JSON SKU 被 XPath 旧结构覆盖。 */
  async function scrapeBaseProductRules(rules, preClickXpath, dbg, preClickXpaths, scrollToBottom = true) {
    const doc = document;
    const log = typeof dbg === 'function' ? dbg : () => {};
    const list = Array.isArray(rules) ? rules : [];
    const row = {};
    const preList = Array.isArray(preClickXpaths)
      ? preClickXpaths.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const legacy = String(preClickXpath || '').trim();
    if (legacy && !preList.includes(legacy)) preList.push(legacy);
    log(
      `JSON合并：补采基础商品字段，${scrollToBottom !== false ? '含滚底' : '跳过滚底'}，预处理步数=${preList.length}`
    );
    await preparePage(preList, { scrollToBottom: scrollToBottom !== false });

    for (let idx = 0; idx < list.length; idx++) {
      checkAbort();
      const r = list[idx];
      const xpath = String(r.xpath || '').trim();
      if (!xpath) continue;
      const field = String(r.field || `字段_${idx + 1}`).trim() || `字段_${idx + 1}`;
      const type = String(r.type || 'field');
      const isVariant = Boolean(r.is_variant);
      const isMainImg = type === 'main_image';
      if (isVariant || isMainImg || field === '颜色' || field === '尺码' || field === '尺寸' || field === '主图') {
        continue;
      }
      const cssExpr = parseCssExpr(xpath);
      const isGalImg = type === 'gallery_image';
      const isDesc = type === 'description';
      const isDetail = type === 'detail';
      if (isGalImg) {
        row[field] = cssExpr ? await extractCssTextOrAttr(cssExpr, true) : extractTextOrAttr(doc, xpath, true);
        continue;
      }
      if (isDesc) {
        row[field] = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
        continue;
      }
      if (isDetail) {
        const vals = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
        row[field] = vals.join('|');
        const vx = String(r.value_xpath || '').trim();
        if (vx) {
          const vvCss = parseCssExpr(vx);
          const vv = vvCss ? await extractCssTextOrAttr(vvCss, false) : extractTextOrAttr(doc, vx, false);
          const mergedDetail = buildDetailHtmlFromNameValueLists(vals, vv);
          if (mergedDetail) {
            row[field] = mergedDetail;
          } else {
            row[`${field}_value_xpath`] = vv.join('|');
          }
        }
        continue;
      }
      const vals = cssExpr ? await extractCssTextOrAttr(cssExpr, false) : extractTextOrAttr(doc, xpath, false);
      row[field] = joinScalarFieldVals(vals);
    }
    return row;
  }

  function uniqueNonEmpty(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      const s = String(x ?? '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  function shouldDropDetailName(nameRaw) {
    const k = String(nameRaw || '').trim();
    if (!k) return true;
    const low = k.toLowerCase().replace(/\s+/g, ' ');
    const dropEn = new Set([
      'brand name',
      'brand',
      'origin',
      'place of origin',
      'country of origin',
      'product origin',
      'made in',
      'madein',
      'cn',
      'size',
      'sizes',
      'country',
      'platforms',
      'main downstream platforms',
      'color',
      'in stock',
      'stock type',
      'suitable for',
      'error range',
      'item no',
      'article number',
    ]);
    if (dropEn.has(low)) return true;
    if (low.startsWith('size') || low.startsWith('brand')) return true;
    const dropCnSubstrings = [
      '品牌',
      '尺码',
      '跨境',
      '质检',
      '货源',
      '货号',
      '颜色',
      '平台',
      '年份',
      '季节',
      '淘货',
      '销售',
      '地区',
      '库存',
      '授权',
      '专供',
      '设计货源',
      '报告',
      '误差',
      '上市',
      '吊牌',
      '领标',
      '衣长',
    ];
    return dropCnSubstrings.some((sub) => k.includes(sub));
  }

  function buildDetailHtmlFromNameValueLists(namesRaw, valuesRaw) {
    const names = Array.isArray(namesRaw) ? namesRaw : String(namesRaw || '').split('|');
    const values = Array.isArray(valuesRaw) ? valuesRaw : String(valuesRaw || '').split('|');
    const n = Math.min(names.length, values.length);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const name = String(names[i] ?? '').trim();
      const value = String(values[i] ?? '').trim();
      if (shouldDropDetailName(name) || !value) continue;
      parts.push(`${name}: ${value}`);
    }
    return parts.join('<br>');
  }

  function mergeBaseProductAndJsonSku(baseProduct, jsonRows, skuAxes, legacyMeta) {
    const base = baseProduct && typeof baseProduct === 'object' && !Array.isArray(baseProduct) ? { ...baseProduct } : {};
    const children = (Array.isArray(jsonRows) ? jsonRows : [])
      .filter((r) => r && r['父子关系'] === 'child')
      .map((r) => ({ ...r, 价格: '' }));
    const colors = uniqueNonEmpty(
      legacyMeta && Array.isArray(legacyMeta.colors)
        ? legacyMeta.colors
        : skuAxes && Array.isArray(skuAxes.colors)
          ? skuAxes.colors
          : children.map((r) => r['颜色'])
    );
    const sizes = uniqueNonEmpty(
      legacyMeta && Array.isArray(legacyMeta.sizes)
        ? legacyMeta.sizes
        : skuAxes && Array.isArray(skuAxes.sizes)
          ? skuAxes.sizes
          : children.map((r) => r['尺码'] ?? r['尺寸'])
    );
    const mains = [];
    const byColor = new Map();
    children.forEach((r) => {
      const c = String(r['颜色'] ?? '').trim();
      const m = String(r['主图'] ?? '').trim();
      if (c && m && !byColor.has(c)) byColor.set(c, m);
    });
    colors.forEach((c, i) => {
      const m =
        String(
          (legacyMeta && Array.isArray(legacyMeta.mains)
            ? legacyMeta.mains[i]
            : skuAxes && Array.isArray(skuAxes.mains)
              ? skuAxes.mains[i]
              : '') || ''
        ).trim() ||
        String(byColor.get(c) || '').trim();
      if (m) mains.push(m);
    });
    const mainImages = mains;
    const finalRow = {
      ...base,
      颜色: colors.length > 0 ? colors : (Array.isArray(base['颜色']) ? base['颜色'] : []),
      尺码: sizes.length > 0 ? sizes : (Array.isArray(base['尺码']) ? base['尺码'] : []),
      主图: mainImages.length > 0 ? mainImages : (Array.isArray(base['主图']) ? base['主图'] : []),
      价格: base['价格'] || '',
    };
    const productView = {
      标题: finalRow['标题'] || '',
      颜色: finalRow['颜色'] || [],
      尺码: finalRow['尺码'] || [],
      主图: finalRow['主图'] || [],
      副图: finalRow['副图'] || [],
      详情: finalRow['详情'] || '',
      价格: finalRow['价格'] || '',
      详情图: finalRow['详情图'] || [],
    };
    try {
      debugLog('[1688 SKU] colors:', colors);
      debugLog('[MAIN IMAGES]', mainImages);
      debugLog('[FINAL ROW 主图]', finalRow['主图']);
    } catch {
      // ignore
    }
    const parent = {
      父子关系: 'parent',
      标题: base['标题'] || '',
      价格: base['价格'] || '',
      副图: base['副图'] || [],
      详情: base['详情'] || '',
      ...(base['详情_value_xpath'] != null ? { 详情_value_xpath: base['详情_value_xpath'] } : {}),
      详情图: base['详情图'] || [],
      basePrice: base['价格'] || '',
    };
    const skuView = [parent, ...children];
    return { productView, skuView };
  }

  /**
   * 速卖通 legacy JSON 与 XPath 单行上报结构对齐：相同字段名、类型（数组/字符串）、书写顺序。
   */
  function coerceStringArray(v) {
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (v == null || v === '') return [];
    const s = String(v).trim();
    return s ? [s] : [];
  }
  function coerceStr(v, fb = '') {
    return String(v != null && v !== '' ? v : fb).trim();
  }
  function buildAliExpressLegacyJsonProductView(baseProduct, jsonRow) {
    const b = baseProduct && typeof baseProduct === 'object' && !Array.isArray(baseProduct) ? baseProduct : {};
    const j = jsonRow && typeof jsonRow === 'object' && !Array.isArray(jsonRow) ? jsonRow : {};
    const pickArr = (primary, secondary) => {
      if (Array.isArray(primary) && primary.length) return primary;
      if (Array.isArray(secondary) && secondary.length) return secondary;
      return coerceStringArray(primary ?? secondary);
    };
    const out = {
      标题: coerceStr(b['标题'] || j['标题']),
      颜色: pickArr(j['颜色'], b['颜色']),
      尺码: pickArr(j['尺码'], b['尺码']),
      主图: pickArr(j['主图'], b['主图']),
      副图: pickArr(b['副图'], j['副图']),
      描述: pickArr(b['描述'], j['描述']),
      详情: coerceStr(b['详情'] || j['详情']),
      详情图: pickArr(b['详情图'], j['详情图']),
      价格: coerceStr(b['价格']),
    };
    if (b['详情_value_xpath'] != null) out['详情_value_xpath'] = b['详情_value_xpath'];
    return out;
  }

  const PLATFORM_ALIEXPRESS = 'aliexpress';
  const PLATFORM_ALIBABA1688 = 'alibaba1688';

  function resolvePlatformKey(raw) {
    const s = String(raw || '')
      .trim()
      .toLowerCase();
    if (!s) return PLATFORM_ALIEXPRESS;
    if (s === PLATFORM_ALIEXPRESS || s === 'ae' || s === 'smt') return PLATFORM_ALIEXPRESS;
    if (s.includes('速卖')) return PLATFORM_ALIEXPRESS;
    if (
      s === PLATFORM_ALIBABA1688 ||
      s === '1688' ||
      s === 'cbu' ||
      s.includes('1688') ||
      s.includes('阿里巴巴') ||
      s.includes('阿里') ||
      (s.includes('alibaba') && !s.includes('aliexpress'))
    ) {
      return PLATFORM_ALIBABA1688;
    }
    throw new Error(
      '不支持的平台「' +
        String(raw).trim() +
        '」。请填写：速卖通 / ' +
        PLATFORM_ALIEXPRESS +
        '，或 1688 / 阿里巴巴 / ' +
        PLATFORM_ALIBABA1688
    );
  }

  let PLATFORM_SCRAPERS = null;

  function getPlatformScrapers() {
    if (!PLATFORM_SCRAPERS) {
      PLATFORM_SCRAPERS = {
        [PLATFORM_ALIEXPRESS]: scrapePlainRules,
        [PLATFORM_ALIBABA1688]: scrapePlainRules,
      };
    }
    return PLATFORM_SCRAPERS;
  }

  async function dispatchScrapeByPlatform(platformKey, rules, pageUrl, preClickXpath, dbg, preClickXpaths, scrollToBottom = true) {
    const scrapers = getPlatformScrapers();
    const fn = scrapers[platformKey];
    if (typeof fn !== 'function') throw new Error('采集管线未注册：' + platformKey);
    return fn(rules, pageUrl, preClickXpath, dbg, preClickXpaths, scrollToBottom);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ABORT') {
      abortRequested = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'RUN_SCRAPE') {
      abortRequested = false;
      (async () => {
        try {
          const rules = msg.rules || [];
          const pre = msg.pre_click_xpath || '';
          const preList = Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [];
          const url = msg.url || location.href;
          const mode = String(msg.scrapeMode || 'xpath').trim().toLowerCase();
          const scrollToBottom = msg.scroll_to_bottom !== false;
          let platformKey = '';
          let platformResolveError = null;
          try {
            platformKey = resolvePlatformKey(msg.platform);
          } catch (e) {
            platformResolveError = e;
            platformKey = String(msg.platform || 'json').trim() || 'json';
          }
          const debugLogs = [];
          const dbg = (m) => {
            if (debugLogs.length > 500) return;
            debugLogs.push(String(m));
          };
          /** @type {string[]} */
          let jsonAttemptLines = [];
          const safeJson = (obj) => {
            try {
              return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
            } catch {
              try {
                return String(obj);
              } catch {
                return '[unstringifiable]';
              }
            }
          };
          dbg(`平台=${platformKey}`);
          if (platformResolveError && mode === 'xpath') throw platformResolveError;
          const isAliExpressPage =
            platformKey === PLATFORM_ALIEXPRESS || String(location.host || '').toLowerCase().includes('aliexpress');
          if (isAliExpressPage && (mode === 'json' || mode === 'smart')) {
            dbg('速卖通：尝试 SKU JSON 识别，失败后转入模拟采集');
          }
          /** 速卖通：在「点首色拉 adjust」之前快照基础 XPath（含价格），避免合并时页面已是 SKU 价与纯 XPath 模拟采集不一致 */
          let aeBaseProductBeforeColorPrime = null;
          if (mode === 'json' || mode === 'smart') {
            if (isAliExpressPage) {
              try {
                dbg('速卖通：选色触发 adjust 前先补采基础字段（含价格），与未切换 SKU 时 XPath 一致');
                aeBaseProductBeforeColorPrime = await scrapeBaseProductRules(rules, pre, dbg, preList, scrollToBottom);
              } catch (e) {
                dbg(`速卖通：选色前补采失败（合并时将再试）：${e && e.message ? e.message : String(e)}`);
              }
              await aeTryPrimeAdjustRequest(rules, dbg);
              dbg('速卖通：等待 mtop 数据同步到采集桥接（首次最长约 10s）…');
              await waitForAliExpressMtopBridge(dbg, 10000, 180);
            }
            const jsonDetect = window.__skuJsonDetect && window.__skuJsonDetect.detect;
            if (typeof jsonDetect === 'function') {
              const rulesForJson = Array.isArray(msg.skuDetectRules) ? msg.skuDetectRules : [];
              let got = jsonDetect(rulesForJson, msg.platform);
              const mergeJsonAttempts = (g) => {
                try {
                  const atts = g && Array.isArray(g.attempts) ? g.attempts : [];
                  const lines = atts.slice(0, 120).map((a) => `JSON尝试：${safeJson(a)}`);
                  if (atts.length > 120) lines.push(`JSON尝试：… 还有 ${atts.length - 120} 条`);
                  return lines;
                } catch {
                  return [];
                }
              };
              jsonAttemptLines = mergeJsonAttempts(got);
              if (
                isAliExpressPage &&
                (!got || !got.ok) &&
                (mode === 'smart' || mode === 'json')
              ) {
                dbg('速卖通：首检 JSON 未命中，等待 2.8s 后重试（首包 query/adjust 常晚于首屏）');
                await sleep(2800);
                await waitForAliExpressMtopBridge(dbg, 6500, 160);
                const got2 = jsonDetect(rulesForJson, msg.platform);
                const lines2 = mergeJsonAttempts(got2);
                if (lines2.length) {
                  jsonAttemptLines = jsonAttemptLines.concat(['JSON尝试：[速卖通二次检测]'].concat(lines2)).slice(0, 200);
                }
                if (got2 && got2.ok) got = got2;
              }
              if (got && got.ok && Array.isArray(got.rows) && got.rows.length > 0 && (got.legacyProductRows || got.rows.length > 1)) {
                const baseProduct =
                  aeBaseProductBeforeColorPrime && typeof aeBaseProductBeforeColorPrime === 'object'
                    ? aeBaseProductBeforeColorPrime
                    : await scrapeBaseProductRules(rules, pre, dbg, preList, scrollToBottom);
                let productView = null;
                if (got.legacyProductRows) {
                  const jsonRow = got.rows[0] && typeof got.rows[0] === 'object' ? got.rows[0] : {};
                  try {
                    productView = buildAliExpressLegacyJsonProductView(baseProduct, jsonRow);
                  } catch (e) {
                    dbg(`JSON合并异常（已降级为浅合并）：${e && e.message ? e.message : String(e)}`);
                    const b0 = baseProduct && typeof baseProduct === 'object' && !Array.isArray(baseProduct) ? baseProduct : {};
                    productView = { ...b0, ...jsonRow, 价格: b0['价格'] || '' };
                  }
                } else {
                  const merged = mergeBaseProductAndJsonSku(baseProduct, got.rows, got.sku_axes || null, got.legacyProductMeta || null);
                  productView = merged.productView;
                }
                dbg(
                  `JSON采集成功：规则=${got.ruleName || '—'}，来源=${got.source || '—'}，路径=${got.path || '—'}，SKU=${got.rawCount || Math.max(0, got.rows.length - 1)}`
                );
                dbg('JSON合并：标题/副图/详情/详情图/价格来自 XPath；颜色/尺码/主图/SKU 来自 JSON（JSON 不含价）');
                const aeSku = got.aliexpressSkuData;
                const aeDbg = aeSku && aeSku._debug;
                if (aeDbg) {
                  dbg('[AE SKU] 命中 mtop AliExpress PDP（query/adjust 等）：是');
                  dbg(`[AE SKU] JSONP 解析成功：${aeDbg.jsonpParsed !== false ? '是' : '否'}`);
                  dbg(`[AE SKU] 提取 skuId 数量：${Number(aeDbg.skuIdCount) || 0}`);
                  dbg(`[AE SKU] 是否提取到 skuImagesMap：${aeDbg.hasSkuImagesMap ? '是' : '否'}`);
                  dbg(`[AE SKU] 是否提取到 skuPriceList：${aeDbg.hasSkuPriceList ? '是' : '否'}`);
                  dbg(`[AE SKU] 是否提取到 skuPropertyList：${aeDbg.hasSkuPropertyList ? '是' : '否'}`);
                }
                sendResponse({
                  ok: true,
                  rows: [productView],
                  ...(got.aliexpressSkuData ? { aliexpressSkuData: got.aliexpressSkuData } : {}),
                  platformKey,
                  scrapeMode: 'json',
                  logs: debugLogs.concat(jsonAttemptLines),
                });
                return;
              }
              dbg(`JSON采集失败：${got && got.error ? got.error : '未命中'}`);
              // 智能采集降级到 xpath 时也保留 JSON attempts，方便定位为何未命中数据源
              for (const line of jsonAttemptLines) dbg(line);
              if (mode === 'json') {
                sendResponse({
                  ok: false,
                  error: got && got.error ? got.error : 'JSON 采集未识别到 SKU 数据',
                  platformKey,
                  scrapeMode: 'json',
                  logs: debugLogs.concat(jsonAttemptLines),
                });
                return;
              }
              if (platformResolveError) throw platformResolveError;
              dbg('智能采集：转入模拟 XPath/点击兜底');
            } else if (mode === 'json') {
              sendResponse({ ok: false, error: 'JSON 识别引擎未加载', platformKey, scrapeMode: 'json', logs: debugLogs });
              return;
            }
          }
          if (platformResolveError) throw platformResolveError;
          const rows = await dispatchScrapeByPlatform(platformKey, rules, url, pre, dbg, preList, scrollToBottom);
          sendResponse({
            ok: true,
            rows,
            platformKey,
            scrapeMode: mode === 'smart' ? 'xpath-fallback' : 'xpath',
            logs: debugLogs.concat(mode === 'smart' ? jsonAttemptLines : []),
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }
  });
})();
