// lib/storage.js
// Two kinds of storage:
//  1. Settings  -> chrome.storage.local (small key/value data)
//     The API key can be kept in chrome.storage.session instead ("don't remember
//     after browser closes") — chosen on the Settings page.
//  2. Pins/images -> IndexedDB (can hold many image blobs; chrome.storage can't)

export const DEFAULT_SETTINGS = Object.freeze({
  model: 'gemini-2.5-flash',
  keyStorage: 'local', // 'local' = remember | 'session' = forget when Chrome closes
  language: 'English',
  tone: 'friendly and helpful',
  nicheContext: '',
  boards: [],
  keywordCount: 12,
  titleMax: 100,
  descriptionMax: 500,
  includeHashtags: false,
  linkMode: 'same', // 'same' = one URL for all pins | 'individual'
  defaultLink: '',
  mediaBaseUrl: '',
  concurrency: 2,
  requestsPerMinute: 10,
  proxyUrl: '',
  proxyToken: '',
  // Pinterest publishing
  autoMode: false, // drop images -> generate -> publish, no clicks
  reliableMode: true, // real clicks/typing/upload via Chrome's debugger (most reliable)
  publishMode: 'auto', // 'auto' = PinForge clicks Publish | 'fill' = fills the form, you click Publish
  pinterestCreateUrl: 'https://www.pinterest.com/pin-creation-tool/',
  addTags: true,
  tagCount: 5,
  delayMinSec: 20,
  delayMaxSec: 40,
  dailyLimit: 25,
  fallbackBoard: '',
  selectorOverrides: '',
});

const SETTINGS_KEY = 'settings';
const API_KEY = 'geminiApiKey';

// ---------- Settings ----------

export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // v1.3: the old default pause (45–90 s) became 20–40 s — move users who never changed it.
  if (s.delayMinSec === 45 && s.delayMaxSec === 90) {
    s.delayMinSec = DEFAULT_SETTINGS.delayMinSec;
    s.delayMaxSec = DEFAULT_SETTINGS.delayMaxSec;
  }
  return s;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) });
    }
  });
}

// ---------- API key ----------

export async function getApiKey() {
  const s = await chrome.storage.session.get(API_KEY);
  if (s[API_KEY]) return s[API_KEY];
  const l = await chrome.storage.local.get(API_KEY);
  return l[API_KEY] || '';
}

/** Save the key in exactly one place, removing it from the other. */
export async function saveApiKey(key, where = 'local') {
  const value = String(key || '').trim();
  await chrome.storage.session.remove(API_KEY);
  await chrome.storage.local.remove(API_KEY);
  if (!value) return;
  if (where === 'session') await chrome.storage.session.set({ [API_KEY]: value });
  else await chrome.storage.local.set({ [API_KEY]: value });
}

export async function clearApiKey() {
  await chrome.storage.session.remove(API_KEY);
  await chrome.storage.local.remove(API_KEY);
}

/** "AIza…x9Qk" — shown in the UI instead of the full key. */
export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : key.slice(0, 4) + '…' + key.slice(-4);
}

// ---------- IndexedDB (pins + images) ----------

const DB_NAME = 'pinforge';
const DB_VERSION = 1;
const STORE = 'items';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store, (r) => (result = r))).catch(reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
      }),
  );
}

export function getAllItems() {
  return tx('readonly', (store, done) => {
    const req = store.index('createdAt').getAll();
    req.onsuccess = () => done(req.result || []);
  });
}

export function putItem(item) {
  return tx('readwrite', (store) => {
    store.put({ ...item, updatedAt: Date.now() });
  });
}

export function deleteItem(id) {
  return tx('readwrite', (store) => {
    store.delete(id);
  });
}

export function clearItems() {
  return tx('readwrite', (store) => {
    store.clear();
  });
}

/** Rough storage usage for the Settings page. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
