// Runs content/pinterest.js against a mock of Pinterest's "Create Pin" page in jsdom.
// The mock behaves like the real page: fields unlock after upload, the board picker
// filters as you type, tags come from suggestions, Publish shows a success toast.
// Run: npm install && node tests/pinterest-content.smoke.mjs
import { JSDOM } from 'jsdom';
import { installFileChooserPatch } from '../lib/pinterest.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CONTENT = readFileSync(ROOT + '/content/pinterest.js', 'utf8');

// "Hard" mock: few known ids, wrappers around editors, Publish inside the tool's own <header>,
// a board picker and tag suggestions with no ids/roles — PinForge has to use its fallbacks.
const PAGE = `<!doctype html><html><body>
<nav><input name="searchBoxInput" placeholder="Search" id="globalSearch"></nav>
<header class="tool-bar"><span>Create Pin</span><div data-test-id="storyboard-creation-nav-done"><button id="publish" disabled>Publish</button></div></header>
<main>
  <div id="drop"><input type="file" id="storyboard-upload-input" accept="image/*" style="display:none"></div>
  <label for="storyboard-selector-title">Title</label>
  <input id="storyboard-selector-title" placeholder="Add a title" disabled>
  <label>Description</label>
  <div id="storyboard-selector-description"><div class="DraftEditor-root"><div contenteditable="true" role="textbox" id="desc"></div></div></div>
  <label for="WebsiteField">Link</label>
  <input id="WebsiteField" placeholder="Add a link" disabled>
  <span>Board</span>
  <button id="boardBtn">Choose a board</button>
  <div id="picker" style="display:none">
    <input placeholder="Search" id="pickerInput">
    <div id="rows"></div>
  </div>
  <span>Tagged topics</span>
  <input placeholder="Search for a tag" id="tagInput">
  <div id="tagList"></div>
  <button id="more">More options</button>
  <div id="altBox" style="display:none"><textarea id="alt" placeholder="Explain what people can see in the Pin"></textarea></div>
  <div id="toast" role="status"></div>
</main></body></html>`;

const tinyJpegForPatch = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

function makePage({ loggedOut = false, failPublish = false, upload = 'input' } = {}) {
  let html = PAGE;
  if (upload === 'drop') html = html.replace('<div id="drop">', '<div id="drop"><p>Drag and drop or click to upload</p>');
  if (upload === 'chooser') html = html.replace(/<div id="drop">[\s\S]*?<\/div>/, '<div id="drop"><p>Choose a file or drag and drop it here</p><button id="chooseBtn">Choose a file</button></div>');
  const dom = new JSDOM(loggedOut ? '<body><form><input type="password"></form></body>' : html, { url: 'https://www.pinterest.com/pin-creation-tool/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const d = w.document;

  // --- jsdom gaps ---
  w.HTMLElement.prototype.getClientRects = function () {
    for (let el = this; el; el = el.parentElement) if (el.style?.display === 'none') return [];
    return [{}];
  };
  Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', { get() { return this.getAttribute('contenteditable') === 'true'; } });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.HTMLInputElement.prototype, 'files', { get() { return this._files || []; }, set(v) { this._files = v; }, configurable: true });
  w.DataTransfer = class { constructor() { this._f = []; this.items = { add: (f) => this._f.push(f) }; } get files() { return this._f; } setData() {} };
  d.execCommand = (cmd, _ui, val) => {
    const el = d.activeElement;
    if (!el?.isContentEditable) return false;
    if (cmd === 'delete') el.textContent = '';
    if (cmd === 'insertText') el.textContent = val; // selection covers the whole box
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    return true;
  };
  w.DragEvent = class extends w.Event { constructor(t, o = {}) { super(t, o); this.dataTransfer = o.dataTransfer; } };
  const listeners = [];
  w.chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f) } } };

  if (!loggedOut) {
    const $ = (s) => d.querySelector(s);
    const state = { board: '', tags: [], uploaded: null };
    const titleEl = $('#storyboard-selector-title');
    // upload -> progress -> preview replaces the drop area -> fields unlock
    const accept = (file) => {
      state.uploaded = file;
      const bar = d.createElement('div');
      bar.setAttribute('role', 'progressbar');
      d.body.append(bar);
      setTimeout(() => {
        bar.remove();
        $('#drop').innerHTML = '<img src="blob:preview" alt="">';
        titleEl.disabled = false;
        $('#WebsiteField').disabled = false;
      }, 400);
    };
    if (upload === 'input') $('#storyboard-upload-input').addEventListener('change', (e) => accept(e.target.files[0]));
    if (upload === 'drop') $('#drop').addEventListener('drop', (e) => { e.preventDefault(); accept(e.dataTransfer.files[0]); });
    if (upload === 'chooser') {
      $('#chooseBtn').addEventListener('click', () => {
        const input = d.createElement('input');
        input.type = 'file';
        input.addEventListener('change', () => accept(input.files[0]));
        input.click(); // real Pinterest opens the OS file dialog here
      });
    }
    $('#more').addEventListener('click', () => ($('#altBox').style.display = ''));
    // board picker
    const boards = ['Home Decor', 'Patterns', 'Patterns & Textures'];
    const renderRows = (q) => {
      $('#rows').replaceChildren(...boards.filter((b) => b.toLowerCase().includes(q.toLowerCase())).map((b) => {
        const row = d.createElement('div');
        row.innerHTML = `<div><img alt=""><div>${b}</div></div>`;
        row.addEventListener('click', () => {
          state.board = b;
          $('#boardBtn').textContent = b;
          $('#picker').style.display = 'none';
          $('#publish').disabled = false;
        });
        return row;
      }));
    };
    $('#boardBtn').addEventListener('mousedown', () => { $('#picker').style.display = ''; renderRows(''); });
    $('#pickerInput').addEventListener('input', (e) => setTimeout(() => renderRows(e.target.value), 200));
    // tags
    $('#tagInput').addEventListener('input', (e) => {
      const v = e.target.value;
      $('#tagList').replaceChildren();
      if (!v) return;
      setTimeout(() => {
        const opt = d.createElement('div');
        opt.textContent = v + ' ideas';
        opt.addEventListener('click', () => { state.tags.push(opt.textContent); $('#tagList').replaceChildren(); });
        $('#tagList').append(opt);
      }, 300);
    });
    // publish
    $('#publish').addEventListener('click', () => {
      setTimeout(() => {
        if (failPublish) { $('#toast').textContent = 'Something went wrong. Try again later.'; return; }
        $('#toast').innerHTML = 'Your Pin has been published! <a href="/pin/123456/">See your Pin</a>';
      }, 500);
    });
    w.__state = state;
  }

  w.eval(`(${installFileChooserPatch.toString()})(${JSON.stringify(tinyJpegForPatch)}, "patched.jpg", "image/jpeg")`);
  w.eval(CONTENT);
  const send = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));
  return { w, d, send };
}

const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const pin = {
  title: 'Blue Floral Seamless Pattern',
  description: 'A soft blue floral pattern for spring crafts. Save it for later!',
  link: 'https://shop.example.com/blue',
  altText: 'Small blue flowers repeating on a cream background.',
  board: 'patterns',
  keywords: ['floral pattern', 'spring background', 'blue flowers'],
};

// 1. Happy path
{
  const { w, d, send } = makePage();
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'blue.jpg', type: 'image/jpeg' }, options: { publishMode: 'auto', addTags: true, tagCount: 2 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(w.__state.uploaded.name, 'blue.jpg');
  assert.equal(d.querySelector('#storyboard-selector-title').value, pin.title);
  assert.equal(d.querySelector('#desc').textContent, pin.description);
  assert.equal(d.querySelector('#WebsiteField').value, pin.link);
  assert.equal(d.querySelector('#alt').value, pin.altText);
  assert.equal(w.__state.board, 'Patterns', 'exact board (case-insensitive), not "Patterns & Textures"');
  assert.deepEqual([...w.__state.tags], ['floral pattern ideas', 'spring background ideas']);
  assert.equal(d.querySelector('#globalSearch').value, '', 'header search untouched');
  assert.match(res.pinUrl, /\/pin\/123456\/$/);
  console.log('✓ full publish: upload, title, rich-text description, link, alt text, board, tags, publish, pin URL');
}

// 2. Board not found
{
  const { send } = makePage();
  const res = await send({ type: 'pf-publish', pin: { ...pin, board: 'Recipes' }, image: { dataUrl: tinyJpeg, name: 'a.jpg', type: 'image/jpeg' }, options: { publishMode: 'auto' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BOARD_NOT_FOUND');
  assert.match(res.message, /Home Decor/);
  assert.ok(res.debug.fields.length > 5, 'debug field list included');
  assert.ok(res.debug.done.some((l) => l.startsWith('description')), 'debug shows completed steps');
  console.log('✓ missing board reported with the boards that exist');
}

// 3. Pinterest error toast
{
  const { send } = makePage({ failPublish: true });
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'a.jpg', type: 'image/jpeg' }, options: { publishMode: 'auto' } });
  assert.equal(res.code, 'PUBLISH_FAILED');
  console.log('✓ Pinterest error is reported');
}

// 4. Logged out
{
  const { send } = makePage({ loggedOut: true });
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'a.jpg', type: 'image/jpeg' }, options: {} });
  assert.equal(res.code, 'NOT_LOGGED_IN');
  console.log('✓ logged-out detected');
}

// 5. Diagnose
{
  const { send } = makePage();
  const res = await send({ type: 'pf-diagnose' });
  assert.equal(res.report.loggedIn, true);
  assert.equal(res.report.fields.uploadInput, true);
  assert.equal(res.report.fields.publish, true);
  assert.deepEqual([...res.report.boards], ['Home Decor', 'Patterns', 'Patterns & Textures']);
  console.log('✓ diagnose finds fields and reads board names');
}

// 6. Selector overrides
{
  const { d, send } = makePage();
  d.querySelector('#storyboard-selector-title').id = 'brand-new-title';
  d.querySelector('#brand-new-title').removeAttribute('placeholder');
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'a.jpg', type: 'image/jpeg' }, options: {}, selectors: { title: ['#brand-new-title'] } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(d.querySelector('#brand-new-title').value, pin.title);
  console.log('✓ selector overrides from Settings work');
}

// 7. Upload via drag & drop when the file input is ignored
{
  const { w, d, send } = makePage({ upload: 'drop' });
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'drop.jpg', type: 'image/jpeg' }, options: {} });
  assert.equal(res.ok, true, JSON.stringify(res.message));
  assert.equal(w.__state.uploaded.name, 'drop.jpg');
  assert.ok(res.log.some((l) => l.startsWith('upload: drop')));
  assert.equal(d.querySelector('#storyboard-selector-title').value, pin.title);
  console.log('✓ upload fallback: drag & drop');
}

// 8. Upload via "Choose a file" when there is no file input until you click
{
  const { w, send } = makePage({ upload: 'chooser' });
  const res = await send({ type: 'pf-publish', pin, image: { dataUrl: tinyJpeg, name: 'chooser.jpg', type: 'image/jpeg' }, options: {} });
  assert.equal(res.ok, true, JSON.stringify(res.message));
  assert.equal(w.__state.uploaded.name, 'patched.jpg');
  assert.ok(res.log.some((l) => l.startsWith('upload: chooser')));
  console.log('✓ upload fallback: "Choose a file" dialog handed our image');
}

console.log('\nPINTEREST CONTENT SCRIPT TESTS PASSED');
process.exit(0);
