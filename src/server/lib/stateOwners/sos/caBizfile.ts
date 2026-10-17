import { DESKTOP_UA, looksBlocked } from '../http.js';
import { isRegistryAgentName } from '../names.js';
import type { CoverageReason } from '../types.js';
import { apifyFetchHtml } from './apifyPlaywright.js';
import type { LookupContext } from './context.js';
import { ctxFetch } from './context.js';
import { pickBestEntityMatch } from './match.js';

/** Public bizfileOnline SPA. The calicodev/calico developer API is government-agencies-only — do not call it. */
export const CA_BIZFILE_ONLINE_UI = 'https://bizfileonline.sos.ca.gov/search/business';
export const CA_BIZFILE_ONLINE_SEARCH = 'https://bizfileonline.sos.ca.gov/api/Records/businessSearch';

export interface CaBizfileEntity {
  EntityID?: string;
  EntityName?: string;
  ForeignEntityName?: string | null;
  StatusDescription?: string | null;
  EntityCity?: string | null;
  MailingCity?: string | null;
  AgentCity?: string | null;
  AgentName?: string | null;
  MailingZipCode?: string | null;
  EntityZipCode?: string | null;
  SiFrequency?: string | null;
}

export interface CaBizfileSearchPayload {
  RecordCount?: number;
  EntityData?: CaBizfileEntity[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

function nestedCity(row: Record<string, unknown>): { city: string | null; zip: string | null } {
  const addr =
    asRecord(row.PRINCIPAL_ADDRESS) ||
    asRecord(row.MAILING_ADDRESS) ||
    asRecord(row.PHYSICAL_ADDRESS) ||
    asRecord(row.ADDRESS) ||
    asRecord(asRecord(row.PRINCIPAL_ADDRESS)?.PHYSICAL_ADDRESS) ||
    asRecord(asRecord(row.MAILING_ADDRESS)?.PHYSICAL_ADDRESS);
  const city = addr ? pickString(addr, ['CITY', 'City', 'city']) : null;
  const zip = addr ? pickString(addr, ['POSTAL_CODE', 'ZIP', 'Zip', 'zip']) : null;
  return { city, zip };
}

function nestedAgent(row: Record<string, unknown>): { name: string | null; city: string | null } {
  const agent = asRecord(row.AGENT) || asRecord(row.Agent);
  if (!agent) return { name: pickString(row, ['AgentName', 'AGENT_NAME']), city: pickString(row, ['AgentCity', 'AGENT_CITY']) };
  const name = pickString(agent, ['NAME', 'Name', 'FULL_NAME']);
  const addr = asRecord(agent.ADDRESS) || asRecord(agent.PHYSICAL_ADDRESS);
  const city = addr ? pickString(addr, ['CITY', 'City']) : pickString(agent, ['CITY', 'City']);
  return { name, city };
}

export function mapPublicBizfileRow(raw: unknown): CaBizfileEntity | null {
  const row = asRecord(raw);
  if (!row) return null;
  const name = pickString(row, ['EntityName', 'ENTITY_NAME', 'TITLE', 'Name']);
  const id = pickString(row, ['EntityID', 'ENTITY_NUM', 'RECORD_NUM', 'RECORD_NUMBER', 'ID']);
  if (!name && !id) return null;
  const loc = nestedCity(row);
  const agent = nestedAgent(row);
  return {
    EntityID: id || undefined,
    EntityName: name || undefined,
    ForeignEntityName: pickString(row, ['ForeignEntityName', 'DBA', 'DBA_NAME']),
    StatusDescription: pickString(row, ['StatusDescription', 'STATUS', 'Status']),
    EntityCity: pickString(row, ['EntityCity', 'CITY']) || loc.city,
    MailingCity: pickString(row, ['MailingCity']) || loc.city,
    AgentCity: agent.city,
    AgentName: agent.name,
    MailingZipCode: pickString(row, ['MailingZipCode']) || loc.zip,
    EntityZipCode: pickString(row, ['EntityZipCode', 'ZIP']) || loc.zip,
  };
}

function rowsFromPayload(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const row = asRecord(payload);
  if (!row) return [];
  if (Array.isArray(row.EntityData)) return row.EntityData;
  if (Array.isArray(row.rows)) return row.rows;
  if (Array.isArray(row.ROWS)) return row.ROWS;
  const data = asRecord(row.data);
  if (data && Array.isArray(data.rows)) return data.rows;
  if (data && Array.isArray(data.EntityData)) return data.EntityData;
  return [];
}

export function parseCaBizfileSearch(payload: unknown): CaBizfileEntity[] {
  return rowsFromPayload(payload).map(mapPublicBizfileRow).filter((r): r is CaBizfileEntity => Boolean(r?.EntityName || r?.EntityID));
}

export function entityCity(row: CaBizfileEntity): string | null {
  return row.EntityCity || row.MailingCity || row.AgentCity || null;
}

export function pickCaBizfileEntity(
  companyName: string,
  city: string | null | undefined,
  rows: CaBizfileEntity[],
): { entity: CaBizfileEntity; score: number; method: 'exact' | 'substring' | 'trigram' } | null {
  const hit = pickBestEntityMatch(companyName, rows, {
    legalNameOf: (r) => r.EntityName || '',
    dbaNameOf: (r) => r.ForeignEntityName,
    city,
    cityOf: entityCity,
    zipOf: (r) => r.EntityZipCode || r.MailingZipCode,
    allowTrigram: true,
  });
  if (!hit) return null;
  return { entity: hit.item, score: hit.score, method: hit.method };
}

export function caBizfileSourceUrl(entityId: string | null | undefined): string {
  const id = String(entityId || '').trim();
  if (!id) return CA_BIZFILE_ONLINE_UI;
  return `${CA_BIZFILE_ONLINE_UI}/${encodeURIComponent(id)}`;
}

export function caAgentCoverage(agentName: string | null | undefined): CoverageReason {
  const name = String(agentName || '').trim();
  if (!name) return 'not_found';
  if (isRegistryAgentName(name)) return 'agent_only';
  return 'agent_only';
}

export function caBusinessSearchBody(searchTerm: string): Record<string, unknown> {
  return {
    SEARCH_VALUE: searchTerm.trim(),
    SEARCH_FILTER_TYPE_ID: 'search',
    STATUS_ID: '',
    FILING_TYPE_ID: '',
    RECORD_TYPE_ID: '',
    FILING_DATE: { start: null, end: null },
  };
}

/** Playwright pageFunction: same-origin POST after Incapsula issues a browser cookie. */
export function caSearchPageFunction(searchTerm: string): string {
  const termJson = JSON.stringify(searchTerm);
  const bodyJson = JSON.stringify(caBusinessSearchBody(searchTerm));
  return `async function pageFunction(context) {
  const term = ${termJson};
  const body = ${bodyJson};
  const payload = await context.page.evaluate(async ({ term, body }) => {
    void term;
    const r = await fetch('/api/Records/businessSearch', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.text();
  }, { term, body });
  return { url: context.request.url, html: payload, text: payload };
}`;
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
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

export async function searchCaBizfileOnline(
  searchTerm: string,
  ctx?: LookupContext,
): Promise<{
  status: number;
  payload: unknown;
  blocked: boolean;
  via_apify: boolean;
  usd: number;
  source_url: string;
}> {
  const source_url = CA_BIZFILE_ONLINE_UI;
  const empty = { status: 0, payload: null, blocked: false, via_apify: false, usd: 0, source_url };
  if (!searchTerm.trim() || !ctx?.live) return empty;

  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json,text/html;q=0.8',
    'Content-Type': 'application/json',
    Origin: 'https://bizfileonline.sos.ca.gov',
    Referer: `${CA_BIZFILE_ONLINE_UI}/`,
  };

  let status = 0;
  let body = '';
  try {
    const res = await ctxFetch(ctx)(CA_BIZFILE_ONLINE_SEARCH, {
      method: 'POST',
      headers,
      body: JSON.stringify(caBusinessSearchBody(searchTerm)),
    });
    status = res.status;
    body = await res.text();
    const blocked = looksBlocked(status, body) || status === 403 || status === 401;
    const payload = parseMaybeJson(body);
    if (!blocked && payload != null) {
      return { status, payload, blocked: false, via_apify: false, usd: 0, source_url };
    }
    if (!blocked) return { status, payload: null, blocked: false, via_apify: false, usd: 0, source_url };
  } catch {
    /* Apify fallback */
  }

  if (ctx.apifyEnabled === false) {
    return { status, payload: null, blocked: true, via_apify: false, usd: 0, source_url };
  }
  const apify = await apifyFetchHtml(CA_BIZFILE_ONLINE_UI, ctx, { pageFunction: caSearchPageFunction(searchTerm) });
  const raw = apify.html || apify.text;
  const payload = parseMaybeJson(raw);
  return {
    status: payload ? 200 : status || 0,
    payload,
    blocked: payload == null,
    via_apify: true,
    usd: apify.usd,
    source_url,
  };
}

export function matchCaBizfileFromPayload(
  companyName: string,
  city: string | null | undefined,
  payload: unknown,
): {
  entity: CaBizfileEntity | null;
  coverage_reason: CoverageReason;
  match_method?: 'exact' | 'substring' | 'trigram';
  match_score?: number;
  source_url: string;
} {
  const rows = parseCaBizfileSearch(payload);
  const picked = pickCaBizfileEntity(companyName, city, rows);
  if (!picked) {
    return { entity: null, coverage_reason: 'not_found', source_url: CA_BIZFILE_ONLINE_UI };
  }
  return {
    entity: picked.entity,
    coverage_reason: caAgentCoverage(picked.entity.AgentName),
    match_method: picked.method,
    match_score: picked.score,
    source_url: caBizfileSourceUrl(picked.entity.EntityID),
  };
}
