import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import {
  RecPendingRecDto,
  RecSignalDto,
  recFormatPrice,
  recPips,
} from '../../trade-recommendations.types';

/**
 * What the card became: the parked rec (if its entry was too far to file at once), the signal and
 * any changes the engine made to it, every account that tried it and why some refused, the orders
 * and their fills, and the positions with their P&L.
 */
@Component({
  selector: 'app-rec-execution',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, PercentPipe, RouterLink],
  styleUrls: ['../../rec-shared.scss'],
  template: `
    @if (pending(); as pr) {
      <section class="block">
        <h3>
          Parked rec
          <a class="pill pill--link mono" routerLink="/pending-signal-recs">#{{ pr.id }} ↗</a>
          <span class="pill">{{ pr.state }}</span>
        </h3>
        <dl class="kv">
          <dt>Entry</dt>
          <dd class="mono">{{ price(pr.recommendedEntryPrice) }}</dd>
          <dt>ATR at generation</dt>
          <dd class="mono">{{ price(pr.atrAtGeneration) }}</dd>
          <dt>Parked</dt>
          <dd>
            {{ pr.createdAt | date: 'MMM d, HH:mm' : 'UTC' }} UTC → park expires
            {{ pr.parkExpiresAt | date: 'MMM d, HH:mm' : 'UTC' }}
          </dd>
          <dt>Revalidations</dt>
          <dd>
            {{ pr.revalAttempts }}
            @if (pr.lastRevalAttemptAt) {
              <span class="muted"
                >· last {{ pr.lastRevalAttemptAt | date: 'MMM d, HH:mm' : 'UTC' }}</span
              >
            }
          </dd>
          @if (pr.terminalReason) {
            <dt>Ended</dt>
            <dd>{{ pr.terminalReason }}</dd>
          }
        </dl>
      </section>
    }

    @if (signal(); as s) {
      <section class="block">
        <h3>
          Signal
          <a class="pill pill--link mono" [routerLink]="['/trade-signals', s.id]">#{{ s.id }} ↗</a>
          <span class="pill" [class]="'pill pill--' + signalTone()">{{ s.status }}</span>
          <span class="pill">{{ s.source }}</span>
        </h3>
        <dl class="kv">
          <dt>Levels</dt>
          <dd class="mono">
            {{ price(s.entryPrice) }} · SL {{ price(s.stopLoss) }} · TP {{ price(s.takeProfit) }}
          </dd>
          @if (s.originalTakeProfit !== null && s.originalTakeProfit !== s.takeProfit) {
            <dt>TP adjusted</dt>
            <dd class="mono">
              from {{ price(s.originalTakeProfit) }} to {{ price(s.takeProfit) }}
            </dd>
          }
          <dt>Lot size</dt>
          <dd class="mono">{{ s.suggestedLotSize | number: '1.2-2' }}</dd>
          <dt>Confidence</dt>
          <dd class="mono">{{ s.confidence | percent: '1.0-0' }}</dd>
          @if (s.atrAtGeneration !== null) {
            <dt>ATR</dt>
            <dd class="mono">{{ price(s.atrAtGeneration) }}</dd>
          }
          <dt>Strategy</dt>
          <dd>{{ s.strategyName ?? '#' + s.strategyId }}</dd>
          <dt>Generated</dt>
          <dd>
            {{ s.generatedAt | date: 'MMM d, HH:mm:ss' : 'UTC' }} UTC · expires
            {{ s.expiresAt | date: 'MMM d, HH:mm' : 'UTC' }}
          </dd>
          @if (s.analysisMonitorId) {
            <dt>Filed by monitor</dt>
            <dd>
              <a
                class="pill pill--link mono"
                [routerLink]="['/analysis-monitors']"
                [queryParams]="{ focus: s.analysisMonitorId }"
              >
                #{{ s.analysisMonitorId }} ↗
              </a>
            </dd>
          }
          @if (s.rejectionReason) {
            <dt>Rejection</dt>
            <dd class="loss">{{ s.rejectionReason }}</dd>
          }
          @if (s.gateBypassReason) {
            <dt>Gate bypass</dt>
            <dd>{{ s.gateBypassReason }}</dd>
          }
          @if (s.ghostOutcome) {
            <dt>Ghost outcome</dt>
            <dd>
              {{ s.ghostOutcome }}
              @if (s.ghostPnLPips !== null) {
                <span
                  class="mono"
                  [class.profit]="s.ghostPnLPips > 0"
                  [class.loss]="s.ghostPnLPips < 0"
                >
                  ({{ s.ghostPnLPips > 0 ? '+' : '' }}{{ s.ghostPnLPips | number: '1.1-1' }} pips)
                </span>
              }
              <span class="muted"> — what it would have done unfilled</span>
            </dd>
          }
        </dl>
      </section>

      <section class="block">
        <h3>
          Accounts <span class="muted count">{{ s.accountAttempts.length }}</span>
        </h3>
        @if (s.accountAttempts.length === 0) {
          <p class="empty-line">No account has picked it up.</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Result</th>
                  <th>Reason</th>
                  <th>When (UTC)</th>
                </tr>
              </thead>
              <tbody>
                @for (a of s.accountAttempts; track $index) {
                  <tr>
                    <td>{{ a.accountName ?? '#' + a.tradingAccountId }}</td>
                    <td>
                      <span
                        class="pill"
                        [class.pill--good]="a.passed"
                        [class.pill--bad]="!a.passed"
                      >
                        {{ a.passed ? 'Passed' : 'Blocked' }}
                      </span>
                    </td>
                    <td>{{ a.blockReason ?? '' }}</td>
                    <td class="mono">{{ a.attemptedAt | date: 'MMM d, HH:mm:ss' : 'UTC' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="block">
        <h3>
          Orders <span class="muted count">{{ s.orders.length }}</span>
        </h3>
        @if (s.orders.length === 0) {
          <p class="empty-line">No order was placed.</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Lots</th>
                  <th>Price</th>
                  <th>Fill</th>
                  <th>Slippage</th>
                  <th>Created / filled (UTC)</th>
                </tr>
              </thead>
              <tbody>
                @for (o of s.orders; track o.id) {
                  <tr>
                    <td>
                      <a class="mono" [routerLink]="['/orders', o.id]">#{{ o.id }}</a
                      >{{ o.isPaper ? ' · paper' : '' }}
                    </td>
                    <td>{{ o.accountName ?? '#' + o.tradingAccountId }}</td>
                    <td>
                      {{ o.orderType }} <span class="muted">{{ o.executionType }}</span>
                    </td>
                    <td>
                      {{ o.status }}
                      @if (o.rejectionReason) {
                        <div class="loss small">{{ o.rejectionReason }}</div>
                      }
                    </td>
                    <td class="mono">{{ o.quantity | number: '1.2-2' }}</td>
                    <td class="mono">{{ price(o.price) }}</td>
                    <td class="mono">{{ o.filledPrice !== null ? price(o.filledPrice) : '—' }}</td>
                    <td class="mono">
                      {{ o.slippagePips !== null ? (o.slippagePips | number: '1.1-1') + 'p' : '—' }}
                      @if (o.submitToFillMs !== null) {
                        <span class="muted"> · {{ o.submitToFillMs }}ms</span>
                      }
                    </td>
                    <td class="mono small">
                      {{ o.createdAt | date: 'MMM d, HH:mm:ss' : 'UTC' }}
                      @if (o.filledAt) {
                        <br />{{ o.filledAt | date: 'MMM d, HH:mm:ss' : 'UTC' }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="block">
        <h3>
          Positions <span class="muted count">{{ s.positions.length }}</span>
        </h3>
        @if (s.positions.length === 0) {
          <p class="empty-line">No position was opened.</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Lots</th>
                  <th>Entry</th>
                  <th>Exit / now</th>
                  <th>SL / TP</th>
                  <th>MFE / MAE</th>
                  <th>P&amp;L</th>
                  <th>Opened / closed (UTC)</th>
                </tr>
              </thead>
              <tbody>
                @for (p of s.positions; track p.id) {
                  <tr>
                    <td>
                      <a class="mono" [routerLink]="['/positions', p.id]">#{{ p.id }}</a
                      >{{ p.isPaper ? ' · paper' : '' }}
                    </td>
                    <td>
                      {{ p.accountName ?? '#' + p.tradingAccountId }}
                      @if (p.accountType) {
                        <span class="pill" [class.pill--warn]="p.accountType === 'Real'">{{
                          p.accountType
                        }}</span>
                      }
                    </td>
                    <td>
                      {{ p.status }} <span class="muted">{{ p.direction }}</span>
                    </td>
                    <td class="mono">{{ p.openLots | number: '1.2-2' }}</td>
                    <td class="mono">{{ price(p.averageEntryPrice) }}</td>
                    <td class="mono">{{ price(p.closePrice ?? p.currentPrice) }}</td>
                    <td class="mono small">
                      {{ price(p.stopLoss) }} / {{ price(p.takeProfit) }}
                      @if (p.initialStopLoss !== null && p.initialStopLoss !== p.stopLoss) {
                        <div class="muted">initial SL {{ price(p.initialStopLoss) }}</div>
                      }
                    </td>
                    <td class="mono small">
                      {{ excursion(p.averageEntryPrice, p.maxFavorablePrice) }} /
                      {{ excursion(p.averageEntryPrice, p.maxAdversePrice) }}
                    </td>
                    <td class="mono">
                      @let pnl = p.status === 'Closed' ? p.realizedPnL : p.unrealizedPnL;
                      <span [class.profit]="pnl > 0" [class.loss]="pnl < 0"
                        >{{ pnl > 0 ? '+' : '' }}{{ pnl | number: '1.2-2' }}</span
                      >
                      @if (p.swap || p.commission) {
                        <div class="muted small">
                          swap {{ p.swap | number: '1.2-2' }} · comm
                          {{ p.commission | number: '1.2-2' }}
                        </div>
                      }
                    </td>
                    <td class="mono small">
                      {{ p.openedAt | date: 'MMM d, HH:mm' : 'UTC' }}
                      @if (p.closedAt) {
                        <br />{{ p.closedAt | date: 'MMM d, HH:mm' : 'UTC' }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .block h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 0 0 8px;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .count {
        font-weight: normal;
      }
      .small {
        font-size: 11.5px;
      }
    `,
  ],
})
export class RecExecutionComponent {
  readonly symbol = input.required<string>();
  readonly signal = input<RecSignalDto | null>(null);
  readonly pending = input<RecPendingRecDto | null>(null);

  readonly signalTone = computed(() => {
    switch (this.signal()?.status) {
      case 'Executed':
      case 'Approved':
        return 'good';
      case 'Rejected':
        return 'bad';
      case 'Expired':
      case 'Cancelled':
        return 'warn';
      default:
        return 'info';
    }
  });

  price(v: number | null | undefined): string {
    return recFormatPrice(this.symbol(), v);
  }

  excursion(entry: number, extreme: number | null): string {
    const p = recPips(this.symbol(), entry, extreme);
    return p == null ? '—' : `${p}p`;
  }
}
