import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const DETAIL = 'https://secure.lni.wa.gov/verify/Detail.aspx';
const SEARCH = 'https://secure.lni.wa.gov/verify/';

export function parseWaLniText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  const inactive = /inactive|expired|unregistered|no longer registered|not registered/i.test(body) &&
    !/active/i.test(body);
  const people: OwnerPerson[] = [];

  const governing = body.match(/Governing persons?\s*([\s\S]{0,400}?)(?:License|Insurance|Bond|Workers|Other government|$)/i);
  const block = governing?.[1] || body;
  const nameLines = block
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && /^[A-Z][A-Z .'-]+$/.test(l) && l.split(/\s+/).length >= 2 && l.split(/\s+/).length <= 5);

  const seen = new Set<string>();
  for (const raw of nameLines) {
    if (/WASHINGTON|LABOR|INDUSTR|VERIFY|CONTRACTOR|PRINCIPAL|GOVERNING/i.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const split = splitPersonName(raw);
    people.push({
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role: /sole/i.test(body) ? 'sole_proprietor' : 'officer',
      source: 'wa_lni',
      source_url: sourceUrl,
      confidence: 'high',
      review_flag: split.review_flag || undefined,
    });
  }

  const phoneMatch = body.match(/Business phone[:\s]+(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i);
  if (phoneMatch && people[0]) people[0].business_phone = phoneMatch[1];

  if (inactive && !/current|active registration/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'wa_lni', source_url: sourceUrl };
  }
  if (!people.length) {
    return { people: [], coverage_reason: 'not_found', source: 'wa_lni', source_url: sourceUrl };
  }
  return { people, coverage_reason: null, source: 'wa_lni', source_url: sourceUrl };
}

export async function resolveWaLni(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'wa_lni' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  const url = license
    ? `${DETAIL}?LIC=${encodeURIComponent(license)}`
    : `${SEARCH}`;
  const key = license
    ? licenseCacheKey(license)
    : nameStateCacheKey(lead.company_name, 'WA');

  if (!license && !lead.company_name) {
    return { people: [], coverage_reason: 'no_license_number', source: 'wa_lni', source_url: url };
  }

  const cached = await readBoardCache('wa_lni', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'wa_lni', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parseWaLniText(cached.body, url), cached: true, http_status: cached.http_status };
  }

  let gotUrl = url;
  let got = license
    ? await client.get(url)
    : await client.get(
        `${SEARCH}?SearchType=1&Lic=${encodeURIComponent(lead.company_name)}`,
      );
  if (!license && got.status === 200 && /Detail\.aspx/i.test(got.url)) gotUrl = got.url;

  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'wa_lni', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'wa_lni', source_url: gotUrl, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'wa_lni', source_url: gotUrl, http_status: got.status };
  }
  return { ...parseWaLniText(text, gotUrl), http_status: got.status };
}
