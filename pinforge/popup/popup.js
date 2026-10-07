// popup/popup.js — small launcher shown when the toolbar icon is clicked.
import { getAllItems, getApiKey, getSettings } from '../lib/storage.js';

document.getElementById('openApp').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'open-app' });
  window.close();
});
document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const [items, key, settings] = await Promise.all([getAllItems().catch(() => []), getApiKey(), getSettings()]);
  document.getElementById('sTotal').textContent = items.length;
  document.getElementById('sDone').textContent = items.filter((i) => i.status === 'done').length;
  document.getElementById('sErr').textContent = items.filter((i) => i.status === 'error').length;
  document.getElementById('noKey').classList.toggle('hidden', Boolean(key || settings.proxyUrl));
})();
