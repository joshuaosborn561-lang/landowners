import { isRegistryAgentName } from '../names.js';
import type { CoverageReason } from '../types.js';
import { pickBestEntityMatch } from './match.js';

export const CA_BIZFILE_KEYWORD =
  'https://calico.sos.ca.gov/cbc/v1/api/BusinessEntityKeywordSearch';
export const CA_BIZFILE_DETAIL = 'https://calico.sos.ca.gov/cbc/v1/api/BusinessEntityDetails';
export const CA_BIZFILE_SIGNUP = 'https://calicodev.sos.ca.gov';

export interface CaBizfileEntity {
  EntityID?: string;
  EntityName?: string;
  ForeignEntityName?: string | null;
  StatusDescription?: string | null;
  EntityCity?: string | null;
  MailingCity?: string | null;
  AgentCity?: string | null;
  AgentName?: string | null;
  MailingZipCode?: string | null;
  EntityZipCode?: string | null;
  SiFrequency?: string | null;
}

export interface CaBizfileSearchPayload {
  RecordCount?: number;
  EntityData?: CaBizfileEntity[];
}

export function parseCaBizfileSearch(payload: unknown): CaBizfileEntity[] {
  if (!payload || typeof payload !== 'object') return [];
  const row = payload as CaBizfileSearchPayload;
  if (Array.isArray(row.EntityData)) return row.EntityData.filter(Boolean);
  if (Array.isArray(payload)) return (payload as CaBizfileEntity[]).filter(Boolean);
  return [];
}

export function entityCity(row: CaBizfileEntity): string | null {
  return row.EntityCity || row.MailingCity || row.AgentCity || null;
}

export function pickCaBizfileEntity(
  companyName: string,
  city: string | null | undefined,
  rows: CaBizfileEntity[],
): { entity: CaBizfileEntity; score: number; method: 'exact' | 'substring' | 'trigram' } | null {
  const hit = pickBestEntityMatch(companyName, rows, {
    legalNameOf: (r) => r.EntityName || '',
    dbaNameOf: (r) => r.ForeignEntityName,
    city,
    cityOf: entityCity,
    zipOf: (r) => r.EntityZipCode || r.MailingZipCode,
    allowTrigram: true,
  });
  if (!hit) return null;
  return { entity: hit.item, score: hit.score, method: hit.method };
}

export function caBizfileSourceUrl(entityId: string | null | undefined): string {
  const id = String(entityId || '').trim();
  if (!id) return CA_BIZFILE_KEYWORD;
  return `${CA_BIZFILE_DETAIL}?entity-number=${encodeURIComponent(id)}`;
}

export function caAgentCoverage(agentName: string | null | undefined): CoverageReason {
  const name = String(agentName || '').trim();
  if (!name) return 'not_found';
  if (isRegistryAgentName(name)) return 'agent_only';
  return 'agent_only';
}

/** Phase 1: no live HTTP. Callers inject JSON. */
export function matchCaBizfileFromPayload(
  companyName: string,
  city: string | null | undefined,
  payload: unknown,
): {
  entity: CaBizfileEntity | null;
  coverage_reason: CoverageReason;
  match_method?: 'exact' | 'substring' | 'trigram';
  match_score?: number;
  source_url: string;
} {
  const rows = parseCaBizfileSearch(payload);
  const picked = pickCaBizfileEntity(companyName, city, rows);
  if (!picked) {
    return { entity: null, coverage_reason: 'not_found', source_url: CA_BIZFILE_KEYWORD };
  }
  return {
    entity: picked.entity,
    coverage_reason: caAgentCoverage(picked.entity.AgentName),
    match_method: picked.method,
    match_score: picked.score,
    source_url: caBizfileSourceUrl(picked.entity.EntityID),
  };
}
