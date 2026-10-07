// Unit tests for the pure modules. Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';

import {
  clampText, normalizeKeywords, normalizeUrl, parseUrlList, sanitizeResult, fileNameHint, joinMediaUrl, displayDomain,
} from '../lib/validate.js';
import {
  buildPrompt, buildRequestBody, parseGenerateResponse, errorFromResponse, generatePinData, withRetry, GeminiError, listModels,
} from '../lib/gemini.js';
import { toPins, toTable, toCSV, toJSON, toXLSX, crc32 } from '../lib/export.js';
import { runQueue } from '../lib/queue.js';

// ---------- validate ----------
test('clampText keeps words whole and respects max', () => {
  const t = clampText('Boho living room ideas with cozy neutral textures and warm light', 30);
  assert.ok(t.length <= 30);
  assert.ok(!t.endsWith(' '));
  assert.equal(t, 'Boho living room ideas with');
});

test('normalizeKeywords dedupes, lowercases, strips #', () => {
  assert.deepEqual(normalizeKeywords(['#Boho Decor', 'boho decor', ' Living Room ', '']), ['boho decor', 'living room']);
  assert.deepEqual(normalizeKeywords('a, b,\n c', 2), ['a', 'b']);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com/shop').url, 'https://example.com/shop');
  assert.equal(normalizeUrl('').ok, true);
  assert.equal(normalizeUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeUrl('ftp://x.com').ok, false);
  assert.equal(normalizeUrl('localhost').ok, false);
  assert.equal(normalizeUrl('https://user:pw@site.com').ok, false);
  assert.equal(displayDomain('https://www.shop.com/a'), 'shop.com');
});

test('parseUrlList', () => {
  const r = parseUrlList('site.com/a\n\n  bad url \nhttps://b.com');
  assert.equal(r.length, 3);
  assert.equal(r[0].url, 'https://site.com/a');
  assert.equal(r[1].ok, false);
});

test('sanitizeResult fills missing fields and enforces limits', () => {
  const r = sanitizeResult({ title: 'x'.repeat(300), keywords: ['A', 'a', 'b'] }, { keywordCount: 5 });
  assert.equal(r.title.length, 100);
  assert.deepEqual(r.keywords, ['a', 'b']);
  assert.equal(r.primaryKeyword, 'a');
  assert.equal(r.description, '');
  assert.equal(sanitizeResult(null).title, '');
});

test('fileNameHint + joinMediaUrl', () => {
  assert.equal(fileNameHint('blue-floral_pattern.02.jpg'), 'blue floral pattern 02');
  assert.equal(joinMediaUrl('https://cdn.x.com/pins/', 'a b.jpg'), 'https://cdn.x.com/pins/a%20b.jpg');
  assert.equal(joinMediaUrl('', 'a.jpg'), '');
});

// ---------- gemini ----------
const settings = { titleMax: 100, descriptionMax: 500, keywordCount: 10, boards: ['Home Decor', 'Patterns'], language: 'English', tone: 'warm' };

test('buildPrompt includes limits, boards and context', () => {
  const p = buildPrompt(settings, { fileName: 'x.jpg', notes: 'for my etsy shop', link: 'https://a.com' });
  assert.match(p, /max 100 characters/);
  assert.match(p, /exactly 10 lowercase/);
  assert.match(p, /"Home Decor", "Patterns"/);
  assert.match(p, /for my etsy shop/);
  assert.match(p, /Do not use hashtags/);
});

test('buildPrompt regenerate-one-field mode', () => {
  const p = buildPrompt(settings, { current: { title: 'Old title' } }, { onlyField: 'title' });
  assert.match(p, /NEW alternative title/);
  assert.match(p, /"Old title"/);
});

test('buildRequestBody shape', () => {
  const b = buildRequestBody({ prompt: 'hi', base64: 'AAA', mimeType: 'image/jpeg' });
  assert.equal(b.contents[0].parts[0].inline_data.mime_type, 'image/jpeg');
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.ok(b.generationConfig.responseSchema.required.includes('altText'));
});

test('parseGenerateResponse handles json, fences, blocks', () => {
  const ok = { candidates: [{ content: { parts: [{ text: '```json\n{"title":"T"}\n```' }] }, finishReason: 'STOP' }] };
  assert.deepEqual(parseGenerateResponse(ok), { title: 'T' });
  assert.throws(() => parseGenerateResponse({ promptFeedback: { blockReason: 'SAFETY' } }), (e) => e.code === 'BLOCKED');
  assert.throws(() => parseGenerateResponse({ candidates: [{ finishReason: 'SAFETY' }] }), (e) => e.code === 'BLOCKED');
  assert.throws(() => parseGenerateResponse({ candidates: [{ content: { parts: [{ text: 'nope' }] } }] }), (e) => e.code === 'BAD_JSON' && e.retryable);
});

test('errorFromResponse maps common errors', () => {
  assert.equal(errorFromResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code, 'INVALID_KEY');
  const rl = errorFromResponse(429, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13s' }] } });
  assert.equal(rl.retryable, true);
  assert.equal(rl.retryAfterMs, 13000);
  assert.equal(errorFromResponse(503, null).retryable, true);
  assert.equal(errorFromResponse(404, null).code, 'MODEL_NOT_FOUND');
});

test('generatePinData sends key in header, not URL', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"title":"Hi"}' }] } }] }) };
  };
  const r = await generatePinData({ apiKey: 'SECRET', model: 'gemini-2.5-flash', prompt: 'p', base64: 'b', mimeType: 'image/jpeg', fetchImpl: fakeFetch });
  assert.equal(r.title, 'Hi');
  assert.ok(!seen.url.includes('SECRET'));
  assert.equal(seen.init.headers['x-goog-api-key'], 'SECRET');
  assert.match(seen.url, /models\/gemini-2\.5-flash:generateContent$/);
});

test('generatePinData via proxy does not send the API key', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  };
  await generatePinData({ apiKey: 'SECRET', proxyUrl: 'https://me.com/proxy.php', proxyToken: 'tok', model: 'm', prompt: 'p', base64: 'b', mimeType: 'image/jpeg', fetchImpl: fakeFetch });
  assert.equal(seen.url, 'https://me.com/proxy.php');
  assert.ok(!JSON.stringify(seen.init).includes('SECRET'));
  assert.equal(seen.init.headers['X-PinForge-Token'], 'tok');
});

test('generatePinData without key fails clearly', async () => {
  await assert.rejects(generatePinData({ model: 'm', prompt: 'p', base64: 'b', mimeType: 'image/jpeg' }), (e) => e.code === 'NO_KEY');
});

test('withRetry retries retryable errors then succeeds', async () => {
  let calls = 0;
  const waits = [];
  const r = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new GeminiError('busy', { retryable: true });
      return 'ok';
    },
    { sleepImpl: async (ms) => waits.push(ms) },
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
});

test('withRetry does not retry fatal errors', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new GeminiError('bad key', { code: 'INVALID_KEY' }); }, { sleepImpl: async () => {} }));
  assert.equal(calls, 1);
});

test('listModels filters to gemini text models', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      ],
    }),
  });
  const m = await listModels('k', fakeFetch);
  assert.deepEqual(m.map((x) => x.id), ['gemini-2.5-flash']);
});

// ---------- export ----------
const items = [
  { status: 'done', fileName: 'a.jpg', title: '=SUM(A1)', description: 'Line, with "quotes"\nand newline', keywords: ['k1', 'k2'], altText: 'alt', board: 'B', link: 'https://own.com' },
  { status: 'error', fileName: 'b.jpg' },
  { status: 'done', fileName: 'ç ü.png', title: 'Üñíçødé <&>', description: 'd', keywords: [], altText: '', board: '', link: '' },
];
const getLink = (it) => it.link;

test('toPins only exports finished items, applies media base URL', () => {
  const pins = toPins(items, getLink, { mediaBaseUrl: 'https://cdn.com/p' });
  assert.equal(pins.length, 2);
  assert.equal(pins[0].mediaUrl, 'https://cdn.com/p/a.jpg');
});

test('CSV escaping, BOM and formula guard', () => {
  const csv = toCSV(toTable(toPins(items, getLink), 'full'));
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes("'=SUM(A1)"));
  assert.ok(csv.includes('"Line, with ""quotes""\nand newline"'));
});

test('Pinterest preset columns', () => {
  const t = toTable(toPins(items, getLink), 'pinterest');
  assert.deepEqual(t.headers, ['Title', 'Media URL', 'Pinterest board', 'Thumbnail', 'Description', 'Link', 'Publish date', 'Keywords']);
  assert.equal(t.rows[0][7], 'k1, k2');
});

test('JSON export', () => {
  const j = JSON.parse(toJSON(toPins(items, getLink)));
  assert.equal(j.count, 2);
});

test('crc32 known value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('XLSX writes a file (validated by openpyxl in tests/check_xlsx.py)', () => {
  const bytes = toXLSX(toTable(toPins(items, getLink), 'full'));
  assert.equal(bytes[0], 0x50); // "PK"
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/test.xlsx', import.meta.url), bytes);
});

// ---------- queue ----------
test('runQueue respects concurrency and counts failures', async () => {
  let running = 0;
  let maxRunning = 0;
  const r = await runQueue([1, 2, 3, 4, 5], async (n) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((res) => setTimeout(res, 10));
    running--;
    if (n === 3) throw new Error('x');
  }, { concurrency: 2 });
  assert.equal(maxRunning, 2);
  assert.equal(r.done, 5);
  assert.equal(r.failed, 1);
});

test('runQueue stops on abort', async () => {
  const ac = new AbortController();
  let ran = 0;
  const r = await runQueue([1, 2, 3, 4], async () => { ran++; ac.abort(); }, { concurrency: 1, signal: ac.signal });
  assert.equal(ran, 1);
  assert.equal(r.aborted, true);
});

test('runQueue spaces starts by requestsPerMinute', async () => {
  const starts = [];
  await runQueue([1, 2, 3], async () => { starts.push(Date.now()); }, { concurrency: 3, requestsPerMinute: 600 }); // 100ms gap
  assert.ok(starts[2] - starts[0] >= 190);
});

// ---------- pinterest helpers ----------
import { safeCreateUrl, parseSelectorOverrides, randomDelayMs, todayKey, DEFAULT_CREATE_URL } from '../lib/pinterest.js';

test('safeCreateUrl only allows https pinterest.com', () => {
  assert.equal(safeCreateUrl('https://www.pinterest.com/pin-builder/'), 'https://www.pinterest.com/pin-builder/');
  assert.equal(safeCreateUrl('https://evil.com/pinterest.com'), DEFAULT_CREATE_URL);
  assert.equal(safeCreateUrl('http://www.pinterest.com/x'), DEFAULT_CREATE_URL);
  assert.equal(safeCreateUrl('https://pinterest.com.evil.io/'), DEFAULT_CREATE_URL);
  assert.equal(safeCreateUrl(''), DEFAULT_CREATE_URL);
});

test('parseSelectorOverrides', () => {
  assert.deepEqual(parseSelectorOverrides('{"title":"#t","link":["#a",""," #b"],"x":5}'), { title: ['#t'], link: ['#a', ' #b'] });
  assert.deepEqual(parseSelectorOverrides('not json'), {});
  assert.deepEqual(parseSelectorOverrides(''), {});
});

test('randomDelayMs stays in range with a 5s floor', () => {
  for (let i = 0; i < 50; i++) {
    const d = randomDelayMs(45, 90);
    assert.ok(d >= 45000 && d <= 90000);
  }
  assert.ok(randomDelayMs(0, 0) >= 5000);
  assert.ok(randomDelayMs(60, 10) >= 60000); // max < min handled
});

test('todayKey', () => {
  assert.equal(todayKey(new Date(2026, 9, 7)), '2026-10-07');
});
