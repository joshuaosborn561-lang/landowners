import { getSupabase, hasSupabase, ingestSecret } from '../supabase.js';
import { incapsulaDetected, looksBlocked } from './http.js';
import type { BoardSource } from './types.js';

export interface BoardCacheRow {
  board: BoardSource;
  cache_key: string;
  http_status: number | null;
  body: string | null;
  fetched_at: string | null;
  query_string?: string | null;
  fetched_url?: string | null;
}

export interface BoardCacheMeta {
  query_string?: string | null;
  fetched_url?: string | null;
}

const META_RE = /^<!--board_meta:({.*?})-->\n?/;

export function encodeCacheBody(body: string, meta?: BoardCacheMeta): string {
  if (!meta?.query_string && !meta?.fetched_url) return body;
  return `<!--board_meta:${JSON.stringify({
    query_string: meta.query_string || null,
    fetched_url: meta.fetched_url || null,
  })}-->\n${body}`;
}

export function decodeCacheBody(body: string): {
  text: string;
  query_string: string | null;
  fetched_url: string | null;
} {
  const raw = String(body || '');
  const m = raw.match(META_RE);
  if (!m?.[1]) return { text: raw, query_string: null, fetched_url: null };
  try {
    const meta = JSON.parse(m[1]) as BoardCacheMeta;
    return {
      text: raw.slice(m[0].length),
      query_string: meta.query_string ?? null,
      fetched_url: meta.fetched_url ?? null,
    };
  } catch {
    return { text: raw, query_string: null, fetched_url: null };
  }
}

export function licenseCacheKey(license: string): string {
  return `lic:${String(license || '').trim().toUpperCase()}`;
}

export function nameStateCacheKey(name: string, state: string): string {
  return `name:${String(name || '').trim().toUpperCase().replace(/\s+/g, ' ')}|${String(state || '')
    .trim()
    .toUpperCase()}`;
}

/** Cached Incapsula / 4xx / WAF shells must not replace a live (or proxied) fetch. */
export function isBlockedBoardCache(row: { http_status?: number | null; body?: string | null }): boolean {
  const status = row.http_status ?? 0;
  const body = row.body ?? '';
  if (status >= 400) return true;
  if (looksBlocked(status, body)) return true;
  if (incapsulaDetected(body)) return true;
  return false;
}

export function shouldReuseBoardCache(row: { http_status?: number | null; body?: string | null }): boolean {
  if (row.body == null || row.http_status == null) return false;
  return !isBlockedBoardCache(row);
}

export function formatMaCacheBypassLog(opts: {
  board: string;
  status?: number | null;
  body?: string | null;
}): string {
  return `[ma-cache] board=${opts.board} bypass=blocked status=${opts.status ?? 0} incapsula=${incapsulaDetected(opts.body || '') ? 'yes' : 'no'}`;
}

type CacheRead = (board: BoardSource, cacheKey: string) => Promise<BoardCacheRow | null>;
let cacheReadOverride: CacheRead | null = null;

export function setBoardCacheReadForTests(fn: CacheRead | null): void {
  cacheReadOverride = fn;
}

export async function readBoardCache(
  board: BoardSource,
  cacheKey: string,
): Promise<BoardCacheRow | null> {
  if (cacheReadOverride) return cacheReadOverride(board, cacheKey);
  if (!hasSupabase()) return null;
  const { data, error } = await getSupabase().rpc('fetch_permit_parcel_board_cache', {
    p_secret: ingestSecret(),
    p_board: board,
    p_cache_key: cacheKey,
  });
  if (error) return null;
  const row = data as BoardCacheRow | { ok?: boolean; found?: boolean } | null;
  if (!row || (row as { found?: boolean }).found === false) return null;
  const typed = row as BoardCacheRow;
  if (!typed.cache_key && !(typed as { body?: string }).body) return null;
  const decoded = decodeCacheBody(typed.body ?? '');
  return {
    board,
    cache_key: cacheKey,
    http_status: typed.http_status ?? null,
    body: decoded.text,
    fetched_at: typed.fetched_at ?? null,
    query_string: typed.query_string ?? decoded.query_string,
    fetched_url: typed.fetched_url ?? decoded.fetched_url,
  };
}

export async function writeBoardCache(row: {
  board: BoardSource;
  cache_key: string;
  http_status: number | null;
  body: string | null;
  query_string?: string | null;
  fetched_url?: string | null;
}): Promise<void> {
  if (cacheReadOverride) return;
  if (!hasSupabase()) return;
  const body = encodeCacheBody(row.body ?? '', {
    query_string: row.query_string,
    fetched_url: row.fetched_url,
  });
  const payload: Record<string, unknown> = {
    p_secret: ingestSecret(),
    p_board: row.board,
    p_cache_key: row.cache_key,
    p_http_status: row.http_status,
    p_body: body,
  };
  if (row.query_string || row.fetched_url) {
    payload.p_query_string = row.query_string ?? null;
    payload.p_fetched_url = row.fetched_url ?? null;
  }
  const { error } = await getSupabase().rpc('upsert_permit_parcel_board_cache', payload);
  if (error && (row.query_string || row.fetched_url)) {
    await getSupabase().rpc('upsert_permit_parcel_board_cache', {
      p_secret: ingestSecret(),
      p_board: row.board,
      p_cache_key: row.cache_key,
      p_http_status: row.http_status,
      p_body: body,
    });
  }
}
