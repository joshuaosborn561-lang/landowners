import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isChurchName } from './church.js';
import { parcelMatches } from './filters.js';
import { assertWritableProject } from './guard.js';
import { mergeRegisteredCounties } from './registry.js';
import { countiesWithinDallasRadius, radiusDiff, ROUGH_EXPECTED_COUNTIES } from './radius.js';
import { placePacsField, sliceField, type PacsField } from './parsers/pacsLayout.js';
import { socrataAdvance } from './parsers/socrata.js';
import { openVendor } from './parsers/vendor.js';
import type { CountyConfig } from './countyTypes.js';

describe('dallas radius', () => {
  it('includes the rough expected counties and flags extras', () => {
    const hits = countiesWithinDallasRadius();
    const diff = radiusDiff(hits);
    for (const name of ROUGH_EXPECTED_COUNTIES) {
      assert.ok(diff.computed.includes(name), `missing ${name}`);
    }
    assert.deepEqual(diff.missing_from_computed, []);
    for (const extra of ['Bosque', 'Cooke', 'Hopkins', 'Rains', 'Somervell']) {
      assert.ok(diff.extra_vs_expected.includes(extra), `expected extra ${extra}`);
    }
  });
});

describe('county registry', () => {
  it('keeps a radius county missing from config as needs_request', () => {
    const merged = mergeRegisteredCounties(
      [
        {
          name: 'Dallas',
          state: 'TX',
          fips: '48113',
          source_type: 'dcad_extract',
          source_url: 'https://example.test/dallas.zip',
          parser: 'dcad',
          refresh_cadence: 'annual',
          status: 'active',
        },
      ],
      [
        { name: 'Dallas', state: 'TX', fips: '48113', boundary_miles: 0 },
        { name: 'Hunt', state: 'TX', fips: '48231', boundary_miles: 29.25 },
      ],
    );
    const hunt = merged.find((county) => county.name === 'Hunt');
    assert.equal(hunt?.status, 'needs_request');
    assert.equal(hunt?.source_type, 'open_records');
    assert.equal(hunt?.inside_60_miles, true);
    const dallas = merged.find((county) => county.name === 'Dallas');
    assert.equal(dallas?.status, 'active');
    assert.equal(dallas?.inside_60_miles, true);
  });
});

describe('church flag', () => {
  it('matches church words and skips Churchill', () => {
    assert.equal(isChurchName('Churchill Downs LLC', null), false);
    assert.equal(isChurchName('FIRST BAPTIST CHURCH', null), true);
    assert.equal(isChurchName('GRACE FELLOWSHIP', 'religious'), true);
    assert.equal(isChurchName('NORTH ASSEMBLY OF GOD', null), true);
    assert.equal(isChurchName('SMITH FAMILY TRUST', 'residential'), false);
  });
});

describe('pacs slice', () => {
  it('reads a 1-indexed fixed field', () => {
    const field: PacsField = { name: 'prop_id', start: 1, length: 12 };
    const line = '000000000042' + 'X'.repeat(20);
    assert.equal(sliceField(line, field), '000000000042');
    const owner: PacsField = { name: 'py_owner_name', start: 13, length: 10 };
    assert.equal(sliceField(line, owner), 'XXXXXXXXXX');
  });

  it('continues a field when the layout leaves Start blank', () => {
    const fields: PacsField[] = [];
    placePacsField(fields, 'prop_id', 1, 12);
    placePacsField(fields, 'prop_type_cd', null, 5);
    placePacsField(fields, 'py_owner_name', null, 70);
    assert.equal(fields[1]?.start, 13);
    assert.equal(fields[2]?.start, 18);
  });
});

describe('socrata paging', () => {
  it('stops when a page is short', () => {
    assert.equal(socrataAdvance(0, 50000, 50000), 50000);
    assert.equal(socrataAdvance(50000, 50000, 50000), 100000);
    assert.equal(socrataAdvance(100000, 1361, 50000), null);
  });
});

describe('project guard', () => {
  it('rejects the forbidden projects and accepts the permits project', () => {
    assert.throws(() => assertWritableProject('https://azpapwtnrbzywlnxxecz.supabase.co'));
    assert.throws(() => assertWritableProject('https://klomihumrgwoixbzxypr.supabase.co'));
    assert.equal(
      assertWritableProject('https://kemvxzhcxvynmoutwdrh.supabase.co'),
      'kemvxzhcxvynmoutwdrh',
    );
  });
});

describe('parcel filters', () => {
  const row = {
    county: 'Collin',
    state: 'TX',
    owner_type: 'local_llc',
    is_church: false,
    improved: true,
    assessed_value: 400000,
    state_use_code: 'F1',
    miles_from_dallas: 18,
    owner_name: 'OAK STREET LLC',
    city: 'Plano',
    zip: '75024',
    account_id: '1',
  };

  it('applies miles, improved, and owner_type OR church', () => {
    assert.equal(
      parcelMatches(row, {
        max_miles_from_dallas: 60,
        improved: true,
        owner_type: ['local_llc', 'institutional'],
        owner_or_church: true,
      }),
      true,
    );
    assert.equal(
      parcelMatches({ ...row, miles_from_dallas: 61 }, { max_miles_from_dallas: 60 }),
      false,
    );
    assert.equal(
      parcelMatches({ ...row, miles_from_dallas: null }, { max_miles_from_dallas: 60 }),
      false,
    );
    assert.equal(
      parcelMatches(
        { ...row, owner_type: 'individual', is_church: true },
        { owner_type: ['local_llc', 'institutional'], owner_or_church: true },
      ),
      true,
    );
    assert.equal(
      parcelMatches(
        { ...row, owner_type: 'individual', is_church: false },
        { owner_type: ['local_llc', 'institutional'], owner_or_church: true },
      ),
      false,
    );
  });
});

describe('vendor slot', () => {
  it('throws before any network call', async () => {
    const county: CountyConfig = {
      name: 'Example',
      state: 'TX',
      source_type: 'vendor_api',
      source_url: 'https://vendor.example/should-not-be-called',
      parser: 'vendor_api',
      refresh_cadence: 'annual',
      status: 'registered',
    };
    await assert.rejects(() => openVendor(county), /No vendor request was sent/);
  });
});
