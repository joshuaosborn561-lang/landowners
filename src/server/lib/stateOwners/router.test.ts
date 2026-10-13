import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadState, sourceForState } from './router.js';
import { normalizeCslbLicense } from './cslb.js';
import type { OwnerLead } from './types.js';

describe('router', () => {
  it('maps states to board sources', () => {
    assert.equal(sourceForState('CA'), 'cslb');
    assert.equal(sourceForState('WA'), 'wa_lni');
    assert.equal(sourceForState('NY', 'Brooklyn'), 'nyc_dob');
    assert.equal(sourceForState('NY', 'Albany'), 'ny_dos');
    assert.equal(sourceForState('MA'), 'ma_csl');
    assert.equal(sourceForState('MN'), 'mn_dli');
    assert.equal(sourceForState('PA'), 'pa_hic');
    assert.equal(sourceForState('TX'), 'tx_tdlr');
    assert.equal(sourceForState('FL'), 'sunbiz');
  });

  it('reads the lead state', () => {
    const lead: OwnerLead = {
      list_id: 'x',
      lead_id: 1,
      company_name: 'Acme',
      state: 'California',
      license_number: '00012345',
    };
    assert.equal(leadState(lead), 'CA');
    assert.equal(normalizeCslbLicense(lead.license_number), '12345');
  });
});
