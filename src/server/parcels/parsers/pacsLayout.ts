import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PacsField {
  name: string;
  start: number;
  length: number;
}

export type PacsLayout = Map<string, PacsField[]>;

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const part of xml.split(/<si\b/)) {
    if (!part.includes('<t')) continue;
    const texts = [...part.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => decodeXml(match[1] ?? ''));
    out.push(texts.join(''));
  }
  return out;
}

/**
 * True Automation leaves Start blank after the first field of a file.
 * Each following field begins where the previous one ended.
 */
export function placePacsField(
  fields: PacsField[],
  name: string,
  explicitStart: number | null,
  length: number,
): void {
  const previous = fields[fields.length - 1];
  const start =
    explicitStart != null && Number.isFinite(explicitStart) && explicitStart > 0
      ? explicitStart
      : previous
        ? previous.start + previous.length
        : 1;
  fields.push({ name, start, length });
}

function rowCells(chunk: string, strings: string[]): Map<string, string> {
  const cells = new Map<string, string>();
  for (const match of chunk.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = match[1] ?? '';
    const ref = attrs.match(/\br="([A-Z]+)\d+"/);
    const value = (match[2] ?? '').match(/<v>([^<]*)<\/v>/);
    if (!ref?.[1] || !value?.[1]) continue;
    const type = attrs.match(/\bt="([^"]+)"/)?.[1];
    cells.set(ref[1], type === 's' ? strings[Number(value[1])] ?? '' : value[1]);
  }
  return cells;
}

function consumeSheet(sheetXml: string, strings: string[], layout: PacsLayout): void {
  let current: PacsField[] | null = null;
  for (const chunk of sheetXml.split(/<row\b/)) {
    const cells = rowCells(chunk, strings);
    const label = (cells.get('A') ?? '').trim();
    if (/^File #\d+/i.test(label)) {
      const file = label.match(/([A-Z0-9_]+)\.TXT/i)?.[1]?.toUpperCase();
      if (file) {
        current = [];
        layout.set(file, current);
      }
      continue;
    }
    if (!current || !label || label === 'Field Name') continue;
    const length = Number(cells.get('E'));
    if (!Number.isFinite(length) || length <= 0) continue;
    const explicit = Number(cells.get('C'));
    placePacsField(current, label.trim(), Number.isFinite(explicit) ? explicit : null, length);
  }
}

/** Read a True Automation "Appraisal Export Layout" xlsx into per-file field lists. */
export async function readPacsLayout(xlsxPath: string): Promise<PacsLayout> {
  const stringsXml = (await execFileAsync('unzip', ['-p', xlsxPath, 'xl/sharedStrings.xml'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const listing = (await execFileAsync('unzip', ['-Z1', xlsxPath], { maxBuffer: 1024 * 1024 })).stdout;
  const sheets = listing
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/sheet(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/sheet(\d+)/)?.[1] ?? 0);
      return na - nb;
    });
  const strings = sharedStrings(stringsXml);
  const layout: PacsLayout = new Map();
  for (const sheet of sheets) {
    const sheetXml = (await execFileAsync('unzip', ['-p', xlsxPath, sheet], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    consumeSheet(sheetXml, strings, layout);
  }
  if (!layout.has('APPRAISAL_INFO')) {
    throw new Error(`PACS layout ${xlsxPath} has no APPRAISAL_INFO section`);
  }
  return layout;
}

export function fieldIndex(fields: PacsField[]): Map<string, PacsField> {
  const map = new Map<string, PacsField>();
  for (const field of fields) map.set(field.name.toLowerCase(), field);
  return map;
}

export function sliceField(line: string, field: PacsField | undefined): string {
  if (!field) return '';
  return line.slice(field.start - 1, field.start - 1 + field.length).trim();
}
