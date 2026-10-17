import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resolveColoradoAgentOnly, resolveOhioAgentOnly } from './agentStates.js';
import { isWaterfallReady } from './waterfall.js';

const coRows = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'co-soda.json'), 'utf8'),
);

const ohRows = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'oh-search.json'), 'utf8'),
).data;

describe('OH/CO agent_only', () => {
  it('returns no_source for Ohio when no JSON lookup ran', async () => {
    const result = await resolveOhioAgentOnly({
      company_name: 'Sample Masonry LLC',
      city: 'Columbus',
      state: 'OH',
    });
    assert.equal(result.coverage_reason, 'no_source');
    assert.equal(result.implemented, true);
    assert.equal(result.people.length, 0);
    assert.equal(result.via_apify, undefined);
  });

  it('marks Ohio agent_only only after a confirmed entity record', async () => {
    const result = await resolveOhioAgentOnly(
      { company_name: 'Sample Masonry LLC', city: 'Columbus', state: 'OH' },
      { live: false, ohRows },
    );
    assert.equal(result.coverage_reason, 'agent_only');
    assert.equal(result.business_name, 'SAMPLE MASONRY LLC');
    assert.equal(result.people.length, 0);
    assert.equal(result.people.some((p) => isWaterfallReady(p)), false);
  });

  it('confirms a Colorado entity via Socrata and never treats the agent as waterfall-ready', async () => {
    const result = await resolveColoradoAgentOnly(
      { company_name: 'Sample HVAC LLC', city: 'Denver', state: 'CO' },
      { live: false, coRows, includeAgents: true },
    );
    assert.equal(result.coverage_reason, 'agent_only');
    assert.equal(result.implemented, true);
    assert.equal(result.people[0]?.role, 'registered_agent');
    assert.equal(isWaterfallReady(result.people[0]!), false);
  });
});
