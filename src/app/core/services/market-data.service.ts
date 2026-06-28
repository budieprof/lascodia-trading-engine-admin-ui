import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  AccountLivePriceDto,
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

  /**
   * GET /market-data/account-live-price/{tradingAccountId}/{symbol} —
   * account-aware bid/ask. Layers the per-(account, symbol) live spread
   * from SpreadStateStore on the symbol tick cache so the Ask reflects
   * this account's broker, not whichever broker last fed the symbol cache.
   * Drives the chart modal's Now·Bid / Now·Ask markLines.
   */
  getAccountLivePrice(
    tradingAccountId: number,
    symbol: string,
  ): Observable<ResponseData<AccountLivePriceDto>> {
    return this.api.get(
      `/market-data/account-live-price/${tradingAccountId}/${this.formatSymbol(symbol)}`,
    );
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
    barPosition = 'closed',
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    return this.api.post(`/market-data/analyze`, {
      symbol: this.formatSymbol(symbol),
      timeframe,
      // When true the engine persists every viable recommendation as a live
      // trade signal (sentinel-owned, SpotAnalysis source). Default false.
      generateSignals,
      // Where in the current bar we're firing — `closed` (just after close,
      // default), `mid_25`, `mid_50`, `mid_75`. The engine reads this to
      // frame the prompt so the model treats partial-bar OHLC correctly.
      barPosition,
    });
  }

  /**
   * POST /market-data/propose-limit — directed limit-proposal variant of
   * {@link analyzeMarket}. The operator pins a direction (`Buy` or `Sell`)
   * and the LLM is constrained to optimise Entry / SL / TP for a pending
   * limit order in that direction — entry must be on the limit side of
   * the latest close (below for Buy, above for Sell), or the engine
   * filters the rec out and returns a "no viable proposal" error.
   *
   * Same result shape as {@link analyzeMarket} so the modal renders it
   * with the existing `rec-card` and the Create signal button works
   * transparently — the persist-signal endpoint accepts either
   * `market_analysis.spot` or `market_analysis.limit_proposal`.
   */
  proposeLimit(
    symbol: string,
    timeframe: string,
    direction: 'Buy' | 'Sell',
    barPosition = 'closed',
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    return this.api.post(`/market-data/propose-limit`, {
      symbol: this.formatSymbol(symbol),
      timeframe,
      barPosition,
      // The operator's directional choice — the engine pins the LLM to
      // this and validates the response shape (direction + limit-side
      // entry) before returning.
      limitProposalDirection: direction,
    });
  }

  /**
   * POST /market-data/propose-stop — directed STOP-proposal variant of
   * {@link analyzeMarket}, sibling of {@link proposeLimit}. The operator
   * pins a direction (`Buy` or `Sell`) and the LLM is constrained to
   * optimise Entry / SL / TP for a pending stop order in that direction
   * — entry must be on the STOP side of the latest close (above for
   * Buy = breakout above resistance, below for Sell = breakdown below
   * support), or the engine filters the rec out and returns a "no
   * viable proposal" envelope.
   *
   * Same result shape as {@link analyzeMarket}; the modal renders it
   * with a "Stop proposal" badge and the Create signal button works
   * transparently — the persist-signal endpoint accepts
   * `market_analysis.stop_proposal` alongside spot and limit.
   */
  proposeStop(
    symbol: string,
    timeframe: string,
    direction: 'Buy' | 'Sell',
    barPosition = 'closed',
  ): Observable<ResponseData<MarketAnalysisResultDto>> {
    return this.api.post(`/market-data/propose-stop`, {
      symbol: this.formatSymbol(symbol),
      timeframe,
      barPosition,
      stopProposalDirection: direction,
    });
  }

  /**
   * POST /market-data/analyze/{llmInvocationId}/persist-signal — promote one
   * recommendation from an existing spot analysis into a live TradeSignal.
   * Mirrors the engine's auto-gen path (sentinel strategy + SpotAnalysis
   * source + LlmInvocationId provenance + 3-bar TTL) but flags IsManual=true.
   *
   * The "Create signal" button on the spot-analysis modal — used when the
   * auto-gen toggle was off at analyse time and the operator still wants to
   * file the rec without re-running the LLM call. Returns the new signal id
   * in `data` on success, or a failed envelope (-12 / -14) on invalid index,
   * missing analysis, or already-persisted recommendation.
   */
  persistSignalFromAnalysis(
    llmInvocationId: number,
    recommendationIndex = 0,
  ): Observable<ResponseData<number>> {
    const qs = new URLSearchParams({ recommendationIndex: String(recommendationIndex) }).toString();
    return this.api.post(`/market-data/analyze/${llmInvocationId}/persist-signal?${qs}`, {});
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
