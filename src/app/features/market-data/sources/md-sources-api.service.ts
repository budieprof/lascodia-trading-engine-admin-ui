import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type {
  CreateVenueSourceBody,
  MarketDataSourceAdmin,
  MarketDataStoreCoverage,
  UpdateMarketDataSourceBody,
} from './md-sources.types';

const SILENT = { silent: true } as const;

function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/**
 * The market-data source registry for platform staff (`platform.data.manage`): every source with its
 * writers, onboarding an external source (enable, writer machine ids, symbol map, contract size) and
 * registering an FX venue. MT5 broker rows are the engine's (it refuses changes to them). Every change
 * is audited by the engine.
 */
@Injectable({ providedIn: 'root' })
export class MarketDataSourcesApiService {
  private readonly api = inject(ApiService);

  list(): Observable<MarketDataSourceAdmin[]> {
    return settled(
      this.api.get<ResponseData<MarketDataSourceAdmin[]>>('/admin/md/sources', SILENT),
    ).pipe(map((rows) => rows ?? []));
  }

  /** What the store holds per source (engine pages program; a 404 = older engine, the caller absorbs it). */
  coverage(): Observable<MarketDataStoreCoverage> {
    return settled(
      this.api.get<ResponseData<MarketDataStoreCoverage>>('/admin/md/sources/coverage', SILENT),
    );
  }

  update(sourceId: string, body: UpdateMarketDataSourceBody): Observable<MarketDataSourceAdmin> {
    return settled(
      this.api.put<ResponseData<MarketDataSourceAdmin>>(
        `/admin/md/sources/${encodeURIComponent(sourceId)}`,
        body,
        SILENT,
      ),
    );
  }

  createVenue(body: CreateVenueSourceBody): Observable<MarketDataSourceAdmin> {
    return settled(
      this.api.post<ResponseData<MarketDataSourceAdmin>>('/admin/md/sources', body, SILENT),
    );
  }
}
