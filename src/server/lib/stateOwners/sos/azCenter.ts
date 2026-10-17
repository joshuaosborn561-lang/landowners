import { DESKTOP_UA, isChallengePage, looksBlocked } from '../http.js';
import { htmlToText } from '../names.js';
import type { LookupContext } from './context.js';
import { ctxFetch, fixtureHtml } from './context.js';
import { apifyFetchHtml } from './apifyPlaywright.js';
import { pickBestEntityMatch } from './match.js';
import { hitsFromRoster, parseOfficerRoster, type RosterEntry } from './officers.js';
import type { NameLookupInput, NameLookupResult } from './types.js';

/** Arizona Business Center SPA. Direct HTML is an empty Angular shell. */
export const AZ_SEARCH_UI = 'https://arizonabusinesscenter.azcc.gov/businesssearch';
export const AZ_API = 'https://api-azbusinessconnectonline.azcc.gov/api';
export const AZ_PUBLIC_SEARCH = `${AZ_API}/businesssearch/public-search`;
export const AZ_GET_BY_ID = `${AZ_API}/businesssearch/getbyidasync`;

export function isEmptyJsShell(html: string): boolean {
  const text = String(html || '');
  if (!text.trim()) return true;
  if (/<app-root>\s*<\/app-root>/i.test(text) && !/<table[\s>]/i.test(text)) return true;
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const visible = stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return visible.length < 80 && /app-root|ng-version|data-critters-container/i.test(text);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

export interface AzEntity {
  name: string;
  id: string;
  city: string | null;
  officers: RosterEntry[];
}

function rowsFromPayload(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const rec = asRecord(payload);
  if (!rec) return [];
  const data = rec.data ?? rec.Data;
  if (Array.isArray(data)) return data;
  const nested = asRecord(data);
  if (nested) {
    for (const key of ['rows', 'items', 'results', 'businessSearchInformationData', 'list']) {
      if (Array.isArray(nested[key])) return nested[key] as unknown[];
    }
  }
  for (const key of ['rows', 'items', 'results', 'ROWS']) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

export function officersFromAzPayload(payload: unknown): RosterEntry[] {
  const blob = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const fromText = parseOfficerRoster(blob);
  if (fromText.length) return fromText;
  const rows: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    const name = pickString(rec, ['name', 'fullName', 'principalName', 'officerName', 'memberName']);
    const title = pickString(rec, ['title', 'position', 'principalTitle', 'officerTitle']) || 'Officer';
    if (name) rows.push(`${title}: ${name}`);
    for (const v of Object.values(rec)) walk(v);
  };
  walk(payload);
  return rows.length ? parseOfficerRoster(rows.join('\n')) : [];
}

export function parseAzSearchPayload(payload: unknown): AzEntity[] {
  const out: AzEntity[] = [];
  for (const raw of rowsFromPayload(payload)) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const name = pickString(rec, ['businessName', 'entityName', 'legalName', 'name', 'BusinessName', 'TITLE']);
    const id = pickString(rec, ['entityNumber', 'businessId', 'id', 'entityId', 'EntityNumber', 'controlNumber']);
    if (!name && !id) continue;
    const city =
      pickString(rec, ['city', 'physicalCity', 'principalCity']) ||
      pickString(asRecord(rec.physicalAddress) || {}, ['city', 'City']) ||
      pickString(asRecord(rec.address) || {}, ['city', 'City']);
    out.push({
      name: name || id || '',
      id: id || '',
      city,
      officers: officersFromAzPayload(raw),
    });
  }
  return out;
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

export function azSearchPageFunction(searchTerm: string): string {
  const termJson = JSON.stringify(searchTerm);
  const apiJson = JSON.stringify(AZ_API);
  return `async function pageFunction(context) {
  const term = ${termJson};
  const api = ${apiJson};
  await context.page.waitForTimeout(1500);
  const payload = await context.page.evaluate(async ({ term, api }) => {
    const params = new URLSearchParams({
      pageNumber: '1',
      pageSize: '25',
      searchType: 'businessname',
      searchValue: term,
      isInhouse: 'true',
      searchMethod: '7',
    });
    const r = await fetch(api + '/businesssearch/public-search?' + params.toString(), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return { status: r.status, text: await r.text() };
  }, { term, api });
  return { url: context.request.url, html: payload.text, text: payload.text };
}`;
}

async function fetchAzJson(
  url: string,
  ctx: LookupContext | undefined,
): Promise<{ status: number; payload: unknown; blocked: boolean; body: string }> {
  const res = await ctxFetch(ctx)(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json',
      Origin: 'https://arizonabusinesscenter.azcc.gov',
      Referer: `${AZ_SEARCH_UI}/`,
    },
  });
  const body = await res.text();
  const blocked = looksBlocked(res.status, body) || isChallengePage(body) || res.status === 401;
  return { status: res.status, payload: blocked ? null : parseMaybeJson(body), blocked, body };
}

export async function searchAzBusinessCenter(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<{
  entities: AzEntity[];
  blocked: boolean;
  via_apify: boolean;
  usd: number;
  source_url: string;
}> {
  const source_url = AZ_SEARCH_UI;
  if (ctx?.azPayload != null) {
    return { entities: parseAzSearchPayload(ctx.azPayload), blocked: false, via_apify: false, usd: 0, source_url };
  }
  if (!ctx?.live) {
    return { entities: [], blocked: false, via_apify: false, usd: 0, source_url };
  }

  const q = encodeURIComponent(input.company_name.trim());
  const directUrl =
    `${AZ_PUBLIC_SEARCH}?pageNumber=1&pageSize=25&searchType=businessname&searchValue=${q}&isInhouse=true&searchMethod=7`;
  try {
    const got = await fetchAzJson(directUrl, ctx);
    if (!got.blocked && got.payload != null) {
      const entities = parseAzSearchPayload(got.payload);
      if (entities.length) {
        return { entities, blocked: false, via_apify: false, usd: 0, source_url };
      }
    }
  } catch {
    /* browser fallback */
  }

  if (ctx.apifyEnabled === false) {
    return { entities: [], blocked: true, via_apify: false, usd: 0, source_url };
  }
  const apify = await apifyFetchHtml(AZ_SEARCH_UI, ctx, {
    pageFunction: azSearchPageFunction(input.company_name),
    immediate: true,
  });
  if (apify.refused) {
    return { entities: [], blocked: true, via_apify: false, usd: 0, source_url };
  }
  const raw = apify.html || apify.text;
  if (!raw || isChallengePage(raw) || looksBlocked(200, raw)) {
    return { entities: [], blocked: true, via_apify: true, usd: apify.usd, source_url };
  }
  const payload = parseMaybeJson(raw);
  return {
    entities: parseAzSearchPayload(payload ?? raw),
    blocked: false,
    via_apify: true,
    usd: apify.usd,
    source_url,
  };
}

function parseAzHtmlLinks(html: string): AzEntity[] {
  const out: AzEntity[] = [];
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = htmlToText(m[2] || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3) continue;
    out.push({ name, id: m[1] || '', city: null, officers: [] });
  }
  return out;
}

export async function resolveArizona(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const searchHtml = fixtureHtml(ctx, 'AZ', 'search', input);
  const detailHtml = fixtureHtml(ctx, 'AZ', 'detail', input);
  if (searchHtml && !isChallengePage(searchHtml) && !isEmptyJsShell(searchHtml)) {
    const entities = parseAzHtmlLinks(searchHtml);
    const picked = pickBestEntityMatch(input.company_name, entities, {
      legalNameOf: (r) => r.name,
      city: input.city,
      cityOf: (r) => r.city,
      allowTrigram: true,
    });
    if (!picked) {
      return {
        people: [],
        coverage_reason: 'not_found',
        source: 'us_sos',
        source_url: AZ_SEARCH_UI,
        implemented: true,
      };
    }
    const body = detailHtml && !isChallengePage(detailHtml) ? detailHtml : searchHtml;
    const people = hitsFromRoster(input, parseOfficerRoster(body), 'us_sos', AZ_SEARCH_UI, picked.method);
    return {
      people,
      coverage_reason: people.length ? null : 'agent_only',
      source: 'us_sos',
      source_url: AZ_SEARCH_UI,
      implemented: true,
      match_method: picked.method,
      match_score: picked.score,
      business_name: picked.item.name,
    };
  }

  const searched = await searchAzBusinessCenter(input, ctx);
  if (searched.blocked && !searched.entities.length) {
    return {
      people: [],
      coverage_reason: 'blocked',
      source: 'us_sos',
      source_url: searched.source_url,
      implemented: true,
      via_apify: searched.via_apify,
      apify_usd: searched.usd,
    };
  }
  const picked = pickBestEntityMatch(input.company_name, searched.entities, {
    legalNameOf: (r) => r.name,
    city: input.city,
    cityOf: (r) => r.city,
    allowTrigram: true,
  });
  if (!picked) {
    return {
      people: [],
      coverage_reason: 'not_found',
      source: 'us_sos',
      source_url: searched.source_url,
      implemented: true,
      via_apify: searched.via_apify,
      apify_usd: searched.usd,
    };
  }

  let officers = picked.item.officers;
  let detailUrl = picked.item.id ? `${AZ_GET_BY_ID}?id=${encodeURIComponent(picked.item.id)}` : searched.source_url;
  const usd = searched.usd;
  const via = searched.via_apify;
  if (ctx?.azDetailPayload != null) {
    officers = officersFromAzPayload(ctx.azDetailPayload);
  } else if (picked.item.id && ctx?.live) {
    try {
      const got = await fetchAzJson(`${AZ_GET_BY_ID}?id=${encodeURIComponent(picked.item.id)}`, ctx);
      if (!got.blocked && got.payload) {
        officers = officersFromAzPayload(got.payload);
      }
    } catch {
      /* keep search-row officers */
    }
  }
  const people = hitsFromRoster(input, officers, 'us_sos', detailUrl, picked.method);
  if (!people.length) {
    return {
      people: [],
      coverage_reason: 'agent_only',
      source: 'us_sos',
      source_url: detailUrl,
      implemented: true,
      match_method: picked.method,
      match_score: picked.score,
      business_name: picked.item.name,
      entity_id: picked.item.id || null,
      via_apify: via,
      apify_usd: usd,
    };
  }
  return {
    people,
    coverage_reason: null,
    source: 'us_sos',
    source_url: detailUrl,
    implemented: true,
    match_method: picked.method,
    match_score: picked.score,
    business_name: picked.item.name,
    entity_id: picked.item.id || null,
    via_apify: via,
    apify_usd: usd,
  };
}
