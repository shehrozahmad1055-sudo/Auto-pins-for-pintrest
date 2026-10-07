// background/service-worker.js
// Manifest V3 background script. It sleeps most of the time and only wakes up for events.
// Gemini calls are made from the workspace page (an extension page with the same
// permissions), so long bulk jobs aren't cut off when the service worker sleeps.

const APP_URL = chrome.runtime.getURL('app/app.html');

/** Focus the workspace tab if it's already open, otherwise open a new one. */
async function openApp() {
  // runtime.getContexts finds our own open pages without needing the "tabs" permission.
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [APP_URL] });
  if (existing && existing.tabId >= 0) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
}

// First install: open Settings so the user can paste their API key.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages.
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'open-app') {
    openApp().then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }
  return false;
});
