-- Permits MCP (repo: joshuaosborn561-lang/permits-GCs; protocol id alias: permits-gcs)
-- Active schema for parcels + calling lists. Applied to google-maps-scraper-leads.
-- See also supabase/migrations/ for incremental RPCs.
--
-- Legacy note: property_pm_finder.* remains in the database from the removed
-- Propwire cascade but is not used by this app.

CREATE SCHEMA IF NOT EXISTS permit_parcel;

CREATE TABLE IF NOT EXISTS permit_parcel.parcels (
  id text PRIMARY KEY,
  county text NOT NULL,
  account_id text NOT NULL,
  owner_name text NOT NULL DEFAULT '',
  mailing_address text,
  parcel_address text,
  city text,
  zip text,
  assessed_value numeric,
  use_code text,
  prop_type text,
  owner_type text NOT NULL DEFAULT 'unknown'
    CHECK (owner_type = ANY (ARRAY[
      'individual'::text, 'local_llc'::text, 'institutional'::text, 'unknown'::text
    ])),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permit_parcel.calling_lists (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner text NOT NULL DEFAULT 'shared',
  source text NOT NULL DEFAULT 'shovels_contractors',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
