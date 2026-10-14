import { isRegistryAgentName, pickBestNameMatchScored, splitPersonName } from './names.js';
import { fetchSodaJson, sodaWhereContains } from './soda.js';
import { lookupBoardRef, upsertBoardRef } from './boardRef.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const PA_BIZ = 'https://data.pa.gov/resource/xvd7-5r2c.json';

const ROLE_RANK: Record<string, number> = {
  president: 100,
  ceo: 95,
  owner: 90,
  member: 85,
  manager: 80,
  governor: 78,
  'managing member': 82,
  treasurer: 70,
  secretary: 65,
  'vice president': 60,
  organizer: 40,
  incorporator: 35,
};

function roleRank(party: string): number {
  return ROLE_RANK[String(party || '').trim().toLowerCase()] ?? 50;
}

export function parsePaOpenDataJson(
  rows: unknown[],
  companyName: string,
  sourceUrl: string,
  city?: string | null,
  zip?: string | null,
): ResolverResult {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object',
  );
  const byFiling = new Map<string, Record<string, unknown>[]>();
  for (const row of list) {
    const id = String(row.filing_number || row.business_name || '');
    const bucket = byFiling.get(id) || [];
    bucket.push(row);
    byFiling.set(id, bucket);
  }
  const entities = [...byFiling.values()].map((officers) => officers[0]!);
  const hit = pickBestNameMatchScored(companyName, entities, (r) => String(r.business_name || ''), {
    allowTrigram: true,
    city,
    zip,
    cityOf: (r) => String(r.city || ''),
    zipOf: (r) => String(r.zip || ''),
  });
  if (!hit) {
    return {
      people: [],
      coverage_reason: list.length ? 'name_miss' : 'not_found',
      source: 'pa_dos',
      source_url: sourceUrl,
    };
  }
  const filing = String(hit.item.filing_number || hit.item.business_name || '');
  const officers = (byFiling.get(filing) || [hit.item])
    .slice()
    .sort((a, b) => roleRank(String(b.party_type || '')) - roleRank(String(a.party_type || '')));
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  for (const rec of officers) {
    const first = String(rec.first_name || '').trim();
    const last = String(rec.last_name || '').trim();
    const raw = [first, last].filter(Boolean).join(' ');
    if (!raw || isRegistryAgentName(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const split = splitPersonName(raw);
    const party = String(rec.party_type || '');
    people.push({
      first_name: split.first_name || first || null,
      last_name: split.last_name || last || null,
      full_name_raw: raw,
      role: /member/i.test(party) ? 'member' : /owner|partner/i.test(party) ? 'owner' : 'officer',
      source: 'pa_dos',
      source_url: sourceUrl,
      confidence: hit.method === 'trigram' ? 'medium' : 'high',
      review_flag: split.review_flag || undefined,
    });
    if (people.length >= 5) break;
  }
  if (!people.length) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source: 'pa_dos',
      source_url: sourceUrl,
      business_name: String(hit.item.business_name || '') || null,
      match_method: hit.method,
      match_score: hit.score,
    };
  }
  return {
    people,
    coverage_reason: null,
    source: 'pa_dos',
    source_url: sourceUrl,
    business_name: String(hit.item.business_name || '') || null,
    match_method: hit.method,
    match_score: hit.score,
  };
}

export async function resolvePaOpenData(lead: OwnerLead): Promise<ResolverResult> {
  const name = lead.company_name?.trim() || '';
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'pa_dos', source_url: PA_BIZ };
  }
  const cached = await lookupBoardRef({
    state: 'PA',
    source: 'pa_dos',
    companyName: name,
    city: lead.city,
  });
  if (cached.length) {
    const fromRef = parsePaOpenDataJson(
      cached.map((r) => ({
        business_name: r.entity_name,
        first_name: r.officer_name.split(/\s+/)[0],
        last_name: r.officer_name.split(/\s+/).slice(-1)[0],
        party_type: r.officer_role,
        city: r.city,
        zip: r.zip,
        filing_number: r.entity_name_norm,
      })),
      name,
      cached[0]?.source_url || PA_BIZ,
      lead.city,
    );
    if (fromRef.people.length) return fromRef;
  }

  const where = sodaWhereContains('business_name', name);
  const got = await fetchSodaJson(PA_BIZ, { where, limit: 50 });
  const parsed = parsePaOpenDataJson(got.rows, name, got.url, lead.city);
  if (parsed.people.length) {
    await upsertBoardRef(
      parsed.people.map((p) => ({
        state: 'PA',
        source: 'pa_dos',
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
