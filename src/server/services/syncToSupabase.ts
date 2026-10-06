import { randomUUID } from 'node:crypto';
import { getSupabase, hasSupabase, ingestSecret, SCHEMA } from '../lib/supabase.js';
import { supabaseProjectRef, supabaseTargetMeta } from '../lib/supabaseTarget.js';
import { assertParcelsWritableProject } from '../parcels/guard.js';
import { syncParcelFilterSet } from '../parcels/query.js';
import { type ParcelQuery } from './parcels.js';
import { nationalChainHit } from '../lib/nationalChain.js';
import {
  contractorsToCsv,
  loadShovelsContractors,
  matchingShovelsContractors,
  type ContractorQuery,
} from './shovelsContractors.js';

export interface SyncCounts {
  scrape_job_id: string;
  rows_inserted: number;
  rows_deleted: number;
  export_bytes: number;
  dataset: string;
}

export interface SyncResult {
  ok: boolean;
  supabase_configured: boolean;
  supabase_project: string | null;
  supabase_schema: string;
  dataset: string;
  scrape_job_id: string;
  counts: SyncCounts & Record<string, number | string | boolean | null>;
  verify_sql: string[];
  error?: string;
  assistant_instructions: string;
}

function tagsFor(dataset: string, extra: string[] = []): string[] {
  return ['permit_parcel', dataset, ...extra].filter(Boolean);
}

function baseMeta() {
  return {
    supabase_configured: hasSupabase(),
    ...supabaseTargetMeta(),
  };
}

export async function upsertJob(opts: {
  id: string;
  prompt: string;
  tags: string[];
  requestEstimate: number;
}): Promise<string | null> {
  const { error } = await getSupabase().rpc('ingest_scrape_job', {
    p_secret: ingestSecret(),
    p_job: {
      id: opts.id,
      prompt: opts.prompt,
      tags: opts.tags,
      status: 'completed',
      estimate: {
        total: 0,
        mapsCost: 0,
        llmCost: 0,
        apifyCost: 0,
        requestEstimate: opts.requestEstimate,
      },
      downloadUrl: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  });
  return error ? error.message : null;
}

export async function replaceLeads(
  jobId: string,
  tags: string[],
  rows: Record<string, unknown>[],
): Promise<{ deleted: number; inserted: number; error?: string }> {
  let deleted = 0;
  let inserted = 0;
  if (!rows.length) {
    const { data, error } = await getSupabase().rpc('replace_scrape_leads', {
      p_secret: ingestSecret(),
      p_job_id: jobId,
      p_tags: tags,
      p_rows: [],
    });
    if (error) return { deleted: 0, inserted: 0, error: error.message };
    return {
      deleted: Number((data as { deleted?: number })?.deleted ?? 0),
      inserted: 0,
    };
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (i === 0) {
      const { data, error } = await getSupabase().rpc('replace_scrape_leads', {
        p_secret: ingestSecret(),
        p_job_id: jobId,
        p_tags: tags,
        p_rows: chunk,
      });
      if (error) return { deleted, inserted, error: error.message };
      deleted = Number((data as { deleted?: number })?.deleted ?? 0);
      inserted += Number((data as { inserted?: number })?.inserted ?? chunk.length);
    } else {
      const { data, error } = await getSupabase().rpc('ingest_scrape_leads', {
        p_secret: ingestSecret(),
        p_job_id: jobId,
        p_tags: tags,
        p_rows: chunk,
      });
      if (error) return { deleted, inserted, error: error.message };
      inserted += Number((data as { inserted?: number })?.inserted ?? chunk.length);
    }
  }
  return { deleted, inserted };
}

export async function upsertExport(jobId: string, filename: string, content: string) {
  const { error } = await getSupabase().rpc('upsert_scrape_export', {
    p_secret: ingestSecret(),
    p_job_id: jobId,
    p_filename: filename,
    p_content: content,
  });
  if (error) console.warn('[sync] export failed', error.message);
  return error ? 0 : Buffer.byteLength(content, 'utf8');
}

export async function syncParcelsToSupabase(q: ParcelQuery = {}): Promise<SyncResult> {
  const jobId = `permit-parcels-${randomUUID().slice(0, 8)}`;
  const meta = baseMeta();
  const base: SyncResult = {
    ok: false,
    ...meta,
    supabase_schema: SCHEMA,
    dataset: 'parcels',
    scrape_job_id: jobId,
    counts: {
      scrape_job_id: jobId,
      rows_inserted: 0,
      rows_deleted: 0,
      export_bytes: 0,
      dataset: 'parcels',
      supabase_project: meta.supabase_project,
      supabase_schema: SCHEMA,
    },
    verify_sql: [`select count(*) from permit_parcel.parcels;`],
    assistant_instructions:
      'Parcel sync wrote the matching account keys to permit_parcel.parcel_client_sets. The appraisal roll itself is loaded with parcels_load. Verify with verify_sql count(*) only — do not pull rows into chat.',
  };
  if (!hasSupabase()) return { ...base, error: 'Supabase not configured' };
  try {
    assertParcelsWritableProject();
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const synced = await syncParcelFilterSet(q, q.client_tag);
    return {
      ...base,
      ok: true,
      verify_sql: synced.verify_sql,
      counts: {
        scrape_job_id: jobId,
        rows_inserted: synced.rows_inserted,
        rows_deleted: synced.rows_deleted,
        export_bytes: 0,
        dataset: 'parcels',
        client_tag: synced.client_tag,
        parcels_matched: synced.rows_inserted,
        truncated: false,
        has_more: false,
        county_filter: q.county ?? null,
        supabase_project: meta.supabase_project,
        supabase_schema: SCHEMA,
      },
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncContractorsToSupabase(
  q: ContractorQuery = {},
  list?: { list_name?: string; owner?: string },
): Promise<SyncResult> {
  const jobId = `permit-contractors-${randomUUID().slice(0, 8)}`;
  const meta = baseMeta();
  const owner = (list?.owner || 'shared').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'shared';
  const listName = list?.list_name?.trim() || null;
  const base: SyncResult = {
    ok: false,
    ...meta,
    supabase_schema: SCHEMA,
    dataset: 'shovels_contractors',
    scrape_job_id: jobId,
    counts: {
      scrape_job_id: jobId,
      rows_inserted: 0,
      rows_deleted: 0,
      export_bytes: 0,
      dataset: 'shovels_contractors',
      supabase_project: meta.supabase_project,
      supabase_schema: SCHEMA,
    },
    verify_sql: [
      `select count(*) from public.scrape_leads where job_id = '${jobId}';`,
      `select count(*) from permit_parcel.calling_lists where owner = '${owner}';`,
    ],
    assistant_instructions:
      'Contractor pull wrote to Supabase scrape_leads + calling_lists. Verify with select count(*). Cayden can filter via list_calling_lists / query_calling_list.',
  };
  if (!hasSupabase()) return { ...base, error: 'Supabase not configured' };

  const items = matchingShovelsContractors(q);

  const tags = tagsFor('shovels_contractors', [
    'calling_list',
    `owner:${owner}`,
    q.place ? String(q.place) : '',
    q.has_phone === true ? 'has_phone' : '',
    q.has_email === true ? 'has_email' : '',
  ]);
  const jobErr = await upsertJob({
    id: jobId,
    prompt:
      listName ||
      `Permit & Parcel MCP Shovels contractors sync ${JSON.stringify({ ...q, owner })}`,
    tags,
    requestEstimate: items.length,
  });
  if (jobErr) return { ...base, error: jobErr };

  const leads = items.map((c) => {
    const chain = nationalChainHit(c);
    return {
    place_id: `shovels:${c.id}`,
    name: c.business_name || c.name || '',
    owner_name: c.name || '',
    email: c.email || c.primary_email || '',
    phone: c.phone || c.primary_phone || '',
    website: c.website || '',
    city: c.address_city || '',
    state: c.address_state || 'TX',
    zip: c.address_zip || '',
    rating: '',
    reviews: c.permit_count != null ? String(c.permit_count) : '',
    permit_count: c.permit_count,
    total_job_value: c.total_job_value,
    national_chain: chain.national_chain ? 'true' : 'false',
    national_chain_reason: chain.reason || '',
    category: c.primary_industry || 'commercial_contractor',
    main_category: 'shovels_commercial_contractor',
    maps_url: '',
    in_icp: c.email || c.primary_email ? 'true' : 'false',
    address: c.address_street || '',
    source_pipeline: 'permit_parcel_shovels',
  };
  });

  const { deleted, inserted, error } = await replaceLeads(jobId, tags, leads);
  if (error) return { ...base, error };
  const exportBytes = await upsertExport(jobId, `${jobId}.csv`, contractorsToCsv(items));

  return {
    ...base,
    ok: true,
    counts: {
      scrape_job_id: jobId,
      rows_inserted: inserted,
      rows_deleted: deleted,
      export_bytes: exportBytes,
      dataset: 'shovels_contractors',
      contractors_matched: items.length,
      contractors_loaded: loadShovelsContractors().length,
      truncated: false,
      has_more: false,
      supabase_project: meta.supabase_project,
      supabase_schema: SCHEMA,
    },
  };
}

export async function syncToSupabase(opts: {
  dataset: 'parcels' | 'contractors' | 'all';
  parcel_query?: ParcelQuery;
  contractor_query?: ContractorQuery;
  list_name?: string;
  owner?: string;
}): Promise<{
  ok: boolean;
  supabase_project: string | null;
  supabase_schema: string;
  results: SyncResult[];
}> {
  const results: SyncResult[] = [];
  if (opts.dataset === 'parcels' || opts.dataset === 'all') {
    results.push(await syncParcelsToSupabase(opts.parcel_query ?? {}));
  }
  if (opts.dataset === 'contractors' || opts.dataset === 'all') {
    const contractorSync = await syncContractorsToSupabase(opts.contractor_query ?? {}, {
      list_name: opts.list_name,
      owner: opts.owner,
    });
    results.push(contractorSync);
    if (contractorSync.ok) {
      const { upsertCallingListMeta } = await import('./callingLists.js');
      await upsertCallingListMeta({
        id: contractorSync.scrape_job_id,
        name:
          opts.list_name?.trim() ||
          `Shovels GCs${opts.owner ? ` · ${opts.owner}` : ''}`,
        owner: opts.owner || 'shared',
        source: 'shovels_contractors',
        filters: (opts.contractor_query ?? {}) as Record<string, unknown>,
        row_count: Number(contractorSync.counts.contractors_matched ?? 0),
      });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    supabase_project: supabaseProjectRef(),
    supabase_schema: SCHEMA,
    results,
  };
}
