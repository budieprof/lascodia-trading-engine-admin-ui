import { Injectable, inject } from '@angular/core';
import { HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  AnalyserComparisonSummaryDto,
  LookAheadAuditReport,
  Timeframe,
} from '@core/api/api.types';

/**
 * Data access for the Analyser Comparison surface — the A/B view between
 * the LLM analyser and the non-LLM Synthetic Analyser, plus the operator-
 * runnable look-ahead-bias audit suite.
 */
@Injectable({ providedIn: 'root' })
export class AnalyserComparisonService {
  private readonly api = inject(ApiService);

  /**
   * Per-source aggregate summary. Defaults to a 30-day window on the server
   * when from/to are omitted.
   */
  getSummary(filter: {
    symbol?: string;
    timeframe?: Timeframe;
    fromUtc?: string;
    toUtc?: string;
  }): Observable<ResponseData<AnalyserComparisonSummaryDto>> {
    let params = new HttpParams();
    if (filter.symbol) params = params.set('symbol', filter.symbol);
    if (filter.timeframe) params = params.set('timeframe', filter.timeframe);
    if (filter.fromUtc) params = params.set('fromUtc', filter.fromUtc);
    if (filter.toUtc) params = params.set('toUtc', filter.toUtc);
    const qs = params.toString();
    return this.api.get(`/market-data/analyser-comparison/summary${qs ? `?${qs}` : ''}`);
  }

  /**
   * Run the T1–T5 look-ahead-bias audit suite for one (symbol, timeframe).
   * `sampleAt` defaults to UtcNow on the server when omitted.
   */
  runAudit(args: {
    symbol: string;
    timeframe: Timeframe;
    sampleAt?: string;
  }): Observable<ResponseData<LookAheadAuditReport>> {
    let params = new HttpParams().set('symbol', args.symbol).set('timeframe', args.timeframe);
    if (args.sampleAt) params = params.set('sampleAt', args.sampleAt);
    return this.api.get(`/synthetic-analyser-audit?${params.toString()}`);
  }
}
