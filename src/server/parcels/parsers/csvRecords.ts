import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseCsv } from '../../services/parcels.js';

/** Stream a CSV that may quote commas. Physical lines with an odd quote count are joined. */
export async function* csvRecords(path: string): AsyncGenerator<string[]> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  let buffer = '';
  const flush = function* (text: string): Generator<string[]> {
    const rows = parseCsv(text.endsWith('\n') ? text : `${text}\n`);
    for (const row of rows) {
      if (row.length === 1 && row[0] === '') continue;
      yield row;
    }
  };
  for await (const line of rl) {
    buffer = buffer ? `${buffer}\n${line}` : line;
    const quotes = buffer.split('"').length - 1;
    if (quotes % 2 === 0) {
      yield* flush(buffer);
      buffer = '';
    }
  }
  if (buffer.trim()) yield* flush(buffer);
}

export function headerIndex(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => index.set(name.trim().toLowerCase(), i));
  return index;
}

export function col(cols: string[], index: Map<string, number>, name: string): string {
  const at = index.get(name.toLowerCase());
  if (at == null) return '';
  return cols[at]?.trim() ?? '';
}
