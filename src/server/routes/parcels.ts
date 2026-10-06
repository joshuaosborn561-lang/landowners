import { Router } from 'express';
import { loadCounty } from '../parcels/loadCounty.js';
import {
  parcelsCount,
  parcelsCounties,
  parcelsOwnersCount,
  parcelsQueryDb,
  parcelsSampleDb,
  parcelsSummaryDb,
} from '../parcels/query.js';
import type { ParcelFilters } from '../parcels/filters.js';
import { parcelsToCsv } from '../services/parcels.js';
import { syncParcelsToSupabase } from '../services/syncToSupabase.js';

export const parcelsRouter = Router();

function queryFrom(req: { query: Record<string, unknown>; body?: Record<string, unknown> }) {
  const src = { ...req.query, ...(req.body ?? {}) };
  return {
    county: src.county != null ? String(src.county) : undefined,
    owner_name: src.owner_name != null ? String(src.owner_name) : undefined,
    city: src.city != null ? String(src.city) : undefined,
    zip: src.zip != null ? String(src.zip) : undefined,
    use_code: src.use_code != null ? String(src.use_code) : undefined,
    owner_type: src.owner_type != null ? String(src.owner_type) : undefined,
    state: src.state != null ? String(src.state) : undefined,
    min_assessed_value:
      src.min_assessed_value != null ? Number(src.min_assessed_value) : undefined,
    owner_or_church: src.owner_or_church === 'true' || src.owner_or_church === true,
    is_church: src.is_church == null ? undefined : src.is_church === 'true' || src.is_church === true,
    improved: src.improved == null ? undefined : src.improved === 'true' || src.improved === true,
    state_use_code: src.state_use_code != null ? String(src.state_use_code) : undefined,
    max_miles_from_dallas:
      src.max_miles_from_dallas != null ? Number(src.max_miles_from_dallas) : undefined,
    client_tag: src.client_tag != null ? String(src.client_tag) : undefined,
    q: src.q != null ? String(src.q) : undefined,
    page: src.page != null ? Number(src.page) : undefined,
    page_size: src.page_size != null ? Number(src.page_size) : undefined,
  };
}

parcelsRouter.get('/counties', async (_req, res, next) => {
  try {
    res.json(await parcelsCounties());
  } catch (err) {
    next(err);
  }
});

parcelsRouter.get('/summary', async (req, res, next) => {
  try {
    res.json(await parcelsSummaryDb(queryFrom(req) as ParcelFilters));
  } catch (err) {
    next(err);
  }
});

parcelsRouter.get('/count', async (req, res, next) => {
  try {
    res.json(await parcelsCount(queryFrom(req) as ParcelFilters));
  } catch (err) {
    next(err);
  }
});

parcelsRouter.get('/owners-count', async (req, res, next) => {
  try {
    res.json(await parcelsOwnersCount(queryFrom(req) as ParcelFilters));
  } catch (err) {
    next(err);
  }
});

parcelsRouter.post('/load', async (req, res) => {
  try {
    const county = String(req.body?.county || req.query.county || '');
    const state = req.body?.state != null ? String(req.body.state) : 'TX';
    const result = await loadCounty(county, state);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'load failed' });
  }
});

parcelsRouter.get('/sample', async (req, res, next) => {
  try {
    const n = req.query.n != null ? Number(req.query.n) : 20;
    res.json(await parcelsSampleDb(n, queryFrom(req) as ParcelFilters));
  } catch (err) {
    next(err);
  }
});

parcelsRouter.get('/export.csv', async (req, res, next) => {
  try {
  const q = queryFrom(req) as ParcelFilters;
  const pageSize = 50;
  let page = 1;
  const items = [];
  for (;;) {
    const batch = await parcelsQueryDb({ ...q, page, page_size: pageSize });
    items.push(...batch.items);
    if (page >= batch.total_pages || items.length >= 5000) break;
    page += 1;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="parcels.csv"');
  res.send(parcelsToCsv(items.slice(0, 5000)));
  } catch (err) {
    next(err);
  }
});

parcelsRouter.post('/sync-to-supabase', async (req, res) => {
  try {
    const result = await syncParcelsToSupabase(queryFrom(req));
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sync failed' });
  }
});

parcelsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await parcelsQueryDb(queryFrom(req) as ParcelFilters));
  } catch (err) {
    next(err);
  }
});
