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

  it('extracts AZ members from the Business Center JSON API shape', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Electric LLC', city: 'Phoenix', state: 'AZ' },
      'AZ',
      {
        live: false,
        azPayload: JSON.parse(html('az-search.json')),
        azDetailPayload: JSON.parse(html('az-detail.json')),
      },
    );
    assert.ok(result.people.some((p) => p.role === 'member' || p.last_name === 'SAMPLE'));
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

  it('treats recorded Cloudflare search HTML as blocked and never parses officers', async () => {
    const cf = html('nc-cloudflare-just-a-moment.html');
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Plumbing LLC', city: 'Raleigh', state: 'NC' },
      'NC',
      { live: false, htmlFor: cf },
    );
    assert.equal(result.coverage_reason, 'blocked');
    assert.equal(result.people.length, 0);
    assert.equal(result.people.some((p) => isWaterfallReady(p)), false);
  });

  it('does not match the input name against itself when SOS returns no result links', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Builders LLC', city: 'Atlanta', state: 'GA' },
      'GA',
      { live: false, htmlFor: '<html><body><div>No records found</div></body></html>' },
    );
    assert.equal(result.coverage_reason, 'not_found');
    assert.equal(result.people.length, 0);
  });

  it('does not treat the Arizona empty SPA shell as a company match', async () => {
    const result = await resolveHtmlOfficerState(
      { company_name: 'Sample Electric LLC', city: 'Phoenix', state: 'AZ' },
      'AZ',
      { live: false, htmlFor: html('az-spa-shell.html') },
    );
    assert.equal(result.people.length, 0);
    assert.ok(result.coverage_reason === 'not_found' || result.coverage_reason === 'blocked');
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
        apifyFetchHtml: async (url) => ({
          html: /BusinessInformation/i.test(url) ? html('ga-detail.html') : html('ga-search.html'),
          usd: 0.015,
        }),
      },
    );
    assert.equal(result.via_apify, true);
    assert.ok((result.apify_usd || 0) > 0);
    assert.ok(result.people.some((p) => p.last_name === 'SAMPLE'));
  });
});
