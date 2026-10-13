import { htmlToText, lineAfter, lineStarting, looksLikeSolePropPerson, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const CSLB_ORIGIN = 'https://www.cslb.ca.gov';

export function normalizeCslbLicense(raw: string | null | undefined): string | null {
  const digits = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 5 || digits.length > 8) return null;
  return digits;
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
  const business_name = lineAfter(body, 'Business Information');
  const phoneLine = lineStarting(body, 'Business Phone Number:');
  const business_phone = phoneFromLine(phoneLine);
  const entity = lineAfter(body, 'Entity');
  const statusLine = lineAfter(body, 'License Status') || '';
  const license_status = statusLine || null;
  const active = /current and active/i.test(statusLine);

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
