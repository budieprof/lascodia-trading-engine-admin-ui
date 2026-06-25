import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { EAStatePayload } from '@core/api/api.types';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { SkeletonComponent } from '@shared/components/ui/skeleton/skeleton.component';

/**
 * Renders the EA's rich-state envelope (heartbeat payload — Phase-1 admin)
 * as a grid of small status cards.  Each card has a label, a value, and a
 * color cue derived from the value's operational meaning (green = healthy,
 * amber = degraded, red = halted/critical).  Unknown / missing fields render
 * as "—" rather than failing — keeps the panel forward-compatible with
 * future EA-side schema additions.
 *
 * The envelope itself is intentionally schemaless on the wire so the EA can
 * evolve fields without an engine migration; this component reflects the
 * v8.47.13x set and degrades gracefully when keys are absent.
 */
@Component({
  selector: 'app-ea-state-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RelativeTimePipe, SkeletonComponent],
  template: `
    <section class="panel" aria-label="EA live state">
      <header class="panel-head">
        <h3>Live state</h3>
        <span class="meta">
          @if (lastUpdated()) {
            updated {{ lastUpdated() | relativeTime }} ·
            <span [title]="lastUpdated() | date: 'yyyy-MM-dd HH:mm:ss UTC'">
              {{ lastUpdated() | date: 'HH:mm:ss UTC' }}
            </span>
          } @else if (loading()) {
            <span class="muted">loading…</span>
          } @else {
            <span class="muted">no state envelope yet</span>
          }
        </span>
      </header>

      @if (loading() && !state()) {
        <div class="grid" aria-label="Loading live state" role="status">
          @for (i of skeletonCells(); track i) {
            <article class="cell skeleton-cell">
              <ui-skeleton height="8px" width="8px" borderRadius="50%" />
              <ui-skeleton height="11px" width="62%" borderRadius="4px" />
              <ui-skeleton height="13px" width="46%" borderRadius="4px" />
            </article>
          }
        </div>
      } @else if (!state()) {
        <p class="empty muted">
          This instance hasn't pushed a rich-state envelope yet. The EA tees state into the
          heartbeat starting at v8.47.134 — older builds report only the bare ping. Re-attach to
          pick up the upgrade.
        </p>
      } @else {
        <div class="grid">
          @for (cell of cells(); track cell.key) {
            <article class="cell" [attr.data-tone]="cell.tone">
              <span class="dot" [attr.data-tone]="cell.tone"></span>
              <span class="label">{{ cell.label }}</span>
              <span class="value mono" [class.muted]="cell.value === '—'">{{ cell.value }}</span>
            </article>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .meta {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .empty {
        margin: 0;
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: var(--space-2);
      }
      .cell {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        padding: 10px 12px;
        display: grid;
        grid-template-columns: 8px 1fr auto;
        align-items: center;
        gap: 10px;
        font-size: var(--text-xs);
      }
      .skeleton-cell {
        border-left-color: var(--border);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--border);
      }
      .label {
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: var(--font-medium);
      }
      .value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .cell[data-tone='ok'] {
        border-left-color: #34c759;
      }
      .cell[data-tone='ok'] .dot {
        background: #34c759;
      }
      .cell[data-tone='warn'] {
        border-left-color: #ff9500;
      }
      .cell[data-tone='warn'] .dot {
        background: #ff9500;
      }
      .cell[data-tone='bad'] {
        border-left-color: #ff3b30;
        background: rgba(255, 59, 48, 0.05);
      }
      .cell[data-tone='bad'] .dot {
        background: #ff3b30;
      }
      .cell[data-tone='info'] {
        border-left-color: #0071e3;
      }
      .cell[data-tone='info'] .dot {
        background: #0071e3;
      }
    `,
  ],
})
export class EAStatePanelComponent {
  readonly state = input<EAStatePayload | null>(null);
  readonly lastUpdated = input<string | null>(null);
  /**
   * True while the parent's detail resource is still mid-flight on first
   * load.  Lets the panel show shimmer cells instead of the "no state
   * envelope yet" copy during the initial fetch — that copy is reserved
   * for the legitimate case of an older EA build that never pushes the
   * envelope.
   */
  readonly loading = input(false);

  /** Six placeholder cells while the envelope is in flight. */
  protected readonly skeletonCells = computed(() => Array.from({ length: 6 }, (_, i) => i));

  protected readonly cells = computed((): readonly StateCell[] => {
    const s = this.state();
    if (!s) return [];

    const cells: StateCell[] = [];

    // ── State machine ──
    cells.push({
      key: 'stateMachine',
      label: 'State',
      value: s.stateMachine ?? '—',
      tone: stateMachineTone(s.stateMachine),
    });

    if (s.safetyStopCategory && s.safetyStopCategory !== 'NONE') {
      cells.push({
        key: 'safetyCategory',
        label: 'Stop category',
        // A profit-target stop is a DAILY_RESET that the operator WANTED —
        // surface it as a benign "profit target" reason rather than a fault.
        value:
          s.dailyProfitTargetHit && s.safetyStopCategory === 'DAILY_RESET'
            ? 'DAILY_RESET (profit target)'
            : s.safetyStopCategory,
        tone: s.dailyProfitTargetHit && s.safetyStopCategory === 'DAILY_RESET' ? 'ok' : 'bad',
      });
    }

    if (s.dailyProfitTargetHit) {
      cells.push({
        key: 'profitTarget',
        label: 'Daily profit target',
        value: 'REACHED',
        tone: 'ok',
      });
    }

    cells.push({
      key: 'killSwitch',
      label: 'Kill switch',
      value: s.killSwitchActive == null ? '—' : s.killSwitchActive ? 'ACTIVE' : 'off',
      tone: s.killSwitchActive ? 'bad' : 'ok',
    });

    cells.push({
      key: 'globalStop',
      label: 'Global safety stop',
      value: s.globalSafetyStop == null ? '—' : s.globalSafetyStop ? 'TRIPPED' : 'off',
      tone: s.globalSafetyStop ? 'bad' : 'ok',
    });

    cells.push({
      key: 'broker',
      label: 'Broker conn.',
      value: s.brokerConnected == null ? '—' : s.brokerConnected ? 'connected' : 'down',
      tone: s.brokerConnected ? 'ok' : 'bad',
    });

    cells.push({
      key: 'coordinator',
      label: 'Coordinator',
      value: s.isCoordinator == null ? '—' : s.isCoordinator ? 'yes' : 'no',
      tone: 'info',
    });

    cells.push({
      key: 'httpCircuit',
      label: 'HTTP circuit',
      value: s.httpCircuitOpen == null ? '—' : s.httpCircuitOpen ? 'OPEN' : 'closed',
      tone: s.httpCircuitOpen ? 'bad' : 'ok',
    });

    cells.push({
      key: 'deadMan',
      label: "Dead-man's switch",
      value: s.deadManSwitchArmed == null ? '—' : s.deadManSwitchArmed ? 'ARMED' : 'safe',
      tone: s.deadManSwitchArmed ? 'bad' : 'ok',
    });

    // ── Counters ──
    cells.push({
      key: 'engineFailures',
      label: 'Engine fails (consec.)',
      value: s.engineFailuresConsec == null ? '—' : String(s.engineFailuresConsec),
      tone: countTone(s.engineFailuresConsec, 1, 5),
    });

    cells.push({
      key: 'reconDrift',
      label: 'Recon drift (consec.)',
      value: s.reconDriftConsecutive == null ? '—' : String(s.reconDriftConsecutive),
      tone: countTone(s.reconDriftConsecutive, 3, 20),
    });

    // ── Queues ──
    cells.push({
      key: 'orderQueue',
      label: 'Order queue',
      value:
        s.orderQueueSize == null
          ? '—'
          : s.orderQueueUsagePct != null
            ? `${s.orderQueueSize} · ${s.orderQueueUsagePct}%`
            : String(s.orderQueueSize),
      tone: countTone(s.orderQueueUsagePct, 50, 80),
    });

    cells.push({
      key: 'retryQueue',
      label: 'Retry queue',
      value:
        s.retryQueueCount != null
          ? String(s.retryQueueCount)
          : s.retryQueuePending == null
            ? '—'
            : s.retryQueuePending
              ? 'pending'
              : 'empty',
      tone: countTone(s.retryQueueCount, 1, 50),
    });

    cells.push({
      key: 'pendingAcks',
      label: 'Pending cmd acks',
      value: s.pendingCommandAcks == null ? '—' : String(s.pendingCommandAcks),
      tone: countTone(s.pendingCommandAcks, 5, 50),
    });

    // ── GVar pressure ──
    cells.push({
      key: 'gvar',
      label: 'GVar (Lascodia/total)',
      value: s.gvarLasc != null && s.gvarTotal != null ? `${s.gvarLasc} / ${s.gvarTotal}` : '—',
      tone: s.gvarUsageHigh ? 'bad' : 'ok',
    });

    // ── Phase-5a: chart-panel parity ──
    // Trading stats
    if (s.positionCount != null) {
      cells.push({
        key: 'positionCount',
        label: 'Open positions',
        value: String(s.positionCount),
        tone: 'info',
      });
    }
    if (s.signalsProcessed != null) {
      cells.push({
        key: 'signalsProcessed',
        label: 'Signals processed',
        value: String(s.signalsProcessed),
        tone: 'info',
      });
    }
    if (s.dailyPnL != null) {
      cells.push({
        key: 'dailyPnL',
        label: 'Daily P&L',
        value: s.dailyPnL.toFixed(2),
        tone: s.dailyPnL >= 0 ? 'ok' : 'bad',
      });
    }
    if (s.lastSignalAtUnix != null && s.lastSignalAtUnix > 0) {
      cells.push({
        key: 'lastSignal',
        label: 'Last signal',
        value:
          new Date(s.lastSignalAtUnix * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z',
        tone: 'info',
      });
    }

    // Engine + transport health
    if (s.engineReachable != null) {
      cells.push({
        key: 'engineReachable',
        label: 'Engine reachable',
        value: s.engineReachable ? 'yes' : 'no',
        tone: s.engineReachable ? 'ok' : 'bad',
      });
    }
    if (s.httpSuccessRate != null) {
      const pct = s.httpSuccessRate * 100;
      cells.push({
        key: 'httpSuccess',
        label: 'HTTP success rate',
        value: `${pct.toFixed(1)}%`,
        tone: pct > 99 ? 'ok' : pct > 90 ? 'warn' : 'bad',
      });
    }
    if (s.transportMode) {
      cells.push({
        key: 'transport',
        label: 'Transport',
        value: `${s.transportMode} · ${s.transportConnected ? 'OK' : 'down'}`,
        tone: s.transportConnected ? 'ok' : 'bad',
      });
    }

    // Order queue capacity
    if (s.orderQueueCapacity != null && s.orderQueueSize != null) {
      const pct =
        s.orderQueueCapacity > 0 ? Math.round((s.orderQueueSize * 100) / s.orderQueueCapacity) : 0;
      cells.push({
        key: 'queueCap',
        label: 'Queue capacity',
        value: `${s.orderQueueSize} / ${s.orderQueueCapacity} · ${pct}%`,
        tone: pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'ok',
      });
    }

    // Execution quality — render "—" when the EA sends the -1 sentinel
    // (no fills / no latency samples since the heartbeat counters last
    // reset).  Lifetime counters never reset, so a -1 truly means "no
    // data yet" and "0.0%" would mislead operators into thinking every
    // fill is failing.
    if (s.fillRate != null) {
      if (s.fillRate < 0) {
        cells.push({ key: 'fillRate', label: 'Fill rate', value: '—', tone: 'info' });
      } else {
        const pct = s.fillRate * 100;
        cells.push({
          key: 'fillRate',
          label: 'Fill rate',
          value: `${pct.toFixed(0)}%`,
          tone: pct > 90 ? 'ok' : pct > 70 ? 'warn' : 'bad',
        });
      }
    }
    if (s.avgLatencyMs != null) {
      if (s.avgLatencyMs < 0) {
        cells.push({ key: 'avgLatency', label: 'Avg latency', value: '—', tone: 'info' });
      } else {
        cells.push({
          key: 'avgLatency',
          label: 'Avg latency',
          value: `${s.avgLatencyMs} ms`,
          tone: s.avgLatencyMs <= 200 ? 'ok' : s.avgLatencyMs <= 500 ? 'warn' : 'bad',
        });
      }
    }
    if (s.avgSlippagePoints != null) {
      if (s.avgSlippagePoints < 0) {
        cells.push({ key: 'avgSlippage', label: 'Avg slippage', value: '—', tone: 'info' });
      } else {
        cells.push({
          key: 'avgSlippage',
          label: 'Avg slippage',
          value: `${s.avgSlippagePoints.toFixed(1)} pt`,
          tone: 'info',
        });
      }
    }
    if (s.latencyP99Ms != null) {
      if (s.latencyP99Ms < 0) {
        cells.push({ key: 'latencyPct', label: 'Latency p50/p95/p99', value: '—', tone: 'info' });
      } else {
        const p50 = s.latencyP50Ms ?? 0;
        const p95 = s.latencyP95Ms ?? 0;
        cells.push({
          key: 'latencyPct',
          label: 'Latency p50/p95/p99',
          value: `${p50} / ${p95} / ${s.latencyP99Ms} ms`,
          tone: s.latencyP99Ms <= 500 ? 'ok' : s.latencyP99Ms <= 1000 ? 'warn' : 'bad',
        });
      }
    }

    // Market microstructure
    if (s.marketState) {
      cells.push({
        key: 'marketState',
        label: 'Market',
        value: s.marketState,
        tone: s.marketState === 'OPEN' ? 'ok' : 'warn',
      });
    }
    if (s.primarySymbol && s.primarySpreadPoints != null && s.primarySpreadPoints > 0) {
      cells.push({
        key: 'primarySpread',
        label: `Spread (${s.primarySymbol})`,
        value: `${s.primarySpreadPoints.toFixed(1)} pt`,
        tone: s.primarySpreadPoints <= 10 ? 'ok' : s.primarySpreadPoints <= 30 ? 'warn' : 'bad',
      });
    } else if (s.primarySymbol) {
      // Spread == 0 means broker is between quotes (closed market or
      // very illiquid moment) — surface as "—" rather than misreporting
      // an exact 0pt spread that's never real outside synthetic feeds.
      cells.push({
        key: 'primarySpread',
        label: `Spread (${s.primarySymbol})`,
        value: '—',
        tone: 'info',
      });
    }
    // Last tick — EA emits wall-clock age directly so we don't have to
    // subtract Unix timestamps (which broke when the broker timestamp was
    // emitted in broker-local seconds-since-epoch but the UI compared
    // against UTC Date.now()).  -1 sentinel ⇒ no tick observed yet.
    if (s.lastTickAgeSec != null) {
      if (s.lastTickAgeSec < 0) {
        cells.push({ key: 'lastTick', label: 'Last tick', value: '—', tone: 'info' });
      } else {
        const a = s.lastTickAgeSec;
        const ageStr =
          a < 60
            ? `${a}s ago`
            : a < 3600
              ? `${Math.floor(a / 60)}m ago`
              : a < 86400
                ? `${Math.floor(a / 3600)}h ago`
                : `${Math.floor(a / 86400)}d ago`;
        cells.push({
          key: 'lastTick',
          label: 'Last tick',
          value: ageStr,
          tone: a <= 60 ? 'ok' : a <= 600 ? 'warn' : 'bad',
        });
      }
    }

    return cells;
  });
}

type Tone = 'ok' | 'warn' | 'bad' | 'info';

interface StateCell {
  key: string;
  label: string;
  value: string;
  tone: Tone;
}

function stateMachineTone(state: string | undefined): Tone {
  switch (state) {
    case 'RUNNING':
      return 'ok';
    case 'SAFE_MODE':
    case 'SAFETY_PAUSE':
    case 'MARKET_CLOSED':
      return 'warn';
    case 'SAFETY_STOP':
    case 'BROKER_DISCONNECTED':
    case 'SHUTTING_DOWN':
      return 'bad';
    case 'INITIALIZING':
      return 'info';
    default:
      return 'info';
  }
}

function countTone(n: number | undefined | null, warnAt: number, badAt: number): Tone {
  if (n == null) return 'info';
  if (n >= badAt) return 'bad';
  if (n >= warnAt) return 'warn';
  return 'ok';
}
