import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { iamResource } from '@features/iam/shared/iam-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { ExecutionApiService } from '../execution-api.service';
import { progressPct, relative, slippageText, statusTone } from '../execution.logic';
import type { AlgoOrderPage, ExecutionSettings } from '../execution.types';

/**
 * Algorithmic orders (gaps program, execution): every TWAP / VWAP / Iceberg / Adaptive parent of the organisation with
 * its fill progress, average price and slippage against the arrival price. A parent never reaches the broker itself:
 * its children are ordinary orders, each through the account risk check and the EA's gates.
 */
@Component({
  selector: 'app-algo-orders-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DecimalPipe, RouterLink, PageHeaderComponent, FeatureStateComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Algorithmic orders"
        subtitle="Parents of execution algorithms: children, fill progress, average price and slippage against arrival."
      />

      @if (settings.value(); as s) {
        @if (!enabled()) {
          <app-feature-state
            title="Execution algorithms are off"
            kind="off"
            stateLabel="Off"
            switchKey="Execution:Algo:Enabled"
            summary="With algorithms off every signal executes as one order per account, exactly as before. A strategy set to TWAP / VWAP / Iceberg / Adaptive executes Direct, and a manual ticket cannot choose an algorithm."
            [requirements]="requirements()"
            [links]="[{ label: 'Execution settings', route: '/execution/settings' }]"
          />
        }
        <div class="tiles">
          <div class="tile"><span class="t-label">Working</span><span class="t-value">{{ s.workingParents }}</span></div>
          <div class="tile"><span class="t-label">Paused (halt)</span><span class="t-value">{{ s.pausedParents }}</span></div>
          <div class="tile"><span class="t-label">Open blocks</span><span class="t-value">{{ s.openBlocks }}</span></div>
          <div class="tile">
            <span class="t-label">Router would use an algorithm (24 h)</span>
            <span class="t-value">{{ s.routerWouldUseAlgo24h }} / {{ s.routerDecisions24h }}</span>
          </div>
        </div>
      }

      <section class="card">
        <div class="filters">
          <label class="field"
            >Status
            <select class="input" [ngModel]="status()" (ngModelChange)="status.set($event); load()">
              <option value="">Any</option>
              @for (st of statuses; track st) {
                <option [value]="st">{{ st }}</option>
              }
            </select>
          </label>
          <label class="check">
            <input type="checkbox" [ngModel]="activeOnly()" (ngModelChange)="activeOnly.set($event); load()" />
            working or paused only
          </label>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm btn-secondary" (click)="load()">Refresh</button>
        </div>
        @if (orders.error(); as err) {
          <p class="alert" role="alert">{{ err }}</p>
        }
        @if (orders.value(); as page) {
          @if (page.items.length) {
            <table class="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Algorithm</th>
                  <th>Status</th>
                  <th class="num">Filled / total</th>
                  <th>Progress</th>
                  <th class="num">Avg price</th>
                  <th>Slippage</th>
                  <th>Children</th>
                  <th>Next slice</th>
                </tr>
              </thead>
              <tbody>
                @for (o of page.items; track o.id) {
                  <tr class="click" (click)="open(o.id)">
                    <td><a [routerLink]="['/execution/algo-orders', o.id]">{{ o.id }}</a></td>
                    <td>{{ o.accountName ?? o.tradingAccountId }}</td>
                    <td>{{ o.side }} {{ o.symbol }}</td>
                    <td>{{ o.algorithm }} <span class="muted">({{ o.source }})</span></td>
                    <td [class]="'tone-' + tone(o.status)" [title]="o.statusReason ?? ''">{{ o.status }}</td>
                    <td class="num">{{ o.filledQuantity | number: '1.2-5' }} / {{ o.totalQuantity | number: '1.2-5' }}</td>
                    <td><div class="bar"><div class="fill" [style.width.%]="pct(o)"></div></div></td>
                    <td class="num">{{ o.averageFillPrice !== null ? (o.averageFillPrice | number: '1.5-5') : '—' }}</td>
                    <td>{{ slip(o.slippagePips) }}</td>
                    <td>{{ o.childrenFilled }} filled · {{ o.childrenRefused }} refused · {{ o.childrenSent }} sent</td>
                    <td>{{ o.nextSliceAtUtc ? ago(o.nextSliceAtUtc) : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="muted" style="padding: 8px 16px">{{ page.total }} parent(s)</p>
          } @else {
            <p class="muted" style="padding: 12px 16px">
              No algorithmic order{{ status() || activeOnly() ? ' matches the filter' : ' yet' }}. A parent appears when a
              signal of a strategy set to an algorithm, or a live manual ticket that chose one, is claimed for an account.
            </p>
          }
        } @else if (orders.loading()) {
          <p class="muted" style="padding: 12px 16px">Loading…</p>
        }
      </section>
    </div>
  `,
})
export class AlgoOrdersPageComponent {
  private readonly api = inject(ExecutionApiService);
  private readonly router = inject(Router);

  protected readonly statuses = ['Working', 'Paused', 'Completed', 'Cancelled', 'Failed', 'Expired'];
  readonly status = signal('');
  readonly activeOnly = signal(false);

  readonly orders = iamResource<AlgoOrderPage | null>(
    () => this.api.algoOrders({ status: this.status() || null, activeOnly: this.activeOnly(), pageSize: 100 }),
    null,
    'Could not load the algorithmic orders.',
  );
  readonly settings = iamResource<ExecutionSettings | null>(() => this.api.settings(), null, 'Could not load the settings.');

  readonly enabled = computed(() => {
    const k = this.settings.value()?.keys.find((x) => x.key === 'Execution:Algo:Enabled');
    return (k?.value ?? k?.default ?? 'false').trim() === 'true';
  });
  readonly requirements = computed(() => [
    {
      label: 'Execution:Algo:Enabled is on',
      ok: this.enabled(),
      detail: 'Platform staff switch it on in Execution settings once the fleet runs the EA build with command ExecuteOrder.',
      route: '/execution/settings',
    },
  ]);

  constructor() {
    this.load();
    this.settings.reload();
  }

  load(): void {
    this.orders.reload();
  }

  open(id: number): void {
    void this.router.navigate(['/execution/algo-orders', id]);
  }

  pct = progressPct;
  slip = slippageText;
  tone = statusTone;
  ago(iso: string): string {
    return relative(iso, new Date());
  }
}
