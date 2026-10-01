import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, of } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  FUNDAMENTAL_PANES,
  stepDifference,
  swapPerLotSeries,
  utcMs,
  type CarrySeriesDto,
  type FundamentalPaneInfo,
  type NewsPressurePointDto,
  type PanePoint,
  type SurpriseIndexDto,
} from './fx-fundamentals';

export interface CarryPanes {
  raw: CarrySeriesDto;
  /** Base − quote policy rate, percent (step series). */
  differential: PanePoint[];
  /** Per lot per night in the quote currency; empty when the swap model is unavailable. */
  swapLong: PanePoint[];
  swapShort: PanePoint[];
  /** Why the swap panes are empty, when they are. */
  swapIssue: string | null;
}

/**
 * Data providers for the chart's FX fundamentals panes. Every series comes from
 * a real engine endpoint; COT is reported unavailable rather than invented.
 */
@Injectable({ providedIn: 'root' })
export class FxFundamentalsService {
  private readonly api = inject(ApiService);

  readonly panes: readonly FundamentalPaneInfo[] = FUNDAMENTAL_PANES;

  /** GET /fx-fundamentals/carry?symbol= — raw differential + swap model. */
  carry(symbol: string): Observable<CarrySeriesDto> {
    return this.api.getEnvelope<CarrySeriesDto>(
      `/fx-fundamentals/carry?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    );
  }

  /** Base − quote policy-rate differential, percent. */
  rateDifferential(symbol: string): Observable<PanePoint[]> {
    return this.carry(symbol).pipe(
      map((c) => c.differential.map((p) => ({ time: utcMs(p.timeUtc), value: p.differentialPct }))),
    );
  }

  /**
   * Differential plus swap per lot per night (quote currency), priced at each
   * daily close in `dailyBars` (ascending, ms).
   */
  carryPanes(symbol: string, dailyBars: readonly { time: number; close: number }[]): Observable<CarryPanes> {
    return this.carry(symbol).pipe(
      map((raw) => {
        const differential = raw.differential.map((p) => ({ time: utcMs(p.timeUtc), value: p.differentialPct }));
        const swap = raw.swap;
        if (!swap || !swap.calibrated) {
          return {
            raw,
            differential,
            swapLong: [],
            swapShort: [],
            swapIssue: swap?.issue ?? 'no broker swap stored for the symbol',
          };
        }
        const { long, short } = swapPerLotSeries(swap.points, swap.contractSize, dailyBars);
        return { raw, differential, swapLong: long, swapShort: short, swapIssue: null };
      }),
    );
  }

  /** GET /news-intel/timeseries — one currency's weighted pressure score. */
  newsPressure(currency: string, hours = 24 * 30): Observable<PanePoint[]> {
    return this.api
      .getEnvelope<NewsPressurePointDto[]>(
        `/news-intel/timeseries?currency=${encodeURIComponent(currency.toUpperCase())}&hours=${hours}`,
      )
      .pipe(map((pts) => (pts ?? []).map((p) => ({ time: utcMs(p.asOfUtc), value: p.weightedScore }))));
  }

  /** Base − quote news pressure (step difference of the two roll-up series). */
  newsPressureDifference(base: string, quote: string, hours = 24 * 30): Observable<PanePoint[]> {
    return forkJoin([this.newsPressure(base, hours), this.newsPressure(quote, hours)]).pipe(
      map(([a, b]) => stepDifference(a, b)),
    );
  }

  /** GET /fx-fundamentals/surprise-index — raw response. */
  surpriseIndexRaw(
    currency: string,
    opts: { days?: number; halfLifeDays?: number; preReleaseOnly?: boolean } = {},
  ): Observable<SurpriseIndexDto> {
    const q = new URLSearchParams({
      currency: currency.toUpperCase(),
      days: String(opts.days ?? 365),
      halfLifeDays: String(opts.halfLifeDays ?? 30),
      preReleaseOnly: String(opts.preReleaseOnly ?? false),
    });
    return this.api.getEnvelope<SurpriseIndexDto>(`/fx-fundamentals/surprise-index?${q.toString()}`);
  }

  /** Economic surprise index for one currency. */
  surpriseIndex(
    currency: string,
    opts: { days?: number; halfLifeDays?: number; preReleaseOnly?: boolean } = {},
  ): Observable<PanePoint[]> {
    return this.surpriseIndexRaw(currency, opts).pipe(
      map((d) => d.points.map((p) => ({ time: utcMs(p.timeUtc), value: p.index }))),
    );
  }

  /** COT positioning is not ingested engine-side — always empty, with the pane marked unavailable. */
  cot(): Observable<PanePoint[]> {
    return of([]);
  }
}
