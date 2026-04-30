/**
 * 内容脚本：采集前执行「页面预处理」——整页滚动 + 可选 pre_click_xpath 点击（与采集规则配置一致）；
 * 主图：若规则含 color_list_xpath（后台「特殊 XPath」），则对该列节点逐个点击，随机等待 500–1000ms 后再用字段 XPath 取主图 src，结果为 URL 数组。
 * 其它字段取值仍仅按各规则 XPath 读取，无变体笛卡尔积、无图区切换等业务加工。
 */
(function () {
  if (window.__amzScraperEngineLoaded) return;
  window.__amzScraperEngineLoaded = true;

  let abortRequested = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
  async function preparePage(preClickXpathOrList) {
    await scrollPage();
    await interruptibleRandomSleepMs(300, 2000);
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
   * 单页单条：先 preparePage，再按规则 XPath 顺序写入同一行对象（无变体笛卡尔积等）。
   */
  async function scrapePlainRules(rules, _pageUrl, preClickXpath, dbg, preClickXpaths) {
    const doc = document;
    const log = typeof dbg === 'function' ? dbg : () => {};
    const list = Array.isArray(rules) ? rules : [];
    const row = {};

    const preList = Array.isArray(preClickXpaths)
      ? preClickXpaths.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const legacy = String(preClickXpath || '').trim();
    if (legacy && !preList.includes(legacy)) preList.push(legacy);
    log(`准备页面：滚动/等待，预处理步数=${preList.length}`);
    await preparePage(preList);
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
      row[field] = vals.length ? vals.join(' ') : '';
      log(`「${field}」字段 命中 ${vals.length}`);
      if (cssExpr && vals.length === 0) log(`  · ShadowCSS 诊断：${shadowCssExplainZero(cssExpr)}`);
    }

    checkAbort();
    return [row];
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

  async function dispatchScrapeByPlatform(platformKey, rules, pageUrl, preClickXpath, dbg, preClickXpaths) {
    const scrapers = getPlatformScrapers();
    const fn = scrapers[platformKey];
    if (typeof fn !== 'function') throw new Error('采集管线未注册：' + platformKey);
    return fn(rules, pageUrl, preClickXpath, dbg, preClickXpaths);
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
          const platformKey = resolvePlatformKey(msg.platform);
          const debugLogs = [];
          const dbg = (m) => {
            if (debugLogs.length > 500) return;
            debugLogs.push(String(m));
          };
          dbg(`平台=${platformKey}`);
          const rows = await dispatchScrapeByPlatform(platformKey, rules, url, pre, dbg, preList);
          sendResponse({ ok: true, rows, platformKey, logs: debugLogs });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }
  });
})();
