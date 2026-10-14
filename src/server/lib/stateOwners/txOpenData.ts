import { pickBestNameMatchScored, splitPersonName } from './names.js';
import { fetchSodaName } from './soda.js';
import { lookupBoardRef, peopleFromRef, upsertBoardRef } from './boardRef.js';
import { getFranchiseAccount, pickOwnerOfficer } from '../texasComptroller.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const TX_FT = 'https://data.texas.gov/resource/9cir-efmm.json';

export function pickTxFranchiseRow(
  rows: unknown[],
  companyName: string,
  city?: string | null,
  zip?: string | null,
): { taxpayerId: string; name: string; method: 'exact' | 'substring' | 'trigram'; score: number } | null {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object',
  );
  const hit = pickBestNameMatchScored(companyName, list, (r) => String(r.taxpayer_name || ''), {
    allowTrigram: true,
    city,
    zip,
    cityOf: (r) => String(r.taxpayer_city || ''),
    zipOf: (r) => String(r.taxpayer_zip || ''),
  });
  if (!hit) return null;
  const taxpayerId = String(hit.item.taxpayer_number || '').replace(/\D/g, '');
  if (!taxpayerId) return null;
  return {
    taxpayerId,
    name: String(hit.item.taxpayer_name || ''),
    method: hit.method,
    score: hit.score,
  };
}

export async function resolveTxOpenData(lead: OwnerLead): Promise<ResolverResult> {
  const name = lead.company_name?.trim() || '';
  if (!name) {
    return { people: [], coverage_reason: 'not_found', source: 'tx_sos', source_url: TX_FT };
  }
  const cached = await lookupBoardRef({
    state: 'TX',
    source: 'tx_sos',
    companyName: name,
    city: lead.city,
    zip: null,
  });
  if (cached.length) {
    const fromRef = peopleFromRef(cached, name, 'tx_sos', lead.city);
    if (fromRef?.people.length) return fromRef;
  }

  const got = await fetchSodaName(TX_FT, 'taxpayer_name', name, 25);
  const picked = pickTxFranchiseRow(got.rows, name, lead.city);
  if (!picked) {
    return {
      people: [],
      coverage_reason: got.rows.length ? 'name_miss' : 'not_found',
      source: 'tx_sos',
      source_url: got.url,
      http_status: got.status,
    };
  }

  let entity;
  try {
    entity = await getFranchiseAccount(picked.taxpayerId);
  } catch {
    return { people: [], coverage_reason: 'blocked', source: 'tx_sos', blocked: true, http_status: got.status };
  }
  if (!entity) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source: 'tx_sos',
      source_url: got.url,
      business_name: picked.name,
      match_method: picked.method,
      match_score: picked.score,
      http_status: got.status,
    };
  }
  const chosen = pickOwnerOfficer(lead.contact_name || '', entity, name);
  if (!chosen.officer?.name) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source: 'tx_sos',
      source_url: got.url,
      business_name: picked.name,
      match_method: picked.method,
      match_score: picked.score,
      http_status: got.status,
    };
  }
  const split = splitPersonName(chosen.officer.name);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: chosen.match === 'agent' ? 'registered_agent' : 'officer',
    source: 'tx_sos',
    source_url: `https://comptroller.texas.gov/data-search/franchise-tax/${entity.taxpayer_id}`,
    confidence: picked.method === 'trigram' ? 'medium' : 'high',
    review_flag: split.review_flag || undefined,
  };
  await upsertBoardRef([
    {
      state: 'TX',
      source: 'tx_sos',
      entity_name: picked.name || name,
      entity_name_norm: '',
      city: lead.city,
      officer_name: person.full_name_raw,
      officer_role: person.role,
      source_url: person.source_url,
    },
  ]);
  return {
    people: [person],
    coverage_reason: null,
    source: 'tx_sos',
    source_url: person.source_url,
    business_name: picked.name,
    match_method: picked.method,
    match_score: picked.score,
    http_status: got.status,
  };
}
