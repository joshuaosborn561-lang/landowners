import { htmlToText, labeledValue, parseBoardPersonName, pickBestNameMatch, splitPersonName } from './names.js';
import { DESKTOP_UA, looksBlocked, PacedBoardClient } from './http.js';
import { collectAspNetFields, cookiesFromList, hasAspNetState } from './aspNet.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

export const MA_SOS_SEARCH = 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx';

const CHROME =
  /MASSACHUSETTS|COMMONWEALTH|SECRETARY|CORPORATION|SEARCH|PLEASE|DEPARTMENT|REGISTERED AGENT|CORPORATION SERVICE|CT CORPORATION/i;

function personFrom(raw: string, sourceUrl: string, role: OwnerPerson['role'] = 'officer'): OwnerPerson | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned || CHROME.test(cleaned)) return null;
  const split = cleaned.includes(',') ? parseBoardPersonName(cleaned) : splitPersonName(cleaned);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'ma_sos',
    source_url: sourceUrl,
    confidence: role === 'registered_agent' ? 'low' : 'medium',
    review_flag: split.review_flag || undefined,
  };
}

/** MA Secretary of the Commonwealth entity-detail / results text. */
export function parseMaSosText(text: string, sourceUrl: string, companyName?: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 record|not found|no matching/i.test(body) && !/officer|director|manager/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: sourceUrl };
  }
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  const hits = body.matchAll(
    /(?:President|Treasurer|Secretary|Clerk|Director|Manager|Member|Officer|Registered Agent)[:\s]+([A-Z][A-Za-z .,'-]{2,60})/gi,
  );
  for (const hit of hits) {
    const raw = hit[1]?.trim() || '';
    const role = /registered agent/i.test(hit[0] || '') ? 'registered_agent' : /member/i.test(hit[0] || '') ? 'member' : 'officer';
    const person = personFrom(raw, sourceUrl, role);
    if (!person || seen.has(person.full_name_raw.toLowerCase())) continue;
    seen.add(person.full_name_raw.toLowerCase());
    people.push(person);
  }
  const entity = labeledValue(body, 'Entity Name') || labeledValue(body, 'Exact Name');
  if (companyName && entity && !pickBestNameMatch(companyName, [entity], (n) => n)) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: sourceUrl };
  }
  const real = people.filter((p) => p.role !== 'registered_agent');
  const chosen = real.length ? real : people;
  if (!chosen.length) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: sourceUrl };
  }
  return { people: chosen, coverage_reason: null, source: 'ma_sos', source_url: sourceUrl, business_name: entity };
}

function headers(cookie: string, referer: string): Record<string, string> {
  return {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookie,
    Referer: referer,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://corp.sec.state.ma.us',
  };
}

export function maSosSearchUrl(companyName: string): { url: string; query_string: string } {
  const q = companyName.trim();
  return { url: MA_SOS_SEARCH, query_string: `entityName=${q}` };
}

export async function resolveMaSos(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'ma_sos' }),
): Promise<ResolverResult> {
  const name = lead.company_name?.trim() || '';
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: MA_SOS_SEARCH };
  }
  const { url, query_string } = maSosSearchUrl(name);
  const key = nameStateCacheKey(name, 'MA-SOS');
  const cached = await readBoardCache('ma_sos', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'ma_sos',
        source_url: url,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    return { ...parseMaSosText(cached.body, url, name), cached: true, http_status: cached.http_status };
  }

  const got = await client.get(url);
  if (looksBlocked(got.status, got.body)) {
    await writeBoardCache({
      board: 'ma_sos',
      cache_key: key,
      http_status: got.status,
      body: htmlToText(got.body),
      query_string,
      fetched_url: got.url || url,
    });
    return { people: [], coverage_reason: 'blocked', source: 'ma_sos', source_url: url, blocked: true, http_status: got.status };
  }
  const fields = collectAspNetFields(got.body);
  if (!hasAspNetState(fields)) {
    const text = htmlToText(got.body);
    await writeBoardCache({
      board: 'ma_sos',
      cache_key: key,
      http_status: got.status,
      body: text,
      query_string,
      fetched_url: got.url || url,
    });
    return { ...parseMaSosText(text, url, name), http_status: got.status };
  }
  for (const [k] of Object.entries(fields)) {
    if (/entityname|txtentity|txtname|searchname/i.test(k)) fields[k] = name;
    if (/searchtype|rblsearch/i.test(k) && !fields[k]) fields[k] = 'B';
  }
  fields.__EVENTTARGET = fields.__EVENTTARGET || '';
  const cookie = cookiesFromList(got.setCookie);
  const posted = await client.post(url, {
    headers: headers(cookie, url),
    body: new URLSearchParams(fields),
  });
  const text = htmlToText(posted.body);
  await writeBoardCache({
    board: 'ma_sos',
    cache_key: key,
    http_status: posted.status,
    body: text,
    query_string,
    fetched_url: posted.url || url,
  });
  if (looksBlocked(posted.status, posted.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'ma_sos', source_url: posted.url || url, blocked: true, http_status: posted.status };
  }
  return { ...parseMaSosText(text, posted.url || url, name), http_status: posted.status };
}
