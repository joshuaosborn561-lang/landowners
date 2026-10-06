/** Parcel filters shared by the tools. SQL permit_parcel.parcel_matches mirrors this. */

export interface ParcelFilters {
  county?: string;
  state?: string;
  owner_name?: string;
  city?: string;
  zip?: string;
  use_code?: string;
  owner_type?: string | string[];
  /** When true, owner_type list OR is_church, plus the other filters. */
  owner_or_church?: boolean;
  is_church?: boolean;
  improved?: boolean;
  min_assessed_value?: number;
  state_use_code?: string;
  max_miles_from_dallas?: number;
  q?: string;
  page?: number;
  page_size?: number;
  client_tag?: string;
}

export interface FilterableParcel {
  county: string;
  state?: string | null;
  owner_type: string;
  is_church?: boolean;
  improved?: boolean;
  assessed_value: number | null;
  state_use_code?: string | null;
  use_code?: string | null;
  miles_from_dallas?: number | null;
  owner_name: string;
  city?: string | null;
  zip?: string | null;
  use_desc?: string | null;
  account_id: string;
  situs_address?: string | null;
  parcel_address?: string | null;
  mailing_address?: string | null;
}

export function ownerTypeList(value: string | string[] | undefined): string[] | null {
  if (value == null || value === '') return null;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = parts.map((part) => part.trim()).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

export function sanitizeClientTag(tag: string | undefined): string {
  const cleaned = (tag || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (!cleaned) throw new Error('client_tag is empty');
  return cleaned;
}

export function parcelMatches(row: FilterableParcel, filters: ParcelFilters): boolean {
  if (filters.county && row.county.toLowerCase() !== filters.county.toLowerCase()) return false;
  if (filters.state && (row.state || 'TX').toUpperCase() !== filters.state.toUpperCase()) return false;
  const types = ownerTypeList(filters.owner_type);
  if (filters.owner_or_church) {
    const typeHit = types ? types.includes(row.owner_type) : false;
    if (!typeHit && !row.is_church) return false;
  } else {
    if (types && !types.includes(row.owner_type)) return false;
    if (filters.is_church != null && Boolean(row.is_church) !== filters.is_church) return false;
  }
  if (filters.improved != null && Boolean(row.improved) !== filters.improved) return false;
  if (filters.min_assessed_value != null) {
    if (row.assessed_value == null || row.assessed_value < filters.min_assessed_value) return false;
  }
  if (filters.state_use_code) {
    const code = (row.state_use_code || row.use_code || '').toUpperCase();
    if (code !== filters.state_use_code.toUpperCase()) return false;
  }
  if (filters.max_miles_from_dallas != null) {
    if (row.miles_from_dallas == null || row.miles_from_dallas > filters.max_miles_from_dallas) return false;
  }
  if (filters.zip && (row.zip || '').slice(0, 5) !== String(filters.zip).slice(0, 5)) return false;
  if (filters.city && !(row.city || '').toLowerCase().includes(filters.city.toLowerCase())) return false;
  if (filters.use_code) {
    const hay = `${row.use_code || ''} ${row.state_use_code || ''}`.toLowerCase();
    if (!hay.includes(filters.use_code.toLowerCase())) return false;
  }
  if (filters.owner_name && !row.owner_name.toLowerCase().includes(filters.owner_name.toLowerCase())) {
    return false;
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const hay = [
      row.owner_name,
      row.mailing_address,
      row.parcel_address,
      row.situs_address,
      row.city,
      row.zip,
      row.use_code,
      row.use_desc,
      row.account_id,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/** JSON body stored for Supabase RPCs. Drops empty values. */
export function rpcParcelFilters(filters: ParcelFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const types = ownerTypeList(filters.owner_type);
  if (filters.county) out.county = filters.county;
  if (filters.state) out.state = filters.state.toUpperCase();
  if (filters.owner_name) out.owner_name = filters.owner_name;
  if (filters.city) out.city = filters.city;
  if (filters.zip) out.zip = String(filters.zip).slice(0, 5);
  if (filters.use_code) out.use_code = filters.use_code;
  if (types) out.owner_type = types.length === 1 ? types[0] : types;
  if (filters.owner_or_church) out.owner_or_church = true;
  if (filters.is_church != null) out.is_church = filters.is_church;
  if (filters.improved != null) out.improved = filters.improved;
  if (filters.min_assessed_value != null) out.min_assessed_value = filters.min_assessed_value;
  if (filters.state_use_code) out.state_use_code = filters.state_use_code;
  if (filters.max_miles_from_dallas != null) out.max_miles_from_dallas = filters.max_miles_from_dallas;
  if (filters.q) out.q = filters.q;
  return out;
}
