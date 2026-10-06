import { classifyOwnerType } from '../services/ownerType.js';
import type { ParcelRecord } from '../types.js';
import { isChurchName } from './church.js';
import type { CountyConfig } from './countyTypes.js';

export interface RawParcel {
  account_id: string;
  owner_name?: string | null;
  situs_address?: string | null;
  situs_city?: string | null;
  situs_zip?: string | null;
  owner_mail_addr1?: string | null;
  owner_mail_addr2?: string | null;
  owner_mail_city?: string | null;
  owner_mail_state?: string | null;
  owner_mail_zip?: string | null;
  state_use_code?: string | null;
  use_desc?: string | null;
  improved?: boolean | null;
  land_value?: number | null;
  improvement_value?: number | null;
  assessed_value?: number | null;
  year_built?: number | null;
  acres?: number | null;
  deed_date?: string | null;
  prop_type?: string | null;
}

export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : null;
}

export function zip5(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 5) return digits.slice(0, 5);
  return raw.slice(0, 5);
}

export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** PACS numeric acreage is an integer with 4 implied decimal places. */
export function pacsAcres(raw: string | null | undefined): number | null {
  const text = blankToNull(raw);
  if (!text) return null;
  if (text.includes('.')) return finiteNumber(text);
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 10000) * 10000) / 10000;
}

export function pacsMoney(raw: string | null | undefined): number | null {
  const text = blankToNull(raw);
  if (!text) return null;
  const n = Number(text.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseDeedDate(raw: string | null | undefined): string | null {
  const text = blankToNull(raw);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const digits = text.replace(/\D/g, '');
  if (digits.length === 8) {
    const mm = digits.slice(0, 2);
    const dd = digits.slice(2, 4);
    const yyyy = digits.slice(4, 8);
    const month = Number(mm);
    const day = Number(dd);
    const year = Number(yyyy);
    if (year >= 1700 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${yyyy}-${mm}-${dd}`;
    }
    // YYYYMMDD
    const y2 = Number(digits.slice(0, 4));
    const m2 = Number(digits.slice(4, 6));
    const d2 = Number(digits.slice(6, 8));
    if (y2 >= 1700 && y2 <= 2100 && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }
  return null;
}

export function parseYearBuilt(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null) return null;
  const year = Math.trunc(n);
  if (year < 1700 || year > 2100) return null;
  return year;
}

export function joinParts(parts: Array<string | null | undefined>): string | null {
  const text = parts
    .map((part) => blankToNull(part))
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return text || null;
}

export function splitCityState(value: string | null | undefined): { city: string | null; state: string | null } {
  const text = blankToNull(value);
  if (!text) return { city: null, state: null };
  const match = text.match(/^(.*?)[,\s]+([A-Z]{2})$/);
  if (!match) return { city: text, state: null };
  return { city: blankToNull(match[1]), state: match[2]! };
}

/** Stable id. Unique row key in the database is (county, account_id); state is stored beside it. */
export function parcelId(county: string, accountId: string): string {
  return `${county}:${accountId}`;
}

export function toParcelRecord(
  county: CountyConfig,
  raw: RawParcel,
  milesForZip: (zip: string | null) => number | null,
  loadedAt: string,
): ParcelRecord | null {
  const accountId = blankToNull(raw.account_id);
  if (!accountId) return null;
  const ownerName = blankToNull(raw.owner_name) ?? '';
  const useDesc = blankToNull(raw.use_desc);
  const stateUse = blankToNull(raw.state_use_code);
  const situsZip = zip5(raw.situs_zip);
  const mailZip = zip5(raw.owner_mail_zip);
  const improvement = finiteNumber(raw.improvement_value);
  const land = finiteNumber(raw.land_value);
  const assessed = finiteNumber(raw.assessed_value);
  const improved = raw.improved != null ? Boolean(raw.improved) : (improvement ?? 0) > 0;
  const situsAddress = blankToNull(raw.situs_address);
  const situsCity = blankToNull(raw.situs_city);
  const mail1 = blankToNull(raw.owner_mail_addr1);
  const mail2 = blankToNull(raw.owner_mail_addr2);
  const mailCity = blankToNull(raw.owner_mail_city);
  const mailState = blankToNull(raw.owner_mail_state);
  const mailing = [mail1, mail2, joinParts([mailCity, mailState, mailZip])].filter(Boolean).join(', ');
  return {
    id: parcelId(county.name, accountId),
    county: county.name,
    state: county.state,
    fips: county.fips ?? null,
    account_id: accountId,
    owner_name: ownerName,
    mailing_address: mailing || null,
    parcel_address: situsAddress,
    city: situsCity,
    zip: situsZip,
    assessed_value: assessed,
    use_code: stateUse,
    prop_type: blankToNull(raw.prop_type) ?? useDesc,
    owner_type: classifyOwnerType(ownerName),
    situs_address: situsAddress,
    situs_city: situsCity,
    situs_zip: situsZip,
    owner_mail_addr1: mail1,
    owner_mail_addr2: mail2,
    owner_mail_city: mailCity,
    owner_mail_state: mailState,
    owner_mail_zip: mailZip,
    state_use_code: stateUse,
    use_desc: useDesc,
    improved,
    is_church: isChurchName(ownerName, useDesc),
    land_value: land,
    improvement_value: improvement,
    year_built: parseYearBuilt(raw.year_built),
    acres: finiteNumber(raw.acres),
    deed_date: parseDeedDate(raw.deed_date),
    miles_from_dallas: milesForZip(situsZip),
    source: county.source_url,
    loaded_at: loadedAt,
  };
}
