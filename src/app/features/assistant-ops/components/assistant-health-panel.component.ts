import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, of } from 'rxjs';

import { createPolledResource } from '@core/polling/polled-resource';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import {
  SPLITS,
  WINDOWS,
  breachFromAlert,
  compact,
  countsText,
  duration,
  humanise,
  isQuiet,
  ms,
  pct,
  usd,
  type Split,
} from '../assistant-ops.logic';
import type { AssistantTurnStats } from '../assistant-ops.types';

const GOOD = '#34C759';
const WARN = '#FF9500';
const BAD = '#FF3B30';
const NEUTRAL = '#8E8E93';
const INFO = '#0071E3';

/**
 * The assistant's health at a glance (`GET assistant/metrics`): headline tiles for the chosen
 * window and split, the engine's own active health alerts, approval outcomes, outcomes per
 * question and the per-tool breakdown.
 */
@Component({
  selector: 'app-assistant-health-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    FeatureStateComponent,
    RefreshButtonComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="panel">
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Time window">
          @for (w of windows; track w.hours) {
            <button
              type="button"
              [class.on]="hours() === w.hours"
              [attr.aria-pressed]="hours() === w.hours"
              (click)="setHours(w.hours)"
            >
              {{ w.label }}
            </button>
          }
        </div>
        <div class="seg" role="group" aria-label="Which questions">
          @for (s of splits; track s.value) {
            <button
              type="button"
              [class.on]="split() === s.value"
              [attr.aria-pressed]="split() === s.value"
              (click)="split.set(s.value)"
            >
              {{ s.label }}
            </button>
          }
        </div>
        <span class="spacer"></span>
        @if (metrics.lastUpdated(); as at) {
          <span class="muted small">Updated {{ at | date: 'HH:mm:ss' }}</span>
        }
        <app-refresh-button [refreshing]="metrics.refreshing()" (refresh)="refresh()" />
      </div>

      @if (breaches().length > 0) {
        <section class="breaches" role="alert" aria-label="Active assistant health alerts">
          <h3>Needs attention</h3>
          <ul>
            @for (b of breaches(); track b.key) {
              <li>
                <strong>{{ b.title }}</strong>
                <span class="sev">{{ b.severity }}</span>
                <p>{{ b.detail }}</p>
                @if (b.since) {
                  <span class="muted small" [title]="b.since | date: 'yyyy-MM-dd HH:mm' : 'UTC'"
                    >Raised {{ b.since | relativeTime }} · checked by the engine every few minutes
                    over its own alert window</span
                  >
                }
              </li>
            }
          </ul>
        </section>
      }

      @if (metrics.loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (metrics.error() && !metrics.value()) {
        <app-error-state
          title="Could not load the assistant's health"
          message="The engine did not answer GET assistant/metrics. Check it is reachable; an engine older than the assistant harness does not have this endpoint."
          (retry)="refresh()"
        />
      } @else if (metrics.value(); as m) {
        @if (quiet()) {
          <app-feature-state
            kind="waiting"
            title="No assistant questions in this window"
            [summary]="
              'Nobody asked the assistant anything ' +
              windowLabel().toLowerCase() +
              (split() === 'all' ? '' : ' in this group') +
              ', so there is nothing to measure yet.'
            "
            detail="Figures appear here once questions are asked in the assistant dock or on the Conversations page, or once the engine runs the assistant on its own (Patient Trader)."
            [links]="[{ label: 'Open Conversations', route: '/conversations' }]"
          />
        } @else if (stats(); as s) {
          <section class="kpis" aria-label="Headline figures">
            <app-metric-card
              label="Questions"
              [value]="s.turns"
              [caption]="s.answered + ' answered (' + pctOf(s.finalAnswerRate) + ')'"
              [dotColor]="INFO"
            />
            <app-metric-card
              label="Posted unverified"
              [displayValue]="pctOf(s.unverifiedRate, s.answerAttempts)"
              [caption]="s.unverified + ' of ' + s.answerAttempts + ' answers'"
              [dotColor]="tone(s.unverifiedRate, 0.15, 0.3, s.answerAttempts)"
            />
            <app-metric-card
              label="Held by the checks"
              [displayValue]="pctOf(s.holdRate, s.answerAttempts)"
              [caption]="holdsCaption(s)"
              [dotColor]="NEUTRAL"
            />
            <app-metric-card
              label="Time per question"
              [displayValue]="dur(s.wallP50Seconds)"
              [caption]="'slowest 5%: ' + dur(s.wallP95Seconds)"
              [dotColor]="NEUTRAL"
            />
            <app-metric-card
              label="Tool errors"
              [displayValue]="pctOf(s.toolErrorRate, s.avgToolCalls)"
              [caption]="s.avgToolCalls + ' tool calls per question'"
              [dotColor]="tone(s.toolErrorRate, 0.2, 0.4, s.avgToolCalls)"
            />
            <app-metric-card
              label="Cost"
              [displayValue]="money(s.notionalCostUsd)"
              [caption]="money(s.avgNotionalCostUsd) + ' per question'"
              [dotColor]="NEUTRAL"
            />
          </section>
          <section class="kpis" aria-label="More figures">
            <app-metric-card
              label="Approvals accepted"
              [displayValue]="pctOf(m.approvals.approvalRate, decided())"
              [caption]="m.approvals.confirmed + ' of ' + decided() + ' decided cards'"
              [dotColor]="INFO"
            />
            <app-metric-card
              label="Failed after approval"
              [displayValue]="
                pctOf(
                  m.approvals.failedAfterConfirmRate,
                  m.approvals.confirmed + m.approvals.failed
                )
              "
              [caption]="m.approvals.failed + ' approved cards failed to run'"
              [dotColor]="m.approvals.failed > 0 ? WARN : NEUTRAL"
            />
            <app-metric-card
              label="Stopped by pre-check"
              [value]="s.preflightBlocks"
              caption="writes that would have failed, sent back before a card"
              [dotColor]="NEUTRAL"
            />
            <app-metric-card
              label="Paused at a checkpoint"
              [displayValue]="pctOf(s.checkpointRate, s.turns)"
              caption="questions that stopped to ask for more budget"
              [dotColor]="NEUTRAL"
            />
            <app-metric-card
              label="Prompt cache hits"
              [displayValue]="pctOf(s.cacheHitRatio, s.tokensInput)"
              [caption]="num(s.tokensInput) + ' in · ' + num(s.tokensOutput) + ' out tokens'"
              [dotColor]="NEUTRAL"
            />
            <app-metric-card
              label="Spend guard refusals"
              [value]="s.spendGuardTrips"
              caption="questions refused at a budget ceiling"
              [dotColor]="s.spendGuardTrips > 0 ? BAD : NEUTRAL"
            />
          </section>

          <div class="grid2">
            <section class="card">
              <header class="card-head">
                <h3>How questions ended</h3>
                <span class="sub">Latest outcome of each question</span>
              </header>
              @if (outcomeRows().length === 0) {
                <p class="pad muted">No outcomes recorded.</p>
              } @else {
                <table class="t">
                  <tbody>
                    @for (o of outcomeRows(); track o.key) {
                      <tr>
                        <td>{{ o.label }}</td>
                        <td class="num">{{ o.count }}</td>
                        <td class="bar-cell">
                          <span class="bar" [style.width.%]="o.share * 100"></span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>
            <section class="card">
              <header class="card-head">
                <h3>Per question, on average</h3>
              </header>
              <dl class="facts">
                <dt>Rounds with the model</dt>
                <dd>{{ s.avgRounds }}</dd>
                <dt>Model calls</dt>
                <dd>{{ s.avgModelCalls }}</dd>
                <dt>Tool calls</dt>
                <dd>{{ s.avgToolCalls }}</dd>
                <dt>Tokens in / out</dt>
                <dd>{{ num(s.avgTokensInput) }} / {{ num(s.avgTokensOutput) }}</dd>
                <dt>Writes held back (one per turn)</dt>
                <dd>{{ s.writesNotRun }}</dd>
                <dt>Writes refused</dt>
                <dd>{{ s.writesRefused }}</dd>
                <dt>Tool calls it had to re-send</dt>
                <dd>{{ s.toolParseRetries }}</dd>
                <dt>Approval cards still waiting</dt>
                <dd>{{ m.approvals.pending }}</dd>
              </dl>
            </section>
          </div>
        }

        <section class="card">
          <header class="card-head">
            <h3>Tools</h3>
            <span class="sub"
              >Every tool the assistant used {{ windowLabel().toLowerCase() }} (operator and
              engine-run questions together) · busiest first</span
            >
          </header>
          @if (m.tools.length === 0) {
            <p class="pad muted">No tool calls in this window.</p>
          } @else {
            <div class="scroll">
              <table class="t tools">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th class="num">Calls</th>
                    <th class="num">Errors</th>
                    <th>Most common errors</th>
                    <th class="num">Typical</th>
                    <th class="num">Slowest 5%</th>
                    <th class="num">Cut short</th>
                    <th class="num">In parallel</th>
                    <th class="num">Operator / engine</th>
                    <th>Not run as a read</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of m.tools; track t.tool) {
                    <tr>
                      <td>
                        <code>{{ t.tool }}</code>
                      </td>
                      <td class="num">{{ t.calls }}</td>
                      <td class="num" [class.bad]="t.calls > 0 && t.errorRate >= 0.4">
                        {{ t.errors }}
                        @if (t.calls > 0) {
                          <span class="muted">({{ pctOf(t.errorRate) }})</span>
                        }
                      </td>
                      <td class="wrap">{{ counts(t.errorClasses) }}</td>
                      <td class="num">{{ msOf(t.p50Ms) }}</td>
                      <td class="num">{{ msOf(t.p95Ms) }}</td>
                      <td class="num">{{ t.calls > 0 ? pctOf(t.truncatedRate) : '—' }}</td>
                      <td class="num">{{ t.calls > 0 ? pctOf(t.parallelShare) : '—' }}</td>
                      <td class="num">{{ t.operatorCalls }} / {{ t.headlessCalls }}</td>
                      <td class="wrap">{{ counts(t.nonReads) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <p class="muted small foot">
          {{ m.fromUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} → {{ m.toUtc | date: 'HH:mm' : 'UTC' }}
          UTC.
          @if (m.truncated) {
            <strong
              >Busy window: the figures cover only the newest questions and tool calls.</strong
            >
          }
          Figures are recorded per question; questions asked before the engine started recording are
          not counted.
        </p>
      }
    </div>
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
      }
      .spacer {
        flex: 1;
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .seg button {
        border: none;
        background: transparent;
        color: var(--text-secondary);
        padding: 5px 10px;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .seg button + button {
        border-left: 1px solid var(--border);
      }
      .seg button.on {
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
      }
      @media (max-width: 1100px) {
        .kpis {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      @media (max-width: 640px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .breaches {
        border: 1px solid var(--loss);
        border-left-width: 4px;
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--loss) 6%, var(--bg-secondary));
        padding: var(--space-3) var(--space-4);
      }
      .breaches h3 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-base);
      }
      .breaches ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: var(--space-3);
      }
      .breaches p {
        margin: 2px 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .sev {
        margin-left: var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        color: var(--loss);
      }
      .grid2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-4);
      }
      @media (max-width: 900px) {
        .grid2 {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
      }
      .card-head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-3);
        align-items: baseline;
        padding: var(--space-3) var(--space-4);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .sub {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .pad {
        padding: 0 var(--space-4) var(--space-3);
        margin: 0;
      }
      .scroll {
        overflow-x: auto;
      }
      .t {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .t th,
      .t td {
        padding: 6px 12px;
        text-align: left;
        border-top: 1px solid var(--border);
        white-space: nowrap;
      }
      .t th {
        font-weight: var(--font-bold);
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .t .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .t .wrap {
        white-space: normal;
        min-width: 160px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .t .bad {
        color: var(--loss);
      }
      .bar-cell {
        width: 40%;
      }
      .bar {
        display: block;
        height: 6px;
        border-radius: 3px;
        background: var(--accent);
        min-width: 2px;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px var(--space-4);
        margin: 0;
        padding: 0 var(--space-4) var(--space-3);
        font-size: var(--text-sm);
      }
      .facts dt {
        color: var(--text-secondary);
      }
      .facts dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .foot {
        margin: 0;
      }
    `,
  ],
})
export class AssistantHealthPanelComponent {
  private readonly api = inject(AssistantOpsApiService);

  protected readonly windows = WINDOWS;
  protected readonly splits = SPLITS;
  protected readonly INFO = INFO;
  protected readonly WARN = WARN;
  protected readonly BAD = BAD;
  protected readonly NEUTRAL = NEUTRAL;

  readonly hours = signal(168);
  readonly split = signal<Split>('operator');

  readonly metrics = createPolledResource(() => this.api.metrics(this.hours()), {
    intervalMs: 120_000,
  });

  /** Optional: the engine's own verdicts. An engine or role without them just shows none. */
  readonly alerts = createPolledResource(
    () => this.api.activeHealthAlerts().pipe(catchError(() => of([]))),
    { intervalMs: 300_000 },
  );

  readonly breaches = computed(() => (this.alerts.value() ?? []).map(breachFromAlert));

  readonly stats = computed<AssistantTurnStats | null>(() => {
    const m = this.metrics.value();
    return m ? m[this.split()] : null;
  });

  readonly quiet = computed(() => isQuiet(this.stats()));

  readonly decided = computed(() => {
    const a = this.metrics.value()?.approvals;
    return a ? a.confirmed + a.rejected + a.failed : 0;
  });

  readonly windowLabel = computed(
    () => WINDOWS.find((w) => w.hours === this.hours())?.label ?? `Last ${this.hours()} h`,
  );

  readonly outcomeRows = computed(() => {
    const outcomes = this.stats()?.outcomes ?? {};
    const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
    return Object.entries(outcomes)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({
        key,
        label: humanise(key),
        count,
        share: total ? count / total : 0,
      }));
  });

  setHours(h: number): void {
    if (this.hours() === h) return;
    this.hours.set(h);
    this.metrics.refresh();
  }

  refresh(): void {
    this.metrics.refresh();
    this.alerts.refresh();
  }

  protected pctOf(ratio: number, denominator = 1): string {
    return pct(ratio, denominator);
  }
  protected dur(s: number): string {
    return duration(s);
  }
  protected msOf(v: number): string {
    return ms(v);
  }
  protected money(v: number): string {
    return usd(v);
  }
  protected num(v: number): string {
    return compact(v);
  }
  protected counts(c: Record<string, number>): string {
    return countsText(c);
  }

  protected holdsCaption(s: AssistantTurnStats): string {
    const parts = [
      s.gateHoldsNumbers ? `${s.gateHoldsNumbers} numbers` : '',
      s.gateHoldsAbsence ? `${s.gateHoldsAbsence} "none found"` : '',
      s.gateHoldsCausal ? `${s.gateHoldsCausal} cause` : '',
    ].filter(Boolean);
    return parts.length ? `held for: ${parts.join(', ')}` : 'answers sent back for a fix';
  }

  /** Colour for a "lower is better" rate; neutral when nothing stands behind it. */
  protected tone(ratio: number, warnAt: number, badAt: number, denominator: number): string {
    if (!denominator) return NEUTRAL;
    return ratio >= badAt ? BAD : ratio >= warnAt ? WARN : GOOD;
  }
}
