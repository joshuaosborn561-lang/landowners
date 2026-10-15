import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectMaSosChallenge,
  estimateMaBrowserUsd,
  formatMaBrowserAttemptLog,
  MA_BROWSER_USD_CAP_PER_BATCH,
  MA_BROWSER_USD_CAP_PER_LOOKUP,
  planMaBrowserBatch,
  resultsFromMaBrowserItems,
  setMaSosBrowserRunnerForTests,
  shouldUseMaBrowser,
  fetchMaSosViaPlaywright,
  buildMaSosPlaywrightInput,
} from './maSosBrowser.js';
import {
  applyOpsiFacilityFields,
  applyOpsiPersonFields,
  MA_CSL_CACHE_VERSION,
  maCslCacheKey,
  maCslSearchName,
  OPSI_FACILITY,
} from './maCsl.js';
import { isDefinitiveSosNotFound, parseMaSosText } from './maSos.js';

describe('MA browser cost cap', () => {
  it('prices a batched lookup under the per-lookup and per-batch caps', () => {
    const one = estimateMaBrowserUsd(1);
    assert.equal(one.run, true);
    assert.equal(one.total_usd <= MA_BROWSER_USD_CAP_PER_LOOKUP, true);
    const batch = estimateMaBrowserUsd(25);
    assert.equal(batch.run, true);
    assert.equal(batch.total_usd <= MA_BROWSER_USD_CAP_PER_BATCH, true);
    assert.equal(planMaBrowserBatch(25).lookups, 25);
    assert.equal(planMaBrowserBatch(0).run, false);
  });
});

describe('MA browser challenge + logs', () => {
  it('stops on captcha/Turnstile and logs host only', () => {
    assert.equal(detectMaSosChallenge('<div class="cf-turnstile"></div>').captcha, true);
    assert.equal(detectMaSosChallenge('Request unsuccessful. Incapsula incident ID').incapsula, true);
    assert.equal(detectMaSosChallenge('__VIEWSTATE Entity Name ACME').incapsula, false);
    const line = formatMaBrowserAttemptLog({
      url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx?q=secret',
      status: 200,
      body: '_Incapsula_Resource',
      captcha: false,
    });
    assert.equal(
      line,
      '[ma-browser] host=corp.sec.state.ma.us group=RESIDENTIAL status=200 incapsula=yes captcha=no',
    );
    assert.equal(line.includes('secret'), false);
    const plan = formatMaBrowserAttemptLog({ lookups: 10, estimate_usd: 0.45, cap_usd: 1.2 });
    assert.match(plan, /\[ma-browser\] actor=apify\/playwright-scraper lookups=10/);
    assert.equal(plan.includes('APIFY_TOKEN'), false);
  });
});

describe('MA browser result mapping', () => {
  it('maps a CorpSummary officer page and leaves captcha rows blocked', () => {
    const lookups = [
      { cacheKey: 'a', companyName: 'Acme Builders LLC' },
      { cacheKey: 'b', companyName: 'Other LLC' },
    ];
    const results = resultsFromMaBrowserItems(lookups, [
      {
        kind: 'detail',
        cacheKey: 'a',
        html: 'Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n',
        url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSummary.aspx?id=1',
        httpStatus: 200,
      },
      {
        kind: 'search',
        cacheKey: 'b',
        captcha: true,
        blocked: true,
        html: '',
        url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx',
        httpStatus: 200,
      },
    ]);
    assert.equal(results[0]?.people[0]?.last_name, 'KIM');
    assert.equal(results[0]?.blocked, undefined);
    assert.equal(results[1]?.blocked, true);
    assert.equal(results[1]?.captcha, true);
    assert.equal(shouldUseMaBrowser({ people: [], coverage_reason: 'blocked', source: 'ma_sos', blocked: true }), true);
    assert.equal(
      shouldUseMaBrowser({ people: [], coverage_reason: 'blocked', source: 'ma_sos', blocked: true, captcha: true }),
      false,
    );
    assert.equal(
      shouldUseMaBrowser({ people: [], coverage_reason: 'not_found', source: 'ma_sos', http_status: 0 }),
      true,
    );
    assert.equal(
      shouldUseMaBrowser({ people: [], coverage_reason: 'not_found', source: 'ma_sos', http_status: 200 }),
      false,
    );
  });

  it('treats proxy connect/timeout bodies as blocked, not a parsed no-results page', () => {
    const timeout = parseMaSosText('', 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx');
    assert.equal(timeout.coverage_reason, 'blocked');
    assert.equal(timeout.blocked, true);
    assert.equal(shouldUseMaBrowser(timeout), true);
    const noResults = parseMaSosText(
      'No records were found matching your search.',
      'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx',
    );
    assert.equal(noResults.coverage_reason, 'not_found');
    assert.equal(noResults.blocked, undefined);
    assert.equal(isDefinitiveSosNotFound('No records were found matching your search.'), true);
    assert.equal(shouldUseMaBrowser(noResults), false);
  });

  it('runs one batched actor call and never includes names in the attempt log', async () => {
    let calls = 0;
    setMaSosBrowserRunnerForTests(async ({ lookups }) => {
      calls += 1;
      return lookups.map((lookup) => ({
        kind: 'detail',
        cacheKey: lookup.cacheKey,
        html: `Entity Name: ${lookup.companyName}\nPresident: PAT KIM\n`,
        url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSummary.aspx',
        httpStatus: 200,
      }));
    });
    try {
      const results = await fetchMaSosViaPlaywright([
        { cacheKey: 'n1', companyName: 'Acme Builders LLC' },
        { cacheKey: 'n2', companyName: 'Beta Builders LLC' },
      ]);
      assert.equal(calls, 1);
      assert.equal(results.length, 2);
      assert.equal(results[0]?.people.length, 1);
      const input = buildMaSosPlaywrightInput([{ cacheKey: 'n1', companyName: 'Acme Builders LLC' }]);
      assert.equal((input.proxyConfiguration as { apifyProxyGroups: string[] }).apifyProxyGroups[0], 'RESIDENTIAL');
      assert.equal((input.proxyConfiguration as { apifyProxyCountry: string }).apifyProxyCountry, 'US');
      assert.equal(input.maxConcurrency, 1);
    } finally {
      setMaSosBrowserRunnerForTests(null);
    }
  });
});

describe('OPSI current form fields', () => {
  it('posts Building Licenses + All types + entity name without LLC/Inc', () => {
    const person = applyOpsiPersonFields(
      { t_web_lookup__profession_name: '', t_web_lookup__license_type_name: 'Construction Supervisor' },
      { businessName: 'Acme Builders LLC' },
    );
    assert.equal(person.t_web_lookup__doing_business_as, 'ACME BUILDERS');
    assert.equal(person.t_web_lookup__licensee_name, undefined);
    assert.equal(person.t_web_lookup__profession_name, 'Building Licenses');
    assert.equal(person.t_web_lookup__license_type_name, '');
    assert.equal(person.sch_button, 'Search');
    const facility = applyOpsiFacilityFields({}, { businessName: 'Acme Builders Inc' });
    assert.equal(facility.t_web_lookup__full_name, 'ACME BUILDERS');
    assert.equal(facility.t_web_lookup__owner_name, 'ACME BUILDERS');
    assert.equal(facility.t_web_lookup__facility_name, undefined);
    assert.equal(facility.t_web_lookup__license_type_name, '');
    assert.equal(OPSI_FACILITY.includes('Facility=Y'), true);
    assert.equal(maCslSearchName('Acme Builders LLC'), 'ACME BUILDERS');
    assert.equal(MA_CSL_CACHE_VERSION, 'v2');
    assert.match(maCslCacheKey({ businessName: 'Acme Builders LLC' }), /MA-CSL-V2/);
    assert.equal(maCslCacheKey({ businessName: 'Acme Builders LLC' }).includes('|MA'), true);
    assert.equal(maCslCacheKey({ businessName: 'Acme Builders LLC' }).endsWith('|MA'), false);
  });
});
