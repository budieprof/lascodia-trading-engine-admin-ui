import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type {
  ApplyStrategyTemplateResult,
  StrategyTemplateDto,
  Timeframe,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

@Component({
  selector: 'app-templates-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategies — Templates"
        subtitle="Saved strategy templates. Apply across multiple symbols in a single round-trip."
      >
        <a routerLink="/strategies" class="btn btn-secondary">← Strategies</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load templates"
          message="Engine returned an error fetching the template list."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Templates"
            [value]="templates().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Total applications"
            [value]="totalApplied()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Most-used"
            [value]="maxApplied()"
            format="number"
            dotColor="#AF52DE"
          />
        </section>

        @if (templates().length === 0) {
          <app-empty-state
            title="No templates saved yet"
            description="Save a strategy as a template from the strategy detail page to start a reusable library."
          />
        } @else {
          <section class="card">
            <table class="templates-table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Type</th>
                  <th class="num">Applied</th>
                  <th>Risk profile</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (t of templates(); track t.id) {
                  <tr>
                    <td>
                      <div class="tmpl-name">{{ t.name ?? '(unnamed)' }}</div>
                      @if (t.description) {
                        <div class="muted small">{{ t.description }}</div>
                      }
                    </td>
                    <td class="mono small">{{ t.strategyType }}</td>
                    <td class="num mono">{{ t.appliedCount }}</td>
                    <td class="mono small muted">
                      {{ t.riskProfileId === null ? '—' : '#' + t.riskProfileId }}
                    </td>
                    <td class="time" [title]="t.createdAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ t.createdAt | relativeTime }}
                    </td>
                    <td>
                      <button
                        type="button"
                        class="action"
                        (click)="askApply(t)"
                        [disabled]="submitting()"
                      >
                        Apply →
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (pending(); as p) {
        <div class="modal-overlay" (click)="cancel()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>Apply template</h2>
              <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <strong>{{ p.name ?? '(unnamed)' }}</strong>
              <span class="muted small"> · {{ p.strategyType }}</span>
            </p>
            <p class="modal-desc">
              This will create one Paused Strategy per symbol below, all on the chosen timeframe.
              Duplicates (template already applied to that pair) are skipped.
            </p>

            <label class="field">
              <span>Symbols (comma- or space-separated)</span>
              <textarea
                rows="2"
                [(ngModel)]="symbolsText"
                placeholder="EURUSD, GBPUSD, USDJPY"
              ></textarea>
            </label>

            <div class="row">
              <label class="field grow">
                <span>Timeframe</span>
                <select [(ngModel)]="timeframePick">
                  @for (tf of TIMEFRAMES; track tf) {
                    <option [ngValue]="tf">{{ tf }}</option>
                  }
                </select>
              </label>
              <label class="field grow">
                <span>Name prefix (optional)</span>
                <input type="text" [(ngModel)]="namePrefix" placeholder="e.g. v3-rollout" />
              </label>
            </div>

            @if (lastResult(); as r) {
              <div class="result-banner" [class.has-skipped]="r.skippedCount > 0">
                Created <strong>{{ r.createdCount }}</strong> strategy{{
                  r.createdCount === 1 ? '' : 'ies'
                }}
                @if (r.skippedCount > 0) {
                  , skipped <strong>{{ r.skippedCount }}</strong>
                }
                .
                @if (r.skippedReasons.length > 0) {
                  <ul class="skipped-list">
                    @for (reason of r.skippedReasons; track reason) {
                      <li>{{ reason }}</li>
                    }
                  </ul>
                }
              </div>
            }

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancel()">
                {{ lastResult() ? 'Close' : 'Cancel' }}
              </button>
              @if (!lastResult()) {
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="confirmApply()"
                  [disabled]="!canApply()"
                >
                  {{
                    submitting()
                      ? 'Applying…'
                      : 'Apply to ' +
                        parsedSymbols().length +
                        ' symbol' +
                        (parsedSymbols().length === 1 ? '' : 's')
                  }}
                </button>
              }
            </footer>
          </div>
        </div>
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
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .templates-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .templates-table th,
      .templates-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .templates-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .templates-table td.num,
      .templates-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .tmpl-name {
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .action {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        color: var(--accent);
      }
      .action:hover:not(:disabled) {
        background: var(--accent);
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 560px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
        line-height: 1;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-target strong {
        color: var(--text-primary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field textarea,
      .field input,
      .field select {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
      }
      .row {
        display: flex;
        gap: var(--space-3);
      }
      .grow {
        flex: 1;
      }
      .result-banner {
        font-size: var(--text-sm);
        background: rgba(52, 199, 89, 0.08);
        border: 1px solid rgba(52, 199, 89, 0.3);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
      }
      .result-banner.has-skipped {
        background: rgba(255, 149, 0, 0.08);
        border-color: rgba(255, 149, 0, 0.4);
      }
      .skipped-list {
        margin: var(--space-2) 0 0;
        padding-left: var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
    `,
  ],
})
export class TemplatesPageComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly TIMEFRAMES = TIMEFRAMES;

  protected readonly resource = createPolledResource(
    () =>
      this.strategies.listTemplates().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<StrategyTemplateDto[]>([])),
      ),
    { intervalMs: 120_000 },
  );

  protected readonly templates = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.templates().length === 0,
  );
  protected readonly totalApplied = computed(() =>
    this.templates().reduce((s, t) => s + t.appliedCount, 0),
  );
  protected readonly maxApplied = computed(() =>
    this.templates().reduce((m, t) => (t.appliedCount > m ? t.appliedCount : m), 0),
  );

  // Apply modal -----------------------------------------------------------
  protected readonly pending = signal<StrategyTemplateDto | null>(null);
  protected symbolsText = '';
  protected timeframePick: Timeframe = 'H1';
  protected namePrefix = '';
  protected readonly submitting = signal(false);
  protected readonly lastResult = signal<ApplyStrategyTemplateResult | null>(null);

  protected askApply(t: StrategyTemplateDto): void {
    this.symbolsText = '';
    this.namePrefix = '';
    this.timeframePick = 'H1';
    this.lastResult.set(null);
    this.pending.set(t);
  }

  protected cancel(): void {
    if (this.submitting()) return;
    this.pending.set(null);
    this.lastResult.set(null);
  }

  protected parsedSymbols = computed(() => {
    // Use template literal split for both commas and whitespace.
    return this.symbolsText
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  });

  protected canApply = (): boolean => {
    if (this.submitting()) return false;
    return this.parsedSymbols().length > 0;
  };

  protected confirmApply(): void {
    const p = this.pending();
    if (!p || !this.canApply()) return;
    const symbols = this.parsedSymbols();
    this.submitting.set(true);
    this.strategies
      .applyTemplate({
        templateId: p.id,
        symbols,
        timeframe: this.timeframePick,
        namePrefix: this.namePrefix.trim() || null,
      })
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            this.lastResult.set(res.data);
            this.auditTrail
              .create({
                entityType: 'StrategyTemplate',
                entityId: p.id,
                decisionType: 'StrategyTemplateApplied',
                outcome: 'Applied',
                reason: null,
                contextJson: JSON.stringify({
                  templateName: p.name,
                  symbols,
                  timeframe: this.timeframePick,
                  result: res.data,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          }
        },
        error: () => undefined,
      });
  }
}
