import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertAllowedApifyActor, PaidDatasetForbiddenError } from './apifyPlaywright.js';

describe('Apify policy', () => {
  it('allows playwright-scraper and forbids paid officer datasets', () => {
    assert.doesNotThrow(() => assertAllowedApifyActor('apify/playwright-scraper'));
    assert.throws(() => assertAllowedApifyActor('open-sos-data/officers'), PaidDatasetForbiddenError);
  });
});
