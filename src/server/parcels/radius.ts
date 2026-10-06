import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Downtown Dallas. The 60-mile set is every Texas county whose boundary intersects this circle. */
export const DALLAS = { lat: 32.7767, lon: -96.797 };
export const RADIUS_MILES = 60;

/**
 * Rough list from the request, used only to flag differences.
 * Membership itself comes from the TIGER/Line geometries.
 */
export const ROUGH_EXPECTED_COUNTIES = [
  'Dallas',
  'Tarrant',
  'Collin',
  'Denton',
  'Rockwall',
  'Kaufman',
  'Ellis',
  'Johnson',
  'Hunt',
  'Parker',
  'Wise',
  'Grayson',
  'Fannin',
  'Navarro',
  'Hill',
  'Henderson',
  'Van Zandt',
  'Hood',
] as const;

export interface RadiusCounty {
  name: string;
  state: 'TX';
  fips: string;
  /** 0 when downtown Dallas is inside the county. */
  boundary_miles: number;
}

export interface RadiusDiff {
  computed: string[];
  missing_from_computed: string[];
  extra_vs_expected: string[];
}

interface GeoFeature {
  properties: { name: string; fips: string; state: string };
  geometry: { type: string; coordinates: number[][][] | number[][][][] };
}

const MILES_PER_DEG_LAT = 69.0;
const MILES_PER_DEG_LON = 69.172 * Math.cos((DALLAS.lat * Math.PI) / 180);

function geojsonPath(): string {
  return join(process.cwd(), 'data', 'geo', 'tl_2025_tx_counties.geojson');
}

/** Local equirectangular miles centered on downtown Dallas. */
export function toLocalMiles(lat: number, lon: number): { x: number; y: number } {
  return {
    x: (lon - DALLAS.lon) * MILES_PER_DEG_LON,
    y: (lat - DALLAS.lat) * MILES_PER_DEG_LAT,
  };
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringsOf(geometry: GeoFeature['geometry']): number[][][] {
  if (geometry.type === 'Polygon') return geometry.coordinates as number[][][];
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as number[][][][]).flat();
  }
  return [];
}

/** Minimum miles from downtown Dallas to the county boundary. 0 if the point is inside. */
export function boundaryMiles(geometry: GeoFeature['geometry']): number {
  const rings = ringsOf(geometry);
  for (const ring of rings) {
    if (ring.length >= 3 && pointInRing(DALLAS.lon, DALLAS.lat, ring)) return 0;
  }
  let min = Infinity;
  for (const ring of rings) {
    const pts = ring.map(([lon, lat]) => toLocalMiles(lat!, lon!));
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSegment(0, 0, pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y);
      if (d < min) min = d;
    }
  }
  return min;
}

let cache: RadiusCounty[] | null = null;

/**
 * Texas counties whose TIGER/Line boundary intersects the radius around downtown Dallas.
 * Geometries are Census TIGER/Line 2025 (tl_2025_us_county), simplified only for file size.
 */
export function countiesWithinDallasRadius(miles = RADIUS_MILES): RadiusCounty[] {
  if (cache && miles === RADIUS_MILES) return cache;
  const fc = JSON.parse(readFileSync(geojsonPath(), 'utf8')) as { features: GeoFeature[] };
  const hits: RadiusCounty[] = [];
  for (const feature of fc.features) {
    if (feature.properties.state !== 'TX') continue;
    const boundary = boundaryMiles(feature.geometry);
    if (boundary <= miles) {
      hits.push({
        name: feature.properties.name,
        state: 'TX',
        fips: feature.properties.fips,
        boundary_miles: Math.round(boundary * 100) / 100,
      });
    }
  }
  hits.sort((a, b) => a.boundary_miles - b.boundary_miles || a.name.localeCompare(b.name));
  if (miles === RADIUS_MILES) cache = hits;
  return hits;
}

export function radiusDiff(counties: RadiusCounty[] = countiesWithinDallasRadius()): RadiusDiff {
  const computed = counties.map((c) => c.name);
  const got = new Set(computed);
  const expected = new Set<string>(ROUGH_EXPECTED_COUNTIES);
  return {
    computed,
    missing_from_computed: ROUGH_EXPECTED_COUNTIES.filter((name) => !got.has(name)),
    extra_vs_expected: computed.filter((name) => !expected.has(name)),
  };
}
