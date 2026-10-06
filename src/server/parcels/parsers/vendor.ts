import type { CountyConfig } from '../countyTypes.js';
import type { RawParcel } from '../normalize.js';

/**
 * Slot for a national parcel vendor (ReportAll, Regrid, or similar).
 * The adapter interface accepts source_type vendor_api and returns the same
 * normalized row as every other county. This build does not call a vendor.
 */
export async function openVendor(_county: CountyConfig): Promise<{
  rows: AsyncGenerator<RawParcel>;
  sourceFileDate: string | null;
  sourceFileName: string | null;
  rowsDownloaded: () => number;
}> {
  throw new Error(
    'source_type vendor_api is not wired. No vendor request was sent. Register a free bulk source or set status to needs_request.',
  );
}
