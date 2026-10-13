import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasCompanyWord,
  htmlToText,
  isNycCity,
  looksLikeSolePropPerson,
  normalizeCompanyName,
  normalizeState,
  personKey,
  splitPersonName,
} from './names.js';
import { parseNycDobJson } from './nycDob.js';
import { parseWaLniText } from './waLni.js';
import { parseTxTdlrText } from './txTdlr.js';
import { parseMaCslText } from './maCsl.js';
import { parseMnDliText } from './mnDli.js';
import { parsePaHicText } from './paHic.js';
import { sampleOwnerRows } from './types.js';

describe('splitPersonName', () => {
  it('splits two and three tokens on the last word', () => {
    assert.deepEqual(splitPersonName('JANE PUBLIC'), {
      first_name: 'JANE',
      last_name: 'PUBLIC',
      full_name_raw: 'JANE PUBLIC',
      review_flag: false,
    });
    assert.equal(splitPersonName('JANE Q PUBLIC').last_name, 'PUBLIC');
    assert.equal(splitPersonName('JANE Q PUBLIC').first_name, 'JANE Q');
  });

  it('does not guess first/last on four tokens', () => {
    const split = splitPersonName('MARY ELLEN ANN GARCIA');
    assert.equal(split.first_name, null);
    assert.equal(split.review_flag, true);
  });
});

describe('normalizeCompanyName', () => {
  it('strips punctuation, legal suffixes, and DBA tails', () => {
    assert.equal(normalizeCompanyName('Smith HVAC, L.L.C. DBA Cool Air'), 'SMITH HVAC');
    assert.equal(normalizeCompanyName('J & J ELECTRIC INC'), 'J AND J ELECTRIC');
  });
});

describe('sole prop person heuristic', () => {
  it('accepts 2–3 word names without company words', () => {
    assert.equal(looksLikeSolePropPerson('MARY ELLEN'), true);
    assert.equal(looksLikeSolePropPerson('VALLEY ROOFING'), false);
    assert.equal(looksLikeSolePropPerson('ACME CONSTRUCTION'), false);
    assert.equal(hasCompanyWord('VALLEY SERVICES'), true);
  });
});

describe('geo helpers', () => {
  it('normalizes state names and NYC cities', () => {
    assert.equal(normalizeState('California'), 'CA');
    assert.equal(isNycCity('Brooklyn'), true);
    assert.equal(isNycCity('Albany'), false);
  });
});

describe('htmlToText', () => {
  it('strips tags to lines', () => {
    const text = htmlToText('<div>Business Information</div><p>ACME INC</p>');
    assert.match(text, /Business Information/);
    assert.match(text, /ACME INC/);
  });
});

describe('other board parsers', () => {
  it('parses NYC DOB JSON licensee as owner', () => {
    const result = parseNycDobJson(
      [
        {
          first_name: 'GEORGE',
          last_name: 'PAPADIONISOPOULOS',
          license_status: 'ACTIVE',
          business_phone_number: '3476547642',
        },
      ],
      'https://data.cityofnewyork.us/resource/cnwx-a5xx.json',
    );
    assert.equal(result.people[0]?.role, 'owner');
    assert.equal(result.people[0]?.source, 'nyc_dob');
    assert.equal(result.coverage_reason, null);
    assert.equal(result.people[0]?.business_phone, '3476547642');
  });

  it('marks expired NYC licenses inactive', () => {
    const result = parseNycDobJson([{ first_name: 'A', last_name: 'B', license_status: 'EXPIRED' }], 'u');
    assert.equal(result.coverage_reason, 'inactive_license');
    assert.equal(result.people.length, 0);
  });

  it('parses WA governing persons', () => {
    const result = parseWaLniText(
      'Governing persons\nALICE BAKER\nLicense\nActive registration\n',
      'https://secure.lni.wa.gov/verify/Detail.aspx?LIC=1',
    );
    assert.equal(result.people[0]?.last_name, 'BAKER');
    assert.equal(result.people[0]?.source, 'wa_lni');
  });

  it('parses TDLR / MA / MN / PA holder lines', () => {
    assert.equal(parseTxTdlrText('Licensee: SAM LEE\nActive\n', 'u').people[0]?.last_name, 'LEE');
    assert.equal(parseMaCslText('License Holder: PAT KIM\nActive\n', 'u').people[0]?.role, 'owner');
    assert.equal(
      parseMnDliText('Qualifying Person: CHRIS ONG\nActive\n', 'u').people[0]?.role,
      'qualifying_individual',
    );
    assert.equal(parsePaHicText('Owner: RILEY COHEN\n', 'u').people[0]?.source, 'pa_hic');
  });
});

describe('sampleOwnerRows', () => {
  it('omits names from samples', () => {
    const sample = sampleOwnerRows([
      {
        people: [
          {
            first_name: 'JANE',
            last_name: 'PUBLIC',
            full_name_raw: 'JANE PUBLIC',
            role: 'owner',
            source: 'cslb',
            source_url: 'u',
            confidence: 'high',
          },
        ],
        coverage_reason: null,
        source: 'cslb',
      },
    ]);
    const blob = JSON.stringify(sample);
    assert.equal(blob.includes('JANE'), false);
    assert.equal(blob.includes('PUBLIC'), false);
    assert.equal(sample[0]?.role, 'owner');
    assert.equal(sample[0]?.source, 'cslb');
    assert.equal(personKey('Jane  Public'), 'jane public');
  });
});
