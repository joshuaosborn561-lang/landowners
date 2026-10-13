import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasCompanyWord,
  htmlToText,
  isNycCity,
  labeledValue,
  looksLikeSolePropPerson,
  namesMatchNormalized,
  normalizeCompanyName,
  normalizeState,
  parseBoardPersonName,
  personKey,
  pickBestNameMatch,
  splitPersonName,
} from './names.js';
import { decodeCacheBody, encodeCacheBody } from './cache.js';
import { parseMaSosText } from './maSos.js';
import { parsePaDosText } from './paDos.js';
import { nycDobSearchUrl } from './nycDob.js';
import { nyDosSearchUrl } from './nyDos.js';
import { txTdlrSearchUrl } from './txTdlr.js';
import { looksBlocked, setBoardFetch } from './http.js';
import { resolveMaCsl } from './maCsl.js';
import { parseNycDobJson } from './nycDob.js';
import { parseWaLniJson, parseWaLniText } from './waLni.js';
import { parseTxTdlrJson, parseTxTdlrText } from './txTdlr.js';
import { hasRealMaResult, parseMaCslText } from './maCsl.js';
import { parseMnDliCsv, parseMnDliText } from './mnDli.js';
import { parsePaHicText } from './paHic.js';
import { sampleOwnerRows } from './types.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

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

describe('parseBoardPersonName', () => {
  it('splits LAST, FIRST M from registry dumps', () => {
    const split = parseBoardPersonName('SMITH, JOHN A');
    assert.equal(split.first_name, 'JOHN A');
    assert.equal(split.last_name, 'SMITH');
    assert.equal(split.review_flag, false);
  });
});

describe('looksBlocked', () => {
  it('does not treat a CSLB page with a recaptcha widget as blocked', () => {
    assert.equal(
      looksBlocked(200, 'Business Information\nACME INC\nLicense Status\nCurrent and active\ng-recaptcha captcha widget'),
      false,
    );
  });

  it('treats a Turnstile search shell as blocked', () => {
    assert.equal(looksBlocked(200, '<div class="cf-turnstile"></div>Please wait'), true);
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

  it('turns </td> </tr> </div> </p> and <br> into newlines', () => {
    const text = htmlToText(
      '<tr><td>License Status</td><td>This license is current and active.</td></tr><div>Entity</div><p>Corporation</p>Business Phone<br>(916) 555-0100',
    );
    assert.match(text, /License Status\n+This license is current and active/);
    assert.match(text, /Entity\n+Corporation/);
    assert.match(text, /Business Phone\n+\(916\) 555-0100/);
  });
});

describe('labeledValue', () => {
  it('captures a value on the same line or the next line', () => {
    assert.equal(labeledValue('License Status This license is current and active.', 'License Status'), 'This license is current and active.');
    assert.equal(labeledValue('License Status\n This license is current and active.', 'License Status'), 'This license is current and active.');
  });
});

describe('normalized name match', () => {
  it('matches after stripping punctuation, legal suffixes, and DBA tails', () => {
    assert.equal(namesMatchNormalized('Smith HVAC, L.L.C. DBA Cool Air', 'SMITH HVAC'), true);
    assert.equal(pickBestNameMatch('Acme Builders LLC', [{ n: 'ACME BUILDERS' }, { n: 'OTHER CO' }], (r) => r.n)?.n, 'ACME BUILDERS');
    assert.equal(pickBestNameMatch('Acme', [{ n: 'ZETA ROOFING' }], (r) => r.n), null);
  });
});

describe('cache query/url envelope', () => {
  it('round-trips query string and fetched URL without leaking into parse text', () => {
    const wrapped = encodeCacheBody('License Status This license is current and active.', {
      query_string: 'searchName=ACME',
      fetched_url: 'https://example.test/search?q=ACME',
    });
    const decoded = decodeCacheBody(wrapped);
    assert.equal(decoded.query_string, 'searchName=ACME');
    assert.equal(decoded.fetched_url, 'https://example.test/search?q=ACME');
    assert.equal(decoded.text, 'License Status This license is current and active.');
  });
});

describe('name-search URLs', () => {
  it('logs the exact query string for NYC / NY DOS / TDLR', () => {
    assert.equal(nycDobSearchUrl({ license: '12345' }).query_string, 'license_number=12345');
    assert.match(nycDobSearchUrl({ businessName: "O'BRIEN HVAC LLC" }).query_string, /business_name/i);
    assert.equal(nyDosSearchUrl('Smith HVAC, LLC DBA Cool').query_string, 'searchName=SMITH HVAC');
    assert.equal(txTdlrSearchUrl({ license: 'TECL-009' }).query_string, 'license_number=009');
    assert.match(txTdlrSearchUrl({ businessName: 'Smith HVAC LLC' }).query_string, /SMITH HVAC LLC/i);
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
    assert.equal(parseMaCslText(fixture('ma-accela-result.txt'), 'u').people[0]?.role, 'owner');
    assert.equal(parseMaCslText(fixture('ma-accela-result.txt'), 'u').people[0]?.last_name, 'KIM');
    assert.equal(hasRealMaResult(fixture('ma-accela-form.txt')), false);
    assert.equal(hasRealMaResult(fixture('ma-accela-result.txt')), true);
    assert.equal(
      parseMnDliText('Qualifying Person: CHRIS ONG\nActive\n', 'u').people[0]?.role,
      'qualifying_individual',
    );
    assert.equal(parsePaHicText('Owner: RILEY COHEN\n', 'u').people[0]?.source, 'pa_hic');
    assert.equal(parsePaHicText('<div class="cf-turnstile"></div>', 'u').coverage_reason, 'blocked');
    assert.equal(parsePaDosText('Entity Name: ACME BUILDERS LLC\nPresident: RILEY COHEN\n', 'u', 'Acme Builders LLC').people[0]?.source, 'pa_dos');
    assert.equal(parseMaSosText('Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n', 'u', 'Acme Builders LLC').people[0]?.source, 'ma_sos');
  });

  it('ignores Accela chrome that only says Licensee', () => {
    const result = parseMaCslText('Search\nLicensee\nLicense Type\nPlease enter a license number\n', 'u');
    assert.equal(result.people.length, 0);
    assert.equal(result.coverage_reason, 'not_found');
  });

  it('parses TDLR SODA owner_name for electrical trades', () => {
    const result = parseTxTdlrJson(
      [
        {
          license_type: 'Electrical Contractor',
          license_number: '12345',
          owner_name: 'LEE, SAM',
          business_telephone: '2145550100',
          license_expiration_date_mmddccyy: '01012099',
        },
      ],
      'u',
    );
    assert.equal(result.people[0]?.last_name, 'LEE');
    assert.equal(result.people[0]?.first_name, 'SAM');
    assert.equal(result.coverage_reason, null);
  });

  it('skips TDLR rows that are not electrical or HVAC', () => {
    const result = parseTxTdlrJson([{ license_type: 'Cosmetology Operator', owner_name: 'LEE, SAM' }], 'u');
    assert.equal(result.people.length, 0);
    assert.equal(result.coverage_reason, 'not_found');
  });

  it('parses WA L&I principal JSON as LAST, FIRST', () => {
    const result = parseWaLniJson(
      [{ principalname: 'BAKER, ALICE M', contractorlicensenumber: 'STATUEC903MA' }],
      'u',
      { phone: '2065550100', status: 'ACTIVE' },
    );
    assert.equal(result.people[0]?.first_name, 'ALICE M');
    assert.equal(result.people[0]?.last_name, 'BAKER');
    assert.equal(result.people[0]?.business_phone, '2065550100');
  });

  it('matches a NYC business_name after suffix/DBA normalize', () => {
    const result = parseNycDobJson(
      [
        {
          first_name: 'GEORGE',
          last_name: 'PAPADIONISOPOULOS',
          license_status: 'ACTIVE',
          business_name: 'ACME BUILDERS LLC DBA ACE',
          business_phone_number: '3476547642',
        },
      ],
      'u',
      'Acme Builders, Inc.',
    );
    assert.equal(result.people.length, 1);
    assert.equal(result.coverage_reason, null);
  });

  it('joins a MN business to a unique qualifying person at the same address', () => {
    const csv = [
      'Bus_Pers,License_Type,License_Subtype,Name,DBA_Name,Addr1,Addr2,City,St,Zip,Phone_No,Email_Address,Lic_Number,Status,Orig_Date,Exp_Date,Enforcement_Action,Renewal_in_Progress',
      'Business,Residential Contractors,Residential Building Contractor,ACME BUILDERS LLC,,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,BC000111,Issued,,,,',
      'Personal,Residential Contractors,Qualifying Builder,"JONES, PAT",,100 MAIN ST,,ST PAUL,MN,55101,6515550100,,QB000111,Issued,,,,',
    ].join('\n');
    const result = parseMnDliCsv(csv, 'Acme Builders LLC DBA Ace Construction', 'u');
    assert.equal(result.people[0]?.role, 'qualifying_individual');
    assert.equal(result.people[0]?.last_name, 'JONES');
    assert.equal(result.people[0]?.confidence, 'medium');
  });
});

describe('MA license miss routes to SOS', () => {
  it('does not stop on Accela/OPSI block when SOS has officers', async () => {
    setBoardFetch(async (input) => {
      const url = String(input);
      if (url.includes('elicensing21.mass.gov')) {
        return new Response('Access Denied', { status: 404 });
      }
      if (url.includes('madpl.mylicense.com')) {
        return new Response('Access Denied', { status: 403 });
      }
      if (url.includes('corp.sec.state.ma.us')) {
        return new Response('Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n', { status: 200 });
      }
      return new Response('no', { status: 404 });
    });
    try {
      const result = await resolveMaCsl({
        list_id: 'x',
        lead_id: 1,
        company_name: 'Acme Builders LLC',
        state: 'MA',
      });
      assert.equal(result.source, 'ma_sos');
      assert.equal(result.people.length, 1);
      assert.equal(result.people[0]?.last_name, 'KIM');
      assert.equal(result.coverage_reason, null);
    } finally {
      setBoardFetch(null);
    }
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
