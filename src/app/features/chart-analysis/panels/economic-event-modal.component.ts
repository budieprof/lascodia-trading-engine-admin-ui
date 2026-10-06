import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import {
  EconomicCalendarService,
  type EconomicEventAnalysis,
  type EconomicEventOutcome,
  type UpcomingEconomicEvent,
} from '@core/services/economic-calendar.service';
import { ServerClock } from '@core/time/server-clock';
import { currencyFlag, eventCountdown, impactDots, isEventPast } from './economic-calendar';

/**
 * An economic event's detail: the stored numbers (previous, forecast = consensus, actual), and an
 * AI reading — what it is, why it matters, and a beat / in-line / miss SCENARIO reading with an
 * explicit uncertainty statement. Never a trade call: the desk's research found surprise size
 * carries no reliable direction or magnitude signal. Styled like the news reading.
 */
@Component({
  selector: 'app-economic-event-modal',
  standalone: true,
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="na-backdrop" (click)="closed.emit()"></div>
    <section
      class="na-modal"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="'Economic event: ' + event().title"
    >
      <header class="na-head">
        <div>
          <div class="na-meta">
            {{ flag(event().currency) }} {{ event().currency }} · {{ event().impact }} importance ·
            {{ event().scheduledAt | date: 'EEE d MMM, HH:mm' }}
            @if (countdown(); as c) {
              · <b class="ee-count">{{ c }}</b>
            }
          </div>
          <h2 class="na-title">{{ event().title }}</h2>
        </div>
        <button type="button" class="na-x" (click)="closed.emit()" aria-label="Close">×</button>
      </header>

      <table class="ee-facts">
        <tbody>
          <tr>
            <th>Previous</th>
            <th>Forecast (consensus)</th>
            <th>Actual</th>
            <th>Importance</th>
          </tr>
          <tr>
            <td>{{ event().previous ?? 'not stored' }}</td>
            <td>
              {{ event().forecast ?? 'not stored' }}
              @if (event().forecast && event().forecastProvenance !== 'PreRelease') {
                <span class="muted" title="Not captured before the release">
                  ({{ event().forecastProvenance }})</span
                >
              }
            </td>
            <td class="ee-act">
              {{ event().actual ?? (isPast() ? 'none stored' : 'not released') }}
            </td>
            <td>
              <span class="ee-dots">
                @for (i of [1, 2, 3]; track i) {
                  <i [class.on]="i <= dots()" [class.high]="dots() === 3"></i>
                }
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      @if (loading()) {
        <div class="na-loading"><span class="spin"></span> Reading the event…</div>
      } @else if (error()) {
        <div class="na-error">
          {{ error() }} <button type="button" class="link" (click)="load(true)">Retry</button>
        </div>
      } @else if (result(); as r) {
        @if (r.phase === 'PostEvent') {
          <div class="ee-badge" data-testid="ee-post">Event has happened · post-event reading</div>
          @if (r.summary) {
            <p>{{ r.summary }}</p>
          }
          <h3>Outcome</h3>
          @if (r.outcome; as o) {
            <p class="ee-fact" data-testid="ee-outcome">
              {{ o.statement }}
              @if (o.vsForecastDirection && o.polarity !== 'Unknown') {
                <span class="chip" [class]="outcomeTone(o)"
                  >{{ outcomeWord(o) }} for {{ event().currency }}</span
                >
              }
            </p>
          }
          @if (r.releaseReading) {
            <p>{{ r.releaseReading }}</p>
          }

          @if (r.coverage?.length) {
            <h3>Coverage cited</h3>
            <ul class="ee-cov" data-testid="ee-coverage">
              @for (c of r.coverage; track c.id) {
                <li>
                  @if (c.url) {
                    <a [href]="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }}</a>
                  } @else {
                    {{ c.title }}
                  }
                  <span class="muted">
                    · {{ c.source }} · {{ c.publishedAtUtc | date: 'd MMM HH:mm' }}</span
                  >
                </li>
              }
            </ul>
          } @else if (r.outcome?.kind === 'Speech') {
            <p class="muted" data-testid="ee-no-coverage">
              No news coverage of this event was found, so what was said is not known here.
            </p>
          }

          <h3>Market reaction</h3>
          @if (r.reaction?.length) {
            <table class="ee-react" data-testid="ee-reaction">
              <thead>
                <tr>
                  <th></th>
                  <th>Before</th>
                  <th>+15 min</th>
                  <th>+1 h</th>
                  <th>Now</th>
                </tr>
              </thead>
              <tbody>
                @for (m of r.reaction; track m.symbol) {
                  <tr [class.focus]="m.symbol === symbol()" [title]="m.note ?? ''">
                    <td class="sym">{{ m.symbol }}</td>
                    <td>{{ m.before ?? '—' }}</td>
                    <td [class]="pipTone(m.pips15m)">{{ pips(m.pips15m) }}</td>
                    <td [class]="pipTone(m.pips1h)">{{ pips(m.pips1h) }}</td>
                    <td [class]="pipTone(m.pipsNow)">{{ pips(m.pipsNow) }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="muted ee-small">
              Pips from the last M1 close before the event. Measured facts, not a forecast.
            </p>
          } @else {
            <p class="muted">No pairs to measure.</p>
          }

          <h3>
            The read
            @if (r.readLabel) {
              <span class="chip" [class]="readTone(r.readLabel)" data-testid="ee-read-label">{{
                r.readLabel
              }}</span>
            }
          </h3>
          <p data-testid="ee-read">{{ r.read }}</p>
          @if (r.reactionAgreement) {
            <p class="muted">{{ r.reactionAgreement }}</p>
          }

          @if (r.implications?.length) {
            <h3>Implications</h3>
            <table class="na-pairs" data-testid="ee-implications">
              <tbody>
                @for (i of r.implications; track i.symbol) {
                  <tr [class.focus]="i.symbol === symbol()">
                    <td class="sym">{{ i.symbol }}</td>
                    <td class="why">{{ i.text }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        } @else {
          <h3>Summary</h3>
          <p data-testid="ee-summary">{{ r.summary }}</p>
          @if (r.whyItMatters) {
            <h3>Why it matters</h3>
            <p>{{ r.whyItMatters }}</p>
          }
          @if (r.releaseReading) {
            <h3>The release</h3>
            <p class="ee-release">{{ r.releaseReading }}</p>
          }
          <h3>Analysis</h3>
          <p>{{ r.analysis }}</p>
          @if (r.expectation) {
            <h3>What is expected</h3>
            <p>{{ r.expectation }}</p>
          }

          <h3>Scenarios</h3>
          @if (r.scenarios.length) {
            <table class="na-pairs ee-scen" data-testid="ee-scenarios">
              <tbody>
                @for (s of r.scenarios; track s.case) {
                  <tr>
                    <td class="sym">{{ caseLabel(s.case) }}</td>
                    <td class="why">
                      {{ s.whatItMeans }}
                      <div class="muted">{{ s.likelyReaction }}</div>
                      @if (s.pairs.length) {
                        <div class="ee-pairs">
                          @for (p of s.pairs; track p.symbol) {
                            <span
                              class="chip"
                              [class]="tone(p.reaction)"
                              [class.focus]="p.symbol === symbol()"
                              >{{ p.symbol }} {{ arrow(p.reaction) }}</span
                            >
                          }
                        </div>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted">The model gave no scenarios.</p>
          }
        }

        <h3>How sure is this?</h3>
        <p class="ee-uncertain">{{ r.uncertainty }}</p>

        @if (r.whatWouldChange.length) {
          <h3>What would change the read</h3>
          <ul class="na-risks">
            @for (k of r.whatWouldChange; track k) {
              <li>{{ k }}</li>
            }
          </ul>
        }

        @if (r.dataNotes.length) {
          <h3>About the data</h3>
          <ul class="na-risks muted">
            @for (n of r.dataNotes; track n) {
              <li>{{ n }}</li>
            }
          </ul>
        }

        <footer class="na-foot">
          <span
            >{{ r.model }} · {{ r.generatedAtUtc | date: 'd MMM HH:mm'
            }}{{ r.cached ? ' · cached' : '' }}</span
          >
          @if (r.llmInvocationId) {
            <a [routerLink]="['/conversations']" [queryParams]="{ conversation: r.llmInvocationId }"
              >#{{ r.llmInvocationId }}</a
            >
          }
          <button type="button" class="link" (click)="load(true)" data-testid="ee-regenerate">
            Regenerate
          </button>
        </footer>
        <p class="na-disclaimer">
          AI reading for context only — not a signal; the engine does not trade on it.
        </p>
      }
    </section>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
      }
      .na-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
      }
      .na-modal {
        position: relative;
        width: min(720px, calc(100vw - 32px));
        max-height: calc(100vh - 64px);
        overflow-y: auto;
        padding: 18px 22px 16px;
        border-radius: 10px;
        background: var(--tv-bg, #fff);
        color: var(--tv-ink, #131722);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
        font-size: 13px;
        line-height: 1.5;
      }
      .na-head {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .na-head > div {
        flex: 1;
      }
      .na-meta,
      .muted,
      .na-foot,
      .na-disclaimer {
        color: var(--tv-muted, #787b86);
        font-size: 12px;
      }
      .na-title {
        margin: 2px 0 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.35;
      }
      .na-x {
        border: 0;
        background: none;
        color: inherit;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }
      .na-labels {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 10px 0 2px;
      }
      .chip {
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        background: var(--tv-hover, #f0f3fa);
      }
      h3 {
        margin: 16px 0 4px;
        font-size: 13px;
        font-weight: 600;
      }
      p {
        margin: 0;
      }
      .bullish {
        color: #089981;
      }
      .bearish {
        color: #f23645;
      }
      .neutral {
        color: var(--tv-muted, #787b86);
      }
      .na-pairs {
        width: 100%;
        border-collapse: collapse;
      }
      .na-pairs td {
        padding: 6px 8px 6px 0;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
        vertical-align: top;
      }
      .na-pairs tr.focus .sym {
        font-weight: 700;
      }
      .sym,
      .bias,
      .hz,
      .conf {
        white-space: nowrap;
      }
      .bias {
        font-weight: 600;
      }
      .conf {
        font-variant-numeric: tabular-nums;
      }
      .bar {
        display: inline-block;
        width: 48px;
        height: 4px;
        margin-right: 6px;
        border-radius: 2px;
        background: var(--tv-line, #e0e3eb);
        vertical-align: middle;
        overflow: hidden;
      }
      .bar i {
        display: block;
        height: 100%;
        background: currentColor;
      }
      .bar i.neutral {
        background: var(--tv-muted, #787b86);
      }
      .bar i.bullish {
        background: #089981;
      }
      .bar i.bearish {
        background: #f23645;
      }
      .why {
        color: var(--tv-ink, #131722);
      }
      .na-risks {
        margin: 0;
        padding-left: 18px;
        list-style: disc;
      }
      .na-foot {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin-top: 16px;
      }
      .na-foot a,
      .link {
        color: var(--tv-blue, #2962ff);
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
      }
      .na-disclaimer {
        margin-top: 6px;
        font-size: 11px;
      }
      .na-loading,
      .na-error {
        padding: 28px 0;
        text-align: center;
        color: var(--tv-muted, #787b86);
      }
      .na-error {
        color: #f23645;
      }
      .spin {
        display: inline-block;
        width: 12px;
        height: 12px;
        margin-right: 6px;
        vertical-align: -1px;
        border: 2px solid var(--tv-line, #e0e3eb);
        border-top-color: var(--tv-blue, #2962ff);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      .ee-facts {
        width: 100%;
        margin: 12px 0 4px;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      .ee-facts th {
        text-align: left;
        font-weight: 500;
        font-size: 11px;
        color: var(--tv-muted, #787b86);
        padding: 0 8px 2px 0;
      }
      .ee-facts td {
        padding: 0 8px 0 0;
        font-weight: 600;
      }
      .ee-act,
      .ee-count {
        color: var(--tv-blue, #2962ff);
      }
      .ee-dots {
        display: inline-flex;
        gap: 2px;
      }
      .ee-dots i {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--tv-line, #e0e3eb);
      }
      .ee-dots i.on {
        background: #f7a600;
      }
      .ee-dots i.on.high {
        background: #f23645;
      }
      .ee-pairs {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .chip.focus {
        font-weight: 700;
      }
      .ee-uncertain {
        padding: 8px 10px;
        border-radius: 6px;
        background: var(--tv-hover, #f0f3fa);
      }
      .ee-release {
        font-weight: 500;
      }
      .ee-badge {
        display: inline-block;
        margin: 10px 0 2px;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        background: var(--tv-hover, #f0f3fa);
        color: var(--tv-muted, #787b86);
      }
      .ee-fact {
        font-weight: 500;
      }
      .ee-fact .chip {
        margin-left: 6px;
      }
      .ee-cov {
        margin: 0;
        padding-left: 18px;
      }
      .ee-cov a {
        color: var(--tv-blue, #2962ff);
        text-decoration: none;
      }
      .ee-react {
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
      }
      .ee-react th {
        font-weight: 500;
        font-size: 11px;
        color: var(--tv-muted, #787b86);
        text-align: right;
        padding: 0 0 2px 14px;
      }
      .ee-react td {
        text-align: right;
        padding: 3px 0 3px 14px;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
      }
      .ee-react td.sym {
        text-align: left;
        padding-left: 0;
        font-weight: 600;
      }
      .ee-react tr.focus td.sym {
        font-weight: 700;
      }
      .ee-small {
        font-size: 11px;
        margin-top: 4px;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class EconomicEventModalComponent {
  readonly event = input.required<UpcomingEconomicEvent>();
  /** The chart's symbol — always read against, listed first. */
  readonly symbol = input<string | null>(null);
  readonly closed = output<void>();

  private readonly calendar = inject(EconomicCalendarService);
  private readonly clock = inject(ServerClock);
  private readonly destroyRef = inject(DestroyRef);

  readonly result = signal<EconomicEventAnalysis | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly now = signal(Date.now());
  private seq = 0;

  readonly id = computed(() => this.event().id);
  readonly dots = computed(() => impactDots(this.event().impact));
  readonly countdown = computed(() => eventCountdown(this.event(), this.now()));
  readonly isPast = computed(() => isEventPast(this.event(), this.now()));

  constructor() {
    effect(() => {
      this.id();
      untracked(() => this.load(false));
    });
    const t = setInterval(() => this.now.set(this.clock.now()), 1000);
    this.destroyRef.onDestroy(() => clearInterval(t));
  }

  load(refresh: boolean): void {
    const n = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const sub = this.calendar.analyse(this.id(), this.symbol(), refresh).subscribe({
      next: (r) => {
        if (n !== this.seq) return;
        this.result.set(r);
        this.loading.set(false);
      },
      error: (e: unknown) => {
        if (n !== this.seq) return;
        this.error.set(e instanceof Error ? e.message : 'Analysis unavailable.');
        this.loading.set(false);
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected flag = currencyFlag;

  protected pips(p: number | null): string {
    return p === null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}`;
  }

  protected pipTone(p: number | null): string {
    return p === null || p === 0 ? 'neutral' : p > 0 ? 'bullish' : 'bearish';
  }

  /** Beat / Miss for the currency: above the forecast is better unless the indicator is inverse. */
  protected outcomeWord(o: EconomicEventOutcome): string {
    if (o.vsForecastDirection === 'Equal') return 'In line';
    const higher = o.vsForecastDirection === 'Above';
    return higher === (o.polarity !== 'Inverse') ? 'Beat' : 'Miss';
  }

  protected outcomeTone(o: EconomicEventOutcome): string {
    const w = this.outcomeWord(o);
    return w === 'Beat' ? 'bullish' : w === 'Miss' ? 'bearish' : 'neutral';
  }

  protected readTone(label: string): string {
    return label === 'Hawkish' || label === 'Beat'
      ? 'bullish'
      : label === 'Dovish' || label === 'Miss'
        ? 'bearish'
        : 'neutral';
  }

  protected caseLabel(c: string): string {
    return c === 'Inline' ? 'In line' : c;
  }

  protected tone(reaction: string): string {
    return reaction === 'Up' ? 'bullish' : reaction === 'Down' ? 'bearish' : 'neutral';
  }

  protected arrow(reaction: string): string {
    return reaction === 'Up' ? '↑' : reaction === 'Down' ? '↓' : reaction === 'Mixed' ? '↕' : '→';
  }
}
