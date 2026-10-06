import { basename, join } from 'node:path';
import type { CountyConfig } from '../countyTypes.js';
import { dateFromText, downloadToFile, unzipFiles, unzipList } from '../download.js';
import { blankToNull, finiteNumber, joinParts, promoteMailLines, type RawParcel } from '../normalize.js';
import { col, csvRecords, headerIndex } from './csvRecords.js';

interface ValueRow {
  year: number;
  land: number | null;
  improvement: number | null;
  assessed: number | null;
}

interface BuildingRow {
  yearBuilt: number | null;
  area: number;
  useDesc: string | null;
}

interface LandRow {
  code: string | null;
  desc: string | null;
  acres: number;
}

async function indexByHeader(path: string): Promise<{ index: Map<string, number>; rows: AsyncGenerator<string[]> }> {
  const rows = csvRecords(path);
  const first = await rows.next();
  if (first.done || !first.value) throw new Error(`Empty CSV ${path}`);
  return { index: headerIndex(first.value), rows };
}

export async function openDcad(county: CountyConfig, workDir: string): Promise<{
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}> {
  if (!county.source_url) throw new Error(`${county.name} has no source_url`);
  const zipPath = join(workDir, 'dcad.zip');
  const meta = await downloadToFile(county.source_url, zipPath);
  const listing = await unzipList(zipPath);
  const want = ['ACCOUNT_INFO.CSV', 'ACCOUNT_APPRL_YEAR.CSV', 'RES_DETAIL.CSV', 'COM_DETAIL.CSV', 'LAND.CSV'];
  const names = want
    .map((token) => listing.find((row) => row.name.toUpperCase().endsWith(token))?.name)
    .filter((name): name is string => Boolean(name));
  if (!names.some((name) => name.toUpperCase().endsWith('ACCOUNT_INFO.CSV'))) {
    throw new Error(`${county.name} zip has no ACCOUNT_INFO.CSV`);
  }
  const dir = join(workDir, 'dcad');
  await unzipFiles(zipPath, dir, names);
  const file = (token: string) => {
    const hit = names.find((name) => name.toUpperCase().endsWith(token));
    return hit ? join(dir, basename(hit)) : null;
  };
  const values = new Map<string, ValueRow>();
  const readAppraisal = async (path: string | null) => {
    if (!path) return;
    const { index, rows } = await indexByHeader(path);
    for await (const cols of rows) {
      const id = col(cols, index, 'ACCOUNT_NUM');
      const year = Number(col(cols, index, 'APPRAISAL_YR'));
      if (!id || !Number.isFinite(year)) continue;
      const total = finiteNumber(col(cols, index, 'TOT_VAL'));
      const previous = finiteNumber(col(cols, index, 'PREV_MKT_VAL'));
      const next: ValueRow = {
        year,
        land: finiteNumber(col(cols, index, 'LAND_VAL')),
        improvement: finiteNumber(col(cols, index, 'IMPR_VAL')),
        assessed: total && total > 0 ? total : previous,
      };
      const prev = values.get(id);
      if (!prev) {
        values.set(id, next);
        continue;
      }
      const score = (row: ValueRow) => ((row.improvement ?? 0) > 0 ? 2 : 0) + ((row.assessed ?? 0) > 0 ? 1 : 0);
      if (score(next) > score(prev) || (score(next) === score(prev) && next.year >= prev.year)) {
        values.set(id, next);
      }
    }
  };
  if (county.values_url) {
    const valuesZip = join(workDir, 'dcad-values.zip');
    await downloadToFile(county.values_url, valuesZip);
    const valuesListing = await unzipList(valuesZip);
    const valuesName = valuesListing.find((row) => row.name.toUpperCase().endsWith('ACCOUNT_APPRL_YEAR.CSV'))?.name;
    if (!valuesName) throw new Error(`${county.name} values zip has no ACCOUNT_APPRL_YEAR.CSV`);
    const valuesDir = join(workDir, 'dcad-values');
    await unzipFiles(valuesZip, valuesDir, [valuesName]);
    await readAppraisal(join(valuesDir, basename(valuesName)));
  }
  await readAppraisal(file('ACCOUNT_APPRL_YEAR.CSV'));
  const buildings = new Map<string, BuildingRow>();
  const takeBuilding = async (path: string | null, yearCol: string, areaCol: string) => {
    if (!path) return;
    const { index, rows } = await indexByHeader(path);
    for await (const cols of rows) {
      const id = col(cols, index, 'ACCOUNT_NUM');
      if (!id) continue;
      const area = finiteNumber(col(cols, index, areaCol)) ?? 0;
      const yearBuilt = finiteNumber(col(cols, index, yearCol));
      const useDesc = blankToNull(col(cols, index, 'BLDG_CLASS_DESC'));
      const prev = buildings.get(id);
      if (prev && prev.area > area) continue;
      buildings.set(id, { yearBuilt, area, useDesc });
    }
  };
  await takeBuilding(file('RES_DETAIL.CSV'), 'YR_BUILT', 'TOT_LIVING_AREA_SF');
  await takeBuilding(file('COM_DETAIL.CSV'), 'YEAR_BUILT', 'GROSS_BLDG_AREA');
  const land = new Map<string, LandRow>();
  const landPath = file('LAND.CSV');
  if (landPath) {
    const { index, rows } = await indexByHeader(landPath);
    for await (const cols of rows) {
      const id = col(cols, index, 'ACCOUNT_NUM');
      if (!id) continue;
      const uom = col(cols, index, 'AREA_UOM_DESC').toUpperCase();
      const size = finiteNumber(col(cols, index, 'AREA_SIZE')) ?? 0;
      const acres = uom.includes('ACRE') ? size : 0;
      const prev = land.get(id);
      land.set(id, {
        code: blankToNull(col(cols, index, 'SPTD_CD')) ?? prev?.code ?? null,
        desc: blankToNull(col(cols, index, 'SPTD_DESC')) ?? prev?.desc ?? null,
        acres: (prev?.acres ?? 0) + acres,
      });
    }
  }
  const infoPath = file('ACCOUNT_INFO.CSV');
  if (!infoPath) throw new Error(`${county.name} ACCOUNT_INFO.CSV missing after unzip`);
  const accountInfoPath = infoPath;
  const infoDate = listing.find((row) => row.name.toUpperCase().endsWith('ACCOUNT_INFO.CSV'));
  let downloaded = 0;

  async function* rows(): AsyncGenerator<RawParcel> {
    const { index, rows: infoRows } = await indexByHeader(accountInfoPath);
    const emittedYear = new Map<string, number>();
    for await (const cols of infoRows) {
      downloaded += 1;
      const id = col(cols, index, 'ACCOUNT_NUM');
      const year = Number(col(cols, index, 'APPRAISAL_YR')) || 0;
      if (!id) continue;
      if ((emittedYear.get(id) ?? -1) > year) continue;
      emittedYear.set(id, year);
      const value = values.get(id);
      const building = buildings.get(id);
      const landRow = land.get(id);
      const owner = joinParts([col(cols, index, 'OWNER_NAME1'), col(cols, index, 'OWNER_NAME2')]);
      const mail = promoteMailLines(
        col(cols, index, 'OWNER_ADDRESS_LINE1'),
        col(cols, index, 'OWNER_ADDRESS_LINE2'),
        col(cols, index, 'OWNER_ADDRESS_LINE3'),
        col(cols, index, 'OWNER_ADDRESS_LINE4'),
      );
      yield {
        account_id: id,
        owner_name: owner,
        situs_address: joinParts([
          col(cols, index, 'STREET_NUM'),
          col(cols, index, 'STREET_HALF_NUM'),
          col(cols, index, 'FULL_STREET_NAME'),
          col(cols, index, 'UNIT_ID'),
        ]),
        situs_city: col(cols, index, 'PROPERTY_CITY'),
        situs_zip: col(cols, index, 'PROPERTY_ZIPCODE'),
        owner_mail_addr1: mail.addr1,
        owner_mail_addr2: mail.addr2,
        owner_mail_city: col(cols, index, 'OWNER_CITY'),
        owner_mail_state: col(cols, index, 'OWNER_STATE'),
        owner_mail_zip: col(cols, index, 'OWNER_ZIPCODE'),
        state_use_code: landRow?.code ?? null,
        use_desc: building?.useDesc ?? landRow?.desc ?? null,
        land_value: value?.land ?? null,
        improvement_value: value?.improvement ?? null,
        assessed_value: value?.assessed ?? null,
        year_built: building?.yearBuilt ?? null,
        acres: landRow && landRow.acres > 0 ? landRow.acres : null,
        deed_date: col(cols, index, 'DEED_TXFR_DATE'),
        improved: (value?.improvement ?? 0) > 0,
        prop_type: col(cols, index, 'DIVISION_CD'),
      };
    }
  }

  return {
    rows: rows(),
    sourceFileDate: infoDate?.date ?? meta.sourceFileDate ?? dateFromText(county.source_url),
    sourceFileName: infoDate ? basename(infoDate.name) : 'ACCOUNT_INFO.CSV',
    rowsDownloaded: () => downloaded,
  };
}
