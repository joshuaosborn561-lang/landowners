/**
 * Free/open document text. PDF literal strings first; embedded JPEGs go through
 * tesseract.js when installed (never a paid OCR API). Tests inject ctx.ocr.
 */
import type { LookupContext } from './context.js';

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function unescapePdfLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{1,3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
}

/** Best-effort uncompressed PDF text (Tj / literal strings). */
export function extractPdfText(bytes: Uint8Array): string {
  const ascii = latin1(bytes);
  if (!ascii.startsWith('%PDF')) return '';
  const chunks: string[] = [];
  for (const m of ascii.matchAll(/\((?:\\.|[^\\)]){2,200}\)/g)) {
    const inner = unescapePdfLiteral(m[0].slice(1, -1));
    if (/[A-Za-z]{3,}/.test(inner)) chunks.push(inner);
  }
  return chunks.join('\n').replace(/[ \t]+/g, ' ').trim();
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

export function isPdf(bytes: Uint8Array): boolean {
  return latin1(bytes.slice(0, 5)) === '%PDF-';
}

/** Pull DCTDecode (JPEG) streams out of a PDF for OCR. */
export function extractPdfJpegs(bytes: Uint8Array): Uint8Array[] {
  const ascii = latin1(bytes);
  const out: Uint8Array[] = [];
  const re = /\/Filter\s*\/DCTDecode[\s\S]{0,400}stream\r?\n([\s\S]*?)endstream/gi;
  for (const m of ascii.matchAll(re)) {
    const payload = m[1] || '';
    const buf = Buffer.from(payload, 'latin1');
    if (isJpeg(buf)) out.push(buf);
  }
  return out;
}

export function looksLikeImageContentType(contentType: string | null | undefined): boolean {
  const t = String(contentType || '').toLowerCase();
  return t.includes('image/jpeg') || t.includes('image/png') || t.includes('image/tiff') || t.includes('image/gif');
}

export async function ocrImageBytes(bytes: Uint8Array, ctx?: LookupContext): Promise<string> {
  if (ctx?.ocr) return ctx.ocr(bytes);
  try {
    // Optional free OCR. Not a package.json dependency so unit tests stay offline.
    const spec = 'tesseract.js';
    const tesseract = (await import(spec)) as {
      recognize: (image: Buffer, lang: string) => Promise<{ data: { text: string } }>;
    };
    const result = await tesseract.recognize(Buffer.from(bytes), 'eng');
    return String(result?.data?.text || '').trim();
  } catch {
    return '';
  }
}

export async function textFromDocument(
  bytes: Uint8Array,
  contentType: string | null | undefined,
  ctx?: LookupContext,
): Promise<{ text: string; ocr_used: boolean }> {
  if (isPdf(bytes) || String(contentType || '').includes('pdf')) {
    const text = extractPdfText(bytes);
    if (text.replace(/\s+/g, ' ').length >= 40) return { text, ocr_used: false };
    const jpegs = extractPdfJpegs(bytes);
    if (!jpegs.length) return { text, ocr_used: false };
    const parts: string[] = [];
    for (const img of jpegs.slice(0, 4)) {
      const ocr = await ocrImageBytes(img, ctx);
      if (ocr) parts.push(ocr);
    }
    return { text: parts.join('\n') || text, ocr_used: parts.length > 0 };
  }
  if (isJpeg(bytes) || isPng(bytes) || looksLikeImageContentType(contentType)) {
    const ocr = await ocrImageBytes(bytes, ctx);
    return { text: ocr, ocr_used: Boolean(ocr) };
  }
  const asText = Buffer.from(bytes).toString('utf8');
  if (/^[\x09\x0a\x0d\x20-\x7e]{20,}$/.test(asText.slice(0, 200)) || /<[a-z][\s\S]*?>/i.test(asText)) {
    return { text: asText, ocr_used: false };
  }
  return { text: '', ocr_used: false };
}
