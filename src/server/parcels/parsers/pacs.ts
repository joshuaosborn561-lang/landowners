import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { dateFromText, unzipFiles, unzipList } from '../download.js';
import {
  blankToNull,
  joinParts,
  pacsAcres,
  pacsMoney,
  promoteMailLines,
  type RawParcel,
} from '../normalize.js';
import type { CountyConfig } from '../countyTypes.js';
import { fieldIndex, readPacsLayout, sliceField, type PacsField } from './pacsLayout.js';

export interface PacsParseResult {
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}

function numericId(raw: string): string {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return text.replace(/^0+/, '') || '0';
  return text;
}

async function loadYearBuilt(
  path: string,
  fields: Map<string, PacsField>,
): Promise<Map<string, number>> {
  const years = new Map<string, { year: number; area: number }>();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const id = numericId(sliceField(line, fields.get('prop_id')));
    const year = Number(sliceField(line, fields.get('yr_built')));
    if (!id || !Number.isFinite(year) || year < 1700 || year > 2100) continue;
    const area = Number(sliceField(line, fields.get('imprv_det_area'))) || 0;
    const prev = years.get(id);
    if (!prev || area > prev.area) years.set(id, { year, area });
  }
  return new Map([...years.entries()].map(([id, hit]) => [id, hit.year]));
}

async function loadStateCodes(
  path: string,
  fields: Map<string, PacsField>,
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const code = sliceField(line, fields.get('state_cd') ?? fields.get('ptd_state_cd'));
    const desc = sliceField(
      line,
      fields.get('state_cd_description') ?? fields.get('ptd_state_cd_description'),
    );
    if (code && desc) codes.set(code.toUpperCase(), desc);
  }
  return codes;
}

export async function openPacs(county: CountyConfig, workDir: string): Promise<PacsParseResult> {
  if (!county.source_url) throw new Error(`${county.name} has no source_url`);
  if (!county.layout_url) throw new Error(`${county.name} PACS source needs layout_url`);
  const { downloadToFile } = await import('../download.js');
  const zipPath = join(workDir, 'source.zip');
  const layoutPath = join(workDir, 'layout.xlsx');
  const [zipMeta] = await Promise.all([
    downloadToFile(county.source_url, zipPath),
    downloadToFile(county.layout_url, layoutPath),
  ]);
  const layout = await readPacsLayout(layoutPath);
  const listing = await unzipList(zipPath);
  const pick = (token: string) =>
    listing
      .filter((row) => row.name.toUpperCase().includes(token) && row.name.toUpperCase().endsWith('.TXT'))
      .sort((a, b) => b.bytes - a.bytes)[0];
  const info = pick('APPRAISAL_INFO');
  if (!info) throw new Error(`${county.name} zip has no APPRAISAL_INFO file`);
  const stateFile = pick('APPRAISAL_STATE_CODE');
  const detail = pick('APPRAISAL_IMPROVEMENT_DETAIL');
  const names = [info.name, stateFile?.name, detail?.name].filter((name): name is string => Boolean(name));
  const extractDir = join(workDir, 'pacs');
  await unzipFiles(zipPath, extractDir, names);
  const infoFields = fieldIndex(layout.get('APPRAISAL_INFO') ?? []);
  const stateFields = fieldIndex(layout.get('APPRAISAL_STATE_CODE') ?? []);
  const detailFields = fieldIndex(layout.get('APPRAISAL_IMPROVEMENT_DETAIL') ?? []);
  const stateCodes = stateFile
    ? await loadStateCodes(join(extractDir, basename(stateFile.name)), stateFields)
    : new Map<string, string>();
  const years = detail
    ? await loadYearBuilt(join(extractDir, basename(detail.name)), detailFields)
    : new Map<string, number>();
  const infoPath = join(extractDir, basename(info.name));
  let downloaded = 0;
  const sourceFileDate = dateFromText(basename(info.name)) ?? info.date ?? zipMeta.sourceFileDate;

  async function* rows(): AsyncGenerator<RawParcel> {
    const seen = new Set<string>();
    const rl = createInterface({
      input: createReadStream(infoPath, { encoding: 'latin1' }),
      crlfDelay: Infinity,
    });
    let checked = false;
    for await (const line of rl) {
      if (!line.trim()) continue;
      downloaded += 1;
      const propId = numericId(sliceField(line, infoFields.get('prop_id')));
      if (!checked) {
        checked = true;
        if (!/^\d+$/.test(propId)) {
          throw new Error(
            `${county.name} APPRAISAL_INFO prop_id "${propId}" is not numeric. The layout file does not match this export.`,
          );
        }
      }
      if (!propId || seen.has(propId)) continue;
      const partial = sliceField(line, infoFields.get('partial_owner')).toUpperCase();
      if (partial === 'Y' && seen.has(propId)) continue;
      seen.add(propId);
      const useCode =
        blankToNull(sliceField(line, infoFields.get('imprv_state_cd'))) ||
        blankToNull(sliceField(line, infoFields.get('land_state_cd'))) ||
        blankToNull(sliceField(line, infoFields.get('personal_state_cd')));
      const land =
        (pacsMoney(sliceField(line, infoFields.get('land_hstd_val'))) ?? 0) +
        (pacsMoney(sliceField(line, infoFields.get('land_non_hstd_val'))) ?? 0);
      const improvement =
        (pacsMoney(sliceField(line, infoFields.get('imprv_hstd_val'))) ?? 0) +
        (pacsMoney(sliceField(line, infoFields.get('imprv_non_hstd_val'))) ?? 0);
      const assessed =
        pacsMoney(sliceField(line, infoFields.get('assessed_val'))) ??
        pacsMoney(sliceField(line, infoFields.get('appraised_val'))) ??
        pacsMoney(sliceField(line, infoFields.get('market_value')));
      const mail = promoteMailLines(
        sliceField(line, infoFields.get('py_addr_line1')),
        sliceField(line, infoFields.get('py_addr_line2')),
        sliceField(line, infoFields.get('py_addr_line3')),
      );
      yield {
        account_id: propId,
        owner_name:
          blankToNull(sliceField(line, infoFields.get('py_owner_name'))) ||
          blankToNull(sliceField(line, infoFields.get('appr_owner_name'))),
        situs_address: joinParts([
          sliceField(line, infoFields.get('situs_num')),
          sliceField(line, infoFields.get('situs_street_prefx')),
          sliceField(line, infoFields.get('situs_street')),
          sliceField(line, infoFields.get('situs_street_suffix')),
        ]),
        situs_city: sliceField(line, infoFields.get('situs_city')),
        situs_zip: sliceField(line, infoFields.get('situs_zip')),
        owner_mail_addr1: mail.addr1,
        owner_mail_addr2: mail.addr2,
        owner_mail_city: sliceField(line, infoFields.get('py_addr_city')),
        owner_mail_state: sliceField(line, infoFields.get('py_addr_state')),
        owner_mail_zip: sliceField(line, infoFields.get('py_addr_zip')),
        state_use_code: useCode,
        use_desc: useCode ? stateCodes.get(useCode.toUpperCase()) ?? null : null,
        land_value: land,
        improvement_value: improvement,
        assessed_value: assessed,
        improved: improvement > 0,
        acres: pacsAcres(sliceField(line, infoFields.get('legal_acreage'))),
        deed_date: sliceField(line, infoFields.get('deed_dt')),
        year_built: years.get(propId) ?? null,
        prop_type: sliceField(line, infoFields.get('prop_type_cd')),
      };
    }
  }

  return {
    rows: rows(),
    sourceFileDate,
    sourceFileName: basename(info.name),
    rowsDownloaded: () => downloaded,
  };
}
