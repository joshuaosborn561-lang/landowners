import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SEARCH = 'https://hicsearch.attorneygeneral.gov/';

export function parsePaHicText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 result|not found|no contractor/i.test(body) && !/owner/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: sourceUrl };
  }
  const owner =
    body.match(/Owner[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Owner(?:'s)? Name[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Principal[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  if (!owner?.[1]) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: sourceUrl };
  }
  const split = splitPersonName(owner[1]);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'pa_hic',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'pa_hic', source_url: sourceUrl };
}

export async function resolvePaHic(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'pa_hic' }),
): Promise<ResolverResult> {
  if (!lead.company_name?.trim()) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: SEARCH };
  }
  const url = `${SEARCH}?s=${encodeURIComponent(lead.company_name)}`;
  const key = nameStateCacheKey(lead.company_name, 'PA');
  const cached = await readBoardCache('pa_hic', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'pa_hic', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parsePaHicText(cached.body, url), cached: true, http_status: cached.http_status };
  }
  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'pa_hic', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'pa_hic', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: url, http_status: got.status };
  }
  return { ...parsePaHicText(text, url), http_status: got.status };
}
