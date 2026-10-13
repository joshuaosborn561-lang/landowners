import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const LOOKUP = 'https://elicensing21.mass.gov/CitizenAccess/GeneralProperty/PropertyLookUp.aspx';

export function parseMaCslText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  // Accela chrome repeats "Licensee" on the empty search form — require a result row.
  if (!/License Status|Expiration Date|License Type/i.test(body) || /please enter|no records found/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  if (/inactive|expired|revoked|lapsed/i.test(body) && !/active/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'ma_csl', source_url: sourceUrl };
  }
  const holder =
    body.match(/Licensee(?:\s+Name)?[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/License Holder[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Name of Licensee[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  if (!holder?.[1]) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  const split = splitPersonName(holder[1]);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'ma_csl',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'ma_csl', source_url: sourceUrl };
}

export async function resolveMaCsl(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'ma_csl' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  if (!license) {
    return { people: [], coverage_reason: 'no_license_number', source: 'ma_csl', source_url: LOOKUP };
  }
  const url = `${LOOKUP}?LicenseNumber=${encodeURIComponent(license)}`;
  const key = licenseCacheKey(license);
  const cached = await readBoardCache('ma_csl', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'ma_csl', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parseMaCslText(cached.body, url), cached: true, http_status: cached.http_status };
  }
  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'ma_csl', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'ma_csl', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: url, http_status: got.status };
  }
  return { ...parseMaCslText(text, url), http_status: got.status };
}
