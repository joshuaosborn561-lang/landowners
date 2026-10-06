import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CountyConfig, RegisteredCounty } from './countyTypes.js';
import {
  countiesWithinDallasRadius,
  radiusDiff,
  type RadiusCounty,
  type RadiusDiff,
} from './radius.js';

interface CountiesFile {
  counties: CountyConfig[];
}

let configCache: CountyConfig[] | null = null;

export function loadCountyConfig(): CountyConfig[] {
  if (configCache) return configCache;
  const path = join(process.cwd(), 'data', 'parcels', 'counties.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CountiesFile;
  configCache = parsed.counties.map((county) => ({
    ...county,
    name: county.name.trim(),
    state: county.state.trim().toUpperCase(),
  }));
  return configCache;
}

function keyOf(state: string, name: string): string {
  return `${state.trim().toUpperCase()}:${name.trim().toLowerCase()}`;
}

/**
 * Registered counties = TIGER radius hits, plus any county in config
 * (so a county anywhere in the US is a config change). inside_60_miles is
 * never taken from config. A radius county missing from config stays needs_request.
 */
export function mergeRegisteredCounties(
  config: CountyConfig[],
  radiusHits: RadiusCounty[],
): RegisteredCounty[] {
  const byKey = new Map<string, RegisteredCounty>();
  for (const hit of radiusHits) {
    byKey.set(keyOf(hit.state, hit.name), {
      name: hit.name,
      state: hit.state,
      fips: hit.fips,
      source_type: 'open_records',
      source_url: null,
      parser: 'open_records',
      refresh_cadence: 'annual',
      status: 'needs_request',
      notes: 'No free bulk appraisal export is registered. File an open records request.',
      inside_60_miles: true,
      boundary_miles: hit.boundary_miles,
    });
  }
  for (const cfg of config) {
    const key = keyOf(cfg.state, cfg.name);
    const prev = byKey.get(key);
    byKey.set(key, {
      name: cfg.name,
      state: cfg.state.toUpperCase(),
      fips: cfg.fips || prev?.fips || null,
      source_type: cfg.source_type,
      source_url: cfg.source_url,
      layout_url: cfg.layout_url ?? null,
      parser: cfg.parser,
      refresh_cadence: cfg.refresh_cadence,
      status: cfg.status,
      notes: cfg.notes,
      order_by: cfg.order_by,
      page_size: cfg.page_size,
      delimiter: cfg.delimiter,
      field_map: cfg.field_map,
      dataset_id: cfg.dataset_id,
      inside_60_miles: prev?.inside_60_miles ?? false,
      boundary_miles: prev?.boundary_miles ?? null,
    });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.inside_60_miles !== b.inside_60_miles) return a.inside_60_miles ? -1 : 1;
    return (a.boundary_miles ?? 999) - (b.boundary_miles ?? 999) || a.name.localeCompare(b.name);
  });
}

/** TIGER 60-mile Texas set merged with data/parcels/counties.json. */
export function registeredCounties(): { counties: RegisteredCounty[]; radius: RadiusDiff } {
  const radiusHits = countiesWithinDallasRadius();
  return {
    counties: mergeRegisteredCounties(loadCountyConfig(), radiusHits),
    radius: radiusDiff(radiusHits),
  };
}

export function findRegisteredCounty(name: string, state = 'TX'): RegisteredCounty {
  const wanted = keyOf(state, name);
  const hit = registeredCounties().counties.find((county) => keyOf(county.state, county.name) === wanted);
  if (!hit) {
    throw new Error(
      `County ${name}, ${state} is not registered. Add it to data/parcels/counties.json (name, state, fips, source_type, source_url, parser, refresh_cadence, status).`,
    );
  }
  return hit;
}

export function assertRegisteredCounty(name: string | undefined, state?: string): RegisteredCounty | null {
  if (!name) return null;
  return findRegisteredCounty(name, state ?? 'TX');
}
