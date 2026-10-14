import { sleep } from '../retry.js';
import { BoardJobStopError, type BoardSource } from './types.js';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

let injectedFetch: FetchLike | null = null;

export function setBoardFetch(fn: FetchLike | null): void {
  injectedFetch = fn;
}

export function getBoardFetch(): FetchLike {
  return injectedFetch ?? fetch;
}

export function isBoardFetchInjected(): boolean {
  return injectedFetch != null;
}

const CAPTCHA_RE =
  /cf-turnstile|challenges\.cloudflare\.com\/turnstile|please complete the captcha/i;
const IMPERVA_RE = /_Incapsula_Resource|incapsula|imperva|request unsuccessful|incident id/i;
const PROXY_PASSWORD_ENVS = ['APIFY_PROXY_PASSWORD', 'apify_proxy_password'] as const;
const PROXY_GROUP = 'RESIDENTIAL';

export function apifyProxyPasswordEnvName(): string | null {
  for (const name of PROXY_PASSWORD_ENVS) {
    if (process.env[name]?.trim()) return name;
  }
  return null;
}

export function apifyProxyPassword(): string | null {
  const name = apifyProxyPasswordEnvName();
  return name ? process.env[name]!.trim() : null;
}

export function apifyResidentialProxyConfigured(): boolean {
  return Boolean(apifyProxyPassword());
}

export function hasCaptchaOrTurnstile(body: string): boolean {
  return CAPTCHA_RE.test(body || '');
}

export function incapsulaDetected(body: string): boolean {
  return IMPERVA_RE.test(body || '');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Counts-only proxy line. Host + group + status + Incapsula. Never secrets or query strings. */
export function formatMaProxyAttemptLog(opts: {
  url: string;
  group?: string;
  status: number;
  body?: string;
  error?: string;
}): string {
  const err = opts.error ? ` error=${opts.error}` : '';
  return `[ma-proxy] host=${hostOf(opts.url)} group=${opts.group || PROXY_GROUP} status=${opts.status} incapsula=${incapsulaDetected(opts.body || '') ? 'yes' : 'no'}${err}`;
}

export function logMaProxyAttempt(opts: {
  url: string;
  group?: string;
  status: number;
  body?: string;
  error?: string;
}): void {
  console.log(formatMaProxyAttemptLog(opts));
}

let loggedProxyConfig = false;
export function logMaProxyConfigOnce(): void {
  if (loggedProxyConfig) return;
  loggedProxyConfig = true;
  const env = apifyProxyPasswordEnvName();
  console.log(`[ma-proxy] configured=${Boolean(env)} env=${env || 'none'}`);
}

export function resetMaProxyConfigLogForTests(): void {
  loggedProxyConfig = false;
}

/** Session must be [0-9A-Za-z._~], max 50. Pin one residential IP for ASP.NET GET→POST. */
export function residentialProxyUrl(sessionId = 'permits-mcp'): string | null {
  const password = apifyProxyPassword();
  if (!password) return null;
  const session = String(sessionId || 'permits-mcp')
    .replace(/[^0-9A-Za-z._~]/g, '')
    .slice(0, 50);
  const user = `groups-${PROXY_GROUP},country-US,session-${session || 'permits-mcp'}`;
  return `http://${user}:${encodeURIComponent(password)}@proxy.apify.com:8000`;
}

export async function createResidentialProxyFetch(sessionId?: string): Promise<FetchLike | null> {
  logMaProxyConfigOnce();
  const proxyUrl = residentialProxyUrl(sessionId);
  if (!proxyUrl) return null;
  try {
    let undici: typeof import('undici');
    try {
      undici = await import('undici');
    } catch {
      undici = (await import(/* @vite-ignore */ ['node', 'undici'].join(':'))) as typeof import('undici');
    }
    const agent = new undici.ProxyAgent(proxyUrl);
    return async (input, init) => {
      const res = await undici.fetch(String(input), {
        method: init?.method,
        headers: init?.headers as Record<string, string> | undefined,
        body: init?.body as never,
        redirect: (init?.redirect ?? 'follow') as RequestRedirect,
        dispatcher: agent,
      });
      return res as unknown as Response;
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    console.log(`[ma-proxy] init_failed name=${name}`);
    return null;
  }
}

/** True when the page is an IP/WAF block, not a captcha/Turnstile challenge. */
export function isPlainHttpBlock(status: number, body: string): boolean {
  if (hasCaptchaOrTurnstile(body)) return false;
  if (status === 403 || status === 401 || status === 429 || status === 404) return true;
  if (status === 200 && IMPERVA_RE.test(body || '')) return true;
  return false;
}

/** Retry MA SOS / licensing through the residential proxy. Never captcha/Turnstile. */
export function shouldRetryMaViaProxy(opts: {
  named: boolean;
  captcha?: boolean;
  blocked?: boolean;
  coverage_reason?: string | null;
  http_status?: number | null;
  body?: string;
}): boolean {
  if (opts.named) return false;
  if (opts.captcha || hasCaptchaOrTurnstile(opts.body || '')) return false;
  if (opts.blocked || opts.coverage_reason === 'blocked' || opts.coverage_reason === 'not_found') {
    return true;
  }
  return isPlainHttpBlock(opts.http_status ?? 0, opts.body || '');
}

export interface BoardGetResult {
  status: number;
  body: string;
  url: string;
  retried: boolean;
  setCookie: string[];
}

/**
 * Paced GET. Retry once on a non-200. After `stopAfter` consecutive non-200s
 * the job must stop (CSLB: 3). Default gap 1200ms.
 */
export class PacedBoardClient {
  readonly source: BoardSource;
  readonly gapMs: number;
  readonly stopAfter: number;
  readonly fetchFn: FetchLike | null;
  readonly viaProxy: boolean;
  consecutiveNon200 = 0;
  lastRequestAt = 0;

  constructor(opts: {
    source: BoardSource;
    gapMs?: number;
    stopAfter?: number;
    fetch?: FetchLike | null;
    viaProxy?: boolean;
  }) {
    this.source = opts.source;
    this.gapMs = opts.gapMs ?? 1200;
    this.stopAfter = opts.stopAfter ?? 3;
    this.fetchFn = opts.fetch ?? null;
    this.viaProxy = opts.viaProxy === true;
  }

  async get(url: string, init: RequestInit = {}): Promise<BoardGetResult> {
    return this.request(url, init);
  }

  async post(url: string, init: RequestInit = {}): Promise<BoardGetResult> {
    return this.request(url, { ...init, method: 'POST' });
  }

  private async request(url: string, init: RequestInit = {}): Promise<BoardGetResult> {
    const wait = this.lastRequestAt ? this.gapMs - (Date.now() - this.lastRequestAt) : 0;
    if (wait > 0) await sleep(wait);

    let result = await this.once(url, init);
    this.lastRequestAt = Date.now();
    let retried = false;
    if (result.status !== 200) {
      result = await this.once(url, init);
      this.lastRequestAt = Date.now();
      retried = true;
    }
    if (result.status !== 200) {
      this.consecutiveNon200 += 1;
      if (this.consecutiveNon200 >= this.stopAfter) {
        throw new BoardJobStopError(this.source, this.consecutiveNon200, result.status);
      }
    } else {
      this.consecutiveNon200 = 0;
    }
    return { ...result, retried };
  }

  private async once(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: string; url: string; setCookie: string[] }> {
    try {
      const res = await (this.fetchFn ?? getBoardFetch())(url, {
        ...init,
        redirect: init.redirect ?? 'follow',
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(init.headers || {}),
        },
      });
      const body = await res.text();
      const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (this.viaProxy) {
        logMaProxyAttempt({ url: res.url || url, status: res.status, body });
      }
      return { status: res.status, body, url: res.url || url, setCookie };
    } catch (err) {
      if (this.viaProxy) {
        const name = err instanceof Error ? err.name : 'error';
        logMaProxyAttempt({ url, status: 0, body: '', error: name });
        return { status: 0, body: '', url, setCookie: [] };
      }
      throw err;
    }
  }
}

export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 401 || status === 429) return true;
  const text = body || '';
  const hasPayload =
    /Business Information|Governing person|license_number|Qualifying Person|Licensee|owner_name|principalname|OWNER NAME|Officer|Director|Entity Name/i.test(
      text,
    );
  // Cloudflare Turnstile on an otherwise empty search shell is a block.
  if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(text) && !hasPayload) return true;
  if (incapsulaDetected(text) && !hasPayload) return true;
  // Real board pages often include a reCAPTCHA widget; only treat challenge shells as blocked.
  if (
    /just a moment|cf-mitigation|access denied|unusual traffic|please complete the captcha|enable javascript and cookies to continue/i.test(
      text,
    )
  ) {
    return !hasPayload;
  }
  return false;
}
