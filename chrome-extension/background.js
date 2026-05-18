let batchStopRequested = false;
let currentBatchTabId = null;

/** 网络 Hook 上报环形缓冲（供排障；不持久化） */
const NET_SKU_HOOK_RING = [];
const NET_SKU_HOOK_RING_MAX = 120;

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FLOATING_PANEL' }).catch(async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['content_overlay.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_FLOATING_PANEL' });
    } catch {}
  });
});

/** 写入浮层面板采集日志（忽略失败：面板未注入等） */
function floatLog(tabId, line) {
  if (tabId == null || !line) return;
  chrome.tabs.sendMessage(tabId, { type: 'FLOAT_LOG', line: String(line) }).catch(() => {});
}

/**
 * 等待标签页主框架导航完成（Chrome status === complete）。
 * 若当前已是 complete（例如单页本就在当前页点采集），立即继续，避免永远等不到 onUpdated。
 */
function waitTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, 120000);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => resolve(), 800);
    }
    function listener(id, info) {
      if (done) return;
      if (id === tabId && info.status === 'complete') {
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (done) return;
      if (tab.status === 'complete') {
        finish();
      }
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('无法读取标签页'));
    });
  });
}

function nowChinaIso() {
  const ms = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

async function apiPostCollection(apiBase, token, payload) {
  const base = String(apiBase || '').replace(/\/$/, '') || 'https://ai.dokor.cn';
  const res = await fetch(`${base}/api/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || res.statusText || '上报失败');
  }
  return data;
}

async function apiFetchJson(apiBase, path, options = {}, token = '') {
  const base = String(apiBase || '').replace(/\/$/, '') || 'https://ai.dokor.cn';
  const p = String(path || '');
  if (!p.startsWith('/')) throw new Error('API path 必须以 / 开头');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || res.statusText || '请求失败');
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function injectEngine(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    files: ['platforms/aliexpress/skuExtractor.js'],
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: 'MAIN',
    func: () => {
      try {
        const BRIDGE_ID = '__ai_sku_json_bridge__';
        const AE_CAPTURE_KEY = '__ai_ae_sku_capture__';
        let timer = null;
        let tries = 0;
        const parseJsonIfString = (v) => {
          if (typeof v !== 'string') return v;
          const s = v.trim();
          if (!s || !/^[\[{]/.test(s)) return v;
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        };
        const extractBalancedAt = (text, start) => {
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
            if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
            if (ch === open) depth += 1;
            if (ch === close) depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
          }
          return null;
        };
        const deepFindFirst = (root, predicate, maxDepth = 10) => {
          const seen = new WeakSet();
          const walk = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > maxDepth) return null;
            if (seen.has(node)) return null;
            seen.add(node);
            try {
              if (predicate(node)) return node;
            } catch {
              // ignore
            }
            const vals = Array.isArray(node) ? node.slice(0, 80) : Object.values(node);
            for (const child of vals) {
              const got = walk(child, depth + 1);
              if (got) return got;
            }
            return null;
          };
          return walk(root, 0);
        };
        const tryExtractJsonNear = (textRaw, keywordLower) => {
          const text = String(textRaw || '');
          if (!text) return null;
          const lower = text.toLowerCase();
          const hit = lower.indexOf(keywordLower);
          if (hit < 0) return null;
          const backStart = Math.max(0, hit - 200000);
          const back = text.slice(backStart, hit + 1);
          let bracePos = -1;
          for (let i = back.length - 1; i >= 0; i--) {
            const ch = back[i];
            if (ch === '{' || ch === '[') {
              bracePos = backStart + i;
              break;
            }
          }
          if (bracePos < 0) return null;
          const jsonText = extractBalancedAt(text, bracePos);
          if (!jsonText) return null;
          return parseJsonIfString(jsonText);
        };
        const tryExtractSkuPartsFromText = (textRaw) => {
          const text = String(textRaw || '');
          if (!text) return null;
          const lower = text.toLowerCase();
          if (!lower.includes('skuproperties') && !lower.includes('skupaths')) return null;
          const parsedA = lower.includes('skuproperties') ? tryExtractJsonNear(text, 'skuproperties') : null;
          const parsedB = lower.includes('skupaths') ? tryExtractJsonNear(text, 'skupaths') : null;
          const parsed = (parsedA && typeof parsedA === 'object') ? parsedA : (parsedB && typeof parsedB === 'object') ? parsedB : null;
          if (!parsed || typeof parsed !== 'object') return null;

          const propsNode = deepFindFirst(parsed, (o) => Array.isArray(o?.skuProperties) && o.skuProperties.length > 0, 10);
          const skuNode = deepFindFirst(parsed, (o) => o?.SKU && Array.isArray(o.SKU?.skuPaths) && o.SKU.skuPaths.length > 0, 10);
          const props = propsNode && Array.isArray(propsNode.skuProperties) ? propsNode.skuProperties : null;
          const skuPaths = skuNode && skuNode.SKU && Array.isArray(skuNode.SKU.skuPaths) ? skuNode.SKU.skuPaths : null;

          const out = {};
          if (props) out.skuProperties = props;
          if (skuPaths) out.SKU = { skuPaths };
          return Object.keys(out).length ? out : null;
        };
        const isSkuModelLike = (obj) => {
          if (!obj || typeof obj !== 'object') return false;
          if (obj.skuProps && obj.skuInfoMap) return true;
          const sm = parseJsonIfString(obj.skuModel);
          return !!(sm && typeof sm === 'object' && sm.skuProps && sm.skuInfoMap);
        };
        const isAliSkuLike = (obj) => {
          if (!obj || typeof obj !== 'object') return false;
          const sku = obj.SKU && typeof obj.SKU === 'object' ? obj.SKU : null;
          const paths = Array.isArray(sku?.skuPaths) ? sku.skuPaths : [];
          const props = Array.isArray(obj?.skuProperties) ? obj.skuProperties : Array.isArray(sku?.skuProperties) ? sku.skuProperties : [];
          return paths.length > 0 && props.length > 0;
        };
        const looksLikeAliExpressHost = () => String(location.host || '').toLowerCase().includes('aliexpress');
        const aeTopWindow = () => {
          try {
            if (window.top && window.top !== window) {
              void window.top.document;
              return window.top;
            }
          } catch {
            // cross-origin top
          }
          return window;
        };
        const aeBridgeDocument = () => {
          try {
            const tw = aeTopWindow();
            if (tw && tw.document) return tw.document;
          } catch {
            // ignore
          }
          return document;
        };
        const ensureAliExpressNetworkCapture = () => {
          try {
            if (window.__aliExpressSkuExtractor && typeof window.__aliExpressSkuExtractor.installNetworkCapture === 'function') {
              window.__aliExpressSkuExtractor.installNetworkCapture();
            }
          } catch {
            // ignore
          }
        };
        const pickDataJsonCandidate = () => {
          // AliExpress：优先抓取 SKU.skuPaths + skuProperties（隔离世界读不到，必须通过 bridge）
          if (looksLikeAliExpressHost()) {
            if (window.__AI_AE_SKU_DATA__ && typeof window.__AI_AE_SKU_DATA__ === 'object') {
              const v = window.__AI_AE_SKU_DATA__;
              if (isAliSkuLike(v)) return v;
            }
            const candidates = [
              window,
              window.SKU,
              window.runParams,
              window.__INITIAL_STATE__,
              window.__NEXT_DATA__,
              window.__NUXT__,
            ];
            for (const raw of candidates) {
              const v = parseJsonIfString(raw);
              if (!v || typeof v !== 'object') continue;
              if (isAliSkuLike(v)) return v;
              const deep = deepFindFirst(v, isAliSkuLike, 12);
              if (deep) return deep;
              // 常见：runParams 里嵌套 data / SKU
              const vals = Object.values(v);
              for (const child of vals) {
                const c = parseJsonIfString(child);
                if (c && typeof c === 'object' && isAliSkuLike(c)) return c;
                if (c && typeof c === 'object') {
                  const deepChild = deepFindFirst(c, isAliSkuLike, 10);
                  if (deepChild) return deepChild;
                }
              }
            }
            for (const s of Array.from(document.scripts || [])) {
              const text = String(s.textContent || '');
              if (!text || !text.includes('skuProperties') || !text.includes('skuPaths')) continue;
              const extracted = tryExtractSkuPartsFromText(text);
              if (extracted && isAliSkuLike(extracted)) return extracted;
            }
          }

          // 1688 等：优先 context.fields.dataJson，其次直接 context，其它全局作兜底
          const candidates = [
            window.context?.result?.data?.Root?.fields?.dataJson,
            window.context?.result?.data?.Root?.fields,
            window.context?.result?.data?.Root,
            window.context,
            window.__INITIAL_STATE__,
            window.__NEXT_DATA__,
            window.__NUXT__,
            window.runParams,
          ];
          for (const raw of candidates) {
            const v = parseJsonIfString(raw);
            if (!v || typeof v !== 'object') continue;
            // 若本身就是 skuModelLike（含 skuProps/skuInfoMap），直接用
            if (isSkuModelLike(v)) return v;
            // 常见字段：fields.dataJson / dataJson
            const f = v?.fields && typeof v.fields === 'object' ? v.fields : null;
            const dj1 = parseJsonIfString(f?.dataJson);
            if (dj1 && typeof dj1 === 'object' && (isSkuModelLike(dj1) || dj1.images || dj1.gallery || dj1.mainImage)) {
              return dj1;
            }
            const dj2 = parseJsonIfString(v?.dataJson);
            if (dj2 && typeof dj2 === 'object' && (isSkuModelLike(dj2) || dj2.images || dj2.gallery || dj2.mainImage)) {
              return dj2;
            }
          }
          return null;
        };
        const syncBridge = () => {
          tries += 1;
          ensureAliExpressNetworkCapture();
          const dataJson = pickDataJsonCandidate();
          const isAe = looksLikeAliExpressHost();
          const tw = aeTopWindow();
          const aeMtop =
            tw.__AI_AE_MTOP_SKU_DATA__ && typeof tw.__AI_AE_MTOP_SKU_DATA__ === 'object'
              ? tw.__AI_AE_MTOP_SKU_DATA__
              : null;
          const aeResponses = Array.isArray(tw.__AI_AE_MTOP_RESPONSES__) ? tw.__AI_AE_MTOP_RESPONSES__.slice(-20) : [];
          const aeHasNetworkSku = !!(aeMtop || aeResponses.length > 0);
          // 仅有 mtop 抓包、页面上已无 skuPaths/skuProperties 时，pickDataJsonCandidate 会返回 null；
          // 若此处直接 return false，隔离世界的 JSON 检测永远读不到 __aliExpressMtopSkuData。
          if (!dataJson || typeof dataJson !== 'object') {
            if (!(isAe && aeHasNetworkSku)) return false;
          }
          const effectiveDataJson = dataJson && typeof dataJson === 'object' ? dataJson : {};
          const aliSku =
            effectiveDataJson && typeof effectiveDataJson === 'object' && effectiveDataJson.SKU && typeof effectiveDataJson.SKU === 'object'
              ? effectiveDataJson.SKU
              : null;
          const aliSkuProps =
            effectiveDataJson && typeof effectiveDataJson === 'object'
              ? effectiveDataJson.skuProperties || (aliSku ? aliSku.skuProperties : null)
              : null;
          // 关键：bridge 必须兼容规则 windowPaths（大量规则使用 window.context...）。
          // content script 的隔离世界无法直接读取 window.context，因此这里用 DOM bridge 提供同构路径。
          const payload = {
            // AliExpress：让 windowPaths 里的 window.SKU / window.skuProperties 在 bridge 上可直接读取
            SKU: aliSku || (effectiveDataJson && typeof effectiveDataJson === 'object' ? effectiveDataJson.SKU : null),
            skuProperties: aliSkuProps,
            context: {
              result: {
                data: {
                  Root: {
                    fields: {
                      dataJson: effectiveDataJson,
                    },
                  },
                },
              },
            },
            // 额外再放一份便于诊断/兼容其它路径（不依赖 context）
            result: {
              data: {
                Root: {
                  fields: {
                    dataJson: effectiveDataJson,
                  },
                },
              },
            },
            __jsonCapturedResponses: aeResponses,
            __aliExpressMtopSkuData: aeMtop,
          };
          const text = JSON.stringify(payload);
          const hostDoc = aeBridgeDocument();
          let el = hostDoc.getElementById(BRIDGE_ID);
          if (!el) {
            el = hostDoc.createElement('script');
            el.id = BRIDGE_ID;
            el.type = 'application/json';
            (hostDoc.documentElement || hostDoc.head || hostDoc.body || hostDoc).appendChild(el);
          }
          el.textContent = text;
          el.setAttribute('data-ai-sku-json-bridge', '1');
          return true;
        };
        if (syncBridge()) return;
        timer = setInterval(() => {
          if (syncBridge() || tries >= 60) {
            if (timer) clearInterval(timer);
          }
        }, 100);
        setTimeout(() => {
          if (timer) clearInterval(timer);
        }, 6500);
      } catch {
        // ignore
      }
    },
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['sku_json_engine.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['engine.js'],
  });
  await new Promise((r) => setTimeout(r, 120));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'NET_SKU_HOOK') {
    try {
      NET_SKU_HOOK_RING.push({
        tabId: sender.tab?.id,
        pageUrl: String(msg.pageUrl || ''),
        receivedAt: Date.now(),
        payload: msg.payload,
      });
      if (NET_SKU_HOOK_RING.length > NET_SKU_HOOK_RING_MAX) {
        NET_SKU_HOOK_RING.splice(0, NET_SKU_HOOK_RING.length - NET_SKU_HOOK_RING_MAX);
      }
    } catch {
      // ignore
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'API_FETCH') {
    (async () => {
      try {
        const data = await apiFetchJson(msg.apiBase, msg.path, msg.options || {}, msg.token || '');
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'RUN_SCRAPE') {
    (async () => {
      try {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: '缺少 tabId' });
          return;
        }
        const modeLabel = msg.scrapeMode === 'xpath' ? '模拟采集' : '智能采集';
        floatLog(tabId, `${modeLabel}：正在等待页面加载完毕…`);
        await waitTabComplete(tabId);
        floatLog(tabId, `${modeLabel}：页面已加载完毕，开始执行采集。`);
        await injectEngine(tabId);
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'RUN_SCRAPE',
          rules: msg.rules,
          pre_click_xpath: msg.pre_click_xpath || '',
          pre_click_xpaths: Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [],
          url: msg.url || '',
          platform: msg.platform != null ? String(msg.platform) : '',
          scrapeMode: msg.scrapeMode || 'xpath',
          skuDetectRules: Array.isArray(msg.skuDetectRules) ? msg.skuDetectRules : [],
          scroll_to_bottom: msg.scroll_to_bottom !== false,
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  // 导航到指定 URL 后再采集：用于批量采集队列
  if (msg.type === 'RUN_SCRAPE_ON_URL') {
    (async () => {
      try {
        const tabId = msg.tabId || sender?.tab?.id;
        const u = String(msg.url || '').trim();
        if (!tabId) {
          sendResponse({ ok: false, error: '缺少 tabId' });
          return;
        }
        if (!u) {
          sendResponse({ ok: false, error: '缺少 url' });
          return;
        }
        await chrome.tabs.update(tabId, { url: u, active: true });
        floatLog(tabId, '正在等待页面加载完毕…');
        await waitTabComplete(tabId);
        floatLog(tabId, '页面已加载完毕，开始执行采集。');
        await injectEngine(tabId);
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'RUN_SCRAPE',
          rules: msg.rules,
          pre_click_xpath: msg.pre_click_xpath || '',
          pre_click_xpaths: Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [],
          url: u,
          platform: msg.platform != null ? String(msg.platform) : '',
          scrapeMode: msg.scrapeMode || 'xpath',
          skuDetectRules: Array.isArray(msg.skuDetectRules) ? msg.skuDetectRules : [],
          scroll_to_bottom: msg.scroll_to_bottom !== false,
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ABORT_SCRAPE') {
    (async () => {
      try {
        const tabId = msg.tabId;
        if (!tabId) {
          sendResponse({ ok: false });
          return;
        }
        await chrome.tabs.sendMessage(tabId, { type: 'ABORT' }).catch(() => {});
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'STOP_BATCH_QUEUE') {
    batchStopRequested = true;
    if (currentBatchTabId != null) {
      chrome.tabs.sendMessage(currentBatchTabId, { type: 'ABORT' }).catch(() => {});
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RUN_BATCH_QUEUE') {
    (async () => {
      const urls = Array.isArray(msg.urls) ? msg.urls.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const rules = Array.isArray(msg.rules) ? msg.rules : [];
      const pre = Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [];
      const platform = msg.platform != null ? String(msg.platform) : '';
      const apiBase = String(msg.apiBase || '').replace(/\/$/, '') || 'https://ai.dokor.cn';
      const token = String(msg.token || '');
      const imagesStorage = String(msg.imagesStorage || '').toLowerCase() === 'oss' ? 'oss' : 'local';
      const skuDetectRules = Array.isArray(msg.skuDetectRules) ? msg.skuDetectRules : [];
      const skuRulesByUrl = msg.skuRulesByUrl && typeof msg.skuRulesByUrl === 'object' ? msg.skuRulesByUrl : {};
      const batchScrollToBottom = msg.scroll_to_bottom !== false;
      const globalOffset = Math.max(0, Math.floor(Number(msg.globalOffset) || 0));
      const globalTotal = Math.max(urls.length, Math.floor(Number(msg.globalTotal) || urls.length));
      const globalOkBase = Math.max(0, Math.floor(Number(msg.globalOkBase) || 0));
      const globalFailBase = Math.max(0, Math.floor(Number(msg.globalFailBase) || 0));
      const sourceTabId = sender?.tab?.id || msg.tabId || null;
      let tabId = null;
      let ok = 0;
      let fail = 0;
      const errors = [];
      const emitProgress = (i, state, extra = {}) => {
        if (!sourceTabId) return;
        chrome.tabs.sendMessage(sourceTabId, {
          type: 'BATCH_PROGRESS',
          i: globalOffset + i,
          n: globalTotal,
          ok: globalOkBase + ok,
          fail: globalFailBase + fail,
          state,
          ...extra,
        }).catch(() => {});
      };
      try {
        batchStopRequested = false;
        currentBatchTabId = null;
        if (!urls.length) throw new Error('批量链接为空');
        for (let i = 0; i < urls.length; i++) {
          if (batchStopRequested) break;
          const url = urls[i];
          try {
            emitProgress(i + 1, 'opening');
            if (!tabId) {
              const tab = await chrome.tabs.create({ url, active: true });
              tabId = tab.id;
              currentBatchTabId = tabId;
            } else {
              await chrome.tabs.update(tabId, { url, active: true });
              currentBatchTabId = tabId;
            }
            const linkNo = globalOffset + i + 1;
            floatLog(
              sourceTabId,
              `正在采集第 ${linkNo} 条链接（共 ${globalTotal} 条），等待页面加载完毕…`
            );
            await waitTabComplete(tabId);
            floatLog(
              sourceTabId,
              `正在采集第 ${linkNo} 条链接（共 ${globalTotal} 条），页面已加载完毕，开始采集。`
            );
            if (batchStopRequested) break;
            await injectEngine(tabId);
            const skuRulesForUrl = Array.isArray(skuRulesByUrl[url]) ? skuRulesByUrl[url] : skuDetectRules;
            emitProgress(i + 1, 'scraping');
            const result = await chrome.tabs.sendMessage(tabId, {
              type: 'RUN_SCRAPE',
              rules,
              pre_click_xpath: pre[0] || '',
              pre_click_xpaths: pre,
              url,
              platform,
              scrapeMode: 'smart',
              skuDetectRules: skuRulesForUrl,
              scroll_to_bottom: batchScrollToBottom,
            });
            if (!result || !result.ok) throw new Error((result && result.error) || '采集失败');
            const rows = Array.isArray(result.rows) ? result.rows : [];
            emitProgress(i + 1, 'uploading');
            await apiPostCollection(apiBase, token, {
              platform,
              url,
              collectedAt: nowChinaIso(),
              rows,
              imagesStorage,
            });
            ok += 1;
            emitProgress(i + 1, 'done');
            if (i < urls.length - 1 && !batchStopRequested) await sleep(500 + Math.floor(Math.random() * 1200));
          } catch (e) {
            fail += 1;
            errors.push({ url, error: e?.message || String(e) });
            emitProgress(i + 1, 'failed', { error: e?.message || String(e) });
          }
        }
        sendResponse({ ok: true, success: ok, failed: fail, stopped: batchStopRequested, errors });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e), success: ok, failed: fail, errors });
      } finally {
        currentBatchTabId = null;
      }
    })();
    return true;
  }
});
