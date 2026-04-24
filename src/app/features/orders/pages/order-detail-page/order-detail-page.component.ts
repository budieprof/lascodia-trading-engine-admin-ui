import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ReactiveFormsModule, FormBuilder } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';

import { OrdersService } from '@core/services/orders.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { OrderDto, ModifyOrderRequest } from '@core/api/api.types';

import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';

@Component({
  selector: 'app-order-detail-page',
  standalone: true,
  imports: [
    ConfirmDialogComponent,
    TabsComponent,
    ReactiveFormsModule,
    RouterLink,
    DatePipe,
    DecimalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (loading()) {
        <div class="skeleton-header">
          <div class="skeleton-title shimmer-box"></div>
          <div class="skeleton-badge shimmer-box"></div>
        </div>
        <div class="detail-card">
          <div class="detail-grid">
            @for (i of skeletonItems; track i) {
              <div class="detail-item">
                <div class="skeleton-label shimmer-box"></div>
                <div class="skeleton-value shimmer-box"></div>
              </div>
            }
          </div>
        </div>
      } @else if (order()) {
        <!-- Header -->
        <div class="page-title-row">
          <div class="title-left">
            <button class="btn-back" (click)="goBack()">
              <span class="back-arrow">&larr;</span>
            </button>
            <h1 class="page-title">Order #{{ order()!.id }}</h1>
            <span
              class="status-badge"
              [style.background]="statusStyle().bg"
              [style.color]="statusStyle().color"
            >
              {{ statusLabel() }}
            </span>
          </div>
          <div class="title-actions">
            @if (order()!.status === 'Pending' || statusNumeric() === 0) {
              <button class="btn btn-primary" (click)="onSubmit()" [disabled]="actionLoading()">
                Submit to Broker
              </button>
              <button
                class="btn btn-secondary"
                (click)="openModifyPanel()"
                [disabled]="actionLoading()"
              >
                Modify SL/TP
              </button>
              <button
                class="btn btn-warning"
                (click)="showCancelDialog.set(true)"
                [disabled]="actionLoading()"
              >
                Cancel
              </button>
              <button
                class="btn btn-destructive"
                (click)="showDeleteDialog.set(true)"
                [disabled]="actionLoading()"
              >
                Delete
              </button>
            }
            @if (order()!.status === 'Submitted' || statusNumeric() === 1) {
              <button
                class="btn btn-warning"
                (click)="showCancelDialog.set(true)"
                [disabled]="actionLoading()"
              >
                Cancel
              </button>
            }
            @if (
              order()!.status === 'Filled' ||
              order()!.status === 'PartialFill' ||
              statusNumeric() === 3 ||
              statusNumeric() === 2
            ) {
              <button
                class="btn btn-secondary"
                (click)="openModifyPanel()"
                [disabled]="actionLoading()"
              >
                Modify SL/TP
              </button>
            }
          </div>
        </div>

        <!-- Modify SL/TP Inline Panel -->
        @if (showModifyPanel()) {
          <div class="modify-panel">
            <div class="modify-panel-header">
              <h3 class="modify-panel-title">Modify Stop Loss / Take Profit</h3>
              <button
                type="button"
                class="close-btn"
                aria-label="Close modify panel"
                (click)="showModifyPanel.set(false)"
              >
                &times;
              </button>
            </div>
            <form [formGroup]="modifyForm" (ngSubmit)="onModify()" class="modify-panel-body">
              <div class="modify-form-grid">
                <div class="form-field">
                  <label class="form-label">Stop Loss</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="stopLoss"
                    step="0.00001"
                    placeholder="Stop Loss price"
                  />
                </div>
                <div class="form-field">
                  <label class="form-label">Take Profit</label>
                  <input
                    class="form-input"
                    type="number"
                    formControlName="takeProfit"
                    step="0.00001"
                    placeholder="Take Profit price"
                  />
                </div>
                <div class="modify-actions">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="showModifyPanel.set(false)"
                    [disabled]="actionLoading()"
                  >
                    Cancel
                  </button>
                  <button type="submit" class="btn btn-primary" [disabled]="actionLoading()">
                    @if (actionLoading()) {
                      <span class="spinner"></span>
                    } @else {
                      Save Changes
                    }
                  </button>
                </div>
              </div>
            </form>
          </div>
        }

        <!-- Tabs -->
        <ui-tabs [tabs]="tabItems" [(activeTab)]="activeTab">
          @switch (activeTab()) {
            @case ('details') {
              <!-- Order Info Card -->
              <div class="detail-card">
                <div class="card-header">
                  <h3 class="card-title">Order Information</h3>
                </div>
                <div class="detail-grid-3">
                  <div class="detail-item">
                    <span class="detail-label">Symbol</span>
                    <span class="detail-value">{{ order()!.symbol ?? '-' }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Order Type</span>
                    <span class="detail-value">
                      <span class="side-badge" [class.buy]="isBuy()" [class.sell]="!isBuy()">
                        {{ sideLabel() }}
                      </span>
                    </span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Execution Type</span>
                    <span class="detail-value">{{ executionLabel() }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Quantity</span>
                    <span class="detail-value mono">{{ order()!.quantity | number: '1.2-2' }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Price</span>
                    <span class="detail-value mono">{{ order()!.price | number: '1.5-5' }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Filled Price</span>
                    <span class="detail-value mono">{{
                      order()!.filledPrice !== null
                        ? (order()!.filledPrice! | number: '1.5-5')
                        : '-'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Stop Loss</span>
                    <span class="detail-value mono">{{
                      order()!.stopLoss !== null ? (order()!.stopLoss! | number: '1.5-5') : '-'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Take Profit</span>
                    <span class="detail-value mono">{{
                      order()!.takeProfit !== null ? (order()!.takeProfit! | number: '1.5-5') : '-'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Filled Quantity</span>
                    <span class="detail-value mono">{{
                      order()!.filledQuantity !== null
                        ? (order()!.filledQuantity! | number: '1.2-2')
                        : '-'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Status</span>
                    <span class="detail-value">
                      <span
                        class="status-badge"
                        [style.background]="statusStyle().bg"
                        [style.color]="statusStyle().color"
                      >
                        {{ statusLabel() }}
                      </span>
                    </span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Paper Trade</span>
                    <span class="detail-value">
                      <span
                        class="paper-badge"
                        [class.paper]="order()!.isPaper"
                        [class.live]="!order()!.isPaper"
                      >
                        {{ order()!.isPaper ? 'Paper' : 'Live' }}
                      </span>
                    </span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Broker Order ID</span>
                    <span class="detail-value mono">{{ order()!.brokerOrderId ?? '-' }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Trade Signal ID</span>
                    <span class="detail-value">
                      @if (order()!.tradeSignalId) {
                        <a class="link" [routerLink]="['/trade-signals', order()!.tradeSignalId]">
                          #{{ order()!.tradeSignalId }}
                        </a>
                      } @else {
                        -
                      }
                    </span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Created At</span>
                    <span class="detail-value">{{
                      order()!.createdAt | date: 'MMM d, yyyy HH:mm:ss'
                    }}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Filled At</span>
                    <span class="detail-value">{{
                      order()!.filledAt ? (order()!.filledAt | date: 'MMM d, yyyy HH:mm:ss') : '-'
                    }}</span>
                  </div>
                  @if (order()!.notes) {
                    <div class="detail-item detail-item-full">
                      <span class="detail-label">Notes</span>
                      <span class="detail-value">{{ order()!.notes }}</span>
                    </div>
                  }
                </div>
              </div>

              <!-- Rejection Reason Card -->
              @if (order()!.rejectionReason) {
                <div class="rejection-card">
                  <div class="rejection-icon">!</div>
                  <div class="rejection-content">
                    <span class="rejection-title">Rejection Reason</span>
                    <span class="rejection-text">{{ order()!.rejectionReason }}</span>
                  </div>
                </div>
              }

              <!-- P&L Summary (if filled) -->
              @if (order()!.filledPrice !== null && order()!.price) {
                <div class="detail-card pnl-card">
                  <div class="card-header">
                    <h3 class="card-title">Execution Summary</h3>
                  </div>
                  <div class="detail-grid-3">
                    <div class="detail-item">
                      <span class="detail-label">Requested Price</span>
                      <span class="detail-value mono">{{ order()!.price | number: '1.5-5' }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Filled Price</span>
                      <span class="detail-value mono">{{
                        order()!.filledPrice! | number: '1.5-5'
                      }}</span>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">Slippage</span>
                      <span
                        class="detail-value mono"
                        [class.loss]="slippage() > 0"
                        [class.profit]="slippage() < 0"
                      >
                        {{ slippage() | number: '1.5-5' }}
                      </span>
                    </div>
                  </div>
                </div>
              }
            }

            @case ('timeline') {
              <div class="timeline-card">
                <div class="card-header">
                  <h3 class="card-title">Order Lifecycle</h3>
                </div>
                <div class="timeline">
                  @for (step of timelineSteps(); track step.label) {
                    <div
                      class="timeline-step"
                      [class.active]="step.active"
                      [class.current]="step.current"
                    >
                      <div class="timeline-dot-container">
                        <div class="timeline-dot">
                          @if (step.active) {
                            <span class="dot-check">&#10003;</span>
                          }
                        </div>
                        @if (!$last) {
                          <div
                            class="timeline-line"
                            [class.filled]="step.active && !step.current"
                          ></div>
                        }
                      </div>
                      <div class="timeline-content">
                        <span class="timeline-label">{{ step.label }}</span>
                        <span class="timeline-time">{{ step.timestamp ?? 'Pending' }}</span>
                        @if (step.description) {
                          <span class="timeline-desc">{{ step.description }}</span>
                        }
                      </div>
                    </div>
                  }
                </div>
              </div>
            }

            @case ('related') {
              <div class="related-card">
                <div class="card-header">
                  <h3 class="card-title">Related Entities</h3>
                </div>
                <div class="related-list">
                  <div class="related-item">
                    <span class="related-label">Trade Signal</span>
                    @if (order()!.tradeSignalId) {
                      <a
                        class="related-link"
                        [routerLink]="['/trade-signals', order()!.tradeSignalId]"
                      >
                        Trade Signal #{{ order()!.tradeSignalId }}
                        <span class="link-arrow">&rarr;</span>
                      </a>
                    } @else {
                      <span class="related-empty">No linked trade signal</span>
                    }
                  </div>
                  <div class="related-item">
                    <span class="related-label">Position</span>
                    @if (order()!.status === 'Filled' || statusNumeric() === 3) {
                      <a class="related-link" [routerLink]="['/positions']">
                        View Positions
                        <span class="link-arrow">&rarr;</span>
                      </a>
                    } @else {
                      <span class="related-empty">No position created yet</span>
                    }
                  </div>
                  <div class="related-item">
                    <span class="related-label">Broker Order</span>
                    @if (order()!.brokerOrderId) {
                      <span class="related-value mono">{{ order()!.brokerOrderId }}</span>
                    } @else {
                      <span class="related-empty">Not yet submitted to broker</span>
                    }
                  </div>
                </div>
              </div>
            }
          }
        </ui-tabs>

        <!-- Cancel Confirm Dialog -->
        <app-confirm-dialog
          [open]="showCancelDialog()"
          title="Cancel Order"
          [message]="
            'Are you sure you want to cancel order #' +
            order()!.id +
            '? This action cannot be undone.'
          "
          confirmLabel="Cancel Order"
          confirmVariant="destructive"
          [loading]="actionLoading()"
          (confirm)="onCancel()"
          (cancelled)="showCancelDialog.set(false)"
        />

        <!-- Delete Confirm Dialog -->
        <app-confirm-dialog
          [open]="showDeleteDialog()"
          title="Delete Order"
          [message]="
            'Are you sure you want to permanently delete order #' +
            order()!.id +
            '? This action cannot be undone.'
          "
          confirmLabel="Delete"
          confirmVariant="destructive"
          [loading]="actionLoading()"
          (confirm)="onDelete()"
          (cancelled)="showDeleteDialog.set(false)"
        />
      } @else {
        <div class="error-state">
          <div class="error-icon">?</div>
          <h2>Order not found</h2>
          <p>The requested order could not be loaded.</p>
          <button class="btn btn-primary" (click)="goBack()">Back to Orders</button>
        </div>
      }
    </div>
  `,
  styleUrl: './order-detail-page.component.scss',
})
export class OrderDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly ordersService = inject(OrdersService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  order = signal<OrderDto | null>(null);
  loading = signal(true);
  actionLoading = signal(false);

  showCancelDialog = signal(false);
  showDeleteDialog = signal(false);
  showModifyPanel = signal(false);

  skeletonItems = Array(12);

  tabItems: TabItem[] = [
    { label: 'Details', value: 'details' },
    { label: 'Timeline', value: 'timeline' },
    { label: 'Related', value: 'related' },
  ];
  activeTab = signal('details');

  modifyForm = this.fb.nonNullable.group({
    stopLoss: [null as number | null],
    takeProfit: [null as number | null],
  });

  // Computed helpers for numeric enum handling
  statusNumeric = computed(() => {
    const o = this.order();
    if (!o) return -1;
    const v = o.status as unknown;
    return typeof v === 'number' ? v : -1;
  });

  statusLabel = computed(() => {
    const o = this.order();
    if (!o) return '';
    const v = o.status as unknown;
    if (typeof v === 'number') {
      const map: Record<number, string> = {
        0: 'Pending',
        1: 'Submitted',
        2: 'PartialFill',
        3: 'Filled',
        4: 'Cancelled',
        5: 'Rejected',
        6: 'Expired',
      };
      return map[v] ?? String(v);
    }
    return String(o.status);
  });

  statusStyle = computed(() => {
    const label = this.statusLabel();
    const map: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
      Submitted: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
      PartialFill: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
      Filled: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
      Cancelled: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
      Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
    };
    return map[label] ?? map['Expired'];
  });

  isBuy = computed(() => {
    const o = this.order();
    if (!o) return true;
    const v = o.orderType as unknown;
    return v === 0 || v === 'Buy';
  });

  sideLabel = computed(() => (this.isBuy() ? 'BUY' : 'SELL'));

  executionLabel = computed(() => {
    const o = this.order();
    if (!o) return '';
    const v = o.executionType as unknown;
    if (typeof v === 'number') {
      const map: Record<number, string> = { 0: 'Market', 1: 'Limit', 2: 'Stop', 3: 'StopLimit' };
      return map[v] ?? String(v);
    }
    return String(o.executionType);
  });

  slippage = computed(() => {
    const o = this.order();
    if (!o || o.filledPrice == null) return 0;
    return Math.abs(o.filledPrice - o.price);
  });

  timelineSteps = computed(() => {
    const o = this.order();
    if (!o) return [];
    const status = this.statusLabel();
    const fmt = (d: string | null) =>
      d
        ? new Date(d).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : null;

    const created = {
      label: 'Created',
      timestamp: fmt(o.createdAt),
      description: 'Order was created in the system',
      active: true,
      current: status === 'Pending',
    };

    const submitted = {
      label: 'Submitted',
      timestamp: ['Submitted', 'PartialFill', 'Filled'].includes(status) ? fmt(o.createdAt) : null,
      description: 'Order submitted to broker for execution',
      active: ['Submitted', 'PartialFill', 'Filled'].includes(status),
      current: status === 'Submitted',
    };

    const terminal = this.getTerminalStep(status, o, fmt);

    return [created, submitted, terminal];
  });

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id) {
      this.loading.set(false);
      return;
    }
    this.loadOrder(id);
  }

  private loadOrder(id: number): void {
    this.loading.set(true);
    this.ordersService.getById(id).subscribe({
      next: (response) => {
        this.order.set(response.data);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notifications.error('Failed to load order');
      },
    });
  }

  private getTerminalStep(
    status: string,
    o: OrderDto,
    fmt: (d: string | null) => string | null,
  ): {
    label: string;
    timestamp: string | null;
    description: string;
    active: boolean;
    current: boolean;
  } {
    switch (status) {
      case 'Filled':
        return {
          label: 'Filled',
          timestamp: fmt(o.filledAt),
          description: `Filled at ${o.filledPrice?.toFixed(5) ?? '-'} for ${o.filledQuantity?.toFixed(2) ?? '-'} lots`,
          active: true,
          current: true,
        };
      case 'PartialFill':
        return {
          label: 'Partially Filled',
          timestamp: fmt(o.filledAt),
          description: `Partial fill: ${o.filledQuantity?.toFixed(2) ?? '?'} of ${o.quantity?.toFixed(2)} lots`,
          active: true,
          current: true,
        };
      case 'Cancelled':
        return {
          label: 'Cancelled',
          timestamp: null,
          description: 'Order was cancelled',
          active: true,
          current: true,
        };
      case 'Rejected':
        return {
          label: 'Rejected',
          timestamp: null,
          description: o.rejectionReason ?? 'Order was rejected by the broker',
          active: true,
          current: true,
        };
      case 'Expired':
        return {
          label: 'Expired',
          timestamp: null,
          description: 'Order expired without being filled',
          active: true,
          current: true,
        };
      default:
        return {
          label: 'Awaiting Execution',
          timestamp: null,
          description: 'Waiting for fill or terminal state',
          active: false,
          current: false,
        };
    }
  }

  onSubmit(): void {
    const o = this.order();
    if (!o) return;
    this.actionLoading.set(true);
    this.ordersService.submit(o.id).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        if (response.status) {
          this.notifications.success(response.data?.message ?? 'Order submitted successfully');
          this.loadOrder(o.id);
        } else {
          this.notifications.error(response.message ?? 'Failed to submit order');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.notifications.error('Failed to submit order');
      },
    });
  }

  onCancel(): void {
    const o = this.order();
    if (!o) return;
    this.actionLoading.set(true);
    this.ordersService.cancel(o.id).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        this.showCancelDialog.set(false);
        if (response.status) {
          this.notifications.success('Order cancelled successfully');
          this.loadOrder(o.id);
        } else {
          this.notifications.error(response.message ?? 'Failed to cancel order');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.showCancelDialog.set(false);
        this.notifications.error('Failed to cancel order');
      },
    });
  }

  onDelete(): void {
    const o = this.order();
    if (!o) return;
    this.actionLoading.set(true);
    this.ordersService.delete(o.id).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        this.showDeleteDialog.set(false);
        if (response.status) {
          this.notifications.success('Order deleted successfully');
          this.router.navigate(['/orders']);
        } else {
          this.notifications.error(response.message ?? 'Failed to delete order');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.showDeleteDialog.set(false);
        this.notifications.error('Failed to delete order');
      },
    });
  }

  openModifyPanel(): void {
    const o = this.order();
    if (!o) return;
    this.modifyForm.patchValue({
      stopLoss: o.stopLoss,
      takeProfit: o.takeProfit,
    });
    this.showModifyPanel.set(true);
  }

  onModify(): void {
    const o = this.order();
    if (!o) return;
    const v = this.modifyForm.getRawValue();
    const request: ModifyOrderRequest = {
      stopLoss: v.stopLoss,
      takeProfit: v.takeProfit,
    };
    this.actionLoading.set(true);
    this.ordersService.modify(o.id, request).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        this.showModifyPanel.set(false);
        if (response.status) {
          this.notifications.success('Order modified successfully');
          this.loadOrder(o.id);
        } else {
          this.notifications.error(response.message ?? 'Failed to modify order');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.showModifyPanel.set(false);
        this.notifications.error('Failed to modify order');
      },
    });
  }

  goBack(): void {
    this.router.navigate(['/orders']);
  }
}
