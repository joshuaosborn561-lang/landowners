-- Distinct mailing-address owners for the same filters as permit_parcel_count.
-- An owner is upper(trimmed addr1) plus the first five characters of the mail ZIP.
-- by_owner_type and by_ptad count an address once per bucket it appears in.

CREATE OR REPLACE FUNCTION public.permit_parcel_owners_count(p_secret text, p_filters jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, permit_parcel
SET statement_timeout TO '45s'
AS $fn$
DECLARE
  expected text;
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  types text[];
  owners bigint;
  by_type jsonb;
  by_ptad jsonb;
  by_county jsonb;
BEGIN
  SELECT value INTO expected FROM private.app_secrets WHERE key = 'ingest_secret';
  IF expected IS NULL OR p_secret IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  types := permit_parcel.filter_owner_types(f);
  WITH matched AS (
    SELECT
      p.county,
      p.owner_type,
      coalesce(nullif(left(upper(coalesce(p.state_use_code, '')), 1), ''), 'unmapped') AS ptad,
      upper(btrim(p.owner_mail_addr1)) || '|' || left(coalesce(p.owner_mail_zip, ''), 5) AS owner_key
    FROM permit_parcel.parcels p
    WHERE btrim(coalesce(p.owner_mail_addr1, '')) <> ''
      AND (f->>'county' IS NULL OR lower(p.county) = lower(f->>'county'))
      AND (f->>'state' IS NULL OR upper(p.state) = upper(f->>'state'))
      AND (
        CASE
          WHEN coalesce((f->>'owner_or_church')::boolean, false) THEN
            ((types IS NOT NULL AND p.owner_type = ANY (types)) OR p.is_church)
          ELSE
            (types IS NULL OR p.owner_type = ANY (types))
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
        OR (p.miles_from_dallas IS NOT NULL AND p.miles_from_dallas <= (f->>'max_miles_from_dallas')::numeric)
      )
      AND (f->>'zip' IS NULL OR left(coalesce(p.zip, ''), 5) = left(f->>'zip', 5))
      AND (f->>'city' IS NULL OR position(lower(f->>'city') in lower(coalesce(p.city, ''))) > 0)
      AND (
        f->>'use_code' IS NULL
        OR position(
          lower(f->>'use_code') in lower(coalesce(p.use_code, '') || ' ' || coalesce(p.state_use_code, ''))
        ) > 0
      )
      AND (f->>'owner_name' IS NULL OR position(lower(f->>'owner_name') in lower(coalesce(p.owner_name, ''))) > 0)
      AND (
        f->>'q' IS NULL
        OR position(lower(f->>'q') in lower(concat_ws(
          ' ', p.owner_name, p.mailing_address, p.parcel_address, p.situs_address,
          p.city, p.zip, p.use_code, p.use_desc, p.account_id
        ))) > 0
      )
  )
  SELECT
    (SELECT count(DISTINCT owner_key) FROM matched),
    (SELECT coalesce(jsonb_object_agg(owner_type, n), '{}'::jsonb) FROM (
      SELECT owner_type, count(DISTINCT owner_key) AS n FROM matched GROUP BY owner_type
    ) s),
    (SELECT coalesce(jsonb_object_agg(ptad, n), '{}'::jsonb) FROM (
      SELECT ptad, count(DISTINCT owner_key) AS n FROM matched GROUP BY ptad
    ) s),
    (SELECT coalesce(jsonb_object_agg(county, n), '{}'::jsonb) FROM (
      SELECT county, count(DISTINCT owner_key) AS n FROM matched GROUP BY county
    ) s)
  INTO owners, by_type, by_ptad, by_county;
  RETURN jsonb_build_object(
    'owners', coalesce(owners, 0),
    'by_owner_type', coalesce(by_type, '{}'::jsonb),
    'by_ptad', coalesce(by_ptad, '{}'::jsonb),
    'by_county', coalesce(by_county, '{}'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.permit_parcel_owners_count(text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.permit_parcel_owners_count(text, jsonb) TO anon, authenticated, service_role;
