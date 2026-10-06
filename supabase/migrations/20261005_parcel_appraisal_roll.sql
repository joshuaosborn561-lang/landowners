-- Appraisal roll columns, county load log, filtered client sets.
-- Writes stay on permit_parcel. Unique key remains (county, account_id).
-- parcel_matches mirrors src/server/parcels/filters.ts.

ALTER TABLE permit_parcel.parcels
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'TX',
  ADD COLUMN IF NOT EXISTS fips text,
  ADD COLUMN IF NOT EXISTS situs_address text,
  ADD COLUMN IF NOT EXISTS situs_city text,
  ADD COLUMN IF NOT EXISTS situs_zip text,
  ADD COLUMN IF NOT EXISTS owner_mail_addr1 text,
  ADD COLUMN IF NOT EXISTS owner_mail_addr2 text,
  ADD COLUMN IF NOT EXISTS owner_mail_city text,
  ADD COLUMN IF NOT EXISTS owner_mail_state text,
  ADD COLUMN IF NOT EXISTS owner_mail_zip text,
  ADD COLUMN IF NOT EXISTS state_use_code text,
  ADD COLUMN IF NOT EXISTS use_desc text,
  ADD COLUMN IF NOT EXISTS improved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_church boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS land_value numeric,
  ADD COLUMN IF NOT EXISTS improvement_value numeric,
  ADD COLUMN IF NOT EXISTS year_built integer,
  ADD COLUMN IF NOT EXISTS acres numeric,
  ADD COLUMN IF NOT EXISTS deed_date date,
  ADD COLUMN IF NOT EXISTS miles_from_dallas numeric,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS loaded_at timestamptz;

CREATE INDEX IF NOT EXISTS parcels_state_county_idx ON permit_parcel.parcels (state, county);
CREATE INDEX IF NOT EXISTS parcels_miles_idx ON permit_parcel.parcels (miles_from_dallas);
CREATE INDEX IF NOT EXISTS parcels_improved_idx ON permit_parcel.parcels (improved);
CREATE INDEX IF NOT EXISTS parcels_owner_type_idx ON permit_parcel.parcels (owner_type);
CREATE INDEX IF NOT EXISTS parcels_church_idx ON permit_parcel.parcels (is_church) WHERE is_church;

CREATE TABLE IF NOT EXISTS permit_parcel.county_loads (
  state text NOT NULL,
  county text NOT NULL,
  source_type text,
  source_url text,
  parser text,
  status text,
  source_file_date date,
  source_file_name text,
  rows_downloaded integer,
  rows_parsed integer,
  rows_upserted integer,
  loaded_at timestamptz,
  notes text,
  PRIMARY KEY (state, county)
);

CREATE TABLE IF NOT EXISTS permit_parcel.parcel_client_sets (
  client_tag text NOT NULL,
  state text NOT NULL,
  county text NOT NULL,
  account_id text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_tag, state, county, account_id)
);

CREATE TABLE IF NOT EXISTS permit_parcel.zip_centroids (
  zip text PRIMARY KEY,
  lat double precision NOT NULL,
  lon double precision NOT NULL
);

ALTER TABLE permit_parcel.county_loads ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_parcel.parcel_client_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_parcel.zip_centroids ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION permit_parcel.classify_owner(owner_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  name text := btrim(coalesce(owner_name, ''));
BEGIN
  IF name = '' THEN
    RETURN 'unknown';
  END IF;
  IF name ~* '\m(CITY OF|COUNTY OF|TOWN OF|VILLAGE OF|STATE OF|SCHOOL DISTRICT|ISD|HOUSING AUTHORITY|UNIVERSITY|COLLEGE|CHURCH|TRANSIT AUTHORITY|MUNICIPAL|METROPOLITAN|PUBLIC LIBRARY|FIRE DISTRICT|WATER DISTRICT|UTILITY DISTRICT)\M' THEN
    RETURN 'municipal';
  END IF;
  IF name ~* '\m(LLC|L\.L\.C\.|INC\.?|CORP\.?|LTD\.?|LP|L\.P\.|LLP|COMPANY|CO\.|TRUST|HOLDINGS?|PROPERTIES|PARTNERS|PARTNERSHIP)\M' THEN
    RETURN 'local_llc';
  END IF;
  IF name ~* '\m(BANK|CREDIT UNION|REIT|FUND|CAPITAL|INVESTMENT|ASSET|MANAGEMENT|INSURANCE|PENSION|FOUNDATION)\M' THEN
    RETURN 'institutional';
  END IF;
  IF name ~ '^[A-Z][A-Za-z.''-]+(\s+[A-Z][A-Za-z.''-]+){1,3}$' THEN
    RETURN 'individual';
  END IF;
  RETURN 'unknown';
END;
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.is_church(owner_name text, use_desc text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (coalesce(owner_name, '') || ' ' || coalesce(use_desc, ''))
    ~* '\m(?:churches?|baptists?|methodists?|ministries|ministry|fellowships?|chapels?|catholics?|parishes|parish|lutherans?|presbyterians?|bible|assembly of god)\M';
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.miles_between(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT 2 * 3958.7613 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
  )));
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.miles_for_zip(p_zip text)
RETURNS numeric
LANGUAGE sql
STABLE
AS $fn$
  SELECT round(permit_parcel.miles_between(32.7767, -96.7970, lat, lon)::numeric, 2)
  FROM permit_parcel.zip_centroids
  WHERE zip = left(regexp_replace(coalesce(p_zip, ''), '\D', '', 'g'), 5);
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.parse_deed_date(raw text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  text_value text := btrim(coalesce(raw, ''));
  digits text;
BEGIN
  IF text_value = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF text_value ~ '^\d{4}-\d{2}-\d{2}' THEN
      RETURN left(text_value, 10)::date;
    END IF;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  digits := regexp_replace(text_value, '\D', '', 'g');
  IF length(digits) = 8 THEN
    BEGIN
      IF substring(digits, 1, 2)::int BETWEEN 1 AND 12
         AND substring(digits, 3, 2)::int BETWEEN 1 AND 31
         AND substring(digits, 5, 4)::int BETWEEN 1700 AND 2100 THEN
        RETURN to_date(digits, 'MMDDYYYY');
      END IF;
      IF substring(digits, 1, 4)::int BETWEEN 1700 AND 2100 THEN
        RETURN to_date(digits, 'YYYYMMDD');
      END IF;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.filter_owner_types(f jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN f->'owner_type' IS NULL OR f->'owner_type' = 'null'::jsonb OR coalesce(f->>'owner_type', '') = '' THEN NULL
    WHEN jsonb_typeof(f->'owner_type') = 'array' THEN (
      SELECT array_agg(trim(value))
      FROM jsonb_array_elements_text(f->'owner_type') AS t(value)
      WHERE trim(value) <> ''
    )
    ELSE (
      SELECT array_agg(trim(part))
      FROM unnest(string_to_array(f->>'owner_type', ',')) AS part
      WHERE trim(part) <> ''
    )
  END;
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.parcel_matches(p permit_parcel.parcels, f jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT
    (f->>'county' IS NULL OR lower(p.county) = lower(f->>'county'))
    AND (f->>'state' IS NULL OR upper(p.state) = upper(f->>'state'))
    AND (
      CASE
        WHEN coalesce((f->>'owner_or_church')::boolean, false) THEN
          (
            (
              permit_parcel.filter_owner_types(f) IS NOT NULL
              AND p.owner_type = ANY (permit_parcel.filter_owner_types(f))
            )
            OR p.is_church
          )
        ELSE
          (
            permit_parcel.filter_owner_types(f) IS NULL
            OR p.owner_type = ANY (permit_parcel.filter_owner_types(f))
          )
          AND (f->>'is_church' IS NULL OR p.is_church = (f->>'is_church')::boolean)
      END
    )
    AND (f->>'improved' IS NULL OR p.improved = (f->>'improved')::boolean)
    AND (
      f->>'min_assessed_value' IS NULL
      OR (p.assessed_value IS NOT NULL AND p.assessed_value >= (f->>'min_assessed_value')::numeric)
    )
    AND (
      f->>'state_use_code' IS NULL
      OR upper(coalesce(p.state_use_code, '')) = upper(f->>'state_use_code')
    )
    AND (
      f->>'max_miles_from_dallas' IS NULL
      OR (
        p.miles_from_dallas IS NOT NULL
        AND p.miles_from_dallas <= (f->>'max_miles_from_dallas')::numeric
      )
    )
    AND (f->>'zip' IS NULL OR left(coalesce(p.zip, ''), 5) = left(f->>'zip', 5))
    AND (f->>'city' IS NULL OR coalesce(p.city, '') ILIKE '%' || f->>'city' || '%')
    AND (
      f->>'use_code' IS NULL
      OR (coalesce(p.use_code, '') || ' ' || coalesce(p.state_use_code, '')) ILIKE '%' || f->>'use_code' || '%'
    )
    AND (f->>'owner_name' IS NULL OR coalesce(p.owner_name, '') ILIKE '%' || f->>'owner_name' || '%')
    AND (
      f->>'q' IS NULL
      OR lower(concat_ws(
        ' ',
        p.owner_name,
        p.mailing_address,
        p.parcel_address,
        p.situs_address,
        p.city,
        p.zip,
        p.use_code,
        p.use_desc,
        p.account_id
      )) LIKE '%' || lower(f->>'q') || '%'
    );
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.num_or_null(raw text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN raw IS NULL OR btrim(raw) = '' THEN NULL
    WHEN btrim(raw) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(raw)::numeric
    ELSE NULL
  END;
$fn$;

CREATE OR REPLACE FUNCTION permit_parcel.upsert_appraisal_rows(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  n integer := 0;
BEGIN
  INSERT INTO permit_parcel.parcels (
    id, county, state, fips, account_id, owner_name, mailing_address, parcel_address,
    city, zip, assessed_value, use_code, prop_type, owner_type, updated_at,
    situs_address, situs_city, situs_zip, owner_mail_addr1, owner_mail_addr2,
    owner_mail_city, owner_mail_state, owner_mail_zip, state_use_code, use_desc,
    improved, is_church, land_value, improvement_value, year_built, acres, deed_date,
    miles_from_dallas, source, loaded_at
  )
  SELECT
    coalesce(nullif(deduped.payload->>'county', ''), 'unknown') || ':' || coalesce(nullif(deduped.payload->>'account_id', ''), 'unknown'),
    coalesce(deduped.payload->>'county', ''),
    coalesce(nullif(deduped.payload->>'state', ''), 'TX'),
    nullif(deduped.payload->>'fips', ''),
    coalesce(deduped.payload->>'account_id', ''),
    coalesce(deduped.payload->>'owner_name', ''),
    coalesce(
      nullif(deduped.payload->>'mailing_address', ''),
      nullif(concat_ws(', ',
        nullif(deduped.payload->>'owner_mail_addr1', ''),
        nullif(deduped.payload->>'owner_mail_addr2', ''),
        nullif(concat_ws(' ',
          nullif(deduped.payload->>'owner_mail_city', ''),
          nullif(deduped.payload->>'owner_mail_state', ''),
          nullif(deduped.payload->>'owner_mail_zip', '')
        ), '')
      ), '')
    ),
    coalesce(nullif(deduped.payload->>'parcel_address', ''), nullif(deduped.payload->>'situs_address', '')),
    coalesce(nullif(deduped.payload->>'city', ''), nullif(deduped.payload->>'situs_city', '')),
    coalesce(nullif(deduped.payload->>'zip', ''), nullif(deduped.payload->>'situs_zip', '')),
    permit_parcel.num_or_null(deduped.payload->>'assessed_value'),
    coalesce(nullif(deduped.payload->>'use_code', ''), nullif(deduped.payload->>'state_use_code', '')),
    coalesce(nullif(deduped.payload->>'prop_type', ''), nullif(deduped.payload->>'use_desc', '')),
    coalesce(nullif(deduped.payload->>'owner_type', ''), permit_parcel.classify_owner(deduped.payload->>'owner_name')),
    now(),
    nullif(deduped.payload->>'situs_address', ''),
    nullif(deduped.payload->>'situs_city', ''),
    nullif(deduped.payload->>'situs_zip', ''),
    nullif(deduped.payload->>'owner_mail_addr1', ''),
    nullif(deduped.payload->>'owner_mail_addr2', ''),
    nullif(deduped.payload->>'owner_mail_city', ''),
    nullif(deduped.payload->>'owner_mail_state', ''),
    nullif(deduped.payload->>'owner_mail_zip', ''),
    nullif(deduped.payload->>'state_use_code', ''),
    nullif(deduped.payload->>'use_desc', ''),
    CASE
      WHEN deduped.payload->>'improved' IS NULL OR deduped.payload->>'improved' = '' THEN false
      ELSE (deduped.payload->>'improved')::boolean
    END,
    CASE
      WHEN deduped.payload->>'is_church' IS NULL OR deduped.payload->>'is_church' = '' THEN
        permit_parcel.is_church(deduped.payload->>'owner_name', deduped.payload->>'use_desc')
      ELSE (deduped.payload->>'is_church')::boolean
    END,
    permit_parcel.num_or_null(deduped.payload->>'land_value'),
    permit_parcel.num_or_null(deduped.payload->>'improvement_value'),
    CASE
      WHEN permit_parcel.num_or_null(deduped.payload->>'year_built') BETWEEN 1700 AND 2100
        THEN permit_parcel.num_or_null(deduped.payload->>'year_built')::integer
      ELSE NULL
    END,
    permit_parcel.num_or_null(deduped.payload->>'acres'),
    permit_parcel.parse_deed_date(deduped.payload->>'deed_date'),
    coalesce(
      permit_parcel.num_or_null(deduped.payload->>'miles_from_dallas'),
      permit_parcel.miles_for_zip(coalesce(deduped.payload->>'situs_zip', deduped.payload->>'zip'))
    ),
    nullif(deduped.payload->>'source', ''),
    coalesce(nullif(deduped.payload->>'loaded_at', '')::timestamptz, now())
  FROM (
    SELECT DISTINCT ON (coalesce(src.payload->>'county', ''), coalesce(src.payload->>'account_id', ''))
      src.payload
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) WITH ORDINALITY AS src(payload, ordinality)
    WHERE coalesce(src.payload->>'county', '') <> ''
      AND coalesce(src.payload->>'account_id', '') <> ''
    ORDER BY coalesce(src.payload->>'county', ''), coalesce(src.payload->>'account_id', ''), src.ordinality DESC
  ) deduped
  ON CONFLICT (county, account_id) DO UPDATE SET
    id = excluded.id,
    state = excluded.state,
    fips = excluded.fips,
    owner_name = excluded.owner_name,
    mailing_address = excluded.mailing_address,
    parcel_address = excluded.parcel_address,
    city = excluded.city,
    zip = excluded.zip,
    assessed_value = excluded.assessed_value,
    use_code = excluded.use_code,
    prop_type = excluded.prop_type,
    owner_type = excluded.owner_type,
    updated_at = now(),
    situs_address = excluded.situs_address,
    situs_city = excluded.situs_city,
    situs_zip = excluded.situs_zip,
    owner_mail_addr1 = excluded.owner_mail_addr1,
    owner_mail_addr2 = excluded.owner_mail_addr2,
    owner_mail_city = excluded.owner_mail_city,
    owner_mail_state = excluded.owner_mail_state,
    owner_mail_zip = excluded.owner_mail_zip,
    state_use_code = excluded.state_use_code,
    use_desc = excluded.use_desc,
    improved = excluded.improved,
    is_church = excluded.is_church,
    land_value = excluded.land_value,
    improvement_value = excluded.improvement_value,
    year_built = excluded.year_built,
    acres = excluded.acres,
    deed_date = excluded.deed_date,
    miles_from_dallas = excluded.miles_from_dallas,
    source = excluded.source,
    loaded_at = excluded.loaded_at;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ingest_permit_parcel_parcels(p_secret text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  n integer := 0;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  n := permit_parcel.upsert_appraisal_rows(p_rows);
  RETURN jsonb_build_object('ok', true, 'upserted', n);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.record_permit_parcel_county_load(p_secret text, p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  INSERT INTO permit_parcel.county_loads (
    state, county, source_type, source_url, parser, status, source_file_date,
    source_file_name, rows_downloaded, rows_parsed, rows_upserted, loaded_at, notes
  ) VALUES (
    coalesce(nullif(p_row->>'state', ''), 'TX'),
    p_row->>'county',
    nullif(p_row->>'source_type', ''),
    nullif(p_row->>'source_url', ''),
    nullif(p_row->>'parser', ''),
    nullif(p_row->>'status', ''),
    CASE WHEN coalesce(p_row->>'source_file_date', '') ~ '^\d{4}-\d{2}-\d{2}'
      THEN (p_row->>'source_file_date')::date ELSE NULL END,
    nullif(p_row->>'source_file_name', ''),
    permit_parcel.num_or_null(p_row->>'rows_downloaded')::integer,
    permit_parcel.num_or_null(p_row->>'rows_parsed')::integer,
    permit_parcel.num_or_null(p_row->>'rows_upserted')::integer,
    now(),
    nullif(p_row->>'notes', '')
  )
  ON CONFLICT (state, county) DO UPDATE SET
    source_type = excluded.source_type,
    source_url = excluded.source_url,
    parser = excluded.parser,
    status = excluded.status,
    source_file_date = excluded.source_file_date,
    source_file_name = excluded.source_file_name,
    rows_downloaded = excluded.rows_downloaded,
    rows_parsed = excluded.rows_parsed,
    rows_upserted = excluded.rows_upserted,
    loaded_at = excluded.loaded_at,
    notes = excluded.notes;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_row_count(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  n bigint;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT count(*) INTO n FROM permit_parcel.parcels;
  RETURN jsonb_build_object('count', n);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_county_stats(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  RETURN jsonb_build_object(
    'counts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('state', state, 'county', county, 'row_count', n) ORDER BY county)
      FROM (
        SELECT state, county, count(*)::bigint AS n
        FROM permit_parcel.parcels
        GROUP BY state, county
      ) grouped
    ), '[]'::jsonb),
    'loads', coalesce((
      SELECT jsonb_agg(to_jsonb(loads) ORDER BY loads.county)
      FROM permit_parcel.county_loads loads
    ), '[]'::jsonb)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_count(p_secret text, p_filters jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  n bigint;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT count(*) INTO n
  FROM permit_parcel.parcels AS parcels
  WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb));
  RETURN jsonb_build_object('count', n);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_summary(p_secret text, p_filters jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  RETURN (
    WITH filtered AS MATERIALIZED (
      SELECT county, owner_type, improved, is_church
      FROM permit_parcel.parcels AS parcels
      WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb))
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM filtered),
      'improved', (SELECT count(*) FROM filtered WHERE improved),
      'is_church', (SELECT count(*) FROM filtered WHERE is_church),
      'by_county', coalesce((
        SELECT jsonb_object_agg(county, n)
        FROM (SELECT county, count(*) AS n FROM filtered GROUP BY county) s
      ), '{}'::jsonb),
      'by_owner_type', coalesce((
        SELECT jsonb_object_agg(owner_type, n)
        FROM (SELECT owner_type, count(*) AS n FROM filtered GROUP BY owner_type) s
      ), '{}'::jsonb)
    )
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_query(
  p_secret text,
  p_filters jsonb,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  total bigint;
  items jsonb;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT count(*) INTO total
  FROM permit_parcel.parcels AS parcels
  WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb));
  SELECT coalesce(jsonb_agg(to_jsonb(page)), '[]'::jsonb) INTO items
  FROM (
    SELECT *
    FROM permit_parcel.parcels AS parcels
    WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb))
    ORDER BY county, account_id
    LIMIT v_limit
    OFFSET v_offset
  ) page;
  RETURN jsonb_build_object('total', total, 'items', items);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.permit_parcel_sample(
  p_secret text,
  p_filters jsonb,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 20);
  total bigint;
  items jsonb;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT count(*) INTO total
  FROM permit_parcel.parcels AS parcels
  WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb));
  SELECT coalesce(jsonb_agg(to_jsonb(page)), '[]'::jsonb) INTO items
  FROM (
    SELECT *
    FROM permit_parcel.parcels AS parcels
    WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb))
    ORDER BY md5(county || ':' || account_id)
    LIMIT v_limit
  ) page;
  RETURN jsonb_build_object('total', total, 'items', items);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.sync_permit_parcel_client_set(
  p_secret text,
  p_client_tag text,
  p_filters jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
AS $fn$
DECLARE
  expected text;
  deleted_n bigint := 0;
  inserted_n bigint := 0;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF p_client_tag IS NULL OR p_client_tag !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'client_tag must be snake_case';
  END IF;
  DELETE FROM permit_parcel.parcel_client_sets WHERE client_tag = p_client_tag;
  GET DIAGNOSTICS deleted_n = ROW_COUNT;
  INSERT INTO permit_parcel.parcel_client_sets (client_tag, state, county, account_id)
  SELECT p_client_tag, parcels.state, parcels.county, parcels.account_id
  FROM permit_parcel.parcels AS parcels
  WHERE permit_parcel.parcel_matches(parcels, coalesce(p_filters, '{}'::jsonb));
  GET DIAGNOSTICS inserted_n = ROW_COUNT;
  RETURN jsonb_build_object('rows_deleted', deleted_n, 'rows_inserted', inserted_n, 'client_tag', p_client_tag);
END;
$fn$;

-- Database-side Socrata page so a full roll can be upserted without shipping rows through the client.
CREATE OR REPLACE FUNCTION permit_parcel.pull_socrata_page(
  p_county text,
  p_state text,
  p_fips text,
  p_source_url text,
  p_field_map jsonb,
  p_offset integer,
  p_limit integer,
  p_order text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel, extensions
AS $fn$
DECLARE
  response record;
  url text;
  body jsonb;
  rows jsonb;
  upserted integer;
  raw_count integer;
  source_date text;
BEGIN
  url := p_source_url
    || CASE WHEN position('?' in p_source_url) > 0 THEN '&' ELSE '?' END
    || '$limit=' || p_limit
    || '&$offset=' || p_offset
    || '&$order=' || p_order;
  SELECT status, content INTO response FROM http_get(url);
  IF response.status <> 200 THEN
    RAISE EXCEPTION 'Socrata HTTP % at offset %', response.status, p_offset;
  END IF;
  body := response.content::jsonb;
  raw_count := jsonb_array_length(body);
  source_date := NULL;
  IF coalesce(p_field_map->>'source_date', '') <> '' AND raw_count > 0 THEN
    source_date := left(body->0->>(p_field_map->>'source_date'), 10);
  END IF;
  SELECT coalesce(jsonb_agg(mapped.row), '[]'::jsonb) INTO rows
  FROM (
    SELECT jsonb_build_object(
      'county', p_county,
      'state', p_state,
      'fips', p_fips,
      'account_id', coalesce(
        nullif(btrim(elem->>(p_field_map->>'account_id')), ''),
        nullif(btrim(elem->>(p_field_map->>'account_id_fallback')), '')
      ),
      'owner_name', nullif(btrim(elem->>(p_field_map->>'owner_name')), ''),
      'situs_address', nullif(btrim(elem->>(p_field_map->>'situs_address')), ''),
      'situs_city', nullif(btrim(elem->>(p_field_map->>'situs_city')), ''),
      'situs_zip', left(regexp_replace(coalesce(elem->>(p_field_map->>'situs_zip'), ''), '\D', '', 'g'), 5),
      'owner_mail_addr1', nullif(btrim(elem->>(p_field_map->>'owner_mail_addr1')), ''),
      'owner_mail_addr2', nullif(btrim(elem->>(p_field_map->>'owner_mail_addr2')), ''),
      'owner_mail_city', nullif(btrim(elem->>(p_field_map->>'owner_mail_city')), ''),
      'owner_mail_state', nullif(btrim(elem->>(p_field_map->>'owner_mail_state')), ''),
      'owner_mail_zip', left(regexp_replace(coalesce(elem->>(p_field_map->>'owner_mail_zip'), ''), '\D', '', 'g'), 5),
      'state_use_code', nullif(btrim(elem->>(p_field_map->>'state_use_code')), ''),
      'use_desc', nullif(btrim(elem->>(p_field_map->>'use_desc')), ''),
      'land_value', nullif(btrim(elem->>(p_field_map->>'land_value')), ''),
      'improvement_value', nullif(btrim(elem->>(p_field_map->>'improvement_value')), ''),
      'assessed_value', nullif(btrim(elem->>(p_field_map->>'assessed_value')), ''),
      'year_built', nullif(btrim(elem->>(p_field_map->>'year_built')), ''),
      'deed_date', nullif(btrim(elem->>(p_field_map->>'deed_date')), ''),
      'improved', (
        coalesce(permit_parcel.num_or_null(elem->>(p_field_map->>'improvement_value')), 0) > 0
        OR (
          permit_parcel.num_or_null(elem->>(p_field_map->>'year_built')) BETWEEN 1700 AND 2100
        )
      ),
      'source', p_source_url,
      'loaded_at', now()
    ) AS row
    FROM jsonb_array_elements(body) elem
  ) mapped
  WHERE coalesce(mapped.row->>'account_id', '') <> '';
  upserted := permit_parcel.upsert_appraisal_rows(rows);
  RETURN jsonb_build_object(
    'raw_count', raw_count,
    'upserted', upserted,
    'source_file_date', source_date
  );
END;
$fn$;

REVOKE ALL ON FUNCTION permit_parcel.classify_owner(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.is_church(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.miles_between(double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.miles_for_zip(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.parse_deed_date(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.filter_owner_types(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.parcel_matches(permit_parcel.parcels, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.num_or_null(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.upsert_appraisal_rows(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION permit_parcel.pull_socrata_page(text, text, text, text, jsonb, integer, integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_permit_parcel_parcels(text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_permit_parcel_county_load(text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_row_count(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_county_stats(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_count(text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_summary(text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_query(text, jsonb, integer, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.permit_parcel_sample(text, jsonb, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sync_permit_parcel_client_set(text, text, jsonb) TO anon, authenticated, service_role;

UPDATE permit_parcel.parcels
SET
  situs_address = coalesce(situs_address, parcel_address),
  situs_city = coalesce(situs_city, city),
  situs_zip = coalesce(situs_zip, left(zip, 5)),
  state_use_code = coalesce(state_use_code, use_code),
  use_desc = coalesce(use_desc, prop_type),
  improved = CASE WHEN source IS NULL THEN coalesce(assessed_value, 0) > 0 ELSE improved END,
  is_church = permit_parcel.is_church(owner_name, coalesce(use_desc, prop_type))
WHERE source IS NULL;
