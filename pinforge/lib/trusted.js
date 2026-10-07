// lib/trusted.js
// "Reliable mode": real (trusted) input for the Pinterest tab through Chrome's debugger API.
// Websites can't tell these apart from you using the mouse and keyboard:
//   - upload:   sets the image on Pinterest's file box exactly like choosing it in the file dialog
//   - insertText: types text instantly (like pasting)
//   - click:    a real mouse click at the element's position (computed live, so any screen size works)
// While attached, Chrome shows a bar "PinForge started debugging this browser" — that's expected.
// If you press "Cancel" on that bar, PinForge falls back to normal mode automatically.

const attached = new Set();
const temps = new Map(); // tabId -> [downloadId]

if (globalThis.chrome?.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

export async function attachDebugger(tabId) {
  if (attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!/already attached/i.test(err?.message || '')) throw err;
  }
  attached.add(tabId);
  return true;
}

export async function detachDebugger(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export const isAttached = (tabId) => attached.has(tabId);

// ---------------------------------------------------------------- temp file for upload

function safeFileName(name) {
  const base = String(name || 'pin.jpg').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(-80);
  return /\.(jpe?g|png|webp)$/i.test(base) ? base : base + '.jpg';
}

/** Save the image into Downloads/PinForge-temp so Chrome can hand it to the file box. */
async function saveTemp(tabId, blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.setUiOptions?.({ enabled: false }).catch(() => {});
    const id = await chrome.downloads.download({
      url,
      filename: `PinForge-temp/${Date.now()}-${safeFileName(name)}`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    const path = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(reject, new Error('Saving the image for upload took too long.')), 30000);
      const check = async () => {
        const [item] = await chrome.downloads.search({ id });
        if (item?.state === 'complete') done(resolve, item.filename);
        if (item?.state === 'interrupted') done(reject, new Error('Could not save the image for upload (' + (item.error || 'interrupted') + ').'));
      };
      const onChanged = (delta) => delta.id === id && delta.state && check();
      function done(fn, v) {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        fn(v);
      }
      chrome.downloads.onChanged.addListener(onChanged);
      check();
    });
    if (!temps.has(tabId)) temps.set(tabId, []);
    temps.get(tabId).push(id);
    return path;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** Delete the temporary upload files and their entries in Chrome's download list. */
export async function cleanupTemps(tabId) {
  const ids = temps.get(tabId) || [];
  temps.delete(tabId);
  for (const id of ids) {
    await chrome.downloads.removeFile(id).catch(() => {});
    await chrome.downloads.erase({ id }).catch(() => {});
  }
  await chrome.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
}

// ---------------------------------------------------------------- actions

/** Put the image on the element marked by the content script (an <input type=file>). */
async function uploadToMarkedInput(tabId, path, selector) {
  const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error('Upload box not found');
  await cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files: [path] });
}

/** Click (x,y) and catch the file dialog that opens, then give it the image. */
async function uploadViaChooser(tabId, path, x, y) {
  await cdp(tabId, 'Page.enable');
  await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(reject, new Error('The file dialog did not open.')), 8000);
      const onEvent = (src, method, params) => {
        if (src.tabId === tabId && method === 'Page.fileChooserOpened') finish(resolve, params);
      };
      function finish(fn, v) {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(onEvent);
        fn(v);
      }
      chrome.debugger.onEvent.addListener(onEvent);
    });
    await click(tabId, x, y);
    const { backendNodeId } = await opened;
    await cdp(tabId, 'DOM.setFileInputFiles', { backendNodeId, files: [path] });
  } finally {
    await cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

async function click(tabId, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
};

async function key(tabId, name) {
  const k = KEYS[name];
  if (!k) return;
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...k });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
}

/**
 * Handle one request from the content script.
 * ctx = { tabId, image: { blob, name } }
 */
export async function handleTrusted(msg, ctx) {
  const { tabId } = ctx;
  if (!attached.has(tabId)) return { ok: false, error: 'not attached' };
  switch (msg.op) {
    case 'insertText':
      await cdp(tabId, 'Input.insertText', { text: String(msg.text ?? '') });
      return { ok: true };
    case 'click':
      await click(tabId, msg.x, msg.y);
      return { ok: true };
    case 'key':
      await key(tabId, msg.key);
      return { ok: true };
    case 'upload': {
      if (!ctx.image?.blob) return { ok: false, error: 'no image' };
      const path = await saveTemp(tabId, ctx.image.blob, ctx.image.name);
      if (msg.selector) await uploadToMarkedInput(tabId, path, msg.selector);
      else await uploadViaChooser(tabId, path, msg.x, msg.y);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown op' };
  }
}
