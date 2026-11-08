import { signal, type DestroyRef, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, from, map, of, switchMap as switchMapTo, type Observable } from 'rxjs';

import type { ActiveIndicator, ExternalPane } from '../../chart/chart-host.component';
import type { Bar } from '../../datafeed/candle-feed.service';
import type { DailyBarsService } from '../../panels/daily-bars.service';
import { FUNDAMENTAL_PANES, stepDifference, type PanePoint } from '../../panels/fx-fundamentals';
import type { FxFundamentalsService } from '../../panels/fx-fundamentals.service';
import { notApplicable, paneApplies, type PaneScope } from '../../panels/market-panes';
import type { MarketPanesService } from '../../panels/market-panes.service';
import { fundamentalIdOf } from '../../studies';

/** What the fundamentals panes read on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartFundamentalsLoaderDeps {
  paneScope: () => PaneScope;
  bars: () => Bar[];
  /** The page's script / study error line: a pane that could not load says so there. */
  scriptError: () => WritableSignal<string | null>;
  fundamentals: Pick<
    FxFundamentalsService,
    'rateDifferential' | 'carryPanes' | 'newsPressureDifference' | 'surpriseIndex'
  >;
  dailyBars: Pick<DailyBarsService, 'daily'>;
  marketPanes: Pick<MarketPanesService, 'load'>;
  destroyRef: DestroyRef;
}

/**
 * b9-maint — the chart's fundamental studies (FX rate differential, swap carry, news pressure, economic surprise, and the
 * market panes of other asset classes), fetched per symbol and drawn as their own panes; moved out of
 * ChartAnalysisPageComponent behaviour for behaviour. The page aliases {@link panes} as `externalPanes` and calls
 * {@link load} from the same effect.
 */
export class ChartFundamentalsLoader {
  constructor(private readonly deps: ChartFundamentalsLoaderDeps) {}

  /** Fetched FX-fundamental series, keyed by the study's uid. */
  readonly panes = signal<ExternalPane[]>([]);

  private request = 0;

  load(items: ActiveIndicator[], symbol: string): void {
    const d = this.deps;
    const request = ++this.request;
    if (!items.length) {
      this.panes.set([]);
      return;
    }
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    const scope = d.paneScope();
    const loaded = d.bars();
    const window = { from: loaded[0]?.time ?? Date.now() - 7 * 86_400_000, to: Date.now() };
    const one = (a: ActiveIndicator): Observable<ExternalPane> => {
      const id = fundamentalIdOf(a.defId);
      const pane = (lines: ExternalPane['lines']): ExternalPane => ({ uid: a.uid, lines });
      // UA03: a pane saved with a layout on a symbol it does not apply to says why instead of slicing the symbol.
      if (!paneApplies(id, scope)) return of({ uid: a.uid, lines: [], note: notApplicable(id, scope) });
      switch (id) {
        case 'rate-differential':
          return d.fundamentals
            .rateDifferential(symbol)
            .pipe(
              map((pts) =>
                pane([{ title: `${base}−${quote} rate %`, color: '#2962FF', points: pts }]),
              ),
            );
        case 'swap-carry':
          return from(d.dailyBars.daily(symbol)).pipe(
            switchMapTo((daily) => d.fundamentals.carryPanes(symbol, daily)),
            map((c) => {
              if (c.swapIssue) d.scriptError().set(`Swap / carry: ${c.swapIssue}`);
              return pane([
                { title: 'Swap long / lot', color: '#26A69A', points: c.swapLong },
                { title: 'Swap short / lot', color: '#EF5350', points: c.swapShort },
              ]);
            }),
          );
        case 'news-pressure':
          return d.fundamentals
            .newsPressureDifference(base, quote)
            .pipe(
              map((pts) =>
                pane([
                  { title: `News ${base}−${quote}`, color: '#AB47BC', points: pts, precision: 3 },
                ]),
              ),
            );
        case 'economic-surprise': {
          const side = String(a.params['side'] ?? 'base − quote');
          const halfLifeDays = Number(a.params['halfLifeDays'] ?? 30);
          const series = (ccy: string) => d.fundamentals.surpriseIndex(ccy, { halfLifeDays });
          const pts$: Observable<PanePoint[]> =
            side === 'base'
              ? series(base)
              : side === 'quote'
                ? series(quote)
                : forkJoin([series(base), series(quote)]).pipe(
                    map(([x, y]) => stepDifference(x, y)),
                  );
          return pts$.pipe(
            map((pts) =>
              pane([
                {
                  title: `Surprise ${side === 'base − quote' ? `${base}−${quote}` : side === 'base' ? base : quote}`,
                  color: '#FF6D00',
                  points: pts,
                },
              ]),
            ),
          );
        }
        default:
          return from(d.marketPanes.load(id, a.params, scope, window)).pipe(
            map((r) => ({ uid: a.uid, lines: r.lines, stepped: r.stepped, note: r.note })),
          );
      }
    };
    forkJoin(
      items.map((a) =>
        one(a).pipe(
          catchError((err: unknown) => {
            const title = FUNDAMENTAL_PANES.find((f) => f.id === fundamentalIdOf(a.defId))?.title;
            d.scriptError().set(`${title ?? a.defId}: ${err instanceof Error ? err.message : 'unavailable'}`);
            return of({ uid: a.uid, lines: [] } as ExternalPane);
          }),
        ),
      ),
    )
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe((panes) => {
        if (request === this.request) this.panes.set(panes);
      });
  }
}
