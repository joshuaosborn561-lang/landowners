-- Additive only: nullable cache columns + cache RPCs.
-- Does not touch fetch_permit_parcel_owner_leads or its indexes.
-- Applied live on kemvxzhcxvynmoutwdrh as board_cache_query_url.

ALTER TABLE permit_parcel.board_page_cache
  ADD COLUMN IF NOT EXISTS query_string text;

ALTER TABLE permit_parcel.board_page_cache
  ADD COLUMN IF NOT EXISTS fetched_url text;

CREATE OR REPLACE FUNCTION public.upsert_permit_parcel_board_cache(
  p_secret text,
  p_board text,
  p_cache_key text,
  p_http_status integer,
  p_body text,
  p_query_string text DEFAULT NULL,
  p_fetched_url text DEFAULT NULL
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

  insert into permit_parcel.board_page_cache (
    board, cache_key, http_status, body, query_string, fetched_url, fetched_at
  )
  values (
    p_board, p_cache_key, p_http_status, p_body, p_query_string, p_fetched_url, now()
  )
  on conflict (board, cache_key) do update set
    http_status = excluded.http_status,
    body = excluded.body,
    query_string = coalesce(excluded.query_string, permit_parcel.board_page_cache.query_string),
    fetched_url = coalesce(excluded.fetched_url, permit_parcel.board_page_cache.fetched_url),
    fetched_at = now();

  return jsonb_build_object('ok', true, 'board', p_board, 'cache_key', p_cache_key);
end;
$function$;

-- Replace the old 5-arg overload so PostgREST has a single function.
DROP FUNCTION IF EXISTS public.upsert_permit_parcel_board_cache(text, text, text, integer, text);

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
    'query_string', c.query_string,
    'fetched_url', c.fetched_url,
    'fetched_at', c.fetched_at
  )
  into row_json
  from permit_parcel.board_page_cache c
  where c.board = p_board
    and c.cache_key = p_cache_key;

  if row_json is not null then
    return row_json;
  end if;

  if p_board = 'cslb' and p_cache_key like 'lic:%' then
    select jsonb_build_object(
      'ok', true,
      'found', true,
      'board', 'cslb',
      'cache_key', p_cache_key,
      'http_status', s.http_status,
      'body', s.body,
      'query_string', null,
      'fetched_url', null,
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

GRANT EXECUTE ON FUNCTION public.upsert_permit_parcel_board_cache(text, text, text, integer, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fetch_permit_parcel_board_cache(text, text, text) TO anon, authenticated, service_role;
