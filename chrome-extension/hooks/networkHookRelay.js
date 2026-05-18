/**
 * 隔离世界 · document_start
 * 接收 MAIN world postMessage，转发至 background，并合并摘要到 #__ai_sku_json_bridge__ 供 sku_json_engine 消费。
 */
(function () {
  if (window.__aiNetworkHookRelayLoaded) return;
  window.__aiNetworkHookRelayLoaded = true;

  var BRIDGE_ID = '__ai_sku_json_bridge__';
  var SRC = 'ai-scraper-net-hook';
  var TYPE = 'AI_NET_SKU_SCAN';

  function mergeSnapshots(msg) {
    try {
      var el = document.getElementById(BRIDGE_ID);
      var cur = {};
      if (el && el.textContent) {
        try {
          cur = JSON.parse(el.textContent);
        } catch (_) {
          cur = {};
        }
      }
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
      var arr = Array.isArray(cur.__networkSkuSnapshots) ? cur.__networkSkuSnapshots : [];
      arr.push({
        capturedAt: msg.capturedAt || new Date().toISOString(),
        url: msg.url || '',
        transport: msg.transport || '',
        method: msg.method || '',
        textLen: msg.textLen || 0,
        hits: Array.isArray(msg.hits) ? msg.hits : [],
      });
      cur.__networkSkuSnapshots = arr.slice(-35);
      var text = JSON.stringify(cur);
      if (!el) {
        el = document.createElement('script');
        el.id = BRIDGE_ID;
        el.type = 'application/json';
        (document.documentElement || document.head || document.body || document).appendChild(el);
      }
      el.textContent = text;
      el.setAttribute('data-ai-sku-json-bridge', '1');
    } catch (_) {}
  }

  function validatePayload(d) {
    if (!d || d.source !== SRC || d.type !== TYPE || d.v !== 1) return false;
    if (!Array.isArray(d.hits) || d.hits.length > 20) return false;
    for (var i = 0; i < d.hits.length; i++) {
      var h = d.hits[i];
      if (!h || typeof h !== 'object') return false;
      if (typeof h.preview !== 'string' || h.preview.length > 26000) return false;
    }
    return true;
  }

  window.addEventListener(
    'message',
    function (ev) {
      try {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!validatePayload(d)) return;
        mergeSnapshots(d);
        chrome.runtime.sendMessage({ type: 'NET_SKU_HOOK', payload: d, pageUrl: location.href }).catch(function () {});
      } catch (_) {}
    },
    false
  );
})();
