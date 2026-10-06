import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CountyConfig } from '../countyTypes.js';
import { downloadToFile, unzipFiles, unzipList } from '../download.js';
import type { RawParcel } from '../normalize.js';
import { mapGisRecord } from './gisFields.js';

interface DbfField {
  name: string;
  type: string;
  length: number;
  decimal: number;
}

/** Minimal dBase III/IV reader so a shapefile's attribute table can be loaded without geometry. */
export async function* readDbf(path: string): AsyncGenerator<Record<string, string>> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(32);
    await handle.read(header, 0, 32, 0);
    const recordCount = header.readUInt32LE(4);
    const headerBytes = header.readUInt16LE(8);
    const recordBytes = header.readUInt16LE(10);
    const fields: DbfField[] = [];
    let offset = 32;
    while (offset < headerBytes - 1) {
      const desc = Buffer.alloc(32);
      await handle.read(desc, 0, 32, offset);
      if (desc[0] === 0x0d) break;
      const name = desc.toString('ascii', 0, 11).replace(/\0/g, '').trim();
      fields.push({
        name,
        type: String.fromCharCode(desc[11] ?? 67),
        length: desc[16] ?? 0,
        decimal: desc[17] ?? 0,
      });
      offset += 32;
    }
    const record = Buffer.alloc(recordBytes);
    for (let i = 0; i < recordCount; i++) {
      await handle.read(record, 0, recordBytes, headerBytes + i * recordBytes);
      if (record[0] === 0x2a) continue;
      const row: Record<string, string> = {};
      let cursor = 1;
      for (const field of fields) {
        row[field.name] = record.toString('latin1', cursor, cursor + field.length).trim();
        cursor += field.length;
      }
      yield row;
    }
  } finally {
    await handle.close();
  }
}

export async function openDbf(county: CountyConfig, workDir: string): Promise<{
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}> {
  if (!county.source_url) throw new Error(`${county.name} has no source_url`);
  const zipPath = join(workDir, 'gis.zip');
  const meta = await downloadToFile(county.source_url, zipPath);
  const listing = await unzipList(zipPath);
  const dbf = listing.find((row) => row.name.toLowerCase().endsWith('.dbf'));
  if (!dbf) throw new Error(`${county.name} archive has no DBF attribute table`);
  const dir = join(workDir, 'gis');
  await unzipFiles(zipPath, dir, [dbf.name]);
  const path = join(dir, basename(dbf.name));
  let downloaded = 0;
  async function* rows(): AsyncGenerator<RawParcel> {
    for await (const row of readDbf(path)) {
      downloaded += 1;
      yield mapGisRecord(row, county.field_map);
    }
  }
  return {
    rows: rows(),
    sourceFileDate: dbf.date ?? meta.sourceFileDate,
    sourceFileName: basename(dbf.name),
    rowsDownloaded: () => downloaded,
  };
}
