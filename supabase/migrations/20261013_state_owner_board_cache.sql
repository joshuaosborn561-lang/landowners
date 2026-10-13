-- State owner lookup: per-board page cache + list reader that joins ps_contractors.
-- Additive. Does not rename permit_parcel / scrape_leads / contact_enrichment.

CREATE TABLE IF NOT EXISTS permit_parcel.board_page_cache (
  board text NOT NULL,
  cache_key text NOT NULL,
  http_status integer,
  body text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_pp_board_cache_fetched
  ON permit_parcel.board_page_cache (board, fetched_at DESC);

ALTER TABLE permit_parcel.board_page_cache ENABLE ROW LEVEL SECURITY;

ALTER TABLE permit_parcel.contact_enrichment
  ADD COLUMN IF NOT EXISTS owner_source text;

COMMENT ON TABLE permit_parcel.board_page_cache IS
  'Raw board page text keyed by license or name+state. Never fetch the same record twice.';

CREATE OR REPLACE FUNCTION public.fetch_permit_parcel_board_cache(
  p_secret text,
  p_board text,
  p_cache_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  row_json jsonb;
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  select jsonb_build_object(
    'ok', true,
    'found', true,
    'board', c.board,
    'cache_key', c.cache_key,
    'http_status', c.http_status,
    'body', c.body,
    'fetched_at', c.fetched_at
  )
  into row_json
  from permit_parcel.board_page_cache c
  where c.board = p_board
    and c.cache_key = p_cache_key;

  if row_json is not null then
    return row_json;
  end if;

  -- Reuse the Oct 2026 CSLB scrape so a license is never fetched twice.
  if p_board = 'cslb' and p_cache_key like 'lic:%' then
    select jsonb_build_object(
      'ok', true,
      'found', true,
      'board', 'cslb',
      'cache_key', p_cache_key,
      'http_status', s.http_status,
      'body', s.body,
      'fetched_at', s.fetched_at
    )
    into row_json
    from permit_parcel.ps_cslb s
    where s.license_number = regexp_replace(p_cache_key, '^lic:', '')
    limit 1;
    if row_json is not null then
      return row_json;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'found', false, 'board', p_board, 'cache_key', p_cache_key);
end;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_permit_parcel_board_cache(
  p_secret text,
  p_board text,
  p_cache_key text,
  p_http_status integer,
  p_body text
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

  insert into permit_parcel.board_page_cache (board, cache_key, http_status, body, fetched_at)
  values (p_board, p_cache_key, p_http_status, p_body, now())
  on conflict (board, cache_key) do update set
    http_status = excluded.http_status,
    body = excluded.body,
    fetched_at = now();

  return jsonb_build_object('ok', true, 'board', p_board, 'cache_key', p_cache_key);
end;
$function$;

CREATE OR REPLACE FUNCTION public.fetch_permit_parcel_owner_leads(
  p_secret text,
  p_list_id text,
  p_states text[] DEFAULT NULL,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'permit_parcel'
AS $function$
declare
  expected text;
  rows jsonb;
  lim integer := greatest(1, least(coalesce(p_limit, 25), 100));
  off integer := greatest(0, coalesce(p_offset, 0));
begin
  select value into expected from private.app_secrets where key = 'ingest_secret';
  if expected is null or p_secret is distinct from expected then
    raise exception 'unauthorized';
  end if;

  if p_list_id is null or p_list_id = '' then
    return jsonb_build_object('ok', false, 'error', 'list_id required', 'rows', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  into rows
  from (
    select
      sl.job_id as list_id,
      sl.id as lead_id,
      sl.place_id,
      sl.name as company_name,
      sl.owner_name as contact_name,
      sl.email,
      sl.phone,
      sl.city,
      sl.state,
      coalesce(
        nullif(sl.raw->>'license_number', ''),
        pc.license_number
      ) as license_number,
      coalesce(pc.id::text, replace(sl.place_id, 'shovels:', '')) as contractor_id
    from public.scrape_leads sl
    left join lateral (
      select p.id, p.license_number
      from permit_parcel.ps_contractors p
      where (
          sl.place_id like 'shovels:%'
          and p.id::text = replace(sl.place_id, 'shovels:', '')
        )
        or (
          lower(p.name) = lower(sl.name)
          and upper(coalesce(p.state, '')) = upper(coalesce(sl.state, ''))
        )
      order by
        (sl.place_id like 'shovels:%' and p.id::text = replace(sl.place_id, 'shovels:', '')) desc,
        (lower(coalesce(p.city, '')) = lower(coalesce(sl.city, ''))) desc
      limit 1
    ) pc on true
    where sl.job_id = p_list_id
      and (
        p_states is null
        or cardinality(p_states) = 0
        or upper(coalesce(sl.state, '')) = any (
          select upper(s) from unnest(p_states) s
        )
      )
    order by sl.id
    offset off
    limit lim
  ) x;

  return jsonb_build_object('ok', true, 'rows', rows);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.fetch_permit_parcel_board_cache(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_permit_parcel_board_cache(text, text, text, integer, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fetch_permit_parcel_owner_leads(text, text, text[], integer, integer) TO anon, authenticated, service_role;
