import { randomUUID } from 'node:crypto';
import {
  createLimiter,
  mapPool,
  SUPABASE_WRITE_CONCURRENCY,
} from '../lib/retry.js';
import { getSupabase, hasSupabase, ingestSecret } from '../lib/supabase.js';
import { supabaseTargetMeta } from '../lib/supabaseTarget.js';
import {
  BoardJobStopError,
  COVERAGE_REASONS,
  personKey,
  resolveLeadByState,
  resolveCslb,
  resolveWaLni,
  resolveNewYork,
  resolveMaCsl,
  resolveMnDli,
  resolvePaDos,
  resolveTexas,
  sampleOwnerRows,
  sourceForState,
  normalizeState,
  STATE_RESOLVERS,
  type BoardSource,
  type CoverageReason,
  type OwnerLead,
  type OwnerPerson,
  type ResolverResult,
  type SampleOwnerRow,
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

const DEFAULT_ROWS = 25;
const DRY_RUN_CAP = 100;
const LIVE_CAP = 100;
const DEFAULT_BOARD_LANES = 6;
const MAX_BOARD_LANES = 10;

export type StoppedBoard = { source: BoardSource; status: number; consecutive: number };

export function clampOwnerRows(maxRows: number | undefined, dryRun: boolean): number {
  const cap = dryRun ? DRY_RUN_CAP : LIVE_CAP;
  return Math.min(Math.max(maxRows ?? DEFAULT_ROWS, 1), cap);
}

/** BOARD_LANES: default 6, minimum 1, cap 10. Invalid values fall back to 6. */
export function boardLaneCount(raw: string | undefined = process.env.BOARD_LANES): number {
  if (raw == null || raw.trim() === '') return DEFAULT_BOARD_LANES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BOARD_LANES;
  return Math.min(MAX_BOARD_LANES, Math.floor(n));
}

export function personSeenKey(lead: OwnerLead, fullName: string): string {
  const id = lead.contractor_id || String(lead.lead_id);
  return `${id}|${personKey(fullName)}`;
}

/** Claim a dedup key once. Sync so parallel board groups cannot double-write the same person. */
export function claimSeenKey(seen: Set<string>, key: string): boolean {
  if (!key || seen.has(key)) return false;
  seen.add(key);
  return true;
}

export interface BoardLeadGroup {
  source: BoardSource;
  items: Array<{ lead: OwnerLead; index: number }>;
}

export function groupLeadsByBoardSource(leads: OwnerLead[]): BoardLeadGroup[] {
  const groups = new Map<BoardSource, Array<{ lead: OwnerLead; index: number }>>();
  const order: BoardSource[] = [];
  for (let i = 0; i < leads.length; i += 1) {
    const lead = leads[i]!;
    const source = sourceForState(lead.state || '', lead.city);
    let items = groups.get(source);
    if (!items) {
      items = [];
      groups.set(source, items);
      order.push(source);
    }
    items.push({ lead, index: i });
  }
  return order.map((source) => ({ source, items: groups.get(source)! }));
}

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
  return Object.fromEntries(COVERAGE_REASONS.map((r) => [r, 0])) as Record<CoverageReason, number>;
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
    if (!person.full_name_raw) continue;
    if (!claimSeenKey(seen, personSeenKey(lead, person.full_name_raw))) continue;
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
      return resolvePaDos;
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

export interface OwnerMatchLoopOpts {
  leads: OwnerLead[];
  resolve: (lead: OwnerLead) => Promise<ResolverResult>;
  dryRun: boolean;
  listId: string;
  lanes?: number;
  persist?: (lead: OwnerLead, result: ResolverResult, seen: Set<string>) => Promise<number>;
  writeConcurrency?: number;
}

export interface OwnerMatchLoopResult {
  processed: number;
  named: number;
  written: number;
  remaining: number;
  hit_rate_by_state: Record<string, StateStats>;
  status_histogram: Record<string, number>;
  sample: SampleOwnerRow[];
  stopped: StoppedBoard[];
  results: ResolverResult[];
}

function recordMatch(
  byState: Record<string, StateStats>,
  statusHistogram: Record<string, number>,
  lead: OwnerLead,
  result: ResolverResult,
): boolean {
  const st = normalizeState(lead.state);
  const gotName = result.people.length > 0;
  bump(byState, st, gotName, result.coverage_reason);
  const phrase = result.license_status
    ? result.license_status.replace(/\s+/g, ' ').trim()
    : `(${result.coverage_reason || 'named_no_status'})`;
  statusHistogram[phrase] = (statusHistogram[phrase] || 0) + 1;
  return gotName;
}

function claimPeople(lead: OwnerLead, result: ResolverResult, seen: Set<string>): void {
  for (const person of result.people) {
    if (!person.full_name_raw) continue;
    claimSeenKey(seen, personSeenKey(lead, person.full_name_raw));
  }
}

/**
 * Group leads by board source, run up to `lanes` groups in parallel, and keep each
 * group sequential (1.2s paced client + stop-after-3). A BoardJobStopError ends
 * only that group; other boards keep going. Results are reassembled in lead order.
 */
export async function runOwnerMatchLoop(opts: OwnerMatchLoopOpts): Promise<OwnerMatchLoopResult> {
  const leads = opts.leads;
  const lanes = Math.max(1, Math.min(MAX_BOARD_LANES, Math.floor(opts.lanes ?? boardLaneCount()) || 1));
  const persist = opts.persist;
  const writeGate = createLimiter(opts.writeConcurrency ?? SUPABASE_WRITE_CONCURRENCY);
  const groups = groupLeadsByBoardSource(leads);
  const slots: Array<ResolverResult | undefined> = new Array(leads.length);
  const byState: Record<string, StateStats> = {};
  const statusHistogram: Record<string, number> = {};
  const seen = new Set<string>();
  const stopped: StoppedBoard[] = [];
  let named = 0;
  let written = 0;

  await mapPool(groups, lanes, async (group) => {
    for (const { lead, index } of group.items) {
      try {
        const result = await opts.resolve(lead);
        slots[index] = result;
        if (recordMatch(byState, statusHistogram, lead, result)) named += 1;
        if (!opts.dryRun && persist) {
          const n = await writeGate(() => persist({ ...lead, list_id: opts.listId }, result, seen));
          written += n;
        } else {
          claimPeople(lead, result, seen);
        }
      } catch (err) {
        if (err instanceof BoardJobStopError) {
          stopped.push({ source: err.source, status: err.status, consecutive: err.consecutive });
          return;
        }
        const blocked: ResolverResult = {
          people: [],
          coverage_reason: 'blocked',
          source: 'cslb',
        };
        slots[index] = blocked;
        bump(byState, normalizeState(lead.state), false, 'blocked');
      }
    }
  });

  const results = slots.filter((row): row is ResolverResult => row != null);
  return {
    processed: results.length,
    named,
    written: opts.dryRun ? 0 : written,
    remaining: Math.max(0, leads.length - results.length),
    hit_rate_by_state: byState,
    status_histogram: statusHistogram,
    sample: sampleOwnerRows(results, 10),
    stopped,
    results,
  };
}

export async function matchStateOwners(opts: StateOwnerJobOpts): Promise<Record<string, unknown>> {
  const tool = opts.tool ?? 'match_state_owners';
  const dryRun = opts.dry_run === true;
  const maxRows = clampOwnerRows(opts.max_rows, dryRun);
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
  const loop = await runOwnerMatchLoop({
    leads,
    resolve,
    dryRun,
    listId,
    lanes: boardLaneCount(),
    persist: persistOwner,
  });

  return {
    ok: loop.stopped.length === 0,
    job_id: jobId,
    ...supabaseTargetMeta(),
    tool,
    dry_run: dryRun,
    processed: loop.processed,
    named: loop.named,
    written: dryRun ? 0 : loop.written,
    remaining: loop.remaining,
    hit_rate_by_state: loop.hit_rate_by_state,
    status_histogram: loop.status_histogram,
    sample: loop.sample,
    stopped: loop.stopped,
    assistant_instructions: dryRun
      ? 'Dry run only. Counts and coverage reasons. No names. Re-run dry_run=false to write officer names for Email Finder name_company mode.'
      : 'Wrote owner names to contact_enrichment. Counts only — do not dump the list. Feed owner_search_name into Email Finder Waterfall name_company mode.',
  };
}
