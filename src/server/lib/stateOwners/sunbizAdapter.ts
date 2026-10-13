import { getSunbizEntity, searchSunbizEntities, pickSunbizOwnerOfficer } from '../floridaSunbiz.js';
import { splitPersonName } from './names.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

export async function resolveSunbiz(lead: OwnerLead): Promise<ResolverResult> {
  if (!lead.company_name?.trim()) {
    return { people: [], coverage_reason: 'not_found', source: 'sunbiz', source_url: 'https://search.sunbiz.org' };
  }
  const hits = await searchSunbizEntities(lead.company_name);
  for (const cand of hits) {
    const entity = await getSunbizEntity(cand);
    if (!entity) continue;
    const picked = pickSunbizOwnerOfficer(lead.contact_name || '', entity, lead.company_name);
    if (picked.match === 'none' || !picked.officer?.name) continue;
    const split = splitPersonName(picked.officer.name);
    const role: OwnerPerson['role'] =
      picked.match === 'agent' ? 'registered_agent' : /member/i.test(picked.officer.title || '') ? 'member' : 'officer';
    const person: OwnerPerson = {
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role,
      source: 'sunbiz',
      source_url: cand.detail_url || 'https://search.sunbiz.org',
      confidence: picked.match === 'match' ? 'high' : 'medium',
      review_flag: split.review_flag || undefined,
    };
    return {
      people: [person],
      coverage_reason: null,
      source: 'sunbiz',
      source_url: person.source_url,
    };
  }
  return {
    people: [],
    coverage_reason: hits.length ? 'not_found' : 'not_found',
    source: 'sunbiz',
    source_url: 'https://search.sunbiz.org',
  };
}
