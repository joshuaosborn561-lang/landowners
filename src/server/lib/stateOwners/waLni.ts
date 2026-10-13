import { htmlToText, parseBoardPersonName, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const DETAIL = 'https://secure.lni.wa.gov/verify/Detail.aspx';
const SEARCH = 'https://secure.lni.wa.gov/verify/';
const PRINCIPALS = 'https://data.wa.gov/resource/4xk5-x9j6.json';
const GENERAL = 'https://data.wa.gov/resource/m8qx-ubtq.json';

function personFromRaw(
  raw: string,
  role: OwnerPerson['role'],
  sourceUrl: string,
  phone: string | null,
): OwnerPerson {
  const split = parseBoardPersonName(raw);
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'wa_lni',
    source_url: sourceUrl,
    confidence: 'high',
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
}

export function parseWaLniHtml(html: string, sourceUrl: string): ResolverResult {
  const first = html.match(/id="BusinesOwnersFirstName"[^>]*>([^<]*)/i)?.[1]?.trim() || '';
  const last = html.match(/id="BusinesOwnersLastName"[^>]*>([^<]*)/i)?.[1]?.trim() || '';
  const combined = html.match(/id="BusinesOwnersName"[^>]*>([^<]*)/i)?.[1]?.trim() || '';
  const principal = html.match(/id="principalName"[^>]*>([^<]*)/i)?.[1]?.trim() || '';
  const raw = [first, last].filter(Boolean).join(' ') || combined || principal;
  if (raw) {
    const text = `Governing persons\n${raw}\n`;
    return parseWaLniText(text, sourceUrl);
  }
  return parseWaLniText(htmlToText(html), sourceUrl);
}

export function parseWaLniText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  const inactive =
    /inactive|expired|unregistered|no longer registered|not registered/i.test(body) && !/active/i.test(body);
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

/** Official L&I principal dump on data.wa.gov (`4xk5-x9j6`). */
export function parseWaLniJson(
  rows: unknown[],
  sourceUrl: string,
  extras: { phone?: string | null; status?: string | null } = {},
): ResolverResult {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object',
  );
  const status = String(extras.status || list[0]?.contractorlicensestatus || list[0]?.statuscode || '');
  if (status && /inactive|expired|unregistered|suspended|canceled/i.test(status) && !/active/i.test(status)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'wa_lni', source_url: sourceUrl };
  }
  const seen = new Set<string>();
  const people: OwnerPerson[] = [];
  for (const row of list) {
    const raw = String(row.principalname || row.primaryprincipalname || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(personFromRaw(raw, 'officer', sourceUrl, extras.phone ?? null));
  }
  if (!people.length) {
    return { people: [], coverage_reason: 'not_found', source: 'wa_lni', source_url: sourceUrl };
  }
  return {
    people,
    coverage_reason: null,
    source: 'wa_lni',
    source_url: sourceUrl,
    business_phone: extras.phone ?? people[0]?.business_phone ?? null,
    license_status: status || null,
  };
}

async function sodaJson(
  client: PacedBoardClient,
  url: string,
): Promise<{ status: number; rows: unknown[]; body: string; blocked: boolean }> {
  const got = await client.get(url, { headers: { Accept: 'application/json' } });
  if (looksBlocked(got.status, got.body)) {
    return { status: got.status, rows: [], body: got.body, blocked: true };
  }
  if (got.status !== 200) {
    return { status: got.status, rows: [], body: got.body, blocked: false };
  }
  try {
    const parsed = JSON.parse(got.body) as unknown;
    return { status: got.status, rows: Array.isArray(parsed) ? parsed : [], body: got.body, blocked: false };
  } catch {
    return { status: got.status, rows: [], body: got.body, blocked: false };
  }
}

export async function resolveWaLni(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'wa_lni' }),
): Promise<ResolverResult> {
  const license = String(lead.license_number || '').trim();
  const htmlUrl = license ? `${DETAIL}?LIC=${encodeURIComponent(license)}` : SEARCH;
  const key = license ? licenseCacheKey(license) : nameStateCacheKey(lead.company_name, 'WA');

  if (!license && !lead.company_name) {
    return { people: [], coverage_reason: 'no_license_number', source: 'wa_lni', source_url: htmlUrl };
  }

  const cached = await readBoardCache('wa_lni', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'wa_lni',
        source_url: htmlUrl,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    try {
      const parsed = JSON.parse(cached.body) as { principals?: unknown[]; phone?: string | null; status?: string | null };
      if (parsed && Array.isArray(parsed.principals)) {
        return {
          ...parseWaLniJson(parsed.principals, PRINCIPALS, { phone: parsed.phone, status: parsed.status }),
          cached: true,
          http_status: cached.http_status,
        };
      }
    } catch {
      /* HTML cache */
    }
    return { ...parseWaLniHtml(cached.body, htmlUrl), cached: true, http_status: cached.http_status };
  }

  const sodaUrl = license
    ? `${PRINCIPALS}?contractorlicensenumber=${encodeURIComponent(license)}&$limit=20`
    : `${PRINCIPALS}?$where=${encodeURIComponent(`upper(businessname) like '${lead.company_name.replace(/'/g, "''").toUpperCase()}%'`)}&$limit=20`;
  const principals = await sodaJson(client, sodaUrl);
  if (principals.blocked) {
    await writeBoardCache({ board: 'wa_lni', cache_key: key, http_status: principals.status, body: principals.body });
    return {
      people: [],
      coverage_reason: 'blocked',
      source: 'wa_lni',
      source_url: sodaUrl,
      blocked: true,
      http_status: principals.status,
    };
  }

  let phone: string | null = null;
  let status: string | null = null;
  if (license) {
    const general = await sodaJson(
      client,
      `${GENERAL}?contractorlicensenumber=${encodeURIComponent(license)}&$limit=5`,
    );
    const rec = (general.rows[0] || null) as Record<string, unknown> | null;
    phone = rec ? String(rec.phonenumber || '').trim() || null : null;
    status = rec ? String(rec.contractorlicensestatus || rec.statuscode || '').trim() || null : null;
  }

  if (principals.status === 200 && principals.rows.length) {
    const parsed = parseWaLniJson(principals.rows, sodaUrl, { phone, status });
    await writeBoardCache({
      board: 'wa_lni',
      cache_key: key,
      http_status: principals.status,
      body: JSON.stringify({ principals: principals.rows, phone, status }),
    });
    return { ...parsed, http_status: principals.status };
  }

  // HTML fallback — names are often filled by JS, so this is last resort.
  const got = license
    ? await client.get(htmlUrl)
    : await client.get(`${SEARCH}?SearchType=1&Lic=${encodeURIComponent(lead.company_name)}`);
  await writeBoardCache({ board: 'wa_lni', cache_key: key, http_status: got.status, body: got.body });
  if (looksBlocked(got.status, got.body)) {
    return {
      people: [],
      coverage_reason: 'blocked',
      source: 'wa_lni',
      source_url: got.url || htmlUrl,
      blocked: true,
      http_status: got.status,
    };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'wa_lni', source_url: got.url || htmlUrl, http_status: got.status };
  }
  return { ...parseWaLniHtml(got.body, got.url || htmlUrl), http_status: got.status };
}
