import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  AnalysisMonitorDto,
  MarketAnalysisResultDto,
  ResponseData,
} from '@core/api/api.types';
import { MarketDataService } from '@core/services/market-data.service';

import type { ChartAlertDto } from '../alerts/chart-alerts.types';
import type {
  AnalysisRequestMode,
  ChartAnalysisMonitors,
  StructureWatchRequest,
} from './chart-analysis.types';

/**
 * The engine side of analysis on the chart (SP-I5). Every call goes through the existing analysis and monitor paths:
 * a chart analysis is the same `market_analysis.*` run the spot-analysis modal makes (it never files a signal from
 * here — `generateSignals` stays false), and "Watch this" is the same monitor create the cockpit uses.
 */
@Injectable({ providedIn: 'root' })
export class ChartAnalysisService {
  private readonly api = inject(ApiService);
  private readonly marketData = inject(MarketDataService);

  /**
   * Run an analysis now. Spot is the free patient analysis (TRADE NOW / WATCH / STAND ASIDE — a WATCH arms its own
   * watch); the four directed modes pin the side and the order type. Costs one LLM call.
   */
  analyse(
    symbol: string,
    timeframe: string,
    mode: AnalysisRequestMode,
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    switch (mode) {
      case 'spot':
        return this.marketData.analyzeMarket(symbol, timeframe, false);
      case 'limitBuy':
        return this.marketData.proposeLimit(symbol, timeframe, 'Buy');
      case 'limitSell':
        return this.marketData.proposeLimit(symbol, timeframe, 'Sell');
      case 'stopBuy':
        return this.marketData.proposeStop(symbol, timeframe, 'Buy');
      case 'stopSell':
        return this.marketData.proposeStop(symbol, timeframe, 'Sell');
    }
  }

  /** The newest finished spot analysis of the pair, replayed from its stored audit row. No LLM call. */
  latest(symbol: string, timeframe: string): Observable<ResponseData<MarketAnalysisResultDto>> {
    return this.marketData.getLatestAnalysis(symbol, timeframe);
  }

  /** `GET market-data/analysis-monitors/chart` — the symbol's watches, their levels and their events in the window. */
  monitors(
    symbol: string,
    fromUtcMs: number | null,
    toUtcMs: number | null,
    limit = 40,
  ): Observable<ResponseData<ChartAnalysisMonitors>> {
    const p = new URLSearchParams({ symbol: symbol.replace(/\//g, ''), limit: String(limit) });
    if (fromUtcMs !== null) p.set('fromUtc', new Date(fromUtcMs).toISOString());
    if (toUtcMs !== null) p.set('toUtc', new Date(toUtcMs).toISOString());
    return this.api.get(`/market-data/analysis-monitors/chart?${p.toString()}`, { silent: true });
  }

  /** `GET chart-alert` — every chart alert of the operator (the assistant's `chart.alerts.list` filters the symbol). */
  alerts(): Observable<ResponseData<ChartAlertDto[]>> {
    return this.api.get('/chart-alert', { silent: true });
  }

  /** `POST market-data/analysis-monitors` with a Structure Watch script. The engine checks the script before arming. */
  createStructureWatch(body: StructureWatchRequest): Observable<ResponseData<AnalysisMonitorDto>> {
    return this.api.post('/market-data/analysis-monitors', body);
  }
}
