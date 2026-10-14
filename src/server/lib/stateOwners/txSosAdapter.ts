import {
  getFranchiseAccount,
  pickOwnerOfficer,
  rankFranchiseHits,
  searchFranchiseEntities,
} from '../texasComptroller.js';
import { splitPersonName } from './names.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

export async function resolveTxSos(lead: OwnerLead): Promise<ResolverResult> {
  if (!lead.company_name?.trim()) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_sos' };
  }
  let hits: Array<{ taxpayerId: string; name: string }>;
  try {
    hits = await searchFranchiseEntities(lead.company_name);
  } catch {
    return { people: [], coverage_reason: 'blocked', source: 'tx_sos', blocked: true };
  }
  const ranked = rankFranchiseHits(lead.company_name, hits);
  if (!ranked.length && hits.length) {
    return { people: [], coverage_reason: 'name_miss', source: 'tx_sos' };
  }
  for (const cand of ranked) {
    let entity;
    try {
      entity = await getFranchiseAccount(cand.taxpayerId);
    } catch {
      continue;
    }
    if (!entity) continue;
    const picked = pickOwnerOfficer(lead.contact_name || '', entity, lead.company_name);
    if (!picked.officer?.name) continue;
    const split = splitPersonName(picked.officer.name);
    const normalized = cand.score < 100 && cand.score >= 70;
    const person: OwnerPerson = {
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role: picked.match === 'agent' ? 'registered_agent' : 'officer',
      source: 'tx_sos',
      source_url: `https://comptroller.texas.gov/data-search/franchise-tax/${entity.taxpayer_id}`,
      confidence: picked.match === 'match' ? 'high' : normalized ? 'medium' : 'high',
      review_flag: split.review_flag || undefined,
    };
    return {
      people: [person],
      coverage_reason: null,
      source: 'tx_sos',
      source_url: person.source_url,
      match_method: cand.score >= 100 ? 'exact' : cand.score >= 70 ? 'substring' : 'trigram',
      match_score: cand.score,
    };
  }
  return { people: [], coverage_reason: hits.length ? 'name_miss' : 'not_found', source: 'tx_sos' };
}
