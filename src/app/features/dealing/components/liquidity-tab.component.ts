import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { errorText } from '@features/iam/iam.logic';
import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { isModuleNotInPlan, percent, pips } from '../dealing.logic';
import type { DealingLpAnalytics } from '../dealing.types';

/**
 * LP / venue analytics of one symbol over ≤ 24 h, from the tick store (top of book) + multibook dispersion: share at
 * best, spread and spread contribution, quote age and staleness, and the platform's own order rejects per broker server.
 * Runs on request (a store read in the research process).
 */
@Component({
  selector: 'app-dealing-liquidity-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      td.num,
      th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Liquidity providers and venues</h3>
        <input
          class="input"
          style="width: 7rem"
          aria-label="Symbol"
          [ngModel]="symbol()"
          (ngModelChange)="symbol.set($event)"
        />
        <select
          class="select"
          aria-label="Window"
          [ngModel]="hours()"
          (ngModelChange)="hours.set(+$event)"
        >
          <option [ngValue]="1">last hour</option>
          <option [ngValue]="6">last 6 hours</option>
          <option [ngValue]="24">last 24 hours</option>
        </select>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          [disabled]="loading() || !symbol().trim()"
          (click)="load()"
        >
          {{ loading() ? 'Analysing…' : 'Analyse' }}
        </button>
      </header>
      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }
      @if (data(); as d) {
        <div class="card-body">
          <p class="small muted">
            {{ d.symbol }} · {{ d.window.samples }} samples every {{ d.sampleMs }} ms ({{
              d.window.multiSourceSamples
            }}
            with two or more live sources) · mean inside spread
            {{ pips(d.window.meanInsideSpreadPips) }} pips · crossed or locked
            {{ d.window.crossedOrLockedSamples }}
            samples (cross-venue, not executable at one place).
          </p>
          @for (n of d.notes; track n) {
            <p class="note">{{ n }}</p>
          }
          @if (d.denied.length) {
            <p class="note warn">
              Not entitled to: {{ d.denied.join(', ') }} — those sources are left out.
            </p>
          }
        </div>
        @if (d.sources.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Source</th>
                  <th class="num">Live</th>
                  <th class="num">Best bid</th>
                  <th class="num">Best ask</th>
                  <th class="num">At best</th>
                  <th class="num">Spread</th>
                  <th
                    class="num"
                    title="How much tighter the consolidated top is because of this source"
                  >
                    Spread contribution
                  </th>
                  <th class="num">Quote age (mean / P95)</th>
                  <th class="num">Stale</th>
                  <th class="num">Ticks</th>
                </tr>
              </thead>
              <tbody>
                @for (s of d.sources; track s.sourceId) {
                  <tr>
                    <td>
                      <code>{{ s.sourceId }}</code
                      ><span class="sub">{{ s.kind }}</span>
                    </td>
                    <td class="num">{{ percent(s.liveShare) }}</td>
                    <td class="num">{{ percent(s.atBestBidShare) }}</td>
                    <td class="num">{{ percent(s.atBestAskShare) }}</td>
                    <td class="num">{{ percent(s.atBestEitherShare) }}</td>
                    <td class="num">{{ pips(s.meanSpreadPips) }}</td>
                    <td class="num">{{ pips(s.meanInsideContributionPips) }}</td>
                    <td class="num">
                      {{ s.meanQuoteAgeMs ?? '—' }} / {{ s.p95QuoteAgeMs ?? '—' }} ms
                    </td>
                    <td class="num">{{ percent(s.staleShare) }}</td>
                    <td class="num">{{ s.ticks }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (d.dispersion.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Source (multibook)</th>
                  <th class="num">Minutes</th>
                  <th class="num">Mean |dev| from median</th>
                  <th class="num">Arrival lag (mean / max)</th>
                </tr>
              </thead>
              <tbody>
                @for (x of d.dispersion; track x.sourceId) {
                  <tr>
                    <td>
                      <code>{{ x.sourceId }}</code>
                    </td>
                    <td class="num">{{ x.minutes }}</td>
                    <td class="num">{{ pips(x.meanAbsDevPips) }}</td>
                    <td class="num">
                      {{ x.meanArrivalLagMs ?? '—' }} / {{ x.maxArrivalLagMs ?? '—' }} ms
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (d.ownOrders.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Own orders by broker server</th>
                  <th class="num">Orders</th>
                  <th class="num">Filled</th>
                  <th class="num">Rejected</th>
                  <th class="num">Reject rate</th>
                  <th class="num">Submit → fill</th>
                </tr>
              </thead>
              <tbody>
                @for (o of d.ownOrders; track o.brokerServer) {
                  <tr>
                    <td>
                      {{ o.brokerServer }} <span class="sub">{{ o.sourceId }}</span>
                    </td>
                    <td class="num">{{ o.orders }}</td>
                    <td class="num">{{ o.filled }}</td>
                    <td class="num">{{ o.rejected }}</td>
                    <td class="num">{{ percent(o.rejectRate, 1) }}</td>
                    <td class="num">{{ o.meanSubmitToFillMs ?? '—' }} ms</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <p class="note">{{ d.rejectLastLook }}</p>
        <details class="pad">
          <summary class="small">Methodology</summary>
          <p class="small muted">{{ d.methodology }}</p>
        </details>
      } @else if (!error()) {
        <p class="pad muted">
          {{ loading() ? 'Analysing ' + symbol() + '…' : 'Pick a symbol and press Analyse.' }}
        </p>
      }
    </section>
  `,
})
export class DealingLiquidityTabComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);

  protected readonly pips = pips;
  protected readonly percent = percent;

  readonly symbol = signal(this.store.symbol().trim() || 'EURUSD');
  readonly hours = signal(1);
  readonly data = signal<DealingLpAnalytics | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // Open on the default question (the filter's symbol or EURUSD, last hour) — about a second of store reads —
    // instead of an empty panel; "Analyse" re-reads with what the operator picks.
    this.load();
  }

  load(): void {
    if (this.loading()) return;
    const to = Date.now();
    this.loading.set(true);
    this.api
      .lpAnalytics({
        symbol: this.symbol().trim().toUpperCase(),
        from: to - this.hours() * 3_600_000,
        to,
        sampleMs: this.hours() > 6 ? 1_000 : 500,
      })
      .subscribe({
        next: (d) => {
          this.loading.set(false);
          this.data.set(d);
          this.error.set(null);
        },
        error: (e) => {
          this.loading.set(false);
          if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
          else this.error.set(errorText(e, 'Could not analyse the liquidity.'));
        },
      });
  }
}
