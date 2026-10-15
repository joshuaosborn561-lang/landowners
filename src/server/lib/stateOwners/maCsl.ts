import {
  htmlToText,
  looksLikeSolePropPerson,
  normalizeCompanyName,
  parseBoardPersonName,
  splitPersonName,
} from './names.js';
import {
  DESKTOP_UA,
  createResidentialProxyFetch,
  hasCaptchaOrTurnstile,
  hostOf,
  isBoardFetchInjected,
  looksBlocked,
  shouldRetryMaViaProxy,
  PacedBoardClient,
} from './http.js';
import { collectAspNetFields, collectAspNetSearchSubmit, cookiesFromList, hasAspNetState } from './aspNet.js';
import {
  formatMaCacheBypassLog,
  isBlockedBoardCache,
  licenseCacheKey,
  nameStateCacheKey,
  readBoardCache,
  shouldReuseBoardCache,
  writeBoardCache,
} from './cache.js';
import { resolveMaSos } from './maSos.js';
import {
  fetchMaSosViaPlaywright,
  maSosLookupFromLead,
  shouldUseMaBrowser,
} from './maSosBrowser.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

/** Bump ignores stale cached blocked / empty OPSI rows from before the form+parser fix. */
export const MA_CSL_CACHE_VERSION = 'v2';

/** Accela Citizen Access no longer lists DOL construction boards (eLIPSE). Kept only as a last-resort host label. */
export const ACCELA = 'https://elicensing21.mass.gov/CitizenAccess/GeneralProperty/PropertyLookUp.aspx?isLicensee=Y';
/** Official free OPSI / CSL verification (person search). */
export const OPSI = 'https://madpl.mylicense.com/Verification/';
/** Official free OPSI facility / business-name search. */
export const OPSI_FACILITY = 'https://madpl.mylicense.com/Verification/Search.aspx?Facility=Y';

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

export interface MaCslResultRow {
  name: string;
  license: string;
  licenseType: string;
  status: string;
  detailsPath: string;
}

/** Live OPSI SearchResults.aspx datagrid: Name / License Number / License Type / License Status. */
export function parseMaCslResultsTable(html: string): MaCslResultRow[] {
  const rows: MaCslResultRow[] = [];
  const re =
    /<a[^>]+href="([^"]*Details\.aspx\?result=[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*>\s*(?:<span[^>]*>)?([^<]*)(?:<\/span>)?[\s\S]*?<td[^>]*>\s*(?:<span[^>]*>)?([^<]*)(?:<\/span>)?[\s\S]*?<td[^>]*>\s*(?:<span[^>]*>)?([^<]*)(?:<\/span>)?/gi;
  for (const m of String(html || '').matchAll(re)) {
    const name = htmlToText(m[2] || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) continue;
    rows.push({
      name,
      license: htmlToText(m[3] || '').replace(/\s+/g, ' ').trim(),
      licenseType: htmlToText(m[4] || '').replace(/\s+/g, ' ').trim(),
      status: htmlToText(m[5] || '').replace(/\s+/g, ' ').trim(),
      detailsPath: (m[1] || '').replace(/&amp;/g, '&'),
    });
  }
  return rows;
}

export function maCslDetailsUrl(path: string): string {
  if (/^https?:/i.test(path)) return path;
  return new URL(path, 'https://madpl.mylicense.com/Verification/').href;
}

export function pickMaCslResultRow(rows: MaCslResultRow[]): MaCslResultRow | null {
  return rows.find((r) => /^active$/i.test(r.status)) || rows[0] || null;
}

export function hasRealMaResult(text: string): boolean {
  const body = text.replace(/\r/g, '');
  if (/please enter a license number/i.test(body)) return false;
  if (/License Status/i.test(body) && /Expiration Date/i.test(body)) return true;
  if (/Details\.aspx\?result=/i.test(body) && /License (Number|Status|Type)/i.test(body)) return true;
  if (/datagrid_results/i.test(body) && /License Number/i.test(body)) return true;
  return parseMaCslResultsTable(body).length > 0;
}

/** Accela / OPSI result text. Hits are a details page or the live SearchResults table. */
export function parseMaCslText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  const tableRows = parseMaCslResultsTable(body);
  if (!hasRealMaResult(body) && !tableRows.length) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  const activeRows = tableRows.filter((r) => /^active$/i.test(r.status));
  const anyActive = /active/i.test(body) || activeRows.length > 0;
  if (/inactive|expired|revoked|lapsed|null and void/i.test(body) && !anyActive) {
    return { people: [], coverage_reason: 'inactive_license', source: 'ma_csl', source_url: sourceUrl };
  }
  const holder =
    body.match(/Licensee(?:\s+Name)?[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/License Holder[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Name of Licensee[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Full Name[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Owner(?:\s+Name)?[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
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
  if (!raw && tableRows.length) {
    raw = (activeRows[0] || tableRows[0]).name;
  }
  const person = personFrom(raw, sourceUrl);
  if (!person) {
    return { people: [], coverage_reason: 'not_found', source: 'ma_csl', source_url: sourceUrl };
  }
  return { people: [person], coverage_reason: null, source: 'ma_csl', source_url: sourceUrl };
}

/** Entity search without LLC / Inc / Corp suffixes. */
export function maCslSearchName(name: string): string {
  return normalizeCompanyName(name) || String(name || '').replace(/\s+/g, ' ').trim();
}

export function maCslCacheKey(query: { license?: string; businessName?: string }): string {
  if (query.license) return `${licenseCacheKey(query.license)}|MA-CSL-${MA_CSL_CACHE_VERSION}`;
  return nameStateCacheKey(maCslSearchName(query.businessName || ''), `MA-CSL-${MA_CSL_CACHE_VERSION}`);
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

export function applyOpsiPersonFields(
  fields: Record<string, string>,
  query: { license?: string; businessName?: string },
): Record<string, string> {
  const next = { ...fields };
  next.t_web_lookup__profession_name = 'Building Licenses';
  // Empty type = All. Forcing Construction Supervisor hid every business-name hit.
  next.t_web_lookup__license_type_name = '';
  if (query.license) next.t_web_lookup__license_no = query.license;
  if (query.businessName) {
    const q = maCslSearchName(query.businessName);
    next.t_web_lookup__doing_business_as = q;
    if (looksLikeSolePropPerson(query.businessName) || looksLikeSolePropPerson(q)) {
      const split = splitPersonName(q);
      if (split.last_name) next.t_web_lookup__last_name = split.last_name;
      if (split.first_name) next.t_web_lookup__first_name = split.first_name;
    }
  }
  next.sch_button = 'Search';
  return next;
}

export function applyOpsiFacilityFields(
  fields: Record<string, string>,
  query: { license?: string; businessName?: string },
): Record<string, string> {
  const next = { ...fields };
  next.t_web_lookup__profession_name = 'Building Licenses';
  next.t_web_lookup__license_type_name = '';
  if (query.license) next.t_web_lookup__license_no = query.license;
  if (query.businessName) {
    const q = maCslSearchName(query.businessName);
    next.t_web_lookup__full_name = q;
    next.t_web_lookup__owner_name = q;
  }
  next.sch_button = 'Search';
  return next;
}

function logCslAttempt(url: string, status: number, form: 'person' | 'facility'): void {
  console.log(`[ma-csl] host=${hostOf(url)} form=${form} status=${status}`);
}

async function opsiSearch(
  query: { license?: string; businessName?: string },
  client: PacedBoardClient,
  form: 'person' | 'facility',
): Promise<{ status: number; body: string; url: string; blocked: boolean; query_string: string }> {
  const startUrl = form === 'facility' ? OPSI_FACILITY : OPSI;
  const query_string = query.license
    ? `license=${query.license}`
    : form === 'facility'
      ? `facility_name=${query.businessName || ''}`
      : `doing_business_as=${query.businessName || ''}`;
  const got = await client.get(startUrl);
  logCslAttempt(startUrl, got.status, form);
  if (looksBlocked(got.status, got.body)) {
    return { status: got.status, body: got.body, url: startUrl, blocked: true, query_string };
  }
  const fields = collectAspNetFields(got.body);
  if (!hasAspNetState(fields)) {
    return { status: got.status, body: got.body, url: startUrl, blocked: false, query_string };
  }
  const postedFields = form === 'facility' ? applyOpsiFacilityFields(fields, query) : applyOpsiPersonFields(fields, query);
  Object.assign(postedFields, collectAspNetSearchSubmit(got.body));
  postedFields.sch_button = postedFields.sch_button || 'Search';
  postedFields.__EVENTTARGET = postedFields.__EVENTTARGET || '';
  const cookie = cookiesFromList(got.setCookie);
  const posted = await client.post(startUrl, {
    headers: headers(cookie, startUrl, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://madpl.mylicense.com',
    }),
    body: new URLSearchParams(postedFields),
  });
  logCslAttempt(posted.url || startUrl, posted.status, form);
  if (looksBlocked(posted.status, posted.body)) {
    return { status: posted.status, body: posted.body, url: startUrl, blocked: true, query_string };
  }
  let resultHtml = posted.body;
  let resultUrl = posted.url || startUrl;
  if (
    !/datagrid_results|Details\.aspx\?result=/i.test(resultHtml) &&
    /SearchResults\.aspx/i.test(`${resultHtml}\n${resultUrl}`)
  ) {
    const followed = await client.get('https://madpl.mylicense.com/Verification/SearchResults.aspx', {
      headers: headers(cookiesFromList(posted.setCookie, cookie), startUrl),
    });
    logCslAttempt(followed.url || resultUrl, followed.status, form);
    if (!looksBlocked(followed.status, followed.body)) {
      resultHtml = followed.body;
      resultUrl = followed.url || resultUrl;
    }
  }
  const picked = pickMaCslResultRow(parseMaCslResultsTable(resultHtml));
  if (!picked) {
    return { status: posted.status, body: resultHtml, url: resultUrl, blocked: false, query_string };
  }
  const detailUrl = maCslDetailsUrl(picked.detailsPath);
  const nextCookie = cookiesFromList(posted.setCookie, cookie);
  const detail = await client.get(detailUrl, { headers: headers(nextCookie, resultUrl) });
  const combined = `${resultHtml}\n${detail.body}`;
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
  const cacheKey = maCslCacheKey({
    license: query.license,
    businessName: query.businessName || lead.company_name,
  });
  const cached = await readBoardCache('ma_csl', cacheKey);
  if (cached && isBlockedBoardCache(cached)) {
    console.log(formatMaCacheBypassLog({ board: 'ma_csl', status: cached.http_status, body: cached.body }));
  } else if (cached && shouldReuseBoardCache(cached) && hasRealMaResult(cached.body || '')) {
    return { ...parseMaCslText(cached.body || '', cached.fetched_url || ACCELA), cached: true, http_status: cached.http_status };
  }

  // Accela elicensing21 no longer lists construction / CSL (eLIPSE). Contractor Hub is captcha-gated — skip.
  const person = await opsiSearch(query, client, 'person');
  let chosen = person;
  if (!person.blocked) {
    const parsedPerson = parseMaCslText(person.body, person.url);
    if (parsedPerson.people.length) {
      await writeBoardCache({
        board: 'ma_csl',
        cache_key: cacheKey,
        http_status: person.status,
        body: person.body,
        query_string: person.query_string,
        fetched_url: person.url,
      });
      return { ...parsedPerson, http_status: person.status };
    }
  }
  if (query.businessName || !person.blocked) {
    chosen = await opsiSearch(
      query,
      new PacedBoardClient({ source: 'ma_csl', fetch: client.fetchFn, viaProxy: client.viaProxy }),
      'facility',
    );
  }
  const parsed = chosen.blocked
    ? { people: [] as ResolverResult['people'], coverage_reason: 'blocked' as const, source: 'ma_csl' as const, source_url: chosen.url }
    : parseMaCslText(chosen.body, chosen.url);
  await writeBoardCache({
    board: 'ma_csl',
    cache_key: cacheKey,
    http_status: chosen.status,
    body: chosen.body,
    query_string: chosen.query_string,
    fetched_url: chosen.url,
  });
  if (parsed.people.length) return { ...parsed, http_status: chosen.status };
  if (person.blocked && chosen.blocked) {
    return {
      people: [],
      coverage_reason: 'blocked',
      source: 'ma_csl',
      source_url: chosen.url,
      blocked: true,
      captcha: hasCaptchaOrTurnstile(person.body) || hasCaptchaOrTurnstile(chosen.body),
      http_status: chosen.status,
    };
  }
  return { ...parsed, coverage_reason: parsed.coverage_reason || 'not_found', http_status: chosen.status };
}

async function resolveMaCslOnce(
  lead: OwnerLead,
  client: PacedBoardClient,
  sosClient: PacedBoardClient,
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  const businessName = lead.company_name?.trim() || '';

  const attempts: ResolverResult[] = [];
  if (license) attempts.push(await lookupMaLicense(lead, { license }, client));
  // Pilot MA rows have no license numbers; SOS officers are the free path.
  if (businessName && !attempts.some((a) => a.people.length)) {
    attempts.push(await resolveMaSos(lead, sosClient));
  }
  if (businessName && !attempts.some((a) => a.people.length)) {
    attempts.push(await lookupMaLicense(lead, { businessName }, client));
  }

  const hit = attempts.find((a) => a.people.length);
  if (hit) return hit;
  const captcha = attempts.find((a) => a.captcha);
  if (captcha) return { ...captcha, coverage_reason: 'blocked', blocked: true, captcha: true };
  const blocked = attempts.find((a) => a.blocked || a.coverage_reason === 'blocked');
  if (blocked) return { ...blocked, coverage_reason: 'blocked', blocked: true };
  if (!license && !businessName) {
    return { people: [], coverage_reason: 'no_license_number', source: 'ma_csl', source_url: ACCELA };
  }
  return (
    attempts.find((a) => a.coverage_reason !== 'blocked') ||
    attempts[attempts.length - 1] || {
      people: [],
      coverage_reason: 'not_found',
      source: 'ma_csl',
      source_url: ACCELA,
    }
  );
}

export async function resolveMaCsl(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'ma_csl' }),
  opts: { skipBrowser?: boolean } = {},
): Promise<ResolverResult> {
  let proxyUpFront = null;
  try {
    proxyUpFront =
      !client.fetchFn && !isBoardFetchInjected()
        ? await createResidentialProxyFetch(`ma${lead.lead_id || 'sos'}`)
        : null;
  } catch {
    proxyUpFront = null;
  }
  const sosClient = new PacedBoardClient({
    source: 'ma_sos',
    fetch: proxyUpFront || undefined,
    viaProxy: Boolean(proxyUpFront),
  });
  let current = await resolveMaCslOnce(lead, client, sosClient);
  if (current.people.length) return current;
  if (isBoardFetchInjected()) return current;
  if (
    !client.fetchFn &&
    !proxyUpFront &&
    shouldRetryMaViaProxy({
      named: false,
      captcha: current.captcha,
      blocked: current.blocked,
      coverage_reason: current.coverage_reason,
      http_status: current.http_status,
    })
  ) {
    let proxyFetch = null;
    try {
      proxyFetch = await createResidentialProxyFetch(`ma${lead.lead_id || 'retry'}`);
    } catch {
      proxyFetch = null;
    }
    if (proxyFetch) {
      current = await resolveMaCslOnce(
        lead,
        new PacedBoardClient({ source: 'ma_csl', fetch: proxyFetch, viaProxy: true }),
        new PacedBoardClient({ source: 'ma_sos', fetch: proxyFetch, viaProxy: true }),
      );
      if (current.people.length) return current;
    }
  }
  if (opts.skipBrowser || !shouldUseMaBrowser(current)) return current;
  const lookup = maSosLookupFromLead(lead);
  if (!lookup) return current;
  const [browser] = await fetchMaSosViaPlaywright([lookup]);
  return browser || current;
}

/** One Playwright actor run for every remaining Incapsula SOS miss. */
export async function resolveMassachusettsOwners(leads: OwnerLead[]): Promise<ResolverResult[]> {
  const first: ResolverResult[] = [];
  for (const lead of leads) {
    first.push(await resolveMaCsl(lead, new PacedBoardClient({ source: 'ma_csl' }), { skipBrowser: true }));
  }
  const pending = leads
    .map((lead, i) => ({ lead, index: i, result: first[i]! }))
    .filter((row) => shouldUseMaBrowser(row.result));
  const lookups = pending
    .map((row) => maSosLookupFromLead(row.lead))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (!lookups.length) return first;
  const browser = await fetchMaSosViaPlaywright(lookups);
  const out = first.slice();
  pending.forEach((row, i) => {
    const hit = browser[i];
    if (hit) out[row.index] = hit;
  });
  return out;
}
