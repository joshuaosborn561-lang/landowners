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
  const hits = await searchFranchiseEntities(lead.company_name);
  const ranked = rankFranchiseHits(lead.company_name, hits);
  for (const cand of ranked) {
    const entity = await getFranchiseAccount(cand.taxpayerId);
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
    };
  }
  return { people: [], coverage_reason: 'not_found', source: 'tx_sos' };
}
