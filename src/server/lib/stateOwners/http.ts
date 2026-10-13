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

export interface BoardGetResult {
  status: number;
  body: string;
  url: string;
  retried: boolean;
}

/**
 * Paced GET. Retry once on a non-200. After `stopAfter` consecutive non-200s
 * the job must stop (CSLB: 3). Default gap 1200ms.
 */
export class PacedBoardClient {
  readonly source: BoardSource;
  readonly gapMs: number;
  readonly stopAfter: number;
  consecutiveNon200 = 0;
  lastRequestAt = 0;

  constructor(opts: { source: BoardSource; gapMs?: number; stopAfter?: number }) {
    this.source = opts.source;
    this.gapMs = opts.gapMs ?? 1200;
    this.stopAfter = opts.stopAfter ?? 3;
  }

  async get(url: string, init: RequestInit = {}): Promise<BoardGetResult> {
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

  private async once(url: string, init: RequestInit): Promise<{ status: number; body: string; url: string }> {
    const res = await getBoardFetch()(url, {
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
    return { status: res.status, body, url: res.url || url };
  }
}

export function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 401 || status === 429) return true;
  return /just a moment|cf-mitigation|access denied|unusual traffic|captcha|enable javascript/i.test(
    body || '',
  );
}
