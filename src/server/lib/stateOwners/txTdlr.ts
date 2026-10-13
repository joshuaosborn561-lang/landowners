import { hasCompanyWord, htmlToText, namesMatchNormalized, parseBoardPersonName, pickBestNameMatch, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SEARCH = 'https://www.tdlr.texas.gov/LicenseSearch/';
const SODA = 'https://data.texas.gov/resource/7358-krk7.json';

const TRADE =
  /electrical|a\/c|air conditioning|airconditioning|hvac|refrigerat|acr\b|elc\b|airref/i;

export function looksLikeTdlrTradeLicense(raw: string | null | undefined): boolean {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return false;
  if (/\b(TECL|TACL|TACLA|ACR|ELCON|MASTER\s*ELEC|JOURNEYMAN|HVAC|ELECTR)/.test(s)) return true;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 5 && digits.length <= 8;
}

export function isTdlrTradeType(licenseType: string | null | undefined): boolean {
  return TRADE.test(String(licenseType || ''));
}

function expired(mmddccyy: string | null | undefined): boolean {
  const m = String(mmddccyy || '').match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) return false;
  const exp = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return exp < Date.now();
}

export function parseTxTdlrText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 record|not found|no matches/i.test(body) && !/licensee|license holder/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: sourceUrl };
  }
  if (/inactive|expired|revoked|closed/i.test(body) && !/active/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'tx_tdlr', source_url: sourceUrl };
  }
  const holder =
    body.match(/Licensee(?:\s+Name)?[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/License Holder[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Name[:\s]+([A-Z][A-Z .'-]{2,60})/i);
  if (!holder?.[1] || /TEXAS|TDLR|DEPARTMENT/i.test(holder[1])) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: sourceUrl };
  }
  const split = splitPersonName(holder[1]);
  const phone = (body.match(/Phone[:\s]+(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i) || [])[1] || null;
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'tx_tdlr',
    source_url: sourceUrl,
    confidence: 'high',
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'tx_tdlr', source_url: sourceUrl, business_phone: phone };
}

export function txTdlrSearchUrl(opts: {
  license?: string | null;
  businessName?: string | null;
}): { url: string; query_string: string } {
  const digits = String(opts.license || '').replace(/\D/g, '');
  if (digits) {
    const query_string = `license_number=${digits}`;
    return { url: `${SODA}?${query_string}&$limit=10`, query_string };
  }
  const name = String(opts.businessName || '').trim();
  const like = name.replace(/'/g, "''").toUpperCase();
  const where = `upper(business_name) like '%${like}%'`;
  return {
    url: `${SODA}?$where=${encodeURIComponent(where)}&$limit=25`,
    query_string: `$where=${where}`,
  };
}

/** Official TDLR All Licenses dump on data.texas.gov (`7358-krk7`). */
export function parseTxTdlrJson(rows: unknown[], sourceUrl: string, companyName?: string): ResolverResult {
  let list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object',
  );
  if (companyName) {
    list = list.filter((r) => namesMatchNormalized(String(r.business_name || ''), companyName));
    const best = pickBestNameMatch(companyName, list, (r) => String(r.business_name || ''));
    if (best) list = [best, ...list.filter((r) => r !== best)];
  }
  const trade = list.find((r) => isTdlrTradeType(String(r.license_type || ''))) || null;
  if (!trade) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: sourceUrl };
  }
  if (expired(String(trade.license_expiration_date_mmddccyy || ''))) {
    return { people: [], coverage_reason: 'inactive_license', source: 'tx_tdlr', source_url: sourceUrl };
  }
  const owner = String(trade.owner_name || '').trim();
  const phone = String(trade.business_telephone || trade.owner_telephone || '').trim() || null;
  if (!owner) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: sourceUrl, business_phone: phone };
  }
  if (hasCompanyWord(owner)) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: sourceUrl, business_phone: phone };
  }
  const split = parseBoardPersonName(owner);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'tx_tdlr',
    source_url: sourceUrl,
    confidence: 'high',
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
  return {
    people: [person],
    coverage_reason: null,
    source: 'tx_tdlr',
    source_url: sourceUrl,
    business_phone: phone,
    business_name: String(trade.business_name || '') || null,
    license_status: 'active',
  };
}

async function fetchTdlr(
  lead: OwnerLead,
  opts: { license?: string; businessName?: string },
  client: PacedBoardClient,
): Promise<ResolverResult> {
  const { url, query_string } = txTdlrSearchUrl(opts);
  const key = opts.license
    ? licenseCacheKey(opts.license.replace(/\D/g, ''))
    : nameStateCacheKey(opts.businessName || lead.company_name, 'TX');
  const cached = await readBoardCache('tx_tdlr', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'tx_tdlr',
        source_url: url,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    try {
      return {
        ...parseTxTdlrJson(JSON.parse(cached.body) as unknown[], url, opts.businessName),
        cached: true,
        http_status: cached.http_status,
      };
    } catch {
      return { ...parseTxTdlrText(cached.body, url), cached: true, http_status: cached.http_status };
    }
  }

  const got = await client.get(url, { headers: { Accept: 'application/json' } });
  await writeBoardCache({
    board: 'tx_tdlr',
    cache_key: key,
    http_status: got.status,
    body: got.body,
    query_string,
    fetched_url: got.url || url,
  });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'tx_tdlr', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: url, http_status: got.status };
  }
  try {
    return { ...parseTxTdlrJson(JSON.parse(got.body) as unknown[], url, opts.businessName), http_status: got.status };
  } catch {
    return { ...parseTxTdlrText(htmlToText(got.body), url), http_status: got.status };
  }
}

export async function resolveTxTdlr(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'tx_tdlr' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  const digits = license.replace(/\D/g, '');
  if (digits) {
    const byLicense = await fetchTdlr(lead, { license: digits }, client);
    if (byLicense.people.length || byLicense.coverage_reason === 'blocked') return byLicense;
  }
  const businessName = lead.company_name?.trim() || '';
  if (businessName) {
    return fetchTdlr(lead, { businessName }, client);
  }
  return { people: [], coverage_reason: digits ? 'not_found' : 'no_license_number', source: 'tx_tdlr', source_url: SEARCH };
}
