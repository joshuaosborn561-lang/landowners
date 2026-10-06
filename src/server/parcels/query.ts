import { getSupabase, hasSupabase, ingestSecret } from '../lib/supabase.js';
import type { ParcelRecord } from '../types.js';
import {
  parcelMatches,
  rpcParcelFilters,
  sanitizeClientTag,
  type ParcelFilters,
} from './filters.js';
import { assertRegisteredCounty, registeredCounties } from './registry.js';
import { RADIUS_MILES } from './radius.js';
import {
  parcelsSummary as csvSummary,
  queryParcels as csvQuery,
  sampleParcels as csvSample,
  type ParcelQueryResult,
} from '../services/parcels.js';

export interface CountyListing {
  name: string;
  state: string;
  fips: string | null;
  status: string;
  source_type: string;
  source: string | null;
  parser: string;
  refresh_cadence: string;
  inside_60_miles: boolean;
  boundary_miles: number | null;
  row_count: number;
  last_loaded: string | null;
  source_file_date: string | null;
  rows_downloaded: number | null;
  rows_parsed: number | null;
  rows_upserted: number | null;
  notes: string | null;
}

function assertFilters(filters: ParcelFilters): ParcelFilters {
  if (filters.county) assertRegisteredCounty(filters.county, filters.state ?? 'TX');
  return filters;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

export async function parcelsDatabaseCount(): Promise<number | null> {
  if (!hasSupabase()) return null;
  try {
    const data = await rpc<{ count?: number }>('permit_parcel_row_count', { p_secret: ingestSecret() });
    return Number(data?.count ?? 0);
  } catch {
    return null;
  }
}

export async function parcelsCounties(): Promise<{
  radius_miles: number;
  computed: string[];
  missing_from_computed: string[];
  extra_vs_expected: string[];
  needs_request: Array<{ county: string; state: string; source: string | null; notes: string | null }>;
  counties: CountyListing[];
}> {
  const { counties, radius } = registeredCounties();
  const counts = new Map<string, number>();
  const loads = new Map<
    string,
    {
      loaded_at?: string | null;
      source_file_date?: string | null;
      rows_downloaded?: number | null;
      rows_parsed?: number | null;
      rows_upserted?: number | null;
    }
  >();
  if (hasSupabase()) {
    const stats = await rpc<{
      counts?: Array<{ state: string; county: string; row_count: number }>;
      loads?: Array<Record<string, unknown>>;
    }>('permit_parcel_county_stats', { p_secret: ingestSecret() });
    for (const row of stats?.counts ?? []) {
      counts.set(`${row.state}:${row.county}`.toLowerCase(), Number(row.row_count));
    }
    for (const row of stats?.loads ?? []) {
      const key = `${row.state}:${row.county}`.toLowerCase();
      loads.set(key, {
        loaded_at: (row.loaded_at as string) ?? null,
        source_file_date: (row.source_file_date as string) ?? null,
        rows_downloaded: row.rows_downloaded == null ? null : Number(row.rows_downloaded),
        rows_parsed: row.rows_parsed == null ? null : Number(row.rows_parsed),
        rows_upserted: row.rows_upserted == null ? null : Number(row.rows_upserted),
      });
    }
  }
  const listed: CountyListing[] = counties.map((county) => {
    const key = `${county.state}:${county.name}`.toLowerCase();
    const load = loads.get(key);
    return {
      name: county.name,
      state: county.state,
      fips: county.fips,
      status: county.status,
      source_type: county.source_type,
      source: county.source_url,
      parser: county.parser,
      refresh_cadence: county.refresh_cadence,
      inside_60_miles: county.inside_60_miles,
      boundary_miles: county.boundary_miles,
      row_count: counts.get(key) ?? 0,
      last_loaded: load?.loaded_at ?? null,
      source_file_date: load?.source_file_date ?? null,
      rows_downloaded: load?.rows_downloaded ?? null,
      rows_parsed: load?.rows_parsed ?? null,
      rows_upserted: load?.rows_upserted ?? null,
      notes: county.notes ?? null,
    };
  });
  return {
    radius_miles: RADIUS_MILES,
    computed: radius.computed,
    missing_from_computed: radius.missing_from_computed,
    extra_vs_expected: radius.extra_vs_expected,
    needs_request: listed
      .filter((county) => county.status === 'needs_request')
      .map((county) => ({
        county: county.name,
        state: county.state,
        source: county.source,
        notes: county.notes,
      })),
    counties: listed,
  };
}

export async function parcelsSummaryDb(filters: ParcelFilters = {}): Promise<Record<string, unknown>> {
  assertFilters(filters);
  if (!hasSupabase()) {
    const csv = csvSummary();
    return { ...csv, source: 'commercial_csv', note: 'Supabase is not configured; counts are the commercial CSV cache.' };
  }
  const summary = await rpc<Record<string, unknown>>('permit_parcel_summary', {
    p_secret: ingestSecret(),
    p_filters: rpcParcelFilters(filters),
  });
  return {
    ...summary,
    source: 'permit_parcel.parcels',
    query_hint:
      'Counts only. parcels_query returns at most 50 rows. parcels_count sizes a filter. sync_to_supabase writes the matching key set.',
  };
}

export async function parcelsCount(filters: ParcelFilters = {}): Promise<{ count: number; filters: Record<string, unknown> }> {
  assertFilters(filters);
  const body = rpcParcelFilters(filters);
  if (!hasSupabase()) {
    const matched = csvQuery({ ...filters, page: 1, page_size: 1 }).total;
    return { count: matched, filters: body };
  }
  const data = await rpc<{ count?: number }>('permit_parcel_count', {
    p_secret: ingestSecret(),
    p_filters: body,
  });
  return { count: Number(data?.count ?? 0), filters: body };
}

export async function parcelsOwnersCount(filters: ParcelFilters = {}): Promise<{
  owners: number;
  by_owner_type: Record<string, number>;
  by_ptad: Record<string, number>;
  by_county: Record<string, number>;
  filters: Record<string, unknown>;
}> {
  assertFilters(filters);
  const body = rpcParcelFilters(filters);
  if (!hasSupabase()) {
    return { owners: 0, by_owner_type: {}, by_ptad: {}, by_county: {}, filters: body };
  }
  const data = await rpc<{
    owners?: number;
    by_owner_type?: Record<string, number>;
    by_ptad?: Record<string, number>;
    by_county?: Record<string, number>;
  }>('permit_parcel_owners_count', {
    p_secret: ingestSecret(),
    p_filters: body,
  });
  return {
    owners: Number(data?.owners ?? 0),
    by_owner_type: data?.by_owner_type ?? {},
    by_ptad: data?.by_ptad ?? {},
    by_county: data?.by_county ?? {},
    filters: body,
  };
}

function pageArgs(filters: ParcelFilters, cap: number): { limit: number; offset: number; page: number } {
  const pageSize = Math.min(Math.max(filters.page_size ?? 25, 1), cap);
  const page = Math.max(filters.page ?? 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page };
}

export async function parcelsQueryDb(filters: ParcelFilters = {}): Promise<ParcelQueryResult> {
  assertFilters(filters);
  if (!hasSupabase()) return csvQuery(filters);
  const page = pageArgs(filters, 50);
  const data = await rpc<{ total?: number; items?: ParcelRecord[] }>('permit_parcel_query', {
    p_secret: ingestSecret(),
    p_filters: rpcParcelFilters(filters),
    p_limit: page.limit,
    p_offset: page.offset,
  });
  const total = Number(data?.total ?? 0);
  const items = data?.items ?? [];
  return {
    total,
    page: page.page,
    page_size: page.limit,
    total_pages: Math.max(1, Math.ceil(total / page.limit)),
    items: items.slice(0, 50),
  };
}

export async function parcelsSampleDb(n = 20, filters: ParcelFilters = {}): Promise<{
  n: number;
  total_matching: number;
  items: ParcelRecord[];
}> {
  assertFilters(filters);
  const size = Math.min(Math.max(n, 1), 20);
  if (!hasSupabase()) return csvSample(size, filters);
  const data = await rpc<{ total?: number; items?: ParcelRecord[] }>('permit_parcel_sample', {
    p_secret: ingestSecret(),
    p_filters: rpcParcelFilters(filters),
    p_limit: size,
  });
  const items = (data?.items ?? []).slice(0, 20);
  return { n: items.length, total_matching: Number(data?.total ?? 0), items };
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function syncParcelFilterSet(filters: ParcelFilters, clientTag?: string): Promise<{
  client_tag: string;
  rows_deleted: number;
  rows_inserted: number;
  verify_sql: string[];
}> {
  assertFilters(filters);
  if (!hasSupabase()) throw new Error('Supabase is not configured');
  const tag = sanitizeClientTag(clientTag ?? filters.client_tag);
  const body = rpcParcelFilters(filters);
  const data = await rpc<{ rows_deleted?: number; rows_inserted?: number }>('sync_permit_parcel_client_set', {
    p_secret: ingestSecret(),
    p_client_tag: tag,
    p_filters: body,
  });
  const payload = JSON.stringify(body).replace(/'/g, "''");
  return {
    client_tag: tag,
    rows_deleted: Number(data?.rows_deleted ?? 0),
    rows_inserted: Number(data?.rows_inserted ?? 0),
    verify_sql: [
      `select count(*) from permit_parcel.parcel_client_sets where client_tag = ${sqlLiteral(tag)};`,
      `select count(*) from permit_parcel.parcels p where permit_parcel.parcel_matches(p, '${payload}'::jsonb);`,
    ],
  };
}

export { parcelMatches };
