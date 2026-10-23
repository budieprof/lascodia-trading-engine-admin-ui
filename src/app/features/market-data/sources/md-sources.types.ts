/**
 * Wire shapes of the market-data source registry for platform staff (engine C7 + venue-tier3,
 * `GET/POST admin/md/sources`, `PUT admin/md/sources/{sourceId}` — `platform.data.manage`).
 */

/** `Mt5Broker`, `CmeFutures` or `FixVenue`. */
export type MdSourceKind = 'Mt5Broker' | 'CmeFutures' | 'FixVenue' | string;

export interface MarketDataSourceAdmin {
  sourceId: string;
  kind: MdSourceKind;
  displayName: string;
  /** The entitlement feed guarding the source (`broker-ticks`, `cme-l2`, `venue:<id>`, …). */
  feedId: string;
  enabled: boolean;
  /** `Lots`, `Units` or `Contracts`. */
  sizeUnit: string;
  contractSize: number;
  /** `None` or `Invert`. */
  priceTransform: string;
  /** Engine symbol → source symbol. */
  symbolMap: Record<string, string>;
  brokerServer: string | null;
  /** Machine instance ids allowed to write this source (MT5 rows: the engine decides). */
  writerInstanceIds: string[];
  createdAtUtc: string;
  updatedAtUtc: string;
}

/** `PUT admin/md/sources/{sourceId}` — only what changes. */
export interface UpdateMarketDataSourceBody {
  enabled?: boolean;
  writerInstanceIds?: string[];
  displayName?: string;
  symbolMap?: Record<string, string>;
  contractSize?: number;
  reason?: string;
}

/** `POST admin/md/sources` — register an FX venue (`venue-<venueId>`, feed `venue:<venueId>`), disabled. */
export interface CreateVenueSourceBody {
  venueId: string;
  displayName: string;
  symbolMap?: Record<string, string>;
  writerInstanceIds?: string[];
  reason?: string;
}
