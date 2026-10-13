import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const LOOKUP = 'https://secure.doli.state.mn.us/lookup/licensing.aspx';

export function parseMnDliText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 record|not found/i.test(body) && !/qualifying/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }
  if (/inactive|expired|revoked/i.test(body) && !/active/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl };
  }
  const qp =
    body.match(/Qualifying (?:Person|Individual|Party)[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Responsible Person[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Qualifier[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  if (!qp?.[1]) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }
  const split = splitPersonName(qp[1]);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'qualifying_individual',
    source: 'mn_dli',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'mn_dli', source_url: sourceUrl };
}

export async function resolveMnDli(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'mn_dli' }),
): Promise<ResolverResult> {
  if (!lead.company_name?.trim()) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: LOOKUP };
  }
  const url = `${LOOKUP}?businessName=${encodeURIComponent(lead.company_name)}`;
  const key = nameStateCacheKey(lead.company_name, 'MN');
  const cached = await readBoardCache('mn_dli', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'mn_dli', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parseMnDliText(cached.body, url), cached: true, http_status: cached.http_status };
  }
  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'mn_dli', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: url, http_status: got.status };
  }
  return { ...parseMnDliText(text, url), http_status: got.status };
}
