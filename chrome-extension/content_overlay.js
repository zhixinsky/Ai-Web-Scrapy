(function () {
  if (window.__aiCollectionFloatingPanelLoaded) return;
  window.__aiCollectionFloatingPanelLoaded = true;

  const STORAGE_TOKEN = 'scraper_api_token';
  const STORAGE_USER = 'scraper_user_json';
  const STORAGE_API_BASE = 'scraper_api_base';
  const STORAGE_BATCH_URLS = 'scraper_batch_urls';
  const STORAGE_IMAGES_STORAGE = 'scraper_images_storage';
  const STORAGE_FLOAT_STATE = 'scraper_float_panel_state';
  const STORAGE_SKU_RULE_CACHE_PREFIX = 'scraper_sku_detect_rules:';
  const DEFAULT_API_BASE = 'https://ai.dokor.cn';
  const SKU_RULE_CACHE_TTL_MS = 10 * 60 * 1000;
  const SKU_RULE_CACHE_VERSION = 'v4';

  let authToken = '';
  let apiBase = DEFAULT_API_BASE;
  let rulesList = [];
  let currentRuleDetail = null;
  let batchUrlsText = '';
  let busy = false;
  let sharedUiState = { panelOpen: false, batchOpen: false, logText: '', settingsOpen: false };
  let applyingSharedState = false;
  let batchSaveTimer = null;
  let batchRunning = false;

  function normalizeApiBase(v) {
    const raw = String(v || '').trim();
    return (raw || DEFAULT_API_BASE).replace(/\/$/, '');
  }

  function currentApiBase() {
    const input = $('#apiBase');
    if (input) {
      apiBase = normalizeApiBase(input.value);
      chrome.storage.local.set({ [STORAGE_API_BASE]: String(input.value || '').trim() }).catch(() => {});
    }
    return apiBase;
  }

  function hostFromUrl(url) {
    try {
      return new URL(String(url || '')).host.toLowerCase();
    } catch {
      return '';
    }
  }

  function platformMatchesHost(platformRaw, hostRaw) {
    const host = String(hostRaw || '').toLowerCase();
    const p = String(platformRaw || '').toLowerCase();
    if (!host || !p) return false;
    if (p.includes('1688') && host.includes('1688.com')) return true;
    if ((p.includes('速卖') || p.includes('aliexpress')) && host.includes('aliexpress')) return true;
    if (p.includes('alibaba') && host.includes('alibaba.com') && !host.includes('aliexpress')) return true;
    return host.includes(p) || p.includes(host.replace(/^www\./, ''));
  }

  function pickRuleForUrl(list, url) {
    const host = hostFromUrl(url);
    const arr = Array.isArray(list) ? list : [];
    const matched = arr.find((r) => platformMatchesHost(r.platform, host));
    return matched || (arr.length === 1 ? arr[0] : null);
  }

  function parseBatchUrls(text) {
    const seen = new Set();
    const out = [];
    for (const url of String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  function nowChinaIso() {
    const ms = Date.now() + 8 * 60 * 60 * 1000;
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res);
      });
    });
  }

  async function apiFetch(path, options = {}) {
    const res = await sendRuntimeMessage({
      type: 'API_FETCH',
      apiBase: currentApiBase(),
      path,
      token: options.auth === false ? '' : authToken,
      options: {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
      },
    });
    if (!res || !res.ok) throw new Error(res?.error || '请求失败');
    return res.data;
  }

  function getImagesStorageChoice() {
    return $('#ossToggle')?.checked ? 'oss' : 'local';
  }

  async function uploadCollection(platform, pageUrl, rows) {
    const payload = {
      platform: platform || '',
      url: pageUrl || '',
      collectedAt: nowChinaIso(),
      rows: Array.isArray(rows) ? rows : [],
      imagesStorage: getImagesStorageChoice(),
    };
    await apiFetch('/api/collections', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async function getSkuDetectRulesForPage(pageUrl, platform) {
    const host = hostFromUrl(pageUrl);
    if (!host) return [];
    const cacheKey = `${STORAGE_SKU_RULE_CACHE_PREFIX}${SKU_RULE_CACHE_VERSION}:${apiBase}:${host}:${platform || ''}`;
    try {
      const got = await chrome.storage.local.get(cacheKey);
      const cached = got && got[cacheKey];
      if (
        cached &&
        Array.isArray(cached.rules) &&
        Number.isFinite(Number(cached.savedAt)) &&
        Date.now() - Number(cached.savedAt) < SKU_RULE_CACHE_TTL_MS
      ) {
        return cached.rules;
      }
    } catch {
      // ignore
    }
    const q = new URLSearchParams({ host, platform: platform || '' });
    const res = await apiFetch(`/api/sku-detect-rules/match?${q.toString()}`);
    const rules = Array.isArray(res?.rules) ? res.rules : [];
    try {
      await chrome.storage.local.set({ [cacheKey]: { savedAt: Date.now(), rules } });
    } catch {
      // ignore
    }
    return rules;
  }

  function compactPreClicks(config) {
    const arr = Array.isArray(config?.pre_click_xpaths)
      ? config.pre_click_xpaths.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const legacy = String(config?.pre_click_xpath || '').trim();
    if (legacy && !arr.includes(legacy)) arr.push(legacy);
    return arr;
  }

  function buildPayload() {
    const cfg = currentRuleDetail?.config || {};
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    if (!currentRuleDetail || !rules.length) return null;
    const pre = compactPreClicks(cfg);
    return {
      rules,
      pre_click_xpaths: pre,
      pre_click_xpath: pre[0] || '',
      platform: currentRuleDetail.platform || '',
      scroll_to_bottom: cfg.scroll_to_bottom !== false,
    };
  }

  function log(line) {
    const el = $('#log');
    if (!el) return;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const next = `${el.value || ''}[${t}] ${line}\n`.slice(-24000);
    el.value = next;
    el.scrollTop = el.scrollHeight;
    persistSharedState({ logText: next });
  }

  function applySharedState(nextState) {
    if (!nextState || typeof nextState !== 'object') return;
    applyingSharedState = true;
    sharedUiState = { ...sharedUiState, ...nextState };
    const panel = $('#panel');
    const batchBox = $('#batchBox');
    const batchBtn = $('#batchToggleBtn');
    const logEl = $('#log');
    if (panel) panel.hidden = !sharedUiState.panelOpen;
    if (batchBox) batchBox.hidden = !sharedUiState.batchOpen;
    if (batchBtn) batchBtn.setAttribute('aria-expanded', sharedUiState.batchOpen ? 'true' : 'false');
    if (logEl && typeof sharedUiState.logText === 'string' && logEl.value !== sharedUiState.logText) {
      logEl.value = sharedUiState.logText;
      logEl.scrollTop = logEl.scrollHeight;
    }
    syncSettingsPanelUi();
    applyingSharedState = false;
  }

  function syncSettingsPanelUi() {
    const open = Boolean(sharedUiState.settingsOpen);
    const sp = root.querySelector('#settingsPanel');
    const sb = root.querySelector('#settingsBtn');
    if (sp) sp.hidden = !open;
    if (sb) sb.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function persistSharedState(patch) {
    if (applyingSharedState) return;
    sharedUiState = { ...sharedUiState, ...patch };
    syncSettingsPanelUi();
    chrome.storage.local.set({ [STORAGE_FLOAT_STATE]: sharedUiState }).catch(() => {});
  }

  function setBusy(next) {
    busy = Boolean(next);
    root.querySelectorAll('button,input,textarea').forEach((el) => {
      if (el.id === 'fab' || el.id === 'batchStopBtn') return;
      el.disabled = busy;
    });
    const stopBtn = $('#batchStopBtn');
    if (stopBtn) stopBtn.disabled = !batchRunning;
  }

  function setBatchRunning(next) {
    batchRunning = Boolean(next);
    const stopBtn = $('#batchStopBtn');
    const runBtn = $('#batchRunBtn');
    if (stopBtn) stopBtn.disabled = !batchRunning;
    if (runBtn) runBtn.disabled = batchRunning;
  }

  async function loadRuleDetail(id, silent = false) {
    if (!id) {
      currentRuleDetail = null;
      renderRuleLine();
      return null;
    }
    const detail = await apiFetch(`/api/plugin/rules/${encodeURIComponent(String(id))}`);
    currentRuleDetail = detail;
    renderRuleLine();
    if (!silent) log(`规则：${detail.name}（${detail.platform || '未填平台'}）`);
    return detail;
  }

  async function refreshRules({ silent = false } = {}) {
    rulesList = await apiFetch('/api/plugin/rules');
    if (!Array.isArray(rulesList) || !rulesList.length) {
      currentRuleDetail = null;
      renderRuleLine();
      if (!silent) log('没有可用规则，请在后台授权。');
      return;
    }
    const picked = pickRuleForUrl(rulesList, location.href);
    await loadRuleDetail(picked?.id, true);
    if (!silent) {
      log(`已加载 ${rulesList.length} 条规则，当前域名自动选择：${picked?.name || '无'}`);
    }
  }

  async function ensureRuleForUrl(url) {
    if (!Array.isArray(rulesList) || !rulesList.length) {
      await refreshRules({ silent: true });
    }
    const picked = pickRuleForUrl(rulesList, url);
    if (!picked) return null;
    if (!currentRuleDetail || String(currentRuleDetail.id) !== String(picked.id)) {
      await loadRuleDetail(picked.id, true);
      log(`已按域名切换规则：${picked.name}`);
    }
    return currentRuleDetail;
  }

  function renderRuleLine() {
    const el = $('#ruleLine');
    if (!el) return;
    el.textContent = '';
  }

  function showLoggedIn(user) {
    const top = $('#panelTop');
    if (top) top.hidden = false;
    $('#loginView').hidden = true;
    $('#mainView').hidden = false;
    $('#userLine').textContent = user?.username ? `已登录：${user.username}` : '已登录';
  }

  function showLogin() {
    const top = $('#panelTop');
    if (top) top.hidden = false;
    $('#loginView').hidden = false;
    $('#mainView').hidden = true;
  }

  async function login() {
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) {
      log('请输入账号和密码');
      return;
    }
    setBusy(true);
    try {
      currentApiBase();
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        auth: false,
      });
      authToken = data.token;
      await chrome.storage.local.set({
        [STORAGE_TOKEN]: data.token,
        [STORAGE_USER]: JSON.stringify(data.user || {}),
      });
      showLoggedIn(data.user || {});
      await refreshRules({ silent: false });
      log('登录成功。');
    } catch (e) {
      log(`登录失败：${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    authToken = '';
    currentRuleDetail = null;
    await chrome.storage.local.remove([STORAGE_TOKEN, STORAGE_USER]);
    showLogin();
    log('已退出登录。');
  }

  async function scrapeCurrent(mode) {
    setBusy(true);
    try {
      await ensureRuleForUrl(location.href);
      const payload = buildPayload();
      if (!payload) {
        log('未匹配采集规则，无法采集。');
        return;
      }
      const pageUrl = location.href;
      log(`${mode === 'xpath' ? '模拟采集' : '智能采集'}开始`);
      const skuRules = mode === 'xpath' ? [] : await getSkuDetectRulesForPage(pageUrl, payload.platform);
      const res = await sendRuntimeMessage({
        type: 'RUN_SCRAPE',
        rules: payload.rules,
        pre_click_xpath: payload.pre_click_xpath,
        pre_click_xpaths: payload.pre_click_xpaths,
        url: pageUrl,
        platform: payload.platform,
        scrapeMode: mode,
        skuDetectRules: skuRules,
        scroll_to_bottom: payload.scroll_to_bottom !== false,
      });
      if (!res || !res.ok) throw new Error(res?.error || '采集失败');
      const rows = Array.isArray(res.rows) ? res.rows : [];
      log(`采集完成：${rows.length} 行，模式=${res.scrapeMode || mode}`);
      if (Array.isArray(res.logs)) {
        res.logs
          .filter((line) =>
            /aliexpress|速卖通|mtop|skuImagesMap|skuPriceList|skuPropertyList|SKU=|命中 mtop|JSONP|skuId/i.test(String(line || ''))
          )
          .slice(-12)
          .forEach((line) => log(String(line || '')));
      }
      await uploadCollection(payload.platform, pageUrl, rows);
      log('采集成功，已上报后台！');
    } catch (e) {
      log(`采集失败：${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function appendCurrentToBatch() {
    const url = location.href;
    if (!/^https?:\/\//i.test(url)) {
      const msg = '当前页不是网页链接';
      log(msg);
      return;
    }
    const existing = parseBatchUrls($('#batchUrls').value || batchUrlsText);
    if (existing.includes(url)) {
      const msg = '已在批量采集列表中';
      log(msg);
      return;
    }
    batchUrlsText = [...existing, url].join('\n');
    $('#batchUrls').value = batchUrlsText;
    await chrome.storage.local.set({ [STORAGE_BATCH_URLS]: batchUrlsText });
    updateBatchCount();
    log(`已添加到批量采集：${url}`);
  }

  function updateBatchCount() {
    const n = parseBatchUrls($('#batchUrls')?.value || batchUrlsText).length;
    $('#batchCount').textContent = n ? `${n} 条链接` : '暂无链接';
  }

  async function runBatch() {
    batchUrlsText = $('#batchUrls').value || '';
    const urls = parseBatchUrls(batchUrlsText);
    if (!urls.length) {
      log('批量链接为空');
      return;
    }
    setBusy(true);
    setBatchRunning(true);
    try {
      if (!Array.isArray(rulesList) || !rulesList.length) {
        await refreshRules({ silent: true });
      }
      await chrome.storage.local.set({ [STORAGE_BATCH_URLS]: batchUrlsText });
      const groups = new Map();
      for (let ui = 0; ui < urls.length; ui++) {
        const url = urls[ui];
        const picked = pickRuleForUrl(rulesList, url);
        if (!picked) {
          const host = hostFromUrl(url);
          throw new Error(
            `第 ${ui + 1} 条未匹配采集规则${host ? `（站点：${host}）` : ''}`
          );
        }
        const key = String(picked.id);
        if (!groups.has(key)) groups.set(key, { rule: picked, urls: [] });
        groups.get(key).urls.push(url);
      }
      log(`批量采集开始：共 ${urls.length} 条，规则分组 ${groups.size} 组`);
      log(`准备采集：共 ${urls.length} 条链接`);
      let success = 0;
      let failed = 0;
      let processed = 0;
      for (const group of groups.values()) {
        await loadRuleDetail(group.rule.id, true);
        const payload = buildPayload();
        if (!payload) throw new Error(`规则无效：${group.rule.name}`);
        log(
          `批量分组：${group.rule.name}（${payload.platform || group.rule.platform || '未填平台'}）· ${group.urls.length} 条`
        );
        const skuRulesByUrl = {};
        for (const u of group.urls) {
          skuRulesByUrl[u] = await getSkuDetectRulesForPage(u, payload.platform);
        }
        const res = await sendRuntimeMessage({
          type: 'RUN_BATCH_QUEUE',
          urls: group.urls,
          rules: payload.rules,
          pre_click_xpath: payload.pre_click_xpath,
          pre_click_xpaths: payload.pre_click_xpaths,
          platform: payload.platform,
          apiBase: currentApiBase(),
          token: authToken,
          imagesStorage: getImagesStorageChoice(),
          skuDetectRules: skuRulesByUrl[group.urls[0]] || [],
          skuRulesByUrl,
          globalOffset: processed,
          globalTotal: urls.length,
          globalOkBase: success,
          globalFailBase: failed,
          scroll_to_bottom: payload.scroll_to_bottom !== false,
        });
        if (!res || !res.ok) throw new Error(res?.error || '批量采集失败');
        success += Number(res.success || 0);
        failed += Number(res.failed || 0);
        processed += group.urls.length;
        if (res.stopped) {
          log('批量采集已停止。');
          break;
        }
      }
      log(`批量采集结束：成功 ${success}，失败 ${failed}`);
    } catch (e) {
      log(`批量采集失败：${e?.message || String(e)}`);
    } finally {
      setBatchRunning(false);
      setBusy(false);
    }
  }

  async function stopBatch() {
    if (!batchRunning) return;
    log('正在停止批量采集…');
    await sendRuntimeMessage({ type: 'STOP_BATCH_QUEUE' });
  }

  function clearLog() {
    const el = $('#log');
    if (el) el.value = '';
    persistSharedState({ logText: '' });
  }

  async function initState() {
    const data = await chrome.storage.local.get([
      STORAGE_TOKEN,
      STORAGE_USER,
      STORAGE_API_BASE,
      STORAGE_BATCH_URLS,
      STORAGE_IMAGES_STORAGE,
      STORAGE_FLOAT_STATE,
    ]);
    applySharedState(data[STORAGE_FLOAT_STATE]);
    apiBase = normalizeApiBase(data[STORAGE_API_BASE]);
    $('#apiBase').value = data[STORAGE_API_BASE] || '';
    batchUrlsText = String(data[STORAGE_BATCH_URLS] || '');
    $('#batchUrls').value = batchUrlsText;
    $('#ossToggle').checked = String(data[STORAGE_IMAGES_STORAGE] || '').toLowerCase() === 'oss';
    updateBatchCount();
    authToken = String(data[STORAGE_TOKEN] || '');
    if (authToken) {
      let user = {};
      try {
        user = JSON.parse(data[STORAGE_USER] || '{}');
      } catch {
        user = {};
      }
      showLoggedIn(user);
      try {
        await refreshRules({ silent: true });
      } catch (e) {
        log(`加载规则失败：${e?.message || String(e)}`);
      }
    } else {
      showLogin();
    }
  }

  const host = document.createElement('div');
  host.id = '__ai_collection_float_host__';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const fabIconUrl = chrome.runtime.getURL('32.png');
  const icon16Url = chrome.runtime.getURL('16.png');
  root.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      * { box-sizing: border-box; }
      .fab {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
        width: 48px; height: 48px; border-radius: 999px;
        background: linear-gradient(165deg, #ecfdf5 0%, #f0fdfa 45%, #ffffff 100%);
        border: 1px solid rgba(167, 243, 208, 0.9);
        box-shadow: 0 6px 20px rgba(15, 118, 110, 0.2);
        cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
        padding: 0; overflow: hidden;
      }
      .fab:hover {
        border-color: #5eead4;
        box-shadow: 0 8px 24px rgba(15, 118, 110, 0.26);
      }
      .fab img {
        width: 28px; height: 28px; display: block; object-fit: contain;
      }
      .panel {
        position: fixed; right: 18px; bottom: 78px; z-index: 2147483647;
        width: min(330px, calc(100vw - 28px)); max-height: min(620px, calc(100vh - 96px));
        overflow: auto; border-radius: 16px; border: 1px solid rgba(226,232,240,.92);
        background: rgba(255,255,255,.96); box-shadow: 0 24px 70px rgba(15,23,42,.22);
        backdrop-filter: blur(12px); padding: 12px; font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif;
        color: #1e293b;
      }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .top-leading {
        display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;
      }
      .top-logo-wrap {
        width: 28px; height: 28px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: none; border: none; box-shadow: none; border-radius: 0;
      }
      .top-logo { width: 22px; height: 22px; display: block; object-fit: contain; }
      .brand { font-weight: 800; color: #0f172a; min-width: 0; }
      .icon-btn {
        flex-shrink: 0; border: 0; background: transparent; padding: 6px; margin: -4px -4px -4px 0;
        border-radius: 10px; cursor: pointer; color: #64748b; display: inline-flex; align-items: center; justify-content: center;
        line-height: 0; transition: background .15s ease, color .15s ease;
      }
      .icon-btn:hover { background: #f1f5f9; color: #334155; }
      .icon-btn[aria-expanded="true"] { background: #ecfdf5; color: #0f766e; }
      .icon-btn svg { display: block; }
      #settingsPanel {
        margin: -6px -12px 10px; padding: 2px 12px 12px;
        border-bottom: 1px solid rgba(226,232,240,.85);
      }
      #settingsPanel .field { margin-top: 0; }
      .settings-hint { margin: 6px 0 0; font-size: 11px; line-height: 1.4; }
      .muted { color: #64748b; font-size: 12px; }
      .field { margin-top: 8px; }
      label { display: block; margin-bottom: 4px; color: #475569; font-weight: 650; font-size: 12px; }
      input, textarea {
        width: 100%; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 9px;
        font: 13px system-ui, "Microsoft YaHei", sans-serif; outline: none; background: #fff; color: #0f172a;
      }
      textarea { min-height: 96px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
      textarea.batch-urls {
        white-space: pre;
        overflow-wrap: normal;
        word-break: normal;
        overflow-x: auto;
      }
      input:focus, textarea:focus { border-color: #2dd4bf; box-shadow: 0 0 0 3px rgba(45,212,191,.14); }
      .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
      button { font: 700 12px system-ui, "Microsoft YaHei", sans-serif; }
      .btn { border: 1px solid #e2e8f0; border-radius: 10px; padding: 9px 10px; cursor: pointer; background: #f8fafc; color: #334155; font-weight: 600; }
      .btn.disclosure { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
      .chev { font-size: 10px; line-height: 1; transition: transform .16s ease; }
      .btn.disclosure[aria-expanded="true"] .chev { transform: rotate(180deg); }
      .btn.smart {
        background: #ecfdf5; color: #047857; border-color: #a7f3d0;
      }
      .btn.smart:hover { background: #d1fae5; border-color: #6ee7b7; }
      .btn.xpath {
        background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe;
      }
      .btn.xpath:hover { background: #dbeafe; border-color: #93c5fd; }
      .btn.batch {
        background: #f5f3ff; color: #6d28d9; border-color: #ddd6fe;
      }
      .btn.batch:hover { background: #ede9fe; border-color: #c4b5fd; }
      .btn.append {
        background: #fffbeb; color: #b45309; border-color: #fde68a;
      }
      .btn.append:hover { background: #fef3c7; border-color: #fcd34d; }
      .btn.primary { background: #0f766e; color: #fff; border-color: #0f766e; }
      .btn.primary:hover { background: #115e59; border-color: #115e59; }
      .btn.warn { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
      .btn.danger { background: #b91c1c; color: #fff; border-color: #b91c1c; }
      .btn.danger:hover { background: #991b1b; border-color: #991b1b; }
      .btn:disabled, input:disabled, textarea:disabled { opacity: .58; cursor: not-allowed; }
      .ruleLine { display: none; }
      .switch {
        margin-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
        color: #475569; font-size: 12px; font-weight: 600;
      }
      .switch > span:first-child { flex: 1; min-width: 0; }
      .toggle-wrap {
        position: relative; width: 44px; height: 26px; flex-shrink: 0; cursor: pointer; display: inline-block;
      }
      .toggle-wrap input {
        position: absolute; inset: 0; width: 44px; height: 26px; margin: 0; opacity: 0.001;
        cursor: pointer; z-index: 2; appearance: none;
      }
      .toggle-ui {
        position: absolute; inset: 0; border-radius: 999px; background: #e2e8f0;
        border: 1px solid #cbd5e1; transition: background .18s ease, border-color .18s ease;
        pointer-events: none;
      }
      .toggle-ui::after {
        content: ''; position: absolute; width: 20px; height: 20px; left: 3px; top: 50%;
        margin-top: -10px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 3px rgba(15,23,42,.12); transition: transform .18s ease;
      }
      .toggle-wrap input:focus-visible + .toggle-ui {
        box-shadow: 0 0 0 3px rgba(45,212,191,.22);
      }
      .toggle-wrap input:checked + .toggle-ui {
        background: #ccfbf1; border-color: #5eead4;
      }
      .toggle-wrap input:checked + .toggle-ui::after {
        transform: translateX(16px);
      }
      .login-card {
        background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px 12px 14px;
      }
      .login-card .field:first-of-type { margin-top: 0; }
      .login-actions { margin-top: 14px; }
      .login-actions .btn.primary { width: 100%; padding: 10px 12px; font-size: 13px; border-radius: 11px; }
      .divider { height: 1px; background: #e2e8f0; margin: 10px 0; }
      .log { height: 92px; min-height: 92px; background: #0f172a; color: #d1fae5; border-color: #0f172a; }
      .panel-log-section { margin-top: 4px; }
      /* 登录页不展示采集日志（已登录后仍显示；日志照常写入 storage） */
      #loginView:not([hidden]) ~ #panelLogSection {
        display: none !important;
      }
      [hidden] { display: none !important; }
    </style>
    <button class="fab" id="fab" title="AI数据采集"><img src="${fabIconUrl}" alt="" /></button>
    <section class="panel" id="panel" hidden>
      <div class="top" id="panelTop">
        <div class="top-leading">
          <div class="top-logo-wrap">
            <img class="top-logo" src="${fabIconUrl}" alt="" decoding="async" onerror="this.onerror=null;this.src='${icon16Url}'" />
          </div>
          <div class="brand">AI数据采集</div>
        </div>
        <button type="button" class="icon-btn" id="settingsBtn" title="设置" aria-label="设置" aria-expanded="false" aria-controls="settingsPanel">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
          </svg>
        </button>
      </div>
      <div id="settingsPanel" hidden>
        <div class="field" id="apiField"><label>后台 API</label><input id="apiBase" placeholder="留空使用默认接口" /></div>
        <p class="settings-hint muted">修改后登录与采集将请求新地址；留空则使用默认接口。</p>
      </div>
      <div id="loginView" hidden>
        <div class="login-card">
          <div class="field"><label>用户名</label><input id="username" autocomplete="username" /></div>
          <div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password" /></div>
          <div class="login-actions"><button class="btn primary" id="loginBtn">登录</button></div>
        </div>
      </div>
      <div id="mainView" hidden>
        <div class="row" style="justify-content:space-between;">
          <span class="muted" id="userLine"></span>
          <button class="btn" id="logoutBtn">退出</button>
        </div>
        <div class="ruleLine" id="ruleLine">规则：自动匹配中</div>
        <div class="switch">
          <span>图片存储 OSS</span>
          <label class="toggle-wrap" title="开启后图片上传到 OSS">
            <input id="ossToggle" type="checkbox" />
            <span class="toggle-ui" aria-hidden="true"></span>
          </label>
        </div>
        <div class="actions">
          <button class="btn smart" id="smartBtn">智能采集</button>
          <button class="btn xpath" id="xpathBtn">模拟采集</button>
          <button class="btn batch disclosure" id="batchToggleBtn" aria-expanded="false">批量采集 <span class="chev">▼</span></button>
          <button class="btn append" id="appendBtn">添加到批量采集</button>
        </div>
        <div id="batchBox" hidden>
          <div class="divider"></div>
          <div class="row" style="justify-content:space-between; margin-bottom:6px;">
            <label style="margin:0;">批量链接</label><span class="muted" id="batchCount">暂无链接</span>
          </div>
          <textarea id="batchUrls" class="batch-urls" spellcheck="false"></textarea>
          <div class="row" style="margin-top:8px;">
            <button class="btn primary" id="batchRunBtn">开始批量采集</button>
            <button class="btn danger" id="batchStopBtn" disabled>停止</button>
            <button class="btn warn" id="batchClearBtn">清空</button>
          </div>
        </div>
      </div>
      <div id="panelLogSection" class="panel-log-section">
        <div class="divider"></div>
        <div class="row" style="justify-content:space-between; margin-bottom:6px;">
          <label style="margin:0;">采集日志</label>
          <button class="btn" id="clearLogBtn" style="padding:5px 9px;">清空日志</button>
        </div>
        <textarea class="log" id="log" readonly></textarea>
      </div>
    </section>
  `;

  function $(selector) {
    return root.querySelector(selector);
  }

  function togglePanel(force) {
    const panel = $('#panel');
    const next = typeof force === 'boolean' ? force : panel.hidden;
    panel.hidden = !next;
    if (!next) persistSharedState({ panelOpen: false, settingsOpen: false });
    else persistSharedState({ panelOpen: true });
    if (next && authToken) refreshRules({ silent: true }).catch((e) => log(`加载规则失败：${e?.message || String(e)}`));
  }

  $('#fab').addEventListener('click', () => togglePanel());
  $('#settingsBtn').addEventListener('click', () => {
    persistSharedState({ settingsOpen: !sharedUiState.settingsOpen });
  });
  $('#loginBtn').addEventListener('click', login);
  $('#username').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      login();
    }
  });
  $('#password').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      login();
    }
  });
  $('#logoutBtn').addEventListener('click', logout);
  $('#smartBtn').addEventListener('click', () => scrapeCurrent('smart'));
  $('#xpathBtn').addEventListener('click', () => scrapeCurrent('xpath'));
  $('#appendBtn').addEventListener('click', appendCurrentToBatch);
  $('#batchToggleBtn').addEventListener('click', () => {
    const nextOpen = $('#batchBox').hidden;
    $('#batchBox').hidden = !nextOpen;
    $('#batchToggleBtn').setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    persistSharedState({ batchOpen: nextOpen });
    updateBatchCount();
  });
  $('#batchRunBtn').addEventListener('click', runBatch);
  $('#batchStopBtn').addEventListener('click', stopBatch);
  $('#clearLogBtn').addEventListener('click', clearLog);
  $('#batchClearBtn').addEventListener('click', async () => {
    batchUrlsText = '';
    $('#batchUrls').value = '';
    await chrome.storage.local.set({ [STORAGE_BATCH_URLS]: '' });
    updateBatchCount();
  });
  $('#batchUrls').addEventListener('input', () => {
    batchUrlsText = $('#batchUrls').value || '';
    updateBatchCount();
    clearTimeout(batchSaveTimer);
    batchSaveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_BATCH_URLS]: batchUrlsText }).catch(() => {});
    }, 250);
  });
  $('#ossToggle').addEventListener('change', async () => {
    await chrome.storage.local.set({ [STORAGE_IMAGES_STORAGE]: getImagesStorageChoice() });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_FLOATING_PANEL') {
      $('#fab').hidden = false;
      togglePanel();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'FLOAT_LOG') {
      if (msg.line) log(String(msg.line));
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'BATCH_PROGRESS') {
      const stateMap = {
        opening: '打开页面（等待加载完毕）',
        scraping: '采集数据',
        uploading: '上报后台',
        done: '完成',
        failed: '失败',
      };
      const stateText = stateMap[msg.state] || '处理中';
      const cur = Number(msg.i) || 0;
      const total = Number(msg.n) || 0;
      const text = `正在采集第 ${cur}/${total} 条 · ${stateText} · 成功 ${msg.ok || 0} · 失败 ${msg.fail || 0}`;
      log(text);
      if (msg.error) log(`第 ${cur} 条失败：${msg.error}`);
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_FLOAT_STATE]) {
      applySharedState(changes[STORAGE_FLOAT_STATE].newValue);
    }
    if (changes[STORAGE_BATCH_URLS]) {
      batchUrlsText = String(changes[STORAGE_BATCH_URLS].newValue || '');
      const ta = $('#batchUrls');
      if (ta && ta.value !== batchUrlsText) ta.value = batchUrlsText;
      updateBatchCount();
    }
    if (changes[STORAGE_IMAGES_STORAGE]) {
      $('#ossToggle').checked = String(changes[STORAGE_IMAGES_STORAGE].newValue || '').toLowerCase() === 'oss';
    }
    if (changes[STORAGE_API_BASE]) {
      const raw = String(changes[STORAGE_API_BASE].newValue || '');
      apiBase = normalizeApiBase(raw);
      const input = $('#apiBase');
      if (input && input.value !== raw) input.value = raw;
    }
    if (changes[STORAGE_TOKEN] || changes[STORAGE_USER]) {
      initState().catch(() => {});
    }
  });

  initState().catch(() => {});
})();
