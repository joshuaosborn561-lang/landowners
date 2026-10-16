import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLimiter, mapPool, SUPABASE_WRITE_CONCURRENCY } from './retry.js';

describe('mapPool', () => {
  it('preserves input order and respects concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const got = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return n * 10;
    });
    assert.deepEqual(got, [10, 20, 30, 40, 50]);
    assert.equal(maxInFlight, 2);
  });
});

describe('createLimiter', () => {
  it('caps in-flight work at the supabase write concurrency', async () => {
    assert.equal(SUPABASE_WRITE_CONCURRENCY, 4);
    const limit = createLimiter(SUPABASE_WRITE_CONCURRENCY);
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight -= 1;
        }),
      ),
    );
    assert.equal(maxInFlight, 4);
    assert.ok(maxInFlight <= 4);
  });
});
