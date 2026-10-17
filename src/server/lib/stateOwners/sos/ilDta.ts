import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRegistryAgentName } from '../names.js';
import { pickBestEntityMatch } from './match.js';
import { parseOfficerRoster, type RosterEntry } from './officers.js';
import type { NameLookupInput } from './types.js';

/** Illinois Data Transparency Act bulk files (P.A. 102-0049). Do not scrape the search UI. */
export const IL_DTA_HOME = 'https://www.ilsos.gov/data/bus-serv-home.html';

export interface IlDtaEntity {
  file_number: string;
  legal_name: string;
  dba_name: string | null;
  city: string | null;
  zip: string | null;
  agent_name: string | null;
  officers: RosterEntry[];
}

export interface IlDtaIndex {
  byFile: Map<string, IlDtaEntity>;
  list: IlDtaEntity[];
}

const CORP_ANNUAL_LEN = 126;
const CORP_NAME_LEN = 197;
const CORP_AGENT_LEN = 164;
const CORP_MASTER_LEN = 160;

function ensureEntity(index: IlDtaIndex, fileNumber: string): IlDtaEntity {
  const key = fileNumber.trim();
  let row = index.byFile.get(key);
  if (!row) {
    row = {
      file_number: key,
      legal_name: '',
      dba_name: null,
      city: null,
      zip: null,
      agent_name: null,
      officers: [],
    };
    index.byFile.set(key, row);
    index.list.push(row);
  }
  return row;
}

function padSlice(line: string, start: number, end: number): string {
  return line.slice(start, end).trim();
}

function addOfficer(row: IlDtaEntity, name: string, title: string): void {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  if (!cleaned || isRegistryAgentName(cleaned)) return;
  const parsed = parseOfficerRoster(`${title}: ${cleaned}`);
  for (const entry of parsed) {
    if (row.officers.some((o) => o.name.toLowerCase() === entry.name.toLowerCase())) continue;
    row.officers.push(entry);
  }
}

/** Corporate annual-report record (126 bytes) — file number, year, two officer slots. */
export function parseCorpAnnualLine(line: string): { file_number: string; officers: RosterEntry[] } | null {
  const raw = line.replace(/\r$/, '');
  if (raw.length < 80) return null;
  const file_number = padSlice(raw, 0, 8);
  if (!/^\d{4,8}$/.test(file_number)) return null;
  const officers: RosterEntry[] = [];
  const name1 = padSlice(raw, 12, 52);
  const title1 = padSlice(raw, 52, 72) || 'Officer';
  const name2 = padSlice(raw, 72, 112);
  const title2 = padSlice(raw, 112, 126) || 'Officer';
  for (const pair of [
    [name1, title1],
    [name2, title2],
  ] as const) {
    officers.push(...parseOfficerRoster(`${pair[1]}: ${pair[0]}`));
  }
  return { file_number, officers };
}

export function parseCorpNameLine(line: string): { file_number: string; name: string } | null {
  const raw = line.replace(/\r$/, '');
  if (raw.length < 20) return null;
  const file_number = padSlice(raw, 0, 8);
  if (!/^\d{4,8}$/.test(file_number)) return null;
  const name = padSlice(raw, 12, raw.length);
  if (!name) return null;
  return { file_number, name };
}

export function parseCorpAgentLine(line: string): { file_number: string; agent: string } | null {
  const raw = line.replace(/\r$/, '');
  if (raw.length < 20) return null;
  const file_number = padSlice(raw, 0, 8);
  if (!/^\d{4,8}$/.test(file_number)) return null;
  return { file_number, agent: padSlice(raw, 8, Math.min(raw.length, 80)) };
}

function headerMap(headerLine: string, delim: string): Map<string, number> {
  const map = new Map<string, number>();
  headerLine.split(delim).forEach((h, i) => {
    map.set(h.trim().toLowerCase().replace(/\s+/g, '_'), i);
  });
  return map;
}

function col(cells: string[], headers: Map<string, number>, names: string[]): string {
  for (const name of names) {
    const idx = headers.get(name);
    if (idx != null && cells[idx]) return cells[idx].trim();
  }
  return '';
}

function ingestDelimited(index: IlDtaIndex, text: string): boolean {
  const first = text.split(/\n/, 1)[0] || '';
  const delim = first.includes('\t') ? '\t' : first.includes('|') ? '|' : first.includes(',') ? ',' : '';
  if (!delim) return false;
  const headers = headerMap(first, delim);
  const nameKey = ['legal_name', 'entity_name', 'company_name', 'corp_name', 'llc_name', 'name'].some((k) =>
    headers.has(k),
  );
  if (!nameKey) return false;
  const lines = text.split(/\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(delim);
    const file_number = col(cells, headers, ['file_number', 'filenumber', 'file_no', 'entity_id']) || String(index.list.length + 1);
    const row = ensureEntity(index, file_number);
    row.legal_name = col(cells, headers, ['legal_name', 'entity_name', 'company_name', 'corp_name', 'llc_name', 'name']) || row.legal_name;
    row.dba_name = col(cells, headers, ['dba_name', 'dba', 'assumed_name']) || row.dba_name;
    row.city = col(cells, headers, ['city', 'principal_city', 'entity_city']) || row.city;
    row.zip = col(cells, headers, ['zip', 'zipcode', 'postal']) || row.zip;
    row.agent_name = col(cells, headers, ['agent_name', 'agent', 'registered_agent']) || row.agent_name;
    const officer = col(cells, headers, ['officer_name', 'officer', 'manager', 'member', 'president', 'manager_name']);
    const title = col(cells, headers, ['officer_title', 'title', 'position']) || 'Manager';
    if (officer) addOfficer(row, officer, title);
  }
  return true;
}

function ingestFixedWidth(index: IlDtaIndex, text: string, filename: string): void {
  const lines = text.split(/\n/).filter((l) => l.trim());
  if (!lines.length) return;
  const lens = lines.map((l) => l.replace(/\r$/, '').length);
  const mode = lens.sort((a, b) => a - b)[Math.floor(lens.length / 2)];
  const lower = filename.toLowerCase();
  const treatAnnual = mode === CORP_ANNUAL_LEN || /annual|anr|officer|manager|member/.test(lower);
  const treatName = mode === CORP_NAME_LEN || /name/.test(lower);
  const treatAgent = mode === CORP_AGENT_LEN || /agent/.test(lower);
  const treatMaster = mode === CORP_MASTER_LEN || /master|mstr/.test(lower);

  for (const line of lines) {
    const raw = line.replace(/\r$/, '');
    if (treatAnnual || raw.length === CORP_ANNUAL_LEN) {
      const parsed = parseCorpAnnualLine(raw);
      if (parsed) {
        const row = ensureEntity(index, parsed.file_number);
        for (const off of parsed.officers) {
          if (!row.officers.some((o) => o.name.toLowerCase() === off.name.toLowerCase())) row.officers.push(off);
        }
        continue;
      }
    }
    if (treatName || raw.length === CORP_NAME_LEN) {
      const parsed = parseCorpNameLine(raw);
      if (parsed) {
        const row = ensureEntity(index, parsed.file_number);
        if (!row.legal_name) row.legal_name = parsed.name;
        else if (row.legal_name !== parsed.name && !row.dba_name) row.dba_name = parsed.name;
        continue;
      }
    }
    if (treatAgent || raw.length === CORP_AGENT_LEN) {
      const parsed = parseCorpAgentLine(raw);
      if (parsed) {
        const row = ensureEntity(index, parsed.file_number);
        row.agent_name = parsed.agent;
        continue;
      }
    }
    if (treatMaster || raw.length === CORP_MASTER_LEN) {
      const file_number = padSlice(raw, 0, 8);
      if (/^\d{4,8}$/.test(file_number)) ensureEntity(index, file_number);
    }
  }
}

export function ingestIlDtaText(index: IlDtaIndex, text: string, filename = 'upload.txt'): void {
  if (ingestDelimited(index, text)) return;
  ingestFixedWidth(index, text, filename);
}

export function emptyIlIndex(): IlDtaIndex {
  return { byFile: new Map(), list: [] };
}

export function loadIlDtaDir(dir: string): IlDtaIndex {
  const index = emptyIlIndex();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return index;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const text = readFileSync(path, 'utf8');
      ingestIlDtaText(index, text, name);
    } catch {
      continue;
    }
  }
  return index;
}

let cached: { dir: string; index: IlDtaIndex } | null = null;

export function getIlIndex(dir: string | null | undefined, injected?: IlDtaIndex | null): IlDtaIndex | null {
  if (injected) return injected;
  if (!dir) return null;
  if (cached?.dir === dir) return cached.index;
  const index = loadIlDtaDir(dir);
  cached = { dir, index };
  return index;
}

export function resetIlIndexCache(): void {
  cached = null;
}

export function matchIlDta(
  input: NameLookupInput,
  index: IlDtaIndex,
): { entity: IlDtaEntity; score: number; method: 'exact' | 'substring' | 'trigram' } | null {
  const hit = pickBestEntityMatch(input.company_name, index.list, {
    legalNameOf: (r) => r.legal_name,
    dbaNameOf: (r) => r.dba_name,
    city: input.city,
    cityOf: (r) => r.city,
    zipOf: (r) => r.zip,
    allowTrigram: true,
  });
  if (!hit) return null;
  return { entity: hit.item, score: hit.score, method: hit.method };
}
