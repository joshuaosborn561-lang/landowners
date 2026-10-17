import { fetchSodaName } from '../soda.js';
import type { LookupContext } from './context.js';
import { pickBestEntityMatch } from './match.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { agentOnlyHit } from './waterfall.js';
import { catalogByCode } from './catalog.js';

export const CO_SOCRATA = 'https://data.colorado.gov/resource/4ykn-tg5h.json';
export const OH_SEARCH = 'https://businesssearch.ohiosos.gov/';

interface CoEntity {
  entityid?: string;
  entitynum?: string;
  entityname?: string;
  principalcity?: string;
  principalzipcode?: string;
  agentfirstname?: string;
  agentlastname?: string;
  agentorganizationname?: string;
  entitystatus?: string;
}

function coAgentName(row: CoEntity): string {
  const org = String(row.agentorganizationname || '').trim();
  if (org) return org;
  return `${row.agentfirstname || ''} ${row.agentlastname || ''}`.replace(/\s+/g, ' ').trim();
}

function emptyAgent(input: NameLookupInput, url: string, extra?: Partial<NameLookupResult>): NameLookupResult {
  return {
    people: [],
    coverage_reason: 'agent_only',
    source: 'us_sos',
    source_url: url,
    implemented: true,
    ...extra,
  };
}

/** Ohio has no ongoing officer roster. Never Apify. */
export async function resolveOhioAgentOnly(input: NameLookupInput): Promise<NameLookupResult> {
  const entry = catalogByCode().get('OH');
  return emptyAgent(input, entry?.search_url || OH_SEARCH, { business_name: input.company_name });
}

/** Colorado Socrata 4ykn-tg5h — entity/city confirm only. Officers are absent from every CO product. */
export async function resolveColoradoAgentOnly(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const sourceUrl = CO_SOCRATA;
  let rows: CoEntity[] = Array.isArray(ctx?.coRows) ? (ctx!.coRows as CoEntity[]) : [];
  if (!rows.length && ctx?.live) {
    try {
      const got = await fetchSodaName(CO_SOCRATA, 'entityname', input.company_name, 25);
      rows = (got.rows || []) as CoEntity[];
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    return emptyAgent(input, sourceUrl);
  }
  const picked = pickBestEntityMatch(input.company_name, rows, {
    legalNameOf: (r) => r.entityname || '',
    city: input.city,
    cityOf: (r) => r.principalcity,
    zipOf: (r) => r.principalzipcode,
    allowTrigram: true,
  });
  if (!picked) return emptyAgent(input, sourceUrl, { coverage_reason: 'not_found' });
  const agentName = coAgentName(picked.item);
  const agent = ctx?.includeAgents === true ? agentOnlyHit(input, agentName, 'us_sos', sourceUrl) : null;
  return {
    people: agent ? [agent] : [],
    coverage_reason: 'agent_only',
    source: 'us_sos',
    source_url: sourceUrl,
    implemented: true,
    match_method: picked.method,
    match_score: picked.score,
    entity_id: String(picked.item.entityid || picked.item.entitynum || ''),
    business_name: picked.item.entityname || null,
  };
}
