// app/app.js
// The main workspace: upload images, run Gemini on them, edit results, publish to Pinterest.
//
// Flow:  files -> prepareImage() -> saved in IndexedDB as "pending"
//        "Generate" -> processItem() -> Gemini -> sanitizeResult() -> "done"
//        edits are saved automatically (debounced)
//        "Publish" -> publishItem() -> lib/pinterest.js -> Pinterest Create Pin page -> "published"
//        Full auto = generate + publish as soon as images are dropped

import { h, $, $$, toast, copyText, debounce, downloadFile, confirmDialog } from '../shared/dom.js';
import { getSettings, saveSettings, onSettingsChanged, getApiKey, getAllItems, putItem, deleteItem } from '../lib/storage.js';
import { checkFile, prepareImage, blobToBase64, aspectNote } from '../lib/image.js';
import { buildPrompt, generatePinData, withRetry } from '../lib/gemini.js';
import { sanitizeResult, normalizeKeywords, normalizeUrl, parseUrlList, fileNameHint, displayDomain, clampText, LIMITS } from '../lib/validate.js';
import { toPins, toTable, toCSV, toJSON, toXLSX, exportFileName } from '../lib/export.js';
import { runQueue } from '../lib/queue.js';
import { publishPin, diagnose, parseSelectorOverrides, randomDelayMs, getTodayCount, bumpTodayCount, focusPinterestWindow, endPublishingSession } from '../lib/pinterest.js';

// Errors that will fail for every image, so bulk processing stops instead of burning through the queue.
const FATAL_CODES = new Set(['NO_KEY', 'INVALID_KEY', 'PERMISSION', 'MODEL_NOT_FOUND', 'UNAVAILABLE_REGION']);

const state = {
  settings: null,
  apiKey: '',
  items: new Map(), // id -> item
  order: [], // ids in upload order
  thumbUrls: new Map(), // id -> blob: URL
  busy: new Set(), // "id:field" currently regenerating
  filter: 'all',
  search: '',
  running: false,
  abort: null,
  publishing: false,
  publishAbort: null,
  autoBusy: false,
  autoAgain: false,
  streamPublish: false,
  publishDone: Promise.resolve(),
};

// ---------------------------------------------------------------- helpers

const getItem = (id) => state.items.get(id);
const effectiveLink = (item) => (state.settings.linkMode === 'same' ? state.settings.defaultLink : item.link) || '';
const hasCredentials = () => Boolean(state.apiKey || state.settings.proxyUrl);

const saveSoon = new Map();
function scheduleSave(item) {
  if (!saveSoon.has(item.id)) {
    saveSoon.set(item.id, debounce((it) => putItem(it).catch(reportStorageError), 400));
  }
  saveSoon.get(item.id)(item);
}

function reportStorageError(err) {
  console.error(err);
  toast('Could not save to browser storage: ' + (err?.message || err), 'error', 6000);
}

function thumbUrl(item) {
  if (!item.thumbBlob) return '';
  if (!state.thumbUrls.has(item.id)) state.thumbUrls.set(item.id, URL.createObjectURL(item.thumbBlob));
  return state.thumbUrls.get(item.id);
}

function matchesFilter(item) {
  const f = state.filter;
  if (f === 'done' && !(item.status === 'done' && item.publishStatus !== 'published')) return false;
  if (f === 'published' && item.publishStatus !== 'published') return false;
  if (f === 'error' && item.status !== 'error') return false;
  if (f === 'pending' && !(item.status === 'pending' || item.status === 'processing')) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    return (item.fileName + ' ' + (item.title || '')).toLowerCase().includes(q);
  }
  return true;
}

// ---------------------------------------------------------------- start-up

async function init() {
  state.settings = await getSettings();
  state.apiKey = await getApiKey();

  try {
    const items = await getAllItems();
    for (const it of items) {
      if (it.status === 'processing') it.status = 'pending'; // page was closed mid-run
      if (it.publishStatus === 'publishing' || it.publishStatus === 'queued') it.publishStatus = '';
      state.items.set(it.id, it);
      state.order.push(it.id);
    }
  } catch (err) {
    reportStorageError(err);
  }

  bindUi();
  applySettingsToUi();
  renderAll();

  onSettingsChanged((s) => {
    state.settings = s;
    applySettingsToUi();
    if (!state.running && !state.publishing) renderAll();
  });
  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.geminiApiKey) {
      state.apiKey = await getApiKey();
      updateBanner();
      if (!state.running && !state.publishing) renderAll();
    }
  });
  updatePublishStatus();
}

function applySettingsToUi() {
  const s = state.settings;
  $$('input[name="linkMode"]').forEach((r) => (r.checked = r.value === s.linkMode));
  $('#sameLinkBox').classList.toggle('hidden', s.linkMode !== 'same');
  $('#individualLinkBox').classList.toggle('hidden', s.linkMode !== 'individual');
  if (document.activeElement !== $('#sameLink')) $('#sameLink').value = s.defaultLink || '';
  $('#boardList').replaceChildren(...(s.boards || []).map((b) => h('option', { value: b })));
  $('#autoMode').checked = !!s.autoMode;
  $('#publishMode').value = s.publishMode || 'auto';
  updateBanner();
}

function updateBanner() {
  $('#keyBanner').classList.toggle('hidden', hasCredentials());
}

// ---------------------------------------------------------------- uploading

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const rejected = [];
  let added = 0;
  const t0 = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const problem = checkFile(file);
    if (problem) {
      rejected.push(`${file.name}: ${problem}`);
      continue;
    }
    try {
      const img = await prepareImage(file);
      const item = {
        id: crypto.randomUUID(),
        fileName: file.name || `pasted-${Date.now()}.png`,
        width: img.width,
        height: img.height,
        aiBlob: img.aiBlob,
        thumbBlob: img.thumbBlob,
        uploadBlob: img.uploadBlob,
        publishStatus: '',
        pinUrl: '',
        publishError: '',
        status: 'pending',
        error: '',
        notes: '',
        link: '',
        board: '',
        boardManual: false,
        title: '',
        description: '',
        keywords: [],
        altText: '',
        primaryKeyword: '',
        suggestedBoard: '',
        imageSummary: '',
        createdAt: t0 + i,
      };
      await putItem(item);
      state.items.set(item.id, item);
      state.order.push(item.id);
      added++;
      if (matchesFilter(item)) $('#grid').append(buildCard(item));
      updateCounts();
    } catch (err) {
      rejected.push(`${file.name}: ${err.message}`);
    }
  }

  if (added) toast(`Added ${added} image${added > 1 ? 's' : ''}.${state.settings.autoMode ? ' Full auto is on — writing and publishing…' : ''}`, 'success');
  if (rejected.length) toast(`Skipped ${rejected.length}: ${rejected.slice(0, 3).join(' · ')}${rejected.length > 3 ? ' …' : ''}`, 'error', 8000);
  updateEmpty();
  if (added && state.settings.autoMode) runAutoPipeline();
}

// ---------------------------------------------------------------- AI processing

/**
 * Generate (or regenerate) one item.
 * onlyField = 'title' | 'description' | 'keywords' | 'altText' | 'board' to replace just that field.
 */
async function processItem(id, { onlyField = null, signal } = {}) {
  const item = getItem(id);
  if (!item) return;
  if (!item.aiBlob) throw new Error('Image data missing — remove and re-upload this image.');

  const prevStatus = item.status;
  const busyKey = `${id}:${onlyField || '*'}`;
  state.busy.add(busyKey);
  if (!onlyField) {
    item.status = 'processing';
    item.error = '';
    item.retryNote = '';
  }
  renderCard(id);

  try {
    const base64 = await blobToBase64(item.aiBlob);
    const promptField = onlyField === 'board' ? 'suggestedBoard' : onlyField;
    const prompt = buildPrompt(
      state.settings,
      {
        fileName: fileNameHint(item.fileName),
        notes: item.notes,
        link: effectiveLink(item),
        current: onlyField ? { ...item, suggestedBoard: item.board } : null,
      },
      { onlyField: promptField },
    );

    const raw = await withRetry(
      () =>
        generatePinData({
          apiKey: state.apiKey,
          model: state.settings.model,
          proxyUrl: state.settings.proxyUrl,
          proxyToken: state.settings.proxyToken,
          prompt,
          base64,
          mimeType: 'image/jpeg',
          signal,
        }),
      {
        signal,
        onRetry: ({ wait, attempt, error }) => {
          item.retryNote = `${error.message} (try ${attempt + 1}, waiting ${Math.round(wait / 1000)}s)`;
          renderCard(id);
        },
      },
    );

    const r = sanitizeResult(raw, state.settings);
    if (onlyField === 'board') {
      item.suggestedBoard = r.suggestedBoard;
      item.board = r.suggestedBoard;
      item.boardManual = false;
    } else if (onlyField) {
      item[onlyField] = r[onlyField];
    } else {
      Object.assign(item, {
        title: r.title,
        description: r.description,
        keywords: r.keywords,
        altText: r.altText,
        primaryKeyword: r.primaryKeyword,
        suggestedBoard: r.suggestedBoard,
        imageSummary: r.imageSummary,
      });
      if (!item.boardManual) item.board = r.suggestedBoard;
      item.status = 'done';
    }
    item.error = '';
    item.retryNote = '';
    await putItem(item);
  } catch (err) {
    if (err?.name === 'AbortError') {
      item.status = prevStatus === 'processing' ? 'pending' : prevStatus;
    } else if (onlyField) {
      toast(`Regenerate failed: ${err.message}`, 'error', 6000);
    } else {
      item.status = 'error';
      item.error = err.message || String(err);
    }
    item.retryNote = '';
    await putItem(item).catch(reportStorageError);
    throw err;
  } finally {
    state.busy.delete(busyKey);
    renderCard(id);
    updateCounts();
  }
}

async function processMany(ids, { onDone } = {}) {
  if (state.running) return;
  if (!hasCredentials()) {
    toast('Add your Gemini API key in Settings first.', 'error');
    updateBanner();
    return;
  }
  if (!ids.length) {
    toast('Nothing to generate. Use "Regenerate" on a card to redo a finished pin.', 'info');
    return;
  }

  state.running = true;
  state.abort = new AbortController();
  setRunningUi(true, 0, ids.length, 0);
  let fatal = null;

  const result = await runQueue(
    ids,
    async (id) => {
      try {
        await processItem(id, { signal: state.abort.signal });
        if (getItem(id)?.status === 'done') onDone?.(id);
      } catch (err) {
        if (FATAL_CODES.has(err?.code) && !fatal) {
          fatal = err;
          state.abort.abort();
        }
        throw err;
      }
    },
    {
      concurrency: Number(state.settings.concurrency) || 1,
      requestsPerMinute: Number(state.settings.requestsPerMinute) || 0,
      signal: state.abort.signal,
      onProgress: ({ done, total, failed }) => setRunningUi(true, done, total, failed),
    },
  );

  state.running = false;
  state.abort = null;
  setRunningUi(false);

  // Items that never started go back to "pending".
  for (const id of ids) {
    const it = getItem(id);
    if (it?.status === 'processing') {
      it.status = 'pending';
      renderCard(id);
    }
  }
  updateCounts();

  if (fatal) toast(`Stopped: ${fatal.message}`, 'error', 9000);
  else if (result.aborted) toast('Stopped.', 'info');
  else toast(`Finished ${result.done - result.failed} of ${result.total}${result.failed ? ` · ${result.failed} failed` : ''}.`, result.failed ? 'error' : 'success', 6000);
}

function setRunningUi(running, done = 0, total = 0, failed = 0) {
  $('#processBtn').disabled = running;
  $('#pipelineBtn').disabled = running || state.publishing;
  $('#retryFailedBtn').disabled = running;
  $('#stopAllBtn').classList.toggle('hidden', !(running || state.publishing));
  $('#progress').classList.toggle('hidden', !running);
  if (running) {
    $('#progressFill').style.width = total ? `${(done / total) * 100}%` : '0';
    $('#progressText').textContent = `Writing pins: ${done} / ${total}${failed ? ` · ${failed} failed` : ''}`;
  }
}

// ---------------------------------------------------------------- Pinterest publishing

const PUBLISH_FATAL_HINT = {
  NOT_LOGGED_IN: 'Log in to Pinterest in this Chrome, then press Publish again.',
  PERMISSION: 'Open chrome://extensions, reload PinForge, and allow it on pinterest.com.',
  WINDOW_CLOSED: 'The Pinterest tab was closed.',
  PUBLISH_UNCONFIRMED: 'Stopped so no more drafts pile up — check "Pin drafts" on Pinterest, then send the debug info.',
};

function pinPayload(item) {
  return {
    title: clampText(item.title, LIMITS.title),
    description: clampText(item.description, LIMITS.description),
    link: effectiveLink(item),
    altText: clampText(item.altText, LIMITS.altText),
    board: (item.board || state.settings.fallbackBoard || '').trim(),
    keywords: item.keywords || [],
  };
}

function publishOptions() {
  const s = state.settings;
  return {
    createUrl: s.pinterestCreateUrl,
    publishMode: s.publishMode || 'auto',
    addTags: !!s.addTags,
    tagCount: Number(s.tagCount) || 5,
    selectors: parseSelectorOverrides(s.selectorOverrides),
    reliable: s.reliableMode !== false,
    fallbackBoard: s.fallbackBoard || '',
  };
}

async function publishItem(id) {
  const item = getItem(id);
  if (!item) return;
  const pin = pinPayload(item);
  // (no board is OK: Pinterest keeps the board you used last)
  const problem = item.status !== 'done' || !item.title ? 'Generate the pin text first.' : '';
  if (problem) {
    item.publishStatus = 'failed';
    item.publishError = problem;
    await putItem(item).catch(reportStorageError);
    renderCard(id);
    throw new Error(problem);
  }

  item.publishStatus = 'publishing';
  item.publishError = '';
  item.publishDebug = '';
  renderCard(id);
  try {
    const res = await publishPin(pin, item.uploadBlob || item.aiBlob, item.fileName, publishOptions());
    item.publishStatus = 'published';
    item.pinUrl = res.pinUrl || '';
    item.publishLog = (res.log || []).join('\n');
    item.publishNote = res.unconfirmed ? 'Pinterest did not show a confirmation — check your profile.' : '';
    item.publishedAt = Date.now();
    await bumpTodayCount();
  } catch (err) {
    item.publishStatus = 'failed';
    item.publishError = err.message || String(err);
    item.publishDebug = err.debug ? JSON.stringify({ error: err.code, message: err.message, ...err.debug }, null, 2) : '';
    throw err;
  } finally {
    await putItem(item).catch(reportStorageError);
    renderCard(id);
    updateCounts();
  }
}

const readyToPublish = (it, includeFailed) =>
  it && it.status === 'done' && it.title && it.publishStatus !== 'published' && (includeFailed || it.publishStatus !== 'failed');

/** Wait `ms`, showing a countdown, unless stopped. Returns false if stopped. */
async function waitWithCountdown(ms, label) {
  // One timer for the real wait (Chrome slows down repeated timers in background tabs,
  // and this tab is in the background while Pinterest is in front). The countdown text
  // is only cosmetic.
  const end = Date.now() + ms;
  const signal = state.publishAbort?.signal;
  const show = () => ($('#publishStatus').textContent = `${label} — next pin in ${Math.max(0, Math.ceil((end - Date.now()) / 1000))}s`);
  show();
  const ticker = setInterval(show, 1000);
  await new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  clearInterval(ticker);
  return !signal?.aborted;
}

// ---- publish queue: pins are published one by one, as soon as each is ready ----
const pubQueue = [];
let pubStats = { ok: 0, failed: 0, stopReason: '' };

/** Add pins to the publish line. Starts the worker if it isn't running. */
function enqueuePublish(ids) {
  for (const id of ids) {
    const it = getItem(id);
    if (!it || pubQueue.includes(id) || it.publishStatus === 'publishing') continue;
    it.publishStatus = 'queued';
    pubQueue.push(id);
    renderCard(id);
  }
  updateCounts();
  return runPublishWorker();
}

function runPublishWorker() {
  if (state.publishing) return state.publishDone;
  state.publishing = true;
  state.publishAbort = new AbortController();
  pubStats = { ok: 0, failed: 0, stopReason: '' };
  setPublishingUi(true);
  let nextAt = 0;

  state.publishDone = (async () => {
    const signal = state.publishAbort.signal;
    for (;;) {
      if (signal.aborted) break;
      if (!pubQueue.length) {
        // While pins are still being written, wait for the next one instead of finishing.
        if (state.streamPublish && state.running) {
          $('#publishStatus').textContent = `${pubStats.ok} published — waiting for the next pin to be written…`;
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        break;
      }
      const limit = Number(state.settings.dailyLimit) || 0;
      if (limit && (await getTodayCount()) >= limit) {
        pubStats.stopReason = `Daily limit of ${limit} pins reached (Settings → Pinterest).`;
        break;
      }
      const wait = nextAt - Date.now();
      if (wait > 0 && !(await waitWithCountdown(wait, `${pubStats.ok} published`))) break;

      const id = pubQueue.shift();
      if (!readyToPublish(getItem(id), true) && getItem(id)?.publishStatus !== 'queued') continue;
      $('#publishStatus').textContent = `Publishing… (${pubStats.ok} done, ${pubQueue.length} waiting)`;
      try {
        await publishItem(id);
        pubStats.ok++;
      } catch (err) {
        pubStats.failed++;
        if (err.fatal) {
          pubStats.stopReason = `${err.message} ${PUBLISH_FATAL_HINT[err.code] || ''}`.trim();
          break;
        }
      }
      nextAt = Date.now() + randomDelayMs(state.settings.delayMinSec, state.settings.delayMaxSec);
    }

    // Anything still waiting goes back to "not on Pinterest yet".
    while (pubQueue.length) {
      const it = getItem(pubQueue.shift());
      if (it?.publishStatus === 'queued') {
        it.publishStatus = '';
        renderCard(it.id);
      }
    }
    const stopped = state.publishAbort.signal.aborted;
    await endPublishingSession().catch(() => {});
    state.publishing = false;
    state.publishAbort = null;
    setPublishingUi(false);
    updateCounts();
    const { ok, failed, stopReason } = pubStats;
    if (stopReason) toast(`Publishing stopped: ${stopReason}`, 'error', 10000);
    else if (stopped) toast(`Stopped. ${ok} pin${ok === 1 ? '' : 's'} published.`, 'info');
    else if (ok || failed) toast(`${ok} pin${ok === 1 ? '' : 's'} published to Pinterest${failed ? ` · ${failed} failed` : ''}.`, failed ? 'error' : 'success', 7000);
  })();
  return state.publishDone;
}

async function publishMany(ids, { quiet = false } = {}) {
  ids = ids.filter((id) => getItem(id));
  if (!ids.length) {
    if (!quiet) toast('No ready pins to publish. Generate pins first.', 'info');
    return;
  }
  const limit = Number(state.settings.dailyLimit) || 0;
  if (limit && (await getTodayCount()) >= limit) {
    toast(`Daily limit of ${limit} pins reached (Settings → Pinterest). This keeps your account safe.`, 'error', 8000);
    return;
  }
  await enqueuePublish(ids);
}

/**
 * One click for everything: write every image that isn't written yet, and publish each
 * pin the moment it's ready (no waiting for the whole batch). Already-written pins are
 * published too.
 */
async function generateAndPublishAll({ includeFailed = true } = {}) {
  if (!hasCredentials()) {
    toast('Add your Gemini API key in Settings first.', 'error');
    return;
  }
  const toGenerate = state.order.filter((id) => ['pending', 'error'].includes(getItem(id)?.status));
  const ready = state.order.filter((id) => readyToPublish(getItem(id), includeFailed));
  if (!toGenerate.length && !ready.length) {
    toast('Everything is already on Pinterest. Drop more images!', 'info');
    return;
  }
  const limit = Number(state.settings.dailyLimit) || 0;
  if (limit && (await getTodayCount()) >= limit) {
    toast(`Daily limit of ${limit} pins reached (Settings → Pinterest).`, 'error', 8000);
    return;
  }
  state.streamPublish = true;
  try {
    const gen = toGenerate.length ? processMany(toGenerate, { onDone: (id) => enqueuePublish([id]) }) : Promise.resolve();
    const pub = enqueuePublish(ready);
    await gen;
    await pub;
    await state.publishDone;
  } finally {
    state.streamPublish = false;
  }
}

function setPublishingUi(on) {
  $('#publishBtn').disabled = on;
  $('#pipelineBtn').disabled = on || state.running;
  $('#testPinterestBtn').disabled = on;
  $('#stopAllBtn').classList.toggle('hidden', !(on || state.running));
  if (!on) updatePublishStatus();
}

async function updatePublishStatus() {
  if (state.publishing) return;
  const limit = Number(state.settings.dailyLimit) || 0;
  const today = await getTodayCount().catch(() => 0);
  $('#publishStatus').textContent = `Published today: ${today}${limit ? ` / ${limit}` : ''}`;
}

/** Full auto: same as "Generate + publish all", re-run whenever new images arrive. */
async function runAutoPipeline() {
  if (state.autoBusy) {
    state.autoAgain = true;
    return;
  }
  state.autoBusy = true;
  try {
    do {
      state.autoAgain = false;
      if (!state.settings.autoMode) break;
      await generateAndPublishAll({ includeFailed: false });
    } while (state.autoAgain && state.settings.autoMode);
  } finally {
    state.autoBusy = false;
  }
}

async function runDiagnose() {
  const body = $('#diagBody');
  body.replaceChildren(h('p', {}, 'Opening Pinterest and checking the Create Pin page…'));
  $('#diagDialog').showModal();
  try {
    const r = await diagnose(publishOptions());
    const labels = {
      uploadInput: 'Image upload', title: 'Title box', description: 'Description box', link: 'Link box',
      altText: 'Alt text', boardPicker: 'Board picker', tags: 'Tagged topics', publish: 'Publish button',
    };
    const savedBoards = state.settings.boards || [];
    const missingBoards = savedBoards.filter((b) => r.boards.length && !r.boards.some((x) => x.toLowerCase() === b.toLowerCase()));
    body.replaceChildren(
      h('p', {}, r.loggedIn ? h('strong', { class: 'y' }, '✓ Logged in to Pinterest') : h('strong', { class: 'error-text' }, '✗ Not logged in — log in to Pinterest in this Chrome first.')),
      h('ul', { class: 'diag-list' }, Object.entries(labels).map(([k, label]) =>
        h('li', {}, h('span', { class: r.fields[k] ? 'y' : 'n' }, r.fields[k] ? '✓' : '✗'), label))),
      r.boards.length
        ? h('div', {},
            h('p', {}, h('strong', {}, `Your boards (${r.boards.length}): `), r.boards.join(', ')),
            missingBoards.length ? h('p', { class: 'error-text small' }, 'These boards in Settings were not found on Pinterest: ', missingBoards.join(', ')) : null,
            h('button', {
              class: 'btn btn-sm',
              onclick: async () => {
                state.settings = await saveSettings({ boards: r.boards });
                applySettingsToUi();
                toast('Boards saved — the AI will now choose from your real boards.', 'success');
              },
            }, 'Use these boards in PinForge'))
        : null,
      r.notes.length ? h('ul', { class: 'small muted' }, r.notes.map((n) => h('li', {}, n))) : null,
      h('p', { class: 'small muted' }, 'Tip: for a full test, set "When a pin is ready" to "Fill the form, I click Publish" and publish one pin. Nothing is posted until you click Publish.'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copyText(JSON.stringify(r, null, 2), 'Report copied') }, 'Copy report'),
    );
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error-text' }, err.message), h('p', { class: 'small muted' }, PUBLISH_FATAL_HINT[err.code] || ''));
  }
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  const grid = $('#grid');
  grid.replaceChildren(...state.order.map(getItem).filter(Boolean).filter(matchesFilter).map(buildCard));
  updateCounts();
  updateEmpty();
}

function renderCard(id) {
  const old = $(`.card[data-id="${CSS.escape(id)}"]`);
  const item = getItem(id);
  if (!item) {
    old?.remove();
    return;
  }
  if (!matchesFilter(item)) {
    old?.remove();
    return;
  }
  if (!old) return;
  // Keep the cursor where it was if the user is typing in this card.
  const active = document.activeElement;
  const restore = old.contains(active) && active?.dataset?.field
    ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
    : null;
  const fresh = buildCard(item);
  old.replaceWith(fresh);
  if (restore) {
    const el = fresh.querySelector(`[data-field="${restore.field}"]`);
    if (el) {
      el.closest('details')?.setAttribute('open', '');
      el.focus();
      try { el.setSelectionRange(restore.start, restore.end); } catch { /* not a text input */ }
    }
  }
}

function updateCounts() {
  const all = state.order.map(getItem).filter(Boolean);
  const c = {
    all: all.length,
    done: all.filter((i) => i.status === 'done' && i.publishStatus !== 'published').length,
    published: all.filter((i) => i.publishStatus === 'published').length,
    error: all.filter((i) => i.status === 'error').length,
    pending: all.filter((i) => i.status === 'pending' || i.status === 'processing').length,
  };
  $('#stats').replaceChildren(
    h('span', {}, h('b', {}, c.all), ' images'),
    h('span', {}, h('b', {}, c.done), ' ready'),
    h('span', {}, h('b', {}, c.published), ' published'),
    h('span', {}, h('b', {}, c.pending), ' to do'),
    c.error ? h('span', {}, h('b', {}, c.error), ' errors') : null,
  );
  for (const btn of $$('#filterTabs button')) {
    const key = btn.dataset.filter;
    const label = { all: 'All', pending: 'To do', done: 'Ready', published: 'Published', error: 'Errors' }[key];
    btn.replaceChildren(label, h('span', { class: 'count' }, c[key]));
  }
  $('#retryFailedBtn').classList.toggle('hidden', !c.error);
  const toPublish = all.filter((i) => readyToPublish(i, true)).length;
  const toGen = c.pending + c.error;
  $('#processBtn').textContent = toGen ? `Generate all (${toGen})` : 'Generate all';
  $('#publishBtn').textContent = toPublish ? `Publish all ready (${toPublish})` : 'Publish all ready';
  $('#pipelineBtn').textContent = toGen + toPublish ? `Generate + Publish all (${toGen + toPublish})` : 'Generate + Publish all';
}

function updateEmpty() {
  $('#empty').classList.toggle('hidden', state.order.length > 0);
}

function statusBadge(item) {
  const text = { pending: 'Not generated', processing: 'Generating…', done: 'Ready', error: 'Error' }[item.status] || item.status;
  return h('span', { class: `badge badge-${item.status}` }, text);
}

function counter(len, max) {
  return h('span', { class: `counter${len > max ? ' over' : ''}` }, `${len}/${max}`);
}

/** Small "↻" + "Copy" buttons in a field header. */
function fieldTools(item, field, getCopyText) {
  const busy = state.busy.has(`${item.id}:${field}`) || item.status === 'processing';
  return [
    h('button', {
      class: 'mini',
      title: `Write a new ${field}`,
      disabled: busy || !hasCredentials(),
      onclick: () => processItem(item.id, { onlyField: field }).catch(() => {}),
    }, state.busy.has(`${item.id}:${field}`) ? '…' : '↻ New'),
    getCopyText ? h('button', { class: 'mini', title: 'Copy', onclick: () => copyText(getCopyText(), 'Copied') }, 'Copy') : null,
  ];
}

function textField(item, { field, label, max, multiline = false, rows = 3 }) {
  const cnt = counter((item[field] || '').length, max);
  const input = h(multiline ? 'textarea' : 'input', {
    type: multiline ? null : 'text',
    rows: multiline ? rows : null,
    'aria-label': label,
    dataset: { field },
    oninput: (e) => {
      item[field] = e.target.value;
      cnt.textContent = `${e.target.value.length}/${max}`;
      cnt.classList.toggle('over', e.target.value.length > max);
      scheduleSave(item);
    },
  });
  input.value = item[field] || '';
  return h('div', { class: 'f' }, h('div', { class: 'f-head' }, h('span', { class: 'label' }, label), cnt, fieldTools(item, field, () => item[field] || '')), input);
}

function buildCard(item) {
  const done = item.status === 'done' || Boolean(item.title);
  const isSame = state.settings.linkMode === 'same';

  const img = h('img', { class: 'thumb', src: thumbUrl(item), alt: item.altText || item.fileName, onclick: () => openPreview(item.id) });

  const actions = h(
    'div',
    { class: 'card-actions' },
    h('button', {
      class: `btn btn-sm ${done ? '' : 'btn-primary'}`,
      disabled: item.status === 'processing' || !hasCredentials(),
      onclick: () => processItem(item.id).catch(() => {}),
    }, item.status === 'processing' ? 'Working…' : done ? 'Regenerate all' : 'Generate'),
    done ? h('button', { class: 'btn btn-sm', onclick: () => openPreview(item.id) }, 'Preview') : null,
    done ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copyText(formatForCopy(item), 'Pin details copied') }, 'Copy all') : null,
    h('button', { class: 'btn btn-sm btn-ghost', 'aria-label': 'Remove image', title: 'Remove', onclick: () => removeItem(item.id) }, 'Remove'),
  );

  const head = h(
    'div',
    { class: 'card-head' },
    img,
    h(
      'div',
      { class: 'card-meta' },
      h('div', { class: 'file-name', title: item.fileName }, item.fileName),
      h('div', { class: 'meta-line' }, statusBadge(item), h('span', { class: 'small muted' }, `${item.width}×${item.height} · ${aspectNote(item.width, item.height)}`)),
      item.retryNote ? h('div', { class: 'small muted' }, item.retryNote) : null,
      item.status === 'error' ? h('div', { class: 'card-error' }, item.error) : null,
      actions,
    ),
  );

  // Link field (shown for every card in "individual" mode)
  let linkField = null;
  if (!isSame) {
    const err = h('span', { class: 'small error-text' });
    linkField = h(
      'div',
      { class: 'f' },
      h('div', { class: 'f-head' }, h('span', { class: 'label' }, 'Destination link')),
      h('input', {
        type: 'url',
        value: item.link || '',
        placeholder: 'https://yoursite.com/this-product',
        'aria-label': 'Destination link',
        dataset: { field: 'link' },
        onchange: (e) => {
          const r = normalizeUrl(e.target.value);
          e.target.classList.toggle('invalid', !r.ok);
          err.textContent = r.ok ? '' : r.error;
          if (r.ok) {
            item.link = r.url;
            e.target.value = r.url;
            putItem(item).catch(reportStorageError);
          }
        },
      }),
      err,
    );
  }

  const notes = h(
    'details',
    { class: 'notes', open: !done && item.notes ? true : null },
    h('summary', {}, item.notes ? 'Notes for AI ✓' : 'Notes for AI (optional)'),
    h('textarea', {
      rows: 2,
      placeholder: 'e.g. "Seamless pattern for fabric printing, sold on my Etsy shop"',
      dataset: { field: 'notes' },
      oninput: (e) => {
        item.notes = e.target.value;
        scheduleSave(item);
      },
    }, item.notes || ''),
  );

  if (!done) {
    return h('article', { class: `card panel is-${item.status}`, dataset: { id: item.id } }, head, h('div', { class: 'card-body' }, linkField, notes));
  }
  const publishRow = buildPublishRow(item);

  // ---- Full editor for generated pins ----
  const chips = h('div', { class: 'chips' });
  const renderChips = () =>
    chips.replaceChildren(...(item.keywords || []).map((k) => h('span', { class: `chip${k === item.primaryKeyword ? ' primary' : ''}` }, k)));
  renderChips();

  const keywordsField = h(
    'div',
    { class: 'f' },
    h('div', { class: 'f-head' }, h('span', { class: 'label' }, 'Keywords / tags'), h('span', { class: 'counter' }, `${(item.keywords || []).length}`), fieldTools(item, 'keywords', () => (item.keywords || []).join(', '))),
    h('textarea', {
      rows: 2,
      'aria-label': 'Keywords, comma separated',
      dataset: { field: 'keywords' },
      onchange: (e) => {
        item.keywords = normalizeKeywords(e.target.value);
        e.target.value = item.keywords.join(', ');
        renderChips();
        putItem(item).catch(reportStorageError);
      },
    }, (item.keywords || []).join(', ')),
    chips,
  );

  const primaryField = h(
    'div',
    { class: 'f' },
    h('div', { class: 'f-head' }, h('span', { class: 'label' }, 'Primary keyword')),
    h('input', {
      type: 'text',
      value: item.primaryKeyword || '',
      'aria-label': 'Primary keyword',
      dataset: { field: 'primaryKeyword' },
      oninput: (e) => {
        item.primaryKeyword = e.target.value.trim().toLowerCase();
        renderChips();
        scheduleSave(item);
      },
    }),
  );

  const boardField = h(
    'div',
    { class: 'f' },
    h('div', { class: 'f-head' }, h('span', { class: 'label' }, 'Board'), fieldTools(item, 'board', null)),
    h('input', {
      type: 'text',
      list: 'boardList',
      value: item.board || '',
      'aria-label': 'Board',
      dataset: { field: 'board' },
      oninput: (e) => {
        item.board = e.target.value;
        item.boardManual = true;
        scheduleSave(item);
      },
    }),
  );

  return h(
    'article',
    { class: `card panel is-${item.publishStatus === 'published' ? 'published' : item.status}`, dataset: { id: item.id } },
    head,
    h(
      'div',
      { class: 'card-body' },
      textField(item, { field: 'title', label: 'SEO title', max: state.settings.titleMax || LIMITS.title }),
      textField(item, { field: 'description', label: 'Description', max: state.settings.descriptionMax || LIMITS.description, multiline: true, rows: 4 }),
      h('div', { class: 'two' }, primaryField, boardField),
      keywordsField,
      textField(item, { field: 'altText', label: 'Alt text', max: LIMITS.altText, multiline: true, rows: 2 }),
      linkField,
      isSame && state.settings.defaultLink ? h('div', { class: 'small muted' }, 'Link: ', displayDomain(state.settings.defaultLink), ' (same for all)') : null,
      notes,
    ),
    publishRow,
  );
}

function buildPublishRow(item) {
  const ps = item.publishStatus || '';
  const label = { '': 'Not on Pinterest yet', queued: 'Waiting to publish', publishing: 'Publishing…', published: 'Published', failed: 'Publish failed' }[ps];
  const busy = ps === 'queued' || ps === 'publishing' || state.publishing;
  const publishOne = async () => {
    if (ps === 'published' && !(await confirmDialog('This pin is already on Pinterest. Publish it again?', 'Publish again'))) return;
    if (ps === 'published') item.publishStatus = '';
    publishMany([item.id]);
  };
  return h(
    'div',
    { class: 'publish-row' },
    h('span', { class: `badge badge-${ps || 'pending'}` }, label),
    ps === 'published' && item.pinUrl ? h('a', { href: item.pinUrl, target: '_blank', rel: 'noopener noreferrer' }, 'View pin ↗') : null,
    ps === 'publishing' ? h('button', { class: 'mini', onclick: () => focusPinterestWindow() }, 'Show Pinterest tab') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: `btn btn-sm ${ps === 'published' ? 'btn-ghost' : 'btn-primary'}`, disabled: busy, onclick: publishOne },
      ps === 'published' ? 'Publish again' : ps === 'failed' ? 'Retry publish' : 'Publish'),
    item.publishNote && ps === 'published' ? h('span', { class: 'small muted', style: 'flex-basis:100%' }, item.publishNote) : null,
    ps === 'failed' && item.publishError ? h('span', { class: 'publish-error' }, item.publishError) : null,
    ps === 'failed' && item.publishDebug ? h('button', { class: 'mini', onclick: () => copyText(item.publishDebug, 'Debug info copied — paste it to Claude') }, 'Copy debug info') : null,
    ps === 'published' && item.publishLog ? h('button', { class: 'mini', title: 'Steps and timings of this pin', onclick: () => copyText(item.publishLog, 'Steps copied') }, 'Copy steps') : null,
  );
}

function formatForCopy(item) {
  return [
    `Title: ${item.title}`,
    `Description: ${item.description}`,
    `Primary keyword: ${item.primaryKeyword}`,
    `Keywords: ${(item.keywords || []).join(', ')}`,
    `Alt text: ${item.altText}`,
    `Board: ${item.board}`,
    `Link: ${effectiveLink(item)}`,
  ].join('\n');
}

// ---------------------------------------------------------------- preview

function openPreview(id) {
  const item = getItem(id);
  if (!item) return;
  const link = effectiveLink(item);
  const src = thumbUrl(item);
  const shortDesc = (item.description || '').length > 120 ? item.description.slice(0, 117) + '…' : item.description;

  $('#previewBody').replaceChildren(
    h(
      'div',
      { class: 'pin-detail-wrap' },
      h('h3', {}, 'Pin page'),
      h(
        'div',
        { class: 'pin-detail' },
        h('img', { src, alt: item.altText || '' }),
        h(
          'div',
          { class: 'pin-info' },
          link ? h('a', { class: 'pin-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, displayDomain(link)) : h('span', { class: 'small muted' }, 'No destination link'),
          h('div', { class: 'pin-title' }, item.title || '(no title)'),
          h('div', { class: 'pin-desc' }, item.description || ''),
          h('div', { class: 'pin-board' }, item.board ? `Board: ${item.board}` : 'No board'),
          h('div', { class: 'chips' }, (item.keywords || []).slice(0, 10).map((k) => h('span', { class: 'chip' }, k))),
          h('div', { class: 'pin-alt' }, h('strong', {}, 'Alt text: '), item.altText || '—'),
        ),
      ),
    ),
    h(
      'div',
      { class: 'pin-grid-preview' },
      h('h3', {}, 'In the feed'),
      h('div', { class: 'pin-mini' }, h('img', { src, alt: '' }), h('div', { class: 't' }, item.title || ''), h('div', { class: 'd' }, link ? displayDomain(link) : '')),
      h('p', { class: 'small muted' }, 'Approximate look. Pinterest crops very tall images and shows about 40–50 title characters in the feed.'),
      shortDesc ? h('p', { class: 'small muted' }, 'First line of description: ', shortDesc) : null,
    ),
  );
  $('#previewDialog').showModal();
}

// ---------------------------------------------------------------- remove / batch tools

async function removeItem(id) {
  const item = getItem(id);
  if (!item) return;
  if (item.status === 'processing' || item.publishStatus === 'publishing' || item.publishStatus === 'queued') return toast('Wait until this image finishes.', 'info');
  await deleteItem(id).catch(reportStorageError);
  state.items.delete(id);
  state.order = state.order.filter((x) => x !== id);
  const url = state.thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  state.thumbUrls.delete(id);
  $(`.card[data-id="${CSS.escape(id)}"]`)?.remove();
  updateCounts();
  updateEmpty();
}

async function removeWhere(predicate, label) {
  const ids = state.order.filter((id) => predicate(getItem(id)));
  if (!ids.length) return toast('Nothing to remove.', 'info');
  if (!(await confirmDialog(`Remove ${ids.length} ${label}? This cannot be undone.`, 'Remove', true))) return;
  for (const id of ids) await removeItem(id);
  toast(`Removed ${ids.length}.`, 'success');
}

function exportAs(format) {
  const list = state.order.map(getItem).filter(Boolean);
  const pins = toPins(list, effectiveLink, state.settings);
  if (!pins.length) return toast('No finished pins to export yet.', 'error');
  const preset = $('#exportPreset').value;

  if (preset === 'pinterest' && !state.settings.mediaBaseUrl) {
    toast('Pinterest needs a public image URL in "Media URL". Set "Media base URL" in Settings, or fill that column before uploading.', 'info', 9000);
  }

  if (format === 'json') {
    downloadFile(toJSON(pins), exportFileName('json'), 'application/json');
  } else if (format === 'csv') {
    downloadFile(toCSV(toTable(pins, preset)), exportFileName('csv'), 'text/csv;charset=utf-8');
  } else {
    downloadFile(toXLSX(toTable(pins, preset)), exportFileName('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  toast(`Exported ${pins.length} pin${pins.length > 1 ? 's' : ''}.`, 'success');
}

// ---------------------------------------------------------------- events

function bindUi() {
  // Upload: click, keyboard, drag & drop, paste
  const dz = $('#dropzone');
  const input = $('#fileInput');
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      dz.classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, () => dz.classList.remove('drag')));
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  // Pinterest
  $('#publishBtn').addEventListener('click', () => publishMany(state.order.filter((id) => readyToPublish(getItem(id), true))));
  $('#pipelineBtn').addEventListener('click', () => generateAndPublishAll());
  $('#stopAllBtn').addEventListener('click', () => {
    state.abort?.abort();
    state.publishAbort?.abort();
  });
  $('#testPinterestBtn').addEventListener('click', runDiagnose);
  $('#diagClose').addEventListener('click', () => $('#diagDialog').close());
  $('#autoMode').addEventListener('change', async (e) => {
    state.settings = await saveSettings({ autoMode: e.target.checked });
    if (e.target.checked) {
      toast('Full auto ON: waiting and ready pins will be written and published automatically.', 'success', 5000);
      runAutoPipeline();
    }
  });
  $('#publishMode').addEventListener('change', async (e) => {
    state.settings = await saveSettings({ publishMode: e.target.value });
  });

  // Processing
  $('#processBtn').addEventListener('click', () =>
    processMany(state.order.filter((id) => ['pending', 'error'].includes(getItem(id)?.status))),
  );
  $('#retryFailedBtn').addEventListener('click', () => processMany(state.order.filter((id) => getItem(id)?.status === 'error')));

  // Link mode
  $$('input[name="linkMode"]').forEach((r) =>
    r.addEventListener('change', async () => {
      state.settings = await saveSettings({ linkMode: r.value });
      applySettingsToUi();
      renderAll();
    }),
  );
  $('#sameLink').addEventListener('change', async (e) => {
    const r = normalizeUrl(e.target.value);
    e.target.classList.toggle('invalid', !r.ok);
    $('#sameLinkError').textContent = r.ok ? '' : r.error;
    $('#sameLinkError').classList.toggle('hidden', r.ok);
    if (!r.ok) return;
    e.target.value = r.url;
    state.settings = await saveSettings({ defaultLink: r.url });
    renderAll();
  });
  $('#applyUrlList').addEventListener('click', async () => {
    const list = parseUrlList($('#urlList').value);
    if (!list.length) return toast('Paste one URL per line first.', 'info');
    const bad = list.map((u, i) => (u.ok ? null : i + 1)).filter(Boolean);
    if (bad.length) return toast(`Invalid URL on line ${bad.join(', ')}. Fix and try again.`, 'error', 6000);
    const ids = state.order;
    const n = Math.min(ids.length, list.length);
    for (let i = 0; i < n; i++) {
      const it = getItem(ids[i]);
      it.link = list[i].url;
      await putItem(it).catch(reportStorageError);
    }
    renderAll();
    toast(`Filled ${n} card${n === 1 ? '' : 's'}${list.length !== ids.length ? ` (${list.length} URLs, ${ids.length} images)` : ''}.`, 'success', 5000);
  });
  $('#copySameToAll').addEventListener('click', async () => {
    const first = state.order.map(getItem).find((it) => it?.link);
    if (!first) return toast('No card has a link yet.', 'info');
    let n = 0;
    for (const id of state.order) {
      const it = getItem(id);
      if (!it.link) {
        it.link = first.link;
        n++;
        await putItem(it).catch(reportStorageError);
      }
    }
    renderAll();
    toast(`Filled ${n} empty link${n === 1 ? '' : 's'}.`, 'success');
  });

  // Board for all
  $('#applyBoard').addEventListener('click', async () => {
    const board = $('#batchBoard').value.trim();
    for (const id of state.order) {
      const it = getItem(id);
      it.board = board || it.suggestedBoard || '';
      it.boardManual = Boolean(board);
      await putItem(it).catch(reportStorageError);
    }
    renderAll();
    toast(board ? `Board "${board}" applied to all.` : 'Boards reset to AI suggestions.', 'success');
  });

  // Filters & search
  $$('#filterTabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      $$('#filterTabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      renderAll();
    }),
  );
  $('#search').addEventListener('input', debounce((e) => {
    state.search = e.target.value.trim();
    renderAll();
  }, 200));

  // Export & cleanup
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.export)));
  $('#clearDoneBtn').addEventListener('click', () => removeWhere((it) => it?.status === 'done', 'finished pins'));
  $('#clearAllBtn').addEventListener('click', () => {
    if (state.running || state.publishing) return toast('Stop processing and publishing first.', 'info');
    removeWhere(() => true, 'images');
  });

  // Preview dialog
  $('#previewClose').addEventListener('click', () => $('#previewDialog').close());
  $('#previewDialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // click on backdrop
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.running || state.publishing) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

init().catch((err) => {
  console.error(err);
  toast('PinForge failed to start: ' + err.message, 'error', 10000);
});
