import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DownloadMeta {
  path: string;
  bytes: number;
  lastModified: string | null;
  sourceFileDate: string | null;
  finalUrl: string;
}

export function dateFromText(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = value.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = value.match(/\b(\d{2})[-/](\d{2})[-/](20\d{2})\b/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

export async function downloadToFile(url: string, dest: string): Promise<DownloadMeta> {
  mkdirSync(dirname(dest), { recursive: true });
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'permits-gcs-parcel-loader/2' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} ${url}`);
  }
  const lastModified = response.headers.get('last-modified');
  await pipeline(Readable.fromWeb(response.body as import('stream/web').ReadableStream), createWriteStream(dest));
  const bytes = statSync(dest).size;
  return {
    path: dest,
    bytes,
    lastModified,
    sourceFileDate: dateFromText(lastModified) ?? dateFromText(url),
    finalUrl: response.url || url,
  };
}

export async function unzipList(zipPath: string): Promise<Array<{ name: string; bytes: number; date: string | null }>> {
  const { stdout } = await execFileAsync('unzip', ['-l', zipPath], { maxBuffer: 32 * 1024 * 1024 });
  const rows: Array<{ name: string; bytes: number; date: string | null }> = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) continue;
    const name = match[3]!.trim();
    if (!name || name.endsWith('/')) continue;
    rows.push({ name, bytes: Number(match[1]), date: match[2]! });
  }
  return rows;
}

export async function unzipFiles(zipPath: string, destDir: string, names: string[]): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  if (!names.length) return;
  await execFileAsync('unzip', ['-o', '-j', zipPath, ...names, '-d', destDir], {
    maxBuffer: 8 * 1024 * 1024,
  });
}
