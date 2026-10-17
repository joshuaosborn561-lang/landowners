import { DESKTOP_UA, looksBlocked } from '../http.js';
import type { LookupContext } from './context.js';
import { ctxFetch, fixtureHtml } from './context.js';
import { apifyFetchHtml } from './apifyPlaywright.js';
import { catalogByCode } from './catalog.js';
import type { NameLookupInput } from './types.js';

export interface OfficialPage {
  status: number;
  body: string;
  url: string;
  via_apify: boolean;
  blocked: boolean;
  usd: number;
}

export async function fetchOfficialPage(
  url: string,
  ctx: LookupContext | undefined,
  opts: {
    state: string;
    allowApify: boolean;
    input: NameLookupInput;
    kind?: 'search' | 'detail' | 'document';
    init?: RequestInit;
  },
): Promise<OfficialPage> {
  const fixture = fixtureHtml(ctx, opts.state, opts.kind || 'search', opts.input, url);
  if (fixture != null) {
    return { status: 200, body: fixture, url, via_apify: false, blocked: false, usd: 0 };
  }
  if (ctx?.htmlByUrl?.[url]) {
    return { status: 200, body: ctx.htmlByUrl[url], url, via_apify: false, blocked: false, usd: 0 };
  }
  if (!ctx?.live) {
    return { status: 0, body: '', url, via_apify: false, blocked: false, usd: 0 };
  }

  const fetchFn = ctxFetch(ctx);
  let status = 0;
  let body = '';
  try {
    const res = await fetchFn(url, {
      redirect: 'follow',
      ...opts.init,
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.init?.headers || {}),
      },
    });
    status = res.status;
    const buf = new Uint8Array(await res.arrayBuffer());
    body = Buffer.from(buf).toString('utf8');
    const blocked = looksBlocked(status, body) || status === 0;
    if (!blocked) {
      return { status, body, url: res.url || url, via_apify: false, blocked: false, usd: 0 };
    }
    if (!opts.allowApify) {
      return { status, body, url, via_apify: false, blocked: true, usd: 0 };
    }
  } catch {
    if (!opts.allowApify) return { status: 0, body: '', url, via_apify: false, blocked: true, usd: 0 };
  }

  const entry = catalogByCode().get(opts.state);
  if (!opts.allowApify || entry?.apify === 'never' || ctx?.apifyEnabled === false) {
    return { status, body, url, via_apify: false, blocked: true, usd: 0 };
  }
  const got = await apifyFetchHtml(url, ctx);
  const html = got.html || got.text;
  return {
    status: html ? 200 : status || 0,
    body: html || body,
    url,
    via_apify: true,
    blocked: !html,
    usd: got.usd,
  };
}
