// lib/gemini.js
// Everything that talks to the Google Gemini API lives in this one file.
// - buildPrompt():   turns settings + image info into instructions for the AI
// - generatePinData(): sends ONE image to Gemini and returns parsed JSON
// - withRetry():     retries on rate limits / temporary server errors
// - listModels(), testApiKey(): used by the Settings page
//
// No Chrome APIs are used here, so the pure parts are unit-tested in Node.

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** A typed error so the UI can show a helpful message. */
export class GeminiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * JSON schema Gemini must follow. Using "structured output" means we get
 * clean JSON back instead of text we would have to guess-parse.
 */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    imageSummary: { type: 'STRING', description: 'One factual sentence about what is in the image.' },
    primaryKeyword: { type: 'STRING', description: 'The single main search phrase people would type on Pinterest.' },
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
    altText: { type: 'STRING' },
    suggestedBoard: { type: 'STRING' },
  },
  required: ['imageSummary', 'primaryKeyword', 'title', 'description', 'keywords', 'altText', 'suggestedBoard'],
  propertyOrdering: ['imageSummary', 'primaryKeyword', 'title', 'description', 'keywords', 'altText', 'suggestedBoard'],
};

const FIELD_LABELS = {
  title: 'title',
  description: 'description',
  keywords: 'keywords',
  altText: 'alt text',
  suggestedBoard: 'suggested board',
};

/**
 * Build the text instructions sent together with the image.
 * @param {object} s       settings
 * @param {object} item    { fileName, notes, link, current? }
 * @param {object} [opts]  { onlyField: 'title' | 'description' | ... }
 */
export function buildPrompt(s, item = {}, opts = {}) {
  const titleMax = s.titleMax || 100;
  const descMax = s.descriptionMax || 500;
  const kwCount = s.keywordCount || 12;
  const boards = (s.boards || []).filter(Boolean);
  const lines = [];

  lines.push(
    'You are a Pinterest SEO specialist. Look carefully at the attached image and write metadata for a Pinterest Pin.',
    'Base everything on what is actually visible. Do not invent brands, prices, places or claims you cannot see.',
    '',
    'RULES',
    `- primaryKeyword: the single most valuable search phrase (2-5 words) a Pinterest user would type to find this image.`,
    `- title: max ${titleMax} characters. Put the primary keyword near the start. Clear and specific, no clickbait, no hashtags, no emojis, no ALL CAPS.`,
    `- description: max ${descMax} characters, 2-4 natural sentences. Use the primary keyword once and 2-3 related keywords naturally. Say what the image shows and why it is useful or inspiring. End with a short call to action.` +
      (s.includeHashtags ? ' Add 2-4 relevant hashtags at the very end.' : ' Do not use hashtags.') +
      ' Never paste a URL into the description.',
    `- keywords: exactly ${kwCount} lowercase search phrases, most important first, mixing broad and long-tail terms. No "#", no duplicates.`,
    '- altText: an objective description of the image for screen-reader users (max 500 characters). Describe subject, colours, composition and any visible text. Do not start with "Image of" or "Picture of". No marketing language.',
    boards.length
      ? `- suggestedBoard: choose the best match from this exact list: ${boards.map((b) => JSON.stringify(b)).join(', ')}.`
      : '- suggestedBoard: suggest a short, searchable board name (2-4 words) where this pin belongs.',
    `- Write everything in ${s.language || 'English'}. Tone: ${s.tone || 'friendly and helpful'}.`,
  );

  const context = [];
  if (s.nicheContext) context.push(`Account / niche context: ${s.nicheContext}`);
  if (item.fileName) context.push(`Original file name (may contain hints, may be meaningless): ${item.fileName}`);
  if (item.notes) context.push(`Notes from the creator about this image: ${item.notes}`);
  if (item.link) context.push(`The pin will link to: ${item.link} (use only as context about the topic).`);
  if (context.length) lines.push('', 'CONTEXT', ...context.map((c) => '- ' + c));

  if (opts.onlyField && item.current) {
    const label = FIELD_LABELS[opts.onlyField] || opts.onlyField;
    const currentValue = Array.isArray(item.current[opts.onlyField])
      ? item.current[opts.onlyField].join(', ')
      : item.current[opts.onlyField];
    lines.push(
      '',
      'TASK',
      `The user wants a NEW alternative ${label}. It must be clearly different from the current one:`,
      JSON.stringify(currentValue || ''),
      'Still return every field in the JSON, but put your effort into the new ' + label + '.',
    );
  }

  lines.push('', 'Return only JSON that matches the response schema.');
  return lines.join('\n');
}

/** Build the request body for generateContent. */
export function buildRequestBody({ prompt, base64, mimeType, temperature = 0.7 }) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: prompt }],
      },
    ],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

/** Parse "13s" / "1.5s" from Google's RetryInfo into milliseconds. */
function parseRetryDelay(errorJson) {
  const details = errorJson?.error?.details || [];
  for (const d of details) {
    if (typeof d?.retryDelay === 'string') {
      const sec = parseFloat(d.retryDelay);
      if (!Number.isNaN(sec)) return Math.ceil(sec * 1000);
    }
  }
  return 0;
}

/** Convert an HTTP error from Gemini into a GeminiError with a friendly message. */
export function errorFromResponse(status, body) {
  const apiMsg = body?.error?.message || '';
  const reason = (body?.error?.details || []).map((d) => d?.reason).find(Boolean) || body?.error?.status || '';
  const retryAfterMs = parseRetryDelay(body);

  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason + apiMsg)) {
    return new GeminiError('Your Gemini API key is not valid. Check it in Settings.', { status, code: 'INVALID_KEY' });
  }
  if (status === 400 && /location is not supported|FAILED_PRECONDITION/i.test(reason + apiMsg)) {
    return new GeminiError('Gemini API is not available for this account or region: ' + apiMsg, { status, code: 'UNAVAILABLE_REGION' });
  }
  if (status === 401 || status === 403) {
    return new GeminiError('Permission denied by Gemini. Check that the API key is correct and the Generative Language API is enabled.', { status, code: 'PERMISSION' });
  }
  if (status === 404) {
    return new GeminiError('Model not found. Pick another model in Settings (use "Load models").', { status, code: 'MODEL_NOT_FOUND' });
  }
  if (status === 413) {
    return new GeminiError('The image is too large for the API.', { status, code: 'TOO_LARGE' });
  }
  if (status === 429) {
    return new GeminiError('Rate limit or quota reached. Waiting and retrying…', { status, code: 'RATE_LIMIT', retryable: true, retryAfterMs });
  }
  if (status >= 500) {
    return new GeminiError('Gemini server is busy (' + status + '). Retrying…', { status, code: 'SERVER', retryable: true, retryAfterMs });
  }
  return new GeminiError(apiMsg || `Request failed (HTTP ${status}).`, { status, code: 'HTTP_' + status });
}

/** Pull the JSON object out of a successful generateContent response. */
export function parseGenerateResponse(json) {
  if (json?.promptFeedback?.blockReason) {
    throw new GeminiError('Gemini blocked this image (' + json.promptFeedback.blockReason + ').', { code: 'BLOCKED' });
  }
  const cand = json?.candidates?.[0];
  if (!cand) throw new GeminiError('Gemini returned no result.', { code: 'EMPTY', retryable: true });
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT' || cand.finishReason === 'IMAGE_SAFETY') {
    throw new GeminiError('Gemini declined this image for safety reasons.', { code: 'BLOCKED' });
  }
  const text = (cand.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  if (!text) throw new GeminiError('Gemini returned an empty answer.', { code: 'EMPTY', retryable: true });

  // Structured output should be pure JSON, but strip ``` fences just in case.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    throw new GeminiError('Could not read the AI answer (invalid JSON).', { code: 'BAD_JSON', retryable: true });
  }
}

/**
 * Send one image to Gemini.
 * If `proxyUrl` is set, the request goes to your own backend instead
 * (the backend adds the API key, so it never lives in the browser).
 */
export async function generatePinData({ apiKey, model, proxyUrl, proxyToken, prompt, base64, mimeType, signal, fetchImpl = fetch }) {
  const body = buildRequestBody({ prompt, base64, mimeType });
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let payload;

  if (proxyUrl) {
    url = proxyUrl;
    if (proxyToken) headers['X-PinForge-Token'] = proxyToken;
    payload = JSON.stringify({ model, body });
  } else {
    if (!apiKey) throw new GeminiError('Add your Gemini API key in Settings first.', { code: 'NO_KEY' });
    url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key'] = apiKey; // header, not URL, so the key never ends up in logs/history
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: payload, signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new GeminiError('Network error — check your internet connection.', { code: 'NETWORK', retryable: true });
  }

  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON body */ }

  if (!res.ok) throw errorFromResponse(res.status, json);
  return parseGenerateResponse(json);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

/**
 * Run fn() and retry when the error is retryable (429, 5xx, network, bad JSON).
 * Wait time doubles each try: ~2s, 4s, 8s (+ random jitter), or what Google asks for.
 */
export async function withRetry(fn, { retries = 3, baseDelayMs = 2000, signal, onRetry, sleepImpl = sleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      const retryable = err instanceof GeminiError ? err.retryable : false;
      if (!retryable || attempt >= retries) throw err;
      const backoff = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500);
      const wait = Math.min(Math.max(backoff, err.retryAfterMs || 0), 65000);
      attempt += 1;
      onRetry?.({ attempt, wait, error: err });
      await sleepImpl(wait, signal);
    }
  }
}

/** List models that support generateContent (for the Settings dropdown). */
export async function listModels(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw errorFromResponse(res.status, json);
  return (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => /gemini/i.test(m.id) && !/embedding|tts|audio|live|image-generation/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Quick check used by the "Test key" button. */
export async function testApiKey(apiKey, fetchImpl = fetch) {
  const models = await listModels(apiKey, fetchImpl);
  return { ok: true, modelCount: models.length, models };
}
