import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSupabase, hasSupabase, ingestSecret } from '../lib/supabase.js';
import type { ParcelRecord } from '../types.js';
import { assertParcelsWritableProject } from './guard.js';
import { toParcelRecord, type RawParcel } from './normalize.js';
import { findRegisteredCounty } from './registry.js';
import { loadZipCentroids, milesForZip } from './zipCentroids.js';
import type { RegisteredCounty } from './countyTypes.js';
import { openArcgis } from './parsers/arcgis.js';
import { openDbf } from './parsers/dbf.js';
import { openDcad } from './parsers/dcad.js';
import { openDelimited } from './parsers/delimited.js';
import { openPacs } from './parsers/pacs.js';
import { iterateSocrata, socrataDatasetCount, socrataUpdatedAt } from './parsers/socrata.js';

export interface LoadCountyResult {
  ok: boolean;
  skipped?: boolean;
  status: string;
  county: string;
  state: string;
  rows_downloaded: number;
  rows_parsed: number;
  rows_upserted: number;
  source_file_date: string | null;
  source_file_name: string | null;
  error?: string;
}

interface Opened {
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}

const BATCH = Number(process.env.PARCEL_UPSERT_BATCH || 250);

function dedupe(rows: ParcelRecord[]): ParcelRecord[] {
  const map = new Map<string, ParcelRecord>();
  for (const row of rows) map.set(`${row.county}\0${row.account_id}`, row);
  return [...map.values()];
}

async function upsertBatch(rows: ParcelRecord[]): Promise<number> {
  if (!rows.length) return 0;
  assertParcelsWritableProject();
  const { data, error } = await getSupabase().rpc('ingest_permit_parcel_parcels', {
    p_secret: ingestSecret(),
    p_rows: rows,
  });
  if (error) throw new Error(`ingest_permit_parcel_parcels failed: ${error.message}`);
  const upserted = Number((data as { upserted?: number })?.upserted ?? 0);
  return upserted;
}

async function upsertAll(rows: ParcelRecord[]): Promise<number> {
  const unique = dedupe(rows);
  let n = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    n += await upsertBatch(unique.slice(i, i + BATCH));
  }
  return n;
}

async function recordLoad(county: RegisteredCounty, result: LoadCountyResult): Promise<void> {
  if (!hasSupabase()) return;
  assertParcelsWritableProject();
  const { error } = await getSupabase().rpc('record_permit_parcel_county_load', {
    p_secret: ingestSecret(),
    p_row: {
      state: county.state,
      county: county.name,
      source_type: county.source_type,
      source_url: county.source_url,
      parser: county.parser,
      status: result.ok ? county.status : 'error',
      source_file_date: result.source_file_date,
      source_file_name: result.source_file_name,
      rows_downloaded: result.rows_downloaded,
      rows_parsed: result.rows_parsed,
      rows_upserted: result.rows_upserted,
      notes: result.error || county.notes || null,
    },
  });
  if (error) console.warn(`[parcels] county load log failed for ${county.name}: ${error.message}`);
}

function logLoad(result: LoadCountyResult): void {
  console.log(
    `[parcels] ${result.state} ${result.county} status=${result.status} source_file_date=${result.source_file_date ?? 'unknown'} file=${result.source_file_name ?? 'none'} downloaded=${result.rows_downloaded} parsed=${result.rows_parsed} upserted=${result.rows_upserted}`,
  );
}

async function openActive(county: RegisteredCounty, workDir: string): Promise<Opened> {
  switch (county.parser) {
    case 'dcad':
      return openDcad(county, workDir);
    case 'delimited':
      return openDelimited(county, workDir);
    case 'pacs':
      return openPacs(county, workDir);
    case 'arcgis_attributes':
      return openArcgis(county);
    case 'gis_dbf':
      return openDbf(county, workDir);
    case 'socrata':
      throw new Error('socrata is paged separately');
    case 'vendor_api':
      throw new Error('vendor_api must be rejected before download');
    default:
      throw new Error(`${county.name} parser ${county.parser} has no adapter`);
  }
}

async function loadSocrata(
  county: RegisteredCounty,
  miles: (zip: string | null) => number | null,
  loadedAt: string,
): Promise<LoadCountyResult> {
  if (!county.source_url) throw new Error(`${county.name} has no Socrata source_url`);
  const expected = await socrataDatasetCount(county.source_url);
  const updatedAt = await socrataUpdatedAt(county.dataset_id);
  let downloaded = 0;
  let parsed = 0;
  let upserted = 0;
  let sourceFileDate = updatedAt;
  for await (const page of iterateSocrata(county)) {
    downloaded += page.rawCount;
    if (page.sourceFileDate) sourceFileDate = page.sourceFileDate;
    const records: ParcelRecord[] = [];
    for (const raw of page.rows) {
      const record = toParcelRecord(county, raw, miles, loadedAt);
      if (record) records.push(record);
    }
    parsed += records.length;
    upserted += await upsertAll(records);
  }
  if (downloaded !== expected) {
    throw new Error(
      `${county.name} Socrata download stopped at ${downloaded} rows; the dataset count is ${expected}.`,
    );
  }
  if (parsed > 0 && upserted === 0) {
    throw new Error(`${county.name}: rows_parsed=${parsed} but rows_upserted=0`);
  }
  return {
    ok: true,
    status: county.status,
    county: county.name,
    state: county.state,
    rows_downloaded: downloaded,
    rows_parsed: parsed,
    rows_upserted: upserted,
    source_file_date: sourceFileDate,
    source_file_name: county.dataset_id ?? county.source_url,
  };
}

/**
 * Download and upsert one registered county. Idempotent on (county, account_id).
 * needs_request counties are skipped. vendor_api never places a network call.
 */
export async function loadCounty(name: string, state = 'TX'): Promise<LoadCountyResult> {
  const county = findRegisteredCounty(name, state);
  const base = {
    status: county.status,
    county: county.name,
    state: county.state,
    rows_downloaded: 0,
    rows_parsed: 0,
    rows_upserted: 0,
    source_file_date: null as string | null,
    source_file_name: null as string | null,
  };

  if (county.parser === 'vendor_api' || county.source_type === 'vendor_api') {
    const result: LoadCountyResult = {
      ...base,
      ok: false,
      error: `${county.name} source_type vendor_api has no vendor wired. No request was sent.`,
    };
    logLoad(result);
    return result;
  }

  if (county.status === 'needs_request' || county.parser === 'open_records') {
    const result: LoadCountyResult = { ...base, ok: true, skipped: true, status: 'needs_request' };
    logLoad(result);
    await recordLoad(county, result);
    return result;
  }

  const centroids = await loadZipCentroids();
  const miles = (zip: string | null) => milesForZip(centroids, zip);
  const loadedAt = new Date().toISOString();
  const workDir = await mkdtemp(join(tmpdir(), `parcels-${county.state}-${county.name}-`));

  try {
    let result: LoadCountyResult;
    if (county.parser === 'socrata') {
      result = await loadSocrata(county, miles, loadedAt);
    } else {
      const opened = await openActive(county, workDir);
      const pending: ParcelRecord[] = [];
      let parsed = 0;
      let upserted = 0;
      for await (const raw of opened.rows) {
        const record = toParcelRecord(county, raw, miles, loadedAt);
        if (!record) continue;
        pending.push(record);
        parsed += 1;
        if (pending.length >= BATCH * 4) {
          upserted += await upsertAll(pending);
          pending.length = 0;
        }
      }
      upserted += await upsertAll(pending);
      const downloaded = opened.rowsDownloaded();
      if (parsed > 0 && upserted === 0) {
        throw new Error(`${county.name}: rows_parsed=${parsed} but rows_upserted=0`);
      }
      result = {
        ok: true,
        status: county.status,
        county: county.name,
        state: county.state,
        rows_downloaded: downloaded,
        rows_parsed: parsed,
        rows_upserted: upserted,
        source_file_date: opened.sourceFileDate,
        source_file_name: opened.sourceFileName,
      };
    }
    logLoad(result);
    await recordLoad(county, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed: LoadCountyResult = { ...base, ok: false, error: message };
    logLoad(failed);
    await recordLoad(county, failed).catch(() => undefined);
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
