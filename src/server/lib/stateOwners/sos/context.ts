import { config } from '../../../config.js';
import { getBoardFetch, type FetchLike } from '../http.js';
import type { NameLookupInput } from './types.js';
import { ApifySpendTracker } from './spend.js';
import type { IlDtaIndex } from './ilDta.js';

export type HtmlKind = 'search' | 'detail' | 'document';

export interface LookupContext {
  /** When true, adapters may call official HTTP / Apify. Tests leave this false. */
  live?: boolean;
  fetch?: FetchLike;
  caApiKey?: string | null;
  apifyToken?: string | null;
  apifyEnabled?: boolean;
  ilDtaDir?: string | null;
  ilIndex?: IlDtaIndex | null;
  includeAgents?: boolean;
  spend?: ApifySpendTracker;
  /** Fixture: skip CA HTTP and use this keyword-search JSON. */
  caPayload?: unknown;
  caDetailPayload?: unknown;
  caSiText?: string | null;
  caSiBytes?: Uint8Array | null;
  /** Fixture HTML keyed by state + kind, or a function. */
  htmlFor?: string | ((state: string, kind: HtmlKind, input: NameLookupInput, url?: string) => string | null);
  htmlByUrl?: Record<string, string>;
  /** Fixture rows for Colorado Socrata. */
  coRows?: unknown[];
  /** Injected OCR (tests). Production uses tesseract.js when installed. */
  ocr?: (bytes: Uint8Array) => Promise<string>;
  /** Injected Apify HTML fetch (tests). */
  apifyFetchHtml?: (url: string) => Promise<{ html: string; usd: number }>;
}

export function caSosApiKeyFromEnv(): string | null {
  const keys = ['CA_SOS_API_KEY', 'CA_BIZFILE_API_KEY', 'ca_sos_api_key', 'ca_bizfile_api_key'] as const;
  for (const name of keys) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return config.caBizfileApiKey?.trim() || null;
}

export function apifyTokenFromEnv(): string | null {
  for (const name of ['APIFY_TOKEN', 'APIFY_API_TOKEN', 'apify_token'] as const) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export function ilDtaDirFromEnv(): string | null {
  return process.env.IL_DTA_DIR?.trim() || null;
}

export function defaultLookupContext(overrides: LookupContext = {}): LookupContext {
  return {
    live: true,
    fetch: getBoardFetch(),
    caApiKey: caSosApiKeyFromEnv(),
    apifyToken: apifyTokenFromEnv(),
    apifyEnabled: overrides.apifyEnabled ?? true,
    ilDtaDir: ilDtaDirFromEnv(),
    includeAgents: false,
    spend: overrides.spend ?? new ApifySpendTracker(),
    ...overrides,
  };
}

export function ctxFetch(ctx?: LookupContext): FetchLike {
  return ctx?.fetch ?? getBoardFetch();
}

export function ctxSpend(ctx?: LookupContext): ApifySpendTracker {
  if (ctx?.spend) return ctx.spend;
  const spend = new ApifySpendTracker();
  if (ctx) ctx.spend = spend;
  return spend;
}

export function fixtureHtml(ctx: LookupContext | undefined, state: string, kind: HtmlKind, input: NameLookupInput, url?: string): string | null {
  if (!ctx) return null;
  if (typeof ctx.htmlFor === 'function') return ctx.htmlFor(state, kind, input, url);
  if (typeof ctx.htmlFor === 'string') return ctx.htmlFor;
  if (url && ctx.htmlByUrl?.[url]) return ctx.htmlByUrl[url];
  return null;
}
