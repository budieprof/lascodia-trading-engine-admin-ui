import { signal, type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { OrderDto } from '@core/api/api.types';
import type { PositionsService } from '@core/services/positions.service';
import type { OrdersService } from '@core/services/orders.service';
import type { TradeSignalsService } from '@core/services/trade-signals.service';
import type { MartingaleService } from '@core/services/martingale.service';
import type { ChartMarker } from '../../chart/chart-host.component';
import type { ChartPosition } from '../../overlays/trade-layer';

export interface TradeLayersDeps {
  symbol(): string;
  accountScope: { accountIds(): readonly number[]; accountIdsKey(): string };
  showPositions(): boolean;
  showOrders(): boolean;
  showClosedTrades(): boolean;
  showOverlays(): boolean;
  /** The account scope as a filter (the martingale chains are per account). */
  inTradeScope(): (accountId: number | null | undefined) => boolean;
  positions: Pick<PositionsService, 'list'>;
  orders: Pick<OrdersService, 'list'>;
  signals: Pick<TradeSignalsService, 'list'>;
  martingale: Pick<MartingaleService, 'getOverview'>;
  destroyRef: DestroyRef;
}

/**
 * US02 (from ChartAnalysisPageComponent, behaviour unchanged): the engine state drawn on the chart, each layer held
 * and refreshed on its own — the symbol's open positions, working orders and closed positions as the engine last sent
 * them, and the signal and martingale-rung markers.
 */
export class TradeLayersLoader {
  readonly openPositions = signal<ChartPosition[]>([]);
  readonly workingOrders = signal<OrderDto[]>([]);
  readonly closedPositions = signal<ChartPosition[]>([]);
  readonly signalMarkers = signal<ChartMarker[]>([]);
  readonly rungMarkers = signal<ChartMarker[]>([]);

  constructor(private readonly deps: TradeLayersDeps) {}

  /**
   * Each trade layer's newest request: a reply for an older one — another symbol, another account
   * scope, a toggle since switched off — is dropped (CC-09: a slow EURUSD reply painted EURUSD's
   * stop and target on GBPUSD).
   */
  private readonly loads = { positions: 0, orders: 0, closed: 0, rungs: 0, signals: 0 };

  /**
   * Load this symbol's trade layers onto the chart: open positions, working orders, closed trades,
   * martingale rungs and signals — each only when its toggle is on. Called on a symbol switch, an
   * account switch, a toggle, and whenever the engine reports a fill, a position change or a new
   * signal (realtime, {@link scheduleTradeRefresh}); before CC-09 they loaded once and never
   * followed a fill.
   *
   * Filtered by symbol and account server-side via the nested `filter` object — sent flat the
   * criteria are discarded in silence and the handler answers with page 1 of the whole table — and
   * re-checked here (`positionLines` / `orderLines`).
   */
  load(): void {
    const d = this.deps;
    const symbol = d.symbol();
    // The header's account scope. Positions and orders belong to an account, so only the selected
    // account's are drawn (an aggregate scope draws its accounts'). An empty scope means no live
    // account — draw none rather than falling back to the whole fleet.
    const accountIds = Array.from(d.accountScope.accountIds());
    const accountKey = d.accountScope.accountIdsKey();
    /** The chart still shows what this request was for. */
    const current = () =>
      symbol === d.symbol() && accountKey === d.accountScope.accountIdsKey();
    const loads = this.loads;

    if (!d.showPositions()) {
      loads.positions++;
      this.openPositions.set([]);
    } else {
      const seq = ++loads.positions;
      d.positions
        .list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { symbol, status: 'Open', tradingAccountIds: accountIds },
        })
        .pipe(takeUntilDestroyed(d.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.positions || !current() || !res?.status || !res.data) return;
          this.openPositions.set((res.data.data ?? []) as ChartPosition[]);
        });
    }

    // ── Working orders ────────────────────────────────────────────────────
    //
    // Only orders that can still fill (orderLines). A filled order is already a
    // position and is drawn as one; a cancelled one is history.
    if (!d.showOrders()) {
      loads.orders++;
      this.workingOrders.set([]);
    } else {
      const seq = ++loads.orders;
      d.orders
        .list({
          currentPage: 1,
          itemCountPerPage: 50,
          filter: { symbol, tradingAccountIds: accountIds },
          sortBy: 'id',
          sortDirection: 'desc',
        })
        .pipe(takeUntilDestroyed(d.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.orders || !current() || !res?.status || !res.data) return;
          this.workingOrders.set(res.data.data ?? []);
        });
    }

    // ── Closed trades ─────────────────────────────────────────────────────
    //
    // The most recent closed positions of the symbol in scope; their fills are pinned to the bars
    // they happened in, and those before the loaded history drop off the chart (applyMarkers).
    if (!d.showClosedTrades()) {
      loads.closed++;
      this.closedPositions.set([]);
    } else {
      const seq = ++loads.closed;
      d.positions
        .list({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: { symbol, status: 'Closed', tradingAccountIds: accountIds },
          sortBy: 'openedAt',
          sortDirection: 'desc',
        })
        .pipe(takeUntilDestroyed(d.destroyRef))
        .subscribe((res) => {
          if (seq !== loads.closed || !current() || !res?.status || !res.data) return;
          this.closedPositions.set((res.data.data ?? []) as ChartPosition[]);
        });
    }

    if (!d.showOverlays()) {
      loads.rungs++;
      loads.signals++;
      this.signalMarkers.set([]);
      this.rungMarkers.set([]);
      return;
    }
    const inScope = d.inTradeScope();

    // ── Martingale rungs ──────────────────────────────────────────────────
    //
    // Each closed rung is pinned to the BAR it closed on, not to a price line:
    // a chain's rungs are events in sequence, and stacking six horizontal lines
    // on the price scale buries the candles the operator is reading.
    const rungSeq = ++loads.rungs;
    d.martingale
      .getOverview({ maxChains: 40 })
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe({
        next: (overview) => {
          if (rungSeq !== loads.rungs || !current()) return;
          const chains = (overview?.chains ?? []).filter(
            (c) =>
              (c.symbol ?? '').toUpperCase() === symbol.toUpperCase() &&
              inScope(c.tradingAccountId),
          );
          const marks: ChartMarker[] = [];
          for (const chain of chains) {
            for (const entry of chain.ledger ?? []) {
              const at = Date.parse(entry.closedAtUtc ?? '');
              if (Number.isNaN(at)) continue;
              const loss = String(entry.outcome) === 'Loss';
              marks.push({
                time: at,
                position: 'belowBar',
                shape: 'square',
                color: loss ? '#EF5350' : '#26A69A',
                text: `R${entry.depthAfter}`,
              });
            }
          }
          this.rungMarkers.set(marks);
        },
        // The ladder module can be off entirely; that is not an error worth a
        // toast, it just means there are no rungs to draw.
        error: () => {
          if (rungSeq === loads.rungs) this.rungMarkers.set([]);
        },
      });

    const signalSeq = ++loads.signals;
    d.signals
      .list({
        currentPage: 1,
        itemCountPerPage: 100,
        filter: { symbol },
        sortBy: 'id',
        sortDirection: 'desc',
      })
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe((res) => {
        if (signalSeq !== loads.signals || !current() || !res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter(
          (s) => (s.symbol ?? '').toUpperCase() === symbol.toUpperCase(),
        );
        const marks: ChartMarker[] = [];
        for (const s of rows) {
          const at = Date.parse(s.generatedAt ?? '');
          // A signal with no readable timestamp cannot be pinned to a bar; a
          // NaN time makes the library drop the whole batch silently.
          if (Number.isNaN(at)) continue;
          const long = String(s.direction).toLowerCase().includes('buy');
          marks.push({
            time: at,
            position: long ? 'belowBar' : 'aboveBar',
            shape: long ? 'arrowUp' : 'arrowDown',
            color: long ? '#26A69A' : '#EF5350',
            text: `#${s.id}`,
          });
        }
        this.signalMarkers.set(marks);
      });
  }
}
