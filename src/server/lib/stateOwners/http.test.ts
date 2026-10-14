import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
    delete process.env.APIFY_PROXY_PASSWORD;
    assert.equal(residentialProxyUrl('ma1'), null);
    process.env.APIFY_PROXY_PASSWORD = 'unit-test-secret';
    const url = residentialProxyUrl('ma 12');
    assert.match(String(url), /^http:\/\/groups-RESIDENTIAL,country-US,session-ma12:/);
    assert.match(String(url), /@proxy\.apify\.com:8000$/);
    if (prev === undefined) delete process.env.APIFY_PROXY_PASSWORD;
    else process.env.APIFY_PROXY_PASSWORD = prev;
  });
});
