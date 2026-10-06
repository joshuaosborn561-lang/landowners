import { blankToNull, finiteNumber, joinParts, type RawParcel } from '../normalize.js';

const SYNONYMS: Record<string, string[]> = {
  account_id: ['pid', 'prop_id', 'propid', 'geoid', 'account_num', 'accountnum', 'parcelid', 'parcel_id', 'gispropid', 'refid2'],
  owner_name: ['ownername', 'owner_name', 'fileasname', 'owner', 'py_owner_name', 'name'],
  situs_num: ['streetnum', 'situs_num', 'situsnum'],
  situs_street: ['streetnam', 'situsstreet', 'situs_street', 'streetname'],
  situs_pre: ['streetpre', 'situs_street_prefx'],
  situs_suf: ['streetsuf', 'situs_street_suffix'],
  situs_address: ['situs_address', 'situsaddress', 'situs', 'siteaddress', 'property_address'],
  situs_city: ['streetcity', 'situscity', 'situs_city', 'property_city', 'city'],
  situs_zip: ['streetzip', 'situszip', 'situs_zip', 'property_zip', 'propzip'],
  owner_mail_addr1: ['owneraddr', 'owner_address', 'mailaddr', 'owneraddress', 'addr1'],
  owner_mail_addr2: ['ownersuite', 'owneraddr2', 'addr2'],
  owner_mail_city: ['ownercity', 'mailcity'],
  owner_mail_state: ['ownerstate', 'mailstate'],
  owner_mail_zip: ['ownerzip', 'mailzip'],
  state_use_code: ['ascode', 'state_use_code', 'propusecode', 'sptd_cd', 'usecode'],
  use_desc: ['usedesc', 'use_desc', 'bldg_class_desc', 'sptd_desc', 'propclass'],
  land_value: ['ownerland', 'land_value', 'landvalue', 'land_val'],
  improvement_value: ['ownerimpro', 'improvement_value', 'impr_val', 'imprvalue'],
  assessed_value: ['ownermarke', 'assessed_value', 'market_value', 'total_value', 'tot_val', 'appraised'],
  acres: ['legalacre', 'acres', 'acreage', 'land_acres'],
  deed_date: ['deeddt', 'deed_date', 'deed_dt', 'saledate'],
  year_built: ['yr_built', 'year_built', 'yearbuilt'],
};

/** ArcGIS date fields arrive as epoch milliseconds. */
function epochDate(raw: string | null): string | null {
  if (!raw || !/^\d{12,13}$/.test(raw)) return raw;
  const date = new Date(Number(raw));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString().slice(0, 10);
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mapGisRecord(
  record: Record<string, unknown>,
  fieldMap?: Record<string, string>,
): RawParcel {
  const byNorm = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) byNorm.set(norm(key), value);
  const pick = (key: string): string | null => {
    const configured = fieldMap?.[key];
    if (configured) {
      const direct = record[configured] ?? byNorm.get(norm(configured));
      if (direct != null && String(direct).trim()) return String(direct).trim();
    }
    for (const name of SYNONYMS[key] ?? []) {
      const value = byNorm.get(norm(name));
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return null;
  };
  const improvement = finiteNumber(pick('improvement_value'));
  const situs = pick('situs_address') || joinParts([pick('situs_num'), pick('situs_pre'), pick('situs_street'), pick('situs_suf')]);
  return {
    account_id: pick('account_id') ?? '',
    owner_name: blankToNull(pick('owner_name')),
    situs_address: situs,
    situs_city: pick('situs_city'),
    situs_zip: pick('situs_zip'),
    owner_mail_addr1: pick('owner_mail_addr1'),
    owner_mail_addr2: pick('owner_mail_addr2'),
    owner_mail_city: pick('owner_mail_city'),
    owner_mail_state: pick('owner_mail_state'),
    owner_mail_zip: pick('owner_mail_zip'),
    state_use_code: pick('state_use_code'),
    use_desc: pick('use_desc'),
    land_value: finiteNumber(pick('land_value')),
    improvement_value: improvement,
    assessed_value: finiteNumber(pick('assessed_value')),
    acres: finiteNumber(pick('acres')),
    deed_date: epochDate(pick('deed_date')),
    year_built: finiteNumber(pick('year_built')),
    improved: (improvement ?? 0) > 0,
  };
}
