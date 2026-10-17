import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJob, resetJobsForTests } from '../lib/stateOwners/sos/jobs.js';
import {
  APIFY_USD_PER_BLOCKED_LOOKUP,
  PHASE1_WRITES_ENABLED,
  getBusinessOwnerJob,
  lookupBusinessOwner,
} from './lookupBusinessOwner.js';
import { sourceForState } from '../lib/stateOwners/router.js';
import { resolveCslb } from '../lib/stateOwners/cslb.js';

describe('lookup_business_owner scaffold', () => {
  it('returns a first-use envelope on estimate_only without calling SOS', async () => {
    const out = await lookupBusinessOwner({ estimate_only: true });
    assert.equal(out.ok, true);
    assert.equal(out.writes_enabled, false);
    assert.equal(PHASE1_WRITES_ENABLED, false);
    const first = out.first_use as { assumed_total: number; ca_api_usd: number };
    assert.equal(first.assumed_total, 15359);
    assert.equal(first.ca_api_usd, 0);
    assert.equal(out.apify_estimate_usd, 0);
    assert.ok(APIFY_USD_PER_BLOCKED_LOOKUP > 0);
  });

  it('records a dry job with counts only', async () => {
    resetJobsForTests();
    const out = await lookupBusinessOwner({
      dry_run: true,
      rows: [
        { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
        { company_name: 'Sample HVAC LLC', city: 'Denver', state: 'CO' },
      ],
    });
    assert.equal(out.ok, true);
    assert.equal(out.processed, 2);
    assert.equal(out.named, 0);
    assert.equal(out.writes_enabled, false);
    const job = getJob(String(out.job_id));
    assert.equal(job?.status, 'completed');
    const fetched = await getBusinessOwnerJob(String(out.job_id));
    assert.equal(fetched.ok, true);
    assert.equal(fetched.processed, 2);
  });
});

describe('permit path unchanged', () => {
  it('still routes CA to CSLB and fails closed without a license number', async () => {
    assert.equal(sourceForState('CA'), 'cslb');
    const result = await resolveCslb({
      list_id: 'x',
      lead_id: 1,
      company_name: 'Sample Builders LLC',
      state: 'CA',
      city: 'Oakland',
    });
    assert.equal(result.coverage_reason, 'no_license_number');
    assert.equal(result.people.length, 0);
  });
});
