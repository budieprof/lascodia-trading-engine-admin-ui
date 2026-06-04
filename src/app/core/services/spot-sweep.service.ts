import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { delay, map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import {
  DEFAULT_SWEEP_CONFIG,
  SpotSweepConfig,
  SpotSweepStatus,
  SweepHistoryItem,
} from '@features/spot-sweep/spot-sweep.types';

/**
 * Data access for the Spot Sweep cockpit — the autonomous spot-analysis loop's
 * persisted config and runtime status. See docs/SPOT_SWEEP_PLAN.md.
 *
 * The engine endpoints (`/market-data/spot-sweep/*`) are not built yet, so the
 * cockpit runs against an in-memory mock while {@link USE_MOCK} is true. Flip
 * it to false once the engine ships the contract in §4 of the plan; the real
 * branches below already speak the intended envelope shapes.
 */
@Injectable({ providedIn: 'root' })
export class SpotSweepService {
  private readonly api = inject(ApiService);

  /** Engine endpoints are live — cockpit talks to the real API. */
  private static readonly USE_MOCK = false;

  // ── Mock state (session-scoped) ──────────────────────────────────
  private readonly mockConfig$ = new BehaviorSubject<SpotSweepConfig>({
    ...DEFAULT_SWEEP_CONFIG,
    pairs: [
      { symbol: 'EURUSD', timeframe: 'H1' },
      { symbol: 'GBPUSD', timeframe: 'H1' },
      { symbol: 'USDJPY', timeframe: 'H1' },
    ],
  });

  getConfig(): Observable<SpotSweepConfig> {
    if (SpotSweepService.USE_MOCK) {
      return this.mockConfig$.pipe(
        map((c) => structuredClone(c)),
        delay(120),
      );
    }
    return this.api.getEnvelope<SpotSweepConfig>('/market-data/spot-sweep/config');
  }

  saveConfig(config: SpotSweepConfig): Observable<SpotSweepConfig> {
    if (SpotSweepService.USE_MOCK) {
      const next = structuredClone(config);
      this.mockConfig$.next(next);
      return of(structuredClone(next)).pipe(delay(180));
    }
    return this.api.putEnvelope<SpotSweepConfig>('/market-data/spot-sweep/config', config);
  }

  getStatus(): Observable<SpotSweepStatus> {
    if (SpotSweepService.USE_MOCK) {
      return of(this.mockStatus()).pipe(delay(120));
    }
    return this.api.getEnvelope<SpotSweepStatus>('/market-data/spot-sweep/status');
  }

  /**
   * Recent sweep cycles for the history table. Real impl reads the Spot
   * Analysis report filtered to the sweep source (see SPOT_SWEEP_PLAN.md §2);
   * a dedicated `/spot-sweep/history` endpoint keeps the cockpit decoupled.
   */
  getHistory(limit = 15): Observable<SweepHistoryItem[]> {
    if (SpotSweepService.USE_MOCK) {
      return of(this.mockHistory(limit)).pipe(delay(140));
    }
    return this.api.getEnvelope<SweepHistoryItem[]>(
      `/market-data/spot-sweep/history?limit=${limit}`,
    );
  }

  /**
   * Synthesises a believable status from the current mock config so the
   * cockpit animates (cycles through the configured pairs every ~6s).
   */
  private mockStatus(): SpotSweepStatus {
    const cfg = this.mockConfig$.value;
    const pairs = cfg.pairs;
    const running = cfg.enabled && pairs.length > 0;

    if (!running) {
      return {
        running: false,
        phase: 'Idle',
        idleReason: !cfg.enabled ? 'Sweep disabled' : 'No pairs configured',
        currentSymbol: null,
        startedAt: null,
        nextEligibleSymbol: pairs[0]?.symbol ?? null,
        lastResult: null,
        today: this.emptyCounters(),
        killSwitchActive: false,
        eligibleCount: pairs.length,
        excludedCount: 0,
      };
    }

    const tick = Math.floor(Date.now() / 6000);
    const i = tick % pairs.length;
    const current = pairs[i];
    const prev = pairs[(i - 1 + pairs.length) % pairs.length];
    const autoApproved = cfg.autoApprove && cfg.minConfidence <= 0.75;

    return {
      running: true,
      phase: tick % 2 === 0 ? 'Analyzing' : 'Cooldown',
      idleReason: null,
      currentSymbol: current.symbol,
      startedAt: new Date(tick * 6000).toISOString(),
      nextEligibleSymbol: pairs[(i + 1) % pairs.length].symbol,
      lastResult: {
        symbol: prev.symbol,
        outcome: 'SignalCreated',
        signalId: 4200 + tick,
        orderId: autoApproved ? 8800 + tick : null,
        autoApproved,
        costUsd: 0.012,
        at: new Date(tick * 6000).toISOString(),
      },
      today: {
        analyses: 6 + (tick % 12),
        signalsCreated: 3 + (tick % 6),
        ordersPlaced: autoApproved ? 2 + (tick % 4) : 0,
        autoApproved: autoApproved ? 2 + (tick % 4) : 0,
        manualPending: autoApproved ? 1 : 3 + (tick % 4),
        gateRejected: tick % 3,
        costUsd: +(0.012 * (6 + (tick % 12))).toFixed(3),
      },
      killSwitchActive: false,
      eligibleCount: pairs.length,
      excludedCount: 0,
    };
  }

  private mockHistory(limit: number): SweepHistoryItem[] {
    const cfg = this.mockConfig$.value;
    const pairs = cfg.pairs.length ? cfg.pairs : [{ symbol: 'EURUSD', timeframe: 'H1' }];
    const outcomes = ['SignalCreated', 'NoSignal', 'GateRejected', 'SignalCreated', 'Skipped'];
    const base = Math.floor(Date.now() / 6000) * 6000;
    const step = Math.max(5, cfg.intervalSeconds) * 1000;
    const items: SweepHistoryItem[] = [];
    for (let k = 0; k < limit; k++) {
      const p = pairs[k % pairs.length];
      const outcome = outcomes[k % outcomes.length];
      const created = outcome === 'SignalCreated';
      const autoApproved = created && cfg.autoApprove && cfg.minConfidence <= 0.75 && k % 2 === 0;
      items.push({
        id: 5000 - k,
        at: new Date(base - k * step).toISOString(),
        symbol: p.symbol,
        timeframe: p.timeframe,
        outcome,
        confidence: created ? +(0.6 + ((k * 7) % 35) / 100).toFixed(2) : null,
        signalId: created ? 4200 - k : null,
        orderId: autoApproved ? 8800 - k : null,
        autoApproved,
        mode: cfg.mode,
        costUsd: +(0.01 + (k % 5) * 0.002).toFixed(3),
      });
    }
    return items;
  }

  private emptyCounters() {
    return {
      analyses: 0,
      signalsCreated: 0,
      ordersPlaced: 0,
      autoApproved: 0,
      manualPending: 0,
      gateRejected: 0,
      costUsd: 0,
    };
  }
}
