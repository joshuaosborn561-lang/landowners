import { htmlToText, parseBoardPersonName, splitPersonName } from './names.js';
import { DESKTOP_UA, looksBlocked, PacedBoardClient } from './http.js';
import { collectAspNetFields, cookiesFromList, hasAspNetState } from './aspNet.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import { resolveMaSos } from './maSos.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const ACCELA = 'https://elicensing21.mass.gov/CitizenAccess/GeneralProperty/PropertyLookUp.aspx?isLicensee=Y';
const OPSI = 'https://madpl.mylicense.com/Verification/';

const CHROME_NAME = /MASSACHUSETTS|COMMONWEALTH|LICENSE|SEARCH|PLEASE|DEPARTMENT|ACCELA|VERIFICATION/i;

function personFrom(
  raw: string,
  sourceUrl: string,
): OwnerPerson | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned || CHROME_NAME.test(cleaned)) return null;
  const split = cleaned.includes(',') ? parseBoardPersonName(cleaned) : splitPersonName(cleaned);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'ma_csl',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
}

export function hasRealMaResult(text: string): boolean {
  const body = text.replace(/\r/g, '');
  const status = /License Status/i.test(body);
  const expiration = /Expiration Date/i.test(body);
  return status && expiration && !/please enter a license number/i.test(body);
}

/** Accela / OPSI result text. Hits require License Status + Expiration Date. */
export function parseMaCslText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (!hasRealMaResult(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  if (/inactive|expired|revoked|lapsed/i.test(body) && !/active/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'ma_csl', source_url: sourceUrl };
  }
  const holder =
    body.match(/Licensee(?:\s+Name)?[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/License Holder[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Name of Licensee[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Full Name[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  let raw = holder?.[1]?.trim() || '';
  if (!raw) {
    const last = body.match(/Last Name[:\s]+([A-Z][A-Za-z .'-]{1,40})/i)?.[1];
    const first = body.match(/First Name[:\s]+([A-Z][A-Za-z .'-]{1,40})/i)?.[1];
    raw = [first, last].filter(Boolean).join(' ');
  }
  if (!raw) {
    const row = body.match(/Name\s+License Number[\s\S]{0,200}?([A-Z][A-Za-z .,'-]{2,60})\s+[A-Z]{1,6}-?\d+/i);
    raw = row?.[1]?.trim() || '';
  }
  const person = personFrom(raw, sourceUrl);
  if (!person) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  return { people: [person], coverage_reason: null, source: 'ma_csl', source_url: sourceUrl };
}

function headers(cookie: string, referer: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: cookie,
    Referer: referer,
    ...extra,
  };
}

async function accelaSearch(
  query: { license?: string; businessName?: string },
  client: PacedBoardClient,
): Promise<{ status: number; body: string; url: string; blocked: boolean; query_string: string }> {
  const query_string = query.license
    ? `license=${query.license}`
    : `businessName=${query.businessName || ''}`;
  const got = await client.get(ACCELA);
  if (looksBlocked(got.status, got.body)) {
    return { status: got.status, body: got.body, url: ACCELA, blocked: true, query_string };
  }
  const fields = collectAspNetFields(got.body);
  if (!hasAspNetState(fields)) {
    return { status: got.status, body: got.body, url: ACCELA, blocked: false, query_string };
  }
  if (query.license) {
    fields['ctl00$PlaceHolderMain$refLicenseeSearchForm$txtLicenseNumber'] = query.license;
  }
  if (query.businessName) {
    for (const [k] of Object.entries(fields)) {
      if (/txtBusiName|txtBusinessName|txtLicenseeName|txtGSName/i.test(k)) {
        fields[k] = query.businessName;
      }
    }
  }
  fields.__EVENTTARGET = 'ctl00$PlaceHolderMain$btnNewSearch';
  fields.__EVENTARGUMENT = '';
  const cookie = cookiesFromList(got.setCookie);
  const posted = await client.post(ACCELA, {
    headers: headers(cookie, ACCELA, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://elicensing21.mass.gov',
    }),
    body: new URLSearchParams(fields),
  });
  return {
    status: posted.status,
    body: posted.body,
    url: posted.url || ACCELA,
    blocked: looksBlocked(posted.status, posted.body),
    query_string,
  };
}

async function opsiSearch(
  query: { license?: string; businessName?: string },
  client: PacedBoardClient,
): Promise<{ status: number; body: string; url: string; blocked: boolean; query_string: string }> {
  const query_string = query.license
    ? `license=${query.license}`
    : `licensee_name=${query.businessName || ''}`;
  const got = await client.get(OPSI);
  if (looksBlocked(got.status, got.body)) {
    return { status: got.status, body: got.body, url: OPSI, blocked: true, query_string };
  }
  const fields = collectAspNetFields(got.body);
  if (!hasAspNetState(fields)) {
    return { status: got.status, body: got.body, url: OPSI, blocked: false, query_string };
  }
  if (query.license) fields.t_web_lookup__license_no = query.license;
  if (query.businessName) {
    fields.t_web_lookup__licensee_name = query.businessName;
    fields.t_web_lookup__facility_name = query.businessName;
  }
  fields.sch_button = 'Search';
  const cookie = cookiesFromList(got.setCookie);
  const posted = await client.post(OPSI, {
    headers: headers(cookie, OPSI, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://madpl.mylicense.com',
    }),
    body: new URLSearchParams(fields),
  });
  if (looksBlocked(posted.status, posted.body)) {
    return { status: posted.status, body: posted.body, url: OPSI, blocked: true, query_string };
  }
  const detailHref = posted.body.match(/Details\.aspx\?result=([a-f0-9-]+)/i);
  if (!detailHref?.[1]) {
    return { status: posted.status, body: posted.body, url: posted.url || OPSI, blocked: false, query_string };
  }
  const detailUrl = `https://madpl.mylicense.com/Verification/Details.aspx?result=${detailHref[1]}`;
  const nextCookie = cookiesFromList(posted.setCookie, cookie);
  const detail = await client.get(detailUrl, { headers: headers(nextCookie, OPSI) });
  const combined = `${posted.body}\n${detail.body}`;
  return {
    status: detail.status || posted.status,
    body: combined,
    url: detailUrl,
    blocked: looksBlocked(detail.status, detail.body),
    query_string,
  };
}

async function lookupMaLicense(
  lead: OwnerLead,
  query: { license?: string; businessName?: string },
  client: PacedBoardClient,
): Promise<ResolverResult> {
  const cacheKey = query.license
    ? licenseCacheKey(query.license)
    : nameStateCacheKey(query.businessName || lead.company_name, 'MA');
  const cached = await readBoardCache('ma_csl', cacheKey);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'ma_csl',
        source_url: ACCELA,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    return { ...parseMaCslText(cached.body, ACCELA), cached: true, http_status: cached.http_status };
  }

  const accela = await accelaSearch(query, client);
  if (accela.blocked) {
    await writeBoardCache({
      board: 'ma_csl',
      cache_key: cacheKey,
      http_status: accela.status,
      body: htmlToText(accela.body),
      query_string: accela.query_string,
      fetched_url: accela.url,
    });
    return { people: [], coverage_reason: 'blocked', source: 'ma_csl', source_url: accela.url, blocked: true, http_status: accela.status };
  }
  let parsed = parseMaCslText(htmlToText(accela.body), accela.url);
  if (parsed.people.length) {
    await writeBoardCache({
      board: 'ma_csl',
      cache_key: cacheKey,
      http_status: accela.status,
      body: htmlToText(accela.body),
      query_string: accela.query_string,
      fetched_url: accela.url,
    });
    return { ...parsed, http_status: accela.status };
  }

  const opsi = await opsiSearch(query, client);
  if (opsi.blocked) {
    await writeBoardCache({
      board: 'ma_csl',
      cache_key: cacheKey,
      http_status: opsi.status,
      body: htmlToText(opsi.body),
      query_string: opsi.query_string,
      fetched_url: opsi.url,
    });
    return { people: [], coverage_reason: 'blocked', source: 'ma_csl', source_url: opsi.url, blocked: true, http_status: opsi.status };
  }
  parsed = parseMaCslText(htmlToText(opsi.body), opsi.url);
  await writeBoardCache({
    board: 'ma_csl',
    cache_key: cacheKey,
    http_status: opsi.status,
    body: htmlToText(opsi.body),
    query_string: opsi.query_string,
    fetched_url: opsi.url,
  });
  return { ...parsed, http_status: opsi.status };
}

export async function resolveMaCsl(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'ma_csl' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  const businessName = lead.company_name?.trim() || '';

  if (license) {
    const byLicense = await lookupMaLicense(lead, { license }, client);
    if (byLicense.people.length || byLicense.coverage_reason === 'blocked') return byLicense;
  }

  // no_license_number is a routing condition — try the business name on the license lookup.
  if (businessName) {
    const byName = await lookupMaLicense(lead, { businessName }, client);
    if (byName.people.length || byName.coverage_reason === 'blocked') return byName;
    const sos = await resolveMaSos(lead, client);
    if (sos.people.length || sos.coverage_reason === 'blocked') return sos;
    return { ...byName, coverage_reason: byName.coverage_reason || 'not_found' };
  }

  return {
    people: [],
    coverage_reason: license ? 'not_found' : 'no_license_number',
    source: 'ma_csl',
    source_url: ACCELA,
  };
}
