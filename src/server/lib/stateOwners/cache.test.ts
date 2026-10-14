import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMaCacheBypassLog, isBlockedBoardCache, shouldReuseBoardCache } from './cache.js';

describe('board cache reuse', () => {
  it('does not reuse Incapsula / 4xx / access-denied shells', () => {
    assert.equal(
      shouldReuseBoardCache({
        http_status: 200,
        body: 'Request unsuccessful. Incapsula incident ID /_Incapsula_Resource',
      }),
      false,
    );
    assert.equal(isBlockedBoardCache({ http_status: 403, body: 'Forbidden' }), true);
    assert.equal(isBlockedBoardCache({ http_status: 404, body: 'Access Denied' }), true);
    assert.equal(
      shouldReuseBoardCache({
        http_status: 200,
        body: 'Request unsuccessful\nIncident ID 0-123',
      }),
      false,
    );
  });

  it('reuses a real officer page and logs a counts-only bypass line', () => {
    assert.equal(
      shouldReuseBoardCache({
        http_status: 200,
        body: 'Entity Name: ACME BUILDERS LLC\nPresident: PAT KIM\n',
      }),
      true,
    );
    const line = formatMaCacheBypassLog({
      board: 'ma_sos',
      status: 200,
      body: '_Incapsula_Resource',
    });
    assert.equal(line, '[ma-cache] board=ma_sos bypass=blocked status=200 incapsula=yes');
    assert.equal(line.includes('KIM'), false);
    assert.equal(line.includes('password'), false);
  });
});
