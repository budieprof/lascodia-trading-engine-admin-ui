import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';

import { RiskApiService } from '../risk-api.service';
import { exposureOption, formatMoney } from '../risk.logic';
import type { NettedExposure } from '../risk.types';

/** Positions, working orders and live signals netted per currency leg (bars + table). */
@Component({
  selector: 'app-risk-exposure',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ChartCardComponent],
  styleUrl: '../risk.scss',
  template: `
    <div class="toolbar">
      <label class="check"><input type="checkbox" [ngModel]="includeSignals()" (ngModelChange)="includeSignals.set($event)" /> Include live signals not yet executed</label>
      @if (data(); as d) {
        <span class="small muted">{{ d.positionCount }} position(s) · {{ d.pendingOrderCount }} working order(s) · {{ d.signalCount }} live signal(s) · in {{ d.currency }} · {{ d.asOfUtc | date: 'HH:mm:ss' }}</span>
      }
    </div>
    @if (error()) { <section class="card"><p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ error() }}</p></section> }
    <app-chart-card
      title="Net exposure by currency"
      subtitle="Long a pair = long its base, short its quote; an index or metal is its own leg. Signals stack on top of what is committed."
      height="320px"
      [loading]="loading()"
      [options]="chart()"
      [emptyMessage]="(data()?.currencies?.length ?? 0) === 0 ? 'Nothing open, working or signalled.' : null"
    />
    @if (data(); as d) {
      @if (d.unresolvedRates.length) {
        <p class="small muted">No live conversion rate for {{ d.unresolvedRates.join(', ') }} — priced at 1.0.</p>
      }
      <section class="card">
        <div class="table-wrap">
          <table class="grid">
            <thead><tr><th>Leg</th><th class="num">Positions</th><th class="num">Working orders</th><th class="num">Committed</th><th class="num">Live signals</th><th class="num">With signals</th><th class="num">Signal-book net</th></tr></thead>
            <tbody>
              @for (r of d.currencies; track r.currency) {
                <tr>
                  <td>{{ r.currency }}</td>
                  <td class="num">{{ money(r.positions, d.currency) }}</td>
                  <td class="num">{{ money(r.pendingOrders, d.currency) }}</td>
                  <td class="num"><strong>{{ money(r.committed, d.currency) }}</strong></td>
                  <td class="num">{{ money(r.signals, d.currency) }}</td>
                  <td class="num">{{ money(r.withSignals, d.currency) }}</td>
                  <td class="num" title="What the analysis prompt sees: +1 per long leg, −1 per short leg">{{ r.signalBookNet > 0 ? '+' : '' }}{{ r.signalBookNet }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class RiskExposureComponent {
  private readonly api = inject(RiskApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly accountId = input<number | null>(null);
  readonly includeSignals = signal(true);
  readonly data = signal<NettedExposure | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly chart = computed(() => exposureOption(this.data()?.currencies ?? [], this.data()?.currency ?? 'USD', this.includeSignals()));

  constructor() {
    effect(() => {
      const id = this.accountId();
      const sig = this.includeSignals();
      untracked(() => this.load(id, sig));
    });
  }

  private load(id: number | null, includeSignals: boolean): void {
    this.loading.set(true);
    this.error.set(null);
    const sub = this.api.exposure(id, includeSignals).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('The exposure book did not load.');
        this.loading.set(false);
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected money(v: number, ccy: string): string {
    return formatMoney(v, ccy);
  }
}
