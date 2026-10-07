// options/options.js — Settings page.
import { $, $$, h, toast, confirmDialog } from '../shared/dom.js';
import { getSettings, saveSettings, getApiKey, saveApiKey, clearApiKey, clearItems, maskKey, storageEstimate, DEFAULT_SETTINGS } from '../lib/storage.js';
import { testApiKey, listModels } from '../lib/gemini.js';
import { normalizeUrl } from '../lib/validate.js';

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

function fillModels(ids, selected) {
  const list = [...new Set([selected, ...ids].filter(Boolean))];
  $('#model').replaceChildren(...list.map((id) => h('option', { value: id, selected: id === selected }, id)));
}

async function load() {
  const s = await getSettings();
  const key = await getApiKey();

  $('#apiKey').value = key;
  $('#keyStatus').textContent = key ? `Saved key: ${maskKey(key)}` : 'No key saved yet.';
  $$('input[name="keyStorage"]').forEach((r) => (r.checked = r.value === s.keyStorage));
  fillModels(FALLBACK_MODELS, s.model);

  for (const id of ['language', 'tone', 'nicheContext', 'defaultLink', 'mediaBaseUrl', 'proxyUrl', 'proxyToken', 'fallbackBoard', 'pinterestCreateUrl', 'selectorOverrides']) $('#' + id).value = s[id] || '';
  for (const id of ['keywordCount', 'titleMax', 'descriptionMax', 'concurrency', 'requestsPerMinute', 'tagCount', 'delayMinSec', 'delayMaxSec', 'dailyLimit']) $('#' + id).value = s[id];
  for (const id of ['autoMode', 'addTags', 'reliableMode']) $('#' + id).checked = !!s[id];
  $$('input[name="publishMode"]').forEach((r) => (r.checked = r.value === s.publishMode));
  $('#boards').value = (s.boards || []).join('\n');
  $('#includeHashtags').checked = !!s.includeHashtags;
  $$('input[name="linkMode"]').forEach((r) => (r.checked = r.value === s.linkMode));

  $('#version').textContent = chrome.runtime.getManifest().version;
  showUsage();
}

async function showUsage() {
  const est = await storageEstimate();
  if (!est) return ($('#usage').textContent = '');
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  $('#usage').textContent = `Using ${mb(est.usage)} of browser storage for images and results.`;
}

const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
};

function checkUrlField(id) {
  const r = normalizeUrl($('#' + id).value);
  $('#' + id + 'Err').textContent = r.ok ? '' : r.error;
  $('#' + id).classList.toggle('invalid', !r.ok);
  return r;
}

async function onSave(e) {
  e.preventDefault();

  // Ask for permission to reach the proxy server FIRST (must happen during the click).
  const proxy = checkUrlField('proxyUrl');
  let proxyGranted = true;
  if (proxy.ok && proxy.url) {
    const origin = new URL(proxy.url).origin + '/*';
    try {
      proxyGranted = await chrome.permissions.request({ origins: [origin] });
    } catch {
      proxyGranted = false;
    }
  }

  const link = checkUrlField('defaultLink');
  const media = checkUrlField('mediaBaseUrl');
  if (!link.ok || !media.ok || !proxy.ok) return toast('Fix the highlighted links first.', 'error');
  if (proxy.url && !proxyGranted) return toast('Chrome permission for the proxy server was not granted.', 'error');
  if (proxy.url && !proxy.url.startsWith('https://')) toast('Tip: use https:// for your proxy so the connection is encrypted.', 'info', 6000);

  // Selector overrides must be valid JSON (or empty).
  const selText = $('#selectorOverrides').value.trim();
  if (selText) {
    try {
      const parsed = JSON.parse(selText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be an object like { "title": ["#id"] }');
      $('#selectorOverridesErr').textContent = '';
    } catch (err) {
      $('#selectorOverridesErr').textContent = 'Invalid JSON: ' + err.message;
      return toast('Fix the selector overrides JSON first.', 'error');
    }
  }
  const createUrl = $('#pinterestCreateUrl').value.trim();
  if (createUrl && !/^https:\/\/([a-z0-9-]+\.)*pinterest\.com\//i.test(createUrl)) return toast('The Create Pin page must be a https://…pinterest.com/ address.', 'error');
  const delayMin = clampInt($('#delayMinSec').value, 5, 3600, 20);
  const delayMax = Math.max(delayMin, clampInt($('#delayMaxSec').value, 5, 3600, 40));

  const keyStorage = $('input[name="keyStorage"]:checked')?.value || 'local';
  const patch = {
    model: $('#model').value || DEFAULT_SETTINGS.model,
    keyStorage,
    language: $('#language').value.trim() || DEFAULT_SETTINGS.language,
    tone: $('#tone').value.trim() || DEFAULT_SETTINGS.tone,
    nicheContext: $('#nicheContext').value.trim().slice(0, 1000),
    boards: [...new Set($('#boards').value.split('\n').map((b) => b.trim()).filter(Boolean))].slice(0, 200),
    keywordCount: clampInt($('#keywordCount').value, 3, 30, 12),
    titleMax: clampInt($('#titleMax').value, 30, 100, 100),
    descriptionMax: clampInt($('#descriptionMax').value, 100, 500, 500),
    includeHashtags: $('#includeHashtags').checked,
    linkMode: $('input[name="linkMode"]:checked')?.value || 'same',
    defaultLink: link.url,
    mediaBaseUrl: media.url,
    concurrency: clampInt($('#concurrency').value, 1, 6, 2),
    requestsPerMinute: clampInt($('#requestsPerMinute').value, 0, 2000, 10),
    proxyUrl: proxy.url,
    proxyToken: $('#proxyToken').value.trim(),
    autoMode: $('#autoMode').checked,
    reliableMode: $('#reliableMode').checked,
    publishMode: $('input[name="publishMode"]:checked')?.value || 'auto',
    fallbackBoard: $('#fallbackBoard').value.trim(),
    addTags: $('#addTags').checked,
    tagCount: clampInt($('#tagCount').value, 1, 10, 5),
    delayMinSec: delayMin,
    delayMaxSec: delayMax,
    dailyLimit: clampInt($('#dailyLimit').value, 0, 500, 25),
    pinterestCreateUrl: createUrl || DEFAULT_SETTINGS.pinterestCreateUrl,
    selectorOverrides: selText,
  };

  try {
    await saveSettings(patch);
    await saveApiKey($('#apiKey').value, keyStorage);
    const key = await getApiKey();
    $('#keyStatus').textContent = key ? `Saved key: ${maskKey(key)}` : 'No key saved.';
    $('#keyStatus').className = 'hint';
    $('#saveStatus').textContent = 'Saved ' + new Date().toLocaleTimeString();
    toast('Settings saved.', 'success');
    load();
  } catch (err) {
    toast('Could not save: ' + err.message, 'error');
  }
}

async function onTestKey() {
  const key = $('#apiKey').value.trim();
  const status = $('#keyStatus');
  if (!key) {
    status.textContent = 'Paste a key first.';
    status.className = 'hint error-text';
    return;
  }
  status.textContent = 'Testing…';
  status.className = 'hint';
  try {
    const r = await testApiKey(key);
    status.textContent = `Key works — ${r.modelCount} Gemini models available. Don't forget to save.`;
    status.className = 'hint ok-text';
    fillModels(r.models.map((m) => m.id), $('#model').value);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'hint error-text';
  }
}

async function onLoadModels() {
  const key = $('#apiKey').value.trim();
  if (!key) return toast('Paste your API key first.', 'info');
  try {
    const models = await listModels(key);
    fillModels(models.map((m) => m.id), $('#model').value);
    toast(`Loaded ${models.length} models.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#form').addEventListener('submit', onSave);
$('#testKey').addEventListener('click', onTestKey);
$('#loadModels').addEventListener('click', onLoadModels);
$('#toggleKey').addEventListener('click', (e) => {
  const input = $('#apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? 'Hide' : 'Show';
  e.currentTarget.setAttribute('aria-pressed', String(show));
});
$('#forgetKey').addEventListener('click', async () => {
  if (!(await confirmDialog('Remove the saved Gemini API key from this browser?', 'Remove', true))) return;
  await clearApiKey();
  $('#apiKey').value = '';
  $('#keyStatus').textContent = 'Key removed.';
  toast('API key removed.', 'success');
});
$('#wipeAll').addEventListener('click', async () => {
  if (!(await confirmDialog('Delete ALL uploaded images and generated pin data? Settings and your API key are kept.', 'Delete everything', true))) return;
  await clearItems();
  toast('All images and results deleted. Reload the workspace tab.', 'success', 5000);
  showUsage();
});

load();
