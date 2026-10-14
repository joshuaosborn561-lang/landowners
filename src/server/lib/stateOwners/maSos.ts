import { htmlToText, labeledValue, parseBoardPersonName, pickBestNameMatchScored, splitPersonName } from './names.js';
import { DESKTOP_UA, hasCaptchaOrTurnstile, looksBlocked, PacedBoardClient } from './http.js';
import { collectAspNetFields, collectAspNetSearchSubmit, cookiesFromList, hasAspNetState } from './aspNet.js';
import {
  formatMaCacheBypassLog,
  isBlockedBoardCache,
  nameStateCacheKey,
  readBoardCache,
  writeBoardCache,
} from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

export const MA_SOS_SEARCH = 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx';
export const MA_SOS_ORIGIN = 'https://corp.sec.state.ma.us';

const CHROME =
  /MASSACHUSETTS|COMMONWEALTH|SECRETARY|CORPORATION|SEARCH|PLEASE|DEPARTMENT|REGISTERED AGENT|CORPORATION SERVICE|CT CORPORATION/i;

const ROLE =
  'President|Treasurer|Secretary|Clerk|Director|Manager|Member|CEO|CFO|COO|Officer|Registered Agent';

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

function roleFrom(label: string): OwnerPerson['role'] {
  if (/registered agent/i.test(label)) return 'registered_agent';
  if (/member/i.test(label)) return 'member';
  return 'officer';
}

export function parseMaSosResultLinks(html: string): Array<{ name: string; url: string }> {
  const rows: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]*CorpSummary\.aspx[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] || '').replace(/&amp;/g, '&');
    const name = htmlToText(m[2] || '').replace(/\s+/g, ' ').trim();
    if (!href || !name) continue;
    const url = href.startsWith('http') ? href : new URL(href, `${MA_SOS_ORIGIN}/CorpWeb/CorpSearch/`).href;
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ name, url });
  }
  return rows;
}

function addPerson(people: OwnerPerson[], seen: Set<string>, raw: string, sourceUrl: string, role: OwnerPerson['role']) {
  const person = personFrom(raw, sourceUrl, role);
  if (!person || seen.has(person.full_name_raw.toLowerCase())) return;
  seen.add(person.full_name_raw.toLowerCase());
  people.push(person);
}

/** MA Secretary of the Commonwealth entity-detail / results text. */
export function parseMaSosText(text: string, sourceUrl: string, companyName?: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 record|not found|no matching/i.test(body) && !/officer|director|manager/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: sourceUrl };
  }
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  const roleRe = new RegExp(
    `(?:${ROLE})[:\\s]+([A-Z][A-Za-z .'-]{1,40}(?:,\\s*[A-Z][A-Za-z .'-]{1,40})?)(?=\\s+\\d|\\s+P\\.?O\\.?|\\s*$|\\n)`,
    'gi',
  );
  for (const hit of body.matchAll(roleRe)) {
    addPerson(people, seen, hit[1]?.trim() || '', sourceUrl, roleFrom(hit[0] || ''));
  }
  const htmlRows = body.matchAll(
    new RegExp(`<(?:td|th)[^>]*>\\s*(${ROLE})\\s*</(?:td|th)>\\s*<(?:td|th)[^>]*>\\s*([^<]{2,80})`, 'gi'),
  );
  for (const hit of htmlRows) {
    addPerson(people, seen, htmlToText(hit[2] || '').trim(), sourceUrl, roleFrom(hit[1] || ''));
  }
  const entity =
    labeledValue(body, 'Entity Name') ||
    labeledValue(body, 'Exact Name') ||
    body.match(/Summary for:\s*([^\n]{2,80})/i)?.[1]?.trim() ||
    null;
  let match_method: ResolverResult['match_method'];
  let match_score: number | undefined;
  if (companyName && entity) {
    const hit = pickBestNameMatchScored(companyName, [entity], (n) => n, { allowTrigram: true });
    if (!hit) {
      return { people: [], coverage_reason: 'name_miss', source: 'ma_sos', source_url: sourceUrl };
    }
    match_method = hit.method;
    match_score = hit.score;
  }
  const real = people.filter((p) => p.role !== 'registered_agent');
  const chosen = real.length ? real : people;
  if (!chosen.length) {
    if (isDefinitiveSosNotFound(body) || looksLikeRealSosPage(body)) {
      return { people: [], coverage_reason: 'not_found', source: 'ma_sos', source_url: sourceUrl };
    }
    return {
      people: [],
      coverage_reason: 'blocked',
      source: 'ma_sos',
      source_url: sourceUrl,
      blocked: true,
    };
  }
  return {
    people: chosen,
    coverage_reason: null,
    source: 'ma_sos',
    source_url: sourceUrl,
    business_name: entity || undefined,
    match_method,
    match_score,
  };
}

function headers(cookie: string, referer: string): Record<string, string> {
  return {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookie,
    Referer: referer,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: MA_SOS_ORIGIN,
  };
}

export function maSosSearchUrl(companyName: string): { url: string; query_string: string } {
  const q = companyName.trim();
  return { url: MA_SOS_SEARCH, query_string: `entityName=${q}` };
}

function blockedResult(url: string, status: number, body: string, cached = false): ResolverResult {
  return {
    people: [],
    coverage_reason: 'blocked',
    source: 'ma_sos',
    source_url: url,
    cached,
    blocked: true,
    captcha: hasCaptchaOrTurnstile(body),
    http_status: status,
  };
}

export function isDefinitiveSosNotFound(text: string): boolean {
  const body = text || '';
  return /no records|0 record|not found|no matching/i.test(body) && !/officer|director|manager/i.test(body);
}

export function looksLikeRealSosPage(text: string): boolean {
  return /Entity Name|CorpSummary\.aspx|__VIEWSTATE|Business Entity|Exact Name/i.test(text || '');
}

function isCacheableSosBody(text: string, parsed: ResolverResult): boolean {
  if (parsed.people.length) return true;
  if (parsed.coverage_reason === 'name_miss') return true;
  return isDefinitiveSosNotFound(text);
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
    if (isBlockedBoardCache(cached)) {
      console.log(formatMaCacheBypassLog({ board: 'ma_sos', status: cached.http_status, body: cached.body }));
    } else {
      const parsed = parseMaSosText(cached.body, cached.fetched_url || url, name);
      if (isCacheableSosBody(cached.body, parsed)) {
        return { ...parsed, cached: true, http_status: cached.http_status };
      }
    }
  }

  const got = await client.get(url);
  if (got.status === 0 || looksBlocked(got.status, got.body)) {
    await writeBoardCache({
      board: 'ma_sos',
      cache_key: key,
      http_status: got.status,
      body: htmlToText(got.body),
      query_string,
      fetched_url: got.url || url,
    });
    return blockedResult(url, got.status, got.body);
  }
  const fields = collectAspNetFields(got.body);
  if (!hasAspNetState(fields)) {
    const text = htmlToText(got.body);
    if (!isDefinitiveSosNotFound(text) && !looksLikeRealSosPage(got.body)) {
      return blockedResult(url, got.status || 0, got.body);
    }
    const parsed = parseMaSosText(text, url, name);
    if (isCacheableSosBody(text, parsed)) {
      await writeBoardCache({
        board: 'ma_sos',
        cache_key: key,
        http_status: got.status,
        body: text,
        query_string,
        fetched_url: got.url || url,
      });
    }
    return { ...parsed, http_status: got.status };
  }
  for (const [k] of Object.entries(fields)) {
    if (/entityname|txtentity|txtname|searchname/i.test(k)) fields[k] = name;
    if (/searchtype|rblsearch/i.test(k) && !fields[k]) fields[k] = 'B';
  }
  Object.assign(fields, collectAspNetSearchSubmit(got.body));
  fields.__EVENTTARGET = fields.__EVENTTARGET || '';
  const cookie = cookiesFromList(got.setCookie);
  const posted = await client.post(url, {
    headers: headers(cookie, url),
    body: new URLSearchParams(fields),
  });
  if (looksBlocked(posted.status, posted.body)) {
    await writeBoardCache({
      board: 'ma_sos',
      cache_key: key,
      http_status: posted.status,
      body: htmlToText(posted.body),
      query_string,
      fetched_url: posted.url || url,
    });
    return blockedResult(posted.url || url, posted.status, posted.body);
  }

  let detailHtml = posted.body;
  let detailUrl = posted.url || url;
  const links = parseMaSosResultLinks(posted.body);
  if (links.length) {
    const picked = pickBestNameMatchScored(name, links, (r) => r.name, { allowTrigram: true });
    if (picked) {
      const nextCookie = cookiesFromList(posted.setCookie, cookie);
      const detail = await client.get(picked.item.url, { headers: { Cookie: nextCookie, Referer: detailUrl } });
      if (!looksBlocked(detail.status, detail.body)) {
        detailHtml = detail.body;
        detailUrl = detail.url || picked.item.url;
      }
    }
  }

  const text = `${htmlToText(detailHtml)}\n${detailHtml}`;
  const parsed = parseMaSosText(text, detailUrl, name);
  if (isCacheableSosBody(text, parsed) || parsed.people.length) {
    await writeBoardCache({
      board: 'ma_sos',
      cache_key: key,
      http_status: posted.status,
      body: text,
      query_string,
      fetched_url: detailUrl,
    });
  }
  return { ...parsed, http_status: posted.status };
}
