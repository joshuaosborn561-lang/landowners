import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { parseCsv } from '../../services/parcels.js';
import type { CountyConfig } from '../countyTypes.js';
import { dateFromText, downloadToFile, unzipList, unzipFiles } from '../download.js';
import { blankToNull, finiteNumber, joinParts, splitCityState, type RawParcel } from '../normalize.js';

function parseLine(line: string, delimiter: string): string[] {
  if (delimiter === ',') return parseCsv(`${line}\n`)[0] ?? [];
  return line.split(delimiter);
}

export async function openDelimited(county: CountyConfig, workDir: string): Promise<{
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}> {
  if (!county.source_url) throw new Error(`${county.name} has no source_url`);
  const delimiter = county.delimiter ?? ',';
  const fieldMap = county.field_map ?? {};
  const dest = join(workDir, 'delimited.zip');
  const meta = await downloadToFile(county.source_url, dest);
  const listing = await unzipList(dest);
  const dataFile = county.member
    ? listing.find((row) => row.name.toLowerCase().includes(county.member!.toLowerCase()))
    : listing.find((row) => /\.(txt|csv|tab)$/i.test(row.name)) ??
      listing.sort((a, b) => b.bytes - a.bytes)[0];
  if (!dataFile) throw new Error(`${county.name} archive has no ${county.member ?? 'delimited'} member`);
  const dir = join(workDir, 'delimited');
  await unzipFiles(dest, dir, [dataFile.name]);
  const path = join(dir, basename(dataFile.name));
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  let header: string[] | null = null;
  const index = new Map<string, number>();
  let rowsDownloaded = 0;
  const seen = new Set<string>();
  async function* rows(): AsyncGenerator<RawParcel> {
  const cell = (cols: string[], key: string): string | null => {
    const name = fieldMap[key];
    if (!name) return null;
    const at = index.get(name.toLowerCase());
    if (at == null) return null;
    return blankToNull(cols[at]);
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseLine(line.replace(/\r$/, ''), delimiter);
    if (!header) {
      header = cols;
      cols.forEach((name, i) => index.set(name.trim().toLowerCase(), i));
      continue;
    }
    rowsDownloaded += 1;
    const account = cell(cols, 'account_id');
    if (!account || seen.has(account)) continue;
    seen.add(account);
    const cityState = splitCityState(cell(cols, 'owner_mail_citystate'));
    const improvement = finiteNumber(cell(cols, 'improvement_value'));
    const situs =
      cell(cols, 'situs_address') ||
      joinParts([
        cell(cols, 'situs_num'),
        cell(cols, 'situs_street'),
        cell(cols, 'situs_suffix'),
      ]);
    yield {
      account_id: account,
      owner_name: cell(cols, 'owner_name'),
      situs_address: situs,
      situs_city: cell(cols, 'situs_city'),
      situs_zip: cell(cols, 'situs_zip'),
      owner_mail_addr1: cell(cols, 'owner_mail_addr1'),
      owner_mail_addr2: cell(cols, 'owner_mail_addr2'),
      owner_mail_city: cell(cols, 'owner_mail_city') ?? cityState.city,
      owner_mail_state: cell(cols, 'owner_mail_state') ?? cityState.state,
      owner_mail_zip: cell(cols, 'owner_mail_zip'),
      state_use_code: cell(cols, 'state_use_code'),
      use_desc: cell(cols, 'use_desc'),
      land_value: finiteNumber(cell(cols, 'land_value')),
      improvement_value: improvement,
      assessed_value: finiteNumber(cell(cols, 'assessed_value')),
      year_built: finiteNumber(cell(cols, 'year_built')),
      acres: finiteNumber(cell(cols, 'acres')),
      deed_date: cell(cols, 'deed_date'),
      improved: (improvement ?? 0) > 0,
      prop_type: cell(cols, 'prop_type'),
    };
  }
  }
  return {
    rows: rows(),
    sourceFileDate: dataFile.date ?? meta.sourceFileDate ?? dateFromText(basename(dataFile.name)),
    sourceFileName: basename(dataFile.name),
    rowsDownloaded: () => rowsDownloaded,
  };
}
