import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resolveHtmlOfficerState } from './htmlStates.js';
import { isWaterfallReady } from './waterfall.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function html(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

describe('GA/NC/AZ HTML adapters', () => {
  it('extracts GA officers from official HTML fixtures', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Builders LLC', city: 'Atlanta', state: 'GA' },
      'GA',
      {
        live: false,
        htmlFor: (_state, kind) => (kind === 'search' ? html('ga-search.html') : html('ga-detail.html')),
      },
    );
    assert.equal(result.implemented, true);
    assert.equal(result.coverage_reason, null);
    assert.ok(result.people.some((p) => isWaterfallReady(p) && p.last_name === 'SAMPLE'));
  });

  it('extracts NC company officials from HTML fixtures', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Plumbing LLC', city: 'Raleigh', state: 'NC' },
      'NC',
      {
        live: false,
        htmlFor: (_state, kind) => (kind === 'search' ? html('nc-search.html') : html('nc-detail.html')),
      },
    );
    assert.ok(result.people.some((p) => p.first_name === 'JANE'));
  });

  it('extracts AZ members from HTML fixtures', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Electric LLC', city: 'Phoenix', state: 'AZ' },
      'AZ',
      {
        live: false,
        htmlFor: (_state, kind) => (kind === 'search' ? html('az-search.html') : html('az-detail.html')),
      },
    );
    assert.ok(result.people.some((p) => p.role === 'member'));
  });

  it('uses Apify Playwright only after a blocked direct fetch', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Builders LLC', city: 'Atlanta', state: 'GA' },
      'GA',
      {
        live: true,
        fetch: async () =>
          new Response('<html>Incapsula incident id 1</html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
        apifyFetchHtml: async () => ({ html: html('ga-detail.html'), usd: 0.015 }),
      },
    );
    assert.equal(result.via_apify, true);
    assert.ok((result.apify_usd || 0) > 0);
    assert.ok(result.people.some((p) => p.last_name === 'SAMPLE'));
  });
});
