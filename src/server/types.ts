export type OwnerType =
  | 'individual'
  | 'local_llc'
  | 'institutional'
  | 'municipal'
  | 'unknown';

/** County name. Any registered county, not a fixed enum. */
export type CountyCode = string;

export interface ParcelRecord {
  id: string;
  county: string;
  state: string;
  fips: string | null;
  account_id: string;
  owner_name: string;
  mailing_address: string | null;
  parcel_address: string | null;
  city: string | null;
  zip: string | null;
  assessed_value: number | null;
  use_code: string | null;
  prop_type: string | null;
  owner_type: OwnerType;
  situs_address: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  owner_mail_addr1: string | null;
  owner_mail_addr2: string | null;
  owner_mail_city: string | null;
  owner_mail_state: string | null;
  owner_mail_zip: string | null;
  state_use_code: string | null;
  use_desc: string | null;
  improved: boolean;
  is_church: boolean;
  land_value: number | null;
  improvement_value: number | null;
  year_built: number | null;
  acres: number | null;
  deed_date: string | null;
  miles_from_dallas: number | null;
  source: string | null;
  loaded_at: string | null;
}

