import { htmlToText, labeledValue, lineStarting, looksLikeSolePropPerson, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const CSLB_ORIGIN = 'https://www.cslb.ca.gov';

export function normalizeCslbLicense(raw: string | null | undefined): string | null {
  // Excel/JSON often stores 981116 as "981116.0". Stripping all non-digits
  // would look up 9811160 — the wrong license.
  const stripped = String(raw || '').trim().replace(/\.0+$/, '');
  const digits = stripped.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 5 || digits.length > 8) return null;
  return digits;
}

const STATUS_CHROME =
  /check provides|before relying|limitations|license database|skip to main|check a license/i;
const STATUS_ACTIVE = /current\s+and\s+active|\bthis license is active\b/i;
const STATUS_INACTIVE = /suspen|expired|revoked|cancel+ed|inactive|lapsed|surrendered/i;

function normalizeStatusPhrase(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Real CSLB status sentence — skip the "License Status check provides…" help chrome. */
export function extractCslbLicenseStatus(text: string): string | null {
  const body = String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const hits: string[] = [];
  const re = /License Status\s*:?\s*([^\n]{0,160})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const cap = normalizeStatusPhrase(m[1] || '');
    if (!cap || STATUS_CHROME.test(cap)) continue;
    hits.push(cap);
  }
  const preferred = hits.find((h) => STATUS_ACTIVE.test(h) || STATUS_INACTIVE.test(h) || /this license is/i.test(h));
  if (preferred) return preferred;
  const fallback =
    body.match(/This license is current and active\.?/i) ||
    body.match(/License is under suspension[^\n]{0,160}/i) ||
    body.match(/This license (?:has )?expired[^\n]{0,80}/i) ||
    body.match(/This license (?:has been )?(?:revoked|cancelled|canceled|surrendered)[^\n]{0,80}/i);
  if (fallback?.[0]) return normalizeStatusPhrase(fallback[0]);
  return hits[0] || null;
}

export function isCslbActiveStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const n = normalizeStatusPhrase(status);
  if (STATUS_CHROME.test(n)) return false;
  return STATUS_ACTIVE.test(n);
}

export function isCslbDetailPage(text: string): boolean {
  const body = String(text || '');
  return /Business Information/i.test(body) && /License Status/i.test(body);
}

export interface CslbParsed {
  business_name: string | null;
  business_phone: string | null;
  entity: string | null;
  license_status: string | null;
  active: boolean;
  people: OwnerPerson[];
  coverage_reason: ResolverResult['coverage_reason'];
}

function phoneFromLine(line: string | null): string | null {
  if (!line) return null;
  const m = line.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0] : null;
}

function personFromRaw(
  raw: string,
  role: OwnerPerson['role'],
  confidence: OwnerPerson['confidence'],
  sourceUrl: string,
  phone: string | null,
): OwnerPerson {
  const split = splitPersonName(raw);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'cslb',
    source_url: sourceUrl,
    confidence,
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
}

/** Parse stripped CSLB license-detail text. */
export function parseCslbText(text: string, sourceUrl = ''): CslbParsed {
  const body = text.replace(/\r/g, '');
  const business_name = labeledValue(body, 'Business Information');
  const phoneLine = lineStarting(body, 'Business Phone Number:');
  const business_phone = phoneFromLine(phoneLine);
  const entity = labeledValue(body, 'Entity');
  const statusLine = extractCslbLicenseStatus(body);
  const license_status = statusLine;
  const missingStatus = !statusLine;
  const active = isCslbActiveStatus(statusLine);

  const people: OwnerPerson[] = [];
  const qi =
    body.match(/The qualifying individual (.+?) certified that he\/she owns 10 percent or more/i) ||
    body.match(/Bond of Qualifying Individual for (.+?)(?:\.|,| Effective| certified|\n|$)/i);

  if (qi?.[1]) {
    people.push(
      personFromRaw(qi[1].trim(), 'qualifying_individual', 'high', sourceUrl, business_phone),
    );
  }

  if (!people.length) {
    const soleOrPartner = /sole ownership|partnership/i.test(entity || '');
    if (soleOrPartner && business_name && looksLikeSolePropPerson(business_name)) {
      people.push(
        personFromRaw(business_name, 'sole_proprietor', 'medium', sourceUrl, business_phone),
      );
    }
  }

  if (missingStatus) {
    return {
      business_name,
      business_phone,
      entity,
      license_status,
      active: false,
      people: [],
      coverage_reason: 'parse_error',
    };
  }

  let coverage_reason: ResolverResult['coverage_reason'] = null;
  if (!active) coverage_reason = 'inactive_license';
  else if (!people.length) {
    const soleOrPartner = /sole ownership|partnership/i.test(entity || '');
    coverage_reason = soleOrPartner && business_name && !looksLikeSolePropPerson(business_name)
      ? 'sole_prop_dba'
      : 'not_found';
  }

  return {
    business_name,
    business_phone,
    entity,
    license_status,
    active,
    people: active ? people : [],
    coverage_reason: active ? (people.length ? null : coverage_reason) : 'inactive_license',
  };
}

export function cslbLicenseUrl(license: string): string {
  return `${CSLB_ORIGIN}/${license}`;
}

export async function resolveCslb(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'cslb', gapMs: 1200, stopAfter: 3 }),
): Promise<ResolverResult> {
  const license = normalizeCslbLicense(lead.license_number);
  if (!license) {
    return {
      people: [],
      coverage_reason: 'no_license_number',
      source: 'cslb',
      source_url: null,
    };
  }
  const url = cslbLicenseUrl(license);
  const key = licenseCacheKey(license);
  const cached = await readBoardCache('cslb', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'cslb', source_url: url, cached: true, http_status: cached.http_status, blocked: true };
    }
    if (cached.http_status !== 200) {
      return { people: [], coverage_reason: 'not_found', source: 'cslb', source_url: url, cached: true, http_status: cached.http_status };
    }
    const parsed = parseCslbText(cached.body, url);
    return { ...toResult(parsed, url, cached.http_status), cached: true };
  }

  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({
    board: 'cslb',
    cache_key: key,
    http_status: got.status,
    body: text,
  });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'cslb', source_url: url, http_status: got.status, blocked: true };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'cslb', source_url: url, http_status: got.status };
  }
  return toResult(parseCslbText(text, url), url, got.status);
}

function toResult(parsed: CslbParsed, url: string, status: number): ResolverResult {
  return {
    people: parsed.people,
    coverage_reason: parsed.coverage_reason,
    source: 'cslb',
    source_url: url,
    license_status: parsed.license_status,
    entity: parsed.entity,
    business_name: parsed.business_name,
    business_phone: parsed.business_phone,
    http_status: status,
  };
}
