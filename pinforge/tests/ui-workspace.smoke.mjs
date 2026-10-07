// UI smoke test: runs the real app.js inside jsdom with mocked chrome.* and fetch.
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const html = readFileSync(ROOT + '/app/app.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'chrome-extension://abc/app/app.html', pretendToBeVisual: true });
const w = dom.window;

for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DOMException']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => (globalThis.__clip = t) }, storage: {} }, configurable: true });
globalThis.CSS = { escape: (s) => s.replace(/"/g, '\\"') };
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function (v) { this.returnValue = v ?? ''; this.open = false; this.dispatchEvent(new w.Event('close')); };
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = 'data:' + blob.type + ';base64,' + Buffer.from(buf).toString('base64');
      this.onload?.();
    });
  }
};
const downloads = [];
const realCreate = URL.createObjectURL;
URL.createObjectURL = (b) => { downloads.push(b); return 'blob:fake/' + downloads.length; };
URL.revokeObjectURL = () => {};
w.HTMLAnchorElement.prototype.click = function () {};

// ---- chrome mock ----
function area(name) {
  const data = {};
  return {
    data,
    async get(k) { if (typeof k === 'string') return k in data ? { [k]: structuredClone(data[k]) } : {}; return structuredClone(data); },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = structuredClone(v); }
      listeners.forEach((l) => l(changes, name));
    },
    async remove(k) { if (k in data) { const changes = { [k]: { oldValue: data[k] } }; delete data[k]; listeners.forEach((l) => l(changes, name)); } },
  };
}
const listeners = [];
const tabUpdated = [];
const tabCreates = [];
const pinterestMsgs = [];
let pinterestMode = 'ok';
globalThis.chrome = {
  storage: { local: area('local'), session: area('session'), onChanged: { addListener: (f) => listeners.push(f) } },
  runtime: { getManifest: () => ({ version: '1.0.0' }), id: 'abc' },
  // --- fake Pinterest window/tab plumbing ---
  windows: {
    getCurrent: async () => ({ id: 1 }),
    update: async () => ({}),
    remove: async () => {},
  },
  tabs: {
    create: async (o) => { tabCreates.push(o); return { id: 7, windowId: 1 }; },
    get: async () => ({ id: 7, windowId: 1, status: 'complete' }),
    update: async (id) => { setTimeout(() => { tabUpdated.forEach((f) => f(id, { status: 'loading' })); tabUpdated.forEach((f) => f(id, { status: 'complete' })); }, 20); return {}; },
    onUpdated: { addListener: (f) => tabUpdated.push(f), removeListener: (f) => tabUpdated.splice(tabUpdated.indexOf(f), 1) },
    onRemoved: { addListener() {}, removeListener() {} },
    sendMessage: async (_id, msg) => {
      pinterestMsgs.push(msg);
      genEvents.push({ t: Date.now(), kind: 'publish-start' });
      await new Promise((r) => setTimeout(r, 30));
      if (pinterestMode === 'loggedout') return { ok: false, code: 'NOT_LOGGED_IN', message: 'You are not logged in to Pinterest in this Chrome.' };
      return { ok: true, pinUrl: 'https://www.pinterest.com/pin/' + pinterestMsgs.length + '/' };
    },
  },
  scripting: { executeScript: async () => [{}] },
};

// ---- fetch mock ----
const calls = [];
let mode = 'ok';
let n = 0;
const genEvents = [];
globalThis.createImageBitmap = async () => ({ width: 1000, height: 1500, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() { return { fillRect() {}, drawImage() {}, set fillStyle(v) {}, set imageSmoothingQuality(v) {} }; }
  async convertToBlob(o) { return new Blob([new Uint8Array([1, 2, 3])], { type: o.type }); }
};
let geminiDelay = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (geminiDelay) await new Promise((r) => setTimeout(r, geminiDelay));
  genEvents.push({ t: Date.now(), kind: 'gen-done' });
  n++;
  if (mode === 'badkey') return { ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } }) };
  const result = {
    imageSummary: 'A blue floral pattern',
    primaryKeyword: 'Blue Floral Pattern',
    title: `Blue Floral Pattern Background Idea #${n}`,
    description: 'A soft blue floral pattern perfect for spring crafts. Save it for your next project!',
    keywords: ['blue floral pattern', '#Spring Background', 'floral wallpaper', 'blue floral pattern'],
    altText: 'Repeating pattern of small blue flowers on a cream background.',
    suggestedBoard: 'Patterns',
    xss: '<img src=x>',
  };
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] }) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];

// ---- seed data ----
const storage = await import(ROOT + '/lib/storage.js');
await storage.saveSettings({ concurrency: 2, requestsPerMinute: 0, boards: ['Patterns', 'Home Decor'], defaultLink: 'https://shop.example.com/' });
await storage.saveApiKey('TESTKEY123', 'local');
const mk = (i, notes = '') => ({
  id: 'id' + i, fileName: `blue-floral-${i}.jpg`, width: 1000, height: 1500,
  aiBlob: new Blob([new Uint8Array([1, 2, 3, i])], { type: 'image/jpeg' }), thumbBlob: new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
  status: 'pending', error: '', notes, link: '', board: '', boardManual: false, title: '', description: '', keywords: [], altText: '',
  primaryKeyword: '', suggestedBoard: '', imageSummary: '', createdAt: 1000 + i,
});
await storage.putItem(mk(1, '<img src=x onerror=alert(1)>'));
await storage.putItem(mk(2));
await storage.putItem(mk(3));

// ---- start app ----
await import(ROOT + '/app/app.js');
await sleep(200);

assert.equal($$('.card').length, 3, '3 cards');
assert.ok($('#keyBanner').classList.contains('hidden'), 'banner hidden with key');
assert.match($('#processBtn').textContent, /Generate all \(3\)/);
assert.match($('#pipelineBtn').textContent, /Generate \+ Publish all \(3\)/);
// XSS check
const notesTa = $('.card[data-id="id1"] textarea[data-field="notes"]');
assert.equal(notesTa.value, '<img src=x onerror=alert(1)>');
assert.equal($$('.card img').filter((i) => i.getAttribute('src') === 'x').length, 0, 'no injected img');
console.log('✓ initial render, XSS-safe notes');

// ---- generate all ----
$('#processBtn').click();
for (let i = 0; i < 50 && $$('.badge-done').length < 3; i++) await sleep(50);
assert.equal($$('.badge-done').length, 3, 'all done');
assert.equal(calls.length, 3);
assert.equal(calls[0].init.headers['x-goog-api-key'], 'TESTKEY123');
assert.ok(!calls[0].url.includes('TESTKEY'));
const body = JSON.parse(calls[0].init.body);
assert.ok(body.contents[0].parts[0].inline_data.data.length > 0, 'image sent');
assert.match(body.contents[0].parts[1].text, /"Patterns", "Home Decor"/);
const c1 = $('.card[data-id="id1"]');
assert.match(c1.querySelector('input[data-field="title"]').value, /^Blue Floral Pattern Background Idea #\d$/);
assert.equal(c1.querySelector('input[data-field="board"]').value, 'Patterns');
assert.deepEqual(c1.querySelector('textarea[data-field="keywords"]').value, 'blue floral pattern, spring background, floral wallpaper');
assert.equal(c1.querySelector('input[data-field="primaryKeyword"]').value, 'blue floral pattern');
assert.ok(c1.querySelector('.chip.primary'), 'primary chip');
const stored = (await storage.getAllItems()).find((x) => x.id === 'id1');
assert.equal(stored.status, 'done');
console.log('✓ bulk generate, prompt, parsing, sanitizing, storage');

// ---- regenerate title only ----
const before = (await storage.getAllItems()).find((x) => x.id === 'id2');
const titleBtn = [...$('.card[data-id="id2"]').querySelectorAll('.mini')].find((b) => b.title === 'Write a new title');
titleBtn.click();
await sleep(200);
const after = (await storage.getAllItems()).find((x) => x.id === 'id2');
assert.notEqual(after.title, before.title, 'title changed');
assert.equal(after.description, before.description);
assert.match(JSON.parse(calls.at(-1).init.body).contents[0].parts[1].text, /NEW alternative title/);
console.log('✓ regenerate single field');

// ---- edit + autosave ----
const desc = $('.card[data-id="id3"] textarea[data-field="description"]');
desc.value = 'My edited description';
desc.dispatchEvent(new w.Event('input'));
await sleep(600);
assert.equal((await storage.getAllItems()).find((x) => x.id === 'id3').description, 'My edited description');
assert.equal($('.card[data-id="id3"] textarea[data-field="description"]').closest('.f').querySelector('.counter').textContent, '21/500');
console.log('✓ edit + debounced autosave + counter');

// ---- preview ----
$('.card[data-id="id1"] .thumb').click();
assert.ok($('#previewDialog').open);
assert.match($('.pin-title').textContent, /Blue Floral/);
assert.equal($('.pin-link').textContent, 'shop.example.com');
$('#previewClose').click();
console.log('✓ preview');

// ---- individual links ----
const indiv = $('input[name="linkMode"][value="individual"]');
indiv.checked = true;
indiv.dispatchEvent(new w.Event('change'));
await sleep(150);
assert.ok(!$('#individualLinkBox').classList.contains('hidden'));
$('#urlList').value = 'a.com/1\nhttps://b.com/2';
$('#applyUrlList').click();
await sleep(150);
let all = await storage.getAllItems();
assert.equal(all[0].link, 'https://a.com/1');
assert.equal(all[1].link, 'https://b.com/2');
assert.equal(all[2].link, '');
$('#copySameToAll').click();
await sleep(150);
all = await storage.getAllItems();
assert.equal(all[2].link, 'https://a.com/1');
$('#urlList').value = 'javascript:alert(1)';
$('#applyUrlList').click();
await sleep(50);
assert.match($('#toasts').textContent, /Invalid URL on line 1/);
console.log('✓ individual links, URL list, invalid URL rejected');

// ---- board for all ----
$('#batchBoard').value = 'Home Decor';
$('#applyBoard').click();
await sleep(150);
assert.ok((await storage.getAllItems()).every((x) => x.board === 'Home Decor' && x.boardManual));
console.log('✓ apply board to all');

// ---- export ----
downloads.length = 0;
$('#exportPreset').value = 'pinterest';
$('[data-export="csv"]').click();
const csvBytes = new Uint8Array(await downloads.at(-1).arrayBuffer());
assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csvBytes).slice(1);
assert.ok(csv.startsWith('Title,Media URL,Pinterest board,Thumbnail,Description,Link,Publish date,Keywords'), csv.slice(0, 120));
assert.ok(csv.includes('https://a.com/1'));
assert.ok(csv.includes('Home Decor'));
$('[data-export="xlsx"]').click();
const xbytes = new Uint8Array(await downloads.at(-1).arrayBuffer());
assert.equal(xbytes[0], 0x50);
$('[data-export="json"]').click();
const json = JSON.parse(await downloads.at(-1).text());
assert.equal(json.count, 3);
console.log('✓ export CSV / XLSX / JSON');

// ---- fatal error stops batch ----
await storage.putItem(mk(4));
await storage.putItem(mk(5));
await storage.putItem(mk(6));
// reload state by re-importing is not possible; simulate via upload path is image-dependent, so test via retry of error items:
mode = 'badkey';
const c2Regen = $$('.card[data-id="id2"] .card-actions button').find((b) => /Regenerate all/.test(b.textContent));
c2Regen.click();
await sleep(200);
assert.equal((await storage.getAllItems()).find((x) => x.id === 'id2').status, 'error');
assert.match($('.card[data-id="id2"] .card-error').textContent, /not valid/);
console.log('✓ API error shown on card');
mode = 'ok';
$('#retryFailedBtn').click();
for (let i = 0; i < 40 && !$('.card[data-id="id2"] .badge-done'); i++) await sleep(50);
assert.ok($('.card[data-id="id2"] .badge-done'));
console.log('✓ retry failed');

// ---- filters & remove ----
$('[data-filter="error"]').click();
assert.equal($$('.card').length, 0);
$('[data-filter="all"]').click();
assert.equal($$('.card').length, 3);
$('#search').value = 'floral-3';
$('#search').dispatchEvent(new w.Event('input'));
await sleep(300);
assert.equal($$('.card').length, 1);
$('#search').value = '';
$('#search').dispatchEvent(new w.Event('input'));
await sleep(300);
const rm = $$('.card[data-id="id3"] .card-actions button').find((b) => b.textContent === 'Remove');
rm.click();
await sleep(150);
assert.equal($$('.card').length, 2);
assert.equal((await storage.getAllItems()).filter((x) => x.id.startsWith('id') && x.id <= 'id3').length, 2);
console.log('✓ filters, search, remove');


// ---- publish to Pinterest ----
await storage.saveSettings({ delayMinSec: 5, delayMaxSec: 5, dailyLimit: 25 });
await sleep(100);
assert.match($('#publishBtn').textContent, /Publish all ready \(2\)/);
$('#publishBtn').click();
for (let i = 0; i < 200 && $$('.publish-row .badge-published').length < 2; i++) await sleep(100);
assert.equal($$('.publish-row .badge-published').length, 2, 'both published');
const pubMsgs = pinterestMsgs.filter((m) => m.type === 'pf-publish');
assert.equal(pubMsgs.length, 2);
assert.equal(pubMsgs[0].pin.board, 'Home Decor');
assert.equal(pubMsgs[0].pin.link, 'https://a.com/1');
assert.match(pubMsgs[0].image.dataUrl, /^data:image\/jpeg;base64,/);
assert.equal(pubMsgs[0].options.addTags, true);
assert.ok($('.card[data-id="id1"] .publish-row a').href.includes('/pin/'));
assert.match($('#publishStatus').textContent, /Published today: 2 \/ 25/);
const pubItem = (await storage.getAllItems()).find((x) => x.id === 'id1');
assert.equal(pubItem.publishStatus, 'published');
assert.equal(tabCreates.length, 1, 'one Pinterest tab, reused');
assert.equal(tabCreates[0].active, true);
assert.equal(tabCreates[0].windowId, 1, 'opened in the same window as PinForge');
console.log('✓ publish to Pinterest (one reusable tab, queue, pacing, payload, pin link, daily counter)');

// published filter
$('[data-filter="published"]').click();
assert.equal($$('.card').length, 2);
$('[data-filter="all"]').click();

// logged-out -> fatal, clear message on the card
pinterestMode = 'loggedout';
$$('.card[data-id="id1"] .publish-row button').find((b) => b.textContent === 'Publish again').click();
await sleep(50);
$$('dialog.dialog button').find((b) => b.textContent === 'Publish again').click();
for (let i = 0; i < 50 && !$('.card[data-id="id1"] .publish-error'); i++) await sleep(50);
assert.match($('.card[data-id="id1"] .publish-error').textContent, /not logged in/);
await sleep(100);
assert.match($('#toasts').textContent, /Publishing stopped: .*Log in to Pinterest/);
console.log('✓ not-logged-in stops publishing with a clear message');

// no board on the card -> still published (Pinterest keeps the last board), fallback board passed along
pinterestMode = 'ok';
await storage.saveSettings({ fallbackBoard: 'Patterns' });
await sleep(100);
const before2 = pinterestMsgs.length;
const boardInput = $('.card[data-id="id2"] input[data-field="board"]');
boardInput.value = '';
boardInput.dispatchEvent(new w.Event('input'));
await sleep(500);
$$('.card[data-id="id2"] .publish-row button').find((b) => b.textContent === 'Publish again').click();
await sleep(50);
$$('dialog.dialog button').find((b) => b.textContent === 'Publish again').click();
for (let i = 0; i < 80 && pinterestMsgs.length === before2; i++) await sleep(50);
const noBoardMsg = pinterestMsgs.at(-1);
assert.equal(noBoardMsg.pin.board, 'Patterns', 'fallback board used when card has none');
assert.equal(noBoardMsg.options.fallbackBoard, 'Patterns');
for (let i = 0; i < 80 && !$('.card[data-id="id2"] .publish-row .badge-published'); i++) await sleep(50);
console.log('✓ empty board → fallback board / Pinterest keeps last board');

// full auto toggle saves
$('#autoMode').checked = true;
$('#autoMode').dispatchEvent(new w.Event('change'));
await sleep(200);
assert.equal((await storage.getSettings()).autoMode, true);
console.log('✓ full auto toggle');

// connection test dialog
pinterestMode = 'ok';
const origSend = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (_id, msg) => msg.type === 'pf-diagnose'
  ? { ok: true, report: { loggedIn: true, fields: { uploadInput: true, title: true, description: true, link: true, altText: true, boardPicker: true, tags: false, publish: true }, boards: ['Home Decor', 'Patterns'], notes: [] } }
  : origSend(_id, msg);
$('#testPinterestBtn').click();
for (let i = 0; i < 40 && !/Your boards/.test($('#diagBody').textContent); i++) await sleep(50);
assert.match($('#diagBody').textContent, /Logged in to Pinterest/);
$$('#diagBody button').find((b) => /Use these boards/.test(b.textContent)).click();
await sleep(100);
assert.deepEqual([...(await storage.getSettings()).boards], ['Home Decor', 'Patterns']);
console.log('✓ connection test + import real boards');


// ---- Full auto: drop images -> each pin is published as soon as it is written ----
await storage.saveSettings({ autoMode: true, concurrency: 1, requestsPerMinute: 0, delayMinSec: 5, delayMaxSec: 5, boards: ['Home Decor'] });
await sleep(100);
geminiDelay = 700;
genEvents.length = 0;
const pubBefore = pinterestMsgs.filter((m) => m.type === 'pf-publish').length;
const fileInput = $('#fileInput');
const mkFile = (n) => new File([new Uint8Array([1, 2, 3, 4])], n, { type: 'image/jpeg' });
Object.defineProperty(fileInput, 'files', { value: [mkFile('auto-1.jpg'), mkFile('auto-2.jpg')], configurable: true });
fileInput.dispatchEvent(new w.Event('change'));
const autoPublished = () => $$('.card').filter((c) => /auto-/.test(c.textContent) && c.querySelector('.badge-published')).length;
for (let i = 0; i < 250 && autoPublished() < 2; i++) await sleep(100);
assert.equal(autoPublished(), 2, 'both dropped images published automatically');
const gens = genEvents.filter((e) => e.kind === 'gen-done');
const pubs = genEvents.filter((e) => e.kind === 'publish-start');
assert.ok(pubs[0].t < gens[1].t, 'first pin was published while the second was still being written');
const autoMsgs = pinterestMsgs.filter((m) => m.type === 'pf-publish').slice(pubBefore);
assert.equal(autoMsgs.length, 2);
assert.ok(autoMsgs.every((m) => m.image.name.startsWith('auto-')), 'original files uploaded');
console.log('✓ full auto: drop → write → publish each pin as soon as it is ready (no waiting for the batch)');
geminiDelay = 0;

console.log('\nALL UI SMOKE TESTS PASSED');
process.exit(0);
