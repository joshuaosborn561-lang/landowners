import { htmlToText } from './names.js';
import {
  apifyToken,
  apifyTokenConfigured,
  hasCaptchaOrTurnstile,
  hostOf,
  incapsulaDetected,
} from './http.js';
import { nameStateCacheKey } from './cache.js';
import { MA_SOS_SEARCH, parseMaSosText } from './maSos.js';
import type { OwnerLead, ResolverResult } from './types.js';

export const MA_BROWSER_ACTOR = 'apify/playwright-scraper';
export const MA_BROWSER_MEMORY_MB = 2048;
export const MA_BROWSER_BATCH_SIZE = 25;
/** Starter-plan compute list price (1 CU = 1 GB × 1 hour). */
export const MA_BROWSER_CU_USD = 0.2;
export const MA_BROWSER_STARTUP_SECS = 25;
export const MA_BROWSER_SECS_PER_LOOKUP = 35;
export const MA_BROWSER_PROXY_USD_PER_LOOKUP = 0.04;
export const MA_BROWSER_USD_CAP_PER_LOOKUP = 0.12;
export const MA_BROWSER_USD_CAP_PER_BATCH = 2.5;

export interface MaSosLookup {
  cacheKey: string;
  companyName: string;
}

export interface MaBrowserEstimate {
  lookups: number;
  compute_usd: number;
  proxy_usd: number;
  total_usd: number;
  cap_usd: number;
  run: boolean;
}

export interface MaBrowserActorItem {
  kind?: string;
  cacheKey?: string;
  html?: string;
  url?: string;
  httpStatus?: number;
  blocked?: boolean;
  captcha?: boolean;
  incapsula?: boolean;
}

export type MaBrowserRunner = (input: {
  lookups: MaSosLookup[];
  pageFunction: string;
}) => Promise<MaBrowserActorItem[]>;

let runnerOverride: MaBrowserRunner | null = null;

export function setMaSosBrowserRunnerForTests(fn: MaBrowserRunner | null): void {
  runnerOverride = fn;
}

export function detectMaSosChallenge(html: string): { captcha: boolean; incapsula: boolean } {
  const text = html || '';
  const captcha =
    hasCaptchaOrTurnstile(text) || /g-recaptcha|grecaptcha|h-captcha|hcaptcha/i.test(text);
  const hasForm = /__VIEWSTATE|Entity Name|CorpSummary\.aspx/i.test(text);
  const incapsula = incapsulaDetected(text) && !hasForm;
  return { captcha, incapsula };
}

export function shouldUseMaBrowser(result: ResolverResult): boolean {
  if (result.people.length) return false;
  if (result.captcha) return false;
  return Boolean(result.blocked || result.coverage_reason === 'blocked');
}

export function estimateMaBrowserUsd(lookupCount: number): MaBrowserEstimate {
  const lookups = Math.max(0, Math.min(Math.floor(lookupCount), MA_BROWSER_BATCH_SIZE));
  const seconds = lookups ? MA_BROWSER_STARTUP_SECS + lookups * MA_BROWSER_SECS_PER_LOOKUP : 0;
  const cu = (seconds / 3600) * (MA_BROWSER_MEMORY_MB / 1024);
  const compute_usd = Number((cu * MA_BROWSER_CU_USD).toFixed(4));
  const proxy_usd = Number((lookups * MA_BROWSER_PROXY_USD_PER_LOOKUP).toFixed(4));
  const total_usd = Number((compute_usd + proxy_usd).toFixed(4));
  const cap_usd = Number(Math.min(MA_BROWSER_USD_CAP_PER_BATCH, lookups * MA_BROWSER_USD_CAP_PER_LOOKUP).toFixed(4));
  return { lookups, compute_usd, proxy_usd, total_usd, cap_usd, run: lookups > 0 && total_usd <= cap_usd };
}

export function planMaBrowserBatch(lookupCount: number): MaBrowserEstimate {
  for (let n = Math.min(lookupCount, MA_BROWSER_BATCH_SIZE); n >= 1; n -= 1) {
    const est = estimateMaBrowserUsd(n);
    if (est.run) return est;
  }
  return estimateMaBrowserUsd(0);
}

/** Counts-only. Host + group + status + Incapsula/captcha. Never secrets or names. */
export function formatMaBrowserAttemptLog(opts: {
  url?: string;
  status?: number | null;
  body?: string;
  captcha?: boolean;
  lookups?: number;
  estimate_usd?: number;
  cap_usd?: number;
  error?: string;
}): string {
  if (opts.lookups != null) {
    return `[ma-browser] actor=${MA_BROWSER_ACTOR} lookups=${opts.lookups} estimate_usd=${opts.estimate_usd ?? 0} cap_usd=${opts.cap_usd ?? 0}`;
  }
  const err = opts.error ? ` error=${opts.error}` : '';
  return `[ma-browser] host=${hostOf(opts.url || MA_SOS_SEARCH)} group=RESIDENTIAL status=${opts.status ?? 0} incapsula=${incapsulaDetected(opts.body || '') ? 'yes' : 'no'} captcha=${opts.captcha ? 'yes' : 'no'}${err}`;
}

/**
 * Playwright pageFunction for apify/playwright-scraper.
 * Completes the Incapsula JS challenge. On captcha / Turnstile: stop, do not solve.
 */
export const MA_SOS_PAGE_FUNCTION = `async function pageFunction(context) {
  const { page, request, log, skipLinks, enqueueRequest } = context;
  const waitMs = async (ms) => {
    try { await page.waitForTimeout(ms); } catch { await new Promise((r) => setTimeout(r, ms)); }
  };
  await waitMs(4000);
  let html = await page.content();
  const captchaRe = /cf-turnstile|challenges\\.cloudflare\\.com\\/turnstile|g-recaptcha|grecaptcha|h-captcha|hcaptcha|please complete the captcha/i;
  if (captchaRe.test(html)) {
    await skipLinks();
    log.warning('interactive challenge; aborting page');
    return {
      kind: request.userData.kind || 'search',
      cacheKey: request.userData.cacheKey,
      blocked: true,
      captcha: true,
      incapsula: false,
      httpStatus: 200,
      url: request.loadedUrl || request.url,
      html: '',
    };
  }
  const incapsulaRe = /_Incapsula_Resource|incapsula|imperva|request unsuccessful|incident id/i;
  const formRe = /__VIEWSTATE|Entity Name|CorpSummary\\.aspx/i;
  if (incapsulaRe.test(html) && !formRe.test(html)) {
    await waitMs(8000);
    html = await page.content();
  }
  if (captchaRe.test(html)) {
    await skipLinks();
    return {
      kind: request.userData.kind || 'search',
      cacheKey: request.userData.cacheKey,
      blocked: true,
      captcha: true,
      incapsula: false,
      httpStatus: 200,
      url: request.loadedUrl || request.url,
      html: '',
    };
  }
  if (incapsulaRe.test(html) && !formRe.test(html)) {
    await skipLinks();
    return {
      kind: request.userData.kind || 'search',
      cacheKey: request.userData.cacheKey,
      blocked: true,
      captcha: false,
      incapsula: true,
      httpStatus: 200,
      url: request.loadedUrl || request.url,
      html: '',
    };
  }
  const kind = request.userData.kind || 'search';
  if (kind === 'detail') {
    return {
      kind: 'detail',
      cacheKey: request.userData.cacheKey,
      blocked: false,
      captcha: false,
      incapsula: false,
      httpStatus: 200,
      url: page.url(),
      html,
    };
  }
  const name = String(request.userData.companyName || '');
  const inputs = await page.locator('input').all();
  for (const input of inputs) {
    const n = (await input.getAttribute('name')) || '';
    if (/entityname|txtentity|txtname|searchname/i.test(n)) await input.fill(name);
  }
  const searchBtn = page.locator('input[type="submit"], input[value*="Search" i], button:has-text("Search")').first();
  if (await searchBtn.count()) {
    await searchBtn.click();
    try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch (e) {}
  }
  html = await page.content();
  if (captchaRe.test(html)) {
    await skipLinks();
    return {
      kind: 'search',
      cacheKey: request.userData.cacheKey,
      blocked: true,
      captcha: true,
      incapsula: false,
      httpStatus: 200,
      url: page.url(),
      html: '',
    };
  }
  const rows = await page.$$eval('a[href*="CorpSummary.aspx"]', (as) =>
    as.map((a) => ({ url: a.href, name: (a.textContent || '').replace(/\\s+/g, ' ').trim() })).filter((r) => r.url),
  );
  const tokens = name.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 2 && !/^(INC|LLC|THE|AND|CORP|LTD|CO)$/.test(t));
  let best = rows[0];
  let bestScore = 0;
  for (const row of rows) {
    const u = row.name.toUpperCase();
    const score = tokens.filter((t) => u.includes(t)).length;
    if (score > bestScore) { best = row; bestScore = score; }
  }
  if (best && best.url) {
    await enqueueRequest({
      url: best.url,
      uniqueKey: 'ma-sos-detail-' + String(request.userData.cacheKey || ''),
      userData: { kind: 'detail', cacheKey: request.userData.cacheKey },
    });
  }
  return {
    kind: 'search',
    cacheKey: request.userData.cacheKey,
    blocked: false,
    captcha: false,
    incapsula: false,
    httpStatus: 200,
    url: page.url(),
    html,
  };
}`;

export function buildMaSosPlaywrightInput(lookups: MaSosLookup[]): Record<string, unknown> {
  return {
    startUrls: lookups.map((lookup) => ({
      url: MA_SOS_SEARCH,
      uniqueKey: `ma-sos-search-${lookup.cacheKey}`,
      userData: { kind: 'search', companyName: lookup.companyName, cacheKey: lookup.cacheKey },
    })),
    linkSelector: '',
    globs: [],
    pseudoUrls: [],
    pageFunction: MA_SOS_PAGE_FUNCTION,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'US',
    },
    proxyRotation: 'UNTIL_FAILURE',
    launcher: 'chromium',
    headless: true,
    downloadMedia: false,
    downloadCss: true,
    maxConcurrency: 1,
    maxRequestRetries: 1,
    maxPagesPerCrawl: lookups.length * 2 + 1,
    maxCrawlingDepth: 1,
    pageLoadTimeoutSecs: 60,
    pageFunctionTimeoutSecs: 90,
    waitUntil: 'networkidle',
    respectRobotsTxtFile: false,
  };
}

function blockedSos(url: string, status: number, captcha: boolean): ResolverResult {
  return {
    people: [],
    coverage_reason: 'blocked',
    source: 'ma_sos',
    source_url: url,
    blocked: true,
    captcha,
    http_status: status,
  };
}

function pickHtmlForLookup(items: MaBrowserActorItem[], cacheKey: string): MaBrowserActorItem | null {
  const mine = items.filter((item) => item.cacheKey === cacheKey);
  if (!mine.length) return null;
  const captcha = mine.find((item) => item.captcha);
  if (captcha) return captcha;
  const detail = mine.find((item) => item.kind === 'detail' && item.html);
  if (detail) return detail;
  return mine.find((item) => item.html) || mine[0] || null;
}

export function resultsFromMaBrowserItems(
  lookups: MaSosLookup[],
  items: MaBrowserActorItem[],
): ResolverResult[] {
  return lookups.map((lookup) => {
    const item = pickHtmlForLookup(items, lookup.cacheKey);
    const url = item?.url || MA_SOS_SEARCH;
    const status = item?.httpStatus ?? 0;
    const html = item?.html || '';
    const challenge = detectMaSosChallenge(html);
    const captcha = Boolean(item?.captcha || challenge.captcha);
    const incapsula = Boolean(item?.incapsula || challenge.incapsula);
    console.log(
      formatMaBrowserAttemptLog({
        url,
        status,
        body: html,
        captcha,
      }),
    );
    if (captcha || item?.blocked || incapsula) {
      return blockedSos(url, status || 200, captcha);
    }
    const text = `${htmlToText(html)}\n${html}`;
    const parsed = parseMaSosText(text, url, lookup.companyName);
    return { ...parsed, http_status: status || 200 };
  });
}

async function defaultRunner(input: { lookups: MaSosLookup[]; pageFunction: string }): Promise<MaBrowserActorItem[]> {
  const token = apifyToken();
  if (!token) return [];
  const actorInput = buildMaSosPlaywrightInput(input.lookups);
  const timeoutSecs = 90 + input.lookups.length * 50;
  const started = await apifyApi(`/acts/apify~playwright-scraper/runs?timeout=${timeoutSecs}&memory=${MA_BROWSER_MEMORY_MB}`, {
    method: 'POST',
    body: JSON.stringify(actorInput),
  });
  const runId = String(started?.data?.id || '');
  const datasetId = String(started?.data?.defaultDatasetId || '');
  if (!runId) return [];
  const deadline = Date.now() + timeoutSecs * 1000;
  let run = started?.data;
  while (Date.now() < deadline) {
    const status = String(run?.status || '');
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) break;
    await new Promise((r) => setTimeout(r, 8000));
    const next = await apifyApi(`/actor-runs/${runId}`);
    run = next?.data;
  }
  if (String(run?.status || '') !== 'SUCCEEDED' || !datasetId) return [];
  const data = await apifyApi(`/datasets/${datasetId}/items?clean=true`);
  return Array.isArray(data) ? (data as MaBrowserActorItem[]) : [];
}

async function apifyApi(path: string, init: RequestInit = {}): Promise<any> {
  const token = apifyToken();
  if (!token) return null;
  const res = await fetch(`https://api.apify.com/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    console.log(`[ma-browser] host=api.apify.com group=RESIDENTIAL status=${res.status} incapsula=no captcha=no`);
    return null;
  }
  return res.json();
}

export async function fetchMaSosViaPlaywright(lookups: MaSosLookup[]): Promise<ResolverResult[]> {
  const planned = planMaBrowserBatch(lookups.length);
  const batch = lookups.slice(0, planned.lookups);
  console.log(
    formatMaBrowserAttemptLog({
      lookups: batch.length,
      estimate_usd: planned.total_usd,
      cap_usd: planned.cap_usd,
    }),
  );
  if (!batch.length) return lookups.map((lookup) => blockedSos(MA_SOS_SEARCH, 0, false));
  if (!runnerOverride && !apifyTokenConfigured()) {
    console.log('[ma-browser] configured=false env=none');
    return batch.map(() => blockedSos(MA_SOS_SEARCH, 0, false));
  }
  let items: MaBrowserActorItem[] = [];
  try {
    const run = runnerOverride || defaultRunner;
    items = await run({ lookups: batch, pageFunction: MA_SOS_PAGE_FUNCTION });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    console.log(formatMaBrowserAttemptLog({ url: MA_SOS_SEARCH, status: 0, error: name }));
    return batch.map(() => blockedSos(MA_SOS_SEARCH, 0, false));
  }
  return resultsFromMaBrowserItems(batch, items);
}

export function maSosLookupFromLead(lead: OwnerLead): MaSosLookup | null {
  const companyName = lead.company_name?.trim() || '';
  if (!companyName) return null;
  return { companyName, cacheKey: nameStateCacheKey(companyName, 'MA-SOS') };
}
