import type { CountyConfig } from '../countyTypes.js';
import { blankToNull, finiteNumber, type RawParcel } from '../normalize.js';
import { dateFromText } from '../download.js';

interface SocrataPage {
  rows: RawParcel[];
  rawCount: number;
  sourceFileDate: string | null;
}

function col(row: Record<string, unknown>, fieldMap: Record<string, string>, key: string): unknown {
  const name = fieldMap[key];
  if (!name) return null;
  return row[name];
}

function text(row: Record<string, unknown>, fieldMap: Record<string, string>, key: string): string | null {
  const primary = blankToNull(col(row, fieldMap, key) == null ? null : String(col(row, fieldMap, key)));
  if (primary) return primary;
  const fallback = fieldMap[`${key}_fallback`];
  if (!fallback || row[fallback] == null) return null;
  return blankToNull(String(row[fallback]));
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { 'user-agent': 'permits-gcs-parcel-loader/2' } });
  if (!response.ok) throw new Error(`Socrata HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function socrataDatasetCount(sourceUrl: string): Promise<number> {
  const url = new URL(sourceUrl);
  url.searchParams.set('$select', 'count(*)');
  const body = (await fetchJson(url.toString())) as Array<{ count?: string }>;
  const count = Number(body[0]?.count);
  if (!Number.isFinite(count)) throw new Error(`Socrata count was not numeric for ${sourceUrl}`);
  return count;
}

export async function socrataUpdatedAt(datasetId: string | undefined): Promise<string | null> {
  if (!datasetId) return null;
  try {
    const meta = (await fetchJson(`https://data.texas.gov/api/views/${datasetId}.json`)) as {
      rowsUpdatedAt?: number;
    };
    if (!meta.rowsUpdatedAt) return null;
    return new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function mapRow(row: Record<string, unknown>, fieldMap: Record<string, string>): RawParcel {
  const improvement = finiteNumber(text(row, fieldMap, 'improvement_value'));
  return {
    account_id: text(row, fieldMap, 'account_id') ?? '',
    owner_name: text(row, fieldMap, 'owner_name'),
    situs_address: text(row, fieldMap, 'situs_address'),
    situs_city: text(row, fieldMap, 'situs_city'),
    situs_zip: text(row, fieldMap, 'situs_zip'),
    owner_mail_addr1: text(row, fieldMap, 'owner_mail_addr1'),
    owner_mail_addr2: text(row, fieldMap, 'owner_mail_addr2'),
    owner_mail_city: text(row, fieldMap, 'owner_mail_city'),
    owner_mail_state: text(row, fieldMap, 'owner_mail_state'),
    owner_mail_zip: text(row, fieldMap, 'owner_mail_zip'),
    state_use_code: text(row, fieldMap, 'state_use_code'),
    use_desc: text(row, fieldMap, 'use_desc'),
    land_value: finiteNumber(text(row, fieldMap, 'land_value')),
    improvement_value: improvement,
    assessed_value: finiteNumber(text(row, fieldMap, 'assessed_value')),
    year_built: finiteNumber(text(row, fieldMap, 'year_built')),
    acres: finiteNumber(text(row, fieldMap, 'acres')),
    deed_date: text(row, fieldMap, 'deed_date'),
    improved: (improvement ?? 0) > 0 || finiteNumber(text(row, fieldMap, 'year_built')) != null,
  };
}

/** Next $offset, or null when this page is short and paging should stop. */
export function socrataAdvance(offset: number, pageLength: number, limit: number): number | null {
  if (pageLength < limit) return null;
  return offset + pageLength;
}

/**
 * Page a Socrata resource with $limit/$offset until a short page.
 * Caller must compare rows downloaded with socrataDatasetCount.
 */
export async function* iterateSocrata(county: CountyConfig): AsyncGenerator<SocrataPage> {
  if (!county.source_url) throw new Error(`${county.name} has no Socrata source_url`);
  const fieldMap = county.field_map ?? {};
  const limit = county.page_size ?? 50000;
  const order = county.order_by ?? fieldMap.account_id ?? ':id';
  const select = [...new Set(Object.values(fieldMap).filter(Boolean))];
  let offset = 0;
  for (;;) {
    const url = new URL(county.source_url);
    url.searchParams.set('$limit', String(limit));
    url.searchParams.set('$offset', String(offset));
    url.searchParams.set('$order', order);
    if (select.length) url.searchParams.set('$select', select.join(','));
    const body = (await fetchJson(url.toString())) as Array<Record<string, unknown>>;
    if (!Array.isArray(body)) throw new Error(`Socrata page at offset ${offset} was not an array`);
    let sourceFileDate: string | null = null;
    const dateCol = fieldMap.source_date;
    if (dateCol && body[0]?.[dateCol]) sourceFileDate = dateFromText(String(body[0][dateCol]));
    yield {
      rows: body.map((row) => mapRow(row, fieldMap)),
      rawCount: body.length,
      sourceFileDate,
    };
    const next = socrataAdvance(offset, body.length, limit);
    if (next == null) break;
    offset = next;
  }
}
