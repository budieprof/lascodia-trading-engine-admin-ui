import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrdersService } from '@core/services/orders.service';
import type { OrderDto, TradeSignalDto } from '@core/api/api.types';
import { ago, day } from '@features/strategies/util/figures';

/**
 * The signal behind an order and every order that signal produced on the other accounts — so a cancelled or
 * lone order shows where it came from (strategy, source, levels, why the signal ended) and what its siblings did.
 */
@Component({
  selector: 'app-order-signal-context',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (sig(); as s) {
      <section class="card">
        <header class="head">
          <h3>The signal behind it</h3>
          <a [routerLink]="['/trade-signals', s.id]" class="small">Signal #{{ s.id }} →</a>
        </header>
        <dl class="grid-dl">
          <div>
            <dt>Strategy</dt>
            <dd>
              <a [routerLink]="['/strategies', s.strategyId]">#{{ s.strategyId }}</a> ·
              {{ s.source }}
            </dd>
          </div>
          <div>
            <dt>Trade</dt>
            <dd>{{ s.direction }} {{ s.symbol }} @ {{ s.entryPrice }}</dd>
          </div>
          <div>
            <dt>Stop / target</dt>
            <dd>{{ s.stopLoss ?? '—' }} / {{ s.takeProfit ?? '—' }}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{{ (s.confidence * 100).toFixed(0) }}%</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{{ day(s.generatedAt) }} ({{ ago(s.generatedAt) }})</dd>
          </div>
          <div>
            <dt>Expired / expires</dt>
            <dd>{{ day(s.expiresAt) }}</dd>
          </div>
          <div>
            <dt>Signal status</dt>
            <dd>{{ s.status }}{{ s.rejectionReason ? ' — ' + s.rejectionReason : '' }}</dd>
          </div>
          <div>
            <dt>Accounts that took it</dt>
            <dd>{{ s.accountsPickedUpCount }}</dd>
          </div>
        </dl>
      </section>
    }
    @if (siblings(); as list) {
      <section class="card">
        <header class="head">
          <h3>Every order from this signal</h3>
          <span class="muted">{{ list.length }} order(s) across accounts</span>
        </header>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Account</th>
                <th>Type</th>
                <th>Status</th>
                <th class="num">Qty</th>
                <th class="num">Price</th>
                <th class="num">Filled at</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              @for (o of list; track o.id) {
                <tr [class.current]="o.id === orderId()">
                  <td>
                    @if (o.id === orderId()) {
                      #{{ o.id }} <span class="muted">(this one)</span>
                    } @else {
                      <a [routerLink]="['/orders', o.id]">#{{ o.id }}</a>
                    }
                  </td>
                  <td>
                    @if (o.tradingAccountId) {
                      <a [routerLink]="['/trading-accounts', o.tradingAccountId]"
                        >#{{ o.tradingAccountId }}</a
                      >
                    }
                  </td>
                  <td>{{ o.orderType }}</td>
                  <td>{{ o.status }}</td>
                  <td class="num">{{ o.quantity }}</td>
                  <td class="num">{{ o.price }}</td>
                  <td class="num">{{ o.filledPrice ?? '—' }}</td>
                  <td>{{ ago(o.createdAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        margin-top: var(--space-3);
      }
      .card {
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        justify-content: space-between;
        flex-wrap: wrap;
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .small {
        font-size: var(--text-xs);
      }
      .grid-dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .grid-dl dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .grid-dl dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      th,
      td {
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        white-space: nowrap;
      }
      th {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: normal;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      tr.current td {
        background: var(--bg-tertiary);
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
    `,
  ],
})
export class OrderSignalContextComponent {
  private readonly signals = inject(TradeSignalsService);
  private readonly orders = inject(OrdersService);

  readonly tradeSignalId = input<number | null>(null);
  readonly orderId = input.required<number>();

  protected readonly sig = signal<TradeSignalDto | null>(null);
  protected readonly siblings = signal<OrderDto[] | null>(null);
  protected readonly day = day;
  protected readonly ago = ago;

  constructor() {
    effect(() => {
      const id = this.tradeSignalId();
      untracked(() => {
        if (!id) return;
        this.signals
          .getById(id)
          .pipe(catchError(() => of(null)))
          .subscribe((r) => this.sig.set(r?.status ? (r.data ?? null) : null));
        this.orders
          .list({
            currentPage: 1,
            itemCountPerPage: 25,
            filter: { tradeSignalId: id },
            sortBy: 'id',
            sortDirection: 'asc',
          })
          .pipe(catchError(() => of(null)))
          .subscribe((r) => this.siblings.set(r?.data?.data ?? null));
      });
    });
  }
}
