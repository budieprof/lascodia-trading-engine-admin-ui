import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { iamResource } from '@features/iam/shared/iam-resource';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { ExecutionApiService } from '../execution-api.service';
import { fairnessSum, statusTone } from '../execution.logic';
import type { BlockOrder } from '../execution.types';

/**
 * One block order's allocation report (gaps program, execution): every member's target share, its own fills, the
 * block's volume-weighted price and the average-price allocation — what one price gains or costs each account.
 * Reporting-level for MT5 accounts: no money moves between them (said on the page).
 */
@Component({
  selector: 'app-block-order-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './execution-page.scss'],
  template: `
    <div class="page">
      <app-page-header [title]="'Block order ' + id()" subtitle="Allocation report: shares, fills and the average-price allocation." />
      <p><a routerLink="/execution/allocation-groups">← allocation groups</a></p>
      @if (block.error(); as err) {
        <p class="alert" role="alert">{{ err }}</p>
      }
      @if (block.value(); as b) {
        <div class="tiles">
          <div class="tile"><span class="t-label">{{ b.groupName }} · signal {{ b.tradeSignalId }}</span><span class="t-value">{{ b.direction }} {{ b.symbol }}</span><span class="muted">{{ b.method }}</span></div>
          <div class="tile"><span class="t-label">Filled / allocated lots</span><span class="t-value">{{ b.filledLots | number: '1.2-2' }} / {{ b.totalLots | number: '1.2-2' }}</span></div>
          <div class="tile"><span class="t-label">Block average price</span><span class="t-value">{{ b.averagePrice !== null ? (b.averagePrice | number: '1.5-5') : '—' }}</span></div>
          <div class="tile"><span class="t-label">Status</span><span class="t-value" [class]="'tone-' + tone(b.status)">{{ b.status }}</span><span class="muted">{{ b.allocatedAtUtc ? 'allocated ' + (b.allocatedAtUtc | date: 'MMM d HH:mm' : 'UTC') + ' UTC' : 'members still executing' }}</span></div>
        </div>
        <p class="hint-line">{{ b.allocationNote }}</p>
        @if (b.notes) {
          <p class="hint-line">{{ b.notes }}</p>
        }
        <section class="card">
          <table class="table">
            <thead>
              <tr>
                <th>Account</th><th class="num">Equity</th><th class="num">Share</th><th class="num">Target lots</th><th>Order / parent</th>
                <th class="num">Filled</th><th class="num">Own avg</th><th class="num">Allocated avg</th><th class="num">Adjustment</th><th class="num">Fairness (quote ccy)</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              @for (a of b.allocations; track a.tradingAccountId) {
                <tr [title]="a.reason ?? ''">
                  <td>{{ a.accountName ?? a.tradingAccountId }}</td>
                  <td class="num">{{ a.accountEquity | number: '1.0-0' }}</td>
                  <td class="num">{{ a.fraction * 100 | number: '1.1-1' }} %</td>
                  <td class="num">{{ a.targetLots | number: '1.2-2' }}</td>
                  <td>
                    @if (a.algoOrderId) {
                      <a [routerLink]="['/execution/algo-orders', a.algoOrderId]">parent {{ a.algoOrderId }}</a>
                    } @else {
                      {{ a.orderId ?? '—' }}
                    }
                  </td>
                  <td class="num">{{ a.filledLots | number: '1.2-2' }}</td>
                  <td class="num">{{ a.venueAveragePrice !== null ? (a.venueAveragePrice | number: '1.5-5') : '—' }}</td>
                  <td class="num">{{ a.allocatedAveragePrice !== null ? (a.allocatedAveragePrice | number: '1.5-5') : '—' }}</td>
                  <td class="num">{{ a.priceAdjustment !== null ? (a.priceAdjustment | number: '1.5-8') : '—' }}</td>
                  <td class="num" [class.tone-ok]="(a.fairnessAmount ?? 0) > 0" [class.tone-bad]="(a.fairnessAmount ?? 0) < 0">{{ a.fairnessAmount !== null ? (a.fairnessAmount | number: '1.2-2') : '—' }}</td>
                  <td [class]="'tone-' + tone(a.status)">{{ a.status }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="hint-line">Σ fairness = {{ sum() | number: '1.2-4' }} (zero when the allocation is complete). Positive = the block price is better for the account than its own fills.</p>
        </section>
      } @else if (block.loading()) {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
})
export class BlockOrderPageComponent {
  private readonly api = inject(ExecutionApiService);
  private readonly route = inject(ActivatedRoute);

  readonly id = signal<string>(this.route.snapshot.paramMap.get('id') ?? '');
  readonly block = iamResource<BlockOrder | null>(() => this.api.block(Number(this.id())), null, 'Could not load the block order.');
  readonly sum = computed(() => {
    const b = this.block.value();
    return b ? fairnessSum(b) : 0;
  });

  constructor() {
    this.block.reload();
  }

  tone = statusTone;
}
