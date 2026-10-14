import { config } from 'dotenv';
config({ path: '/workspace/.env' });
import { matchStateOwners, type StateOwnerTool } from '../src/server/services/matchStateOwners.ts';

const JOBS: Array<{ tool: StateOwnerTool; max: number }> = [
  { tool: 'match_california_owners', max: 31 },
  { tool: 'match_washington_owners', max: 7 },
  { tool: 'match_new_york_owners', max: 15 },
  { tool: 'match_pennsylvania_owners', max: 8 },
  { tool: 'match_texas_tdlr_owners', max: 13 },
  { tool: 'match_minnesota_owners', max: 17 },
  { tool: 'match_massachusetts_owners', max: 35 },
];

const LIST = 'permit-sgpilot-20261012';

for (const job of JOBS) {
  const started = Date.now();
  try {
    const result = await matchStateOwners({
      list_id: LIST,
      dry_run: true,
      max_rows: job.max,
      tool: job.tool,
    });
    console.log(JSON.stringify({
      tool: job.tool,
      ok: result.ok,
      processed: result.processed,
      named: result.named,
      written: result.written,
      hit_rate_by_state: result.hit_rate_by_state,
      status_histogram: result.status_histogram,
      sample: result.sample,
      stopped: result.stopped,
      ms: Date.now() - started,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      tool: job.tool,
      ok: false,
      error: err instanceof Error ? err.message : 'failed',
      ms: Date.now() - started,
    }));
  }
}
