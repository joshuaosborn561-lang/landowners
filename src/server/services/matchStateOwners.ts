import { randomUUID } from 'node:crypto';
import { getSupabase, hasSupabase, ingestSecret } from '../lib/supabase.js';
import { supabaseTargetMeta } from '../lib/supabaseTarget.js';
import {
  BoardJobStopError,
  personKey,
  resolveLeadByState,
  resolveCslb,
  resolveWaLni,
  resolveNewYork,
  resolveMaCsl,
  resolveMnDli,
  resolvePaHic,
  resolveTexas,
  sampleOwnerRows,
  normalizeState,
  STATE_RESOLVERS,
  type BoardSource,
  type CoverageReason,
  type OwnerLead,
  type OwnerPerson,
  type ResolverResult,
  type StateCode,
} from '../lib/stateOwners/index.js';

export type StateOwnerTool =
  | 'match_state_owners'
  | 'match_california_owners'
  | 'match_washington_owners'
  | 'match_new_york_owners'
  | 'match_massachusetts_owners'
  | 'match_minnesota_owners'
  | 'match_pennsylvania_owners'
  | 'match_texas_tdlr_owners';

const DRY_RUN_CAP = 25;
const LIVE_CAP = 100;

export interface StateOwnerJobOpts {
  list_id: string;
  states?: string[];
  max_rows?: number;
  dry_run?: boolean;
  tool?: StateOwnerTool;
}

interface StateStats {
  attempted: number;
  named: number;
  hit_rate: number;
  coverage: Record<CoverageReason, number>;
}

function emptyCoverage(): Record<CoverageReason, number> {
  return { not_found: 0, inactive_license: 0, no_license_number: 0, sole_prop_dba: 0, blocked: 0 };
}

function emptyStats(): StateStats {
  return { attempted: 0, named: 0, hit_rate: 0, coverage: emptyCoverage() };
}

function bump(stats: Record<string, StateStats>, state: string, named: boolean, reason: CoverageReason | null) {
  const key = state || 'UNK';
  const row = stats[key] ?? emptyStats();
  row.attempted += 1;
  if (named) row.named += 1;
  if (reason) row.coverage[reason] += 1;
  row.hit_rate = row.attempted ? Number((row.named / row.attempted).toFixed(3)) : 0;
  stats[key] = row;
}

async function fetchOwnerLeads(opts: {
  list_id: string;
  states: string[] | null;
  limit: number;
}): Promise<OwnerLead[]> {
  if (!hasSupabase()) throw new Error('Supabase not configured');
  const { data, error } = await getSupabase().rpc('fetch_permit_parcel_owner_leads', {
    p_secret: ingestSecret(),
    p_list_id: opts.list_id,
    p_states: opts.states,
    p_limit: opts.limit,
    p_offset: 0,
  });
  if (error) throw new Error(error.message);
  const payload = data as { ok?: boolean; error?: string; rows?: OwnerLead[] };
  if (payload?.error) throw new Error(payload.error);
  return (payload?.rows ?? []) as OwnerLead[];
}

function pickPerson(people: OwnerPerson[]): OwnerPerson | null {
  const ranked = [...people].sort((a, b) => rankPerson(b) - rankPerson(a));
  return ranked[0] ?? null;
}

function rankPerson(p: OwnerPerson): number {
  const role = { owner: 5, qualifying_individual: 5, sole_proprietor: 4, member: 3, officer: 3, registered_agent: 1 }[
    p.role
  ];
  const conf = p.confidence === 'high' ? 3 : p.confidence === 'medium' ? 2 : 1;
  return role + conf;
}

async function persistOwner(lead: OwnerLead, result: ResolverResult, seen: Set<string>): Promise<number> {
  const unique: OwnerPerson[] = [];
  for (const person of result.people) {
    const id = lead.contractor_id || String(lead.lead_id);
    const key = `${id}|${personKey(person.full_name_raw)}`;
    if (!person.full_name_raw || seen.has(key)) continue;
    seen.add(key);
    unique.push(person);
  }
  const best = pickPerson(unique);
  const { error } = await getSupabase().rpc('upsert_permit_parcel_enrichment', {
    p_secret: ingestSecret(),
    p_rows: [
      {
        list_id: lead.list_id,
        lead_id: lead.lead_id,
        place_id: lead.place_id ?? null,
        company_name: lead.company_name ?? null,
        contact_name: lead.contact_name ?? null,
        phone: lead.phone ?? null,
        email: lead.email ?? null,
        officer_name: best?.full_name_raw ?? null,
        officer_title: best?.role ?? null,
        officer_state: lead.state ?? null,
        officer_city: lead.city ?? null,
        officer_match: best ? 'resolved' : 'none',
        owner_search_name: best?.full_name_raw ?? null,
        people_search: {
          state_owner: {
            source: result.source,
            role: best?.role ?? null,
            confidence: best?.confidence ?? null,
            coverage_reason: result.coverage_reason,
            review_flag: best?.review_flag ?? false,
            people_count: unique.length,
            has_business_phone: Boolean(best?.business_phone),
          },
        },
        evidence: [
          `source=${result.source}`,
          result.coverage_reason ? `coverage=${result.coverage_reason}` : null,
          best?.review_flag ? 'review_flag' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        dial_status: 'needs_enrichment',
        flags: best?.review_flag ? ['review_name'] : [],
      },
    ],
  });
  if (error) throw new Error(error.message);
  return unique.length;
}

function resolverForTool(tool: StateOwnerTool): ((lead: OwnerLead) => Promise<ResolverResult>) | null {
  switch (tool) {
    case 'match_california_owners':
      return resolveCslb;
    case 'match_washington_owners':
      return resolveWaLni;
    case 'match_new_york_owners':
      return resolveNewYork;
    case 'match_massachusetts_owners':
      return resolveMaCsl;
    case 'match_minnesota_owners':
      return resolveMnDli;
    case 'match_pennsylvania_owners':
      return resolvePaHic;
    case 'match_texas_tdlr_owners':
      return resolveTexas;
    default:
      return null;
  }
}

function statesForTool(tool: StateOwnerTool, requested?: string[]): string[] | null {
  const map: Partial<Record<StateOwnerTool, StateCode>> = {
    match_california_owners: 'CA',
    match_washington_owners: 'WA',
    match_new_york_owners: 'NY',
    match_massachusetts_owners: 'MA',
    match_minnesota_owners: 'MN',
    match_pennsylvania_owners: 'PA',
    match_texas_tdlr_owners: 'TX',
  };
  const forced = map[tool];
  if (forced) return [forced];
  if (!requested?.length) return [...STATE_RESOLVERS];
  return requested.map(normalizeState).filter((s) => (STATE_RESOLVERS as string[]).includes(s));
}

export async function matchStateOwners(opts: StateOwnerJobOpts): Promise<Record<string, unknown>> {
  const tool = opts.tool ?? 'match_state_owners';
  const dryRun = opts.dry_run === true;
  const cap = dryRun ? DRY_RUN_CAP : LIVE_CAP;
  const maxRows = Math.min(Math.max(opts.max_rows ?? DRY_RUN_CAP, 1), cap);
  const jobId = `state-owners-${randomUUID().slice(0, 8)}`;
  const listId = opts.list_id.trim();
  if (!listId) return { ok: false, error: 'list_id required', job_id: jobId };

  let leads: OwnerLead[];
  try {
    leads = await fetchOwnerLeads({
      list_id: listId,
      states: statesForTool(tool, opts.states),
      limit: maxRows,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch leads failed', job_id: jobId };
  }

  const resolve = resolverForTool(tool) ?? resolveLeadByState;
  const byState: Record<string, StateStats> = {};
  const results: ResolverResult[] = [];
  const seen = new Set<string>();
  let named = 0;
  let written = 0;
  let stopped: { source: BoardSource; status: number; consecutive: number } | null = null;

  for (const lead of leads) {
    try {
      const result = await resolve(lead);
      results.push(result);
      const st = normalizeState(lead.state);
      const gotName = result.people.length > 0;
      if (gotName) named += 1;
      bump(byState, st, gotName, result.coverage_reason);
      if (!dryRun) {
        written += await persistOwner({ ...lead, list_id: listId }, result, seen);
      } else {
        for (const person of result.people) {
          const id = lead.contractor_id || String(lead.lead_id);
          seen.add(`${id}|${personKey(person.full_name_raw)}`);
        }
      }
    } catch (err) {
      if (err instanceof BoardJobStopError) {
        stopped = { source: err.source, status: err.status, consecutive: err.consecutive };
        break;
      }
      const st = normalizeState(lead.state);
      bump(byState, st, false, 'blocked');
      results.push({
        people: [],
        coverage_reason: 'blocked',
        source: 'cslb',
      });
    }
  }

  return {
    ok: !stopped,
    job_id: jobId,
    ...supabaseTargetMeta(),
    tool,
    dry_run: dryRun,
    processed: results.length,
    named,
    written: dryRun ? 0 : written,
    remaining: Math.max(0, leads.length - results.length),
    hit_rate_by_state: byState,
    sample: sampleOwnerRows(results, 10),
    stopped,
    assistant_instructions: dryRun
      ? 'Dry run only. Counts and coverage reasons. No names. Re-run dry_run=false to write officer names for Email Finder name_company mode.'
      : 'Wrote owner names to contact_enrichment. Counts only — do not dump the list. Feed owner_search_name into Email Finder Waterfall name_company mode.',
  };
}
