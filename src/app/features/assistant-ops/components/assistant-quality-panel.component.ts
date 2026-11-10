import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { createPolledResource } from '@core/polling/polled-resource';
import { ThemeService } from '@core/theme/theme.service';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

import { AssistantOpsApiService } from '../assistant-ops-api.service';
import { qualityTrendOptions } from '../assistant-charts';
import { RUBRIC, scoreTone } from '../assistant-quality.logic';
import type { AssistantAnswerGrade } from '../assistant-ops.types';

const DAYS = [30, 90, 180] as const;

/**
 * Answer quality: a second model ("the judge") reads a sample of real answers every few days and
 * scores each 1-5 on four points. Its scores over time, and the lowest-scored answers with its
 * reasons (`GET assistant/quality`).
 */
@Component({
  selector: 'app-assistant-quality-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    ChartCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    FeatureStateComponent,
    RefreshButtonComponent,
  ],
  template: `
    <div class="panel">
      <div class="toolbar">
        <label class="field">
          <span>Period</span>
          <select [value]="days()" (change)="setDays(+$any($event.target).value)">
            @for (d of dayOptions; track d) {
              <option [value]="d">Last {{ d }} days</option>
            }
          </select>
        </label>
        <span class="spacer"></span>
        <app-refresh-button [refreshing]="q.refreshing()" (refresh)="q.refresh()" />
      </div>
      <p class="intro muted">
        Every few days a second model (“the judge”) reads a sample of the assistant’s real answers
        and scores each from 1 (poor) to 5 (excellent):
        @for (r of rubric; track r.key; let last = $last) {
          <strong>{{ r.label.toLowerCase() }}</strong> — {{ r.hint }}{{ last ? '.' : ';' }}
        }
      </p>

      @if (q.loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (q.error() && !q.value()) {
        <app-error-state
          title="Could not load answer quality"
          message="The engine did not answer GET assistant/quality. An engine older than 2026-11-10 does not have it."
          (retry)="q.refresh()"
        />
      } @else if (q.value(); as v) {
        @if (v.answers === 0) {
          <app-feature-state
            kind="waiting"
            title="No answers have been scored in this period"
            summary="The judge has not scored any answers yet in the period picked."
            detail="Spot checks run every few days while Llm:AssistantJudgeEnabled is on; the Evals tab shows its settings and runs."
          />
        } @else {
          <section class="tiles" aria-label="Average scores">
            @for (r of rubric; track r.key) {
              <div class="tile" [attr.data-tone]="tone(v[r.key])" [title]="r.hint">
                <span class="lbl">{{ r.label }}</span>
                <span class="val">{{ v[r.key] | number: '1.1-1' }}<small> / 5</small></span>
              </div>
            }
            <div class="tile">
              <span class="lbl">Answers scored</span>
              <span class="val">{{ v.answers }}</span>
            </div>
          </section>

          <app-chart-card
            title="Scores over time"
            subtitle="Average of each spot check (1 = poor, 5 = excellent)"
            height="260px"
            [options]="chart()"
            [emptyMessage]="v.trend.length === 0 ? 'No spot checks in this period' : null"
            alt="Line chart of the four answer scores per spot check; the table of lowest-scored answers follows."
          />

          <section class="card">
            <header class="card-head">
              <h3>Lowest-scored answers</h3>
              <span class="sub"
                >Worst correctness first · what the judge said, and where to look</span
              >
            </header>
            @if (v.lowest.length === 0) {
              <p class="pad muted">None.</p>
            } @else {
              <ul class="grades">
                @for (g of v.lowest; track g.id) {
                  <li>
                    <div class="g-head">
                      @for (r of rubric; track r.key) {
                        <span class="score" [attr.data-tone]="tone(g[r.key])" [title]="r.hint"
                          >{{ r.label }} {{ g[r.key] }}</span
                        >
                      }
                      <span class="spacer"></span>
                      <span class="muted small"
                        >answered {{ g.answeredAtUtc | date: 'MMM d HH:mm' : 'UTC' }} UTC</span
                      >
                    </div>
                    @if (g.question) {
                      <p class="qtext"><strong>Asked:</strong> {{ g.question }}</p>
                    }
                    @if (g.answerExcerpt) {
                      <p class="excerpt">{{ g.answerExcerpt }}</p>
                    }
                    <ul class="reasons">
                      @for (r of reasons(g); track r.label) {
                        <li>
                          <strong>{{ r.label }}:</strong> {{ r.text }}
                        </li>
                      }
                    </ul>
                    <div class="links">
                      <a
                        routerLink="/conversations"
                        [queryParams]="{ conversation: g.conversationId }"
                        >Open conversation #{{ g.conversationId }}</a
                      >
                      @if (g.lessonCandidateId) {
                        ·
                        <a routerLink="/assistant" [queryParams]="{ tab: 'lessons' }"
                          >Lesson #{{ g.lessonCandidateId }} drafted from it</a
                        >
                      }
                    </div>
                  </li>
                }
              </ul>
            }
          </section>
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
        align-items: center;
        gap: var(--space-3);
      }
      .spacer {
        flex: 1;
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
      .intro {
        margin: 0;
        font-size: var(--text-sm);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: var(--space-2);
      }
      @media (max-width: 900px) {
        .tiles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .tile[data-tone='good'] {
        border-left-color: var(--profit);
      }
      .tile[data-tone='warn'] {
        border-left-color: var(--warning);
      }
      .tile[data-tone='bad'] {
        border-left-color: var(--loss);
      }
      .lbl {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .val {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      .val small {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-weight: normal;
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
      h3 {
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
      .grades {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .grades > li {
        border-top: 1px solid var(--border);
        padding: var(--space-3) var(--space-4);
        font-size: var(--text-sm);
      }
      .g-head {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .score {
        font-size: var(--text-xs);
        padding: 0 7px;
        border-radius: 8px;
        border: 1px solid var(--border);
      }
      .score[data-tone='bad'] {
        color: var(--loss);
        border-color: color-mix(in srgb, var(--loss) 50%, transparent);
      }
      .score[data-tone='warn'] {
        color: var(--warning);
      }
      .score[data-tone='good'] {
        color: var(--profit);
      }
      .qtext,
      .excerpt {
        margin: 6px 0 0;
      }
      .excerpt {
        color: var(--text-secondary);
        white-space: pre-wrap;
        max-height: 7.5em;
        overflow: hidden;
      }
      .reasons {
        margin: 6px 0;
        padding-left: 18px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .links {
        font-size: var(--text-xs);
      }
      .links a {
        color: var(--accent);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class AssistantQualityPanelComponent {
  private readonly api = inject(AssistantOpsApiService);
  private readonly theme = inject(ThemeService);

  protected readonly rubric = RUBRIC;
  protected readonly dayOptions = DAYS;
  readonly days = signal(90);

  readonly q = createPolledResource(() => this.api.quality(this.days(), 10), {
    intervalMs: 300_000,
  });

  protected readonly chart = computed(() =>
    qualityTrendOptions(this.q.value()?.trend ?? [], this.theme.theme() === 'dark'),
  );

  setDays(d: number): void {
    if (d === this.days()) return;
    this.days.set(d);
    this.q.refresh();
  }

  protected tone = scoreTone;

  protected reasons(g: AssistantAnswerGrade): { label: string; text: string }[] {
    return [
      { label: 'Correct', text: g.correctnessReason },
      { label: 'Complete', text: g.completenessReason },
      { label: 'Clear', text: g.clarityReason },
      { label: 'Honest', text: g.honestyReason },
    ].filter((r): r is { label: string; text: string } => !!r.text && !!r.text.trim());
  }
}
