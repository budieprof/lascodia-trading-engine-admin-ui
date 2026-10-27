import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';

import { VenuesApiService } from '../venues-api.service';
import { lagText } from '../venues.logic';
import type { InstrumentCandleState } from '../venues.types';

const EMPTY: InstrumentCandleState = { builderEnabled: false, continuousAdjustment: null, cursors: [], rolls: [], statusCounts: {} };

/**
 * Instrument candles (multi-asset WS7 7.10): where the non-FX candle builder stands (engine md-candles,
 * `MarketData:InstrumentCandles:Enabled`, `GET instrument-candles/state`) — one row per futures / crypto / equity
 * symbol and continuous series (`ES1!` back-adjusted, `ES1!U` raw): its single source, the built span and how far it
 * lags live, prints read and excluded, and the status (Blocked = another producer owns the symbol's candles; FX candles
 * always come from the EA). Below, the continuous series' roll records with the prices that set each adjustment.
 * Read-only (`marketdata.read`).
 */
@Component({
  selector: 'app-instrument-candles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Instrument candles"
        subtitle="The futures, crypto and equity candle builder: one source per symbol, the built span, lag and continuous-futures rolls. FX candles come from the EA."
      >
        <button type="button" class="btn btn-secondary" (click)="state.reload()" [disabled]="state.loading()">
          {{ state.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (state.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }

      <section class="card">
        <div class="card-body">
          <p>
            <span class="chip" [class.ok]="state.value().builderEnabled" [class.warn]="!state.value().builderEnabled">
              builder {{ state.value().builderEnabled ? 'on' : 'off' }}
            </span>
            <span class="chip">continuous adjustment: {{ state.value().continuousAdjustment ?? 'Panama' }}</span>
            @for (s of statuses(); track s.status) {
              <span class="chip" [class.bad]="s.status === 'Blocked' || s.status === 'Stalled'" [class.ok]="s.status === 'Live'">
                {{ s.status }} {{ s.count }}
              </span>
            }
          </p>
          @if (!state.value().builderEnabled) {
            <p class="note">
              The builder is off (<code>MarketData:InstrumentCandles:Enabled</code> = false): no non-FX candle is written.
            </p>
          }
          <div class="row">
            <label class="field">
              <span class="label">Symbol or root starts with</span>
              <input class="input search" name="f-sym" [ngModel]="symbol()" (ngModelChange)="symbol.set($event)" (keydown.enter)="state.reload()" />
            </label>
          </div>
        </div>
      </section>

      <section class="card" aria-label="Cursors">
        <header class="card-head"><h3>Symbols</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Kind · source</th>
                <th>Status</th>
                <th>Built span (UTC)</th>
                <th>Lag</th>
                <th>Bars · prints (excluded)</th>
              </tr>
            </thead>
            <tbody>
              @for (c of state.value().cursors; track c.id) {
                <tr>
                  <td><code>{{ c.symbol }}</code></td>
                  <td class="small">{{ c.kind }}<span class="sub">{{ c.sourceId ?? c.root ?? '—' }}</span></td>
                  <td>
                    <span class="chip" [class.ok]="c.status === 'Live'" [class.bad]="c.status === 'Blocked' || c.status === 'Stalled'">{{ c.status }}</span>
                    @if (c.note) {
                      <span class="sub">{{ c.note }}</span>
                    }
                  </td>
                  <td class="small">{{ when(c.builtFromUtc) }} → {{ when(c.builtToUtc) }}</td>
                  <td class="small">{{ lag(c.lagMinutes) }}</td>
                  <td class="small">{{ c.barsWritten }} · {{ c.tradesRead }} ({{ c.tradesExcluded }})</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted">No symbol has a builder cursor yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="card" aria-label="Continuous futures rolls">
        <header class="card-head"><h3>Continuous futures rolls</h3></header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Series</th>
                <th>Roll (UTC)</th>
                <th>From → to</th>
                <th>Prices</th>
                <th>Gap · ratio</th>
                <th>Observed from</th>
              </tr>
            </thead>
            <tbody>
              @for (r of state.value().rolls; track r.id) {
                <tr>
                  <td><code>{{ r.continuousSymbol }}</code></td>
                  <td class="small">{{ when(r.rollUtc) }}</td>
                  <td class="small">{{ r.fromContract }} → {{ r.toContract }}</td>
                  <td class="small">{{ r.fromPrice ?? '—' }} → {{ r.toPrice ?? '—' }}</td>
                  <td class="small">{{ r.gap }} · {{ r.ratio }}</td>
                  <td class="small">
                    <span class="chip" [class.warn]="r.priceSource === 'unobserved'">{{ r.priceSource }}</span>
                    <span class="sub">{{ when(r.observedAtUtc) }}</span>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="muted">No roll recorded.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
})
export class InstrumentCandlesPageComponent {
  private readonly api = inject(VenuesApiService);

  protected readonly when = when;
  protected readonly lag = lagText;

  readonly symbol = signal('');
  readonly state = iamResource<InstrumentCandleState>(
    () => this.api.instrumentCandleState({ symbol: this.symbol().trim() || undefined }),
    EMPTY,
    'Could not load the instrument candle state.',
  );
  readonly statuses = computed(() =>
    Object.entries(this.state.value().statusCounts ?? {}).map(([status, count]) => ({ status, count })),
  );

  constructor() {
    this.state.reload();
  }
}
