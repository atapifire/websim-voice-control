const NATIVE_HOST = 'com.websim.voicecontrol';
let codexPort = null;
let codexTabId = null;
const uiRefs = {
  help: { windowId: null, tabId: null, opening: false },
  terminal: { windowId: null, tabId: null, opening: false }
};
let terminalState = [];
let sourceBrowserWindowId = null;
let sourceBrowserTabId = null;
const loginUrls = new Set();

function notifyUi(update) {
  terminalState = [...terminalState, update].slice(-200);
  const terminalTabId = uiRefs.terminal.tabId;
  if (terminalTabId !== null) chrome.tabs.sendMessage(terminalTabId, { type: 'terminal-update', ...update }, () => void chrome.runtime.lastError);
}

function openUi(view) {
  const ref = uiRefs[view] || uiRefs.help;
  const url = view === 'terminal'
    ? chrome.runtime.getURL('terminal.html')
    : chrome.runtime.getURL('ui.html?view=help');
  if (ref.opening) return;
  if (ref.windowId !== null) {
    chrome.windows.update(ref.windowId, { focused: true }, () => {
      if (ref.tabId !== null) chrome.tabs.update(ref.tabId, { url });
    });
    return;
  }
  ref.opening = true;
  chrome.tabs.query({ url: `${chrome.runtime.getURL(view === 'terminal' ? 'terminal.html' : 'ui.html')}*` }, allUiTabs => {
    const existingTabs = allUiTabs.filter(tab => tab.url === url);
    const existing = existingTabs[0];
    for (const duplicate of existingTabs.slice(1)) chrome.tabs.remove(duplicate.id, () => void chrome.runtime.lastError);
    if (existing) {
      ref.windowId = existing.windowId;
      ref.tabId = existing.id;
      ref.opening = false;
      chrome.windows.update(ref.windowId, { focused: true }, () => void chrome.runtime.lastError);
      return;
    }
    chrome.windows.create({ url, type: 'popup', width: view === 'terminal' ? 760 : 560, height: view === 'terminal' ? 620 : 700 }, windowInfo => {
      ref.opening = false;
      ref.windowId = windowInfo?.id ?? null;
      ref.tabId = windowInfo?.tabs?.[0]?.id ?? null;
    });
  });
}

function closeLoginTabs() {
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (/^https:\/\/websim\.com\/_cli-login\?challengeId=[A-Za-z0-9-]+/.test(String(tab.url || ''))) {
        chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError);
      }
    }
  });
  loginUrls.clear();
}

function openProjectTab(url) {
  if (!/^https:\/\/websim\.com\//i.test(url)) return;
  const canonical = url.replace(/\/$/, '');
  chrome.tabs.query({ url: 'https://websim.com/*' }, tabs => {
    const matches = tabs.filter(tab => String(tab.url || '').replace(/\/$/, '') === canonical);
    const existing = matches.find(tab => tab.windowId === sourceBrowserWindowId) || matches[0];
    const activate = tabId => chrome.tabs.update(tabId, { active: true }, () => void chrome.runtime.lastError);
    const removeDuplicates = keepId => {
      for (const duplicate of matches) {
        if (duplicate.id !== keepId) chrome.tabs.remove(duplicate.id, () => void chrome.runtime.lastError);
      }
    };
    if (existing) {
      const finish = tab => {
        const moved = Array.isArray(tab) ? tab[0] : tab;
        if (!moved?.id) return;
        removeDuplicates(moved.id);
        activate(moved.id);
      };
      if (sourceBrowserWindowId !== null && existing.windowId !== sourceBrowserWindowId) {
        chrome.tabs.move(existing.id, { windowId: sourceBrowserWindowId, index: -1 }, finish);
      } else {
        finish(existing);
      }
      return;
    }
    const create = { url, active: true };
    if (sourceBrowserWindowId !== null) create.windowId = sourceBrowserWindowId;
    chrome.tabs.create(create, tab => {
      if (chrome.runtime.lastError || !tab?.id) return;
      // The project is always a tab in the originating window; the original
      // voice-control page is left intact.
      activate(tab.id);
    });
  });
}

chrome.tabs.onRemoved.addListener(tabId => {
  for (const ref of Object.values(uiRefs)) {
    if (tabId === ref.tabId) { ref.tabId = null; ref.windowId = null; ref.opening = false; }
  }
});

chrome.windows.onRemoved.addListener(windowId => {
  for (const ref of Object.values(uiRefs)) {
    if (windowId === ref.windowId) { ref.tabId = null; ref.windowId = null; ref.opening = false; }
  }
});

function log(level, message, details = {}) {
  const entry = { time: new Date().toISOString(), level, message, details };
  console[level === 'error' ? 'error' : 'log']('[Websim Voice]', message, details);
  chrome.storage.local.get({ websimVoiceLogs: [] }, result => {
    chrome.storage.local.set({ websimVoiceLogs: [...result.websimVoiceLogs, entry].slice(-100) });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'open-ui') {
    sourceBrowserWindowId = sender.tab?.windowId ?? sourceBrowserWindowId;
    sourceBrowserTabId = sender.tab?.id ?? sourceBrowserTabId;
    const view = message.view === 'terminal' ? 'terminal' : 'help';
    log('log', 'Opening UI window', { view, senderTabId: sender.tab?.id });
    openUi(view);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'open-project-tab') {
    sourceBrowserWindowId = sender.tab?.windowId ?? sourceBrowserWindowId;
    sourceBrowserTabId = sender.tab?.id ?? sourceBrowserTabId;
    openProjectTab(String(message.url || ''));
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'close-ui') {
    const view = message.view === 'terminal' ? 'terminal' : message.view === 'help' ? 'help' : null;
    const refs = view ? [uiRefs[view]] : Object.values(uiRefs);
    let pending = refs.length;
    const closeWindow = () => {
      if (--pending > 0) return;
      sendResponse({ ok: true });
    };
    for (const ref of refs) {
      const windowId = ref.windowId;
      ref.windowId = null;
      ref.tabId = null;
      ref.opening = false;
      if (windowId !== null) chrome.windows.remove(windowId, closeWindow);
      else closeWindow();
    }
    return true;
  }
  if (message.type === 'scroll-ui') {
    const helpTabId = uiRefs.help.tabId;
    if (helpTabId !== null) chrome.tabs.sendMessage(helpTabId, { type: 'scroll-ui', direction: message.direction }, () => void chrome.runtime.lastError);
    sendResponse({ ok: true, target: helpTabId !== null ? 'help' : 'page' });
    return true;
  }
  if (message.type === 'cycle-window') {
    chrome.windows.getLastFocused({ populate: false }, focused => {
      const focusedIsUi = Object.values(uiRefs).some(ref => ref.windowId !== null && ref.windowId === focused?.id);
      if (focusedIsUi && sourceBrowserWindowId !== null) {
        chrome.windows.update(sourceBrowserWindowId, { focused: true }, () => sendResponse({ ok: !chrome.runtime.lastError, windowId: sourceBrowserWindowId }));
        return;
      }
      chrome.windows.getAll({ populate: false }, windows => {
        const usable = windows.filter(item => item.type === 'normal' || item.type === 'popup');
        const current = focused?.id ?? sender.tab?.windowId;
        const index = usable.findIndex(item => item.id === current);
        const next = usable[(index + 1) % usable.length];
        if (next) chrome.windows.update(next.id, { focused: true });
        sendResponse({ ok: Boolean(next), windowId: next?.id });
      });
    });
    return true;
  }
  if (message.type === 'switch-tab') {
    chrome.windows.getLastFocused({ populate: false }, focused => {
      const focusedIsUi = Object.values(uiRefs).some(ref => ref.windowId !== null && ref.windowId === focused?.id);
      const windowId = focusedIsUi ? sourceBrowserWindowId : focused?.id;
      if (windowId === null || windowId === undefined) { sendResponse({ ok: false }); return; }
      chrome.tabs.query({ windowId }, tabs => {
        const usable = tabs.filter(tab => !tab.pinned).sort((a, b) => a.index - b.index);
        const activeIndex = usable.findIndex(tab => tab.active);
        const next = usable[(activeIndex + 1) % usable.length];
        if (!next || usable.length < 2) { sendResponse({ ok: false, reason: 'Only one tab is open.' }); return; }
        chrome.windows.update(windowId, { focused: true }, () => {
          chrome.tabs.update(next.id, { active: true }, () => sendResponse({ ok: !chrome.runtime.lastError, tabId: next.id }));
        });
      });
    });
    return true;
  }
  if (message.type === 'get-ui-state') {
    sendResponse({ terminalState });
    return true;
  }
  if (message.type === 'get-codex-sessions') {
    if (typeof chrome.runtime.sendNativeMessage !== 'function') {
      sendResponse({ ok: false, error: 'Chrome native messaging is unavailable.' });
      return true;
    }
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { kind: 'codex-sessions', filter: message.filter || '' }, response => {
      const error = chrome.runtime.lastError;
      sendResponse(error ? { ok: false, error: error.message } : (response || { ok: false, error: 'No session list returned.' }));
    });
    return true;
  }
  if (message.type === 'ensure-content-ui') {
    const tabId = message.tabId;
    if (!tabId) { sendResponse({ ok: false, error: 'No active tab.' }); return true; }
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      .then(() => new Promise(resolve => setTimeout(resolve, 50)))
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'show-help' }))
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'get-logs') {
    chrome.storage.local.get({ websimVoiceLogs: [] }, result => sendResponse({ logs: result.websimVoiceLogs }));
    return true;
  }
  if (message.type === 'clear-logs') {
    chrome.storage.local.remove('websimVoiceLogs', () => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'voice-log') {
    log('log', message.message, message.details || {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'get-codex-model') {
    chrome.storage.local.get({ codexModel: '', codexReasoning: '' }, result => {
      if (result.codexModel && result.codexReasoning) {
        sendResponse({ model: result.codexModel, reasoning: result.codexReasoning });
        return;
      }
      if (typeof chrome.runtime.sendNativeMessage !== 'function') {
        sendResponse({ ok: false, error: 'Chrome native messaging is unavailable. Reload the extension first.' });
        return;
      }
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { kind: 'codex-status' }, response => {
        const error = chrome.runtime.lastError;
        if (error) { sendResponse({ ok: false, error: error.message }); return; }
        sendResponse({ ...response, reasoning: result.codexReasoning || response?.reasoning });
      });
    });
    return true;
  }
  if (message.type === 'set-codex-model') {
    chrome.storage.local.set({ codexModel: message.model || '', codexReasoning: message.reasoning || 'medium' }, () => sendResponse({ ok: true, model: message.model || '', reasoning: message.reasoning || 'medium' }));
    return true;
  }
  if (message.type === 'set-codex-reasoning') {
    chrome.storage.local.set({ codexReasoning: message.reasoning }, () => sendResponse({ ok: true, reasoning: message.reasoning }));
    return true;
  }
  if (message.type === 'run-codex-agent') {
    if (codexPort) {
      sendResponse({ ok: false, error: 'A Codex task is already running.' });
      return true;
    }
    chrome.storage.local.get({ codexModel: '', codexReasoning: '' }, result => {
      const payload = { kind: 'codex', prompt: message.prompt, sessionId: message.sessionId || undefined, model: result.codexModel || undefined, reasoning: result.codexReasoning || undefined };
      log('log', 'Running Codex agent request', { prompt: message.prompt, model: payload.model || 'configured default' });
      if (typeof chrome.runtime.connectNative !== 'function') {
        const error = 'Chrome native messaging is unavailable. Reload the extension after adding nativeMessaging permission.';
        log('error', error);
        sendResponse({ ok: false, error });
        return;
      }
      try {
        terminalState = [{ kind: 'progress', text: 'Codex request received. Starting the agent…' }];
        openUi('terminal');
        codexTabId = sender.tab?.id;
        const port = chrome.runtime.connectNative(NATIVE_HOST);
        codexPort = port;
        let completionHandled = false;
        port.onMessage.addListener(update => {
          if (update.kind === 'codex-done' && completionHandled) return;
          terminalState = [...terminalState, update].slice(-200);
          if (codexTabId) chrome.tabs.sendMessage(codexTabId, { type: 'codex-progress', ...update });
          const terminalTabId = uiRefs.terminal.tabId;
          if (terminalTabId !== null) chrome.tabs.sendMessage(terminalTabId, { type: 'terminal-update', ...update }, () => void chrome.runtime.lastError);
          if (update.kind === 'login-required' && update.url) {
            if (/^https:\/\/websim\.com\/_cli-login\?challengeId=[A-Za-z0-9-]+$/.test(update.url) && !loginUrls.has(update.url)) {
              loginUrls.add(update.url);
              chrome.tabs.create({ url: update.url, active: true }, () => void chrome.runtime.lastError);
            }
          }
          if (update.kind === 'login-complete') {
            closeLoginTabs();
          }
          if (update.kind === 'codex-done' && update.projectUrl) {
            openProjectTab(update.projectUrl);
          }
          if (update.kind === 'codex-done') {
            completionHandled = true;
            log(update.ok ? 'log' : 'error', 'Codex agent finished', update);
            port.disconnect();
            if (codexPort === port) codexPort = null;
            codexTabId = null;
          }
        });
        port.onDisconnect.addListener(() => {
          if (completionHandled) return;
          const error = chrome.runtime.lastError?.message;
          if (error && codexTabId) chrome.tabs.sendMessage(codexTabId, { type: 'codex-progress', kind: 'codex-done', ok: false, error });
          if (error) notifyUi({ kind: 'codex-done', ok: false, error });
          if (error) log('error', 'Codex native port disconnected', { error });
          if (codexPort === port) codexPort = null;
          codexTabId = null;
        });
        port.postMessage(payload);
        notifyUi({ kind: 'progress', text: 'Codex agent started. Terminal output will appear here.' });
        if (codexTabId) chrome.tabs.sendMessage(codexTabId, { type: 'codex-progress', kind: 'progress', text: 'Codex agent started. Terminal output will appear here.' });
        sendResponse({ ok: true, started: true });
      } catch (error) {
        log('error', 'Codex agent could not start', { error: error.message });
        notifyUi({ kind: 'codex-done', ok: false, error: error.message });
        codexPort = null;
        codexTabId = null;
        sendResponse({ ok: false, error: error.message });
      }
    });
    return true;
  }
  if (message.type === 'stop-codex-agent') {
    if (!codexPort) { sendResponse({ ok: false, error: 'No Codex task is running.' }); return true; }
    codexPort.postMessage({ kind: 'cancel-codex' });
    log('log', 'Codex stop requested');
    sendResponse({ ok: true });
    return true;
  }
  if (message.type !== 'run-websim-cli') return false;
  log('log', 'Running websim-cli command', { args: message.args || [] });
  if (typeof chrome.runtime.sendNativeMessage !== 'function') {
    const error = 'Chrome native messaging is unavailable. Reload the extension after adding nativeMessaging permission.';
    log('error', error);
    sendResponse({ ok: false, error });
    return true;
  }
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { args: message.args || [] }, response => {
    const error = chrome.runtime.lastError;
    if (error) {
      log('error', 'Native host failed', { error: error.message });
      sendResponse({ ok: false, error: error.message });
    } else {
      log(response?.ok ? 'log' : 'error', 'Native host returned', response || {});
      sendResponse(response || { ok: false, error: 'Native host returned no response.' });
    }
  });
  return true;
});
