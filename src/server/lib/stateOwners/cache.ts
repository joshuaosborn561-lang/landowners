import { getSupabase, hasSupabase, ingestSecret } from '../supabase.js';
import type { BoardSource } from './types.js';

export interface BoardCacheRow {
  board: BoardSource;
  cache_key: string;
  http_status: number | null;
  body: string | null;
  fetched_at: string | null;
}

export function licenseCacheKey(license: string): string {
  return `lic:${String(license || '').trim().toUpperCase()}`;
}

export function nameStateCacheKey(name: string, state: string): string {
  return `name:${String(name || '').trim().toUpperCase().replace(/\s+/g, ' ')}|${String(state || '')
    .trim()
    .toUpperCase()}`;
}

export async function readBoardCache(
  board: BoardSource,
  cacheKey: string,
): Promise<BoardCacheRow | null> {
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
  return {
    board,
    cache_key: cacheKey,
    http_status: typed.http_status ?? null,
    body: typed.body ?? null,
    fetched_at: typed.fetched_at ?? null,
  };
}

export async function writeBoardCache(row: {
  board: BoardSource;
  cache_key: string;
  http_status: number | null;
  body: string | null;
}): Promise<void> {
  if (!hasSupabase()) return;
  await getSupabase().rpc('upsert_permit_parcel_board_cache', {
    p_secret: ingestSecret(),
    p_board: row.board,
    p_cache_key: row.cache_key,
    p_http_status: row.http_status,
    p_body: row.body,
  });
}
