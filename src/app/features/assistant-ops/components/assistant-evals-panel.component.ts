import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { createPolledResource } from '@core/polling/polled-resource';
import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import { evalTrendOptions } from '../assistant-charts';
import { compact, pct } from '../assistant-ops.logic';
import {
  casesText,
  evalKindLabel,
  evalStatusLabel,
  evalStatusTone,
  evalTrend,
  evalTriggerLabel,
  queueRefusalText,
  runDuration,
  tokenBudget,
} from '../assistant-quality.logic';
import type { AssistantEvalKind, AssistantEvalRun } from '../assistant-ops.types';
import { AssistantEvalRunDetailComponent } from './assistant-eval-run-detail.component';

const KINDS: ReadonlyArray<{ value: AssistantEvalKind; label: string }> = [
  { value: 'suite', label: 'Test suite' },
  { value: 'lesson', label: 'Lesson replays' },
  { value: 'judge', label: 'Answer spot checks' },
  { value: 'all', label: 'All' },
];
const DAYS = [30, 60, 90] as const;

/**
 * Evals: the assistant re-run against recorded test questions on the real model (nightly, or on
 * demand), and how it scored over time (`GET assistant/evals/runs`, `/runs/{id}`,
 * `POST assistant/evals/run` — `llmbacktest.launch`).
 */
@Component({
  selector: 'app-assistant-evals-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    LscCanDirective,
    ChartCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    FeatureStateComponent,
    RefreshButtonComponent,
    AssistantEvalRunDetailComponent,
  ],
  template: `
    <div class="panel">
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Which runs">
          @for (k of kinds; track k.value) {
            <button
              type="button"
              [class.on]="kind() === k.value"
              [attr.aria-pressed]="kind() === k.value"
              (click)="setKind(k.value)"
            >
              {{ k.label }}
            </button>
          }
        </div>
        <label class="field">
          <span>Period</span>
          <select [value]="days()" (change)="setDays(+$any($event.target).value)">
            @for (d of dayOptions; track d) {
              <option [value]="d">Last {{ d }} days</option>
            }
          </select>
        </label>
        <span class="spacer"></span>
        <button
          *lscCan="launchKey"
          type="button"
          class="btn primary"
          [disabled]="starting() || !!runs.value()?.live"
          [title]="
            runs.value()?.live
              ? 'A run is already waiting or running'
              : 'Run the test suite on the real model now'
          "
          (click)="runNow()"
        >
          {{ starting() ? 'Starting…' : 'Run now' }}
        </button>
        <app-refresh-button [refreshing]="runs.refreshing()" (refresh)="runs.refresh()" />
      </div>

      <p class="intro muted">
        An eval re-asks the assistant recorded questions (“test cases”) on the real model and checks
        its work — which tools it used, whether its answer held up. A drop in the pass rate after a
        change means the change made it worse.
      </p>

      @if (note(); as n) {
        <p class="note" [attr.data-tone]="n.tone" role="status">{{ n.text }}</p>
      }

      @if (runs.loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (runs.error() && !runs.value()) {
        <app-error-state
          title="Could not load the eval runs"
          message="The engine did not answer GET assistant/evals/runs. An engine older than 2026-11-10 does not have it."
          (retry)="runs.refresh()"
        />
      } @else if (runs.value(); as r) {
        <div class="facts">
          <div>
            <strong>Nightly run:</strong>
            @if (r.settings.evalEnabled) {
              on, at {{ pad(r.settings.evalHourUtc) }}:00 UTC, up to
              {{ r.settings.evalMaxCases || 'all' }} cases
              @if (r.settings.evalModel) {
                on <code>{{ r.settings.evalModel }}</code>
              }
            } @else {
              off
            }
            · <strong>Spot checks:</strong>
            @if (r.settings.judgeEnabled) {
              every {{ r.settings.judgeIntervalDays }} day(s),
              {{ r.settings.judgeSampleSize }} answers
            } @else {
              off
            }
            · {{ r.settings.cases.length }} test cases
          </div>
          @if (budget(); as b) {
            <div class="budget" [attr.data-tone]="b.tone">
              <span>Today’s eval tokens: {{ b.text }}</span>
              @if (b.ceiling > 0) {
                <span
                  class="meter"
                  role="meter"
                  [attr.aria-valuenow]="b.spent"
                  [attr.aria-valuemax]="b.ceiling"
                  aria-label="Today's eval token use"
                >
                  <span [style.width.%]="b.share * 100"></span>
                </span>
              }
            </div>
          }
        </div>

        @if (r.live; as live) {
          <p class="live" role="status">
            Run #{{ live.id }} is {{ statusText(live.status).toLowerCase() }} ({{
              live.casesTotal
            }}
            cases, {{ triggerText(live.trigger) }}).
          </p>
        }

        @if (kind() === 'suite' || kind() === 'all') {
          <app-chart-card
            title="Nightly test suite"
            subtitle="Share of test cases passed, and the mean score of their checks"
            height="240px"
            [options]="chart()"
            [emptyMessage]="
              trend().length === 0 ? 'No finished suite runs in this period yet' : null
            "
            [emptyHint]="
              trend().length === 0
                ? 'Runs appear here after the nightly run, or after Run now.'
                : null
            "
            alt="Line chart of the nightly suite pass rate and mean score; the table below lists every run."
          />
        }

        @if (r.runs.length === 0) {
          <app-feature-state
            kind="waiting"
            title="No eval runs in this period"
            summary="Nothing of this kind ran in the period picked."
            detail="The nightly suite runs only while it is switched on (Llm:AssistantEvalEnabled). A lesson replay runs when a lesson is approved or evaluated."
          />
        } @else {
          <section class="card">
            <div class="scroll">
              <table class="t">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>When (UTC)</th>
                    <th>What</th>
                    <th>Status</th>
                    <th>Cases</th>
                    <th class="num">Passed</th>
                    <th class="num">Score</th>
                    <th class="num">Tokens in / out</th>
                    <th>Model</th>
                    <th class="num">Took</th>
                  </tr>
                </thead>
                <tbody>
                  @for (run of r.runs; track run.id) {
                    <tr
                      [class.sel]="selected() === run.id"
                      (click)="select(run)"
                      tabindex="0"
                      (keydown.enter)="select(run)"
                    >
                      <td>
                        <button type="button" class="link">#{{ run.id }}</button>
                      </td>
                      <td>{{ run.queuedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</td>
                      <td>
                        {{ kindText(run.kind) }}
                        @if (run.lessonId) {
                          · lesson #{{ run.lessonId }}
                        }
                        <div class="muted small">{{ triggerText(run.trigger) }}</div>
                      </td>
                      <td [attr.data-tone]="tone(run.status)">{{ statusText(run.status) }}</td>
                      <td>{{ cases(run) }}</td>
                      <td class="num">{{ run.passRate === null ? '—' : pctOf(run.passRate) }}</td>
                      <td class="num">{{ run.meanScore === null ? '—' : pctOf(run.meanScore) }}</td>
                      <td class="num">{{ num(run.tokensInput) }} / {{ num(run.tokensOutput) }}</td>
                      <td>
                        <code>{{ run.resolvedModel || run.model || '—' }}</code>
                      </td>
                      <td class="num">{{ dur(run) }}</td>
                    </tr>
                    @if (run.error && selected() !== run.id) {
                      <tr class="err">
                        <td colspan="10">{{ run.error }}</td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          </section>
          <p class="muted small">
            Pick a run to see its cases. The tool-calling protocol each case used is shown per case.
          </p>
        }

        @if (selected(); as id) {
          <app-assistant-eval-run-detail [runId]="id" (closed)="selected.set(null)" />
        }
      }
    </div>
  `,
  styles: [
    `
      .panel {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
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
      .field {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      select {
        font: inherit;
        padding: 3px 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn {
        padding: 5px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-contrast, #fff);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .intro,
      .note,
      .live {
        margin: 0;
        font-size: var(--text-sm);
      }
      .note[data-tone='bad'] {
        color: var(--loss);
      }
      .note[data-tone='good'] {
        color: var(--profit);
      }
      .live {
        color: var(--accent);
      }
      .facts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-4);
        justify-content: space-between;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .budget {
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .meter {
        display: inline-block;
        width: 120px;
        height: 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .meter span {
        display: block;
        height: 100%;
        background: var(--profit);
      }
      .budget[data-tone='warn'] .meter span {
        background: var(--warning);
      }
      .budget[data-tone='bad'] .meter span {
        background: var(--loss);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
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
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text-secondary);
      }
      .t tbody tr {
        cursor: pointer;
      }
      .t tbody tr:hover,
      .t tr.sel {
        background: color-mix(in srgb, var(--accent) 6%, transparent);
      }
      .t tr.err td {
        color: var(--loss);
        font-size: var(--text-xs);
        white-space: normal;
        border-top: none;
      }
      .num {
        text-align: right !important;
        font-variant-numeric: tabular-nums;
      }
      [data-tone='good'] {
        color: var(--profit);
      }
      [data-tone='warn'] {
        color: var(--warning);
      }
      [data-tone='bad'] {
        color: var(--loss);
      }
      [data-tone='live'] {
        color: var(--accent);
      }
      .link {
        border: none;
        background: none;
        color: var(--accent);
        cursor: pointer;
        padding: 0;
        font: inherit;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
        margin: 0;
      }
    `,
  ],
})
export class AssistantEvalsPanelComponent {
  private readonly api = inject(AssistantOpsApiService);
  private readonly theme = inject(ThemeService);

  protected readonly kinds = KINDS;
  protected readonly dayOptions = DAYS;
  protected readonly launchKey = Permission.LlmbacktestLaunch;

  readonly kind = signal<AssistantEvalKind>('suite');
  readonly days = signal(60);
  readonly selected = signal<number | null>(null);
  /** A run to open on arrival (`?run=`). */
  readonly initialRun = input<number | null>(null);
  protected readonly starting = signal(false);
  protected readonly note = signal<{ text: string; tone: 'good' | 'bad' } | null>(null);

  readonly runs = createPolledResource(() => this.api.evalRuns(this.kind(), this.days()), {
    intervalMs: 60_000,
  });

  protected readonly trend = computed(() => evalTrend(this.runs.value()?.runs ?? []));
  protected readonly chart = computed(() =>
    evalTrendOptions(this.trend(), this.theme.theme() === 'dark'),
  );
  protected readonly budget = computed(() => tokenBudget(this.runs.value()?.settings));

  constructor() {
    effect(() => {
      const id = this.initialRun();
      if (id) untracked(() => this.selected.set(id));
    });
  }

  setKind(k: AssistantEvalKind): void {
    if (k === this.kind()) return;
    this.kind.set(k);
    this.selected.set(null);
    this.runs.refresh();
  }

  setDays(d: number): void {
    if (d === this.days()) return;
    this.days.set(d);
    this.runs.refresh();
  }

  select(run: AssistantEvalRun): void {
    this.selected.set(this.selected() === run.id ? null : run.id);
  }

  runNow(): void {
    if (this.starting()) return;
    this.starting.set(true);
    this.note.set(null);
    this.api.startEvalRun().subscribe({
      next: (run) => {
        this.starting.set(false);
        this.note.set({
          text: `Run #${run.id} queued (${run.casesTotal} cases); it starts within a minute.`,
          tone: 'good',
        });
        this.runs.refresh();
      },
      error: (err: unknown) => {
        this.starting.set(false);
        this.note.set({ text: queueRefusalText(err, 'run'), tone: 'bad' });
      },
    });
  }

  protected statusText = evalStatusLabel;
  protected tone = evalStatusTone;
  protected kindText = evalKindLabel;
  protected triggerText = evalTriggerLabel;
  protected cases = casesText;
  protected dur = runDuration;

  protected pad(h: number): string {
    return String(h).padStart(2, '0');
  }
  protected num(v: number): string {
    return compact(v);
  }
  protected pctOf(v: number): string {
    return pct(v);
  }
}
