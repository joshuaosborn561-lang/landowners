import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { hasPermitLicense, resolveNameLookup } from './namePath.js';
import { matchCaBizfileFromPayload, parseCaBizfileSearch } from './caBizfile.js';
import { pickBestEntityMatch } from './match.js';
import { isWaterfallReady } from './waterfall.js';

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ca-bizfile-keyword.json'), 'utf8'),
);

describe('CA BizFile fixture (synthetic)', () => {
  it('parses keyword JSON and city-tie-breaks two same legal names', () => {
    const rows = parseCaBizfileSearch(fixture);
    assert.equal(rows.length, 2);
    const oakland = matchCaBizfileFromPayload('Sample Builders LLC', 'Oakland', fixture);
    assert.equal(oakland.entity?.EntityID, '202399900002');
    assert.equal(oakland.coverage_reason, 'agent_only');
    const sac = matchCaBizfileFromPayload('Sample Builders LLC', 'Sacramento', fixture);
    assert.equal(sac.entity?.EntityID, '202399900001');
  });

  it('matches a DBA tail against the legal+DBA entity name', () => {
    const hit = pickBestEntityMatch(
      'Sample Crew',
      parseCaBizfileSearch(fixture),
      {
        legalNameOf: (r) => r.EntityName || '',
        city: 'Oakland',
        cityOf: (r) => r.EntityCity || r.MailingCity,
      },
    );
    assert.ok(hit);
    assert.equal(hit.item.EntityID, '202399900002');
  });

  it('does not treat the API agent as waterfall-ready', async () => {
    const result = await resolveNameLookup(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      { caPayload: fixture, includeAgents: true, live: false },
    );
    assert.equal(result.source, 'ca_bizfile');
    assert.equal(result.coverage_reason, 'agent_only');
    assert.equal(result.implemented, true);
    assert.equal(result.people[0]?.role, 'registered_agent');
    assert.equal(isWaterfallReady(result.people[0]!), false);
  });

  it('returns missing_key for CA when no API key or payload is injected', async () => {
    const result = await resolveNameLookup(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      { live: false },
    );
    assert.equal(result.coverage_reason, 'missing_key');
    assert.equal(result.source, 'ca_bizfile');
    assert.equal(result.implemented, true);
  });

  it('extracts SI officers after a BizFile entity match', async () => {
    const si = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ca-si-text.txt'), 'utf8');
    const result = await resolveNameLookup(
      { company_name: 'Sample Builders LLC', city: 'Oakland', state: 'CA' },
      { caPayload: fixture, caSiText: si, live: false },
    );
    assert.equal(result.coverage_reason, null);
    assert.ok(result.people.some((p) => isWaterfallReady(p) && p.last_name === 'SAMPLE'));
    assert.equal(result.source, 'ca_bizfile');
  });
});

describe('permit vs name path', () => {
  it('still requires a CSLB license number on the permit path', () => {
    assert.equal(hasPermitLicense({ company_name: 'Sample', state: 'CA' }), false);
    assert.equal(hasPermitLicense({ company_name: 'Sample', state: 'CA', license_number: '123456' }), true);
  });
});
