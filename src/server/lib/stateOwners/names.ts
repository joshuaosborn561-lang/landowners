const COMPANY_WORDS =
  /\b(INC|LLC|L\.?L\.?C\.?|INCORPORATED|LTD|LP|LLP|PLLC|PC|PA|CO|COMPANY|CORP|CORPORATION|CONSTRUCTION|BUILDERS?|ELECTRIC|ELECTRICAL|PLUMBING|ROOFING|SERVICES?)\b/i;

const LEGAL_SUFFIX =
  /\b(THE|A|AN|LLC|L\s*L\s*C|INC|INCORPORATED|LTD|LP|LLP|PLLC|PC|PA|CO|COMPANY|CORP|CORPORATION)\b/gi;

/** Split `LEGAL NAME DBA TRADE NAME` so both sides can be scored. */
export function splitLegalAndDba(name: string): { legal: string; dba: string | null } {
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  const m = raw.match(/^(.*?)\s+\bD\s*\.?\s*B\s*\.?\s*A\.?\s+(.+)$/i);
  if (!m?.[1] || !m[2]) return { legal: raw, dba: null };
  return { legal: m[1].trim(), dba: m[2].trim() };
}

/** Strip punctuation, legal suffixes, and a trailing "DBA …" / "D/B/A …". */
export function normalizeCompanyName(name: string): string {
  return String(name || '')
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bD\s*\.?\s*B\s*\.?\s*A\.?\s+.+$/i, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCompanyWord(name: string): boolean {
  return COMPANY_WORDS.test(name || '');
}

export function tokenizeCapsName(raw: string): string[] {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export interface SplitPersonName {
  first_name: string | null;
  last_name: string | null;
  full_name_raw: string;
  review_flag: boolean;
}

/**
 * ALL-CAPS board names. Last token is last name only for 2–3 tokens.
 * 4+ tokens: first_name stays null and review_flag is set — do not guess.
 */
export function splitPersonName(raw: string): SplitPersonName {
  const full_name_raw = String(raw || '').replace(/\s+/g, ' ').trim();
  const tokens = tokenizeCapsName(full_name_raw);
  if (tokens.length === 2 || tokens.length === 3) {
    return {
      first_name: tokens.slice(0, -1).join(' '),
      last_name: tokens[tokens.length - 1] || null,
      full_name_raw,
      review_flag: false,
    };
  }
  if (tokens.length >= 4) {
    return { first_name: null, last_name: null, full_name_raw, review_flag: true };
  }
  return { first_name: null, last_name: tokens[0] || null, full_name_raw, review_flag: tokens.length !== 1 };
}

/**
 * Board registries print `LAST, FIRST M` (WA L&I, TDLR). Fall back to
 * space-delimited splitPersonName when there is no comma.
 */
export function parseBoardPersonName(raw: string): SplitPersonName {
  const full_name_raw = String(raw || '').replace(/\s+/g, ' ').trim();
  const comma = full_name_raw.indexOf(',');
  if (comma < 0) return splitPersonName(full_name_raw);
  const lastTokens = tokenizeCapsName(full_name_raw.slice(0, comma));
  const firstTokens = tokenizeCapsName(full_name_raw.slice(comma + 1));
  if (lastTokens.length === 1 && firstTokens.length >= 1 && firstTokens.length <= 2) {
    return {
      first_name: firstTokens.join(' '),
      last_name: lastTokens[0] || null,
      full_name_raw,
      review_flag: false,
    };
  }
  return {
    first_name: firstTokens.length ? firstTokens.join(' ') : null,
    last_name: lastTokens[0] || null,
    full_name_raw,
    review_flag: true,
  };
}

/** 2–3 capitalized words and no company/trade tokens → treat as a person. */
export function looksLikeSolePropPerson(businessName: string): boolean {
  const tokens = tokenizeCapsName(businessName);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (hasCompanyWord(businessName)) return false;
  return tokens.every((t) => /^[A-Z]+$/.test(t) && t.length >= 2);
}

export function personKey(name: string): string {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Capture the value after a label on the same line or the next line. */
export function labeledValue(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\s*:?\\s*([^\\n]{0,160})`, 'i');
  const cap = String(text || '').replace(/\r/g, '').match(re)?.[1]?.trim() || '';
  return cap || null;
}

/** True when normalized names are equal or one contains the other. */
export function namesMatchNormalized(a: string, b: string): boolean {
  const left = normalizeCompanyName(a);
  const right = normalizeCompanyName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

export function pickBestNameMatch<T>(
  target: string,
  items: T[],
  nameOf: (item: T) => string,
): T | null {
  return pickBestNameMatchScored(target, items, nameOf, { allowTrigram: false })?.item ?? null;
}

export function trigramSimilarity(a: string, b: string): number {
  const left = normalizeCompanyName(a);
  const right = normalizeCompanyName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (s: string): string[] => {
    const padded = `  ${s} `;
    const out: string[] = [];
    for (let i = 0; i <= padded.length - 3; i += 1) out.push(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(left);
  const gb = grams(right);
  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of gb) {
    const n = counts.get(g) || 0;
    if (n > 0) {
      inter += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * inter) / (ga.length + gb.length);
}

export const TRIGRAM_THRESHOLD = 0.48;

export interface NameMatchHit<T> {
  item: T;
  score: number;
  method: 'exact' | 'substring' | 'trigram';
}

export function pickBestNameMatchScored<T>(
  target: string,
  items: T[],
  nameOf: (item: T) => string,
  opts?: {
    city?: string | null;
    zip?: string | null;
    cityOf?: (item: T) => string | null | undefined;
    zipOf?: (item: T) => string | null | undefined;
    minTrigram?: number;
    allowTrigram?: boolean;
    /** Default true. MN DLI turns this off so "Jones" cannot match "Jones and Sons". */
    allowSubstring?: boolean;
  },
): NameMatchHit<T> | null {
  const key = normalizeCompanyName(target);
  if (!key) return null;
  const minTrigram = opts?.minTrigram ?? TRIGRAM_THRESHOLD;
  let best: NameMatchHit<T> | null = null;
  let second = 0;
  for (const item of items) {
    const hit = normalizeCompanyName(nameOf(item));
    if (!hit) continue;
    let score = 0;
    let method: NameMatchHit<T>['method'] = 'trigram';
    if (hit === key) {
      score = 100;
      method = 'exact';
    } else if (opts?.allowSubstring !== false && (hit.includes(key) || key.includes(hit))) {
      score = 80;
      method = 'substring';
    } else if (opts?.allowTrigram !== false) {
      const tri = trigramSimilarity(key, hit);
      if (tri >= minTrigram) {
        score = Math.round(tri * 100);
        method = 'trigram';
      }
    }
    if (score > 0) {
      const city = String(opts?.city || '').trim().toLowerCase();
      const zip = String(opts?.zip || '').replace(/\D/g, '').slice(0, 5);
      const itemCity = String(opts?.cityOf?.(item) || '').trim().toLowerCase();
      const itemZip = String(opts?.zipOf?.(item) || '').replace(/\D/g, '').slice(0, 5);
      if (city && itemCity && city === itemCity) score += 8;
      if (zip && itemZip && zip === itemZip) score += 5;
    }
    if (score > (best?.score || 0)) {
      second = best?.score || 0;
      best = { item, score, method };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best) return null;
  if (best.method === 'trigram' && best.score < Math.round(minTrigram * 100)) return null;
  if (best.method === 'trigram' && second > 0 && best.score - second < 5) return null;
  if (best.method !== 'trigram' && best.score < 70) return null;
  return best;
}

const REGISTRY_AGENT =
  /\b(corporation service|ct corporation|c t corporation|cogency|legalzoom|registered agents?|national registered|united agent|northwest registered|incorp services|northwest registered agent)\b/i;

export function isRegistryAgentName(name: string): boolean {
  return REGISTRY_AGENT.test(name || '');
}

export function sodaNameNeedle(name: string): string {
  const tokens = normalizeCompanyName(name)
    .split(' ')
    .filter((t) => t.length >= 3)
    .slice(0, 4);
  return tokens.join(' ') || normalizeCompanyName(name).slice(0, 24);
}

export function hasUsableBusinessName(name: string | null | undefined): boolean {
  return normalizeCompanyName(name || '').length >= 3;
}

export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|dt|dd|table|section|header|td|th)>/gi, '\n')
    .replace(/<(td|tr|div|p|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/gi, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function lineAfter(text: string, label: string): string | null {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  if (idx < 0) return null;
  return lines[idx + 1] || null;
}

export function lineStarting(text: string, prefix: string): string | null {
  const hit = text
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(prefix.toLowerCase()));
  return hit ?? null;
}

export function normalizeState(state: string | null | undefined): string {
  const raw = String(state || '').trim().toUpperCase();
  const names: Record<string, string> = {
    ALABAMA: 'AL',
    ALASKA: 'AK',
    ARIZONA: 'AZ',
    ARKANSAS: 'AR',
    CALIFORNIA: 'CA',
    COLORADO: 'CO',
    CONNECTICUT: 'CT',
    DELAWARE: 'DE',
    FLORIDA: 'FL',
    GEORGIA: 'GA',
    HAWAII: 'HI',
    IDAHO: 'ID',
    ILLINOIS: 'IL',
    INDIANA: 'IN',
    IOWA: 'IA',
    KANSAS: 'KS',
    KENTUCKY: 'KY',
    LOUISIANA: 'LA',
    MAINE: 'ME',
    MARYLAND: 'MD',
    MASSACHUSETTS: 'MA',
    MICHIGAN: 'MI',
    MINNESOTA: 'MN',
    MISSISSIPPI: 'MS',
    MISSOURI: 'MO',
    MONTANA: 'MT',
    NEBRASKA: 'NE',
    NEVADA: 'NV',
    'NEW HAMPSHIRE': 'NH',
    'NEW JERSEY': 'NJ',
    'NEW MEXICO': 'NM',
    'NEW YORK': 'NY',
    'NORTH CAROLINA': 'NC',
    'NORTH DAKOTA': 'ND',
    OHIO: 'OH',
    OKLAHOMA: 'OK',
    OREGON: 'OR',
    PENNSYLVANIA: 'PA',
    'RHODE ISLAND': 'RI',
    'SOUTH CAROLINA': 'SC',
    'SOUTH DAKOTA': 'SD',
    TENNESSEE: 'TN',
    TEXAS: 'TX',
    UTAH: 'UT',
    VERMONT: 'VT',
    VIRGINIA: 'VA',
    WASHINGTON: 'WA',
    'WEST VIRGINIA': 'WV',
    WISCONSIN: 'WI',
    WYOMING: 'WY',
    'DISTRICT OF COLUMBIA': 'DC',
    'WASHINGTON DC': 'DC',
    'WASHINGTON D C': 'DC',
  };
  if (raw.length === 2) return raw;
  return names[raw] || raw;
}

const NYC_CITIES = new Set([
  'NEW YORK',
  'NYC',
  'NEW YORK CITY',
  'MANHATTAN',
  'BROOKLYN',
  'QUEENS',
  'BRONX',
  'THE BRONX',
  'STATEN ISLAND',
]);

export function isNycCity(city: string | null | undefined): boolean {
  const c = String(city || '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return NYC_CITIES.has(c);
}
