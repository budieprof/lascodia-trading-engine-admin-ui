import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { LlmService } from '@core/services/llm.service';
import { LifecycleRationaleDto, RationaleCoverageDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

@Component({
  selector: 'app-llm-rationales-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Lifecycle Rationales"
        subtitle="Why did the engine do that? 2–3 sentence LLM-authored explanations attached to every persisted lifecycle event."
      >
        <select class="window-select" [(ngModel)]="windowHours" (change)="reloadCoverage()">
          <option [ngValue]="24">Last 24h</option>
          <option [ngValue]="168">Last 7d</option>
          <option [ngValue]="720">Last 30d</option>
        </select>
        <button type="button" class="btn-refresh" (click)="reload()">↻ Refresh</button>
      </app-page-header>

      <!-- ── KPI strip ──────────────────────────────────────────────── -->
      <div class="kpi-strip">
        <app-metric-card
          label="Rationales"
          [value]="coverage()?.totalRationales ?? 0"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Avg confidence"
          [value]="coverage() ? coverage()!.averageConfidence * 100 : 0"
          format="percent"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Low-confidence (<0.4)"
          [value]="coverage()?.lowConfidenceCount ?? 0"
          format="number"
          [dotColor]="(coverage()?.lowConfidenceCount ?? 0) > 0 ? '#FF9500' : '#34C759'"
        />
        <app-metric-card
          label="LLM cost (window)"
          [value]="coverage()?.totalCostUsd ?? 0"
          format="currency"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Event types covered"
          [value]="coverageTotalTypes()"
          format="number"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="Active types (≥1)"
          [value]="coverageActiveTypes()"
          format="number"
          dotColor="#FF9500"
        />
      </div>

      <!-- ── Coverage matrix ────────────────────────────────────────── -->
      @if (coverage(); as c) {
        <section class="card">
          <header class="card-head">
            <h3>Event-Type Coverage</h3>
            <span class="muted small"
              >Window: last {{ windowHours }}h · {{ c.byEventType.length }} event type(s)
              wired</span
            >
          </header>
          <div class="coverage-grid">
            @for (e of c.byEventType; track e.eventType) {
              <article class="coverage-card" [class.empty]="e.count === 0">
                <header class="cov-head">
                  <span class="event-pill">{{ e.eventType }}</span>
                  <span class="cov-count" [class.zero]="e.count === 0">
                    {{ e.count }}
                  </span>
                </header>
                <p class="cov-desc">{{ e.description }}</p>
                <footer class="cov-foot">
                  @if (e.count > 0) {
                    <span class="cov-meta">
                      avg conf
                      <strong>{{ e.averageConfidence ?? 0 | number: '1.2-2' }}</strong>
                    </span>
                    <span class="cov-meta">
                      latest <strong>{{ e.latestAt | date: 'MMM d, HH:mm' }}</strong>
                    </span>
                    <button
                      type="button"
                      class="cov-filter-btn"
                      (click)="filterToEventType(e.eventType)"
                    >
                      View →
                    </button>
                  } @else {
                    <span class="cov-meta muted">No rationale fired in window.</span>
                  }
                </footer>
              </article>
            }
          </div>
        </section>
      }

      <!-- Filters -->
      <section class="card filters-card">
        <div class="filters">
          <input
            class="filter-input"
            type="text"
            placeholder="Event type (e.g. StrategyActivated)"
            [(ngModel)]="filterEventType"
            (change)="resetAndReload()"
          />
          <input
            class="filter-input"
            type="number"
            placeholder="Event id"
            [(ngModel)]="filterEventId"
            (change)="resetAndReload()"
          />
          <div class="confidence-filter">
            <label class="confidence-label">Min confidence</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              [(ngModel)]="filterMinConfidence"
              (change)="resetAndReload()"
            />
            <span class="confidence-value">{{ filterMinConfidence | number: '1.2-2' }}</span>
          </div>
        </div>
      </section>

      <!-- Feed -->
      @if (loading()) {
        <div class="note">Loading rationales…</div>
      } @else if (rationales().length === 0) {
        <div class="note">
          No rationales match the filter. The narrative layer writes one row per persisted lifecycle
          event — if this is empty either no qualifying events have fired in your window or the
          layer is disabled in <a routerLink="/llm/settings">Settings</a>.
        </div>
      } @else {
        <div class="feed">
          @for (r of rationales(); track r.id) {
            <article class="rationale-card" [class.low-conf]="r.confidence < 0.4">
              <header class="rationale-head">
                <span class="event-pill">{{ r.eventType }}</span>
                <span class="muted">#{{ r.eventId }}</span>
                <span class="dot">·</span>
                <span class="muted">{{ r.createdAt | date: 'MMM d, HH:mm' }}</span>
                <span class="spacer"></span>
                <span class="conf-badge" [class.low]="r.confidence < 0.4">
                  conf {{ r.confidence | number: '1.2-2' }}
                </span>
                @if (r.llmProvider) {
                  <span class="provider-tag mono">{{ r.llmProvider }} / {{ r.llmModel }}</span>
                }
              </header>
              <p class="rationale-body">{{ r.rationaleText }}</p>
              @if (r.keyMetricReferenced) {
                <footer class="rationale-foot">
                  <span class="metric-label">Key metric</span>
                  <span class="metric-value mono">{{ r.keyMetricReferenced }}</span>
                </footer>
              }
            </article>
          }
        </div>
        <footer class="pager">
          <span class="muted">Showing {{ pageStart() }}–{{ pageEnd() }} of {{ totalRows() }}</span>
          <div class="pager-buttons">
            <button
              type="button"
              class="pager-btn"
              [disabled]="currentPage() === 1"
              (click)="goToPage(currentPage() - 1)"
            >
              ← Prev
            </button>
            <button
              type="button"
              class="pager-btn"
              [disabled]="pageEnd() >= totalRows()"
              (click)="goToPage(currentPage() + 1)"
            >
              Next →
            </button>
          </div>
        </footer>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .btn-refresh,
      .window-select {
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-4);
      }
      .coverage-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
      }
      .coverage-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .coverage-card.empty {
        background: rgba(142, 142, 147, 0.04);
        border-style: dashed;
      }
      .cov-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .cov-count {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .cov-count.zero {
        color: var(--text-tertiary);
      }
      .cov-desc {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
      }
      .cov-foot {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
        margin-top: auto;
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .cov-meta {
        color: var(--text-tertiary);
      }
      .cov-meta strong {
        color: var(--text-primary);
        font-weight: var(--font-medium);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .cov-meta.muted {
        font-style: italic;
      }
      .cov-filter-btn {
        margin-left: auto;
        padding: 3px 10px;
        font-size: var(--text-xs);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .cov-filter-btn:hover {
        background: #0071e3;
        color: #fff;
        border-color: #0071e3;
      }
      @media (max-width: 1200px) {
        .kpi-strip {
          grid-template-columns: repeat(3, 1fr);
        }
        .coverage-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 768px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      /* Header strip inside the coverage card. The page didn't define
         .card-head locally so the h3 was rendering with default browser
         margins and the subtitle sat flush against the card edges. Match
         the spacing rhythm used on the rest of the LLM feature. */
      .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .filters-card {
        padding: var(--space-3) var(--space-4);
      }
      .filters {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .filter-input {
        height: 30px;
        padding: 0 var(--space-2);
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        min-width: 180px;
      }
      .confidence-filter {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .confidence-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .confidence-value {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        min-width: 40px;
      }
      .feed {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .rationale-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .rationale-card.low-conf {
        border-color: rgba(255, 149, 0, 0.4);
        background: rgba(255, 149, 0, 0.04);
      }
      .rationale-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        flex-wrap: wrap;
      }
      .event-pill {
        padding: 3px 8px;
        border-radius: 3px;
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .dot {
        color: var(--text-tertiary);
      }
      .spacer {
        flex: 1;
      }
      .conf-badge {
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(52, 199, 89, 0.12);
        color: #34c759;
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-semibold);
      }
      .conf-badge.low {
        background: rgba(255, 149, 0, 0.14);
        color: #ff9500;
      }
      .provider-tag {
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .rationale-body {
        margin: 0;
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .rationale-foot {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .metric-label {
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .metric-value {
        font-family: 'SF Mono', 'Fira Code', monospace;
        color: var(--text-primary);
      }
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--space-3) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .pager-buttons {
        display: flex;
        gap: var(--space-2);
      }
      .pager-btn {
        padding: 4px 10px;
        font-size: var(--text-sm);
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .note {
        padding: var(--space-5);
        text-align: center;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
      }
    `,
  ],
})
export class LlmRationalesPageComponent implements OnInit {
  private readonly llm = inject(LlmService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rationales = signal<LifecycleRationaleDto[]>([]);
  readonly totalRows = signal(0);
  readonly currentPage = signal(1);
  readonly pageSize = 25;
  readonly loading = signal(true);
  readonly coverage = signal<RationaleCoverageDto | null>(null);

  /** Window for the coverage rollup. Independent from per-row filters
   *  (those drive the paged list, this drives the KPI strip + matrix). */
  windowHours = 168;

  filterEventType = '';
  filterEventId: number | null = null;
  filterMinConfidence = 0;

  readonly coverageTotalTypes = computed(() => this.coverage()?.byEventType.length ?? 0);
  readonly coverageActiveTypes = computed(
    () => this.coverage()?.byEventType.filter((e) => e.count > 0).length ?? 0,
  );

  readonly pageStart = computed(() =>
    this.totalRows() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize + 1,
  );
  readonly pageEnd = computed(() => Math.min(this.currentPage() * this.pageSize, this.totalRows()));

  ngOnInit(): void {
    this.reloadCoverage();
    this.reload();
  }

  reloadCoverage(): void {
    this.llm
      .rationalesCoverage(this.windowHours)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.coverage.set(res?.data ?? null);
      });
  }

  filterToEventType(eventType: string): void {
    this.filterEventType = eventType;
    this.resetAndReload();
  }

  reload(): void {
    this.loading.set(true);
    this.llm
      .listRationales({
        currentPage: this.currentPage(),
        itemCountPerPage: this.pageSize,
        filter: {
          eventType: this.filterEventType || null,
          eventId: this.filterEventId,
          minConfidence: this.filterMinConfidence > 0 ? this.filterMinConfidence : null,
        },
      })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.loading.set(false);
        const data = res?.data;
        this.rationales.set(data?.data ?? []);
        this.totalRows.set(data?.pager?.totalItemCount ?? 0);
      });
  }

  resetAndReload(): void {
    this.currentPage.set(1);
    this.reload();
  }

  goToPage(page: number): void {
    this.currentPage.set(page);
    this.reload();
  }
}
