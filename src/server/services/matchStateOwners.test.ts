import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampOwnerRows } from './matchStateOwners.js';
import { permitStackPlaceId } from './shovelsContractors.js';
import { resolvePaHic } from '../lib/stateOwners/paHic.js';

describe('clampOwnerRows', () => {
  it('allows dry-run max_rows up to 100 and defaults to 25', () => {
    assert.equal(clampOwnerRows(undefined, true), 25);
    assert.equal(clampOwnerRows(100, true), 100);
    assert.equal(clampOwnerRows(250, true), 100);
    assert.equal(clampOwnerRows(1, true), 1);
    assert.equal(clampOwnerRows(80, false), 80);
  });
});

describe('permitStackPlaceId', () => {
  it('sets place_id = shovels: + ps_id', () => {
    assert.deepEqual(permitStackPlaceId('abc-123'), { place_id: 'shovels:abc-123', ps_id: 'abc-123' });
    assert.deepEqual(permitStackPlaceId('shovels:abc-123'), { place_id: 'shovels:abc-123', ps_id: 'abc-123' });
    assert.deepEqual(permitStackPlaceId(''), { place_id: null, ps_id: null });
  });
});

describe('resolvePaHic', () => {
  it('stays disabled and never fetches the Turnstile HIC site', async () => {
    const result = await resolvePaHic({ list_id: 'x', lead_id: 1, company_name: 'Acme' });
    assert.equal(result.coverage_reason, 'blocked');
    assert.equal(result.source, 'pa_hic');
    assert.equal(result.blocked, true);
    assert.equal(result.people.length, 0);
  });
});
