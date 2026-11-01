import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { LscCanDirective } from '@core/auth/can.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { ExecutionApiService } from '../execution-api.service';
import { isActive, progressPct, slippageText, statusTone } from '../execution.logic';
import type { AlgoOrderDetail } from '../execution.types';

/**
 * One algorithmic parent: the plan against the children sent (each an ordinary order with its own risk check and
 * broker fill), fill progress, average price, slippage against the arrival price, the timeline (sent, refused,
 * filled, paused, resumed …) and a confirmed cancel — unsent children are withdrawn, children at the broker stand.
 */
@Component({
  selector: 'app-algo-order-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, LscCanDirective, PageHeaderComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header [title]="'Algorithmic order ' + id()" subtitle="Plan, children, fills and timeline." />
      <p><a routerLink="/execution/algo-orders">← all algorithmic orders</a></p>
      @if (detail.error(); as err) {
        <p class="alert" role="alert">{{ err }}</p>
      }
      @if (message()) {
        <p class="ok-line" role="status">{{ message() }}</p>
      }
      @if (detail.value(); as d) {
        <div class="tiles">
          <div class="tile">
            <span class="t-label">{{ d.order.algorithm }} · {{ d.order.side }} {{ d.order.symbol }}</span>
            <span class="t-value" [class]="'tone-' + tone(d.order.status)">{{ d.order.status }}</span>
            <span class="muted">{{ d.order.statusReason }}</span>
          </div>
          <div class="tile">
            <span class="t-label">Filled / total</span>
            <span class="t-value">{{ d.order.filledQuantity | number: '1.2-5' }} / {{ d.order.totalQuantity | number: '1.2-5' }}</span>
            <div class="bar"><div class="fill" [style.width.%]="pct()"></div></div>
          </div>
          <div class="tile">
            <span class="t-label">Average price (arrival {{ d.order.arrivalPrice ?? '—' }})</span>
            <span class="t-value">{{ d.order.averageFillPrice !== null ? (d.order.averageFillPrice | number: '1.5-5') : '—' }}</span>
            <span class="muted">{{ slip(d.order.slippagePips) }}</span>
          </div>
          <div class="tile">
            <span class="t-label">Window</span>
            <span>{{ d.order.startAtUtc | date: 'MMM d HH:mm:ss' : 'UTC' }} → {{ d.order.endAtUtc | date: 'HH:mm:ss' : 'UTC' }} UTC</span>
            <span class="muted">account {{ d.order.accountName ?? d.order.tradingAccountId }} · signal {{ d.order.tradeSignalId ?? '—' }} · {{ d.order.source }}</span>
          </div>
        </div>

        @if (active()) {
          <p *lscCan="'orders.cancel'">
            <button type="button" class="btn btn-sm btn-danger" [disabled]="d.order.cancelRequested || busy()" (click)="confirm.set(true)">
              {{ d.order.cancelRequested ? 'Cancel requested' : 'Cancel the algorithm' }}
            </button>
          </p>
        }

        <div class="grid2">
          <section class="card">
            <div class="card-head"><h3>Plan</h3><span class="hint">stop {{ d.stopLoss ?? '—' }} · target {{ d.takeProfit ?? '—' }} · {{ d.executionType }}{{ d.limitPrice ? ' @ ' + d.limitPrice : '' }}</span></div>
            <table class="table">
              <thead><tr><th>Slice</th><th class="num">Lots</th><th>Due (UTC)</th><th>Acted on</th></tr></thead>
              <tbody>
                @for (s of d.plan; track s.index) {
                  <tr><td>{{ s.index }}</td><td class="num">{{ s.quantity | number: '1.2-5' }}</td><td>{{ s.atUtc | date: 'HH:mm:ss' : 'UTC' }}</td><td>{{ s.actedOn ? 'yes' : '—' }}</td></tr>
                }
              </tbody>
            </table>
          </section>
          <section class="card">
            <div class="card-head"><h3>Children</h3><span class="hint">each an ordinary order through Tier 2 and the EA's gates</span></div>
            @if (d.children.length) {
              <table class="table">
                <thead><tr><th>Slice</th><th>Order</th><th>Status</th><th class="num">Lots</th><th class="num">Filled</th><th class="num">Price</th><th>Created (UTC)</th></tr></thead>
                <tbody>
                  @for (c of d.children; track c.orderId) {
                    <tr [title]="c.rejectionReason ?? ''">
                      <td>{{ c.sliceIndex }}</td>
                      <td>{{ c.orderId }}{{ c.brokerOrderId ? ' · #' + c.brokerOrderId : '' }}</td>
                      <td [class]="'tone-' + tone(c.status)">{{ c.status }}</td>
                      <td class="num">{{ c.quantity | number: '1.2-5' }}</td>
                      <td class="num">{{ c.filledQuantity ?? 0 | number: '1.2-5' }}</td>
                      <td class="num">{{ c.filledPrice !== null ? (c.filledPrice | number: '1.5-5') : '—' }}</td>
                      <td>{{ c.createdAt | date: 'HH:mm:ss' : 'UTC' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted" style="padding: 12px 16px">No child sent yet.</p>
            }
          </section>
        </div>

        <section class="card">
          <div class="card-head"><h3>Timeline</h3></div>
          <ul class="timeline">
            @for (e of d.timeline; track e.id) {
              <li><span>{{ e.occurredAtUtc | date: 'MMM d HH:mm:ss' : 'UTC' }}</span><strong>{{ e.kind }}</strong><span>{{ e.message }}</span></li>
            }
          </ul>
        </section>
      } @else if (detail.loading()) {
        <p class="muted">Loading…</p>
      }

      <app-confirm-dialog
        [open]="confirm()"
        title="Cancel this algorithm?"
        message="Children not yet delivered to the EA are withdrawn and nothing new is sent. A child the EA already took may still fill — it is booked and rolled up like any fill."
        confirmLabel="Cancel the algorithm"
        [loading]="busy()"
        (confirm)="cancel()"
        (cancelled)="confirm.set(false)"
      />
    </div>
  `,
})
export class AlgoOrderDetailPageComponent {
  private readonly api = inject(ExecutionApiService);

  private readonly route = inject(ActivatedRoute);
  /** The parent's id from the route. */
  readonly id = signal<string>(this.route.snapshot.paramMap.get('id') ?? '');
  readonly confirm = signal(false);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);

  readonly detail = iamResource<AlgoOrderDetail | null>(
    () => this.api.algoOrder(Number(this.id())),
    null,
    'Could not load the algorithmic order.',
  );
  readonly pct = computed(() => {
    const d = this.detail.value();
    return d ? progressPct(d.order) : 0;
  });
  readonly active = computed(() => {
    const d = this.detail.value();
    return !!d && isActive(d.order.status);
  });

  constructor() {
    this.detail.reload();
  }

  cancel(): void {
    this.busy.set(true);
    this.api.cancel(Number(this.id())).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirm.set(false);
        this.message.set('Cancel requested: unsent children are withdrawn within seconds.');
        this.detail.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirm.set(false);
        this.message.set(errorText(e, 'The cancel was refused.'));
      },
    });
  }

  slip = slippageText;
  tone = statusTone;
}
