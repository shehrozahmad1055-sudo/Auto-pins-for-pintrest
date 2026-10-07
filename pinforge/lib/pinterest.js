// lib/pinterest.js
// Drives Pinterest's "Create Pin" page from the workspace:
//  1. opens (or reuses) a Pinterest tab, logged in with YOUR account
//  2. injects content/pinterest.js into it
//  3. sends one pin at a time and waits for the result
// No Pinterest password or token is ever handled by PinForge — it uses your normal login.

import { attachDebugger, detachDebugger, isAttached, handleTrusted, cleanupTemps } from './trusted.js';

export const DEFAULT_CREATE_URL = 'https://www.pinterest.com/pin-creation-tool/';
const FATAL = new Set(['NOT_LOGGED_IN', 'UPLOAD_INPUT_NOT_FOUND', 'TITLE_NOT_FOUND', 'DESCRIPTION_NOT_FOUND', 'PUBLISH_NOT_FOUND', 'BOARD_PICKER_NOT_FOUND', 'LINK_NOT_FOUND', 'WINDOW_CLOSED', 'PERMISSION', 'NEEDS_FOCUS', 'PUBLISH_UNCONFIRMED']);

export class PinterestError extends Error {
  constructor(message, code = 'ERROR', step = '') {
    super(message);
    this.name = 'PinterestError';
    this.code = code;
    this.step = step;
    this.fatal = FATAL.has(code);
  }
}

let tabId = null;
let windowId = null;
let currentImage = null; // { blob, name } of the pin being published

// The content script asks for real (trusted) clicks/typing/upload through this listener.
if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'pf-trusted' || sender.tab?.id == null || sender.tab.id !== tabId) return false;
    handleTrusted(msg, { tabId, image: currentImage }).then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
}

/** Stop reliable mode (removes Chrome's "debugging" bar) — call when a batch finishes. */
export async function endPublishingSession() {
  if (tabId != null) {
    await cleanupTemps(tabId).catch(() => {});
    await detachDebugger(tabId).catch(() => {});
  }
}

/** Only allow Pinterest URLs (so a typo in Settings can't send us somewhere else). */
export function safeCreateUrl(url) {
  try {
    const u = new URL(url || DEFAULT_CREATE_URL);
    if (u.protocol === 'https:' && /(^|\.)pinterest\.com$/.test(u.hostname)) return u.href;
  } catch { /* fall through */ }
  return DEFAULT_CREATE_URL;
}

/** Parse the "Selector overrides" JSON from Settings. Returns {} if empty/invalid. */
export function parseSelectorOverrides(text) {
  if (!text || !String(text).trim()) return {};
  try {
    const obj = JSON.parse(text);
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && x.trim());
      else if (typeof v === 'string' && v.trim()) out[k] = [v];
    }
    return out;
  } catch {
    return {};
  }
}

/** Random wait between min and max seconds (human-like pacing). */
export function randomDelayMs(minSec, maxSec) {
  const min = Math.max(5, Number(minSec) || 0);
  const max = Math.max(min, Number(maxSec) || min);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

/** Keeps a per-day publish counter in chrome.storage.local. */
export function todayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function getTodayCount() {
  const { publishLog } = await chrome.storage.local.get('publishLog');
  return publishLog?.date === todayKey() ? publishLog.count : 0;
}

export async function bumpTodayCount() {
  const count = (await getTodayCount()) + 1;
  await chrome.storage.local.set({ publishLog: { date: todayKey(), count } });
  return count;
}

// ------------------------------------------------------------ tab handling

/**
 * Wait until a tab finishes loading.
 * afterNavigation=true ignores the old page's "complete" state and waits for the new load.
 */
function waitForComplete(id, { afterNavigation = false, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let sawLoading = !afterNavigation;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn(v);
    };
    const onUpdated = (tid, info) => {
      if (tid !== id) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish(resolve);
    };
    const onRemoved = (tid) => {
      if (tid === id) finish(reject, new PinterestError('The Pinterest tab was closed.', 'WINDOW_CLOSED'));
    };
    const timer = setTimeout(() => finish(reject, new PinterestError('Pinterest took too long to load. Check your internet.', 'LOAD_TIMEOUT')), timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (!afterNavigation) chrome.tabs.get(id).then((t) => t.status === 'complete' && finish(resolve)).catch(() => {});
  });
}

async function tabAlive() {
  if (tabId == null) return false;
  try {
    const t = await chrome.tabs.get(tabId);
    windowId = t.windowId ?? windowId;
    return true;
  } catch {
    tabId = null;
    windowId = null;
    return false;
  }
}

/**
 * Open a fresh Create Pin page in a normal tab next to PinForge (same Chrome window)
 * and bring it to the front, so you can watch it fill in. The tab stays open.
 * Nothing depends on screen size, so it works on any laptop.
 */
export async function openCreatePage(url) {
  const target = safeCreateUrl(url);
  if (await tabAlive()) {
    const ready = waitForComplete(tabId, { afterNavigation: true });
    await chrome.tabs.update(tabId, { url: target, active: true });
    await ready;
  } else {
    const here = await chrome.windows.getCurrent().catch(() => null);
    const tab = await chrome.tabs.create({ url: target, active: true, ...(here?.id != null ? { windowId: here.id } : {}) });
    tabId = tab.id;
    windowId = tab.windowId ?? here?.id ?? null;
    await waitForComplete(tabId);
  }
  await focusPinterestWindow();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/pinterest.js'] });
  } catch (err) {
    throw new PinterestError('Chrome blocked access to Pinterest. Open chrome://extensions, reload PinForge and allow it on pinterest.com. (' + err.message + ')', 'PERMISSION');
  }
  return tabId;
}

/** Bring the Pinterest tab (and its window) to the front. */
export async function focusPinterestWindow() {
  if (tabId != null) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  if (windowId != null) await chrome.windows.update(windowId, { focused: true }).catch(() => {});
}

function send(message, timeoutMs) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => setTimeout(() => reject(new PinterestError('Pinterest page stopped responding.', 'TIMEOUT')), timeoutMs)),
  ]).catch((err) => {
    if (err instanceof PinterestError) throw err;
    throw new PinterestError('Lost connection to the Pinterest page (' + err.message + ').', 'DISCONNECTED');
  });
}

/**
 * Runs inside Pinterest's own page (main world). If Pinterest opens its file dialog
 * (input.click() / showPicker()), hand it our image instead of showing the dialog.
 * This is upload strategy 3 — used only if giving the file directly doesn't work.
 */
export function installFileChooserPatch(dataUrl, name, type) {
  const bin = atob(dataUrl.split(',')[1] || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  window.__pinforgeFile = new File([bytes], name, { type });
  if (window.__pinforgePatched) return true;
  window.__pinforgePatched = true;
  const handOver = (input) => {
    const file = window.__pinforgeFile;
    if (!file) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && handOver(this)) return;
    return origClick.call(this);
  };
  if (HTMLInputElement.prototype.showPicker) {
    const origPicker = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (this.type === 'file' && handOver(this)) return;
      return origPicker.call(this);
    };
  }
  return true;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ------------------------------------------------------------ public actions

/**
 * Publish one pin.
 * pin = { title, description, link, altText, board, keywords }
 * opts = { createUrl, publishMode: 'auto'|'fill', addTags, tagCount, selectors }
 * Returns { pinUrl, unconfirmed, log }.
 */
export async function publishPin(pin, imageBlob, fileName, opts = {}) {
  const image = { dataUrl: await blobToDataUrl(imageBlob), name: fileName || 'pin.jpg', type: imageBlob.type || 'image/jpeg' };
  currentImage = { blob: imageBlob, name: fileName || 'pin.jpg' };
  const attempt = async () => {
    await openCreatePage(opts.createUrl);
    let trusted = false;
    if (opts.reliable !== false) {
      try {
        trusted = await attachDebugger(tabId);
      } catch {
        trusted = false; // e.g. you pressed Cancel on Chrome's bar — normal mode still works
      }
    }
    await chrome.scripting
      .executeScript({ target: { tabId }, world: 'MAIN', func: installFileChooserPatch, args: [image.dataUrl, image.name, image.type] })
      .catch(() => { /* optional helper — the other upload methods still run */ });
    const res = await send(
      {
        type: 'pf-publish',
        pin,
        image,
        options: { publishMode: opts.publishMode, addTags: opts.addTags, tagCount: opts.tagCount, trusted, fallbackBoard: opts.fallbackBoard || '' },
        selectors: opts.selectors,
      },
      opts.publishMode === 'fill' ? 11 * 60 * 1000 : 4 * 60 * 1000,
    );
    if (!res?.ok) {
      const err = new PinterestError(res?.message || 'Unknown error on Pinterest page.', res?.code || 'ERROR', res?.step || '');
      err.debug = res?.debug || null;
      throw err;
    }
    return res;
  };
  try {
    return await attempt();
  } catch (err) {
    // Rich-text boxes need the tab in front — retry once after focusing it.
    if (err.code === 'NEEDS_FOCUS') return attempt();
    throw err;
  } finally {
    currentImage = null;
    if (tabId != null) await cleanupTemps(tabId).catch(() => {});
  }
}

/** Open the Create Pin page and report which fields/boards PinForge can see. */
export async function diagnose(opts = {}) {
  await openCreatePage(opts.createUrl);
  const res = await send({ type: 'pf-diagnose', selectors: opts.selectors }, 60000);
  if (!res?.ok) throw new PinterestError(res?.message || 'Diagnosis failed.', res?.code || 'ERROR');
  return res.report;
}
