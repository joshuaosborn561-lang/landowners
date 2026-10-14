import { getSupabase, hasSupabase, ingestSecret } from '../supabase.js';
import { normalizeCompanyName, pickBestNameMatchScored } from './names.js';
import type { BoardSource, OwnerPerson, ResolverResult } from './types.js';

export interface BoardRefOfficer {
  state: string;
  source: BoardSource;
  entity_name: string;
  entity_name_norm: string;
  city?: string | null;
  zip?: string | null;
  officer_name: string;
  officer_role?: string | null;
  license_number?: string | null;
  source_url?: string | null;
}

export async function lookupBoardRef(opts: {
  state: string;
  source?: BoardSource;
  companyName: string;
  city?: string | null;
  zip?: string | null;
}): Promise<BoardRefOfficer[]> {
  if (!hasSupabase()) return [];
  const { data, error } = await getSupabase().rpc('lookup_permit_parcel_board_ref', {
    p_secret: ingestSecret(),
    p_state: opts.state,
    p_source: opts.source ?? null,
    p_name_norm: normalizeCompanyName(opts.companyName),
    p_city: opts.city ?? null,
    p_zip: opts.zip ?? null,
    p_limit: 25,
  });
  if (error || !data) return [];
  const rows = (data as { ok?: boolean; rows?: BoardRefOfficer[] }).rows;
  return Array.isArray(rows) ? rows : [];
}

export async function upsertBoardRef(rows: BoardRefOfficer[]): Promise<void> {
  if (!hasSupabase() || !rows.length) return;
  await getSupabase().rpc('upsert_permit_parcel_board_ref', {
    p_secret: ingestSecret(),
    p_rows: rows.map((r) => ({
      ...r,
      entity_name_norm: r.entity_name_norm || normalizeCompanyName(r.entity_name),
    })),
  });
}

export function peopleFromRef(
  rows: BoardRefOfficer[],
  companyName: string,
  source: BoardSource,
  city?: string | null,
  zip?: string | null,
): ResolverResult | null {
  if (!rows.length) return null;
  const grouped = new Map<string, BoardRefOfficer[]>();
  for (const row of rows) {
    const key = row.entity_name_norm || normalizeCompanyName(row.entity_name);
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  const entities = [...grouped.values()].map((list) => list[0]!);
  const hit = pickBestNameMatchScored(companyName, entities, (r) => r.entity_name, {
    allowTrigram: true,
    city,
    zip,
    cityOf: (r) => r.city,
    zipOf: (r) => r.zip,
  });
  if (!hit) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source,
      match_method: 'trigram',
      match_score: 0,
    };
  }
  const officers = grouped.get(hit.item.entity_name_norm || normalizeCompanyName(hit.item.entity_name)) || [hit.item];
  const people: OwnerPerson[] = [];
  for (const row of officers) {
    const raw = String(row.officer_name || '').trim();
    if (!raw) continue;
    people.push({
      first_name: null,
      last_name: null,
      full_name_raw: raw,
      role: /member/i.test(row.officer_role || '')
        ? 'member'
        : /agent/i.test(row.officer_role || '')
          ? 'registered_agent'
          : /owner|partner/i.test(row.officer_role || '')
            ? 'owner'
            : 'officer',
      source,
      source_url: row.source_url || '',
      confidence: hit.method === 'exact' ? 'high' : hit.method === 'substring' ? 'high' : 'medium',
    });
  }
  if (!people.length) {
    return { people: [], coverage_reason: 'name_miss', source, match_method: hit.method, match_score: hit.score };
  }
  return {
    people,
    coverage_reason: null,
    source,
    source_url: people[0]?.source_url,
    business_name: hit.item.entity_name,
    match_method: hit.method,
    match_score: hit.score,
  };
}
