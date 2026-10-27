import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import { InstrumentsService } from '@core/instruments/instruments.service';
import type { SessionStateDto } from '@core/instruments/instrument.types';
import { errorText } from '@features/iam/iam.logic';
import { VenuesApiService } from '@features/venues/venues-api.service';
import { venueInstrumentFor } from '@features/venues/venues.logic';
import type { CryptoFundamentals, EquityFundamentals, FuturesTermStructure } from '@features/venues/venues.types';

import { fundingTone, sessionText, slopeWord } from './fundamentals.logic';

/**
 * The chart's fundamentals panel for an EXCHANGE-TRADED instrument (multi-asset WS7 7.9): the market's session state,
 * then per asset class — futures: the term structure (settlement, open interest and its change per contract, the
 * annualised slope), crypto: funding (now, 24 h mean, annualised, next), open interest and its 24 h change, the
 * mark/index basis and liquidations, equities: dividends, splits and the trailing yield. Built only from what the
 * engine holds (`instrument-fundamentals/*`): a blank says "no data", never a guess. The rail button is shown only
 * for exchange-traded symbols, so FX charts are unchanged.
 */
@Component({
  selector: 'app-fundamentals-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  template: `
    <div class="fp" data-testid="fundamentals-panel">
      @if (!instrument()) {
        <p class="fp-note">Fundamentals are shown for futures, crypto and equities. This symbol is traded through MT5.</p>
      } @else {
        <p class="fp-note" data-testid="fundamentals-session">{{ session() }}</p>
        @if (error(); as e) {
          <p class="fp-warn" role="alert">{{ e }}</p>
        }
        @if (loading()) {
          <p class="fp-note">Loading…</p>
        }

        @if (futures(); as f) {
          <h4>Term structure · {{ f.root }}{{ f.exchange ? ' (' + f.exchange + ')' : '' }}</h4>
          <table class="fp-grid">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Days</th>
                <th>Settle</th>
                <th>OI</th>
                <th>ΔOI</th>
              </tr>
            </thead>
            <tbody>
              @for (c of f.curve; track c.contract) {
                <tr [class.front]="c.isFront" [class.me]="c.contract === instrument()!.symbol">
                  <td>{{ c.contract }}</td>
                  <td>{{ c.daysToLastTrade ?? '—' }}</td>
                  <td>{{ c.settlement === null ? '—' : (c.settlement | number: '1.0-6') }}{{ c.settlementFinal === false ? '*' : '' }}</td>
                  <td>{{ c.openInterest === null ? '—' : (c.openInterest | number: '1.0-0') }}</td>
                  <td [class.up]="(c.openInterestChange ?? 0) > 0" [class.down]="(c.openInterestChange ?? 0) < 0">
                    {{ c.openInterestChange === null ? '—' : (c.openInterestChange | number: '1.0-0') }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <dl class="fp-facts">
            <dt>Slope</dt>
            <dd>{{ f.slopeAnnualPct === null ? '—' : (f.slopeAnnualPct | number: '1.2-2') + ' % / yr (' + slope(f.slopeAnnualPct) + ')' }}</dd>
            <dt>Total OI</dt>
            <dd>{{ f.totalOpenInterest === null ? '—' : (f.totalOpenInterest | number: '1.0-0') }}</dd>
            <dt>Listing</dt>
            <dd>{{ f.contractSource === 'master' ? 'instrument master' : 'catalog cycle' }}</dd>
          </dl>
          @for (n of f.notes; track n) {
            <p class="fp-note">{{ n }}</p>
          }
          <p class="fp-note">* preliminary settlement.</p>
        }

        @if (crypto(); as c) {
          <h4>Derivatives · {{ c.sourceId }}</h4>
          <dl class="fp-facts">
            <dt>Funding</dt>
            <dd [class]="tone(c.fundingRate)">
              {{ c.fundingRate === null ? '—' : (c.fundingRate * 100 | number: '1.4-4') + ' %' }}
              @if (c.fundingIntervalHours) {
                / {{ c.fundingIntervalHours }} h
              }
            </dd>
            <dt>Annualised</dt>
            <dd>{{ c.fundingAnnualPct === null ? '—' : (c.fundingAnnualPct | number: '1.1-1') + ' %' }}</dd>
            <dt>24 h mean</dt>
            <dd>{{ c.fundingMean24h === null ? '—' : (c.fundingMean24h * 100 | number: '1.4-4') + ' %' }}</dd>
            <dt>Next funding</dt>
            <dd>{{ c.nextFundingT ? (c.nextFundingT | date: 'HH:mm') : '—' }}</dd>
            <dt>Mark / index</dt>
            <dd>{{ c.mark ?? '—' }} / {{ c.index ?? '—' }}</dd>
            <dt>Basis</dt>
            <dd>{{ c.basisBps === null ? '—' : (c.basisBps | number: '1.1-1') + ' bps' }}</dd>
            <dt>Open interest</dt>
            <dd>
              {{ c.openInterest === null ? '—' : (c.openInterest | number: '1.0-2') }}
              {{ c.openInterestChange24hPct === null ? '' : '(' + (c.openInterestChange24hPct | number: '1.1-1') + ' % 24 h)' }}
            </dd>
            <dt>Liquidations 24 h</dt>
            <dd>
              {{ c.liquidationCount24h }} · longs {{ c.liquidationSellNotional24h | number: '1.0-0' }} · shorts
              {{ c.liquidationBuyNotional24h | number: '1.0-0' }}
            </dd>
          </dl>
          @for (n of c.notes; track n) {
            <p class="fp-note">{{ n }}</p>
          }
        }

        @if (equity(); as q) {
          <h4>{{ q.symbol }}{{ q.primaryExchange ? ' · ' + q.primaryExchange : '' }}</h4>
          <dl class="fp-facts">
            <dt>Dividends (12 m)</dt>
            <dd>{{ q.trailingDividendsPerShare | number: '1.2-4' }} {{ q.currency }} / share</dd>
            <dt>Yield</dt>
            <dd>{{ q.trailingYieldPct === null ? '—' : (q.trailingYieldPct | number: '1.2-2') + ' %' }}</dd>
            <dt>Next ex-date</dt>
            <dd>{{ q.nextExDate ? (q.nextExDate.exDate | date: 'yyyy-MM-dd') + ' · ' + q.nextExDate.cashAmount : '—' }}</dd>
            <dt>Last split</dt>
            <dd>{{ q.lastSplit ? (q.lastSplit.exDate | date: 'yyyy-MM-dd') + ' · ' + q.lastSplit.ratio + ' : 1' : '—' }}</dd>
            <dt>Shortable</dt>
            <dd>{{ q.shortable === null ? '—' : q.shortable ? 'yes' : 'no' }}</dd>
            <dt>Earnings</dt>
            <dd>no source</dd>
          </dl>
          @if (q.actions.length) {
            <table class="fp-grid">
              <thead>
                <tr>
                  <th>Ex-date</th>
                  <th>Action</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                @for (a of q.actions.slice(0, 12); track $index) {
                  <tr [class.front]="a.upcoming">
                    <td>{{ a.exDate | date: 'yyyy-MM-dd' }}</td>
                    <td>{{ a.kind }}</td>
                    <td>{{ a.cashAmount ?? a.ratio ?? a.newSymbol ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @for (n of q.notes; track n) {
            <p class="fp-note">{{ n }}</p>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .fp {
        padding: 0 10px 10px;
        font-size: 12px;
      }
      .fp h4 {
        margin: 8px 0 4px;
        font-size: 12px;
      }
      .fp-note {
        opacity: 0.75;
        margin: 4px 0;
      }
      .fp-warn {
        color: #ef5350;
        margin: 4px 0;
      }
      .fp-grid {
        width: 100%;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      .fp-grid th,
      .fp-grid td {
        text-align: right;
        padding: 2px 4px;
        border-bottom: 1px solid var(--border-1, #363a45);
      }
      .fp-grid th:first-child,
      .fp-grid td:first-child {
        text-align: left;
      }
      .fp-grid tr.front td {
        font-weight: 600;
      }
      .fp-grid tr.me td:first-child::after {
        content: ' ◂';
      }
      .up {
        color: #26a69a;
      }
      .down {
        color: #ef5350;
      }
      .fp-facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 8px;
        margin: 6px 0;
      }
      .fp-facts dt {
        opacity: 0.7;
      }
      .fp-facts dd {
        margin: 0;
      }
      .pos {
        color: #26a69a;
      }
      .neg {
        color: #ef5350;
      }
    `,
  ],
})
export class FundamentalsPanelComponent {
  private readonly api = inject(VenuesApiService);
  private readonly instruments = inject(InstrumentsService);

  readonly symbol = input.required<string>();

  readonly instrument = computed(() => venueInstrumentFor(this.symbol()));
  readonly futures = signal<FuturesTermStructure | null>(null);
  readonly crypto = signal<CryptoFundamentals | null>(null);
  readonly equity = signal<EquityFundamentals | null>(null);
  readonly sessionState = signal<SessionStateDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly session = computed(() => sessionText(this.sessionState(), Date.now()));

  protected readonly tone = fundingTone;
  protected readonly slope = slopeWord;

  private generation = 0;

  constructor() {
    effect(() => {
      const inst = this.instrument();
      untracked(() => this.load(inst));
    });
  }

  private load(inst: ReturnType<typeof venueInstrumentFor>): void {
    const mine = ++this.generation;
    this.futures.set(null);
    this.crypto.set(null);
    this.equity.set(null);
    this.error.set(null);
    this.sessionState.set(null);
    if (!inst) return;
    void this.instruments.sessionState(inst.symbol).then((s) => {
      if (mine === this.generation) this.sessionState.set(s);
    });
    this.loading.set(true);
    const done = () => mine === this.generation && this.loading.set(false);
    const fail = (e: unknown) => {
      if (mine !== this.generation) return;
      this.error.set(errorText(e, 'Fundamentals could not be loaded.'));
      this.loading.set(false);
    };
    if (inst.future) {
      this.api.futuresTermStructure(inst.future.root || inst.symbol).subscribe({
        next: (f) => mine === this.generation && this.futures.set(f),
        error: fail,
        complete: done,
      });
    } else if (inst.crypto) {
      const sourceId = `crypto-${(inst.exchange ?? '').toLowerCase()}`;
      this.api.cryptoFundamentals(inst.symbol, sourceId).subscribe({
        next: (c) => mine === this.generation && this.crypto.set(c),
        error: fail,
        complete: done,
      });
    } else {
      this.api.equityFundamentals(inst.symbol).subscribe({
        next: (q) => mine === this.generation && this.equity.set(q),
        error: fail,
        complete: done,
      });
    }
  }
}
