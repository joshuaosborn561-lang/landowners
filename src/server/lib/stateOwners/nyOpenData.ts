import { isRegistryAgentName, pickBestNameMatchScored, splitPersonName } from './names.js';
import { fetchSodaJson, sodaWhereContains } from './soda.js';
import { lookupBoardRef, upsertBoardRef } from './boardRef.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const NY_CORPS = 'https://data.ny.gov/resource/n9v6-gdp6.json';
const NY_CEO = 'https://data.ny.gov/resource/8yw7-5gcp.json';

function personFrom(raw: string, sourceUrl: string): OwnerPerson | null {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || isRegistryAgentName(cleaned)) return null;
  if (/\b(LLC|INC|CORP|LTD|LP|TRUST|COMPANY)\b/i.test(cleaned)) return null;
  const split = splitPersonName(cleaned);
  if (!split.full_name_raw || split.full_name_raw.length < 4) return null;
  return {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'officer',
    source: 'ny_dos',
    source_url: sourceUrl,
    confidence: 'medium',
    review_flag: split.review_flag || undefined,
  };
}

export function parseNyOpenDataJson(
  rows: unknown[],
  companyName: string,
  sourceUrl: string,
  city?: string | null,
): ResolverResult {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object',
  );
  const hit = pickBestNameMatchScored(companyName, list, (r) => String(r.current_entity_name || ''), {
    allowTrigram: true,
    city,
    cityOf: (r) => String(r.location_city || r.dos_process_city || r.county || ''),
  });
  if (!hit) {
    return {
      people: [],
      coverage_reason: list.length ? 'name_miss' : 'not_found',
      source: 'ny_dos',
      source_url: sourceUrl,
    };
  }
  const rec = hit.item;
  const chairman = personFrom(String(rec.chairman_name || ''), sourceUrl);
  const location = personFrom(String(rec.location_name || ''), sourceUrl);
  const people = [chairman, location].filter((p): p is OwnerPerson => Boolean(p));
  if (!people.length) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source: 'ny_dos',
      source_url: sourceUrl,
      business_name: String(rec.current_entity_name || '') || null,
      match_method: hit.method,
      match_score: hit.score,
    };
  }
  return {
    people,
    coverage_reason: null,
    source: 'ny_dos',
    source_url: sourceUrl,
    business_name: String(rec.current_entity_name || '') || null,
    match_method: hit.method,
    match_score: hit.score,
  };
}

export async function resolveNyOpenData(lead: OwnerLead): Promise<ResolverResult> {
  const name = lead.company_name?.trim() || '';
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'ny_dos', source_url: NY_CORPS };
  }
  const cached = await lookupBoardRef({
    state: 'NY',
    source: 'ny_dos',
    companyName: name,
    city: lead.city,
  });
  if (cached.length) {
    const fromRef = parseNyOpenDataJson(
      cached.map((r) => ({
        current_entity_name: r.entity_name,
        chairman_name: r.officer_name,
        location_city: r.city,
      })),
      name,
      cached[0]?.source_url || NY_CORPS,
      lead.city,
    );
    if (fromRef.people.length) return fromRef;
  }

  const where = sodaWhereContains('current_entity_name', name);
  let got = await fetchSodaJson(NY_CORPS, { where, limit: 25 });
  let parsed = parseNyOpenDataJson(got.rows, name, got.url, lead.city);
  if (!parsed.people.length) {
    const ceo = await fetchSodaJson(NY_CEO, { where, limit: 25 });
    if (ceo.status === 200 && ceo.rows.length) {
      got = ceo;
      parsed = parseNyOpenDataJson(ceo.rows, name, ceo.url, lead.city);
    }
  }
  if (parsed.people.length) {
    await upsertBoardRef(
      parsed.people.map((p) => ({
        state: 'NY',
        source: 'ny_dos',
        entity_name: parsed.business_name || name,
        entity_name_norm: '',
        city: lead.city,
        officer_name: p.full_name_raw,
        officer_role: p.role,
        source_url: parsed.source_url || got.url,
      })),
    );
  }
  return { ...parsed, http_status: got.status };
}
