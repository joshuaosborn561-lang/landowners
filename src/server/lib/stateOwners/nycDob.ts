import { namesMatchNormalized, pickBestNameMatch, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SOCRATA = 'https://data.cityofnewyork.us/resource/cnwx-a5xx.json';

export function nycDobSearchUrl(opts: {
  license?: string | null;
  businessName?: string | null;
}): { url: string; query_string: string } {
  const license = String(opts.license || '').replace(/\D/g, '');
  if (license) {
    const query_string = `license_number=${license}`;
    return { url: `${SOCRATA}?${query_string}`, query_string };
  }
  const name = String(opts.businessName || '').trim();
  const like = name.replace(/'/g, "''").toUpperCase();
  const where = `upper(business_name) like '%${like}%'`;
  return {
    url: `${SOCRATA}?$where=${encodeURIComponent(where)}&$limit=25`,
    query_string: `$where=${where}`,
  };
}

export function parseNycDobJson(
  rows: unknown[],
  sourceUrl: string,
  companyName?: string,
): ResolverResult {
  const list = Array.isArray(rows) ? rows : [];
  let recs = list.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object');
  if (companyName) {
    const matched = pickBestNameMatch(companyName, recs, (r) => String(r.business_name || ''));
    recs = matched ? recs.filter((r) => namesMatchNormalized(String(r.business_name || ''), companyName)) : [];
  }
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

async function fetchNyc(
  lead: OwnerLead,
  opts: { license?: string; businessName?: string },
  client: PacedBoardClient,
): Promise<ResolverResult> {
  const { url, query_string } = nycDobSearchUrl(opts);
  const key = opts.license
    ? licenseCacheKey(opts.license)
    : nameStateCacheKey(opts.businessName || lead.company_name, 'NYC');
  const cached = await readBoardCache('nyc_dob', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'nyc_dob', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    try {
      return {
        ...parseNycDobJson(JSON.parse(cached.body) as unknown[], url, opts.businessName),
        cached: true,
        http_status: cached.http_status,
      };
    } catch {
      return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, cached: true };
    }
  }
  const got = await client.get(url, { headers: { Accept: 'application/json' } });
  await writeBoardCache({
    board: 'nyc_dob',
    cache_key: key,
    http_status: got.status,
    body: got.body,
    query_string,
    fetched_url: got.url || url,
  });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'nyc_dob', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, http_status: got.status };
  }
  try {
    return { ...parseNycDobJson(JSON.parse(got.body) as unknown[], url, opts.businessName), http_status: got.status };
  } catch {
    return { people: [], coverage_reason: 'not_found', source: 'nyc_dob', source_url: url, http_status: got.status };
  }
}

export async function resolveNycDob(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'nyc_dob' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').replace(/\D/g, '');
  if (license) {
    const byLicense = await fetchNyc(lead, { license }, client);
    if (byLicense.people.length || byLicense.coverage_reason === 'blocked') return byLicense;
  }
  const businessName = lead.company_name?.trim() || '';
  if (businessName) {
    return fetchNyc(lead, { businessName }, client);
  }
  return { people: [], coverage_reason: license ? 'not_found' : 'no_license_number', source: 'nyc_dob', source_url: SOCRATA };
}
