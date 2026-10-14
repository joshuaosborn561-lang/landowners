import { htmlToText, labeledValue, parseBoardPersonName, pickBestNameMatch, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import { resolvePaOpenData } from './paOpenData.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

export const PA_DOS_SEARCH = 'https://file.dos.pa.gov/search/business';
export const PA_DOS_LEGACY = 'https://www.corporations.pa.gov/search/corpsearch';

const CHROME =
  /PENNSYLVANIA|DEPARTMENT|SEARCH|PLEASE|CORPORATION SERVICE|CT CORPORATION|REGISTERED OFFICE/i;

function personFrom(raw: string, sourceUrl: string, role: OwnerPerson['role'] = 'officer'): OwnerPerson | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned || CHROME.test(cleaned)) return null;
  const split = cleaned.includes(',') ? parseBoardPersonName(cleaned) : splitPersonName(cleaned);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'pa_dos',
    source_url: sourceUrl,
    confidence: role === 'registered_agent' ? 'low' : 'medium',
    review_flag: split.review_flag || undefined,
  };
}

/** PA Department of State business-entity officers / partners. */
export function parsePaDosText(text: string, sourceUrl: string, companyName?: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(body)) {
    return { people: [], coverage_reason: 'blocked', source: 'pa_dos', source_url: sourceUrl };
  }
  if (/no records|0 result|not found|no matching|no entities/i.test(body) && !/officer|partner|member/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: sourceUrl };
  }
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  const hits = body.matchAll(
    /(?:President|Vice President|Treasurer|Secretary|Officer|Director|Manager|Member|General Partner|Partner|Owner)[:\s]+([A-Z][A-Za-z .,'-]{2,60})/gi,
  );
  for (const hit of hits) {
    const raw = hit[1]?.trim() || '';
    const role = /member/i.test(hit[0] || '') ? 'member' : /partner|owner/i.test(hit[0] || '') ? 'owner' : 'officer';
    const person = personFrom(raw, sourceUrl, role);
    if (!person || seen.has(person.full_name_raw.toLowerCase())) continue;
    seen.add(person.full_name_raw.toLowerCase());
    people.push(person);
  }
  const entity = labeledValue(body, 'Entity Name') || labeledValue(body, 'Business Name') || labeledValue(body, 'Exact Name');
  if (companyName && entity && !pickBestNameMatch(companyName, [entity], (n) => n)) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: sourceUrl };
  }
  if (!people.length) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: sourceUrl, business_name: entity };
  }
  return { people, coverage_reason: null, source: 'pa_dos', source_url: sourceUrl, business_name: entity };
}

export function paDosSearchUrl(companyName: string): { url: string; query_string: string } {
  const q = companyName.trim();
  const query_string = `q=${q}`;
  return { url: `${PA_DOS_SEARCH}?q=${encodeURIComponent(q)}`, query_string };
}

export async function resolvePaDos(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'pa_dos' }),
): Promise<ResolverResult> {
  const name = lead.company_name?.trim() || '';
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: PA_DOS_SEARCH };
  }
  const open = await resolvePaOpenData(lead);
  if (open.people.length || open.coverage_reason === 'blocked') return open;
  const { url, query_string } = paDosSearchUrl(name);
  const key = nameStateCacheKey(name, 'PA');
  const cached = await readBoardCache('pa_dos', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body) || /cf-turnstile/i.test(cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'pa_dos',
        source_url: url,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    return { ...parsePaDosText(cached.body, url, name), cached: true, http_status: cached.http_status };
  }

  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({
    board: 'pa_dos',
    cache_key: key,
    http_status: got.status,
    body: text,
    query_string,
    fetched_url: got.url || url,
  });
  if (looksBlocked(got.status, got.body) || /cf-turnstile/i.test(got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'pa_dos', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: url, http_status: got.status };
  }
  const parsed = parsePaDosText(text, got.url || url, name);
  if (parsed.people.length || parsed.coverage_reason === 'blocked') return { ...parsed, http_status: got.status };

  const legacy = `${PA_DOS_LEGACY}?searchName=${encodeURIComponent(name)}`;
  const next = await client.get(legacy);
  const legacyText = htmlToText(next.body);
  await writeBoardCache({
    board: 'pa_dos',
    cache_key: key,
    http_status: next.status,
    body: legacyText,
    query_string: `searchName=${name}`,
    fetched_url: next.url || legacy,
  });
  if (looksBlocked(next.status, next.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'pa_dos', source_url: legacy, blocked: true, http_status: next.status };
  }
  return { ...parsePaDosText(legacyText, next.url || legacy, name), http_status: next.status };
}
