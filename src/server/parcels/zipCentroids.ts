import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DALLAS } from './radius.js';

const execFileAsync = promisify(execFile);

const GAZETTEER_URLS = [
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip',
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip',
];

let centroids: Map<string, { lat: number; lon: number }> | null = null;

function cacheDir(): string {
  const dir = join(process.cwd(), 'data', 'geo', 'cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function milesFromDallas(lat: number, lon: number): number {
  return Math.round(haversineMiles(DALLAS.lat, DALLAS.lon, lat, lon) * 100) / 100;
}

async function ensureGazetteer(): Promise<string> {
  const dir = cacheDir();
  const existing = ['2025_Gaz_zcta_national.txt', '2024_Gaz_zcta_national.txt']
    .map((name) => join(dir, name))
    .find((path) => existsSync(path));
  if (existing) return existing;
  const zipPath = join(dir, 'zcta_gazetteer.zip');
  let lastError: unknown;
  for (const url of GAZETTEER_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`gazetteer HTTP ${response.status}`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
      await execFileAsync('unzip', ['-o', '-j', zipPath, '-d', dir]);
      const extracted = ['2025_Gaz_zcta_national.txt', '2024_Gaz_zcta_national.txt']
        .map((name) => join(dir, name))
        .find((path) => existsSync(path));
      if (!extracted) throw new Error('gazetteer zip did not contain a ZCTA file');
      return extracted;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not download Census ZCTA gazetteer: ${String(lastError)}`);
}

export async function loadZipCentroids(): Promise<Map<string, { lat: number; lon: number }>> {
  if (centroids) return centroids;
  const path = await ensureGazetteer();
  const map = new Map<string, { lat: number; lon: number }>();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const delimiter = line.includes('|') ? '|' : '\t';
    const cols = line.split(delimiter);
    if (!header) {
      header = cols.map((col) => col.trim().toUpperCase());
      continue;
    }
    const get = (name: string) => {
      const index = header!.indexOf(name);
      return index >= 0 ? cols[index]?.trim() ?? '' : '';
    };
    const zip = (get('GEOID') || get('GEOIDFQ')).replace(/\D/g, '').slice(0, 5);
    const lat = Number(get('INTPTLAT'));
    const lon = Number(get('INTPTLONG'));
    if (zip.length === 5 && Number.isFinite(lat) && Number.isFinite(lon)) {
      map.set(zip, { lat, lon });
    }
  }
  centroids = map;
  return map;
}

export function milesForZip(
  centroidsMap: Map<string, { lat: number; lon: number }>,
  zip: string | null,
): number | null {
  if (!zip) return null;
  const hit = centroidsMap.get(zip.slice(0, 5));
  if (!hit) return null;
  return milesFromDallas(hit.lat, hit.lon);
}
