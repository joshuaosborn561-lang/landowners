import { htmlToText, splitPersonName } from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import { normalizeCompanyName } from './names.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const SEARCH = 'https://apps.dos.ny.gov/publicInquiry/EntityDisplay';
const FALLBACK = 'https://apps.dos.ny.gov/publicInquiry/';

export function parseNyDosText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  const people: OwnerPerson[] = [];
  const officerBlock = body.match(
    /(?:Chief Executive Officer|Officer|Director|Member|Shareholder|Registered Agent)[:\s]+([A-Z][A-Z .'-]{2,60})/gi,
  );
  const seen = new Set<string>();
  for (const hit of officerBlock || []) {
    const name = hit.replace(/^[^:]+:\s*/i, '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (/REGISTERED AGENT|CORPORATION SERVICE|CT CORPORATION|LEGALZOOM/i.test(name)) {
      const split = splitPersonName(name);
      people.push({
        ...splitToPerson(split, 'registered_agent', 'low', sourceUrl),
      });
      continue;
    }
    seen.add(name.toLowerCase());
    const role = /registered agent/i.test(hit) ? 'registered_agent' : /member/i.test(hit) ? 'member' : 'officer';
    people.push(splitToPerson(splitPersonName(name), role, role === 'registered_agent' ? 'low' : 'medium', sourceUrl));
  }
  const real = people.filter((p) => p.role !== 'registered_agent');
  const chosen = real.length ? real : people;
  if (!chosen.length) {
    return { people: [], coverage_reason: 'not_found', source: 'ny_dos', source_url: sourceUrl };
  }
  return { people: chosen, coverage_reason: null, source: 'ny_dos', source_url: sourceUrl };
}

function splitToPerson(
  split: ReturnType<typeof splitPersonName>,
  role: OwnerPerson['role'],
  confidence: OwnerPerson['confidence'],
  sourceUrl: string,
): OwnerPerson {
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'ny_dos',
    source_url: sourceUrl,
    confidence,
    review_flag: split.review_flag || undefined,
  };
}

export async function resolveNyDos(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'ny_dos' }),
): Promise<ResolverResult> {
  const name = normalizeCompanyName(lead.company_name) || lead.company_name;
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'ny_dos', source_url: FALLBACK };
  }
  const url = `${SEARCH}?searchName=${encodeURIComponent(lead.company_name)}`;
  const key = nameStateCacheKey(lead.company_name, 'NY');
  const cached = await readBoardCache('ny_dos', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return { people: [], coverage_reason: 'blocked', source: 'ny_dos', source_url: url, cached: true, blocked: true, http_status: cached.http_status };
    }
    return { ...parseNyDosText(cached.body, url), cached: true, http_status: cached.http_status };
  }
  const got = await client.get(url);
  const text = htmlToText(got.body);
  await writeBoardCache({ board: 'ny_dos', cache_key: key, http_status: got.status, body: text });
  if (looksBlocked(got.status, got.body)) {
    return { people: [], coverage_reason: 'blocked', source: 'ny_dos', source_url: url, blocked: true, http_status: got.status };
  }
  if (got.status !== 200) {
    return { people: [], coverage_reason: 'not_found', source: 'ny_dos', source_url: url, http_status: got.status };
  }
  return { ...parseNyDosText(text, url), http_status: got.status };
}
