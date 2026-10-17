import { htmlToText } from '../names.js';
import type { LookupContext } from './context.js';
import { fetchOfficialPage } from './htmlFetch.js';
import { pickBestEntityMatch } from './match.js';
import { hitsFromRoster, parseOfficerRoster } from './officers.js';
import type { NameLookupInput, NameLookupResult } from './types.js';
import { catalogByCode } from './catalog.js';

interface SearchHit {
  name: string;
  url: string;
  city?: string | null;
}

const GA_SEARCH = 'https://ecorp.sos.ga.gov/BusinessSearch';
const NC_SEARCH = 'https://www.sosnc.gov/online_services/search/by_title/_Business_Registration';
const AZ_SEARCH = 'https://arizonabusinesscenter.azcc.gov/businesssearch';

function absUrl(href: string, base: string): string {
  try {
    return new URL(href.replace(/&amp;/g, '&'), base).href;
  } catch {
    return href;
  }
}

export function parseSearchResultLinks(html: string, base: string): SearchHit[] {
  const rows: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of String(html || '').matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1] || '';
    const name = htmlToText(m[2] || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3 || name.length > 120) continue;
    if (/^search|home|login|help|privacy|next|previous$/i.test(name)) continue;
    const lower = href.toLowerCase();
    if (!/business|profile|detail|entity|information|controln|id=/i.test(lower) && !/Business/i.test(href)) {
      continue;
    }
    const url = absUrl(href, base);
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ name, url });
  }
  return rows;
}

function searchUrlFor(state: string, company: string): { url: string; base: string } {
  const q = encodeURIComponent(company.trim());
  if (state === 'GA') {
    return {
      url: `${GA_SEARCH}?SearchType=BusinessName&EntityName=${q}`,
      base: 'https://ecorp.sos.ga.gov/',
    };
  }
  if (state === 'NC') {
    return {
      url: `https://www.sosnc.gov/online_services/search/Business_Registration_Results?SearchTerms=${q}`,
      base: 'https://www.sosnc.gov/',
    };
  }
  return {
    url: `${AZ_SEARCH}?q=${q}`,
    base: 'https://arizonabusinesscenter.azcc.gov/',
  };
}

export async function resolveHtmlOfficerState(
  input: NameLookupInput,
  state: 'GA' | 'NC' | 'AZ',
  ctx?: LookupContext,
): Promise<NameLookupResult> {
  const entry = catalogByCode().get(state)!;
  const sourceUrl = entry.search_url;
  const { url, base } = searchUrlFor(state, input.company_name);
  const search = await fetchOfficialPage(url, ctx, {
    state,
    allowApify: true,
    input,
    kind: 'search',
  });
  let viaApify = search.via_apify;
  let usd = search.usd;
  if (!search.body) {
    return {
      people: [],
      coverage_reason: search.blocked ? 'blocked' : 'not_found',
      source: 'us_sos',
      source_url: sourceUrl,
      implemented: true,
      via_apify: viaApify,
      apify_usd: usd,
    };
  }

  const links = parseSearchResultLinks(search.body, base);
  const candidates = links.length
    ? links
    : [{ name: input.company_name, url, city: input.city }];
  const picked = pickBestEntityMatch(input.company_name, candidates, {
    legalNameOf: (r) => r.name,
    city: input.city,
    cityOf: (r) => r.city,
    allowTrigram: true,
  });
  if (!picked) {
    const roster = parseOfficerRoster(search.body);
    if (roster.length) {
      return {
        people: hitsFromRoster(input, roster, 'us_sos', search.url, 'substring'),
        coverage_reason: null,
        source: 'us_sos',
        source_url: search.url,
        implemented: true,
        match_method: 'substring',
        via_apify: viaApify,
        apify_usd: usd,
      };
    }
    return {
      people: [],
      coverage_reason: 'not_found',
      source: 'us_sos',
      source_url: sourceUrl,
      implemented: true,
      via_apify: viaApify,
      apify_usd: usd,
    };
  }

  let detailBody = search.body;
  let detailUrl = search.url;
  if (picked.item.url && picked.item.url !== url) {
    const detail = await fetchOfficialPage(picked.item.url, ctx, {
      state,
      allowApify: true,
      input,
      kind: 'detail',
    });
    viaApify = viaApify || detail.via_apify;
    usd += detail.usd;
    if (detail.body) {
      detailBody = detail.body;
      detailUrl = detail.url;
    }
  }
  const entries = parseOfficerRoster(detailBody);
  const people = hitsFromRoster(input, entries, 'us_sos', detailUrl, picked.method);
  if (!people.length) {
    return {
      people: [],
      coverage_reason: 'agent_only',
      source: 'us_sos',
      source_url: detailUrl,
      implemented: true,
      match_method: picked.method,
      match_score: picked.score,
      business_name: picked.item.name,
      via_apify: viaApify,
      apify_usd: usd,
    };
  }
  return {
    people,
    coverage_reason: null,
    source: 'us_sos',
    source_url: detailUrl,
    implemented: true,
    match_method: picked.method,
    match_score: picked.score,
    business_name: picked.item.name,
    via_apify: viaApify,
    apify_usd: usd,
  };
}

export const HTML_OFFICER_STATES = {
  GA_SEARCH,
  NC_SEARCH,
  AZ_SEARCH,
};
