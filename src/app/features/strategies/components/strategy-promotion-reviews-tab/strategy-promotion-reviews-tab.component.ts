import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import type {
  PromotionReviewSnapshotDto,
  PromotionReviewRecommendation,
} from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Read-only tab on the strategy detail page that lists bull/bear/judge
 * advisory reviews for this strategy (PRD-0001 §6 F4 / PRD-V2 FR-3.11).
 * Reviews are produced asynchronously after auto-promotion lands, so older
 * strategies will commonly have zero rows — the empty state explains why.
 *
 * Each row exposes the judge verdict, confidence, screening score that
 * placed the strategy in the borderline band, LLM cost, and an expandable
 * thesis pane that parses the four JSON columns lazily on click.
 */
interface BulletPoint {
  label?: string;
  text: string;
}

interface ParsedThesis {
  summary?: string;
  points: BulletPoint[];
}

interface ReviewRow extends PromotionReviewSnapshotDto {
  expanded: boolean;
  bull?: ParsedThesis;
  bear?: ParsedThesis;
  concerns?: string[];
}

@Component({
  selector: 'app-strategy-promotion-reviews-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel">
      <header class="panel-head">
        <h3>Promotion Reviews</h3>
        <span class="muted small">
          {{ reviews().length }} review{{ reviews().length === 1 ? '' : 's' }}
          @if (lastReviewedAt()) {
            · most recent {{ lastReviewedAt() | relativeTime }}
          }
        </span>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="5" />
      } @else if (error()) {
        <app-error-state
          title="Could not load promotion reviews"
          message="Engine returned an error fetching bull/bear/judge advisory reviews."
          (retry)="load()"
        />
      } @else if (reviews().length === 0) {
        <app-empty-state
          title="No promotion reviews yet"
          message="Reviews are produced asynchronously after auto-promotion. Strategies created manually or before the LLM-narrative layer shipped won't have any."
        />
      } @else {
        <ul class="reviews">
          @for (r of reviews(); track r.id) {
            <li class="review" [class.review--skip]="r.judgeRecommendation === 'SkipRecommend'">
              <button class="review-head" type="button" (click)="toggle(r.id)">
                <div class="head-left">
                  <span class="verdict" [attr.data-verdict]="r.judgeRecommendation ?? 'none'">
                    {{ verdictLabel(r.judgeRecommendation) }}
                  </span>
                  @if (r.judgeConfidence !== null) {
                    <span class="confidence muted small">
                      {{ r.judgeConfidence! * 100 | number: '1.0-0' }}% confidence
                    </span>
                  }
                  <span class="outcome muted small">· {{ r.outcome }}</span>
                </div>
                <div class="head-right muted small">
                  <span>score {{ r.screeningScore | number: '1.2-2' }}</span>
                  <span>·</span>
                  <span>p{{ r.borderlineLowerPercentile }}–p{{ r.borderlineUpperPercentile }}</span>
                  <span>·</span>
                  <span title="LLM spend on this review">
                    \${{ r.totalCostUsd | number: '1.4-4' }}
                  </span>
                  <span>·</span>
                  <span>{{ r.createdAt | date: 'short' }}</span>
                </div>
              </button>

              @if (r.expanded) {
                <div class="thesis-grid">
                  <div class="thesis bull">
                    <h4>Bull</h4>
                    @if (r.bull; as t) {
                      @if (t.summary) {
                        <p class="muted">{{ t.summary }}</p>
                      }
                      @if (t.points.length) {
                        <ul>
                          @for (p of t.points; track $index) {
                            <li>
                              @if (p.label) {
                                <strong>{{ p.label }}:</strong>
                              }
                              {{ p.text }}
                            </li>
                          }
                        </ul>
                      }
                    } @else {
                      <p class="muted small">No bull thesis (stage truncated or failed).</p>
                    }
                  </div>

                  <div class="thesis bear">
                    <h4>Bear</h4>
                    @if (r.bear; as t) {
                      @if (t.summary) {
                        <p class="muted">{{ t.summary }}</p>
                      }
                      @if (t.points.length) {
                        <ul>
                          @for (p of t.points; track $index) {
                            <li>
                              @if (p.label) {
                                <strong>{{ p.label }}:</strong>
                              }
                              {{ p.text }}
                            </li>
                          }
                        </ul>
                      }
                    } @else {
                      <p class="muted small">No bear thesis (stage truncated or failed).</p>
                    }
                  </div>

                  <div class="thesis judge">
                    <h4>Judge concerns</h4>
                    @if (r.concerns && r.concerns.length) {
                      <ul>
                        @for (c of r.concerns; track $index) {
                          <li>{{ c }}</li>
                        }
                      </ul>
                    } @else {
                      <p class="muted small">No concerns flagged.</p>
                    }
                  </div>
                </div>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--space-3);
      }
      h3 {
        margin: 0;
        font-size: var(--font-md);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--font-sm);
      }

      .reviews {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .review {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        overflow: hidden;
      }
      .review--skip {
        border-color: var(--warning, var(--accent));
      }

      .review-head {
        all: unset;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3);
        width: 100%;
      }
      .review-head:hover {
        background: var(--bg-tertiary, var(--bg-secondary));
      }
      .review-head:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .head-left,
      .head-right {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }

      .verdict {
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary, var(--bg-secondary));
        font-size: var(--font-sm);
      }
      .verdict[data-verdict='Confirm'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .verdict[data-verdict='Caution'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .verdict[data-verdict='SkipRecommend'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }

      .thesis-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: var(--space-3);
        padding: 0 var(--space-3) var(--space-3);
        border-top: 1px solid var(--border);
      }
      @media (max-width: 900px) {
        .thesis-grid {
          grid-template-columns: 1fr;
        }
      }
      .thesis h4 {
        margin: var(--space-3) 0 var(--space-2);
        font-size: var(--font-sm);
        font-weight: var(--font-semibold);
      }
      .thesis ul {
        margin: 0;
        padding-left: var(--space-4);
        font-size: var(--font-sm);
      }
      .thesis li {
        margin-bottom: var(--space-1);
      }
      .thesis p {
        margin: 0 0 var(--space-2);
        font-size: var(--font-sm);
      }
    `,
  ],
})
export class StrategyPromotionReviewsTabComponent {
  readonly strategyId = input.required<number>();

  private readonly strategies = inject(StrategiesService);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly reviews = signal<ReviewRow[]>([]);

  protected readonly lastReviewedAt = computed(() => {
    const rows = this.reviews();
    return rows.length > 0 ? rows[0].createdAt : null;
  });

  constructor() {
    effect(() => {
      const id = this.strategyId();
      if (id) this.load();
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.strategies
      .listPromotionReviews({
        currentPage: 1,
        itemCountPerPage: 50,
        filter: { strategyId: this.strategyId() },
      })
      .pipe(
        map((res) => res.data?.data ?? []),
        catchError(() => {
          this.error.set('Failed to load promotion reviews.');
          return of([] as PromotionReviewSnapshotDto[]);
        }),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((rows) => {
        this.reviews.set(rows.map((r) => ({ ...r, expanded: false })));
      });
  }

  toggle(id: number): void {
    this.reviews.update((rows) =>
      rows.map((r) => {
        if (r.id !== id) return r;
        if (r.expanded) return { ...r, expanded: false };
        return {
          ...r,
          expanded: true,
          bull: parseThesis(r.bullThesisJson),
          bear: parseThesis(r.bearThesisJson),
          concerns: parseConcerns(r.judgeKeyConcernsJson),
        };
      }),
    );
  }

  verdictLabel(v: PromotionReviewRecommendation | null): string {
    if (v === 'Confirm') return 'Confirm';
    if (v === 'Caution') return 'Caution';
    if (v === 'SkipRecommend') return 'Skip recommended';
    return 'No verdict';
  }
}

// ── JSON shape is the engine's PromotionReviewSchemas — kept loose because
// the engine deliberately treats them as untyped strings on the DB side. We
// best-effort extract summary + bullet points without imposing a strict
// contract; truncation / shape drift falls back to an "empty" parsed thesis.
function parseThesis(json: string | null): ParsedThesis | undefined {
  if (!json) return undefined;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const summary = typeof obj['summary'] === 'string' ? (obj['summary'] as string) : undefined;
    const rawPoints = obj['points'] ?? obj['arguments'] ?? obj['theses'];
    const points: BulletPoint[] = Array.isArray(rawPoints)
      ? rawPoints
          .map((p): BulletPoint | null => {
            if (typeof p === 'string') return { text: p };
            if (p && typeof p === 'object') {
              const item = p as Record<string, unknown>;
              const text =
                typeof item['text'] === 'string'
                  ? (item['text'] as string)
                  : typeof item['claim'] === 'string'
                    ? (item['claim'] as string)
                    : null;
              if (!text) return null;
              const label =
                typeof item['label'] === 'string' ? (item['label'] as string) : undefined;
              return { label, text };
            }
            return null;
          })
          .filter((p): p is BulletPoint => p !== null)
      : [];
    return { summary, points };
  } catch {
    return { points: [] };
  }
}

function parseConcerns(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return undefined;
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return undefined;
  }
}
