import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoardJobStopError, normalizeState, sampleOwnerRows, sourceForState } from '../lib/stateOwners/index.js';
import type { BoardSource, OwnerLead, OwnerPerson, ResolverResult } from '../lib/stateOwners/index.js';
import { resolvePaHic } from '../lib/stateOwners/paHic.js';
import {
  boardLaneCount,
  claimSeenKey,
  clampOwnerRows,
  groupLeadsByBoardSource,
  personSeenKey,
  runOwnerMatchLoop,
} from './matchStateOwners.js';
import { permitStackPlaceId } from './shovelsContractors.js';

describe('clampOwnerRows', () => {
  it('allows dry-run max_rows up to 100 and defaults to 25', () => {
    assert.equal(clampOwnerRows(undefined, true), 25);
    assert.equal(clampOwnerRows(100, true), 100);
    assert.equal(clampOwnerRows(250, true), 100);
    assert.equal(clampOwnerRows(1, true), 1);
    assert.equal(clampOwnerRows(80, false), 80);
  });
});

describe('permitStackPlaceId', () => {
  it('sets place_id = shovels: + ps_id', () => {
    assert.deepEqual(permitStackPlaceId('abc-123'), { place_id: 'shovels:abc-123', ps_id: 'abc-123' });
    assert.deepEqual(permitStackPlaceId('shovels:abc-123'), { place_id: 'shovels:abc-123', ps_id: 'abc-123' });
    assert.deepEqual(permitStackPlaceId(''), { place_id: null, ps_id: null });
  });
});

describe('resolvePaHic', () => {
  it('stays disabled and never fetches the Turnstile HIC site', async () => {
    const result = await resolvePaHic({ list_id: 'x', lead_id: 1, company_name: 'Co 1' });
    assert.equal(result.coverage_reason, 'blocked');
    assert.equal(result.source, 'pa_hic');
    assert.equal(result.blocked, true);
    assert.equal(result.people.length, 0);
  });
});

function lead(partial: Partial<OwnerLead> & { lead_id: number; state: string }): OwnerLead {
  return {
    list_id: 'list-1',
    company_name: `Co ${partial.lead_id}`,
    ...partial,
  };
}

function person(leadId: number, source: BoardSource): OwnerPerson {
  return {
    first_name: 'Pat',
    last_name: `N${leadId}`,
    full_name_raw: `Pat N${leadId}`,
    role: 'owner',
    source,
    source_url: 'https://example.test/board',
    confidence: 'high',
  };
}

function namedResult(row: OwnerLead): ResolverResult {
  const source = sourceForState(row.state, row.city);
  return {
    people: [person(row.lead_id, source)],
    coverage_reason: null,
    source,
  };
}

/** Pre-concurrency loop: original lead order, global stop. */
async function serialOwnerMatch(
  leads: OwnerLead[],
  resolve: (row: OwnerLead) => Promise<ResolverResult>,
): Promise<{
  processed: number;
  named: number;
  written: number;
  remaining: number;
  hit_rate_by_state: Record<string, { attempted: number; named: number; hit_rate: number }>;
  status_histogram: Record<string, number>;
  sample: ReturnType<typeof sampleOwnerRows>;
  stopped: Array<{ source: BoardSource; status: number; consecutive: number }>;
}> {
  const results: ResolverResult[] = [];
  const seen = new Set<string>();
  let named = 0;
  const byState: Record<string, { attempted: number; named: number; hit_rate: number; coverage: Record<string, number> }> =
    {};
  const statusHistogram: Record<string, number> = {};
  let stopped: Array<{ source: BoardSource; status: number; consecutive: number }> = [];

  for (const row of leads) {
    try {
      const result = await resolve(row);
      results.push(result);
      const st = normalizeState(row.state);
      const gotName = result.people.length > 0;
      if (gotName) named += 1;
      const stats = byState[st] ?? {
        attempted: 0,
        named: 0,
        hit_rate: 0,
        coverage: {},
      };
      stats.attempted += 1;
      if (gotName) stats.named += 1;
      if (result.coverage_reason) stats.coverage[result.coverage_reason] = (stats.coverage[result.coverage_reason] || 0) + 1;
      stats.hit_rate = stats.attempted ? Number((stats.named / stats.attempted).toFixed(3)) : 0;
      byState[st] = stats;
      const phrase = result.license_status
        ? result.license_status.replace(/\s+/g, ' ').trim()
        : `(${result.coverage_reason || 'named_no_status'})`;
      statusHistogram[phrase] = (statusHistogram[phrase] || 0) + 1;
      for (const p of result.people) {
        if (!p.full_name_raw) continue;
        claimSeenKey(seen, personSeenKey(row, p.full_name_raw));
      }
    } catch (err) {
      if (err instanceof BoardJobStopError) {
        stopped = [{ source: err.source, status: err.status, consecutive: err.consecutive }];
        break;
      }
      const st = normalizeState(row.state);
      const stats = byState[st] ?? { attempted: 0, named: 0, hit_rate: 0, coverage: {} };
      stats.attempted += 1;
      stats.coverage.blocked = (stats.coverage.blocked || 0) + 1;
      stats.hit_rate = stats.attempted ? Number((stats.named / stats.attempted).toFixed(3)) : 0;
      byState[st] = stats;
      results.push({ people: [], coverage_reason: 'blocked', source: 'cslb' });
    }
  }

  return {
    processed: results.length,
    named,
    written: 0,
    remaining: Math.max(0, leads.length - results.length),
    hit_rate_by_state: byState,
    status_histogram: statusHistogram,
    sample: sampleOwnerRows(results, 10),
    stopped,
  };
}

describe('boardLaneCount', () => {
  it('defaults to 6, caps at 10, and rejects non-positive values', () => {
    assert.equal(boardLaneCount(undefined), 6);
    assert.equal(boardLaneCount(''), 6);
    assert.equal(boardLaneCount('0'), 6);
    assert.equal(boardLaneCount('nope'), 6);
    assert.equal(boardLaneCount('1'), 1);
    assert.equal(boardLaneCount('6'), 6);
    assert.equal(boardLaneCount('15'), 10);
  });
});

describe('groupLeadsByBoardSource', () => {
  it('keeps first-seen board order and original lead order within a board', () => {
    const leads = [
      lead({ lead_id: 1, state: 'CA' }),
      lead({ lead_id: 2, state: 'TX' }),
      lead({ lead_id: 3, state: 'CA' }),
      lead({ lead_id: 4, state: 'NY', city: 'Albany' }),
      lead({ lead_id: 5, state: 'NY', city: 'Brooklyn' }),
    ];
    const groups = groupLeadsByBoardSource(leads);
    assert.deepEqual(
      groups.map((g) => [g.source, g.items.map((i) => i.lead.lead_id)]),
      [
        ['cslb', [1, 3]],
        ['tx_tdlr', [2]],
        ['ny_dos', [4]],
        ['nyc_dob', [5]],
      ],
    );
  });
});

describe('claimSeenKey', () => {
  it('claims each key once', () => {
    const seen = new Set<string>();
    const row = lead({ lead_id: 1, state: 'CA', contractor_id: 'c-1' });
    const key = personSeenKey(row, 'Pat N1');
    assert.equal(claimSeenKey(seen, key), true);
    assert.equal(claimSeenKey(seen, key), false);
    assert.equal(seen.size, 1);
  });
});

describe('runOwnerMatchLoop', () => {
  it('with 1 lane the results match today serial processing', async () => {
    const leads = [
      lead({ lead_id: 1, state: 'CA' }),
      lead({ lead_id: 2, state: 'TX' }),
      lead({ lead_id: 3, state: 'CA' }),
      lead({ lead_id: 4, state: 'WA' }),
      lead({ lead_id: 99, state: 'MA' }),
    ];
    const resolve = async (row: OwnerLead): Promise<ResolverResult> => {
      if (row.lead_id === 99) throw new Error('net');
      return namedResult(row);
    };
    const serial = await serialOwnerMatch(leads, resolve);
    const got = await runOwnerMatchLoop({
      leads,
      resolve,
      dryRun: true,
      listId: 'list-1',
      lanes: 1,
    });
    assert.equal(got.processed, serial.processed);
    assert.equal(got.named, serial.named);
    assert.equal(got.written, serial.written);
    assert.equal(got.remaining, serial.remaining);
    assert.deepEqual(got.status_histogram, serial.status_histogram);
    assert.deepEqual(got.sample, serial.sample);
    assert.deepEqual(got.stopped, []);
    assert.equal(got.hit_rate_by_state.CA?.named, 2);
    assert.equal(got.hit_rate_by_state.TX?.named, 1);
    assert.equal(got.hit_rate_by_state.WA?.named, 1);
    assert.equal(got.hit_rate_by_state.MA?.named, 0);
  });

  it('a stop on one board does not stop the others', async () => {
    const leads = [
      lead({ lead_id: 1, state: 'CA' }),
      lead({ lead_id: 2, state: 'CA' }),
      lead({ lead_id: 3, state: 'TX' }),
      lead({ lead_id: 4, state: 'WA' }),
    ];
    const resolve = async (row: OwnerLead): Promise<ResolverResult> => {
      if (row.state === 'CA') throw new BoardJobStopError('cslb', 3, 403);
      return namedResult(row);
    };
    const got = await runOwnerMatchLoop({
      leads,
      resolve,
      dryRun: true,
      listId: 'list-1',
      lanes: 6,
    });
    assert.deepEqual(
      got.stopped.map((s) => s.source).sort(),
      ['cslb'],
    );
    assert.equal(got.stopped[0]?.consecutive, 3);
    assert.equal(got.stopped[0]?.status, 403);
    assert.equal(got.processed, 2);
    assert.equal(got.named, 2);
    assert.equal(got.remaining, 2);
    assert.deepEqual(
      got.results.map((r) => r.source).sort(),
      ['tx_tdlr', 'wa_lni'],
    );
  });

  it('lists every board that stopped without dropping the others', async () => {
    const leads = [
      lead({ lead_id: 1, state: 'CA' }),
      lead({ lead_id: 2, state: 'TX' }),
      lead({ lead_id: 3, state: 'WA' }),
    ];
    const resolve = async (row: OwnerLead): Promise<ResolverResult> => {
      if (row.state === 'CA') throw new BoardJobStopError('cslb', 3, 503);
      if (row.state === 'WA') throw new BoardJobStopError('wa_lni', 3, 429);
      return namedResult(row);
    };
    const got = await runOwnerMatchLoop({
      leads,
      resolve,
      dryRun: true,
      listId: 'list-1',
      lanes: 6,
    });
    assert.deepEqual(
      got.stopped.map((s) => s.source).sort(),
      ['cslb', 'wa_lni'],
    );
    assert.equal(got.processed, 1);
    assert.equal(got.named, 1);
    assert.equal(got.results[0]?.source, 'tx_tdlr');
  });

  it('processes one lead at a time within a board group', async () => {
    const events: string[] = [];
    const leads = [lead({ lead_id: 1, state: 'CA' }), lead({ lead_id: 2, state: 'CA' })];
    const got = await runOwnerMatchLoop({
      leads,
      resolve: async (row) => {
        events.push(`start-${row.lead_id}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end-${row.lead_id}`);
        return namedResult(row);
      },
      dryRun: true,
      listId: 'list-1',
      lanes: 6,
    });
    assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
    assert.equal(got.processed, 2);
  });

  it('claims a person key once across board groups', async () => {
    const seenWrites: string[] = [];
    const leads = [
      lead({ lead_id: 1, state: 'CA', contractor_id: 'same-co' }),
      lead({ lead_id: 2, state: 'TX', contractor_id: 'same-co' }),
    ];
    const sharedPerson: OwnerPerson = {
      first_name: 'Pat',
      last_name: 'N',
      full_name_raw: 'Pat N',
      role: 'owner',
      source: 'cslb',
      source_url: 'https://example.test/board',
      confidence: 'high',
    };
    const got = await runOwnerMatchLoop({
      leads,
      resolve: async (row) => ({
        people: [{ ...sharedPerson, source: sourceForState(row.state, row.city) }],
        coverage_reason: null,
        source: sourceForState(row.state, row.city),
      }),
      dryRun: false,
      listId: 'list-1',
      lanes: 6,
      persist: async (row, result, seen) => {
        let n = 0;
        for (const p of result.people) {
          if (!p.full_name_raw) continue;
          const key = personSeenKey(row, p.full_name_raw);
          if (!claimSeenKey(seen, key)) continue;
          seenWrites.push(key);
          n += 1;
        }
        await new Promise((r) => setTimeout(r, 5));
        return n;
      },
    });
    assert.equal(seenWrites.length, 1);
    assert.equal(got.written, 1);
    assert.equal(got.named, 2);
  });

  it('keeps persist RPCs at 4 or fewer concurrent', async () => {
    const states = ['CA', 'TX', 'WA', 'MA', 'MN', 'PA'] as const;
    const leads = states.map((state, i) => lead({ lead_id: i + 1, state }));
    let inFlight = 0;
    let maxInFlight = 0;
    await runOwnerMatchLoop({
      leads,
      resolve: async (row) => namedResult(row),
      dryRun: false,
      listId: 'list-1',
      lanes: 6,
      writeConcurrency: 4,
      persist: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return 1;
      },
    });
    assert.ok(maxInFlight <= 4, `persist in-flight ${maxInFlight}`);
    assert.equal(maxInFlight, 4);
  });
});
