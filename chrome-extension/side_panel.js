/**
 * 精简面板：登录、规则下拉、采集当前页、日志。
 * 采集：background 转发 RUN_SCRAPE，携带 rules、pre_click_xpath、platform（所属平台 → 插件内采集管线）。
 */

const STORAGE_TOKEN = 'scraper_api_token';
const STORAGE_USER = 'scraper_user_json';
const STORAGE_API_BASE = 'scraper_api_base';
const STORAGE_BATCH_URLS = 'scraper_batch_urls';
/** 'local' | 'oss'，与 POST /api/collections 字段 imagesStorage 一致 */
const STORAGE_IMAGES_STORAGE = 'scraper_images_storage';

/** 用户未填写且未保存时使用的默认接口（与 config.js 中 __SCRAPER_API_BASE__ 一致） */
const DEFAULT_API_BASE = 'https://ai.dokor.cn';

function normalizeApiBase(b) {
  const raw = String(b ?? '').trim();
  if (!raw) return DEFAULT_API_BASE;
  return raw.replace(/\/$/, '');
}

let authToken = '';
/** 当前请求使用的 API 根地址（不含末尾 /） */
let apiBase = DEFAULT_API_BASE;
let currentRuleDetail = null; // { id, name, platform, config: { rules, pre_click_xpath, pre_click_xpaths } }

let batchUrlsText = '';

function ms(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)}s`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.style.display = 'none';
  }, 2800);
}

function log(line) {
  const ta = document.getElementById('logArea');
  const t = (() => {
    const ms = Date.now() + 8 * 60 * 60 * 1000;
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const y = d.getUTCFullYear();
    const m = p(d.getUTCMonth() + 1);
    const day = p(d.getUTCDate());
    const hh = p(d.getUTCHours());
    const mm = p(d.getUTCMinutes());
    const ss = p(d.getUTCSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
  })();
  ta.value += `[${t}] ${line}\n`;
  ta.scrollTop = ta.scrollHeight;
}

function syncBatchTextareaFromMemory() {
  const ta = document.getElementById('batchUrlsInput');
  if (ta && typeof ta.value !== 'undefined') ta.value = batchUrlsText || '';
}

function readBatchTextareaToMemory() {
  const ta = document.getElementById('batchUrlsInput');
  const raw = ta ? String(ta.value || '') : '';
  batchUrlsText = raw;
  return raw;
}

function parseBatchUrls(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setBatchStatusLine() {
  const el = document.getElementById('batchStatusLine');
  if (!el) return;
  const urls = parseBatchUrls(batchUrlsText);
  el.style.display = urls.length ? 'block' : 'none';
  if (urls.length) el.textContent = `批量链接：${urls.length} 条`;
}

function setBatchProgressLine({ i, n, ok, fail, url, state }) {
  const el = document.getElementById('batchStatusLine');
  if (!el) return;
  const total = Math.max(0, Math.floor(Number(n) || 0));
  const idx = Math.max(0, Math.floor(Number(i) || 0));
  const okCount = Math.max(0, Math.floor(Number(ok) || 0));
  const failCount = Math.max(0, Math.floor(Number(fail) || 0));
  const s = String(state || '').trim();
  el.style.display = 'block';
  let text = `批量采集：${s || '—'}`;
  if (total > 0) text += ` · ${idx}/${total}`;
  text += ` · 成功${okCount} 失败${failCount}`;
  el.textContent = text;
}

/** 批量采集卡片是否已展开（整块卡片显示 + 内容区可见） */
function isBatchCardExpanded() {
  const card = document.getElementById('batchCard');
  const body = document.getElementById('batchCardBody');
  if (!card || !body) return false;
  if ((card.style.display || '').trim() === 'none') return false;
  return !body.hidden;
}

/** 展开/收起整块批量采集卡片（由主面板「批量采集」按钮切换） */
function setBatchCardExpanded(expanded) {
  const card = document.getElementById('batchCard');
  const body = document.getElementById('batchCardBody');
  const panelToggle = document.getElementById('btnBatchPanelToggle');
  if (!card || !body) return;
  if (expanded) {
    card.style.display = 'block';
    body.hidden = false;
    card.classList.remove('batch-collapsed');
    if (panelToggle) panelToggle.setAttribute('aria-expanded', 'true');
  } else {
    card.style.display = 'none';
    body.hidden = true;
    card.classList.add('batch-collapsed');
    if (panelToggle) panelToggle.setAttribute('aria-expanded', 'false');
  }
}

function toggleBatchCard() {
  setBatchCardExpanded(!isBatchCardExpanded());
}

async function step(title, fn) {
  const start = performance.now();
  log(`▶ ${title}`);
  try {
    const ret = await fn();
    log(`✓ ${title}（${ms(performance.now() - start)}）`);
    return ret;
  } catch (e) {
    log(`✗ ${title}（${ms(performance.now() - start)}）：${e?.message || String(e)}`);
    throw e;
  }
}

function applyApiBaseFromStorage(stored) {
  const fromWindow =
    typeof window !== 'undefined' && window.__SCRAPER_API_BASE__
      ? String(window.__SCRAPER_API_BASE__).trim()
      : '';
  let rawEffective = '';
  if (stored !== undefined && stored !== null) {
    rawEffective = String(stored).trim();
  } else {
    rawEffective = fromWindow || '';
  }
  apiBase = normalizeApiBase(rawEffective);

  const input = document.getElementById('apiBaseInput');
  if (input) {
    if (stored !== undefined && stored !== null) {
      input.value = String(stored).trim();
    } else {
      input.value = '';
    }
  }
}

async function apiFetch(path, options = {}) {
  const base = apiBase;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(base + path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data && data.error ? data.error : res.statusText || '请求失败';
    throw new Error(msg);
  }
  return data;
}

function showLoginPanel() {
  document.getElementById('panelLogin').style.display = 'block';
  document.getElementById('panelMain').style.display = 'none';
  const batch = document.getElementById('batchCard');
  if (batch) batch.style.display = 'none';
}

function showMainPanel() {
  document.getElementById('panelLogin').style.display = 'none';
  document.getElementById('panelMain').style.display = 'block';
  const batch = document.getElementById('batchCard');
  if (batch) {
    setBatchCardExpanded(false);
  }
}

function renderUserLine() {
  try {
    const u = JSON.parse(localStorage.getItem(STORAGE_USER) || '{}');
    const line = document.getElementById('userLine');
    if (u.username) {
      let s = `已登录：${u.username}`;
      if (u.validTo) s += ` · 授权至 ${u.validTo}`;
      if (u.role === 'admin') s += ' · 管理员';
      line.textContent = s;
    }
  } catch {
    /* ignore */
  }
}

function getImagesStorageChoice() {
  const ossBtn = document.getElementById('btnStorageOss');
  if (ossBtn && ossBtn.classList.contains('active')) return 'oss';
  return 'local';
}

function setImagesStorageUI(value) {
  const local = document.getElementById('btnStorageLocal');
  const oss = document.getElementById('btnStorageOss');
  if (!local || !oss) return;
  const v = String(value || '').toLowerCase() === 'oss' ? 'oss' : 'local';
  local.classList.toggle('active', v === 'local');
  oss.classList.toggle('active', v === 'oss');
}

async function afterLogin(token, user) {
  authToken = token;
  await chrome.storage.local.set({
    [STORAGE_TOKEN]: token,
    [STORAGE_USER]: JSON.stringify(user),
  });
  localStorage.setItem(STORAGE_USER, JSON.stringify(user));
  showMainPanel();
  renderUserLine();
  try {
    const st = await chrome.storage.local.get(STORAGE_IMAGES_STORAGE);
    setImagesStorageUI(st[STORAGE_IMAGES_STORAGE]);
  } catch {
    setImagesStorageUI('local');
  }
  await step('加载可用规则列表', () => refreshRuleList({ silent: false }));
}

async function refreshRuleList(options = {}) {
  const silent = options.silent === true;
  const sel = document.getElementById('ruleSelect');
  const prevId = (sel.value || '').trim();
  sel.innerHTML = '<option value="">加载中…</option>';
  currentRuleDetail = null;
  try {
    const list = await apiFetch('/api/plugin/rules');
    sel.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '暂无可选规则（请让管理员授权）';
      sel.appendChild(o);
      if (!silent) log('规则列表为空，请在后台为您勾选采集规则。');
      return;
    }
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '请选择采集规则';
    sel.appendChild(ph);
    list.forEach((r) => {
      const o = document.createElement('option');
      o.value = String(r.id);
      o.textContent = `${r.name}（${r.platform || '未填平台'}）`;
      sel.appendChild(o);
    });
    if (!silent) log(`已加载 ${list.length} 条可用规则。`);
    if (prevId && list.some((r) => String(r.id) === prevId)) {
      sel.value = prevId;
      await loadRuleDetail(prevId, { silent });
    } else if (prevId && !silent) {
      log('原选择的规则已不在列表中，请重新选择。');
    }
  } catch (e) {
    sel.innerHTML = '<option value="">加载失败</option>';
    log('加载规则失败: ' + (e.message || String(e)));
    toast('加载规则失败');
  }
}

let ruleRefreshDebounce = null;
function scheduleRefreshRulesOnPanelShow() {
  if (!authToken) return;
  clearTimeout(ruleRefreshDebounce);
  ruleRefreshDebounce = setTimeout(() => {
    refreshRuleList({ silent: true });
  }, 200);
}

async function loadRuleDetail(ruleId, opts = {}) {
  const silent = opts.silent === true;
  if (!ruleId) {
    currentRuleDetail = null;
    return;
  }
  try {
    const d = await apiFetch('/api/plugin/rules/' + ruleId);
    currentRuleDetail = d;
    if (!silent) {
      const rc = Array.isArray(d?.config?.rules) ? d.config.rules.length : 0;
      const arr = Array.isArray(d?.config?.pre_click_xpaths)
        ? d.config.pre_click_xpaths.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      const legacy = String(d?.config?.pre_click_xpath || '').trim();
      if (legacy && !arr.includes(legacy)) arr.push(legacy);
      const pre = arr.join(' | ');
      log(
        `已选择规则「${d.name}」，平台：${d.platform || '—'}，字段规则数：${rc}，预处理：${
          pre ? '有' : '无'
        }`
      );
    }
  } catch (e) {
    currentRuleDetail = null;
    log('加载规则详情失败: ' + (e.message || String(e)));
    toast('规则加载失败');
  }
}

function buildEnginePayload() {
  if (!currentRuleDetail || !currentRuleDetail.config) return null;
  const cfg = currentRuleDetail.config;
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  const arr = Array.isArray(cfg.pre_click_xpaths)
    ? cfg.pre_click_xpaths.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const legacy = String(cfg.pre_click_xpath || '').trim();
  if (legacy && !arr.includes(legacy)) arr.push(legacy);
  if (!rules.length) {
    toast('该规则未配置 XPath');
    return null;
  }
  return { rules, pre_click_xpaths: arr, pre_click_xpath: arr[0] || '', platform: currentRuleDetail.platform || '' };
}

/**
 * 供导出阶段做颜色×尺码 SKU 展开：颜色与主图 URL 一一对应。
 * 由子行推导；若缺尺码/颜色/主图则不上报。
 */
function computeSkuAxes(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const parent = list.find((r) => r && r['父子关系'] === 'parent');
  const children = list.filter((r) => r && r['父子关系'] === 'child');
  if (!parent || children.length === 0) return null;
  const colorRows = children
    .map((c) => ({
      color: String(c['颜色'] ?? '').trim(),
      main: typeof c['主图'] === 'string' ? String(c['主图']).trim() : '',
      colorIx: Number(c.__color_ix),
    }))
    .filter((x) => Boolean(x.color));

  // 优先用 __color_ix 还原“原始颜色槽位数量”，避免颜色文本相同导致丢槽位，
  // 同时避免使用 children 行数（可能是颜色×尺码的笛卡尔积）导致颜色数量倍增。
  const hasColorIx = colorRows.some((x) => Number.isInteger(x.colorIx) && x.colorIx >= 0);
  const colors = [];
  const mains = [];
  if (hasColorIx) {
    const byIx = new Map();
    for (const r of colorRows) {
      const ix = Number.isInteger(r.colorIx) && r.colorIx >= 0 ? r.colorIx : null;
      if (ix == null) continue;
      if (!byIx.has(ix)) byIx.set(ix, r);
    }
    const ixs = [...byIx.keys()].sort((a, b) => a - b);
    for (const ix of ixs) {
      const r = byIx.get(ix);
      colors.push(r.color);
      mains.push(r.main);
    }
  } else {
    const uniqColors = [...new Set(colorRows.map((x) => x.color))];
    // 若采集到的颜色全都相同（且数量>1），不去重（这里的数量来自子行，可能仍不准；推荐 __color_ix 分支）
    const keepDupColors = uniqColors.length === 1 && colorRows.length > 1;
    const outColors = keepDupColors ? colorRows.map((x) => x.color) : uniqColors;
    for (const col of outColors) {
      const row = children.find((c) => String(c['颜色'] ?? '').trim() === col);
      const m = row ? row['主图'] : '';
      colors.push(col);
      mains.push(typeof m === 'string' ? m.trim() : '');
    }
  }
  const sizes = [
    ...new Set(
      children.map((c) => String(c['尺码'] ?? c['尺寸'] ?? '').trim()).filter(Boolean)
    ),
  ];
  if (!colors.length || !sizes.length) return null;
  if (mains.some((m) => !m)) return null;
  return { colors, sizes, mains };
}

/** 一次采集一条后台记录，详情内为 rows（多 SKU） */
async function uploadBatch(platform, pageUrl, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const axes = computeSkuAxes(list);
  const payload = {
    platform: platform || '',
    url: pageUrl || '',
    collectedAt: (() => {
      const ms = Date.now() + 8 * 60 * 60 * 1000;
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      const y = d.getUTCFullYear();
      const m = p(d.getUTCMonth() + 1);
      const day = p(d.getUTCDate());
      const hh = p(d.getUTCHours());
      const mm = p(d.getUTCMinutes());
      const ss = p(d.getUTCSeconds());
      return `${y}-${m}-${day}T${hh}:${mm}:${ss}+08:00`;
    })(),
    rows: list,
  };
  if (axes) payload.sku_axes = axes;
  payload.imagesStorage = getImagesStorageChoice();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let bodyStr;
  try {
    bodyStr = JSON.stringify(payload);
  } catch (e) {
    throw e;
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const kb = (bodyStr.length / 1024).toFixed(1);
  await apiFetch('/api/collections', {
    method: 'POST',
    body: bodyStr,
  });
  const t2 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const msSerialize = Math.round(t1 - t0);
  const msHttp = Math.round(t2 - t1);
  log(
    `上报耗时：序列化 ${msSerialize} ms · 请求/等待响应 ${msHttp} ms · 约 ${kb} KB（插件端）`
  );
  log(`已上报 1 条采集记录（含 ${list.length} 个 SKU）到后台。`);
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error('无法获取当前标签页');
  return tabs[0].id;
}

function runScrapeOnTab(tabId, pageUrl, rules, pre, platform) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'RUN_SCRAPE',
        tabId,
        rules,
        pre_click_xpaths: Array.isArray(pre) ? pre : [],
        pre_click_xpath: Array.isArray(pre) ? pre[0] || '' : pre || '',
        url: pageUrl || '',
        platform: platform != null ? String(platform) : '',
      },
      (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res);
      }
    );
  });
}

function runScrapeOnUrl(tabId, url, rules, pre, platform) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'RUN_SCRAPE_ON_URL',
        tabId,
        rules,
        pre_click_xpaths: Array.isArray(pre) ? pre : [],
        pre_click_xpath: Array.isArray(pre) ? pre[0] || '' : pre || '',
        url: url || '',
        platform: platform != null ? String(platform) : '',
      },
      (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res);
      }
    );
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

let batchRunning = false;
let batchStopRequested = false;
let batchTabId = null;

function setBatchButtons() {
  const startBtn = document.getElementById('btnBatchStart');
  const stopBtn = document.getElementById('btnBatchStop');
  if (startBtn) startBtn.disabled = batchRunning;
  if (stopBtn) stopBtn.disabled = !batchRunning;
}

async function ensureBatchTab(url) {
  if (batchTabId != null) {
    try {
      await chrome.tabs.get(batchTabId);
      return batchTabId;
    } catch {
      batchTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  batchTabId = tab.id;
  return batchTabId;
}

async function runBatchScrapeQueue() {
  const payload = buildEnginePayload();
  if (!payload) {
    log('请先选择有效的采集规则。');
    toast('未选择规则');
    return;
  }
  // 优先使用输入框当前内容（避免用户未点保存就开始）
  readBatchTextareaToMemory();
  const urls = parseBatchUrls(batchUrlsText);
  if (!urls.length) {
    setBatchCardExpanded(true);
    log('批量链接为空：请在批量采集卡片中录入链接并保存。');
    toast('批量链接为空');
    return;
  }

  setBatchCardExpanded(true);
  batchRunning = true;
  batchStopRequested = false;
  setBatchButtons();

  let okCount = 0;
  let failCount = 0;

  try {
    log(`批量采集开始：共 ${urls.length} 条。`);
    setBatchProgressLine({ i: 0, n: urls.length, ok: okCount, fail: failCount, url: '', state: '准备中' });
    const tabId = await step('打开批量采集标签页', () => ensureBatchTab(urls[0]));

    for (let i = 0; i < urls.length; i++) {
      if (batchStopRequested) {
        log('已停止批量采集。');
        setBatchProgressLine({
          i: i,
          n: urls.length,
          ok: okCount,
          fail: failCount,
          url: '',
          state: '已停止',
        });
        break;
      }
      const u = urls[i];
      log(`正在采集第 ${i + 1}/${urls.length} 条`);
      // 链接可能很长且含敏感参数：批量日志不输出 URL
      log(`目标链接：已隐藏`);
      setBatchProgressLine({
        i: i + 1,
        n: urls.length,
        ok: okCount,
        fail: failCount,
        url: u,
        state: '采集中',
      });

      const res = await step('打开页面并执行采集', () =>
        runScrapeOnUrl(tabId, u, payload.rules, payload.pre_click_xpaths, payload.platform)
      );

      if (!res || !res.ok) {
        failCount++;
        log('采集失败: ' + (res && res.error ? res.error : '未知错误'));
        setBatchProgressLine({
          i: i + 1,
          n: urls.length,
          ok: okCount,
          fail: failCount,
          url: u,
          state: '失败（已跳过）',
        });
        continue;
      }

      const rows = Array.isArray(res.rows) ? res.rows : [];
      if (res.platformKey) log(`采集管线：${res.platformKey}`);
      log(`采集完成：输出 ${rows.length} 行。`);

      await step(`上报后台（写入 1 条采集记录，含 ${rows.length} 行）`, () =>
        uploadBatch(payload.platform, u, rows)
      );
      okCount++;
      setBatchProgressLine({
        i: i + 1,
        n: urls.length,
        ok: okCount,
        fail: failCount,
        url: u,
        state: '已完成',
      });

      if (i < urls.length - 1) {
        const waitMs = randInt(300, 5000);
        log(`随机等待 ${waitMs}ms 后继续…`);
        setBatchProgressLine({
          i: i + 1,
          n: urls.length,
          ok: okCount,
          fail: failCount,
          url: '',
          state: `等待 ${waitMs}ms`,
        });
        await sleep(waitMs);
      }
    }
  } catch (e) {
    log('批量采集错误: ' + (e?.message || String(e)));
    setBatchProgressLine({ i: 0, n: urls.length, ok: okCount, fail: failCount, url: '', state: '出错' });
  } finally {
    batchRunning = false;
    batchStopRequested = false;
    setBatchButtons();
    log(`批量采集结束：成功 ${okCount} 条，失败 ${failCount} 条。`);
    if (urls.length) {
      setBatchProgressLine({ i: urls.length, n: urls.length, ok: okCount, fail: failCount, url: '', state: '结束' });
    } else {
      setBatchStatusLine();
    }
    toast('批量采集结束');
  }
}

document.getElementById('btnBatchPanelToggle')?.addEventListener('click', () => {
  toggleBatchCard();
});

document.getElementById('btnBatchClear')?.addEventListener('click', () => {
  const ta = document.getElementById('batchUrlsInput');
  if (ta) ta.value = '';
  batchUrlsText = '';
  setBatchStatusLine();
});

document.getElementById('btnBatchSave')?.addEventListener('click', async () => {
  const raw = readBatchTextareaToMemory();
  try {
    await chrome.storage.local.set({ [STORAGE_BATCH_URLS]: raw });
    setBatchStatusLine();
    toast('已保存批量链接');
  } catch (e) {
    toast('保存失败');
    log('保存批量链接失败: ' + (e?.message || String(e)));
  }
});

/** 将当前激活标签页的 http(s) 地址追加到批量列表末尾一行，并写入 storage（与「保存」一致） */
async function appendCurrentTabUrlToBatch() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    toast('无法读取当前标签页');
    log('添加当前页失败: ' + (e?.message || String(e)));
    return;
  }
  const url = tabs[0]?.url ? String(tabs[0].url).trim() : '';
  if (!url) {
    toast('当前标签页无地址');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    toast('当前页不是 http/https 链接，已跳过');
    return;
  }
  readBatchTextareaToMemory();
  const prev = String(batchUrlsText || '');
  const trimmedEnd = prev.replace(/\s+$/, '');
  batchUrlsText = trimmedEnd ? `${trimmedEnd}\n${url}` : url;
  syncBatchTextareaFromMemory();
  try {
    await chrome.storage.local.set({ [STORAGE_BATCH_URLS]: batchUrlsText });
    setBatchStatusLine();
    toast('已追加并保存');
    log(`已追加当前页到批量列表（共 ${parseBatchUrls(batchUrlsText).length} 条）`);
  } catch (e) {
    toast('保存失败');
    log('追加并保存失败: ' + (e?.message || String(e)));
  }
}

document.getElementById('btnBatchAppendCurrent')?.addEventListener('click', () => {
  appendCurrentTabUrlToBatch();
});

// 批量输入框体验优化：
// - 点击文本框下方空白区域时自动补齐空行并定位光标，方便逐行粘贴
// - 在末尾粘贴时如果最后一行不是空行，自动先换行再粘贴
(() => {
  const ta = document.getElementById('batchUrlsInput');
  if (!ta) return;

  function lineCountOf(value) {
    if (!value) return 1;
    return String(value).split('\n').length;
  }

  function ensureLineIndexExists(targetLineIndex) {
    const v = String(ta.value || '');
    const lines = lineCountOf(v);
    const want = Math.max(0, Math.floor(Number(targetLineIndex) || 0));
    if (want < lines) return;
    // 需要补足到 want 这一行（0-based），即总行数 want+1
    const need = want + 1 - lines;
    if (need <= 0) return;
    ta.value = v + '\n'.repeat(need);
    // 同步到内存（不强制保存 storage）
    batchUrlsText = String(ta.value || '');
    setBatchStatusLine();
  }

  // 计算点击对应的行号：根据 line-height 与 scrollTop 估算
  ta.addEventListener('mousedown', (ev) => {
    try {
      const style = window.getComputedStyle(ta);
      const lh = parseFloat(style.lineHeight || '') || 16;
      const rect = ta.getBoundingClientRect();
      const y = ev.clientY - rect.top + ta.scrollTop;
      const lineIndex = Math.floor(y / lh);
      ensureLineIndexExists(lineIndex);
    } catch {
      /* ignore */
    }
  });

  ta.addEventListener('paste', (ev) => {
    try {
      // 记录粘贴前光标位置：粘贴后恢复到“粘贴内容起始处”，避免长链接导致光标/视野跳到最右侧
      const beforeStart = ta.selectionStart;
      const beforeEnd = ta.selectionEnd;
      setTimeout(() => {
        try {
          ta.selectionStart = ta.selectionEnd = Math.min(beforeStart, ta.value.length);
          ta.scrollLeft = 0;
        } catch {
          /* ignore */
        }
      }, 0);
    } catch {
      /* ignore */
    }
  });
})();

document.getElementById('btnBatchStart')?.addEventListener('click', async () => {
  if (batchRunning) return;
  await runBatchScrapeQueue();
});

document.getElementById('btnBatchStop')?.addEventListener('click', async () => {
  if (!batchRunning) return;
  batchStopRequested = true;
  toast('正在停止…');
  // 尝试通知引擎中断当前采集（若 tab 仍存在）
  if (batchTabId != null) {
    try {
      chrome.runtime.sendMessage({ type: 'ABORT_SCRAPE', tabId: batchTabId }, () => {});
    } catch {
      /* ignore */
    }
  }
});

document.getElementById('btnLogin').addEventListener('click', async () => {
  const username = (document.getElementById('loginUser').value || '').trim();
  const password = document.getElementById('loginPass').value || '';
  if (!username || !password) {
    toast('请输入用户名和密码');
    return;
  }
  try {
    const data = await step('登录认证', async () => {
      const res = await fetch(apiBase + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '登录失败');
      return j;
    });
    await step('写入本地会话并进入主界面', () => afterLogin(data.token, data.user));
    toast('登录成功');
  } catch (e) {
    log('登录失败: ' + (e.message || String(e)));
    toast('登录失败');
  }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  authToken = '';
  currentRuleDetail = null;
  await chrome.storage.local.remove([STORAGE_TOKEN, STORAGE_USER]);
  localStorage.removeItem(STORAGE_USER);
  showLoginPanel();
  log('已退出登录。');
});

document.getElementById('ruleSelect').addEventListener('change', (e) => {
  const id = e.target.value;
  loadRuleDetail(id);
});

document.getElementById('btnStorageLocal')?.addEventListener('click', async () => {
  setImagesStorageUI('local');
  try {
    await chrome.storage.local.set({ [STORAGE_IMAGES_STORAGE]: 'local' });
    log('图片存储：已选「本地服务器」');
  } catch {
    /* ignore */
  }
});

document.getElementById('btnStorageOss')?.addEventListener('click', async () => {
  setImagesStorageUI('oss');
  try {
    await chrome.storage.local.set({ [STORAGE_IMAGES_STORAGE]: 'oss' });
    log('图片存储：已选「OSS」');
  } catch {
    /* ignore */
  }
});

document.getElementById('btnRefreshRules').addEventListener('click', async () => {
  if (!authToken) return;
  await step('刷新规则列表', () => refreshRuleList({ silent: false }));
  toast('规则列表已更新');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleRefreshRulesOnPanelShow();
});

document.getElementById('btnSaveApi').addEventListener('click', async () => {
  const raw = (document.getElementById('apiBaseInput').value || '').trim();
  try {
    await chrome.storage.local.set({ [STORAGE_API_BASE]: raw });
    apiBase = normalizeApiBase(raw);
    toast(raw ? '已保存' : '已使用默认接口');
  } catch (e) {
    toast('保存失败');
    log('保存接口地址失败: ' + (e?.message || String(e)));
  }
});

document.getElementById('btnScrapeCurrent').addEventListener('click', async () => {
  const payload = buildEnginePayload();
  if (!payload) {
    log('请先选择有效的采集规则。');
    return;
  }
  try {
    const tabId = await step('获取当前标签页', () => getActiveTabId());
    const tab = await step('读取标签页信息', () => chrome.tabs.get(tabId));
    const pageUrl = tab.url || '';

    log(
      `采集参数：平台=${payload.platform || '（空）'}，字段规则数=${
        payload.rules.length
      }，预处理=${payload.pre_click_xpath ? '有' : '无'}`
    );
    log(`页面地址：${pageUrl || '（空）'}`);

    const res = await step('执行页面采集（注入引擎并运行 XPath）', () =>
      runScrapeOnTab(tabId, pageUrl, payload.rules, payload.pre_click_xpaths, payload.platform)
    );

    if (!res || !res.ok) {
      log('采集失败: ' + (res && res.error ? res.error : '未知错误'));
      toast('采集失败');
      return;
    }
    const rows = Array.isArray(res.rows) ? res.rows : [];
    if (res.platformKey) log(`采集管线：${res.platformKey}`);
    if (Array.isArray(res.logs) && res.logs.length) {
      log(`采集明细日志（${res.logs.length}条）：`);
      for (const line of res.logs) {
        log('  · ' + line);
      }
    }
    log(`采集完成：输出 ${rows.length} 行。`);

    await step(`上报后台（写入 1 条采集记录，含 ${rows.length} 行）`, () =>
      uploadBatch(payload.platform, pageUrl, rows)
    );
    toast('采集并上报完成');
  } catch (e) {
    log('错误: ' + (e.message || String(e)));
    toast('采集出错');
  }
});

chrome.storage.local.get(
  [STORAGE_TOKEN, STORAGE_USER, STORAGE_API_BASE, STORAGE_BATCH_URLS, STORAGE_IMAGES_STORAGE],
  async (data) => {
  applyApiBaseFromStorage(data[STORAGE_API_BASE]);
  setImagesStorageUI(data[STORAGE_IMAGES_STORAGE]);
  if (data[STORAGE_BATCH_URLS] != null) {
    batchUrlsText = String(data[STORAGE_BATCH_URLS] || '');
    syncBatchTextareaFromMemory();
    setBatchStatusLine();
  }
  setBatchButtons();
  if (data[STORAGE_USER]) {
    try {
      localStorage.setItem(STORAGE_USER, data[STORAGE_USER]);
    } catch {
      /* ignore */
    }
  }
  if (data[STORAGE_TOKEN]) {
    authToken = data[STORAGE_TOKEN];
    try {
      const me = await step('检测会话有效性', () => apiFetch('/api/auth/me'));
      await step('自动登录并加载规则', () => afterLogin(authToken, me));
      log('会话有效：已自动登录。');
    } catch {
      authToken = '';
      await chrome.storage.local.remove([STORAGE_TOKEN]);
      showLoginPanel();
      log('登录已过期，请重新登录。');
    }
  } else {
    showLoginPanel();
  }
  }
);
