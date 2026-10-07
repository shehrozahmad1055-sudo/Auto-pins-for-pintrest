// Mock of the REAL Pinterest "Create Pin" page as seen in Shehroz's screenshot (Oct 2026):
// - "Upload your media" box; its file input ignores simulated (untrusted) file changes
// - Title placeholder "Tell everyone what your Pin is about" (no id)
// - Description is a rich-text editor with a separate "Describe your Pin" placeholder
// - Link "Add a link", Board shows the last used board ("backounds"), Tagged topics "Search for a tag"
// - Tag box shows Pinterest's own suggestions for the image when clicked
// - Publish button appears in the top bar only after an image is uploaded
// Reliable mode is simulated: the "trusted" upload/typing that Chrome's debugger would do.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CONTENT = readFileSync(ROOT + '/content/pinterest.js', 'utf8');

const PAGE = `<!doctype html><html><body>
<div class="topnav"><span>Create Pin</span><input name="searchBoxInput" placeholder="Search"></div>
<aside><h2>Pin drafts</h2><button id="createNew">Create new</button></aside>
<section>
  <div class="bar"><h1>Create Pin</h1><div id="pubSlot"></div></div>
  <div class="media" id="media">
    <div><svg></svg><div>Upload your media</div><div>Select multiple files in your file picker with Shift or Cmd/Ctrl</div><div>JPG, PNG up to 20MB · MP4 up to 200MB</div></div>
    <input type="file" accept="image/bmp,image/jpeg,image/png,image/tiff,image/webp,video/mp4" multiple style="display:none" id="fileIn">
  </div>
  <button>Save from URL</button>
  <div class="form">
    <div><div>Title</div><input placeholder="Tell everyone what your Pin is about" id="t" disabled></div>
    <div><div>Description</div><div class="DraftEditor-root"><div class="ph"><div>Describe your Pin</div></div><div class="ed"><div contenteditable="true" id="descEd"></div></div></div></div>
    <div><div>Link</div><input placeholder="Add a link" id="l" disabled></div>
    <div><div>Board</div><div role="button" tabindex="0" id="boardBtn"><span>backounds</span></div></div>
    <div id="boardPop" style="display:none"><input placeholder="Search" id="boardSearch"><div id="boardRows"></div></div>
    <div><div>Tagged topics (0)</div><input placeholder="Search for a tag" id="tags"></div>
    <div id="tagSugg"></div>
    <div><div>Tag products</div><button>Add products</button></div>
    <button id="more">More options</button>
    <div id="moreBox" style="display:none"><div><div>Alt text</div><textarea id="alt" placeholder="Explain what people can see in the Pin"></textarea></div></div>
  </div>
  <div id="toast" aria-live="polite"></div>
</section></body></html>`;

function makePage({ trusted = true } = {}) {
  const dom = new JSDOM(PAGE, { url: 'https://za.pinterest.com/pin-creation-tool/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  w.HTMLElement.prototype.getClientRects = function () {
    for (let el = this; el; el = el.parentElement) if (el.style?.display === 'none') return [];
    return [{}];
  };
  Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', { get() { return this.getAttribute('contenteditable') === 'true'; } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.HTMLInputElement.prototype, 'files', { get() { return this._files || []; }, set(v) { this._files = v; }, configurable: true });
  w.DataTransfer = class { constructor() { this._f = []; this.items = { add: (f) => this._f.push(f) }; } get files() { return this._f; } setData() {} };
  w.DragEvent = class extends w.Event { constructor(t, o = {}) { super(t, o); this.dataTransfer = o.dataTransfer; } };
  d.execCommand = () => false; // simulated typing into the rich editor does NOT work on this page
  d.elementFromPoint = () => null;

  const state = { uploaded: null, tags: [], board: 'backounds', published: false };
  // Pinterest only reacts to REAL file selection
  $('#fileIn').addEventListener('change', (e) => {
    if (!e.__trusted) return;
    state.uploaded = e.target.files[0];
    $('#media').innerHTML = '<img src="blob:https://za.pinterest.com/preview" alt="">';
    for (const id of ['#t', '#l']) $(id).disabled = false;
    const pub = d.createElement('button');
    pub.textContent = 'Publish';
    pub.addEventListener('click', () => {
      state.published = true;
      setTimeout(() => ($('#toast').innerHTML = 'Your Pin has been published! <a href="/pin/998877/">See your Pin</a>'), 300);
    });
    $('#pubSlot').append(pub);
  });
  // draft editor: hide placeholder when it has text
  $('#descEd').addEventListener('input', () => ($('.ph').style.display = $('#descEd').textContent ? 'none' : ''));
  // board picker
  $('#boardBtn').addEventListener('click', () => {
    $('#boardPop').style.display = '';
    $('#boardRows').innerHTML = ['backounds', 'Patterns', 'Home Decor'].map((b) => `<div class="row"><div>${b}</div></div>`).join('');
    d.querySelectorAll('#boardRows .row').forEach((r) => r.addEventListener('click', () => {
      state.board = r.textContent.trim();
      $('#boardBtn span').textContent = state.board;
      $('#boardPop').style.display = 'none';
    }));
  });
  // tag suggestions: Pinterest suggests topics for the image when the box is focused/clicked
  const suggestions = ['Abstract wallpaper', 'Gradient background', 'Pastel aesthetic', 'Phone wallpaper'];
  const showSugg = (list) => {
    $('#tagSugg').innerHTML = list.map((t) => `<div role="option">${t}</div>`).join('');
    d.querySelectorAll('#tagSugg [role=option]').forEach((o) => o.addEventListener('click', () => {
      state.tags.push(o.textContent);
      $('#tagSugg').innerHTML = '';
    }));
  };
  $('#tags').addEventListener('click', () => setTimeout(() => showSugg(suggestions.filter((t) => !state.tags.includes(t))), 200));
  $('#tags').addEventListener('input', (e) => setTimeout(() => e.target.value && showSugg([e.target.value + ' ideas']), 150));
  $('#more').addEventListener('click', () => ($('#moreBox').style.display = ''));

  // --- simulated Chrome debugger ("reliable mode") ---
  const trustedOps = [];
  const listeners = [];
  w.chrome = {
    runtime: {
      onMessage: { addListener: (f) => listeners.push(f) },
      sendMessage: async (msg) => {
        if (msg.type !== 'pf-trusted' || !trusted) return { ok: false };
        trustedOps.push(msg.op);
        if (msg.op === 'upload') {
          const input = msg.selector ? d.querySelector(msg.selector) : null;
          if (!input) return { ok: false };
          input.files = [new w.File([new Uint8Array([1])], 'real.jpg', { type: 'image/jpeg' })];
          const ev = new w.Event('change', { bubbles: true });
          ev.__trusted = true;
          input.dispatchEvent(ev);
          return { ok: true };
        }
        if (msg.op === 'insertText') {
          const el = d.activeElement;
          if (el.isContentEditable) el.textContent = msg.text;
          else el.value = msg.text;
          el.dispatchEvent(new w.Event('input', { bubbles: true }));
          return { ok: true };
        }
        return { ok: true };
      },
    },
  };
  w.eval(CONTENT);
  const send = (m) => new Promise((resolve) => listeners[0](m, {}, resolve));
  return { w, d, state, send, trustedOps };
}

const img = { dataUrl: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), name: 'bg-01.jpg', type: 'image/jpeg' };
const pin = {
  title: 'Soft Pastel Gradient Background',
  description: 'A dreamy pastel gradient for phone wallpapers and design projects. Save it for later!',
  link: 'https://stock.adobe.com/contributor/graphics_bazaar',
  altText: 'Smooth gradient from pink to lavender.',
  board: 'Gradient Ideas', // does not exist → fallback → keep current board
  keywords: ['pastel gradient', 'aesthetic background'],
};

// 1. Reliable mode on the real layout
{
  const t0 = Date.now();
  const { d, state, send, trustedOps } = makePage();
  const res = await send({ type: 'pf-publish', pin, image: img, options: { trusted: true, addTags: true, tagCount: 4, fallbackBoard: 'Patterns' } });
  assert.equal(res.ok, true, JSON.stringify({ m: res.message, log: res.log }));
  assert.ok(state.uploaded, 'image uploaded through reliable mode');
  assert.ok(res.log.some((l) => /upload: reliable/.test(l)));
  assert.equal(d.querySelector('#t').value, pin.title);
  assert.equal(d.querySelector('#descEd').textContent, pin.description);
  assert.equal(d.querySelector('#l').value, pin.link);
  assert.equal(d.querySelector('#alt').value, pin.altText);
  assert.equal(state.board, 'Patterns', 'unknown board → fallback board from Settings');
  assert.ok(state.tags.length >= 3, 'tags added: ' + state.tags.join(', '));
  assert.ok(state.tags.includes('Abstract wallpaper'), "Pinterest's own suggestion used");
  assert.equal(state.published, true);
  assert.match(res.pinUrl, /\/pin\/998877\/$/);
  assert.ok(trustedOps.includes('insertText'));
  console.log(`✓ real layout, reliable mode: upload, title, description, link, alt, board fallback, ${state.tags.length} tags (Pinterest suggestions first), publish — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  tags:', state.tags.join(' | '));
  console.log('  steps:', res.log.join(' → '));
}

// 2. No fallback board, unknown board → keep the board Pinterest already shows
{
  const { state, send } = makePage();
  const res = await send({ type: 'pf-publish', pin, image: img, options: { trusted: true, addTags: false } });
  assert.equal(res.ok, true, res.message);
  assert.equal(state.board, 'backounds');
  assert.ok(res.log.some((l) => /board: kept "backounds"/.test(l)));
  console.log('✓ unknown board keeps the board Pinterest already selected');
}

// 3. Without reliable mode this page rejects the upload → clear error with debug info
{
  const { send } = makePage({ trusted: false });
  const res = await send({ type: 'pf-publish', pin, image: img, options: { trusted: false } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPLOAD_NOT_ACCEPTED');
  assert.ok(res.debug.fields.length > 3);
  console.log('✓ normal mode on a strict page fails clearly (that is why reliable mode exists)');
}

console.log('\nREAL-LAYOUT TESTS PASSED');
process.exit(0);
