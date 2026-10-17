/** Starter-plan mid-point from PLAN.md (compute + residential, media off). */
export const APIFY_USD_PER_BLOCKED_LOOKUP = 0.015;
export const APIFY_USD_PER_COMPUTE_UNIT = 0.2;
/** CA search + SI may each need Playwright when Incapsula blocks datacenter IPs. */
export const CA_APIFY_LOOKUPS_PER_ROW = 1.5;

export class ApifySpendTracker {
  usd = 0;
  runs = 0;
  lookups = 0;
  computeUnits = 0;

  add(usd: number, opts?: { cu?: number; lookups?: number }): void {
    const extra = Number(usd) || 0;
    if (extra <= 0 && !opts?.cu) return;
    this.usd = Number((this.usd + extra).toFixed(4));
    this.runs += 1;
    this.lookups += opts?.lookups ?? 1;
    if (opts?.cu) this.computeUnits += opts.cu;
  }

  snapshot(): { apify_usd_spent: number; apify_runs: number; apify_lookups: number; apify_compute_units: number } {
    return {
      apify_usd_spent: Number(this.usd.toFixed(2)),
      apify_runs: this.runs,
      apify_lookups: this.lookups,
      apify_compute_units: Number(this.computeUnits.toFixed(4)),
    };
  }
}

export function usdFromApifyRun(run: { usageTotalUsd?: number; stats?: { computeUnits?: number } } | null | undefined): {
  usd: number;
  cu: number;
} {
  const cu = Number(run?.stats?.computeUnits || 0);
  if (typeof run?.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd)) {
    return { usd: run.usageTotalUsd, cu };
  }
  if (cu > 0) return { usd: cu * APIFY_USD_PER_COMPUTE_UNIT, cu };
  return { usd: APIFY_USD_PER_BLOCKED_LOOKUP, cu: 0 };
}
