const COMPANY_WORDS =
  /\b(INC|LLC|L\.?L\.?C\.?|INCORPORATED|LTD|LP|LLP|PLLC|PC|PA|CO|COMPANY|CORP|CORPORATION|CONSTRUCTION|BUILDERS?|ELECTRIC|ELECTRICAL|PLUMBING|ROOFING|SERVICES?)\b/i;

const LEGAL_SUFFIX =
  /\b(THE|A|AN|LLC|L\s*L\s*C|INC|INCORPORATED|LTD|LP|LLP|PLLC|PC|PA|CO|COMPANY|CORP|CORPORATION)\b/gi;

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

export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|dt|dd|table|section|header|td|th)>/gi, '\n')
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
    CALIFORNIA: 'CA',
    WASHINGTON: 'WA',
    'NEW YORK': 'NY',
    MASSACHUSETTS: 'MA',
    MINNESOTA: 'MN',
    PENNSYLVANIA: 'PA',
    TEXAS: 'TX',
    FLORIDA: 'FL',
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
