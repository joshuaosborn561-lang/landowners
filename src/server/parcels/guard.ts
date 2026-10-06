import { supabaseProjectRef } from '../lib/supabaseTarget.js';
import { config } from '../config.js';

/** This service may write parcels only on the google-maps-scraper-leads project. */
export const ALLOWED_SUPABASE_PROJECT = 'kemvxzhcxvynmoutwdrh';

export const FORBIDDEN_SUPABASE_PROJECTS = [
  'azpapwtnrbzywlnxxecz',
  'klomihumrgwoixbzxypr',
] as const;

export function assertWritableProject(url: string, ref: string | null = null): string {
  const resolved = ref ?? projectRefFromUrl(url);
  const forbidden = FORBIDDEN_SUPABASE_PROJECTS.find((id) => url.includes(id) || resolved === id);
  if (forbidden) {
    throw new Error(
      `Refusing to write parcels. Project ${forbidden} is not the permits target.`,
    );
  }
  if (resolved !== ALLOWED_SUPABASE_PROJECT) {
    throw new Error(
      `Refusing to write parcels. Expected project ${ALLOWED_SUPABASE_PROJECT}, got ${resolved ?? 'unset'}.`,
    );
  }
  return resolved;
}

function projectRefFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

export function assertParcelsWritableProject(): string {
  return assertWritableProject(config.supabaseUrl || '', supabaseProjectRef());
}
