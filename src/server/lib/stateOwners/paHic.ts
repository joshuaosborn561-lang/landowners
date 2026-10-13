import { splitPersonName } from './names.js';
import type { PacedBoardClient } from './http.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

/**
 * Official PA HIC search is https://hicsearch.attorneygeneral.gov/
 * (xlsx download of active registrations is on that same app).
 *
 * No sanctioned open-data / bulk export exists as of 2026-10-13:
 * data.pa.gov has DOS business registrations, not the AG HIC owner list.
 * The search UI is behind Cloudflare Turnstile. We do not bypass Turnstile.
 * Coverage is `blocked` when the challenge shell is served.
 */
export const PA_HIC_SEARCH = 'https://hicsearch.attorneygeneral.gov/';
export const PA_HIC_SOURCE_NOTE =
  'No official HIC open-data or bulk export. hicsearch.attorneygeneral.gov is Turnstile-gated; coverage=blocked.';

export function parsePaHicText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(body)) {
    return { people: [], coverage_reason: 'blocked', source: 'pa_hic', source_url: sourceUrl };
  }
  if (/no records|0 result|not found|no contractor/i.test(body) && !/owner/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: sourceUrl };
  }
  const owner =
    body.match(/Owner[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Owner(?:'s)? Name[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Principal[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  if (!owner?.[1]) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_hic', source_url: sourceUrl };
  }
  const split = splitPersonName(owner[1]);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'owner',
    source: 'pa_hic',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'pa_hic', source_url: sourceUrl };
}

/**
 * Disabled. hicsearch.attorneygeneral.gov is Turnstile-gated.
 * Do not fetch until a solving service is added. PA routes to PA DOS instead.
 */
export async function resolvePaHic(
  _lead?: OwnerLead,
  _client?: PacedBoardClient,
): Promise<ResolverResult> {
  return {
    people: [],
    coverage_reason: 'blocked',
    source: 'pa_hic',
    source_url: PA_HIC_SEARCH,
    blocked: true,
  };
}
