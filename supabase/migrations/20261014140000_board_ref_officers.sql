-- Per-state official-data officer cache. Join locally after a SODA/CSV hit.
-- Does not change fetch_permit_parcel_owner_leads or its indexes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS permit_parcel.board_ref_officers (
  id bigserial PRIMARY KEY,
  state text NOT NULL,
  source text NOT NULL,
  entity_name text NOT NULL,
  entity_name_norm text NOT NULL,
  city text,
  zip text,
  officer_name text NOT NULL,
  officer_role text NOT NULL DEFAULT '',
  license_number text,
  source_url text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state, source, entity_name_norm, officer_name, officer_role)
);

CREATE INDEX IF NOT EXISTS board_ref_officers_trgm
  ON permit_parcel.board_ref_officers USING gin (entity_name_norm gin_trgm_ops);

CREATE INDEX IF NOT EXISTS board_ref_officers_state_norm
  ON permit_parcel.board_ref_officers (state, entity_name_norm);

ALTER TABLE permit_parcel.board_ref_officers ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.upsert_permit_parcel_board_ref(
  p_secret text,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  insert into permit_parcel.board_ref_officers (
    state, source, entity_name, entity_name_norm, city, zip,
    officer_name, officer_role, license_number, source_url, fetched_at
  )
  select
    upper(coalesce(r->>'state', '')),
    r->>'source',
    r->>'entity_name',
    coalesce(nullif(r->>'entity_name_norm', ''), lower(r->>'entity_name')),
    r->>'city',
    r->>'zip',
    r->>'officer_name',
    r->>'officer_role',
    r->>'license_number',
    r->>'source_url',
    now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where nullif(r->>'officer_name', '') is not null
    and nullif(r->>'entity_name', '') is not null
  on conflict (state, source, entity_name_norm, officer_name, officer_role) do update set
    city = coalesce(excluded.city, permit_parcel.board_ref_officers.city),
    zip = coalesce(excluded.zip, permit_parcel.board_ref_officers.zip),
    source_url = coalesce(excluded.source_url, permit_parcel.board_ref_officers.source_url),
    fetched_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_permit_parcel_board_ref(
  p_secret text,
  p_state text,
  p_source text DEFAULT NULL,
  p_name_norm text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_zip text DEFAULT NULL,
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  rows jsonb;
  lim integer := greatest(1, least(coalesce(p_limit, 25), 50));
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;
  if p_name_norm is null or p_name_norm = '' then
    return jsonb_build_object('ok', true, 'rows', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows
  from (
    select
      o.state, o.source, o.entity_name, o.entity_name_norm, o.city, o.zip,
      o.officer_name, o.officer_role, o.license_number, o.source_url
    from permit_parcel.board_ref_officers o
    where o.state = upper(p_state)
      and (p_source is null or o.source = p_source)
      and (
        o.entity_name_norm = lower(p_name_norm)
        or o.entity_name_norm % lower(p_name_norm)
      )
    order by
      similarity(o.entity_name_norm, lower(p_name_norm)) desc,
      case when lower(coalesce(o.city, '')) = lower(coalesce(p_city, '')) then 0 else 1 end,
      case when left(regexp_replace(coalesce(o.zip, ''), '\D', '', 'g'), 5)
             = left(regexp_replace(coalesce(p_zip, ''), '\D', '', 'g'), 5)
           then 0 else 1 end
    limit lim
  ) x;

  return jsonb_build_object('ok', true, 'rows', rows);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_permit_parcel_board_ref(text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lookup_permit_parcel_board_ref(text, text, text, text, text, text, integer) TO anon, authenticated, service_role;
