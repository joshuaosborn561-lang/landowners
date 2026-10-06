import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PlaceHit {
  city: string;
  zip: string;
}

interface PlaceFile {
  Tarrant?: { by_code?: Record<string, PlaceHit> };
  Johnson?: { by_city?: Record<string, PlaceHit> };
}

let cache: PlaceFile | null = null;

function load(): PlaceFile {
  if (cache) return cache;
  const path = join(process.cwd(), 'data', 'parcels', 'place-miles.json');
  cache = JSON.parse(readFileSync(path, 'utf8')) as PlaceFile;
  return cache;
}

function codeKey(cityCode: string | null | undefined): string {
  const digits = (cityCode ?? '').replace(/\D/g, '');
  if (!digits) return '000';
  return digits.padStart(3, '0').slice(-3);
}

/**
 * Situs ZIP for counties whose roll has a city (or a city code) and no ZIP.
 * Tarrant's delimited file stores a 3-digit jurisdiction code. Johnson stores the city name.
 * ZIPs come from a Census geocoder match of one in-city situs address per place.
 */
export function lookupPlace(
  county: string,
  city: string | null | undefined,
  cityCode: string | null | undefined,
): PlaceHit | null {
  const file = load();
  if (county.toLowerCase() === 'tarrant') {
    return file.Tarrant?.by_code?.[codeKey(cityCode)] ?? null;
  }
  if (county.toLowerCase() === 'johnson') {
    const key = (city ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!key) return file.Johnson?.by_city?.[''] ?? null;
    return file.Johnson?.by_city?.[key] ?? null;
  }
  return null;
}
