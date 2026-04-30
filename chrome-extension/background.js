chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

function waitTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, 120000);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => resolve(), 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectEngine(tabId) {
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

  if (msg.type === 'RUN_SCRAPE') {
    (async () => {
      try {
        const tabId = msg.tabId;
        if (!tabId) {
          sendResponse({ ok: false, error: '缺少 tabId' });
          return;
        }
        await injectEngine(tabId);
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'RUN_SCRAPE',
          rules: msg.rules,
          pre_click_xpath: msg.pre_click_xpath || '',
          pre_click_xpaths: Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [],
          url: msg.url || '',
          platform: msg.platform != null ? String(msg.platform) : '',
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
        const tabId = msg.tabId;
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
        await waitTabComplete(tabId);
        await injectEngine(tabId);
        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'RUN_SCRAPE',
          rules: msg.rules,
          pre_click_xpath: msg.pre_click_xpath || '',
          pre_click_xpaths: Array.isArray(msg.pre_click_xpaths) ? msg.pre_click_xpaths : [],
          url: u,
          platform: msg.platform != null ? String(msg.platform) : '',
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'RUN_SCRAPE_MULTI') {
    (async () => {
      const rowsAll = [];
      const errors = [];
      let tabId = msg.tabId;
      const urls = msg.urls || [];
      const rules = msg.rules;
      const pre = msg.pre_click_xpath || '';

      for (let i = 0; i < urls.length; i++) {
        const u = urls[i].trim();
        if (!u) continue;
        try {
          await chrome.tabs.update(tabId, { url: u });
          await waitTabComplete(tabId);
          await injectEngine(tabId);
          const result = await chrome.tabs.sendMessage(tabId, {
            type: 'RUN_SCRAPE',
            rules,
            pre_click_xpath: pre,
            url: u,
            platform: msg.platform != null ? String(msg.platform) : '',
          });
          if (result && result.ok && Array.isArray(result.rows)) {
            rowsAll.push(...result.rows);
          } else {
            errors.push({ url: u, error: (result && result.error) || '未知错误' });
          }
        } catch (e) {
          errors.push({ url: u, error: e.message || String(e) });
        }
      }
      sendResponse({ ok: true, rows: rowsAll, errors });
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
});
