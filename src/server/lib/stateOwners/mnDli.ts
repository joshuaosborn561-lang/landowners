import {
  looksLikeSolePropPerson,
  normalizeCompanyName,
  parseBoardPersonName,
  pickBestNameMatch,
  splitPersonName,
} from './names.js';
import { looksBlocked, PacedBoardClient } from './http.js';
import { nameStateCacheKey, readBoardCache, writeBoardCache } from './cache.js';
import type { OwnerLead, OwnerPerson, ResolverResult } from './types.js';

const LOOKUP = 'https://www.dli.mn.gov/license-and-registration-lookup';
const RESIDENTIAL = 'https://secure.doli.state.mn.us/ccld/data/MNDLILicRegCertExport_Residential_Contractors.csv';

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

function isIssued(row: MnRow): boolean {
  return /issued/i.test(row.Status || '');
}

function isPerson(row: MnRow): boolean {
  return /^p/i.test(row.Bus_Pers || '');
}

function isQualifier(row: MnRow): boolean {
  return /qualif/i.test(row.License_Subtype || '') || /^Q/i.test(row.Lic_Number || '');
}

/** Nightly DLI residential-contractor dump. Qualifying people are Personal rows. */
export function parseMnDliCsv(text: string, companyName: string, sourceUrl: string): ResolverResult {
  const rows = parseMnCsv(text);
  const target = normalizeCompanyName(companyName);
  if (!target) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: sourceUrl };
  }

  const businesses = rows.filter((r) => !isPerson(r));
  const exact = businesses.filter((r) => {
    const name = r.Name || '';
    const dba = r.DBA_Name || '';
    return Boolean(pickBestNameMatch(target, [name, dba], (n) => n));
  });
  const biz = exact.find(isIssued) || exact[0] || null;
  if (exact.length && !exact.some(isIssued)) {
    return { people: [], coverage_reason: 'inactive_license', source: 'mn_dli', source_url: sourceUrl };
  }

  const peopleRows = rows.filter((r) => isPerson(r) && isQualifier(r) && isIssued(r));
  let qualifier: MnRow | null = null;
  if (biz) {
    const key = addrKey(biz);
    if (key && key !== '|') {
      const atAddr = peopleRows.filter((r) => addrKey(r) === key);
      if (atAddr.length === 1) qualifier = atAddr[0]!;
    }
  }

  const phone = (qualifier?.Phone_No || biz?.Phone_No || '').trim() || null;
  if (qualifier?.Name) {
    const split = parseBoardPersonName(qualifier.Name);
    const person: OwnerPerson = {
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role: 'qualifying_individual',
      source: 'mn_dli',
      source_url: sourceUrl,
      confidence: 'medium',
      business_phone: phone,
      review_flag: split.review_flag || undefined,
    };
    return { people: [person], coverage_reason: null, source: 'mn_dli', source_url: sourceUrl, business_phone: phone };
  }

  if (biz && looksLikeSolePropPerson(biz.Name || '')) {
    const split = splitPersonName(biz.Name);
    const person: OwnerPerson = {
      first_name: split.first_name,
      last_name: split.last_name,
      full_name_raw: split.full_name_raw,
      role: 'sole_proprietor',
      source: 'mn_dli',
      source_url: sourceUrl,
      confidence: 'medium',
      business_phone: phone,
      review_flag: split.review_flag || undefined,
    };
    return { people: [person], coverage_reason: null, source: 'mn_dli', source_url: sourceUrl, business_phone: phone };
  }

  if (biz && looksLikeSolePropPerson(companyName)) {
    return { people: [], coverage_reason: 'sole_prop_dba', source: 'mn_dli', source_url: sourceUrl };
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
  if (!lead.company_name?.trim()) {
    return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: LOOKUP };
  }
  const key = nameStateCacheKey(lead.company_name, 'MN');
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
    if (/Bus_Pers,License_Type/.test(cached.body) || /\t/.test(cached.body)) {
      return { ...parseMnDliCsv(cached.body, lead.company_name, RESIDENTIAL), cached: true, http_status: cached.http_status };
    }
    return { ...parseMnDliText(cached.body, LOOKUP), cached: true, http_status: cached.http_status };
  }

  let csvText = csvMemo && Date.now() - csvMemo.fetchedAt < 6 * 60 * 60 * 1000 ? csvMemo.text : null;
  let status = 200;
  if (!csvText) {
    const got = await client.get(RESIDENTIAL, { headers: { Accept: '*/*' } });
    status = got.status;
    if (looksBlocked(got.status, got.body)) {
      await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: got.status, body: got.body });
      return {
        people: [],
        coverage_reason: 'blocked',
        source: 'mn_dli',
        source_url: RESIDENTIAL,
        blocked: true,
        http_status: got.status,
      };
    }
    if (got.status !== 200) {
      await writeBoardCache({ board: 'mn_dli', cache_key: key, http_status: got.status, body: got.body });
      return { people: [], coverage_reason: 'not_found', source: 'mn_dli', source_url: RESIDENTIAL, http_status: got.status };
    }
    csvText = got.body;
    csvMemo = { fetchedAt: Date.now(), text: csvText };
  }

  const parsed = parseMnDliCsv(csvText, lead.company_name, RESIDENTIAL);
  const needle = normalizeCompanyName(lead.company_name).slice(0, 8);
  const slice = csvText
    .split(/\r?\n/)
    .filter((line, i) => i === 0 || (needle && line.toUpperCase().includes(needle)))
    .slice(0, 8)
    .join('\n');
  await writeBoardCache({
    board: 'mn_dli',
    cache_key: key,
    http_status: status,
    body: slice || csvText.slice(0, 500),
    query_string: `name=${normalizeCompanyName(lead.company_name) || lead.company_name}`,
    fetched_url: RESIDENTIAL,
  });
  return { ...parsed, http_status: status };
}
