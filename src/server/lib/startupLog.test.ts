import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStartupKeyFlags } from './startupLog.js';

describe('formatStartupKeyFlags', () => {
  it('prints presence booleans only — no key fragments', () => {
    const line = formatStartupKeyFlags({
      permitstack: true,
      veriphone: false,
      cpa: true,
      fl: false,
      apify_residential_proxy: true,
    });
    assert.equal(
      line,
      'Keys: permitstack=true veriphone=false cpa=true fl=false apify_residential_proxy=true',
    );
    assert.equal(/[A-Za-z0-9]{4}…[A-Za-z0-9]{4}/.test(line), false);
    assert.equal(line.includes('pk_'), false);
    assert.equal(line.includes('unset'), false);
  });
});
