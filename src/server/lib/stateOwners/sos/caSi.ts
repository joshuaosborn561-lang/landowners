import { DESKTOP_UA, looksBlocked } from '../http.js';
import type { LookupContext } from './context.js';
import { ctxFetch } from './context.js';
import { apifyFetchHtml } from './apifyPlaywright.js';
import { textFromDocument } from './ocr.js';
import { parseOfficerRoster, type RosterEntry } from './officers.js';
import { CA_BIZFILE_ONLINE_SEARCH, CA_BIZFILE_ONLINE_UI, type CaBizfileEntity } from './caBizfile.js';

export { CA_BIZFILE_ONLINE_SEARCH, CA_BIZFILE_ONLINE_UI };

export function caSiImageUrls(entityId: string): string[] {
  const id = encodeURIComponent(entityId.trim());
  return [
    `https://bizfileonline.sos.ca.gov/api/FilingImages/GetImageByNum?fileNumber=${id}`,
    `https://bizfileonline.sos.ca.gov/api/Records/GetImageByNum?fileNumber=${id}`,
    `https://bizfileonline.sos.ca.gov/api/Records/GetImageByNum?num=${id}`,
  ];
}

function officersFromUnknown(payload: unknown): RosterEntry[] {
  if (!payload) return [];
  if (typeof payload === 'string') return parseOfficerRoster(payload);
  const blob = JSON.stringify(payload);
  const fromText = parseOfficerRoster(blob);
  if (fromText.length) return fromText;
  const rows: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const name = rec.Name || rec.name || rec.OfficerName || rec.officerName || rec.fullName || rec.FullName;
    const title = rec.Title || rec.title || rec.OfficerTitle || rec.Position || rec.position;
    if (typeof name === 'string' && name.trim()) {
      rows.push(`${title || 'Officer'}: ${name}`);
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(payload);
  return rows.length ? parseOfficerRoster(rows.join('\n')) : [];
}

async function fetchBytes(
  url: string,
  ctx: LookupContext | undefined,
  init?: RequestInit,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; blocked: boolean; url: string }> {
  const res = await ctxFetch(ctx)(url, {
    redirect: 'follow',
    ...init,
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json,application/pdf,image/*,text/html;q=0.8,*/*;q=0.5',
      ...(init?.headers || {}),
    },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  const preview = Buffer.from(bytes.slice(0, 400)).toString('utf8');
  const blocked = looksBlocked(res.status, preview) || res.status === 403 || res.status === 401;
  return { status: res.status, bytes, contentType, blocked, url: res.url || url };
}

export interface CaSiFetchResult {
  entries: RosterEntry[];
  text: string;
  source_url: string;
  via_apify: boolean;
  ocr_used: boolean;
  usd: number;
}

async function parseDocumentBytes(
  bytes: Uint8Array,
  contentType: string,
  sourceUrl: string,
  ctx: LookupContext | undefined,
): Promise<CaSiFetchResult | null> {
  const preview = Buffer.from(bytes.slice(0, 800)).toString('utf8');
  if (preview.trim().startsWith('{') || preview.trim().startsWith('[')) {
    try {
      const payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const entries = officersFromUnknown(payload);
      if (entries.length) {
        return { entries, text: '', source_url: sourceUrl, via_apify: false, ocr_used: false, usd: 0 };
      }
    } catch {
      /* not json */
    }
  }
  const doc = await textFromDocument(bytes, contentType, ctx);
  const entries = parseOfficerRoster(doc.text);
  if (entries.length) {
    return { entries, text: doc.text, source_url: sourceUrl, via_apify: false, ocr_used: doc.ocr_used, usd: 0 };
  }
  return null;
}

/**
 * Statement of Information officers. Direct image/JSON first, Apify Playwright
 * only if the official host blocks, OCR only for image SI (tesseract.js).
 */
export async function fetchCaStatementOfficers(
  entity: CaBizfileEntity,
  ctx?: LookupContext,
): Promise<CaSiFetchResult> {
  const entityId = String(entity.EntityID || '').trim();
  const empty: CaSiFetchResult = {
    entries: [],
    text: '',
    source_url: CA_BIZFILE_ONLINE_UI,
    via_apify: false,
    ocr_used: false,
    usd: 0,
  };
  if (ctx?.caSiText != null) {
    return {
      ...empty,
      entries: parseOfficerRoster(ctx.caSiText),
      text: ctx.caSiText,
      source_url: `https://bizfileonline.sos.ca.gov/search/business/${entityId}`,
    };
  }
  if (ctx?.caSiBytes) {
    const parsed = await parseDocumentBytes(ctx.caSiBytes, 'application/octet-stream', empty.source_url, ctx);
    return parsed || empty;
  }
  if (!entityId || !ctx?.live) return empty;

  try {
    const searchRes = await fetchBytes(CA_BIZFILE_ONLINE_SEARCH, ctx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        SEARCH_VALUE: entityId,
        SEARCH_FILTER_TYPE_ID: 'fileNumber',
        STATUS_ID: '',
        FILING_TYPE_ID: '',
        RECORD_TYPE_ID: '',
      }),
    });
    if (!searchRes.blocked) {
      const parsed = await parseDocumentBytes(searchRes.bytes, searchRes.contentType, CA_BIZFILE_ONLINE_SEARCH, ctx);
      if (parsed) return parsed;
    }
  } catch {
    /* try images */
  }

  for (const url of caSiImageUrls(entityId)) {
    try {
      const got = await fetchBytes(url, ctx);
      if (got.blocked || got.status >= 400) continue;
      const parsed = await parseDocumentBytes(got.bytes, got.contentType, url, ctx);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }

  if (ctx.apifyEnabled === false) return empty;
  const imageUrl = caSiImageUrls(entityId)[0];
  const apify = await apifyFetchHtml(imageUrl, ctx);
  const html = apify.html || apify.text;
  if (html) {
    const entries = parseOfficerRoster(html);
    if (entries.length) {
      return {
        entries,
        text: html,
        source_url: imageUrl,
        via_apify: true,
        ocr_used: false,
        usd: apify.usd,
      };
    }
    const asBytes = Buffer.from(html);
    const parsed = await parseDocumentBytes(asBytes, 'text/html', imageUrl, ctx);
    if (parsed) return { ...parsed, via_apify: true, usd: apify.usd };
  }
  return { ...empty, via_apify: true, usd: apify.usd };
}
