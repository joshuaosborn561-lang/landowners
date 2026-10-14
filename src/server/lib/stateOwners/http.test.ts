import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  apifyProxyPasswordEnvName,
  apifyTokenConfigured,
  formatMaProxyAttemptLog,
  hasCaptchaOrTurnstile,
  isPlainHttpBlock,
  looksBlocked,
  residentialProxyUrl,
  shouldRetryMaViaProxy,
} from './http.js';

describe('MA residential proxy retry gates', () => {
  it('treats Imperva 200 as a plain HTTP block, not a captcha', () => {
    const body = 'Request unsuccessful. Incapsula incident ID. /_Incapsula_Resource';
    assert.equal(looksBlocked(200, body), true);
    assert.equal(isPlainHttpBlock(200, body), true);
    assert.equal(hasCaptchaOrTurnstile(body), false);
    assert.equal(
      shouldRetryMaViaProxy({ named: false, blocked: true, http_status: 200, body }),
      true,
    );
    assert.equal(looksBlocked(200, 'Request unsuccessful. Incident ID 0-123'), true);
    assert.equal(
      formatMaProxyAttemptLog({
        url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx',
        status: 0,
        error: 'TypeError',
      }),
      '[ma-proxy] host=corp.sec.state.ma.us group=RESIDENTIAL status=0 incapsula=no error=TypeError',
    );
  });

  it('does not retry Turnstile or captcha shells', () => {
    const body = '<div class="cf-turnstile"></div> please complete the captcha';
    assert.equal(isPlainHttpBlock(200, body), false);
    assert.equal(hasCaptchaOrTurnstile(body), true);
    assert.equal(
      shouldRetryMaViaProxy({ named: false, captcha: true, blocked: true, http_status: 200, body }),
      false,
    );
  });

  it('retries SOS 403 / not_found and skips a named hit', () => {
    assert.equal(isPlainHttpBlock(403, 'Forbidden'), true);
    assert.equal(
      shouldRetryMaViaProxy({ named: false, coverage_reason: 'not_found', http_status: 200 }),
      true,
    );
    assert.equal(shouldRetryMaViaProxy({ named: true, blocked: true, http_status: 403 }), false);
  });

  it('builds a US residential session URL only when the password is set', () => {
    const prev = process.env.APIFY_PROXY_PASSWORD;
    const prevLower = process.env.apify_proxy_password;
    delete process.env.APIFY_PROXY_PASSWORD;
    delete process.env.apify_proxy_password;
    assert.equal(residentialProxyUrl('ma1'), null);
    process.env.APIFY_PROXY_PASSWORD = 'unit-test-secret';
    const url = residentialProxyUrl('ma 12');
    assert.match(String(url), /^http:\/\/groups-RESIDENTIAL,country-US,session-ma12:/);
    assert.match(String(url), /@proxy\.apify\.com:8000$/);
    delete process.env.APIFY_PROXY_PASSWORD;
    process.env.apify_proxy_password = 'lower-secret';
    assert.equal(apifyProxyPasswordEnvName(), 'apify_proxy_password');
    assert.match(String(residentialProxyUrl('ma1')), /session-ma1:/);
    const line = formatMaProxyAttemptLog({
      url: 'https://corp.sec.state.ma.us/corpweb/CorpSearch/CorpSearch.aspx?q=secret',
      status: 403,
      body: '_Incapsula_Resource',
    });
    assert.equal(
      line,
      '[ma-proxy] host=corp.sec.state.ma.us group=RESIDENTIAL status=403 incapsula=yes',
    );
    assert.equal(line.includes('secret'), false);
    assert.equal(line.includes('lower-secret'), false);
    if (prev === undefined) delete process.env.APIFY_PROXY_PASSWORD;
    else process.env.APIFY_PROXY_PASSWORD = prev;
    if (prevLower === undefined) delete process.env.apify_proxy_password;
    else process.env.apify_proxy_password = prevLower;
  });

  it('reports Apify token presence without fragments', () => {
    const prev = process.env.APIFY_TOKEN;
    const prevApi = process.env.APIFY_API_TOKEN;
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_API_TOKEN;
    assert.equal(apifyTokenConfigured(), false);
    process.env.APIFY_API_TOKEN = 'unit-token-secret';
    assert.equal(apifyTokenConfigured(), true);
    if (prev === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prev;
    if (prevApi === undefined) delete process.env.APIFY_API_TOKEN;
    else process.env.APIFY_API_TOKEN = prevApi;
  });
});
