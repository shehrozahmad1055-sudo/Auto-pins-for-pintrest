// content/pinterest.js
// Injected into Pinterest's "Create Pin" page by the workspace (chrome.scripting).
// It does what you would do by hand: upload the image, type the title, description,
// link and alt text, pick the board, add tagged topics, and click Publish.
//
// Works on any screen size / laptop: nothing uses screen positions. Every field is
// found from the page structure with several fall-backs (ids, data-test-ids,
// aria-labels, placeholders, <label> text, and "what appeared after I clicked").
// Extra selectors can be added in Settings → Pinterest → "Selector overrides".

(() => {
  if (window.__pinforgeLoaded) return;
  window.__pinforgeLoaded = true;

  const DEFAULT_SELECTORS = {
    uploadInput: [
      '#storyboard-upload-input',
      '[data-test-id="storyboard-upload-input"]',
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ],
    title: [
      '#storyboard-selector-title',
      '[data-test-id="pin-draft-title"]',
      'input[placeholder*="what your pin is about" i]',
      'textarea[placeholder*="what your pin is about" i]',
      'input[placeholder*="title" i]',
      'textarea[placeholder*="title" i]',
      'input[aria-label*="title" i]',
      '[contenteditable="true"][aria-label*="title" i]',
    ],
    description: [
      '#storyboard-selector-description',
      '[data-test-id="pin-draft-description"]',
      '[data-test-id="storyboard-description-field-container"]',
      '[contenteditable="true"][aria-label*="description" i]',
      '[role="textbox"][aria-label*="description" i]',
      'textarea[placeholder*="description" i]',
      'textarea[placeholder*="describe your pin" i]',
      '[contenteditable="true"][aria-label*="describe" i]',
      '[contenteditable="true"][data-placeholder*="describe" i]',
      '[contenteditable="true"][data-placeholder*="description" i]',
      '.public-DraftEditor-content',
    ],
    link: [
      '#WebsiteField',
      '#storyboard-selector-link',
      '[data-test-id="pin-draft-link"]',
      'input[placeholder*="link" i]',
      'input[aria-label*="link" i]',
      'input[type="url"]',
    ],
    altText: [
      '#storyboard-selector-alt-text',
      '[data-test-id="pin-draft-alt-text"]',
      '[data-test-id="pin-draft-alttext"]',
      'textarea[placeholder*="alt" i]',
      'textarea[placeholder*="people can see" i]',
      'input[placeholder*="alt text" i]',
      '[aria-label*="alt text" i]',
    ],
    boardButton: [
      '[data-test-id="board-dropdown-select-button"]',
      '[data-test-id="board-dropdown"] button',
      '[data-test-id="board-dropdown"]',
      'button[aria-label*="board" i]',
      '[role="button"][aria-label*="board" i]',
      '[role="combobox"][aria-label*="board" i]',
    ],
    boardSearch: [
      '#pickerSearchField',
      '[data-test-id="board-picker-search"] input',
      '[role="dialog"] input[type="text"]',
      '[role="dialog"] input:not([type])',
      '[role="dialog"] input[type="search"]',
    ],
    boardOption: [
      '[data-test-id^="board-row"]',
      '[data-test-id="boardWithoutSection"]',
      '[data-test-id*="board-picker"] [role="button"]',
      '[role="listbox"] [role="option"]',
    ],
    tagInput: [
      '#storyboard-selector-interest-tags',
      '[data-test-id="pin-draft-interest-tags"]',
      '[data-test-id*="interest-tag"] input',
      'input[placeholder*="tag" i]',
      'input[placeholder*="topic" i]',
      'input[aria-label*="topic" i]',
      'input[aria-label*="tag" i]',
    ],
    tagOption: [
      '[data-test-id*="interest"] [role="option"]',
      '[role="listbox"] [role="option"]',
    ],
    publish: [
      '[data-test-id="storyboard-creation-nav-done"] button',
      '[data-test-id="storyboard-creation-nav-done"]',
      'button[aria-label="Publish"]',
    ],
  };

  let SEL = DEFAULT_SELECTORS;

  // ------------------------------------------------------------ helpers

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  class StepError extends Error {
    constructor(code, message, step) {
      super(message);
      this.code = code;
      this.step = step;
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  }

  const isEnabled = (el) => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const isTypable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  /** Pinterest's global search box in the top bar — never type into it. */
  function isGlobalSearch(el) {
    return Boolean(
      el.closest('[data-test-id="search-box-container"], [data-test-id="header"], [role="search"], nav, header[role="banner"]') ||
        el.getAttribute('name') === 'searchBoxInput' ||
        el.id === 'searchBoxContainer',
    );
  }

  /** If a selector hit a wrapper <div>, use the real text box inside it. */
  function resolveEditable(el) {
    if (!el || isTypable(el)) return el;
    return el.querySelector('[contenteditable="true"], textarea, input:not([type="hidden"]):not([type="file"]), [role="textbox"]') || null;
  }

  function find(key, { visibleOnly = true, root = document } = {}) {
    for (const sel of SEL[key] || []) {
      let els;
      try {
        els = root.querySelectorAll(sel);
      } catch {
        continue; // invalid selector from overrides
      }
      for (const el of els) if ((!visibleOnly || isVisible(el)) && !isGlobalSearch(el)) return el;
    }
    return null;
  }

  function findAll(key) {
    const out = [];
    for (const sel of SEL[key] || []) {
      try {
        for (const el of document.querySelectorAll(sel)) if (isVisible(el) && !isGlobalSearch(el) && !out.includes(el)) out.push(el);
      } catch { /* ignore */ }
    }
    return out;
  }

  function labelOf(el) {
    return (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
  }

  function buttonByText(re) {
    return [...document.querySelectorAll('button, [role="button"]')].find((el) => isVisible(el) && re.test(labelOf(el).split('\n')[0].trim() || el.getAttribute('aria-label') || ''));
  }

  /** Field found from the text of its <label> (or aria-labelledby). */
  function fieldByLabel(re) {
    for (const label of document.querySelectorAll('label')) {
      if (!re.test(label.textContent || '')) continue;
      const id = label.getAttribute('for');
      let el = id ? document.getElementById(id) : label.querySelector('input, textarea, [contenteditable="true"]');
      el = resolveEditable(el);
      if (el && isVisible(el) && !isGlobalSearch(el)) return el;
    }
    for (const el of document.querySelectorAll('[aria-labelledby]')) {
      const ids = el.getAttribute('aria-labelledby').split(/\s+/);
      const text = ids.map((i) => document.getElementById(i)?.textContent || '').join(' ');
      if (re.test(text) && isTypable(el) && isVisible(el)) return el;
    }
    return null;
  }

  /** Pinterest shows small labels ("Title", "Description", "Link", "Board") above each box. */
  function boxNearLabel(re, want = 'typable') {
    const labels = [...document.querySelectorAll('label, div, span, p, h2, h3')].filter(
      (el) => el.children.length === 0 && isVisible(el) && re.test(textOf(el)) && textOf(el).length < 30 && !isGlobalSearch(el),
    );
    for (const label of labels) {
      for (let box = label.parentElement, i = 0; box && i < 4; box = box.parentElement, i++) {
        if (want === 'typable') {
          const el = box.querySelector('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]), textarea, [contenteditable="true"]');
          if (el && isVisible(el)) return el;
        } else {
          const el = box.querySelector('button, [role="button"], [role="combobox"], [aria-haspopup]');
          if (el && isVisible(el)) return el;
        }
      }
    }
    return null;
  }

  /** A rich-text editor found from its grey placeholder text (e.g. "Describe your Pin"). */
  function editorByPlaceholder(re) {
    const ph = [...document.querySelectorAll('div, span')].find((el) => el.children.length === 0 && isVisible(el) && re.test(textOf(el)));
    if (!ph) return null;
    for (let box = ph.parentElement, i = 0; box && i < 5; box = box.parentElement, i++) {
      const ed = box.querySelector('[contenteditable="true"], textarea');
      if (ed) return ed;
    }
    return null;
  }

  const visibleTypables = () =>
    [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, [contenteditable="true"]')].filter((el) => isVisible(el) && !isGlobalSearch(el));

  async function waitFor(fn, timeout = 15000, interval = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(interval);
    }
  }

  /** Click like a real mouse (some menus open on pointerdown/mousedown). */
  function realClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' })); } catch { /* old engines */ }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' })); } catch { /* ignore */ }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  // ---- Reliable mode: real clicks / typing / upload done by PinForge through Chrome ----
  let TRUSTED = false;

  async function tcall(op, args = {}) {
    if (!TRUSTED) return null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'pf-trusted', op, ...args });
      return r?.ok ? r : null;
    } catch {
      return null;
    }
  }

  function centerOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ok: r.width > 0 && r.height > 0 };
  }

  /** Click an element: a real mouse click in reliable mode, otherwise a simulated one. */
  async function clickEl(el) {
    if (TRUSTED) {
      const c = centerOf(el);
      await sleep(60);
      const hit = c.ok && document.elementFromPoint(c.x, c.y);
      // only click by position if nothing is covering the element
      if (hit && (hit === el || el.contains(hit) || hit.contains(el)) && (await tcall('click', { x: c.x, y: c.y }))) return;
    }
    realClick(el);
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

  /** Type text into an input, textarea or rich-text (contenteditable) editor. */
  async function setText(rawEl, text, fieldName = 'field') {
    const el = resolveEditable(rawEl);
    if (!el) throw new StepError('NOT_TYPABLE', `The ${fieldName} box was found but has no text area inside.`, fieldName);
    el.scrollIntoView({ block: 'center' });
    await clickEl(el);
    el.focus();
    await sleep(60);

    // Reliable mode: select what's there and type over it with real keyboard input (instant).
    if (TRUSTED && text) {
      if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.select?.();
      }
      if (await tcall('insertText', { text })) {
        await sleep(80);
        const now = el.isContentEditable ? textOf(el) : el.value;
        if (norm(now).includes(norm(text).slice(0, 20))) return;
      }
    }

    if (!el.isContentEditable) {
      setNativeValue(el, text);
      await sleep(80);
      if (el.value !== text) {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return;
    }

    // Rich-text editor (Pinterest's description uses one).
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    if (!text) {
      document.execCommand('delete', false);
      return;
    }
    const probe = norm(text).slice(0, 20);
    const ok = () => norm(textOf(el)).includes(probe);

    document.execCommand('insertText', false, text);
    await sleep(200);
    if (!ok()) {
      // Try a paste event.
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(250);
    }
    if (!ok()) {
      // Try a beforeinput event.
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      await sleep(250);
    }
    if (!ok()) throw new StepError('NEEDS_FOCUS', `Could not type into the ${fieldName} box. Keep the Pinterest tab in front while it works.`, fieldName);
  }

  function pressKey(key, target = document.activeElement || document.body) {
    const keyCode = { Escape: 27, Enter: 13 }[key] || 0;
    const ev = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', ev));
    target.dispatchEvent(new KeyboardEvent('keypress', ev));
    target.dispatchEvent(new KeyboardEvent('keyup', ev));
  }

  function dataUrlToFile(dataUrl, name, type) {
    const bin = atob(dataUrl.split(',')[1] || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  function isLoggedOut() {
    if (/\/login|\/signup/.test(location.pathname)) return true;
    const pw = document.querySelector('input[type="password"]');
    return Boolean(pw && isVisible(pw) && !find('uploadInput', { visibleOnly: false }));
  }

  /** Short description of the form's fields — used in the test report and error reports (no values). */
  function dumpFields() {
    const els = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], button, [role="button"]')]
      .filter((el) => isVisible(el) || (el.type === 'file'))
      .slice(0, 150);
    return els.map((el) => {
      const testIdEl = el.closest('[data-test-id]');
      const row = {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        id: el.id || undefined,
        testId: testIdEl?.getAttribute('data-test-id') || undefined,
        aria: el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        role: el.getAttribute('role') || undefined,
        editable: el.isContentEditable || undefined,
        disabled: !isEnabled(el) || undefined,
        globalSearch: isGlobalSearch(el) || undefined,
      };
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') row.text = labelOf(el).split('\n')[0].slice(0, 40);
      return row;
    });
  }

  // ------------------------------------------------------------ field finders

  const findTitle = () => resolveEditable(find('title')) || fieldByLabel(/^\s*title/i) || boxNearLabel(/^title$/i);

  function findDescription() {
    const direct = resolveEditable(find('description')) || fieldByLabel(/description/i) || editorByPlaceholder(/^describe your pin/i) || boxNearLabel(/^description$/i);
    if (direct) return direct;
    // Fallback: the rich-text editor on the form that isn't the title.
    const title = findTitle();
    return visibleTypables().find((el) => el.isContentEditable && el !== title && !title?.contains(el)) || null;
  }

  const findLink = () => resolveEditable(find('link')) || fieldByLabel(/link|website|destination/i) || boxNearLabel(/^(link|destination link|website)$/i);
  const findAlt = () => resolveEditable(find('altText')) || fieldByLabel(/alt text/i);
  const findTagInput = () => resolveEditable(find('tagInput')) || fieldByLabel(/tagged topics|topics|tags/i) || boxNearLabel(/^tagged topics/i);
  const findBoardButton = () =>
    find('boardButton') || buttonByText(/^(choose a board|select a board|select board|choose board)$/i) || buttonByText(/choose a board|select a board/i) || boxNearLabel(/^board$/i, 'button');
  const findPublish = () => find('publish') || buttonByText(/^publish$/i);

  async function reveal(re) {
    const btn = buttonByText(re);
    if (!btn) return false;
    await clickEl(btn);
    await sleep(700);
    return true;
  }

  // ------------------------------------------------------------ steps

  // ---- image upload: three strategies, each verified ----

  const DROP_TEXT = /upload your media|select multiple files|drag and drop|drag & drop|choose a file|upload an image|drop (your )?(image|file)|click to upload|or drag|up to 20 ?mb/i;

  /** The visible "Choose a file / drag and drop" area, if any. */
  function findDropZone() {
    const hits = [...document.querySelectorAll('div, label, button, span, p')]
      .filter((el) => isVisible(el) && el.children.length <= 6 && DROP_TEXT.test(textOf(el)) && textOf(el).length < 300 && !isGlobalSearch(el));
    if (!hits.length) return null;
    // the innermost matching element (one that doesn't contain another match)
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    inner.sort((a, b) => textOf(a).length - textOf(b).length);
    const zone = inner[0] || hits[0];
    // climb to the nearest box that holds the file input (that is where drops are handled)
    for (let up = zone, i = 0; up && i < 5; up = up.parentElement, i++) {
      if (up.querySelector('input[type="file"]')) return up;
    }
    return zone;
  }

  const mediaNow = () => [...document.querySelectorAll('img, video, canvas')].filter((m) => isVisible(m) && !isGlobalSearch(m));

  /** A preview of our image: a blob:/data: image, or any new large picture that wasn't there before. */
  function previewVisible(before) {
    return mediaNow().some((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return false;
      const src = m.currentSrc || m.src || '';
      return /^(blob:|data:)/.test(src) || m.tagName !== 'IMG' || !before.has(m);
    });
  }

  /** Did Pinterest accept the image? */
  function uploadAccepted(ctx) {
    if (document.querySelector('[role="progressbar"]')) return false;
    if (previewVisible(ctx.media)) return true;
    if (ctx.hadDropZone && !findDropZone()) return true; // the drop area was replaced by the image
    const t = findTitle();
    if (ctx.titleWasLocked && t && isEnabled(t)) return true; // fields unlocked
    return false;
  }

  function fileInputs() {
    const found = [];
    for (const sel of SEL.uploadInput) {
      try {
        for (const el of document.querySelectorAll(sel)) if (el.type === 'file' && !found.includes(el)) found.push(el);
      } catch { /* ignore */ }
    }
    // image inputs first
    return found.sort((a, b) => Number(/image/.test(b.accept || '')) - Number(/image/.test(a.accept || '')));
  }

  function giveFiles(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dropOn(target, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
    }
  }

  async function startNewPinIfNeeded() {
    // If Pinterest opened an old draft, start a fresh pin.
    if (findDropZone() || fileInputs().length) return;
    const btn = buttonByText(/^(create new|create pin|new pin|\+ create new)$/i);
    if (btn) {
      await clickEl(btn);
      await sleep(1500);
    }
  }

  async function uploadImage(file, log) {
    await waitFor(() => fileInputs().length || findDropZone() || isLoggedOut(), 25000);
    if (isLoggedOut()) throw new StepError('NOT_LOGGED_IN', 'You are not logged in to Pinterest in this Chrome. Log in, then try again.', 'upload');
    await startNewPinIfNeeded();
    await waitFor(() => fileInputs().length || findDropZone(), 10000);

    const t0 = findTitle();
    const ctx = { hadDropZone: Boolean(findDropZone()), media: new Set(mediaNow()), titleWasLocked: Boolean(t0 && !isEnabled(t0)) };
    const accepted = () => uploadAccepted(ctx);
    const settle = async (ms) => (await waitFor(accepted, ms, 300)) && (await waitFor(() => !document.querySelector('[role="progressbar"]'), 60000, 400));

    log.push(`upload: ${fileInputs().length} file input(s), drop area ${ctx.hadDropZone ? 'found' : 'not found'}, reliable mode ${TRUSTED ? 'on' : 'off'}`);

    // 0) Reliable mode: Chrome puts the file on Pinterest's upload box, exactly like the file dialog.
    if (TRUSTED) {
      const input = fileInputs()[0];
      if (input) {
        document.querySelectorAll('[data-pinforge-upload]').forEach((el) => el.removeAttribute('data-pinforge-upload'));
        input.setAttribute('data-pinforge-upload', '1');
        if ((await tcall('upload', { selector: '[data-pinforge-upload="1"]' })) && (await settle(30000))) return log.push('upload: reliable (file box)');
        log.push('upload: reliable file box not accepted');
      }
      const area = findDropZone();
      if (area) {
        const c = centerOf(area);
        if ((await tcall('upload', { x: c.x, y: c.y })) && (await settle(30000))) return log.push('upload: reliable (file dialog)');
        log.push('upload: reliable file dialog not accepted');
      }
    }

    // 1) give the file straight to the upload input(s)
    for (const input of fileInputs().slice(0, 3)) {
      giveFiles(input, file);
      if (await settle(8000)) return log.push('upload: input');
    }
    // 2) drop the file onto the drop area (and its parents)
    const zone = findDropZone();
    log.push('upload: input not accepted, trying drop on ' + (zone ? zone.tagName.toLowerCase() + (zone.id ? '#' + zone.id : '') : 'nothing'));
    if (zone) {
      for (let t = zone, i = 0; t && i < 2; t = t.parentElement, i++) {
        dropOn(t, file);
        if (await settle(5000)) return log.push('upload: drop');
      }
    }
    // 3) click "Choose a file" — PinForge has patched the file dialog (main world) to hand over the image
    const chooser = buttonByText(/choose a file|upload|select (a )?file/i) || zone;
    log.push('upload: trying file chooser ' + (chooser ? 'button' : '(none)'));
    if (chooser) {
      await clickEl(chooser);
      if (await settle(10000)) return log.push('upload: chooser');
    }
    throw new StepError('UPLOAD_NOT_ACCEPTED', 'Pinterest did not accept the image upload. Copy the debug info and send it so the upload step can be adjusted.', 'upload');
  }

  async function fillTitle(value) {
    const el = findTitle();
    if (!el) throw new StepError('TITLE_NOT_FOUND', 'Could not find the title box.', 'title');
    await setText(el, value, 'title');
  }

  async function fillDescription(value) {
    if (!value) return;
    let el = await waitFor(findDescription, 5000);
    if (!el) {
      await reveal(/^(add a description|description)$/i);
      el = await waitFor(findDescription, 3000);
    }
    if (!el) throw new StepError('DESCRIPTION_NOT_FOUND', 'Could not find the description box.', 'description');
    await setText(el, value, 'description');
  }

  async function fillLink(value) {
    if (!value) return 'skipped';
    let el = findLink();
    if (!el) {
      await reveal(/^(add a link|link|add link)$/i);
      el = await waitFor(findLink, 3000);
    }
    if (!el) throw new StepError('LINK_NOT_FOUND', 'Could not find the link box.', 'link');
    await setText(el, value, 'link');
    return 'ok';
  }

  async function fillAlt(value) {
    if (!value) return 'skipped';
    let el = findAlt();
    if (!el) {
      if (!(await reveal(/^more options$/i))) await reveal(/alt text/i);
      el = await waitFor(findAlt, 3000);
      if (!el && (await reveal(/alt text/i))) el = await waitFor(findAlt, 3000);
    }
    if (!el) return 'not found';
    await setText(el, value, 'alt text');
    return 'ok';
  }

  /** Visible clickable element whose own text is exactly `name` (case-insensitive). */
  function findByExactText(name, exclude = []) {
    const target = norm(name);
    const candidates = [...document.querySelectorAll('[title], div, span, p, button, [role="option"], [role="button"]')]
      .filter((el) => isVisible(el) && !exclude.some((x) => x && (x === el || x.contains(el))) && !isGlobalSearch(el))
      .filter((el) => norm(el.getAttribute('title')) === target || (el.children.length === 0 && norm(el.textContent) === target));
    const el = candidates[0];
    if (!el) return null;
    return el.closest('[data-test-id^="board-row"], [role="option"], [role="button"], button, [data-test-id]') || el;
  }

  function readBoardNames(exclude = [], search = null) {
    const clean = (list) => [...new Set(list.map((n) => (n || '').trim()))].filter((n) => n && n.length < 60 && !/^(create|search|save|sections?|all boards|top choices|recent)\b/i.test(n));
    const fromRows = findAll('boardOption').map((el) => el.querySelector('[title]')?.getAttribute('title') || labelOf(el).split('\n')[0]);
    if (fromRows.length) return clean(fromRows);
    // Generic: the box that opened around the search field — read its short text labels.
    let box = search?.parentElement || null;
    for (let i = 0; box && i < 5; i++, box = box.parentElement) {
      const leaves = [...box.querySelectorAll('div, span, p')].filter((el) => el.children.length === 0 && isVisible(el) && !exclude.some((x) => x?.contains(el)));
      if (leaves.length >= 1) return clean(leaves.map((el) => el.getAttribute('title') || el.textContent));
    }
    return clean([...document.querySelectorAll('[role="dialog"] [title], [role="listbox"] [title]')].filter(isVisible).map((el) => el.getAttribute('title')));
  }

  let lastBoardSearch = null;

  async function openBoardPicker() {
    const btn = findBoardButton();
    if (!btn) return null;
    // picker still open from the previous try? reuse it
    if (lastBoardSearch && isVisible(lastBoardSearch)) return { btn, search: lastBoardSearch };
    const before = new Set(visibleTypables());
    await clickEl(btn);
    const search = await waitFor(() => find('boardSearch') || visibleTypables().find((el) => !before.has(el) && el.tagName === 'INPUT'), 2500, 150);
    lastBoardSearch = search;
    if (!search) await sleep(400); // list without a search box
    return { btn, search };
  }

  /** Text currently shown on the board selector, e.g. "Choose a board" or "Home Decor". */
  function currentBoardText(btn) {
    return textOf(btn || findBoardButton() || document.createElement('i')).replace(/^board\s*/i, '').trim();
  }

  async function trySelectBoard(name) {
    const picker = await openBoardPicker();
    if (!picker) throw new StepError('BOARD_PICKER_NOT_FOUND', 'Could not find the board selector.', 'board');
    const { btn, search } = picker;
    if (search) await setText(search, name, 'board search');
    const target = norm(name);
    const option = await waitFor(() => {
      const opts = findAll('boardOption');
      const nameOf = (el) => norm(el.querySelector('[title]')?.getAttribute('title') || labelOf(el).split('\n')[0]);
      return opts.find((el) => nameOf(el) === target) || findByExactText(name, [btn, search]) || opts.find((el) => nameOf(el).startsWith(target));
    }, 2500, 150);
    if (option) {
      await clickEl(option);
      lastBoardSearch = null;
      await sleep(300);
      return { ok: true };
    }
    if (search) {
      await setText(search, '', 'board search');
      await sleep(400);
    }
    // keep the picker open — the next try (fallback board) reuses it
    return { ok: false, seen: readBoardNames([btn, search], search).slice(0, 12) };
  }

  /**
   * Pick the board. Order: the pin's board → the fallback board from Settings →
   * keep the board Pinterest already shows (it remembers your last one).
   */
  async function chooseBoard(name, fallback) {
    const shown = norm(currentBoardText());
    const wanted = [name, fallback].map((b) => (b || '').trim()).filter(Boolean);
    if (wanted.some((b) => norm(b) === shown)) return `already "${currentBoardText()}"`;

    let seen = [];
    for (const b of [...new Set(wanted)]) {
      const r = await trySelectBoard(b);
      if (r.ok) return b;
      seen = r.seen.length ? r.seen : seen;
    }
    // close the picker
    if (lastBoardSearch && isVisible(lastBoardSearch)) {
      pressKey('Escape', lastBoardSearch);
      await tcall('key', { key: 'Escape' });
      await sleep(250);
    }
    lastBoardSearch = null;
    const stillShown = currentBoardText();
    if (stillShown && !/choose|select/i.test(stillShown)) return `kept "${stillShown}" (${wanted.join(' / ') || 'no board'} not found)`;
    throw new StepError('BOARD_NOT_FOUND', `Board "${wanted[0] || ''}" was not found in your Pinterest account.${seen.length ? ' Boards seen: ' + seen.join(', ') : ''}`, 'board');
  }

  /** Clickable suggestions that appeared under a box after focusing/typing in it. */
  function suggestionsUnder(input, before) {
    const r = input.getBoundingClientRect();
    const seenText = new Set();
    return [...document.querySelectorAll('[role="option"], li, [role="button"], button, div, span')]
      .filter((el) => {
        if (!isVisible(el) || before.has(el) || el.contains(input) || isGlobalSearch(el)) return false;
        const t = textOf(el);
        if (t.length < 2 || t.length > 40 || el.children.length > 3) return false;
        const b = el.getBoundingClientRect();
        // below the box (jsdom has no layout: then accept anything new)
        if (r.height && b.height && b.top < r.bottom - 2) return false;
        return true;
      })
      .map((el) => el.closest('[role="option"], li, [role="button"], button') || el)
      .filter((el) => {
        const t = norm(textOf(el));
        if (!t || seenText.has(t) || /^(add|create|search|no results|see more)/.test(t)) return false;
        seenText.add(t);
        return true;
      });
  }

  /**
   * Tagged topics. First take Pinterest's own suggestions for this image (shown when the
   * box is clicked), then fill up with our keywords, picking Pinterest's closest match.
   */
  async function addTags(keywords, max) {
    let input = findTagInput();
    if (!input) {
      await reveal(/^more options$/i);
      input = await waitFor(findTagInput, 2500);
    }
    if (!input) return { added: 0, note: 'tag field not found' };

    const chosen = [];
    const snapshot = () => new Set([...document.querySelectorAll('[role="option"], li, [role="button"], button, div, span')].filter(isVisible));

    // 1) Pinterest's suggestions for this image
    let before = snapshot();
    await clickEl(input);
    input.focus();
    const fresh = () => {
      const list = suggestionsUnder(input, before).filter((el) => !chosen.includes(norm(textOf(el))));
      return list.length ? list : null;
    };
    for (let round = 0; round < max && chosen.length < max; round++) {
      const sugg = await waitFor(fresh, round === 0 ? 2000 : 1200, 120);
      if (!sugg) break;
      const pick = sugg[0];
      chosen.push(norm(textOf(pick)));
      before = snapshot();
      await clickEl(pick);
      await sleep(250);
      input = findTagInput() || input;
      await clickEl(input);
    }
    const fromPinterest = chosen.length;

    // 2) our keywords → Pinterest's matching topic
    for (const kw of keywords || []) {
      if (chosen.length >= max) break;
      before = snapshot();
      await setText(input, kw, 'tags');
      const word = norm(kw).split(' ')[0];
      const opt = await waitFor(() => findAll('tagOption').find((o) => !before.has(o)) || suggestionsUnder(input, before).find((o) => norm(textOf(o)).includes(word)), 2000, 120);
      if (opt && !chosen.includes(norm(textOf(opt)))) {
        chosen.push(norm(textOf(opt)));
        await clickEl(opt);
        await sleep(250);
        input = findTagInput() || input;
      }
    }
    try { await setText(input, '', 'tags'); } catch { /* ignore */ }
    pressKey('Escape', input);
    return { added: chosen.length, fromPinterest };
  }

  function detectOutcome() {
    const link = [...document.querySelectorAll('a[href*="/pin/"]')].find((a) => isVisible(a) && /see (your )?pin|see it now|view (your )?pin|view now|see pin/i.test(labelOf(a)));
    if (link) return { ok: true, pinUrl: link.href };
    if (/\/pin\/\d+/.test(location.pathname)) return { ok: true, pinUrl: location.href };
    const msgs = [...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [data-test-id*="toast"], [aria-live]')].filter(isVisible).map(labelOf).join(' ');
    if (/(pin|it) (has been|was|is) (published|saved|created|live)|published!|pin published|your pin is live|pin was published|successfully published/i.test(msgs)) {
      const a = [...document.querySelectorAll('[role="alert"] a[href*="/pin/"], [role="status"] a[href*="/pin/"], [role="dialog"] a[href*="/pin/"], [aria-live] a[href*="/pin/"]')][0];
      return { ok: true, pinUrl: a?.href || '' };
    }
    if (/something went wrong|couldn.t (publish|save)|could not (publish|save)|try again|failed/i.test(msgs)) return { ok: false, error: msgs.slice(0, 200) };
    return null;
  }

  async function publish() {
    const btn = await waitFor(() => {
      const b = findPublish();
      return b && isEnabled(b) ? b : null;
    }, 20000);
    if (!btn) {
      const b = findPublish();
      throw new StepError('PUBLISH_NOT_FOUND', b ? 'The Publish button stayed disabled (is a board selected?).' : 'Could not find the Publish button.', 'publish');
    }
    await clickEl(btn);
    let outcome = await waitFor(detectOutcome, 45000, 400);
    if (outcome && !outcome.ok) throw new StepError('PUBLISH_FAILED', 'Pinterest said: ' + outcome.error, 'publish');
    if (outcome) return outcome;
    // Only trust a real confirmation from Pinterest. Anything else is reported, never assumed.
    const stillThere = findPublish();
    throw new StepError(
      'PUBLISH_UNCONFIRMED',
      stillThere
        ? 'Clicked Publish but Pinterest did not publish (the button is still there). The pin is probably saved in "Pin drafts".'
        : 'Pinterest did not show "published". Check "Pin drafts" and your board before retrying, to avoid a duplicate.',
      'publish',
    );
  }

  async function waitForUserPublish() {
    const outcome = await waitFor(detectOutcome, 10 * 60 * 1000, 700);
    if (!outcome) throw new StepError('USER_TIMEOUT', 'Waited 10 minutes for you to click Publish.', 'publish');
    if (!outcome.ok) throw new StepError('PUBLISH_FAILED', 'Pinterest said: ' + outcome.error, 'publish');
    return outcome;
  }

  // ------------------------------------------------------------ commands

  async function doPublish({ pin, image, options }, rawLog) {
    TRUSTED = Boolean(options.trusted);
    const t0 = Date.now();
    // every log line gets the time since start, so slow steps are easy to spot
    const log = { push: (m) => rawLog.push(`${m} @${((Date.now() - t0) / 1000).toFixed(1)}s`), some: (f) => rawLog.some(f) };
    if (isLoggedOut()) throw new StepError('NOT_LOGGED_IN', 'You are not logged in to Pinterest in this Chrome. Log in, then try again.', 'start');

    await uploadImage(dataUrlToFile(image.dataUrl, image.name, image.type), log);
    // fields can take a moment to unlock after the upload
    await waitFor(() => { const t = findTitle(); return t && isEnabled(t); }, 15000);
    await sleep(300);
    await fillTitle(pin.title);
    log.push('title');
    await fillDescription(pin.description);
    log.push('description');
    log.push('link: ' + (await fillLink(pin.link)));
    log.push('alt text: ' + (await fillAlt(pin.altText)));
    log.push('board: ' + (await chooseBoard(pin.board, options.fallbackBoard)));
    if (options.addTags) {
      const t = await addTags(pin.keywords, options.tagCount || 5);
      log.push(t.note ? 'tags: ' + t.note : `tags: ${t.added} (${t.fromPinterest} suggested by Pinterest)`);
    }
    if (options.publishMode === 'fill') {
      log.push('waiting for you to click Publish');
      const outcome = await waitForUserPublish();
      return { ok: true, pinUrl: outcome.pinUrl || '', log: rawLog };
    }
    await sleep(400 + Math.random() * 600);
    const outcome = await publish();
    log.push('published');
    return { ok: true, pinUrl: outcome.pinUrl || '', unconfirmed: !!outcome.unconfirmed, log: rawLog };
  }

  async function doDiagnose() {
    TRUSTED = false;
    await waitFor(() => fileInputs().length || findDropZone() || isLoggedOut(), 20000);
    const report = { url: location.href, loggedIn: !isLoggedOut(), fields: {}, boards: [], notes: [] };
    report.fields.uploadInput = Boolean(fileInputs().length || findDropZone());
    report.uploadInputs = fileInputs().map((el) => ({ id: el.id || undefined, accept: el.accept || undefined, multiple: el.multiple || undefined }));
    report.dropZoneText = findDropZone() ? textOf(findDropZone()).slice(0, 80) : '';
    report.fields.title = Boolean(findTitle());
    report.fields.description = Boolean(findDescription());
    report.fields.link = Boolean(findLink() || buttonByText(/add a link/i));
    report.fields.altText = Boolean(findAlt() || buttonByText(/more options|alt text/i));
    report.fields.boardPicker = Boolean(findBoardButton());
    report.fields.tags = Boolean(findTagInput() || buttonByText(/more options/i));
    report.fields.publish = Boolean(findPublish());
    try {
      const picker = await openBoardPicker();
      if (picker) {
        await sleep(800);
        report.boards = readBoardNames([picker.btn, picker.search], picker.search).slice(0, 100);
        pressKey('Escape');
      }
    } catch { /* ignore */ }
    if (!report.boards.length) report.notes.push('Board list could not be read here (it may only open after an image is added).');
    if (!report.fields.description) report.notes.push('Some boxes only appear after an image is uploaded — use "Fill the form, I click Publish" for a full test.');
    report.dump = dumpFields();
    return report;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('pf-')) return false;
    SEL = { ...DEFAULT_SELECTORS };
    if (msg.selectors && typeof msg.selectors === 'object') {
      for (const [k, list] of Object.entries(msg.selectors)) {
        if (Array.isArray(list)) SEL[k] = [...list.map(String), ...(DEFAULT_SELECTORS[k] || [])];
      }
    }
    const log = [];
    const run = async () => {
      if (msg.type === 'pf-ping') return { ok: true, url: location.href, loggedIn: !isLoggedOut() };
      if (msg.type === 'pf-diagnose') return { ok: true, report: await doDiagnose() };
      if (msg.type === 'pf-publish') return doPublish(msg, log);
      return { ok: false, code: 'UNKNOWN_COMMAND', message: 'Unknown command' };
    };
    run().then(sendResponse, (err) =>
      sendResponse({
        ok: false,
        code: err.code || 'ERROR',
        message: err.message || String(err),
        step: err.step || '',
        log,
        debug: { url: location.href, failedAt: err.step || '', done: log, fields: dumpFields() },
      }),
    );
    return true;
  });
})();
