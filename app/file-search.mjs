export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 1_000_000;
export const MAX_USER_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_USER_FILES = 30;

export function normalizeSearchText(value) {
  return value.normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLocaleLowerCase('ar-EG')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function splitSearchTerms(value) {
  return [...new Set(normalizeSearchText(value).split(/\s+/).filter((term) => term.length > 1))].slice(0, 10);
}

export function splitTextIntoChunks(value, maxLength = 1400, overlap = 180) {
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maxLength, value.length);
    if (end < value.length) {
      const boundary = value.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(maxLength * 0.65)) end = boundary;
    }
    const chunk = value.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === value.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function createSearchExcerpt(text, terms, maxLength = 360) {
  let originalIndex = -1;
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (terms.some((term) => normalizeSearchText(word[0]).includes(term))) {
      originalIndex = word.index;
      break;
    }
  }
  if (originalIndex < 0) return text.slice(0, maxLength).trim();
  const start = Math.max(0, originalIndex - Math.floor(maxLength * 0.2));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
