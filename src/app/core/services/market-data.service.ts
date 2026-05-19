import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  LivePriceDto,
  CandleDto,
  CandleCoverageDto,
  OrderBookSnapshotDto,
  MarketAnalysisResultDto,
  MarketMacroAnalysisResultDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly api = inject(ApiService);

  getLivePrice(symbol: string): Observable<ResponseData<LivePriceDto>> {
    return this.api.get(`/market-data/live-price/${this.formatSymbol(symbol)}`);
  }

  getLatestCandle(symbol: string, timeframe: string): Observable<ResponseData<CandleDto>> {
    return this.api.get(
      `/market-data/candle/latest?symbol=${this.formatSymbol(symbol)}&timeframe=${timeframe}`,
    );
  }

  listCandles(params: PagerRequest): Observable<ResponseData<PagedData<CandleDto>>> {
    return this.api.post(`/market-data/candle/list`, params);
  }

  getCandleCoverage(
    symbol: string,
    timeframe: string,
    fromIso?: string,
    toIso?: string,
  ): Observable<ResponseData<CandleCoverageDto>> {
    const params = new URLSearchParams({
      symbol: this.formatSymbol(symbol),
      timeframe,
    });
    if (fromIso) params.set('from', fromIso);
    if (toIso) params.set('to', toIso);
    return this.api.get(`/market-data/candle/coverage?${params.toString()}`);
  }

  getLatestOrderBook(symbol: string): Observable<ResponseData<OrderBookSnapshotDto>> {
    return this.api.get(`/market-data/order-book/latest/${this.formatSymbol(symbol)}`);
  }

  getRecentOrderBooks(
    symbol: string,
    limit = 120,
  ): Observable<ResponseData<OrderBookSnapshotDto[]>> {
    return this.api.get(
      `/market-data/order-book/recent?symbol=${this.formatSymbol(symbol)}&limit=${limit}`,
    );
  }

  /**
   * POST /market-data/analyze — gathers the engine's canonical view
   * (candles + regime + order book + liquidity history + economic
   * events + sentiment) and asks the active deep-tier LLM for a
   * structured spot analysis. Writes an LlmInvocation audit row
   * tagged `market_analysis.spot`.
   */
  analyzeMarket(
    symbol: string,
    timeframe: string,
    generateSignals = false,
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    return this.api.post(`/market-data/analyze`, {
      symbol: this.formatSymbol(symbol),
      timeframe,
      // When true the engine persists every viable recommendation as a live
      // trade signal (sentinel-owned, SpotAnalysis source). Default false.
      generateSignals,
    });
  }

  /**
   * GET /market-data/analyze/latest — most recent COMPLETED spot analysis
   * for a (symbol, timeframe), replayed server-side from the stored
   * LlmInvocation audit row. NO new LLM call / no spend. Used to default
   * the chart's recommendation bubble to the last real analysis on load /
   * pair switch. Failed response (code -14) when the pair was never analysed.
   */
  getLatestAnalysis(
    symbol: string,
    timeframe: string,
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    const qs = new URLSearchParams({
      symbol: this.formatSymbol(symbol),
      timeframe,
    }).toString();
    return this.api.get(`/market-data/analyze/latest?${qs}`);
  }

  /**
   * POST /market-data/analyze-macro — the LONGER-HORIZON sibling of
   * {@link analyzeMarket}. Anchors on a ~12-month D1 window + COT positioning
   * + the next ~14d of High-impact events (no order book / microstructure)
   * and asks the deep-tier LLM for a multi-week → multi-month positional
   * view. Writes an LlmInvocation audit row tagged `market_analysis.macro`.
   * Materially costlier than spot per call — invoked deliberately.
   */
  analyzeMacro(
    symbol: string,
    timeframe: string,
  ): Observable<ResponseData<MarketMacroAnalysisResultDto>> {
    return this.api.post(`/market-data/analyze-macro`, {
      symbol: this.formatSymbol(symbol),
      timeframe,
    });
  }

  private formatSymbol(symbol: string): string {
    return symbol.replace(/\//g, '');
  }
}
