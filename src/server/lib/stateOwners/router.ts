import { isNycCity, normalizeState } from './names.js';
import { resolveCslb } from './cslb.js';
import { resolveWaLni } from './waLni.js';
import { resolveNycDob } from './nycDob.js';
import { resolveNyDos } from './nyDos.js';
import { resolveMaCsl } from './maCsl.js';
import { resolveMnDli } from './mnDli.js';
import { resolvePaDos } from './paDos.js';
import { resolveTxTdlr } from './txTdlr.js';
import { resolveTxSos } from './txSosAdapter.js';
import { resolveSunbiz } from './sunbizAdapter.js';
import type { BoardSource, OwnerLead, ResolverResult } from './types.js';

export type StateCode = 'CA' | 'WA' | 'NY' | 'MA' | 'MN' | 'PA' | 'TX' | 'FL';

export const STATE_RESOLVERS: StateCode[] = ['CA', 'WA', 'NY', 'MA', 'MN', 'PA', 'TX', 'FL'];

export function leadState(lead: OwnerLead): string {
  return normalizeState(lead.state);
}

export async function resolveNewYork(lead: OwnerLead): Promise<ResolverResult> {
  if (isNycCity(lead.city)) return resolveNycDob(lead);
  return resolveNyDos(lead);
}

export async function resolveTexas(lead: OwnerLead): Promise<ResolverResult> {
  if (lead.license_number) {
    const tdlr = await resolveTxTdlr(lead);
    if (tdlr.people.length || tdlr.coverage_reason === 'blocked') return tdlr;
  }
  return resolveTxSos(lead);
}

export async function resolveLeadByState(lead: OwnerLead): Promise<ResolverResult> {
  const st = leadState(lead);
  switch (st) {
    case 'CA':
      return resolveCslb(lead);
    case 'WA':
      return resolveWaLni(lead);
    case 'NY':
      return resolveNewYork(lead);
    case 'MA':
      return resolveMaCsl(lead);
    case 'MN':
      return resolveMnDli(lead);
    case 'PA':
      return resolvePaDos(lead);
    case 'TX':
      return resolveTexas(lead);
    case 'FL':
      return resolveSunbiz(lead);
    default:
      return {
        people: [],
        coverage_reason: 'not_found',
        source: 'cslb',
      };
  }
}

export function resolverForState(state: string): ((lead: OwnerLead) => Promise<ResolverResult>) | null {
  const st = normalizeState(state);
  if ((STATE_RESOLVERS as string[]).includes(st)) {
    return (lead) => resolveLeadByState({ ...lead, state: st });
  }
  return null;
}

export function sourceForState(state: string, city?: string | null): BoardSource {
  const st = normalizeState(state);
  if (st === 'CA') return 'cslb';
  if (st === 'WA') return 'wa_lni';
  if (st === 'NY') return isNycCity(city) ? 'nyc_dob' : 'ny_dos';
  if (st === 'MA') return 'ma_csl';
  if (st === 'MN') return 'mn_dli';
  if (st === 'PA') return 'pa_dos';
  if (st === 'TX') return 'tx_tdlr';
  if (st === 'FL') return 'sunbiz';
  return 'cslb';
}
