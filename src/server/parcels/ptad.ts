import type { CountyConfig } from './countyTypes.js';

function text(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : null;
}

/** Texas PTAD category letters. */
const PTAD_LETTERS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'L', 'M', 'O', 'S', 'X']);

/**
 * Substring rules for local descriptions that are not a closed code list.
 * Hood mineral rows carry the RRC lease and API 42- number in the description.
 * Order matters: manufactured and personal property are tested before minerals.
 */
const CONTAINS_RULES: Array<{ text: string; ptad: string }> = [
  { text: 'MANUFACTURED HOUSING', ptad: 'M' },
  { text: 'BUSINESS PERSONAL', ptad: 'L' },
  { text: 'INV/FFE', ptad: 'L' },
  { text: 'EQUIP BUSINESS', ptad: 'L' },
  { text: 'RRC', ptad: 'G' },
  { text: 'API 42-', ptad: 'G' },
];

function fromMap(map: Record<string, string> | undefined, value: string | null): string | null {
  if (!map || !value) return null;
  if (map[value]) return map[value];
  const upper = value.toUpperCase();
  for (const [key, ptad] of Object.entries(map)) {
    if (key.toUpperCase() === upper) return ptad;
  }
  return null;
}

function fromContains(value: string | null): string | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  for (const rule of CONTAINS_RULES) {
    if (upper.includes(rule.text)) return rule.ptad;
  }
  return null;
}

/**
 * Keep a code that already starts with a PTAD letter.
 * Otherwise map the county's local use / property type, then the shared description rules.
 */
export function mapStateUse(
  county: CountyConfig,
  stateUse: string | null | undefined,
  propType: string | null | undefined,
  useDesc: string | null | undefined,
): string | null {
  const existing = text(stateUse);
  if (existing && PTAD_LETTERS.has(existing.toUpperCase()[0] ?? '')) return existing;
  const mapped =
    fromMap(county.use_code_map, text(propType)) ??
    fromMap(county.use_code_map, text(useDesc)) ??
    fromContains(text(propType)) ??
    fromContains(text(useDesc));
  return mapped;
}
