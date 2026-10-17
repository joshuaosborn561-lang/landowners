import { normalizeState } from '../lib/stateOwners/names.js';
import {
  apifyEligible,
  catalogByCode,
  catalogInRolloutOrder,
  getJob,
  newJobId,
  ownerYieldPossible,
  putJob,
  resolveNameLookup,
  type BusinessOwnerJobSnapshot,
  type NameLookupInput,
} from '../lib/stateOwners/sos/index.js';

/** Starter plan mid-point from PLAN.md. Compute + residential, media off. */
export const APIFY_USD_PER_BLOCKED_LOOKUP = 0.015;
export const SOS_HTTP_LANES = 4;
/** Existing write gate. Keep well under the 60-connection project cap. */
export const OWNER_LOOKUP_WRITE_CONCURRENCY = 4;
export const PHASE1_WRITES_ENABLED = false;

const FIRST_USE_ASSUMED_TOTAL = 15359;
const FIRST_USE_ASSUMED_CA_SHARE = 0.85;

export interface LookupBusinessOwnerOpts {
  source_table?: string;
  where?: string;
  list_id?: string;
  rows?: NameLookupInput[];
  states?: string[];
  max_rows?: number;
  dry_run?: boolean;
  estimate_only?: boolean;
  include_agents?: boolean;
  job_id?: string;
}

function emptyStateStats() {
  return { attempted: 0, named: 0, agent_only: 0, hit_rate: 0 };
}

export function estimateApifyUsd(inputs: NameLookupInput[]): number {
  const catalog = catalogByCode();
  let blocked = 0;
  for (const row of inputs) {
    const entry = catalog.get(normalizeState(row.state));
    if (!entry) continue;
    if (entry.apify === 'fallback' && ownerYieldPossible(entry.officers)) blocked += 1;
  }
  return Number((blocked * APIFY_USD_PER_BLOCKED_LOOKUP).toFixed(2));
}

export function estimateRuntimeSeconds(rowCount: number, lanes = SOS_HTTP_LANES): number {
  const width = Math.max(1, lanes);
  const secondsPerRow = 2.4;
  return Math.ceil((rowCount * secondsPerRow) / width);
}

export function firstUseEnvelope(): Record<string, unknown> {
  const ca = Math.round(FIRST_USE_ASSUMED_TOTAL * FIRST_USE_ASSUMED_CA_SHARE);
  const other = FIRST_USE_ASSUMED_TOTAL - ca;
  return {
    assumed_total: FIRST_USE_ASSUMED_TOTAL,
    assumed_ca_share: FIRST_USE_ASSUMED_CA_SHARE,
    assumed_ca_rows: ca,
    assumed_other_rows: other,
    note: 'Mix is an assumption (mostly CA). Re-run estimate_only against source_table counts before a live job. No lead names.',
    supabase_pool_cap: 60,
    supabase_project: 'azpapwtnrbzywlnxxecz',
    http_lanes: SOS_HTTP_LANES,
    write_concurrency: OWNER_LOOKUP_WRITE_CONCURRENCY,
    ca_api_usd: 0,
    ca_si_unchallenged_usd: 0,
    ca_si_apify_mid_usd: Number((ca * APIFY_USD_PER_BLOCKED_LOOKUP).toFixed(2)),
    other_apify_mid_if_all_blocked_usd: Number((other * APIFY_USD_PER_BLOCKED_LOOKUP).toFixed(2)),
    runtime_seconds_ca_api_only: estimateRuntimeSeconds(ca),
    apify_usd_per_blocked_lookup: APIFY_USD_PER_BLOCKED_LOOKUP,
  };
}

function namelessSample(result: ReturnType<typeof resolveNameLookup>) {
  return {
    source: result.source,
    coverage_reason: result.coverage_reason,
    implemented: result.implemented,
    match_method: result.match_method ?? null,
    people_count: result.people.length,
    waterfall_ready: result.people.some((p) => p.role !== 'registered_agent' && p.coverage_reason !== 'agent_only'),
  };
}

export async function lookupBusinessOwner(opts: LookupBusinessOwnerOpts): Promise<Record<string, unknown>> {
  const jobId = opts.job_id?.trim() || newJobId();
  const dryRun = opts.dry_run !== false;
  const estimateOnly = opts.estimate_only === true;
  const states = (opts.states || []).map(normalizeState).filter(Boolean);
  const rows = (opts.rows || []).slice(0, Math.max(1, Math.min(opts.max_rows ?? 100, 100)));

  if (estimateOnly) {
    const apifyUsd = rows.length ? estimateApifyUsd(rows) : 0;
    return {
      ok: true,
      job_id: jobId,
      estimate_only: true,
      dry_run: true,
      writes_enabled: PHASE1_WRITES_ENABLED,
      phase: 1,
      rows_in_payload: rows.length,
      source_table: opts.source_table || null,
      where: opts.where ? '(redacted)' : null,
      states: states.length ? states : catalogInRolloutOrder().map((r) => r.code),
      rollout_order: catalogInRolloutOrder().map((r) => r.code),
      apify_estimate_usd: apifyUsd,
      runtime_seconds: estimateRuntimeSeconds(rows.length || FIRST_USE_ASSUMED_TOTAL),
      first_use: firstUseEnvelope(),
      josh_signup: [
        'California SOS BizFile API key (free) at https://calicodev.sos.ca.gov',
        'Optional: CA weekly bulk if it includes Statement of Information officers',
        'Illinois Data Transparency Act Annual Report files (free; do not scrape the search UI)',
        'Confirm Apify CU + residential GB on the existing account',
      ],
      assistant_instructions:
        'Phase 1 estimate only. No SOS calls. No writes. Do not dump company names. Show counts, $ envelope, and what Josh must sign up for.',
    };
  }

  if (opts.source_table && !rows.length) {
    return {
      ok: false,
      job_id: jobId,
      error: 'phase1_scaffold: source_table paging is not implemented. Pass estimate_only=true or wait for Phase 2.',
      writes_enabled: PHASE1_WRITES_ENABLED,
    };
  }

  if (opts.list_id && !rows.length) {
    return {
      ok: false,
      job_id: jobId,
      error: 'phase1_scaffold: list_id fetch is not implemented. Permit lists still use match_state_owners.',
      writes_enabled: PHASE1_WRITES_ENABLED,
    };
  }

  const snapshot: BusinessOwnerJobSnapshot = {
    job_id: jobId,
    status: 'running',
    dry_run: dryRun,
    estimate_only: false,
    processed: 0,
    named: 0,
    agent_only: 0,
    remaining: rows.length,
    hit_rate_by_state: {},
    apify_estimate_usd: estimateApifyUsd(rows),
    writes_enabled: PHASE1_WRITES_ENABLED,
  };
  putJob(snapshot);

  const samples: ReturnType<typeof namelessSample>[] = [];
  for (const row of rows) {
    if (states.length && !states.includes(normalizeState(row.state))) continue;
    const result = resolveNameLookup(row, { includeAgents: opts.include_agents === true });
    const st = normalizeState(row.state) || 'UNK';
    const stats = snapshot.hit_rate_by_state[st] ?? emptyStateStats();
    stats.attempted += 1;
    const named = result.people.some((p) => p.role !== 'registered_agent');
    if (named) stats.named += 1;
    if (result.coverage_reason === 'agent_only') stats.agent_only += 1;
    stats.hit_rate = stats.attempted ? Number((stats.named / stats.attempted).toFixed(3)) : 0;
    snapshot.hit_rate_by_state[st] = stats;
    snapshot.processed += 1;
    if (named) snapshot.named += 1;
    if (result.coverage_reason === 'agent_only') snapshot.agent_only += 1;
    if (samples.length < 10) samples.push(namelessSample(result));
  }
  snapshot.remaining = 0;
  snapshot.status = 'completed';
  putJob(snapshot);

  return {
    ok: true,
    ...snapshot,
    phase: 1,
    sample: samples,
    assistant_instructions: dryRun
      ? 'Phase 1 dry scaffold. Counts only. No SOS HTTP. No Supabase writes. Permit path is still match_state_owners.'
      : 'Phase 1 refuses production writes. Re-run dry_run=true. Enable writes only in Phase 2 after Josh has the CA API key.',
  };
}

export async function getBusinessOwnerJob(jobId: string): Promise<Record<string, unknown>> {
  const id = String(jobId || '').trim();
  if (!id) return { ok: false, error: 'job_id required' };
  const row = getJob(id);
  if (!row) return { ok: false, error: 'job not found', job_id: id };
  return {
    ok: true,
    ...row,
    assistant_instructions: 'Counts and status only. Do not dump names.',
  };
}
