import { pickBestNameMatchScored, splitLegalAndDba, type NameMatchHit } from '../names.js';

export interface EntityNameFields {
  legal_name: string;
  dba_name?: string | null;
  city?: string | null;
  zip?: string | null;
}

/**
 * Fuzzy match against legal name and DBA. City/ZIP bonuses apply to every method
 * (exact / substring / trigram) so two same-name hits in different cities split.
 */
export function pickBestEntityMatch<T>(
  target: string,
  items: T[],
  opts: {
    legalNameOf: (item: T) => string;
    dbaNameOf?: (item: T) => string | null | undefined;
    city?: string | null;
    zip?: string | null;
    cityOf?: (item: T) => string | null | undefined;
    zipOf?: (item: T) => string | null | undefined;
    allowTrigram?: boolean;
    allowSubstring?: boolean;
    minTrigram?: number;
  },
): NameMatchHit<T> | null {
  const expanded: Array<{ item: T; label: string }> = [];
  for (const item of items) {
    const seen = new Set<string>();
    const push = (label: string | null | undefined) => {
      const raw = String(label || '').trim();
      if (!raw) return;
      const key = raw.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      expanded.push({ item, label: raw });
      const parts = splitLegalAndDba(raw);
      if (parts.dba) {
        const dbaKey = parts.dba.toUpperCase();
        if (!seen.has(dbaKey)) {
          seen.add(dbaKey);
          expanded.push({ item, label: parts.dba });
        }
        const legalKey = parts.legal.toUpperCase();
        if (parts.legal && !seen.has(legalKey)) {
          seen.add(legalKey);
          expanded.push({ item, label: parts.legal });
        }
      }
    };
    push(opts.legalNameOf(item));
    push(opts.dbaNameOf?.(item));
  }
  const hit = pickBestNameMatchScored(target, expanded, (row) => row.label, {
    city: opts.city,
    zip: opts.zip,
    cityOf: (row) => opts.cityOf?.(row.item),
    zipOf: (row) => opts.zipOf?.(row.item),
    allowTrigram: opts.allowTrigram,
    allowSubstring: opts.allowSubstring,
    minTrigram: opts.minTrigram,
  });
  if (!hit) return null;
  return { item: hit.item.item, score: hit.score, method: hit.method };
}
