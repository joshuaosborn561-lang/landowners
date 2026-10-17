import {
  hasCompanyWord,
  htmlToText,
  isRegistryAgentName,
  parseBoardPersonName,
  splitPersonName,
} from '../names.js';
import type { BoardSource, OwnerConfidence, OwnerPerson, OwnerRole } from '../types.js';
import type { NameLookupInput, WaterfallOwnerHit } from './types.js';
import { ownerConfidenceFromMatch, waterfallHitFromPerson } from './waterfall.js';

export interface RosterEntry {
  name: string;
  title: string;
  role: OwnerRole;
}

const TITLE_ROLE: Array<{ re: RegExp; role: OwnerRole }> = [
  { re: /registered\s*agent|statutory\s*agent|agent\s+for\s+service/i, role: 'registered_agent' },
  { re: /\b(managing\s+member|member|manager)\b/i, role: 'member' },
  { re: /\b(sole\s+proprietor|owner)\b/i, role: 'owner' },
  { re: /\b(qualifying)\b/i, role: 'qualifying_individual' },
  { re: /\b./, role: 'officer' },
];

const TITLE =
  'Chief\\s+Executive\\s+Officer|Chief\\s+Financial\\s+Officer|Chief\\s+Operating\\s+Officer|' +
  'President|Vice\\s+President|Secretary|Treasurer|Director|Manager|Managing\\s+Member|Member|' +
  'CEO|CFO|COO|VP|Governor|Partner|Principal|Owner|Organizer|Officer';

const TITLE_RE = new RegExp(`^(?:${TITLE})$`, 'i');
const SKIP_NAME =
  /^(name|title|address|city|state|zip|none|n\/a|same|see below|continued|officer|director|manager|member)$/i;

export function roleFromTitle(title: string): OwnerRole {
  for (const row of TITLE_ROLE) {
    if (row.re.test(title)) return row.role;
  }
  return 'officer';
}

export function isOfficerTitle(title: string): boolean {
  return TITLE_RE.test(String(title || '').trim());
}

function cleanName(raw: string): string {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/[,;]+$/g, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

function usablePersonName(name: string): boolean {
  const cleaned = cleanName(name);
  if (cleaned.length < 4 || cleaned.length > 80) return false;
  if (SKIP_NAME.test(cleaned)) return false;
  if (isRegistryAgentName(cleaned)) return false;
  if (hasCompanyWord(cleaned)) return false;
  if (/^\d/.test(cleaned)) return false;
  const tokens = cleaned.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  return /[A-Za-z]/.test(cleaned);
}

function pushEntry(out: RosterEntry[], seen: Set<string>, name: string, title: string): void {
  const cleaned = cleanName(name);
  if (!usablePersonName(cleaned)) return;
  const role = roleFromTitle(title);
  if (role === 'registered_agent') return;
  const key = cleaned.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: cleaned, title: cleanName(title) || 'Officer', role });
}

/** SI-550 / LLC-12 / annual-report / HTML-table officer names. */
export function parseOfficerRoster(textOrHtml: string): RosterEntry[] {
  const raw = String(textOrHtml || '');
  if (!raw.trim()) return [];
  const text = /<[a-z][\s\S]*?>/i.test(raw) ? htmlToText(raw) : raw.replace(/\r/g, '');
  const out: RosterEntry[] = [];
  const seen = new Set<string>();

  const labeled = new RegExp(
    `(?:${TITLE})\\s*[:\\-#]*\\s*([A-Z][A-Za-z .'-]{1,40}(?:,\\s*[A-Z][A-Za-z .'-]{1,40})?)`,
    'gi',
  );
  for (const hit of text.matchAll(labeled)) {
    const title = (hit[0] || '').split(/[:\-#]/)[0]?.trim() || 'Officer';
    pushEntry(out, seen, hit[1] || '', title);
  }

  const reversed = new RegExp(
    `([A-Z][A-Za-z .'-]{1,40}(?:,\\s*[A-Z][A-Za-z .'-]{1,40})?)\\s*,\\s*(${TITLE})\\b`,
    'gi',
  );
  for (const hit of text.matchAll(reversed)) {
    pushEntry(out, seen, hit[1] || '', hit[2] || 'Officer');
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const titled = line.match(new RegExp(`^(${TITLE})\\s*[:\\-]?\\s*(.+)$`, 'i'));
    if (titled?.[1] && titled[2] && !isOfficerTitle(titled[2])) {
      pushEntry(out, seen, titled[2], titled[1]);
      continue;
    }
    if (isOfficerTitle(line)) {
      const next = lines[i + 1] || '';
      const nextName = next.replace(/^(name|full name)\s*[:\-]\s*/i, '');
      if (nextName && !isOfficerTitle(nextName)) pushEntry(out, seen, nextName, line);
    }
  }

  if (/<[a-z][\s\S]*?>/i.test(raw)) {
    for (const row of raw.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        htmlToText(c[1] || '').replace(/\s+/g, ' ').trim(),
      );
      if (cells.length < 2) continue;
      const titleCell = cells.find((c) => isOfficerTitle(c));
      const nameCell = cells.find((c) => c !== titleCell && usablePersonName(c));
      if (titleCell && nameCell) pushEntry(out, seen, nameCell, titleCell);
    }
  }

  return out;
}

export function rosterToPeople(
  entries: RosterEntry[],
  source: BoardSource,
  sourceUrl: string,
  confidence: OwnerConfidence,
): OwnerPerson[] {
  const people: OwnerPerson[] = [];
  const seen = new Set<string>();
  for (const row of entries) {
    if (row.role === 'registered_agent') continue;
    const split = row.name.includes(',') ? parseBoardPersonName(row.name) : splitPersonName(row.name);
    const key = `${split.first_name || ''}|${split.last_name || ''}|${split.full_name_raw}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role: row.role,
      source,
      source_url: sourceUrl,
      confidence,
      review_flag: split.review_flag || undefined,
    });
  }
  return people;
}

export function hitsFromRoster(
  input: NameLookupInput,
  entries: RosterEntry[],
  source: BoardSource,
  sourceUrl: string,
  matchMethod?: 'exact' | 'substring' | 'trigram' | 'license',
): WaterfallOwnerHit[] {
  const people = rosterToPeople(entries, source, sourceUrl, ownerConfidenceFromMatch(matchMethod));
  return people.map((p) => {
    const hit = waterfallHitFromPerson(input, p, null);
    if (p.role === 'member') hit.title = /managing/i.test(entries.find((e) => e.name === p.full_name_raw)?.title || '')
      ? 'Managing Member'
      : 'Member';
    else if (entries.find((e) => e.name === p.full_name_raw)?.title) {
      hit.title = entries.find((e) => e.name === p.full_name_raw)!.title;
    }
    return hit;
  });
}
