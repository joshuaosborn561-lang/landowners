import { DESKTOP_UA, isChallengePage, looksBlocked } from '../http.js';
import { fetchSodaName } from '../soda.js';
import type { LookupContext } from './context.js';
import { ctxFetch } from './context.js';
import { pickBestEntityMatch } from './match.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { agentOnlyHit } from './waterfall.js';
import { catalogByCode } from './catalog.js';

export const CO_SOCRATA = 'https://data.colorado.gov/resource/4ykn-tg5h.json';
export const OH_SEARCH = 'https://businesssearch.ohiosos.gov/';
export const OH_ENDPOINTS = 'https://businesssearch.ohiosos.gov/ajax/endPoints.json';

interface CoEntity {
  entityid?: string;
  entitynum?: string;
  entityname?: string;
  principalcity?: string;
  principalzipcode?: string;
  agentfirstname?: string;
  agentlastname?: string;
  agentorganizationname?: string;
  entitystatus?: string;
}

interface OhEntity {
  name: string;
  city: string | null;
  charter: string | null;
}

function coAgentName(row: CoEntity): string {
  const org = String(row.agentorganizationname || '').trim();
  if (org) return org;
  return `${row.agentfirstname || ''} ${row.agentlastname || ''}`.replace(/\s+/g, ' ').trim();
}

function emptyResult(
  url: string,
  coverage: NameLookupResult['coverage_reason'],
  extra?: Partial<NameLookupResult>,
): NameLookupResult {
  return {
    people: [],
    coverage_reason: coverage,
    source: 'us_sos',
    source_url: url,
    implemented: true,
    ...extra,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function parseOhioEndpoints(payload: unknown): string | null {
  const rec = asRecord(payload);
  const data = rec?.data ?? rec?.Data ?? payload;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;
    const url = pickString(item, ['businessnamediv', 'BusinessNameDiv', 'businessNameDiv']);
    if (url) return url;
  }
  return null;
}

export function parseOhioSearch(payload: unknown): OhEntity[] {
  const rec = asRecord(payload);
  const data = rec?.data ?? rec?.Data ?? payload;
  const rows = Array.isArray(data) ? data : [];
  const out: OhEntity[] = [];
  for (const raw of rows) {
    const nested = asRecord(raw);
    const blob = nested || {};
    const name =
      pickString(blob, ['business_name', 'businessName', 'name', 'entity_name']) ||
      pickString(asRecord(blob.registrant) || {}, ['contact_name', 'business_name']) ||
      pickString(asRecord(Array.isArray(blob.firstpanel) ? blob.firstpanel[0] : blob.firstpanel) || {}, [
        'business_name',
      ]);
    if (!name) {
      // Some payloads nest the first matching record under numeric keys.
      for (const v of Object.values(blob)) {
        const inner = Array.isArray(v) ? asRecord(v[0]) : asRecord(v);
        const innerName = inner ? pickString(inner, ['business_name', 'businessName', 'name']) : null;
        if (innerName) {
          out.push({
            name: innerName,
            city: pickString(inner!, ['city', 'location', 'principal_city']),
            charter: pickString(inner!, ['charter_num', 'charter', 'id']),
          });
          break;
        }
      }
      continue;
    }
    out.push({
      name,
      city: pickString(blob, ['city', 'location', 'principal_city', 'City']),
      charter: pickString(blob, ['charter_num', 'charter', 'id', 'entity_id']),
    });
  }
  return out;
}

async function fetchOhioJson(
  url: string,
  ctx: LookupContext | undefined,
): Promise<{ status: number; payload: unknown; blocked: boolean }> {
  const res = await ctxFetch(ctx)(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json,text/javascript;q=0.9,*/*;q=0.8',
      Origin: 'https://businesssearch.ohiosos.gov',
      Referer: OH_SEARCH,
    },
  });
  const body = await res.text();
  if (looksBlocked(res.status, body) || isChallengePage(body)) {
    return { status: res.status, payload: null, blocked: true };
  }
  try {
    return { status: res.status, payload: JSON.parse(body), blocked: false };
  } catch {
    return { status: res.status, payload: null, blocked: false };
  }
}

/**
 * Ohio has no ongoing officer roster (statutory agent only). Confirm the
 * entity via the official JSON search, or return no_source / blocked.
 * Never return unverified agent_only. Never Apify.
 */
export async function resolveOhioAgentOnly(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const entry = catalogByCode().get('OH');
  const sourceUrl = entry?.search_url || OH_SEARCH;

  const injectedRows = Array.isArray(ctx?.ohRows) ? parseOhioSearch({ data: ctx!.ohRows }) : [];
  if (injectedRows.length) {
    return confirmOhio(input, injectedRows, sourceUrl, ctx);
  }

  if (!ctx?.live) {
    return emptyResult(sourceUrl, 'no_source');
  }

  let base: string | null = null;
  if (ctx.ohEndpoints) {
    base = parseOhioEndpoints(ctx.ohEndpoints);
  } else {
    try {
      const got = await fetchOhioJson(OH_ENDPOINTS, ctx);
      if (got.blocked) return emptyResult(sourceUrl, 'blocked');
      base = parseOhioEndpoints(got.payload);
    } catch {
      return emptyResult(sourceUrl, 'no_source');
    }
  }
  if (!base) return emptyResult(sourceUrl, 'no_source');

  const root = base.endsWith('/') ? base : `${base}/`;
  const searchUrl = `${root}NS_${encodeURIComponent(input.company_name.trim())}_X`;
  try {
    const got = await fetchOhioJson(searchUrl, ctx);
    if (got.blocked) return emptyResult(sourceUrl, 'blocked');
    const rows = parseOhioSearch(got.payload);
    if (!rows.length) return emptyResult(sourceUrl, 'not_found');
    return confirmOhio(input, rows, sourceUrl, ctx);
  } catch {
    return emptyResult(sourceUrl, 'no_source');
  }
}

function confirmOhio(
  input: NameLookupInput,
  rows: OhEntity[],
  sourceUrl: string,
  ctx?: LookupContext,
): NameLookupResult {
  const picked = pickBestEntityMatch(input.company_name, rows, {
    legalNameOf: (r) => r.name,
    city: input.city,
    cityOf: (r) => r.city,
    allowTrigram: true,
  });
  if (!picked) return emptyResult(sourceUrl, 'not_found');
  const agent = ctx?.includeAgents === true ? agentOnlyHit(input, '', 'us_sos', sourceUrl) : null;
  return {
    people: agent ? [agent] : [],
    coverage_reason: 'agent_only',
    source: 'us_sos',
    source_url: sourceUrl,
    implemented: true,
    match_method: picked.method,
    match_score: picked.score,
    entity_id: picked.item.charter,
    business_name: picked.item.name,
  };
}

/** Colorado Socrata 4ykn-tg5h — entity/city confirm only. Officers are absent from every CO product. */
export async function resolveColoradoAgentOnly(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const sourceUrl = CO_SOCRATA;
  let rows: CoEntity[] = Array.isArray(ctx?.coRows) ? (ctx!.coRows as CoEntity[]) : [];
  if (!rows.length && ctx?.live) {
    try {
      const got = await fetchSodaName(CO_SOCRATA, 'entityname', input.company_name, 25);
      rows = (got.rows || []) as CoEntity[];
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    return emptyResult(sourceUrl, 'not_found');
  }
  const picked = pickBestEntityMatch(input.company_name, rows, {
    legalNameOf: (r) => r.entityname || '',
    city: input.city,
    cityOf: (r) => r.principalcity,
    zipOf: (r) => r.principalzipcode,
    allowTrigram: true,
  });
  if (!picked) return emptyResult(sourceUrl, 'not_found');
  const agentName = coAgentName(picked.item);
  const agent = ctx?.includeAgents === true ? agentOnlyHit(input, agentName, 'us_sos', sourceUrl) : null;
  return {
    people: agent ? [agent] : [],
    coverage_reason: 'agent_only',
    source: 'us_sos',
    source_url: sourceUrl,
    implemented: true,
    match_method: picked.method,
    match_score: picked.score,
    entity_id: String(picked.item.entityid || picked.item.entitynum || ''),
    business_name: picked.item.entityname || null,
  };
}
