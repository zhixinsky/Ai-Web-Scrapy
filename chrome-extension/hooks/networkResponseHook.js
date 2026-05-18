/**
 * MAIN world · document_start
 * 拦截 fetch / XHR，clone 响应体后异步扫描 JSON，命中 SKU 相关字段则 postMessage 给隔离 content script。
 * 不修改响应链：始终返回原始 Response / 不改变 XHR 行为。
 */
(function () {
  if (window.__aiNetworkSkuHookInstalled) return;
  window.__aiNetworkSkuHookInstalled = true;

  var MSG_SOURCE = 'ai-scraper-net-hook';
  var MSG_TYPE = 'AI_NET_SKU_SCAN';
  var MAX_BODY = 900000;
  var MAX_SCAN_NODES = 12000;
  var MAX_DEPTH = 14;
  var POST_BURST = 24;
  var POST_WINDOW_MS = 10000;

  var postCount = 0;
  var postWindowStart = Date.now();

  function str(v) {
    return String(v == null ? '' : v);
  }

  function resolveFetchUrl(input) {
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) return str(input.url);
    } catch (_) {}
    return str(input && (input.url != null ? input.url : input));
  }

  function bodySnippet(body) {
    if (body == null) return '';
    if (typeof body === 'string') return body.slice(0, 4000);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return str(body.toString()).slice(0, 4000);
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      try {
        return Array.from(body.entries())
          .map(function (kv) {
            return kv[0] + '=' + kv[1];
          })
          .join('&')
          .slice(0, 4000);
      } catch (_) {
        return '';
      }
    }
    try {
      return JSON.stringify(body).slice(0, 4000);
    } catch (_) {
      return '';
    }
  }

  function stripJsonpInner(text) {
    var s = str(text).replace(/^\uFEFF/, '').trim();
    if (!s) return '';
    var first = s.indexOf('(');
    var last = s.lastIndexOf(')');
    if (first < 0 || last <= first) return s;
    return s.slice(first + 1, last).trim().replace(/;+\s*$/g, '');
  }

  function tryParseJsonText(text) {
    var raw = str(text);
    if (!raw || raw.length > MAX_BODY) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {}
    try {
      return JSON.parse(stripJsonpInner(raw));
    } catch (_) {
      return null;
    }
  }

  /** 键名是否命中「SKU / 商品 / 价格 / 库存」等语义（子串，大小写不敏感） */
  function keyTag(key) {
    var k = str(key).toLowerCase();
    if (!k) return null;
    if (k.indexOf('skuid') >= 0) return 'skuid';
    if (k.indexOf('sku') >= 0) return 'sku';
    if (k.indexOf('productid') >= 0 || k.indexOf('itemid') >= 0 || k.indexOf('product_id') >= 0) return 'product';
    if (k.indexOf('price') >= 0) return 'price';
    if (k.indexOf('inventory') >= 0 || k.indexOf('stock') >= 0) return 'inventory';
    if (k.indexOf('quantity') >= 0 || k.indexOf('qty') >= 0) return 'quantity';
    return null;
  }

  function scoreObjectKeys(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { score: 0, tags: [] };
    var tags = [];
    var seen = {};
    for (var key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      var t = keyTag(key);
      if (t && !seen[t]) {
        seen[t] = 1;
        tags.push(t);
      }
    }
    return { score: tags.length, tags: tags };
  }

  function scanValue(node, depth, state) {
    if (!node || depth > MAX_DEPTH || state.nodes >= MAX_SCAN_NODES) return;
    state.nodes += 1;
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      var lim = Math.min(node.length, 80);
      for (var i = 0; i < lim; i++) scanValue(node[i], depth + 1, state);
      return;
    }
    var sc = scoreObjectKeys(node);
    var tags = sc.tags;
    var interesting =
      tags.length >= 2 ||
      tags.indexOf('skuid') >= 0 ||
      (tags.indexOf('sku') >= 0 && (tags.indexOf('price') >= 0 || tags.indexOf('inventory') >= 0 || tags.indexOf('quantity') >= 0));
    if (interesting) {
      var preview = '';
      try {
        preview = JSON.stringify(node);
        if (preview.length > 24000) preview = preview.slice(0, 24000) + '…[truncated]';
      } catch (_) {
        preview = '[unstringifiable]';
      }
      state.hits.push({
        path: state.pathStack.join('.') || '(root)',
        tags: tags,
        keysSample: Object.keys(node).slice(0, 40),
        preview: preview,
      });
      if (state.hits.length >= 12) return;
    }
    var entries = Object.keys(node);
    var cap = Math.min(entries.length, 60);
    for (var j = 0; j < cap; j++) {
      if (state.hits.length >= 12) return;
      var k = entries[j];
      state.pathStack.push(k);
      scanValue(node[k], depth + 1, state);
      state.pathStack.pop();
    }
  }

  function scanJsonTree(root) {
    var state = { nodes: 0, hits: [], pathStack: [] };
    scanValue(root, 0, state);
    return state.hits;
  }

  function canPost() {
    var now = Date.now();
    if (now - postWindowStart > POST_WINDOW_MS) {
      postWindowStart = now;
      postCount = 0;
    }
    if (postCount >= POST_BURST) return false;
    postCount += 1;
    return true;
  }

  function emit(url, transport, method, textLen, hits) {
    if (!hits || !hits.length) return;
    if (!canPost()) return;
    try {
      window.postMessage(
        {
          source: MSG_SOURCE,
          type: MSG_TYPE,
          v: 1,
          url: str(url).slice(0, 2000),
          transport: transport,
          method: method || '',
          textLen: textLen,
          hits: hits,
          capturedAt: new Date().toISOString(),
          host: str(location.hostname),
        },
        location.origin || '*'
      );
    } catch (_) {}
  }

  function handleText(url, transport, method, text) {
    try {
      var t = str(text);
      if (!t || t.length > MAX_BODY) return;
      var low = t.slice(0, 8000).toLowerCase();
      if (
        low.indexOf('sku') < 0 &&
        low.indexOf('product') < 0 &&
        low.indexOf('price') < 0 &&
        low.indexOf('inventory') < 0 &&
        low.indexOf('quantity') < 0
      ) {
        return;
      }
      var parsed = tryParseJsonText(t);
      if (!parsed || typeof parsed !== 'object') return;
      var hits = scanJsonTree(parsed);
      if (hits.length) emit(url, transport, method, t.length, hits);
    } catch (_) {}
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = resolveFetchUrl(input);
      var method = (init && init.method) || (typeof Request !== 'undefined' && input instanceof Request && input.method) || 'GET';
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          var ct = '';
          try {
            ct = res.headers && res.headers.get ? str(res.headers.get('content-type')) : '';
          } catch (_) {}
          if (res && res.ok && res.clone && (/\/json|\/javascript|text\/|json|javascript/i.test(ct) || /mtop|\.json|jsonp/i.test(url))) {
            res
              .clone()
              .text()
              .then(function (text) {
                handleText(url, 'fetch', method, text);
              })
              .catch(function () {});
          }
        } catch (_) {}
        return res;
      });
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try {
        this.__aiNetUrl = str(url);
        this.__aiNetMethod = str(method);
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        this.__aiNetBodyHint = bodySnippet(body);
      } catch (_) {}
      try {
        this.addEventListener(
          'load',
          function () {
            try {
              var url = str(this.responseURL || this.__aiNetUrl || '');
              var method = str(this.__aiNetMethod || 'GET');
              if (this.responseType && this.responseType !== 'text' && this.responseType !== '' && this.responseType !== 'json') return;
              var text = str(this.responseText);
              handleText(url, 'xhr', method, text);
            } catch (_) {}
          },
          false
        );
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  window.__aiNetworkSkuHook = {
    version: 1,
    tryParseJsonText: tryParseJsonText,
    scanJsonTree: scanJsonTree,
  };
})();
