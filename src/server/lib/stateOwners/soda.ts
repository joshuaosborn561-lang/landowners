import { sodaNameNeedle } from './names.js';

export interface SodaGetResult {
  status: number;
  rows: unknown[];
  url: string;
  query_string: string;
  body: string;
}

export function sodaWhereContains(column: string, name: string): string {
  const needle = sodaNameNeedle(name).replace(/'/g, "''");
  if (!needle) return '1=0';
  const tokens = needle.split(' ').filter(Boolean);
  const likes = tokens.map((t) => `upper(${column}) like '%${t}%'`);
  return likes.join(' AND ');
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
