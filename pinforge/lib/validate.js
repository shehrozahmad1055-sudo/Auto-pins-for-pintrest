// lib/validate.js
// Pure helper functions (no Chrome APIs) so they can be unit-tested in Node.
// Everything that comes back from the AI or from the user passes through here
// before it is saved or exported.

/** Pinterest field limits (characters). */
export const LIMITS = Object.freeze({
  title: 100,
  description: 500,
  altText: 500,
  maxKeywords: 30,
});

/** Collapse whitespace and trim. Always returns a string. */
export function cleanText(value) {
  return String(value ?? '')
    // remove control characters except normal newlines
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cut text to `max` characters without breaking a word in half.
 * No "..." is added, because Pinterest shows text as-is.
 */
export function clampText(value, max) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s,;:\-–—]+$/, '').trim();
}

/**
 * Turn an array or a comma/newline separated string into a clean,
 * de-duplicated list of lowercase keywords (no "#").
 */
export function normalizeKeywords(input, max = LIMITS.maxKeywords) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,\n]/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const kw = cleanText(raw).replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();
    if (!kw || kw.length > 60 || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Validate and normalise a destination URL.
 * Empty input is allowed (means "no link").
 * Returns { ok: true, url } or { ok: false, error }.
 */
export function normalizeUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) return { ok: true, url: '' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = 'https://' + value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only http:// and https:// links are allowed.' };
  }
  if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.')) {
    return { ok: false, error: 'The link needs a real domain, e.g. example.com.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Links with a username or password are not allowed.' };
  }
  return { ok: true, url: parsed.href };
}

/** Domain shown in the pin preview, e.g. "shop.example.com". */
export function displayDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Split a pasted block of URLs (one per line) into a list of results. */
export function parseUrlList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ input: line, ...normalizeUrl(line) }));
}

/**
 * Make sure an AI result has every field, with the right type and length.
 * Anything missing becomes an empty value instead of crashing the UI.
 */
export function sanitizeResult(raw, opts = {}) {
  const limits = {
    title: Math.min(opts.titleMax || LIMITS.title, LIMITS.title),
    description: Math.min(opts.descriptionMax || LIMITS.description, LIMITS.description),
    keywords: Math.min(opts.keywordCount || 12, LIMITS.maxKeywords),
  };
  const r = raw && typeof raw === 'object' ? raw : {};
  const keywords = normalizeKeywords(r.keywords, limits.keywords);
  let primary = cleanText(r.primaryKeyword).toLowerCase().replace(/^#+/, '');
  if (!primary && keywords.length) primary = keywords[0];
  return {
    title: clampText(r.title, limits.title),
    description: clampText(r.description, limits.description),
    keywords,
    altText: clampText(r.altText, LIMITS.altText),
    primaryKeyword: clampText(primary, 60),
    suggestedBoard: clampText(r.suggestedBoard, 50),
    imageSummary: clampText(r.imageSummary, 300),
  };
}

/** File name -> readable hint for the AI ("blue-floral-pattern_02.jpg" -> "blue floral pattern 02"). */
export function fileNameHint(name) {
  return cleanText(String(name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-.]+/g, ' '));
}

/** Join a base URL and a file name, e.g. for "Media URL" in the Pinterest CSV. */
export function joinMediaUrl(base, fileName) {
  const b = String(base ?? '').trim();
  if (!b) return '';
  return b.replace(/\/+$/, '') + '/' + encodeURIComponent(fileName);
}
