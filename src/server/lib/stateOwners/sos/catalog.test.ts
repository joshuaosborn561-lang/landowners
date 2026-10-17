import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PRIORITY_CODES,
  STATE_SOS_CATALOG,
  US_JURISDICTION_COUNT,
  catalogByCode,
  catalogInRolloutOrder,
} from './catalog.js';

describe('STATE_SOS_CATALOG', () => {
  it('covers 50 states plus DC once each', () => {
    const codes = STATE_SOS_CATALOG.map((r) => r.code);
    assert.equal(codes.length, US_JURISDICTION_COUNT);
    assert.equal(new Set(codes).size, US_JURISDICTION_COUNT);
    assert.ok(codes.includes('DC'));
    assert.ok(codes.includes('CA'));
  });

  it('rolls out CA then IL GA OH NC AZ CO', () => {
    const order = catalogInRolloutOrder().map((r) => r.code);
    assert.deepEqual(order.slice(0, PRIORITY_CODES.length), [...PRIORITY_CODES]);
    const byCode = catalogByCode();
    assert.equal(byCode.get('CA')?.access, 'html');
    assert.equal(byCode.get('CA')?.apify, 'fallback');
    assert.match(byCode.get('CA')?.search_url || '', /bizfileonline\.sos\.ca\.gov/);
    assert.equal(byCode.get('CA')?.officers, 'filings_pdf');
    assert.equal(byCode.get('IL')?.apify, 'never');
    assert.equal(byCode.get('IL')?.access, 'bulk_file');
    assert.equal(byCode.get('OH')?.officers, 'agent_only');
    assert.equal(byCode.get('CO')?.access, 'open_data');
    assert.equal(byCode.get('CO')?.apify, 'never');
  });
});
