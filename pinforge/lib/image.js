// lib/image.js
// Prepares uploaded images:
//  - checks type and size
//  - makes a resized JPEG for the AI (smaller = faster + cheaper, same quality of analysis)
//  - makes a small thumbnail for the UI

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
export const MAX_FILE_BYTES = 30 * 1024 * 1024; // 30 MB per file
const AI_MAX_SIDE = 1280;
const THUMB_MAX_SIDE = 480;
const UPLOAD_MAX_SIDE = 2400;
const PINTEREST_MAX_BYTES = 20 * 1024 * 1024;
const PINTEREST_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function checkFile(file) {
  if (!file) return 'No file.';
  const typeOk = ACCEPTED_TYPES.includes(file.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name);
  if (!typeOk) {
    if (/\.(heic|heif)$/i.test(file.name)) return 'HEIC photos are not supported by Chrome. Export as JPG or PNG first.';
    if (/\.(svg|ai|eps|psd)$/i.test(file.name)) return 'Vector/PSD files are not supported. Export a JPG or PNG preview first.';
    return 'Unsupported file type. Use JPG, PNG, WEBP, GIF, BMP or AVIF.';
  }
  if (file.size > MAX_FILE_BYTES) return 'File is larger than 30 MB.';
  if (file.size === 0) return 'File is empty.';
  return null;
}

async function resizeToJpeg(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNG areas become white instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * Returns { aiBlob, thumbBlob, uploadBlob, width, height }.
 * uploadBlob = what gets uploaded to Pinterest: the original file when Pinterest accepts it,
 * otherwise a high-quality JPEG copy.
 * Throws an Error with a readable message if the image can't be decoded.
 */
export async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not read this image (file may be damaged or in an unsupported format).');
  }
  try {
    const [aiBlob, thumbBlob] = await Promise.all([
      resizeToJpeg(bitmap, AI_MAX_SIDE, 0.86),
      resizeToJpeg(bitmap, THUMB_MAX_SIDE, 0.8),
    ]);
    const keepOriginal = PINTEREST_TYPES.includes(file.type) && file.size <= PINTEREST_MAX_BYTES;
    const uploadBlob = keepOriginal ? file : await resizeToJpeg(bitmap, UPLOAD_MAX_SIDE, 0.92);
    return { aiBlob, thumbBlob, uploadBlob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Blob -> base64 string (without the "data:...;base64," prefix). */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Pinterest prefers 2:3 vertical pins. Returns a short note about the ratio. */
export function aspectNote(width, height) {
  if (!width || !height) return '';
  const r = width / height;
  if (r > 0.6 && r < 0.72) return '2:3 — ideal';
  if (r <= 0.6) return 'very tall — may be cropped';
  if (r < 0.9) return 'vertical — good';
  if (r <= 1.1) return 'square — OK';
  return 'horizontal — vertical (2:3) performs better';
}
