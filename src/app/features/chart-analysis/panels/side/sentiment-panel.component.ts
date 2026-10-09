import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import { currencyFlag } from '../economic-calendar';
import { ZonedDatePipe } from '../zoned-time';
import { ChartPanelsService } from './chart-panels.service';
import { cotIsStale, longShare, newsChange, sentimentWord, tiltWords } from './sentiment';
import type { CurrencySentiment, PairSentiment } from './chart-panels.types';

const REFRESH_MS = 120_000;

/**
 * Sentiment for the pair's two currencies (SP-I9): the engine's news pressure per currency (−1 … +1, from analysed
 * headlines, with its change over 24 hours) and the latest CFTC Commitments of Traders positioning of each currency's
 * future. It says plainly what it cannot show: there is no broker retail-positioning (client long/short) feed.
 */
@Component({
  selector: 'app-sentiment-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, ZonedDatePipe],
  template: `
    @if (error(); as e) {
      <div class="pane-empty">{{ e }}</div>
    } @else if (!data()) {
      <div class="pane-empty">Loading…</div>
    } @else {
      @let d = data()!;
      @if (!d.base) {
        <div class="pane-empty">{{ d.symbol }} has no currency legs, so there is no currency sentiment for it.</div>
      } @else {
        <div class="sp-tilt">
          News:
          <b [class.up]="(d.newsTilt ?? 0) > 0" [class.down]="(d.newsTilt ?? 0) < 0">{{
            tilt(d.newsTilt, d.base, d.quote)
          }}</b>
          @if (d.newsTilt !== null) {
            <span class="muted">({{ d.newsTilt > 0 ? '+' : '' }}{{ d.newsTilt | number: '1.2-2' }})</span>
          }
        </div>
        @for (leg of [d.baseSentiment, d.quoteSentiment]; track $index) {
          @let ccy = $index === 0 ? d.base : d.quote;
          <section class="sp-leg">
            <h4>{{ flag(ccy ?? '') }} {{ ccy }}</h4>
            @if (!leg) {
              <p class="muted">No news pressure and no COT report for {{ ccy }}.</p>
            } @else {
              <dl>
                <dt title="The engine's roll-up of analysed headlines, −1 bearish … +1 bullish">News pressure</dt>
                <dd>
                  @if (leg.newsScore !== null) {
                    <b [class.up]="leg.newsScore > 0.15" [class.down]="leg.newsScore < -0.15"
                      >{{ leg.newsScore > 0 ? '+' : '' }}{{ leg.newsScore | number: '1.2-2' }}</b
                    >
                    {{ word(leg.newsScore) }}
                    @if (change(leg); as c) {
                      <span class="muted"> · {{ c > 0 ? '+' : '' }}{{ c | number: '1.2-2' }} in 24 h</span>
                    }
                  } @else {
                    <span class="muted">no reading</span>
                  }
                </dd>
                @if (leg.newsConfidence !== null) {
                  <dt title="How much news is behind the score: one marginal headline scores low">Weight of news</dt>
                  <dd>{{ leg.newsConfidence * 100 | number: '1.0-0' }}%</dd>
                }
                @if (leg.newsAsOfUtc) {
                  <dt>As of</dt>
                  <dd class="muted">{{ leg.newsAsOfUtc | zonedDate: timeZone() : 'dateTime' }}</dd>
                }
                <dt title="CFTC Commitments of Traders: large speculators (non-commercials) in the currency future">
                  COT speculators
                </dt>
                <dd>
                  @if (leg.cotReportDate) {
                    {{ longPct(leg.cotSpeculatorsLongPct) }}
                    @if (leg.cotNet !== null) {
                      <span class="muted">
                        · net {{ leg.cotNet | number: '1.0-0' }}
                        @if (leg.cotNetChangeWeekly !== null) {
                          ({{ leg.cotNetChangeWeekly > 0 ? '+' : '' }}{{ leg.cotNetChangeWeekly | number: '1.0-0' }} w/w)
                        }
                      </span>
                    }
                  } @else {
                    <span class="muted">no report</span>
                  }
                </dd>
                @if (leg.cotReportDate) {
                  <dt title="Futures traders below the CFTC reporting size — not FX broker clients">Small traders</dt>
                  <dd>
                    {{ leg.cotSmallTradersLong | number: '1.0-0' }} long ·
                    {{ leg.cotSmallTradersShort | number: '1.0-0' }} short
                  </dd>
                  <dt>COT report</dt>
                  <dd [class.down]="staleCot(leg.cotReportDate)">
                    positions of {{ leg.cotReportDate | zonedDate: 'UTC' : 'day' }}
                    @if (staleCot(leg.cotReportDate)) {
                      — over 10 days old
                    }
                  </dd>
                }
              </dl>
            }
          </section>
        }
        <p class="sp-note">{{ d.retailPositioningNote }}</p>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
        font-size: 12px;
      }
      .sp-tilt {
        padding: 0 10px 8px;
      }
      .sp-leg {
        padding: 6px 10px;
        border-top: 1px solid var(--tv-line, #e0e3eb);
      }
      .sp-leg h4 {
        margin: 0 0 4px;
        font-size: 12px;
      }
      dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 10px;
        margin: 0;
      }
      dt {
        color: var(--tv-muted, #787b86);
      }
      dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }
      .up {
        color: #089981;
      }
      .down {
        color: #f23645;
      }
      .muted {
        color: var(--tv-muted, #787b86);
      }
      .sp-note {
        margin: 8px 10px;
        font-size: 11px;
        color: var(--tv-muted, #787b86);
      }
    `,
  ],
})
export class SentimentPanelComponent {
  private readonly api = inject(ChartPanelsService);

  readonly symbol = input.required<string>();
  readonly timeZone = input<string | null>(null);

  readonly data = signal<PairSentiment | null>(null);
  readonly error = signal<string | null>(null);

  readonly flag = currencyFlag;
  readonly word = sentimentWord;
  readonly longPct = longShare;
  readonly tilt = tiltWords;
  private seq = 0;

  constructor() {
    effect((onCleanup) => {
      const symbol = this.symbol();
      untracked(() => {
        this.data.set(null);
        void this.read(symbol);
      });
      const timer = setInterval(() => {
        if (!document.hidden) void this.read(symbol);
      }, REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => this.seq++);
  }

  change(leg: CurrencySentiment): number | null {
    return newsChange(leg);
  }

  staleCot(reportDate: string | null): boolean {
    return cotIsStale(reportDate, Date.now());
  }

  private async read(symbol: string): Promise<void> {
    const n = ++this.seq;
    try {
      const d = await firstValueFrom(this.api.sentiment(symbol));
      if (n !== this.seq) return;
      this.data.set(d);
      this.error.set(null);
    } catch (e) {
      if (n !== this.seq) return;
      this.error.set(e instanceof Error && e.message ? e.message : 'Sentiment could not be loaded.');
    }
  }
}
