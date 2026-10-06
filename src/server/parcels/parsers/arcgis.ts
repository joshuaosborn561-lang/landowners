import type { CountyConfig } from '../countyTypes.js';
import { dateFromText } from '../download.js';
import type { RawParcel } from '../normalize.js';
import { mapGisRecord } from './gisFields.js';

export async function openArcgis(county: CountyConfig): Promise<{
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}> {
  if (!county.source_url) throw new Error(`${county.name} has no GIS source_url`);
  const pageSize = county.page_size ?? 2000;
  const meta = { downloaded: 0, sourceFileDate: null as string | null };

  async function* rows(): AsyncGenerator<RawParcel> {
    let offset = 0;
    for (;;) {
      const url = new URL(county.source_url!);
      url.searchParams.set('where', '1=1');
      url.searchParams.set('outFields', '*');
      url.searchParams.set('returnGeometry', 'false');
      url.searchParams.set('f', 'json');
      url.searchParams.set('resultOffset', String(offset));
      url.searchParams.set('resultRecordCount', String(pageSize));
      const response = await fetch(url, { headers: { 'user-agent': 'permits-gcs-parcel-loader/2' } });
      if (!response.ok) throw new Error(`ArcGIS HTTP ${response.status} for ${county.name}`);
      const body = (await response.json()) as {
        error?: { message?: string };
        exceededTransferLimit?: boolean;
        features?: Array<{ attributes?: Record<string, unknown> }>;
        editingInfo?: { dataLastEditDate?: number };
      };
      if (body.error) throw new Error(body.error.message || `ArcGIS error for ${county.name}`);
      if (!meta.sourceFileDate && body.editingInfo?.dataLastEditDate) {
        meta.sourceFileDate = dateFromText(new Date(body.editingInfo.dataLastEditDate).toISOString());
      }
      const features = body.features ?? [];
      meta.downloaded += features.length;
      for (const feature of features) yield mapGisRecord(feature.attributes ?? {}, county.field_map);
      if (features.length < pageSize) break;
      offset += features.length;
      if (offset > 2_000_000) throw new Error(`${county.name} ArcGIS page offset exceeded 2000000`);
    }
  }

  return {
    rows: rows(),
    get sourceFileDate() {
      return meta.sourceFileDate;
    },
    sourceFileName: null,
    rowsDownloaded: () => meta.downloaded,
  };
}
