// shared/dom.js
// Tiny DOM helpers used by every page.
// SECURITY: we never put AI or user text into innerHTML. h() uses textContent,
// so text that looks like <script> is shown as text, never executed.

/**
 * h('button', { class: 'btn', onclick: fn }, 'Save')
 * Children can be strings, nodes, arrays, null/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Small notification in the corner. type: 'info' | 'success' | 'error' */
export function toast(message, type = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  box.append(t);
  setTimeout(() => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success', 1600);
  } catch {
    toast('Could not copy to clipboard.', 'error');
  }
}

export function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Trigger a file download from a string or bytes. */
export function downloadFile(content, fileName, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Simple confirm dialog using <dialog>. Resolves true/false. */
export function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const dlg = h(
      'dialog',
      { class: 'dialog' },
      h('p', {}, message),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', value: 'cancel', onclick: () => dlg.close('cancel') }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => dlg.close('ok') }, okLabel),
      ),
    );
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}
