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

function columnLetters(ref: string): string {
  return ref.replace(/[0-9]/g, '');
}

/** Read a True Automation "Appraisal Export Layout" xlsx into per-file field lists. */
export async function readPacsLayout(xlsxPath: string): Promise<PacsLayout> {
  const stringsXml = (await execFileAsync('unzip', ['-p', xlsxPath, 'xl/sharedStrings.xml'], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const sheetXml = (await execFileAsync('unzip', ['-p', xlsxPath, 'xl/worksheets/sheet1.xml'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const strings = sharedStrings(stringsXml);
  const layout: PacsLayout = new Map();
  let current: PacsField[] | null = null;
  let currentName = '';
  for (const chunk of sheetXml.split(/<row\b/)) {
    const cells = new Map<string, string>();
    for (const match of chunk.matchAll(/<c\b[^>]*r="([A-Z]+)[0-9]+"[^>]*(?:t="([^"]+)")?[^>]*>\s*(?:<v>([^<]*)<\/v>)?/g)) {
      const col = columnLetters(match[1] ?? '');
      const type = match[2];
      const raw = match[3];
      if (!col || raw == null) continue;
      cells.set(col, type === 's' ? strings[Number(raw)] ?? '' : raw);
    }
    const label = (cells.get('A') ?? '').trim();
    if (/APPRAISAL_[A-Z0-9_]+\.TXT/i.test(label) || /File #\d+/i.test(label)) {
      const file = label.match(/([A-Z0-9_]+)\.TXT/i)?.[1]?.toUpperCase();
      if (file) {
        currentName = file;
        current = [];
        layout.set(currentName, current);
      }
      continue;
    }
    if (!current || !label || label === 'Field Name') continue;
    const start = Number(cells.get('C'));
    const length = Number(cells.get('E'));
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) continue;
    current.push({ name: label.trim(), start, length });
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
