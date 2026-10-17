import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { emptyIlIndex, ingestIlDtaText } from './ilDta.js';
import { resolveNameLookup } from './namePath.js';
import { formatSampleCsv, readCompanyCsv, resultToCsvRow, summarizeSample } from './sampleCsv.js';
import { isWaterfallReady } from './waterfall.js';
import type { LookupContext } from './context.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function html(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

describe('owner_lookup_sample helpers', () => {
  it('runs a fixture CSV through all Phase 2 adapters without network or writes', async () => {
    const index = emptyIlIndex();
    ingestIlDtaText(index, readFileSync(join(dir, 'il', 'officers.tsv'), 'utf8'), 'officers.tsv');
    const ctx: LookupContext = {
      live: false,
      caPayload: JSON.parse(readFileSync(join(dir, 'ca-bizfile-keyword.json'), 'utf8')),
      caSiText: readFileSync(join(dir, 'ca-si-text.txt'), 'utf8'),
      ilIndex: index,
      coRows: JSON.parse(readFileSync(join(dir, 'co-soda.json'), 'utf8')),
      ohRows: JSON.parse(readFileSync(join(dir, 'oh-search.json'), 'utf8')).data,
      htmlFor: (state, kind) => {
        if (state === 'GA') return kind === 'search' ? html('ga-search.html') : html('ga-detail.html');
        if (state === 'NC') return kind === 'search' ? html('nc-search.html') : html('nc-detail.html');
        if (state === 'AZ') return kind === 'search' ? html('az-search.html') : html('az-detail.html');
        return null;
      },
    };
    const rows = await readCompanyCsv(join(dir, 'sample-companies.csv'));
    assert.equal(rows.length, 7);
    const lines = [];
    for (const row of rows) {
      const result = await resolveNameLookup(row, ctx);
      lines.push(resultToCsvRow(row, result));
    }
    const summary = summarizeSample(lines);
    assert.equal(summary.rows, 7);
    assert.ok(summary.named >= 4, `expected officers in CA/IL/GA/NC/AZ, got ${summary.named}`);
    assert.ok(summary.hit_rate_by_state.OH.agent_only >= 1);
    assert.ok(summary.hit_rate_by_state.CO.agent_only >= 1);
    assert.equal(summary.apify_usd_spent, 0);
    assert.ok(lines.some((r) => r.waterfall_ready && isWaterfallReady({
      first_name: r.officer_first,
      last_name: r.officer_last,
      title: r.officer_title,
      company_name: r.company,
      domain: null,
      source_url: r.source_url,
      confidence: 'high',
      state: r.state,
      source: 'ca_bizfile',
      role: 'officer',
      coverage_reason: null,
    })));
    const csv = formatSampleCsv(lines);
    assert.match(csv, /^company,city,state,/);
  });
});
