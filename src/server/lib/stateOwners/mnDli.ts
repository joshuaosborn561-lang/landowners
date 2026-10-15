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

export function parseMnCsv(text: string): MnRow[] {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row: MnRow = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]!] = cols[i] || '';
    return row;
  });
}

function addrKey(row: MnRow): string {
  return `${normalizeCompanyName(row.Addr1 || '')}|${normalizeCompanyName(row.City || '')}`;
}

function phoneKey(row: MnRow): string {
  const digits = String(row.Phone_No || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/** Tight MN company match: exact normalized name, or trigram ≥ this. No substring. */
export const MN_NAME_TRIGRAM_THRESHOLD = 0.8;

export function normalizeMnLicense(raw: string | null | undefined): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function labeledCompanyRows(businesses: MnRow[]): Array<{ row: MnRow; label: string }> {
  const out: Array<{ row: MnRow; label: string }> = [];
  for (const row of businesses) {
    if (row.Name) out.push({ row, label: row.Name });
    if (row.DBA_Name) out.push({ row, label: row.DBA_Name });
  }
  return out;
}

function pickMnDliCompany(
  target: string,
  businesses: MnRow[],
  opts: { minTrigram: number; allowSubstring: boolean },
): NameMatchHit<MnRow> | null {
  if (!target) return null;
  const hit = pickBestNameMatchScored(target, labeledCompanyRows(businesses), (x) => x.label, {
    allowTrigram: true,
    allowSubstring: opts.allowSubstring,
    minTrigram: opts.minTrigram,
  });
  return hit ? { item: hit.item.row, score: hit.score, method: hit.method } : null;
}

function uniqueBy(rows: MnRow[], key: string, keyOf: (row: MnRow) => string): MnRow | null {
  if (!key) return null;
  const hits = rows.filter((r) => keyOf(r) === key);
  return hits.length === 1 ? hits[0]! : null;
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

function qualifierForBusiness(biz: MnRow, peopleRows: MnRow[]): MnRow | null {
  const addr = addrKey(biz);
  const byAddr = addr && addr !== '|' ? uniqueBy(peopleRows, addr, addrKey) : null;
  if (byAddr) return byAddr;
  return uniqueBy(peopleRows, phoneKey(biz), phoneKey);
}

/** Nightly DLI dump. Take a person only when the DLI company matches the permit (tight name) or license is exact. */
export function parseMnDliCsv(
  text: string,
  companyName: string,
  sourceUrl: string,
  licenseNumber?: string | null,
): ResolverResult {
  const rows = parseMnCsv(text);
  const target = normalizeCompanyName(companyName);
  const wantLic = normalizeMnLicense(licenseNumber);
  if (!target && !wantLic) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }

  const businesses = rows.filter((r) => !isPerson(r));
  const peopleRows = rows.filter((r) => isPerson(r) && isQualifier(r) && isIssued(r));

  let biz: MnRow | null = null;
  let licensePerson: MnRow | null = null;
  let matchMethod: ResolverResult['match_method'];
  let matchScore: number | undefined;

  if (wantLic) {
    const licHits = rows.filter((r) => normalizeMnLicense(r.Lic_Number) === wantLic);
    const licRow = licHits.find(isIssued) || licHits[0] || null;
    if (licRow && !licHits.some(isIssued)) {
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

  const tight = !biz && !licensePerson && target ? pickMnDliCompany(target, businesses, {
    minTrigram: MN_NAME_TRIGRAM_THRESHOLD,
    allowSubstring: false,
  }) : null;
  if (tight) {
    const peers = businesses.filter((r) => {
      if (r === tight.item) return true;
      return Boolean(
        pickMnDliCompany(target, [r], { minTrigram: MN_NAME_TRIGRAM_THRESHOLD, allowSubstring: false }),
      );
    });
    biz = peers.find(isIssued) || peers[0] || tight.item;
    matchMethod = tight.method;
    matchScore = tight.score;
    if (peers.length && !peers.some(isIssued) && !isIssued(biz)) {
      return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl, match_method: matchMethod, match_score: matchScore };
    }
  }

  if (!biz && !licensePerson) {
    const loose = target
      ? pickMnDliCompany(target, businesses, { minTrigram: 0.48, allowSubstring: true })
      : null;
    if (loose) {
      return {
        people: [],
        coverage_reason: 'name_miss',
        source: 'mn_dli',
        source_url: sourceUrl,
        match_method: loose.method,
        match_score: loose.score,
      };
    }
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }

  const qualifier = licensePerson || (biz ? qualifierForBusiness(biz, peopleRows) : null);
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

let csvMemo: { fetchedAt: number; text: string } | null = null;

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

  let csvText = csvMemo && Date.now() - csvMemo.fetchedAt < 6 * 60 * 60 * 1000 ? csvMemo.text : null;
  let status = 200;
  if (!csvText) {
    const chunks: string[] = [];
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
      chunks.push(chunks.length ? got.body.replace(/^[^\n]+\n/, '') : got.body);
    }
    if (!chunks.length) {
      await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: status, body: '' });
      return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: RESIDENTIAL, http_status: status };
    }
    csvText = chunks.join('\n');
    csvMemo = { fetchedAt: Date.now(), text: csvText };
  }

  const parsed = parseMnDliCsv(csvText, lead.company_name, RESIDENTIAL, lead.license_number);
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
