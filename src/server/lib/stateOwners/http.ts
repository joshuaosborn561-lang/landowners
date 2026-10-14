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

const CAPTCHA_RE =
  /cf-turnstile|challenges\.cloudflare\.com\/turnstile|please complete the captcha/i;
const IMPERVA_RE = /_Incapsula_Resource|incapsula|imperva/i;

export function apifyResidentialProxyConfigured(): boolean {
  return Boolean(process.env.APIFY_PROXY_PASSWORD);
}

export function hasCaptchaOrTurnstile(body: string): boolean {
  return CAPTCHA_RE.test(body || '');
}

/** Session must be [0-9A-Za-z._~], max 50. Pin one residential IP for ASP.NET GET→POST. */
export function residentialProxyUrl(sessionId = 'permits-mcp'): string | null {
  const password = process.env.APIFY_PROXY_PASSWORD;
  if (!password) return null;
  const session = String(sessionId || 'permits-mcp')
    .replace(/[^0-9A-Za-z._~]/g, '')
    .slice(0, 50);
  const user = `groups-RESIDENTIAL,country-US,session-${session || 'permits-mcp'}`;
  return `http://${user}:${encodeURIComponent(password)}@proxy.apify.com:8000`;
}

export async function createResidentialProxyFetch(sessionId?: string): Promise<FetchLike | null> {
  const proxyUrl = residentialProxyUrl(sessionId);
  if (!proxyUrl) return null;
  const undici = await import('undici');
  const agent = new undici.ProxyAgent(proxyUrl);
  return async (input, init) => {
    const res = await undici.fetch(String(input), {
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as import('undici').RequestInit['body'],
      redirect: (init?.redirect ?? 'follow') as RequestRedirect,
      dispatcher: agent,
    });
    return res as unknown as Response;
  };
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
  consecutiveNon200 = 0;
  lastRequestAt = 0;

  constructor(opts: { source: BoardSource; gapMs?: number; stopAfter?: number; fetch?: FetchLike | null }) {
    this.source = opts.source;
    this.gapMs = opts.gapMs ?? 1200;
    this.stopAfter = opts.stopAfter ?? 3;
    this.fetchFn = opts.fetch ?? null;
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
    return { status: res.status, body, url: res.url || url, setCookie };
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
  if (/_Incapsula_Resource|incapsula/i.test(text) && !hasPayload) return true;
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
