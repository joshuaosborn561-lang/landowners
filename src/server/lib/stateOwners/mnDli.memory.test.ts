import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../../..');
const REAL_DLI = '/tmp/mn-dli-dry/combined.csv';
const HEADER =
  'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress';
const SYNTH_ROWS = 200_000;
const HEAP_CAP_MB = 500;

type MemoryReport = {
  contractors: number;
  parcels: number;
  dli_rows: number;
  ingest_ms: number;
  lookup_license_ms: number;
  lookup_exact_ms: number;
  lookup_miss_ms: number;
  named_license: number;
  named_exact: number;
  miss_reason: string | null;
  heap_boot_mb: number;
  heap_after_ingest_mb: number;
  heap_after_lookups_mb: number;
  rss_after_lookups_mb: number;
};

function heapMb(): { heap_used_mb: number; rss_mb: number } {
  const m = process.memoryUsage();
  return {
    heap_used_mb: Math.round(m.heapUsed / 1048576),
    rss_mb: Math.round(m.rss / 1048576),
  };
}

function gc(): void {
  globalThis.gc?.();
}

async function writeSyntheticCsv(path: string, n: number): Promise<void> {
  const out = createWriteStream(path);
  out.write(`${HEADER}\n`);
  out.write(
    'Business,Residential Contractors,Residential Building Contractor,SENTINEL TARGET LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC999001,Issued,,,,\n',
  );
  out.write(
    'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB999001,Issued,,,,\n',
  );
  for (let i = 0; i < n; i += 1) {
    const ok = out.write(
      `Business,Residential Contractors,Residential Building Contractor,FIRM${i} LLC,,${i} OAK ST,,ST PAUL,MN,55101,6515550100,,BC${i},Issued,,,,\n`,
    );
    if (!ok) await new Promise<void>((resolve) => out.once('drain', resolve));
  }
  out.end();
  await finished(out);
}

async function runChild(): Promise<void> {
  const csvPath = process.env.MN_DLI_CSV;
  if (!csvPath) throw new Error('MN_DLI_CSV is required');
  const probeName = process.env.MN_DLI_PROBE_NAME || 'Sentinel Target LLC';
  const probeLic = process.env.MN_DLI_PROBE_LICENSE || 'BC999001';

  const { createMnIndex, ingestMnCsvFile, lookupMnIndex } = await import('./mnDli.js');
  const { loadParcels } = await import('../../services/parcels.js');
  const { loadShovelsContractors } = await import('../../services/shovelsContractors.js');

  loadShovelsContractors();
  const parcels = loadParcels();
  gc();
  const boot = heapMb();
  const contractors = loadShovelsContractors().length;

  const index = createMnIndex();
  const tIngest = Date.now();
  await ingestMnCsvFile(index, csvPath);
  const ingest_ms = Date.now() - tIngest;
  gc();
  const afterIngest = heapMb();

  const tLic = Date.now();
  const byLic = lookupMnIndex(index, 'Unrelated Ventures LLC', 'u', probeLic);
  const lookup_license_ms = Date.now() - tLic;

  const tExact = Date.now();
  const byName = lookupMnIndex(index, probeName, 'u');
  const lookup_exact_ms = Date.now() - tExact;

  const tMiss = Date.now();
  const miss = lookupMnIndex(index, 'Unrelated Ventures LLC', 'u');
  const lookup_miss_ms = Date.now() - tMiss;

  gc();
  const afterLookups = heapMb();

  const report: MemoryReport = {
    contractors,
    parcels: parcels.length,
    dli_rows: index.rows,
    ingest_ms,
    lookup_license_ms,
    lookup_exact_ms,
    lookup_miss_ms,
    named_license: byLic.people.length,
    named_exact: byName.people.length,
    miss_reason: miss.coverage_reason,
    heap_boot_mb: boot.heap_used_mb,
    heap_after_ingest_mb: afterIngest.heap_used_mb,
    heap_after_lookups_mb: afterLookups.heap_used_mb,
    rss_after_lookups_mb: afterLookups.rss_mb,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function parseReport(stdout: string): MemoryReport {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.startsWith('{')) return JSON.parse(lines[i]!) as MemoryReport;
  }
  throw new Error('memory child printed no JSON report');
}

if (process.env.MN_DLI_MEMORY_CHILD === '1') {
  runChild().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  describe('MN DLI startup memory', () => {
    it(
      'ingests production-scale DLI with 6k contractors + 156k parcels under a 512MB heap',
      { timeout: 180_000 },
      async () => {
        const real = process.env.MN_DLI_CSV || (existsSync(REAL_DLI) ? REAL_DLI : '');
        const csvPath = real || join(tmpdir(), 'mn-dli-memory-test.csv');
        const probeName = real ? 'Luther Construction Services Inc' : 'Sentinel Target LLC';
        const probeLic = real ? 'BC648794' : 'BC999001';
        if (!real) await writeSyntheticCsv(csvPath, SYNTH_ROWS);

        const child = spawn(
          process.execPath,
          ['--import', 'tsx', join(HERE, 'mnDli.memory.test.ts')],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              NODE_OPTIONS: '--max-old-space-size=512 --expose-gc',
              MN_DLI_MEMORY_CHILD: '1',
              MN_DLI_CSV: csvPath,
              MN_DLI_PROBE_NAME: probeName,
              MN_DLI_PROBE_LICENSE: probeLic,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });

        const code: number | null = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });

        assert.equal(
          code,
          0,
          `512MB child exited ${code}. stderr=${stderr.slice(-1500)} stdout=${stdout.slice(-1500)}`,
        );
        const report = parseReport(stdout);
        assert.ok(report.contractors >= 6000, `contractors=${report.contractors}`);
        assert.ok(report.parcels >= 150_000, `parcels=${report.parcels}`);
        assert.ok(report.dli_rows >= 150_000, `dli_rows=${report.dli_rows}`);
        assert.ok(report.ingest_ms < 60_000, `ingest_ms=${report.ingest_ms}`);
        assert.ok(report.lookup_license_ms < 250, `lookup_license_ms=${report.lookup_license_ms}`);
        assert.ok(report.lookup_exact_ms < 250, `lookup_exact_ms=${report.lookup_exact_ms}`);
        assert.ok(report.lookup_miss_ms < 250, `lookup_miss_ms=${report.lookup_miss_ms}`);
        assert.ok(report.named_license >= 1, 'license lookup should resolve a person');
        assert.equal(report.miss_reason, 'name_miss');
        assert.ok(
          report.heap_after_lookups_mb <= HEAP_CAP_MB,
          `heap_after_lookups_mb=${report.heap_after_lookups_mb} boot=${report.heap_boot_mb} ingest=${report.heap_after_ingest_mb}`,
        );
      },
    );
  });
}
