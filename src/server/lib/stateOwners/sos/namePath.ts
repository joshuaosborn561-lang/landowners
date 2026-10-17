import { normalizeCslbLicense } from '../cslb.js';
import { normalizeState } from '../names.js';
import { resolverForState } from '../router.js';
import type { OwnerLead } from '../types.js';
import { catalogByCode } from './catalog.js';
import {
  caBizfileSourceUrl,
  matchCaBizfileFromPayload,
  searchCaBizfileKeyword,
  type CaBizfileEntity,
} from './caBizfile.js';
import { fetchCaStatementOfficers } from './caSi.js';
import type { LookupContext } from './context.js';
import { caSosApiKeyFromEnv } from './context.js';
import { getIlIndex, matchIlDta, IL_DTA_HOME } from './ilDta.js';
import { resolveHtmlOfficerState } from './htmlStates.js';
import { resolveColoradoAgentOnly, resolveOhioAgentOnly } from './agentStates.js';
import { hitsFromRoster } from './officers.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { agentOnlyHit } from './waterfall.js';

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
  extra?: Partial<NameLookupResult>,
): NameLookupResult {
  return {
    people: [],
    coverage_reason: coverage,
    source,
    implemented: extra?.implemented ?? false,
    ...extra,
  };
}

function withSpend(result: NameLookupResult, usd: number, via: boolean, ocr?: boolean): NameLookupResult {
  return {
    ...result,
    apify_usd: Number(((result.apify_usd || 0) + usd).toFixed(4)),
    via_apify: result.via_apify || via,
    ocr_used: result.ocr_used || ocr,
  };
}

async function resolveCalifornia(input: NameLookupInput, ctx?: LookupContext): Promise<NameLookupResult> {
  const apiKey = ctx?.caApiKey ?? caSosApiKeyFromEnv();
  let payload = ctx?.caPayload;
  if (payload == null && ctx?.live && apiKey) {
    const got = await searchCaBizfileKeyword(input.company_name, apiKey, ctx);
    if (got.status === 401 || got.status === 403 || got.status === 503) {
      return emptyNameResult(input, 'missing_key', 'ca_bizfile', {
        implemented: true,
        source_url: caBizfileSourceUrl(null),
      });
    }
    payload = got.payload;
  }
  if (payload == null) {
    return emptyNameResult(input, apiKey && !ctx?.live ? 'not_found' : 'missing_key', 'ca_bizfile', {
      implemented: true,
      source_url: caBizfileSourceUrl(null),
    });
  }

  const matched = matchCaBizfileFromPayload(input.company_name, input.city, payload);
  if (!matched.entity) {
    return emptyNameResult(input, 'not_found', 'ca_bizfile', {
      implemented: true,
      source_url: matched.source_url,
    });
  }

  const entity: CaBizfileEntity = matched.entity;
  const si = await fetchCaStatementOfficers(entity, ctx);
  const officers = hitsFromRoster(input, si.entries, 'ca_bizfile', si.source_url || matched.source_url, matched.match_method);
  if (officers.length) {
    return withSpend(
      {
        people: officers,
        coverage_reason: null,
        source: 'ca_bizfile',
        source_url: si.source_url || matched.source_url,
        match_method: matched.match_method,
        match_score: matched.match_score,
        entity_id: entity.EntityID || null,
        business_name: entity.EntityName || null,
        implemented: true,
        ocr_used: si.ocr_used,
        via_apify: si.via_apify,
        apify_usd: si.usd,
      },
      0,
      si.via_apify,
      si.ocr_used,
    );
  }

  const agent =
    ctx?.includeAgents === true
      ? agentOnlyHit(input, entity.AgentName || '', 'ca_bizfile', matched.source_url)
      : null;
  return withSpend(
    {
      people: agent ? [agent] : [],
      coverage_reason: 'agent_only',
      source: 'ca_bizfile',
      source_url: matched.source_url,
      match_method: matched.match_method,
      match_score: matched.match_score,
      entity_id: entity.EntityID || null,
      business_name: entity.EntityName || null,
      implemented: true,
      ocr_used: si.ocr_used,
      via_apify: si.via_apify,
      apify_usd: si.usd,
    },
    0,
    si.via_apify,
    si.ocr_used,
  );
}

async function resolveIllinois(input: NameLookupInput, ctx?: LookupContext): Promise<NameLookupResult> {
  const index = getIlIndex(ctx?.ilDtaDir ?? process.env.IL_DTA_DIR, ctx?.ilIndex);
  if (!index || !index.list.length) {
    return emptyNameResult(input, 'no_source', 'us_sos', {
      implemented: true,
      source_url: IL_DTA_HOME,
    });
  }
  const matched = matchIlDta(input, index);
  if (!matched) {
    return emptyNameResult(input, 'not_found', 'us_sos', { implemented: true, source_url: IL_DTA_HOME });
  }
  const people = hitsFromRoster(input, matched.entity.officers, 'us_sos', IL_DTA_HOME, matched.method);
  if (people.length) {
    return {
      people,
      coverage_reason: null,
      source: 'us_sos',
      source_url: IL_DTA_HOME,
      match_method: matched.method,
      match_score: matched.score,
      entity_id: matched.entity.file_number,
      business_name: matched.entity.legal_name,
      implemented: true,
    };
  }
  const agent =
    ctx?.includeAgents === true
      ? agentOnlyHit(input, matched.entity.agent_name || '', 'us_sos', IL_DTA_HOME)
      : null;
  return {
    people: agent ? [agent] : [],
    coverage_reason: 'agent_only',
    source: 'us_sos',
    source_url: IL_DTA_HOME,
    match_method: matched.method,
    match_score: matched.score,
    entity_id: matched.entity.file_number,
    business_name: matched.entity.legal_name,
    implemented: true,
  };
}

export async function resolveNameLookup(
  input: NameLookupInput,
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const company = String(input.company_name || '').trim();
  const state = normalizeState(input.state);
  if (!company || !state) {
    return emptyNameResult(input, 'not_found');
  }

  const entry = catalogByCode().get(state);
  if (!entry) {
    return emptyNameResult(input, 'no_source');
  }

  if (state === 'CA') return resolveCalifornia(input, ctx);
  if (state === 'IL') return resolveIllinois(input, ctx);
  if (state === 'GA' || state === 'NC' || state === 'AZ') {
    return resolveHtmlOfficerState(input, state, ctx);
  }
  if (state === 'OH') return resolveOhioAgentOnly(input);
  if (state === 'CO') return resolveColoradoAgentOnly(input, ctx);

  if (entry.officers === 'agent_only' || entry.officers === 'none') {
    return emptyNameResult(input, entry.officers === 'none' ? 'no_source' : 'agent_only', 'us_sos', {
      source_url: entry.search_url,
      implemented: false,
    });
  }

  return emptyNameResult(input, 'not_implemented', 'us_sos', {
    source_url: entry.search_url,
    implemented: false,
  });
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

export { waterfallHitFromPerson } from './waterfall.js';
