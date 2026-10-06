import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isChurchName } from '../parcels/church.js';
import { parcelMatches, type ParcelFilters } from '../parcels/filters.js';
import type { CountyCode, ParcelRecord } from '../types.js';
import { classifyOwnerType } from './ownerType.js';

export interface ParcelQuery extends ParcelFilters {}

export interface ParcelQueryResult {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: ParcelRecord[];
}

let cache: ParcelRecord[] | null = null;
let loadError: string | null = null;

function dataRoot(): string {
  return join(process.cwd(), 'data', 'parcels');
}

/** Minimal CSV parse (quotes + commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function emptyToNull(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

function toNum(v: string | null): number | null {
  if (!v) return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function countyFromFolder(folder: string): CountyCode | null {
  const f = folder.toLowerCase();
  if (f === 'dcad' || f === 'dallas') return 'Dallas';
  if (f === 'tad' || f === 'tarrant') return 'Tarrant';
  if (f === 'ccad' || f === 'collin') return 'Collin';
  return null;
}

/** Stable natural-key id — must match ingest_permit_parcel_parcels upsert key. */
function parcelId(county: CountyCode, accountId: string): string {
  return `${county}:${accountId}`;
}

function loadFile(county: CountyCode, path: string): ParcelRecord[] {
  const text = readFileSync(path, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iAccount = idx('account_id');
  const iOwner = idx('owner_name');
  const iMail = idx('mailing_address');
  const iParcel = idx('parcel_address');
  const iCity = idx('city');
  const iZip = idx('zip');
  const iValue = idx('assessed_value');
  const iUse = idx('use_code');
  const iProp = idx('prop_type');

  const out: ParcelRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r]!;
    const account = emptyToNull(cols[iAccount]);
    const owner = emptyToNull(cols[iOwner]);
    if (!account && !owner) continue;
    const accountId = account || `row-${r}`;
    const ownerName = owner || '';
    // Always classify from owner_name so municipalities leave the unknown bucket.
    const ownerType = classifyOwnerType(ownerName);
    const mailing = emptyToNull(cols[iMail]);
    const parcelAddress = emptyToNull(cols[iParcel]);
    const city = emptyToNull(cols[iCity]);
    const zip = emptyToNull(cols[iZip])?.slice(0, 5) ?? null;
    const useCode = emptyToNull(cols[iUse]);
    const propType = emptyToNull(cols[iProp]) || 'commercial';
    const assessed = toNum(emptyToNull(cols[iValue]));
    out.push({
      id: parcelId(county, accountId),
      county,
      state: 'TX',
      fips: null,
      account_id: accountId,
      owner_name: ownerName,
      mailing_address: mailing,
      parcel_address: parcelAddress,
      city,
      zip,
      assessed_value: assessed,
      use_code: useCode,
      prop_type: propType,
      owner_type: ownerType,
      situs_address: parcelAddress,
      situs_city: city,
      situs_zip: zip,
      owner_mail_addr1: mailing,
      owner_mail_addr2: null,
      owner_mail_city: null,
      owner_mail_state: null,
      owner_mail_zip: null,
      state_use_code: useCode,
      use_desc: propType,
      improved: assessed != null && assessed > 0,
      is_church: isChurchName(ownerName, propType),
      land_value: null,
      improvement_value: null,
      year_built: null,
      acres: null,
      deed_date: null,
      miles_from_dallas: null,
      source: 'commercial_csv',
      loaded_at: null,
    });
  }
  return out;
}

export function loadParcels(): ParcelRecord[] {
  if (cache) return cache;
  const root = dataRoot();
  if (!existsSync(root)) {
    loadError = `Missing parcels data dir: ${root}`;
    cache = [];
    return cache;
  }
  const all: ParcelRecord[] = [];
  for (const folder of readdirSync(root)) {
    const county = countyFromFolder(folder);
    if (!county) continue;
    const csvPath = join(root, folder, 'commercial_parcels.csv');
    if (!existsSync(csvPath)) continue;
    try {
      const rows = loadFile(county, csvPath);
      console.log(`[parcels] loaded ${rows.length} from ${folder}`);
      all.push(...rows);
    } catch (err) {
      console.warn(`[parcels] failed ${csvPath}`, err);
      loadError = err instanceof Error ? err.message : String(err);
    }
  }
  cache = all;
  return cache;
}

function matches(p: ParcelRecord, q: ParcelQuery): boolean {
  return parcelMatches(p, q);
}

function filterAll(q: ParcelQuery): ParcelRecord[] {
  return loadParcels().filter((p) => matches(p, q));
}

export function queryParcels(q: ParcelQuery): ParcelQueryResult {
  const all = filterAll(q);
  const pageSize = Math.min(Math.max(q.page_size ?? 25, 1), 50);
  const page = Math.max(q.page ?? 1, 1);
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
  const start = (page - 1) * pageSize;
  return {
    total: all.length,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    items: all.slice(start, start + pageSize),
  };
}

export function sampleParcels(n = 20, q: ParcelQuery = {}) {
  const all = filterAll(q);
  const size = Math.min(Math.max(n, 1), 20);
  const copy = [...all];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return { n: size, total_matching: all.length, items: copy.slice(0, size) };
}

export function parcelsSummary(): Record<string, unknown> {
  const all = loadParcels();
  const byCounty: Record<string, number> = {};
  const byOwnerType: Record<string, number> = {};
  let withValue = 0;
  let valueSum = 0;
  for (const p of all) {
    byCounty[p.county] = (byCounty[p.county] || 0) + 1;
    byOwnerType[p.owner_type] = (byOwnerType[p.owner_type] || 0) + 1;
    if (p.assessed_value != null) {
      withValue += 1;
      valueSum += p.assessed_value;
    }
  }
  return {
    loaded: all.length > 0,
    load_error: loadError,
    total_parcels: all.length,
    counties: byCounty,
    owner_type: byOwnerType,
    with_assessed_value: withValue,
    assessed_value_sum: Math.round(valueSum),
    sources: {
      Dallas: 'DCAD commercial extract',
      Tarrant: 'TAD PropertyData commercial',
      Collin: 'CCAD Socrata commercial',
    },
    query_hint:
      'Use parcels_query (max 50/page). Full matching sets sync to Supabase via sync_to_supabase — do not dump rows into chat.',
  };
}

export function parcelsToCsv(rows: ParcelRecord[]): string {
  const headers: (keyof ParcelRecord)[] = [
    'county',
    'account_id',
    'owner_name',
    'owner_type',
    'mailing_address',
    'parcel_address',
    'city',
    'zip',
    'assessed_value',
    'use_code',
    'prop_type',
  ];
  const esc = (v: string | number | boolean | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join(
    '\n',
  );
}

export type ParcelSyncCollection = {
  /** Rows after filter, before natural-key dedupe (CSV may contain dups). */
  source_rows: number;
  /** Unique (county, account_id) rows to upsert. */
  parcels: ParcelRecord[];
  duplicates_collapsed: number;
};

/**
 * All matching rows for server-side sync (not for MCP chat dumps).
 * No silent cap — callers must sync the full matching set or paginate explicitly.
 * Dedupes on (county, account_id) so upsert chunks never hit
 * "ON CONFLICT DO UPDATE command cannot affect row a second time".
 */
export function collectParcelsForSync(q: ParcelQuery): ParcelSyncCollection {
  const matched = filterAll(q);
  const byKey = new Map<string, ParcelRecord>();
  for (const p of matched) {
    const key = `${p.county}\0${p.account_id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, p);
      continue;
    }
    // Prefer the row with more filled fields / higher assessed value.
    const score = (x: ParcelRecord) =>
      (x.assessed_value != null ? 4 : 0) +
      (x.mailing_address ? 2 : 0) +
      (x.parcel_address ? 1 : 0) +
      (x.assessed_value ?? 0) / 1e12;
    if (score(p) >= score(prev)) byKey.set(key, p);
  }
  const parcels = [...byKey.values()];
  return {
    source_rows: matched.length,
    parcels,
    duplicates_collapsed: matched.length - parcels.length,
  };
}
