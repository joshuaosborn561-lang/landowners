import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectAspNetFields, cookiesFromList, hasAspNetState } from './aspNet.js';

describe('collectAspNetFields', () => {
  it('carries VIEWSTATE and EVENTVALIDATION and skips submit buttons', () => {
    const html = `
      <input type="hidden" name="__VIEWSTATE" value="abc+def=" />
      <input type="hidden" name="__EVENTVALIDATION" value="ev1" />
      <input type="text" name="t_web_lookup__license_no" value="" />
      <input type="submit" name="sch_button" value="Search" />
      <select name="board"><option value="">--</option><option value="OPSI" selected>OPSI</option></select>
    `;
    const fields = collectAspNetFields(html);
    assert.equal(fields.__VIEWSTATE, 'abc+def=');
    assert.equal(fields.__EVENTVALIDATION, 'ev1');
    assert.equal(fields.t_web_lookup__license_no, '');
    assert.equal(fields.sch_button, undefined);
    assert.equal(fields.board, 'OPSI');
    assert.equal(hasAspNetState(fields), true);
  });
});

describe('cookiesFromList', () => {
  it('merges set-cookie names without duplicating', () => {
    const first = cookiesFromList(['ACA_CS_KEY=one; Path=/', 'AWSALB=x; Path=/']);
    const next = cookiesFromList(['ACA_CS_KEY=two; Path=/'], first);
    assert.match(next, /ACA_CS_KEY=two/);
    assert.match(next, /AWSALB=x/);
    assert.equal(next.includes('ACA_CS_KEY=one'), false);
  });
});
