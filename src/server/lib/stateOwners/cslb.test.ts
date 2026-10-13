import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { extractCslbLicenseStatus, isCslbActiveStatus, normalizeCslbLicense, parseCslbText } from './cslb.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(dir, 'fixtures', name), 'utf8');

describe('normalizeCslbLicense', () => {
  it('strips leading zeros and keeps 5–8 digits', () => {
    assert.equal(normalizeCslbLicense('000989437'), '989437');
    assert.equal(normalizeCslbLicense('12345'), '12345');
    assert.equal(normalizeCslbLicense('12'), null);
    assert.equal(normalizeCslbLicense('123456789'), null);
    assert.equal(normalizeCslbLicense(''), null);
    assert.equal(normalizeCslbLicense('981116.0'), '981116');
    assert.equal(normalizeCslbLicense('1075385.0'), '1075385');
  });
});

describe('extractCslbLicenseStatus', () => {
  it('skips the help-chrome License Status and keeps the real field', () => {
    const status = extractCslbLicenseStatus(fixture('cslb-chrome-then-active.txt'));
    assert.equal(status, 'This license is current and active.');
    assert.equal(isCslbActiveStatus(status), true);
  });

  it('keeps a suspension phrase', () => {
    const status = extractCslbLicenseStatus(fixture('cslb-inactive.txt'));
    assert.match(status || '', /under suspension/i);
    assert.equal(isCslbActiveStatus(status), false);
  });

  it('keeps an expired phrase', () => {
    const status = extractCslbLicenseStatus(fixture('cslb-expired.txt'));
    assert.match(status || '', /expired/i);
    assert.equal(isCslbActiveStatus(status), false);
  });

  it('returns null on a disclaimer-only shell (not a detail page)', () => {
    assert.equal(extractCslbLicenseStatus(fixture('cslb-disclaimer-only.txt')), null);
  });
});

describe('parseCslbText', () => {
  it('extracts a qualifying individual from the 10-percent sentence', () => {
    const parsed = parseCslbText(fixture('cslb-qi-active.txt'), 'https://www.cslb.ca.gov/12345');
    assert.equal(parsed.active, true);
    assert.equal(parsed.entity, 'Corporation');
    assert.equal(parsed.business_phone, '(916) 555-0100');
    assert.equal(parsed.people.length, 1);
    assert.equal(parsed.people[0]?.role, 'qualifying_individual');
    assert.equal(parsed.people[0]?.confidence, 'high');
    assert.equal(parsed.people[0]?.first_name, 'JANE Q');
    assert.equal(parsed.people[0]?.last_name, 'PUBLIC');
    assert.equal(parsed.coverage_reason, null);
  });

  it('falls back to Bond of Qualifying Individual for NAME', () => {
    const parsed = parseCslbText(fixture('cslb-bond-fallback.txt'));
    assert.equal(parsed.people[0]?.full_name_raw, 'JOHN A SMITH');
    assert.equal(parsed.people[0]?.role, 'qualifying_individual');
    assert.equal(parsed.people[0]?.last_name, 'SMITH');
  });

  it('treats a 2–3 word sole-ownership business name as the person', () => {
    const parsed = parseCslbText(fixture('cslb-sole-person.txt'));
    assert.equal(parsed.people[0]?.role, 'sole_proprietor');
    assert.equal(parsed.people[0]?.confidence, 'medium');
    assert.equal(parsed.people[0]?.last_name, 'ELLEN');
    assert.equal(parsed.coverage_reason, null);
  });

  it('does not guess a sole-prop DBA with a company word', () => {
    const parsed = parseCslbText(fixture('cslb-sole-dba.txt'));
    assert.equal(parsed.people.length, 0);
    assert.equal(parsed.coverage_reason, 'sole_prop_dba');
  });

  it('returns inactive_license and no people when status is not current and active', () => {
    const parsed = parseCslbText(fixture('cslb-inactive.txt'));
    assert.equal(parsed.active, false);
    assert.equal(parsed.people.length, 0);
    assert.equal(parsed.coverage_reason, 'inactive_license');
  });

  it('sets first_name null and review_flag on 4+ token names', () => {
    const parsed = parseCslbText(fixture('cslb-four-token-review.txt'));
    assert.equal(parsed.people[0]?.first_name, null);
    assert.equal(parsed.people[0]?.review_flag, true);
    assert.equal(parsed.people[0]?.full_name_raw, 'MARY ELLEN ANN GARCIA');
  });

  it('reads License Status when the heading and sentence are on one line', () => {
    const parsed = parseCslbText(
      [
        'Business Information ACME WIRING INC',
        'Entity Corporation',
        'License Status This license is current and active.',
        'The qualifying individual JANE Q PUBLIC certified that he/she owns 10 percent or more of the voting stock/membership interest of this company.',
      ].join('\n'),
    );
    assert.equal(parsed.active, true);
    assert.match(parsed.license_status || '', /current and active/i);
    assert.equal(parsed.entity, 'Corporation');
    assert.equal(parsed.business_name, 'ACME WIRING INC');
    assert.equal(parsed.people.length, 1);
    assert.equal(parsed.coverage_reason, null);
  });

  it('treats chrome-then-active pages as current and active', () => {
    const parsed = parseCslbText(fixture('cslb-chrome-then-active.txt'));
    assert.equal(parsed.active, true);
    assert.equal(parsed.license_status, 'This license is current and active.');
    assert.equal(parsed.coverage_reason, null);
    assert.equal(parsed.people.length, 1);
  });

  it('uses parse_error on a disclaimer-only shell, never inactive_license', () => {
    const parsed = parseCslbText(fixture('cslb-disclaimer-only.txt'));
    assert.equal(parsed.active, false);
    assert.equal(parsed.coverage_reason, 'parse_error');
    assert.equal(parsed.people.length, 0);
  });

  it('marks expired wording inactive_license', () => {
    const parsed = parseCslbText(fixture('cslb-expired.txt'));
    assert.equal(parsed.active, false);
    assert.equal(parsed.coverage_reason, 'inactive_license');
    assert.equal(parsed.people.length, 0);
  });

  it('uses parse_error when License Status is missing, never inactive_license', () => {
    const parsed = parseCslbText(
      [
        'Business Information ACME WIRING INC',
        'Entity Corporation',
        'The qualifying individual JANE Q PUBLIC certified that he/she owns 10 percent or more of the voting stock/membership interest of this company.',
      ].join('\n'),
    );
    assert.equal(parsed.active, false);
    assert.equal(parsed.people.length, 0);
    assert.equal(parsed.coverage_reason, 'parse_error');
  });
});
