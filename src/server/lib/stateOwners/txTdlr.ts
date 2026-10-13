import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SEARCH = 'https://www.tdlr.texas.gov/LicenseSearch/Search.asp';

/** Electrical / HVAC license-ish tokens from PermitStack. */
export function looksLikeTdlrTradeLicense(raw: string | null | undefined): boolean {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return false;
  if (/\b(TECL|TACL|TACLA|ACR|ELCON|MASTER\s*ELEC|JOURNEYMAN|HVAC|ELECTR)/.test(s)) return true;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 5 && digits.length <= 8;
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

export async function resolveTxTdlr(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'tx_tdlr' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  if (!license) {
    return { people: [], coverage_reason: 'no_license_number', source: 'tx_tdlr', source_url: SEARCH };
  }
  const url = `${SEARCH}?Type=LIC&LicNbr=${encodeURIComponent(license)}`;
  const key = licenseCacheKey(license);
  const cached = await readBoardCache('tx_tdlr', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'tx_tdlr', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parseTxTdlrText(cached.body, url), cached: true, http_status: cached.http_status };
  }
  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'tx_tdlr', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'tx_tdlr', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_tdlr', source_url: url, http_status: got.status };
  }
  return { ...parseTxTdlrText(text, url), http_status: got.status };
}
