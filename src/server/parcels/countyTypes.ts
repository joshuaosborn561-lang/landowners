export type ParcelSourceType =
  | 'dcad_extract'
  | 'delimited'
  | 'socrata'
  | 'pacs_fixed_width'
  | 'gis_table'
  | 'open_records'
  | 'vendor_api';

export type ParcelParserId =
  | 'dcad'
  | 'delimited'
  | 'socrata'
  | 'pacs'
  | 'arcgis_attributes'
  | 'gis_dbf'
  | 'open_records'
  | 'vendor_api';

export type CountyStatus = 'active' | 'needs_request' | 'registered';

export interface CountyConfig {
  name: string;
  state: string;
  fips?: string | null;
  source_type: ParcelSourceType;
  source_url: string | null;
  layout_url?: string | null;
  parser: ParcelParserId;
  refresh_cadence: string;
  status: CountyStatus;
  notes?: string;
  order_by?: string;
  page_size?: number;
  delimiter?: string;
  /** Source column name for each normalized field. */
  field_map?: Record<string, string>;
  dataset_id?: string;
  /** ArcGIS result page size, or Socrata $limit. */
  inside_notes?: string;
}

export interface RegisteredCounty extends CountyConfig {
  fips: string | null;
  inside_60_miles: boolean;
  boundary_miles: number | null;
}
