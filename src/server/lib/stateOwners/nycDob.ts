import { splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SOCRATA = 'https://data.cityofnewyork.us/resource/cnwx-a5xx.json';

export function parseNycDobJson(rows: unknown[], sourceUrl: string): ResolverResult {
  const list = Array.isArray(rows) ? rows : [];
  const recs = list.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object');
  if (!recs.length) {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: sourceUrl };
  }
  const active = recs.find((r) => /active/i.test(String(r.license_status || ''))) || recs[0]!;
  if (!/active/i.test(String(active.license_status || ''))) {
    return { people: [], coverage_reason: 'inactive_license', source: 'nyc_dob', source_url: sourceUrl };
  }
  const first = String(active.first_name || '').trim();
  const last = String(active.last_name || '').trim();
  const raw = [first, last].filter(Boolean).join(' ');
  if (!raw) {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: sourceUrl };
  }
  const split = splitPersonName(raw);
  const phone = String(active.business_phone_number || '').trim() || null;
  const person: OwnerPerson = {
    first_name: split.first_name || first || null,
    last_name: split.last_name || last || null,
    full_name_raw: raw,
    role: 'owner',
    source: 'nyc_dob',
    source_url: sourceUrl,
    confidence: 'high',
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'nyc_dob', source_url: sourceUrl, business_phone: phone };
}

export async function resolveNycDob(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'nyc_dob' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').replace(/\D/g, '');
  if (!license) {
    return { people: [], coverage_reason: 'no_license_number', source: 'nyc_dob', source_url: SOCRATA };
  }
  const url = `${SOCRATA}?license_number=${encodeURIComponent(license)}`;
  const key = licenseCacheKey(license);
  const cached = await readBoardCache('nyc_dob', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'nyc_dob', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    try {
      return { ...parseNycDobJson(JSON.parse(cached.body) as unknown[], url), cached: true, http_status: cached.http_status };
    } catch {
      return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, cached: true };
    }
  }
  const got = await client.get(url, { headers: { Accept: 'application/json' } });
  await writeBoardCache({ board: 'nyc_dob', cache_key: key, http_status: got.status, body: got.body });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'nyc_dob', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, http_status: got.status };
  }
  try {
    return { ...parseNycDobJson(JSON.parse(got.body) as unknown[], url), http_status: got.status };
  } catch {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, http_status: got.status };
  }
}
