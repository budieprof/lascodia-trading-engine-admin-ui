import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import type { TradeSignalDto } from '@core/api/api.types';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { foldTimeline, originHeading, originRoute, outcomeSentence } from './signal-story.logic';
import type { SignalStory } from './signal-story.types';

/**
 * What the engine recorded about one signal, from GET trade-signal/{id}/story: summary tiles,
 * the lifecycle timeline, every gate verdict, where the signal came from, and how it ended.
 * An old signal that no EA ever polled still reads as a full story instead of one empty card.
 */
@Component({
  selector: 'app-signal-story-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, MetricCardComponent],
  template: `
    @let st = story();
    <div class="tiles">
      <app-metric-card
        label="Strategy"
        [value]="null"
        [displayValue]="st.strategyName ?? '#' + (signal()?.strategyId ?? '—')"
        dotColor="#0071E3"
      />
      <app-metric-card
        label="Source · confidence"
        [value]="null"
        [displayValue]="sourceText()"
        dotColor="#5AC8FA"
      />
      <app-metric-card
        label="Accounts accepted / blocked"
        [value]="null"
        [displayValue]="st.counts.accountsPassed + ' / ' + st.counts.accountsBlocked"
        [dotColor]="st.counts.accountsBlocked > 0 ? '#FF9500' : '#34C759'"
      />
      <app-metric-card
        label="Orders filled / placed"
        [value]="null"
        [displayValue]="st.counts.ordersFilled + ' / ' + st.counts.orders"
        dotColor="#AF52DE"
      />
      <app-metric-card
        label="Rejections (engine · EA)"
        [value]="null"
        [displayValue]="st.counts.engineRejections + ' · ' + st.counts.eaRejections"
        [dotColor]="st.counts.engineRejections + st.counts.eaRejections > 0 ? '#FF3B30' : '#34C759'"
      />
      <app-metric-card
        label="Outcome"
        [value]="null"
        [displayValue]="outcome().text"
        [dotColor]="
          outcome().tone === 'ok'
            ? '#34C759'
            : outcome().tone === 'bad'
              ? '#FF3B30'
              : outcome().tone === 'warn'
                ? '#FF9500'
                : '#8E8E93'
        "
      />
    </div>

    <div class="grid">
      <section class="card">
        <header class="card-head">
          <h3>Lifecycle</h3>
          <span class="muted small"
            >{{ st.timeline.length }} recorded step(s), oldest first · UTC</span
          >
        </header>
        @if (timeline().length === 0) {
          <p class="muted pad">
            The engine kept no dated steps for this signal beyond its creation.
          </p>
        } @else {
          <ol class="timeline">
            @for (e of timeline(); track $index) {
              <li [attr.data-tone]="e.tone">
                <span class="dot" aria-hidden="true"></span>
                <div class="t-body">
                  <div class="t-head">
                    @if (e.route) {
                      <a [routerLink]="e.route" class="t-title">{{ e.title }}</a>
                    } @else {
                      <span class="t-title">{{ e.title }}</span>
                    }
                    @if (e.repeat > 1) {
                      <span class="pill">×{{ e.repeat }}</span>
                    }
                    <time class="muted small" [attr.datetime]="e.at">{{
                      e.at | date: 'MMM d, HH:mm:ss' : 'UTC'
                    }}</time>
                  </div>
                  @if (e.detail) {
                    <p class="t-detail">{{ e.detail }}</p>
                  }
                </div>
              </li>
            }
          </ol>
        }
      </section>

      <div class="side">
        <section class="card">
          <header class="card-head">
            <h3>Gates and checks</h3>
            <span class="muted small">{{ st.gates.length }} verdict(s)</span>
          </header>
          @if (st.gates.length === 0) {
            <p class="muted pad">
              No gate left a verdict on this signal — it predates the rejection audit and the signal
              guard, or it went straight to the accounts.
            </p>
          } @else {
            <ul class="gates">
              @for (g of st.gates; track $index) {
                <li [class.bad]="!g.passed">
                  <span class="verdict" [class.ok]="g.passed">{{ g.verdict }}</span>
                  <span class="gate">{{ g.gate }}</span>
                  @if (g.detail) {
                    <span class="g-detail">{{ g.detail }}</span>
                  }
                </li>
              }
            </ul>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Where it came from</h3>
          </header>
          @if (st.origin; as o) {
            <div class="pad">
              <div class="origin-head">
                @if (originRoute(o); as r) {
                  <a [routerLink]="r">{{ originHeading(o) }} →</a>
                } @else {
                  <strong>{{ originHeading(o) }}</strong>
                }
                @if (o.confidence != null) {
                  <span class="pill">conf {{ o.confidence | number: '1.2-2' }}</span>
                }
              </div>
              @if (o.summary) {
                <p class="muted small">{{ o.summary }}</p>
              }
              @if (o.rationale) {
                <p class="rationale">{{ o.rationale }}</p>
              }
            </div>
          } @else {
            <p class="muted pad">
              {{ originFallback() }}
            </p>
          }
          <dl class="facts">
            @if (st.llmInvocationId) {
              <dt>LLM analysis</dt>
              <dd>
                <a routerLink="/conversations" [queryParams]="{ conversation: st.llmInvocationId }"
                  >conversation #{{ st.llmInvocationId }} ↗</a
                >
              </dd>
            }
            @if (st.analysisMonitorId) {
              <dt>Monitor</dt>
              <dd>
                <a routerLink="/analysis-monitors">#{{ st.analysisMonitorId }}</a>
              </dd>
            }
            @if (st.sweepRunId) {
              <dt>Sweep run</dt>
              <dd class="mono">{{ st.sweepRunId }}</dd>
            }
            @if (st.atrAtGeneration) {
              <dt>ATR at generation</dt>
              <dd class="mono">{{ st.atrAtGeneration | number: '1.5-5' }}</dd>
            }
            @if (st.strategyType) {
              <dt>Strategy type</dt>
              <dd>{{ st.strategyType }} · {{ st.strategyStatus }}</dd>
            }
          </dl>
        </section>

        @if (st.review || st.ghostOutcome || st.cost) {
          <section class="card">
            <header class="card-head"><h3>How it ended</h3></header>
            <dl class="facts">
              @if (st.review; as rv) {
                <dt>Review journal</dt>
                <dd>
                  {{ rv.outcomeKind }} · {{ rv.closeReason }}
                  @if (rv.realizedPips != null) {
                    · {{ rv.realizedPips | number: '1.1-1' }} pips
                  }
                </dd>
              }
              @if (st.ghostOutcome) {
                <dt title="What the signal would have done had it been traded exactly as written">
                  Shadow outcome
                </dt>
                <dd>
                  {{ st.ghostOutcome }}
                  @if (st.ghostPnLPips != null) {
                    · {{ st.ghostPnLPips | number: '1.1-1' }} pips
                  }
                </dd>
              }
              @if (st.cost; as c) {
                <dt>Execution cost</dt>
                <dd>
                  {{ c.avgTotalCostBps | number: '1.1-2' }} bps avg over {{ c.fills }} fill(s) ·
                  signal→fill {{ c.avgSignalToFillMs / 1000 | number: '1.1-1' }} s
                </dd>
              }
            </dl>
            @if (st.review?.outcome; as text) {
              <p class="rationale pad-x">{{ text }}</p>
            }
          </section>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-3);
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: var(--space-4);
        align-items: start;
      }
      .side {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      @media (max-width: 1200px) {
        .tiles {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 700px) {
        .tiles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .pad {
        padding: var(--space-3) var(--space-4);
        margin: 0;
      }
      .pad-x {
        padding: 0 var(--space-4) var(--space-3);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .timeline {
        list-style: none;
        margin: 0;
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .timeline li {
        display: grid;
        grid-template-columns: 12px minmax(0, 1fr);
        gap: var(--space-2);
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-top: 4px;
        background: var(--text-tertiary);
      }
      li[data-tone='ok'] .dot {
        background: var(--profit);
      }
      li[data-tone='warn'] .dot {
        background: var(--warning);
      }
      li[data-tone='bad'] .dot {
        background: var(--loss);
      }
      li[data-tone='info'] .dot {
        background: var(--accent);
      }
      .t-head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-2);
      }
      .t-title {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      a.t-title {
        color: var(--accent);
      }
      .t-detail {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .pill {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .gates {
        list-style: none;
        margin: 0;
        padding: var(--space-2) var(--space-4) var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .gates li {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        column-gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .verdict {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss);
        align-self: start;
      }
      .verdict.ok {
        background: rgba(52, 199, 89, 0.14);
        color: var(--profit);
      }
      .g-detail {
        grid-column: 2;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }
      .origin-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .origin-head a {
        color: var(--accent);
        font-weight: var(--font-medium);
      }
      .rationale {
        font-size: var(--text-sm);
        line-height: 1.5;
        margin: var(--space-2) 0 0;
        color: var(--text-primary);
        white-space: pre-line;
      }
      .facts {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 4px var(--space-3);
        margin: 0;
        padding: var(--space-2) var(--space-4) var(--space-3);
        font-size: var(--text-sm);
      }
      .facts dt {
        color: var(--text-secondary);
      }
      .facts dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .facts a {
        color: var(--accent);
      }
    `,
  ],
})
export class SignalStoryPanelComponent {
  readonly story = input.required<SignalStory>();
  readonly signal = input<TradeSignalDto | null>(null);

  readonly timeline = computed(() => foldTimeline(this.story().timeline));
  readonly outcome = computed(() => outcomeSentence(this.story()));

  readonly sourceText = computed(() => {
    const s = this.signal();
    if (!s) return '—';
    const src = s.source === 'SpotAnalysis' ? 'LLM analysis' : s.source;
    return `${src} · ${Math.round((s.confidence ?? 0) * 100)}%`;
  });

  readonly originFallback = computed(() => {
    const s = this.signal();
    if (!s) return 'No upstream record links to this signal.';
    if (s.source === 'Strategy')
      return 'Generated directly by its strategy — no recommendation, parked rec or plan sits upstream.';
    if (s.source === 'Manual' || s.isManual)
      return 'Entered by hand (manual signal) — nothing upstream to show.';
    return 'From an LLM analysis that predates recommendation cards; the LLM call below is its record.';
  });

  originHeading = originHeading;
  originRoute = originRoute;
}
