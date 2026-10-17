import { normalizeCslbLicense } from '../cslb.js';
import { normalizeState } from '../names.js';
import { resolverForState } from '../router.js';
import type { OwnerLead } from '../types.js';
import { catalogByCode } from './catalog.js';
import { matchCaBizfileFromPayload } from './caBizfile.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { agentOnlyHit, waterfallHitFromPerson } from './waterfall.js';

export function hasPermitLicense(input: NameLookupInput): boolean {
  const st = normalizeState(input.state);
  if (st === 'CA') return Boolean(normalizeCslbLicense(input.license_number));
  return Boolean(String(input.license_number || '').trim());
}

/**
 * Permit path stays on license-board resolvers. Name path does not call them
 * unless a license number is actually present (CSLB still needs one).
 */
export function permitResolverStillRequired(state: string): boolean {
  return Boolean(resolverForState(state));
}

export function emptyNameResult(
  input: NameLookupInput,
  coverage: NameLookupResult['coverage_reason'],
  source: NameLookupResult['source'] = 'us_sos',
): NameLookupResult {
  return {
    people: [],
    coverage_reason: coverage,
    source,
    implemented: false,
  };
}

export function resolveNameLookup(
  input: NameLookupInput,
  opts?: { caPayload?: unknown; includeAgents?: boolean },
): NameLookupResult {
  const company = String(input.company_name || '').trim();
  const state = normalizeState(input.state);
  if (!company || !state) {
    return emptyNameResult(input, 'not_found');
  }

  const entry = catalogByCode().get(state);
  if (!entry) {
    return emptyNameResult(input, 'no_source');
  }

  if (state === 'CA') {
    if (opts?.caPayload == null) {
      return {
        people: [],
        coverage_reason: 'not_implemented',
        source: 'ca_bizfile',
        source_url: entry.search_url,
        implemented: false,
      };
    }
    const matched = matchCaBizfileFromPayload(company, input.city, opts.caPayload);
    if (!matched.entity) {
      return {
        people: [],
        coverage_reason: 'not_found',
        source: 'ca_bizfile',
        source_url: matched.source_url,
        implemented: true,
      };
    }
    const agent =
      opts?.includeAgents === true
        ? agentOnlyHit(input, matched.entity.AgentName || '', 'ca_bizfile', matched.source_url)
        : null;
    return {
      people: agent ? [agent] : [],
      coverage_reason: 'agent_only',
      source: 'ca_bizfile',
      source_url: matched.source_url,
      match_method: matched.match_method,
      match_score: matched.match_score,
      entity_id: matched.entity.EntityID || null,
      business_name: matched.entity.EntityName || null,
      implemented: true,
    };
  }

  if (entry.officers === 'agent_only' || entry.officers === 'none') {
    return {
      people: [],
      coverage_reason: entry.officers === 'none' ? 'no_source' : 'agent_only',
      source: 'us_sos',
      source_url: entry.search_url,
      implemented: false,
    };
  }

  return {
    people: [],
    coverage_reason: 'not_implemented',
    source: 'us_sos',
    source_url: entry.search_url,
    implemented: false,
  };
}

export function leadToNameInput(lead: OwnerLead): NameLookupInput {
  return {
    company_name: lead.company_name,
    city: lead.city,
    state: lead.state || '',
    license_number: lead.license_number,
    list_id: lead.list_id,
    lead_id: lead.lead_id,
  };
}

export { waterfallHitFromPerson };
