import { DESKTOP_UA } from '../http.js';
import type { LookupContext } from './context.js';
import { ctxSpend } from './context.js';
import { APIFY_USD_PER_BLOCKED_LOOKUP, usdFromApifyRun } from './spend.js';

export const APIFY_PLAYWRIGHT_ACTOR = 'apify/playwright-scraper';
export const APIFY_PLAYWRIGHT_ACTOR_ID = 'apify~playwright-scraper';

const ALLOWED_ACTORS = new Set([APIFY_PLAYWRIGHT_ACTOR, APIFY_PLAYWRIGHT_ACTOR_ID, 'apify/web-scraper', 'apify~web-scraper']);

export class PaidDatasetForbiddenError extends Error {
  constructor(actor: string) {
    super(`Paid SOS datasets are forbidden; only ${APIFY_PLAYWRIGHT_ACTOR} HTML fallback is allowed (got ${actor})`);
    this.name = 'PaidDatasetForbiddenError';
  }
}

export function assertAllowedApifyActor(actor: string): void {
  if (!ALLOWED_ACTORS.has(actor)) throw new PaidDatasetForbiddenError(actor);
}

const PAGE_FUNCTION = `async function pageFunction(context) {
  const html = await context.page.content();
  const text = await context.page.evaluate(() => document.body ? document.body.innerText : '');
  return { url: context.request.url, html, text };
}`;

export interface ApifyHtmlResult {
  html: string;
  text: string;
  usd: number;
  cu: number;
  runId?: string;
}

async function apifyJson(url: string, init: RequestInit, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, init);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    return { error: body.slice(0, 200), status: res.status };
  }
}

/**
 * Official-page HTML via apify/playwright-scraper + residential proxy.
 * Never paid Store officer datasets.
 */
export async function apifyFetchHtml(
  url: string,
  ctx?: LookupContext,
  opts?: { pageFunction?: string },
): Promise<ApifyHtmlResult> {
  if (ctx?.apifyFetchHtml) {
    const got = await ctx.apifyFetchHtml(url);
    ctxSpend(ctx).add(got.usd);
    return { html: got.html, text: '', usd: got.usd, cu: 0 };
  }
  const token = ctx?.apifyToken?.trim();
  if (!token || ctx?.apifyEnabled === false) {
    return { html: '', text: '', usd: 0, cu: 0 };
  }
  assertAllowedApifyActor(APIFY_PLAYWRIGHT_ACTOR);
  const fetchFn = (ctx?.fetch as typeof fetch) ?? fetch;
  const start = `https://api.apify.com/v2/acts/${APIFY_PLAYWRIGHT_ACTOR_ID}/runs?token=${encodeURIComponent(token)}&waitForFinish=120`;
  const input = {
    startUrls: [{ url }],
    keepUrlFragments: false,
    linkSelector: '',
    globs: [],
    pageFunction: opts?.pageFunction || PAGE_FUNCTION,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    proxyRotation: 'RECOMMENDED',
    maxConcurrency: 2,
    maxRequestRetries: 2,
    downloadMedia: false,
    downloadCss: false,
    closeCookieModals: true,
    waitUntil: 'networkidle',
    initialCookies: [],
  };
  const runWrap = (await apifyJson(
    start,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': DESKTOP_UA },
      body: JSON.stringify(input),
    },
    fetchFn,
  )) as { data?: { defaultDatasetId?: string; usageTotalUsd?: number; stats?: { computeUnits?: number }; id?: string } };
  const run = runWrap?.data;
  const cost = usdFromApifyRun(run);
  const spend = ctxSpend(ctx);
  const usd = cost.usd || APIFY_USD_PER_BLOCKED_LOOKUP;
  spend.add(usd, { cu: cost.cu });
  const datasetId = run?.defaultDatasetId;
  if (!datasetId) return { html: '', text: '', usd, cu: cost.cu, runId: run?.id };
  const itemsWrap = (await apifyJson(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`,
    { headers: { Accept: 'application/json', 'User-Agent': DESKTOP_UA } },
    fetchFn,
  )) as Array<{ html?: string; text?: string }>;
  const row = Array.isArray(itemsWrap) ? itemsWrap[0] : null;
  return {
    html: String(row?.html || ''),
    text: String(row?.text || ''),
    usd,
    cu: cost.cu,
    runId: run?.id,
  };
}
