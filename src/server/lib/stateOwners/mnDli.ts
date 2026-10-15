import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  looksLikeSolePropPerson,
  normalizeCompanyName,
  parseBoardPersonName,
  pickBestNameMatchScored,
  splitPersonName,
  type NameMatchHit,
} from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { licenseCacheKey, nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const LOOKUP = 'https://www.dli.mn.gov/license-and-registration-lookup';
const RESIDENTIAL = 'https://secure.doli.state.mn.us/ccld/data/MNDLILicRegCertExport_Residential_Contractors.csv';
const ELECTRICAL = 'https://secure.doli.state.mn.us/ccld/data/MNDLILicRegCertExport_Electrical.csv';
const PLUMBING = 'https://secure.doli.state.mn.us/ccld/data/MNDLILicRegCertExport_Plumbing.csv';
const MN_CSVS = [RESIDENTIAL, ELECTRICAL, PLUMBING];

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

type MnRow = Record<string, string>;

/** Drop unused DLI columns so the in-memory index is not a second copy of the CSV. */
const KEEP_FIELDS = new Set([
  'Bus_Pers',
  'License_Subtype',
  'Name',
  'DBA_Name',
  'Addr1',
  'City',
  'Phone_No',
  'Lic_Number',
  'Status',
]);

const GENERIC_TOKENS = new Set(
  'THE A AN AND LLC INC INCORPORATED LTD LP LLP PLLC PC PA CO COMPANY CORP CORPORATION CONSTRUCTION BUILDER BUILDERS ELECTRIC ELECTRICAL PLUMBING ROOFING SERVICE SERVICES CONTRACTOR CONTRACTORS GROUP ENTERPRISES ASSOCIATES INDUSTRIES'.split(
    ' ',
  ),
);

/** Tight MN company match: exact normalized name, or trigram ≥ this. No substring. */
export const MN_NAME_TRIGRAM_THRESHOLD = 0.8;

export function normalizeMnLicense(raw: string | null | undefined): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function addrKey(row: MnRow): string {
  return `${normalizeCompanyName(row.Addr1 || '')}|${normalizeCompanyName(row.City || '')}`;
}

function phoneKey(row: MnRow): string {
  const digits = String(row.Phone_No || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function distinctiveTokens(norm: string): string[] {
  return String(norm || '')
    .split(' ')
    .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

function isIssued(row: MnRow): boolean {
  return /issued/i.test(row.Status || '');
}

function isPerson(row: MnRow): boolean {
  return /^p/i.test(row.Bus_Pers || '');
}

function isQualifier(row: MnRow): boolean {
  return /qualif/i.test(row.License_Subtype || '') || /^Q/i.test(row.Lic_Number || '');
}

function pushMap(map: Map<string, MnRow[]>, key: string, row: MnRow): void {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

function uniqueInMap(map: Map<string, MnRow[]>, key: string): MnRow | null {
  if (!key) return null;
  const hits = map.get(key);
  return hits && hits.length === 1 ? hits[0]! : null;
}

export interface MnIndex {
  rows: number;
  byLicense: Map<string, MnRow>;
  byName: Map<string, MnRow[]>;
  byToken: Map<string, MnRow[]>;
  peopleByAddr: Map<string, MnRow[]>;
  peopleByPhone: Map<string, MnRow[]>;
}

export function createMnIndex(): MnIndex {
  return {
    rows: 0,
    byLicense: new Map(),
    byName: new Map(),
    byToken: new Map(),
    peopleByAddr: new Map(),
    peopleByPhone: new Map(),
  };
}

function emptyIndex(): MnIndex {
  return createMnIndex();
}

function rowFromCols(header: string[], cols: string[]): MnRow {
  const row: MnRow = {};
  for (let c = 0; c < header.length; c += 1) {
    const key = header[c]!;
    if (!KEEP_FIELDS.has(key)) continue;
    const val = cols[c] || '';
    if (val) row[key] = val;
  }
  return row;
}

function ingestMnLine(index: MnIndex, header: string[], line: string): void {
  if (!line.trim()) return;
  addToIndex(index, rowFromCols(header, parseCsvLine(line)));
}

function indexBusinessName(index: MnIndex, row: MnRow, raw: string): void {
  const norm = normalizeCompanyName(raw);
  if (!norm) return;
  pushMap(index.byName, norm, row);
  for (const tok of distinctiveTokens(norm)) pushMap(index.byToken, tok, row);
}

function addToIndex(index: MnIndex, row: MnRow): void {
  index.rows += 1;
  const lic = normalizeMnLicense(row.Lic_Number);
  if (lic) {
    const prev = index.byLicense.get(lic);
    if (!prev || (!isIssued(prev) && isIssued(row))) index.byLicense.set(lic, row);
  }
  if (isPerson(row)) {
    if (isQualifier(row) && isIssued(row)) {
      const addr = addrKey(row);
      if (addr && addr !== '|') pushMap(index.peopleByAddr, addr, row);
      pushMap(index.peopleByPhone, phoneKey(row), row);
    }
    return;
  }
  if (row.Name) indexBusinessName(index, row, row.Name);
  if (row.DBA_Name) indexBusinessName(index, row, row.DBA_Name);
}

/** Stream a DLI CSV into maps. Does not keep the raw text or a master row list. */
export function ingestMnCsv(index: MnIndex, text: string): void {
  const str = String(text || '');
  if (!str) return;
  let start = 0;
  const nl = str.indexOf('\n');
  const firstLine = (nl < 0 ? str : str.slice(0, nl)).replace(/\r$/, '');
  const header = parseCsvLine(firstLine).map((h) => h.trim());
  const hasHeader = header.includes('Bus_Pers') || header.includes('License_Type');
  if (!hasHeader) return;
  start = nl < 0 ? str.length : nl + 1;
  let i = start;
  while (i < str.length) {
    let j = str.indexOf('\n', i);
    if (j < 0) j = str.length;
    const line = str.slice(i, j).replace(/\r$/, '');
    i = j + 1;
    ingestMnLine(index, header, line);
  }
}

/** Line-at-a-time ingest so a 40MB dump is never held as one string plus the index. */
export async function ingestMnCsvFile(index: MnIndex, filePath: string): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!header) {
      header = parseCsvLine(line).map((h) => h.trim());
      if (!(header.includes('Bus_Pers') || header.includes('License_Type'))) {
        header = null;
      }
      continue;
    }
    ingestMnLine(index, header, line);
  }
}

export function parseMnCsv(text: string): MnRow[] {
  const index = emptyIndex();
  ingestMnCsv(index, text);
  return [...index.byLicense.values()];
}

function nameCandidates(index: MnIndex, target: string): { rows: MnRow[]; exact: boolean } {
  const exact = index.byName.get(target);
  if (exact?.length) return { rows: exact, exact: true };
  const seen = new Set<MnRow>();
  for (const tok of distinctiveTokens(target)) {
    const list = index.byToken.get(tok);
    if (!list) continue;
    for (const row of list) seen.add(row);
  }
  return { rows: [...seen], exact: false };
}

function pickMnDliCompany(
  target: string,
  businesses: MnRow[],
  opts: { minTrigram: number; allowSubstring: boolean },
): NameMatchHit<MnRow> | null {
  if (!target || !businesses.length) return null;
  const labeled: Array<{ row: MnRow; label: string }> = [];
  for (const row of businesses) {
    if (row.Name) labeled.push({ row, label: row.Name });
    if (row.DBA_Name) labeled.push({ row, label: row.DBA_Name });
  }
  const hit = pickBestNameMatchScored(target, labeled, (x) => x.label, {
    allowTrigram: true,
    allowSubstring: opts.allowSubstring,
    minTrigram: opts.minTrigram,
  });
  return hit ? { item: hit.item.row, score: hit.score, method: hit.method } : null;
}

function personFromRow(
  row: MnRow,
  role: OwnerPerson['role'],
  sourceUrl: string,
  phone: string | null,
  extra?: Pick<ResolverResult, 'match_method' | 'match_score'>,
): ResolverResult {
  const split = role === 'qualifying_individual' ? parseBoardPersonName(row.Name) : splitPersonName(row.Name);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role,
    source: 'mn_dli',
    source_url: sourceUrl,
    confidence: extra?.match_method === 'license' ? 'high' : 'medium',
    business_phone: phone,
    review_flag: split.review_flag || undefined,
  };
  return {
    people: [person],
    coverage_reason: null,
    source: 'mn_dli',
    source_url: sourceUrl,
    business_phone: phone,
    match_method: extra?.match_method,
    match_score: extra?.match_score,
  };
}

function qualifierForBusiness(index: MnIndex, biz: MnRow): MnRow | null {
  const addr = addrKey(biz);
  const byAddr = addr && addr !== '|' ? uniqueInMap(index.peopleByAddr, addr) : null;
  if (byAddr) return byAddr;
  return uniqueInMap(index.peopleByPhone, phoneKey(biz));
}

export function lookupMnIndex(
  index: MnIndex,
  companyName: string,
  sourceUrl: string,
  licenseNumber?: string | null,
): ResolverResult {
  const target = normalizeCompanyName(companyName);
  const wantLic = normalizeMnLicense(licenseNumber);
  if (!target && !wantLic) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }

  let biz: MnRow | null = null;
  let licensePerson: MnRow | null = null;
  let matchMethod: ResolverResult['match_method'];
  let matchScore: number | undefined;

  if (wantLic) {
    const licRow = index.byLicense.get(wantLic) || null;
    if (licRow && !isIssued(licRow)) {
      return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl, match_method: 'license', match_score: 100 };
    }
    if (licRow && isPerson(licRow)) {
      if (!isQualifier(licRow) || !isIssued(licRow)) {
        return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl, match_method: 'license', match_score: 100 };
      }
      licensePerson = licRow;
      matchMethod = 'license';
      matchScore = 100;
    } else if (licRow) {
      biz = licRow;
      matchMethod = 'license';
      matchScore = 100;
    }
  }

  if (!biz && !licensePerson && target) {
    const found = nameCandidates(index, target);
    if (found.exact) {
      const peers = found.rows;
      biz = peers.find(isIssued) || peers[0] || null;
      matchMethod = 'exact';
      matchScore = 100;
      if (biz && peers.length && !peers.some(isIssued) && !isIssued(biz)) {
        return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl, match_method: matchMethod, match_score: matchScore };
      }
    } else if (found.rows.length) {
      const tight = pickMnDliCompany(target, found.rows, {
        minTrigram: MN_NAME_TRIGRAM_THRESHOLD,
        allowSubstring: false,
      });
      if (tight) {
        biz = tight.item;
        matchMethod = tight.method;
        matchScore = tight.score;
        if (biz && !isIssued(biz)) {
          return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl, match_method: matchMethod, match_score: matchScore };
        }
      } else {
        return { people: [], coverage_reason: 'name_miss', source: 'mn_dli', source_url: sourceUrl };
      }
    } else {
      return { people: [], coverage_reason: index.rows ? 'name_miss' : 'not_found', source: 'mn_dli', source_url: sourceUrl };
    }
  }

  if (!biz && !licensePerson) {
    return { people: [], coverage_reason: index.rows ? 'name_miss' : 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }

  const qualifier = licensePerson || (biz ? qualifierForBusiness(index, biz) : null);
  const phone = (qualifier?.Phone_No || biz?.Phone_No || '').trim() || null;
  const extra = { match_method: matchMethod, match_score: matchScore };

  if (qualifier?.Name) {
    return personFromRow(qualifier, 'qualifying_individual', sourceUrl, phone, extra);
  }

  if (biz && looksLikeSolePropPerson(biz.Name || '')) {
    return personFromRow(biz, 'sole_proprietor', sourceUrl, phone, extra);
  }

  if (biz && looksLikeSolePropPerson(companyName)) {
    return { people: [], coverage_reason: 'sole_prop_dba', source: 'mn_dli', source_url: sourceUrl, match_method: matchMethod, match_score: matchScore };
  }
  if (biz || licensePerson) {
    return {
      people: [],
      coverage_reason: 'name_miss',
      source: 'mn_dli',
      source_url: sourceUrl,
      match_method: matchMethod,
      match_score: matchScore,
    };
  }
  return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
}

/** Nightly DLI dump. Take a person only when the DLI company matches the permit (tight name) or exact license number. */
export function parseMnDliCsv(
  text: string,
  companyName: string,
  sourceUrl: string,
  licenseNumber?: string | null,
): ResolverResult {
  const index = emptyIndex();
  ingestMnCsv(index, text);
  return lookupMnIndex(index, companyName, sourceUrl, licenseNumber);
}

export function parseMnDliText(text: string, sourceUrl: string): ResolverResult {
  const body = text.replace(/\r/g, '');
  if (/no records|0 record|not found/i.test(body) && !/qualifying/i.test(body)) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }
  if (/inactive|expired|revoked/i.test(body) && !/active/i.test(body)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl };
  }
  const qp =
    body.match(/Qualifying (?:Person|Individual|Party)[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Responsible Person[:\s]+([A-Z][A-Za-z .'-]{2,60})/i) ||
    body.match(/Qualifier[:\s]+([A-Z][A-Za-z .'-]{2,60})/i);
  if (!qp?.[1]) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }
  const split = splitPersonName(qp[1]);
  const person: OwnerPerson = {
    first_name: split.first_name,
    last_name: split.last_name,
    full_name_raw: split.full_name_raw,
    role: 'qualifying_individual',
    source: 'mn_dli',
    source_url: sourceUrl,
    confidence: 'high',
    review_flag: split.review_flag || undefined,
  };
  return { people: [person], coverage_reason: null, source: 'mn_dli', source_url: sourceUrl };
}

let csvMemo: { fetchedAt: number; index: MnIndex } | null = null;

export function resetMnCsvMemo(): void {
  csvMemo = null;
}

export async function resolveMnDli(
  lead: OwnerLead,
  client: PacedBoardClient = new PacedBoardClient({ source: 'mn_dli' }),
): Promise<ResolverResult> {
  const license = normalizeMnLicense(lead.license_number);
  if (!lead.company_name?.trim() && !license) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: LOOKUP };
  }
  const key = lead.company_name?.trim()
    ? nameStateCacheKey(lead.company_name, 'MN')
    : licenseCacheKey(license);
  const cached = await readBoardCache('mn_dli', key);
  if (cached?.body != null && cached.http_status != null) {
    if (looksBlocked(cached.http_status, cached.body)) {
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'mn_dli',
        source_url: RESIDENTIAL,
        cached: true,
        blocked: true,
        http_status: cached.http_status,
      };
    }
    if (/^MN_CSV_OK\b/.test(cached.body)) {
      // Fall through to the in-process full CSV memo. Short slices were stale.
    } else if (/Bus_Pers,License_Type/.test(cached.body) || /\t/.test(cached.body)) {
      const lines = cached.body.split(/\r?\n/).filter((l) => l.trim()).length;
      if (lines >= 50) {
        return {
          ...parseMnDliCsv(cached.body, lead.company_name, RESIDENTIAL, lead.license_number),
          cached: true,
          http_status: cached.http_status,
        };
      }
    } else {
      return { ...parseMnDliText(cached.body, LOOKUP), cached: true, http_status: cached.http_status };
    }
  }

  let index = csvMemo && Date.now() - csvMemo.fetchedAt < 6 * 60 * 60 * 1000 ? csvMemo.index : null;
  let status = 200;
  if (!index) {
    index = emptyIndex();
    let ingested = 0;
    for (const url of MN_CSVS) {
      const got = await client.get(url, { headers: { Accept: '*/*' } });
      status = got.status;
      if (looksBlocked(got.status, got.body)) {
        await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: got.status, body: got.body });
        return {
          people: [],
          coverage_reason: 'blocked',
          source: 'mn_dli',
          source_url: url,
          blocked: true,
          http_status: got.status,
        };
      }
      if (got.status !== 200) continue;
      ingestMnCsv(index, got.body);
      ingested += 1;
    }
    if (!ingested || !index.rows) {
      await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: status, body: '' });
      return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: RESIDENTIAL, http_status: status };
    }
    csvMemo = { fetchedAt: Date.now(), index };
  }

  const parsed = lookupMnIndex(index, lead.company_name, RESIDENTIAL, lead.license_number);
  await writeBoardCache({
    board: 'mn_dli',
    cache_key: key,
    http_status: status,
    body: `MN_CSV_OK\t${normalizeCompanyName(lead.company_name)}\t${parsed.coverage_reason || 'named'}\t${parsed.people.length}`,
    query_string: `name=${normalizeCompanyName(lead.company_name) || lead.company_name}${license ? `&lic=${license}` : ''}`,
    fetched_url: RESIDENTIAL,
  });
  return { ...parsed, http_status: status };
}
