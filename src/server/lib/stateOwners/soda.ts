import { sodaNameNeedle } from './names.js';

export interface SodaGetResult {
  status: number;
  rows: unknown[];
  url: string;
  query_string: string;
  body: string;
}

const STOP = new Set(['AND', 'THE', 'FOR', 'OF', 'WITH']);

export function sodaTokens(name: string): string[] {
  return sodaNameNeedle(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

export function sodaWhereContains(column: string, name: string): string {
  const tokens = sodaTokens(name);
  if (!tokens.length) return '1=0';
  return tokens.map((t) => `upper(${column}) like '%${t.replace(/'/g, "''")}%'`).join(' AND ');
}

/** First one or two distinctive tokens so a tight AND does not miss. */
export function sodaWhereContainsLoose(column: string, name: string): string {
  const tokens = sodaTokens(name);
  const pick = tokens.slice(0, tokens.length >= 3 ? 2 : 1);
  if (!pick.length) return sodaWhereContains(column, name);
  return pick.map((t) => `upper(${column}) like '%${t.replace(/'/g, "''")}%'`).join(' AND ');
}

export async function fetchSodaJson(
  baseUrl: string,
  opts: { where: string; limit?: number; select?: string },
): Promise<SodaGetResult> {
  const params = new URLSearchParams();
  params.set('$where', opts.where);
  params.set('$limit', String(opts.limit ?? 25));
  if (opts.select) params.set('$select', opts.select);
  const query_string = params.toString();
  const url = `${baseUrl}?${query_string}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PermitsMCP/2.2 (open-data lookup)' },
  });
  const body = await res.text();
  let rows: unknown[] = [];
  try {
    const parsed = JSON.parse(body);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    rows = [];
  }
  return { status: res.status, rows, url: res.url || url, query_string, body };
}

/** Tight token AND, then a looser 1–2 token query when that returns no rows. */
export async function fetchSodaName(
  baseUrl: string,
  column: string,
  name: string,
  limit = 50,
): Promise<SodaGetResult> {
  const tight = sodaWhereContains(column, name);
  const got = await fetchSodaJson(baseUrl, { where: tight, limit });
  if (got.status === 200 && got.rows.length) return got;
  const loose = sodaWhereContainsLoose(column, name);
  if (loose === tight) return got;
  const retry = await fetchSodaJson(baseUrl, { where: loose, limit });
  if (retry.status === 200 && retry.rows.length) return retry;
  return got.status === 200 ? got : retry;
}
